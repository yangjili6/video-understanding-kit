// PP-OCRv4 完整流程（Node + onnxruntime-web WASM）
// det: DB 检测概率图 → 阈值 + 连通域 → 文本框
// rec: 裁剪 + resize 48 高 → CTC 解码
import * as ort from 'onnxruntime-web'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const req = createRequire(import.meta.url)
// wasmPaths 必须是 URL：Node 的 ESM loader 在 Windows 上不接受 `D:\...` 这种绝对路径
ort.env.wasm.wasmPaths = pathToFileURL(dirname(req.resolve('onnxruntime-web')) + '/').href
ort.env.wasm.numThreads = 1

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const dictText = readFileSync(join(APP_DIR, 'models/ppocr_keys_v1.txt'), 'utf8')
const DICT = dictText.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length === 0 || s.length >= 0)
while (DICT.length && DICT[DICT.length - 1] === '') DICT.pop()

let detSession = null
let recSession = null
async function getSessions() {
  if (!detSession) {
    const detModel = readFileSync(join(APP_DIR, 'models/ch_PP-OCRv4_det_infer.onnx'))
    detSession = await ort.InferenceSession.create(detModel, { executionProviders: ['wasm'] })
    const recModel = readFileSync(join(APP_DIR, 'models/ch_PP-OCRv4_rec_infer.onnx'))
    recSession = await ort.InferenceSession.create(recModel, { executionProviders: ['wasm'] })
  }
  return { detSession, recSession }
}

// 用 ImageMagick 读图：缩放 + 输出 raw RGB
function readRGB(path, outW, outH) {
  const buf = execFileSync('convert', [path, '-resize', `${outW}x${outH}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 128 * 1024 * 1024 })
  return buf
}

function identify(path) {
  const out = execFileSync('identify', ['-format', '%w %h', path], { encoding: 'utf8' })
  const [w, h] = out.trim().split(/\s+/).map(Number)
  return { w, h }
}

// det 推理：返回框（原图坐标）
async function detect(path) {
  const { detSession } = await getSessions()
  const { w: W0, h: H0 } = identify(path)
  // 缩放到 32 的倍数，长边 <= 960
  let scale = 1
  const longSide = Math.max(W0, H0)
  const MAX_SIDE = Number(process.env.DET_MAX_SIDE || 720)
  if (longSide > MAX_SIDE) scale = MAX_SIDE / longSide
  let W = 32 * Math.round((W0 * scale) / 32)
  let H = 32 * Math.round((H0 * scale) / 32)
  W = Math.max(W, 32)
  H = Math.max(H, 32)
  const rgb = readRGB(path, W, H)
  // NHWC -> NCHW + normalize
  const data = new Float32Array(3 * H * W)
  const px = W * H
  for (let i = 0; i < px; i++) {
    data[i] = (rgb[i * 3] / 255 - MEAN[0]) / STD[0]
    data[px + i] = (rgb[i * 3 + 1] / 255 - MEAN[1]) / STD[1]
    data[2 * px + i] = (rgb[i * 3 + 2] / 255 - MEAN[2]) / STD[2]
  }
  const tensor = new ort.Tensor('float32', data, [1, 3, H, W])
  const out = await detSession.run({ [detSession.inputNames[0]]: tensor })
  const prob = out[detSession.outputNames[0]].data // [1,1,H,W]
  // 阈值 + 连通域
  const boxes = dbPostprocess(prob, W, H, Number(process.env.DET_TH || 0.2), W0 / W, H0 / H)
  return boxes
}

// DB 后处理：阈值化概率图 → 连通域 → bbox
function dbPostprocess(prob, W, H, thresh, sx, sy) {
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) mask[i] = prob[i] > thresh ? 1 : 0
  const visited = new Uint8Array(W * H)
  const boxes = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!mask[i] || visited[i]) continue
      // BFS
      const queue = [i]
      visited[i] = 1
      let minX = x, maxX = x, minY = y, maxY = y, count = 0
      while (queue.length) {
        const j = queue.pop()
        const jx = j % W
        const jy = (j - jx) / W
        count++
        if (jx < minX) minX = jx
        if (jx > maxX) maxX = jx
        if (jy < minY) minY = jy
        if (jy > maxY) maxY = jy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = jx + dx, ny = jy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const k = ny * W + nx
          if (mask[k] && !visited[k]) { visited[k] = 1; queue.push(k) }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (process.env.DEBUG_DET) console.log(`cc [${minX},${minY}] ${bw}x${bh} area=${count}`)
      if (count < 30 || bw < 8 || bh < 8) continue
      if (bw / bh > 60 || bh / bw > 5) continue
      // unclip 简化：按高度外扩 30%
      const pad = Math.round(bh * 0.5)
      const x0 = Math.max(0, minX - pad)
      const y0 = Math.max(0, minY - pad)
      const x1 = Math.min(W - 1, maxX + pad)
      const y1 = Math.min(H - 1, maxY + pad)
      boxes.push({
        x0: Math.round(x0 * sx),
        y0: Math.round(y0 * sy),
        x1: Math.round(x1 * sx),
        y1: Math.round(y1 * sy),
      })
    }
  }
  // 按阅读顺序排序（先上后左）
  boxes.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0))
  return boxes
}

// rec 推理：裁剪框 → 48 高 → CTC 解码
async function recognizeCrop(path, box) {
  const { recSession } = await getSessions()
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  const targetH = 48
  const targetW = Math.max(16, Math.min(320, Math.round((bw / bh) * targetH)))
  const rgb = readRGB2(path, box, targetW, targetH)
  const data = new Float32Array(3 * targetH * targetW)
  const px = targetW * targetH
  for (let i = 0; i < px; i++) {
    data[i] = rgb[i * 3] / 255 - 0.5
    data[px + i] = rgb[i * 3 + 1] / 255 - 0.5
    data[2 * px + i] = rgb[i * 3 + 2] / 255 - 0.5
  }
  const tensor = new ort.Tensor('float32', data, [1, 3, targetH, targetW])
  const out = await recSession.run({ [recSession.inputNames[0]]: tensor })
  const preds = out[recSession.outputNames[0]]
  const [T, C] = preds.dims.slice(1)
  // CTC 解码
  let prev = -1
  const chars = []
  let confSum = 0
  let confN = 0
  for (let t = 0; t < T; t++) {
    let best = 0
    let bestV = -Infinity
    for (let c = 0; c < C; c++) {
      const v = preds.data[t * C + c]
      if (v > bestV) { bestV = v; best = c }
    }
    if (best !== 0 && best !== prev) {
      chars.push(DICT[best - 1] ?? '')
      confSum += bestV
      confN++
    }
    prev = best
  }
  return { text: chars.join(''), conf: confN ? confSum / confN : 0 }
}

function readRGB2(path, box, w, h) {
  const buf = execFileSync('convert', [path, '-crop', `${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1}+${box.x0}+${box.y0}`, '+repage', '-resize', `${w}x${h}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 64 * 1024 * 1024 })
  return buf
}

export { detect, recognizeCrop }

export async function ocrImage(path) {
  const boxes = await detect(path)
  const results = []
  for (const box of boxes) {
    try {
      const { text, conf } = await recognizeCrop(path, box)
      if (text.trim()) results.push({ box, text, conf })
    } catch (e) {
      // 跳过失败的框
    }
  }
  return results
}

if (process.argv[1] && process.argv[1].endsWith('ocr-pp.mjs')) {
  const path = process.argv[2]
  const t0 = Date.now()
  const res = await ocrImage(path)
  console.log(`识别 ${res.length} 个文本框，耗时 ${Date.now() - t0}ms`)
  for (const r of res) console.log(`[${r.box.x0},${r.box.y0}] ${r.conf.toFixed(2)} | ${r.text}`)
}

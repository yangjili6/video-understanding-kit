// PP-OCRv4 完整流程（Node + onnxruntime-web WASM）
// det: DB 检测概率图 → 阈值 + 连通域 → 文本框
// rec: 裁剪 + resize 48 高 → CTC 解码
import * as ort from 'onnxruntime-web'
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
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
// ImageMagick 7 只提供 magick.exe，6.x 提供 convert / identify。
// 优先用 magick（两个版本都有），找不到再退回老命令。
let _magick = null
function magickBin() {
  if (_magick) return _magick
  for (const cand of ['magick', 'convert']) {
    try {
      const r = spawnSync(cand, ['-version'], { encoding: 'utf8', timeout: 5000 })
      if (r.status === 0) { _magick = cand; return cand }
    } catch { /* 试下一个 */ }
  }
  _magick = 'convert'
  return _magick
}
function isMagick7() { return magickBin() === 'magick' }

/** 读帧为 RGB。roi 存在时先裁剪再缩放 —— 字幕带只占画面一小块，
 *  裁掉其余区域能让 det 的输入尺寸降一个量级（实测 960×540 → 960×80）。 */
function readRGB(path, outW, outH, roi = null) {
  const bin = magickBin()
  const args = [path]
  if (roi) args.push('-crop', `${roi.w}x${roi.h}+${roi.x}+${roi.y}`, '+repage')
  args.push('-resize', `${outW}x${outH}!`, '-depth', '8', 'rgb:-')
  const buf = execFileSync(bin, args, { maxBuffer: 128 * 1024 * 1024 })
  return buf
}

function identify(path) {
  const out = isMagick7()
    ? execFileSync('magick', ['identify', '-format', '%w %h', path], { encoding: 'utf8' })
    : execFileSync('identify', ['-format', '%w %h', path], { encoding: 'utf8' })
  const [w, h] = out.trim().split(/\s+/).map(Number)
  return { w, h }
}

// det 推理：返回框（原图坐标）
async function detect(path, roi = null, maxSideOverride = null) {
  const { detSession } = await getSessions()
  // roi 存在时直接用它的尺寸，省掉一次 identify 进程调用
  const { w: W0, h: H0 } = roi ? { w: roi.w, h: roi.h } : identify(path)
  // 缩放到 32 的倍数，长边 <= DET_MAX_SIDE（可用参数覆盖，粗扫走 480）
  let scale = 1
  const longSide = Math.max(W0, H0)
  const MAX_SIDE = Number(maxSideOverride || process.env.DET_MAX_SIDE || 720)
  if (longSide > MAX_SIDE) scale = MAX_SIDE / longSide
  let W = 32 * Math.round((W0 * scale) / 32)
  let H = 32 * Math.round((H0 * scale) / 32)
  W = Math.max(W, 32)
  H = Math.max(H, 32)
  const rgb = readRGB(path, W, H, roi)
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
  if (roi) for (const b of boxes) { b.x0 += roi.x; b.x1 += roi.x; b.y0 += roi.y; b.y1 += roi.y }
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
/**
 * 把一块区域按「水平投影」切成若干行，供逐行识别。
 *
 * 起因：对话气泡常有多行，PP-OCR 的 rec 模型按单行训练 —— 给一个多行块，
 * 它只会读出一行（或读成乱码）。先切行再逐行识别，才能把气泡读全。
 *
 * 做法：裁出区域 → 缩到固定宽 → 转灰度 → 统计每行暗像素比例 →
 * 连续的高密度段就是文字行 → 映射回原图坐标。
 *
 * @returns {Promise<Array<{x0,y0,x1,y1}>>} 子框列表（原图坐标）；切不出多行时返回单框
 */
export async function splitLines(path, box, opts = {}) {
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  if (bw < 8 || bh < 8) return [box]
  // 只有「明显偏高」的块才需要切行：单行文字的高宽比通常 < 0.6
  const minSplitH = opts.minSplitH ?? 56
  if (bh < minSplitH) return [box]

  const W = 300
  const H = Math.max(8, Math.round((bh / bw) * W))
  if (H > 2000) return [box]
  let buf
  try {
    const bin = magickBin()
    buf = execFileSync(bin, [path, '-crop', `${bw}x${bh}+${box.x0}+${box.y0}`, '+repage',
      '-resize', `${W}x${H}!`, '-colorspace', 'Gray', '-depth', '8', 'gray:-'],
      { maxBuffer: 64 * 1024 * 1024 })
  } catch { return [box] }
  if (!buf || buf.length < W * H) return [box]

  // 每行暗像素比例（文字行会有明显凸起）
  const rowDark = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    let dark = 0
    const base = y * W
    for (let x = 0; x < W; x++) if (buf[base + x] < 110) dark++
    rowDark[y] = dark / W
  }
  const peak = Math.max(...rowDark)
  if (peak < 0.02) return [box]
  const th = Math.max(0.02, peak * 0.25)

  const bands = []
  let start = -1
  for (let y = 0; y < H; y++) {
    const on = rowDark[y] >= th
    if (on && start < 0) start = y
    if (!on && start >= 0) { if (y - start >= 4) bands.push([start, y]); start = -1 }
  }
  if (start >= 0 && H - start >= 4) bands.push([start, H])
  if (bands.length <= 1) return [box]

  // 相邻行间隙太窄的合并（避免把字切开）
  const merged = []
  for (const b of bands) {
    const last = merged[merged.length - 1]
    if (last && b[0] - last[1] < 3) last[1] = b[1]
    else merged.push([...b])
  }
  if (merged.length <= 1) return [box]

  const sy = bh / H
  return merged.map(([y0, y1]) => ({
    x0: box.x0,
    y0: Math.max(box.y0, Math.round(box.y0 + y0 * sy) - 1),
    x1: box.x1,
    y1: Math.min(box.y1, Math.round(box.y0 + y1 * sy) + 1),
  }))
}

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
  const bin = magickBin()
  const crop = `${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1}+${box.x0}+${box.y0}`
  const buf = execFileSync(bin, [path, '-crop', crop, '+repage', '-resize', `${w}x${h}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 64 * 1024 * 1024 })
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

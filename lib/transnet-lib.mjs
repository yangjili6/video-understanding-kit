// TransNetV2 边界检测库（供管线使用）
import * as ort from 'onnxruntime-web'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const req = createRequire(import.meta.url)
// wasmPaths 必须是 URL：Node 的 ESM loader 在 Windows 上不接受 `D:\...` 这种绝对路径
ort.env.wasm.wasmPaths = pathToFileURL(dirname(req.resolve('onnxruntime-web')) + '/').href
// WASM 线程数：默认 1（实测手机多线程易触发过热降频，见 ADR-0006/0010）。
// 可用 TRANSNET_THREADS 覆盖，供多线程实验。
ort.env.wasm.numThreads = Number(process.env.TRANSNET_THREADS || 1)
const run = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...o })
const APP = dirname(fileURLToPath(import.meta.url))
const W = 48, H = 27, WIN = 100
// 步长取窗口宽度：窗口不重叠，每帧仍被覆盖一次，推理次数减半。
// 实测（2026-11-03，三视频合计 79s）：切点结果与 STRIDE=50 完全一致
// （CONCAT 5.8/11.8/17.8、anti-late 18.2、羽毛球 0 个），耗时 97.9s → 49.9s。
// 详见 docs/ADR-0005-transnet-sampling.md
const STRIDE = 100

let session = null
async function getSession() {
  if (!session) session = await ort.InferenceSession.create(readFileSync(join(APP, 'models/transnetv2.onnx')), { executionProviders: ['wasm'] })
  return session
}

// 检测镜头边界：返回 [{t, p}]
export async function detectCuts(video, opts = {}) {
  const FPS = opts.fps || 5
  const thr = opts.thr ?? 0.5
  const s = await getSession()
  const buf = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${FPS},scale=${W}:${H},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  const fs = W * H * 3
  const T = Math.floor(buf.length / fs)
  const probs = new Float32Array(T)
  const counts = new Float32Array(T)
  for (let start = 0; start < T; start += STRIDE) {
    const end = Math.min(start + WIN, T)
    if (end - start < 4) break
    const data = new Float32Array(WIN * H * W * 3)
    for (let f = 0; f < WIN; f++) {
      const srcIdx = start + f
      const src = srcIdx < T ? buf.subarray(srcIdx * fs, (srcIdx + 1) * fs) : buf.subarray((T - 1) * fs, T * fs)
      for (let k = 0; k < H * W * 3; k++) data[f * H * W * 3 + k] = src[k]
    }
    const tensor = new ort.Tensor('float32', data, [1, WIN, H, W, 3])
    const out = await s.run({ [s.inputNames[0]]: tensor })
    const all = out[s.outputNames[0]].data
    for (let f = 0; f < WIN; f++) {
      const idx = start + f
      if (idx < T) { probs[idx] += all[f]; counts[idx]++ }
    }
  }
  const prob = new Float32Array(T)
  for (let i = 0; i < T; i++) prob[i] = counts[i] ? probs[i] / counts[i] : 0
  const cuts = []
  for (let i = 1; i < T - 1; i++) {
    if (prob[i] >= thr && prob[i] >= prob[i - 1] && prob[i] >= prob[i + 1]) cuts.push({ t: Number((i / FPS).toFixed(2)), p: Number(prob[i].toFixed(3)) })
  }
  return { cuts, T, fps: FPS }
}

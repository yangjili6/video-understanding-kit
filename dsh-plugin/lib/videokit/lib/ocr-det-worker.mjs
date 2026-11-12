// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/ocr-det-worker.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// PP-OCR 检测 worker：把一批帧的 detect 放到独立线程。
// 模型只有 4.5MB，多开几个副本内存压力远小于 sherpa（217MB）。
import { parentPort, workerData } from 'node:worker_threads'
import { detect } from './ocr-pp.mjs'

const bootAt = Date.now()
// import 完成不代表模型加载完——ocr-pp 是懒加载，第一次 detect 才载 4.5MB 模型。
parentPort.postMessage({ type: 'ready', bootMs: Date.now() - bootAt })

const { frames, roi } = workerData || {}

const out = []
let firstDetectMs = null
for (const f of frames) {
  try {
    const t = Date.now()
    const boxes = await detect(f, roi || null)
    if (firstDetectMs === null) firstDetectMs = Date.now() - t
    out.push(boxes)
  } catch {
    out.push([])
  }
}

parentPort.postMessage({ ok: true, boxes: out, firstDetectMs, totalMs: Date.now() - bootAt })

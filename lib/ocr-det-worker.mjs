// PP-OCR 检测 worker：把一批帧的 detect 放到独立线程。
// 模型只有 4.5MB，多开几个副本内存压力远小于 sherpa（217MB）。
import { parentPort, workerData } from 'node:worker_threads'
import { detect } from './ocr-pp.mjs'

const { frames } = workerData || {}

const out = []
for (const f of frames) {
  try {
    const boxes = await detect(f)
    out.push(boxes)
  } catch {
    out.push([])
  }
}

parentPort.postMessage({ ok: true, boxes: out })

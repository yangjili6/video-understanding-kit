// ⚠ 自动生成文件，请勿编辑。
// 真源：download-models.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 下载模型（约 47MB）：TransNetV2 + PP-OCRv4 det/rec + 字典
// 用法：node download-models.mjs
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = join(ROOT, 'lib', 'models')
mkdirSync(MODEL_DIR, { recursive: true })

const FILES = [
  { name: 'transnetv2.onnx', url: 'https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx', size: 31_250_929 },
  { name: 'ch_PP-OCRv4_det_infer.onnx', url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx', size: 4_745_517 },
  { name: 'ch_PP-OCRv4_rec_infer.onnx', url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx', size: 10_857_958 },
  { name: 'ppocr_keys_v1.txt', url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt', size: 26_250 },
]

for (const f of FILES) {
  const dest = join(MODEL_DIR, f.name)
  if (existsSync(dest) && statSync(dest).size === f.size) {
    console.log(`✓ ${f.name} 已存在（${(f.size / 1e6).toFixed(1)}MB）`)
    continue
  }
  console.log(`下载 ${f.name} ...`)
  const res = await fetch(f.url)
  if (!res.ok) { console.error(`  ✗ HTTP ${res.status}`); continue }
  await pipeline(res.body, createWriteStream(dest))
  const actual = statSync(dest).size
  console.log(`  ✓ ${f.name}（${(actual / 1e6).toFixed(1)}MB）${actual === f.size ? '' : ' ⚠️ 大小不符，请检查'}`)
}
console.log('\n模型目录：', MODEL_DIR)

// ⚠ 自动生成文件，请勿编辑。
// 真源：download-models.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 下载模型（约 30MB）：TransNetV2（镜头检测）。OCR 模型已于 ADR-0019 移除。
// 用法：node download-models.mjs
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = join(ROOT, 'lib', 'models')
mkdirSync(MODEL_DIR, { recursive: true })

const FILES = [
  // ADR-0019 之后只保留 TransNetV2（镜头检测）。OCR 模型已随 OCR 一起删除，
  // 不要再往这里加 PP-OCR 的模型——已经没有任何代码在用它了。
  { name: 'transnetv2.onnx', url: 'https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx', size: 31_250_929 },
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

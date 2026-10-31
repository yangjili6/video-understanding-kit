// 视频理解工具包 · 真源同步脚本
//
// 仓库根目录的下列文件是唯一可编辑的真源：
//   pipeline.mjs  subs.mjs  asr.mjs  download-models.mjs  lib/ocr-pp.mjs  lib/transnet-lib.mjs
//
// dsh-plugin/lib/videokit/ 里的同名文件由本脚本生成，不得手改。
// 原因：插件安装时整个 dsh-plugin/ 目录会被拷进 DSH profile 的 node_modules，
//      index.js 用 `new URL('./lib/videokit/', import.meta.url)` 定位运行时，
//      所以副本必须入库，但不能有两份真源。
//
// 用法：
//   node scripts/sync-videokit.mjs           写入副本（改完真源后运行）
//   node scripts/sync-videokit.mjs --check   只校验，不一致时退出码 1
//
// 换行统一成 LF 后再比对，避免 Windows（core.autocrlf=true）与 Linux/CI 的差异导致误报。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DST_DIR = join(ROOT, 'dsh-plugin', 'lib', 'videokit')

const FILES = [
  'pipeline.mjs',
  'subs.mjs',
  'asr.mjs',
  'download-models.mjs',
  'lib/ocr-pp.mjs',
  'lib/transnet-lib.mjs',
]

const BANNER = [
  '// ⚠ 自动生成文件，请勿编辑。',
  '// 真源：<src>（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。',
  '// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。',
]

const toLf = (text) => text.replace(/\r\n/g, '\n')

function readLf(path) {
  return toLf(readFileSync(path, 'utf8'))
}

function expected(rel) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) {
    console.error(`真源缺失：${rel}`)
    process.exit(1)
  }
  const banner = BANNER.map((line) => line.replace('<src>', rel)).join('\n')
  return `${banner}\n${readLf(src)}`
}

const check = process.argv.includes('--check')
const problems = []

for (const rel of FILES) {
  const dst = join(DST_DIR, rel)
  const want = expected(rel)

  if (!check) {
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, want, 'utf8')
    console.log(`写入 dsh-plugin/lib/videokit/${rel}`)
    continue
  }

  if (!existsSync(dst)) problems.push(`${rel}：副本缺失`)
  else if (readLf(dst) !== want) problems.push(`${rel}：与真源不一致`)
}

if (!check) {
  console.log(`同步完成：${FILES.length} 个文件`)
} else if (problems.length) {
  console.error('同步校验失败：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('修复：运行 `pnpm run sync` 后提交')
  process.exit(1)
} else {
  console.log(`同步校验通过：${FILES.length} 个文件与真源一致`)
}

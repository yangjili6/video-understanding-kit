#!/usr/bin/env node
/**
 * 打包清单体检：`dsh-plugin/package.json` 的 `files` 白名单 vs 仓库里真实存在的文件。
 *
 * 为什么需要这个检查：`files` 靠手工维护，跟新增文件脱节。漏掉一个被静态 import 的
 * 模块（比如 `lib/videokit/lib/dedup.mjs`），装上去 pipeline 一启动就 ERR_MODULE_NOT_FOUND，
 * 整个插件不可用；漏掉一个动态 import 的，则是静默降级、更难发现。
 *
 * 同类问题已经出现过两次（transnet-worker.mjs、dedup.mjs），所以做成检查而不是靠记性。
 *
 * 用法：
 *   node scripts/check-pack-files.mjs         # 只报告，发现问题退出码 1
 *   node scripts/check-pack-files.mjs --list  # 顺带打印将被打包的文件
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = 'dsh-plugin'
const LIST = process.argv.includes('--list')

// 这些文件被版本控制跟踪，但 npm 默认不打包，也不算遗漏
const IGNORE = new Set(['.gitignore', 'package-lock.json', 'pnpm-lock.yaml'])

function gitTracked(dir) {
  const out = execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1))
    .filter((p) => !IGNORE.has(p) && !p.startsWith('node_modules/'))
}

const pkg = JSON.parse(readFileSync(join(ROOT, PKG_DIR, 'package.json'), 'utf8'))
const files = pkg.files || []

// npm 永远包含 package.json；其余按 files 规则匹配（目录规则包含其下所有文件）
const ALWAYS = new Set(['package.json'])
const coveredBy = (f) => {
  if (ALWAYS.has(f)) return true
  for (const rule of files) {
    const clean = rule.replace(/\/$/, '')
    if (f === clean || f.startsWith(clean + '/')) return true
  }
  return false
}

const tracked = gitTracked(PKG_DIR)
const missing = tracked.filter((f) => !coveredBy(f))
const ghosts = files.filter((rule) => {
  const clean = rule.replace(/\/$/, '')
  return !existsSync(join(ROOT, PKG_DIR, clean))
})

if (LIST) {
  console.log('将被打包：')
  for (const f of tracked.filter(coveredBy)) console.log('  ' + f)
  console.log('')
}

let bad = false
if (missing.length) {
  bad = true
  console.log('❌ 这些文件在仓库里，但没写进 package.json 的 files —— 打包会漏掉：')
  for (const f of missing) console.log('  ' + f)
  console.log('')
  console.log('  修法：把它们加进 ' + PKG_DIR + '/package.json 的 files 数组。')
}
if (ghosts.length) {
  bad = true
  console.log('⚠️ 这些 files 规则指向的路径不存在（打包会告警）：')
  for (const f of ghosts) console.log('  ' + f)
}

if (!bad) {
  console.log(`✅ 打包清单完整：files 覆盖 ${tracked.filter(coveredBy).length} 个文件，无多余规则。`)
}
process.exit(bad ? 1 : 0)

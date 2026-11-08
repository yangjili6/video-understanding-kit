// 网格去重探针（对应 ADR-0012 阶段一）
// 对已有网格页做：全图 pHash 初筛 → 相似度高才进入局部区域检测 → 再决定留还是删
// 用法：node tools/dedup-probe.mjs <grids 目录>
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TMP = join(process.cwd(), 'tmp', 'dedup-roi')
mkdirSync(TMP, { recursive: true })
const dir = process.argv[2]
if (!dir) { console.error('用法: node tools/dedup-probe.mjs <grids 目录>'); process.exit(1) }

// 用 ImageMagick 把一张图缩成 N×N 灰度，返回 0-255 数组（避开自己解码 JPEG）
function gray(path, size) {
  const raw = execFileSync('magick', [path, '-colorspace', 'Gray', '-resize', `${size}x${size}!`, '-depth', '8', 'gray:-'], { maxBuffer: 64 * 1024 * 1024 })
  return Array.from(raw.slice(0, size * size))
}

// pHash：32×32 灰度 → 2D DCT 取左上 8×8 低频 → 与均值比较得 64 bit
function phash(path) {
  const N = 32
  const px = gray(path, N)
  const cos = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Math.cos(((2 * i + 1) * j * Math.PI) / (2 * N))))
  const dct = []
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) s += px[x * N + y] * cos[x][u] * cos[y][v]
    dct.push(s)
  }
  const mean = dct.slice(1).reduce((a, b) => a + b, 0) / (dct.length - 1)
  return dct.map((v) => (v > mean ? 1 : 0))
}

function hamming(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

// 局部区域：把整页切成 2×3（上/中/下 × 左/右），每块单独 pHash
// 用固定分区代替人脸 ROI —— 手机上跑不起 MediaPipe，分区是不依赖检测的近似
function regionHashes(path) {
  const out = {}
  for (const [name, crop] of Object.entries({
    topLeft: '50%x33%+0+0',    topRight: '50%x33%+50%+0',
    midLeft: '50%x33%+0+33%',  midRight: '50%x33%+50%+33%',
    botLeft: '50%x34%+0+66%',  botRight: '50%x34%+50%+66%',
  })) {
    const tmp = join(TMP, `roi-${process.pid}-${name}.png`)
    try {
      execFileSync('magick', [path, '-crop', crop, '+repage', tmp])
      out[name] = phash(tmp)
    } catch { out[name] = null } finally { try { execFileSync('rm', ['-f', tmp]) } catch {} }
  }
  return out
}

const files = readdirSync(dir).filter((f) => /^g\d+-p\d+\.jpg$/.test(f)).sort()
console.log(`网格页: ${files.length}\n`)

const GLOBAL_SIM = 6     // 全图汉明距离 ≤6 视为高度相似（需局部复核）
const ROI_CHANGE = 10    // 任一区域汉明距离 >10 视为该区域有变化

let kept = 1
let deduped = 0
const rows = []
let prevGlobal = null
let prevRegions = null

for (let i = 0; i < files.length; i++) {
  const p = join(dir, files[i])
  const g = phash(p)
  let action = 'keep'
  let reason = '首帧'

  if (prevGlobal) {
    const d = hamming(prevGlobal, g)
    if (d > GLOBAL_SIM) {
      action = 'keep'; reason = `全图差异 ${d} > ${GLOBAL_SIM}`
    } else {
      // 相似度高 → 进入局部检测
      const regions = regionHashes(p)
      let maxRoi = -1
      let hot = ''
      for (const k of Object.keys(regions)) {
        if (!regions[k] || !prevRegions?.[k]) continue
        const rd = hamming(regions[k], prevRegions[k])
        if (rd > maxRoi) { maxRoi = rd; hot = k }
      }
      if (maxRoi > ROI_CHANGE) { action = 'keep'; reason = `局部 ${hot} 变化 ${maxRoi}` }
      else { action = 'dedup'; reason = `全图 ${d}, 局部最大 ${maxRoi}` }
      prevRegions = regions
    }
  }
  if (i === 0) prevRegions = regionHashes(p)
  prevGlobal = g
  if (action === 'keep') kept++; else deduped++
  rows.push({ i, file: files[i], action, reason })
}

for (const r of rows) console.log(String(r.i).padStart(3), r.action === 'keep' ? '保留' : '去重', ' ', r.reason)
console.log(`\n原始 ${files.length} 页 → 保留 ${kept - 1} 页，去重 ${deduped} 页`)
console.log(`压缩率 ${((1 - (kept - 1) / files.length) * 100).toFixed(1)}%`)

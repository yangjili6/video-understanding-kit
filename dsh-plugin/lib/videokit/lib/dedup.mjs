// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/dedup.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 网格页去重（ADR-0012 阶段一 + 二）
// 两级：全图 pHash 初筛 → 相似度高才进入局部区域复核 → 决定留删
// 原则：不确定就保留（宁可多留，不可误删细微动作）
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const GLOBAL_SIM = 6     // 全图汉明距离 ≤6 视为高度相似（进入局部复核）
const ROI_CHANGE = 10    // 任一局部区域汉明距离 >10 视为该区域有变化
const TILE = 2           // 局部切 2×3

let tmpRoot = null
export function setDedupTmp(dir) {
  tmpRoot = dir
  mkdirSync(dir, { recursive: true })
}

// 缩成 N×N 灰度
function gray(path, size) {
  const raw = execFileSync('magick', [path, '-colorspace', 'Gray', '-resize', `${size}x${size}!`, '-depth', '8', 'gray:-'], { maxBuffer: 32 * 1024 * 1024 })
  return Array.from(raw.slice(0, size * size))
}

const COS = (() => {
  const N = 32
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Math.cos(((2 * i + 1) * j * Math.PI) / (2 * N))))
})()

// pHash：32×32 → DCT 左上 8×8 → 与均值比较
export function phash(path) {
  const N = 32
  const px = gray(path, N)
  const dct = []
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) s += px[x * N + y] * COS[x][u] * COS[y][v]
    dct.push(s)
  }
  const mean = dct.slice(1).reduce((a, b) => a + b, 0) / (dct.length - 1)
  return dct.map((v) => (v > mean ? 1 : 0))
}

export function hamming(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

// 局部：2×3 分区，每块单独 pHash（不依赖关键点检测）
function regionHashes(path) {
  const out = {}
  const crops = {
    topLeft: '50%x33%+0+0', topRight: '50%x33%+50%+0',
    midLeft: '50%x33%+0+33%', midRight: '50%x33%+50%+33%',
    botLeft: '50%x34%+0+66%', botRight: '50%x34%+50%+66%',
  }
  for (const key of Object.keys(crops)) {
    const tmp = join(tmpRoot || '/tmp', `roi-${process.pid}-${key}.png`)
    try {
      execFileSync('magick', [path, '-crop', crops[key], '+repage', tmp])
      out[key] = phash(tmp)
    } catch { out[key] = null }
  }
  return out
}

/**
 * 对一组网格页做去重。
 * @param {Array<{file:string}>} pages
 * @returns {{kept:Array, dropped:Array, stats:object}}
 */
export function dedupPages(pages, opts = {}) {
  const globalSim = opts.globalSim ?? GLOBAL_SIM
  const roiChange = opts.roiChange ?? ROI_CHANGE
  const kept = [], dropped = []
  if (!pages.length) return { kept, dropped, stats: { total: 0, kept: 0, dropped: 0 } }

  let prevHash = null
  let prevRegions = null
  kept.push({ ...pages[0], dedupReason: 'first' })
  prevHash = phash(pages[0].file)
  prevRegions = regionHashes(pages[0].file)

  for (let i = 1; i < pages.length; i++) {
    const p = pages[i]
    let hash = null, action = 'keep', reason = ''
    try {
      hash = phash(p.file)
      const d = hamming(prevHash, hash)
      if (d > globalSim) {
        reason = `全图差异 ${d}`
      } else {
        const regions = regionHashes(p.file)
        let maxRoi = -1, hot = ''
        for (const k of Object.keys(regions)) {
          if (!regions[k] || !prevRegions?.[k]) continue
          const rd = hamming(regions[k], prevRegions[k])
          if (rd > maxRoi) { maxRoi = rd; hot = k }
        }
        if (maxRoi > roiChange) { reason = `局部 ${hot} 变化 ${maxRoi}` }
        else { action = 'dedup'; reason = `全图 ${d}, 局部最大 ${maxRoi}` }
        prevRegions = regions
      }
    } catch (e) {
      action = 'keep'; reason = '检测失败，按不确定保留'
    }
    if (action === 'keep') { kept.push({ ...p, dedupReason: reason }); if (hash) prevHash = hash }
    else dropped.push({ ...p, dedupReason: reason })
  }
  return {
    kept,
    dropped,
    stats: { total: pages.length, kept: kept.length, dropped: dropped.length, ratio: +(1 - kept.length / pages.length).toFixed(3) },
  }
}

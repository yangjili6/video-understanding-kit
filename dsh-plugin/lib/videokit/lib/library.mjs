// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/library.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 视频阅读库：保留最近 N 条视频的「原视频 + 结构化阅读结果」。
//
// 动机（2026-11-14 指挥官）：VLM 读网格图时能看清字幕条的字，
// 那就该顺手把「字幕内容 + 时间戳」写成字符串存下来 —— 这样既保留
// OCR 曾经独有的「可检索文本」，又不需要真的跑 OCR。
//
// 淘汰策略：最多保留最近 3 条视频（按最近访问时间 LRU），
// 超出的整目录删除（含原视频副本，避免磁盘膨胀）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'

export const MAX_VIDEOS = 3

function libRoot(dshHome) {
  return join(dshHome, 'storages', 'dsh-video-kit', 'library')
}

function indexPath(root) {
  return join(root, 'index.json')
}

/** 读库索引（按 lastAccess 从新到旧） */
export function readIndex(dshHome) {
  const root = libRoot(dshHome)
  const f = indexPath(root)
  if (!existsSync(f)) return { videos: [] }
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    j.videos = (j.videos || []).sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0))
    return j
  } catch {
    return { videos: [] }
  }
}

function writeIndex(dshHome, idx) {
  const root = libRoot(dshHome)
  mkdirSync(root, { recursive: true })
  const f = indexPath(root)
  const tmp = f + '.tmp'
  writeFileSync(tmp, JSON.stringify(idx, null, 2))
  renameSync(tmp, f)   // 原子替换：SELinux 下沙箱内 rename 允许
}

/** 把一条视频登记进库（原视频复制进来 + 写 meta），并按 LRU 淘汰 */
export function registerVideo(dshHome, { taskId, videoPath, videoName, durationSec, pages = 0 }) {
  const root = libRoot(dshHome)
  mkdirSync(root, { recursive: true })
  const dir = join(root, taskId)
  mkdirSync(dir, { recursive: true })
  // 原视频副本（库要能独立于 out/ 目录存在；已存在就跳过）
  const dstVideo = join(dir, 'video' + (videoPath.includes('.') ? videoPath.slice(videoPath.lastIndexOf('.')) : '.mp4'))
  let copied = false
  try {
    if (!existsSync(dstVideo) && existsSync(videoPath)) {
      copyFileSync(videoPath, dstVideo)
      copied = true
    }
  } catch { /* 磁盘满等，不阻断 */ }
  const meta = {
    taskId,
    videoName: videoName || basename(videoPath),
    durationSec: Number(durationSec) || null,
    pages,
    videoFile: existsSync(dstVideo) ? basename(dstVideo) : null,
    videoCopied: copied,
    createdAt: new Date().toISOString(),
    lastAccess: Date.now(),
    readingFile: 'reading.json',
    readings: [],   // 逐页读到的字幕（由 video_read_page 写入）
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  const idx = readIndex(dshHome)
  idx.videos = idx.videos.filter((v) => v.taskId !== taskId)
  idx.videos.unshift({ taskId, videoName: meta.videoName, durationSec: meta.durationSec, lastAccess: meta.lastAccess })
  evict(dshHome, idx)
  writeIndex(dshHome, idx)
  return meta
}

/**
 * 字幕去重：跨页、跨带、跨带内多次出现时只留一条。
 *
 * 判据（由严到宽，命中任一即合并）：
 *   ① 文本完全相同，且时间区间重叠或相距 < 3 秒
 *   ② 一句完整包含另一句（短的被长的吸收），且时间接近
 *   ③ 文本相似度 ≥ 0.85（编辑距离归一化），且时间接近
 * 合并时保留：更长的文本、更宽的 [t, endT]、更大的 pageId 范围。
 */
function normText(t) {
  return String(t || '').replace(/\s+/g, '').replace(/[，。！？、,.!?~～…]+/g, '').toLowerCase()
}

function similar(a, b) {
  const x = normText(a), y = normText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.95
  // 归一化编辑距离
  const m = x.length, n = y.length
  if (Math.abs(m - n) / Math.max(m, n) > 0.4) return 0
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
  }
  return 1 - dp[m][n] / Math.max(m, n)
}

export function dedupeSubtitles(list, nearSec = 3, simTh = 0.85) {
  const out = []
  for (const it of list) {
    const t = Number(it.t) || 0
    const endT = Number(it.endT ?? it.t) || t
    let merged = false
    for (const o of out) {
      const timeNear = Math.abs(t - o.t) <= nearSec || (t <= o.endT + nearSec && endT >= o.t - nearSec)
      if (!timeNear) continue
      const sim = similar(it.text, o.text)
      if (sim >= simTh) {
        // 合并：保留更长文本 + 更宽时间 + 页名并集
        if (String(it.text).length > String(o.text).length) o.text = it.text
        o.t = Math.min(o.t, t)
        o.endT = Math.max(o.endT, endT)
        if (it.pageId && !String(o.pageId || '').includes(it.pageId)) {
          o.pageId = o.pageId ? `${o.pageId},${it.pageId}` : it.pageId
        }
        merged = true
        break
      }
    }
    if (!merged) out.push({ pageId: it.pageId, t, endT, text: String(it.text || '') })
  }
  return out
}

/** 写入一页的阅读结果（我读图后提交的字幕文本 + 时间戳） */
export function savePageReading(dshHome, { taskId, index, pageId, subtitles = [], summary = '', visual = '' }) {
  const root = libRoot(dshHome)
  const dir = join(root, taskId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const mf = join(dir, 'meta.json')
  let meta = {}
  try { meta = JSON.parse(readFileSync(mf, 'utf8')) } catch { meta = { taskId } }
  const readings = (meta.readings || []).filter((r) => r.index !== index)
  readings.push({
    index,
    pageId,
    subtitles: subtitles.map((s) => ({
      t: Number(s.t) || 0,
      endT: Number(s.endT ?? s.t) || 0,
      text: String(s.text || ''),
    })).filter((s) => s.text),
    summary: String(summary || ''),
    visual: String(visual || ''),
    readAt: new Date().toISOString(),
  })
  readings.sort((a, b) => a.index - b.index)
  meta.readings = readings
  meta.lastAccess = Date.now()
  writeFileSync(mf, JSON.stringify(meta, null, 2))
  // 汇总成 reading.json（库里可直接检索的那份）
  const rawFlat = []
  for (const r of readings) for (const s of r.subtitles) rawFlat.push({ pageId: r.pageId, t: s.t, endT: s.endT, text: s.text })
  // 落库前跨页去重：同一句在多页/多条带出现时只留一条
  const flat = dedupeSubtitles(rawFlat)
  writeFileSync(join(dir, 'reading.json'), JSON.stringify({
    taskId,
    videoName: meta.videoName,
    durationSec: meta.durationSec,
    pagesRead: readings.length,
    subtitles: flat,
    pages: readings.map((r) => ({ index: r.index, pageId: r.pageId, summary: r.summary, visual: r.visual })),
    updatedAt: new Date().toISOString(),
  }, null, 2))
  // 刷 LRU
  const idx = readIndex(dshHome)
  const hit = idx.videos.find((v) => v.taskId === taskId)
  if (hit) hit.lastAccess = Date.now()
  idx.videos.sort((a, b) => b.lastAccess - a.lastAccess)
  writeIndex(dshHome, idx)
  return { pagesRead: readings.length, subtitleCount: flat.length, rawCount: rawFlat.length, deduped: rawFlat.length - flat.length }
}

/** 按 LRU 淘汰到 MAX_VIDEOS 条以内 */
function evict(dshHome, idx) {
  const root = libRoot(dshHome)
  while (idx.videos.length > MAX_VIDEOS) {
    const drop = idx.videos.pop()
    try { rmSync(join(root, drop.taskId), { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 列出库内容（含每条的页数/字幕数） */
export function listLibrary(dshHome) {
  const idx = readIndex(dshHome)
  const root = libRoot(dshHome)
  return idx.videos.map((v) => {
    const dir = join(root, v.taskId)
    let pagesRead = 0, subtitleCount = 0, hasVideo = false, bytes = 0
    try {
      const r = JSON.parse(readFileSync(join(dir, 'reading.json'), 'utf8'))
      pagesRead = r.pagesRead || 0
      subtitleCount = (r.subtitles || []).length
    } catch { /* 还没读过 */ }
    try { hasVideo = existsSync(join(dir, 'video.mp4')) } catch { /* ignore */ }
    try {
      for (const f of readdirSync(dir)) {
        try { bytes += statSync(join(dir, f)).size } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return { ...v, pagesRead, subtitleCount, hasVideo, bytes }
  })
}

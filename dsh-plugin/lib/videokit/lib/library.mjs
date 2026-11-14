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
  const flat = []
  for (const r of readings) for (const s of r.subtitles) flat.push({ pageId: r.pageId, t: s.t, endT: s.endT, text: s.text })
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
  return { pagesRead: readings.length, subtitleCount: flat.length }
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

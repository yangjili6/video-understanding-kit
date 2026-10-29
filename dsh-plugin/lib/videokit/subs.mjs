// 字幕提取模块（安全版：整帧差异跳帧，不做 ROI 裁剪——ROI det 实测会漏中文行）
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detect, recognizeCrop } from './lib/ocr-pp.mjs'

const run = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...o })

function padBox(box, px = 6, py = 3) {
  return { x0: Math.max(0, box.x0 - px), y0: Math.max(0, box.y0 - py), x1: box.x1 + px, y1: box.y1 + py }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

// 送检帧固定缩到宽 960（见下面 ffmpeg 的 scale=960:-1）。OCR 返回的 box 是
// **这 960 宽帧空间**的像素坐标，所以所有几何阈值都必须用帧坐标算。
// 2026-10-30 实测事故：1280×720 的片子按 ffprobe 原始分辨率算
// `w > W*0.3`(384) 与 `y0 > H*0.65`(468)，而字幕框在 960×540 空间只有
// w=192 / y0=450 —— 两条判定全崩，整片 420 帧 OCR 输出 0 条。
const FRAME_W = 960

/**
 * 从一帧的所有 OCR box 里挑出「字幕行」。
 * 判据：够宽（短句也能过）、字高合理、位于画面下方、水平居中（挡掉左右角标）。
 * 实测样本：字幕 cx=479（画面中心 480）、updream 角标 cx=120、bilibili 角标 cx=876。
 */
export function selectSubtitleLine(boxes, fw = FRAME_W, fh = FRAME_W * 9 / 16) {
  const lines = boxes.filter((b) => {
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    const cx = (b.x0 + b.x1) / 2
    return (
      w > fw * 0.08 &&                    // 短字幕（5 个字约 20% 宽）也要能过
      h > fh * 0.02 &&                    // 太扁的是横线/分隔条
      h < fh * 0.16 &&                    // 太高的是画面主体
      b.y0 > fh * 0.6 &&                  // 只在下方 40% 找
      Math.abs(cx - fw / 2) < fw * 0.22   // 居中，挡掉角落水印
    )
  })
  return lines.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0] || null
}

// 提取字幕：返回 [{start, end, t, text, conf}]
export async function extractSubtitles(video, outDir, opts = {}) {
  const FPS = opts.fps || 2
  const frameDir = join(outDir, 'frames')
  mkdirSync(frameDir, { recursive: true })

  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', video]))
  const { width: W, height: H } = probe.streams[0]
  // 帧空间的高度：送检帧固定 960 宽，按原始宽高比换算
  const FW = FRAME_W
  const FH = Math.round(FRAME_W * (H / W))
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${FPS},scale=960:-1`, '-q:v', '2', join(frameDir, 'f-%04d.jpg'), '-y'])
  const files = readdirSync(frameDir).filter((f) => f.endsWith('.jpg')).sort()

  const smallBuf = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${FPS},scale=160:90,format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  const smallFs = 160 * 90
  const SKIP_TH = Number(process.env.SUBS_SKIP_TH || 3.0)

  const frames = []
  let lastBoxes = []
  let prevSmall = null
  let statDet = 0, statSkip = 0
  for (let i = 0; i < files.length; i++) {
    const f = join(frameDir, files[i])
    const small = smallBuf.subarray(i * smallFs, (i + 1) * smallFs)
    let diff = 0
    if (prevSmall && prevSmall.length === small.length) {
      let sum = 0
      for (let k = 0; k < small.length; k++) sum += Math.abs(small[k] - prevSmall[k])
      diff = sum / small.length
    }
    prevSmall = small
    let boxes = []
    if (lastBoxes.length && diff < SKIP_TH) {
      boxes = lastBoxes
      statSkip++
    } else {
      try { boxes = await detect(f) } catch { boxes = [] }
      statDet++
    }
    lastBoxes = boxes
    const main = selectSubtitleLine(boxes, FW, FH)
    frames.push({ t: i / FPS, file: f, main, diff })
  }
  console.log(`  det ${statDet}/${files.length} 帧，跳过 ${statSkip} 帧（帧空间 ${FW}×${FH}）`)

  const events = []
  for (const fr of frames) {
    const cur = events[events.length - 1]
    const same = cur && cur.main && fr.main &&
      Math.abs(cur.main.x0 - fr.main.x0) < 40 &&
      Math.abs(cur.main.y0 - fr.main.y0) < 20 &&
      (fr.main.x1 - fr.main.x0) >= (cur.main.x1 - cur.main.x0) - 150
    if (same) {
      cur.end = fr.t
      cur.frames.push(fr)
    } else {
      events.push({ start: fr.t, end: fr.t, main: fr.main, frames: [fr] })
    }
  }

  for (const ev of events) {
    const withMain = ev.frames.filter((f) => f.main)
    ev.selected = withMain.length ? withMain[withMain.length - 1] : null
  }

  const results = []
  for (const ev of events) {
    if (!ev.selected || !ev.selected.main) continue
    try {
      const { text, conf } = await recognizeCrop(ev.selected.file, padBox(ev.selected.main))
      const clean = text.trim()
      if (clean.length >= 2 && conf >= 0.5) results.push({ start: ev.start, end: ev.end, t: ev.selected.t, text: clean, conf })
    } catch { /* skip */ }
  }

  const merged = []
  for (const r of results) {
    const last = merged[merged.length - 1]
    if (last) {
      const sim = 1 - levenshtein(last.text, r.text) / Math.max(last.text.length, r.text.length, 1)
      const contains = last.text.includes(r.text) || r.text.includes(last.text)
      if ((contains || sim >= 0.7) && r.start - last.end < 1.0) {
        if (r.text.length > last.text.length) last.text = r.text
        last.end = r.end
        continue
      }
    }
    merged.push({ ...r })
  }
  return merged
}

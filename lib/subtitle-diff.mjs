// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/subtitle-diff.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
//
// 字幕带逐帧差分：用「字幕那一小条的像素是否变化」决定要不要对这段跑 OCR。
//
// 动机：全量 det 是 OCR 的大头（217 帧 × 0.65s ≈ 140 秒），但字幕大部分时间是
// 不变或缓慢变化的。只对「字幕真的换了」的帧做 det + rec，能省掉绝大部分开销。
//
// 关键实现：用 ffmpeg 一次性把「字幕带区域」抽成 raw 灰度帧序列，
// 比「每帧调一次 magick 裁剪」快两个数量级（一次进程 vs N 次进程）。
import { execFileSync } from 'node:child_process'

/**
 * 抽字幕带灰度帧序列（一次 ffmpeg 调用拿到全部帧）。
 *
 * @param {string} video 原视频路径
 * @param {{x:number,y:number,w:number,h:number}} band 字幕带（帧空间坐标，960 宽）
 * @param {number} FW 帧空间宽度（通常是 960）
 * @param {number} fps 抽帧率（必须与 pipeline 的 FPS 一致）
 * @returns {{frames: Uint8Array[], W:number, H:number, times:number[]}}
 */
export function extractBandFrames(video, band, FW, fps) {
  // 帧空间 → 原视频坐标：需要先探测原视频尺寸
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', video], { encoding: 'utf8' }))
  const { width: VW, height: VH } = probe.streams[0]
  const k = VW / FW
  // 字幕带向下取整对齐到偶数（yuv420p 对奇数尺寸敏感），并留 4px 余量
  const cx = Math.max(0, Math.floor(band.x * k) - 4)
  const cy = Math.max(0, Math.floor(band.y * k) - 4)
  const cw = Math.min(VW - cx, Math.ceil(band.w * k) + 8)
  const ch = Math.min(VH - cy, Math.ceil(band.h * k) + 8)
  // 宽度对齐到 2 的倍数
  const cw2 = cw - (cw % 2)
  const ch2 = ch - (ch % 2)
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=${fps},crop=${cw2}:${ch2}:${cx}:${cy},format=gray`,
    '-f', 'rawvideo', '-'], { maxBuffer: 256 * 1024 * 1024 })
  const fs = cw2 * ch2
  const n = Math.floor(raw.length / fs)
  const frames = []
  for (let i = 0; i < n; i++) frames.push(new Uint8Array(raw.subarray(i * fs, (i + 1) * fs)))
  const times = frames.map((_, i) => i / fps)
  return { frames, W: cw2, H: ch2, times }
}

/** 两帧字幕带的平均逐像素差 */
export function bandDelta(a, b) {
  const n = Math.min(a.length, b.length)
  if (!n) return 999
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i])
  return sum / n
}

/**
 * 标出「字幕发生了变化」的帧序号。
 *
 * 规则：
 *   ① 与「上一个变化点」比较（不是相邻帧——缓慢滚动字幕会逐帧微变，
 *      和相邻帧比永远不掉阈值以下，最后等于每帧都变）
 *   ② 差值 ≥ th → 记为变化点，并更新参考帧
 *   ③ 变化点之间强制间隔 ≥ minGapSec（同一个变化被连续几帧检测到，只算一次）
 *
 * @returns {{changes:number[], deltas:Float64Array, coverage:number}}
 */
export function detectBandChanges(frames, fps, opts = {}) {
  const th = opts.th ?? 2.0
  const minGapSec = opts.minGapSec ?? 0.5
  const deltas = new Float64Array(frames.length)
  const changes = []
  if (!frames.length) return { changes, deltas, coverage: 0 }
  let ref = frames[0]
  let lastChangeT = -Infinity
  deltas[0] = 0
  for (let i = 1; i < frames.length; i++) {
    const d = bandDelta(ref, frames[i])
    deltas[i] = d
    const t = i / fps
    if (d >= th && t - lastChangeT >= minGapSec) {
      changes.push(i)
      ref = frames[i]
      lastChangeT = t
    }
  }
  return { changes, deltas, coverage: changes.length / Math.max(1, frames.length) }
}

/**
 * 三档变化分类：区分「打字机逐字」和「整句替换」。
 *
 * 动机：日语中字这类视频字幕是「逐字弹出」的，每帧像素都在变，
 * 二档差分（变/不变）会把每一帧都标成变化 → 退化成全量检测。
 * 但逐字和换句的差异在**幅度**上：
 *
 *   d < smallTh           完全没变          → 跳过
 *   smallTh ≤ d < bigTh   逐字推进中         → 记为 pending，等它打完
 *   d ≥ bigTh             整句替换           → 立刻 OCR 这一帧
 *
 * 「打完」的判定：pending 之后出现一帧 d < smallTh（字幕稳定），
 * 就把 pending 那一帧交出去 OCR —— 那是完整的一句。
 *
 * @returns {{targets:number[], deltas:Float64Array, stats:{skipped:number,typing:number,replace:number}}}
 */
export function classifyBandChanges(frames, fps, opts = {}) {
  const smallTh = opts.smallTh ?? 0.6
  const bigTh = opts.bigTh ?? 4.0
  const deltas = new Float64Array(frames.length)
  const targets = []
  const stats = { skipped: 0, typing: 0, replace: 0 }
  if (!frames.length) return { targets, deltas, stats }

  let ref = frames[0]        // 稳定参考帧（只在「确认变化」时更新）
  let pending = -1           // 逐字段里最后一个变化帧
  let lastTarget = -99

  for (let i = 1; i < frames.length; i++) {
    const d = bandDelta(ref, frames[i])
    deltas[i] = d

    if (d < smallTh) {
      // 稳定了：如果之前有逐字段在等，说明它打完了 → 交出去
      if (pending >= 0 && i - pending >= 1) {
        targets.push(pending)
        lastTarget = pending
        pending = -1
        ref = frames[i]
      }
      stats.skipped++
      continue
    }

    if (d < bigTh) {
      // 逐字推进中：记住最后一帧，但不立刻 OCR
      pending = i
      stats.typing++
      continue
    }

    // 整句替换：立刻 OCR 这一帧
    if (i - lastTarget >= 1) { targets.push(i); lastTarget = i }
    stats.replace++
    pending = -1
    ref = frames[i]
  }
  // 结尾还在逐字段：把它交出去（可能是最后一句）
  if (pending >= 0 && pending !== lastTarget) targets.push(pending)
  targets.sort((a, b) => a - b)
  return { targets, deltas, stats }
}

/**
 * 变化方向分析：区分「只增加」和「又增又减」。
 *
 * 动机：打字机逐字是「只加新字，旧字不消失」；换句是「旧句消失 + 新句出现」。
 * 两者在**幅度**上可能一样大（一次弹 3-5 个字），但**方向**不同：
 *
 *   逐字   → 变亮的像素多，变暗的很少  → ratio 高
 *   换句   → 亮暗都多                  → ratio 接近 1
 *
 * 这是比「幅度」更可靠的区分维度。
 *
 * @returns {{brighter:number, darker:number, ratio:number, changed:number}}
 */
export function directionRatio(prev, cur, th = 8) {
  const n = Math.min(prev.length, cur.length)
  let brighter = 0, darker = 0
  for (let i = 0; i < n; i++) {
    const d = cur[i] - prev[i]
    if (d > th) brighter++
    else if (d < -th) darker++
  }
  return {
    brighter, darker,
    changed: (brighter + darker) / Math.max(1, n),
    ratio: brighter / Math.max(1, darker),
  }
}

/**
 * 灰度直方图变化：比较两帧直方图的分布差异。
 *
 * 逐字：直方图单调「往亮的方向移动」（新字是白色）
 * 换句：直方图重新分布（旧字消失，亮像素可能减少）
 *
 * @returns {{l1:number, meanShift:number, brightDelta:number}}
 */
export function histogramShift(prev, cur, bins = 16) {
  const hp = new Float64Array(bins), hc = new Float64Array(bins)
  const n = Math.min(prev.length, cur.length)
  for (let i = 0; i < n; i++) {
    hp[Math.min(bins - 1, prev[i] >> (8 - Math.log2(bins)))]++
    hc[Math.min(bins - 1, cur[i] >> (8 - Math.log2(bins)))]++
  }
  let l1 = 0
  for (let b = 0; b < bins; b++) l1 += Math.abs(hp[b] - hc[b])
  l1 /= Math.max(1, n)
  // 亮区（后 1/4 的 bin）像素占比变化
  const brightStart = Math.floor(bins * 0.75)
  const bp = hp.slice(brightStart).reduce((a, v) => a + v, 0) / Math.max(1, n)
  const bc = hc.slice(brightStart).reduce((a, v) => a + v, 0) / Math.max(1, n)
  return { l1, brightDelta: bc - bp }
}

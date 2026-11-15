// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/band-probe.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 字幕带探测：不认字，只看「哪里在变且位置固定」。
//
// 背景：原先字幕带坐标来自 16 个探测帧的 OCR det 投票。删掉 OCR 后需要替代方案。
// 判据来自字幕的两个固有特征：
//   ① 位置固定 —— 同一句字幕总在同一高度
//   ② 内容高频变化 —— 字幕是整片里换得最勤的东西
// 画面里其他东西要么不动（背景），要么整片一起动（镜头运动/人物走动）。
//
// 做法：抽样帧 → 相邻帧逐行差分 → 逐行累计 → 找「变化最集中的连续行区间」。
import { execFileSync } from 'node:child_process'

const PROBE_N = 16
const PW = 480          // 探测宽度（够看位置，不必精确）
const ROW_T = 0.35      // 行变化阈值：超过「最大行变化」的 35% 才算候选行
const MIN_H_RATIO = 0.02 // 带最小高度（占画面高）

/**
 * @param {string} video
 * @param {{n?:number, width?:number, rowThreshold?:number}} [opts]
 * @returns {{band:{y0:number,y1:number,x0:number,x1:number}|null, FW:number, FH:number, rows:Float64Array, peak:number}}
 */
export function probeSubtitleBand(video, opts = {}) {
  const n = opts.n ?? PROBE_N
  const PW_ = opts.width ?? PW
  const rowT = opts.rowThreshold ?? ROW_T

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', video], { encoding: 'utf8' }))
  const { width: VW, height: VH } = probe.streams[0]
  const PW2 = PW_ - (PW_ % 2)
  const PH = Math.max(2, Math.round(PW2 * VH / VW) - ((Math.round(PW2 * VH / VW)) % 2))

  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim()) || 0
  if (!dur) return { band: null, topBand: null, FW: VW, FH: VH, rows: new Float64Array(PH), peak: 0 }

  // 一次 ffmpeg 抽全部探测帧（比逐帧调用快一个数量级）
  const fps = Math.max(0.05, n / dur)
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=${fps.toFixed(4)},scale=${PW2}:${PH},format=gray`, '-frames:v', String(n),
    '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const fs = PW2 * PH
  const count = Math.floor(raw.length / fs)
  if (count < 2) return { band: null, topBand: null, FW: VW, FH: VH, rows: new Float64Array(PH), peak: 0 }

  // 行内高频率：文字的本质是「密集的亮暗交替」（笔画），背景是平滑或大块。
  // 这比「方差」更能区分文字与背景——方差只说明"这行在变"，
  // 高频率说明"这行有密集的小尺度结构"，后者才是文字。
  const hiFreq = new Float64Array(PH)
  for (let f = 0; f < count; f++) {
    const p = raw.subarray(f * fs, (f + 1) * fs)
    for (let y = 0; y < PH; y++) {
      const off = y * PW2
      let flips = 0
      for (let x = 2; x < PW2; x++) {
        const a = p[off + x - 2], b = p[off + x - 1], c = p[off + x]
        // 相邻差的方向反转 = 一次极值（笔画边缘的特征）
        if ((b - a) * (c - b) < 0 && Math.abs(c - a) > 12) flips++
      }
      hiFreq[y] += flips / Math.max(1, PW2)
    }
  }
  for (let y = 0; y < PH; y++) hiFreq[y] /= count

  // 逐像素方差图 → 行投影。
  // 只用「相邻帧差分」会把整帧都点亮（画面本身在动）；方差图能看出
  // 「哪儿在反复变」，但还需要下一步把「大面积的运动」和「窄条字幕」分开。
  const sum = new Float64Array(fs)
  const sum2 = new Float64Array(fs)
  for (let f = 0; f < count; f++) {
    const p = raw.subarray(f * fs, (f + 1) * fs)
    for (let i = 0; i < fs; i++) { sum[i] += p[i]; sum2[i] += p[i] * p[i] }
  }
  const varPerRow = new Float64Array(PH)
  for (let y = 0; y < PH; y++) {
    let s = 0
    const off = y * PW2
    for (let x = 0; x < PW2; x++) {
      const i = off + x
      const mu = sum[i] / count
      s += Math.max(0, sum2[i] / count - mu * mu)
    }
    varPerRow[y] = s / PW2
  }
  const peak = varPerRow.reduce((m, v) => (v > m ? v : m), 0)
  if (peak <= 0) return { band: null, FW: VW, FH: VH, rows: varPerRow, peak: 0 }

  // 找「相对邻居孤立地高」的窄带：字幕 = 上下都安静、自己很吵的细条。
  // 画面运动是「一大片都高」，会被这个判据排除掉。
  const smooth = (arr, r) => {
    const out = new Float64Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0
      for (let d = -r; d <= r; d++) { const j = i + d; if (j >= 0 && j < arr.length) { s += arr[j]; n++ } }
      out[i] = s / Math.max(1, n)
    }
    return out
  }
  const wide = smooth(varPerRow, Math.max(8, Math.round(PH * 0.06)))   // 局部背景水平
  const score = new Float64Array(PH)
  for (let y = 0; y < PH; y++) score[y] = varPerRow[y] / (wide[y] + 1e-6)

  // 用「行内高频率」找字幕行：文字行 = 密集笔画 = 高频率高。
  // 只看下半屏（字幕/进度条在下方；上半屏的标题另说）。
  const maxBandH = Math.max(4, Math.round(PH * 0.20))
  const yStart = Math.floor(PH * 0.40)
  let seed = -1, seedVal = 0
  for (let y = yStart; y < PH; y++) if (hiFreq[y] > seedVal) { seedVal = hiFreq[y]; seed = y }
  if (seed < 0 || seedVal <= 0) return { band: null, topBand: null, FW: VW, FH: VH, rows: varPerRow, peak, hiFreq }
  // 向两侧扩展：高频率保持在种子的一半以上才连进来
  const GROW_T = seedVal * 0.35
  let by0 = seed, by1 = seed
  while (by0 - 1 >= yStart && hiFreq[by0 - 1] >= GROW_T) by0--
  while (by1 + 1 < PH && hiFreq[by1 + 1] >= GROW_T) by1++
  let best = { y0: by0, y1: by1 }
  // ── 顶部标题带：有些视频（VTuber 直播、教程）在画面顶部挂一条常驻标题。
  // 它不是字幕，但同样是内容的一部分，漏掉会丢信息。
  // 上半屏用同样判据再找一次；找不到就返回 null。
  let topBand = null
  {
    const topEnd = Math.floor(PH * 0.35)
    let sSeed = -1, sVal = 0
    for (let y = 0; y < topEnd; y++) if (hiFreq[y] > sVal) { sVal = hiFreq[y]; sSeed = y }
    // 顶部标题的笔画更粗、更稀疏，高频率值通常低于底部字幕；用一个绝对下限挡掉纯噪声
    if (sSeed >= 0 && sVal > 0.02) {
      const gT = sVal * 0.35
      let t0 = sSeed, t1 = sSeed
      while (t0 - 1 >= 0 && hiFreq[t0 - 1] >= gT) t0--
      while (t1 + 1 < topEnd && hiFreq[t1 + 1] >= gT) t1++
      // 顶部标题常常是多行（主标题 + 副标题），探测到的往往只是最下面那行笔画。
      // 所以向上补一半带高，再封顶到画面高的 14%。
      const th = t1 - t0 + 1
      t0 = Math.max(0, t0 - Math.ceil(th * 0.9) - 2)
      const maxTopH = Math.max(4, Math.round(PH * 0.14))
      if (t1 - t0 + 1 > maxTopH) t0 = Math.max(0, t1 - maxTopH + 1)
      topBand = { y0: t0, y1: t1 }
    }
  }

  // 高度封顶（超出就保留靠下的部分，字幕主体在下方）
  if (best.y1 - best.y0 + 1 > maxBandH) best = { y0: best.y1 - maxBandH + 1, y1: best.y1 }
  const rows = varPerRow

  // 太薄（一行噪声）不算；换算到原视频像素坐标
  const minH = Math.max(2, Math.round(VH * MIN_H_RATIO))
  const k = VH / PH
  let y0 = Math.floor(best.y0 * k)
  let y1 = Math.ceil((best.y1 + 1) * k)
  if (y1 - y0 < minH) {
    const mid = Math.round((y0 + y1) / 2)
    y0 = Math.max(0, mid - Math.ceil(minH / 2))
    y1 = Math.min(VH, y0 + minH)
  }
  // 上下各放一点，但要封顶：带子过高会把背景一起裁进来，
  // 同一句字幕就会因为背景变化被判成不同（去重失效）。
  const h = y1 - y0
  const padBottom = Math.ceil(h * 0.3) + 2
  y1 = Math.min(VH, y1 + padBottom)
  // 向上只多给 0.8 倍带高（多行字幕时够用），不再兜底到画面 72%
  y0 = Math.max(0, y0 - Math.ceil(h * 0.8) - 2)

  // 硬上限：字幕区不应超过画面高的 15%。超了就以上沿为基准向下截，
  // 因为探测到的带主体（方差最高的部分）在下沿附近。
  const MAX_H_RATIO_CAP = 0.20
  const maxH = Math.max(8, Math.round(VH * MAX_H_RATIO_CAP))
  if (y1 - y0 > maxH) y0 = Math.max(0, y1 - maxH)

  const toVideo = (b) => b ? {
    y0: Math.floor(b.y0 * k),
    y1: Math.ceil((b.y1 + 1) * k),
    x0: 0, x1: VW,
  } : null

  return {
    band: { y0, y1, x0: 0, x1: VW },
    topBand: toVideo(topBand),
    FW: VW, FH: VH, rows, peak, hiFreq,
  }
}

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
  if (!dur) return { band: null, FW: VW, FH: VH, rows: new Float64Array(PH), peak: 0 }

  // 一次 ffmpeg 抽全部探测帧（比逐帧调用快一个数量级）
  const fps = Math.max(0.05, n / dur)
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=${fps.toFixed(4)},scale=${PW2}:${PH},format=gray`, '-frames:v', String(n),
    '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const fs = PW2 * PH
  const count = Math.floor(raw.length / fs)
  if (count < 2) return { band: null, FW: VW, FH: VH, rows: new Float64Array(PH), peak: 0 }

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

  // 取 score 最高的连续窄段（字幕行纵向通常 < 画面高的 15%）
  // 只在**下半屏**找：字幕/进度条/水印都在下方，上半屏的「孤立窄带」多半是
  // 标题、台标或人物头部——它们也会反复变，但不是字幕。
  const maxBandH = Math.max(4, Math.round(PH * 0.15))
  const yStart = Math.floor(PH * 0.45)
  let best = null
  for (let y0 = yStart; y0 < PH; y0++) {
    let acc = 0
    for (let h = 1; h <= maxBandH && y0 + h <= PH; h++) {
      acc += score[y0 + h - 1]
      const avg = acc / h
      if (!best || avg > best.avg) best = { y0, y1: y0 + h - 1, avg }
    }
  }
  if (!best) return { band: null, FW: VW, FH: VH, rows: varPerRow, peak }
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
  // 向上兜底到「画面底部 28%」：中英多行字幕时，高方差的那一行往往只是最下面一行
  // （它换得最勤），上面还有一两行中文/日文。宁可多带一点画面，也不能切掉字幕。
  const h = y1 - y0
  const padBottom = Math.ceil(h * 0.4) + 2
  y1 = Math.min(VH, y1 + padBottom)
  y0 = Math.min(y0 - Math.ceil(h * 0.5) - 2, Math.floor(VH * 0.72))
  y0 = Math.max(0, y0)

  return {
    band: { y0, y1, x0: 0, x1: VW },
    FW: VW, FH: VH, rows, peak,
  }
}

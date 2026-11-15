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

  // ── 全图找带：不再限制上下两段 ──
  // 指挥官 2026-11-16：视频开头/结尾常把字幕打在画面中间，
  // 只探上下两段会漏掉。所以对整张图找「高频率行」，聚成若干条带。
  const maxBandH = Math.max(4, Math.round(PH * 0.20))
  const allBands = []
  {
    // 全图最高值做门槛基准
    let globalMax = 0
    for (let y = 0; y < PH; y++) if (hiFreq[y] > globalMax) globalMax = hiFreq[y]
    if (globalMax <= 0) return { band: null, topBand: null, bands: [], FW: VW, FH: VH, rows: varPerRow, peak, hiFreq }
    const T = globalMax * 0.30           // 超过全图最高值 30% 就算候选行
    // 找出所有候选行，聚成连续段（间隔 ≤ 画面高 1.2% 视为同一带）
    const gap = Math.max(1, Math.round(PH * 0.012))
    const runs = []
    let cur = null
    for (let y = 0; y < PH; y++) {
      if (hiFreq[y] >= T) {
        if (!cur) cur = { y0: y, y1: y }
        else if (y - cur.y1 <= gap) cur.y1 = y
        else { runs.push(cur); cur = { y0: y, y1: y } }
      }
    }
    if (cur) runs.push(cur)
    // 每条带：高度封顶 + 计算「锐度」
    for (const r of runs) {
      let y0 = r.y0, y1 = r.y1
      if (y1 - y0 + 1 > maxBandH) y0 = y1 - maxBandH + 1
      // 带太薄（< 画面高 0.7%）当噪声丢掉
      if (y1 - y0 + 1 < Math.max(2, PH * 0.007)) continue
      // 锐度：带内相邻像素差的均值（边缘够不够陡）。文字越清晰，这个值越高。
      let sum = 0, n = 0
      for (let f = 0; f < count; f++) {
        const px = raw.subarray(f * fs, (f + 1) * fs)
        for (let y = y0; y <= y1; y++) {
          const off = y * PW2
          for (let x = 1; x < PW2; x++) { sum += Math.abs(px[off + x] - px[off + x - 1]); n++ }
        }
      }
      allBands.push({
        y0, y1,
        hFreq: Number((hiFreq.slice(y0, y1 + 1).reduce((a, b) => a + b, 0) / (y1 - y0 + 1)).toFixed(4)),
        sharp: Number((n ? sum / n : 0).toFixed(3)),
        pos: y0 / PH,
      })
    }
  }
  if (!allBands.length) return { band: null, topBand: null, bands: [], FW: VW, FH: VH, rows: varPerRow, peak, hiFreq }
  // 主带 = 「下半屏里最强的」那一条。
  // 不能直接取全场最强：顶部频道名/水印的笔画常常比字幕还密（实测 yamato 的
  // 顶部频道名 hFreq 0.105 > 字幕 0.075），那样主带会选到频道名上。
  // 字幕的可靠先验是「位置靠下」。
  const lower = allBands.filter((b) => b.pos >= 0.45)
  const best = (lower.length ? lower : allBands).slice().sort((a, b) => b.hFreq - a.hFreq)[0]
  // 排序：主带优先，其余按强度
  allBands.sort((a, b) => (b === best ? 1 : 0) - (a === best ? 1 : 0) || b.hFreq - a.hFreq)

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

  // topBand 兼容旧下游：把「位置在上半屏且不是主带」里最强的一条当 topBand
  const topPick = allBands.find((b) => b !== best && b.pos < 0.35) || null
  const topBandV = topPick ? { y0: topPick.y0, y1: topPick.y1 } : null

  return {
    band: { y0, y1, x0: 0, x1: VW },
    topBand: toVideo(topBandV),
    // 全量带（含主带），按强度排序；每条带 hFreq（笔画密度）与 sharp（锐度）
    bands: allBands.map((b) => {
      const v = toVideo(b)
      return { ...v, hFreq: b.hFreq, sharp: b.sharp, pos: Number(b.pos.toFixed(2)), main: b === best }
    }),
    FW: VW, FH: VH, rows, peak, hiFreq,
  }
}

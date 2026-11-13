// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/frame-dedup.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 帧级去重（ADR-0018，分层：运动门控 → pHash → 时间保底）
//
// 借鉴自两个开源实现：
//   PlainsightAI/filter-frame-dedup   —— motion_gate → hash_dedup → ssim_dedup 三级流水线
//     · MOTION_GATE_PIXEL_DELTA_THRESHOLD = 1.5（平均逐像素差）
//     · MOTION_GATE_EVAL_WIDTH = 480（降采样后再算差）
//     · HASH_THRESHOLD = 5
//     · MIN_TIME_BETWEEN_FRAMES = 1.0s
//   davidhc1230/Video_Page_Extractor —— pHash 粗筛 + SSIM 精筛，SSIM 只对 pHash 通过的跑
//
// 关键设计：与「上一个保留帧」比较，不是与上一帧比较。
// 与上一帧比会串成链（A≈B、B≈C ⇒ A≈C），缓慢变化会被整段吞掉 —— 页面去重那边踩过这个坑。
import { execFileSync } from 'node:child_process'

const MOTION_DELTA_TH = Number(process.env.FRAME_MOTION_TH || 1.5)   // 平均逐像素差低于此值 = 画面没动
const MOTION_W = 480          // 运动门控的降采样宽度
const PHASH_TH = Number(process.env.FRAME_PHASH_TH || 3)   // 汉明距离 ≤3 视为重复（实测 5 会删掉 86%）
const MIN_TIME = Number(process.env.FRAME_MIN_TIME || 3.0)  // 时间保底：约 3 秒一个时间点

// 从 480 宽灰度里降采样出 32×32（最近邻足够——pHash 只取低频）
function down32(px, W, H) {
  const out = new Float64Array(32 * 32)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const sx = Math.min(W - 1, Math.floor((x + 0.5) * W / 32))
      const sy = Math.min(H - 1, Math.floor((y + 0.5) * H / 32))
      out[y * 32 + x] = px[sy * W + sx]
    }
  }
  return out
}

const COS = (() => {
  const N = 32
  return Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => Math.cos(((2 * i + 1) * j * Math.PI) / (2 * N))))
})()

function phash32(px32) {
  const dct = []
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0
      for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) s += px32[y * 32 + x] * COS[x][u] * COS[y][v]
      dct.push(s)
    }
  }
  const mean = dct.slice(1).reduce((a, b) => a + b, 0) / (dct.length - 1)
  return dct.map((v) => (v > mean ? 1 : 0))
}

function hamming(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/** 读一张图为 480 宽灰度像素（Uint8Array） */
function grayWide(path) {
  const meta = execFileSync('magick', ['identify', '-format', '%w %h', path], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
  const H = Math.max(2, Math.round(meta[1] * MOTION_W / meta[0]))
  const buf = execFileSync('magick', [path, '-colorspace', 'Gray', '-resize', `${MOTION_W}x${H}!`, '-depth', '8', 'gray:-'],
    { maxBuffer: 64 * 1024 * 1024 })
  return { px: new Uint8Array(buf), W: MOTION_W, H }
}

/** 两帧的平均逐像素差（0-255 量级） */
export function meanAbsDelta(a, b) {
  const n = Math.min(a.px.length, b.px.length)
  if (!n) return 999
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a.px[i] - b.px[i])
  return sum / n
}

/**
 * 帧级去重。
 *
 * @param {Array<{t:number, file:string}>} frames 采样出来的帧（按时间升序）
 * @param {{motionTh?:number, phashTh?:number, minTime?:number}} opts
 * @returns {{kept:Array, dropped:Array, stats:object}}
 */
export function dedupFrames(frames, opts = {}) {
  const motionTh = opts.motionTh ?? MOTION_DELTA_TH
  const phashTh = opts.phashTh ?? PHASH_TH
  const minTime = opts.minTime ?? MIN_TIME

  const kept = []
  const dropped = []
  if (!frames.length) return { kept, dropped, stats: { total: 0, kept: 0, dropped: 0 } }

  let rep = null            // 上一个保留帧的 { gray, hash, t }
  let skippedByMotion = 0
  let skippedByHash = 0

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    let g
    try { g = grayWide(f.file) } catch (e) {
      // 读图失败 → 不确定就保留
      kept.push({ ...f, dedupReason: '读取失败，按不确定保留' })
      continue
    }
    const hash = phash32(down32(g.px, g.W, g.H))

    if (!rep) {
      kept.push({ ...f, dedupReason: 'first' })
      rep = { gray: g, hash, t: f.t }
      continue
    }

    const motion = meanAbsDelta(rep.gray, g)
    if (motion < motionTh) {
      dropped.push({ ...f, dedupReason: `运动门控 ${motion.toFixed(2)} < ${motionTh}` })
      skippedByMotion++
      continue
    }

    const dist = hamming(rep.hash, hash)
    const dt = f.t - rep.t
    if (dist <= phashTh) {
      // 时间保底：距上一个保留帧不足 minTime 时，只有当它「确实重复」才删；
      // 否则（快速动作但哈希恰好接近）也保留 —— 这一条防止快剪段被整段吞掉。
      if (dt >= minTime) {
        dropped.push({ ...f, dedupReason: `pHash ${dist} ≤ ${phashTh}，且距上帧 ${dt.toFixed(2)}s ≥ ${minTime}s` })
        skippedByHash++
        continue
      }
      kept.push({ ...f, dedupReason: `pHash ${dist} 但距上帧仅 ${dt.toFixed(2)}s，时间保底保留` })
      rep = { gray: g, hash, t: f.t }
      continue
    }

    kept.push({ ...f, dedupReason: `运动 ${motion.toFixed(1)}，pHash ${dist}` })
    rep = { gray: g, hash, t: f.t }
  }

  return {
    kept,
    dropped,
    stats: {
      total: frames.length,
      kept: kept.length,
      dropped: dropped.length,
      ratio: +(1 - kept.length / frames.length).toFixed(3),
      motionSkipped: skippedByMotion,
      hashSkipped: skippedByHash,
    },
  }
}

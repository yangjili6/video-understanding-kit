// ⚠ 自动生成文件，请勿编辑。
// 真源：pipeline.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 视频理解流水线 · 最小原型 v5.2
// 规则来源：video-research/README.md + v5 设计稿（三轮 GPT 批评）+ GPT 实现审查（2026-10-18）
//
// v5.2 相对 v5.1 的修正（按 GPT 审查优先级）：
//   1. 无画面变化候选时，做独立回看（固定采样），不再把语音触发绑回视觉检测；
//   2. 变化检测保留「触发帧对」（prevT → curT），补帧从锚点取，不再只靠段起中终猜点；
//   3. 状态拆成三字段：extraction（取帧）/ read（阅读）/ assessment（事件判断）+ reason；
//   4. 帧身份：requestTime + sourceFrameId（按视频帧率估算）+ extractionId（取帧任务 ID）；
//   5. 分组边界上下文：边界附近帧同时进相邻两组，共享同一 sourceFrameId，记录跨组关系；
//   6. 自动断言：已接纳帧全部进页、组时长兜底生效、状态不被误算成完成。
//
// 原型边界：ASR/OCR 只生成候选，视觉事件语义由调用方核验；本程序不自动给出视频内容结论。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs'
import { detectCpuTopology, ioConcurrency, detectLoad } from './lib/cpu.mjs'
import { Worker } from 'node:worker_threads'
import { join, dirname } from 'node:path'
import { transcribeVideo } from './asr.mjs'
import { detectCuts } from './lib/transnet-lib.mjs'
import { dedupPages, setDedupTmp } from './lib/dedup.mjs'
import { dedupFrames } from './lib/frame-dedup.mjs'
import { extractSubtitles, dumpStageTiming, resetStageTiming } from './subs.mjs'

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    } else out._.push(a)
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const VIDEO = args.video || args._[0]
if (!VIDEO || !existsSync(VIDEO)) {
  console.error('用法: node pipeline.mjs --video <mp4> [--out out] [--cues cues.json] [--base-fps 2] [--change-fps 5] [--diff-threshold 8] [--window 2] [--max-group 8] [--fallback-samples 3] [--force]')
  process.exit(1)
}
const OUT = args.out || 'out'
const CUES_FILE = args.cues || null
const ASR = !!args.asr
// 基础抽帧率。0 = 自动：按帧预算与时长反推（见 probe 之后），
// 显式传 --base-fps 才用固定值。固定 5fps 会让页数随时长线性膨胀。
let BASE_FPS = Number(args['base-fps'] || 0)
const CHANGE_FPS = Number(args['change-fps'] || 5)
const DIFF_TH = Number(args['diff-threshold'] || 8)
const WINDOW = Number(args.window || 2)
const MAX_GROUP = Number(args['max-group'] || 8)
const FALLBACK_SAMPLES = Number(args['fallback-samples'] || 3)
const PAGE_SCALE = Number(args['page-scale'] || 1.8)
const FORCE = args.force === true
const PAGE_FRAMES = 6
// 展示帧预算：不管视频多长，进入网格的帧数受这个上限约束。
// 不设上限时页数 = 时长 × fps ÷ 6，是线性膨胀的（135s 出 112 页、10 分钟出 500 页）。
// 采样模式（验收对照用）：uniform=均匀 / skeleton=仅骨架+镜头补缺 / full=全五步
const SAMPLING_MODE = String(args['sampling-mode'] || process.env.DSH_SAMPLING_MODE || 'uniform')
const FRAME_BUDGET = Number(process.env.DSH_FRAME_BUDGET || 120)
// 单页起点之间的最大间隔（秒）。这是「时间保底」约束：
// 默认 3 秒：300 帧预算下（50 页）135 秒视频要 2.7 秒/页，取 2 秒会一直报「预算不足」；
// 3 秒留给长视频一点余量，实际间隔仍以 samplingBudget 里的 pageStepSec 为准。
// 超过它说明预算不足以满足覆盖要求，必须如实报「未满足」，不能悄悄放宽后假装满足。
const MAX_GAP_SEC = Number(process.env.DSH_MAX_GAP_SEC || 7)
const MAX_EXTRA_PER_CUE = 12
const MAX_EXTRA_TOTAL = 120
const EPS = 0.001

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts })

// ---------------------------------------------------------------- 软字幕

// 检测视频里有没有「文字型」字幕轨。
// 图形字幕（hdmv_pgs / dvd_subtitle）是位图，提取不出文本，仍然要走 OCR。
function probeSubtitleTracks(video) {
  try {
    const out = String(run('ffprobe', ['-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name,codec_type', '-of', 'json', video])).trim()
    const streams = JSON.parse(out).streams || []
    const TEXTUAL = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])
    return streams.filter((x) => TEXTUAL.has(String(x.codec_name || '').toLowerCase()))
  } catch {
    return []
  }
}

// 把软字幕提取成 [{ start, end, text }]；失败返回 null，让调用方回退到 OCR
function extractSoftSubtitles(video, outPath) {
  try {
    mkdirSync(dirname(outPath), { recursive: true })
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video,
      '-map', '0:s:0', '-c:s', 'srt', '-y', outPath])
    const raw = readFileSync(outPath, 'utf8')
    const cues = []
    let cur = null
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/)
      if (m) {
        if (cur && cur.text) cues.push(cur)
        cur = {
          start: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000,
          end: (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000,
          text: '',
        }
      } else if (cur && line.trim() && !/^\d+$/.test(line.trim())) {
        cur.text = (cur.text ? cur.text + ' ' : '') + line.trim().replace(/<[^>]+>/g, '')
      }
    }
    if (cur && cur.text) cues.push(cur)
    return cues.length ? cues : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 探测

function probe() {
  const dur = Number(String(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO])).trim())
  const rate = String(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', VIDEO])).trim()
  const [a, b] = rate.split('/').map(Number)
  const fps = b ? a / b : 30
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('ffprobe 读不到时长')
  const wh = String(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO])).trim().split(',').map(Number)
  return { duration: dur, fps, width: wh[0] || 640, height: wh[1] || 360 }
}

// 源帧身份：按视频帧率把请求时间映射到源帧号（可跨路径对齐同一源帧）
const srcId = (t, fps) => `f-${String(Math.round(t * fps)).padStart(6, '0')}`

// ---------------------------------------------------------------- 基础呈现帧（默认 5fps）

function extractBaseFrames(fps) {
  const dir = join(OUT, 'base')
  mkdirSync(dir, { recursive: true })
  // 按原始帧号采样（select），不用 fps 滤镜：fps 滤镜的采样相位与编号不对齐
  // （实测 2fps 第 15 帧标称 7.0s，实际内容是 7.25s 的帧）。
  const step = Math.max(1, Math.round(fps / BASE_FPS))
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', VIDEO, '-vf', `select='not(mod(n,${step}))'`, '-fps_mode', 'passthrough', '-q:v', '2', join(dir, '%04d.jpg')])
  return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f, i) => {
    const t = (i * step) / fps
    return { requestTime: t, t, sourceFrameId: srcId(t, fps), extractionId: `base-${String(i).padStart(4, '0')}`, source: 'base', file: join(dir, f) }
  })
}

// ---------------------------------------------------------------- 变化检测（5fps，分块最大差，保留触发帧对）

async function detectChanges(fps) {
  const W = 160, H = 90, B = 8
  // 按原始帧号抽样，并逐帧处理，避免把整段 rawvideo 留在内存。
  const step = Math.max(1, Math.round(fps / CHANGE_FPS))
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', VIDEO,
    '-vf', "select='not(mod(n," + step + "))',scale=" + W + ':' + H + ',format=rgb24',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-',
  ]
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let spawnError = null
  let stderr = ''
  child.on('error', (e) => { spawnError = e })
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
  const closePromise = new Promise((resolve) => child.once('close', resolve))

  const frameSize = W * H * 3
  const changes = []
  const histDiffs = []
  const histArr = []
  let pending = Buffer.alloc(0)
  let prev = null
  let frameIndex = 0

  const processFrame = (cur) => {
    const i = frameIndex++
    const t = (i * step) / fps
    const hist = new Float32Array(48)
    for (let p = 0; p < cur.length; p += 3) {
      hist[Math.floor(cur[p] / 16)]++
      hist[16 + Math.floor(cur[p + 1] / 16)]++
      hist[32 + Math.floor(cur[p + 2] / 16)]++
    }
    const pixels = cur.length / 3
    for (let k = 0; k < 48; k++) hist[k] /= pixels
    histArr.push({ t, h: hist })

    if (prev) {
      let maxBlock = 0
      for (let by = 0; by < H; by += B) {
        for (let bx = 0; bx < W; bx += B) {
          let sum = 0, count = 0
          const yEnd = Math.min(by + B, H), xEnd = Math.min(bx + B, W)
          for (let y = by; y < yEnd; y++) {
            for (let x = bx; x < xEnd; x++) {
              const p = (y * W + x) * 3
              sum += Math.abs(cur[p] - prev.frame[p]) + Math.abs(cur[p + 1] - prev.frame[p + 1]) + Math.abs(cur[p + 2] - prev.frame[p + 2])
              count += 3
            }
          }
          maxBlock = Math.max(maxBlock, sum / count)
        }
      }
      const prevT = ((i - 1) * step) / fps
      changes.push({ prevT, curT: t, t, score: Number(maxBlock.toFixed(3)) })
      let histDiff = 0
      for (let k = 0; k < 48; k++) histDiff += Math.abs(hist[k] - prev.hist[k])
      histDiffs.push({ t, d: Number((histDiff / 2).toFixed(4)) })
    }
    prev = { frame: cur, hist }
  }

  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= frameSize) {
        const frame = Buffer.from(pending.subarray(0, frameSize))
        pending = pending.subarray(frameSize)
        processFrame(frame)
      }
    }
  } catch (e) {
    child.kill()
    throw e
  }

  const code = await closePromise
  if (spawnError) throw spawnError
  if (code !== 0) throw new Error('ffmpeg 帧差解码失败：' + (stderr || '无错误详情'))
  if (pending.length) throw new Error('ffmpeg 输出了不完整的 RGB 帧')

  const hits = changes.filter((d) => d.score >= DIFF_TH)
  const segs = []
  for (const h of hits) {
    const last = segs[segs.length - 1]
    if (last && h.curT - last.to <= 0.5) {
      last.to = h.curT
      last.peak = Math.max(last.peak, h.score)
      last.anchors.push({ prevT: h.prevT, curT: h.curT, score: h.score })
    } else {
      segs.push({ from: h.curT, to: h.curT, peak: h.score, anchors: [{ prevT: h.prevT, curT: h.curT, score: h.score }] })
    }
  }
  return { changes, segs, histDiffs, hists: histArr }
}
// ---------------------------------------------------------------- 候选（cues 模拟字幕/STT）

function loadCues() {
  if (!CUES_FILE) return []
  const raw = JSON.parse(readFileSync(CUES_FILE, 'utf8'))
  return raw.map((c, i) => ({
    id: `c${String(i + 1).padStart(2, '0')}`,
    s: Number(c.s), e: Number(c.e), text: String(c.text || ''),
    // 三字段状态（GPT 审查：取帧 / 阅读 / 事件判断分开）
    extraction: 'pending', read: 'not_read', assessment: 'unassessed', reason: null,
    window: [Math.max(0, Number(c.s) - WINDOW), Number(c.e) + WINDOW],
    matchedChanges: [],
    extraFrames: [],
    note: null,
  }))
}

// ---------------------------------------------------------------- 抽单帧（补帧 / 回退）

let extraCount = 0
function extractFrameAt(t, fps, source) {
  const dir = join(OUT, 'extra')
  mkdirSync(dir, { recursive: true })
  const id = `extra-${String(++extraCount).padStart(4, '0')}`
  const file = join(dir, `${id}.jpg`)
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', VIDEO, '-frames:v', '1', '-q:v', '2', file])
  return { requestTime: t, t, sourceFrameId: srcId(t, fps), extractionId: id, source, file }
}

// 合并桥：候选窗口内找画面变化段 → 从触发帧对锚点补帧（偏召回）；
// 无画面候选 → 独立回看（固定采样），不再绑回视觉检测（GPT 审查第 1 条）
// 补帧提取是「每帧一次 ffmpeg spawn」，串行时 20 个点要十几秒。
// 改成两阶段：先在同步阶段把预算/采样点全部算清，再并发提取（AGENTS：改完需 pnpm run sync）。
function extractFrameAtAsync(t, fps, source) {
  const dir = join(OUT, 'extra')
  mkdirSync(dir, { recursive: true })
  const id = `extra-${String(++extraCount).padStart(4, '0')}`
  const file = join(dir, `${id}.jpg`)
  return runAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', VIDEO, '-frames:v', '1', '-q:v', '2', file])
    .then(() => ({ requestTime: t, t, sourceFrameId: srcId(t, fps), extractionId: id, source, file }))
}

async function searchCandidates(cues, segs, fps) {
  let budgetUsed = 0
  const plan = []      // { t, source, cueIdx }
  const decisions = [] // 每条 cue 的回填信息

  for (let ci = 0; ci < cues.length; ci++) {
    const c = cues[ci]
    const [wFrom, wTo] = c.window
    const inWin = segs.filter((s) => s.to >= wFrom && s.from <= wTo)
    c.matchedChanges = inWin.map((s) => ({ from: s.from, to: s.to, peak: Number(s.peak) }))

    if (budgetUsed >= MAX_EXTRA_TOTAL) {
      c.extraction = 'deferred'; c.reason = 'budget_exhausted'; c.note = '补帧总预算已用尽，未展开'
      decisions[ci] = null
      continue
    }

    if (!inWin.length) {
      // 回退：窗内固定采样点（有预算才做）
      const pts = []
      const n = Math.min(FALLBACK_SAMPLES, MAX_EXTRA_TOTAL - budgetUsed)
      for (let i = 0; i < n; i++) {
        pts.push(Number((wFrom + ((wTo - wFrom) * i) / Math.max(1, n - 1)).toFixed(2)))
      }
      const start = plan.length
      for (const t of pts) {
        if (budgetUsed >= MAX_EXTRA_TOTAL) break
        plan.push({ t, source: 'fallback', cueIdx: ci })
        budgetUsed++
      }
      decisions[ci] = { start, count: plan.length - start, kind: 'fallback' }
      continue
    }

    // 从触发帧对取点：每个锚点的 prevT（变化前）与 curT（变化后）都保
    const pts = new Set()
    for (const s of inWin) {
      for (const a of s.anchors) {
        if (a.prevT >= wFrom - EPS && a.prevT <= wTo + EPS) pts.add(Number(a.prevT.toFixed(2)))
        if (a.curT >= wFrom - EPS && a.curT <= wTo + EPS) pts.add(Number(a.curT.toFixed(2)))
      }
    }
    const list = [...pts].sort((a, b) => a - b)
    // 预算内均匀抽样（不是取前 N 个）：覆盖整个窗口，而不是集中在开头
    const take = Math.min(list.length, MAX_EXTRA_PER_CUE, Math.max(0, MAX_EXTRA_TOTAL - budgetUsed))
    const idxs = take >= list.length
      ? list.map((_, i) => i)
      : Array.from({ length: take }, (_, i) => Math.round((i * (list.length - 1)) / Math.max(1, take - 1)))
    const start = plan.length
    for (const i of idxs) {
      if (budgetUsed >= MAX_EXTRA_TOTAL) break
      plan.push({ t: list[i], source: 'extra', cueIdx: ci })
      budgetUsed++
    }
    decisions[ci] = { start, count: plan.length - start, kind: 'extra', listLength: list.length }
  }

  // 并发提取（每帧独立，用同一并发池）
  const frames = new Array(plan.length)
  await runPool(plan.map((item, i) => async () => {
    frames[i] = await extractFrameAtAsync(item.t, fps, item.source)
  }))

  // 回填提取状态（文案与串行版一致）
  for (let ci = 0; ci < cues.length; ci++) {
    const d = decisions[ci]
    if (!d) continue
    const c = cues[ci]
    c.extraFrames = frames.slice(d.start, d.start + d.count)
    if (d.kind === 'fallback') {
      c.extraction = c.extraFrames.length ? 'expanded' : 'deferred'
      c.reason = 'no_visual_candidate'
      c.note = c.extraFrames.length
        ? '窗内无画面变化候选，按固定间隔回看；不代表操作未发生'
        : '窗内无画面变化候选且无预算回看，未展开'
    } else if (c.extraFrames.length === 0) {
      c.extraction = 'deferred'; c.reason = 'budget_exhausted'; c.note = '预算不足，未取帧'
    } else if (c.extraFrames.length < d.listLength) {
      c.extraction = 'partial'; c.reason = 'budget_exhausted'; c.note = `锚点 ${d.listLength} 个，只展开 ${c.extraFrames.length} 个`
    } else {
      c.extraction = 'expanded'
    }
  }
  return budgetUsed
}


// ---------------------------------------------------------------- 呈现集合（只增不减）

/**
 * 保底采样：把「全量帧」裁到预算内，同时尽量守住时间覆盖。
 *
 * 规则（第一版，按霁璃的「镜头保底 + 时间保底」）：
 *   1. 按预算铺均匀的页起点（间隔 = 时长 / 页预算）
 *   2. 起点靠近镜头边界时吸附到边界（镜头代表点，不额外消耗页数）
 *   3. 每个起点取连续 PAGE_FRAMES 帧（页内保持动作连续，不做稀疏采样）
 *   4. 页间隔超过 MAX_GAP_SEC → 报告 satisfied:false，不假装满足
 *
 * 为什么页内仍取连续帧：稀疏采样会把一页变成「6 个相隔 2 秒的点」，
 * 网格就不再表示「某几秒内发生了什么」，看动作的意义没了。
 * 稀疏应该发生在**选哪些页**，不是页内部。
 */
/**
 * 保底采样：把「全量帧」裁到预算内，同时让采样密度跟着画面变化走。
 *
 * 两个约束分工明确：
 *   - 时间保底：任何相邻页起点间隔不超过 maxGapSec（超了就报未满足，不偷偷放宽）
 *   - 变化加权：满足保底之后，剩下的预算按「间隙长度 × 该段变化强度」插入
 *
 * 为什么不能只做均匀骨架：短视频里"素材快剪"和"坐着口播"的信息密度差好几倍。
 * 均匀采样会把口播段和快剪段同等对待——快剪段漏掉动作，口播段浪费页数。
 *
 * 变化强度用直方图帧差（histDiffs，CHANGE_FPS 独立采样，不受展示帧率影响）：
 * 先按中位数归一化，clamp 到 [0.2, 3]，避免个别转场尖峰把整段权重带跑。
 * 单段额外配额有上限（间隙不短于骨架步长的 0.4 倍就停止插入），防止高变化段吞光预算。
 */
/**
 * 保底采样 —— 五步原型（2026-11-11，按霁璃的方案重写）。
 *
 * 核心修正：**预算的单位是「图像槽位」，不是「页」。**
 * 上一版把「起点数」当页数，然后纠结 20 页装不下 35 个镜头——那是算错了账。
 * 20 页 × 6 格 = 120 个槽位，35 个镜头各占一帧完全放得下。
 *
 * 五步：
 *   ① 预算 = pages × PAGE_FRAMES 个图像槽位
 *   ② 时间骨架：每 maxGapSec 一个代表帧（保证**最终帧间隔**，不是页起点间隔）
 *   ③ 镜头补缺：每个镜头至少一帧；已被骨架覆盖的不重复交保底税
 *   ④ 变化加密：剩余槽位按变化强度插点
 *   ⑤ 输出按时间排序的帧列表，装页交给下游全局切
 *
 * 若骨架 + 镜头补缺就超预算，如实报告：优先保时间骨架，列出未覆盖的镜头。
 */
function selectCoverageFrames(frames, { cutTimes, durationSec, budgetPages, maxGapSec, histDiffs, cues, changes }) {
  const frameBudget = Math.max(PAGE_FRAMES * 3, Math.floor(budgetPages) * PAGE_FRAMES)

  if (frames.length <= frameBudget) {
    return {
      frames,
      report: {
        enabled: true,
        budgetFrames: frameBudget,
        budgetPages: Math.floor(budgetPages),
        plannedPages: Math.ceil(frames.length / PAGE_FRAMES),
        sourceFrames: frames.length,
        actualFrames: frames.length,
        note: '帧数本来就在预算内，未裁剪',
        satisfied: true,
      },
    }
  }

  const pickAt = (t) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].t - t)
      if (d < bestD) { bestD = d; best = i }
      else if (frames[i].t > t + 1.5) break
    }
    return best
  }
  const picked = new Set()

  // ② 时间骨架：段中心取点，保证相邻骨架帧间隔 ≈ duration/gapCount ≤ maxGapSec
  const gapCount = Math.max(2, Math.ceil(durationSec / maxGapSec))
  const step = durationSec / gapCount
  for (let k = 0; k < gapCount; k++) {
    if (picked.size >= frameBudget) break
    picked.add(pickAt(k * step + step / 2))
  }
  const skeletonFrames = picked.size

  // ── 验收对照：uniform 跳过骨架与镜头补缺，直接按时长均分取点 ──
  if (SAMPLING_MODE === 'uniform') {
    picked.clear()
    for (let k = 0; k < frameBudget; k++) {
      const t = ((k + 0.5) * durationSec) / frameBudget
      picked.add(pickAt(t))
    }
    const outU = frames.filter((_, i) => picked.has(i))
    let gU = 0
    for (let i = 1; i < outU.length; i++) gU = Math.max(gU, outU[i].t - outU[i - 1].t)
    return {
      frames: outU,
      report: {
        enabled: true, mode: 'uniform',
        budgetFrames: frameBudget, budgetPages: Math.floor(budgetPages),
        actualFrames: outU.length, plannedPages: Math.ceil(outU.length / PAGE_FRAMES),
        sourceFrames: frames.length,
        maxFrameGapSec: +gU.toFixed(2), maxGapLimitSec: maxGapSec,
        satisfied: gU <= maxGapSec + 0.01,
        note: '验收对照：均匀采样（无骨架、无镜头补缺、无变化加密）',
      },
    }
  }

  // ③ 镜头补缺：每个镜头至少一帧
  const cuts = Array.isArray(cutTimes) && cutTimes.length >= 2 ? cutTimes : [0, durationSec]
  let lensFilled = 0
  const uncoveredLens = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    if (!(b > a)) continue
    let anyPicked = false
    let first = -1
    let last = -1
    for (let j = 0; j < frames.length; j++) {
      const t = frames[j].t
      if (t < a || t >= b) continue
      if (first < 0) first = j
      last = j
      if (picked.has(j)) { anyPicked = true; break }
    }
    if (anyPicked || first < 0) continue
    if (picked.size >= frameBudget) {
      uncoveredLens.push({ from: +a.toFixed(2), to: +b.toFixed(2) })
      continue
    }
    // 镜头内部取代表帧（避开首尾各 1 帧，减少落在转场上的概率）
    const inner = last > first + 2 ? [first + 1, last - 1] : [first, last]
    const mid = Math.round((inner[0] + inner[1]) / 2)
    picked.add(mid)
    lensFilled += 1
  }

  // ④ 变化加密：剩余槽位按「间隙长度 × 变化强度」插点
  const diffs = (histDiffs || []).filter((h) => Number.isFinite(h.d) && h.d > 0)
  const vals = diffs.map((h) => h.d).sort((x, y) => x - y)
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0
  const noiseFloor = vals.length ? vals[Math.floor(vals.length * 0.25)] : 0
  // ── 多信号评分（GPT 方案，2026-11-11）──
  // 单一「画面变化」会把「静态但语义重要」的段落降权——实测 KV-7 的 K7（豹2只有一门炮）
  // 画面静止但字幕与语音持续输出，结果被挪走帧、漏掉命中。
  // 五路信号加权后，静态讲解段靠 O/A 保住分数。
  const absNorm = (arr, key) => {
    const vals = arr.map((x) => Math.abs(Number(x[key]) || 0)).filter((v) => v > 0).sort((x, y) => x - y)
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : 1
    return (t0, t1) => {
      const sel = arr.filter((x) => x.t >= t0 && x.t < t1)
      if (!sel.length || !(med > 0)) return 0
      let sum = 0
      for (const x of sel) sum += Math.min(3, Math.abs(Number(x[key]) || 0) / med)
      return sum / sel.length
    }
  }
  const nC = absNorm(diffs, 'd')        // C 画面变化
  const nM = absNorm(changes || [], 'score')  // M 运动
  const cuesArr = cues || []
  const valueAt = (a, b) => {
    const C = nC(a, b)
    const M = nM(a, b)
    const inWin = cuesArr.filter((c) => c.e >= a && c.s < b)
    const O = inWin.length ? 1 : 0                       // O 有字幕
    const density = (b - a) > 0 ? inWin.length / (b - a) : 0
    const A = density > 0.25 ? 1 : density > 0.1 ? 0.5 : 0  // A 字幕密度≈语音密度
    const mid = (a + b) / 2
    const T = (cutTimes || []).some((c) => Math.abs(c - mid) < 2.5) ? 1 : 0  // T 镜头结构
    return 0.25 * C + 0.20 * M + 0.20 * A + 0.15 * O + 0.20 * T
  }

  const strengthAt = (a, b) => {
    const sel = diffs.filter((h) => h.t >= a && h.t < b)
    if (!sel.length || !(median > 0)) return 1
    let sum = 0
    for (const h of sel) sum += h.d <= noiseFloor ? 1 : Math.max(0.2, Math.min(3, h.d / median))
    return sum / sel.length
  }

  // ── 验收对照：skeleton 模式不做变化加密 ──
  if (SAMPLING_MODE === 'skeleton') {
    const outS = frames.filter((_, i) => picked.has(i))
    let gS = 0
    for (let i = 1; i < outS.length; i++) gS = Math.max(gS, outS[i].t - outS[i - 1].t)
    return {
      frames: outS,
      report: {
        enabled: true, mode: 'skeleton',
        budgetFrames: frameBudget, budgetPages: Math.floor(budgetPages),
        actualFrames: outS.length, plannedPages: Math.ceil(outS.length / PAGE_FRAMES),
        sourceFrames: frames.length,
        skeletonFrames, lensFilled, densityFrames: 0, lensTotal: cuts.length - 1,
        uncoveredLens,
        maxFrameGapSec: +gS.toFixed(2), maxGapLimitSec: maxGapSec,
        satisfied: gS <= maxGapSec + 0.01,
        note: '验收对照：时间骨架 + 镜头补缺（不含变化加密）',
      },
    }
  }

  let order = [...picked].sort((x, y) => frames[x].t - frames[y].t)
  let densityFrames = 0
  const idealGap = durationSec / Math.max(1, frameBudget)
  const minGapForDensity = Math.max(frames.length > 1 ? (frames[1].t - frames[0].t) * 1.1 : 0.4, idealGap * 0.6)
  while (picked.size < frameBudget) {
    let bestI = -1
    let bestScore = -1
    for (let i = 0; i + 1 < order.length; i++) {
      const a = frames[order[i]].t
      const b = frames[order[i + 1]].t
      const gap = b - a
      // 加密下限跟着「预算密度」走，而不是固定 step×0.3：
      // 预算 198 帧 / 198 秒 = 每帧 1 秒，下限就该允许到 0.6 秒，
      // 否则「下限 2 秒」会把 198 帧的预算卡在 116 帧用不完（实测）。
      if (gap <= minGapForDensity) continue
      const score = gap * (0.35 + valueAt(a, b))
      if (score > bestScore) { bestScore = score; bestI = i }
    }
    if (bestI < 0) break
    const midT = (frames[order[bestI]].t + frames[order[bestI + 1]].t) / 2
    const ni = pickAt(midT)
    if (picked.has(ni)) break
    picked.add(ni)
    order.splice(bestI + 1, 0, ni)
    densityFrames += 1
  }

  const out = frames.filter((_, i) => picked.has(i))

  // ⑤ 约束检查：用**最终帧时间戳**算最大间隔（不是页起点）
  let maxFrameGap = 0
  for (let i = 1; i < out.length; i++) maxFrameGap = Math.max(maxFrameGap, out[i].t - out[i - 1].t)
  const headGap = out.length ? out[0].t : durationSec
  const tailGap = out.length ? durationSec - out[out.length - 1].t : durationSec
  const satisfied = maxFrameGap <= maxGapSec + 0.01

  return {
    frames: out,
    report: {
      enabled: true,
      mode: SAMPLING_MODE,
      budgetFrames: frameBudget,
      budgetPages: Math.floor(budgetPages),
      actualFrames: out.length,
      plannedPages: Math.ceil(out.length / PAGE_FRAMES),
      sourceFrames: frames.length,
      skeletonFrames,
      lensFilled,
      densityFrames,
      uncoveredLens,
      lensTotal: cuts.length - 1,
      pageStepSec: +step.toFixed(2),
      maxFrameGapSec: +maxFrameGap.toFixed(2),
      headGapSec: +headGap.toFixed(2),
      tailGapSec: +tailGap.toFixed(2),
      maxGapLimitSec: maxGapSec,
      noiseFloor: +noiseFloor.toFixed(4),
      satisfied,
      ...(satisfied
        ? {}
        : {
            reason:
              '帧预算不足：' + frameBudget + ' 个槽位铺不满 ' + maxGapSec +
              ' 秒的最大间隔（实际最大 ' + maxFrameGap.toFixed(1) + ' 秒）',
          }),
      ...(uncoveredLens.length
        ? { lensNote: '预算耗尽，' + uncoveredLens.length + ' 个镜头没有代表帧（优先保时间骨架）' }
        : {}),
    },
  }
}

function buildDisplaySet(baseFrames, cues) {
  const all = [...baseFrames]
  for (const c of cues) for (const f of c.extraFrames) all.push(f)
  // 同一源帧去重（按 sourceFrameId，保留先到者；extractionId 保留原始任务号）
  const bySrc = new Map()
  for (const f of all) if (!bySrc.has(f.sourceFrameId)) bySrc.set(f.sourceFrameId, f)
  return [...bySrc.values()].sort((a, b) => a.t - b.t)
}

// ---------------------------------------------------------------- 分组（内容组 + 边界组）
// 设计依据（GPT 2026-10-18 评估）：
//   - 帧差触发只是「候选边界」，不能直接当内容边界
//   - 稳定段要经过「组内一致性检查」才能建内容组
//   - 硬切直接分左右组；渐变/不确定单独标记
//   - 短段不自动并组；内容组同组可多页，单页不混组

const HIST_TH = 0.2 // 直方图差异内容边界阈值
const CONSISTENCY_TH = 0.06 // 组内首尾帧 RMSE 阈值（超出则拆组）
const DP_L = Number(args['dp-l'] || 10)
const SERIAL = !!args.serial // 强制串行（对照用；默认 worker 并行）
const SUBS = !!args.subs // 字幕提取（PP-OCR，慢，显式开启） // DP 分段最短段长（帧，5fps 下 20 = 4s）
const MAX_GROUP_FRAMES = Infinity // 内容组展示帧无上限（每组完整表达）

function frameRMSE(a, b) {
  const r = spawnSync('compare', ['-metric', 'RMSE', a.file, b.file, 'null:'], { encoding: 'utf8' })
  const m = String(r.stderr || '').match(/\(([0-9.]+)\)/)
  return m ? Number(m[1]) : r.status === 0 ? 0 : 1
}

// 组内一致性二分拆：首尾差异超阈值就拆，直到一致或到最小粒度
function splitByConsistency(frames, depth = 0) {
  if (frames.length < 2) return [frames]
  if (depth >= 3) return [frames]
  const rmse = frameRMSE(frames[0], frames[frames.length - 1])
  if (rmse <= CONSISTENCY_TH) return [frames]
  const mid = Math.floor(frames.length / 2)
  return [...splitByConsistency(frames.slice(0, mid), depth + 1), ...splitByConsistency(frames.slice(mid), depth + 1)]
}

// 内容组展示帧抽样：内容相同，超出上限就均匀抽样（保留首尾）
function sampleFrames(frames, max) {
  if (frames.length <= max) return frames
  const out = []
  for (let i = 0; i < max; i++) out.push(frames[Math.round((i * (frames.length - 1)) / (max - 1))])
  return [...new Set(out)]
}


// 候选干净起点：连续 minRun 个 histDiff < exitTh 才算稳定；搜索限制在 [from, to] 内
function candidateContentStart(from, to, histDiffs, minRun = 2, exitTh = 0.1, budget = 1.0) {
  const end = Math.min(to, from + budget)
  const inRange = histDiffs.filter((h) => h.t > from && h.t <= end)
  let run = 0
  for (const h of inRange) {
    if (h.d < exitTh) {
      run++
      if (run >= minRun) return { start: h.t, status: 'stable' }
    } else run = 0
  }
  return { start: null, status: 'unresolved' }
}

// 候选干净终点：从组尾往前找连续低差异
function candidateContentEnd(from, to, histDiffs, minRun = 2, exitTh = 0.15, budget = 1.0) {
  const begin = Math.max(from, to - budget)
  const inRange = histDiffs.filter((h) => h.t >= begin && h.t < to)
  let run = 0
  for (let i = inRange.length - 1; i >= 0; i--) {
    if (inRange[i].d < exitTh) {
      run++
      if (run >= minRun) return { end: inRange[i].t, status: 'stable' }
    } else run = 0
  }
  return { end: null, status: 'unresolved' }
}

function buildGroups(displaySet, segs, histDiffs, hists, duration, cutTimes) {
  // 内容边界 = TransNetV2 镜头边界（预训练模型）
  const cuts = cutTimes

  // 每段 -> 内容组（组内帧抽样 <= MAX_GROUP_FRAMES）
  const groups = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i], to = cuts[i + 1]
    // 组头/组尾都做「候选干净点」检测（短序列稳定 + 限制组内；失败显式标记，不回退到边界帧）
    const cs = candidateContentStart(from, to, histDiffs)
    const ce = candidateContentEnd(from, to, histDiffs)
    const startT = cs.status === 'stable' ? cs.start : from
    const endT = ce.status === 'stable' ? ce.end : to
    // 帧按【镜头原始边界】分配给组，保证全片不重不漏；
    // startT/endT 是「内容起止」的干净点，只作标注——用它筛帧会把边界附近的帧丢掉
    // （实测 157 帧采样只剩 121 帧进页，36 帧就是这么没的）。
    let frames = displaySet.filter((f) => f.t >= from - EPS && f.t < to - EPS)
    let groupStatus = cs.status === 'stable' && ce.status === 'stable' ? 'clean' : 'uncertain'
    if (!frames.length) {
      // 允许单帧短组：取组内最接近中点的帧，不回退到边界帧
      const mid = (from + to) / 2
      const inside = displaySet
        .filter((f) => f.t >= from && f.t < to)
        .sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid))
      if (inside.length) frames = [inside[0]]
      groupStatus = 'uncertain'
    }
    if (!frames.length) continue
    const shown = sampleFrames(frames, MAX_GROUP_FRAMES)
    groups.push({
      id: `g${String(groups.length + 1).padStart(2, "0")}`,
      type: "content",
      from: Number(from.toFixed(2)),
      to: Number(to.toFixed(2)),
      frames: shown,
      originalFrames: frames.length,
      status: groupStatus,
    })
  }

  // 内容边界记录（供回查，不单独成页）
  const boundaries = []
  for (let i = 1; i < cuts.length - 1; i++) {
    const t = cuts[i]
    const left = groups.filter((g) => g.to <= t + EPS).pop()
    const right = groups.find((g) => g.from >= t - EPS)
    if (!left || !right) continue
    const hd = histDiffs.reduce((best, h) => (Math.abs(h.t - t) < Math.abs(best.t - t) ? h : best), histDiffs[0])
    boundaries.push({
      id: `b${String(boundaries.length + 1).padStart(2, "0")}`,
      t: Number(t.toFixed(2)),
      leftGroupId: left.id,
      rightGroupId: right.id,
      lastLeftFrame: left.frames[left.frames.length - 1].t,
      firstRightFrame: right.frames[0].t,
      histDiff: hd ? hd.d : null,
      type: "content_cut",
    })
  }

  return { groups, boundaries }
}

// ---------------------------------------------------------------- 分页 + 网格图

// 并发执行外部命令：montage 拼图是纯 CPU 子进程，串行跑一页一等，页多时（20+ 页）
// 光拼图就要十几秒。改成并发池后压到 1/4~1/5（AGENTS：真源改动需 pnpm run sync）。
// 拼图是子进程 IO 密集，可以用到小核；按在线核数算，留一个给主线程
const CPU_TOPOLOGY = detectCpuTopology()
const MONTAGE_CONCURRENCY = ioConcurrency(CPU_TOPOLOGY, 8)
function runAsync(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000) })
    child.on('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.trim().slice(-300)}`)))
  })
}
async function runPool(jobs, limit = MONTAGE_CONCURRENCY) {
  let next = 0
  const fan = Math.min(limit, jobs.length)
  const workers = Array.from({ length: fan }, async () => {
    while (next < jobs.length) {
      const i = next++
      await jobs[i]()
    }
  })
  await Promise.all(workers)
}


// TransNet 跑在 worker 线程：主线程同时跑 ASR/OCR，把镜头检测的墙钟时间藏到它们后面。
// 消息协议见 lib/transnet-worker.mjs。失败时退回主线程同步跑，保证不因 worker 问题丢结果。
function detectCutsInWorker(video, opts) {
  return new Promise((resolve, reject) => {
    let settled = false
    let worker
    try {
      worker = new Worker(new URL('./lib/transnet-worker.mjs', import.meta.url), {
        workerData: { video, fps: opts.fps, thr: opts.thr },
      })
    } catch (e) {
      reject(e)
      return
    }
    const done = (fn, v) => {
      if (settled) return
      settled = true
      worker.terminate().catch(() => {})
      fn(v)
    }
    worker.once('message', (m) => {
      if (m && m.ok) done(resolve, m)
      else done(reject, new Error(m?.error || 'worker 未返回结果'))
    })
    worker.once('error', (e) => done(reject, e))
    worker.once('exit', (code) => {
      if (!settled && code !== 0) done(reject, new Error(`worker 退出码 ${code}`))
    })
  })
}

/**
 * 把相邻内容组合并到目标页数。
 *
 * 为什么需要：页数 = max(组数, 帧数/6)。镜头切得碎的片子组数多，
 * 每个组只有 2-3 帧也会各自占一页——135 秒切 42 个镜头就出 43 页，
 * 而且大部分是「半页」。这时候限制帧预算没用，瓶颈是组数。
 *
 * 合并后一页的 6 格可能来自不同镜头，但每帧都带时间戳，
 * 网格本来就表示「这段时间里的若干采样点」，不是「同一镜头内的连续动作」。
 */
function mergeGroupsToTarget(groups, target) {
  if (!groups.length) return groups
  // 页数 = 组数 × 每组页数。要精确控制页数，就得让「每组 ≤ PAGE_FRAMES 帧」——
  // 否则某个合并组帧数超 6 还是会拆成 2 页，页数就会比目标多。
  const all = groups.flatMap((g) => (g.frames || []).map((f) => ({ f, g })))
  if (!all.length) return groups
  const maxPages = Math.max(3, target)
  const per = Math.max(PAGE_FRAMES, Math.ceil(all.length / maxPages))
  const out = []
  for (let i = 0; i < all.length; i += per) {
    const chunk = all.slice(i, i + per)
    if (!chunk.length) continue
    const frames = chunk.map((x) => x.f)
    const srcGroups = [...new Set(chunk.map((x) => x.g.id))]
    out.push({
      id: `g${String(out.length + 1).padStart(2, '0')}`,
      type: 'content',
      from: frames[0].t,
      to: frames[frames.length - 1].t,
      frames,
      originalFrames: chunk.reduce((n, x) => n + (x.g.originalFrames || (x.g.frames || []).length), 0),
      status: chunk.every((x) => x.g.status === 'clean') ? 'clean' : 'uncertain',
      mergedFrom: srcGroups,
    })
  }
  return out
}

async function buildPages(groups, vertical) {
  // 页是全局按时序切的，不是「每组各自切」。
  // 原因：组数由镜头切分决定（135 秒能切 40 多组），如果按组切页，
  // 页数就会被组数封顶——每组 2-3 帧也各占一页，一半是半页。
  // 采样层已经用预算约束了帧数，页数应该只由 ceil(帧数 / 6) 决定。
  const flat = []
  for (const g of groups) for (const f of g.frames || []) flat.push({ f, gid: g.id })
  flat.sort((a, b) => a.f.t - b.f.t)
  const byId = new Map(groups.map((g) => [g.id, g]))
  for (const g of groups) g.pages = []

  const pages = []
  const jobs = []
  for (let off = 0; off < flat.length; off += PAGE_FRAMES) {
    const chunk = flat.slice(off, off + PAGE_FRAMES)
    if (!chunk.length) continue
    // 页归属于「第一帧所在的内容组」，只用于命名与溯源
    const owner = byId.get(chunk[0].gid) || groups[0]
    const frames = chunk.map((x) => x.f)
    const pid = `${owner.id}-p${String(owner.pages.length + 1).padStart(2, '0')}`
    const file = join(OUT, 'grids', `${pid}.jpg`)
    mkdirSync(join(OUT, 'grids'), { recursive: true })
    const fw = Math.round(426 * PAGE_SCALE)
    const fh = Math.round(240 * PAGE_SCALE)
    const geometry = vertical ? `${Math.round(240 * PAGE_SCALE)}x${Math.round(426 * PAGE_SCALE)}+6+6` : `${fw}x${fh}+6+6`
    const argv = ['-quality', '90', '-background', '#0f172a', '-geometry', geometry, '-tile', '3x2']
    for (const f of frames) argv.push(f.file)
    argv.push(file)
    jobs.push(() => runAsync('montage', argv))
    const cells = frames.map((f, i) => ({
      cell: [i % 3, Math.floor(i / 3)],
      t: f.t,
      requestTime: f.requestTime,
      srcFrameId: f.sourceFrameId,
      extractionId: f.extractionId,
      source: f.source,
      shared: !!f.shared,
    }))
    const page = { page: pid, file, frames: cells, groupId: owner.id }
    owner.pages.push(page)
    pages.push(page)
  }
  await runPool(jobs)
  return pages
}

// ---------------------------------------------------------------- 自动断言

function runChecks(displaySet, groups, pages) {
  const problems = []
  // 内容组允许抽样（内容相同，展示帧是子集），所以不要求 displaySet 全进页
  // 页是全局按时序切的，内容组可能没有自己的页（帧被并到相邻窗口里），不算错
  for (const p of pages) if (p.frames.length > PAGE_FRAMES) problems.push(`页超帧: ${p.page} ${p.frames.length}`)
  const cellSet = new Set()
  for (const p of pages) for (const c of p.frames) {
    const key = `${p.page}:${c.cell.join(',')}`
    if (cellSet.has(key)) problems.push(`格位冲突: ${key}`)
    cellSet.add(key)
  }
  // 页内帧必须属于同一组（单页不混组）
  for (const g of groups) for (const p of g.pages || []) {
    const ids = new Set(p.frames.map((f) => f.extractionId))
    if (ids.size > PAGE_FRAMES) problems.push(`页内源帧异常: ${p.page}`)
  }
  return problems
}

// ---------------------------------------------------------------- 覆盖说明

function buildCoverage(duration, cues) {
  const pick = (s) => cues.filter((c) => c.extraction === s).map((c) => ({ id: c.id, window: c.window, reason: c.reason, frames: c.extraFrames.length }))
  return {
    base: { from: 0, to: duration, fps: BASE_FPS, note: '基础呈现覆盖；未展开候选不代表未发生' },
    expanded: pick('expanded'),
    partial: pick('partial'),
    deferred: pick('deferred'),
    failed: pick('failed'),
    pending: cues.filter((c) => c.extraction === 'pending').length,
    note: '已展开 ≠ 已确认；模型阅读后才有 assessment',
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const tAll = Date.now()
  let tPrev = tAll
  const timings = {}
  const lap = (name) => { const now = Date.now(); timings[name] = Number(((now - tPrev) / 1000).toFixed(2)); console.log(`[timing] ${name}: ${((now - tPrev) / 1000).toFixed(1)}s（累计 ${((now - tAll) / 1000).toFixed(1)}s）`); tPrev = now }
  if (existsSync(OUT)) {
    const st = lstatSync(OUT)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('输出路径必须是普通目录，不能是文件或符号链接')
    if (FORCE) {
      rmSync(OUT, { recursive: true, force: true })
    } else if (readdirSync(OUT).length > 0) {
      throw new Error(`输出目录非空：${OUT}。请使用新的目录，或显式传入 --force 覆盖。`)
    }
  }
  mkdirSync(join(OUT, 'grids'), { recursive: true })

  const { duration, fps, width, height } = probe()
  if (!BASE_FPS) {
    // 自适应基础帧率：让「抽出来的帧数」≈ 帧预算，而不是让页数随时长膨胀
    // 下限 1fps（再低抽不到东西），上限 5fps（短视频保持细节）
    // 样本池要大于预算，否则「采样」退化成「全用」，加权无从发挥。
    // 预算帧 = 动态页数 × 6；池子取预算的 1.5 倍。
    const budgetNow = process.env.DSH_FRAME_BUDGET
      ? FRAME_BUDGET
      : Math.max(8, Math.min(36, Math.ceil(duration / 6))) * PAGE_FRAMES
    const poolTarget = budgetNow * 1.5
    BASE_FPS = Math.min(5, Math.max(1, Math.round((poolTarget / Math.max(1, duration)) * 100) / 100))
    console.log(`[1/6] 时长 ${duration.toFixed(2)}s，源帧率 ${fps}fps → 自动基础帧率 ${BASE_FPS}fps（目标池子 ${Math.round(BASE_FPS * duration)} 帧）`)
  } else {
    console.log(`[1/6] 时长 ${duration.toFixed(2)}s，源帧率 ${fps}fps → 指定基础帧率 ${BASE_FPS}fps`)
  }

  const baseFrames = extractBaseFrames(fps)
  lap('抽基础帧')
  console.log(`[2/6] 基础帧 ${baseFrames.length} 张（${BASE_FPS}fps，源帧 ID f-xxxxxx）`)

  const { changes, segs, histDiffs, hists } = await detectChanges(fps)
  lap('帧差检测')
  // 负载必须在「做决定的这一刻」测：模块加载时 CPU 还空着，一定测出 cool。
  const detectedLoad = detectLoad(CPU_TOPOLOGY)
  console.log(SERIAL || detectedLoad.level === 'hot' ? '[3b] TransNetV2 镜头边界检测（串行模式）...' : '[3b] TransNetV2 镜头边界检测（worker 线程，与 ASR/OCR 并行）...')
  const autoSerial = !SERIAL && detectedLoad.level === 'hot'
  const effectiveSerial = SERIAL || autoSerial
  if (autoSerial) console.log(`     [load] ${detectedLoad.note} → 判为过热，本次走串行`)
  const transnetJob = effectiveSerial
    ? detectCuts(VIDEO, { fps: 5, thr: 0.5 }).then((r) => ({ ...r, serial: true }))
    : detectCutsInWorker(VIDEO, { fps: 5, thr: 0.5 })
    // worker 起不来（极少见）就退回主线程同步检测，绝不让并行影响正确性
    .catch((e) => {
      console.log(`     [warn] worker 失败，退回主线程：${String(e?.message || e).slice(0, 160)}`)
      return detectCuts(VIDEO, { fps: 5, thr: 0.5 }).then((r) => ({ ...r, fallback: true }))
    })

  // 串行模式下必须先把 TransNet 跑完再开 OCR —— 否则两个 onnxruntime-web session
  // 会同时在主线程里跑，WASM 后端报 "Session already started"。
  // 走 worker 时不用等（worker 有独立的 WASM 实例）。
  if (effectiveSerial) {
    try { await transnetJob } catch { /* 错误留给后面统一处理 */ }
  }

  // 主线程同时跑 ASR（与 worker 并行）
  let cues = []
  if (ASR) {
    console.log('[4/6] 跑 ASR 转写（sherpa-onnx 本地识别）...')
    cues = transcribeVideo(VIDEO, { outDir: join(OUT, 'audio') }).map((c) => ({
      ...c,
      extraction: 'pending', read: 'not_read', assessment: 'unassessed', reason: null,
      window: [Math.max(0, c.s - WINDOW), c.e + WINDOW],
      matchedChanges: [], extraFrames: [], note: null,
    }))
    for (const c of cues) console.log(`  ${c.id} ${c.s.toFixed(2)}~${c.e.toFixed(2)}s  ${c.text}`)
  } else {
    cues = loadCues()
  }
  console.log(`[4/6] 候选 ${cues.length} 条（${ASR ? 'ASR 转写' : CUES_FILE ? '来自 ' + CUES_FILE : '仅视觉模式'}）`)
  lap('ASR/候选')

  // 字幕提取（可选）：软字幕优先，没有才走 OCR
  let subs = []
  // 三态：disabled（没开）/ failed（跑了但失败）/ completed（跑完）
  // 空数组 + completed 才等于「确实没有文字」
  let subsStatus = SUBS ? 'failed' : 'disabled'
  let softSubs = false
  if (SUBS) {
    const tracks = probeSubtitleTracks(VIDEO)
    if (tracks.length) {
      const soft = extractSoftSubtitles(VIDEO, join(OUT, 'subs', 'soft.srt'))
      if (soft && soft.length) {
        softSubs = true
        subs = soft.map((c) => ({ start: c.start, end: c.end, t: c.end, text: c.text, conf: 1 }))
        subsStatus = 'completed'
        console.log(`[subs] 发现 ${tracks.length} 条文字字幕轨（${tracks.map((x) => x.codec_name).join(',')}），直接提取 ${subs.length} 条，跳过 OCR`)
        lap('字幕提取（软字幕）')
      }
    }
  }
  // ADR-0016：OCR 与「补帧 + 分组分页」互不依赖（OCR 读的是视频本身，不读 cuts/pages），
  // 所以这里不 await，先发出去让它和后面两段重叠；到构造 index 之前再收。
  // 实测重叠无收益（2026-11-10 对照实验：重叠 118s vs 串行 117.5s，OCR 反而慢 9s），
  // 默认走串行；DSH_SUBS_OVERLAP=1 可开启重叠，代码保留作对照入口。
  const OVERLAP = process.env.DSH_SUBS_OVERLAP === '1'
  let subsJob = null
  let tSubStart = 0
  if (SUBS && !softSubs) {
    console.log(
      !OVERLAP
        ? '[subs] 跑字幕提取（PP-OCR 硬字幕链路，串行：等它跑完再分组）...'
        : '[subs] 跑字幕提取（PP-OCR 硬字幕链路，与 TransNet/分组分页重叠）...',
    )
    tSubStart = Date.now()
    resetStageTiming()
    subsJob = (async () => {
      const r = await extractSubtitles(VIDEO, join(OUT, 'subs'), { fps: 2 })
      subsStatus = 'completed'
      return r
    })()
  } else {
    lap('字幕提取')
  }

  /** 收 OCR 结果并按真实区间记时（并行段不能按 lap 顺序累加） */
  const harvestSubs = async () => {
    if (!subsJob) return
    subs = await subsJob
    subsJob = null
    const tSubEnd = Date.now()
    // 分阶段 wall + 进程级 CPU（覆盖 worker 线程）。
    // 注意：重叠模式下这些 stage 的 wall 里混着分组分页的时间，par 会虚高，只作参考。
    for (const m of dumpStageTiming()) {
      console.log(`  [stage] ${m.stage}: wall ${m.wallMs}ms | cpu ${m.cpuMs}ms | par ${m.par}`)
    }
    console.log(
      `[subs] 完成 ${((tSubEnd - tSubStart) / 1000).toFixed(1)}s，字幕 ${subs.length} 条（status=completed${OVERLAP ? '，与分组分页重叠' : ''}）`,
    )
    timings['字幕提取'] = Number(((tSubEnd - tSubStart) / 1000).toFixed(2))
    tPrev = tSubEnd
    console.log(`[timing] 字幕提取: ${((tSubEnd - tSubStart) / 1000).toFixed(1)}s`)
    for (const sm of subs.slice(0, 10)) console.log(`  ${sm.start.toFixed(1)}~${sm.end.toFixed(1)}s conf=${sm.conf.toFixed(2)} | ${sm.text}`)
  }

  // 串行（默认）：立刻收，后面的分组分页等它跑完再开始
  if (!OVERLAP) await harvestSubs()

  // 取 TransNet 结果（此时 worker 多半已经跑完，这段墙钟接近 0）
  const tWait = Date.now()
  const { cuts: tCuts } = await transnetJob
  const cutTimes = [0, ...tCuts.map((c) => c.t).filter((t) => t > 0.5), duration]
  console.log(`[3b] TransNet 返回 ${tCuts.length} 个边界${tCuts.length ? '：' + tCuts.map((c) => c.t + 's').join(' / ') : ''}（等待 ${Date.now() - tWait}ms）`)
  lap('TransNet 镜头检测')
  console.log(`[3/6] 变化检测 ${changes.length} 个采样点，${segs.length} 个变化段`)
  for (const s of segs) console.log(`     变化段 ${s.from.toFixed(2)}~${s.to.toFixed(2)}s（峰值 ${s.peak.toFixed(1)}，锚点 ${s.anchors.length}）`)

  const extraUsed = await searchCandidates(cues, segs, fps)
  console.log(`[5/6] 补帧/回退 ${extraUsed} 张`)
  for (const c of cues) console.log(`     ${c.id} [${c.extraction}] ${c.s.toFixed(2)}~${c.e.toFixed(2)}s${c.reason ? ' · ' + c.reason : ''}${c.note ? ' · ' + c.note : ''}`)
  lap('补帧')

  const fullDisplaySet = buildDisplaySet(baseFrames, cues)
  // 保底采样：把展示帧裁到预算内（页数不再随时长线性膨胀）
  // 动态预算：没显式指定帧预算时，按「每页覆盖 6 秒」推算，夹在 8-36 页
  const pagesByDuration = Math.max(8, Math.min(36, Math.ceil(duration / 6)))
  const budgetPages = process.env.DSH_FRAME_BUDGET
    ? Math.floor(FRAME_BUDGET / PAGE_FRAMES)
    : pagesByDuration
  if (!process.env.DSH_FRAME_BUDGET) {
    console.log('[5a] 动态预算：' + duration.toFixed(1) + 's / 6s = ' + pagesByDuration +
      ' 页（夹在 8-36），共 ' + (pagesByDuration * PAGE_FRAMES) + ' 帧')
  }
  const coverage = selectCoverageFrames(fullDisplaySet, {
    cutTimes,
    histDiffs,
    cues,
    changes,
    durationSec: duration,
    budgetPages,
    maxGapSec: MAX_GAP_SEC,
  })
  const displaySet = coverage.frames
  console.log(
    '[5b] 采样[' + SAMPLING_MODE + '] ' + (budgetPages * PAGE_FRAMES) + ' 帧 / ' + budgetPages + ' 页：' +
    fullDisplaySet.length + ' → ' + displaySet.length + ' 帧，预计 ' + coverage.report.plannedPages +
    ' 页（骨架 ' + (coverage.report.skeletonFrames ?? '?') + ' 帧 + 镜头补 ' + (coverage.report.lensFilled ?? 0) + ' + 加密 ' + (coverage.report.densityFrames ?? 0) + '），' +
    '实际帧 ' + (coverage.report.actualFrames ?? '?') + ' / 预算 ' + FRAME_BUDGET + '，' +
    '帧间隔 ' + coverage.report.maxFrameGapSec + 's（上限 ' + coverage.report.maxGapLimitSec + 's）' +
    (coverage.report.satisfied ? '' : '  ⚠️ ' + coverage.report.reason),
  )
  // 帧级去重（ADR-0018）：运动门控 → pHash → 时间保底。
  // 放在分组之前 —— 帧少了，组内帧少、拼页少、VLM 要读的页也少。
  let frameDedupResult = null
  let effectiveFrames = displaySet
  if (process.env.FRAME_DEDUP !== '0') {
    try {
      const fd = dedupFrames(displaySet)
      frameDedupResult = fd
      effectiveFrames = fd.kept
      console.log(`[5c] 帧级去重：${fd.stats.total} → ${fd.stats.kept} 帧（去 ${fd.stats.dropped}，` +
        `${(fd.stats.ratio * 100).toFixed(1)}%；运动门控 ${fd.stats.motionSkipped}，pHash ${fd.stats.hashSkipped}）`)
    } catch (e) {
      // 必须打全栈 —— 之前只打 message，变量遮蔽类错误（ReferenceError: x is not defined）
      // 看着像「功能没生效」，实际是代码 bug
      console.log('[5c] 帧级去重失败，按原样继续：' + String((e && e.message) || e))
      console.log('[5c] 错误堆栈：' + String((e && e.stack) || '(无堆栈)').split('\n').slice(0, 5).join(' | '))
    }
  }
  const tGroupStart = Date.now()
  const { groups, boundaries } = buildGroups(effectiveFrames, segs, histDiffs, hists, duration, cutTimes)
  // 不再合并组：页数由采样预算决定，组数只影响语义归属。
  // 需要合并组的旧路径见 mergeGroupsToTarget（保留但不再调用）。
  const pages = await buildPages(groups, height > width)
  // 组级拼图（导航用）：按可读性分页，每张 ≤12 页（3×4）
  const SHEET_CHUNK = 12
  const sheetJobs = []
  for (const g of groups) {
    if (g.pages.length <= 1) continue
    g.sheets = []
    for (let i = 0; i < g.pages.length; i += SHEET_CHUNK) {
      const chunk = g.pages.slice(i, i + SHEET_CHUNK)
      const n = Math.floor(i / SHEET_CHUNK) + 1
      const sheet = join(OUT, 'grids', `${g.id}-sheet-${n}.jpg`)
      sheetJobs.push(() => runAsync('montage', ['-quality', '85', '-background', '#0f172a', '-geometry', '600x+4+4', '-tile', '3x', ...chunk.map((p) => p.file), sheet]))
      g.sheets.push(sheet)
    }
  }
  await runPool(sheetJobs)
  console.log(`[6/6] 组 ${groups.length} 个，页 ${pages.length} 张`)
  // 并行段用独立区间计时：OCR 和这段重叠，按 lap 的顺序累加会互相污染
  const tGroupEnd = Date.now()
  timings['分组+分页'] = Number(((tGroupEnd - tGroupStart) / 1000).toFixed(2))
  tPrev = tGroupEnd
  console.log(`[timing] 分组+分页: ${((tGroupEnd - tGroupStart) / 1000).toFixed(1)}s${!OVERLAP ? '' : '（与 OCR 重叠）'}`)

  // 收 OCR：重叠模式下到这里分组分页已经跑完；串行模式下早已收过，这里是空操作
  await harvestSubs()

  lap('字幕/其他')
  const problems = runChecks(displaySet, groups, pages)
  if (problems.length) {
    console.log('\n⚠️ 断言失败：')
    for (const p of problems) console.log('  - ' + p)
  } else {
    console.log('\n✅ 断言全部通过（帧全进页 / 组时长兜底 / 格位无冲突 / 页不超帧）')
  }

  // 网格去重（ADR-0012）：全图 pHash 初筛 → 局部复核 → 标记可去重页。
  // 注意：这里只做标记，不物理删除 pages —— 门禁、账本、原始索引都还要用。
  let dedupResult = null
  try {
    setDedupTmp(join(OUT, '.dedup-tmp'))
    // ADR-0015：视觉去重只吃视觉输入，不再挂字幕文本
    const allPages = groups.flatMap((g) => g.pages.map((pg) => ({ ...pg, groupId: g.id })))
    dedupResult = dedupPages(allPages)
    console.log(`\n[dedup] 全图+局部复核：${dedupResult.stats.total} 页 → 保留 ${dedupResult.stats.kept}，标记去重 ${dedupResult.stats.dropped}（${(dedupResult.stats.ratio * 100).toFixed(1)}%）`)
  } catch (e) {
    console.log('[dedup] 跳过（' + String(e && e.message || e) + '）')
  }

  /**
 * 关联层（ADR-0015）：把视觉与文字按时间轴串起来，谁都不改谁。
 *
 * frames      frameId、timestamp、page、group、cell
 * visualGroups groupId、memberFrameIds（含被合并的帧，不因去重丢失）
 * pages       pageId、groupId、memberFrameIds、时间段
 * ocrEvents   文字事件，按时间重叠关联到页；一条文字可关联多页，一页可有多条文字
 */
function buildRelation(groupsList, subsList) {
  const frames = []
  const visualGroups = []
  const pages = []

  for (const g of groupsList || []) {
    const gFrames = []
    for (const pg of g.pages || []) {
      const ts = (pg.frames || []).map((f) => Number(f.t)).filter(Number.isFinite)
      const from = ts.length ? Math.min(...ts) : 0
      const to = ts.length ? Math.max(...ts) : 0
      const memberFrameIds = (pg.frames || []).map((f) => f.srcFrameId).filter(Boolean)
      pages.push({ pageId: pg.page, groupId: g.id, memberFrameIds, from, to })
      for (const f of pg.frames || []) {
        frames.push({ frameId: f.srcFrameId || null, timestamp: Number(f.t), page: pg.page, group: g.id, cell: f.cell || null })
        if (f.srcFrameId) gFrames.push(f.srcFrameId)
      }
    }
    // 代表帧取组内第一页的第一帧；成员帧保留全部（含将被去重合并的）
    visualGroups.push({
      groupId: g.id,
      representativeFrameId: g.pages?.[0]?.frames?.[0]?.srcFrameId ?? null,
      memberFrameIds: gFrames,
    })
  }

  // 文字事件：按时间重叠关联到页
  const ocrEvents = (subsList || []).map((x, i) => {
    const start = Number(x.start), end = Number(x.end)
    const hitPages = pages.filter((pg) => end >= pg.from - 0.5 && start <= pg.to + 0.5)
    return {
      eventId: `ocr-${String(i + 1).padStart(4, '0')}`,
      start, end, text: String(x.text || ''),
      sourceFrameIds: hitPages.flatMap((pg) => pg.memberFrameIds).slice(0, 12),
      pages: hitPages.map((pg) => pg.pageId),
    }
  })

  return { frames, visualGroups, pages, ocrEvents }
}

const index = {
    version: '5.2-proto',
    timings,
    video: VIDEO,
    duration: Number(duration.toFixed(3)),
    sourceFps: fps,
    // 保底采样的裁剪结果（是否满足最大间隔、预算多少、实际页间隔）。
    // 注意不能叫 coverage —— index.json 里已有同名字段（候选覆盖），会互相覆盖。
    samplingBudget: coverage.report,
    config: { baseFps: BASE_FPS, changeFps: CHANGE_FPS, diffThreshold: DIFF_TH, window: WINDOW, maxGroup: MAX_GROUP, pageFrames: PAGE_FRAMES, fallbackSamples: FALLBACK_SAMPLES },
    detections: changes.filter((d) => d.score >= DIFF_TH).map((d) => ({ prevT: Number(d.prevT.toFixed(2)), curT: Number(d.curT.toFixed(2)), score: Number(d.score.toFixed(1)) })),
    changeSegs: segs.map((s) => ({ from: Number(s.from.toFixed(2)), to: Number(s.to.toFixed(2)), peak: Number(s.peak.toFixed(1)), anchors: s.anchors.map((a) => ({ prevT: Number(a.prevT.toFixed(2)), curT: Number(a.curT.toFixed(2)), score: Number(a.score.toFixed(1)) })) })),
    candidates: cues.map((c) => ({
      id: c.id, s: c.s, e: c.e, text: c.text,
      extraction: c.extraction, read: c.read, assessment: c.assessment, reason: c.reason,
      window: c.window, matchedChanges: c.matchedChanges,
      extraFrames: c.extraFrames.map((f) => ({ t: f.t, srcFrameId: f.sourceFrameId, extractionId: f.extractionId })),
      note: c.note,
    })),
    groups: groups.map((g) => ({
      id: g.id, type: g.type || 'content', boundaryType: g.boundaryType || null,
      status: g.status || null,
      from: g.from, to: g.to,
      pages: g.pages.map((p) => ({ page: p.page, file: p.file, frames: p.frames })),
      sheets: g.sheets || [],
    })),
    // ASR 台词单独成段：candidates 里混着补帧状态机字段，调用方只想问
    // 「有没有台词、台词是什么」，不该去 candidates 里按 extraction 状态筛。
    asr: {
      enabled: ASR,
      cues: ASR
        ? cues.map((c) => ({ id: c.id, s: Number(c.s.toFixed(2)), e: Number(c.e.toFixed(2)), text: c.text }))
        : [],
    },
    // 画面文字（气泡/招牌）：不属于字幕时间轴，单独一列（ADR-0013）
    screenText: (subs.screenText || []).map((x) => ({ t: x.t, end: x.end, text: x.text, conf: x.conf, box: x.box })),
    // ADR-0017：画面文字按「区域」追踪，同一块位置的内容变化记进 textHistory
    screenRegions: (subs.screenRegions || []).map((r) => ({
      regionId: r.regionId, bbox: r.bbox, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
      textHistory: r.textHistory, state: r.state,
    })),
    subsStatus,  // disabled | failed | completed（ADR-0015）
    // 关联层（ADR-0015）：视觉与文字各走各的，这里是按时间轴的只读关联结果
    relation: buildRelation(groups, subs),
    subs: subs.map((x) => ({
      start: x.start, end: x.end, t: x.t, text: x.text, conf: x.conf,
      review: (x.conf < 0.85 || /[0-9]/.test(x.text) || x.text.length < 3) ? [x.conf < 0.85 ? 'low_conf' : null, /[0-9]/.test(x.text) ? 'digits' : null, x.text.length < 3 ? 'short' : null].filter(Boolean) : null,
    })),
    boundaries: boundaries.map((b) => ({
      id: b.id, t: b.t, type: b.type, histDiff: b.histDiff,
      leftGroupId: b.leftGroupId, rightGroupId: b.rightGroupId,
      lastLeftFrame: b.lastLeftFrame, firstRightFrame: b.firstRightFrame,
    })),
    // 实际并发度与温度判定（供面板「最近运行」展示；subs 为数组，属性由 extractSubtitles 挂上）
    detWorkers: Number.isFinite(Number(subs.detWorkers)) ? Number(subs.detWorkers) : null,
    loadLevel: subs.loadLevel ?? null,
    tempC: Number.isFinite(Number(subs.tempC)) ? Number(subs.tempC) : null,
    frameDedup: frameDedupResult ? frameDedupResult.stats : null,
    dedup: dedupResult ? {
      globalSim: 6, roiChange: 10,
      kept: dedupResult.kept.map((x) => ({ page: x.page, file: x.file, reason: x.dedupReason, visualGroup: x.visualGroup ?? null })),
      dropped: dedupResult.dropped.map((x) => ({ page: x.page, file: x.file, reason: x.dedupReason, representativePage: x.representativePage ?? null })),
      stats: dedupResult.stats,
    } : null,
    coverage: buildCoverage(duration, cues),
    checks: { ok: problems.length === 0, problems },
  }
  timings.total = Number(((Date.now() - tAll) / 1000).toFixed(2))
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
  const totalFrames = pages.reduce((s, p) => s + p.frames.length, 0)
  console.log(`\n帧总数 ${totalFrames}（页内），去重后 ${displaySet.length}；输出 ${join(OUT, 'index.json')}`)
  process.exit(0) // tesseract worker 常驻会阻止进程退出，显式收尾
}

main()

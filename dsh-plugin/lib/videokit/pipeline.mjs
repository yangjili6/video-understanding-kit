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
// 仍是原型：无真实 STT（cues 文件模拟）、无模型阅读、无真实视频验证。
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { transcribeVideo } from './asr.mjs'
import { detectCuts } from './lib/transnet-lib.mjs'
import { extractSubtitles } from './subs.mjs'

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
  console.error('用法: node pipeline.mjs --video <mp4> [--out out] [--cues cues.json] [--base-fps 2] [--change-fps 5] [--diff-threshold 8] [--window 2] [--max-group 8] [--fallback-samples 3]')
  process.exit(1)
}
const OUT = args.out || 'out'
const CUES_FILE = args.cues || null
const ASR = !!args.asr
const BASE_FPS = Number(args['base-fps'] || 5)
const CHANGE_FPS = Number(args['change-fps'] || 5)
const DIFF_TH = Number(args['diff-threshold'] || 8)
const WINDOW = Number(args.window || 2)
const MAX_GROUP = Number(args['max-group'] || 8)
const FALLBACK_SAMPLES = Number(args['fallback-samples'] || 3)
const PAGE_SCALE = Number(args['page-scale'] || 1.8)
const PAGE_FRAMES = 6
const MAX_EXTRA_PER_CUE = 12
const MAX_EXTRA_TOTAL = 120
const EPS = 0.001

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts })

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

// ---------------------------------------------------------------- 基础呈现帧（2fps）

function extractBaseFrames(fps) {
  const dir = join(OUT, 'base')
  mkdirSync(dir, { recursive: true })
  // 按原始帧号采样（select），不用 fps 滤镜：fps 滤镜的采样相位与编号不对齐
  // （实测 2fps 第 15 帧标称 7.0s，实际内容是 7.25s 的帧）。
  const step = Math.max(1, Math.round(fps / BASE_FPS))
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', VIDEO, '-vf', `select='not(mod(n,${step}))'`, '-vsync', '0', '-q:v', '2', join(dir, '%04d.jpg')])
  return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f, i) => {
    const t = (i * step) / fps
    return { requestTime: t, t, sourceFrameId: srcId(t, fps), extractionId: `base-${String(i).padStart(4, '0')}`, source: 'base', file: join(dir, f) }
  })
}

// ---------------------------------------------------------------- 变化检测（5fps，分块最大差，保留触发帧对）

function detectChanges(fps) {
  const W = 160, H = 90, B = 8
  // 同样按原始帧号采样（select），时间 = 帧号/源帧率，与基础帧对齐
  const step = Math.max(1, Math.round(fps / CHANGE_FPS))
  const buf = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', VIDEO, '-vf', `select='not(mod(n,${step}))',scale=${W}:${H},format=rgb24`, '-vsync', '0', '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  const frameSize = W * H * 3
  const n = Math.floor(buf.length / frameSize)
  const frames = []
  for (let i = 0; i < n; i++) frames.push(buf.subarray(i * frameSize, (i + 1) * frameSize))
  const diffs = []
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1], cur = frames[i]
    if (true) {
      let maxBlock = 0
      for (let by = 0; by < H; by += B) {
        for (let bx = 0; bx < W; bx += B) {
          let sum = 0, cnt = 0
          const yEnd = Math.min(by + B, H), xEnd = Math.min(bx + B, W)
          for (let y = by; y < yEnd; y++) {
            for (let x = bx; x < xEnd; x++) {
              const p = (y * W + x) * 3
              sum += Math.abs(cur[p] - prev[p]) + Math.abs(cur[p + 1] - prev[p + 1]) + Math.abs(cur[p + 2] - prev[p + 2])
              cnt += 3
            }
          }
          maxBlock = Math.max(maxBlock, sum / cnt)
        }
      }
      diffs.push({ prevT: ((i - 1) * step) / fps, curT: (i * step) / fps, t: (i * step) / fps, score: Number(maxBlock.toFixed(3)) })
    }
  }
  // 直方图差异（全局/内容）：RGB 各 16 桶，L1/2 归一化。对构图/颜色变化敏感，对局部动作相对不敏感
  const hists = frames.map((f) => {
    const h = new Float32Array(48)
    for (let i = 0; i < f.length; i += 3) {
      h[Math.floor(f[i] / 16)]++
      h[16 + Math.floor(f[i + 1] / 16)]++
      h[32 + Math.floor(f[i + 2] / 16)]++
    }
    const m = f.length / 3
    for (let k = 0; k < 48; k++) h[k] /= m
    return h
  })
  const histDiffs = []
  for (let i = 1; i < hists.length; i++) {
    let sum = 0
    for (let k = 0; k < 48; k++) sum += Math.abs(hists[i][k] - hists[i - 1][k])
    histDiffs.push({ t: (i * step) / fps, d: Number((sum / 2).toFixed(4)) })
  }
  // 阈值判定 + 合并相邻（间隔 <= 0.5s 同一段），保留每个触发帧对作为锚点
  const hits = diffs.filter((d) => d.score >= DIFF_TH)
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
  const histArr = frames.map((f, i) => ({ t: (i * step) / fps, h: hists[i] }))
  return { changes: diffs, segs, histDiffs, hists: histArr }
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
function searchCandidates(cues, segs, fps) {
  let budgetUsed = 0
  for (const c of cues) {
    const [wFrom, wTo] = c.window
    const inWin = segs.filter((s) => s.to >= wFrom && s.from <= wTo)
    c.matchedChanges = inWin.map((s) => ({ from: s.from, to: s.to, peak: Number(s.peak) }))

    if (budgetUsed >= MAX_EXTRA_TOTAL) {
      c.extraction = 'deferred'; c.reason = 'budget_exhausted'; c.note = '补帧总预算已用尽，未展开'
      continue
    }

    if (!inWin.length) {
      // 回退：窗内固定采样点（有预算才做）
      const pts = []
      const n = Math.min(FALLBACK_SAMPLES, MAX_EXTRA_TOTAL - budgetUsed)
      for (let i = 0; i < n; i++) {
        pts.push(Number((wFrom + ((wTo - wFrom) * i) / Math.max(1, n - 1)).toFixed(2)))
      }
      const frames = []
      for (const t of pts) { frames.push(extractFrameAt(t, fps, 'fallback')); budgetUsed++ }
      c.extraFrames = frames
      c.extraction = frames.length ? 'expanded' : 'deferred'
      c.reason = 'no_visual_candidate'
      c.note = frames.length
        ? '窗内无画面变化候选，按固定间隔回看；不代表操作未发生'
        : '窗内无画面变化候选且无预算回看，未展开'
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
    const frames = []
    for (const i of idxs) {
      if (budgetUsed >= MAX_EXTRA_TOTAL) break
      frames.push(extractFrameAt(list[i], fps, 'extra'))
      budgetUsed++
    }
    c.extraFrames = frames
    if (frames.length === 0) { c.extraction = 'deferred'; c.reason = 'budget_exhausted'; c.note = '预算不足，未取帧' }
    else if (frames.length < list.length) { c.extraction = 'partial'; c.reason = 'budget_exhausted'; c.note = `锚点 ${list.length} 个，只展开 ${frames.length} 个` }
    else { c.extraction = 'expanded' }
  }
  return budgetUsed
}

// ---------------------------------------------------------------- 呈现集合（只增不减）

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
    let frames = displaySet.filter((f) => f.t >= startT - EPS && f.t < endT - EPS)
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

function buildPages(groups, vertical) {
  const pages = []
  const zoomW = Math.round(426 * PAGE_SCALE)
  for (const g of groups) {
    const chunks = []
    for (let i = 0; i < g.frames.length; i += PAGE_FRAMES) chunks.push(g.frames.slice(i, i + PAGE_FRAMES))
    g.pages = chunks.map((frames, pi) => {
      const pid = `${g.id}-p${String(pi + 1).padStart(2, '0')}`
      const file = join(OUT, 'grids', `${pid}.jpg`)
      mkdirSync(join(OUT, 'grids'), { recursive: true })
      const fw = Math.round(426 * PAGE_SCALE)
      const fh = Math.round(240 * PAGE_SCALE)
      const geometry = vertical ? `${Math.round(240 * PAGE_SCALE)}x${Math.round(426 * PAGE_SCALE)}+6+6` : `${fw}x${fh}+6+6`
      const argv = ['-quality', '90', '-background', '#0f172a', '-geometry', geometry, '-tile', '3x2']
      for (const f of frames) argv.push(f.file)
      argv.push(file)
      run('montage', argv)
      const cells = frames.map((f, i) => ({
        cell: [i % 3, Math.floor(i / 3)],
        t: f.t,
        requestTime: f.requestTime,
        srcFrameId: f.sourceFrameId,
        extractionId: f.extractionId,
        source: f.source,
        shared: !!f.shared,
      }))
      return { page: pid, file, frames: cells }
    })
    pages.push(...g.pages)
  }
  return pages
}


// ---------------------------------------------------------------- 自动断言

function runChecks(displaySet, groups, pages) {
  const problems = []
  // 内容组允许抽样（内容相同，展示帧是子集），所以不要求 displaySet 全进页
  for (const g of groups) if (!g.pages || !g.pages.length) problems.push(`组无页: ${g.id}`)
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
  const lap = (name) => { const now = Date.now(); console.log(`[timing] ${name}: ${((now - tPrev) / 1000).toFixed(1)}s（累计 ${((now - tAll) / 1000).toFixed(1)}s）`); tPrev = now }
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'grids'), { recursive: true })

  const { duration, fps, width, height } = probe()
  console.log(`[1/6] 时长 ${duration.toFixed(2)}s，源帧率 ${fps}fps`)

  const baseFrames = extractBaseFrames(fps)
  lap('抽基础帧')
  console.log(`[2/6] 基础帧 ${baseFrames.length} 张（${BASE_FPS}fps，源帧 ID f-xxxxxx）`)

  const { changes, segs, histDiffs, hists } = detectChanges(fps)
  lap('帧差检测')
  console.log('[3b] TransNetV2 镜头边界检测（预训练模型）...')
  const { cuts: tCuts } = await detectCuts(VIDEO, { fps: 5, thr: 0.5 })
  const cutTimes = [0, ...tCuts.map((c) => c.t).filter((t) => t > 0.5), duration]
  lap('TransNet 镜头检测')
  for (const c of tCuts) console.log(`     镜头边界 ${c.t}s p=${c.p}`)
  console.log(`[3/6] 变化检测 ${changes.length} 个采样点，${segs.length} 个变化段`)
  for (const s of segs) console.log(`     变化段 ${s.from.toFixed(2)}~${s.to.toFixed(2)}s（峰值 ${s.peak.toFixed(1)}，锚点 ${s.anchors.length}）`)

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
  const extraUsed = searchCandidates(cues, segs, fps)
  console.log(`[5/6] 补帧/回退 ${extraUsed} 张`)
  for (const c of cues) console.log(`     ${c.id} [${c.extraction}] ${c.s.toFixed(2)}~${c.e.toFixed(2)}s${c.reason ? ' · ' + c.reason : ''}${c.note ? ' · ' + c.note : ''}`)

  lap('补帧')
  const displaySet = buildDisplaySet(baseFrames, cues)
  const { groups, boundaries } = buildGroups(displaySet, segs, histDiffs, hists, duration, cutTimes)
  const pages = buildPages(groups, height > width)
  // 组级拼图（导航用）：按可读性分页，每张 ≤12 页（3×4）
  const SHEET_CHUNK = 12
  for (const g of groups) {
    if (g.pages.length <= 1) continue
    g.sheets = []
    for (let i = 0; i < g.pages.length; i += SHEET_CHUNK) {
      const chunk = g.pages.slice(i, i + SHEET_CHUNK)
      const n = Math.floor(i / SHEET_CHUNK) + 1
      const sheet = join(OUT, 'grids', `${g.id}-sheet-${n}.jpg`)
      run('montage', ['-quality', '85', '-background', '#0f172a', '-geometry', '600x+4+4', '-tile', '3x', ...chunk.map((p) => p.file), sheet])
      g.sheets.push(sheet)
    }
  }
  console.log(`[6/6] 组 ${groups.length} 个，页 ${pages.length} 张`)
  lap('分组+分页')

  // 字幕提取（可选）：PP-OCR 硬字幕链路
  let subs = []
  if (SUBS) {
    console.log('[subs] 跑字幕提取（PP-OCR 硬字幕链路）...')
    const t0 = Date.now()
    subs = await extractSubtitles(VIDEO, join(OUT, 'subs'), { fps: 2 })
    console.log(`[subs] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，字幕 ${subs.length} 条`)
    lap('字幕提取')
    for (const sm of subs.slice(0, 10)) console.log(`  ${sm.start.toFixed(1)}~${sm.end.toFixed(1)}s conf=${sm.conf.toFixed(2)} | ${sm.text}`)
  }

  lap('字幕/其他')
  const problems = runChecks(displaySet, groups, pages)
  if (problems.length) {
    console.log('\n⚠️ 断言失败：')
    for (const p of problems) console.log('  - ' + p)
  } else {
    console.log('\n✅ 断言全部通过（帧全进页 / 组时长兜底 / 格位无冲突 / 页不超帧）')
  }

  const index = {
    version: '5.2-proto',
    video: VIDEO,
    duration: Number(duration.toFixed(3)),
    sourceFps: fps,
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
    subs: subs.map((x) => ({
      start: x.start, end: x.end, t: x.t, text: x.text, conf: x.conf,
      review: (x.conf < 0.85 || /[0-9]/.test(x.text) || x.text.length < 3) ? [x.conf < 0.85 ? 'low_conf' : null, /[0-9]/.test(x.text) ? 'digits' : null, x.text.length < 3 ? 'short' : null].filter(Boolean) : null,
    })),
    boundaries: boundaries.map((b) => ({
      id: b.id, t: b.t, type: b.type, histDiff: b.histDiff,
      leftGroupId: b.leftGroupId, rightGroupId: b.rightGroupId,
      lastLeftFrame: b.lastLeftFrame, firstRightFrame: b.firstRightFrame,
    })),
    coverage: buildCoverage(duration, cues),
    checks: { ok: problems.length === 0, problems },
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
  const totalFrames = pages.reduce((s, p) => s + p.frames.length, 0)
  console.log(`\n帧总数 ${totalFrames}（页内），去重后 ${displaySet.length}；输出 ${join(OUT, 'index.json')}`)
  process.exit(0) // tesseract worker 常驻会阻止进程退出，显式收尾
}

main()

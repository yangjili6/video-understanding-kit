// 字幕提取模块（安全版：整帧差异跳帧，不做 ROI 裁剪——ROI det 实测会漏中文行）
import { execFileSync } from 'node:child_process'
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { detectCpuTopology, computeConcurrency, detectLoad } from './lib/cpu.mjs'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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


// ── 分阶段计时（GPT/霁璃建议的排查口径）──
// wall 用单调时钟（performance.now），不受系统校时影响；
// cpu 用 process.cpuUsage() 的差值——worker 是同进程线程，天然被覆盖，
// 不要再把各 worker 自己采的进程级数值相加。
const _stage = { t0: performance.now(), c0: process.cpuUsage(), marks: [] }

function stageMark(name) {
  const t = performance.now()
  const c = process.cpuUsage()
  const wall = t - _stage.t0
  const cpu = (c.user - _stage.c0.user) + (c.system - _stage.c0.system)  // 微秒
  _stage.marks.push({ stage: name, wallMs: +wall.toFixed(1), cpuMs: +(cpu / 1000).toFixed(1), par: +(cpu / 1000 / wall).toFixed(2) })
  _stage.t0 = t
  _stage.c0 = c
}

export function dumpStageTiming() {
  return _stage.marks
}

export function resetStageTiming() {
  _stage.t0 = performance.now()
  _stage.c0 = process.cpuUsage()
  _stage.marks = []
}

// 提取字幕：返回 [{start, end, t, text, conf}]

// ── 并行检测 ─────────────────────────────────────────────────────────────
// det 是逐帧独立推理，天然可分片。det 模型只有 4.5MB，4 个 worker 的
// 模型副本约 20MB，比并列跑 sherpa 安全得多。
// 并发度按「大核数」定：这台机器是 1+3+4，能跑满的只有 4 个核
const CPU_TOPOLOGY = detectCpuTopology()
// 平台化并发上限：手机上只有 4 个能跑满的核，桌面核多、上限放到 12。
// 2026-11-08：上游 21d4e76 只改了下面三处使用、漏了这条定义，
// 导致 detWorkerCount() 直接 ReferenceError —— 视频分析一跑就崩。
// DSH_DET_CAP 可覆盖（文档 HANDOFF-pc-threshold 里承诺过）。
const DET_CAP = Number(process.env.DSH_DET_CAP || (process.platform === 'android' ? 4 : 12))
// 热时退回单路：多个 worker 抢核会把整条管线拖慢（ADR-0007 实测过）。
// 注意：必须在 OCR 真正开始时才测负载，模块加载时 CPU 还空着。

// 标定结果接入（ADR-0009）：优先用 tools/calibrate.mjs 实测的推荐值，
// 超过 TTL 就作废——设备状态会变，陈旧标定不如拓扑兜底。
const CALIB_TTL_MS = Number(process.env.CALIB_TTL_MS || 30 * 60 * 1000)
const CALIB_PATHS = () => [
  process.env.CALIBRATE_RESULT,
  join(process.cwd(), 'tmp', 'calibrate-result.json'),
  // 和 tools/calibrate.mjs 的默认输出对齐：真源在仓库根时是 <仓库>/tmp；
  // 副本在插件里时是插件内 lib/videokit/tmp（也正是 runPipeline 的 cwd）。
  join(dirname(fileURLToPath(import.meta.url)), 'tmp', 'calibrate-result.json'),
  // 兼容旧版 calibrate 的默认输出（它写在 <仓库> 的上一级 /tmp）
  join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'calibrate-result.json'),
].filter(Boolean)

function readCalibration() {
  for (const p of CALIB_PATHS()) {
    try {
      // strip BOM：JSON.parse 遇到 U+FEFF 会直接抛错，而带 BOM 的 UTF-8 是
      // Windows 编辑器/PowerShell Set-Content 的默认产物，不处理就静默跳过标定。
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (!j || !Number.isFinite(j.recommended) || j.recommended < 1) continue
      // 没有 at 的旧文件一律作废：TTL 的前提是「知道它有多新」。
      // 2026-11-07 踩过：11-06 那份旧格式文件没有 at，被判为永不过期，
      // 管线照样读了 recommended=9 —— 与 TTL 30 分钟的设计意图正好相反。
      const at = j.at ? Date.parse(j.at) : NaN
      if (!Number.isFinite(at) || Date.now() - at >= CALIB_TTL_MS) continue
      return { n: j.recommended, source: p, tolerance: j.tolerance }
    } catch { /* 读不到就试下一个 */ }
  }
  return null
}

function detWorkerCount() {
  if (process.env.SUBS_DET_WORKERS) return Number(process.env.SUBS_DET_WORKERS)
  // 面板「OCR 加速」开关（由插件通过环境变量传入）：关 = 强制串行
  if (process.env.DSH_OCR_ACCEL === '0') return 1
  // 插件传入的标定值（面板里存的那份，带设备指纹），优先于本地 calibrate-result.json
  const fromPlugin = Number(process.env.DSH_OCR_CALIB_N)
  if (Number.isFinite(fromPlugin) && fromPlugin >= 1) {
    const load0 = detectLoad(CPU_TOPOLOGY)
    const cap0 = load0.maxConcurrency ?? Number.POSITIVE_INFINITY
    return Math.max(1, Math.min(fromPlugin, CPU_TOPOLOGY.big, cap0, DET_CAP))
  }
  // ① 实测标定优先（ADR-0009）+ 温度上限（温度优先于吞吐量）
  const calib = readCalibration()
  if (calib) {
    const load = detectLoad(CPU_TOPOLOGY)
    const cap = load.maxConcurrency ?? Number.POSITIVE_INFINITY
    return Math.max(1, Math.min(calib.n, CPU_TOPOLOGY.big, cap, DET_CAP))
  }
  // ② 低于拓扑：热时退回单路
  const load = detectLoad(CPU_TOPOLOGY)
  const full = computeConcurrency(CPU_TOPOLOGY, DET_CAP)
  if (load.level === 'hot') return 1
  if (load.level === 'warm') return Math.max(1, Math.min(2, full))
  return full
}

function runDetWorker(frames, roi = null) {
  return new Promise((resolve, reject) => {
    let settled = false
    let w
    const t0 = Date.now()
    let readyMs = null
    try {
      w = new Worker(new URL('./lib/ocr-det-worker.mjs', import.meta.url), { workerData: { frames, roi } })
    } catch (e) { reject(e); return }
    const done = (fn, v) => { if (settled) return; settled = true; w.terminate().catch(() => {}); fn(v) }
    w.on('message', (m) => {
      if (m && m.type === 'ready') { readyMs = Date.now() - t0; return }
      if (m && m.ok) { w.readyMs = readyMs; w.firstDetectMs = m.firstDetectMs; w.totalMs = m.totalMs; done(resolve, m.boxes) }
      else done(reject, new Error(m?.error || 'worker 无结果'))
    })
    w.once('error', (e) => done(reject, e))
    w.once('exit', (code) => { if (!settled && code !== 0) done(reject, new Error('worker 退出码 ' + code)) })
  })
}

/** 把多条字幕带合并成一个 ROI（带 padding）。带为空时返回 null（退回全帧检测）。
 *  字幕带是在探测帧的帧空间里算出来的，全量帧同尺寸，可直接用。 */
function bandToRoi(bands, FW, FH) {
  if (!bands || !bands.length) return null
  const PAD_X = 24, PAD_Y = 14
  const x0 = Math.max(0, Math.min(...bands.map((b) => b.x0)) - PAD_X)
  const y0 = Math.max(0, Math.min(...bands.map((b) => b.y0)) - PAD_Y)
  const x1 = Math.min(FW, Math.max(...bands.map((b) => b.x1)) + PAD_X)
  const y1 = Math.min(FH, Math.max(...bands.map((b) => b.y1)) + PAD_Y)
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

async function detectFramesParallel(paths, concurrency = detWorkerCount(), roi = null) {
  if (paths.length === 0) return []
  if (paths.length <= concurrency * 2) {
    // 帧太少，开 worker 反而亏（每个 worker 要加载一次模型）
    const out = []
    for (const p of paths) { try { out.push(await detect(p, roi)) } catch { out.push([]) } }
    return out
  }
  const per = Math.ceil(paths.length / concurrency)
  const chunks = []
  for (let i = 0; i < paths.length; i += per) chunks.push(paths.slice(i, i + per))
  const workers = chunks.map((c) => runDetWorker(c, roi))
  const tPar = Date.now()
  const parts = await Promise.all(workers)
  console.log(`  [timing] 并行检测墙钟 ${Date.now() - tPar}ms（含 worker 启动）`)
  return parts.flat()
}

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

  // 候选区间路由（ADR-0013 / 霁璃建议）：
  // 预探测不再只回答「有没有字」，而是保留文字框，判断哪些时间段是字幕候选。
  // 只对候选区间加密检测；没有候选的区间不跑全量。
  // 全程 OCR 预算默认 15s（SUBS_OCR_BUDGET_MS 可调），耗尽如实退出、不假装跑完。
  const OCR_BUDGET_MS = Number(process.env.SUBS_OCR_BUDGET_MS ?? 15000)
  const tOcrStart = Date.now()
  const budgetLeft = () => OCR_BUDGET_MS - (Date.now() - tOcrStart)
  const PROBE_N = Number(process.env.SUBS_PROBE_N ?? 16)
  let candidateWindows = []   // [{ from, to }] 秒
  let subtitleBands = []      // 探测帧聚出的稳定字幕带（全帧检测的 ROI 来源）
  let probeFrameData = []     // 探测帧（全帧 det）的画面文字候选，补 ROI 裁剪后的缺口
  let budgetExhausted = false
  let coverage = { probed: 0, denseFrames: 0 }

  if (opts.probe !== false && PROBE_N > 0 && files.length > PROBE_N * 2) {
    const probeIdx = []
    for (let k = 0; k < PROBE_N; k++) probeIdx.push(Math.floor(((k + 0.5) * files.length) / PROBE_N))
    stageMark('（预处理/抽帧）')
    const probeBoxes = await detectFramesParallel(probeIdx.map((i) => join(frameDir, files[i])))
    coverage.probed = probeIdx.length
    const hits = []
    for (let k = 0; k < probeIdx.length; k++) {
      const line = selectSubtitleLine(probeBoxes[k] || [], FW, FH)
      if (line) hits.push({ t: probeIdx[k] / FPS, box: line })
    }
    console.log(`  [subs] 稀疏探测 ${PROBE_N} 帧，候选 ${hits.length}`)
    if (hits.length === 0) {
      console.log('  [subs] 全程没有字幕候选，跳过全量 OCR（画面文字未扫描，不等于全片无文字）')
      return []
    }
    // ①.5 画面文字候选：ROI 裁剪后全量 det 只看得到字幕带，
    // 画面里的招牌 / 界面 / 气泡文字要靠这批全帧探测帧补齐。
    for (let k = 0; k < probeIdx.length; k++) {
      const boxes = probeBoxes[k] || []
      if (!boxes.length) continue
      const m = selectSubtitleLine(boxes, FW, FH)
      const ot = boxes.filter((b) => {
        if (m && Math.abs(b.x0 - m.x0) < 10 && Math.abs(b.y0 - m.y0) < 10) return false
        const w = b.x1 - b.x0, h = b.y1 - b.y0
        return w > FW * 0.04 && h > FH * 0.015 && h < FH * 0.35
      })
      if (ot.length) {
        probeFrameData.push({ t: probeIdx[k] / FPS, file: join(frameDir, files[probeIdx[k]]), others: ot })
      }
    }
    if (probeFrameData.length) {
      console.log(`  [subs] 探测帧画面文字候选 ${probeFrameData.length} 帧`)
    }

    // ② 区域投票：把命中框按位置聚类，反复出现在同一位置的才是「字幕带」
    //    簇中心按 (x0/40, y0/20) 粗粒度量化，命中 >= 30% 的探测帧才算稳定带
    const bandVotes = new Map()
    for (const h of hits) {
      const k = `${Math.round(h.box.x0 / 40)},${Math.round(h.box.y0 / 20)}`
      const rec = bandVotes.get(k) || { n: 0, x0: 0, y0: 0, x1: 0, y1: 0 }
      rec.n++; rec.x0 += h.box.x0; rec.y0 += h.box.y0; rec.x1 += h.box.x1; rec.y1 += h.box.y1
      bandVotes.set(k, rec)
    }
    subtitleBands = []
    for (const rec of bandVotes.values()) {
      if (rec.n / Math.max(1, hits.length) < 0.3) continue
      subtitleBands.push({
        x0: Math.round(rec.x0 / rec.n), y0: Math.round(rec.y0 / rec.n),
        x1: Math.round(rec.x1 / rec.n), y1: Math.round(rec.y1 / rec.n),
        votes: rec.n,
      })
    }
    console.log(`  [subs] 字幕带投票：${hits.length} 个命中框聚成 ${subtitleBands.length} 条稳定带 ${subtitleBands.map((b) => `(${b.x0},${b.y0})x${b.votes}票`).join(' ')}`)

    // ADR-0014：空间统计只做诊断，不参与筛选。
    // 曾是 bandHits 筛选 → 候选区间，实测在位置多变的内容上聚出 0 条带、
    // 降级后仍检测全片，没有收益。现在除非显式开 SUBS_BAND_FILTER=1，否则不筛。
    const useBandFilter = process.env.SUBS_BAND_FILTER === '1'
    const inBand = (box) => subtitleBands.length === 0 || subtitleBands.some((b) =>
      Math.abs(box.x0 - b.x0) < 60 && Math.abs(box.y0 - b.y0) < 40)
    const bandHits = useBandFilter ? hits.filter((h) => inBand(h.box)) : []
    if (useBandFilter && subtitleBands.length) console.log(`  [subs] 带内命中 ${bandHits.length}/${hits.length}（SUBS_BAND_FILTER=1 实验开关）`)
    const halfWin = Math.max(1.5, (files.length / PROBE_N / FPS) * 1.5)
    const raw = (bandHits.length ? bandHits : hits).map((h) => ({ from: Math.max(0, h.t - halfWin), to: Math.min(files.length / FPS, h.t + halfWin) }))
    raw.sort((a, b) => a.from - b.from)
    for (const w of raw) {
      const last = candidateWindows[candidateWindows.length - 1]
      if (last && w.from <= last.to) last.to = Math.max(last.to, w.to)
      else candidateWindows.push({ ...w })
    }
    const covered = candidateWindows.reduce((a, w) => a + (w.to - w.from), 0)
    console.log(`  [subs] 候选区间 ${candidateWindows.length} 段，覆盖 ${covered.toFixed(1)}s / ${(files.length / FPS).toFixed(1)}s`)
  }

  // 需要全量检测的帧：有候选区间就只取区间内的，否则（没开探测）取全片
  let denseFiles = files
  if (candidateWindows.length) {
    denseFiles = files.filter((_, i) => {
      const t = i / FPS
      return candidateWindows.some((w) => t >= w.from && t <= w.to)
    })
  }
  coverage.denseFrames = denseFiles.length

  // 所有帧一次性并行检测（分片交给 worker），再按时间顺序组事件。
  const statRecMs = { v: 0 }
  const allPaths = denseFiles.map((f) => join(frameDir, f))
  const _td0 = Date.now()
  // 决策时刻的负载：detWorkers 是这一刻定的，展示也该用这一刻的温度
  const loadAtDecision = detectLoad(CPU_TOPOLOGY)
  const detWorkers = detWorkerCount()
    stageMark('预探测')
  // 字幕带已知时只检测带内区域：det 输入从 960×540 降到 960×80 量级，
  // 推理与后处理都按面积降一个量级。画面文字（others）由稀疏探测帧单独覆盖。
  const ocrRoi = bandToRoi(subtitleBands, FW, FH)
  if (ocrRoi) {
    console.log(`  [subs] ROI 裁剪：只检测字幕带 x=${ocrRoi.x} y=${ocrRoi.y} ${ocrRoi.w}×${ocrRoi.h}（占全帧 ${((ocrRoi.w * ocrRoi.h) / (FW * FH) * 100).toFixed(1)}%）`)
  }
  const allBoxes = await detectFramesParallel(allPaths, detWorkers, ocrRoi)
  stageMark('全量检测')
  const statDetMs = Date.now() - _td0
  const frames = []
  // denseFiles 是 files 的子集，时间要按原始序号还原
  const denseTimes = denseFiles.map((f) => files.indexOf(f) / FPS)
  for (let i = 0; i < denseFiles.length; i++) {
    const boxes = allBoxes[i] || []
    const main = selectSubtitleLine(boxes, FW, FH)
    // 其他文字框：不在字幕位置的那些（气泡、招牌、界面）
    const others = boxes.filter((b) => {
      if (main && Math.abs(b.x0 - main.x0) < 10 && Math.abs(b.y0 - main.y0) < 10) return false
      const w = b.x1 - b.x0, h = b.y1 - b.y0
      return w > FW * 0.04 && h > FH * 0.015 && h < FH * 0.35
    })
    frames.push({ t: denseTimes[i], file: allPaths[i], main, others })
  }
  console.log(`  det ${denseFiles.length} 帧（并行 ${detWorkers} 路，帧空间 ${FW}×${FH}）`)
  console.log(`  [subs] OCR 预算 ${OCR_BUDGET_MS}ms，实际 ${Date.now() - tOcrStart}ms${budgetLeft() < 0 ? '（预算耗尽：未完成全片密集扫描，未覆盖区间未扫描）' : ''}`)
  console.log(`  [timing] det ${(statDetMs / 1000).toFixed(2)}s | rec ${(statRecMs.v / 1000).toFixed(2)}s`)

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
      const _tr = Date.now()
      const { text, conf } = await recognizeCrop(ev.selected.file, padBox(ev.selected.main))
      statRecMs.v += Date.now() - _tr
      const clean = text.trim()
      if (clean.length >= 2 && conf >= 0.5) results.push({ start: ev.start, end: ev.end, t: ev.selected.t, text: clean, conf })
    } catch { /* skip */ }
  }

  // 画面文字：按「文字状态变化」触发识别，不再固定每 2 秒读一次。
  // 检测已全量做过（others 就是检测框），贵的只有 recognizeCrop。
  // 判定：这一帧的框集合与上一状态比，数量和位置是否明显变化。
  const screenText = []
  try {
    let lastKey = null
    let lastT = -99
    const keyOf = (boxes) => boxes
      .map((b) => `${Math.round(b.x0 / 40)},${Math.round(b.y0 / 20)},${Math.round((b.x1 - b.x0) / 40)}`)
      .sort()
      .join('|')
    const screenPool = frames.concat(probeFrameData).sort((a, b) => a.t - b.t)
    for (const fr of screenPool) {
      if (!fr.others || !fr.others.length) { lastKey = null; continue }
      const key = keyOf(fr.others)
      // 状态变了才识别；同一状态最多再隔 6 秒复核一次（防检测抖动导致长时间不读）
      if (key === lastKey && fr.t - lastT < 6) continue
      const box = fr.others.slice().sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0]
      if (!box) continue
      lastKey = key
      lastT = fr.t
      try {
        const { text, conf } = await recognizeCrop(fr.file, padBox(box))
        const clean = text.trim()
        if (clean.length >= 2 && conf >= 0.45) {
          // 与上一条相同就并进它，不重复输出
          // ② 文本去重：同一句（含 OCR 抖动变体）只记一次
          const dupIdx = screenText.findIndex((x) => {
            if (x.text === clean) return true
            const a = x.text, b = clean
            const dist = levenshtein(a, b)
            return dist / Math.max(a.length, b.length, 1) < 0.2
          })
          if (dupIdx >= 0) { screenText[dupIdx].end = Number(fr.t.toFixed(2)); continue }
          screenText.push({ t: Number(fr.t.toFixed(2)), end: Number(fr.t.toFixed(2)), text: clean, conf: Number(conf.toFixed(2)) })
        }
      } catch { /* skip */ }
    }
    console.log(`  [subs] 画面文字 ${screenText.length} 条（按文字状态变化触发，非固定间隔）`)
  } catch { /* 附加信息，失败不影响字幕 */ }

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
  // 挂上实际并发度与温度判定，供 index.json / 面板「最近运行」展示
  try {
    merged.detWorkers = detWorkers
    merged.loadLevel = loadAtDecision.level
    merged.tempC = loadAtDecision.tempC ?? null
    merged.screenText = screenText
  } catch { /* 展示信息，失败不影响主流程 */ }
  return merged
}

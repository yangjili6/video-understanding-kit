// 字幕提取模块（安全版：整帧差异跳帧，不做 ROI 裁剪——ROI det 实测会漏中文行）
import { execFileSync } from 'node:child_process'
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { detectCpuTopology, computeConcurrency, detectLoad } from './lib/cpu.mjs'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
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

// ── 并行检测 ─────────────────────────────────────────────────────────────
// det 是逐帧独立推理，天然可分片。det 模型只有 4.5MB，4 个 worker 的
// 模型副本约 20MB，比并列跑 sherpa 安全得多。
// 并发度按「大核数」定：这台机器是 1+3+4，能跑满的只有 4 个核
const CPU_TOPOLOGY = detectCpuTopology()
// 热时退回单路：多个 worker 抢核会把整条管线拖慢（ADR-0007 实测过）。
// 注意：必须在 OCR 真正开始时才测负载，模块加载时 CPU 还空着。

// 标定结果接入（ADR-0009）：优先用 tools/calibrate.mjs 实测的推荐值，
// 超过 TTL 就作废——设备状态会变，陈旧标定不如拓扑兜底。
const CALIB_TTL_MS = Number(process.env.CALIB_TTL_MS || 30 * 60 * 1000)
const CALIB_PATHS = () => [
  process.env.CALIBRATE_RESULT,
  join(process.cwd(), 'tmp', 'calibrate-result.json'),
  join(workTmpDir(), 'tmp', 'calibrate-result.json'),
].filter(Boolean)

function workTmpDir() {
  // 和 tools/calibrate.mjs 的默认输出保持一致：仓库/工作区根的 tmp/
  return join(new URL('..', import.meta.url).pathname, 'tmp')
}

function readCalibration() {
  for (const p of CALIB_PATHS()) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (!j || !Number.isFinite(j.recommended) || j.recommended < 1) continue
      const at = j.at ? Date.parse(j.at) : NaN
      const fresh = Number.isFinite(at) ? (Date.now() - at < CALIB_TTL_MS) : true
      if (!fresh) continue
      return { n: j.recommended, source: p, tolerance: j.tolerance }
    } catch { /* 读不到就试下一个 */ }
  }
  return null
}

function detWorkerCount() {
  if (process.env.SUBS_DET_WORKERS) return Number(process.env.SUBS_DET_WORKERS)
  // ① 实测标定优先（ADR-0009）
  const calib = readCalibration()
  if (calib) return Math.max(1, Math.min(calib.n, CPU_TOPOLOGY.big))
  // ② 低于拓扑：热时退回单路
  const load = detectLoad(CPU_TOPOLOGY)
  const full = computeConcurrency(CPU_TOPOLOGY, 4)
  if (load.level === 'hot') return 1
  if (load.level === 'warm') return Math.max(1, Math.min(2, full))
  return full
}

function runDetWorker(frames) {
  return new Promise((resolve, reject) => {
    let settled = false
    let w
    const t0 = Date.now()
    let readyMs = null
    try {
      w = new Worker(new URL('./lib/ocr-det-worker.mjs', import.meta.url), { workerData: { frames } })
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

async function detectFramesParallel(paths, concurrency = detWorkerCount()) {
  if (paths.length === 0) return []
  if (paths.length <= concurrency * 2) {
    // 帧太少，开 worker 反而亏（每个 worker 要加载一次模型）
    const out = []
    for (const p of paths) { try { out.push(await detect(p)) } catch { out.push([]) } }
    return out
  }
  const per = Math.ceil(paths.length / concurrency)
  const chunks = []
  for (let i = 0; i < paths.length; i += per) chunks.push(paths.slice(i, i + per))
  const workers = chunks.map((c) => runDetWorker(c))
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

  // 预探测：全片 OCR 前先均匀抽 12 帧试一遍，一帧字幕行都没有就直接收工。
  // 纯人物/风景的画面经常完全没烧录字幕（2026-10-30 实测：210s 的片子
  // 420 帧全量 OCR 约 220s，结果 0 条）。预探测 12 帧约 6s，能省掉整轮。
  // 判定保守：只要有一帧命中就照常全量跑，不做进一步裁剪。
  const PROBE_N = Number(process.env.SUBS_PROBE_N ?? 12)
  if (opts.probe !== false && PROBE_N > 0 && files.length > PROBE_N * 2) {
    const probePaths = []
    for (let k = 0; k < PROBE_N; k++) {
      const idx = Math.floor(((k + 0.5) * files.length) / PROBE_N)
      probePaths.push(join(frameDir, files[idx]))
    }
    const probeBoxes = await detectFramesParallel(probePaths)
    let hit = 0
    for (const boxes of probeBoxes) {
      if (selectSubtitleLine(boxes, FW, FH)) hit++
    }
    console.log(`  [subs] 预探测 ${PROBE_N} 帧，命中 ${hit}`)
    if (hit === 0) {
      console.log('  [subs] 全程没有字幕行，跳过全量 OCR')
      return []
    }
  }

  // 所有帧一次性并行检测（分片交给 worker），再按时间顺序组事件。
  const statRecMs = { v: 0 }
  const allPaths = files.map((f) => join(frameDir, f))
  const _td0 = Date.now()
  const detWorkers = detWorkerCount()
  const allBoxes = await detectFramesParallel(allPaths, detWorkers)
  const statDetMs = Date.now() - _td0
  const frames = []
  for (let i = 0; i < files.length; i++) {
    const main = selectSubtitleLine(allBoxes[i] || [], FW, FH)
    frames.push({ t: i / FPS, file: allPaths[i], main })
  }
  console.log(`  det ${files.length} 帧（并行 ${detWorkers} 路，帧空间 ${FW}×${FH}）`)
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

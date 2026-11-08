// ⚠ 自动生成文件，请勿编辑。
// 真源：tools/calibrate.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// 并行度标定：在「这台机器、此刻的状态」上实测，找出 OCR 检测的最优并发数。
//
// 为什么需要它：同一台手机，同配置两次测出 45.3s 和 63.4s（差 40%），
// 靠「读频率猜档位」并不可靠。与其猜，不如花十几秒实测一次。
//
// 做法：用固定的一小批帧（默认 24 帧）跑 1..N 路，量每次的墙钟，
// 取边际收益最大的档位（再加速不到 8% 就停，避免白白多开 worker）。
//
// 用法：
//   node tools/calibrate.mjs                     # 用内置测试帧（自动从视频抽）
//   node tools/calibrate.mjs <video>             # 指定视频
//   node tools/calibrate.mjs <video> --max 6     # 最多测 6 路
//   node tools/calibrate.mjs --json              # 输出 JSON（给脚本消费）
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { detectCpuTopology, readBatteryTemp } from '../lib/cpu.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 用 fileURLToPath 而不是 URL.pathname：后者在 Windows 上会留下 /D:/ 前缀
// 且把空格/中文 percent-encode 成 %20/%E5%B7%A5，路径不可用。
const VK_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const VK_DIR = process.env.VK_DIR || join('/storage/emulated/0/Documents/dsh-work/dsh-video-kit/lib/videokit')  // 装了 node_modules 的那份
const DEFAULT_VIDEO = '/storage/emulated/0/Documents/dsh-work/test-media/BV1B1xR6nEi4.mp4'
const PROBE_FRAMES = Number(process.env.PROBE_FRAMES || 24)

function parseArgs() {
  const a = process.argv.slice(2)
  const out = { video: DEFAULT_VIDEO, max: 4, json: false, frames: PROBE_FRAMES }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--max') out.max = Number(a[++i])
    else if (a[i] === '--frames') out.frames = Number(a[++i])
    else if (a[i] === '--json') out.json = true
    else if (!a[i].startsWith('--')) out.video = a[i]
  }
  return out
}

function runDetWorker(frames) {
  return new Promise((resolve, reject) => {
    let settled = false
    let w
    try {
      w = new Worker(join(VK_DIR, 'lib/ocr-det-worker.mjs'), { workerData: { frames } })
    } catch (e) { reject(e); return }
    const done = (fn, v) => { if (settled) return; settled = true; w.terminate().catch(() => {}); fn(v) }
    w.on('message', (m) => {
      if (m && m.type === 'ready') return
      if (m && m.ok) done(resolve, m.boxes)
      else done(reject, new Error(m?.error || 'worker 无结果'))
    })
    w.once('error', (e) => done(reject, e))
  })
}

async function detectParallel(paths, concurrency) {
  const per = Math.ceil(paths.length / concurrency)
  const chunks = []
  for (let i = 0; i < paths.length; i += per) chunks.push(paths.slice(i, i + per))
  const t0 = Date.now()
  await Promise.all(chunks.map((c) => runDetWorker(c)))
  return Date.now() - t0
}

async function detectSerial(paths) {
  const { detect } = await import(pathToFileURL(join(VK_DIR, 'lib/ocr-pp.mjs')).href)
  const t0 = Date.now()
  for (const p of paths) {
    try { await detect(p) } catch { /* 单帧失败忽略 */ }
  }
  return Date.now() - t0
}

// 档间冷却：连续测量会把设备从「短时突发」拖进「持续负载限速」，
// 实测同一档 3 次能从 11.15s 漂到 22.98s。固定间隔比读频率可靠
// ——空闲时频率也是低值，区分不了「凉了」和「睡着了」。
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 20000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitCooldown(label) {
  if (COOLDOWN_MS <= 0) return
  process.stdout.write(`[calibrate] 冷却 ${(COOLDOWN_MS / 1000).toFixed(0)}s…`)
  await sleep(COOLDOWN_MS)
  process.stdout.write(' 继续\n')
  void label
}

function readTempC() {
  try { return readBatteryTemp() } catch { return null }
}

async function main() {
  const args = parseArgs()
  const topology = detectCpuTopology()
  const dir = join(tmpdir(), `calib-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  console.log(`[calibrate] 视频: ${args.video}`)
  console.log(`[calibrate] 拓扑: 在线 ${topology.total} 核 / 大核 ${topology.big} 个（来源: ${topology.source}）`)

  // 抽固定数量的测试帧（2fps，和 OCR 主流程一致）
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', args.video,
    '-vf', 'fps=2,scale=960:-1', '-q:v', '2', join(dir, 'f-%04d.jpg'), '-y'], { maxBuffer: 512 * 1024 * 1024 })
  const all = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
  const step = Math.max(1, Math.floor(all.length / args.frames))
  const picked = []
  for (let i = 0; i < all.length && picked.length < args.frames; i += step) picked.push(join(dir, all[i]))
  console.log(`[calibrate] 测试帧: ${picked.length} 张（共 ${all.length}）`)

  // 先跑一次预热，避免第一次的模型加载污染第一档的数据
  console.log('[calibrate] 预热…')
  await detectSerial(picked.slice(0, 1))

  // 每档重复测量取中位数：单次测量在设备状态波动下不可靠（实测差过 40%）
  const REPS = Number(process.env.REPS || 3)
  const results = []
  function med(xs) { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }

  const t0Serial = readTempC()
  const serialSamples = []
  for (let r = 0; r < REPS; r++) {
    if (r > 0) await waitCooldown('serial')
    serialSamples.push(await detectSerial(picked))
  }
  const serialMs = med(serialSamples)
  results.push({ concurrency: 1, ms: serialMs, samples: serialSamples, tempC: readTempC(), tempDelta: (readTempC() ?? 0) - (t0Serial ?? 0) })
  console.log(`[calibrate] 1 路: 中位 ${(serialMs / 1000).toFixed(2)}s（样本 ${serialSamples.map((x) => (x / 1000).toFixed(2)).join('/')}）`)

  const upper = Math.min(args.max, topology.big)
  for (let c = 2; c <= upper; c++) {
    await waitCooldown(c)
    const tBefore = readTempC()
    const samples = []
    for (let r = 0; r < REPS; r++) samples.push(await detectParallel(picked, c))
    const ms = med(samples)
    const tAfter = readTempC()
    results.push({ concurrency: c, ms, samples, tempC: tAfter, tempDelta: (tAfter ?? 0) - (tBefore ?? 0) })
    const speedup = (serialMs / ms).toFixed(2)
    const spread = ((Math.max(...samples) - Math.min(...samples)) / ms * 100).toFixed(0)
    console.log(`[calibrate] ${c} 路: 中位 ${(ms / 1000).toFixed(2)}s（${speedup}x，极差 ${spread}%）`)
  }

  const serial = results[0].ms
  // 按「距最快档不超过 TOLERANCE」选最小 worker 数（GPT/霁璃 2026-11-05 建议）：
  //   T(n) ≤ (1 + TOLERANCE) × min T(k) 的最小 n
  // 注意：这是「允许比最快慢多少」，不是「相邻档边际收益至少多少」——方向相反。
  const TOLERANCE = Number(process.env.TOLERANCE || 0.08)
  const fastestMs = Math.min(...results.map((r) => r.ms))
  // 参考指标：距最快档 ≤8% 的档位（偏「最快」，会放行收益已经很小的档）
  const eligible = results.filter((r) => r.ms <= fastestMs * (1 + TOLERANCE))

  // 选档公式（ADR-0009）：N* = max{ n | Eₙ ≥ 40% ∧ Gₙ ≥ 8% }，
  //   Eₙ = (T₁/Tₙ)/n 是并行效率，Gₙ = (Tₙ₋₁−Tₙ)/Tₙ₋₁ 是相邻档的边际收益。
  // 语义是「在满足条件的档位里取最大的 n」，**不是**连续递进：
  // 某一档不满足只说明该档不该选，不阻断更高档位的判定。
  // （手机端 2/3 通过、4 拒绝，两种解读恰好同解都是 3 路；PC 上 4 路边际 7.9%
  //   属噪声误杀，若按连续递进会停在 3 路，白丢 31% 吞吐。）
  function recommendByEfficiency(times, minEff = 0.40, minGain = 0.10, minAbsSave = 0.3) {
    const base = times[1]
    let best = 1
    const detail = []
    for (const n of Object.keys(times).map(Number).sort((a, b) => a - b)) {
      if (n === 1 || !(n - 1 in times)) continue
      const cur = times[n], prev = times[n - 1]
      const speedup = base / cur
      const eff = speedup / n
      const gain = (prev - cur) / prev
      const absSave = prev - cur  // 绝对节省（秒）；百分比在噪声里翻面时，这条更稳
      const passed = eff >= minEff && gain >= minGain && absSave >= minAbsSave
      detail.push({ concurrency: n, speedup: +speedup.toFixed(3), efficiency: +(eff * 100).toFixed(2), marginalGain: +(gain * 100).toFixed(2), absSave: +absSave.toFixed(2), passed })
      if (passed) best = n   // 覆盖而非 break：取满足条件的最大 n
    }
    return { recommended: best, detail }
  }

  const times = Object.fromEntries(results.map((r) => [r.concurrency, r.ms / 1000]))
  const effRec = recommendByEfficiency(times)
  // 主推荐用效率公式（指挥官定的规则）：效率 ≥40% ∧ 相邻档边际 ≥8%。
  // 只看「谁最快」会把边际收益已经为负的档也选进来（实测过 4 路）。
  const pick = results.find((r) => r.concurrency === effRec.recommended) || results[0]

  const summary = {
    at: new Date().toISOString(),
    video: args.video,
    frames: picked.length,
    topology,
    results: results.map((r) => ({
      concurrency: r.concurrency,
      medianMs: r.ms,
      samples: r.samples,
      speedup: +(serial / r.ms).toFixed(2),
      efficiency: +((serial / r.ms) / r.concurrency).toFixed(2),
      spreadPct: +(((Math.max(...r.samples) - Math.min(...r.samples)) / r.ms) * 100).toFixed(0),
      tempC: r.tempC,
      tempDelta: r.tempDelta,
    })),
    fastestConcurrency: results.reduce((a, b) => (b.ms < a.ms ? b : a)).concurrency,
    recommended: pick.concurrency,
    recommendedByEfficiency: effRec.recommended,
    efficiencyDetail: effRec.detail,
    tolerance: TOLERANCE,
    note: pick.concurrency === 1
      ? '建议 OCR 并发度 = 1（并行收益不足，保持串行）'
      : `建议 OCR 并发度 = ${pick.concurrency}（相对 1 路 ${(serial / pick.ms).toFixed(2)}x，效率 ${(((serial / pick.ms) / pick.concurrency) * 100).toFixed(0)}%）`,
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log('\n══════ 结果 ══════')
    console.log('并发  中位耗时   加速   效率   极差')
    for (const r of summary.results) {
      console.log(`${String(r.concurrency).padStart(3)}  ${String((r.medianMs / 1000).toFixed(2)).padStart(6)}s  ${String(r.speedup).padStart(5)}x  ${String((r.efficiency * 100).toFixed(0)).padStart(4)}%  ${String(r.spreadPct).padStart(4)}%`)
    }
    console.log(`\n${summary.note}`)
  }

  // 默认写到仓库自己的 tmp/：subs.mjs 的 CALIB_PATHS 会找同一个位置，
  // 两边不靠环境变量也能对上。手机端仍可用 CALIB_OUT 覆盖成原路径。
  const OUT = process.env.CALIB_OUT || join(VK_ROOT, 'tmp', 'calibrate-result.json')
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(summary, null, 2))
  console.log(`结果已存 ${OUT}`)

  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => { console.error('calibrate 失败:', e.message); process.exit(1) })

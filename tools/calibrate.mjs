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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { detectCpuTopology } from '../lib/cpu.mjs'
import { pathToFileURL } from 'node:url'

const VK_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
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

  const results = []
  const serialMs = await detectSerial(picked)
  results.push({ concurrency: 1, ms: serialMs })
  console.log(`[calibrate] 1 路: ${(serialMs / 1000).toFixed(2)}s`)

  const upper = Math.min(args.max, topology.big)
  for (let c = 2; c <= upper; c++) {
    const ms = await detectParallel(picked, c)
    results.push({ concurrency: c, ms })
    const speedup = (serialMs / ms).toFixed(2)
    console.log(`[calibrate] ${c} 路: ${(ms / 1000).toFixed(2)}s（${speedup}x）`)
  }

  const serial = results[0].ms
  // 选择：取实测最快的档位；但加速不到 10% 就不折腾（多开 worker 有内存代价）
  const fastest = results.reduce((a, b) => (b.ms < a.ms ? b : a))
  const best = serial / fastest.ms >= 1.10 ? fastest : results[0]

  const summary = {
    video: args.video,
    frames: picked.length,
    topology,
    results: results.map((r) => ({
      concurrency: r.concurrency,
      ms: r.ms,
      speedup: +(serial / r.ms).toFixed(2),
      efficiency: +((serial / r.ms) / r.concurrency).toFixed(2),
    })),
    recommended: best.concurrency,
    note: `建议 OCR 并发度 = ${best.concurrency}（相对 1 路 ${(serial / best.ms).toFixed(2)}x）`,
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log('\n══════ 结果 ══════')
    console.log('并发  耗时     加速   效率')
    for (const r of summary.results) {
      console.log(`${String(r.concurrency).padStart(3)}  ${String((r.ms / 1000).toFixed(2)).padStart(6)}s  ${String(r.speedup).padStart(5)}x  ${String((r.efficiency * 100).toFixed(0)).padStart(4)}%`)
    }
    console.log(`\n${summary.note}`)
  }

  writeFileSync('/storage/emulated/0/Documents/dsh-work/tmp/calibrate-result.json', JSON.stringify(summary, null, 2))
  console.log('结果已存 tmp/calibrate-result.json')

  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => { console.error('calibrate 失败:', e.message); process.exit(1) })

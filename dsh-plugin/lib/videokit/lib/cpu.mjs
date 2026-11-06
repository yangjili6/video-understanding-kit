// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/cpu.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// CPU 拓扑探测：Android 上 os.cpus() 会返回空数组（实测 length=0），
// 只能从 /sys 读。而「核数」不等于「能跑满的核数」——这台机器是 1+3+4：
//   cpu0-3 capacity ≈ 509（能效核）
//   cpu4-6 capacity ≈ 893（性能核）
//   cpu7   capacity = 1024（超大核）
// 并行任务该按「大核数」定并发度，而不是按总核数。
import { cpus } from 'node:os'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const CAPACITY_PATH = (i) => `/sys/devices/system/cpu/cpu${i}/cpu_capacity`
const ONLINE_PATH = '/sys/devices/system/cpu/online'

function parseOnlineRange(raw) {
  let count = 0
  for (const part of raw.trim().split(',')) {
    const seg = part.trim()
    if (!seg) continue
    const m = seg.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : a
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) count += b - a + 1
  }
  return count
}

/**
 * 返回 CPU 拓扑：
 *   total  在线逻辑核数
 *   big    能跑性能的核数（capacity ≥ 最大值的 70%）
 *   caps   每核 capacity（读不到则为空数组）
 *   source 数据来源，便于排障
 */
export function detectCpuTopology() {
  // 桌面平台 os.cpus() 正常，优先用它（拿不到 capacity 就当作全是大核）
  const fromOs = cpus()
  if (fromOs.length > 0) {
    // 桌面平台读不到 capacity，也不区分 P/E 核（比如 i9-14900HX 是 8P+16E，
    // os.cpus() 只给出 32 个逻辑核）。按超线程折半估物理核，避免把逻辑核
    // 当并行上限——真正的并发度应该来自 tools/calibrate.mjs 的实测。
    const physicalHint = Math.max(1, Math.ceil(fromOs.length / 2))
    return { total: fromOs.length, big: physicalHint, caps: [], source: 'os.cpus', note: 'PC 端不区分 P/E 核，big 取逻辑核的一半' }
  }

  const caps = []
  for (let i = 0; i < 32; i++) {
    try {
      const v = parseInt(readFileSync(CAPACITY_PATH(i), 'utf8').trim(), 10)
      if (!Number.isFinite(v)) break
      caps.push(v)
    } catch {
      break
    }
  }

  let total = caps.length
  let source = total > 0 ? 'sysfs/cpu_capacity' : ''
  if (!total) {
    try {
      total = parseOnlineRange(readFileSync(ONLINE_PATH, 'utf8'))
      source = 'sysfs/online'
    } catch { /* 继续兜底 */ }
  }
  if (!total) {
    try {
      const raw = readFileSync('/proc/cpuinfo', 'utf8')
      total = (raw.match(/^processor\s*:/gm) || []).length
      source = 'proc/cpuinfo'
    } catch { /* 继续兜底 */ }
  }
  if (!total) return { total: 4, big: 2, caps: [], source: 'fallback' }

  const maxCap = caps.length ? Math.max(...caps) : 0
  const big = maxCap > 0 ? Math.max(1, caps.filter((c) => c >= maxCap * 0.7).length) : Math.max(1, Math.ceil(total / 2))
  return { total, big, caps, source }
}

/** 给计算型任务（WASM 推理）用的并发度：按大核数，留一个给主线程 */
export function computeConcurrency(topology, maxCap = 4) {
  const t = topology || detectCpuTopology()
  return Math.max(1, Math.min(maxCap, Math.max(1, t.big - 1)))
}

/** 给 IO/子进程型任务（montage、ffmpeg）用的并发度：可以用到小核 */
export function ioConcurrency(topology, maxCap = 8) {
  const t = topology || detectCpuTopology()
  return Math.max(2, Math.min(maxCap, t.total - 1))
}

// ── 负载/降频探测 ─────────────────────────────────────────────────────────
// Android 上 /proc/loadavg 和 /proc/stat 读不到（EACCES），thermal_zone 也没有。
// 唯一可读的实时信号是 cpufreq 的当前频率：实测同一台机器
//   · 刚跑完十几轮分析时：cpu4 48% / cpu7 41%
//   · 冷却 90 秒后：      cpu4 58% / cpu7 50%
// 所以用「大核当前频率 / 最高频率」的比值做粗略分档，宁可保守。

const FREQ_CUR = (i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`
const FREQ_MAX = (i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`

function readFreqRatio(i) {
  try {
    const cur = parseInt(readFileSync(FREQ_CUR(i), 'utf8').trim(), 10)
    const max = parseInt(readFileSync(FREQ_MAX(i), 'utf8').trim(), 10)
    if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null
    return cur / max
  } catch {
    return null
  }
}

/**
 * 粗略判断当前算力状态：
 *   level: 'cool' | 'warm' | 'hot' | 'unknown'
 *   ratio: 大核平均频率比（0~1）
 *   note:  给日志用的一句话
 * 分档保守——宁可判成热，也不要因为并行把整条管线拖慢。
 */
// 电池温度（℃，读不到返回 null）。
// thermal_zone*/temp 在这台机器上被 SELinux 挡住（连 shz 都读不到），
// 但 dumpsys battery 能拿到 —— 它反映的是整体发热，比 CPU 核心温度钝，够用来自保。
export function readBatteryTemp() {
  try {
    const out = execFileSync('shz', ['dumpsys battery'], { encoding: 'utf8', timeout: 4000 })
    const mm = out.match(/temperature:\s*(\d+)/)
    if (mm) return Number(mm[1]) / 10
  } catch { /* 非 Shizuku 模式或读失败 */ }
  return null
}

// 温度档位阈值（℃）。电池温度比 CPU 核心温度钝，所以取值偏保守：
//   ≥ 42℃ 判 hot    → 计算型退回单路
//   ≥ 40℃ 判 warm   → 最多 2 路
// 实测：3 路在 37~38℃ 时 17~19s，到 39℃ 掉到 30s；4 路稳定在 39.7~41.5℃。
// 所以阈值取 40 / 38，比原先 42 / 40 提前一档——温度优先于吞吐量。
const TEMP_HOT = Number(process.env.CPU_TEMP_HOT || 40)
const TEMP_WARM = Number(process.env.CPU_TEMP_WARM || 38)

// 温度分级：温度优先于吞吐量（指挥官定的优先级——体验与安全 > 效率）。
// 返回 n = 该温度下允许的最大并发数（null 表示不限）。
const TEMP_TIERS = [
  { max: 38, n: null, level: 'cool', label: '正常' },
  { max: 40, n: 3, level: 'warm', label: '偏热' },
  { max: 42, n: 2, level: 'hot', label: '过热' },
  { max: Infinity, n: 1, level: 'hot', label: '严重过热' },
]

export function tempTierConcurrency(tempC) {
  for (const t of TEMP_TIERS) {
    if (tempC < t.max) {
      return { n: t.n, level: t.level, note: `电池 ${tempC}℃ → ${t.label}` + (t.n ? `（限 ${t.n} 路）` : '') }
    }
  }
  return { n: 1, level: 'hot', note: `电池 ${tempC}℃ → 严重过热（串行）` }
}

export function detectLoad(topology) {
  const t = topology || detectCpuTopology()

  // ① 温度优先：能读到电池温度就先按它判，比频率更直接。
  // 分级降档（不只看 hot/warm）：温度越高，允许的并发越低。
  const temp = readBatteryTemp()
  if (temp !== null) {
    // 温度可读 → 温度说了算，不再回落到频率判断。
    // 原因是「频率低」既可能是降频也可能是空闲，区分不了；而温度是确定事实。
    const cap = tempTierConcurrency(temp)
    return {
      level: cap.level,
      ratio: null,
      tempC: temp,
      maxConcurrency: cap.n,   // null 表示不限
      bigCores: [],
      note: cap.note,
      source: 'battery-temp',
    }
  }

  // ② 取大核（capacity 最高的那批）；没有 capacity 信息就试最后两个核
  let bigIdx = []
  if (t.caps && t.caps.length) {
    const maxCap = Math.max(...t.caps)
    t.caps.forEach((c, i) => { if (c >= maxCap * 0.7) bigIdx.push(i) })
  }
  if (!bigIdx.length) bigIdx = [Math.max(0, t.total - 2), Math.max(0, t.total - 1)]

  const ratios = bigIdx.map(readFreqRatio).filter((r) => r !== null)
  if (!ratios.length) return { level: 'unknown', ratio: null, bigCores: bigIdx, note: '读不到 cpufreq，不据此调整并发' }

  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length
  let level = 'cool'
  if (avg < 0.45) level = 'hot'
  else if (avg < 0.65) level = 'warm'
  return {
    level,
    ratio: Number(avg.toFixed(3)),
    tempC: temp,
    bigCores: bigIdx,
    note: `大核频率比 ${(avg * 100).toFixed(0)}%（${bigIdx.length} 核）${temp !== null ? `，电池 ${temp}℃` : ''}`,
  }
}

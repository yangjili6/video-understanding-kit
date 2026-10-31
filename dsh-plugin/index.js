// ── dsh-video-kit 视频理解工具包 ──────────────────────────────────────────────
// 把 video-understanding-kit 的能力做成 DSH 工具，让 Agent 在工具列表里直接看见。
// 设计要点：工具返回「结构化文本摘要 + 产物路径」，不直接返回图片；
//          图片由调用方按需用 read_image 打开指定网格页。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import dns from 'node:dns'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-video-kit'
export const version = '0.1.6'
// webServer 只用来给侧栏面板提供配置读写（/dsh-video-kit-api）。
export const inject = ['tools', 'webServer']

const KIT_DIR = join(fileURLToPath(new URL('./lib/videokit/', import.meta.url)))
const PIPELINE = join(KIT_DIR, 'pipeline.mjs')

/** crop 参数转换：接受 IM 风格 WxH+X+Y，转成 ffmpeg 的 W:H:X:Y */
function toFfmpegCrop(spec) {
  const s = String(spec || '').trim()
  if (!s) return null

  const imageMagick = s.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/i)
  if (imageMagick) {
    const [, w, h, x, y] = imageMagick
    const values = [w, h, x, y].map(Number)
    if (values.every(Number.isSafeInteger) && values[0] > 0 && values[1] > 0 &&
        values[0] <= 16384 && values[1] <= 16384 && values[2] <= 32768 && values[3] <= 32768) {
      return `crop=${w}:${h}:${x}:${y}`
    }
    throw new Error('crop 尺寸或偏移超出允许范围')
  }

  const parts = s.split(':')
  if ((parts.length === 2 || parts.length === 4) && parts.every((v) => /^\d+$/.test(v))) {
    const values = parts.map(Number)
    if (values.every(Number.isSafeInteger) && values[0] > 0 && values[1] > 0 &&
        values[0] <= 16384 && values[1] <= 16384 &&
        (values.length === 2 || (values[2] <= 32768 && values[3] <= 32768))) {
      return `crop=${parts.join(':')}`
    }
    throw new Error('crop 尺寸或偏移超出允许范围')
  }

  throw new Error('crop 格式无效；请使用 WxH+X+Y 或 W:H:X:Y')
}

function outputLabel(value, fallback = 'video') {
  const raw = String(value ?? '').trim()
  if (raw && (raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw))) {
    throw new Error('输出目录只接受单级名称，不能传入路径')
  }
  const label = (raw || fallback).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 80)
  return label || 'video'
}

/** 定位 ffmpeg：扩展中心装的在 extensions/ffmpeg/bin，不在引擎 PATH 里 */
function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN
  const candidates = [
    join(process.env.DSH_HOME || homedir(), '..', 'engine', 'extensions', 'ffmpeg', 'bin', 'ffmpeg'),
    '/data/user/0/app.dsh.mobile/files/engine/extensions/ffmpeg/bin/ffmpeg',
    '/system/bin/ffmpeg',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'ffmpeg'
}

/** 工作目录：$DSH_HOME/storages/dsh-video-kit */
function storageRoot() {
  const home = process.env.DSH_HOME || homedir()
  return resolve(process.env.DSH_VIDEO_KIT_DIR || join(home, 'storages', 'dsh-video-kit'))
}

// ── 模型资源：检测 / 下载 / 删除（侧栏面板的「需要下载 / 删除」）──────────────
// 下载源优先用国内镜像 hf-mirror，失败再回退 huggingface。

const HF = 'https://hf-mirror.com'
const HF_BACKUP = 'https://huggingface.co'

const OCR_ASSETS = [
  {
    name: 'transnetv2.onnx',
    size: 31250929,
    urls: [`${HF}/elya5/transnetv2/resolve/main/transnetv2.onnx`, `${HF_BACKUP}/elya5/transnetv2/resolve/main/transnetv2.onnx`],
  },
  {
    name: 'ch_PP-OCRv4_det_infer.onnx',
    size: 4745517,
    urls: [
      `${HF}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx`,
      `${HF_BACKUP}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx`,
    ],
  },
  {
    name: 'ch_PP-OCRv4_rec_infer.onnx',
    size: 10857958,
    urls: [
      `${HF}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx`,
      `${HF_BACKUP}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx`,
    ],
  },
  {
    name: 'ppocr_keys_v1.txt',
    size: 26250,
    urls: [
      `${HF}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ppocr_keys_v1.txt`,
      'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt',
    ],
  },
]

const ASR_ASSETS = [
  {
    name: 'model.int8.onnx',
    size: 227330205,
    urls: [`${HF}/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/model.int8.onnx`],
  },
  {
    name: 'tokens.txt',
    size: 75354,
    urls: [`${HF}/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/tokens.txt`],
  },
]

function modelsDir() {
  return join(KIT_DIR, 'lib', 'models')
}

/** ASR 运行时目录：与 asr.mjs 保持一致 */
function asrAppDir() {
  const base = process.env.DSH_ASR_APP_DIR
    || (process.platform === 'android'
      ? '/data/user/0/app.dsh.mobile/files/dsh-home/asr-app'
      : join(homedir(), '.dsh', 'asr-app'))
  return base.replace(/[\\/]+$/, '')
}

function asrModelDir() {
  return join(asrAppDir(), 'models', 'paraformer')
}

function assetFiles(target) {
  return target === 'asr' ? ASR_ASSETS : OCR_ASSETS
}

function assetDir(target) {
  return target === 'asr' ? asrModelDir() : modelsDir()
}

/** 检测某类资源是否就绪；ASR 还要看 sherpa-onnx 运行时在不在 */
function assetStatus(target) {
  const files = assetFiles(target)
  const dir = assetDir(target)
  const missing = []
  let presentBytes = 0
  for (const f of files) {
    const p = join(dir, f.name)
    let ok = false
    try {
      ok = existsSync(p) && statSync(p).size === f.size
    } catch { ok = false }
    if (ok) presentBytes += f.size
    else missing.push(f.name)
  }
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0)
  const out = {
    ready: missing.length === 0,
    missing,
    dir,
    totalMB: Number((totalBytes / 1048576).toFixed(1)),
    presentMB: Number((presentBytes / 1048576).toFixed(1)),
  }
  if (target === 'asr') {
    const runtime = existsSync(join(asrAppDir(), 'node_modules', 'sherpa-onnx-node'))
      || existsSync(join(asrAppDir(), 'node_modules', 'sherpa-onnx'))
    out.runtime = runtime
    if (!runtime) missing.push('sherpa-onnx 运行时')
    out.ready = out.ready && runtime
  }
  return out
}

const assetJobs = new Map()

/**
 * ASR 运行时：sherpa-onnx-node（约 22MB，按平台装 sherpa-onnx-win-x64 之类的二进制包）。
 * 只下模型不装运行时，ASR 仍然开不起来，所以下载动作里连它一起装。
 */
async function ensureAsrRuntime() {
  const dir = asrAppDir()
  if (existsSync(join(dir, 'node_modules', 'sherpa-onnx-node'))) return
  mkdirSync(dir, { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', 'sherpa-onnx-node'], {
      cwd: dir,
      shell: true, // Windows 上 npm 是 .cmd，必须经 shell 解析
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-3000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`安装 sherpa-onnx-node 失败（退出码 ${code}）：${err.slice(-400)}`))
    })
  })
}

async function runAssetDownload(target) {
  const files = assetFiles(target)
  const dir = assetDir(target)
  const job = {
    status: 'downloading',
    totalMB: Number((files.reduce((s, f) => s + (f.size || 0), 0) / 1048576).toFixed(1)),
    doneMB: 0,
    error: null,
  }
  assetJobs.set(target, job)
  try {
    mkdirSync(dir, { recursive: true })
    // ASR：先装运行时，再下模型（模型 227MB，装不上运行时就别白下了）
    if (target === 'asr') await ensureAsrRuntime()
    for (const f of files) {
      const dest = join(dir, f.name)
      try {
        if (existsSync(dest) && statSync(dest).size === f.size) continue
      } catch { /* 继续下载 */ }
      const tmp = `${dest}.part`
      let lastErr = null
      for (const url of f.urls) {
        try {
          const r = await fetchWithRetry(url, {}, { tries: 2, timeoutMs: 900000 })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          if (!r.body) throw new Error('响应没有内容')
          await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp))
          const size = statSync(tmp).size
          if (f.size && size !== f.size) throw new Error(`大小不符 ${size}/${f.size}`)
          renameSync(tmp, dest)
          job.doneMB = Number((job.doneMB + size / 1048576).toFixed(1))
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          rmSync(tmp, { force: true })
        }
      }
      if (lastErr) throw lastErr
    }
    job.status = 'done'
  } catch (e) {
    job.status = 'error'
    job.error = String(e?.message || e)
  }
  return job
}

function removeAsset(target) {
  const dir = assetDir(target)
  if (target === 'asr') {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  for (const f of assetFiles(target)) rmSync(join(dir, f.name), { force: true })
}

// ── 运行配置（侧栏面板可改，工具调用时作为默认值）────────────────────────────
// 语义：面板上的开关是「默认行为」，工具参数显式传了就以参数为准。
// 这样面板不用管每次调用的特例，Agent 也能针对性覆盖。

const DEFAULT_CONFIG = { ocr: true, asr: false, baseFps: 5, updatedAt: null, updatedBy: null }

function configFile() {
  return join(storageRoot(), 'config.json')
}

function coerceConfig(raw) {
  const out = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.ocr === 'boolean') out.ocr = raw.ocr
  if (typeof raw.asr === 'boolean') out.asr = raw.asr
  const fps = Number(raw.baseFps)
  if (Number.isFinite(fps) && fps >= 1 && fps <= 12) out.baseFps = fps
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt
  if (typeof raw.updatedBy === 'string') out.updatedBy = raw.updatedBy
  return out
}

function loadConfig() {
  try {
    return coerceConfig(JSON.parse(readFileSync(configFile(), 'utf8')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** patch 只接受已知键；未知键忽略而不是报错（面板版本可能比 Host 新）。 */
function saveConfig(patch, by = 'panel') {
  const next = coerceConfig({ ...loadConfig(), ...(patch && typeof patch === 'object' ? patch : {}) })
  next.updatedAt = new Date().toISOString()
  next.updatedBy = by
  mkdirSync(dirname(configFile()), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

// ── 侧栏面板 API 的小工具 ───────────────────────────────────────────────────

const API_ROUTE = '/dsh-video-kit-api'

function sendJson(res, status, payload) {
  if (!res || typeof res.writeHead !== 'function') return
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
      if (raw.length > 64 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!raw.trim()) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 最近几次运行的概况（按目录名里的时间戳 + index.json 摘要）。 */
function recentRuns(limit = 6) {
  const outRoot = join(storageRoot(), 'out')
  if (!existsSync(outRoot)) return []
  const dirs = readdirSync(outRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = join(outRoot, d.name)
      let mtime = 0
      try {
        mtime = statSync(join(full, 'index.json')).mtimeMs
      } catch {
        mtime = statSync(full).mtimeMs
      }
      return { name: d.name, dir: full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)

  return dirs.map((d) => {
    let summary = null
    try {
      const idx = JSON.parse(readFileSync(join(d.dir, 'index.json'), 'utf8'))
      summary = {
        duration: Number(idx.duration ?? 0),
        groups: (idx.groups || []).length,
        subs: (idx.subs || []).length,
        asr: idx.asr?.enabled ? (idx.asr.cues || []).length : null,
      }
    } catch {
      summary = null
    }
    return { name: d.name, at: new Date(d.mtime).toISOString(), dir: d.dir, summary }
  })
}

/** 解析外部视频链接 → 本地可下载直链或本地路径 */
// ── 网络与外部工具适配 ────────────────────────────────────────────────────────

// 部分网络环境里 IPv6 路由不通，Node 的 fetch 会先尝试 IPv6 然后超时
// （实测：curl 正常、fetch 报 UND_ERR_CONNECT_TIMEOUT）。强制 IPv4 优先。
try {
  dns.setDefaultResultOrder('ipv4first')
} catch { /* 老版本 Node 不支持，忽略 */ }

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** fetch + 重试：B 站链路偶发超时，失败后退避重试比直接报错可靠 */
async function fetchWithRetry(url, options = {}, { tries = 3, timeoutMs = 60000 } = {}) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      lastErr = e
      if (i < tries) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  const code = lastErr?.cause?.code ? ` [${lastErr.cause.code}]` : ''
  throw new Error(`网络请求失败（已重试 ${tries} 次）：${lastErr?.message || lastErr}${code}`)
}

// B 站风控：裸请求（没有 buvid3 cookie、UA 过简）会被直接拒绝，返回 412 request was banned。
// 先访问一次首页取得匿名 cookie，再带着它调 view/playurl。取不到也照常尝试，失败时给出可读提示。
let _biliCookie = null
let _biliCookieErr = null
async function bilibiliCookie() {
  if (_biliCookie !== null) return _biliCookie
  try {
    // 实测部分网络到 B 站首页要 30s+，超时按 60s 给
    const r = await fetchWithRetry('https://www.bilibili.com/', { headers: { 'User-Agent': BROWSER_UA } }, { timeoutMs: 60000 })
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    _biliCookie = list.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ')
  } catch (e) {
    _biliCookie = ''
    _biliCookieErr = e.message
  }
  return _biliCookie
}

/** 找 ImageMagick 安装目录（Windows 常见位置；其它平台交给 PATH） */
function resolveMagickHome() {
  if (process.env.IMAGEMAGICK_HOME) return process.env.IMAGEMAGICK_HOME
  if (process.platform !== 'win32') return ''
  const roots = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || ''].filter(Boolean)
  for (const root of roots) {
    try {
      const hit = readdirSync(root).filter((d) => d.startsWith('ImageMagick')).sort().pop()
      if (hit) {
        const dir = join(root, hit)
        if (existsSync(join(dir, 'magick.exe'))) return dir
      }
    } catch { /* 目录不可读，换下一个 */ }
  }
  return ''
}

/**
 * ImageMagick 7 只提供 magick.exe，不再带 convert/montage/identify/compare 独立命令，
 * 而管线是按这些命令名调用的。Windows 上把 magick.exe 复制成这 4 个名字即可
 * （它会按 argv[0] 分派行为），DLL 直接由安装目录提供。
 * 返回要加进 PATH 的目录；非 Windows 或 IM6（原生就带这些命令）返回空串。
 */
function imagemagickBinDir() {
  if (process.platform !== 'win32') return ''
  const home = resolveMagickHome()
  if (!home) return ''
  const magick = join(home, 'magick.exe')
  if (!existsSync(magick)) return ''
  const names = ['convert.exe', 'montage.exe', 'identify.exe', 'compare.exe']
  if (names.every((n) => existsSync(join(home, n)))) return home
  try {
    const bin = join(storageRoot(), 'imagemagick-bin')
    mkdirSync(bin, { recursive: true })
    for (const n of names) {
      const dst = join(bin, n)
      if (!existsSync(dst)) copyFileSync(magick, dst)
    }
    return bin
  } catch {
    return ''
  }
}

/** 异常退出可能残留下载目录；每次调用前清掉过期的，保证下载的视频不会长期留在磁盘 */
async function sweepDownloads(maxAgeMs = 6 * 60 * 60 * 1000) {
  const root = join(storageRoot(), 'downloads')
  try {
    const now = Date.now()
    for (const name of await readdir(root)) {
      const p = join(root, name)
      const st = await stat(p).catch(() => null)
      if (st?.isDirectory() && now - st.mtimeMs > maxAgeMs) await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  } catch { /* 目录不存在 */ }
}

async function resolveVideo(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('video 不能为空')
  if (!/^https?:\/\//i.test(raw)) {
    if (!isAbsolute(raw)) return resolve(process.cwd(), raw)
    return raw
  }

  const inputUrl = new URL(raw)
  if (inputUrl.protocol !== 'https:') throw new Error('视频链接必须使用 HTTPS')
  const host = inputUrl.hostname.toLowerCase()
  const isShortLink = host === 'b23.tv' || host === 'bili2233.cn' || host.endsWith('.bili2233.cn')
  const isBilibiliHost = host === 'bilibili.com' || host.endsWith('.bilibili.com')
  if (!isShortLink && !isBilibiliHost) throw new Error('目前只支持 Bilibili 视频链接，不支持任意 HTTP 直链')

  // B 站 API 统一带 cookie + 完整浏览器 UA，否则会返回 412 request was banned
  const cookie = await bilibiliCookie()
  const biliHeaders = {
    Referer: 'https://www.bilibili.com/',
    'User-Agent': BROWSER_UA,
    ...(cookie ? { Cookie: cookie } : {}),
  }

  // b23.tv / bili2233 短链：取页面 canonical
  let pageUrl = raw
  if (isShortLink) {
    const r = await fetchWithRetry(pageUrl, { headers: biliHeaders })
    if (!r.ok) throw new Error(`短链解析失败 HTTP ${r.status}`)
    const html = await r.text()
    const m = html.match(/canonical"\s+href="([^"]+)"/)
    if (!m) throw new Error('短链页面里没找到 canonical')
    pageUrl = m[1]
  }

  const bv = pageUrl.match(/(BV[0-9A-Za-z]{10})/)
  const av = pageUrl.match(/\/av(\d+)/)
  if (!bv && !av) throw new Error('无法从链接里识别 BV/av 号')

  const idQuery = bv ? `bvid=${bv[1]}` : `aid=${av[1]}`
  const viewRes = await fetchWithRetry(`https://api.bilibili.com/x/web-interface/view?${idQuery}`, {
    headers: biliHeaders,
  })
  const viewText = await viewRes.text()
  let view
  try {
    view = JSON.parse(viewText)
  } catch {
    // 拿到 HTML 而不是 JSON：通常是风控页，或网络层被中间设备拦了
    const ct = viewRes.headers.get('content-type') || '(无)'
    throw new Error(
      `view API 返回非 JSON：HTTP ${viewRes.status}，content-type=${ct}，` +
      `${cookie ? '已带 cookie' : `未取到首页 cookie${_biliCookieErr ? `（${_biliCookieErr}）` : ''}`}，` +
      `长度 ${viewText.length}。响应开头：${viewText.slice(0, 120).replace(/\s+/g, ' ')}`,
    )
  }
  if (view.code !== 0) {
    const hint = view.code === -412 ? '（B 站风控拒绝了请求：稍后重试，或换网络/登录后重试）' : ''
    throw new Error(`view API 失败 ${view.code}: ${view.message}${hint}`)
  }
  const { cid, title, duration, owner } = view.data

  const playRes = await fetchWithRetry(
    `https://api.bilibili.com/x/player/playurl?${idQuery}&cid=${cid}&fnval=1&platform=html5&qn=64`,
    { headers: biliHeaders },
  )
  const play = await playRes.json()
  if (play.code !== 0) throw new Error(`playurl 失败 ${play.code}: ${play.message}`)
  const durl = play.data?.durl?.[0]?.url
  if (!durl) throw new Error('没有拿到 durl 直链')

  return {
    download: { url: durl, referer: 'https://www.bilibili.com/', cookie },
    meta: { title, duration, owner: owner?.name, bvid: bv?.[1] || null },
  }
}

/** 下载到临时目录；调用方必须在 finally 里删除，保证视频不留在磁盘 */
async function downloadVideo(dl, destDir) {
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, 'video.mp4')
  const r = await fetchWithRetry(dl.url, {
    headers: {
      Referer: dl.referer,
      'User-Agent': BROWSER_UA,
      ...(dl.cookie ? { Cookie: dl.cookie } : {}),
    },
  }, { timeoutMs: 600000 })
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  if (!r.body) throw new Error('下载响应没有内容')
  try {
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest, { flags: 'wx' }))
  } catch (e) {
    await rm(dest, { force: true }).catch(() => {})
    throw e
  }
  return { path: dest, bytes: Number(r.headers.get('content-length')) || null }
}

/** 跑 pipeline，返回 stdout 摘要 */
function runPipeline(videoPath, outDir, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = [PIPELINE, '--video', videoPath, '--out', outDir]
    if (opts.subs !== false) args.push('--subs')
    if (opts.asr) args.push('--asr')
    if (opts.baseFps) args.push('--base-fps', String(opts.baseFps))

    const child = spawn(process.execPath, args, {
      cwd: KIT_DIR,
      env: {
        ...process.env,
        PATH: [
          // Windows + ImageMagick 7：imagemagickBinDir() 提供 convert/montage 等命令名，
          // resolveMagickHome() 提供这些 exe 依赖的 DLL。手机端两者都为空，行为不变。
          imagemagickBinDir(),
          resolveMagickHome(),
          join(process.env.DSH_HOME || homedir(), '..', 'engine', 'extensions', 'ffmpeg', 'bin'),
          join(process.env.DSH_HOME || homedir(), '..', 'engine', 'extensions', 'imagemagick', 'bin'),
          process.env.PATH || '',
        ].filter(Boolean).join(delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const keepLogChars = 16000
    const appendTail = (current, chunk) => (current + chunk.toString()).slice(-keepLogChars)
    child.stdout.on('data', (d) => (out = appendTail(out, d)))
    child.stderr.on('data', (d) => (err = appendTail(err, d)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ code, out, err })
      else reject(new Error(`pipeline 退出码 ${code}\n${err.slice(-1500) || out.slice(-1500)}`))
    })
  })
}

export function apply(ctx) {
  const tools = []

  // ── video_analyze ─────────────────────────────────────────────────────────
  tools.push({
    name: 'video_analyze',
    description:
      '看视频（本地路径或 B站视频链接）→ 返回字幕时间线、内容分组、网格页路径。' +
      '**目前不支持任意 HTTP 直链**。看视频应先调这个工具，不要自己运行 ffmpeg 抽帧。' +
      '返回的是文本摘要；需要画面证据时再用 video_frame 传本地路径或同一 B站链接取原帧，或用 read_image 打开网格页。',
    parameters: {
      type: 'object',
      properties: {
        video: { type: 'string', description: '视频来源：本地路径 / B站视频链接（支持 b23.tv 短链）；暂不支持任意 HTTP 直链' },
        out: { type: 'string', description: '结果目录名称（可选；目录始终建在插件存储区内）' },
        subs: { type: 'boolean', description: '是否提取硬字幕（PP-OCR）。不传则用侧栏面板配置（默认开）；画面无字时传 false 提速' },
        asr: { type: 'boolean', description: '是否跑语音识别（本地 sherpa-onnx）。不传则用侧栏面板配置（默认关）。视频有配音但没有硬字幕时，务必传 true，否则会漏掉台词' },
        baseFps: { type: 'number', description: '基础抽帧率；不传则用面板配置（默认 5）' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const t0 = Date.now()
      let videoPath = null
      let meta = null
      let tmpDir = null

      try {
        await sweepDownloads()
        const resolved = await resolveVideo(args.video)

        if (typeof resolved === 'string') {
          videoPath = resolved
          if (!existsSync(videoPath)) return { ok: false, error: `本地文件不存在: ${videoPath}` }
        } else {
          meta = resolved.meta
          tmpDir = join(storageRoot(), 'downloads', `dl-${randomUUID()}`)
          const dl = await downloadVideo(resolved.download, tmpDir)
          videoPath = dl.path
        }

        const fallbackName = meta?.title || basename(videoPath, extname(videoPath))
        const label = outputLabel(args.out, fallbackName)
        const outDir = join(storageRoot(), 'out', `${label}-${randomUUID()}`)
        await mkdir(outDir, { recursive: true })

        // 面板配置作为默认值；工具参数显式传布尔值就覆盖它。
        const cfg = loadConfig()
        const ocrOn = typeof args.subs === 'boolean' ? args.subs : cfg.ocr
        const asrOn = typeof args.asr === 'boolean' ? args.asr : cfg.asr
        const { out } = await runPipeline(videoPath, outDir, {
          subs: ocrOn,
          asr: asrOn,
          baseFps: args.baseFps ?? cfg.baseFps,
        })

        const indexPath = join(outDir, 'index.json')
        if (!existsSync(indexPath)) return { ok: false, error: 'pipeline 没产出 index.json', log: out.slice(-1200) }
        const idx = JSON.parse(await readFile(indexPath, 'utf8'))

        const groups = (idx.groups || []).map((g, i) => ({
          id: g.id || `g${String(i + 1).padStart(2, '0')}`,
          from: Number(g.from ?? g.fromMs ?? 0),
          to: Number(g.to ?? g.toMs ?? 0),
          pages: (g.pages || []).length,
        }))
        const subs = (idx.subs || []).map((s) => ({
          start: Number(s.start),
          end: Number(s.end),
          text: s.text,
          conf: s.conf != null ? Number(Number(s.conf).toFixed(2)) : null,
          review: s.review || null,
        }))

        // ASR 台词：pipeline 单独出了 asr 段；老 index.json 没有就退回 candidates。
        const asrCues = (idx.asr?.cues?.length
          ? idx.asr.cues
          : (idx.candidates || []).filter((c) => c.text)
        ).map((c) => ({ s: Number(c.s), e: Number(c.e), text: String(c.text) }))

        const gridsDir = join(outDir, 'grids')

        return {
          ok: true,
          source: meta ? 'url' : 'local',
          ...(meta ? { title: meta.title, owner: meta.owner, bvid: meta.bvid } : {}),
          duration: Number(idx.duration ?? 0),
          coverage: idx.coverage?.base
            ? { from: idx.coverage.base.from, to: idx.coverage.base.to, fps: idx.coverage.base.fps }
            : null,
          groups: groups.length,
          groupsDetail: groups.slice(0, 40),
          // subsCount 只统计 PP-OCR 硬字幕；asrCount 是语音台词条数。两者互不代表。
          subsCount: subs.length,
          subs,
          asrEnabled: Boolean(idx.asr?.enabled ?? asrOn),
          asrCount: asrCues.length,
          asr: asrCues,
          outDir,
          gridsDir,
          indexJson: indexPath,
          elapsedMs: Date.now() - t0,
          nextStep: subs.length > 0
            ? '硬字幕已给出（含时间戳）。需要画面证据时用 video_frame 传 video=<原始本地路径或同一B站链接> 和 t=<秒> 取原帧；也可 read_image 打开 gridsDir 下的组拼图。'
            : asrCues.length > 0
              ? '没有硬字幕，但有 ASR 台词（见 asr 字段）。需要画面证据时用 video_frame 取原帧，或 read_image 打开网格页核对。'
              : asrOn
                ? '没有字幕，也没有识别出台词（可能纯音乐/环境音）。改用 groupsDetail 定位；用 video_frame 取原帧，或 read_image 打开对应网格页核对。'
                : '没有硬字幕，且本次未开启 ASR——如果视频有配音，重跑时传 asr:true（或在侧栏「视频理解」面板里把语音识别打开）。改用 groupsDetail 定位。',
        }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    },
  })

  // ── video_frame ───────────────────────────────────────────────────────────
  tools.push({
    name: 'video_frame',
    description:
      '按时间点从视频取一张原始帧（用于核对字幕/动作细节）。' +
      '返回文件路径，需用 read_image 打开查看。配合 video_analyze 的 subs 时间戳使用。',
    parameters: {
      type: 'object',
      properties: {
        video: { type: 'string', description: '本地视频路径或 B站链接；传链接时会重新下载视频以提取帧' },
        t: { type: 'number', description: '时间点（秒）' },
        outDir: { type: 'string', description: '输出子目录名称（可选；位置限制在插件存储区）' },
        crop: { type: 'string', description: '可选裁剪区域：WxH+X+Y，例如 720x300+0+880 用于只取字幕带' },
        scale: { type: 'number', description: '可选缩放宽度（像素）' },
      },
      required: ['video', 't'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const video = String(args.video || '')
      const t = Number(args.t)
      if (!video || !Number.isFinite(t) || t < 0) return { ok: false, error: 'video 和 t（非负秒数）必填' }

      let scale = null
      if (args.scale !== undefined) {
        scale = Number(args.scale)
        if (!Number.isInteger(scale) || scale < 16 || scale > 4096) {
          return { ok: false, error: 'scale 必须是 16 到 4096 之间的整数像素宽度' }
        }
      }

      let tmpDir = null
      try {
        const resolved = await resolveVideo(video)
        let sourcePath
        if (typeof resolved === 'string') {
          sourcePath = resolved
          if (!existsSync(sourcePath)) return { ok: false, error: `视频不存在: ${sourcePath}` }
        } else {
          tmpDir = join(storageRoot(), 'downloads', `frame-${randomUUID()}`)
          sourcePath = (await downloadVideo(resolved.download, tmpDir)).path
        }

        const label = outputLabel(args.outDir, 'frames')
        const outDir = args.outDir
          ? join(storageRoot(), 'frames', label)
          : join(storageRoot(), 'frames')
        await mkdir(outDir, { recursive: true })
        const dest = join(outDir, `frame-${t.toFixed(2).replace('.', '_')}-${randomUUID()}.jpg`)

        const vf = []
        const cropExpr = toFfmpegCrop(args.crop)
        if (cropExpr) vf.push(cropExpr)
        if (scale !== null) vf.push(`scale=${scale}:-1`)
        const ffArgs = ['-y', '-v', 'error', '-ss', String(t), '-i', sourcePath, '-frames:v', '1']
        if (vf.length) ffArgs.push('-vf', vf.join(','))
        ffArgs.push(dest)

        const ffmpegBin = resolveFfmpeg()
        let stderr = ''
        const code = await new Promise((res) => {
          const c = spawn(ffmpegBin, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
          c.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
          c.on('error', (e) => { stderr = e.message; res(-1) })
          c.on('close', (x) => res(x))
        })
        if (code !== 0 || !existsSync(dest)) {
          return { ok: false, error: `ffmpeg 取帧失败（exit ${code}）`, stderr: stderr.slice(-800) }
        }

        return { ok: true, t, path: dest, hint: '用 read_image 打开这个路径查看' }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    },
  })

  // ── 侧栏面板 API：/dsh-video-kit-api ────────────────────────────────────
  // 面板只需要「读配置 / 写配置 / 看最近运行」，没有别的业务，所以不依赖 RPC。
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer) {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: API_ROUTE,
        async handler(req, res) {
          try {
            const url = String(req.url || '').split('?')[0]
            const rest = url.startsWith(API_ROUTE + '/') ? url.slice(API_ROUTE.length + 1) : ''
            const method = (req.method || 'GET').toUpperCase()

            if (rest === 'config' && method === 'GET') {
              return sendJson(res, 200, {
                ok: true,
                config: loadConfig(),
                defaults: DEFAULT_CONFIG,
                storageRoot: storageRoot(),
              })
            }

            if (rest === 'config' && method === 'POST') {
              const body = await readJsonBody(req)
              const next = saveConfig(body, String(body?.updatedBy || 'panel'))
              return sendJson(res, 200, { ok: true, config: next })
            }

            if (rest === 'recent' && method === 'GET') {
              return sendJson(res, 200, { ok: true, runs: recentRuns() })
            }

            // 模型资源：面板上显示「需要下载 / 删除」
            if (rest === 'assets' && method === 'GET') {
              return sendJson(res, 200, {
                ok: true,
                assets: {
                  ocr: { ...assetStatus('ocr'), job: assetJobs.get('ocr') || null },
                  asr: { ...assetStatus('asr'), job: assetJobs.get('asr') || null },
                },
              })
            }

            if (rest === 'assets/download' && method === 'POST') {
              const body = await readJsonBody(req)
              const target = body?.target === 'asr' ? 'asr' : 'ocr'
              const cur = assetJobs.get(target)
              if (!cur || cur.status !== 'downloading') {
                // 不 await：下载可能几分钟，让面板轮询 /assets 拿进度
                runAssetDownload(target)
              }
              return sendJson(res, 200, { ok: true, started: true, target })
            }

            if (rest === 'assets/remove' && method === 'POST') {
              const body = await readJsonBody(req)
              const target = body?.target === 'asr' ? 'asr' : 'ocr'
              if (assetJobs.get(target)?.status === 'downloading') {
                return sendJson(res, 409, { ok: false, error: '正在下载，结束之后再删除' })
              }
              removeAsset(target)
              assetJobs.delete(target)
              return sendJson(res, 200, { ok: true, target })
            }

            return sendJson(res, 404, { ok: false, error: 'unknown-route', route: API_ROUTE })
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String(e?.message || e) })
          }
        },
      }),
    )
  }

  // 工具全部 push 完之后再注册（时序：effect 必须最后）
  ctx.effect(() => {
    for (const tool of tools) ctx.tools.register(tool)
  })
}

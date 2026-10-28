// ── dsh-video-kit 视频理解工具包 ──────────────────────────────────────────────
// 把 video-understanding-kit 的能力做成 DSH 工具，让 Agent 在工具列表里直接看见。
// 设计要点：工具返回「结构化文本摘要 + 产物路径」，不直接返回图片；
//          图片由调用方按需用 read_image 打开指定网格页。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-video-kit'
export const version = '0.1.0'
export const inject = ['tools']

const KIT_DIR = join(fileURLToPath(new URL('./lib/videokit/', import.meta.url)))
const PIPELINE = join(KIT_DIR, 'pipeline.mjs')

/** crop 参数转换：接受 IM 风格 WxH+X+Y，转成 ffmpeg 的 W:H:X:Y */
function toFfmpegCrop(spec) {
  const s = String(spec || '').trim()
  if (!s) return null

  const imageMagick = s.match(/^(\\d+)x(\\d+)\\+(\\d+)\\+(\\d+)$/i)
  if (imageMagick) {
    const [, w, h, x, y] = imageMagick
    if (Number(w) > 0 && Number(h) > 0) return `crop=${w}:${h}:${x}:${y}`
    throw new Error('crop 的宽高必须大于 0')
  }

  const parts = s.split(':')
  if ((parts.length === 2 || parts.length === 4) && parts.every((v) => /^\\d+$/.test(v))) {
    if (Number(parts[0]) > 0 && Number(parts[1]) > 0) return `crop=${parts.join(':')}`
    throw new Error('crop 的宽高必须大于 0')
  }

  throw new Error('crop 格式无效；请使用 WxH+X+Y 或 W:H:X:Y')
}

function outputLabel(value, fallback = 'video') {
  const raw = String(value ?? '').trim()
  if (raw && (raw === '.' || raw === '..' || /[\\\\/]/.test(raw) || /^[A-Za-z]:/.test(raw))) {
    throw new Error('输出目录只接受单级名称，不能传入路径')
  }
  const label = (raw || fallback).replace(/[^\\w\\u4e00-\\u9fa5-]/g, '_').slice(0, 80)
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
  return process.env.DSH_VIDEO_KIT_DIR || join(home, 'storages', 'dsh-video-kit')
}

const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** 解析外部视频链接 → 本地可下载直链或本地路径 */
async function resolveVideo(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('video 不能为空')
  if (!/^https?:\/\//i.test(raw)) {
    if (!isAbsolute(raw)) return resolve(process.cwd(), raw)
    return raw
  }

  // b23.tv / bilibili 短链：取页面 canonical
  let pageUrl = raw
  if (/b23\.tv|bili2233/i.test(pageUrl)) {
    const r = await fetch(pageUrl, { signal: AbortSignal.timeout(30000) })
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
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?${idQuery}`, {
    headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30000),
  })
  const view = await viewRes.json()
  if (view.code !== 0) throw new Error(`view API 失败 ${view.code}: ${view.message}`)
  const { cid, title, duration, owner } = view.data

  const playRes = await fetch(
    `https://api.bilibili.com/x/player/playurl?${idQuery}&cid=${cid}&fnval=1&platform=html5&qn=64`,
    { headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) },
  )
  const play = await playRes.json()
  if (play.code !== 0) throw new Error(`playurl 失败 ${play.code}: ${play.message}`)
  const durl = play.data?.durl?.[0]?.url
  if (!durl) throw new Error('没有拿到 durl 直链')

  return {
    download: { url: durl, referer: 'https://www.bilibili.com/' },
    meta: { title, duration, owner: owner?.name, bvid: bv?.[1] || null },
  }
}

/** 下载到本地（带 Referer） */
async function downloadVideo(dl, destDir) {
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, 'video.mp4')
  const r = await fetch(dl.url, {
    headers: { Referer: dl.referer, 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(600000),
  })
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
          join(process.env.DSH_HOME || homedir(), '..', 'engine', 'extensions', 'ffmpeg', 'bin'),
          join(process.env.DSH_HOME || homedir(), '..', 'engine', 'extensions', 'imagemagick', 'bin'),
          process.env.PATH || '',
        ].join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
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
        subs: { type: 'boolean', description: '是否提取字幕（PP-OCR，默认 true；画面无字时传 false 提速）' },
        asr: { type: 'boolean', description: '是否跑语音识别（需要 sherpa-onnx，默认 false）' },
        baseFps: { type: 'number', description: '基础抽帧率，默认 5' },
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

        const { out } = await runPipeline(videoPath, outDir, {
          subs: args.subs !== false,
          asr: args.asr === true,
          baseFps: args.baseFps,
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
          subsCount: subs.length,
          subs,
          outDir,
          gridsDir,
          indexJson: indexPath,
          elapsedMs: Date.now() - t0,
          nextStep:
            subs.length > 0
              ? '字幕已给出（含时间戳）。需要画面证据时用 video_frame 传 t=<秒> 取原帧；或按需 read_image 打开 gridsDir 下的组拼图。'
              : '没有字幕。改用 groupsDetail 定位，再 read_image 打开对应网格页核对画面。',
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
          c.stderr.on('data', (d) => (stderr += d))
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

  // 工具全部 push 完之后再注册（时序：effect 必须最后）
  ctx.effect(() => {
    for (const tool of tools) ctx.tools.register(tool)
  })
}

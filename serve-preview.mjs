// 本地视频结果预览；仅绑定回环地址，并限制静态文件只能来自输出目录。
import http from 'node:http'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(process.argv[2] || 'out')
const port = Number(process.env.VIDEO_PREVIEW_PORT) || 3329

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function imageUrl(file) {
  const target = resolve(String(file || ''))
  if (!isInside(ROOT, target)) return ''
  return '/' + relative(ROOT, target).split(sep).map(encodeURIComponent).join('/')
}

function html() {
  const idx = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'))
  const groups = Array.isArray(idx.groups) ? idx.groups : []
  const subs = Array.isArray(idx.subs) ? idx.subs : []
  const pageCount = groups.reduce((n, g) => n + (Array.isArray(g.pages) ? g.pages.length : 0), 0)
  const secs = groups.map((g) => {
    const pages = (Array.isArray(g.pages) ? g.pages : []).map((p) => {
      const src = imageUrl(p.file)
      if (!src) return ''
      const page = escapeHtml(p.page)
      const frames = Array.isArray(p.frames) ? p.frames.length : 0
      return `<figure><img src="${escapeHtml(src)}" loading="lazy" alt="${page}"><figcaption>${page} · ${frames} 帧</figcaption></figure>`
    }).join('')
    const from = Number(g.from), to = Number(g.to)
    const time = Number.isFinite(from) && Number.isFinite(to) ? `${from.toFixed(1)}~${to.toFixed(1)}s` : '时间未知'
    return `<section><h2>${escapeHtml(g.id)} · ${time}（${Array.isArray(g.pages) ? g.pages.length : 0} 页）</h2><div class="grid">${pages}</div></section>`
  }).join('')
  const subsHtml = subs.length ? `<details open><summary>字幕（${subs.length} 条）</summary><ul>${subs.map((s) => {
    const start = Number(s.start), end = Number(s.end)
    const time = Number.isFinite(start) && Number.isFinite(end) ? `${start.toFixed(1)}~${end.toFixed(1)}s` : ''
    return `<li>${time} ${escapeHtml(s.text)}</li>`
  }).join('')}</ul></details>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>视频结果预览</title>
<style>body{margin:0;background:#f6f8fb;color:#0f172a;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;padding:24px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 10px;border-left:4px solid #2563eb;padding-left:10px}
.summary{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px}
figure img{display:block;width:100%;border-radius:6px}
figcaption{font-size:12px;color:#64748b;margin-top:6px}
ul{margin:6px 0;padding-left:18px;color:#334155;font-size:13px;overflow-wrap:anywhere}
</style></head><body>
<h1>视频结果预览</h1>
<div class="summary">视频：${escapeHtml(idx.video)}<br>${groups.length} 组 / ${pageCount} 页</div>
${subsHtml}
${secs}
</body></html>`
}

function sendNotFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    return res.end()
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname)
  } catch {
    return sendNotFound(res)
  }

  if (pathname === '/') {
    try {
      const body = html()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      })
      return res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Could not load the video output. Check the selected output directory and index.json.')
    }
  }

  const candidate = resolve(ROOT, `.${pathname}`)
  if (!isInside(ROOT, candidate)) return sendNotFound(res)
  try {
    const rootReal = realpathSync(ROOT)
    const fileReal = realpathSync(candidate)
    if (!isInside(rootReal, fileReal) || !statSync(fileReal).isFile()) return sendNotFound(res)
    const ext = extname(fileReal).toLowerCase()
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext]
    if (!type) return sendNotFound(res)
    const body = readFileSync(fileReal)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    return sendNotFound(res)
  }
}).listen(port, '127.0.0.1', () => console.log(`[preview] http://127.0.0.1:${port} · ${ROOT}`))

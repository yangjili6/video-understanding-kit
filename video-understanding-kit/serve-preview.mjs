// 主管线预览（TransNet 镜头分组 + 可选字幕）
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const ROOT = './out-main-sub/'
const port = 3329

function html() {
  const idx = JSON.parse(readFileSync(ROOT + 'index.json', 'utf8'))
  const groups = idx.groups || []
  const subs = idx.subs || []
  const secs = groups.map((g) => {
    const pages = g.pages.map((p) => `<figure><img src="/${p.file}" loading="lazy" alt="${p.page}"><figcaption>${p.page} · ${p.frames.length} 帧</figcaption></figure>`).join('')
    return `<section><h2>${g.id} · ${g.from.toFixed(1)}~${g.to.toFixed(1)}s（${g.pages.length} 页）</h2><div class="grid">${pages}</div></section>`
  }).join('')
  const subsHtml = subs.length ? `<details open><summary>字幕（${subs.length} 条）</summary><ul>${subs.map((s) => `<li>${s.start.toFixed(1)}~${s.end.toFixed(1)}s ${s.text}</li>`).join('')}</ul></details>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>主管线预览</title>
<style>body{margin:0;background:#f6f8fb;color:#0f172a;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;padding:24px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 10px;border-left:4px solid #2563eb;padding-left:10px}
.summary{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:8px}
figure img{display:block;width:100%;border-radius:6px}
figcaption{font-size:12px;color:#64748b;margin-top:6px}
ul{margin:6px 0;padding-left:18px;color:#334155;font-size:13px}
</style></head><body>
<h1>主管线预览（TransNet 镜头分组）</h1>
<div class="summary">视频：${idx.video}<br>${groups.length} 组 / ${groups.reduce((a, g) => a + g.pages.length, 0)} 页 · 5fps · 每组 6 帧/页</div>
${subsHtml}
${secs}
</body></html>`
}

http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html())
  }
  try {
    const buf = readFileSync(url.slice(1))
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' }
    res.writeHead(200, { 'content-type': types[extname(url)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('not found') }
}).listen(port, '127.0.0.1', () => console.log(`[main] http://127.0.0.1:${port}`))

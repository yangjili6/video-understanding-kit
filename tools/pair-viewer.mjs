// 去重核对页：把 dropped 页和它的代表页并排，逐页看是不是真冗余
// 用法：node tools/pair-viewer.mjs <taskId> [port]
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT_ROOT = '/data/user/0/app.dsh.mobile/files/dsh-home/storages/dsh-video-kit/out'
const taskId = process.argv[2]
const PORT = Number(process.argv[3] || 3995)
if (!taskId) { console.error('用法: node tools/pair-viewer.mjs <taskId> [port]'); process.exit(1) }
const dir = join(OUT_ROOT, taskId)
if (!existsSync(join(dir, 'index.json'))) { console.error('找不到任务:', taskId); process.exit(1) }

const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
const dd = idx.dedup || {}
const dropped = dd.dropped || []
const keptByPage = new Map((dd.kept || []).map((x) => [x.page, x]))
const allPages = (idx.groups || []).flatMap((g) => (g.pages || []).map((p) => ({ ...p, gid: g.id })))
const pageByPage = new Map(allPages.map((p) => [p.page, p]))

const subs = idx.subs || []
const subOf = (page) => {
  const p = pageByPage.get(page)
  if (!p) return ''
  const ts = (p.frames || []).map((f) => Number(f.t)).filter(Number.isFinite)
  if (!ts.length) return ''
  const from = Math.min(...ts), to = Math.max(...ts)
  return subs.filter((s) => Number(s.end) >= from - 0.5 && Number(s.start) <= to + 0.5).map((s) => s.text).join(' / ')
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const rows = dropped.map((d, i) => {
  const rep = d.representativePage
  const repInfo = keptByPage.get(rep) || {}
  return `<section class="pair" data-i="${i}">
  <header>
    <span class="idx">#${i + 1}</span>
    <span class="name dropped">${esc(d.page)}</span>
    <span class="arrow">被判定为重复 → 代表页</span>
    <span class="name kept">${esc(rep)}</span>
    <span class="reason">${esc(repInfo.reason || '')}</span>
  </header>
  <div class="imgs">
    <figure><img loading="lazy" src="/img/${encodeURIComponent(d.page)}"><figcaption>${esc(d.page)}（被删）<br><em>${esc(subOf(d.page) || '（无字幕）')}</em></figcaption></figure>
    <figure><img loading="lazy" src="/img/${encodeURIComponent(rep)}"><figcaption>${esc(rep)}（代表页）<br><em>${esc(subOf(rep) || '（无字幕）')}</em></figcaption></figure>
  </div>
</section>`
}).join('\n')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>去重核对 · ${esc(taskId)}</title>
<style>
  :root{--bg:#0f1419;--card:#161d26;--line:#2a3644;--text:#e6edf3;--dim:#8b949e;--red:#f85149;--green:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
  header.top{padding:16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(15,20,25,.96);backdrop-filter:blur(6px);z-index:5}
  h1{margin:0 0 6px;font-size:15px;word-break:break-all}
  .meta{font-size:12.5px;color:var(--dim)}
  main{padding:12px}
  .pair{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
  .pair header{padding:9px 12px;font-size:12.5px;border-bottom:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .idx{color:var(--dim)}
  .name{font-weight:600}
  .name.dropped{color:var(--red)}
  .name.kept{color:var(--green)}
  .arrow{color:var(--dim)}
  .reason{color:var(--dim);font-size:11.5px;margin-left:auto}
  .imgs{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--line)}
  figure{margin:0;background:#0b0f13}
  figure img{width:100%;display:block}
  figcaption{padding:7px 9px;font-size:11.5px;color:var(--text);line-height:1.5}
  figcaption em{color:var(--dim);font-style:normal}
  @media (max-width:520px){.imgs{grid-template-columns:1fr}}
</style></head><body>
<header class="top">
  <h1>去重核对 · ${esc(taskId)}</h1>
  <div class="meta">共 ${dropped.length} 对 · 左边是被判定重复删掉的页，右边是它对比的代表页 · 逐对看是不是真冗余</div>
</header>
<main>${rows}</main>
</body></html>`

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }
  if (url.startsWith('/img/')) {
    const f = join(dir, 'grids', url.slice(5) + '.jpg')
    if (!existsSync(f)) { res.writeHead(404); return res.end('nf') }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=600' })
    return res.end(readFileSync(f))
  }
  res.writeHead(404); res.end('nf')
})
server.listen(PORT, '127.0.0.1', () => console.log(`pair-viewer: http://127.0.0.1:${PORT}`))

// 视频分析结果的本地查看页：网格缩略图 + 去重三态 + 我看过哪些 + 各阶段耗时
// 用法：node tools/viewer.mjs <taskId> [port]
import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const OUT_ROOT = '/data/user/0/app.dsh.mobile/files/dsh-home/storages/dsh-video-kit/out'
const taskId = process.argv[2]
const PORT = Number(process.argv[3] || 3999)
if (!taskId) { console.error('用法: node tools/viewer.mjs <taskId> [port]'); process.exit(1) }
const dir = join(OUT_ROOT, taskId)
if (!existsSync(join(dir, 'index.json'))) { console.error('找不到任务:', taskId); process.exit(1) }

const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
const ledgerPath = join(dir, 'ledger.json')
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, '')) : { opened: [], viewed: {} }

// 页名 → 信息
const keptSet = new Map((idx.dedup?.kept || []).map((x) => [x.page, x]))
const droppedMap = new Map((idx.dedup?.dropped || []).map((x) => [x.page, x]))
const pages = []
for (const g of idx.groups || []) for (const pg of g.pages || []) pages.push(pg)

const viewed = ledger.viewed || {}
const openedIdx = new Set(ledger.opened || [])

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 时间轴：各阶段耗时
const t = idx.timings || {}
const stages = Object.entries(t).filter(([k]) => k !== 'total').sort((a, b) => b[1] - a[1])
const stageMax = Math.max(...stages.map(([, v]) => v), 0.001)

const rowsHtml = pages.map((pg, i) => {
  const kept = keptSet.get(pg.page)
  const dropped = droppedMap.get(pg.page)
  let role = 'kept', cls = 'kept', group = ''
  if (dropped) { role = 'dropped'; cls = 'dropped' }
  else if (kept?.visualGroup) { role = 'visualGroup'; cls = 'grouped'; group = kept.visualGroup }
  const isViewed = !!viewed[pg.page]
  const ts = (pg.frames || []).map((f) => Number(f.t)).filter(Number.isFinite)
  const from = ts.length ? Math.min(...ts) : 0
  const to = ts.length ? Math.max(...ts) : 0
  return `<figure class="card ${cls}${isViewed ? ' viewed' : ''}" data-i="${i}">
    <div class="thumb"><img loading="lazy" src="/img/${encodeURIComponent(pg.page)}" alt="${esc(pg.page)}"></div>
    <figcaption>
      <div class="pname">${esc(pg.page)} <span class="badge ${cls}">${role}</span>${isViewed ? '<span class="badge view">已看</span>' : ''}</div>
      <div class="ptime">${from.toFixed(1)}s – ${to.toFixed(1)}s</div>
      ${group ? `<div class="pgroup">归组到 ${esc(group)}</div>` : ''}
      ${dropped ? `<div class="pgroup">代表页 ${esc(dropped.representativePage || '?')}</div>` : ''}
      ${kept?.reason ? `<div class="preason">${esc(kept.reason)}</div>` : ''}
    </figcaption>
  </figure>`
}).join('\n')

const stagesHtml = stages.map(([k, v]) => `
  <div class="stagerow">
    <div class="sname">${esc(k)}</div>
    <div class="sbar"><div class="sfill" style="width:${Math.max(1.5, (v / stageMax) * 100)}%"></div></div>
    <div class="sval">${v.toFixed(2)}s</div>
  </div>`).join('')

const summary = {
  total: pages.length,
  kept: (idx.dedup?.kept || []).filter((x) => !x.visualGroup).length,
  grouped: (idx.dedup?.kept || []).filter((x) => x.visualGroup).length,
  dropped: (idx.dedup?.dropped || []).length,
  viewed: Object.keys(viewed).length,
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(taskId)}</title>
<style>
  :root { --bg:#0f1419; --card:#161d26; --line:#2a3644; --text:#e6edf3; --dim:#8b949e;
          --kept:#3fb950; --grouped:#d29922; --dropped:#8b949e; --view:#4a9eff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font-family: system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  header { padding:20px 16px 8px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:17px; font-weight:600; word-break:break-all; }
  .meta { font-size:13px; color:var(--dim); }
  .chips { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .chip { font-size:12.5px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); }
  .chip.kept { color:var(--kept); border-color:#1f6f3a; }
  .chip.grouped { color:var(--grouped); border-color:#6b5320; }
  .chip.dropped { color:var(--dropped); }
  .chip.view { color:var(--view); border-color:#2b5b8a; }
  main { padding:14px 12px 40px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .card { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .card.kept { border-left:3px solid var(--kept); }
  .card.grouped { border-left:3px solid var(--grouped); }
  .card.dropped { border-left:3px solid var(--dropped); opacity:.55; }
  .card.viewed { outline:2px solid var(--view); outline-offset:-2px; }
  .thumb { aspect-ratio:1; background:#0b0f13; display:flex; align-items:center; justify-content:center; }
  .thumb img { width:100%; height:100%; object-fit:contain; }
  figcaption { padding:7px 9px 9px; font-size:11.5px; line-height:1.5; }
  .pname { font-weight:600; font-size:12px; }
  .ptime, .pgroup, .preason { color:var(--dim); }
  .badge { display:inline-block; font-size:10px; padding:1px 6px; border-radius:4px; margin-left:4px;
           border:1px solid var(--line); vertical-align:1px; }
  .badge.kept { color:var(--kept); }
  .badge.grouped { color:var(--grouped); }
  .badge.dropped { color:var(--dropped); }
  .badge.view { color:var(--view); border-color:#2b5b8a; }
  h2 { font-size:15px; margin:26px 0 12px; padding-left:2px; }
  .stagerow { display:grid; grid-template-columns:110px 1fr 62px; gap:8px; align-items:center;
              margin-bottom:7px; font-size:12.5px; }
  .sname { color:var(--dim); text-align:right; }
  .sbar { height:16px; background:#0b0f13; border-radius:4px; overflow:hidden; }
  .sfill { height:100%; background:linear-gradient(90deg,#2b5b8a,#4a9eff); border-radius:4px; }
  .sval { color:var(--text); font-variant-numeric:tabular-nums; }
  .total { margin-top:14px; font-size:13px; color:var(--dim); }
  .total b { color:var(--text); }
</style></head>
<body>
<header>
  <h1>${esc(taskId)}</h1>
  <div class="meta">${idx.duration ? Number(idx.duration).toFixed(1) + 's · ' : ''}${pages.length} 页 · ${(idx.subs || []).length} 条字幕 · ${(idx.screenText || []).length} 条画面文字</div>
  <div class="chips">
    <span class="chip kept">kept ${summary.kept}</span>
    <span class="chip grouped">grouped ${summary.grouped}</span>
    <span class="chip dropped">dropped ${summary.dropped}</span>
    <span class="chip view">已看 ${summary.viewed}</span>
  </div>
</header>
<main>
  <div class="grid">
${rowsHtml}
  </div>

  <h2>各阶段耗时</h2>
  ${stagesHtml}
  <div class="total">管线总计 <b>${(t.total || 0).toFixed(2)}s</b></div>
</main>
</body></html>`

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }
  if (url.startsWith('/img/')) {
    const name = url.slice(5)
    const file = join(dir, 'grids', name + '.jpg')
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=600' })
    return res.end(readFileSync(file))
  }
  res.writeHead(404); res.end('not found')
})
server.listen(PORT, '127.0.0.1', () => console.log(`viewer: http://127.0.0.1:${PORT}`))

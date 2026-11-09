import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const W = 640, BG = '#0f1419', CARD = '#161d26', BORDER = '#2a3644'
const TEXT = '#e6edf3', DIM = '#8b949e', GREEN = '#3fb950', ORANGE = '#e3a35f'
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const parts = []; let H = 0
function box(x, y, w, h, o = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${o.fill || CARD}" stroke="${o.stroke || BORDER}" stroke-width="1.6"/>`)
}
function text(x, y, s, o = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${o.size || 15}" font-weight="${o.weight || 400}" fill="${o.color || TEXT}" text-anchor="${o.anchor || 'middle'}" font-family="system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif">${esc(s)}</text>`)
}
function arrow(y1, y2, label) {
  const id = `a${parts.length}`
  parts.push(`<defs><marker id="${id}" markerWidth="11" markerHeight="11" refX="8" refY="4" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="${DIM}"/></marker></defs>`)
  parts.push(`<line x1="${W/2}" y1="${y1}" x2="${W/2}" y2="${y2}" stroke="${DIM}" stroke-width="2.4" marker-end="url(#${id})"/>`)
  if (label) text(W / 2 + 90, (y1 + y2) / 2 + 4, label, { size: 12, color: DIM, anchor: 'start' })
}
parts.push(`<rect width="${W}" height="1200" fill="${BG}"/>`)
let y = 46
text(W/2, y, '网格页去重', { size: 22, weight: 700 })
text(W/2, y+26, 'ADR-0012', { size: 15, color: DIM })
y = 92
const M = 24, CW = W - M*2
box(M, y, CW, 58); text(W/2, y+26, '网格页（N 页）', { size: 17, weight: 600 }); text(W/2, y+46, '按时间顺序，每页 2×3 格', { size: 13, color: DIM })
arrow(y+58, y+58+30); y = y+58+30
box(M, y, CW, 96, { stroke: '#4a9eff' })
text(W/2, y+30, '全图 pHash 初筛', { size: 17, weight: 600, color: '#4a9eff' })
text(W/2, y+56, '与「代表页」比，不是与上一页比', { size: 14 })
text(W/2, y+78, '代表页 = 上一个被判定保留的页', { size: 13, color: DIM })
let prev = y+96
arrow(prev, prev+28); y = prev+28
box(M, y, CW, 150, { stroke: GREEN })
text(W/2, y+30, '差异 ≤ 6 bit → 进入局部复核', { size: 16, weight: 600, color: GREEN })
for (const [i,s] of ['切 2×3 六个区域','每块单独算 pHash','任一区域差异 > 10 → 保留'].entries()) text(W/2, y+60+i*26, '· '+s, { size: 14 })
prev = y+150
arrow(prev, prev+28); y = prev+28
box(M, y, CW, 92, { stroke: ORANGE })
text(W/2, y+30, '都没变化 → 标记 dropped', { size: 17, weight: 600, color: ORANGE })
text(W/2, y+54, '不物理删除，只标记', { size: 14 })
text(W/2, y+76, '记录 representativePage 供追溯', { size: 13, color: DIM })
prev = y+92
arrow(prev, prev+28); y = prev+28
box(M, y, CW, 108, { fill: '#12201a', stroke: GREEN })
text(W/2, y+30, '门禁按三组指标分开报', { size: 16, weight: 600, color: GREEN })
for (const [i,s] of ['originals  原始页直接查看率（分母不缩）','kept       代表页查看率','mapping    映射完整性（不折算成已查看）'].entries()) text(W/2, y+58+i*22, s, { size: 13 })
prev = y+108
arrow(prev, prev+28); y = prev+28
box(M, y, CW, 78, { fill: '#1a1410', stroke: ORANGE })
text(W/2, y+30, '边界：对漫画分镜基本无效', { size: 15, weight: 600, color: ORANGE })
text(W/2, y+54, '21 页只删 1 页——但「删了几页」不是好指标', { size: 13, color: DIM })
H = y + 78 + 40
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="${BG}"/>\n${parts.slice(1).join('\n')}\n</svg>\n`
writeFileSync(join('docs','diagrams','grid-dedup.svg'), svg)
console.log('已写 grid-dedup.svg', W+'x'+H)

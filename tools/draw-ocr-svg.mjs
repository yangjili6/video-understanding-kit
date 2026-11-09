import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const W = 640, BG = '#0f1419', CARD = '#161d26', BORDER = '#2a3644'
const TEXT = '#e6edf3', DIM = '#8b949e', GREEN = '#3fb950', BLUE = '#4a9eff', ORANGE = '#e3a35f'
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const parts = []
function box(x, y, w, h, o = {}) { parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${o.fill || CARD}" stroke="${o.stroke || BORDER}" stroke-width="1.6"/>`) }
function text(x, y, s, o = {}) { parts.push(`<text x="${x}" y="${y}" font-size="${o.size || 15}" font-weight="${o.weight || 400}" fill="${o.color || TEXT}" text-anchor="${o.anchor || 'middle'}" font-family="system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif">${esc(s)}</text>`) }
function arrow(x1, y1, x2, y2) {
  const id = `a${parts.length}`
  parts.push(`<defs><marker id="${id}" markerWidth="11" markerHeight="11" refX="8" refY="4" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="${DIM}"/></marker></defs>`)
  parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${DIM}" stroke-width="2.4" marker-end="url(#${id})"/>`)
}
parts.push(`<rect width="${W}" height="1300" fill="${BG}"/>`)
let y = 46
text(W/2, y, 'OCR 候选区间 + 画面文字', { size: 22, weight: 700 })
text(W/2, y+26, 'ADR-0013', { size: 15, color: DIM })
y = 92
const M = 24, CW = W - M*2
box(M, y, CW, 58); text(W/2, y+26, '解码帧（全片）', { size: 17, weight: 600 }); text(W/2, y+46, '固定帧率，带时间戳', { size: 13, color: DIM })
let prev = y+58
arrow(W/2, prev, W/2, prev+28); y = prev+28
box(M, y, CW, 92, { stroke: BLUE })
text(W/2, y+30, '稀疏探测 16 帧', { size: 17, weight: 600, color: BLUE })
text(W/2, y+54, '保留文字框 + 时间点', { size: 14 })
text(W/2, y+76, '不是只回答「有没有字」', { size: 13, color: DIM })
prev = y+92
arrow(W/2, prev, W/2, prev+28); y = prev+28
box(M, y, CW, 88, { stroke: GREEN })
text(W/2, y+30, '候选区间', { size: 17, weight: 600, color: GREEN })
text(W/2, y+54, '命中帧前后各留半窗 → 合并重叠', { size: 14 })
text(W/2, y+76, '30 秒漫画：60 帧 → 25 帧（省 58%）', { size: 13, color: DIM })
prev = y+88
arrow(W/2, prev, W/2, prev+28); y = prev+28
box(M, y, CW, 148, { fill: '#12201a', stroke: GREEN })
text(W/2, y+30, '只对候选区间全量检测', { size: 16, weight: 600, color: GREEN })
text(W/2, y+58, '检测拆出来：detect 找框 → recognizeCrop 读字', { size: 13 })
text(W/2, y+82, '贵的只有 recognizeCrop', { size: 13, color: DIM })
text(W/2, y+106, '预算 15s（SUBS_OCR_BUDGET_MS）', { size: 13 })
text(W/2, y+126, '耗尽如实退出，不假装跑完', { size: 13, color: ORANGE })
prev = y+148
arrow(W/2, prev, W/2, prev+28); y = prev+28
box(M, y, CW, 62); text(W/2, y+26, '分成两条输出', { size: 17, weight: 600 }); text(W/2, y+48, '职责不同，物理分开', { size: 13, color: DIM })
prev = y+62
// 左右两列
const colW = (CW - 16) / 2
box(M, prev+28, colW, 128, { stroke: GREEN })
text(M+colW/2, prev+58, 'subs', { size: 16, weight: 600, color: GREEN })
text(M+colW/2, prev+82, '硬字幕', { size: 14 })
for (const [i,s] of ['底部居中','跨帧稳定','进字幕时间轴'].entries()) text(M+colW/2, prev+106+i*20, '· '+s, { size: 12 })
box(M+colW+16, prev+28, colW, 128, { stroke: ORANGE })
text(M+colW+16+colW/2, prev+58, 'screenText', { size: 16, weight: 600, color: ORANGE })
text(M+colW+16+colW/2, prev+82, '画面文字', { size: 14 })
for (const [i,s] of ['气泡/招牌/界面','不进字幕时间轴','状态变化触发识别'].entries()) text(M+colW+16+colW/2, prev+106+i*20, '· '+s, { size: 12 })
y = prev+28+128
arrow(W/2, y, W/2, y+28); y = y+28
box(M, y, CW, 96, { fill: '#1a1410', stroke: ORANGE })
text(W/2, y+30, '边界：短字幕仍可能漏', { size: 15, weight: 600, color: ORANGE })
text(W/2, y+54, '稀疏采样抓不住闪现的字', { size: 13 })
text(W/2, y+74, '要保证不漏，就得逐帧级处理并接受成本', { size: 13, color: DIM })
const H = y + 96 + 40
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="${BG}"/>\n${parts.slice(1).join('\n')}\n</svg>\n`
writeFileSync(join('docs','diagrams','ocr-pipeline.svg'), svg)
console.log('已写 ocr-pipeline.svg', W+'x'+H)

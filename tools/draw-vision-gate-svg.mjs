import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0011 架构图：只保留主流程，框内文字统一居中
const W = 980
const H = 900
const BG = '#0f1419'
const CARD = '#161d26'
const BORDER = '#2a3644'
const TEXT = '#e6edf3'
const DIM = '#8b949e'
const GREEN = '#3fb950'
const BLUE = '#4a9eff'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const parts = []

function box(x, y, w, h, { fill = CARD, stroke = BORDER, rx = 10 } = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`)
}
function text(x, y, s, { size = 14, color = TEXT, weight = 400, anchor = 'middle', mono = false } = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="${mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif'}">${esc(s)}</text>`)
}
function arrow(x1, y1, x2, y2, color = DIM) {
  const id = `ah${parts.length}`
  parts.push(`<defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>`)
  parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6" marker-end="url(#${id})"/>`)
}

parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`)

// 标题
text(W / 2, 46, '视觉强制执行工作流（ADR-0011）', { size: 20, weight: 600 })
text(W / 2, 72, 'LLM 不再决定「要不要看图」——由插件编排步骤，账本记录看过什么', { size: 13, color: DIM })

// 1. 用户任务
box(W / 2 - 210, 100, 420, 56)
text(W / 2, 126, '用户提出视频分析任务', { size: 15, weight: 500 })
text(W / 2, 145, 'video_analyze(video)', { size: 12, color: DIM, mono: true })

// 2. Orchestrator
arrow(W / 2, 156, W / 2, 196)
box(W / 2 - 260, 196, 520, 100, { stroke: BLUE })
text(W / 2, 226, 'Orchestrator · 任务编排器', { size: 16, weight: 600, color: BLUE })
text(W / 2, 252, '由插件控制，不交给 LLM 自主决定', { size: 13, color: DIM })
text(W / 2, 276, '建任务 · 定采样策略 · 只交出 taskId 与前 3 页导航', { size: 12.5 })

// 3. 双通道
arrow(W / 2, 296, W / 2, 336)
const cw = 380
const cy = 336
const ch = 200
const cxL = W / 2 - cw / 2 - 20
const cxR = W / 2 + cw / 2 + 20

box(cxL - cw / 2, cy, cw, ch, { stroke: GREEN })
text(cxL, cy + 32, '视觉通道', { size: 16, weight: 600, color: GREEN })
text(cxL, cy + 55, '强制执行', { size: 12, color: GREEN })
for (const [i, s] of ['抽帧 / 网格分页', '场景与镜头切分', 'video_look 逐页看图', '账本记账 opened[]'].entries()) {
  text(cxL, cy + 90 + i * 26, '· ' + s, { size: 13 })
}

box(cxR - cw / 2, cy, cw, ch)
text(cxR, cy + 32, '文本通道', { size: 16, weight: 600 })
text(cxR, cy + 55, '辅助执行', { size: 12, color: DIM })
for (const [i, s] of ['ASR 语音识别', 'PP-OCR 硬字幕', '时间戳对齐', '只随 video_look 交付'].entries()) {
  text(cxR, cy + 90 + i * 26, '· ' + s, { size: 13 })
}

// 4. Vision Gate
const gy = cy + ch + 40
arrow(cxL, cy + ch, W / 2 - 130, gy)
arrow(cxR, cy + ch, W / 2 + 130, gy)
box(W / 2 - 310, gy, 620, 152, { stroke: GREEN, fill: '#12201a' })
text(W / 2, gy + 32, 'Vision Gate · 视觉执行门', { size: 16, weight: 600, color: GREEN })
text(W / 2, gy + 56, '必须通过', { size: 12, color: GREEN })
for (const [i, s] of ['看过页数 ≥ max(3, 总页数 × 30%)', '覆盖关键转场页', '只看第 1 页就下全片结论 → 拒绝'].entries()) {
  text(W / 2, gy + 86 + i * 26, '· ' + s, { size: 13 })
}

// 5. LLM
const ly = gy + 152 + 34
arrow(W / 2, gy + 152, W / 2, ly)
box(W / 2 - 230, ly, 460, 86)
text(W / 2, ly + 32, 'LLM 综合推理', { size: 16, weight: 500 })
text(W / 2, ly + 56, '基于「真的看过的画面」+ 随页取回的字幕', { size: 13, color: DIM })
text(W / 2, ly + 74, 'video_report(taskId, conclusion)', { size: 12, color: DIM, mono: true })

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${parts.join('\n')}\n</svg>\n`
writeFileSync(join('docs', 'diagrams', 'vision-gate.svg'), svg)
console.log('已重写 vision-gate.svg（只保留主流程，文字居中）')

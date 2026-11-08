import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0011 架构图：Orchestrator → 双通道 → Vision Gate → LLM
// 深色背景版（和 pipeline-core 同色系），文字全部手动定位，避免重叠
const W = 980
const H = 1090
const BG = '#0f1419'
const CARD = '#161d26'
const BORDER = '#2a3644'
const TEXT = '#e6edf3'
const DIM = '#8b949e'
const GREEN = '#3fb950'
const BLUE = '#4a9eff'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const parts = []

function box(x, y, w, h, { fill = CARD, stroke = BORDER, rx = 10, dash = null } = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`)
}
function text(x, y, s, { size = 14, color = TEXT, weight = 400, anchor = 'middle', mono = false } = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="${mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif'}">${esc(s)}</text>`)
}
function arrow(x1, y1, x2, y2, color = DIM, label = null, labelDx = 0) {
  const id = `ah${parts.length}`
  parts.push(`<defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>`)
  parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6" marker-end="url(#${id})"/>`)
  if (label) text((x1 + x2) / 2 + labelDx, (y1 + y2) / 2 - 8, label, { size: 12, color: DIM })
}

parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`)

// 标题
text(W / 2, 42, '视觉强制执行工作流（ADR-0011）', { size: 20, weight: 600 })
text(W / 2, 66, 'LLM 不再决定「要不要看图」——由插件编排步骤，账本记录看过什么', { size: 13, color: DIM })

// 1. 用户任务
box(W / 2 - 200, 92, 400, 54)
text(W / 2, 118, '用户提出视频分析任务', { size: 15, weight: 500 })
text(W / 2, 136, 'video_analyze(video)', { size: 12, color: DIM, mono: true })

// 2. Orchestrator
arrow(W / 2, 146, W / 2, 186)
box(W / 2 - 250, 186, 500, 96, { stroke: BLUE })
text(W / 2, 214, 'Orchestrator · 任务编排器', { size: 16, weight: 600, color: BLUE })
text(W / 2, 240, '由插件控制，不交给 LLM 自主决定', { size: 13, color: DIM })
text(W / 2, 262, '建任务 · 定采样策略 · 只交出 taskId 与前 3 页导航', { size: 12.5, color: TEXT })

// 3. 双通道
arrow(W / 2, 282, W / 2, 316)
const cw = 380
const cy = 316
const ch = 190
box(W / 2 - cw - 20, cy, cw, ch, { stroke: GREEN })
text(W / 2 - cw / 2 - 20, cy + 30, '视觉通道', { size: 16, weight: 600, color: GREEN })
text(W / 2 - cw / 2 - 20, cy + 52, '强制执行', { size: 12, color: GREEN })
for (const [i, s] of ['抽帧 / 网格分页', '场景与镜头切分', 'video_look 逐页看图', '账本记账 opened[]'].entries()) {
  text(W / 2 - cw / 2 - 20, cy + 84 + i * 26, '· ' + s, { size: 13, color: TEXT })
}
box(W / 2 + 20, cy, cw, ch)
text(W / 2 + cw / 2 + 20, cy + 30, '文本通道', { size: 16, weight: 600 })
text(W / 2 + cw / 2 + 20, cy + 52, '辅助执行', { size: 12, color: DIM })
for (const [i, s] of ['ASR 语音识别', 'PP-OCR 硬字幕', '时间戳对齐', '只随 video_look 交付'].entries()) {
  text(W / 2 + cw / 2 + 20, cy + 84 + i * 26, '· ' + s, { size: 13, color: TEXT })
}

// 4. Vision Gate
arrow(W / 2 - cw / 2 - 20, cy + ch, W / 2 - 120, cy + ch + 30)
arrow(W / 2 + cw / 2 + 20, cy + ch, W / 2 + 120, cy + ch + 30)
box(W / 2 - 300, cy + ch + 30, 600, 132, { stroke: GREEN, fill: '#12201a' })
text(W / 2, cy + ch + 60, 'Vision Gate · 视觉执行门', { size: 16, weight: 600, color: GREEN })
text(W / 2, cy + ch + 82, '必须通过', { size: 12, color: GREEN })
for (const [i, s] of ['看过页数 ≥ max(3, 总页数 × 30%)', '覆盖关键转场页', '只看第 1 页就下全片结论 → 拒绝'].entries()) {
  text(W / 2 - 270, cy + ch + 110 + i * 24, '· ' + s, { size: 13, color: TEXT, anchor: 'start' })
}

// 5. LLM
arrow(W / 2, cy + ch + 162, W / 2, cy + ch + 202)
box(W / 2 - 220, cy + ch + 202, 440, 84)
text(W / 2, cy + ch + 232, 'LLM 综合推理', { size: 16, weight: 500 })
text(W / 2, cy + ch + 256, '基于「真的看过的画面」+ 随页取回的字幕', { size: 13, color: DIM })
text(W / 2, cy + ch + 274, 'video_report(taskId, conclusion)', { size: 12, color: DIM, mono: true })

// 侧栏：边界说明
const sideY = cy + ch + 320
box(40, sideY, W - 80, 130, { fill: '#1a1410', stroke: '#8a5a2b' })
text(70, sideY + 30, '这条方案的边界', { size: 15, weight: 600, color: '#e3a35f', anchor: 'start' })
text(70, sideY + 58, 'video_look 被调用 ≠ 真的看了图。read_image 是内置工具，插件感知不到。', { size: 13, color: TEXT, anchor: 'start' })
text(70, sideY + 82, '能做到的上限：把图和字绑进同一个返回，让「拿字」必然经过图。', { size: 13, color: TEXT, anchor: 'start' })
text(70, sideY + 106, '再往下要强制，只能由宿主提供「工具间已读回执」——不是插件能解决的。', { size: 13, color: DIM, anchor: 'start' })

// 图例
const ly = cy + ch + 480
box(40, ly, W - 80, 74)
text(70, ly + 26, '实测（2026-11-08）', { size: 13, weight: 600, anchor: 'start' })
text(70, ly + 50, '2/34 页提交 → rejected「至少需要 11 页」　·　11/34 页提交 → passed', { size: 13, color: DIM, anchor: 'start', mono: true })

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${parts.join('\n')}\n</svg>\n`
writeFileSync(join('docs', 'diagrams', 'vision-gate.svg'), svg)
console.log('已写 docs/diagrams/vision-gate.svg')

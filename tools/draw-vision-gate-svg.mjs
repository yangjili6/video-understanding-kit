import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0011 架构图（窄版）：单列纵向，双通道上下排，字号相对更大
// 宽度只有 640，2x 后 1280，手机上不缩也能看清
const W = 640
const BG = '#0f1419'
const CARD = '#161d26'
const BORDER = '#2a3644'
const TEXT = '#e6edf3'
const DIM = '#8b949e'
const GREEN = '#3fb950'
const BLUE = '#4a9eff'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const parts = []
let H = 0

function box(x, y, w, h, { fill = CARD, stroke = BORDER } = {}) {
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`)
}
function text(x, y, s, { size = 16, color = TEXT, weight = 400, mono = false } = {}) {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="middle" font-family="${mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif'}">${esc(s)}</text>`)
}
function arrow(y1, y2) {
  const id = `a${parts.length}`
  parts.push(`<defs><marker id="${id}" markerWidth="11" markerHeight="11" refX="8" refY="4" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="${DIM}"/></marker></defs>`)
  parts.push(`<line x1="${W / 2}" y1="${y1}" x2="${W / 2}" y2="${y2}" stroke="${DIM}" stroke-width="2.4" marker-end="url(#${id})"/>`)
}
const M = 24            // 左右边距
const CW = W - M * 2    // 卡片宽度

parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`)  // 占位，最后改高度

let y = 0
// 标题
y = 46
parts.push(`<text x="${W / 2}" y="${y}" font-size="22" font-weight="700" fill="${TEXT}" text-anchor="middle" font-family="system-ui, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif">视觉强制执行工作流</text>`)
y = 72
text(W / 2, y, 'ADR-0011', { size: 15, color: DIM })

// 1 用户任务
y = 92
box(M, y, CW, 62)
text(W / 2, y + 28, '用户提出视频分析任务', { size: 17, weight: 600 })
text(W / 2, y + 50, 'video_analyze(video)', { size: 14, color: DIM, mono: true })
let prevBottom = y + 62

// 2 Orchestrator
arrow(prevBottom, prevBottom + 24)
y = prevBottom + 24
box(M, y, CW, 108, { stroke: BLUE })
text(W / 2, y + 30, 'Orchestrator · 任务编排器', { size: 17, weight: 600, color: BLUE })
text(W / 2, y + 56, '由插件控制，不交给 LLM 自主决定', { size: 14, color: DIM })
text(W / 2, y + 80, '建任务 · 定采样策略', { size: 14 })
text(W / 2, y + 100, '只交出 taskId 与前 3 页导航', { size: 14 })
prevBottom = y + 108

// 3 视觉通道
arrow(prevBottom, prevBottom + 22)
y = prevBottom + 22
box(M, y, CW, 168, { stroke: GREEN })
text(W / 2, y + 32, '视觉通道 · 强制执行', { size: 17, weight: 600, color: GREEN })
for (const [i, s] of ['抽帧 / 网格分页', '场景与镜头切分', 'video_look 逐页看图', '账本记账 opened[]'].entries()) {
  text(W / 2, y + 64 + i * 26, '· ' + s, { size: 15 })
}
prevBottom = y + 168

// 4 文本通道
arrow(prevBottom, prevBottom + 22)
y = prevBottom + 22
box(M, y, CW, 168)
text(W / 2, y + 32, '文本通道 · 辅助执行', { size: 17, weight: 600 })
for (const [i, s] of ['ASR 语音识别', 'PP-OCR 硬字幕', '时间戳对齐', '只随 video_look 交付'].entries()) {
  text(W / 2, y + 64 + i * 26, s, { size: 15 })
}
prevBottom = y + 168

// 5 Vision Gate
arrow(prevBottom, prevBottom + 22)
y = prevBottom + 22
box(M, y, CW, 178, { stroke: GREEN, fill: '#12201a' })
text(W / 2, y + 34, 'Vision Gate · 视觉执行门', { size: 17, weight: 600, color: GREEN })
text(W / 2, y + 58, '必须通过', { size: 14, color: GREEN })
for (const [i, s] of ['看过页数 ≥ max(3, 总页数 × 30%)', '覆盖关键转场页', '只看第 1 页就下全片结论 → 拒绝'].entries()) {
  text(W / 2, y + 90 + i * 26, '· ' + s, { size: 15 })
}
prevBottom = y + 178

// 6 LLM
arrow(prevBottom, prevBottom + 22)
y = prevBottom + 22
box(M, y, CW, 100)
text(W / 2, y + 32, 'LLM 综合推理', { size: 17, weight: 600 })
text(W / 2, y + 58, '基于「真的看过的画面」', { size: 14, color: DIM })
text(W / 2, y + 80, 'video_report(taskId, conclusion)', { size: 13, color: DIM, mono: true })

H = y + 100 + 40
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n<rect width="${W}" height="${H}" fill="${BG}"/>\n${parts.slice(1).join('\n')}\n</svg>\n`
writeFileSync(join('docs', 'diagrams', 'vision-gate.svg'), svg)
console.log(`已写窄版 vision-gate.svg（${W}x${H}）`)

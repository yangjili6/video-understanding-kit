// 生成管线架构图 SVG：视频分析管线（并发 + 温度决策）
// 用法：node tools/draw-pipeline-svg.mjs > out.svg
const W = 1240, H = 900

const C = {
  bg: '#0f1419',
  panel: '#1a2029',
  panel2: '#212a36',
  line: '#3a4656',
  text: '#e6edf3',
  dim: '#8b98a8',
  accent: '#4a9eff',
  warm: '#f0a04b',
  hot: '#e5534b',
  ok: '#3fb950',
}

const box = (x, y, w, h, fill, stroke, rx = 8) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`

const txt = (x, y, s, { size = 14, fill = C.text, weight = 400, anchor = 'middle' } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif">${s}</text>`

const arrow = (x1, y1, x2, y2, color = C.line) => {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const a1 = ang - Math.PI / 7, a2 = ang + Math.PI / 7
  const L = 9
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6"/>
  <polygon points="${x2},${y2} ${x2 - L * Math.cos(a1)},${y2 - L * Math.sin(a1)} ${x2 - L * Math.cos(a2)},${y2 - L * Math.sin(a2)}" fill="${color}"/>`
}

// 折线箭头
const elbow = (x1, y1, x2, y2, color = C.line) => {
  const my = (y1 + y2) / 2
  return `<path d="M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6"/>
  <polygon points="${x2},${y2} ${x2 - 4.5},${y2 - 8} ${x2 + 4.5},${y2 - 8}" fill="${color}"/>`
}

const parts = []
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
parts.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)

// ── 标题
parts.push(txt(W / 2, 44, '视频分析管线 · 并发与温度决策', { size: 22, weight: 600 }))
parts.push(txt(W / 2, 70, 'dsh-video-kit 0.2.3 · 手机端实测 26s 素材 → 40.46s', { size: 13, fill: C.dim }))

// ── 主流程（纵向中列）
const cx = 430
const bw = 200, bh = 46
const nodes = [
  { y: 110, label: '视频输入', sub: '本地 / B站' },
  { y: 190, label: '抽基础帧', sub: '5fps · 960 宽' },
  { y: 270, label: '帧差检测', sub: '画面变化点' },
]
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]
  parts.push(box(cx - bw / 2, n.y, bw, bh, C.panel, C.line))
  parts.push(txt(cx, n.y + 20, n.label, { size: 15, weight: 500 }))
  parts.push(txt(cx, n.y + 37, n.sub, { size: 11, fill: C.dim }))
  if (i < nodes.length - 1) parts.push(arrow(cx, n.y + bh, cx, nodes[i + 1].y))
}

// ── 并发分叉
const forkY = 340
parts.push(arrow(cx, 316, cx, forkY))
const leftX = 200, rightX = 660
parts.push(elbow(cx, forkY, leftX, 380))
parts.push(elbow(cx, forkY, rightX, 380))

// 左：TransNet worker
parts.push(box(leftX - 130, 380, 260, 86, C.panel2, C.accent))
parts.push(txt(leftX, 406, 'TransNet 镜头检测', { size: 15, weight: 600, fill: C.accent }))
parts.push(txt(leftX, 428, 'worker 线程', { size: 12, fill: C.dim }))
parts.push(txt(leftX, 447, '窗口 100 帧 · 不重叠', { size: 11, fill: C.dim }))

// 右：OCR + ASR
parts.push(box(rightX - 150, 380, 300, 86, C.panel2, C.accent))
parts.push(txt(rightX, 404, '字幕 OCR · 语音 ASR', { size: 15, weight: 600, fill: C.accent }))
parts.push(txt(rightX, 426, '主线程串行（WASM）', { size: 12, fill: C.dim }))
parts.push(txt(rightX, 445, 'OCR 检测分片 → 3 路 worker', { size: 11, fill: C.dim }))

// ── 汇合
const joinY = 540
parts.push(elbow(leftX, 466, cx, joinY))
parts.push(elbow(rightX, 466, cx, joinY))
parts.push(box(cx - bw / 2, joinY, bw, bh, C.panel, C.line))
parts.push(txt(cx, joinY + 20, '补帧 + 分组', { size: 15, weight: 500 }))
parts.push(txt(cx, joinY + 37, '按镜头切段', { size: 11, fill: C.dim }))
parts.push(arrow(cx, joinY + bh, cx, 630))

parts.push(box(cx - bw / 2, 630, bw, bh, C.panel, C.ok))
parts.push(txt(cx, 650, '网格页 + 字幕', { size: 15, weight: 500 }))
parts.push(txt(cx, 667, '输出给 Agent 阅读', { size: 11, fill: C.dim }))

// ── 右侧：温度决策面板
const px = 900, py = 110, pw = 300, ph = 420
parts.push(box(px, py, pw, ph, C.panel, C.line, 10))
parts.push(txt(px + pw / 2, py + 30, '温度决策', { size: 16, weight: 600, fill: C.warm }))
parts.push(txt(px + pw / 2, py + 50, 'dumpsys battery → 电池温度', { size: 11, fill: C.dim }))

const tiers = [
  { t: '＜ 38℃', n: '不限（标定值）', c: C.ok },
  { t: '38 ~ 40℃', n: '最多 3 路', c: C.warm },
  { t: '40 ~ 42℃', n: '最多 2 路', c: '#d29922' },
  { t: '＞ 42℃', n: '退回串行', c: C.hot },
]
tiers.forEach((tier, i) => {
  const y = py + 80 + i * 74
  parts.push(box(px + 16, y, pw - 32, 60, C.panel2, tier.c, 6))
  parts.push(txt(px + 34, y + 24, tier.t, { size: 13, weight: 600, fill: tier.c, anchor: 'start' }))
  parts.push(txt(px + 34, y + 44, tier.n, { size: 12, fill: C.text, anchor: 'start' }))
})

// 决策箭头指向分叉
parts.push(`<path d="M ${px} ${py + 160} L ${rightX + 158} ${py + 160} L ${rightX + 158} 420" fill="none" stroke="${C.warm}" stroke-width="1.4" stroke-dasharray="5 4"/>`)
parts.push(txt(rightX + 170, py + 150, '限流', { size: 11, fill: C.warm, anchor: 'start' }))

// ── 底部：三档实测
const by = 790
parts.push(txt(W / 2, by - 10, '并发实测（52 帧 · TransNet 固定串行）', { size: 13, fill: C.dim }))
const stats = [
  { k: '1 路', v: '53.3s', d: '基准', c: C.dim },
  { k: '3 路', v: '25.5s', d: '效率 69.7% · 入选', c: C.ok },
  { k: '4 路', v: '26.9s', d: '边际 -5.5% · 拒绝', c: C.hot },
]
stats.forEach((s, i) => {
  const x = W / 2 - 330 + i * 220
  parts.push(box(x - 95, by, 190, 54, C.panel, C.line, 6))
  parts.push(txt(x - 78, by + 22, s.k, { size: 13, fill: C.dim, anchor: 'start' }))
  parts.push(txt(x + 78, by + 26, s.v, { size: 18, weight: 700, fill: s.c, anchor: 'end' }))
  parts.push(txt(x - 78, by + 42, s.d, { size: 10, fill: s.c, anchor: 'start' }))
})

parts.push('</svg>')
console.log(parts.join('\n'))

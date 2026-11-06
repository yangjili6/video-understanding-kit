// 生成「OCR 并发 + 温度决策」核心图（简化版，只保留两条主线）
// 用法：node tools/draw-core-svg.mjs > out.svg
const W = 860, H = 480

const C = {
  bg: '#0f1419', panel: '#1a2029', panel2: '#212a36', line: '#3a4656',
  text: '#e6edf3', dim: '#8b98a8', accent: '#4a9eff',
  warm: '#f0a04b', hot: '#e5534b', ok: '#3fb950',
}

const box = (x, y, w, h, fill, stroke, rx = 8) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
const txt = (x, y, s, o = {}) => {
  const { size = 13, fill = C.text, weight = 400, anchor = 'middle' } = o
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="-apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif">${s}</text>`
}

const p = []
p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
p.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)

// ── 上：OCR 并发
p.push(txt(W / 2, 32, 'OCR 检测并发', { size: 17, weight: 600 }))
p.push(txt(W / 2, 52, '标定推荐 → 温度上限 → 实际路数', { size: 11, fill: C.dim }))

// 主线程 → 三个 worker
p.push(box(60, 78, 130, 54, C.panel, C.line))
p.push(txt(125, 100, '主线程', { size: 13, weight: 500 }))
p.push(txt(125, 118, 'PP-OCR 分片', { size: 10, fill: C.dim }))

for (let i = 0; i < 3; i++) {
  const y = 78 + i * 66
  p.push(box(300, y, 150, 54, C.panel2, C.accent))
  p.push(txt(375, y + 21, `worker ${i + 1}`, { size: 12, weight: 500, fill: C.accent }))
  p.push(txt(375, y + 38, '4.5MB det 模型', { size: 9, fill: C.dim }))
  // 分派箭头
  p.push(`<path d="M 190 105 L 245 105 L 245 ${y + 27} L 300 ${y + 27}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
  p.push(`<polygon points="300,${y + 27} 292,${y + 22} 292,${y + 32}" fill="${C.line}"/>`)
}

// 汇总
p.push(`<path d="M 450 ${105} L 505 ${105}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
p.push(`<path d="M 450 ${171} L 505 ${171}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
p.push(`<path d="M 450 ${237} L 505 ${237}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
for (const y of [105, 171, 237]) p.push(`<path d="M 505 ${y} L 505 171" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
p.push(`<path d="M 505 171 L 545 171" fill="none" stroke="${C.line}" stroke-width="1.4"/>`)
p.push(`<polygon points="545,171 537,166 537,176" fill="${C.line}"/>`)

p.push(box(545, 130, 150, 82, C.panel, C.ok))
p.push(txt(620, 156, '事件合并', { size: 13, weight: 500 }))
p.push(txt(620, 176, '→ 字幕时间线', { size: 10, fill: C.dim }))
p.push(txt(620, 196, '取最长文本帧', { size: 9, fill: C.dim }))

// par 标注
p.push(txt(375, 292, '实测 par ≈ 2.4（3 路）— 不是每个 worker 都能拿满核', { size: 10, fill: C.dim }))

// ── 下：温度决策
p.push(txt(W / 2, 350, '温度决策（优先于吞吐量）', { size: 17, weight: 600, fill: C.warm }))
p.push(txt(W / 2, 370, 'dumpsys battery → 电池温度 · 能读到时只认温度', { size: 10, fill: C.dim }))

const tiers = [
  { t: '＜ 38℃', n: '不限', c: C.ok },
  { t: '38~40℃', n: '3 路', c: C.warm },
  { t: '40~42℃', n: '2 路', c: '#d29922' },
  { t: '＞ 42℃', n: '串行', c: C.hot },
]
tiers.forEach((tier, i) => {
  const x = 60 + i * 190
  p.push(box(x, 388, 170, 62, C.panel2, tier.c, 6))
  p.push(txt(x + 85, 412, tier.t, { size: 12, weight: 600, fill: tier.c }))
  p.push(txt(x + 85, 434, tier.n, { size: 14, weight: 700 }))
})

// 温度 → 并发 的限流箭头（从下往上）


p.push('</svg>')
console.log(p.join('\n'))

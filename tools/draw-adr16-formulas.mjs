// 生成 ADR-0016 的三条公式图（手写 SVG 数学排版，不依赖 LaTeX 环境）
// 风格对齐 docs/diagrams/formula-e.png：深底、浅色 serif 数学字
// 用法：node tools/draw-adr16-formulas.mjs > /tmp/adr16.svg && rsvg-convert -z 2 /tmp/adr16.svg -o docs/diagrams/adr16-formulas@2x.png
const W = 1120
const C = { bg: '#0f1419', text: '#e6edf3', dim: '#8b98a8', accent: '#4a9eff' }
const p = []
const T = (x, y, s, size = 34, fill = C.text, anchor = 'start', weight = 400) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="'Latin Modern Math','STIX Two Math','Times New Roman',serif">${s}</text>`

// ── 公式一：动态预算  pages = clamp(⌈T/6⌉, 8, 36)
p.push(T(40, 62, 'pages', 34))
p.push(T(158, 62, '=', 34, C.dim))
p.push(T(196, 62, 'clamp', 34))
p.push(T(300, 62, '(', 34))
p.push(T(322, 44, '⌈', 40))
p.push(T(368, 34, 'T', 32))
p.push(`<line x1="340" y1="46" x2="404" y2="46" stroke="${C.text}" stroke-width="2.2"/>`)
p.push(T(378, 78, '6', 32))
p.push(T(414, 44, '⌉', 40))
p.push(T(448, 62, ', 8, 36', 34))
p.push(T(600, 62, ')', 34))
// 右侧：F_pool = 1.5 × F_budget
p.push(T(672, 62, 'F', 32))
p.push(T(692, 74, 'pool', 18, C.dim))
p.push(T(744, 62, '=', 30, C.dim))
p.push(T(778, 62, '1.5', 32))
p.push(T(828, 62, '×', 30, C.dim))
p.push(T(872, 62, 'F', 32))
p.push(T(892, 74, 'budget', 17, C.dim))

// ── 公式二：五信号评分
const y2 = 176
p.push(T(40, y2, 'S', 34))
p.push(T(62, y2 + 8, 'i', 21, C.dim))
p.push(T(96, y2, '=', 34, C.dim))
const terms = [
  ['0.25', 'C'], ['0.20', 'M'], ['0.20', 'A'], ['0.15', 'O'], ['0.20', 'T'],
]
let x = 146
for (let k = 0; k < terms.length; k++) {
  const [coef, sym] = terms[k]
  p.push(T(x, y2, coef, 30, C.accent))
  p.push(T(x + 76, y2, sym, 32))
  p.push(T(x + 100, y2 + 8, 'i', 21, C.dim))
  x += 132
  if (k < terms.length - 1) { p.push(T(x - 18, y2, '+', 30, C.dim)); x += 18 }
}

// ── 公式三：间隙评分
const y3 = 276
p.push(T(40, y3, 'score', 32))
p.push(T(158, y3 + 8, 'ij', 21, C.dim))
p.push(T(206, y3, '=', 32, C.dim))
p.push(T(248, y3, 'Δt', 32))
p.push(T(294, y3 + 8, 'ij', 21, C.dim))
p.push(T(348, y3, '(', 32))
p.push(T(372, y3, '0.35', 30, C.accent))
p.push(T(456, y3, '+', 30, C.dim))
p.push(T(488, y3, 'v', 32))
p.push(T(506, y3 + 8, 'ij', 21, C.dim))
p.push(T(548, y3, ')', 32))

const H = 320
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${p.join('\n')}
</svg>`
process.stdout.write(svg)

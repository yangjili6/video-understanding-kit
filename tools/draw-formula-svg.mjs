// 生成 ADR-0009 的两条规则公式 SVG（手写数学排版，不依赖 LaTeX 环境）
// 用法：node tools/draw-formula-svg.mjs > formulas.svg
const W = 760, H = 300
const C = { bg: '#0f1419', text: '#e6edf3', dim: '#8b98a8', accent: '#4a9eff', ok: '#3fb950' }

const p = []
p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
p.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)

// 主符号用较大字号，上下标用小字号 + dy 偏移
const T = (x, y, s, size = 34, fill = C.text, anchor = 'middle', weight = 400) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" font-family="'Latin Modern Math','STIX Two Math','Times New Roman',serif">${s}</text>`

// ── 公式一：效率
// E_n = (T_1 / T_n) / n × 100% ≥ 40%
p.push(T(60, 92, 'E', 38))
p.push(T(80, 108, 'n', 22, C.dim))                       // 下标
p.push(T(122, 92, '=', 34))
p.push(T(178, 78, 'T', 30))                               // 分子
p.push(T(196, 92, '1', 19, C.dim))
p.push(T(228, 78, '/', 30, C.dim))
p.push(T(258, 78, 'T', 30))
p.push(T(276, 92, 'n', 19, C.dim))
// 主分数线
p.push(`<line x1="160" y1="104" x2="300" y2="104" stroke="${C.text}" stroke-width="2.4"/>`)
p.push(T(230, 136, 'n', 30))
p.push(T(348, 92, '× 100%', 30))
p.push(T(500, 92, '≥ 40%', 30, C.ok, 'start'))

// ── 公式二：边际
// G_n = (T_{n-1} - T_n) / T_{n-1} × 100% ≥ 8%
p.push(T(60, 232, 'G', 38))
p.push(T(80, 248, 'n', 22, C.dim))
p.push(T(122, 232, '=', 34))
// 分子：T_{n-1} − T_n
p.push(T(196, 218, 'T', 30))
p.push(T(216, 232, 'n−1', 17, C.dim))
p.push(T(276, 218, '−', 30, C.dim))
p.push(T(316, 218, 'T', 30))
p.push(T(334, 232, 'n', 19, C.dim))
// 分数线
p.push(`<line x1="170" y1="244" x2="356" y2="244" stroke="${C.text}" stroke-width="2.4"/>`)
// 分母：T_{n-1}
p.push(T(238, 278, 'T', 30))
p.push(T(258, 292, 'n−1', 17, C.dim))
p.push(T(400, 232, '× 100%', 30))
p.push(T(552, 232, '≥ 8%', 30, C.ok, 'start'))

p.push('</svg>')
console.log(p.join('\n'))

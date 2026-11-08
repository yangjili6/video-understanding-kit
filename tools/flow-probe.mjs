// 纯 JS 光流探针：Shi-Tomasi 角点 + Lucas-Kanade 稀疏光流
// 目的：验证「不引入 opencv.js 也能拿到局部运动」——对应 ADR-0012 Level 1
// 用法：node tools/flow-probe.mjs <帧目录> [起始帧] [帧数]
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = process.argv[2]
const from = Number(process.argv[3] || 0)
const count = Number(process.argv[4] || 40)
if (!dir) { console.error('用法: node tools/flow-probe.mjs <帧目录> [起始帧] [帧数]'); process.exit(1) }

const W = 160, H = 90   // 分析分辨率（原始帧缩小后）

function readGray(path) {
  // 用 ImageMagick 解成 160x90 灰度裸数据，避开自己写 JPEG 解码
  const raw = execFileSync('magick', [path, '-colorspace', 'Gray', '-resize', `${W}x${H}!`, '-depth', '8', 'gray:-'], { maxBuffer: 8 * 1024 * 1024 })
  return new Uint8Array(raw.slice(0, W * H))
}

// Shi-Tomasi：对每个像素算 2x2 结构张量的最小特征值，取局部极大值
function corners(img, maxN = 120, minDist = 6) {
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    gx[i] = (img[i - W + 1] + 2 * img[i + 1] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - 1] - img[i + W - 1]) / 8
    gy[i] = (img[i + W - 1] + 2 * img[i + W] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - W] - img[i - W + 1]) / 8
  }
  const R = 2
  const score = new Float32Array(W * H)
  for (let y = R; y < H - R; y++) for (let x = R; x < W - R; x++) {
    let a = 0, b = 0, c = 0
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const i = (y + dy) * W + (x + dx)
      a += gx[i] * gx[i]; b += gx[i] * gy[i]; c += gy[i] * gy[i]
    }
    const det = a * c - b * b, tr = a + c
    score[y * W + x] = tr - Math.sqrt(Math.max(0, tr * tr - 4 * det))   // 最小特征值 ×2
  }
  const picked = []
  const used = new Uint8Array(W * H)
  for (let n = 0; n < maxN; n++) {
    let best = -1, bi = -1
    for (let i = 0; i < W * H; i++) if (score[i] > best && !used[i]) { best = score[i]; bi = i }
    if (bi < 0 || best <= 0) break
    const py = (bi / W) | 0, px = bi % W
    picked.push({ x: px, y: py })
    for (let dy = -minDist; dy <= minDist; dy++) for (let dx = -minDist; dx <= minDist; dx++) {
      const yy = py + dy, xx = px + dx
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) used[yy * W + xx] = 1
    }
  }
  return picked
}

// Lucas-Kanade：单尺度，在 prev 点周围迭代求位移（窗口 5x5）
function lk(prev, next, pt, win = 5, iters = 6) {
  let u = 0, v = 0
  const gxp = (x, y, I) => {
    const i = y * W + x
    return (I[i - W + 1] + 2 * I[i + 1] + I[i + W + 1] - I[i - W - 1] - 2 * I[i - 1] - I[i + W - 1]) / 8
  }
  const gyp = (x, y, I) => {
    const i = y * W + x
    return (I[i + W - 1] + 2 * I[i + W] + I[i + W + 1] - I[i - W - 1] - 2 * I[i - W] - I[i - W + 1]) / 8
  }
  const sample = (I, x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y)
    if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) return null
    const fx = x - x0, fy = y - y0
    const i = y0 * W + x0
    return I[i] * (1 - fx) * (1 - fy) + I[i + 1] * fx * (1 - fy) + I[i + W] * (1 - fx) * fy + I[i + W + 1] * fx * fy
  }
  for (let it = 0; it < iters; it++) {
    let gxx = 0, gxy = 0, gyy = 0, gxt = 0, gyt = 0
    for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
      const x = pt.x + u + dx, y = pt.y + v + dy
      const nv = sample(next, x, y)
      if (nv === null) continue
      const xi = Math.round(x), yi = Math.round(y)
      const ix = gxp(xi, yi, prev), iy = gyp(xi, yi, prev)
      const itv = nv - sample(prev, x, y) || 0
      if (!Number.isFinite(ix) || !Number.isFinite(iy)) continue
      gxx += ix * ix; gxy += ix * iy; gyy += iy * iy
      gxt += ix * itv; gyt += iy * itv
    }
    const det = gxx * gyy - gxy * gxy
    if (Math.abs(det) < 1e-6) return null
    const du = (-gyy * gxt + gxy * gyt) / det
    const dv = (gxy * gxt - gxx * gyt) / det
    u += du; v += dv
    if (Math.hypot(du, dv) < 0.1) break
  }
  return { u, v, mag: Math.hypot(u, v) }
}

// 正向-反向校验：从 prev 跟到 next，再从 next 跟回 prev。
// 真匹配的位移应近似互为相反数；误匹配不会抵消，直接丢掉。
function lkFB(prev, next, pt, fbThresh = 1.2) {
  const f = lk(prev, next, pt)
  if (!f) return null
  const backPt = { x: pt.x + f.u, y: pt.y + f.v }
  if (backPt.x < 1 || backPt.y < 1 || backPt.x >= W - 1 || backPt.y >= H - 1) return null
  const b = lk(next, prev, backPt)
  if (!b) return null
  const err = Math.hypot(f.u + b.u, f.v + b.v)
  if (err > fbThresh) return null
  return { u: f.u, v: f.v, mag: f.mag, fbErr: err }
}

// 降采样：步长 2 的双线性近似
function half(I, w, h) {
  const w2 = w >> 1, h2 = h >> 1
  const out = new Uint8Array(w2 * h2)
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = (y * 2) * w + x * 2
    out[y * w2 + x] = (I[i] + I[i + 1] + I[i + w] + I[i + w + 1]) >> 2
  }
  return { img: out, w: w2, h: h2 }
}

// 在给定层级的图上跑一次 LK（窗口 5），返回增量位移
function lkAt(prev, next, x, y, w, h, win = 5, iters = 5) {
  const samp = (I, fx, fy) => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return null
    const dx = fx - x0, dy = fy - y0
    const i = y0 * w + x0
    return I[i] * (1 - dx) * (1 - dy) + I[i + 1] * dx * (1 - dy) + I[i + w] * (1 - dx) * dy + I[i + w + 1] * dx * dy
  }
  const gx = (I, cx, cy) => {
    const i = cy * w + cx
    return (I[i - w + 1] + 2 * I[i + 1] + I[i + w + 1] - I[i - w - 1] - 2 * I[i - 1] - I[i + w - 1]) / 8
  }
  const gy = (I, cx, cy) => {
    const i = cy * w + cx
    return (I[i + w - 1] + 2 * I[i + w] + I[i + w + 1] - I[i - w - 1] - 2 * I[i - w] - I[i - w + 1]) / 8
  }
  let u = 0, v = 0
  for (let k = 0; k < iters; k++) {
    let gxx = 0, gxy = 0, gyy = 0, gxt = 0, gyt = 0
    for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
      const px = x + u + dx, py = y + v + dy
      const a = samp(prev, px, py), b = samp(next, px, py)
      if (a === null || b === null) continue
      const ix = gx(prev, Math.round(px), Math.round(py))
      const iy = gy(prev, Math.round(px), Math.round(py))
      if (!Number.isFinite(ix) || !Number.isFinite(iy)) continue
      const it2 = b - a
      gxx += ix * ix; gxy += ix * iy; gyy += iy * iy
      gxt += ix * it2; gyt += iy * it2
    }
    const det = gxx * gyy - gxy * gxy
    if (Math.abs(det) < 1e-6) return null
    const du = (-gyy * gxt + gxy * gyt) / det
    const dv = (gxy * gxt - gxx * gyt) / det
    u += du; v += dv
    if (Math.hypot(du, dv) < 0.05) break
  }
  return { u, v }
}

// 三层金字塔 LK：在 1/4 分辨率追位移，再逐层细化
function lkPyr(prevFull, nextFull, pt) {
  const l0 = { img: prevFull, w: W, h: H }
  const n0 = { img: nextFull, w: W, h: H }
  const l1 = half(prevFull, W, H), n1 = half(nextFull, W, H)
  const l2 = half(l1.img, l1.w, l1.h), n2 = half(n1.img, n1.w, n1.h)
  let u = 0, v = 0
  // 顶层（1/4）
  const rTop = lkAt(l2.img, n2.img, pt.x / 4, pt.y / 4, l2.w, l2.h)
  if (!rTop) return null
  u = rTop.u * 2; v = rTop.v * 2
  // 中层（1/2）
  const r1 = lkAt(l1.img, n1.img, pt.x / 2 + u * 0.5, pt.y / 2 + v * 0.5, l1.w, l1.h)
  if (!r1) return null
  u = (u + r1.u) * 1; v = (v + r1.v) * 1
  // 底层（原分辨率）
  const r0 = lkAt(prevFull, nextFull, pt.x + u * 0.5, pt.y + v * 0.5, W, H)
  if (!r0) return null
  u += r0.u; v += r0.v
  return { u, v, mag: Math.hypot(u, v) }
}

// 金字塔版的 FB 校验
function lkPyrFB(prev, next, pt, fbThresh = 1.2) {
  const f = lkPyr(prev, next, pt)
  if (!f) return null
  const bx = pt.x + f.u, by = pt.y + f.v
  if (bx < 2 || by < 2 || bx >= W - 2 || by >= H - 2) return null
  const b = lkPyr(next, prev, { x: bx, y: by })
  if (!b) return null
  const err = Math.hypot(f.u + b.u, f.v + b.v)
  if (err > fbThresh) return null
  return { u: f.u, v: f.v, mag: f.mag, fbErr: err }
}

const files = readdirSync(dir).filter((f) => /\.jpg$/i.test(f)).sort().slice(from, from + count)
console.log(`分析帧: ${files.length}（${files[0]} … ${files[files.length - 1]}）`)

let prev = null
const rows = []
for (let i = 0; i < files.length; i++) {
  const img = readGray(join(dir, files[i]))
  if (!prev) { prev = img; continue }
  const pts = corners(prev)
  let sumMag = 0, moved = 0, maxMag = 0, rejected = 0
  const byRegion = { 左上: 0, 右上: 0, 左下: 0, 右下: 0 }
  const counts = { 左上: 0, 右上: 0, 左下: 0, 右下: 0 }
  for (const p of pts) {
    const r = lkPyrFB(prev, img, p)
    if (!r) { rejected++; continue }
    sumMag += r.mag
    if (r.mag > 0.5) moved++
    if (r.mag > maxMag) maxMag = r.mag
    const key = (p.y < H / 2 ? '上' : '下') + (p.x < W / 2 ? '左' : '右')
    byRegion[key] = (byRegion[key] || 0) + r.mag
    counts[key] = (counts[key] || 0) + 1
  }
  const avg = pts.length ? sumMag / pts.length : 0
  const hot = Object.keys(byRegion).sort((a, b) => (byRegion[b] / (counts[b] || 1)) - (byRegion[a] / (counts[a] || 1)))[0]
  rows.push({ i, file: files[i], pts: pts.length, avg: +avg.toFixed(2), moved, max: +maxMag.toFixed(2), hot, rejected })
  prev = img
}

console.log('\n帧  有效点  剔除  平均位移  移动点  最大位移  最活跃区')
for (const r of rows) console.log(
  String(r.i).padStart(3),
  String(r.pts - r.rejected).padStart(6),
  String(r.rejected).padStart(5),
  String(r.avg).padStart(8),
  String(r.moved).padStart(6),
  String(r.max).padStart(8),
  '  ' + (r.hot || '-')
)
const avgAll = rows.reduce((s, r) => s + r.avg, 0) / rows.length
console.log(`\n全段平均位移 ${avgAll.toFixed(2)} px/帧`)

// 字幕条带：把「该页时间段内的字幕」切成小条，去重后按 6 格/行拼成一条，
// 再贴到网格页底部 —— 让 VLM 在一张图里同时看到「画面」和「全时段字幕」。
//
// 动机（2026-11-14 指挥官）：帧级去重会把帧删稀，字幕可能在删掉的帧里变过；
// 网格里只剩几个时间点，中间的字幕就丢了。字幕条带把这些中间状态补回来，
// 而且和网格拼成一张图 —— 既省 token，又让「图里哪块对应哪一帧」在同一坐标系。
//
// 去重：字幕本身也是图像，同一句字幕的相邻帧受压缩影响并不完全相同，
// 所以用 pHash 粗筛 + SSIM 精筛（阈值比帧去重宽松：pHash≤10 / SSIM≥0.88）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { probeSubtitleBand } from './band-probe.mjs'

const FPS = 2                // 字幕带抽帧率
const MAX_ITEMS_PER_ROW = 6  // 一条大条最多 6 个字幕条，超过换行
const PHASH_T = 12
const SSIM_T = 0.82        // 保留给别处（条带整体比较用）
const GLYPH_T = 0.85       // 字形 IoU：同一句字幕 ≥ 0.85

const COS = (() => {
  const N = 32
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Math.cos(((2 * i + 1) * j * Math.PI) / (2 * N))))
})()

function grayOf(file, size) {
  const buf = execFileSync('magick', [file, '-colorspace', 'Gray', '-resize', `${size}x${size}!`, '-depth', '8', 'gray:-'], { maxBuffer: 32 * 1024 * 1024 })
  return { px: new Uint8Array(buf.subarray(0, size * size)), W: size, H: size }
}

/** 按宽度等比缩放的灰度读取（条带是长条形，不能压成正方形） */
function grayWide(file, width) {
  const dim = execFileSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' }).trim().split(' ')
  const w = Number(dim[0]) || width
  const h = Math.max(2, Math.round((Number(dim[1]) || 1) * (width / w)))
  const buf = execFileSync('magick', [file, '-colorspace', 'Gray', '-resize', `${width}x${h}!`, '-depth', '8', 'gray:-'], { maxBuffer: 32 * 1024 * 1024 })
  return { px: new Uint8Array(buf.subarray(0, width * h)), W: width, H: h }
}

function phash(g) {
  const dct = []
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) s += g.px[y * 32 + x] * COS[x][u] * COS[y][v]
    dct.push(s)
  }
  const mean = dct.slice(1).reduce((a, b) => a + b, 0) / 63
  return dct.map((v) => (v > mean ? 1 : 0))
}

const ham = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0)

function ssim(a, b, win = 8) {
  const C1 = 6.5025, C2 = 58.5225
  let total = 0, n = 0
  for (let y = 0; y + win <= a.H; y += win) for (let x = 0; x + win <= a.W; x += win) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
    for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
      const va = a.px[(y + j) * a.W + x + i], vb = b.px[(y + j) * b.W + x + i]
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb
    }
    const N = win * win, ma = sa / N, mb = sb / N
    const va2 = saa / N - ma * ma, vb2 = sbb / N - mb * mb, cov = sab / N - ma * mb
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va2 + vb2 + C2)); n++
  }
  return n ? total / n : 1
}

/**
 * 字形掩码：只保留「高亮 + 高对比」的像素，也就是字幕的白字笔画。
 *
 * 为什么不能用 SSIM/pHash 直接比整帧：字幕条的背景（角色、舰体、场景）一直在动，
 * 同一句字幕的相邻帧 SSIM 只有 0.83 左右，会被判成「不同」（实测）。
 * 而只比白字笔画时，同一句 IoU ≈ 0.95-0.99、不同句 ≈ 0.48-0.52，
 * 两档差一倍，判据非常干净。
 */
function glyphMask(file, W = 180) {
  const dim = execFileSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' }).trim().split(' ')
  const H = Math.max(2, Math.round(Number(dim[1]) * (W / Number(dim[0]))))
  const buf = execFileSync('magick', [file, '-colorspace', 'Gray', '-resize', `${W}x${H}!`, '-depth', '8', 'gray:-'], { maxBuffer: 16 * 1024 * 1024 })
  const px = new Uint8Array(buf.subarray(0, W * H))
  const mask = new Uint8Array(W * H)
  let n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 3; x < W - 3; x++) {
      const v = px[y * W + x]
      // 白字 + 邻域有明显对比（黑描边或深背景）
      if (v > 195 && (Math.abs(v - px[y * W + x - 3]) > 60 || Math.abs(v - px[y * W + x + 3]) > 60)) {
        mask[y * W + x] = 1
        n++
      }
    }
  }
  return { mask, W, H, n }
}

/** 两帧字形掩码的 IoU（交并比）：1 = 完全同一句，0 = 完全无关 */
function maskIoU(a, b) {
  if (a.W !== b.W || a.H !== b.H) return 0
  let inter = 0, uni = 0
  for (let i = 0; i < a.mask.length; i++) {
    const x = a.mask[i], y = b.mask[i]
    if (x && y) inter++
    if (x || y) uni++
  }
  return uni ? inter / uni : 1
}


/**
 * 边缘密度：估计这条带子里「有多少是文字笔画」。
 *
 * 为什么要它：没有硬字幕的视频，字幕带照样会被切出来（它只是画面的一部分），
 * 结果是 bandCount > 0 但一个字都没有。下游拿到会误以为「有字幕但读不出」。
 * 文字的笔画是密集的小梯度，平滑画面（皮肤、墙壁）梯度很少，两者数量级差很远。
 *
 * @returns {number} 0~1，边缘像素占全图比例
 */
function edgeDensity(g, th = 22) {
  if (!g || !g.W || !g.H) return 0
  let hit = 0, total = 0
  for (let y = 1; y < g.H; y++) {
    for (let x = 1; x < g.W; x++) {
      const c = g.px[y * g.W + x]
      const dx = Math.abs(c - g.px[y * g.W + x - 1])
      const dy = Math.abs(c - g.px[(y - 1) * g.W + x])
      if (dx > th || dy > th) hit++
      total++
    }
  }
  return total ? hit / total : 0
}

/**
 * 局部强对比比例：字幕的特征是「细笔画 + 高对比」（白字黑边），
 * 而画面里的大块亮度变化是渐进的。所以只看「和 3px 外邻居差很多」的像素。
 *
 * 单纯统计全图边缘密度区分不开（实测有字幕 0.45 / 无字幕 0.35），
 * 因为条带里本来就含画面。拉大对比阈值 + 看远邻，能把渐变排掉。
 */
function strongContrast(g, th = 90, reach = 3) {
  if (!g || !g.W || !g.H) return 0
  let hit = 0, total = 0
  for (let y = 0; y < g.H; y++) {
    for (let x = reach; x < g.W - reach; x++) {
      const c = g.px[y * g.W + x]
      if (Math.abs(c - g.px[y * g.W + x - reach]) > th || Math.abs(c - g.px[y * g.W + x + reach]) > th) hit++
      total++
    }
  }
  return total ? hit / total : 0
}

/**
 * 给每页生成「网格 + 字幕条带」增强图，并写 pages.json。
 *
 * @param {object} opts
 * @param {string} opts.video      原视频
 * @param {string} opts.outDir     任务输出目录
 * @param {Array}  opts.groups     分组（含 pages）
 * @param {Array}  opts.subtitleBands  字幕带（帧空间坐标）
 * @param {number} opts.FW         帧空间宽度
 * @returns {{pages:number, withBand:number, bandItems:number}}
 */
export function buildBandStrips({ video, outDir, groups, subtitleBands, FW }) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', video], { encoding: 'utf8' }))
  const { width: VW, height: VH } = probe.streams[0]

  // 全图探测：主带（下半屏最强的）+ 所有副带（顶部标题、台标、中间跳出的字幕）
  let bandProbe = null
  try { bandProbe = probeSubtitleBand(video) } catch { bandProbe = null }
  const allBands = (bandProbe?.bands || []).slice()
  // 主带排最前
  allBands.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0))
  const mainBand = allBands.find((b) => b.main) || allBands[0] || null

  const manifest = {
    video: video.split('/').pop(),
    band: mainBand ? { y: mainBand.y0, h: mainBand.y1 - mainBand.y0 } : null,
    topBand: bandProbe?.topBand ? { y: bandProbe.topBand.y0, h: bandProbe.topBand.y1 - bandProbe.topBand.y0 } : null,
    // 所有探测到的带（含位置/笔画密度/锐度），下游可据此知道条带由几段组成
    detectedBands: allBands.map((b) => ({ y: b.y0, h: b.y1 - b.y0, hFreq: b.hFreq, sharp: b.sharp, pos: b.pos, main: !!b.main })),
    pages: [],
  }
  let withBand = 0, bandItems = 0
  if (!allBands.length) {
    for (const g of groups) for (const p of g.pages) manifest.pages.push(metaOf(g, p, null))
    writeFileSync(join(outDir, 'pages.json'), JSON.stringify(manifest, null, 2))
    return { pages: manifest.pages.length, withBand: 0, bandItems: 0 }
  }

  const tmp = join(outDir, '.bandtmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  /**
   * 处理一条带（抽帧 → pHash+SSIM 去重 → 6 格/行 → 出图）。
   * 主带与副带走完全相同的流程，所以副带也有去重和时间戳。
   */
  function stripFor(from, dur, band, tag) {
    const bh = Math.max(8, band.y1 - band.y0)
    const bh2 = bh - (bh % 2)
    const dir = join(tmp, tag)
    mkdirSync(dir, { recursive: true })
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(dur), '-i', video,
        '-vf', `fps=${FPS},crop=${VW}:${bh2}:0:${band.y0}`, '-q:v', '2', join(dir, 'b-%03d.jpg'), '-y'])
    } catch { return null }
    const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    if (!files.length) return null
    const segs = []
    for (let i = 0; i < files.length; i++) {
      // 用「白字笔画掩码的 IoU」判同一句，而不是整帧 SSIM：
      // 字幕条背景一直在动，整帧比会把同一句判成不同（实测 0.83）。
      // 实测字形 IoU：同一句 0.95~0.99，不同句 0.48~0.52。
      const gm = glyphMask(join(dir, files[i]))
      let merged = false
      for (const s2 of segs) {
        if (maskIoU(gm, s2.gm) >= GLYPH_T) {
          s2.endIdx = i
          s2.endT = +(from + (i + 0.5) / FPS).toFixed(2)
          merged = true
          break
        }
      }
      if (!merged) segs.push({ idx: i, endIdx: i, t: +(from + (i + 0.5) / FPS).toFixed(2), endT: +(from + (i + 0.5) / FPS).toFixed(2), file: files[i], gm })
    }
    if (!segs.length) return null
    // 6 格/行
    const rows = []
    for (let i = 0; i < segs.length; i += MAX_ITEMS_PER_ROW) rows.push(segs.slice(i, i + MAX_ITEMS_PER_ROW))
    const rowFiles = []
    for (let r = 0; r < rows.length; r++) {
      const rf = join(tmp, `${tag}-row${r}.jpg`)
      const args = rows[r].map((s2) => join(dir, s2.file))
      while (args.length < MAX_ITEMS_PER_ROW) args.push('-size', `${VW}x${bh2}`, 'xc:#161b22')
      try { execFileSync('magick', [...args, '-background', '#161b22', '+append', rf]); rowFiles.push(rf) } catch { /* skip */ }
    }
    if (!rowFiles.length) return null
    const outFile = join(tmp, `${tag}-strip.jpg`)
    try {
      if (rowFiles.length === 1) execFileSync('cp', [rowFiles[0], outFile])
      else execFileSync('magick', [...rowFiles, '-background', '#161b22', '-append', outFile])
    } catch { return null }
    return { segs, file: outFile, band }
  }

  for (const g of groups) {
    for (const p of g.pages) {
      const ts = (p.frames || []).map((f) => Number(f.t)).filter(Number.isFinite).sort((a, b) => a - b)
      if (!ts.length) { manifest.pages.push(metaOf(g, p, null)); continue }
      const from = ts[0], to = ts[ts.length - 1]
      const dur = Math.max(0.6, to - from)

      // 每条带都出一段（主带 + 副带），副带同样去重、同样带时间戳
      const strips = []
      for (let bi = 0; bi < allBands.length; bi++) {
        const b = allBands[bi]
        const st = stripFor(from, dur, b, `${p.page}-b${bi}`)
        if (st) strips.push({ ...st, index: bi, main: !!b.main })
      }
      if (!strips.length) { manifest.pages.push(metaOf(g, p, null)); continue }

      const bandFile = join(outDir, 'band-' + p.page + '.jpg')
      try {
        const files = strips.map((st) => st.file)
        if (files.length === 1) execFileSync('cp', [files[0], bandFile])
        else execFileSync('magick', [...files, '-background', '#161b22', '-gravity', 'center', '-append', bandFile])
      } catch { manifest.pages.push(metaOf(g, p, null)); continue }

      let td = null, sc = null
      try {
        const gw = grayWide(bandFile, 320)
        td = edgeDensity(gw)
        sc = strongContrast(gw)
      } catch { /* ignore */ }

      const enhFile = join(outDir, 'enh-' + p.page + '.jpg')
      try {
        execFileSync('magick', [p.file, bandFile, '-resize', '1332x', '-background', '#161b22', '-gravity', 'center', '-append', enhFile])
      } catch { manifest.pages.push(metaOf(g, p, null)); continue }

      withBand++
      bandItems += strips.reduce((n, st) => n + st.segs.length, 0)
      manifest.pages.push(metaOf(g, p, { strips, bandFile, enhFile, textDensity: td, strongContrast: sc }))
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  writeFileSync(join(outDir, 'pages.json'), JSON.stringify(manifest, null, 2))
  return { pages: manifest.pages.length, withBand, bandItems }
}

function metaOf(g, p, band) {
  const frames = (p.frames || []).map((f) => ({ id: f.srcFrameId, t: +Number(f.t).toFixed(2) })).sort((a, b) => a.t - b.t)
  const strips = band?.strips || []
  const totalItems = strips.reduce((n, st) => n + st.segs.length, 0)

  // 每条带一组 rows + items；带内位置按「大条序号-行-列」定位
  const bandGroups = strips.map((st, gi) => {
    const rowCount = Math.max(1, Math.ceil(st.segs.length / MAX_ITEMS_PER_ROW))
    const gid = `${p.page}-band${gi + 1}`
    return {
      id: gid,
      main: !!st.main,
      bandY: st.band.y0,
      bandH: st.band.y1 - st.band.y0,
      rowCount,
      itemCount: st.segs.length,
      rows: Array.from({ length: rowCount }, (_, r) => ({
        id: `${gid}-r${String(r + 1).padStart(2, '0')}`,
        index: r + 1,
        itemCount: Math.min(MAX_ITEMS_PER_ROW, st.segs.length - r * MAX_ITEMS_PER_ROW),
      })),
      items: st.segs.map((s2, i) => ({
        id: `b${String(i + 1).padStart(2, '0')}`,
        rowId: `${gid}-r${String(Math.floor(i / MAX_ITEMS_PER_ROW) + 1).padStart(2, '0')}`,
        row: Math.floor(i / MAX_ITEMS_PER_ROW) + 1,
        col: (i % MAX_ITEMS_PER_ROW) + 1,
        t: s2.t,
        endT: s2.endT,
        frames: s2.endIdx - s2.idx + 1,
      })),
    }
  })

  return {
    pageId: p.page,
    groupId: g.id,
    grid: {
      id: p.page,
      from: frames.length ? frames[0].t : 0,
      to: frames.length ? frames[frames.length - 1].t : 0,
      file: `grids/${p.page}.jpg`,
      ...(band ? { enhanced: `enh-${p.page}.jpg` } : {}),
    },
    frameCount: frames.length,
    frames,
    // 大条总数 = 探测到的带数（主带 + 副带）；每条带内再分行/格
    bandStrip: band ? {
      id: `${p.page}-band`,
      file: `band-${p.page}.jpg`,
      maxItemsPerRow: MAX_ITEMS_PER_ROW,
      stripCount: bandGroups.length,
      itemCount: totalItems,
      textDensity: Number.isFinite(band.textDensity) ? Number(band.textDensity.toFixed(4)) : null,
      strongContrast: Number.isFinite(band.strongContrast) ? Number(band.strongContrast.toFixed(4)) : null,
      strips: bandGroups,
    } : null,
    bandCount: totalItems,
    // 兼容旧字段：把所有带的项摊平
    bands: bandGroups.flatMap((bg) => bg.items.map((it) => ({ ...it, stripId: bg.id, main: bg.main }))),
  }
}

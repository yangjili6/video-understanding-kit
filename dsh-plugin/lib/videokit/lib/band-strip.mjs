// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/band-strip.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
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

const FPS = 2                // 字幕带抽帧率
const MAX_ITEMS_PER_ROW = 6  // 一条大条最多 6 个字幕条，超过换行
const PHASH_T = 10
const SSIM_T = 0.88

const COS = (() => {
  const N = 32
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Math.cos(((2 * i + 1) * j * Math.PI) / (2 * N))))
})()

function grayOf(file, size) {
  const buf = execFileSync('magick', [file, '-colorspace', 'Gray', '-resize', `${size}x${size}!`, '-depth', '8', 'gray:-'], { maxBuffer: 32 * 1024 * 1024 })
  return { px: new Uint8Array(buf.subarray(0, size * size)), W: size, H: size }
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

  // 字幕带 → 视频像素坐标（取所有带的 y 并集，避免中英双行只覆盖一行）
  let bandY = 0, bandH = 0
  const bands = (subtitleBands || []).filter((b) => Number.isFinite(b.x0))
  if (bands.length) {
    const k = VW / FW
    const y0s = bands.map((b) => b.y0 * k)
    const y1s = bands.map((b) => b.y1 * k)
    // 探测到的带可能只覆盖字幕的一行（中英双行时 det 常只命中其中一行），
    // 所以上下各放 60% 高度，把整块字幕区兜进来
    const rawY0 = Math.min(...y0s)
    const rawY1 = Math.max(...y1s)
    const rawH = Math.max(6, rawY1 - rawY0)
    const pad = Math.ceil(rawH * 0.6) + 4
    bandY = Math.max(0, Math.floor(rawY0) - pad)
    const yEnd = Math.min(VH, Math.ceil(rawY1) + pad)
    bandH = Math.max(8, (yEnd - bandY) - ((yEnd - bandY) % 2))
  }

  const manifest = { video: video.split('/').pop(), band: bands.length ? { y: bandY, h: bandH } : null, pages: [] }
  let withBand = 0, bandItems = 0
  if (!bands.length) {
    // 没有稳定字幕带：只写网格元数据，不拼条带
    for (const g of groups) for (const p of g.pages) manifest.pages.push(metaOf(g, p, null))
    writeFileSync(join(outDir, 'pages.json'), JSON.stringify(manifest, null, 2))
    return { pages: manifest.pages.length, withBand: 0, bandItems: 0 }
  }

  const tmp = join(outDir, '.bandtmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  for (const g of groups) {
    for (const p of g.pages) {
      const ts = (p.frames || []).map((f) => Number(f.t)).filter(Number.isFinite).sort((a, b) => a - b)
      if (!ts.length) { manifest.pages.push(metaOf(g, p, null)); continue }
      const from = ts[0], to = ts[ts.length - 1]
      const dur = Math.max(0.6, to - from)
      const dir = join(tmp, p.page)
      mkdirSync(dir, { recursive: true })
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(dur), '-i', video,
          '-vf', `fps=${FPS},crop=${VW}:${bandH}:0:${bandY}`, '-q:v', '2', join(dir, 'b-%03d.jpg'), '-y'])
      } catch { manifest.pages.push(metaOf(g, p, null)); continue }

      const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
      const segs = []
      for (let i = 0; i < files.length; i++) {
        const g32 = grayOf(join(dir, files[i]), 32)
        const h = phash(g32)
        const g64 = grayOf(join(dir, files[i]), 64)
        let merged = false
        for (const s of segs) {
          if (ham(h, s.hash) <= PHASH_T && ssim(g64, s.g64) >= SSIM_T) {
            s.endIdx = i
            s.endT = +(from + (i + 0.5) / FPS).toFixed(2)
            merged = true
            break
          }
        }
        if (!merged) {
          segs.push({ idx: i, endIdx: i, t: +(from + (i + 0.5) / FPS).toFixed(2), endT: +(from + (i + 0.5) / FPS).toFixed(2), file: files[i], hash: h, g64 })
        }
      }
      if (!segs.length) { manifest.pages.push(metaOf(g, p, null)); continue }

      // 6 格/行排版
      const rows = []
      for (let i = 0; i < segs.length; i += MAX_ITEMS_PER_ROW) rows.push(segs.slice(i, i + MAX_ITEMS_PER_ROW))
      const rowFiles = []
      for (let r = 0; r < rows.length; r++) {
        const rf = join(tmp, `${p.page}-row${r}.jpg`)
        const args = rows[r].map((s) => join(dir, s.file))
        while (args.length < MAX_ITEMS_PER_ROW) args.push('-size', `${VW}x${bandH}`, 'xc:#161b22')
        try { execFileSync('magick', [...args, '-background', '#161b22', '+append', rf]); rowFiles.push(rf) } catch { /* skip */ }
      }
      if (!rowFiles.length) { manifest.pages.push(metaOf(g, p, null)); continue }
      const bandFile = join(outDir, 'band-' + p.page + '.jpg')
      try {
        if (rowFiles.length === 1) execFileSync('cp', [rowFiles[0], bandFile])
        else execFileSync('magick', [...rowFiles, '-background', '#161b22', '-append', bandFile])
        // 拼到网格页底部
        const enhFile = join(outDir, 'enh-' + p.page + '.jpg')
        execFileSync('magick', [p.file, bandFile, '-resize', '1332x', '-background', '#161b22', '-gravity', 'center', '-append', enhFile])
        withBand++
        bandItems += segs.length
        manifest.pages.push(metaOf(g, p, { segs, bandFile, enhFile }))
      } catch { manifest.pages.push(metaOf(g, p, null)) }
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  writeFileSync(join(outDir, 'pages.json'), JSON.stringify(manifest, null, 2))
  return { pages: manifest.pages.length, withBand, bandItems }
}

function metaOf(g, p, band) {
  const frames = (p.frames || []).map((f) => ({ id: f.srcFrameId, t: +Number(f.t).toFixed(2) })).sort((a, b) => a.t - b.t)
  const segs = band?.segs || []
  const rowCount = Math.max(1, Math.ceil(segs.length / MAX_ITEMS_PER_ROW))
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
    bandStrip: band ? {
      id: `${p.page}-band`,
      file: `band-${p.page}.jpg`,
      maxItemsPerRow: MAX_ITEMS_PER_ROW,
      rowCount,
      itemCount: segs.length,
      rows: Array.from({ length: rowCount }, (_, r) => ({
        id: `${p.page}-band-r${String(r + 1).padStart(2, '0')}`,
        index: r + 1,
        itemCount: Math.min(MAX_ITEMS_PER_ROW, segs.length - r * MAX_ITEMS_PER_ROW),
      })),
    } : null,
    bandCount: segs.length,
    bands: segs.map((s, i) => ({
      id: `b${String(i + 1).padStart(2, '0')}`,
      rowId: `${p.page}-band-r${String(Math.floor(i / MAX_ITEMS_PER_ROW) + 1).padStart(2, '0')}`,
      row: Math.floor(i / MAX_ITEMS_PER_ROW) + 1,
      col: (i % MAX_ITEMS_PER_ROW) + 1,
      t: s.t,
      endT: s.endT,
      frames: s.endIdx - s.idx + 1,
    })),
  }
}

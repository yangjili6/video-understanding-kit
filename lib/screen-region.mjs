/**
 * 画面文字的区域级追踪（ADR-0017）。
 *
 * 与字幕的区别：字幕是「时间轴上的连续文本」，适合按事件分组；
 * 画面文字是「空间上的区域对象」，同一块位置会随内容变化（CPU 85% → 86%），
 * 所以需要维护跨帧的 region 实体，而不是每帧重新检测一遍文本。
 *
 * 纯函数、零依赖，可单独测试。
 */

/** 两个框的间距（不相交时返回最近边缘距离，相交返回 0） */
export function boxGap(a, b) {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1))
  return Math.hypot(dx, dy)
}

/** 两个框的 IoU */
export function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  if (x1 <= x0 || y1 <= y0) return 0
  const inter = (x1 - x0) * (y1 - y0)
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0)
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0)
  return inter / (areaA + areaB - inter)
}

/** 框中心点 */
export function boxCenter(b) {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
}

/**
 * 空间聚类：把距离过近的框合并成一个，避免逐框送 OCR 产生大量小任务。
 *
 * 贪心策略：按面积从大到小取种子，吸收间距 < gap 的邻居；
 * 合并后面积超过 maxAreaRatio × 画面面积就停止吸收
 * （否则上半部分散布的十个框会并成一块，等于没合并）。
 *
 * @param {Array<{x0,y0,x1,y1}>} boxes
 * @param {number} FW 画面宽
 * @param {number} FH 画面高
 * @param {{gap?:number, maxAreaRatio?:number, padding?:number}} opts
 * @returns {Array<{x0,y0,x1,y1,merged:number}>}
 */
export function clusterBoxes(boxes, FW, FH, opts = {}) {
  if (!boxes || !boxes.length) return []
  const gap = opts.gap ?? Math.max(20, FW * 0.03)
  const maxAreaRatio = opts.maxAreaRatio ?? 0.4
  const padding = opts.padding ?? 8
  const maxArea = FW * FH * maxAreaRatio
  // 高度上限：PP-OCR 的 rec 模型按「一行文本」设计，给它一个多行的块会读不出字。
  // 实测 960×1707 竖屏里，单行文字高约 40–80px；超过画面 6% 就别再并了。
  const maxHeight = FH * (opts.maxHeightRatio ?? 0.06)

  const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0)
  const remaining = boxes.map((b) => ({ ...b, merged: 1 })).sort((a, b) => area(b) - area(a))
  const out = []

  while (remaining.length) {
    const seed = remaining.shift()
    let cur = { ...seed }
    let changed = true
    while (changed) {
      changed = false
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i]
        if (boxGap(cur, cand) > gap) continue
        const merged = {
          x0: Math.min(cur.x0, cand.x0), y0: Math.min(cur.y0, cand.y0),
          x1: Math.max(cur.x1, cand.x1), y1: Math.max(cur.y1, cand.y1),
          merged: cur.merged + cand.merged,
        }
        if (area(merged) > maxArea) continue   // 面积上限：不再吸收
        if (merged.y1 - merged.y0 > maxHeight) continue   // 高度上限：避免并成多行块
        cur = merged
        remaining.splice(i, 1)
        i--
        changed = true
      }
    }
    out.push({
      x0: Math.max(0, Math.round(cur.x0 - padding)),
      y0: Math.max(0, Math.round(cur.y0 - padding)),
      x1: Math.min(FW, Math.round(cur.x1 + padding)),
      y1: Math.min(FH, Math.round(cur.y1 + padding)),
      merged: cur.merged,
    })
  }
  // 包含去重：高度上限会让一个高块「停止合并」后另起一个簇，
  // 结果两个簇大面积重叠、内容也重复（实测 r005/r006 就是这样）。
  // 这里把「自身 70% 以上被更大框覆盖」的簇丢掉。
  const covered = (a, b) => {
    const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1)
    const y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1)
    if (x1 <= x0 || y1 <= y0) return 0
    const inter = (x1 - x0) * (y1 - y0)
    const areaA = (a.x1 - a.x0) * (a.y1 - a.y0)
    return inter / Math.max(1, areaA)
  }
  const areaOf = (b) => (b.x1 - b.x0) * (b.y1 - b.y0)
  const kept = out.filter((a, i) =>
    !out.some((b, j) => j !== i && areaOf(b) > areaOf(a) && covered(a, b) > 0.7))
  return kept
}

/**
 * 把新一帧的框匹配到已有 region 上。
 * 匹配条件：IoU > iouTh 或 中心点距离 < centerRatio × 区域宽。
 *
 * @returns {{pairs: Array<[regionIdx, boxIdx]>, unmatchedBoxes: number[], matchedRegions: Set<number>}}
 */
export function matchRegions(regions, boxes, opts = {}) {
  const iouTh = opts.iou ?? 0.5
  const centerRatio = opts.centerRatio ?? 0.5
  const pairs = []
  const matchedRegions = new Set()
  const usedBoxes = new Set()

  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri]
    const rc = boxCenter(r)
    const rw = r.x1 - r.x0
    let best = -1
    let bestScore = -1
    for (let bi = 0; bi < boxes.length; bi++) {
      if (usedBoxes.has(bi)) continue
      const b = boxes[bi]
      const ov = iou(r, b)
      const bc = boxCenter(b)
      const dist = Math.hypot(bc.x - rc.x, bc.y - rc.y)
      const ok = ov > iouTh || dist < centerRatio * rw
      if (!ok) continue
      // 打分优先 IoU，其次中心距离近
      const score = ov > 0 ? ov : 1 - dist / (centerRatio * rw)
      if (score > bestScore) { bestScore = score; best = bi }
    }
    if (best >= 0) {
      pairs.push([ri, best])
      matchedRegions.add(ri)
      usedBoxes.add(best)
    }
  }
  const unmatchedBoxes = boxes.map((_, i) => i).filter((i) => !usedBoxes.has(i))
  return { pairs, unmatchedBoxes, matchedRegions }
}

/**
 * 区域状态机：NEW / STABLE / CHANGED / GONE。
 *
 * @param {{regions:Array, now:number, goneAfterSec:number}} ctx
 * @returns {{regions:Array, toRecognize:Array}}  toRecognize = 需要高清细认的 region
 */
export function updateRegionState(regions, now, goneAfterSec = 2) {
  const toRecognize = []
  const alive = []
  for (const r of regions) {
    const idle = now - r.lastSeen
    if (idle > goneAfterSec) { r.state = 'GONE'; continue }
    if (r.state === 'NEW' || r.state === 'CHANGED') toRecognize.push(r)
    alive.push(r)
  }
  return { regions: alive, toRecognize }
}

/**
 * 决定这一帧要不要扫、怎么扫。
 *
 * @param {{histDiff:number, prevHadText:boolean, hasText:boolean,
 *          nearCut:boolean, diffHi:number, diffLo:number,
 *          secSinceScan:number, rescanEverySec:number}} p
 * @returns {'NEW_SCENE'|'STATIC'|'LOST'|'REENFORCE'}
 */
export function selectScanMode(p) {
  if (p.nearCut || p.histDiff >= p.diffHi) return 'NEW_SCENE'
  if (p.prevHadText && !p.hasText) return 'LOST'
  if (p.histDiff < p.diffLo && p.secSinceScan < p.rescanEverySec) return 'STATIC'
  return 'REENFORCE'
}

/**
 * 把历次识别结果压进 textHistory（限长，保留趋势）。
 * 超出上限时保留：首条 + 每 5 条抽 1 + 末 3 条。
 */
export function pushTextHistory(history, text, maxLen = 20) {
  if (!history.length || history[history.length - 1] !== text) history.push(text)
  if (history.length <= maxLen) return history
  const head = history.slice(0, 1)
  const tail = history.slice(-3)
  const mid = history.slice(1, -3).filter((_, i) => i % 5 === 0)
  return head.concat(mid, tail).slice(0, maxLen)
}

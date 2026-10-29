// 语音转文字模块（sherpa-onnx Node WASM + 中文 paraformer）
// 流程：提取音轨 → 静音检测切分语音段 → 逐段识别 → 产出带时间戳的 cues
// 产出格式与 loadCues 一致：{ id, s, e, text }
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const APP_DIR = '/data/user/0/app.dsh.mobile/files/dsh-home/asr-app/'
const MODEL_DIR = APP_DIR + 'models/paraformer/'
const req = createRequire(APP_DIR)

let _recognizer = null
function getRecognizer() {
  if (_recognizer) return _recognizer
  const sherpa = req('sherpa-onnx')
  const cwd = process.cwd()
  process.chdir(MODEL_DIR) // wasm 版相对路径才找得到模型（实测绝对路径不行）
  try {
    _recognizer = sherpa.createOfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: 'model.int8.onnx' },
        tokens: 'tokens.txt',
        numThreads: 1,
        debug: false,
      },
    })
  } finally {
    process.chdir(cwd)
  }
  return _recognizer
}

function extractAudio(video, outWav) {
  mkdirSync(join(outWav, '..'), { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav, '-y'])
}

// 静音检测 → 语音段（互补区间）
// 阈值可调：实拍片有人声轻、底噪高的，-30dB 会把轻声说话整段判成静音。
// 2026-10-30 实测一个 30s 实拍片：-30dB 切 7 段捞到 4 条，-40dB 切 8 段捞到 5 条
// （多出「游戏」「没有」）。但再放宽到 -50dB 反而只剩 2 条 —— 段被拉太长，识别跑偏。
// 所以默认保持 -30dB 稳定，需要时用 ASR_SILENCE_DB / ASR_MIN_SILENCE 调。
function detectSpeechSegments(wav, opts = {}) {
  const noiseDb = Number(process.env.ASR_SILENCE_DB ?? opts.noiseDb ?? 30)
  const minSilence = Number(process.env.ASR_MIN_SILENCE ?? opts.minSilence ?? 0.4)
  const filter = `silencedetect=noise=-${noiseDb}dB:d=${minSilence}`
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', wav, '-af', filter, '-f', 'null', '-'], { encoding: 'utf8' })
  const log = String(r.stderr || '')
  const silences = []
  const starts = [...log.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
  const ends = [...log.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]))
  for (let i = 0; i < starts.length; i++) silences.push([starts[i], ends[i] ?? Infinity])
  if (!silences.length) return [{ start: 0, end: null }]
  const segs = []
  let cursor = 0
  for (const [a, b] of silences) {
    if (a > cursor + 0.3) segs.push({ start: cursor, end: a })
    cursor = Math.max(cursor, b)
  }
  segs.push({ start: cursor, end: null }) // null = 到结尾
  return segs
}

/**
 * 超长段等分。paraformer 是整段一次性解码，一段喂进 80 多秒会明显跑偏
 * （2026-10-30 实测：动画片用 -35dB 切出 86s / 124s 两段，识别出的文本
 * 出现「冻筷子」「滑管」这类错字，且时间戳粒度粗到没用）。
 * 默认上限 25s，可用 ASR_MAX_SEG 调。
 */
function splitLongSegs(segs, duration, maxLen) {
  if (!(maxLen > 0)) return segs
  const out = []
  for (const s of segs) {
    const start = Number(s.start) || 0
    // 最后一段的 end 是 null（表示「到结尾」）；Number(null) === 0 会让 len 变负、
    // 把 124 秒的段当 0 秒放过 —— 必须显式判空。
    const end = s.end === null || s.end === undefined ? duration : Number(s.end)
    const len = end - start
    if (!(len > maxLen)) {
      out.push(s)
      continue
    }
    const n = Math.ceil(len / maxLen)
    const step = len / n
    for (let k = 0; k < n; k++) {
      out.push({ start: start + k * step, end: start + (k + 1) * step })
    }
  }
  return out
}

export function transcribeVideo(video, opts = {}) {
  const outDir = opts.outDir || 'out/audio'
  const wav = join(outDir, 'audio-16k.wav')
  console.log('[asr] 提取音轨...')
  extractAudio(video, wav)

  console.log('[asr] 加载识别器（217MB int8 paraformer）...')
  const t0 = Date.now()
  const recognizer = getRecognizer()
  const sherpa = req('sherpa-onnx')
  console.log(`[asr] 识别器就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const wave = sherpa.readWave(wav)
  const sr = wave.sampleRate
  const duration = wave.samples.length / sr
  const rawSegs = detectSpeechSegments(wav)
  const maxSeg = Number(process.env.ASR_MAX_SEG ?? 25)
  const segs = splitLongSegs(rawSegs, duration, maxSeg)
  console.log(`[asr] 音频 ${duration.toFixed(1)}s，语音段 ${rawSegs.length} 个${segs.length !== rawSegs.length ? ` → 超长切分后 ${segs.length} 段（上限 ${maxSeg}s）` : ''}`)

  const cues = []
  const t1 = Date.now()
  let dropped = 0
  for (let i = 0; i < segs.length; i++) {
    const { start, end } = segs[i]
    const s = Math.max(0, start - 0.1)
    const e = Math.min(duration, (end ?? duration) + 0.1)
    if (e - s < 0.3) continue
    const samples = wave.samples.subarray(Math.floor(s * sr), Math.round(e * sr))
    const stream = recognizer.createStream()
    stream.acceptWaveform(sr, samples)
    recognizer.decode(stream)
    const r = recognizer.getResult(stream)
    const text = String(r.text || '').replace(/\s+/g, '').trim()
    if (!text) continue
    // 底噪/音乐里常被硬识别成「啊」「啊啊」「嗯」这类语气片段，不携带信息却占一条候选。
    if (isNoiseOnly(text)) {
      dropped++
      continue
    }
    cues.push({ id: `c${String(cues.length + 1).padStart(2, '0')}`, s: Number(s.toFixed(2)), e: Number(e.toFixed(2)), text })
  }
  if (dropped) console.log(`[asr] 丢弃纯语气片段 ${dropped} 条`)
  console.log(`[asr] 识别完成 ${((Date.now() - t1) / 1000).toFixed(1)}s，有效 cue ${cues.length} 条`)
  return cues
}

/** 只由 1~3 个语气字组成、没有任何实词的片段，视为底噪误识别。 */
function isNoiseOnly(text) {
  const t = text.replace(/[，。！？、,.!?…~～\s]/g, '')
  if (!t) return true
  if (t.length > 3) return false
  return /^[啊哦嗯呃唉哎哈嘿呀哇喔噢欸呢呐啦哟]+$/.test(t)
}

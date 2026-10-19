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
function detectSpeechSegments(wav) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', wav, '-af', 'silencedetect=noise=-30dB:d=0.4', '-f', 'null', '-'], { encoding: 'utf8' })
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
  const segs = detectSpeechSegments(wav)
  console.log(`[asr] 音频 ${duration.toFixed(1)}s，语音段 ${segs.length} 个`)

  const cues = []
  const t1 = Date.now()
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
    if (text) cues.push({ id: `c${String(cues.length + 1).padStart(2, '0')}`, s: Number(s.toFixed(2)), e: Number(e.toFixed(2)), text })
  }
  console.log(`[asr] 识别完成 ${((Date.now() - t1) / 1000).toFixed(1)}s，有效 cue ${cues.length} 条`)
  return cues
}

// EmotionTalk -> 我们的样本表 data/emotiontalk-samples.jsonl
//
// 语料：BAAI/Emotiontalk（南开 NKU-HLT，CC BY-NC-SA 4.0，19 演员 / 19,250 条 / 7 类）
// 结构：extract/Text/json/<G...>/<...>.json   每条含 speaker_id / emotion_result / content / file_name
//       extract/Audio/wav/<同路径>.wav        44.1kHz 双声道 16bit
//
// 用法:
//   node ingest-emotiontalk.mjs --root "<corpus>/EmotionTalk\extract" --out data/emotiontalk-samples.jsonl
//   node ingest-emotiontalk.mjs --limit 200          # 先抽 200 条看方向
//
// 只写特征（不复制音频、不保留音频以外的个人信息）。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}
const ROOT = arg('root', '语音\\语音库\\EmotionTalk\\extract')
const OUT = arg('out', join('data', 'emotiontalk-samples.jsonl'))
const LIMIT = Number(arg('limit', '0')) || 0

// 7 类 -> 我们的类
const MAP = {
  neutral: 'neutral',
  angry: 'angry',
  disgusted: 'angry',
  happy: 'happy',
  surprised: 'excited',
  sad: 'sad',
  fearful: 'sad',
}

function walkJson(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkJson(p, acc)
    else if (/\.json$/i.test(e.name)) acc.push(p)
  }
  return acc
}

const textRoot = join(ROOT, 'Text', 'json')
const audioRoot = join(ROOT, 'Audio', 'wav')
if (!existsSync(textRoot)) {
  console.error('Text/json not found under', ROOT)
  process.exit(1)
}

const files = walkJson(textRoot)
const rows = []
let skipped = 0
let missingAudio = 0
for (const jf of files) {
  try {
    const meta = JSON.parse(readFileSync(jf, 'utf8'))
    const emo = MAP[String(meta.emotion_result || '').toLowerCase()]
    if (!emo) { skipped++; continue }
    const rel = String(meta.file_name || '').replace(/\.txt$/i, '.wav')
    if (!rel) { skipped++; continue }
    const wavPath = join(audioRoot, rel)
    if (!existsSync(wavPath)) { missingAudio++; continue }
    const text = String(meta.content || '')
    const wav = parseWav(readFileSync(wavPath))
    const mono = to16kMono(wav.samples, wav.sampleRate)
    const r = analyzeProsody(mono, 16000, { text })
    // ok 但只有 note（几乎没能量）的片段要丢掉，否则 NaN 会污染整张表
    if (!r.ok || !Number.isFinite(r.features?.rate)) { skipped++; continue }
    rows.push({
      file: rel,
      emotion: emo,
      speaker: String(meta.speaker_id || 'unknown'),
      rateMeasured: Boolean(text),
      chars: text.length,
      duration: Number(wav.duration.toFixed(2)),
      features: r.features,
    })
    if (LIMIT && rows.length >= LIMIT) break
  } catch {
    skipped++
  }
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
const byEmo = {}
const bySpk = new Set()
for (const r of rows) {
  byEmo[r.emotion] = (byEmo[r.emotion] || 0) + 1
  bySpk.add(r.speaker)
}
console.log(
  JSON.stringify(
    { ok: true, out: OUT, clips: rows.length, speakers: bySpk.size, skipped, missingAudio, byEmotion: byEmo },
    null,
    2,
  ),
)

// 把 EmoGator（非语言发声：笑、叹气、哭腔、哼）转成我们的样本表
//
// 数据来源：https://github.com/fredbuhl/EmoGator （CC BY 4.0）
// 文件命名：NNNNNN-EE-I.mp3  （说话人 000001-000357 / 类别 01-30 / 第几次 1-3）
//
// 用法:
//   node burst-ingest.mjs --root "<corpus>/EmoGator\extract\EmoGator-main\data\mp3" --limit 2000
//   node burst-ingest.mjs --root "..." --out data\burst-samples.jsonl
//
// 只写特征，不复制音频，不保留转发用的路径。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { MPEGDecoder } from 'mpg123-decoder'
import { to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}

const ROOT = arg('root')
const OUT = arg('out', join('data', 'burst-samples.jsonl'))
const LIMIT = Number(arg('limit', '0')) || 0
const SKIP_EXISTING = process.argv.includes('--resume')

// 30 类 → 我们的 4 类（发声层只需要「像生气 / 像难过 / 像开心 / 平常」）
const MAP = {
  Anger: 'angry', Contempt: 'angry', Disgust: 'angry',
  Sadness: 'sad', Distress: 'sad', Disappointment: 'sad', Guilt: 'sad',
  Shame: 'sad', Embarrassment: 'sad', Pain: 'sad', Fear: 'sad',
  Amusement: 'happy', Elation: 'happy', Ecstasy: 'happy', Triumph: 'happy',
  'Surprise (Positive)': 'happy', Interest: 'happy', Awe: 'happy',
  Adoration: 'happy', 'Romantic Love': 'happy', Desire: 'happy',
  Pride: 'happy', Realization: 'happy',
  Neutral: 'neutral', Contentment: 'neutral', Serenity: 'neutral',
  Relief: 'neutral', Sympathy: 'neutral', Confusion: 'neutral',
  'Surprise (Negative)': 'neutral',
}

const CATEGORIES = [
  'Adoration', 'Amusement', 'Anger', 'Awe', 'Confusion', 'Contempt',
  'Contentment', 'Desire', 'Disappointment', 'Disgust', 'Distress', 'Ecstasy',
  'Elation', 'Embarrassment', 'Fear', 'Guilt', 'Interest', 'Neutral',
  'Pain', 'Pride', 'Realization', 'Relief', 'Romantic Love', 'Sadness',
  'Serenity', 'Shame', 'Surprise (Negative)', 'Surprise (Positive)',
  'Sympathy', 'Triumph',
]

if (!ROOT) {
  console.error('need --root <mp3 dir>')
  process.exit(1)
}

const files = readdirSync(ROOT).filter((n) => /\.mp3$/i.test(n))
if (LIMIT) files.length = Math.min(files.length, LIMIT)

const dec = new MPEGDecoder()
await dec.ready

const rows = []
let done = 0, failed = 0
const t0 = Date.now()

for (const name of files) {
  const m = /^(\d{6})-(\d{2})-(\d)\.mp3$/i.exec(name)
  if (!m) { failed++; continue }
  const speaker = m[1]
  const catIdx = Number(m[2]) - 1
  const cat = CATEGORIES[catIdx]
  if (!cat) { failed++; continue }
  const label = MAP[cat]
  if (!label) { failed++; continue }

  try {
    const buf = readFileSync(join(ROOT, name))
    const { channelData, sampleRate, samplesDecoded } = dec.decode(new Uint8Array(buf))
    if (!samplesDecoded || !channelData?.[0]?.length) { failed++; continue }
    const mono = channelData.length > 1
      ? averageChannels(channelData, samplesDecoded)
      : channelData[0]
    const pcm16k = to16kMono(mono, sampleRate)
    const p = analyzeProsody(pcm16k, 16000, { text: '' })
    if (!p?.ok || !p.features || p.features.note) { failed++; continue }
    rows.push({
      file: name,
      speaker,
      cat,
      emotion: label,
      duration: p.features.duration,
      features: p.features,
    })
  } catch {
    failed++
  }

  done++
  if (done % 1000 === 0) {
    const sec = ((Date.now() - t0) / 1000).toFixed(0)
    console.error(`  ${done}/${files.length}  ok=${rows.length} fail=${failed}  ${sec}s`)
  }
}

function averageChannels(ch, n) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < ch.length; c++) s += ch[c][i]
    out[i] = s / ch.length
  }
  return out
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const byLabel = {}
for (const r of rows) byLabel[r.emotion] = (byLabel[r.emotion] || 0) + 1
const bySpk = new Set(rows.map((r) => r.speaker)).size
console.log(`wrote ${rows.length} rows -> ${OUT}`)
console.log(`  failed=${failed}  speakers=${bySpk}  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('  labels:', JSON.stringify(byLabel))

// 把一个「情绪语料库」变成我们的样本表：data/samples.jsonl
//
// 支持的目录形状（两种都认）：
//   corpus/<emotion>/<speaker>/xxx.wav
//   corpus/<speaker>/<emotion>/xxx.wav
// 每个 wav 旁边可放同名 .txt（转写），有它 rate 才按「字/秒」算；没有就用代理值并标记。
//
// 用法:
//   node ingest-corpus.mjs --root "E:\corpus" --out data\samples.jsonl
//   node ingest-corpus.mjs --root ... --limit 50          # 先抽 50 条看分布
//
// 只写特征，不复制音频、不保留音频路径以外的信息。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { readdirSync } from 'node:fs'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}
const ROOT = arg('root')
const OUT = arg('out', join('data', 'samples.jsonl'))
const LIMIT = Number(arg('limit', '0')) || 0
const EMOTIONS = ['happy', 'excited', 'tired', 'sad', 'relaxed', 'angry', 'neutral']

if (!ROOT || !existsSync(ROOT)) {
  console.error('need --root <corpus dir>')
  process.exit(1)
}

function listWav(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) listWav(p, acc)
    else if (/\.wav$/i.test(e.name)) acc.push(p)
  }
  return acc
}

const files = listWav(ROOT)
const rows = []
let skipped = 0
for (const f of files) {
  const parts = f.slice(ROOT.length + 1).split(/[\\/]/)
  const emotion = parts.find((x) => EMOTIONS.includes(x.toLowerCase()))
  if (!emotion) { skipped++; continue }
  const emoIdx = parts.indexOf(emotion)
  const speaker = emoIdx > 0 ? parts[emoIdx - 1] : (parts.length >= 4 ? parts[parts.length - 2] : 'unknown')
  const txtPath = f.replace(/\.wav$/i, '.txt')
  const text = existsSync(txtPath) ? readFileSync(txtPath, 'utf8').trim() : ''
  try {
    const buf = readFileSync(f)
    const wav = parseWav(buf)
    const mono = to16kMono(wav.samples, wav.sampleRate)
    const r = analyzeProsody(mono, 16000, { text })
    if (!r.ok) { skipped++; continue }
    rows.push({
      file: f,
      emotion: emotion.toLowerCase(),
      speaker,
      rateMeasured: Boolean(text),
      duration: Number(wav.duration.toFixed(2)),
      features: r.features,
    })
    if (LIMIT && rows.length >= LIMIT) break
  } catch (e) {
    skipped++
  }
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
const byEmo = {}
for (const r of rows) byEmo[r.emotion] = (byEmo[r.emotion] || 0) + 1
const spk = new Set(rows.map((r) => r.speaker))
console.log(JSON.stringify({ ok: true, out: OUT, clips: rows.length, speakers: spk.size, skipped, byEmotion: byEmo }, null, 2))

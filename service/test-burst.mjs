// 端到端测「没字但是有声音」这条路：把 EmoGator 的 mp3 转成 wav，POST /analyze，
// 看服务是否走 burst 模型、给出的标签是否合理。
//
// 用法: node test-burst.mjs [--n 12] [--port 3098]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MPEGDecoder } from 'mpg123-decoder'
import { to16kMono } from './lib/wav.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const N = Number(arg('n', '12'))
const PORT = Number(arg('port', '3098'))
const SMART_MIN = Number(arg('from', '100'))
const DIR = arg('dir', '<drive>/\语音库\\EmoGator\\extract\\EmoGator-main\\data\\mp3')

const CATS = [
  ['02', 'Amusement 笑', 'happy'],
  ['12', 'Ecstasy 极喜', 'happy'],
  ['24', 'Sadness 难过', 'sad'],
  ['11', 'Distress 痛苦', 'sad'],
  ['19', 'Pain 疼', 'sad'],
  ['18', 'Neutral 平常', 'neutral'],
]

const dec = new MPEGDecoder()
await dec.ready

function wavOf(pcm16k) {
  const n = pcm16k.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm16k[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

const all = readdirSync(DIR)
const rows = []
for (const [code, name, expect] of CATS) {
  const files = all.filter((f) => Number(f.slice(0, 6)) >= SMART_MIN && f.split('-')[1] === code).slice(0, N)
  for (const f of files) {
    const { channelData, sampleRate, samplesDecoded } = dec.decode(new Uint8Array(readFileSync(join(DIR, f))))
    if (!samplesDecoded) continue
    const pcm = to16kMono(channelData[0], sampleRate)
    const body = wavOf(pcm)
    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${PORT}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body,
    })
    const j = await res.json()
    rows.push({ f, name, expect, text: j.asr?.text ?? '', domain: j.affect?.domain, label: j.affect?.label, conf: j.affect?.confidence, margin: j.affect?.burst?.margin, ms: Date.now() - t0 })
  }
}

let hit = 0, total = 0
for (const r of rows) {
  const ok = r.label === r.expect || (r.expect === 'neutral' && r.label === 'neutral')
  if (r.expect !== 'neutral') { total++; if (ok) hit++ }
  console.log(`${r.f} ${r.name.padEnd(12)} → ${String(r.label).padEnd(8)} conf=${r.conf} margin=${r.margin} ${r.ms}ms domain=${r.domain} text="${r.text}"`)
}
console.log(`\n两极（happy/sad）命中 ${hit}/${total}`)

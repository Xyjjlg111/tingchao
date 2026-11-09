// 给「非语言发声」（EmoGator）贪心选特征：候选里去掉 rate / pause（发声没有说话的字和停顿结构）
//
// 用法: node tune-burst.mjs --in data\burst-samples.jsonl --labels angry,neutral,sad,happy
import { readFileSync } from 'node:fs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const IN = arg('in', 'data/burst-samples.jsonl')
const LABELS = (arg('labels', 'angry,neutral,sad,happy') || '').split(',').map((s) => s.trim()).filter(Boolean)
const ALL = ['energyDb', 'energyVar', 'zcr', 'hnr', 'pitchVar', 'pitchRange', 'pitchSlope', 'tailTrend', 'peakRate', 'jitter', 'voicedRatio']

const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => LABELS.includes(r.emotion))
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const bySpk = {}
for (const r of rows) (bySpk[r.speaker] ||= []).push(r)
const base = {}
for (const [spk, rs] of Object.entries(bySpk)) {
  const neu = rs.filter((r) => r.emotion === 'neutral')
  const src = neu.length >= 3 ? neu : rs
  const f = (k) => med(src.map((r) => r.features[k] ?? 0))
  base[spk] = {
    pitchIQR: f('pitchIQR'), pitchRange: f('pitchRange'), jitter: f('jitter'),
    energyCV: f('energyCV'), energyDb: f('energyDb'), zcr: f('zcr'),
    pitchSlope: f('pitchSlope'), tailTrend: f('tailTrend'), peakRate: f('peakRate'),
    hnr: f('hnr'), voicedRatio: f('voicedRatio'),
  }
}

const relOf = (r) => {
  const f = r.features, b = base[r.speaker]
  return {
    pitchVar: f.pitchIQR / Math.max(0.1, b.pitchIQR),
    pitchRange: f.pitchRange / Math.max(0.1, b.pitchRange),
    jitter: f.jitter / Math.max(0.01, b.jitter),
    energyVar: f.energyCV / Math.max(0.01, b.energyCV),
    energyDb: f.energyDb - b.energyDb,
    zcr: f.zcr / Math.max(1, b.zcr),
    pitchSlope: (f.pitchSlope ?? 0) - b.pitchSlope,
    tailTrend: (f.tailTrend ?? 0) - b.tailTrend,
    peakRate: (f.peakRate ?? 0) / Math.max(0.5, b.peakRate),
    hnr: (f.hnr ?? 0) - b.hnr,
    voicedRatio: f.voicedRatio / Math.max(0.02, b.voicedRatio),
  }
}

const data = rows.map((r) => ({ spk: r.speaker, y: r.emotion, x: relOf(r) }))
const speakers = [...new Set(data.map((d) => d.spk))]
const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)

function accOf(keys) {
  let ok = 0, n = 0
  const conf = {}
  for (const spk of speakers) {
    const train = data.filter((d) => d.spk !== spk), test = data.filter((d) => d.spk === spk)
    const mu = {}, sd = {}
    for (const k of keys) {
      const xs = train.map((d) => d.x[k])
      mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
      sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1
    }
    const zv = (x) => keys.map((k) => (x[k] - mu[k]) / sd[k])
    const groups = {}
    for (const d of train) (groups[d.y] ||= []).push(zv(d.x))
    const cen = {}
    for (const [y, vs] of Object.entries(groups)) cen[y] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
    for (const d of test) {
      const z = zv(d.x)
      let pred = null, best = Infinity
      for (const [y, c] of Object.entries(cen)) { const dd = d2(z, c); if (dd < best) { best = dd; pred = y } }
      conf[d.y] ||= {}; conf[d.y][pred] = (conf[d.y][pred] || 0) + 1
      if (pred === d.y) ok++
      n++
    }
  }
  const by = {}
  for (const y of LABELS) { const tot = Object.values(conf[y] || {}).reduce((a, b) => a + b, 0); by[y] = tot ? Number(((conf[y][y] || 0) / tot).toFixed(2)) : 0 }
  return { acc: Number((ok / n).toFixed(3)), by }
}

console.log(`rows=${data.length} speakers=${speakers.length} labels=${LABELS.join('/')}`)
let chosen = [], best = { acc: 0 }
for (const k of ALL) {
  const r = accOf([k])
  console.log(`  single ${k.padEnd(12)} ${r.acc}`)
  if (r.acc > best.acc) { best = r; chosen = [k] }
}
for (let round = 0; round < 8; round++) {
  let gain = null
  for (const k of ALL) {
    if (chosen.includes(k)) continue
    const r = accOf([...chosen, k])
    if (r.acc > best.acc + 1e-9 && (!gain || r.acc > gain.r.acc)) gain = { k, r }
  }
  if (!gain) break
  chosen.push(gain.k); best = gain.r
  console.log(`+ ${gain.k} → ${gain.r.acc} ${JSON.stringify(gain.r.by)}`)
}
console.log(JSON.stringify({ ok: true, keys: chosen, acc: best.acc, by: best.by, all: accOf(ALL) }, null, 2))

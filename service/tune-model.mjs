// 贪心选特征：在 3 分类上找 LOO 最准的特征子集（质心法）
// 用法: node tune-model.mjs --in data\casia-samples-v4.jsonl --labels angry,neutral,sad
import { readFileSync } from 'node:fs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const IN = arg('in', 'data/casia-samples-v4.jsonl')
const LABELS = (arg('labels', 'angry,neutral,sad') || '').split(',').map((s) => s.trim()).filter(Boolean)
const ALL = ['rate', 'pitchVar', 'pause', 'energyVar', 'energyDb', 'zcr', 'pitchSlope', 'tailTrend', 'peakRate', 'hnr']

const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => LABELS.includes(r.emotion))
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const bySpk = {}
for (const r of rows) (bySpk[r.speaker] ||= []).push(r)
const base = {}
for (const [spk, rs] of Object.entries(bySpk)) {
  const neu = rs.filter((r) => r.emotion === 'neutral')
  const src = neu.length >= 3 ? neu : rs
  const f = (k) => med(src.map((r) => r.features[k] ?? 0))
  base[spk] = { rate: f('rate'), pitchIQR: f('pitchIQR'), pauseRatio: f('pauseRatio'), energyCV: f('energyCV'), energyDb: f('energyDb'), zcr: f('zcr'), pitchSlope: f('pitchSlope'), tailTrend: f('tailTrend'), peakRate: f('peakRate'), hnr: f('hnr') }
}
const relOf = (r) => {
  const f = r.features, b = base[r.speaker]
  return {
    rate: f.rate / Math.max(0.2, b.rate),
    pitchVar: f.pitchIQR / Math.max(0.35, b.pitchIQR),
    pause: f.pauseRatio / Math.max(0.01, b.pauseRatio),
    energyVar: f.energyCV / Math.max(0.03, b.energyCV),
    energyDb: f.energyDb - b.energyDb,
    zcr: f.zcr / Math.max(1, b.zcr),
    pitchSlope: (f.pitchSlope ?? 0) - b.pitchSlope,
    tailTrend: (f.tailTrend ?? 0) - b.tailTrend,
    peakRate: (f.peakRate ?? 0) / Math.max(0.5, b.peakRate),
    hnr: (f.hnr ?? 0) - b.hnr,
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

let chosen = []
let best = { acc: 0 }
for (const k of ALL) {
  const r = accOf([k])
  if (r.acc > best.acc) { best = r; chosen = [k] }
}
for (let round = 0; round < 6; round++) {
  let gain = null
  for (const k of ALL) {
    if (chosen.includes(k)) continue
    const r = accOf([...chosen, k])
    if (r.acc > best.acc + 1e-9 && (!gain || r.acc > gain.r.acc)) gain = { k, r }
  }
  if (!gain) break
  chosen.push(gain.k); best = gain.r
  console.log(`+ ${gain.k} → ${gain.r.acc}`)
}
console.log(JSON.stringify({ ok: true, keys: chosen, acc: best.acc, by: best.by, all: accOf(ALL) }, null, 2))

// 评估「发声模型」在多大 margin 下才值得说话：留一人交叉验证 + 阈值扫描
//
// 用法: node evaluate-burst.mjs --in data\burst-samples.jsonl --model data\burst-model.json
import { readFileSync } from 'node:fs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const IN = arg('in', 'data/burst-samples.jsonl')
const MP = arg('model', 'data/burst-model.json')
const model = JSON.parse(readFileSync(MP, 'utf8'))
const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse)

const KEYS = model.keys
const LABELS = model.labels
const base = model.baseMedians || null

function relOf(f) {
  if (!base) {
    return { pitchRange: f.pitchRange, zcr: f.zcr, energyVar: f.energyCV, energyDb: f.energyDb }
  }
  return {
    pitchRange: f.pitchRange / Math.max(0.1, base.pitchRange),
    zcr: f.zcr / Math.max(1, base.zcr),
    energyVar: f.energyCV / Math.max(0.01, base.energyCV),
    energyDb: f.energyDb - base.energyDb,
  }
}

const data = rows.filter((r) => LABELS.includes(r.emotion)).map((r) => ({
  spk: r.speaker, y: r.emotion, x: relOf(r.features),
}))

const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function train(rowsIn) {
  const mu = {}, sd = {}
  for (const k of KEYS) {
    const xs = rowsIn.map((d) => d.x[k])
    mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
    sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1
  }
  const zv = (x) => KEYS.map((k) => (x[k] - mu[k]) / sd[k])
  const centers = {}
  for (const y of LABELS) {
    const vs = rowsIn.filter((d) => d.y === y).map((d) => zv(d.x))
    centers[y] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
  }
  return { mu, sd, centers }
}

const speakers = [...new Set(data.map((d) => d.spk))]
const preds = []
for (const spk of speakers) {
  const tr = data.filter((d) => d.spk !== spk), te = data.filter((d) => d.spk === spk)
  if (!tr.length || !te.length) continue
  const m = train(tr)
  const zv = (x) => KEYS.map((k) => (x[k] - m.mu[k]) / m.sd[k])
  for (const d of te) {
    const z = zv(d.x)
    const ds = LABELS.map((y) => [y, Math.sqrt(d2(z, m.centers[y]))]).sort((a, b) => a[1] - b[1])
    const [l1, d1] = ds[0]
    const d2v = ds[1][1]
    preds.push({ y: d.y, p: l1, margin: (d2v - d1) / (d2v + d1), d1 })
  }
}

console.log(`rows=${preds.length} speakers=${speakers.length}`)
const baseAcc = preds.filter((p) => p.p === p.y).length / preds.length
console.log(`overall acc (no threshold) = ${baseAcc.toFixed(3)}`)

for (const th of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) {
  const keep = preds.filter((p) => p.margin >= th)
  if (!keep.length) continue
  const prec = keep.filter((p) => p.p === p.y).length / keep.length
  const per = {}
  for (const y of LABELS) {
    const k = keep.filter((p) => p.p === y)
    per[y] = k.length ? Number((k.filter((p) => p.y === y).length / k.length).toFixed(3)) : null
  }
  console.log(`margin>=${th.toFixed(2)} coverage=${(keep.length / preds.length * 100).toFixed(1)}% precision=${prec.toFixed(3)} perLabel=${JSON.stringify(per)}`)
}

for (const dc of [0.8, 1.0, 1.2, 1.5, 2.0]) {
  const keep = preds.filter((p) => p.d1 <= dc)
  if (!keep.length) continue
  const prec = keep.filter((p) => p.p === p.y).length / keep.length
  const per = {}
  for (const y of LABELS) {
    const k = keep.filter((p) => p.p === y)
    per[y] = k.length ? Number((k.filter((p) => p.y === y).length / k.length).toFixed(3)) : null
  }
  console.log('d1<=' + dc + ' coverage=' + (keep.length / preds.length * 100).toFixed(1) + '% precision=' + prec.toFixed(3) + ' perLabel=' + JSON.stringify(per))
}
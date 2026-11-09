// 从样本表训练「按人归一化 + z-score 最近质心」模型：data/model.json
//
// 为什么不再只用区间原型：
//   CASIA 1,000 条上实测——区间原型 LOO 27.8%、最近质心（同一套特征）三分类 65.5%。
//   原型适合"解释"，质心适合"判定"；两者都保留：原型给证据，质心下结论。
//
// 用法:
//   node build-model.mjs --in data\casia-samples-v4.jsonl --labels angry,neutral,sad --loo
//   node build-model.mjs --in ... --out data\model.json
import { readFileSync, writeFileSync } from 'node:fs'

const arg = (n, d = '') => {
  const i = process.argv.indexOf(`--${n}`)
  return i < 0 ? d : process.argv[i + 1]
}
const has = (n) => process.argv.includes(`--${n}`)
const IN = arg('in', 'data/samples.jsonl')
const OUT = arg('out', 'data/model.json')
const LABELS = (arg('labels', 'angry,neutral,sad') || '').split(',').map((s) => s.trim()).filter(Boolean)
const KEYS = (arg('keys', '') || 'rate,pitchVar,pause,energyVar,energyDb,zcr,pitchSlope,tailTrend,peakRate,hnr').split(',').map((s) => s.trim()).filter(Boolean)

const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => LABELS.includes(r.emotion))
  .filter((r) => Number.isFinite(r.features?.rate) && Number.isFinite(r.features?.pitchIQR) && Number.isFinite(r.features?.energyDb))
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// 每人基线：neutral 优先（≥3 条），否则用本人全部
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

function fitNorm(list) {
  const mu = {}, sd = {}
  for (const k of KEYS) {
    const xs = list.map((d) => d.x[k])
    mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
    const v = xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length
    sd[k] = Math.sqrt(v) || 1
  }
  return { mu, sd }
}
const z = (x, n) => KEYS.map((k) => (x[k] - n.mu[k]) / n.sd[k])
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))

function centroidsOf(list, norm) {
  const groups = {}
  for (const d of list) (groups[d.y] ||= []).push(z(d.x, norm))
  const out = {}
  for (const [y, vs] of Object.entries(groups)) {
    out[y] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length).map((v) => Number(v.toFixed(3)))
  }
  return out
}

function loo() {
  const speakers = [...new Set(data.map((d) => d.spk))]
  let ok = 0, n = 0
  const conf = {}
  for (const spk of speakers) {
    const train = data.filter((d) => d.spk !== spk)
    const test = data.filter((d) => d.spk === spk)
    const norm = fitNorm(train)
    const cen = centroidsOf(train, norm)
    for (const d of test) {
      const zz = z(d.x, norm)
      let pred = null, best = Infinity
      for (const [y, c] of Object.entries(cen)) { const dd = dist(zz, c); if (dd < best) { best = dd; pred = y } }
      conf[d.y] ||= {}
      conf[d.y][pred] = (conf[d.y][pred] || 0) + 1
      if (pred === d.y) ok++
      n++
    }
  }
  const by = {}
  for (const y of LABELS) {
    const tot = Object.values(conf[y] || {}).reduce((a, b) => a + b, 0)
    by[y] = tot ? Number(((conf[y][y] || 0) / tot).toFixed(3)) : 0
  }
  const top2 = Object.values(conf).length ? null : null
  return { acc: Number((ok / n).toFixed(3)), n, by, conf, top2 }
}

const norm = fitNorm(data)
const centroids = centroidsOf(data, norm)
const report = has('loo') ? loo() : null

// 每类质心的"半径"：训练集里该类样本到质心距离的 90 分位（判"太远就别下结论"）
const radius = {}
for (const y of LABELS) {
  const vs = data.filter((d) => d.y === y).map((d) => dist(z(d.x, norm), centroids[y]))
  vs.sort((a, b) => a - b)
  radius[y] = Number((vs[Math.floor(vs.length * 0.9)] || 3).toFixed(2))
}

const model = {
  version: '1.0',
  createdAt: new Date().toISOString(),
  labels: LABELS,
  keys: KEYS,
  mu: norm.mu,
  sd: norm.sd,
  centroids,
  radius,
  minConfidence: 0.5,
  loo: report,
}
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, out: OUT, labels: LABELS, clips: data.length, speakers: Object.keys(base).length, radius, loo: report ? { acc: report.acc, by: report.by } : null }, null, 2))

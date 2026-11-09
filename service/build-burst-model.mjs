// 训练「非语言发声」模型：data/burst-model.json
//
// 数据：EmoGator（CC BY 4.0），31,488 条可用发声，356 个说话人。
// 只学两极：happy（笑/雀跃）与 sad（叹气/哭腔/低泣）。
// 中间态（neutral/angry 的发声）刻意不学——说不清就不说，比硬判更安全。
//
// 用法:
//   node build-burst-model.mjs --in data\burst-samples.jsonl --loo
import { readFileSync, writeFileSync } from 'node:fs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const has = (n) => process.argv.includes(`--${n}`)
const IN = arg('in', 'data/burst-samples.jsonl')
const OUT = arg('out', 'data/burst-model.json')
const LABELS = ['happy', 'sad']
const KEYS = (arg('keys','pitchRange,zcr,energyVar,energyDb')).split(',').map(s=>s.trim()).filter(Boolean)
// 基线口径：speaker=每人自己的 Neutral 中位数（离线最准）
//           global =全体中位数（线上不需要该人发声样本，训练/推理一致）
const BASE_MODE = arg('baseline', 'speaker')

const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse)
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// 每人基线：用本人 Neutral 类（≥3 条）中位数，否则用本人全部
const bySpk = {}
for (const r of rows) (bySpk[r.speaker] ||= []).push(r)
const base = {}
for (const [spk, rs] of Object.entries(bySpk)) {
  const neu = rs.filter((r) => r.emotion === 'neutral')
  const src = neu.length >= 3 ? neu : rs
  const f = (k) => med(src.map((r) => r.features[k] ?? 0))
  base[spk] = { pitchRange: f('pitchRange'), zcr: f('zcr'), energyCV: f('energyCV'), energyDb: f('energyDb') }
}

let baseMedians = null
if (BASE_MODE === 'global') {
  const all = rows.map((r) => r.features)
  const g = (k) => med(all.map((f) => f[k] ?? 0))
  const gb = { pitchRange: g('pitchRange'), zcr: g('zcr'), energyCV: g('energyCV'), energyDb: g('energyDb') }
  baseMedians = gb
  for (const spk of Object.keys(base)) base[spk] = gb
}

const relOf = (r) => {
  const f = r.features, b = base[r.speaker]
  if (BASE_MODE === 'none') {
    // 不用说话人基线：只用"这一段声音自己"的形状（跨人最稳，但丢了个体差异）
    return {
      pitchRange: f.pitchRange,
      zcr: f.zcr,
      energyVar: f.energyCV,
      energyDb: f.energyDb,
      hnr: f.hnr,
      pitchSlope: f.pitchSlope,
      tailTrend: f.tailTrend,
      peakRate: f.peakRate,
    }
  }
  return {
    pitchRange: f.pitchRange / Math.max(0.1, b.pitchRange),
    zcr: f.zcr / Math.max(1, b.zcr),
    energyVar: f.energyCV / Math.max(0.01, b.energyCV),
    energyDb: f.energyDb - b.energyDb,
    hnr: (f.hnr ?? 0) - (b.hnr ?? 0),
    pitchSlope: (f.pitchSlope ?? 0) - (b.pitchSlope ?? 0),
    tailTrend: (f.tailTrend ?? 0) - (b.tailTrend ?? 0),
    peakRate: (f.peakRate ?? 0) / Math.max(0.5, b.peakRate ?? 4),
  }
}

const data = rows.filter((r) => LABELS.includes(r.emotion)).map((r) => ({ spk: r.speaker, y: r.emotion, x: relOf(r) }))
const speakers = [...new Set(data.map((d) => d.spk))]
const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)

function train(rowsIn) {
  const mu = {}, sd = {}
  for (const k of KEYS) {
    const xs = rowsIn.map((d) => d.x[k])
    mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
    sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1
  }
  const zv = (x) => KEYS.map((k) => (x[k] - mu[k]) / sd[k])
  const centers = {}, radii = {}
  for (const y of LABELS) {
    const vs = rowsIn.filter((d) => d.y === y).map((d) => zv(d.x))
    const c = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
    centers[y] = c
    const ds = vs.map((v) => Math.sqrt(d2(v, c))).sort((a, b) => a - b)
    radii[y] = Number(ds[Math.floor(ds.length * 0.9)].toFixed(3))
  }
  return { mu, sd, centers, radii }
}

// 留一人交叉验证
let loo = null
if (has('loo')) {
  let ok = 0, n = 0
  const conf = {}
  for (const spk of speakers) {
    const tr = data.filter((d) => d.spk !== spk), te = data.filter((d) => d.spk === spk)
    if (!tr.length || !te.length) continue
    const m = train(tr)
    const zv = (x) => KEYS.map((k) => (x[k] - m.mu[k]) / m.sd[k])
    for (const d of te) {
      const z = zv(d.x)
      let pred = null, best = Infinity
      for (const y of LABELS) { const dd = d2(z, m.centers[y]); if (dd < best) { best = dd; pred = y } }
      conf[d.y] ||= {}; conf[d.y][pred] = (conf[d.y][pred] || 0) + 1
      if (pred === d.y) ok++
      n++
    }
  }
  const by = {}
  for (const y of LABELS) { const tot = Object.values(conf[y] || {}).reduce((a, b) => a + b, 0); by[y] = tot ? Number(((conf[y][y] || 0) / tot).toFixed(3)) : 0 }
  loo = { acc: Number((ok / n).toFixed(3)), by, n }
}

const model = {
  version: `burst-${new Date().toISOString().slice(0, 10)}`,
  source: 'EmoGator (CC BY 4.0)',
  domain: 'vocal-burst',
  labels: LABELS,
  keys: KEYS,
  n: data.length,
  speakers: speakers.length,
  base: BASE_MODE === 'global' ? 'global median of all bursts' : 'per-speaker median of Neutral bursts',
  baseMedians,
  ...train(data),
  loo,
}
writeFileSync(OUT, JSON.stringify(model, null, 2), 'utf8')
console.log(JSON.stringify({ ok: true, out: OUT, labels: LABELS, keys: KEYS, n: data.length, speakers: speakers.length, radii: model.radii, loo }, null, 2))

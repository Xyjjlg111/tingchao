// 用线上真正的判定逻辑（距离闸 + margin<0.18），在给定数据上摸底：
//   - 每个类被判成什么的分布（recall）
//   - 有多少条会真的写出"语气:"（= 判成非 neutral 且过了闸）
//   - 写出标签的那些里，有多少是对的（precision）
//
// 用法:
//   node probe-model.mjs --model data/model.json --data data/emotiontalk-clean.jsonl
//   node probe-model.mjs --model data/model.json --data data/observations.jsonl
import { readFileSync } from 'node:fs'
import { classifyByCentroid, loadModel } from './lib/centroid.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const MODEL = arg('model', 'data/model.json')
const DATA = arg('data', 'data/observations.jsonl')

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const model = loadModel(JSON.parse(readFileSync(MODEL, 'utf8')))
if (!model) { console.error('model not found'); process.exit(1) }

const rows = readFileSync(DATA, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => Number.isFinite(r.features?.rate) && Number.isFinite(r.features?.pitchIQR))

// 每人基线：有 neutral 就用 neutral 中位数，否则用全部
const by = {}
for (const r of rows) (by[r.speaker ?? r.spk ?? 'unknown'] ||= []).push(r)
const base = {}
for (const [spk, rs] of Object.entries(by)) {
  const neu = rs.filter((r) => r.emotion === 'neutral')
  const src = neu.length >= 3 ? neu : rs
  const f = (k) => med(src.map((r) => r.features[k] ?? 0))
  base[spk] = {
    rate: f('rate'), pitchIQR: f('pitchIQR'), pauseRatio: f('pauseRatio'), energyCV: f('energyCV'),
    energyDb: f('energyDb'), zcr: f('zcr'), pitchSlope: f('pitchSlope'), tailTrend: f('tailTrend'),
    peakRate: f('peakRate'), hnr: f('hnr'),
  }
}
const relOf = (f, b) => ({
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
})

const conf = {}
let labelRate = 0, correctLabeled = 0, labeled = 0
const preds = {}
for (const r of rows) {
  const b = base[r.speaker ?? r.spk ?? 'unknown']
  const rel = relOf(r.features, b)
  const c = classifyByCentroid(rel, model)
  const pred = c?.ok ? c.label : 'neutral'
  preds[pred] = (preds[pred] || 0) + 1
  if (r.emotion) { conf[r.emotion] ||= {}; conf[r.emotion][pred] = (conf[r.emotion][pred] || 0) + 1 }
  if (pred !== 'neutral') { labeled++; if (r.emotion && pred === r.emotion) correctLabeled++ }
}
labelRate = labeled / rows.length

const byRecall = {}
for (const [y, m] of Object.entries(conf)) {
  const tot = Object.values(m).reduce((a, b) => a + b, 0)
  byRecall[y] = { recall: Number(((m[y] || 0) / tot).toFixed(3)), n: tot, dist: m }
}

console.log(JSON.stringify({
  ok: true, model: MODEL, data: DATA, clips: rows.length,
  keys: model.keys, radius: model.radius,
  preds,
  labelRate: Number(labelRate.toFixed(3)),
  precisionWhenLabeled: labeled ? Number((correctLabeled / labeled).toFixed(3)) : null,
  byRecall,
}, null, 2))

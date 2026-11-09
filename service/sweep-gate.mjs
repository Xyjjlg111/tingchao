// 阈值扫描：在同一批数据上，看"领先幅度阈值 margin"和"半径缩放 rScale"怎么影响
//   coverage（会写出"语气:"的比例）与 precision（写出来的里面有多少是对的）
// 目的：把闸门收紧到"宁可不说，也不说错"。
//
// 用法: node sweep-gate.mjs --model data/model.json --data data/emotiontalk-clean.jsonl
import { readFileSync } from 'node:fs'
import { classifyByCentroid, loadModel } from './lib/centroid.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const MODEL = arg('model', 'data/model.json')
const DATA = arg('data', 'data/emotiontalk-clean.jsonl')

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const base = loadModel(JSON.parse(readFileSync(MODEL, 'utf8')))
if (!base) { console.error('model not found'); process.exit(1) }

const rows = readFileSync(DATA, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => Number.isFinite(r.features?.rate) && Number.isFinite(r.features?.pitchIQR) && r.emotion)
const by = {}
for (const r of rows) (by[r.speaker] ||= []).push(r)
const bl = {}
for (const [spk, rs] of Object.entries(by)) {
  const neu = rs.filter((r) => r.emotion === 'neutral')
  const src = neu.length >= 3 ? neu : rs
  const f = (k) => med(src.map((r) => r.features[k] ?? 0))
  bl[spk] = {
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

const rows2 = rows.map((r) => ({ y: r.emotion, rel: relOf(r.features, bl[r.speaker]) }))
const out = []
for (const mm of [0.18, 0.25, 0.30, 0.35, 0.40, 0.45]) {
  for (const rs of [1.0, 0.85, 0.7]) {
    const model = {
      ...base,
      minMargin: mm,
      radius: Object.fromEntries(Object.entries(base.radius).map(([k, v]) => [k, v * rs])),
    }
    let labeled = 0, correct = 0
    const dist = {}
    for (const r of rows2) {
      const c = classifyByCentroid(r.rel, model)
      const pred = c?.ok ? c.label : 'neutral'
      if (pred !== 'neutral') {
        labeled++
        if (pred === r.y) correct++
        dist[r.y] ||= {}; dist[r.y][pred] = (dist[r.y][pred] || 0) + 1
      }
    }
    out.push({
      minMargin: mm, rScale: rs,
      coverage: Number((labeled / rows2.length).toFixed(3)),
      precision: labeled ? Number((correct / labeled).toFixed(3)) : null,
      n: labeled,
    })
  }
}
console.log(JSON.stringify({ ok: true, clips: rows2.length, sweep: out }, null, 2))

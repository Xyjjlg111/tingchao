// 跨语料库评估：用 A 库训练、在 B 库上测（检验"换一批人/换一种录音条件"会不会崩）
//
// 用法:
//   node eval-cross.mjs --train data/casia-samples-v4.jsonl --test data/emotiontalk-samples.jsonl --labels angry,neutral,sad
//
// 两边各自按"本人 neutral 中位数"归一化；z-score 与质心只用训练集算，
// 再按训练集的 radius 做"太远就不下结论"的闸门（coverage / precision 一起报）。
import { readFileSync } from 'node:fs'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const TRAIN = arg('train', 'data/casia-samples-v4.jsonl')
const TEST = arg('test', 'data/emotiontalk-samples.jsonl')
const LABELS = (arg('labels', 'angry,neutral,sad')).split(',').map((s) => s.trim()).filter(Boolean)
const KEYS = (arg('keys', 'rate,energyDb,zcr')).split(',').map((s) => s.trim()).filter(Boolean)

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const load = (p) => readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => Number.isFinite(r.features?.rate) && Number.isFinite(r.features?.pitchIQR))

function baselines(rows) {
  const by = {}
  for (const r of rows) (by[r.speaker] ||= []).push(r)
  const out = {}
  for (const [spk, rs] of Object.entries(by)) {
    const neu = rs.filter((r) => r.emotion === 'neutral')
    const src = neu.length >= 3 ? neu : rs
    const f = (k) => med(src.map((r) => r.features[k] ?? 0))
    out[spk] = {
      rate: f('rate'), pitchIQR: f('pitchIQR'), pauseRatio: f('pauseRatio'), energyCV: f('energyCV'),
      energyDb: f('energyDb'), zcr: f('zcr'), pitchSlope: f('pitchSlope'), tailTrend: f('tailTrend'),
      peakRate: f('peakRate'), hnr: f('hnr'),
    }
  }
  return out
}

const relOf = (r, b) => {
  const f = r.features
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

const trainRows = load(TRAIN).filter((r) => LABELS.includes(r.emotion))
const testRows = load(TEST).filter((r) => LABELS.includes(r.emotion))
const bTrain = baselines(trainRows)
const bTest = baselines(testRows)

const trainX = trainRows.map((r) => ({ spk: r.speaker, y: r.emotion, x: relOf(r, bTrain[r.speaker]) }))
const testX = testRows.map((r) => ({ spk: r.speaker, y: r.emotion, x: relOf(r, bTest[r.speaker]) }))

const mu = {}, sd = {}
for (const k of KEYS) {
  const xs = trainX.map((d) => d.x[k])
  mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
  sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1
}
const zv = (x) => KEYS.map((k) => (x[k] - mu[k]) / sd[k])
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))

const cen = {}, radius = {}
for (const y of LABELS) {
  const vs = trainX.filter((d) => d.y === y).map((d) => zv(d.x))
  cen[y] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
  const ds = vs.map((v) => dist(v, cen[y])).sort((a, b) => a - b)
  radius[y] = ds[Math.floor(ds.length * 0.9)]
}

const conf = {}
let okAll = 0, nAll = 0, okIn = 0, nIn = 0, unknown = 0
const confIn = {}
for (const d of testX) {
  const z = zv(d.x)
  let pred = null, best = Infinity
  for (const y of LABELS) { const dd = dist(z, cen[y]); if (dd < best) { best = dd; pred = y } }
  conf[d.y] ||= {}; conf[d.y][pred] = (conf[d.y][pred] || 0) + 1
  if (pred === d.y) okAll++
  nAll++
  if (best <= radius[pred]) {
    nIn++
    if (pred === d.y) okIn++
    confIn[d.y] ||= {}; confIn[d.y][pred] = (confIn[d.y][pred] || 0) + 1
  } else unknown++
}

const byOf = (c) => {
  const out = {}
  for (const y of LABELS) {
    const tot = Object.values(c[y] || {}).reduce((a, b) => a + b, 0)
    out[y] = tot ? Number(((c[y][y] || 0) / tot).toFixed(3)) : 0
  }
  return out
}

console.log(JSON.stringify({
  ok: true,
  train: TRAIN, test: TEST, labels: LABELS, keys: KEYS,
  trainClips: trainRows.length, testClips: testRows.length,
  testSpeakers: new Set(testX.map((d) => d.spk)).size,
  radius: Object.fromEntries(Object.entries(radius).map(([k, v]) => [k, Number(v.toFixed(2))])),
  accAll: Number((okAll / nAll).toFixed(3)),
  byAll: byOf(conf),
  coverage: Number((nIn / nAll).toFixed(3)),
  accInRadius: nIn ? Number((okIn / nIn).toFixed(3)) : 0,
  byInRadius: byOf(confIn),
  neutralFallback: unknown,
}, null, 2))

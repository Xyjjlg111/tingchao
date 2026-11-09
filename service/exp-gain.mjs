// 增益漂移实验：同一模型，把测试集整段 energyDb 平移（模拟手机挪远/换房间），看准确率掉多少
// 用法：node exp-gain.mjs --in data/esd-samples.jsonl --keys rate,energyDb,zcr --labels angry,neutral,sad
import { readFileSync } from 'node:fs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const IN = arg('in', 'F:/dsh-ears-svc/data/esd-samples.jsonl')
const LABELS = (arg('labels', 'angry,neutral,sad')).split(',').map((s) => s.trim()).filter(Boolean)
const KEYS = (arg('keys', 'rate,energyDb,zcr')).split(',').map((s) => s.trim()).filter(Boolean)
const MULTS = (arg('mults', '0,-6,-12,6,12')).split(',').map(Number)

const rows = readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => LABELS.includes(r.emotion))
const bySpk = new Map()
for (const r of rows) {
  if (!bySpk.has(r.speaker)) bySpk.set(r.speaker, [])
  bySpk.get(r.speaker).push(r)
}
const speakers = [...bySpk.keys()]

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const val = (f, k) => {
  if (k === 'pause') return Number(f.pauseRatio ?? f.pause ?? 0)
  if (k === 'pitchVar') return Number(f.pitchIQR ?? f.pitchVar ?? 0)
  if (k === 'energyVar') return Number(f.energyCV ?? f.energyVar ?? 0)
  return Number(f[k] ?? 0)
}

// 每人的基线：用该人 neutral 的中位数
function baselineOf(list) {
  const neu = list.filter((r) => r.emotion === 'neutral')
  const src = neu.length ? neu : list
  const b = {}
  for (const k of KEYS) b[k] = median(src.map((r) => val(r.features, k)))
  return b
}
function relOf(f, b, shiftDb) {
  const o = {}
  for (const k of KEYS) {
    const v = val(f, k)
    if (k === 'energyDb') o[k] = v + shiftDb - b[k]
    else if (k === 'pitchSlope' || k === 'tailTrend' || k === 'hnr') o[k] = v - b[k]
    else o[k] = b[k] ? v / b[k] : 1
  }
  return o
}

// 每个 delta：训练用原始，测试把该人的 energyDb 整体平移 delta（含基线同步平移 → 相当于录音设备变化）
function run(delta) {
  let ok = 0, n = 0
  const by = {}
  for (const spk of speakers) {
    const train = []
    for (const [s, list] of bySpk) if (s !== spk) train.push(...list.map((r) => ({ emotion: r.emotion, x: relOf(r.features, baselineOf(bySpk.get(s)), 0) })))
    // 每类质心 + sd
    const cls = {}
    for (const t of train) {
      cls[t.emotion] ||= { n: 0, sum: {}, sum2: {} }
      const c = cls[t.emotion]; c.n++
      for (const k of KEYS) { c.sum[k] = (c.sum[k] || 0) + t.x[k]; c.sum2[k] = (c.sum2[k] || 0) + t.x[k] * t.x[k] }
    }
    const centers = {}
    for (const [lab, c] of Object.entries(cls)) {
      centers[lab] = { mu: {}, sd: {} }
      for (const k of KEYS) { const m = c.sum[k] / c.n; centers[lab].mu[k] = m; centers[lab].sd[k] = Math.sqrt(Math.max(1e-6, c.sum2[k] / c.n - m * m)) }
    }
    const test = bySpk.get(spk)
    const b = baselineOf(test)
    for (const r of test) {
      const x = relOf(r.features, b, delta)
      let best = null, bd = Infinity
      for (const [lab, c] of Object.entries(centers)) {
        let d = 0
        for (const k of KEYS) { const z = (x[k] - c.mu[k]) / (c.sd[k] || 1); d += z * z }
        if (d < bd) { bd = d; best = lab }
      }
      n++
      by[r.emotion] ||= { hit: 0, tot: 0 }
      by[r.emotion].tot++
      if (best === r.emotion) { ok++; by[r.emotion].hit++ }
    }
  }
  return { acc: ok / n, by }
}

console.log(`keys = ${KEYS.join(',')} | labels = ${LABELS.join(',')}`)
for (const d of MULTS) {
  const r = run(d)
  const detail = Object.entries(r.by).map(([k, v]) => `${k} ${(100 * v.hit / v.tot).toFixed(0)}%`).join(' · ')
  console.log(`  ${d >= 0 ? '+' : ''}${d} dB → acc ${(r.acc * 100).toFixed(1)}%  (${detail})`)
}

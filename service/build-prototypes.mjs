// 把 data/samples.jsonl（带标签的语音样本）聚成「区间原型库」data/prototypes.json
//
// 流程（对应主人定的思路）：
//   1. 每个说话人先算自己的「平常」基线 → 所有样本转成「相对自己」的偏移（换人不失效）
//   2. 按情绪分组，组内聚类 → 每一簇 = 一个「记忆点」（同一情绪的不同样子）
//   3. 每个记忆点：每个因素取 10–90 分位当区间；权重由区间窄+可靠度自动算
//   4. 留一人交叉验证：用 N-1 人建库，猜第 N 人，报每类命中率
//   5. 写 data/prototypes.json（服务重启后自动加载）
//
// 用法:
//   node build-prototypes.mjs                       # 全量
//   node build-prototypes.mjs --min 3 --kmax 4      # 每簇至少 3 条、每情绪最多 4 个记忆点
//   node build-prototypes.mjs --loo                 # 额外跑留一人验证
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyByPrototypes, weightsOf, intensityOf, FACTORS } from './lib/prototypes.mjs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const arg = (n, d = '') => {
  const i = process.argv.indexOf(`--${n}`)
  if (i < 0) return d
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}
const IN = arg('in', join(ROOT, 'data', 'samples.jsonl'))
const OUT = arg('out', join(ROOT, 'data', 'prototypes.json'))
const MIN = Number(arg('min', '3'))
const KMAX = Number(arg('kmax', '4'))
const DO_LOO = process.argv.includes('--loo')

if (!existsSync(IN)) {
  console.error('missing samples:', IN, '（先跑 ingest-corpus.mjs）')
  process.exit(1)
}

const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const med = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (xs, q) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

const RAW = { rate: (f) => f.rate, pitchVar: (f) => f.pitchIQR, pause: (f) => f.pauseRatio, energyVar: (f) => f.energyCV, energyDb: (f) => f.energyDb, zcr: (f) => f.zcr, pitchSlope: (f) => f.pitchSlope ?? 0, tailTrend: (f) => f.tailTrend ?? 0, peakRate: (f) => f.peakRate ?? 0, hnr: (f) => f.hnr ?? 0 }

// 每人基线：优先「neutral」样本的中位数，没有就用他全部样本的中位数
function baselinesOf(list) {
  const by = {}
  for (const r of list) (by[r.speaker] ||= []).push(r)
  const out = {}
  for (const [spk, rs] of Object.entries(by)) {
    const neu = rs.filter((r) => r.emotion === 'neutral')
    const src = neu.length >= 3 ? neu : rs
    out[spk] = {}
    for (const [k, get] of Object.entries(RAW)) out[spk][k] = med(src.map((r) => get(r.features))) || 1e-6
  }
  return out
}

function relOf(r, base) {
  const f = r.features
  const b = base[r.speaker]
  const out = {}
  out.rate = Number((f.rate / Math.max(0.2, b.rate)).toFixed(3))
  out.pitchVar = Number((f.pitchIQR / Math.max(0.35, b.pitchVar)).toFixed(3))
  out.pause = Number((f.pauseRatio / Math.max(0.01, b.pause)).toFixed(3))
  out.energyVar = Number((f.energyCV / Math.max(0.03, b.energyVar)).toFixed(3))
  out.energyDb = Number((f.energyDb - b.energyDb).toFixed(2))
  out.zcr = Number((f.zcr / Math.max(1, b.zcr)).toFixed(3))
  // 走向/嗓音：相对本人习惯的"差"，不是比值（0 表示和平时一样）
  out.pitchSlope = Number(((f.pitchSlope ?? 0) - (b.pitchSlope ?? 0)).toFixed(2))
  out.tailTrend = Number(((f.tailTrend ?? 0) - (b.tailTrend ?? 0)).toFixed(2))
  out.hnr = Number(((f.hnr ?? 0) - (b.hnr ?? 0)).toFixed(2))
  out.peakRate = Number(((f.peakRate ?? 0) / Math.max(0.5, b.rate)).toFixed(3))
  return out
}

function kmeans(vecs, k, iters = 25) {
  const dim = vecs[0].length
  const centers = []
  for (let i = 0; i < k; i++) centers.push([...vecs[Math.floor((i * vecs.length) / k)]])
  const assign = new Array(vecs.length).fill(0)
  for (let it = 0; it < iters; it++) {
    let moved = false
    for (let i = 0; i < vecs.length; i++) {
      let best = 0, bd = Infinity
      for (let c = 0; c < k; c++) {
        let d = 0
        for (let j = 0; j < dim; j++) d += (vecs[i][j] - centers[c][j]) ** 2
        if (d < bd) { bd = d; best = c }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true }
    }
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0))
    const cnt = new Array(k).fill(0)
    for (let i = 0; i < vecs.length; i++) {
      cnt[assign[i]]++
      for (let j = 0; j < dim; j++) sums[assign[i]][j] += vecs[i][j]
    }
    for (let c = 0; c < k; c++) if (cnt[c]) centers[c] = sums[c].map((v) => v / cnt[c])
    if (!moved) break
  }
  return assign
}

// 用简单轮廓系数挑 k：同簇距离 vs 最近异簇距离
function silh(vecs, assign, k) {
  if (k < 2) return -1
  let total = 0, n = 0
  for (let i = 0; i < vecs.length; i++) {
    const own = vecs.filter((_, j) => assign[j] === assign[i] && j !== i)
    if (!own.length) continue
    const a = own.reduce((s, v) => s + dist(vecs[i], v), 0) / own.length
    let b = Infinity
    for (let c = 0; c < k; c++) {
      if (c === assign[i]) continue
      const other = vecs.filter((_, j) => assign[j] === c)
      if (!other.length) continue
      b = Math.min(b, other.reduce((s, v) => s + dist(vecs[i], v), 0) / other.length)
    }
    if (!Number.isFinite(b)) continue
    total += (b - a) / Math.max(a, b); n++
  }
  return n ? total / n : -1
}
const dist = (x, y) => Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0))

function build(list) {
  const base = baselinesOf(list)
  const rels = list.map((r) => ({ emotion: r.emotion, speaker: r.speaker, rel: relOf(r, base) }))
  const byEmo = {}
  for (const r of rels) (byEmo[r.emotion] ||= []).push(r)

  const prototypes = []
  for (const [emo, rs] of Object.entries(byEmo)) {
    if (rs.length < MIN) continue
    const keys = Object.keys(FACTORS).filter((k) => k in rs[0].rel)
    const vecs = rs.map((r) => keys.map((k) => r.rel[k]))
    const mu = keys.map((_, j) => vecs.reduce((s, v) => s + v[j], 0) / vecs.length)
    const sd = keys.map((_, j) => Math.sqrt(vecs.reduce((s, v) => s + (v[j] - mu[j]) ** 2, 0) / vecs.length) || 1)
    const z = vecs.map((v) => v.map((x, j) => (x - mu[j]) / sd[j]))

    let best = { k: 1, assign: new Array(rs.length).fill(0), score: -1 }
    for (let k = 2; k <= Math.min(KMAX, Math.floor(rs.length / MIN)); k++) {
      const assign = kmeans(z, k)
      const counts = new Array(k).fill(0)
      for (const a of assign) counts[a]++
      if (counts.some((c) => c < MIN)) continue
      const s = silh(z, assign, k)
      if (s > best.score) best = { k, assign, score: s }
    }

    if (best.k === 1) {
      prototypes.push(makeProto(emo, '', rs, keys))
    } else {
      for (let c = 0; c < best.k; c++) {
        const sub = rs.filter((_, i) => best.assign[i] === c)
        if (sub.length >= MIN) prototypes.push(makeProto(emo, String(c + 1), sub, keys))
      }
    }
  }

  // 同情绪多簇时，用区间中点给个可读风格名
  const byId = {}
  for (const p of prototypes) (byId[p.emotion] ||= []).push(p)
  for (const [emo, ps] of Object.entries(byId)) {
    if (ps.length < 2) { ps[0].style = styleName(ps[0], 'single'); continue }
    const rateMid = ps.map((p) => (p.ranges.rate[0] + p.ranges.rate[1]) / 2)
    const order = ps.map((p, i) => i).sort((a, b) => rateMid[a] - rateMid[b])
    order.forEach((idx, rank) => {
      ps[idx].style = styleName(ps[idx], rank === 0 ? 'slow' : rank === order.length - 1 ? 'fast' : `s${rank + 1}`)
    })
  }
  return { prototypes, base }
}

function styleName(p, kind) {
  const rate = (p.ranges.rate[0] + p.ranges.rate[1]) / 2
  if (kind === 'slow') return rate < 0.95 ? '压低慢' : '缓'
  if (kind === 'fast') return rate > 1.08 ? '急冲' : '快'
  return rate < 0.95 ? '沉' : rate > 1.08 ? '冲' : '中'
}

function makeProto(emo, tag, sub, keys) {
  const ranges = {}
  for (const k of keys) {
    const xs = sub.map((r) => r.rel[k])
    let lo = Number(pct(xs, 0.1).toFixed(2))
    let hi = Number(pct(xs, 0.9).toFixed(2))
    if (!(hi > lo)) { const d = Math.max(0.08, Math.abs(lo) * 0.12); lo -= d; hi += d }
    ranges[k] = [Number(lo.toFixed(2)), Number(hi.toFixed(2))]
  }
  const p = { id: `${emo}${tag ? '-' + tag : ''}`, emotion: emo, cn: emo, style: '', ranges, note: `${emo}${tag ? ' 第' + tag + '簇' : ''}` }
  p.weights = weightsOf(p)
  const ints = sub.map((r) => intensityOf(r.rel, p.weights))
  p.intensity = [Math.round(med(ints)), Math.round(Math.max(...ints))]
  p.n = sub.length
  p.source = 'corpus'
  return p
}

// 留一人交叉验证
function loo(list) {
  const speakers = [...new Set(list.map((r) => r.speaker))]
  if (speakers.length < 3) return { skipped: 'need >=3 speakers' }
  const per = {}
  let hit = 0, total = 0
  for (const spk of speakers) {
    const train = list.filter((r) => r.speaker !== spk)
    const test = list.filter((r) => r.speaker === spk)
    const { prototypes } = build(train)
    const base = baselinesOf(train)
    const spkBase = baselinesOf(list)[spk]
    for (const r of test) {
      const rel = relOf({ ...r, features: r.features }, { ...base, [spk]: spkBase })
      const res = classifyByPrototypes(rel, prototypes)
      const ok = res.ok && res.label === r.emotion
      total++
      if (ok) hit++
      per[r.emotion] ||= { hit: 0, total: 0 }
      per[r.emotion].total++
      if (ok) per[r.emotion].hit++
    }
  }
  const acc = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Number((v.hit / v.total).toFixed(2))]))
  return { overall: Number((hit / total).toFixed(3)), byEmotion: acc, n: total }
}

const result = build(rows)
const out = {
  version: `0.3-corpus-${new Date().toISOString().slice(0, 10)}`,
  builtAt: new Date().toISOString(),
  source: 'corpus',
  clips: rows.length,
  speakers: new Set(rows.map((r) => r.speaker)).size,
  prototypes: result.prototypes,
}
if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ ok: true, out: OUT, prototypes: out.prototypes.length, clips: out.clips, speakers: out.speakers, perEmotion: out.prototypes.reduce((m, p) => ((m[p.emotion] = (m[p.emotion] || 0) + 1), m), {}) }, null, 2))
if (DO_LOO) console.log('LOO:', JSON.stringify(loo(rows), null, 2))

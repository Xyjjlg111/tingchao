// 区间原型 + 加权隶属度投票（v0.3）
//
// 思路（主人定的）：
//   每种情绪不是一个"中心点"，而是若干"记忆点"（style）；
//   每个记忆点用「每个因素一个区间」描述，例如"压低冷怒 = 音高比平时低 0.3–2.5 个半音、语速 0.70–0.95 倍…"；
//   判定时逐因素算隶属度（在区间内=1，出界按边缘带线性衰减，出太远=0），再按权重投票；
//   大部分因素吻合就判这个记忆点——个别出入不影响；
//   强度是"离他本人常态多远"，输出成区间（轻/有点/明显/很强），不给假精确的单值。
//
// 关键约束（写死在实现里）：
//   1) 所有因素都是「相对他本人基线」的比值/差（tailDrop 是半音差），不是绝对 Hz/dB；
//   2) 权重由每个因素区间的"窄"程度 + 可靠度自动算，窄 = 更有区分度；
//   3) 票数不够（<0.55）或"什么都没发生"（命中 neutral）就不说话；
//   4) 永远只输出「听起来像」，不输出「他是/他一定」。
//
// PRIOR 是"教科书先验版"：没有真人语料时也能跑；
// 收到语料后由 ingest-corpus.mjs + build-prototypes.mjs 生成 data/prototypes.json 覆盖。

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, n = 2) => Number(Number(v).toFixed(n))

// 因素：中性值 + 偏离尺度（算强度用）+ 可靠度（人为先验，越低越可能是环境噪声）
export const FACTORS = {
  rate: { neutral: 1, scale: 0.18, trust: 1.0, cn: '语速' },
  pitchVar: { neutral: 1, scale: 0.25, trust: 0.9, cn: '音高起伏' },
  pause: { neutral: 1, scale: 0.4, trust: 0.55, cn: '停顿' },
  energyVar: { neutral: 1, scale: 0.25, trust: 0.8, cn: '音量起伏' },
  energyDb: { neutral: 0, scale: 5, trust: 0.75, cn: '音量' },
  zcr: { neutral: 1, scale: 0.12, trust: 0.5, cn: '音色' },
  tailDrop: { neutral: 0, scale: 2.0, trust: 0.85, cn: '句尾' },
  // v0.4：走向 / 节奏 / 嗓音。前三个是「往上还是往下」，这是七维看不到的。
  pitchSlope: { neutral: 0, scale: 6, trust: 0.7, cn: '音高走向' },
  tailTrend: { neutral: 0, scale: 6, trust: 0.65, cn: '句尾走向' },
  peakRate: { neutral: 1, scale: 0.25, trust: 0.6, cn: '音节节奏' },
  hnr: { neutral: 0, scale: 8, trust: 0.45, cn: '嗓音' },
}

function marginOf(lo, hi) {
  const w = Math.max(1e-6, hi - lo)
  return Math.max(0.06, w * 0.2)
}

// 1 = 完全在区间里；出界按边缘带线性衰减到 0
export function membership(value, lo, hi) {
  const v = Number(value)
  if (!Number.isFinite(v)) return 0
  if (v >= lo && v <= hi) return 1
  const m = marginOf(lo, hi)
  const d = v < lo ? lo - v : v - hi
  if (d >= m) return 0
  return round(1 - d / m, 3)
}

function normWidth(key, lo, hi) {
  const f = FACTORS[key]
  const w = Math.abs(hi - lo) / (f?.scale || 1)
  return Math.max(0.08, w)
}

// 权重：窄区间 + 可靠度高的因素说话更算数（自动，不用手填）
export function weightsOf(p) {
  const raw = {}
  let max = 0
  for (const [k, rng] of Object.entries(p.ranges || {})) {
    if (!FACTORS[k] || !Array.isArray(rng)) continue
    const w = (FACTORS[k].trust || 0.5) / normWidth(k, rng[0], rng[1])
    raw[k] = w
    if (w > max) max = w
  }
  const out = {}
  for (const [k, w] of Object.entries(raw)) out[k] = round(w / (max || 1), 2)
  return out
}

// ---------- 教科书先验（v0.3-prior） ------------------------------------------
// 单位：rate/pitchVar/pause/energyVar/zcr = 相对本人平时的倍数；
//       energyDb = 相对本人平时的 dB 差；tailDrop = 句尾相对句头下沉的半音数
export const PRIOR_VERSION = '0.3-prior'
const P = (id, emotion, cn, style, ranges, note) => ({ id, emotion, cn, style, ranges, note, source: 'prior' })

export const PRIOR_PROTOTYPES = [
  P('neutral', 'neutral', '平常', '平时', {
    rate: [0.88, 1.12], pitchVar: [0.85, 1.25], pause: [0.8, 1.3], energyVar: [0.85, 1.2], energyDb: [-2.5, 2.5], zcr: [0.95, 1.06], tailDrop: [-1.2, 1.5],
    pitchSlope: [-2.5, 2.5], tailTrend: [-2, 2], peakRate: [0.85, 1.15], hnr: [-4, 4],
  }, '就和平常一样'),
  P('angry-high', 'angry', '火', '高声', {
    rate: [1.12, 1.45], pitchVar: [1.15, 1.75], pause: [0.55, 0.95], energyVar: [1.25, 1.75], energyDb: [3, 10], zcr: [1.05, 1.22], tailDrop: [-2, 2],
    pitchSlope: [0.5, 7], tailTrend: [-2, 4], peakRate: [1.05, 1.4], hnr: [0, 10],
  }, '吼出来的火：快、响、亮'),
  P('angry-low', 'angry', '火', '压低', {
    rate: [0.70, 0.95], pitchVar: [0.95, 1.45], pause: [1.05, 2.00], energyVar: [0.90, 1.25], energyDb: [-8, 1], zcr: [1.02, 1.16], tailDrop: [-1, 2],
    pitchSlope: [-3, 2], tailTrend: [-3, 2], peakRate: [0.7, 1.0], hnr: [-2, 8],
  }, '压着的火：慢、沉、硬'),
  P('sad-wronged', 'sad', '委屈', '忍着', {
    rate: [0.72, 0.95], pitchVar: [0.65, 1.05], pause: [1.15, 2.30], energyVar: [0.80, 1.25], energyDb: [-8, 0], zcr: [0.95, 1.12], tailDrop: [0.6, 4.5],
    pitchSlope: [-6, -0.5], tailTrend: [-6, -0.8], peakRate: [0.7, 1.0], hnr: [-6, 2],
  }, '被误会、憋着的那口气'),
  P('sad-low', 'sad', '低落', '沉下去', {
    rate: [0.60, 0.90], pitchVar: [0.50, 0.92], pause: [1.00, 2.00], energyVar: [0.50, 0.95], energyDb: [-10, -1], zcr: [0.85, 1.05], tailDrop: [1.2, 6],
    pitchSlope: [-7, -1], tailTrend: [-7, -1.5], peakRate: [0.6, 0.95], hnr: [-8, 0],
  }, '没劲、提不起'),
  P('tired', 'tired', '疲惫', '累', {
    rate: [0.62, 0.90], pitchVar: [0.60, 1.10], pause: [1.15, 2.40], energyVar: [0.45, 0.92], energyDb: [-9, -0.5], zcr: [0.88, 1.06], tailDrop: [-1, 1.8],
    pitchSlope: [-5, 0.5], tailTrend: [-5, 1], peakRate: [0.65, 0.95], hnr: [-8, 2],
  }, '加班一天、只想躺下'),
  P('happy', 'happy', '高兴', '轻快', {
    rate: [1.06, 1.30], pitchVar: [1.10, 1.50], pause: [0.72, 1.08], energyVar: [0.95, 1.25], energyDb: [-1, 4], zcr: [0.98, 1.12], tailDrop: [-1, 2],
    pitchSlope: [0.5, 6], tailTrend: [-1, 4], peakRate: [1.05, 1.35], hnr: [-2, 6],
  }, '心情好、话变轻'),
  P('excited', 'excited', '兴奋', '雀跃', {
    rate: [1.25, 1.60], pitchVar: [1.35, 2.10], pause: [0.55, 0.95], energyVar: [1.05, 1.60], energyDb: [1.5, 9], zcr: [1.00, 1.18], tailDrop: [0, 3],
    pitchSlope: [1, 8], tailTrend: [0, 5], peakRate: [1.2, 1.6], hnr: [0, 10],
  }, '憋不住想分享'),
  P('relaxed', 'relaxed', '放松', '松', {
    rate: [0.85, 1.12], pitchVar: [0.50, 0.82], pause: [0.75, 1.30], energyVar: [0.65, 1.00], energyDb: [-4, 0.5], zcr: [0.90, 1.06], tailDrop: [-1, 1],
    pitchSlope: [-2, 1.5], tailTrend: [-1.5, 1.5], peakRate: [0.8, 1.1], hnr: [-3, 4],
  }, '周末下午、什么都不用干'),
].map((p) => ({ ...p, weights: weightsOf(p) }))

// ---------- 判定 ---------------------------------------------------------------
export const BANDS = [
  { id: 'strong', lo: 72, hi: 100, cn: '很强' },
  { id: 'clear', lo: 50, hi: 80, cn: '明显' },
  { id: 'some', lo: 25, hi: 55, cn: '有点' },
  { id: 'slight', lo: 0, hi: 30, cn: '轻' },
]

export function bandOf(intensity) {
  const hits = BANDS.filter((b) => intensity >= b.lo && intensity <= b.hi)
  const pick = hits.length
    ? hits.sort((a, c) => Math.abs((a.lo + a.hi) / 2 - intensity) - Math.abs((c.lo + c.hi) / 2 - intensity))[0]
    : { id: 'slight', lo: 0, hi: 30, cn: '轻' }
  // 2026-11-08 修：只返回 {cn} 时，桥接侧读的是 band.text，会渲染成「语气:疲惫undefined」。
  // 保留 cn（旧调用方在用），同时补 text 作为别名。
  return { ...pick, text: pick.cn }
}

export function intensityOf(rel, weights) {
  let sum = 0
  let wsum = 0
  for (const [k, f] of Object.entries(FACTORS)) {
    const v = Number(rel?.[k])
    if (!Number.isFinite(v)) continue
    const w = Number(weights?.[k] ?? f.trust)
    const dev = Math.abs(v - f.neutral) / f.scale
    sum += Math.min(2.5, dev) * w
    wsum += w
  }
  if (!wsum) return 0
  return clamp(Math.round((sum / wsum) * 100), 0, 100)
}

// 前置门槛：某些情绪必须先有"发声上的激活/松垮"才算数，
// 否则一句语速稍慢的平常话会被判成"压低冷怒"（真实语音里最容易出的假阳性）。
const GUARDS = {
  angry: (r) => Number(r.zcr) >= 1.04 && (Number(r.energyVar) >= 1.08 || Number(r.energyDb) >= 1.5 || Number(r.rate) >= 1.10),
  happy: (r) => Number(r.pitchVar) >= 1.05,
  excited: (r) => Number(r.pitchVar) >= 1.30,
  tired: (r) => Number(r.rate) <= 0.94 && Number(r.pause) >= 1.05,
  sad: (r) => Number(r.tailDrop) >= 0.5,
  relaxed: (r) => Number(r.pitchVar) <= 0.95,
  neutral: () => true,
}

export function scorePrototype(rel, p) {
  const weights = p.weights || weightsOf(p)
  let sum = 0
  let wsum = 0
  const hit = []
  const miss = []
  for (const [k, rng] of Object.entries(p.ranges || {})) {
    if (!FACTORS[k] || !Array.isArray(rng)) continue
    const w = Number(weights[k] ?? 0.5)
    const m = membership(rel?.[k], rng[0], rng[1])
    sum += w * m
    wsum += w
    if (m >= 0.6) hit.push(k)
    else if (m <= 0.2) miss.push(k)
  }
  let score = wsum ? sum / wsum : 0
  const bonus = hit.length >= 5 ? 0.04 : hit.length >= 3 ? 0.02 : 0
  // 分数打平时，比"离区间中点多远"——更靠中间的那个更像
  let cd = 0
  let cdw = 0
  for (const [k, rng] of Object.entries(p.ranges || {})) {
    if (!FACTORS[k] || !Array.isArray(rng)) continue
    const v = Number(rel?.[k])
    if (!Number.isFinite(v)) continue
    const w = Number(weights[k] ?? 0.5)
    const mid = (rng[0] + rng[1]) / 2
    const half = Math.max(0.08, (rng[1] - rng[0]) / 2)
    cd += (Math.abs(v - mid) / half) * w
    cdw += w
  }
  return { score: round(Math.min(1, score + bonus), 3), hit, miss, centerDist: cdw ? round(cd / cdw, 3) : 9 }
}

// 更"具体"的记忆点（区间总宽更小）在分数相同时优先
function specificity(p) {
  let s = 0
  for (const [k, rng] of Object.entries(p.ranges || {})) if (FACTORS[k]) s += normWidth(k, rng[0], rng[1])
  return s
}

export function classifyByPrototypes(rel, prototypes = PRIOR_PROTOTYPES, opts = {}) {
  const minScore = Number(opts.minScore ?? 0.55)
  const strongScore = Number(opts.strongScore ?? 0.72)
  const marginMin = Number(opts.marginMin ?? 0.12)
  if (!rel) return { ok: false, rule: 'no_relative', label: 'neutral', confidence: 0.3, scores: {} }

  const scored = prototypes
    .map((p) => {
      const r = scorePrototype(rel, p)
      const guard = GUARDS[p.emotion ?? String(p.id).split('-')[0]]
      const pass = typeof guard === 'function' ? Boolean(guard(rel)) : true
      return { p, score: pass ? r.score : 0, blocked: !pass, hit: r.hit, miss: r.miss, centerDist: r.centerDist, spec: specificity(p) }
    })
    .sort((a, b) => b.score - a.score || a.centerDist - b.centerDist || a.spec - b.spec)

  const top = scored[0]
  const second = scored[1]
  const scores = {}
  for (const s of scored.slice(0, 8)) scores[s.p.id] = s.score

  if (!top || top.score < minScore) {
    return { ok: false, rule: 'weak_vote', label: 'neutral', confidence: round(clamp(0.35 + (top?.score || 0) * 0.2, 0.3, 0.5), 2), scores }
  }
  // 命中"平常"：什么都不发生，交给上层按 neutral 处理（不注入语气）
  if (top.p.id === 'neutral') {
    return { ok: false, rule: 'neutral_vote', label: 'neutral', confidence: round(top.score, 2), scores }
  }

  const margin = round(top.score - (second?.score ?? 0), 3)
  const strong = top.score >= strongScore && margin >= marginMin
  const labels = [{ id: top.p.id, emotion: top.p.emotion, cn: top.p.cn, style: top.p.style, score: top.score }]
  if (!strong && second && second.score >= minScore && second.p.id !== 'neutral' && margin < marginMin) {
    labels.push({ id: second.p.id, emotion: second.p.emotion, cn: second.p.cn, style: second.p.style, score: second.score })
  }

  const intensity = intensityOf(rel, top.p.weights)
  const band = bandOf(intensity)
  const evidence = top.hit.slice(0, 3).map((k) => `${FACTORS[k].cn}${rel[k] < FACTORS[k].neutral ? '降' : '升'}`).join('+')
  const confidence = round(clamp(0.4 + top.score * 0.42 + Math.min(0.12, margin * 0.5) - (strong ? 0 : 0.05), 0.45, 0.9), 2)

  return {
    ok: true,
    rule: 'prototype_vote',
    label: top.p.emotion,
    labelCN: labels.map((l) => l.cn).join('/'),
    style: top.p.style,
    styleNote: top.p.note,
    confidence,
    scores,
    labels,
    intensity,
    band: { id: band.id, cn: band.cn, lo: band.lo, hi: band.hi, text: `${band.lo}–${band.hi}` },
    evidence,
    hit: top.hit,
    miss: top.miss,
    multi: labels.length > 1,
    margin,
  }
}

// 渲染：越短越好（token 就是钱）
export function renderShort(r) {
  if (!r?.ok) return null
  // 两个标签分数几乎并列时不写百分数（省 token，也避免"100/100"这种噪声）
  const showNum = r.labels.length > 1 && r.labels[0].score - r.labels[1].score >= 0.05
  const head = r.labels.map((l) => (showNum ? `${l.cn}${Math.round(l.score * 100)}` : l.cn)).join('/')
  const band = r.band?.text ? ` ${r.band.text}` : ''
  const ev = r.evidence ? `·${r.evidence}` : ''
  return { labelCN: `${head}${band}`, reason: `${r.style || ''}${ev}` }
}

export function loadPrototypes(json) {
  const list = json?.prototypes
  if (!Array.isArray(list) || list.length < 1) return null
  return list.map((p) => ({ ...p, weights: p.weights || weightsOf(p) }))
}

export { marginOf, normWidth, clamp }

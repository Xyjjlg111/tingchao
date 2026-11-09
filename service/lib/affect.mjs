// 语气判定 v0.4 —— 相对「这个人自己平时的说话」来判断，而不是用全人类统一阈值。
//
// 为什么：同一个人「累」的时候，别人可能觉得正好；不同人音高、语速、口音差得多，
// 绝对阈值一定误判（实测：主人一条明显疲惫的 5 秒语音被判成 neutral 0.3）。
//
// 两套打分，按可用数据自动切换：
//   1) 规则版（默认）：拿 features 与 baseline（这个人的中位数特征）做比值，
//      相对变化才是信号；证据不够就返回 neutral（宁可不说话，也不乱贴标签）。
//   2) 校准版（有标注样本后）：线性判别/最近质心，喂 20–40 条带标签样本即可，
//      由 ./calibrate.mjs 生成 data/affect-model.json。
//
// 输出只有「倾向 + 置信度」，永远不是事实；桥接只在 confidence ≥ 0.45 时才写「语气:」。
// 0 token，不联网。

export const LABELS = ['happy', 'excited', 'tired', 'sad', 'relaxed', 'angry', 'neutral']

export const LABEL_CN = {
  happy: '高兴',
  excited: '兴奋',
  tired: '疲惫',
  sad: '低落',
  relaxed: '放松',
  angry: '烦躁',
  neutral: '平常',
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round2 = (v) => Number(Number(v).toFixed(2))

// 默认阈值：全部是「相对 baseline 的倍数」，1.0 = 和平时一样。
// 之所以写成倍数，是为了让同一个规则适用于嗓门大/小、语速快/慢的人。
export const DEFAULT_CONFIG = {
  version: 4,
  minConfidence: 0.45,
  // 需要至少两条独立证据才下结论
  rules: {
    tired: { rateMax: 0.88, pauseMin: 1.22, energyVarMax: 0.92, pitchVarMax: 1.15 },
    happy: { rateMin: 1.10, pitchVarMin: 1.12 },
    excited: { rateMin: 1.25, pitchVarMin: 1.40 },
    sad: { rateMax: 0.96, pitchVarMax: 0.95, tailDropMin: 1.2 },
    relaxed: { rateMin: 0.86, rateMax: 1.14, pitchVarMax: 0.86, pauseMax: 1.25, tailDropMax: 1.0 },
    angry: { energyVarMin: 1.22, pitchVarMin: 1.18, zcrMin: 1.08 },
  },
}

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function buildBaseline(list) {
  const rows = (list || []).filter(Boolean)
  if (rows.length < 3) return null
  const pick = (k) => median(rows.map((r) => Number(r.features?.[k] ?? r[k] ?? 0)))
  return {
    n: rows.length,
    rate: round2(pick('rate')),
    pitchIQR: round2(pick('pitchIQR')),
    pitchHz: Math.round(pick('pitchHz')),
    pauseRatio: Number(pick('pauseRatio').toFixed(3)),
    energyCV: Number(pick('energyCV').toFixed(3)),
    energyDb: Number(pick('energyDb').toFixed(1)),
    zcr: Math.round(pick('zcr')),
    pitchSlope: round2(pick('pitchSlope')),
    tailTrend: round2(pick('tailTrend')),
    peakRate: round2(pick('peakRate')),
    hnr: round2(pick('hnr')),
    updatedAt: new Date().toISOString(),
  }
}

// 人群先验：刚开始只有 3–5 条样本时，单靠它们会「以偏概全」（例如头三条正好是累的），
// 因此样本少于 10 条时，把中位数和这份先验按 n/10 混合，样本越多越信这个人自己。
export const PRIOR = { rate: 4.6, pitchIQR: 2.2, pauseRatio: 0.2, energyCV: 0.32, energyDb: -22, zcr: 1500, pitchSlope: 0, tailTrend: 0, peakRate: 4.6, hnr: 0 }

export function effectiveBaseline(b) {
  if (!b || !b.n) return null
  // n>=3 就完全信这个人自己：PRIOR 的值（rate 4.6 / zcr 1500 / hnr 0）与本机实测
  // 差得太远，n/10 的混合会把「正常说话」推成 too_far（2026-11-08 实测 neutral→tired）。
  const w = Number(b.n) >= 3 ? 1 : Math.min(1, Number(b.n) / 3)
  const mix = (k) => Number(((Number(b[k]) * w) + (PRIOR[k] * (1 - w))).toFixed(3))
  return {
    ...b,
    rate: mix('rate'),
    pitchIQR: mix('pitchIQR'),
    pauseRatio: mix('pauseRatio'),
    energyCV: mix('energyCV'),
    energyDb: mix('energyDb'),
    zcr: Math.round(mix('zcr')),
    pitchSlope: mix('pitchSlope'),
    tailTrend: mix('tailTrend'),
    peakRate: mix('peakRate'),
    hnr: mix('hnr'),
    blended: w < 1,
  }
}

export function relativeOf(f, baseline) {
  const base = effectiveBaseline(baseline)
  if (!base) return null
  return {
    rate: round2(f.rate / Math.max(0.2, base.rate)),
    pitchVar: round2(f.pitchIQR / Math.max(0.35, base.pitchIQR)),
    pause: round2(f.pauseRatio / Math.max(0.01, base.pauseRatio)),
    energyVar: round2(f.energyCV / Math.max(0.03, base.energyCV)),
    zcr: round2(f.zcr / Math.max(1, base.zcr)),
    energyDb: round2(f.energyDb - base.energyDb),
    // 走向类 / 嗓音类：相对本人习惯的"差"（0 = 和平时一样），与 build-prototypes 口径一致
    pitchSlope: round2((f.pitchSlope ?? 0) - Number(base.pitchSlope ?? 0)),
    tailTrend: round2((f.tailTrend ?? 0) - Number(base.tailTrend ?? 0)),
    peakRate: round2((f.peakRate ?? 0) / Math.max(0.5, base.peakRate ?? base.rate)),
    hnr: round2((f.hnr ?? 0) - Number(base.hnr ?? 0)),
    pitchHz: Math.round(f.pitchHz),
    priorBlend: base.blended ? round2(Math.min(1, Number(baseline.n) / 10)) : 1,
  }
}

// ---------- 规则版 -----------------------------------------------------------
function ruleScores(rel, f, cfg) {
  const r = cfg.rules
  const s = { happy: 0, excited: 0, tired: 0, sad: 0, relaxed: 0, angry: 0 }
  const why = {}

  // 疲惫：明显变慢 + （停顿变多 或 音量起伏变小 或 整体更小声），且音高没变宽
  {
    const T = r.tired
    let score = 0
    const parts = []
    if (rel.rate <= T.rateMax) { score += 0.34 * clamp((T.rateMax - rel.rate) / 0.16 + 0.4, 0.4, 1.4); parts.push('语速慢') }
    if (rel.pause >= T.pauseMin) { score += 0.3 * clamp((rel.pause - T.pauseMin) / 0.5 + 0.5, 0.4, 1.4); parts.push('停顿多') }
    if (rel.energyVar <= T.energyVarMax) { score += 0.2; parts.push('音量平') }
    if (rel.energyDb <= -1.2) { score += 0.18; parts.push('声音轻') }
    if (rel.pitchVar <= T.pitchVarMax) score += 0.1
    if (parts.length >= 2) { s.tired = clamp(score, 0, 1); why.tired = parts.join('+') }
  }

  // 高兴：明显变快 + 音高起伏变大
  if (rel.rate >= r.happy.rateMin && rel.pitchVar >= r.happy.pitchVarMin) {
    s.happy = clamp(0.45 + Math.min(0.22, (rel.rate - r.happy.rateMin) * 0.9) + Math.min(0.18, (rel.pitchVar - r.happy.pitchVarMin) * 0.45), 0, 0.85)
    why.happy = '语速快+音高起伏大'
  }

  // 兴奋：更快 + 起伏更大（高兴的加强版）；成立时压过高心，避免两者同时高分
  if (rel.rate >= r.excited.rateMin && rel.pitchVar >= r.excited.pitchVarMin) {
    s.excited = clamp(0.55 + (rel.rate - r.excited.rateMin) * 0.8 + (rel.pitchVar - r.excited.pitchVarMin) * 0.35, 0, 0.95)
    why.excited = '语速很快+起伏很大'
    s.happy = Math.max(0, Math.min(s.happy, s.excited - 0.15))
  }

  // 低落：句尾明显下沉 + 比平时慢 + 起伏更小
  if (f.tailDrop >= r.sad.tailDropMin && rel.rate <= r.sad.rateMax && rel.pitchVar <= r.sad.pitchVarMax) {
    s.sad = clamp(0.45 + (f.tailDrop - r.sad.tailDropMin) * 0.12 + (r.sad.rateMax - rel.rate) * 0.6, 0, 1)
    why.sad = '句尾下沉+慢+平'
  }

  // 放松：和平常接近、起伏比平时小、停顿不夸张、句尾不下沉
  if (rel.rate >= r.relaxed.rateMin && rel.rate <= r.relaxed.rateMax && rel.pitchVar <= r.relaxed.pitchVarMax &&
      rel.pause <= r.relaxed.pauseMax && f.tailDrop <= r.relaxed.tailDropMax) {
    s.relaxed = clamp(0.42 + (r.relaxed.pitchVarMax - rel.pitchVar) * 0.5, 0, 0.85)
    why.relaxed = '节奏稳+起伏小'
  }

  // 烦躁：音量起伏大 + 音高起伏大 + 声音更「亮」（摩擦/挤压感）
  if (rel.energyVar >= r.angry.energyVarMin && rel.pitchVar >= r.angry.pitchVarMin && rel.zcr >= r.angry.zcrMin) {
    s.angry = clamp(0.45 + (rel.energyVar - r.angry.energyVarMin) * 0.9 + (rel.pitchVar - r.angry.pitchVarMin) * 0.5, 0, 0.9)
    why.angry = '音量起伏大+音高起伏大+音色偏紧'
  }

  // 代价：证据越多分越高（简单抑制单条弱证据）
  for (const k of Object.keys(s)) if (s[k] > 0) s[k] = round2(s[k] * (k === 'tired' ? 1 : 1))
  return { scores: s, why }
}

// ---------- 校准版（有标注样本时） --------------------------------------------
function centroidScores(f, model) {
  const keys = model.features || []
  const classes = model.classes || {}
  const out = {}
  for (const [label, c] of Object.entries(classes)) {
    let d = 0
    let used = 0
    for (const k of keys) {
      const mu = model.mean?.[k]
      const sd = model.sd?.[k]
      if (!Number.isFinite(mu) || !Number.isFinite(sd) || sd <= 1e-6) continue
      const z = (Number(f[k]) - mu) / sd
      const dz = z - Number(c[k] ?? 0)
      d += dz * dz
      used++
    }
    if (used) out[label] = d / used
  }
  const keys2 = Object.keys(out)
  if (!keys2.length) return null
  const best = Math.min(...keys2.map((k) => out[k]))
  const scores = {}
  for (const k of keys2) scores[k] = round2(Math.exp(-(out[k] - best) * 1.2))
  return scores
}

export function classify(f, { baseline = null, model = null, config = DEFAULT_CONFIG } = {}) {
  if (!f || typeof f !== 'object') return { label: 'neutral', confidence: 0, rule: 'no_features', scores: {} }
  const rel = relativeOf(f, baseline)
  let scores = {}
  let why = {}
  let rule = ''

  if (model && model.classes && Object.keys(model.classes).length >= 2) {
    const cs = centroidScores(f, model)
    if (cs) { scores = cs; rule = 'calibrated_centroid' }
  }
  if (!rule) {
    if (!rel) return { label: 'neutral', confidence: 0.3, rule: 'no_baseline', scores: {}, relative: null }
    const rs = ruleScores(rel, f, config)
    scores = rs.scores
    why = rs.why
    rule = 'relative_rules'
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [topLabel, topScore] = entries[0] || ['neutral', 0]
  const second = entries[1]?.[1] ?? 0
  const margin = topScore - second

  if (topScore < config.minConfidence || margin < 0.05) {
    return {
      label: 'neutral',
      confidence: round2(clamp(0.35 + margin, 0.3, 0.45)),
      rule: 'weak_evidence',
      scores,
      relative: rel,
      detail: why,
    }
  }
  const confidence = round2(clamp(0.42 + topScore * 0.35 + Math.min(0.15, margin * 0.4), 0.45, 0.82))
  return {
    label: topLabel,
    confidence,
    rule,
    reason: why[topLabel] || undefined,
    scores,
    relative: rel,
    detail: why,
  }
}

export { median }

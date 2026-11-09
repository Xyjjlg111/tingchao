// z-score 最近质心分类器（语料训练出来的 data/model.json）
//
// 为什么加它：CASIA 上区间原型 LOO 27.8%，同一套特征换最近质心 65.5%，
// 选三特征（语速/音量/音色）后 71.8%。原型留给"解释"，判定交给质心。
// 只在「离质心不远」（≤ 该类训练集 90 分位半径）时才下结论，太远就交回原型/规则。

const CN = {
  rate: '语速', energyDb: '音量', zcr: '音色', pitchVar: '音高起伏', pause: '停顿',
  energyVar: '音量起伏', pitchSlope: '音高走向', tailTrend: '句尾走向', peakRate: '节奏', hnr: '嗓音',
}
const LABEL_CN = { angry: '生气', neutral: '平常', sad: '低落', happy: '高兴', excited: '兴奋', tired: '疲惫', relaxed: '放松' }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const r2 = (v) => Number(Number(v).toFixed(2))

export function loadModel(json) {
  if (!json || !Array.isArray(json.keys) || !json.centroids) return null
  return json
}

function zOf(rel, m) {
  return m.keys.map((k) => {
    const v = Number(rel?.[k])
    const mu = Number(m.mu[k] ?? 0)
    const sd = Number(m.sd[k] ?? 1) || 1
    return Number.isFinite(v) ? (v - mu) / sd : 0
  })
}
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))

function evidenceOf(rel, m) {
  const items = m.keys
    .map((k) => ({ k, v: Number(rel?.[k]) }))
    .filter((x) => Number.isFinite(x.v))
  // 相对基线偏离最大的两项，用"倍数/差"描述（她读得懂的词，不是 z 值）
  return items
    .sort((a, b) => Math.abs(b.v - 1) - Math.abs(a.v - 1))
    .slice(0, 2)
    .map(({ k, v }) => {
      if (k === 'energyDb') return `音量${v >= 0 ? '+' : ''}${r2(v)}dB`
      if (k === 'pitchSlope' || k === 'tailTrend') return `${CN[k]}${v >= 0 ? '+' : ''}${r2(v)}`
      return `${CN[k]}${r2(v)}倍`
    })
    .join('·')
}

export function classifyByCentroid(rel, model) {
  if (!rel || !model) return null
  const z = zOf(rel, model)
  const ds = Object.entries(model.centroids)
    .map(([label, c]) => ({ label, d: dist(z, c) }))
    .sort((a, b) => a.d - b.d)
  if (!ds.length) return null
  const [best, second] = ds
  const radius = Number(model.radius?.[best.label] ?? 4.5)
  const label = best.label
  if (best.d > radius) {
    return { ok: false, rule: 'too_far', label: 'neutral', labelCN: '平常', distance: r2(best.d), radius, margin: 0, scores: {} }
  }
  const margin = (second.d - best.d) / (second.d + best.d + 1e-6)
  // 不够明确就别下结论：非"平常"的判定要求领先幅度足够大，否则会把她带偏。
  // 实测：CASIA 中性样本被误判成"低落"时，margin 只有 0.04–0.15。
  const minMargin = Number(model.minMarginByLabel?.[label] ?? model.minMargin ?? 0.18)
  if (label !== 'neutral' && margin < minMargin) {
    return {
      ok: true, label: 'neutral', labelCN: '平常', confidence: 0.35, rule: 'low_margin',
      // 领先不够时不给硬结论，但把"最像的那个"留出来，让她自己掂量（可能有点 X）。
      rawLabel: label, rawLabelCN: LABEL_CN[label] || label,
      reason: '', distance: r2(best.d), radius, margin: r2(margin),
      scores: Object.fromEntries(ds.map((d) => [d.label, r2(1 / (1 + d.d))])),
    }
  }
  const confidence = clamp(0.5 + 0.45 * margin, 0.35, 0.92)
  return {
    ok: true,
    label,
    labelCN: LABEL_CN[label] || label,
    confidence: r2(confidence),
    rule: 'centroid',
    reason: evidenceOf(rel, model),
    distance: r2(best.d),
    radius,
    margin: r2(margin),
    scores: Object.fromEntries(ds.map((d) => [d.label, r2(1 / (1 + d.d))])),
  }
}

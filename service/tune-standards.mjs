import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * 用 CASIA 的样本，给「门槛」定一个有理有据的值。
 *
 * 为什么不用他的 63 条语音直接驯？——那 63 条没有人工标签，
 * 在没标签的数据上调门槛 = 自己给自己打分，越调越自信。
 *
 * 做法：
 *   1) 用【线上模型】在 CASIA 上算每个片段的「最近/次近距离比」margin（不做留一，
 *      因为这问的是「线上模型说的话什么时候可信」，不是「模型还能不能再好」）；
 *   2) 对每个情绪扫 margin 阈值，统计「说出口时的准确率」与「覆盖率」；
 *   3) 取「准确率 ≥ 目标 且 覆盖率最大」的那个阈值；
 *   4) 拿他的真实观测跑一遍，报告新旧门槛下会「说」多少条。
 *
 * 用法：node tune-standards.mjs [--target 0.8] [--speaker <QQ>] [--apply]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const TARGET = Number(arg('target', 0.8))
const MIN_COV = Number(arg('min-coverage', 0.05))
const SPEAKER = String(arg('speaker', ''))
 if (!SPEAKER) { console.error('缺少 --speaker <QQ>'); process.exit(1) }
const MODEL_FILE = `${ROOT}/data/model.json`
const SAMPLES_FILE = `${ROOT}/data/casia-samples-v4.jsonl`
const OBS_FILE = `${ROOT}/data/observations.jsonl`
const STANDARDS_FILE = `${ROOT}/data/standards.json`

const model = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
const KEYS = model.keys
const LABELS = model.labels

const rows = readFileSync(SAMPLES_FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => Number.isFinite(r.features?.rate))

const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[Math.floor(v.length / 2)] : 0
}
const pick = (f, k) => {
  if (k === 'pitchVar') return f.pitchVar ?? f.pitchIQR
  if (k === 'pause') return f.pause ?? f.pauseRatio
  if (k === 'energyVar') return f.energyVar ?? f.energyCV
  return f[k]
}

// 每个说话人自己的基线（neutral 优先）
const baseBy = new Map()
for (const r of rows) {
  if (!baseBy.has(r.speaker)) baseBy.set(r.speaker, [])
  baseBy.get(r.speaker).push(r)
}
for (const [spk, list] of baseBy) {
  const neutral = list.filter((r) => r.emotion === 'neutral')
  const pool = neutral.length >= 3 ? neutral : list
  baseBy.set(spk, Object.fromEntries(KEYS.map((k) => [k, median(pool.map((r) => pick(r.features, k))) || 1])))
}

function predOf(features, base) {
  const z = KEYS.map((k) => {
    const v = pick(features, k)
    const b = base[k] || 1
    return ((b ? v / b : v) - (model.mu[k] ?? 1)) / (model.sd[k] || 1)
  })
  const ds = LABELS.map((l) => {
    const c = model.centroids[l]
    if (!c) return null
    return { label: l, d: Math.sqrt(c.reduce((s, cv, i) => s + (z[i] - cv) ** 2, 0)) }
  }).filter(Boolean).sort((a, b) => a.d - b.d)
  if (ds.length < 2) return null
  const [best, second] = ds
  const radius = model.radius?.[best.label] ?? 4.5
  return {
    truth: features.__truth,
    label: best.label,
    d: best.d,
    radius,
    inRadius: best.d <= radius,
    margin: (second.d - best.d) / (second.d + best.d + 1e-6),
  }
}

const preds = []
for (const r of rows) {
  const p = predOf({ ...r.features, __truth: r.emotion }, baseBy.get(r.speaker))
  if (p) preds.push(p)
}
console.log(`样本 ${preds.length} 条（线上模型直接跑，不用留一）`)
console.log(`总体：最近质心命中 ${(100 * preds.filter((p) => p.label === p.truth).length / preds.length).toFixed(1)}%，半径内 ${(100 * preds.filter((p) => p.inRadius).length / preds.length).toFixed(1)}%`)

function sweep(label) {
  const mine = preds.filter((p) => p.label === label && p.inRadius)
  const out = []
  for (let th = 0; th <= 0.6; th += 0.02) {
    const kept = mine.filter((p) => p.margin >= th)
    if (!kept.length) { out.push({ th, cov: 0, prec: 0, n: 0 }); continue }
    const ok = kept.filter((p) => p.truth === label).length
    out.push({ th, cov: kept.length / mine.length, prec: ok / kept.length, n: kept.length })
  }
  return out
}

const chosen = {}
for (const label of LABELS) {
  if (label === 'neutral') continue
  const list = sweep(label)
  const usable = list.filter((x) => x.cov >= MIN_COV && x.prec >= TARGET)
  const pickBest = usable.sort((a, b) => b.cov - a.cov || b.prec - a.prec)[0]
    || list.filter((x) => x.prec >= TARGET).sort((a, b) => b.cov - a.cov)[0]
    || list.slice().sort((a, b) => b.prec - a.prec)[0]
  chosen[label] = pickBest
  console.log(`\n${label}（候选 ${list[0].n} 条）：`)
  for (const x of list.filter((y) => Number((y.th * 100).toFixed(0)) % 4 === 0 && y.th > 0)) {
    console.log(`  th=${x.th.toFixed(2)} 覆盖=${(x.cov * 100).toFixed(1)}% 准确=${(x.prec * 100).toFixed(1)}% n=${x.n}`)
  }
  console.log(`  → 选 ${pickBest.th.toFixed(2)}（覆盖 ${(pickBest.cov * 100).toFixed(1)}%，准确 ${(pickBest.prec * 100).toFixed(1)}%）`)
}

const baselineStore = existsSync(`${ROOT}/data/baselines.json`)
  ? JSON.parse(readFileSync(`${ROOT}/data/baselines.json`, 'utf8'))
  : { speakers: {} }

const obs = existsSync(OBS_FILE)
  ? readFileSync(OBS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => String(o.speaker) === SPEAKER)
  : []

function countWith(std) {
  let say = 0, hint = 0, none = 0
  const rowsB = baselineStore.speakers?.[SPEAKER]?.rows || []
  const base = Object.fromEntries(KEYS.map((k) => {
    const vals = rowsB.map((f) => pick(f, k)).filter(Number.isFinite).sort((a, b) => a - b)
    if (vals.length >= 3) return [k, vals[Math.floor(vals.length / 2)]]
    return [k, model.mu[k] ?? 1]
  }))
  for (const o of obs) {
    const f = o.features || {}
    const z = KEYS.map((k) => {
      const v = pick(f, k)
      const rel = (base[k] || 1) ? v / base[k] : v
      return (rel - (model.mu[k] ?? 1)) / (model.sd[k] || 1)
    })
    const ds = LABELS.map((l) => {
      const c = model.centroids[l]
      if (!c) return null
      return { label: l, d: Math.sqrt(c.reduce((s, cv, i) => s + (z[i] - cv) ** 2, 0)) }
    }).filter(Boolean).sort((a, b) => a.d - b.d)
    if (ds.length < 2) { none++; continue }
    const [best, second] = ds
    const gate = std.labelMargin?.[best.label] ?? std.minMargin ?? 0.18
    const margin = (second.d - best.d) / (second.d + best.d + 1e-6)
    if (best.d > (model.radius?.[best.label] ?? 4.5)) { none++; continue }
    if (best.label === 'neutral') { none++; continue }
    if (margin >= gate) say++
    else hint++
  }
  return { say, hint, none }
}

const newStd = {
  minMargin: Number(arg('min-margin', 0.18)),
  labelMargin: {
    angry: Number(arg('angry', chosen.angry?.th?.toFixed(2) ?? 0.2)),
    neutral: 0,
    sad: Number(arg('sad', chosen.sad?.th?.toFixed(2) ?? 0.3)),
  },
}

const store = JSON.parse(readFileSync(STANDARDS_FILE, 'utf8'))
const cur = store.people?.[SPEAKER]?.thresholds || store.default?.thresholds
console.log('\n他的 63 条观测：旧门槛', JSON.stringify(countWith(cur)), '新门槛', JSON.stringify(countWith(newStd)))

if (process.argv.includes('--apply')) {
  copyFileSync(STANDARDS_FILE, STANDARDS_FILE + `.bak-tune-${Date.now()}`)
  if (!store.people) store.people = {}
  if (!store.people[SPEAKER]) {
    store.people[SPEAKER] = { id: `spk-${SPEAKER}`, kind: 'person', qq: SPEAKER, name: '', label: `QQ ${SPEAKER}`, keywords: [], enabled: true, source: 'manual' }
  }
  store.people[SPEAKER].thresholds = { minMargin: newStd.minMargin, labelMargin: newStd.labelMargin }
  store.people[SPEAKER].updatedAt = Date.now()
  writeFileSync(STANDARDS_FILE, JSON.stringify(store, null, 2), 'utf8')
  console.log('已写入 standards.json（旧文件已备份 .bak-tune-*）')
} else {
  console.log('\n（只算不写；加 --apply 才写入）')
}

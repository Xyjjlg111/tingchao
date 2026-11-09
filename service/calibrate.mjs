// 校准器：用 data/samples.jsonl 里带标签的特征训练「最近质心」模型，
// 并做留一法（LOO）准确率评估；数据不够会明确告诉你要多少条。
//
// 用法:
//   node calibrate.mjs                 # 训练 + LOO 评估 + 写 data/affect-model.json
//   node calibrate.mjs --dry           # 只看评估，不写文件
//   node calibrate.mjs --min 6         # 每类至少 6 条才参与（默认 4）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABEL_CN } from './lib/affect.mjs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const SAMPLES = join(ROOT, 'data', 'samples.jsonl')
const MODEL = join(ROOT, 'data', 'affect-model.json')

const FEATURES = ['rate', 'pitchIQR', 'pauseRatio', 'energyCV', 'energyDb', 'zcr', 'tailDrop', 'jitter', 'pitchHz']

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.split('=').slice(1).join('=') : def
}
const minPerClass = Number(arg('min', '4'))
const dry = process.argv.includes('--dry')

if (!existsSync(SAMPLES)) {
  console.error(`没有样本文件：${SAMPLES}\n先用 collect.mjs 收集带标签的 wav。`)
  process.exit(2)
}

const rows = readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byLabel = new Map()
for (const r of rows) {
  if (!r?.features) continue
  if (!byLabel.has(r.label)) byLabel.set(r.label, [])
  byLabel.get(r.label).push(r.features)
}

console.log('样本统计：')
for (const [k, v] of [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${LABEL_CN[k] || k} (${k}): ${v.length} 条`)
}

const usable = [...byLabel.entries()].filter(([, v]) => v.length >= minPerClass)
if (usable.length < 2) {
  console.error(`\n可用的类不足以训练：每类至少 ${minPerClass} 条，当前只有 ${usable.length} 类达标。`)
  console.error('建议：每类 8–15 条真实语音，自然说、别演；至少覆盖「平常 / 疲惫 / 高兴 / 低落」。')
  process.exit(3)
}

// 全局均值/标准差（z-score 用）
const all = usable.flatMap(([, v]) => v)
const mean = {}
const sd = {}
for (const k of FEATURES) {
  const xs = all.map((r) => Number(r[k])).filter(Number.isFinite)
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length)) || 1
  mean[k] = m
  sd[k] = s
}

function centroid(list) {
  const c = {}
  for (const k of FEATURES) {
    const xs = list.map((r) => (Number(r[k]) - mean[k]) / sd[k]).filter(Number.isFinite)
    c[k] = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  }
  return c
}

// LOO：留一条出来，用剩下的质心判它
function evalLOO() {
  let hit = 0
  let total = 0
  const confusion = {}
  for (const [label, list] of usable) {
    confusion[label] = confusion[label] || {}
    for (let i = 0; i < list.length; i++) {
      const held = list[i]
      const classes = {}
      for (const [l2, l2list] of usable) {
        const rest = l2 === label ? l2list.filter((_, j) => j !== i) : l2list
        if (!rest.length) continue
        classes[l2] = centroid(rest)
      }
      const keys = Object.keys(classes)
      if (!keys.length) continue
      let best = null
      let bestD = Infinity
      for (const k of keys) {
        let d = 0
        for (const kk of FEATURES) {
          const z = (Number(held[kk]) - mean[kk]) / sd[kk]
          d += (z - Number(classes[k][kk] || 0)) ** 2
        }
        d /= FEATURES.length
        if (d < bestD) { bestD = d; best = k }
      }
      total++
      if (best === label) hit++
      confusion[label][best] = (confusion[label][best] || 0) + 1
    }
  }
  return { hit, total, acc: total ? hit / total : 0, confusion }
}

const classes = {}
for (const [label, list] of usable) classes[label] = centroid(list)

const ev = evalLOO()
console.log(`\n留一法准确率：${(ev.acc * 100).toFixed(1)}%（${ev.hit}/${ev.total}）`)
console.log('混淆（行=真实，列=判成）：')
for (const [label, row] of Object.entries(ev.confusion)) {
  const cells = Object.entries(row).map(([k, v]) => `${LABEL_CN[k] || k}:${v}`).join('  ')
  console.log(`  ${LABEL_CN[label] || label}: ${cells}`)
}

if (ev.acc < 0.65) {
  console.log('\n⚠️ 准确率 < 65%，先别拿去上线；多半是样本太少或标签不一致（同一句话不同人感受不同）。')
  console.log('   建议：每类补到 12 条以上，标签只按「说话人当时确实是什么状态」打，不按内容打。')
}

if (dry) {
  console.log('\n(--dry，未写模型)')
  process.exit(0)
}

const model = {
  version: 1,
  createdAt: new Date().toISOString(),
  samples: ev.total,
  accuracy: Number(ev.acc.toFixed(3)),
  features: FEATURES,
  mean: Object.fromEntries(FEATURES.map((k) => [k, Number(mean[k].toFixed(4))])),
  sd: Object.fromEntries(FEATURES.map((k) => [k, Number(sd[k].toFixed(4))])),
  classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, Object.fromEntries(FEATURES.map((f) => [f, Number((v[f] || 0).toFixed(4))]))])),
  counts: Object.fromEntries([...byLabel.entries()].map(([k, v]) => [k, v.length])),
}
writeFileSync(MODEL, JSON.stringify(model, null, 2))
console.log(`\n已写入 ${MODEL}（${Object.keys(model.classes).length} 类 / ${model.samples} 条）`)
console.log('服务会在下次启动时加载；不重启则继续用规则版。')

// 事后标注：把 observations.jsonl（只存数字）里的一条，按你听过的真实感受打标签，
// 写进 samples.jsonl 供 calibrate.mjs 训练。
//
// 用法:
//   node label.mjs --list 12                 # 看最近 12 条（带序号）
//   node label.mjs --index 3 --label tired   # 把第 3 条标成疲惫
//   node label.mjs --index 3 --label happy --speaker <QQ>
//
// 标签：happy/excited/tired/sad/relaxed/angry/neutral
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABELS, LABEL_CN } from './lib/affect.mjs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const OBS = join(ROOT, 'data', 'observations.jsonl')
const SAMPLES = join(ROOT, 'data', 'samples.jsonl')

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.split('=').slice(1).join('=') : def
}

if (!existsSync(OBS)) {
  console.error(`还没有观察记录：${OBS}\n先让她/你发几条 QQ 语音，耳朵会自动记录特征。`)
  process.exit(2)
}
const rows = readFileSync(OBS, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l) } catch { return null }
}).filter(Boolean)

const limit = Number(arg('list', '0'))
if (limit > 0) {
  const tail = rows.slice(-limit)
  const base = rows.length - tail.length
  console.log(`共 ${rows.length} 条观察，最后 ${tail.length} 条：\n`)
  tail.forEach((r, i) => {
    const f = r.features || {}
    console.log(`[${base + i}] ${r.ts}  ${LABEL_CN[r.label] || r.label} ${r.confidence ?? ''}  qq=${r.speaker || '-'}`)
    console.log(`     rate=${f.rate} 音高=${f.pitchHz}Hz 起伏=${f.pitchIQR} 停顿=${f.pauseRatio} 音量起伏=${f.energyCV} 句尾=${f.tailDrop} 时长=${r.duration}s`)
  })
  console.log('\n挑一条：node label.mjs --index N --label tired')
  process.exit(0)
}

const idx = Number(arg('index', '-1'))
const label = arg('label')
if (!(idx >= 0 && idx < rows.length)) {
  console.error('用法: node label.mjs --index N --label <标签>   （先用 --list 看序号）')
  process.exit(2)
}
if (!LABELS.includes(label)) {
  console.error(`label 必须是 ${LABELS.join(' / ')} 之一`)
  process.exit(2)
}
const r = rows[idx]
const row = {
  hash: `obs-${idx}-${String(r.ts).replace(/[^0-9]/g, '').slice(0, 14)}`,
  file: `observation#${idx}`,
  label,
  speaker: String(arg('speaker', r.speaker || 'me')),
  collectedAt: new Date().toISOString(),
  note: arg('note', ''),
  features: r.features,
}
appendFileSync(SAMPLES, JSON.stringify(row) + '\n')
console.log(`✓ 第 ${idx} 条已标为 ${LABEL_CN[label]} / ${label}，写入 ${SAMPLES}`)
console.log('   样本够了以后跑：node calibrate.mjs')

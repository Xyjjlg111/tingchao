// 用「你自己的语音」训练一个只属于你的情绪模型（听潮自训）
//
// 为什么自己录几句就能比公开模型准：公开模型要抵消「不同人嗓子的差异」，
// 这是语音情绪识别里最难的；你自己录的样本没有这个差异，同一个嗓子、同一个手机。
//
// 用法（在 01_ears-service 目录下）：
//   node train-my-model.mjs                 # 训练 + 装模型 + 热重载
//   node train-my-model.mjs --dry           # 只评估，不写 data/model.json
//   node train-my-model.mjs --root corpus/me --service http://127.0.0.1:3098
//
// 目录结构（每类一个文件夹，wav/mp3 都行）：
//   corpus/me/neutral/*.wav
//   corpus/me/angry/*.wav
//   corpus/me/sad/*.wav
//
// 输出：留一法准确率、每类命中、和「当前线上模型」在同一批样本上的对比。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'
import { loadModel, classifyByCentroid } from './lib/centroid.mjs'
import { MPEGDecoder } from 'mpg123-decoder'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n, d = '') => {
  const i = process.argv.indexOf(`--${n}`)
  return i < 0 ? d : process.argv[i + 1]
}
const has = (n) => process.argv.includes(`--${n}`)

const ROOT = arg('root', join(HERE, 'corpus', 'me'))
const OUT = arg('out', join(HERE, 'data', 'model.json'))
const SERVICE = arg('service', 'http://127.0.0.1:3098').replace(/\/$/, '')
const KEYS = (arg('keys', 'rate,pitchVar,zcr,hnr') || '').split(',').map((s) => s.trim()).filter(Boolean)
const LABELS = ['angry', 'neutral', 'sad']
const MIN_PER_CLASS = Number(arg('min', '3'))
const DRY = has('dry')

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

async function decodeToMono(buf, file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.wav' || ext === '.wave') {
    const wav = parseWav(buf)
    return to16kMono(wav.samples, wav.sampleRate)
  }
  if (ext === '.mp3') {
    const dec = new MPEGDecoder()
    const out = dec.decode(new Uint8Array(buf))
    if (!out.samplesDecoded || !out.channelData?.[0]?.length) return null
    const ch = out.channelData
    const mixed = ch.length > 1
      ? Float32Array.from({ length: out.samplesDecoded }, (_, i) => (ch[0][i] + ch[1][i]) / 2)
      : ch[0]
    return to16kMono(mixed, out.sampleRate)
  }
  return null
}

async function transcribe(buf, file) {
  try {
    const r = await fetch(`${SERVICE}/asr`, {
      method: 'POST',
      headers: { 'content-type': file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' },
      body: buf,
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) return ''
    const j = await r.json()
    return j?.text || ''
  } catch {
    return ''
  }
}

const rows = []
console.log(`扫描目录：${ROOT}`)
if (!existsSync(ROOT)) {
  console.error(`找不到目录 ${ROOT}`)
  console.error('请先建好 corpus/me/neutral、corpus/me/angry、corpus/me/sad，把录音放进去。')
  process.exit(2)
}
for (const label of LABELS) {
  const dir = join(ROOT, label)
  if (!existsSync(dir)) { console.warn(`跳过：没有 ${label} 文件夹`); continue }
  const files = readdirSync(dir).filter((f) => /\.(wav|mp3)$/i.test(f)).sort()
  if (files.length < MIN_PER_CLASS) console.warn(`警告：${label} 只有 ${files.length} 条，建议至少 ${MIN_PER_CLASS} 条`)
  for (const f of files) {
    const p = join(dir, f)
    const buf = readFileSync(p)
    const mono = await decodeToMono(buf, p)
    if (!mono) { console.warn(`跳过（读不了）：${f}`); continue }
    const text = await transcribe(buf, p)
    const r = analyzeProsody(mono, 16000, { text })
    if (!r.ok || !Number.isFinite(r.features?.rate)) { console.warn(`跳过（几乎没声音）：${f}`); continue }
    rows.push({ speaker: 'me', emotion: label, file: f, text, features: r.features })
  }
}
console.log(`提取完成：${rows.length} 条（angry ${rows.filter(r => r.emotion === 'angry').length} / neutral ${rows.filter(r => r.emotion === 'neutral').length} / sad ${rows.filter(r => r.emotion === 'sad').length}）\n`)
if (rows.length < 9) {
  console.error('样本太少（<9 条），先录够再来。')
  process.exit(2)
}

// —— 基线：你自己「平常」的中位数 ——
const neutralRows = rows.filter((r) => r.emotion === 'neutral')
if (neutralRows.length < 3) { console.error('neutral 少于是 3 条，无法建立基线。'); process.exit(2) }
const f = (k) => med(neutralRows.map((r) => r.features[k] ?? 0))
const base = { rate: f('rate'), pitchIQR: f('pitchIQR'), pauseRatio: f('pauseRatio'), energyCV: f('energyCV'), zcr: f('zcr'), hnr: f('hnr') }
const relOf = (r) => ({
  rate: r.features.rate / Math.max(0.2, base.rate),
  pitchVar: r.features.pitchIQR / Math.max(0.35, base.pitchIQR),
  pause: r.features.pauseRatio / Math.max(0.01, base.pauseRatio),
  energyVar: r.features.energyCV / Math.max(0.03, base.energyCV),
  zcr: r.features.zcr / Math.max(1, base.zcr),
  hnr: (r.features.hnr ?? 0) - (base.hnr ?? 0),
})
const data = rows.map((r) => ({ y: r.emotion, x: relOf(r), file: r.file }))

function fitNorm(list) {
  const mu = {}, sd = {}
  for (const k of KEYS) {
    const xs = list.map((d) => d.x[k])
    mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length
    const v = xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length
    sd[k] = Math.sqrt(v) || 1
  }
  return { mu, sd }
}
const zOf = (x, n) => KEYS.map((k) => (x[k] - n.mu[k]) / (n.sd[k] || 1))
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))
function centersOf(list, norm) {
  const out = {}
  for (const y of LABELS) {
    const zs = list.filter((d) => d.y === y).map((d) => zOf(d.x, norm))
    if (!zs.length) continue
    out[y] = zs[0].map((_, i) => zs.reduce((s, z) => s + z[i], 0) / zs.length)
  }
  return out
}

// —— 留一法：每次留一条，用其余条建模型，看判得对不对 ——
let hit = 0
const by = {}
const conf = {}
for (const d of data) {
  const rest = data.filter((o) => o !== d)
  const norm = fitNorm(rest)
  const centers = centersOf(rest, norm)
  const z = zOf(d.x, norm)
  let best = null, bestD = Infinity
  for (const y of LABELS) {
    if (!centers[y]) continue
    const dd = dist(z, centers[y])
    if (dd < bestD) { bestD = dd; best = y }
  }
  const ok = best === d.y
  if (ok) hit++
  by[d.y] ||= { n: 0, hit: 0 }
  by[d.y].n++
  if (ok) by[d.y].hit++
  conf[d.y] ||= {}
  conf[d.y][best] = (conf[d.y][best] || 0) + 1
}
const acc = hit / data.length

// —— 训练最终模型（全量）——
const norm = fitNorm(data)
const centers = centersOf(data, norm)
// 半径：该类到质心距离的 90 分位（至少 1.2，避免过紧）
const radius = {}
for (const y of LABELS) {
  if (!centers[y]) continue
  const ds = data.filter((d) => d.y === y).map((d) => dist(zOf(d.x, norm), centers[y])).sort((a, b) => a - b)
  const q = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))] || 1.5
  radius[y] = Math.max(1.2, Number((q * 1.1).toFixed(2)))
}
const model = {
  version: '1.0-mine',
  labels: LABELS.filter((y) => centers[y]),
  keys: KEYS,
  mu: norm.mu,
  sd: norm.sd,
  centers,
  radius,
  baseline: base,
  minMargin: 0.18,
  minMarginByLabel: { angry: 0.20, neutral: 0, sad: 0.28 },
  note: `personal model trained on ${data.length} clips (${new Date().toISOString().slice(0, 10)})`,
  loo: { acc: Number(acc.toFixed(3)), by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Number((v.hit / v.n).toFixed(3))])) },
}

// —— 和「现在线上那个模型」在同一批样本上比 ——
let compare = null
if (existsSync(OUT)) {
  const cur = loadModel(JSON.parse(readFileSync(OUT, 'utf8')))
  if (cur) {
    let cHit = 0, cSaid = 0
    const cBy = {}
    for (const d of data) {
      const r = classifyByCentroid(d.x, cur)
      cBy[d.y] ||= { n: 0, hit: 0, said: 0 }
      cBy[d.y].n++
      if (r?.ok) {
        cSaid++
        cBy[d.y].said++
        if (r.label === d.y) { cHit++; cBy[d.y].hit++ }
      }
    }
    compare = { acc: cHit / data.length, said: cSaid / data.length, by: cBy, keys: cur.keys }
  }
}

const pct = (x) => `${(x * 100).toFixed(0)}%`
console.log('══ 留一法结果（你自己这批录音）══')
console.log(`总体准确率：${pct(acc)}  （${hit}/${data.length}）`)
for (const y of LABELS) {
  if (!by[y]) continue
  console.log(`  ${y.padEnd(8)} ${pct(by[y].hit / by[y].n)}  (${by[y].hit}/${by[y].n})`)
}
console.log('\n对照表（行=真实，列=判成）：')
for (const y of LABELS) {
  if (!conf[y]) continue
  const cells = LABELS.map((c) => String(conf[y][c] || 0).padStart(3)).join('')
  console.log(`  ${y.padEnd(8)}${cells}`)
}
if (compare) {
  console.log(`\n══ 和现有模型（${compare.keys.join('/')}）对比 ══`)
  console.log(`现有模型：准确率 ${pct(compare.acc)}，开口率 ${pct(compare.said)}`)
  console.log(`你的模型：准确率 ${pct(acc)}，开口率 100%（训练集内）`)
  const delta = acc - compare.acc
  console.log(delta >= 0.03 ? '→ 明显更好，建议装上。' : delta <= -0.03 ? '→ 更差，先别装（可能录音/标注有问题）。' : '→ 差不多，样本再录一些会更稳。')
}

if (DRY) {
  console.log('\n--dry：没有写入模型。去掉 --dry 再跑一次就会装上。')
  process.exit(0)
}

writeFileSync(OUT, JSON.stringify(model, null, 2), 'utf8')
console.log(`\n已写入：${OUT}`)
try {
  const r = await fetch(`${SERVICE}/reload`, { method: 'POST', signal: AbortSignal.timeout(5000) })
  const j = await r.json()
  console.log(`热重载：${j.ok ? '成功' : '失败'}  source=${j.source} keys=${(j.keys || []).join(',')} loo=${j.loo}`)
} catch (e) {
  console.log(`热重载失败（服务没在跑？）：${e.message}`)
  console.log('重启听潮服务后生效：node server.mjs')
}

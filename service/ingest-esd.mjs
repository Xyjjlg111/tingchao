// ESD 语料入库（并行分片版）
// 用法：
//   node ingest-esd.mjs --root "<corpus>\ESD\Emotion Speech Dataset" --out data/esd-samples.jsonl
//   可选：--per 150（每个说话人每个情绪最多取多少条） --shard 0/8 --out 分片文件
//
// 目录：<speaker>/<Emotion>/*.wav  +  <speaker>/<speaker>.txt（转写 + 中文情绪名）
// 输出：每行 { file, emotion, speaker, lang, rateMeasured, duration, features }

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeProsody } from './lib/prosody.mjs'
import { parseWav, to16kMono } from './lib/wav.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}

const ROOT = arg('root')
const OUT = arg('out', join(HERE, 'data', 'esd-samples.jsonl'))
const PER = Number(arg('per', '0')) || 0
const SHARD = arg('shard', '')          // "0/8"
const LIMIT = Number(arg('limit', '0')) || 0

if (!ROOT || !existsSync(ROOT)) {
  console.error('用法：node ingest-esd.mjs --root <"…\Emotion Speech Dataset"> [--per N] [--shard i/n] [--out f.jsonl]')
  process.exit(2)
}

const EMO = {
  angry: 'angry', happy: 'happy', neutral: 'neutral', sad: 'sad', surprise: 'excited',
}
const emoOf = (s) => EMO[String(s || '').toLowerCase().trim()] || ''

mkdirSync(dirname(OUT), { recursive: true })

// 1) 收集文件（跳过 __MACOSX 与 ._ 资源叉）
let tasks = []
for (const spk of readdirSync(ROOT)) {
  if (spk === '__MACOSX' || spk.startsWith('.')) continue
  const spkDir = join(ROOT, spk)
  if (!statSync(spkDir).isDirectory()) continue
  // 转写表
  const txtPath = join(spkDir, `${spk}.txt`)
  const texts = new Map()
  if (existsSync(txtPath)) {
    try {
      for (const line of readFileSync(txtPath, 'utf8').split(/\r?\n/)) {
        const parts = line.split('\t')
        if (parts.length >= 2 && parts[0]) texts.set(parts[0].trim(), parts[1].trim())
      }
    } catch {}
  }
  for (const emoDirName of readdirSync(spkDir)) {
    const emo = emoOf(emoDirName)
    if (!emo) continue
    const emoDir = join(spkDir, emoDirName)
    if (!statSync(emoDir).isDirectory()) continue
    let files = readdirSync(emoDir).filter((f) => /\.wav$/i.test(f) && !f.startsWith('._'))
    if (PER) files = files.slice(0, PER)
    for (const f of files) {
      tasks.push({ spk, emo, emoDirName, file: join(emoDir, f), stem: basename(f, extname(f)), text: texts.get(basename(f, extname(f))) || '' })
    }
  }
}

tasks.sort((a, b) => (a.file < b.file ? -1 : 1))

// 分片
if (SHARD) {
  const [i, n] = SHARD.split('/').map(Number)
  tasks = tasks.filter((_, idx) => idx % n === i)
}
if (LIMIT) tasks = tasks.slice(0, LIMIT)

const byEmo = {}
const speakers = new Set()
const lines = []
let skipped = 0
let done = 0
const t0 = Date.now()

for (const t of tasks) {
  let r
  try {
    const wav = parseWav(readFileSync(t.file))
    const mono = to16kMono(wav.samples, wav.sampleRate)
    r = analyzeProsody(mono, 16000, t.text ? { text: t.text } : {})
  } catch { skipped++; continue }
  if (!r?.ok || !Number.isFinite(r.features?.rate)) { skipped++; continue }

  const rec = {
    file: t.file.slice(ROOT.length + 1).replace(/\\/g, '/'),
    emotion: t.emo,
    speaker: t.spk,
    lang: Number(t.spk) <= 10 ? 'zh' : 'en',
    rateMeasured: Boolean(t.text),
    duration: Math.round((r.duration ?? r.features?.duration ?? 0) * 1000) / 1000,
    features: r.features,
  }
  lines.push(JSON.stringify(rec))
  byEmo[t.emo] = (byEmo[t.emo] || 0) + 1
  speakers.add(t.spk)
  if (++done % 500 === 0) {
    const sp = (Date.now() - t0) / 1000
    console.log(`  …${done}/${tasks.length}  ${(done / sp).toFixed(1)}/s  ${sp.toFixed(0)}s`)
  }
}

writeFileSync(OUT, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`[shard ${SHARD || 'all'}] 入库 ${lines.length} / 说话人 ${speakers.size} / 跳过 ${skipped} / ${secs}s`)
console.log('  分布：', Object.entries(byEmo).map(([k, v]) => `${k} ${v}`).join(' · '))

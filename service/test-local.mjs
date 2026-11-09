import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 离线自测：对 samples/*.wav 跑「转写 + 韵律情绪」，不启动 HTTP。
// 用法: node test-local.mjs [file1.wav file2.wav ...]
import { readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const MODEL = process.env.EARS_MODEL || join(ROOT, 'models', 'ggml-base-q5_1.bin')
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['zh-tired.wav', 'zh-happy.wav', 'zh-sad.wav', 'en-test.wav'].map((f) => join(ROOT, 'samples', f))

if (!existsSync(MODEL)) {
  console.log(`model missing: ${MODEL}`)
  process.exit(2)
}

const mod = await import('@fugood/whisper.node')
console.log('loading model…')
const t0 = Date.now()
const ctx = await mod.initWhisper({ filePath: MODEL })
console.log(`model loaded in ${Date.now() - t0} ms`)

for (const f of files) {
  if (!existsSync(f)) {
    console.log(`\n--- ${basename(f)} (missing) ---`)
    continue
  }
  const buf = readFileSync(f)
  const wav = parseWav(buf)
  const mono = to16kMono(wav.samples, wav.sampleRate)
  const t1 = Date.now()
  let text = ''
  let err = ''
  try {
    const job = ctx.transcribe(f, { language: 'zh', translate: false, maxThreads: 4 })
    const res = await job.promise
    text = String(res?.result || '').trim()
  } catch (e) {
    err = e?.message || String(e)
  }
  const ms = Date.now() - t1
  const pros = analyzeProsody(mono, 16000, { text })

  console.log(`\n--- ${basename(f)} ---`)
  console.log('wav      :', `${wav.sampleRate}Hz ${wav.channels}ch ${wav.bitsPerSample}bit ${wav.duration.toFixed(2)}s`)
  console.log('text     :', err ? `ERROR ${err}` : text, `(${ms} ms)`)
  console.log('affect   :', `${pros.label} conf=${pros.confidence}`, JSON.stringify(pros.features))
  console.log('scores   :', JSON.stringify(pros.scores))
}

await ctx.release().catch(() => {})

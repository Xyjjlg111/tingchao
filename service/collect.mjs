// 标注样本收集器：从 wav 里提特征（不保存音频，只存数字 + 文件哈希），
// 供 calibrate.mjs 训练/验证「语气判定」的校准模型。
//
// 用法:
//   node collect.mjs --dir samples/labeled --label tired
//   node collect.mjs --dir samples/labeled/tired --label tired --speaker <QQ>
//   （--dir 下的每个 .wav 都会被处理；也可以只给单个文件）
//
// 标签用英文: happy / excited / tired / sad / relaxed / angry / neutral
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'
import { LABELS } from './lib/affect.mjs'

const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'data', 'samples.jsonl')

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.split('=').slice(1).join('=') : def
}

const label = arg('label')
const speaker = arg('speaker', 'me')
let dir = arg('dir')
if (!dir) {
  console.error('用法: node collect.mjs --dir <wav 文件或目录> --label <tired|happy|...> [--speaker QQ]')
  process.exit(2)
}
if (!LABELS.includes(label)) {
  console.error(`label 必须是 ${LABELS.join(' / ')} 之一`)
  process.exit(2)
}

const files = []
if (statSync(dir).isDirectory()) {
  for (const f of readdirSync(dir)) if (extname(f).toLowerCase() === '.wav') files.push(join(dir, f))
} else files.push(dir)

mkdirSync(join(ROOT, 'data'), { recursive: true })
let n = 0
for (const file of files) {
  try {
    const buf = readFileSync(file)
    const wav = parseWav(buf)
    const mono = to16kMono(wav.samples, wav.sampleRate)
    const r = analyzeProsody(mono, 16000, { text: arg('text') })
    if (!r.ok) { console.error(`跳过 ${basename(file)}: ${r.reason}`); continue }
    const row = {
      hash: createHash('sha1').update(buf).digest('hex').slice(0, 16),
      file: basename(file),
      label,
      speaker: String(speaker),
      collectedAt: new Date().toISOString(),
      features: r.features,
    }
    appendFileSync(OUT, JSON.stringify(row) + '\n')
    n++
    console.log(`✓ ${basename(file)} → ${label}  rate=${r.features.rate} pitchIQR=${r.features.pitchIQR} pause=${r.features.pauseRatio} tail=${r.features.tailDrop}`)
  } catch (e) {
    console.error(`✗ ${basename(file)}: ${e.message}`)
  }
}
console.log(`\n共写入 ${n} 条到 ${OUT}`)

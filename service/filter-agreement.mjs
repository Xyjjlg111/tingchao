// 用逐条 json 里的 5 位标注员（A–E）算"标注一致性"，只留高一致的片段。
//
// 目的：分清"我们的特征不行"和"标签本身噪声大"。
// 只保留：5 位标注员映射到我们的类之后 ≥4 位一致，且该多数类 == 样本的 emotion_result。
//
// 用法: node filter-agreement.mjs --root "<corpus>/EmotionTalk\extract" --samples data/emotiontalk-samples.jsonl --out data/emotiontalk-clean.jsonl --min 0.8
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const arg = (n, d = '') => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] }
const ROOT = arg('root', '语音\\语音库\\EmotionTalk\\extract')
const SAMPLES = arg('samples', 'data/emotiontalk-samples.jsonl')
const OUT = arg('out', 'data/emotiontalk-clean.jsonl')
const MIN = Number(arg('min', '0.8'))

const MAP = { neutral: 'neutral', angry: 'angry', disgusted: 'angry', happy: 'happy', surprised: 'excited', sad: 'sad', fearful: 'sad' }

const rows = readFileSync(SAMPLES, 'utf8').trim().split('\n').map(JSON.parse)
const out = []
const stat = { total: rows.length, noJson: 0, lowAgree: 0, mismatch: 0, kept: 0 }
for (const r of rows) {
  const jf = join(ROOT, 'Audio', 'json', r.file.replace(/\.wav$/i, '.json'))
  if (!existsSync(jf)) { stat.noJson++; continue }
  let meta
  try { meta = JSON.parse(readFileSync(jf, 'utf8')) } catch { stat.noJson++; continue }
  const votes = {}
  for (const v of Object.values(meta.data || {})) {
    const e = MAP[String(v?.emotion || '').toLowerCase()]
    if (e) votes[e] = (votes[e] || 0) + 1
  }
  const n = Object.values(votes).reduce((a, b) => a + b, 0)
  if (!n) { stat.noJson++; continue }
  let top = null, topN = 0
  for (const [e, c] of Object.entries(votes)) if (c > topN) { top = e; topN = c }
  const agree = topN / n
  if (agree < MIN) { stat.lowAgree++; continue }
  if (top !== r.emotion) { stat.mismatch++; continue }
  out.push({ ...r, agree: Number(agree.toFixed(2)), votes })
  stat.kept++
}
writeFileSync(OUT, out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''))
const by = {}
for (const r of out) by[r.emotion] = (by[r.emotion] || 0) + 1
console.log(JSON.stringify({ ok: true, out: OUT, min: MIN, ...stat, byEmotion: by }, null, 2))

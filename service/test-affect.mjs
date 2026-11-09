// 语气判定自测：不依赖音频，直接喂「特征向量」，验证相对规则与兜底。
// 运行: node test-affect.mjs
import { classify, buildBaseline, relativeOf } from './lib/affect.mjs'

const baseline = {
  n: 12,
  rate: 4.6, pitchIQR: 1.8, pitchHz: 210, pauseRatio: 0.18,
  energyCV: 0.32, energyDb: -22, zcr: 900, updatedAt: new Date().toISOString(),
}

function f(over = {}) {
  return {
    duration: 5, speechSeconds: 3.6, pitchHz: 210, pitchIQR: 1.8, pitchRange: 3.2,
    jitter: 0.35, energyCV: 0.32, energyDb: -22, zcr: 900, rate: 4.6,
    rateUnit: '字/秒', pauseRatio: 0.18, tailDrop: 0.3, voicedRatio: 0.7, pitchFrames: 30,
    ...over,
  }
}

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[1] 无基线 → 不下结论')
{
  const r = classify(f({ rate: 3.2, pauseRatio: 0.4, pitchIQR: 1.2 }), { baseline: null })
  ok('no_baseline → neutral', r.label === 'neutral' && r.rule === 'no_baseline', r.rule)
}

console.log('\n[2] 平常 → neutral（0 token 的前提）')
{
  const r = classify(f(), { baseline })
  ok('平常被判 neutral', r.label === 'neutral', `${r.label} ${r.confidence} rule=${r.rule}`)
}

console.log('\n[3] 疲惫：语速慢 + 停顿多 + 音量平')
{
  const r = classify(f({ rate: 3.6, pauseRatio: 0.34, energyCV: 0.26, pitchIQR: 1.6 }), { baseline })
  ok('→ tired', r.label === 'tired', `${r.label} ${r.confidence} ${r.reason || ''}`)
  ok('置信度 ≥0.45', r.confidence >= 0.45, String(r.confidence))
}

console.log('\n[4] 高兴：语速快 + 起伏大')
{
  const r = classify(f({ rate: 5.3, pitchIQR: 2.3 }), { baseline })
  ok('→ happy', r.label === 'happy', `${r.label} ${r.confidence}`)
}

console.log('\n[5] 兴奋：更快 + 起伏更大')
{
  const r = classify(f({ rate: 6.2, pitchIQR: 3.2 }), { baseline })
  ok('→ excited', r.label === 'excited', `${r.label} ${r.confidence}`)
}

console.log('\n[6] 低落：句尾下沉 + 慢 + 平')
{
  const r = classify(f({ rate: 4.1, pitchIQR: 1.4, tailDrop: 2.1 }), { baseline })
  ok('→ sad', r.label === 'sad', `${r.label} ${r.confidence}`)
}

console.log('\n[7] 放松：节奏稳 + 起伏小')
{
  const r = classify(f({ rate: 4.5, pitchIQR: 1.3, pauseRatio: 0.2, tailDrop: 0.4 }), { baseline })
  ok('→ relaxed', r.label === 'relaxed', `${r.label} ${r.confidence}`)
}

console.log('\n[8] 烦躁：音量起伏大 + 音高起伏大 + 音色偏紧')
{
  const r = classify(f({ energyCV: 0.45, pitchIQR: 2.4, zcr: 1020 }), { baseline })
  ok('→ angry', r.label === 'angry', `${r.label} ${r.confidence}`)
}

console.log('\n[9] 证据不足 → 不乱贴标签')
{
  const r = classify(f({ rate: 4.2 }), { baseline })
  ok('neutral', r.label === 'neutral' && r.rule === 'weak_evidence', `${r.label} ${r.rule}`)
}

console.log('\n[10] 相对量计算')
{
  const rel = relativeOf(f({ rate: 2.3, pitchIQR: 0.9 }), baseline)
  ok('rate=0.5', Math.abs(rel.rate - 0.5) < 0.01, String(rel.rate))
  ok('pitchVar=0.5', Math.abs(rel.pitchVar - 0.5) < 0.01, String(rel.pitchVar))
}

console.log('\n[11] 基线构建')
{
  const rows = [f(), f({ rate: 4.4 }), f({ rate: 4.8 }), f({ rate: 4.6 })]
  const b = buildBaseline(rows)
  ok('n=4', b.n === 4, String(b.n))
  ok('中位数 rate=4.6', Math.abs(b.rate - 4.6) < 0.001, String(b.rate))
  ok('少于 3 条 → null', buildBaseline(rows.slice(0, 2)) === null)
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)

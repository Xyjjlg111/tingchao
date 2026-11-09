// dsh-ears-svc — 小鱼儿的本地耳朵（ASR + 语气韵律），独立进程，不碰 DSH profile。
// 用法: node server.mjs [--port 3098]
// 端点（全部 127.0.0.1）:
//   GET  /health                        → 状态（含基线人数、校准模型）
//   POST /asr     (wav body)            → { ok, text, segments, ms }
//   POST /affect  (wav body, ?speaker=) → { ok, label, labelCN, confidence, features, scores }
//   POST /analyze (wav body, ?speaker=) → asr + affect 合并
//   GET  /baselines                     → 已学到的人声基线
//   POST /baseline/reset?speaker=       → 清掉某个人的基线
//   POST /speaker (wav body)            → 预留（声纹），当前返回 not_implemented
import http from 'node:http'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { parseWav, to16kMono } from './lib/wav.mjs'
import { analyzeProsody } from './lib/prosody.mjs'
import { classify, buildBaseline, LABEL_CN, relativeOf } from './lib/affect.mjs'
import { classifyByPrototypes, loadPrototypes, renderShort, PRIOR_PROTOTYPES, PRIOR_VERSION } from './lib/prototypes.mjs'
import { classifyByCentroid, loadModel } from './lib/centroid.mjs'
import { createStandards, deriveFromObservations } from './lib/standards.mjs'

// 可搬移：默认就是本文件所在目录；想放别处设 EARS_ROOT。
const ROOT = process.env.EARS_ROOT || dirname(fileURLToPath(import.meta.url))
// 2026-11-08：Paraformer（中文专用）做默认引擎，whisper 留作回退。
// 2026-11-08：默认换成本地 Paraformer-large（101 条自然口语实测 CER 16.06% vs small 21.20%，
// 单句 92ms vs 40ms）。想回小模型：设 EARS_PARA_DIR 指向 sherpa-onnx-paraformer-zh-small-2024-03-09。
const PARA_DIR = process.env.EARS_PARA_DIR || join(ROOT, 'models', 'paraformer-zh-large')
const PARA_MODEL = join(PARA_DIR, 'model.int8.onnx')
const PARA_TOKENS = join(PARA_DIR, 'tokens.txt')
const ENGINE = process.env.EARS_ENGINE || 'auto'   // auto | paraformer | whisper
const MODEL_SMALL = join(ROOT, 'models', 'ggml-small-q5_1.bin')
const MODEL_BASE = join(ROOT, 'models', 'ggml-base-q5_1.bin')
// 模型选择：EARS_MODEL 显式指定 > 有 small 就用 small > 退回 base。
// 换模型不影响任何判定逻辑（阈值、记忆点、基线都在别处），随时可以改回 base。
// 2026-11-08：默认回到 base（5 秒语音约 3.6 秒，延迟才是体验底线）。
// small 保留，需要更高准确率时显式 EARS_MODEL=small 启一次即可（约 10 秒/条）。
const MODEL = process.env.EARS_MODEL === 'small' ? MODEL_SMALL
  : process.env.EARS_MODEL === 'base' ? MODEL_BASE
  : process.env.EARS_MODEL || MODEL_BASE
const DATA_DIR = join(ROOT, 'data')
const BASELINE_FILE = join(DATA_DIR, 'baselines.json')
// 听潮 · 判断标准：通用 + 每人专属（面板在 DSH 设置里改）
const STANDARDS_FILE = join(DATA_DIR, 'standards.json')
const standardsStore = createStandards(STANDARDS_FILE)
standardsStore.load()
const standards = standardsStore
const AFFECT_MODEL_FILE = join(DATA_DIR, 'affect-model.json')
const PORT = Number(process.env.EARS_PORT || process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 3098)
const MAX_BYTES = 40 * 1024 * 1024
const ASR_TIMEOUT_MS = Number(process.env.EARS_ASR_TIMEOUT_MS || 60000)
const BASELINE_MAX = 60
// 单条语音硬上限（秒）：超过就直接拒，不让 small 模型白跑几十秒把消息流堵死。
const MAX_SECONDS = Number(process.env.EARS_MAX_SECONDS || 60)

const logDir = join(ROOT, 'logs')
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try {
    writeFileSync(join(logDir, 'ears-svc.log'), line + '\n', { flag: 'a' })
  } catch {}
}

// ---------- 人声基线 & 校准模型 -------------------------------------------------
function loadJson(p, fallback) {
  try {
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    log('WARN failed to read', p, String(e.message || e))
    return fallback
  }
}
function saveJson(p, obj) {
  try {
    writeFileSync(p, JSON.stringify(obj, null, 2))
  } catch (e) {
    log('WARN failed to write', p, String(e.message || e))
  }
}

const store = loadJson(BASELINE_FILE, { version: 1, speakers: {} })
if (!store.speakers) store.speakers = {}
// 迁移：丢掉缺少 hnr 的旧基线行（旧版没存这一项，留着会让相对值失真）。
for (const [spk, s] of Object.entries(store.speakers)) {
  if (!s || !Array.isArray(s.rows)) continue
  const kept = s.rows.filter((r) => Number.isFinite(r?.hnr))
  if (kept.length !== s.rows.length) {
    if (kept.length >= 3) s.rows = kept
    else delete store.speakers[spk]
  }
}
let affectModel = loadJson(AFFECT_MODEL_FILE, null)

// 区间原型库：有 data/prototypes.json 就用它（语料建出来的），否则用教科书先验。
const PROTOTYPE_FILE = join(DATA_DIR, 'prototypes.json')
let prototypes = loadPrototypes(loadJson(PROTOTYPE_FILE, null)) || PRIOR_PROTOTYPES
let prototypeSource = existsSync(PROTOTYPE_FILE) ? 'file' : 'prior'

// 质心模型：有 data/model.json 就优先用它判定（原型只留作解释）。
// CASIA 实测：同一套特征下 区间原型 LOO 27.8% → 质心 65.5% → 三特征(语速/音量/音色) 71.8%。
const MODEL_FILE = join(DATA_DIR, 'model.json')
const centroidModel = loadModel(loadJson(MODEL_FILE, null))
const modelSource = centroidModel ? 'file' : 'none'

// ---- 非语言发声（EmoGator）模型：笑/叹气/哭腔 ----------------------------
// 只在「转写为空」时使用：没有说话的字，就没有句子级情绪可言，
// 但一声叹气本身就是情绪。模型只认两极（happy/sad），中间态一律不判。
const BURST_MODEL_FILE = join(DATA_DIR, 'burst-model.json')
const burstModel = loadJson(BURST_MODEL_FILE, null)
const burstSource = burstModel ? 'file' : 'none'

function classifyBurst(features) {
  const m = burstModel
  if (!m) return null
  const rel = {
    pitchRange: features.pitchRange / Math.max(0.1, m.base?.pitchRange ?? 6),
    zcr: features.zcr / Math.max(1, m.base?.zcr ?? 1500),
    energyVar: features.energyCV / Math.max(0.01, m.base?.energyCV ?? 0.3),
    energyDb: features.energyDb - (m.baseMedians?.energyDb ?? -22),
  }
  const z = m.keys.map((k) => (rel[k] - m.mu[k]) / (m.sd[k] || 1))
  const d = {}
  for (const y of m.labels) {
    let s = 0
    for (let i = 0; i < z.length; i++) s += (z[i] - m.centers[y][i]) ** 2
    d[y] = Math.sqrt(s)
  }
  const sorted = Object.entries(d).sort((a, b) => a[1] - b[1])
  const [label, d1] = sorted[0]
  const d2v = sorted[1] ? sorted[1][1] : d1 + 1
  const margin = Number(((d2v - d1) / (d2v + d1)).toFixed(3))
  const radius = m.radii?.[label] ?? 3
  // 阈值按「错一次有多贵」定，不是按好看的召回率定。
  // 留一人实测（356 人 / 20,983 条）：
  //   「像在叹气」在任何 margin 上精度都 ≤0.6 → 不注入（宁可不说）
  //   「像在笑」margin≥0.10 精度 ~0.70；再加"音高起伏比平常大、音色不沙"两条形状约束
  //   （pitchRange≥1.05、zcr≤1.0）后升到 ~0.775，代价是只在 15% 的发声上说话。
  const laughterish = rel.pitchRange >= 1.05 && rel.zcr <= 1.0
  // 默认不注入：2026-11-08 留出 30 条真人发声实测，误差仍在 1/3 左右，
  // 不够格进她的上下文。打开方式：环境变量 EARS_BURST_HINT=1（或 config 里显式开关）。
  const HINT_ON = process.env.EARS_BURST_HINT === '1'
  const ok = HINT_ON && label === 'happy' && d1 <= radius && margin >= 0.1 && laughterish
  return {
    ok,
    domain: 'burst',
    label,
    labelCN: label === 'happy' ? '高兴' : '低落',
    confidence: ok ? Number(Math.min(0.85, 0.5 + 0.4 * margin).toFixed(2)) : 0.3,
    rule: ok ? 'burst-laughter' : label !== 'happy' ? 'burst-sad-unsure' : d1 > radius ? 'burst-too-far' : 'burst-low-margin',
    reason:
      '起伏' + rel.pitchRange.toFixed(2) + '倍·音色' + rel.zcr.toFixed(2) + '倍' +
      '·音量' + (rel.energyDb >= 0 ? '+' : '') + rel.energyDb.toFixed(1) + 'dB',
    distance: Number(d1.toFixed(3)),
    radius,
    margin,
    keys: m.keys,
    loo: m.loo?.acc ?? null,
  }
}

// 一句话里到底是"在说话"还是"只发了个声"？
// Paraformer 对任何有能量的声音都会吐字（"嗯/啊/哈/好"），不能拿"有字"当"在说话"。
// 规则：短句（≤3 字或 ≤2.6 秒）先看发声模型，它说得清（margin ≥ 0.12）就以它为准；
// 否则回到句子模型。长句永远走句子模型，发声模型不掺和。
function analyzeMixed(buf, asr, speaker, group) {
  const text = String(asr?.text ?? '')
  const dur = Number(asr?.duration ?? 0)
  const chars = text.replace(/\s+/g, '').length
  const short = chars <= 3 || (dur > 0 && dur <= 2.6)
  if (!short) return doAffect(buf, text, { speaker, group })
  const b = doBurst(buf)
  const m = b?.burst?.margin ?? 0
  if (b?.ok && m >= 0.12) {
    return {
      ...b,
      rule: 'burst-over-short-speech',
      reason: b.reason ? b.reason + '（短句，按发声判）' : '短句，按发声判',
    }
  }
  const a = doAffect(buf, text, { speaker, group })
  if (b?.burst) a.burst = b.burst
  return a
}

function doBurst(buf) {
  const { mono, wav } = prepAudio(buf)
  const t0 = Date.now()
  const r = analyzeProsody(mono, 16000, { text: '' })
  if (!r.ok) return { ...r, ms: Date.now() - t0, srcDuration: Number(wav.duration.toFixed(2)) }
  const b = classifyBurst(r.features)
  return {
    ok: Boolean(b?.ok),
    label: b?.ok ? b.label : 'neutral',
    labelCN: b?.ok ? b.labelCN : '平常',
      confidence: b?.confidence ?? 0.3,
    rule: b?.rule ?? 'burst-disabled',
    reason: b?.reason ?? '',
    domain: 'burst',
    duration: r.features.duration,
    features: r.features,
    burst: b,
    ms: Date.now() - t0,
    srcDuration: Number(wav.duration.toFixed(2)),
  }
}

function baselineOf(speaker) {
  const s = speaker && store.speakers[speaker]
  return s && s.rows && s.rows.length >= 3 ? buildBaseline(s.rows) : null
}

function learnBaseline(speaker, features) {
  if (!speaker) return
  const s = store.speakers[speaker] || { rows: [], updatedAt: null }
  // 必须把模型用到的每一项都存下来：旧版只存 7 项，模型换成含 hnr 的四键后，
  // 基线里 hnr 恒为 0 → 相对值凭空多出 3~4 个标准差 → 全部 too_far（2026-11-08 实测）。
  s.rows.push({
    rate: features.rate,
    pitchIQR: features.pitchIQR,
    pitchHz: features.pitchHz,
    pauseRatio: features.pauseRatio,
    energyCV: features.energyCV,
    energyDb: features.energyDb,
    zcr: features.zcr,
    hnr: features.hnr,
    pitchSlope: features.pitchSlope,
    tailTrend: features.tailTrend,
    peakRate: features.peakRate,
  })
  if (s.rows.length > BASELINE_MAX) s.rows = s.rows.slice(-BASELINE_MAX)
  s.updatedAt = new Date().toISOString()
  store.speakers[speaker] = s
  saveJson(BASELINE_FILE, store)
}

let paraRec = null
function getParaformer() {
  if (paraRec) return paraRec
  if (!existsSync(PARA_MODEL) || !existsSync(PARA_TOKENS)) return null
  // sherpa-onnx-node 是 CJS 原生插件，ESM 里要用 createRequire
  const req = createRequire(import.meta.url)
  const sherpa = req('sherpa-onnx-node')
  const t0 = Date.now()
  paraRec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { paraformer: { model: PARA_MODEL }, tokens: PARA_TOKENS, numThreads: 2, provider: 'cpu', debug: 0 },
  })
  log(`paraformer loaded in ${Date.now() - t0}ms: ${PARA_MODEL}`)
  return paraRec
}

let whisper = null
let whisperLoading = null
async function getWhisper() {
  if (whisper) return whisper
  if (whisperLoading) return whisperLoading
  whisperLoading = (async () => {
    if (!existsSync(MODEL)) throw new Error(`model missing: ${MODEL}`)
    const mod = await import('@fugood/whisper.node')
    const t0 = Date.now()
    const ctx = await mod.initWhisper({ filePath: MODEL })
    log(`whisper model loaded in ${Date.now() - t0}ms: ${MODEL}`)
    whisper = ctx
    return ctx
  })()
  try {
    return await whisperLoading
  } finally {
    whisperLoading = null
  }
}

// 单飞队列：whisper 上下文非线程安全，一次只跑一条
let chain = Promise.resolve()
function serialize(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function prepAudio(buf) {
  const wav = parseWav(buf)
  const mono = to16kMono(wav.samples, wav.sampleRate)
  return { wav, mono }
}

async function doAsr(buf) {
  const { wav, mono } = prepAudio(buf)

  // ① Paraformer（中文专用，5 秒语音约 0.1 秒）—— 默认走这条
  if (ENGINE !== 'whisper') {
    try {
      const rec = getParaformer()
      if (rec) {
        const t0 = Date.now()
        const stream = rec.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: mono })
        rec.decode(stream)
        const r = rec.getResult(stream)
        return {
          ok: true,
          text: String(r?.text || '').trim(),
          language: 'zh',
          segments: [],
          ms: Date.now() - t0,
          duration: Number(wav.duration.toFixed(2)),
          engine: 'paraformer',
        }
      }
    } catch (e) {
      log('WARN paraformer 转写失败，回退 whisper：', String(e?.message || e))
    }
  }

  // ② 回退：whisper（原逻辑，一行没有改判定）
  const ctx = await getWhisper()
  const tmp = join(tmpdir(), `ears-${randomUUID()}.wav`)
  writeFileSync(tmp, buf)
  const t0 = Date.now()
  try {
    const job = ctx.transcribe(tmp, {
      language: process.env.EARS_LANG || 'zh',
      translate: false,
      maxThreads: Number(process.env.EARS_THREADS || 8),
      prompt: process.env.EARS_PROMPT || '以下是简体中文普通话。',
      tokenTimestamps: false,
    })
    const timer = setTimeout(() => job.stop().catch(() => {}), ASR_TIMEOUT_MS)
    let res
    try {
      res = await job.promise
    } finally {
      clearTimeout(timer)
    }
    return {
      ok: true,
      text: String(res?.result || '').trim(),
      language: res?.language,
      segments: (res?.segments || []).map((s) => ({ text: s.text.trim(), t0: s.t0, t1: s.t1 })),
      ms: Date.now() - t0,
      duration: Number(wav.duration.toFixed(2)),
      engine: 'whisper',
    }
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

function doAffect(buf, text = '', opts = {}) {
  const { wav, mono } = prepAudio(buf)
  const t0 = Date.now()
  const r = analyzeProsody(mono, 16000, { text })
  if (!r.ok) return { ...r, ms: Date.now() - t0, srcDuration: Number(wav.duration.toFixed(2)) }

  const speaker = opts.speaker ? String(opts.speaker) : ''
  const group = opts.group ? String(opts.group) : ''
  const baseline = baselineOf(speaker)
  const cls = classify(r.features, { baseline, model: affectModel })
  const rel = relativeOf(r.features, baseline)
  if (rel) rel.tailDrop = Number(r.features.tailDrop?.toFixed?.(2) ?? r.features.tailDrop ?? 0)
  const proto = rel ? classifyByPrototypes(rel, prototypes) : null
  // 质心判定优先：它是由真人语料训练出来的，比手写区间准（见 MODEL_FILE 注释）。
  // 每个人的「专属标准」只改一件事：多确定才敢下结论（margin 线）。
  // 算分本身不变，所以调参不会让模型"变形"，只是说话更谨慎/更直接。
  const std = standards.effectiveFor(speaker, { gid: group })
  const modelForSpeaker = centroidModel && std?.thresholds
    ? { ...centroidModel, minMargin: std.thresholds.minMargin, minMarginByLabel: std.thresholds.labelMargin }
    : centroidModel
  const cen = modelForSpeaker && rel ? classifyByCentroid(rel, modelForSpeaker) : null
  const useCentroid = Boolean(cen && cen.ok)
  // 先验库（教科书区间，还没用真实语料校准）比语料库保守得多：
  // 只在"单标签且置信度 ≥0.80"时才敢下结论，否则当平常——宁可不说，也别把她带错方向。
  // 2026-11-08 起不再对"先验库"额外加 0.80 单标签门槛（那会让绝大多数语音被抹成平常，
  // 反而让她失去判断依据）。回到原型库本身的阈值：≥0.72 且领先 0.12 才单标签，其余双标签/平常。
  // 防误报靠 GUARDS（声学证据）+ 双标签（把不确定摊开给她看），不是靠沉默。
  let useProto = Boolean(proto && proto.ok) && !useCentroid
  const rendered = useProto ? renderShort(proto) : null

  // 只在「证据很弱」的普通语音上学习基线：不让极端情绪的样本污染「平时」的样子。
  // 冷启动：前 3 条先当基线样本，判 neutral（rule=bootstrap），第 4 条起才有相对判断。
  let learned = false
  if (speaker && r.features.pitchFrames >= 6 && r.features.speechSeconds >= 1.0) {
    const rows = store.speakers[speaker]?.rows?.length || 0
    // 只让"偏平常"的语音进入基线：不然一条很累的语音会被学成他平时的样子。
    const neutralish = (useCentroid && cen.label === 'neutral') || (!useCentroid && !useProto)
    if (!baseline && rows < 3) {
      learnBaseline(speaker, r.features)
      learned = true
      cls.rule = 'bootstrap'
    } else if (neutralish && r.features.speechSeconds >= 1.2) {
      learnBaseline(speaker, r.features)
      learned = true
    }
  }

  const labelCN = useCentroid ? cen.labelCN : useProto ? LABEL_CN[proto.label] : LABEL_CN[cls.label]
  const result = {
    ...r,
    label: useCentroid ? cen.label : useProto ? proto.label : cls.label,
    labelCN,
    confidence: useCentroid ? cen.confidence : useProto ? proto.confidence : cls.confidence,
    rule: useCentroid ? 'centroid' : useProto ? proto.rule : cls.rule,
    reason: useCentroid ? cen.reason : useProto ? rendered.reason : cls.reason,
    scores: useCentroid ? cen.scores : useProto ? proto.scores : cls.scores,
    relative: rel || cls.relative,
    // 这一条用了谁的判断标准（面板排查用；桥接不读）
    standard: { source: std?.source || 'none', label: std?.standard?.label || '', keywords: std?.standard?.keywords || [] },
    // 区间原型投票的细节（桥接不读，用于面板/排查）
    proto: useProto
      ? {
          id: proto.labels[0].id,
          style: proto.style,
          note: proto.styleNote,
          intensity: proto.intensity,
          band: proto.band,
          labels: proto.labels,
          evidence: proto.evidence,
          hit: proto.hit,
          miss: proto.miss,
          margin: proto.margin,
        }
      : null,
    prototypeSource,
    modelSource,
    centroid: useCentroid
      ? {
          label: cen.label,
          rawLabel: cen.rawLabel ?? null,
          rawLabelCN: cen.rawLabelCN ?? null,
          distance: cen.distance,
          radius: cen.radius,
          margin: cen.margin,
          keys: centroidModel.keys,
        }
      : null,
    // 领先不够、又确实最像某个情绪时，留一句"可能有点 X（不确定）"给桥接用
    hint: useCentroid && cen.rule === 'low_margin' && cen.rawLabel && cen.rawLabel !== 'neutral'
      ? { label: cen.rawLabel, labelCN: cen.rawLabelCN, margin: cen.margin }
      : null,
    baselineSamples: store.speakers[speaker]?.rows?.length || 0,
    learned,
    ms: Date.now() - t0,
    srcDuration: Number(wav.duration.toFixed(2)),
  }
  noteObservation(speaker, result)
  return result
}

// 观察日志：只存数字，不存音频、不存原文。用于「事后标注 → 校准」。
const OBS_FILE = join(DATA_DIR, 'observations.jsonl')
function noteObservation(speaker, affect) {
  try {
    if (existsSync(OBS_FILE) && statSync(OBS_FILE).size > 8 * 1024 * 1024) {
      writeFileSync(OBS_FILE, '')
      log('observations.jsonl 超过 8MB，已轮转清空')
    }
    const row = {
      ts: new Date().toISOString(),
      speaker: speaker || '',
      label: affect.label,
      confidence: affect.confidence,
      rule: affect.rule,
      reason: affect.reason || '',
      duration: affect.srcDuration,
      features: affect.features,
    }
    writeFileSync(OBS_FILE, JSON.stringify(row) + '\n', { flag: 'a' })
  } catch (e) {
    log('WARN observation write failed', String(e.message || e))
  }
}

async function readJsonSafe(req, limit = 64 * 1024) {
  const buf = await readBody(req)
  if (!buf.length) return { ok: true, value: {} }
  if (buf.length > limit) return { ok: false, error: `请求体太大（${buf.length} 字节，上限 ${limit}）` }
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) }
  } catch (e) {
    return { ok: false, error: '请求体不是合法 JSON：' + String((e && e.message) || e) }
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const speaker = url.searchParams.get('speaker') || ''
  const groupParam = url.searchParams.get('group') || ''
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'dsh-ears-svc',
        version: '0.3.0',
        model: MODEL,
        modelPresent: existsSync(MODEL),
        modelBytes: existsSync(MODEL) ? statSync(MODEL).size : 0,
        whisperLoaded: Boolean(whisper),
        engine: ENGINE === 'whisper' ? 'whisper' : (existsSync(PARA_MODEL) ? 'paraformer' : 'whisper'),
        paraformerLoaded: Boolean(paraRec),
        paraformerPresent: existsSync(PARA_MODEL),
        affect: { baselineSpeakers: Object.keys(store.speakers).length, calibrated: Boolean(affectModel), labels: affectModel ? Object.keys(affectModel.classes || {}) : [] },
        prototype: {
          source: prototypeSource,
          version: prototypeSource === 'file' ? (loadJson(PROTOTYPE_FILE, {})?.version ?? 'file') : PRIOR_VERSION,
          count: prototypes.length,
          styles: prototypes.map((p) => p.id),
        },
        model: centroidModel
          ? { source: modelSource, labels: centroidModel.labels, keys: centroidModel.keys, loo: centroidModel.loo?.acc ?? null, radius: centroidModel.radius }
          : { source: 'none' },
        burst: burstModel
          ? { source: burstSource, labels: burstModel.labels, keys: burstModel.keys, loo: burstModel.loo?.acc ?? null, samples: burstModel.n, speakers: burstModel.speakers, license: 'EmoGator CC BY 4.0' }
          : { source: 'none' },
        speaker: 'not_implemented',
        uptimeSec: Math.round(process.uptime()),
      })
    }
    // ---- 听潮 · 判断标准（面板读写；全部只在本机 127.0.0.1）----
    // 省电状态：设置页直接读这个（只读、只在本机）
    if (req.method === 'GET' && url.pathname === '/eco') {
      let eco = false
      try {
        const ecoFile = process.env.EARS_ECO_FILE || '/var/lib/tingchao/eco-state.json'
        const st = JSON.parse(readFileSync(ecoFile, 'utf8'))
        eco = Boolean(st && st.eco)
      } catch {}
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      return res.end(JSON.stringify({ ok: true, eco }))
    }
    if (req.method === 'GET' && url.pathname === '/standards') {
      const info = {}
      for (const [k, v] of Object.entries(store.speakers)) info[k] = { n: v.rows?.length || 0, updatedAt: v.updatedAt }
      return json(res, 200, standards.snapshot(info))
    }
    if (req.method === 'POST' && url.pathname === '/standards') {
      const parsed = await readJsonSafe(req)
      if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error })
      return json(res, 200, standards.upsert(parsed.value))
    }
    if (req.method === 'POST' && url.pathname === '/standards/delete') {
      const parsed = await readJsonSafe(req, 4 * 1024)
      if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error })
      const b = parsed.value || {}
      return json(res, 200, standards.remove(b.gid ? b.gid : b.qq))
    }
    if (req.method === 'GET' && url.pathname === '/standards/derive') {
      const days = Number(url.searchParams.get('days') || 0)
      return json(res, 200, deriveFromObservations(OBS_FILE, speaker, { days: Number.isFinite(days) ? days : 0 }))
    }
    if (req.method === 'GET' && url.pathname === '/prototypes') {
      return json(res, 200, {
        ok: true,
        source: prototypeSource,
        version: prototypeSource === 'file' ? (loadJson(PROTOTYPE_FILE, {})?.version ?? 'file') : PRIOR_VERSION,
        count: prototypes.length,
        prototypes: prototypes.map((p) => ({ id: p.id, emotion: p.emotion, cn: p.cn, style: p.style, ranges: p.ranges, weights: p.weights, note: p.note })),
      })
    }
    if (req.method === 'GET' && url.pathname === '/baselines') {
      const out = {}
      for (const [k, v] of Object.entries(store.speakers)) out[k] = { n: v.rows?.length || 0, updatedAt: v.updatedAt, baseline: baselineOf(k) }
      return json(res, 200, { ok: true, speakers: out })
    }
    if (req.method === 'POST' && url.pathname === '/baseline/reset') {
      if (!speaker) return json(res, 400, { ok: false, error: 'speaker required' })
      delete store.speakers[speaker]
      saveJson(BASELINE_FILE, store)
      return json(res, 200, { ok: true, removed: speaker })
    }
    if (req.method === 'POST' && (url.pathname === '/asr' || url.pathname === '/analyze' || url.pathname === '/affect')) {
      const buf = await readBody(req)
      if (!buf.length) return json(res, 400, { ok: false, error: 'empty body (send wav bytes)' })
      // 超长语音直接回「太长」：ok 仍为 true（这是上限，不是故障）。
      {
        let dur = 0
        try { dur = Number(parseWav(buf).duration.toFixed(2)) } catch { dur = 0 }
        if (MAX_SECONDS > 0 && dur > MAX_SECONDS) {
          return json(res, 200, {
            ok: true, tooLong: true, duration: dur, maxSeconds: MAX_SECONDS,
            asr: { ok: false, text: '', duration: dur },
            affect: { ok: false, rule: 'too_long', duration: dur }
          })
        }
      }
      if (url.pathname === '/affect') {
        return json(res, 200, doAffect(buf, '', { speaker }))
      }
      if (url.pathname === '/analyze') {
        const asr = await serialize(() => doAsr(buf))
        const affect = analyzeMixed(buf, asr, speaker, groupParam)
        return json(res, 200, { ok: true, asr, affect })
      }
      const asr = await serialize(() => doAsr(buf))
      return json(res, 200, { ...asr, affect: analyzeMixed(buf, asr, speaker, groupParam) })
    }
    if (req.method === 'POST' && url.pathname === '/speaker') {
      await readBody(req)
      return json(res, 501, { ok: false, error: 'not_implemented', hint: '声纹模块待装（onnxruntime + CAM++ 27MB）' })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    log('ERROR', req.method, url.pathname, e?.stack || e?.message || String(e))
    return json(res, 500, { ok: false, error: String(e?.message || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`dsh-ears-svc listening on 127.0.0.1:${PORT} model=${MODEL} baselines=${Object.keys(store.speakers).length} calibrated=${Boolean(affectModel)}`)
})

/**
 * 听潮 · 判断标准（standards）
 *
 * 一份「通用标准」+ 每个 QQ 号一份「专属标准」。专属标准可以改：
 *   - 身份标签（主人 / 哥哥 / 妈妈 / 只写 QQ 号）
 *   - 他说话的关键词（大肥鱼对他的印象，写给人看的，不参与算分，但会进面板）
 *   - 判定阈值（每个情绪一条 margin 线：调高 = 更少下结论，调低 = 更容易说）
 *   - 开关
 *
 * 一条语音进来时：先按说话人 QQ 找专属标准；找到且开着就用它，
 * 否则退回通用标准。算分本身不变（还是质心 + 距离闸），变的只是「多确定才敢说」。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const LABELS = ['angry', 'neutral', 'sad']
export const LABEL_CN = { angry: '生气', neutral: '平常', sad: '低落' }

/** 通用标准的默认值：跟现在线上跑的参数一致，改这里等于改全世界。 */
export const DEFAULT_THRESHOLDS = {
  minMargin: 0.18,
  labelMargin: { angry: 0.20, neutral: 0, sad: 0.30 },
}

export function defaultStandard() {
  return {
    id: 'default',
    kind: 'default',
    name: '通用标准',
    label: '陌生人 / 没有专属标准的人',
    keywords: ['正常人说话节奏', '没有专属样本'],
    thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
    enabled: true,
    updatedAt: 0,
  }
}

function cleanThresholds(t = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS))
  const mm = Number(t.minMargin)
  if (Number.isFinite(mm)) out.minMargin = Math.min(0.6, Math.max(0, mm))
  for (const k of LABELS) {
    const v = Number(t.labelMargin?.[k])
    if (Number.isFinite(v)) out.labelMargin[k] = Math.min(0.8, Math.max(0, v))
  }
  return out
}

function cleanKeywords(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12)
}

export function createStandards(file) {
  // people：每个 QQ 一份；groups：每个群一份（群里没有专属标准的人，退到群标准，再退到通用）
  const state = { version: 2, default: defaultStandard(), people: {}, groups: {} }

  function load() {
    try {
      if (!existsSync(file)) return state
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw?.default) {
        state.default = {
          ...defaultStandard(),
          ...raw.default,
          id: 'default',
          kind: 'default',
          thresholds: cleanThresholds(raw.default.thresholds),
          keywords: cleanKeywords(raw.default.keywords),
        }
      }
      if (raw?.people && typeof raw.people === 'object') {
        for (const [qq, p] of Object.entries(raw.people)) {
          state.people[String(qq)] = normalizePerson(qq, p)
        }
      }
      if (raw?.groups && typeof raw.groups === 'object') {
        for (const [gid, g] of Object.entries(raw.groups)) {
          state.groups[String(gid)] = normalizeGroup(gid, g)
        }
      }
    } catch {}
    return state
  }

  function normalizePerson(qq, p = {}) {
    const id = `spk-${qq}`
    return {
      id,
      kind: 'person',
      qq: String(qq),
      name: String(p.name || '').trim().slice(0, 24),
      label: String(p.label || '').trim().slice(0, 24) || `QQ ${qq}`,
      keywords: cleanKeywords(p.keywords),
      note: String(p.note || '').trim().slice(0, 200),
      thresholds: cleanThresholds(p.thresholds),
      enabled: p.enabled !== false,
      updatedAt: Number(p.updatedAt) || 0,
      source: p.source === 'derived' ? 'derived' : 'manual',
    }
  }

  function normalizeGroup(gid, g = {}) {
    return {
      id: `grp-${gid}`,
      kind: 'group',
      gid: String(gid),
      name: String(g.name || '').trim().slice(0, 24) || `群 ${gid}`,
      label: String(g.label || '').trim().slice(0, 24) || '群内通用',
      keywords: cleanKeywords(g.keywords),
      note: String(g.note || '').trim().slice(0, 200),
      thresholds: cleanThresholds(g.thresholds),
      enabled: g.enabled !== false,
      updatedAt: Number(g.updatedAt) || 0,
      source: 'manual',
    }
  }

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
      return true
    } catch (e) {
      return false
    }
  }

  /** 面板用的全景：通用 + 每个人，附「这个人的基线学到几条」。 */
  function snapshot(baselineInfo = {}) {
    return {
      ok: true,
      default: state.default,
      people: Object.values(state.people)
        .map((p) => ({ ...p, baseline: baselineInfo[p.qq] || null }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      groups: Object.values(state.groups).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      updatedAt: Date.now(),
    }
  }

  /** 面板保存：qq 空 = 改通用标准。 */
  function upsert(payload = {}) {
    const now = Date.now()
    const qq = String(payload.qq ?? '').trim()
    const gid0 = String(payload.gid ?? '').trim()
    if ((!qq || qq === 'default') && !gid0) {
      // 改通用标准
      state.default = {
        ...state.default,
        name: String(payload.name || state.default.name).trim().slice(0, 24) || '通用标准',
        label: String(payload.label || state.default.label).trim().slice(0, 24) || '通用',
        keywords: payload.keywords === undefined
          ? state.default.keywords
          : cleanKeywords(typeof payload.keywords === 'string' ? payload.keywords.split(/[\n,，、]+/) : payload.keywords),
        thresholds: payload.thresholds === undefined ? state.default.thresholds : cleanThresholds(payload.thresholds),
        enabled: payload.enabled !== false,
        updatedAt: now,
      }
      save()
      return { ok: true, standard: state.default }
    }
    // 群标准：payload.gid（群号）优先于 qq
    const gid = String(payload.gid ?? '').trim()
    if (gid) {
      if (!/^\d{5,12}$/.test(gid)) return { ok: false, error: '群号格式不对（5–12 位数字）' }
      const prevG = state.groups[gid]
      const nextG = normalizeGroup(gid, {
        ...(prevG || {}),
        ...payload,
        keywords: typeof payload.keywords === 'string'
          ? payload.keywords.split(/[\n,，、]+/)
          : payload.keywords ?? prevG?.keywords,
        updatedAt: now,
      })
      state.groups[gid] = nextG
      save()
      return { ok: true, standard: nextG }
    }
    if (!/^\d{5,12}$/.test(qq)) return { ok: false, error: 'QQ 号格式不对（5–12 位数字）' }
    const prev = state.people[qq]
    const next = normalizePerson(qq, {
      ...(prev || {}),
      ...payload,
      // 关键词如果是字符串（面板里用换行/逗号分隔），拆成数组
      keywords: typeof payload.keywords === 'string'
        ? payload.keywords.split(/[\n,，、]+/)
        : payload.keywords ?? prev?.keywords,
      updatedAt: now,
      source: payload.source === 'derived' ? 'derived' : (prev?.source || 'manual'),
    })
    state.people[qq] = next
    save()
    return { ok: true, standard: next }
  }

  function remove(qq) {
    const k = String(qq || '')
    if (state.people[k]) {
      delete state.people[k]
      save()
      return { ok: true, removed: k, kind: 'person' }
    }
    if (state.groups[k]) {
      delete state.groups[k]
      save()
      return { ok: true, removed: k, kind: 'group' }
    }
    return { ok: false, error: '没有这个人的专属标准' }
  }

  /** 语音分析时用：人 → 群 → 通用。没有任何专属就退回通用。 */
  function effectiveFor(qq, { gid } = {}) {
    const p = qq ? state.people[String(qq)] : null
    if (p && p.enabled) return { standard: p, thresholds: p.thresholds, source: 'person' }
    const g = gid ? state.groups[String(gid)] : null
    if (g && g.enabled) return { standard: g, thresholds: g.thresholds, source: 'group' }
    return { standard: state.default, thresholds: state.default.enabled ? state.default.thresholds : DEFAULT_THRESHOLDS, source: 'default' }
  }

  return { load, save, snapshot, upsert, remove, effectiveFor, normalizePerson, normalizeGroup, cleanThresholds, cleanKeywords, state }
}

/**
 * 从真实观测里「推」一份初稿：只读 data/observations.jsonl，不碰音频。
 * 目的不是替主人拍板，而是让他打开面板时有个能改的起点。
 */
export function deriveFromObservations(obsFile, qq, { minSamples = 5, days = 0 } = {}) {
  const since = days > 0 ? Date.now() - days * 86400_000 : 0
  const target = String(qq || '')
  if (!target) return { ok: false, error: 'qq required' }
  if (!existsSync(obsFile)) return { ok: false, error: '还没有任何观测（data/observations.jsonl 不存在）' }
  const lines = readFileSync(obsFile, 'utf8').split('\n')
  const feats = []
  for (const line of lines) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (String(o.speaker) !== target || !o.features) continue
    if (since && Number(new Date(o.ts)) && new Date(o.ts).getTime() < since) continue
    feats.push(o.features)
  }
  if (feats.length < minSamples) {
    return { ok: false, error: `这个人的语音还太少（${feats.length} 条，至少要 ${minSamples} 条）`, samples: feats.length }
  }
  const med = (arr) => {
    const v = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
    if (!v.length) return null
    return v[Math.floor(v.length / 2)]
  }
  const pitch = med(feats.map((f) => Number(f.pitchHz)))
  const rate = med(feats.map((f) => Number(f.rate)))
  const pause = med(feats.map((f) => Number(f.pauseRatio)))
  const energy = med(feats.map((f) => Number(f.energyDb)))
  const hints = []
  if (rate && rate < 3.6) hints.push('语速偏慢')
  if (pause != null && pause > 0.32) hints.push('停顿偏多')
  if (pitch && pitch < 145) hints.push('嗓音偏低')
  if (energy != null && energy < -22) hints.push('说话偏轻')
  return {
    ok: true,
    qq: target,
    samples: feats.length,
    medians: { pitchHz: pitch, rate, pauseRatio: pause, energyDb: energy },
    keywords: hints.length ? hints : ['说话节奏接近普通人'],
    thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
    note: `根据 ${feats.length} 条真实语音${days > 0 ? `（最近 ${days} 天）` : ''}的说话习惯生成（只统计数字，不含音频）。`,
  }
}

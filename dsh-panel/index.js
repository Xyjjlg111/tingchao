/**
 * dsh-tingchao —— 「听潮」判断标准面板（宿主半边）
 *
 * 只做三件事：
 *  1) 把设置面板的读写转发给本机耳朵服务（127.0.0.1:3098），面板不直接跨端口；
 *  2) 顺手把桥接里的会话/群成员读出来，供「群聊」页显示谁有专属标准；
 *  3) 拿不到东西时回一个空结构，绝不让设置页崩。
 */

import { readFileSync } from 'node:fs'

export const name = 'tingchao'
export const inject = ['webServer']

const EARS = 'http://127.0.0.1:3098'
const ROUTE = '/tingchao-7340'
const SOCIAL = 'F:/qq-bridge/state/social-v2.json'

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

async function earsJson(path, init) {
  try {
    const r = await fetch(EARS + path, { ...init, signal: AbortSignal.timeout(8000) })
    const text = await r.text()
    return JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `耳朵服务没响应：${String((e && e.message) || e)}` }
  }
}

/** 读桥接的会话快照：谁在哪个群、私聊过谁。只读，不写。 */
function bridgeOverview() {
  let j
  try { j = JSON.parse(readFileSync(SOCIAL, 'utf8')) } catch { return { people: [], groups: [] } }
  const conv = j.conversations || {}
  const people = new Map()
  const groups = []
  for (const [key, c] of Object.entries(conv)) {
    const msgs = Array.isArray(c.recentMessages) ? c.recentMessages : []
    const members = new Map()
    for (const m of msgs) {
      const qq = m && m.userId ? String(m.userId) : ''
      if (!qq) continue
      const nm = String(m.sender || '').slice(0, 24)
      if (!members.has(qq)) members.set(qq, nm)
      if (!people.has(qq)) people.set(qq, nm)
    }
    if (key.startsWith('group:')) {
      groups.push({
        key,
        gid: key.slice(6),
        members: [...members.entries()].map(([qq, nm]) => ({ qq, name: nm })),
      })
    }
  }
  return {
    people: [...people.entries()].map(([qq, name]) => ({ qq, name })).sort((a, b) => a.qq.localeCompare(b.qq)),
    groups,
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const rest = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : url.pathname
  try {
    if (rest === '/standards' && req.method === 'GET') {
      return send(res, 200, await earsJson('/standards'))
    }
    if (rest === '/standards' && req.method === 'POST') {
      const body = await readBody(req)
      return send(res, 200, await earsJson('/standards', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }))
    }
    if (rest === '/standards/delete' && req.method === 'POST') {
      const body = await readBody(req)
      return send(res, 200, await earsJson('/standards/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }))
    }
    if (rest === '/derive' && req.method === 'GET') {
      const qq = url.searchParams.get('qq') || ''
      const days = url.searchParams.get('days') || '7'
      return send(res, 200, await earsJson(`/standards/derive?speaker=${encodeURIComponent(qq)}&days=${encodeURIComponent(days)}`))
    }
    if (rest === '/overview' && req.method === 'GET') {
      const ov = bridgeOverview()
      const st = await earsJson('/standards')
      const have = new Set((st.people || []).map((p) => String(p.qq)))
      return send(res, 200, {
        ok: true,
        groups: ov.groups.map((g) => ({
          ...g,
          members: g.members.map((m) => ({ ...m, hasStandard: have.has(m.qq) })),
          withStandard: g.members.filter((m) => have.has(m.qq)).length,
        })),
        people: ov.people,
        standards: st,
      })
    }
    if (rest === '/health') {
      return send(res, 200, await earsJson('/health'))
    }
    return send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
}

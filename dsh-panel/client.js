/**
 * dsh-tingchao —— 「听潮」判断标准面板（浏览器半边）
 *
 * 设置里新增一栏「听潮」，order=32（排在「鱼的心」后面）。
 * 一屏三页：通用标准 / 每个人一张卡 / 群聊里谁有专属标准。
 * 所有编辑都先改本地草稿，点「保存」才写回耳朵服务；写失败只提示，不抛。
 */
;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const React = require('react')
      const { useState, useEffect, useCallback } = React
      const h = React.createElement

      const BASE = '/tingchao-7340'
      const LABELS = [
        { key: 'angry', text: '生气' },
        { key: 'neutral', text: '平常' },
        { key: 'sad', text: '低落' },
      ]

      const card = {
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'rgba(127,127,127,0.04)',
      }
      const row = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }
      const labelS = { fontSize: 12, opacity: 0.66, minWidth: 58 }
      const inputS = {
        fontSize: 13, padding: '4px 8px', borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.3)', background: 'transparent',
        color: 'inherit', minWidth: 120,
      }
      const chipS = {
        display: 'inline-block', fontSize: 12, padding: '2px 8px', borderRadius: 999,
        background: 'rgba(14,165,233,0.14)', border: '1px solid rgba(14,165,233,0.35)',
        marginRight: 6, marginTop: 4,
      }
      const badge = (text, ok) => h('span', {
        key: text + String(ok),
        style: {
          fontSize: 11, padding: '1px 7px', borderRadius: 999, marginLeft: 6,
          background: ok ? 'rgba(34,197,94,0.16)' : 'rgba(127,127,127,0.14)',
          border: `1px solid ${ok ? 'rgba(34,197,94,0.45)' : 'rgba(127,127,127,0.3)'}`,
        },
      }, text)

      const defThresholds = { minMargin: 0.18, labelMargin: { angry: 0.2, neutral: 0, sad: 0.3 } }
      const clone = (o) => JSON.parse(JSON.stringify(o ?? {}))


      function keyOf(std) {
        if (std.kind === 'default') return 'default'
        if (std.kind === 'group') return 'g:' + String(std.gid)
        return String(std.qq)
      }

      /** 一张卡片：通用和个人共用，只是个人多一个删除按钮。 */
      function StdCard({ std, draft, onEdit, onSave, onDelete, saving }) {
        const t = draft.thresholds || defThresholds
        const kw = Array.isArray(draft.keywords) ? draft.keywords : String(draft.keywords || '').split(/[\s,，、]+/).filter(Boolean)
        return h('div', { style: card }, [
          h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
            h('div', { key: 'n', style: { fontSize: 15, fontWeight: 600 } }, draft.label || draft.name || (std.kind === 'group' ? `群 ${std.gid}` : `QQ ${std.qq || ''}`)),
            std.kind === 'default' ? badge('默认 · 所有人', true)
              : std.kind === 'group' ? badge(draft.enabled === false ? '已关闭' : '群专属', draft.enabled !== false)
                : badge(draft.enabled === false ? '已关闭' : '个人专属', draft.enabled !== false),
            std.kind === 'person' ? h('span', { key: 'q', style: { fontSize: 12, opacity: 0.55 } }, `QQ ${std.qq}`)
              : std.kind === 'group' ? h('span', { key: 'q', style: { fontSize: 12, opacity: 0.55 } }, `群 ${std.gid}`) : null,
            std.baseline ? h('span', { key: 'b', style: { fontSize: 12, opacity: 0.55 } }, `已学 ${std.baseline.n || 0} 条基线`) : null,
          ]),
          h('div', { key: 'meta', style: row }, [
            h('span', { key: 'l1', style: labelS }, '身份标签'),
            h('input', {
              key: 'i1', style: inputS, value: draft.label || '', placeholder: std.kind === 'group' ? '家里人 / 同事群（可空）' : '哥哥（主人）或 QQ 号',
              onChange: (e) => onEdit({ label: e.target.value }),
            }),
            std.kind !== 'default'
              ? h('input', {
                key: 'i2', style: inputS, value: draft.name || '', placeholder: '昵称（可空）',
                onChange: (e) => onEdit({ name: e.target.value }),
              })
              : null,
            h('label', { key: 'sw', style: { fontSize: 12, opacity: 0.8, marginLeft: 'auto' } }, [
              h('input', { key: 'c', type: 'checkbox', checked: draft.enabled !== false, onChange: (e) => onEdit({ enabled: e.target.checked }) }),
              ' 启用',
            ]),
          ]),
          h('div', { key: 'kw', style: { marginTop: 8 } }, [
            h('div', { key: 't', style: { fontSize: 12, opacity: 0.66 } }, '对他的印象关键词（大肥鱼写，最重要的参考）'),
            h('div', { key: 'c', style: { marginTop: 4 } }, kw.length
              ? kw.map((k, i) => h('span', { key: k + i, style: chipS }, k))
              : h('span', { key: 'none', style: { fontSize: 12, opacity: 0.45 } }, '还没有关键词')),
            h('input', {
              key: 'edit', style: { ...inputS, width: '100%', marginTop: 6 }, value: kw.join('，'),
              placeholder: '用逗号分隔，例如：宿舍里压着嗓子，熬夜写代码，累也不说',
              onChange: (e) => onEdit({ keywords: e.target.value.split(/[\s,，、]+/).filter(Boolean) }),
            }),
          ]),
          h('div', { key: 'th', style: { marginTop: 10 } }, [
            h('div', { key: 't', style: { fontSize: 12, opacity: 0.66 } }, '判定门槛（越高越谨慎，越不容易给结论）'),
            h('div', { key: 'mm', style: row }, [
              h('span', { key: 'l', style: labelS }, '总门槛'),
              h('input', {
                key: 'r', type: 'range', min: 0, max: 0.5, step: 0.01, value: t.minMargin,
                onChange: (e) => onEdit({ thresholds: { ...t, minMargin: Number(e.target.value) } }),
                style: { flex: 1, maxWidth: 220 },
              }),
              h('span', { key: 'v', style: { fontSize: 12, width: 34 } }, Number(t.minMargin).toFixed(2)),
            ]),
            ...LABELS.filter((x) => x.key !== 'neutral').map((x) => h('div', { key: x.key, style: row }, [
              h('span', { key: 'l', style: labelS }, x.text),
              h('input', {
                key: 'r', type: 'range', min: 0, max: 0.8, step: 0.01,
                value: Number(t.labelMargin?.[x.key] ?? 0.2),
                onChange: (e) => onEdit({ thresholds: { ...t, labelMargin: { ...t.labelMargin, [x.key]: Number(e.target.value) } } }),
                style: { flex: 1, maxWidth: 220 },
              }),
              h('span', { key: 'v', style: { fontSize: 12, width: 34 } }, Number(t.labelMargin?.[x.key] ?? 0.2).toFixed(2)),
            ])),
          ]),
          h('div', { key: 'act', style: { ...row, justifyContent: 'flex-end' } }, [
            std.kind !== 'default' && !std._novel
              ? h('button', {
                key: 'del', type: 'button', onClick: onDelete, disabled: saving,
                style: { ...btn(false) }, children: '删除',
              })
              : null,
            h('button', {
              key: 'save', type: 'button', onClick: onSave, disabled: saving,
              style: { ...btn(true) }, children: saving ? '保存中…' : '保存',
            }),
          ]),
        ])
      }

      function btn(primary) {
        return {
          fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
          color: primary ? '#fff' : 'inherit',
          background: primary ? 'rgba(14,165,233,0.9)' : 'transparent',
          border: primary ? '1px solid rgba(14,165,233,0.9)' : '1px solid rgba(127,127,127,0.35)',
        }
      }

      function Panel() {
        const [tab, setTab] = useState('default')
        const [snap, setSnap] = useState(null)
        const [ov, setOv] = useState(null)
        const [drafts, setDrafts] = useState({})
        const [busy, setBusy] = useState('')
        const [msg, setMsg] = useState('')
        const [newQq, setNewQq] = useState('')
        const [newLabel, setNewLabel] = useState('')
        const [newGid, setNewGid] = useState('')
        const [eco, setEco] = useState(false)

        const load = useCallback(async () => {
          try {
            const [a, b] = await Promise.all([
              fetch(`${BASE}/standards`, { cache: 'no-store' }).then((r) => r.json()),
              fetch(`${BASE}/overview`, { cache: 'no-store' }).then((r) => r.json()),
            ])
            if (a?.ok) setSnap(a)
            if (b?.ok) setOv(b)
            try {
              const e = await fetch('http://127.0.0.1:3098/eco', { cache: 'no-store' }).then((r) => r.json())
              setEco(Boolean(e?.eco))
            } catch { setEco(false) }
          } catch (e) {
            setMsg('读不到耳朵服务：' + String((e && e.message) || e))
          }
        }, [])

        useEffect(() => { load() }, [load])

        // 省电开关不在本页触发：每 20 秒问一次 /eco，面板自己切换成「已暂停」/恢复卡片。
        // 只在设置页打开时跑，关掉就不发请求。
        useEffect(() => {
          const t = setInterval(async () => {
            try {
              const e = await fetch('http://127.0.0.1:3098/eco', { cache: 'no-store' }).then((r) => r.json())
              const next = Boolean(e?.eco)
              setEco((prev) => {
                if (prev !== next && !next) load()   // 刚从省电回来：顺手刷新数据
                return next
              })
            } catch {}
          }, 20000)
          return () => clearInterval(t)
        }, [load])

        function draftFor(std) {
          const k = keyOf(std)
          return drafts[k] || clone(std)
        }
        function edit(key, patch) {
          setDrafts((d) => ({ ...d, [key]: { ...(d[key] || {}), ...patch } }))
        }
        async function save(std) {
          const k = keyOf(std)
          const body = draftFor(std)
          setBusy(k)
          setMsg('')
          try {
            const r = await fetch(`${BASE}/standards`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(std.kind === 'group'
                ? { ...body, gid: std.gid }
                : { ...body, qq: std.kind === 'default' ? 'default' : std.qq }),
            }).then((x) => x.json())
            if (r?.ok) {
              setMsg(`已保存：${r.standard?.label || r.standard?.name || k}`)
              setDrafts((d) => { const n = { ...d }; delete n[k]; return n })
              await load()
            } else setMsg('保存失败：' + (r?.error || '未知错误'))
          } catch (e) {
            setMsg('保存失败：' + String((e && e.message) || e))
          } finally { setBusy('') }
        }
        async function remove(std) {
          const k = keyOf(std)
          setBusy(k)
          try {
            const r = await fetch(`${BASE}/standards/delete`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(std.kind === 'group' ? { gid: std.gid } : { qq: std.qq }),
            }).then((x) => x.json())
            setMsg(r?.ok
              ? (std.kind === 'group' ? `已删除群 ${std.gid} 的标准` : `已删除 QQ ${std.qq} 的专属标准`)
              : '删除失败：' + (r?.error || ''))
            if (r?.ok) setDrafts((d) => { const n = { ...d }; delete n[k]; return n })
            await load()
          } finally { setBusy('') }
        }
        async function derive() {
          const qq = String(newQq || '').trim()
          if (!/^\d{5,12}$/.test(qq)) { setMsg('先填一个 5–12 位 QQ 号'); return }
          setBusy('derive')
          try {
            const r = await fetch(`${BASE}/derive?qq=${qq}&days=7`, { cache: 'no-store' }).then((x) => x.json())
            if (!r?.ok) { setMsg('生成初稿失败：' + (r?.error || '')); return }
            setDrafts((d) => ({
              ...d,
              [qq]: {
                kind: 'person', qq, name: '', label: newLabel || `QQ ${qq}`,
                keywords: r.keywords || [], thresholds: r.thresholds || defThresholds,
                enabled: true, note: r.note || '', source: 'derived',
              },
            }))
            setMsg(`已按最近 7 天的 ${r.samples} 条真实语音生成初稿，确认后点保存`)
          } catch (e) {
            setMsg('生成初稿失败：' + String((e && e.message) || e))
          } finally { setBusy('') }
        }

        const tabBtn = (k, text) => h('button', {
          key: k, type: 'button', onClick: () => setTab(k),
          style: {
            ...btn(tab === k), marginRight: 8, marginBottom: 8,
            background: tab === k ? 'rgba(14,165,233,0.9)' : 'transparent',
            color: tab === k ? '#fff' : 'inherit',
          },
        }, text)

        if (eco) {
          // 省电模式：耳朵服务被主动关掉，这里不报错，直接说清楚「停了、怎么恢复」。
          return h('div', { style: card }, [
            h('div', { key: 't', style: { fontSize: 15, fontWeight: 600 } }, '省电模式中 · 听潮已暂停'),
            h('div', { key: 'd', style: { fontSize: 13, opacity: 0.75, marginTop: 8, lineHeight: 1.9 } },
              '省电时会整个关掉语音（3098 停跑、不占 CPU）。插电或用盖打开后自动恢复，标准与关键词都不会丢。'),
            h('div', { key: 'b', style: { marginTop: 10 } }, [
              h('button', { key: 'r', type: 'button', onClick: load, style: btn(false) }, '再查一次'),
            ]),
          ])
        }

        if (!snap) {
          return h('div', { style: { padding: '8px 4px', fontSize: 13, opacity: 0.7 } },
            msg || '正在读听潮的判断标准…（耳朵服务 3098 没起来时会一直是这句）')
        }

        const people = snap.people || []
        const extra = Object.keys(drafts).filter((k) => k !== 'default' && !k.startsWith('g:') && !people.some((p) => String(p.qq) === k))

        return h('div', { style: { padding: '4px 2px' } }, [
          h('div', { key: 'title', style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 } }, [
            h('div', { key: 't', style: { fontSize: 16, fontWeight: 600 } }, '听潮 · 判断标准'),
            h('div', { key: 's', style: { fontSize: 12, opacity: 0.55 } }, '声音先归一到「他自己平时」，再决定多确定才敢说'),
            h('button', {
              key: 'r', type: 'button', onClick: load, style: { ...btn(false), marginLeft: 'auto', fontSize: 12 },
            }, '刷新'),
          ]),
          h('div', { key: 'tabs' }, [tabBtn('default', '通用标准'), tabBtn('people', `个人（${people.length}）`), tabBtn('groups', '群聊')]),
          msg ? h('div', { key: 'msg', style: { fontSize: 12, margin: '4px 0 10px', opacity: 0.8 } }, msg) : null,

          tab === 'default'
            ? h(StdCard, {
              key: 'd', std: snap.default, draft: draftFor(snap.default),
              onEdit: (p) => edit('default', p), onSave: () => save(snap.default), saving: busy === 'default',
            })
            : null,

          tab === 'people'
            ? h('div', { key: 'p' }, [
              h('div', { key: 'add', style: { ...card, borderStyle: 'dashed' } }, [
                h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, '加一个人'),
                h('div', { key: 'r', style: row }, [
                  h('span', { key: 'l', style: labelS }, 'QQ 号'),
                  h('input', {
                    key: 'i', style: inputS, value: newQq, placeholder: '例如 1000000000',
                    onChange: (e) => setNewQq(e.target.value.replace(/[^\d]/g, '')),
                  }),
                  h('span', { key: 'l2', style: labelS }, '身份'),
                  h('input', {
                    key: 'i2', style: inputS, value: newLabel, placeholder: '哥哥（主人）/ 只写 QQ 也行',
                    onChange: (e) => setNewLabel(e.target.value),
                  }),
                  h('button', { key: 'b', type: 'button', onClick: derive, disabled: busy === 'derive', style: btn(false) },
                    busy === 'derive' ? '生成中…' : '按最近语音生成初稿'),
                ]),
                h('div', { key: 'hint', style: { fontSize: 12, opacity: 0.55, marginTop: 6 } },
                  '初稿只统计他说话的节奏（语速/停顿/音高），不含音频；关键词要你自己补，或等大肥鱼看过聊天后写。'),
              ]),
              ...people.map((p) => h(StdCard, {
                key: p.qq, std: p, draft: draftFor(p),
                onEdit: (patch) => edit(String(p.qq), patch),
                onSave: () => save(p), onDelete: () => remove(p),
                saving: busy === String(p.qq),
              })),
              ...extra.map((qq) => h(StdCard, {
                key: 'new-' + qq,
                std: { kind: 'person', qq },
                draft: drafts[qq], onEdit: (patch) => edit(qq, patch),
                onSave: () => save({ kind: 'person', qq }), saving: busy === qq,
              })),
              people.length === 0 && extra.length === 0
                ? h('div', { key: 'empty', style: { fontSize: 13, opacity: 0.6, padding: 8 } },
                  '还没有专属标准——所有人现在都用「通用标准」。')
                : null,
            ])
            : null,

          tab === 'groups'
            ? h('div', { key: 'g' }, [
              h('div', { key: 'hint', style: { fontSize: 12, opacity: 0.6, marginBottom: 8 } },
                '判定顺序：这个人有「个人专属」→ 用个人的；没有 → 用这个群的；再没有 → 通用标准。'),
              ...((ov?.groups) || []).map((g) => {
                const gStd = (snap?.groups || []).find((x) => String(x.gid) === String(g.gid))
                const std = gStd || { kind: 'group', gid: g.gid, name: '', _novel: true }
                const k = keyOf(std)
                return h('div', { key: 'gg-' + g.gid, style: card }, [
                  h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
                    h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, '群 ' + g.gid),
                    h('span', { key: 'c', style: { fontSize: 12, opacity: 0.55 } },
                      `${g.members.length} 人 · ${g.withStandard} 人有个人专属`),
                    gStd ? badge(gStd.enabled === false ? '群标准已关' : '群专属', gStd.enabled !== false) : badge('未设群标准', false),
                  ]),
                  h('div', { key: 'm', style: { marginTop: 6, fontSize: 13, lineHeight: 2 } },
                    g.members.length
                      ? g.members.map((m) => h('span', {
                        key: m.qq, style: { marginRight: 14, opacity: m.hasStandard ? 1 : 0.62 },
                      }, `${m.name || m.qq}(${m.qq})${m.hasStandard ? ' · 个人' : ' · 随群'}`))
                      : h('span', { key: 'e', style: { opacity: 0.5 } }, '最近没有消息，看不到成员')),
                  h(StdCard, {
                    key: 'card-' + g.gid,
                    std,
                    draft: draftFor(std),
                    onEdit: (patch) => edit(k, patch),
                    onSave: () => save(std),
                    onDelete: () => remove(std),
                    saving: busy === k,
                  }),
                ])
              }),
              ((ov?.groups) || []).length === 0
                ? h('div', { key: 'e', style: { fontSize: 13, opacity: 0.6 } }, '桥接里还没有群会话记录。')
                : null,
              h('div', { key: 'addg', style: card }, [
                h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 } }, '加一个群'),
                h('div', { key: 'r', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } }, [
                  h('input', {
                    key: 'i', style: inputS, value: newGid, placeholder: '群号（5–12 位数字）',
                    onChange: (e) => setNewGid(e.target.value.replace(/\D/g, '')),
                  }),
                  h('button', {
                    key: 'b', type: 'button', style: btn(true),
                    onClick: () => {
                      const gid = String(newGid || '').trim()
                      if (!/^\d{5,12}$/.test(gid)) { setMsg('群号要 5–12 位数字'); return }
                      setDrafts((d) => ({ ...d, ['g:' + gid]: { kind: 'group', gid, name: '', keywords: [], thresholds: defThresholds, enabled: true } }))
                      setMsg('已加草稿：群 ' + gid + '，填好后点保存')
                    },
                    children: '加进来',
                  }),
                ]),
                h('div', { key: 'h', style: { fontSize: 11, opacity: 0.5, marginTop: 6 } },
                  '不在桥接会话里的群也能先设好，等它有语音自动生效。'),
              ]),
            ])
            : null,

          h('div', { key: 'foot', style: { fontSize: 11, opacity: 0.5, marginTop: 12, lineHeight: 1.8 } }, [
            h('div', { key: 'f1' }, '判定顺序：转写 → 声学特征 → 按人基线归一 → 质心判定 → 用这个人的门槛决定「说/不说」。'),
            h('div', { key: 'f2' }, '通用标准影响所有没有专属标准的人；一个人的专属标准只影响他自己。'),
          ]),
        ])
      }

      const name = 'tingchao-panel'
      const inject = ['slots']

      function apply(ctx) {
        try {
          ctx.slots.inject('settings.section', function* () {
            yield ctx.slots.register({
              name: 'settings.section',
              id: 'tingchao',
              order: 32,
              label: () => '听潮',
              inject: () => ({}),
            }, Panel)
          })
        } catch (error) {
          console.warn('[dsh-tingchao] 设置节注册失败：' + String((error && error.message) || error))
        }
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  try {
    window.__ModuleLoader__.load({ id: 'dsh-tingchao', factory: makeFactory() })
  } catch (error) {
    console.warn('[dsh-tingchao] client 加载失败：' + String((error && error.message) || error))
  }
})()

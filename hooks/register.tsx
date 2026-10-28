import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Board, Msg, Swarm } from '../types'

const PANE = 'swarm-board'
const SERVER = 'claude-code-remote'
const REFRESH_MS = 90_000
const SESSION_PAGES = 3 // 100 sessions per page
const EVENT_PAGES = 40 // first scan of one transcript, 100 events per page

const swarms = atom({ plugin: 'swarm-board', key: 'swarms' } as const, [], { shape: 'swarms-1' })
const selected = atom({ plugin: 'swarm-board', key: 'selected' } as const, '')
const tab = atom({ plugin: 'swarm-board', key: 'tab' } as const, 'agents')
const board = atom({ plugin: 'swarm-board', key: 'board' } as const, { agents: [], messages: [], updatedAt: '' }, { shape: 'board-1' })

type Session = {
  id: string
  title?: string
  status_bucket?: string
  parent_session_id?: string
  updated_at: string
  post_turn_summary?: { recent_action?: string }
}
type Page<T> = { data: T[]; has_more: boolean; first_id?: string; last_id?: string }

// Module state: rebuilt from scratch after a reload.
const cursors = new Map<string, string>() // session id -> newest event id read
const seen = new Map<string, Msg>() // tool_use id -> message
let busy = false

async function call<T>($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = await $.mcp.call(SERVER, tool, args)
  const text = r.content.map(b => b.text ?? '').join('')
  if (r.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`)
  const i = text.indexOf('{"ccr"')
  const j = text.lastIndexOf('}')
  if (i < 0 || j < i) throw new Error(`${tool}: no ccr JSON in ${text.slice(0, 300)}`)
  return JSON.parse(text.slice(i, j + 1)).ccr
}

const bucket = (s?: string) => (s ?? 'unknown').replace('SESSION_STATUS_BUCKET_', '').toLowerCase()

async function listSessions($: EngineInterface): Promise<Session[]> {
  const out: Session[] = []
  let after: string | undefined
  for (let p = 0; p < SESSION_PAGES; p++) {
    const page = await call<Page<Session>>($, 'list_sessions', { mine: true, limit: 100, ...(after ? { after_id: after } : {}) })
    out.push(...page.data)
    if (!page.has_more) break
    after = page.last_id
  }
  return out
}

function harvest(sid: string, events: { created_at: string; assistant?: any }[]) {
  for (const ev of events) {
    const a = ev.assistant
    if (!a) continue
    const content = (a.internal_anthropic_catchall ?? a).message?.content ?? []
    for (const b of content) {
      if (b.type !== 'tool_use' || seen.has(b.id)) continue
      if (b.name.endsWith('__send_message'))
        seen.set(b.id, { key: b.id, at: ev.created_at, from: sid, to: b.input.session_id ?? b.input.to ?? '?', text: b.input.message ?? '' })
      else if (b.name.endsWith('__create_session'))
        seen.set(b.id, { key: b.id, at: ev.created_at, from: sid, to: `new: ${b.input.title ?? '?'}`, text: b.input.prompt ?? '' })
    }
  }
}

async function scanEvents($: EngineInterface, sid: string) {
  const base = { session_id: sid, kinds: ['assistant'], limit: 100 }
  const last = cursors.get(sid)
  if (last) {
    let after = last
    for (;;) {
      const page = await call<Page<any>>($, 'list_events', { ...base, after_id: after })
      harvest(sid, page.data)
      if (page.last_id) after = page.last_id
      if (!page.has_more) break
    }
    cursors.set(sid, after)
    return
  }
  let page = await call<Page<any>>($, 'list_events', base)
  if (page.last_id) cursors.set(sid, page.last_id)
  harvest(sid, page.data)
  for (let p = 1; p < EVENT_PAGES && page.has_more; p++) {
    page = await call<Page<any>>($, 'list_events', { ...base, before_id: page.first_id })
    harvest(sid, page.data)
  }
}

async function refresh($: EngineInterface) {
  if (busy) return
  busy = true
  try {
    const sessions = await listSessions($)
    const kids = new Map<string, Session[]>()
    for (const s of sessions) if (s.parent_session_id) kids.set(s.parent_session_id, [...(kids.get(s.parent_session_id) ?? []), s])

    const roots = [...kids.keys()].filter(id => !sessions.find(s => s.id === id)?.parent_session_id)
    const byId = new Map(sessions.map(s => [s.id, s]))
    for (const id of roots) if (!byId.has(id)) byId.set(id, await call<Session>($, 'get_session', { session_id: id }))
    const found: Swarm[] = roots
      .map(id => byId.get(id)!)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(s => ({ id: s.id, title: s.title ?? s.id, workers: kids.get(s.id)!.length }))
    await update($, swarms, () => found)

    let sel = await read($, selected)
    if (!sel || !found.some(s => s.id === sel)) {
      sel = found[0]?.id ?? ''
      await update($, selected, () => sel)
    }
    if (!sel) return

    const agents: Agent[] = []
    const walk = (s: Session, depth: number) => {
      agents.push({ id: s.id, title: s.title ?? s.id, status: bucket(s.status_bucket), summary: s.post_turn_summary?.recent_action ?? '', depth, parent: s.parent_session_id ?? null })
      for (const k of kids.get(s.id) ?? []) walk(k, depth + 1)
    }
    walk(byId.get(sel)!, 0)
    assert(agents[0]!.depth === 0, 'manager must be first')

    for (const a of agents) await scanEvents($, a.id)
    const ids = new Set(agents.map(a => a.id))
    const messages = [...seen.values()].filter(m => ids.has(m.from)).sort((x, y) => x.at.localeCompare(y.at))
    await update($, board, () => ({ agents, messages, updatedAt: new Date().toISOString() }))
  } finally {
    busy = false
  }
}

function assert(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Error(`swarm-board: ${msg}`)
}

const GLYPH: Record<string, [string, string]> = {
  working: ['●', 'green'],
  blocked: ['■', 'yellow'],
  review_ready: ['◆', 'cyan'],
  completed: ['✓', 'gray'],
  failed: ['✗', 'red'],
}
const hhmm = (iso: string) => iso.slice(11, 16)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swarm', description: 'Open the swarm board (manager, workers, messages)' })
    void $.ui.open({ id: PANE, title: 'Swarm' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'swarm' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Swarm' })
    void refresh($)
    return { text: 'Swarm board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, swarms)
    const sel = await read($, selected)
    const view = await read($, tab)
    const b = await read($, board)
    const rows = Math.max(6, (e.viewport?.rows ?? 30) - 8)
    const name = new Map(b.agents.map(a => [a.id, a.depth === 0 ? 'MANAGER' : a.title]))
    const pick = (id: string) => () => {
      void update($, selected, () => id)
      void update($, board, () => ({ agents: [], messages: [], updatedAt: '' }))
      void refresh($)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {list.slice(0, 8).map(s => (
            <Button key={`s-${s.id}`} variant={s.id === sel ? 'primary' : 'secondary'} onPress={pick(s.id)}>
              {s.title} <Text dimColor>{s.workers}w</Text>
            </Button>
          ))}
          {list.length === 0 && <Text dimColor>{b.updatedAt ? 'No sessions with workers found.' : 'Loading…'}</Text>}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="t-agents" variant={view === 'agents' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'agents')}>
            Agents {b.agents.length}
          </Button>
          <Button key="t-msgs" variant={view === 'messages' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'messages')}>
            Messages {b.messages.length}
          </Button>
          <Button key="refresh" plain onPress={() => void refresh($)}>↻</Button>
          <Text dimColor>{b.updatedAt ? `updated ${hhmm(b.updatedAt)}Z` : 'loading…'}</Text>
        </Box>
        {view === 'agents' ? (
          <Box flexDirection="column">
            {b.agents.map(a => {
              const [g, c] = GLYPH[a.status] ?? ['○', 'gray']
              return (
                <Box key={`a-${a.id}`} flexDirection="column" paddingLeft={a.depth * 2} marginBottom={a.depth === 0 ? 1 : 0}>
                  <Text wrap="truncate-end">
                    <Text color={c}>{g}</Text> {a.depth === 0 ? <Text bold color="magenta">MANAGER </Text> : ''}
                    <Text bold={a.depth === 0}>{a.title}</Text> <Text dimColor>{a.status}</Text>
                  </Text>
                  {a.summary !== '' && <Text dimColor wrap="truncate-end">  {a.summary}</Text>}
                </Box>
              )
            })}
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            {b.messages.length === 0 && <Text dimColor>No messages between these sessions yet.</Text>}
            {b.messages.slice(-Math.floor(rows / 3)).map(m => (
              <Box key={`m-${m.key}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text dimColor>{hhmm(m.at)}</Text> <Text bold color={name.get(m.from) === 'MANAGER' ? 'magenta' : 'cyan'}>{name.get(m.from) ?? m.from}</Text>
                  {' → '}
                  <Text bold>{name.get(m.to) ?? m.to}</Text>
                </Text>
                <Text>{m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

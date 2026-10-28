import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Agent, Board, Msg, Part, Posts, Swarm } from '../types'

const PANE = 'swarm-board'
const SERVER = 'claude-code-remote'
const GITHUB = 'github'
const SVG_MAX = 131_072 // Svg element's source limit
const REFRESH_MS = 90_000
const MAX_SESSIONS = 300
const MAX_PAGES = 80 // first scan of one transcript, pages read before the filter

const swarms = atom({ plugin: 'swarm-board', key: 'swarms' } as const, [], { shape: 'swarms-1' })
const selected = atom({ plugin: 'swarm-board', key: 'selected' } as const, '')
const tab = atom({ plugin: 'swarm-board', key: 'tab' } as const, 'agents')
const board = atom({ plugin: 'swarm-board', key: 'board' } as const, { agents: [], messages: [], updatedAt: '' }, { shape: 'board-2' })
const posts = atom({ plugin: 'swarm-board', key: 'posts' } as const, { where: '', perf: [], tests: [] }, { shape: 'posts-2' })

type Session = {
  id: string
  title?: string
  status_bucket?: string
  parent_session_id?: string
  updated_at: string
  post_turn_summary?: { recent_action?: string; needs_action?: string }
  session_context?: { outcomes?: { git_repository?: { git_info?: { repo: string; branches: string[] } } }[] }
}
// `data` is left out when a kinds filter kept nothing from the page read (has_more may still be true).
type Page<T> = { data?: T[]; has_more: boolean; first_id?: string; last_id?: string }

// Module state: rebuilt from scratch after a reload.
const cursors = new Map<string, string>() // session id -> newest event id read
const seen = new Map<string, Msg>() // tool_use id -> message
let running: Promise<void> | null = null // the refresh in flight, shared by every caller
let lastError = '' // shown in the board until a refresh succeeds

// Page size per tool that last fit in one tool result.
const fits = new Map<string, number>()

async function call<T>($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<T> {
  if (typeof args.limit === 'number') args = { ...args, limit: Math.min(args.limit, fits.get(tool) ?? args.limit) }
  const r = await $.mcp.call(SERVER, tool, args)
  const text = r.content.map(b => b.text ?? '').join('')
  // A page too large for one tool result comes back as this note: ask for half as many.
  const limit = args.limit as number | undefined
  if (text.includes('exceeds maximum allowed tokens') && limit && limit > 1) {
    fits.set(tool, Math.floor(limit / 2))
    return call($, tool, args)
  }
  if (r.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`)
  const i = text.indexOf('{"ccr"')
  const j = text.lastIndexOf('}')
  if (i < 0 || j < i) throw new Error(`${tool}: no ccr JSON in ${text.slice(0, 300)}`)
  return JSON.parse(text.slice(i, j + 1)).ccr
}

// A file on GitHub, or null when it is not there yet. Any other failure throws.
async function ghFile($: EngineInterface, repo: string, branch: string, path: string): Promise<string | null> {
  const [owner, name] = repo.split('/')
  assert(!!owner && !!name, `bad repo ${repo}`)
  const r = await $.mcp.call(GITHUB, 'get_file_contents', { owner, repo: name, path, ref: `refs/heads/${branch}` })
  const texts = r.content.map(b => b.text ?? (b.resource as { text?: string } | undefined)?.text ?? '')
  if (r.isError) {
    if (texts.join('').includes('does not exist')) return null
    throw new Error(`get_file_contents ${repo}@${branch}:${path}: ${texts.join('').slice(0, 300)}`)
  }
  const body = r.content.find(b => b.type === 'resource')
  assert(!!body, `no file body for ${path}`)
  return (body.resource as { text: string }).text
}

// Splits markdown on lines that are just `![alt](x.svg)`, fetching each SVG next to the file.
async function postFile($: EngineInterface, repo: string, branch: string, path: string): Promise<Part[]> {
  const md = await ghFile($, repo, branch, path)
  if (md === null) return []
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const parts: Part[] = []
  let buf: string[] = []
  const flush = () => { if (buf.join('').trim()) parts.push({ kind: 'md', text: buf.join('\n') }); buf = [] }
  for (const line of md.split('\n')) {
    const m = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+\.svg)\)$/)
    if (!m || m[2]!.includes('://')) { buf.push(line); continue }
    flush()
    const svg = await ghFile($, repo, branch, dir + m[2]!.replace(/^\.\//, ''))
    if (svg === null) parts.push({ kind: 'md', text: `_missing plot: ${m[2]}_` })
    else if (svg.length > SVG_MAX) parts.push({ kind: 'md', text: `_plot too large (${svg.length} chars > ${SVG_MAX}): ${m[2]}_` })
    else parts.push({ kind: 'svg', alt: m[1] || m[2]!, source: svg, url: `https://github.com/${repo}/blob/${branch}/${dir}${m[2]!.replace(/^\.\//, '')}` })
  }
  flush()
  return parts
}

const bucket = (s?: string) => (s ?? 'unknown').replace('SESSION_STATUS_BUCKET_', '').toLowerCase()

async function listSessions($: EngineInterface): Promise<Session[]> {
  const out: Session[] = []
  let after: string | undefined
  while (out.length < MAX_SESSIONS) {
    const page = await call<Page<Session>>($, 'list_sessions', { mine: true, limit: 50, ...(after ? { after_id: after } : {}) })
    assert(!!page.data, 'list_sessions: page without data')
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
  const base = { session_id: sid, kinds: ['assistant'], limit: 25 }
  const last = cursors.get(sid)
  if (last) {
    let after = last
    for (;;) {
      const page = await call<Page<any>>($, 'list_events', { ...base, after_id: after })
      harvest(sid, page.data ?? [])
      if (page.last_id) after = page.last_id
      if (!page.has_more) break
    }
    cursors.set(sid, after)
    return
  }
  let page = await call<Page<any>>($, 'list_events', base)
  if (page.last_id) cursors.set(sid, page.last_id)
  harvest(sid, page.data ?? [])
  for (let n = 1; n < MAX_PAGES && page.has_more; n++) {
    assert(!!page.first_id, `list_events ${sid}: has_more without first_id`)
    page = await call<Page<any>>($, 'list_events', { ...base, before_id: page.first_id })
    harvest(sid, page.data ?? [])
  }
}

function refresh($: EngineInterface): Promise<void> {
  running ??= refreshOnce($)
    .then(() => { lastError = '' })
    .catch((err: unknown) => {
      lastError = String(err)
      throw err
    })
    .finally(() => { running = null })
  return running
}

async function refreshOnce($: EngineInterface) {
  {
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
      agents.push({ id: s.id, title: s.title ?? s.id, status: bucket(s.status_bucket), summary: s.post_turn_summary?.recent_action ?? '', depth, parent: s.parent_session_id ?? null, updated: s.updated_at, needs: s.post_turn_summary?.needs_action ?? '' })
      for (const k of kids.get(s.id) ?? []) walk(k, depth + 1)
    }
    const manager = await call<Session>($, 'get_session', { session_id: sel })
    const git = manager.session_context?.outcomes?.[0]?.git_repository?.git_info
    walk(byId.get(sel)!, 0)
    assert(agents[0]!.depth === 0, 'manager must be first')

    // Show the tree before the (slow, first-time) transcript scans.
    await update($, board, old => ({ ...old, agents, updatedAt: new Date().toISOString() }))
    const ids = new Set(agents.map(a => a.id))
    const messagesNow = () => [...seen.values()].filter(m => ids.has(m.from)).sort((x, y) => x.at.localeCompare(y.at))
    // Save after each transcript, so a reader that cannot wait (the snapshot tool) gets what is loaded so far.
    for (const a of agents) {
      await scanEvents($, a.id)
      await update($, board, old => ({ ...old, messages: messagesNow() }))
    }
    await update($, board, () => ({ agents, messages: messagesNow(), updatedAt: new Date().toISOString() }))

    const branch = git?.branches[0]
    if (!git || !branch) {
      await update($, posts, () => ({ where: 'manager session has no repo branch', perf: [], tests: [] }))
      return
    }
    const perf = await postFile($, git.repo, branch, '.swarm/perf.md')
    const tests = await postFile($, git.repo, branch, '.swarm/tests.md')
    await update($, posts, () => ({ where: `${git.repo}@${branch}`, perf, tests }))
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

// One board, drawn in the side pane and inline under /swarm's output row.
const draw = async ($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>) => {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = ui
  const p = await read($, posts)
  const drawParts = (parts: Part[], file: string) => (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{p.where ? `${p.where} · .swarm/${file}` : 'loading…'}</Text>
      {p.where && parts.length === 0 && <Text dimColor>{`Nothing posted yet. Agents commit .swarm/${file} (markdown; SVG plots as ![alt](plots/x.svg)) to the manager's branch.`}</Text>}
      {parts.map((part, i) =>
        part.kind === 'md' ? (
          <Markdown key={`p-${file}-${i}`} text={part.text} />
        ) : e.surface !== 'terminal' && 'Svg' in ui ? (
          <ui.Svg source={part.source} alt={part.alt} />
        ) : (
          <Text dimColor>[plot: {part.alt} — open in the desktop or web app]</Text>
        ),
      )}
    </Box>
  )
  const list = await read($, swarms)
  const sel = await read($, selected)
  const view = await read($, tab)
  const b = await read($, board)
  const rows = Math.max(6, (e.viewport?.rows ?? 30) - 8)
  const name = new Map(b.agents.map(a => [a.id, a.depth === 0 ? 'MANAGER' : a.title]))
  const pick = (id: string) => () => {
    void update($, selected, () => id)
    void update($, board, () => ({ agents: [], messages: [], updatedAt: '' }))
    void update($, posts, () => ({ where: '', perf: [], tests: [] }))
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
        <Button key="t-perf" variant={view === 'perf' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'perf')}>
          Perf
        </Button>
        <Button key="t-tests" variant={view === 'tests' ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => 'tests')}>
          Tests
        </Button>
        <Button key="refresh" plain onPress={() => void refresh($)}>↻</Button>
        <Text dimColor>{b.updatedAt ? `updated ${hhmm(b.updatedAt)}Z` : 'loading…'}</Text>
      </Box>
      {view === 'perf' ? drawParts(p.perf, 'perf.md') : view === 'tests' ? drawParts(p.tests, 'tests.md') : view === 'agents' ? (
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
}

const EMOJI: Record<string, string> = { working: '🟢', blocked: '🟡', review_ready: '🔵', completed: '✅', failed: '🔴' }

// `/swarm` [agents|msgs|perf|tests] as text, for sessions with no surface attached.
async function boardText($: EngineInterface, view: string): Promise<string> {
  const b = await read($, board)
  const p = await read($, posts)
  const list = await read($, swarms)
  const sel = await read($, selected)
  const name = new Map(b.agents.map(a => [a.id, a.depth === 0 ? 'MANAGER' : a.title]))
  const warn = lastError ? `\n⚠️ last refresh failed: ${lastError.slice(0, 500)}` : ''
  const head = `**${list.find(s => s.id === sel)?.title ?? 'no swarm found'}** · updated ${b.updatedAt ? hhmm(b.updatedAt) + 'Z' : 'never'} · \`/swarm agents|msgs|perf|tests\`${warn}`
  const parts = (ps: Part[], file: string) =>
    ps.length === 0 ? `_Nothing posted yet in ${p.where} .swarm/${file}._` : ps.map(x => (x.kind === 'md' ? x.text : `[plot: ${x.alt}](${x.url})`)).join('\n\n')
  if (view === 'msgs')
    return [head, ...b.messages.slice(-20).map(m => `- ${hhmm(m.at)} **${name.get(m.from) ?? m.from} → ${name.get(m.to) ?? m.to}**: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)].join('\n')
  if (view === 'perf') return `${head}\n\n${parts(p.perf, 'perf.md')}`
  if (view === 'tests') return `${head}\n\n${parts(p.tests, 'tests.md')}`
  assert(view === '' || view === 'agents', `unknown view "${view}"; use agents, msgs, perf or tests`)
  const others = list.filter(s => s.id !== sel).map(s => s.title).join(', ')
  return [
    head,
    ...b.agents.map(a => `${'  '.repeat(a.depth)}- ${EMOJI[a.status] ?? '⚪'} ${a.depth === 0 ? '**MANAGER** ' : ''}[${a.title.replace(/[[\]]/g, '')}](https://claude.ai/code/${a.id}) _(${a.status})_${a.summary ? ` — ${a.summary}` : ''}`),
    others ? `\nOther swarms: ${others}` : '',
  ].join('\n')
}


// The board's data as JSON for the web page (skills/swarm-board/board.html reads posts/board.json).
async function snapshotJson($: EngineInterface): Promise<string> {
  const b = await read($, board)
  const p = await read($, posts)
  const sel = await read($, selected)
  const mgr = b.agents[0]
  assert(!!mgr && mgr.id === sel, 'no manager loaded')
  const [repo, branch] = p.where.includes('@') ? p.where.split('@') : ['', '']
  return JSON.stringify({
    version: 1,
    generatedAt: b.updatedAt,
    manager: { id: mgr.id, title: mgr.title, repo, branch },
    agents: b.agents,
    messages: b.messages.map(m => ({ ...m, text: m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text })),
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swarm', description: 'Open the swarm board (manager, workers, messages)' })
    await $.tool.register({
      name: 'snapshot',
      description: 'Refresh the swarm board for a manager session (default: the most recently active one) and write its data (worker tree, statuses, messages) as JSON to `path`, for publishing into the Swarm Board page as posts/board.json. See the swarm-board skill.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path to write, e.g. in your scratchpad: <scratchpad>/swarm-board/board.json' },
          manager: { type: 'string', description: 'Manager session id (session_...). Omit for the most recently active manager.' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })
    void $.ui.open({ id: PANE, title: 'Swarm' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('tool.call', { tool: /^mcp__swarm-board__snapshot$/ }, async ($, e: unknown) => {
    const input = e as unknown as { path: string; manager?: string }
    assert(input.path.startsWith('/'), `path must be absolute: ${input.path}`)
    if (input.manager) {
      const id = input.manager.startsWith('session_') ? input.manager : `session_${input.manager}`
      await update($, selected, () => id)
    }
    // A tool hook has 10 s: wait up to 7 s for the refresh, then write what is loaded.
    // The 90 s background refresh keeps that recent; a manager change waits for the tree before writing.
    const done = await Promise.race([refresh($).then(() => true), $.clock.sleep(7_000).then(() => false)])
    if (!done) assert((await read($, board)).agents[0]?.id === (await read($, selected)), 'the tree for this manager is still loading; call again in a minute')
    const json = await snapshotJson($)
    await $.fs.write(input.path, json)
    const b = await read($, board)
    return { result: `Wrote ${input.path} (${json.length} bytes): ${b.agents[0]!.title}, ${b.agents.length - 1} workers, ${b.messages.length} messages, data from ${b.updatedAt}.` }
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Swarm' })
    if (opened.isPlaced) {
      void refresh($)
      return { text: 'Swarm board opened in the side pane.' }
    }
    // No surface draws plugin elements here (e.g. a cloud session): print the board as markdown.
    // Wait up to 20 s; a first scan of a long manager transcript takes longer, and the
    // board then shows what it has so far. A failure shows in the text as lastError.
    await Promise.race([refresh($).catch(() => undefined), $.clock.sleep(20_000)])
    return { text: await boardText($, e.args.trim()) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, draw)
  on('ui.render', { component: 'CommandOutput', props: { command: 'swarm' } }, draw)
}

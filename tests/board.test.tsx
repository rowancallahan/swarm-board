import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'swarm-board',
  component: 'Pane',
  requestId: 'swarm-board',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const T = '2026-10-28T08:00:00Z'
const wrap = (ccr: unknown) => ({ value: { content: [{ type: 'text', text: `<x>${JSON.stringify({ ccr })}</x>` }], isError: false } })
const sessions = [
  { id: 'w1', title: 'worker one', status_bucket: 'SESSION_STATUS_BUCKET_WORKING', parent_session_id: 'm', updated_at: T },
  { id: 'w2', title: 'worker two', status_bucket: 'SESSION_STATUS_BUCKET_FAILED', parent_session_id: 'm', updated_at: T },
  { id: 'm', title: 'Lean align: MANAGER', status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED', updated_at: T, post_turn_summary: { recent_action: 'merged' } },
]
const sendFrom = (to: string, msg: string) => [{
  created_at: T,
  assistant: { internal_anthropic_catchall: { message: { content: [{ type: 'tool_use', id: `t-${to}-${msg}`, name: 'mcp__claude-code-remote__send_message', input: { session_id: to, message: msg } }] } } },
}]

const need = async (ui: any, q: any, surface: string) => {
  const hit = await ui.find(q)
  if (!hit) throw new Error(`${surface}: nothing matches ${String(q.type)} ${String(q.text)}; tree: ${JSON.stringify(await ui.drawn()).slice(0, 1500)}`)
}

test('board shows manager first, workers nested, and messages', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e: any) => {
    if (e.tool === 'list_sessions') return wrap({ data: sessions, has_more: false })
    if (e.tool === 'list_events') {
      const data = e.args.session_id === 'm' ? sendFrom('w1', 'start task A') : e.args.session_id === 'w1' ? sendFrom('m', 'task A done') : []
      return wrap({ data, has_more: false, first_id: 'a', last_id: 'b' })
    }
    if (e.tool === 'get_session') return wrap({ ...sessions[2], session_context: { outcomes: [{ git_repository: { git_info: { repo: 'o/proj', branches: ['main'] } } }] } })
    if (e.tool === 'get_file_contents') {
      expect(e.args.ref).toBe('refs/heads/main')
      const files: Record<string, string> = {
        '.swarm/perf.md': '# Speed\nInstructions per commit\n![ir per commit](plots/ir.svg)\nafter plot',
        '.swarm/plots/ir.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      }
      const body = files[e.args.path]
      if (body === undefined) return { value: { content: [{ type: 'text', text: 'Failed to get file contents. The path does not point to a file or directory, or the file does not exist in the repository.' }], isError: true } }
      return { value: { content: [{ type: 'text', text: 'successfully downloaded text file' }, { type: 'resource', resource: { uri: 'repo://x', text: body } }], isError: false } }
    }
    throw new Error(`unexpected ${e.tool}`)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await need(ui, { type: 'Text', text: /MANAGER/ }, surface)
    await need(ui, { type: 'Text', text: /worker two/ }, surface)
    await ui.press({ key: 't-msgs' })
    await need(ui, { type: 'Text', text: /task A done/ }, surface)
    await need(ui, { type: 'Text', text: /start task A/ }, surface)
    await ui.press({ key: 't-perf' })
    await need(ui, { type: 'Markdown', text: /Instructions per commit/ }, surface)
    await need(ui, { type: 'Markdown', text: /after plot/ }, surface)
    if (surface === 'terminal') await need(ui, { type: 'Text', text: /plot: ir per commit/ }, surface)
    else await need(ui, { type: 'Svg' }, surface)
    await ui.press({ key: 't-tests' })
    await need(ui, { type: 'Text', text: /Nothing posted yet/ }, surface)
    await ui.press({ key: 't-agents' })
    await ui.unmount()
  }
})

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
    throw new Error(`unexpected ${e.tool}`)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /MANAGER/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /worker two/ })).toBeDefined()
    await ui.press({ key: 't-msgs' })
    expect(await ui.find({ type: 'Text', text: /task A done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /start task A/ })).toBeDefined()
    await ui.press({ key: 't-agents' })
    await ui.unmount()
  }
})

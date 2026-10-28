export type Agent = {
  id: string
  title: string
  status: string
  summary: string
  depth: number
  parent: string | null
}
export type Msg = { key: string; at: string; from: string; to: string; text: string }
export type Swarm = { id: string; title: string; workers: number }
export type Board = { agents: Agent[]; messages: Msg[]; updatedAt: string }
// One block of a posting file: markdown text, or an SVG plot it links to.
export type Part = { kind: 'md'; text: string } | { kind: 'svg'; alt: string; source: string; url: string }
// `.swarm/perf.md` and `.swarm/tests.md` from the manager's branch.
export type Posts = { where: string; perf: Part[]; tests: Part[] }

declare module 'claude-code' {
  interface PluginState {
    'swarm-board': {
      swarms: Shaped<Swarm[]>
      selected: string
      tab: string
      board: Shaped<Board>
      posts: Shaped<Posts>
    }
  }
}

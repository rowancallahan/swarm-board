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

declare module 'claude-code' {
  interface PluginState {
    'swarm-board': {
      swarms: Shaped<Swarm[]>
      selected: string
      tab: string
      board: Shaped<Board>
    }
  }
}

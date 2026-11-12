export type DeskSession = {
  state: 'none' | 'running' | 'idle'
  id?: string
  last_report?: string | null
  last_exit?: string | null
  last_at?: number | null
}
export type DeskCase = { key: string; status: string; notes: string; session: DeskSession }
export type DeskSnapshot = {
  now: number
  paused: boolean
  inspector: { running: boolean; last_at: number | null; last_result: string | null; last_exit: string | null }
  cases: DeskCase[]
}

declare module 'claude-code' {
  interface PluginState {
    'recovery-desk': {
      snap: Shaped<DeskSnapshot | null>
      nextAt: number
      error: string
    }
  }
}

export type RecoveryRun = { id: number; kind: string; model: string | null; pid: number | null; log_file: string; started_at: number }
export type RecoveryReport = { STATUS?: string; DONE?: string; REMAINING?: string; BOUNDARY?: string; exit?: string }
export type RecoveryCase = {
  id: number
  key: string
  kind: string
  state: string
  issue: number | null
  pr: number | null
  session: string | null
  run: RecoveryRun | null
  report: RecoveryReport | null
  wait: Record<string, unknown> | null
  note: string
}
export type DeskSnapshot = {
  now: number
  error?: string
  watchdog: { state?: string; failed_key?: string | null; checked_at?: number } | null
  supervisor: { heartbeat_age: number | null }
  cases: RecoveryCase[]
}

declare module 'claude-code' {
  interface PluginState {
    'recovery-desk': {
      snap: Shaped<DeskSnapshot | null>
      error: string
    }
  }
}

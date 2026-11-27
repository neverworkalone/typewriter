import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeskSnapshot, RecoveryCase } from '../types'

// War Room Recovery status panel. Detection and recovery runs live in the War Room Supervisor (Recovery lane) and the
// external watchdog (`./recovery`); this mod only reads `status.py` (read-only) every minute and shows a panel and toasts.
// It starts, stops and writes nothing. 운영 메인 checkout: 이 모드를 켠 세션의 프로젝트 루트 (session.start에서 읽는다).
let ROOT = ''
let DESK = ''
const PANE = 'recovery-desk'
const TITLE = 'War Room Recovery'
const REFRESH_MS = 60 * 1000

const snap = atom({ plugin: 'recovery-desk', key: 'snap' } as const, null, { shape: 'snap-2' })
const error = atom({ plugin: 'recovery-desk', key: 'error' } as const, '')

const clock = (sec: number | null | undefined): string => {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// What changed between two snapshots that the owner should hear about now.
const changes = (before: DeskSnapshot | null, after: DeskSnapshot): string[] => {
  if (!before) return []
  const out: string[] = []
  const old = new Map(before.cases.map(c => [c.id, c] as const))
  for (const c of after.cases) {
    const p = old.get(c.id)
    if (!p) out.push(`새 복구 case ${c.key}`)
    else if (p.state !== c.state) out.push(`${c.key}: ${p.state} → ${c.state}`)
  }
  const open = new Set(after.cases.map(c => c.id))
  for (const c of before.cases) if (!open.has(c.id)) out.push(`${c.key} 해결됨`)
  if (after.watchdog?.failed_key && after.watchdog.failed_key !== before.watchdog?.failed_key) {
    out.push('Supervisor 기동 실패 — watchdog이 같은 조건 재시도를 멈췄습니다')
  }
  return out
}

async function refresh($: EngineInterface): Promise<void> {
  const r = await $.process.run(['python3', '-I', `${DESK}/status.py`, ROOT], { cwd: ROOT, timeoutMs: 20_000 })
  if (r.exitCode !== 0) {
    await update($, error, () => `status.py exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
    return
  }
  const next = JSON.parse(r.stdout) as DeskSnapshot
  const before = await read($, snap)
  await update($, snap, () => next)
  await update($, error, () => next.error ?? '')
  for (const line of changes(before, next)) $.ui.toast(`${TITLE}: ${line}`)
}

const safely = ($: EngineInterface, job: () => Promise<void>) => {
  void job().catch(err => update($, error, () => String(err).slice(0, 200)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    ROOT = await $.session.root()
    DESK = `${ROOT}/tools/warroom/recovery-desk`
    // 운영 메인 checkout 경계(guard.sh, fail-closed)를 통과해야 패널을 등록한다. 실패·예외면 아무것도 하지 않는다.
    const own = await $.process.run(['sh', `${DESK}/guard.sh`, ROOT], { cwd: ROOT }).catch(() => null)
    if (own?.exitCode !== 0) return started
    await $.command.register({ name: 'recovery-desk', description: 'War Room Recovery 상태 패널 열기' })
    void $.ui.open({ id: PANE, title: TITLE })
    safely($, () => refresh($))
    $.clock.every(REFRESH_MS, () => safely($, () => refresh($)))
    return started
  })

  on('command.run', { command: 'recovery-desk' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'War Room Recovery 패널을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snap)
    const err = await read($, error)
    const hb = s?.supervisor.heartbeat_age
    const caseRow = (c: RecoveryCase) => (
      <Box key={String(c.id)} flexDirection="column" marginTop={1}>
        <Text bold>{c.key}  ·  {c.state}{c.pr ? `  ·  PR #${c.pr}` : ''}</Text>
        <Text dimColor>
          {c.run ? `실행 중 #${c.run.id} ${c.run.model ?? ''} · ${clock(c.run.started_at)}` : '실행 없음'}
          {c.report?.STATUS ? ` · 마지막 보고 ${c.report.STATUS}` : ''}
        </Text>
        {c.report?.REMAINING ? <Text dimColor>{c.report.REMAINING.slice(0, 200)}</Text> : null}
        {c.note ? <Text dimColor>{c.note.slice(0, 200)}</Text> : null}
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Text bold>
          Supervisor {hb == null ? '상태 미확인' : hb < 180 ? '정상' : `heartbeat ${Math.round(hb)}초 지연`}
          {s?.watchdog?.failed_key ? ' · watchdog: 기동 실패(재시도 중단)' : s?.watchdog?.state ? ` · watchdog: ${s.watchdog.state}` : ''}
        </Text>
        {err !== '' && <Text color="red">{err}</Text>}
        <Box marginTop={1}>
          <Button key="refresh" label="새로고침" onPress={() => safely($, () => refresh($))} />
        </Box>
        {(s?.cases.length ?? 0) === 0 ? <Text dimColor>열린 복구 case 없음</Text> : s?.cases.map(caseRow)}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeskCase, DeskSnapshot } from '../types'

// War Room 복구 점검반 (tools/warroom/recovery-desk/). 이 세션이 앱에 열려 있는 동안
// 10분마다 점검 1회(inspect.sh)를 띄우고, 1분마다 상태(status.py)를 읽어 패널과 토스트로 보여 준다.
// 운영 메인 checkout: 이 모드를 켠 세션의 프로젝트 루트 (session.start에서 읽는다).
let ROOT = ''
let DESK = ''
const PANE = 'recovery-desk'
const TITLE = '복구 점검반'
const INSPECT_MS = 10 * 60 * 1000
const REFRESH_MS = 60 * 1000

const snap = atom({ plugin: 'recovery-desk', key: 'snap' } as const, null, { shape: 'snap-1' })
const nextAt = atom({ plugin: 'recovery-desk', key: 'nextAt' } as const, 0)
const error = atom({ plugin: 'recovery-desk', key: 'error' } as const, '')

const statusOf = (report: string | null | undefined): string =>
  report?.match(/STATUS:\s*([A-Z_]+)/)?.[1] ?? ''

const clock = (ms: number | null | undefined): string => {
  if (!ms) return '-'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const firstLines = (text: string | null | undefined, n: number): string[] =>
  (text ?? '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, n)

// What changed between two snapshots that the owner should hear about now.
const changes = (before: DeskSnapshot | null, after: DeskSnapshot): string[] => {
  if (!before) return []
  const out: string[] = []
  const old = new Map(before.cases.map(c => [c.key, c] as const))
  for (const c of after.cases) {
    const p = old.get(c.key)
    if (!p) out.push(`새 장애 ${c.key}`)
    else if (p.status !== c.status) out.push(`${c.key}: ${p.status} → ${c.status}`)
    const s = statusOf(c.session.last_report)
    if (p && s && s !== statusOf(p.session.last_report)) out.push(`${c.key} 복구 세션: ${s}`)
  }
  if (after.inspector.last_exit && after.inspector.last_exit !== '0' &&
      after.inspector.last_at !== before.inspector.last_at) {
    out.push(`점검 실패 (exit ${after.inspector.last_exit})`)
  }
  return out
}

async function refresh($: EngineInterface): Promise<void> {
  const r = await $.process.run(['python3', '-I', `${DESK}/status.py`], { cwd: ROOT, timeoutMs: 20_000 })
  if (r.exitCode !== 0) {
    await update($, error, () => `status.py exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
    return
  }
  const next = JSON.parse(r.stdout) as DeskSnapshot
  const before = await read($, snap)
  await update($, snap, () => next)
  await update($, error, () => '')
  for (const line of changes(before, next)) $.ui.toast(`${TITLE}: ${line}`)
}

// 일시정지는 inspect.sh가 읽는 파일 하나다: 모드 재로드나 타이머 중복과 무관하게 지켜진다.
async function setPaused($: EngineInterface, on: boolean): Promise<void> {
  const flag = `${ROOT}/.git/typewriter-supervisor/recovery-desk/paused`
  await $.process.run(on ? ['touch', flag] : ['rm', '-f', flag], { cwd: ROOT })
  await refresh($)
}

async function inspect($: EngineInterface, force = false): Promise<void> {
  const argv = ['sh', `${DESK}/inspect.sh`, ...(force ? ['--force'] : [])]
  const r = await $.process.run(argv, { cwd: ROOT, timeoutMs: 20_000 })
  if (r.exitCode !== 0) await update($, error, () => `inspect.sh exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
  await update($, nextAt, () => Date.now() + INSPECT_MS)
  await refresh($)
}

const safely = ($: EngineInterface, job: () => Promise<void>) => {
  void job().catch(err => update($, error, () => String(err).slice(0, 200)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    ROOT = await $.session.root()
    DESK = `${ROOT}/tools/warroom/recovery-desk`
    // 운영 메인 checkout 경계(guard.sh, fail-closed)를 통과해야 패널·타이머를 등록한다. 실패·예외면 아무것도 하지 않는다.
    const own = await $.process.run(['sh', `${DESK}/guard.sh`, ROOT], { cwd: ROOT }).catch(() => null)
    if (own?.exitCode !== 0) return started
    await $.command.register({
      name: 'recovery-desk',
      description: '복구 점검반 패널 열기 (인자: run = 지금 점검, pause, resume)',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await update($, nextAt, () => Date.now() + INSPECT_MS)
    safely($, () => refresh($))
    $.clock.every(REFRESH_MS, () => safely($, () => refresh($)))
    $.clock.every(INSPECT_MS, () => safely($, () => inspect($)))
    return started
  })

  on('command.run', { command: 'recovery-desk' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'run') {
      await inspect($, true)
      return { text: '점검을 시작했습니다.' }
    }
    if (arg === 'pause' || arg === 'resume') {
      await setPaused($, arg === 'pause')
      return { text: arg === 'pause' ? '10분 점검을 멈췄습니다.' : '10분 점검을 재개했습니다.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '복구 점검반 패널을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snap)
    const isPaused = s?.paused ?? true
    const due = await read($, nextAt)
    const err = await read($, error)
    const caseRow = (c: DeskCase) => (
      <Box key={c.key} flexDirection="column" marginTop={1}>
        <Text bold>{c.key}  ·  {c.status}</Text>
        <Text dimColor>
          세션 {c.session.state}
          {c.session.last_at ? ` · ${clock(c.session.last_at * 1000)}` : ''}
          {statusOf(c.session.last_report) ? ` · ${statusOf(c.session.last_report)}` : ''}
        </Text>
        {firstLines(c.session.last_report, 3).map(l => <Text dimColor>{l}</Text>)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>
          점검 {s?.inspector.running ? '실행 중' : isPaused ? '일시정지' : `대기 · 다음 ${clock(due)}`}
        </Text>
        <Text dimColor>마지막 점검 {clock(s?.inspector.last_at ? s.inspector.last_at * 1000 : null)}
          {s?.inspector.last_exit ? ` · exit ${s.inspector.last_exit}` : ''}</Text>
        {firstLines(s?.inspector.last_result, 4).map(l => <Text>{l}</Text>)}
        {err !== '' && <Text color="red">{err}</Text>}
        <Box marginTop={1}>
          <Button key="run" label="지금 점검" onPress={() => safely($, () => inspect($, true))} />
          <Button key="pause" label={isPaused ? '재개' : '일시정지'}
            onPress={() => safely($, () => setPaused($, !isPaused))} />
          <Button key="refresh" label="새로고침" onPress={() => safely($, () => refresh($))} />
        </Box>
        {(s?.cases.length ?? 0) === 0
          ? <Text dimColor>열린 장애 없음</Text>
          : s?.cases.filter(c => c.status !== 'RESOLVED').map(caseRow)}
      </Box>
    )
  })
}

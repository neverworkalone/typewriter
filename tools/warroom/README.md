# War Room — 운영 가이드

이 README는 **오너가 War Room 운영 중 찾아 쓰는 명령과 장애 대응 정보**를 정리한 문서다. 내부 아키텍처, 개발 이력, 구현 설계는 다루지 않는다. 모든 셸 명령은 별도 표시가 없으면 **Typewriter 저장소 루트**에서 실행한다.

## 생산 로그 찾기 (전체 실행 기록)

아래 명령은 **최초 생산과 중단·복구 뒤의 모든 `produce%` 실행**에 대한 `runs.log_file` 경로를 시작 시간순으로 출력하고 macOS 클립보드에 복사한다. **마지막 실행 하나만 담는 `batches.log_file`과 다르다.**

### PR 번호로 조회

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.pr_number=1829 AND r.kind LIKE 'produce%'
   ORDER BY r.started_at;" | pbcopy
```

### 배치명으로 조회 — A / 046_01 / Codex

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.method='a' AND b.shard='046' AND b.batch='01'
     AND b.producer='codex' AND r.kind LIKE 'produce%'
   ORDER BY r.started_at;" | pbcopy
```

`method`는 `a`·`b`·`c`·`d`, `producer`는 설정의 논리 모델 ID(`codex`, `claude`, `deepseek` 등)다. **A/B는 모델별 독립 큐**이므로 모델을 지정해 보는 것이 편하다. **C/D는 방식별 공유 큐**라 모델 조건을 빼도 된다. 같은 배치명으로 과거 여러 실행 기록이 있으면 일치하는 경로가 모두 나온다.

### Stage 2 Part로 조회 — 046 / Batch 01 / Part 03

Stage 2는 `batches.method='s2'`, `batches.batch='BB-PP'`로 저장한다.

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.method='s2' AND b.shard='046' AND b.batch='01-03'
     AND r.kind LIKE 'produce%'
   ORDER BY r.started_at;" | pbcopy
```

**리뷰 후 수정 로그까지 함께** 보려면 위 명령의 `AND r.kind LIKE 'produce%'` 조건을 삭제한다. `runs.kind`도 같이 확인하려면 `SELECT r.kind, r.log_file`로 바꾼다. `pbcopy`를 빼면 터미널에 경로가 표시된다. `less <로그경로>` 또는 `tail -f <로그경로>`로 원본 로그를 읽을 수 있다.

## 장애 대응 빠른 판단

| 화면/상황 | 먼저 할 일 | 피할 일 |
| --- | --- | --- |
| `PAUSED` (인증·CLI 권한·한도) | Batch Detail에서 정확한 실패 명령과 권한/계정/한도를 확인 → 환경을 수정한 뒤 같은 배치 `Retry` | 권한을 무조건 확대하거나 새 배치 실행 |
| `ERROR: 정상 종료했지만 PR 없음` | `Raw Log` 마지막 부분과 `Audit Log` 확인 → 최종 파일/PR 생성 여부 확인 → 같은 배치 복구 판단 | `Clear` 또는 무조건 초기 생산 |
| `WAITING_REVIEW` | PR 번호로 리뷰 상태와 정확한 HEAD를 확인. 새로운 `-1`이 접수되면 War Room이 기존 PR에 수정 실행 | 수동으로 중복 PR 생성 |
| `MERGED` / `CLEANUP` 오류 | 해당 PR의 실제 merge 여부, worktree 상태, Audit Log 확인. 원인 해결 후 같은 배치 `Retry` | 강제 reset/rebase 또는 worktree 수동 삭제 |
| Stage 2 입력 대기 | 해당 Batch의 필수 Stage 1 Candidate 6개가 머지됐는지 확인. Single이면 기존 샤드에서 대기 | 다른 Part/샤드로 수동 전환 |
| Shared defect 보고 | 연결된 `urgent` Issue와 Maintainer PR, 해당 배치의 `PAUSED` 사유 확인 | 수정 반영 전 무조건 재개 |

**Shared defect 자동 복구:** 반복 가능한 공통 결함은 원 배치를 `PAUSED`로 보존하고 `urgent` Issue와 Maintainer 수정 PR을 통해 해결한다. Maintainer의 PR이 **머지되고 정리가 완료**되면 수정 커밋이 원 배치에 반영되고 회귀 검증에 성공한 경우 **기존 배치를 자동으로 한 번 재개**한다. 단순 PR 머지만으로 자동 재개 완료가 아니다. `Audit Log`에서 `공통 수정 … 반영·검증 완료 … → 자동 Retry 1회`를 확인한다. **Shared defect 보류 중 일반 `Retry`는 이를 우회하지 않는다.** 명시적으로 `Stop` 후 `Retry`하는 것은 수정 검증을 건너뛸 수 있는 운영자 override이므로 주의한다. 자동 복구 뒤 `ERROR`가 발생하면 먼저 실제 이전 결함이 해결됐는지와 재개 로그를 구분한다.

## Restarting after code updates

Updating files with `git pull` does not reload Python code already running in the Supervisor.
The Board's `r` key reloads `config.json` only; it does **not** restart the Supervisor.
After updating War Room's Python code, restart **both** tmux sessions from a separate,
ordinary terminal (not from inside either War Room tmux session).
Prefer a time when no producer is actively working; the Supervisor and TUI sessions are
replaced, but the persistent database, producer worktrees and PRs are not deleted.

```sh
tmux kill-session -t warroom-supervisor 2>/dev/null || true
tmux kill-session -t warroom 2>/dev/null || true
```

`./war` creates or reattaches the TUI and starts a fresh Supervisor if none holds its lock.
The Supervisor recovers existing batches using the persisted state and running processes;
do not delete `tools/warroom/.local/`, manually reset worktrees or press Retry just to reload code.

## 계정·설정 경로

**설정만 바꿨다면:** `tools/warroom/.local/config.json`을 수정하고 보드에서 `r`을 누른다. 거부 사유는 화면/Audit Log에서 확인한다. Supervisor Python 코드 교체는 위 재시작 절차를 따른다.

```sh
# War Room 전용 GitHub 계정 확인 (개인 gh 로그인과 분리)
GH_CONFIG_DIR=tools/warroom/.local/gh gh auth status

# 최초 설정이 필요한 경우에만
GH_CONFIG_DIR=tools/warroom/.local/gh gh auth login

# Claude / Codex 계정 상태
claude auth status
codex login status
```

- War Room GitHub 기대 계정: `neverworkalone-agent`. GitHub 인증은 `.local/gh`로 분리되며, Claude/Codex 로그인은 각 CLI의 로컬 계정을 사용한다.
- 작업 설정: `tools/warroom/.local/config.json` (`tools/warroom/config.example.json` 참고).
- 상태 DB: `tools/warroom/.local/warroom.db`. 로그·worktree: `tools/warroom/.local/` 아래. 해당 디렉터리는 Git에서 제외되므로 인증·로그를 커밋하지 않는다.
- Codex 권한 문제가 나면 `~/.codex/config.toml`의 지정 `permission_profile`을, Claude 권한 문제가 나면 `~/.claude/settings.json` 등 로컬 권한 설정을 확인한다. War Room이 임의로 권한을 넓히지는 않는다.

추가 생산·검증 절차의 정본은 [Relation Factory](../../docs/relation-factory.md) 및 [Stage 2 Issue #927](https://github.com/neverworkalone/typewriter/issues/927)이다. 이 README는 개발 설계서가 아니라 **오너용 운영 명령 모음**으로 유지한다.

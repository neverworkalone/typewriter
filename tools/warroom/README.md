# War Room — 운영 가이드

이 README는 **오너가 War Room을 사용하면서 바로 찾아 실행할 명령과 조작 방법**을 정리한 문서다. 내부 아키텍처, 개발 이력, 구현 설계는 다루지 않는다. 모든 셸 명령은 별도 표시가 없으면 **Typewriter 저장소 루트**에서 실행한다.

## 1. 실행 및 기본 조작

```sh
./war
```

- 첫 실행: `brew install tmux`; 사용하려는 AI CLI(Claude Code / Codex / OpenCode)를 설치하고 로그인한다. War Room의 GitHub 계정 설정은 아래 §5 참조.
- **시작:** 상단에서 CLI/모델, Method `A`/`B`/`C`/`D` 또는 `Stage 2`, `Single`/`Continuous`를 선택하고 `Start`를 누른다. 각 카드에는 작업 배치와 상태, 관측된 진행률(해당 시), PR 번호가 표시된다.
- **Single:** A/B/C/D는 배치 하나 수행 후 종료한다. Stage 2는 처음 선택한 샤드에 고정되어 준비된 Part를 순서대로 처리하며, 입력이 없으면 해당 샤드에서 기다린다.
- **Continuous:** 같은 생산 라인의 다음 작업을 순서대로 계속 선택한다. Stage 2는 다른 준비된 샤드로 넘어갈 수 있다.
- **카드 선택:** `Batch Detail`에서 현재 오류, PR, Agent Log / `Raw Log` / `Audit Log`, Run History, `Metadata / Details`(HEAD·branch·worktree)를 확인한다.
- **`Drain` / `Drain All`:** 현재 작업을 리뷰·머지·정리까지 마치고 더는 새 작업을 배정하지 않도록 한다. `Drain All`은 현재 실행 중인 라인에 한 번 적용된다.
- **`Stop` / `Stop All`:** 현재 실행을 멈추되 브랜치·worktree·PR·미완성 산출물을 보존한다.
- **`Retry`:** `PAUSED`/`ERROR`에서 같은 배치를 재개한다. 먼저 오류와 `Audit Log`를 확인한다. 기존 PR·worktree를 버리고 새 배치를 고르는 버튼이 아니다.
- **`Clear` (주의):** 미완료 배치의 작업을 **포기**하고 PR·브랜치·worktree·실행 기록 정리를 진행하는 파괴적 동작이다. 단순 오류·일시중단·코드 업데이트 때문에 사용하지 않는다.
- **`r`:** `config.json` 설정만 재로드한다. 실행 중인 Supervisor의 Python 코드는 재시작되지 않는다. 새 모델 열은 TUI를 다시 열어야 표시된다.
- **`s`:** Settings. **`f`:** OpenCode Free/Go 전환(Go 진입은 확인 필요). **`m`:** `PAUSED`/`ERROR`인 Maintainer 재시도. **`Esc`:** 보드로 돌아가기.

Stage 2는 **Claude/Codex에서만 시작할 수 있고 동시에 Part 하나**만 진행한다. Part 하나(보통 100 Canonical records, 마지막 예외 83 records)가 PR 하나다. Stage 1의 다른 A/B/C/D 라인은 동시에 실행 가능하다.

## 2. 생산 로그 찾기 (전체 실행 기록)

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

## 3. 장애 대응 빠른 판단

| 화면/상황 | 먼저 할 일 | 피할 일 |
| --- | --- | --- |
| `PAUSED` (인증·CLI 권한·한도) | Batch Detail에서 정확한 실패 명령과 권한/계정/한도를 확인 → 환경을 수정한 뒤 같은 배치 `Retry` | 권한을 무조건 확대하거나 새 배치 실행 |
| `ERROR: 정상 종료했지만 PR 없음` | `Raw Log` 마지막 부분과 `Audit Log` 확인 → 최종 파일/PR 생성 여부 확인 → 같은 배치 복구 판단 | `Clear` 또는 무조건 초기 생산 |
| `WAITING_REVIEW` | PR 번호로 리뷰 상태와 정확한 HEAD를 확인. 새로운 `-1`이 접수되면 War Room이 기존 PR에 수정 실행 | 수동으로 중복 PR 생성 |
| `MERGED` / `CLEANUP` 오류 | 해당 PR의 실제 merge 여부, worktree 상태, Audit Log 확인. 원인 해결 후 같은 배치 `Retry` | 강제 reset/rebase 또는 worktree 수동 삭제 |
| Stage 2 입력 대기 | 해당 Batch의 필수 Stage 1 Candidate 6개가 머지됐는지 확인. Single이면 기존 샤드에서 대기 | 다른 Part/샤드로 수동 전환 |
| Shared defect 보고 | 연결된 `urgent` Issue와 Maintainer PR, 해당 배치의 `PAUSED` 사유 확인 | 수정 반영 전 무조건 재개 |

**Shared defect 자동 복구:** 반복 가능한 공통 결함은 원 배치를 `PAUSED`로 보존하고 `urgent` Issue와 Maintainer 수정 PR을 통해 해결한다. Maintainer의 PR이 **머지되고 정리가 완료**되면 수정 커밋이 원 배치에 반영되고 회귀 검증에 성공한 경우 **기존 배치를 자동으로 한 번 재개**한다. 단순 PR 머지만으로 자동 재개 완료가 아니다. `Audit Log`에서 `공통 수정 … 반영·검증 완료 … → 자동 Retry 1회`를 확인한다. **Shared defect 보류 중 일반 `Retry`는 이를 우회하지 않는다.** 명시적으로 `Stop` 후 `Retry`하는 것은 수정 검증을 건너뛸 수 있는 운영자 override이므로 주의한다. 자동 복구 뒤 `ERROR`가 발생하면 먼저 실제 이전 결함이 해결됐는지와 재개 로그를 구분한다.

## 4. 코드·설정 변경 반영

**설정만 수정:** `tools/warroom/.local/config.json`을 편집하고 보드에서 `r`을 누른다. 변경이 거부되면 화면/Audit Log 사유를 확인한다. 모델/effort pin을 실행 중간에 바꾸면 복구가 막힐 수 있다.

**War Room Python 코드 업데이트:** `git pull`만 해서는 실행 중인 Supervisor가 새 코드를 읽지 않는다. 가능하면 AI가 작업하지 않을 때 **War Room tmux 밖의 일반 터미널**에서 아래를 실행한다.

```sh
tmux kill-session -t warroom-supervisor 2>/dev/null || true
tmux kill-session -t warroom 2>/dev/null || true
./war
```

이 과정에서 `.local/`의 데이터베이스·로그·worktree는 삭제하지 않는다. 코드 적용 목적으로 `Clear`, 임의 worktree reset, 불필요한 `Retry`를 사용하지 않는다. TUI만 닫거나 tmux를 detach해도 Supervisor의 기존 실행은 계속된다.

## 5. 계정·설정 경로

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

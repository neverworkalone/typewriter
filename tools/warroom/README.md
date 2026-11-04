# War Room — 운영 가이드

이 README는 **오너가 War Room 운영 중 찾아 쓰는 명령과 장애 대응 정보**를 정리한 문서다. 내부 아키텍처, 개발 이력, 구현 설계는 다루지 않는다. 모든 셸 명령은 별도 표시가 없으면 **Typewriter 저장소 루트**에서 실행한다.

## 생산 로그 찾기 (전체 실행 기록)

아래 명령은 **최초 생산과 중단·복구 뒤의 모든 `produce%` 실행**에 대한 `runs.log_file` 경로를 시작 시간순으로 출력하고 macOS 클립보드에 복사한다. **마지막 실행 하나만 담는 `batches.log_file`과 다르다.**

### PR 번호로 조회

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file
   FROM runs r
   JOIN batches b ON b.id = r.batch_id
   WHERE b.pr_number = 2046
   ORDER BY r.started_at;" | paste -sd ' ' - | pbcopy
```

### 배치명으로 조회 — A / 046_01 / Codex

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file
   FROM runs r
   JOIN batches b ON b.id = r.batch_id
   WHERE b.method = 'c'
     AND b.shard = '001'
     AND b.batch = '01'
     AND b.producer='codex'
     AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

`method`는 `a`·`b`·`c`·`d`, `producer`는 설정의 논리 모델 ID(`codex`, `claude`, `deepseek` 등)다. **A/B는 모델별 독립 큐**이므로 모델을 지정해 보는 것이 편하다. **C/D는 방식별 공유 큐**라 모델 조건을 빼도 된다. 같은 배치명으로 과거 여러 실행 기록이 있으면 일치하는 경로가 모두 나온다.

### Stage 2 Part로 조회 — 001 / Batch 01 / Part 03

Stage 2는 `batches.method='s2'`, `batches.batch='BB-PP'`로 저장한다.

```sh
sqlite3 -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file
   FROM runs r
   JOIN batches b ON b.id = r.batch_id
   WHERE b.method = 's2'
     AND b.shard = '001'
     AND b.batch = '01-03'
     AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

**리뷰 후 수정 로그까지 함께** 보려면 위 명령의 `AND r.kind LIKE 'produce%'` 조건을 삭제한다. `runs.kind`도 같이 확인하려면 `SELECT r.kind, r.log_file`로 바꾼다. `pbcopy`를 빼면 터미널에 경로가 표시된다. `less <로그경로>` 또는 `tail -f <로그경로>`로 원본 로그를 읽을 수 있다.

## 사용량 계측과 선택적 단가 (Issue #2033)

run이 끝나면 그 run 자신의 로그만 읽어 `runs` 테이블에 `input_tokens`(cached·cache write 포함), `cached_input_tokens`,
`cache_write_tokens`, `output_tokens`(reasoning 포함), `reasoning_output_tokens`(output의 부분집합), `tool_calls`,
`submit_failures`를 기록합니다. resume은 새 run·새 로그이므로 중복 집계되지 않습니다. 로그에 없는 값(과거 run, OpenCode,
usage 누락)은 NULL이며 0으로 채우지 않습니다. 비용은 `config.json`의 선택적 `pricing`(USD / 1M tokens)이 있을 때만 계산합니다.
실제 단가를 직접 채우세요 (없으면 `unknown`):

```json
"pricing": {"<model id>": {"input": 0, "cached_input": 0, "cache_write": 0, "output": 0}}
```

## Supervisor 코드 수정 후 재시작

```sh
tmux kill-session -t warroom-supervisor 2>/dev/null || true
tmux kill-session -t warroom 2>/dev/null || true
```

`./war` creates or reattaches the TUI and starts a fresh Supervisor if none holds its lock.
The Supervisor recovers existing batches using the persisted state and running processes;
do not delete `tools/warroom/.local/`, manually reset worktrees or press Retry just to reload code.

## Web UI (`./dashboard`)

Mac 브라우저와 iPhone/iPad Safari용 **두 번째 View**다. 새 Controller·Supervisor가 아니며, 기존 `./war`·Supervisor를 바꾸지 않는다.

```sh
./dashboard              # http://localhost:8000
./dashboard --port 8123  # 포트 변경
```
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
- Method C 승인 문학 SQLite: 설정의 `literary_index_path`에 승인 인덱스의 읽기 가능한 절대 경로를 지정한다. Supervisor는 경로가 없거나 읽을 수 없으면 C 실행을 막고, 유효한 경로를 `TYPEWRITER_APPROVED_LITERARY_DB`로 C 생산 및 리뷰 수정 실행에 전달한다. 경로를 찾기 위해 캐시 전체를 검색하지 않는다.
- Method D 승인 문어 SQLite(paragraph corpus): 설정의 `corpus_index_path`에 읽기 가능한 절대 경로를 지정한다(C의 `literary_index_path`와 별개). D는 25-record 청크마다 새 AI 세션으로 실행되고 Supervisor가 `scripts/relation/d-chunk-cli.mjs prepare`로 청크 view를 준비해 초기 프롬프트에 직접 싣는다(너무 크면 page 폴백). 경로는 D 청크 세션과 prepare에만 `TYPEWRITER_APPROVED_CORPUS_DB`로 전달되며, 조립·Candidate v1 검증 1회·commit·push·PR은 Supervisor가 한다. 최종 검증 실패는 ERROR로 보존·보고하며 자동 재작성 세션은 없다.
- 모델 배정(#1867, #2538): 실행 설정은 `model_profiles`(adapter·model·effort·permission_profile), 단계별 사용은 `assignments.stage1|stage2|stage3`(`{모델 ID: 프로필 ID}`)와 `maintainer`(프로필 ID)가 정한다. Stage 2와 Stage 3는 각각 Claude 또는 Codex 모델 하나를 선택해 실행하며, Stage 3는 Stage 1·2와 독립된 `assignments.stage3` 프로필을 사용한다. 프로필 기반 `config.json`은 실행할 Stage 3 모델마다 해당 Claude/Codex 모델 ID와 프로필 ID를 `assignments.stage3`에 지정해야 한다. Stage 2와 같은 프로필 ID를 배정하면 같은 모델·effort를 쓰며, Stage 1·2 배정은 그대로 둔다. 누락된 Stage 3 배정은 해당 모델의 Stage 3 시작/preflight를 차단하며 다른 단계의 프로필을 대신 쓰지 않는다. 모델 ID(`codex`/`claude`/`deepseek`)는 Candidate 파일 접미사·큐·로그 소유권의 논리 producer이며 바뀌지 않는다. Maintainer를 Claude로 바꾸려면 `"maintainer": "sonnet-medium"`처럼 프로필 ID만 교체한다(프로필 adapter의 모델 ID가 둘 이상이면 `assignments`에 그 프로필을 배정해 하나로 정한다). DeepSeek는 계속 `producers.deepseek`의 `models.free/go`·`effort`로 설정한다. 배정이 있는 producer에는 `model`/`effort`/`permission_profile`을 함께 쓸 수 없고, 배정이 없는 기존 `producers` 설정과 `"maintainer": "<모델 ID>"`는 그대로 동작한다. 설정을 `r`로 다시 읽으면 다음 실행부터 새 model/effort/permission_profile을 적용하고 각 실행의 실제 설정과 session ID를 별도 기록으로 보존한다. 기존 adapter 교체 제한과 논리 producer/worktree 소유권은 유지된다.
- Stage 2 병렬 primary(#3047): 배포 후 새로 시작하는 Part는 `admission-cli plan-chunks`의 고정 task 계획(목표 `stage2_chunk_candidates`=250후보/task)으로 primary 판정을 나누어 최대 `stage2_max_parallel`(기본 16)개 세션을 동시에 실행한다. 빈 슬롯은 즉시 채우고 큰 Sense의 후속 조각은 선행 task 저장 후에만 시작하며, 저장은 Supervisor가 완료 순서로 하나씩 `save-chunk --task`로 수행한다. 두 값은 `r` 리로드 후 **다음 새 Part의 계획 / 다음 배정**부터 적용되며 실행 중 세션을 강제로 줄이지 않는다. 상한 1은 같은 계획을 순차 실행한다. 진행 중이던 기존 Part는 직렬 경로로 끝난다. Stop/Clear는 모든 task 프로세스의 종료를 확인하고, Retry는 저장되지 않은 task만 보존된 응답·수정 예산·세션으로 이어간다. Board의 Stage 2 카드에 task 실행/대기/저장 수가 표시된다.
- Stage 3 병렬 청크(#3149): 배포 후 **새로 시작하는 샤드**는 `edit-cli prepare`가 만든 청크를 최대 `stage3_max_parallel`(기본 16)개 answer-only 세션으로 동시에 판정한다. 슬롯은 run의 **종료가 확인된 뒤에만** 비며(`taskruns.slots_used`), 재시도 대기 청크가 미시작 청크보다 먼저 배정된다. 저장은 Supervisor만 완료 순서로 하나씩 `save-chunk --chunk NNN --expect-view-sha256`로 수행하므로 결과 파일은 순서와 무관하다. 응답 없음·헤더 없음·헤더만 있음은 `none`이 아니라 새 세션 1회 뒤 FAILED이고, 명시적 `chunk NNN`+`none`만 Keep-all이다. 저장 거부는 해당 청크만 FAILED로 두고 AI를 다시 부르지 않으며(Retry는 증거가 모두 일치할 때 보존된 응답을 1회만 다시 저장), FAILED가 있으면 그 tick부터 새 세션을 시작하지 않는다. Maintainer 통합으로 미완료 청크의 view가 바뀌면 이전 응답은 `superseded-<view>.txt`로 보존하고 그 청크만 새 세션으로 다시 판정한다. 모드는 배치 행과 같은 트랜잭션에 기록되며(`s3_mode_<id>`), 모드가 없는 진행 중 샤드는 직렬로 끝난다. worker는 다른 AI/CLI를 띄울 수 없다. 값 변경은 `r` 리로드 후 다음 배정부터 적용된다.
- 자동 장애 접수·복구(#3349, #3326): C·D·Stage 2·Stage 3 배치가 **비-ERROR → ERROR로 전이할 때마다** 사건 번호(`batches.error_seq`)가 하나 늘고(같은 ERROR 안의 반복·문구 변경은 번호·최초 시각·최초 원문을 바꾸지 않음), Maintainer sweep이 프로세스·task run 종료를 확인한 뒤 사건마다 incident 1건(PAUSED + urgent Issue)으로 접수한다. A/B, Maintainer `m`, Stop, Clear 중 실패, 사건 번호가 없는 배포 전 ERROR는 접수하지 않는다. 접수 트랜잭션은 운영자 제어(Clear·Stop·Retry·stop pin·defect hold)를 다시 확인하며 하나라도 있으면 ERROR를 그대로 둔다. worktree가 없어도 접수하고 관측 항목은 `ok`/`missing`/`unknown`으로 기록한다. 수정 후 **같은 구조화 증거 지문**이 재발하면 새 incident 없이 ERROR를 유지하고 이전 Issue에 한 번 알린다. 수정 반영은 두 가지로 증명한다 — Runtime-only(`tools/warroom/warroom|prompts` 변경: worktree 통합 없음, `integrated_sha`=NULL, `applied_code_sha` 기록. Python은 실행 중 `code_sha`가 수정을 포함해야 하며 재시작이 필요하면 로그로 알리고 대기, 프롬프트는 메인 checkout 반영 + 재개 launch가 그 프롬프트를 실제로 렌더함이 증명돼야 하며 프로세스 재시작은 필요 없음)와 Worktree integration(통합 HEAD를 FIX_MERGED 상태에서 직접 증명하고 run baseline guard를 사전 실행해 통과해야 RELEASED로 확정; 최초 기준 HEAD/checkpoint는 바꾸지 않음). 증명할 수 없는 단계는 incident를 HELD로 두고 배치를 PAUSED로 보존하며 사유를 Issue에 남긴다. incident release는 Line의 run/drain 플래그를 바꾸지 않는다.
- D 청크 병렬(#3074): 오너가 승인한 War Room Supervisor가 배포 후 새로 시작하는 D 배치의 25-record 청크를 배치 내부에서 최대 4개(`dchunk.MAX_PARALLEL`, 설정 없음)까지 동시에 실행한다. 청크마다 task(`s2_tasks`, ID `001`…)와 run(`runs.task`)이 있고, 슬롯은 SAVED 여부가 아니라 종료가 확인되지 않은 run 수로 센다. 배치당 Candidate 파일·PR 하나, 공유 cursor·claim·worktree·branch는 그대로이며 모드 키(`d_mode_<id>`)가 없는 진행 중 배치는 직렬로 끝낸다. 수정·resume·technical-skip·Retry 기회는 청크별이다. worker가 다른 AI·CLI·서브에이전트를 실행할 권한은 없다.
- C 청크 병렬(#3076): 오너가 승인한 War Room Supervisor가 배포 후 새로 시작하는 C 배치의 12-Sense 청크를 배치 내부에서 최대 4개(`literary.MAX_PARALLEL`, 설정 없음)까지 동시에 실행한다. 청크 번호가 task ID(`s2_tasks`)이며 task 수는 렌더링에 따라 늘어난다. 각 task는 활성 청크(`c-active-NNN.json`)의 Sense만 소유하고, 이미 예약된 Sense는 `--exclude-sense-ids`로 제외한다(남은 Sense가 모두 예약된 빈 view는 정상 대기). 슬롯은 종료가 확인되지 않은 run 수로 센다. 수정(자동 2회 + 운영자 Retry당 1회)·무제출 복구·technical-skip 권한은 task별이며, 운영자 Retry는 `c_parallel_retry_epoch_<id>`로 한 번만 부여된다. 배치당 checkpoint·Candidate 파일·PR 하나, 공유 cursor·claim은 그대로이고 현재 승인 runtime baseline은 `c_run_start_<id>` 하나다. 모드 키(`c_mode_<id>`)가 없는 진행 중 배치는 직렬로 끝낸다. worker가 다른 AI·CLI·서브에이전트를 실행할 권한은 없다.
- 상태 DB: `tools/warroom/.local/warroom.db`. 로그·worktree: `tools/warroom/.local/` 아래. Supervisor 단일 실행 lock과 일시적 Stage 2 fallback 권한 증거는 worker가 쓰지 못하도록 공유 Git 관리 디렉터리의 `typewriter-supervisor/`에 둔다. `.local`은 Git에서 제외되므로 인증·로그를 커밋하지 않는다.
- Codex 권한 문제가 나면 `~/.codex/config.toml`의 지정 `permission_profile`을, Claude 권한 문제가 나면 `~/.claude/settings.json` 등 로컬 권한 설정을 확인한다. War Room이 임의로 권한을 넓히지는 않는다.

추가 생산·검증 절차의 정본은 [Relation Factory](../../docs/relation-factory.md) 및 [Stage 2 Issue #927](https://github.com/neverworkalone/typewriter/issues/927)이다. 이 README는 개발 설계서가 아니라 **오너용 운영 명령 모음**으로 유지한다.

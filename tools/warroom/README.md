# War Room — 운영 가이드

War Room은 Relation Factory의 Stage 2 Admission과 Stage 3 이후 Refinement, 숨은 Maintainer를 Claude·Codex로 운영합니다.
Stage 1(A/B/C/D) 후보 생산, DeepSeek/OpenCode와 Web Dashboard는 #9933에서 제거했습니다. 과거 기록은 DB에서 조회만 가능하며 실행 대상이 아닙니다.

오너가 사용하는 실행·설정·로그 조회·장애 대응 명령만 정리합니다. 별도 표시가 없으면 모든 명령은 **Typewriter 저장소 루트**에서 실행합니다.

## 실행 로그 조회

`runs.log_file`은 최초 생산, 재개, 리뷰 수정 등 **각 run의 로그**를 가리킵니다. `batches.log_file`은 마지막 로그 하나만 나타낼 수 있습니다. 다음 명령은 시간순 경로를 macOS 클립보드에 복사하며, 마지막 `| paste -sd ' ' - | pbcopy`를 제거하면 터미널에 출력합니다.

**PR 번호 기준** (`2046`을 대상 번호로 변경):

```sh
sqlite3 -readonly -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.pr_number=2046 AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

**Stage/배치 기준** (예: Stage 2, shard `001`, Part `02-02`, Codex):

```sh
sqlite3 -readonly -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.method='s2' AND b.shard='001' AND b.batch='02-02'
     AND b.producer='codex' AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

Stage 3는 `b.method='s3'`로 바꿔 shard 단위로 조회합니다. 과거 Stage 1 기록은 `b.method`를 `'a'`~`'d'`로 바꿔 같은 방식으로 조회할 수 있습니다. `SELECT r.kind, r.log_file`로 바꾸면 실행 종류도 확인할 수 있습니다. 로그 내용은 `less <로그경로>` 또는 `tail -f <로그경로>`로 읽습니다.

## 실행 및 설정

아래 명령은 저장소 루트에서 실행합니다.

```sh
./war                 # TUI 열기/재연결; 대기 중인 재시작 요청 확인 및 미실행 Supervisor 기동
./kwar                # Supervisor 인스턴스만 안전하게 교체한 뒤 TUI 열기/재연결
```

설정 변경은 `tools/warroom/.local/config.json` 수정 후 TUI의 `r`로 리로드합니다. 기존 AI run의 프로필·세션은 바뀌지 않습니다. 새 모델에 따른 TUI 열 구성은 TUI를 다시 열어야 반영될 수 있습니다.

지원 adapter는 `claude`와 `codex`뿐이며 단계별 프로필은 `assignments.stage2`, 등록된 정제 Stage마다 `assignments.<role>`(현재 `assignments.stage3`) 및 `maintainer`로 지정합니다(`tools/warroom/config.example.json`). 정제 Stage는 **자기 role의 배정만** 사용합니다. 배정이 없으면 다른 Stage 프로필이나 producer 직접 핀으로 대신하지 않고, 그 Stage의 샤드 선정 시점에 정제 라인만 `BLOCKED`(사유 `assignments.<role>`)로 멈춥니다. Stage 2와 Maintainer는 계속 동작합니다. 이전 Stage 1·DeepSeek/OpenCode 설정(`methods`, `assignments.stage1*`, `adapter: "opencode"`인 모델·프로필, `opencode_bin`, `free_model_pattern`, 인덱스 경로 등)이 남아 있으면 기동과 리로드 때 경고만 남기고 무시합니다. 그 밖의 잘못된 값(알 수 없는 adapter, 오타, 없는 프로필 참조)은 이전처럼 거부합니다. **설정 리로드는 Python 코드 재시작이 아닙니다.**

### 설정 전환 (#9934)

- `stage3_max_parallel`은 `refine_max_parallel`(기본 16)로 바뀌었습니다. `.local/config.json`에 옛 이름만 있으면 그 값을 새 키로 옮기고 기동 경고에 표시합니다. 경고를 확인한 뒤 파일의 키 이름을 직접 `refine_max_parallel`로 바꾸세요. 두 이름이 함께 있으면 설정 오류로 Start와 리로드를 거부합니다.
- 상한은 **샤드의 병렬 계획을 처음 만들 때** 그 샤드의 기준 기록(`s3_parallel_start_<id>`)에 고정됩니다. 리로드나 Supervisor 재시작은 진행 중 샤드의 상한을 바꾸지 않고, 다음 새 샤드부터 적용됩니다. 전환 전부터 진행 중인 샤드는 새 코드가 처음 확인할 때의 유효값을 한 번 기록해 이후 그대로 사용합니다. `stage2_max_parallel`·`supervisor_workers`는 그대로입니다.
- 실행 중인 세션은 기록된 RunSpec(model/effort/permission_profile/fast)을 유지합니다. 세션 재개 때 현재 배정이 기록과 다르면 재개하지 않습니다(기존 계약). TUI 상세의 model id/effort는 실행 중이면 그 실행 기록, 실행 사이에는 배치 Stage의 배정, 완료 후에는 마지막 실행 기록을 표시합니다.

### 정제 Stage 추가 방법

정제 라인(TUI의 **Refinement** 카드, 내부 method `s3`)은 등록된 Stage를 순서대로 실행합니다. 한 Stage의 전체 샤드가 끝나야 다음 Stage로 넘어가며 각 샤드는 이전 Stage 성공에 묶입니다. 마지막 등록 Stage까지 끝나면 정상 종료합니다. 새 Stage는 다음만 추가하며 Supervisor·병렬 엔진·TUI·설정 파서·복구 코드는 고치지 않습니다.

1. Stage 모듈 `tools/warroom/warroom/<name>.py`: `refine.register(refine.RefineSpec(id=..., tag=..., label=..., role=..., short=..., issue=..., cli=..., scratch=..., title=..., ...))`로 spec을 등록하고, 답 규칙(`decision_text`·`decision_context`·`validate_prompt_view`·`normalize_decisions`)과 `fixcoord.FixSpec`을 둡니다(`stage3.py` 참고). `role`은 고유해야 하며 `stage2`·`maintainer`는 예약어입니다. 편집 범위가 다르면 spec의 `allowed()`에서 정의합니다.
2. 등록 진입점 `tools/warroom/warroom/refine.py`의 `STAGE_MODULES`에 모듈 이름을 실행 순서대로 한 줄 추가합니다(예: `("stage3", "<name>")`). 자동 탐색은 없습니다.
3. 프롬프트 `tools/warroom/prompts/<chunk_prompt>.md`·`<fix_prompt>.md`·`<policy_card>.md`와, `scripts/relation/refine/core.mjs` 기반 Stage CLI(`prepare`·`read-chunk`·`save-chunk`·`apply`·`report`·`amend`)를 둡니다.
4. 운영 설정에 `assignments.<role>`을 추가합니다. 예: `"stage4": {"codex": "sol", "claude": "sonnet-medium"}`.

## Supervisor 재시작과 코드 반영 (#5162)

**Supervisor 재시작은 배치 Retry나 AI 재생산이 아니라 Supervisor 프로세스 교체입니다.** 새 인스턴스는 DB·PID/종료 기록·checkpoint·worktree·Git HEAD/remote·PR 상태를 다시 확인하고 기존 작업을 이어갑니다. 다른 Line의 AI·Worker·finalization 완료를 전역적으로 기다리지 않습니다. 사용자 Stop/Clear/Drain 및 defect hold는 그대로 유지하며, 소유권이나 쓰기 결과가 불확실한 자원은 해당 범위만 보류합니다.

### 어떤 명령을 사용할까?

- **`./war` — 일반 진입점.** 기존 TUI(`warroom`)에 재연결하거나 새로 엽니다. 대기 중인 재시작 요청을 Controller로 확인하고, Supervisor가 없으면 기동합니다. 이미 정상 실행 중인 Supervisor를 무조건 교체하지는 않습니다.
- **`./kwar` — 운영자 수동 Restart.** `./war --replace`를 통해 Controller의 안전한 교체 경로를 사용합니다. 같은 코드 SHA라도 **새 Supervisor의 PID·instance ID·실제 소유권**이 확인되어야 성공입니다. 기존 TUI 세션과 분리 실행 중인 AI·배치·checkpoint·PR은 보존합니다. `./kwar`만으로 새 코드를 가져오지는 않지만, 이미 대기 중인 코드 갱신 요청이 있으면 한 번의 교체 절차에서 함께 처리합니다.
- **Maintainer 수정 머지 — 자동 코드 갱신 요청.** Supervisor가 `.git/typewriter-supervisor/restart-requests/`에 영속 요청을 기록합니다. 실행 중인 TUI는 새 Controller 프로세스를 주기적으로 호출해 요청을 처리하므로 TUI를 재시작하거나 운영자가 `git pull`할 필요가 없습니다. TUI가 실행 중이 아니라면 다음 `./war` 진입 시 요청 처리를 이어갑니다.

특정 커밋의 Supervisor 코드 로드를 별도로 요청하려면 다음 명령을 사용합니다.

```sh
TYPEWRITER_WARROOM_ROOT="$PWD" PYTHONPATH="$PWD/tools/warroom" \
  tools/warroom/.local/venv/bin/python -m warroom.restart_controller --request-code-sha <FULL_SHA>
```

`<FULL_SHA>`는 **설정된 원격 base 브랜치에 머지된 40자리 소문자 커밋 SHA**여야 하며, 요청 시 운영 checkout의 Supervisor 코드가 깨끗해야 합니다. 이 명령은 요청을 등록하고 Controller를 한 단계 실행합니다. **명령 종료 코드 `0`은 코드 로드 완료의 증명이 아닙니다.** 실제 완료는 아래의 새 인스턴스와 요청 상태에서 확인합니다.

### 실제 교체 및 복구 절차

1. Controller는 실행 중인 Supervisor의 `restart_phase`를 **`RUNNING → STOPPING`**으로 CAS 전환합니다. 이전 `DRAINING → READY` 전역 대기 절차는 사용하지 않습니다. STOPPING에서는 새 Worker·AI·배치·finalization을 시작하지 않습니다.
2. 이미 실행 중인 Supervisor 내부 Worker의 반환을 **최대 30초** 기다립니다. 반복 Restart 요청은 최초 `stopping_at`을 초기화하지 않습니다. 유예가 끝나면 Controller가 **소유권이 확인된 Supervisor만** 종료합니다. 이 30초는 인계 유예이지 `./kwar` 명령 전체의 완료 제한 시간이 아닙니다.
3. 분리된 AI는 중단하지 않습니다. 새 인스턴스가 기존 PID·run·exit_file을 다시 감시하고, 미완료 Git/Node 자식은 fence journal과 실제 자원 소유권으로 판정합니다. 미확정 commit/push/PR/Issue는 기존 영속 증거와 원격 상태를 재확인해 중복 실행하지 않습니다.
4. 대기 중인 코드 갱신이 있다면, Controller는 원격 base를 `git fetch`하여 요청 SHA가 포함됐는지 확인하고 **이전 Supervisor 종료 후에만** 운영 checkout을 `merge --ff-only` 합니다. 운영 checkout은 설정된 base 브랜치여야 하며 추적 파일이 깨끗하고, 들어올 파일과 미추적 파일이 충돌하지 않아야 합니다. `pnpm-lock.yaml` 변경이나 대상 Supervisor 코드·운영 설정의 기동 검증 실패도 갱신을 막습니다. `reset`·`stash`·강제 병합은 하지 않습니다.
5. 코드 갱신이 보류돼도 기존 코드로 운영을 유지합니다. **명시적 인스턴스 교체는 가능한 경우 기존 코드로라도 진행**하고, 미반영 코드 요청은 사유를 기록해 약 5분 뒤 재확인합니다. 기동·소유권 자체를 증명할 수 없는 경우에는 성공으로 보고하지 않습니다.

### 성공·보류 확인

- `./kwar` 종료 코드: **`0`** 새 Supervisor 인스턴스 확인 후 TUI 열기, **`1`** 교체 거부/실패, **`2`** 제한 시간 내 새 인스턴스 미확인. 실패/미확인 시 TUI를 열지 않고 사유를 출력합니다. 기존 작업은 보존되며, `2`를 성공으로 간주하거나 반복 호출로 해결하지 않습니다.
- **인스턴스 교체 성공과 코드 반영 완료는 서로 다릅니다.** `./kwar`가 `0`이어도 대기 중인 코드 요청은 `waiting`일 수 있습니다. `.git/typewriter-supervisor/supervisor-runtime.json`의 `instance`·`pid`·`loaded_code_sha`를 확인하고, 해당 `restart-*.json`이 `loaded`에 도달했는지 구분하세요. 요청/보류 사유는 TUI의 Supervisor 상태와 Audit Log에도 남습니다.
- 코드 로드와 PR 머지만으로 Maintainer 복구가 완료되는 것은 아닙니다. 원래 배치의 공식 저장·검증 및 생산 재개 상태까지 확인합니다.

`supervisor_workers`의 기본값은 **16**입니다(`tools/warroom/config.example.json`). 운영 설정에 `1`을 우연히 남기지 마세요. `1`은 직렬 회귀·장애 폴백 전용이며 1→4→16 단계 확대 절차를 다시 진행하지 않습니다.

프롬프트·설정·Supervisor는 **운영 메인 checkout**에서만 읽으며 임시 worktree를 실행 루트로 바꾸지 않습니다. **`.local/` 삭제, DB 수동 초기화, 수동 `tmux kill-session`·signal 종료, 코드 로드를 위한 배치 Retry는 금지**합니다. 일반 운영자는 `./war`와 `./kwar` 및 위 공식 코드 갱신 요청만 사용합니다.

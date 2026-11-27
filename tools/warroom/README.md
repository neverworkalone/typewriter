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
./war                 # TUI 열기/재연결; 대기 중인 재시작 요청 확인 및 미실행 Supervisor 기동; ./recovery 감시 시작
./kwar                # Supervisor 인스턴스만 안전하게 교체한 뒤 TUI 열기/재연결
./kwar --no-attach    # 교체만 하고 0/1/2 결과로 끝냄 (TUI를 붙이지 않음: 복구 실행·watchdog용)
./recovery status     # Recovery watchdog과 Supervisor 상태 (아래 "Recovery")
```

설정 변경은 `tools/warroom/.local/config.json` 수정 후 TUI의 `r`로 리로드합니다. 기존 AI run의 프로필·세션은 바뀌지 않습니다. 새 모델에 따른 TUI 열 구성은 TUI를 다시 열어야 반영될 수 있습니다.

지원 adapter는 `claude`와 `codex`뿐이며 단계별 프로필은 `assignments.stage2`, 등록된 정제 Stage마다 `assignments.<role>`(현재 `assignments.stage3`, `assignments.stage4`, Drop 라인의 `assignments.d1`) 및 `maintainer`로 지정합니다(`tools/warroom/config.example.json`). 정제 Stage는 **자기 role의 배정만** 사용합니다. 배정이 없으면 다른 Stage 프로필이나 producer 직접 핀으로 대신하지 않고, 그 Stage의 샤드 선정 시점에 정제 라인만 `BLOCKED`(사유 `assignments.<role>`)로 멈춥니다. Stage 2와 Maintainer는 계속 동작합니다. 이전 Stage 1·DeepSeek/OpenCode 설정(`methods`, `assignments.stage1*`, `adapter: "opencode"`인 모델·프로필, `opencode_bin`, `free_model_pattern`, 인덱스 경로 등)이 남아 있으면 기동과 리로드 때 경고만 남기고 무시합니다. 그 밖의 잘못된 값(알 수 없는 adapter, 오타, 없는 프로필 참조)은 이전처럼 거부합니다. **설정 리로드는 Python 코드 재시작이 아닙니다.**

### 설정 전환 (#9934)

- `stage3_max_parallel`은 `refine_max_parallel`(기본 16)로 바뀌었습니다. `.local/config.json`에 옛 이름만 있으면 그 값을 새 키로 옮기고 기동 경고에 표시합니다. 경고를 확인한 뒤 파일의 키 이름을 직접 `refine_max_parallel`로 바꾸세요. 두 이름이 함께 있으면 설정 오류로 Start와 리로드를 거부합니다.
- 상한은 **샤드의 병렬 계획을 처음 만들 때** 그 샤드의 기준 기록(`s3_parallel_start_<id>`)에 고정됩니다. 리로드나 Supervisor 재시작은 진행 중 샤드의 상한을 바꾸지 않고, 다음 새 샤드부터 적용됩니다. 전환 전부터 진행 중인 샤드는 새 코드가 처음 확인할 때의 유효값을 한 번 기록해 이후 그대로 사용합니다. `stage2_max_parallel`·`supervisor_workers`는 그대로입니다.
- 실행 중인 세션은 기록된 RunSpec(model/effort/permission_profile/fast)을 유지합니다. 세션 재개 때 현재 배정이 기록과 다르면 재개하지 않습니다(기존 계약). TUI 상세의 model id/effort는 실행 중이면 그 실행 기록, 실행 사이에는 배치 Stage의 배정, 완료 후에는 마지막 실행 기록을 표시합니다.

### 정제 Stage 추가 방법

정제 라인(TUI의 **Refinement** 카드, 내부 method `s3`)은 등록된 Stage를 순서대로 실행합니다. 한 Stage의 전체 샤드가 끝나야 다음 Stage로 넘어가며 각 샤드는 이전 Stage 성공에 묶입니다. 마지막 등록 Stage까지 끝나면 정상 종료합니다. 새 Stage는 다음만 추가하며 Supervisor·병렬 엔진·TUI·설정 파서·복구 코드는 고치지 않습니다.

1. Stage 모듈 `tools/warroom/warroom/<name>.py`: `refine.register(refine.RefineSpec(id=..., tag=..., label=..., role=..., short=..., issue=..., cli=..., scratch=..., title=..., ...))`로 spec을 등록하고, 답 규칙(`decision_text`·`decision_context`·`validate_prompt_view`·`normalize_decisions`)과 `fixcoord.FixSpec`을 둡니다(`stage3.py` 참고). `role`은 고유해야 하며 `stage2`·`maintainer`는 예약어입니다. 편집 범위는 spec의 `scope()` 하나가 정의합니다(두 파일 Stage는 `allowed()`, 다른 샤드 관계도 편집하는 Stage는 `cross_shard=True`). 무변경 샤드를 PR 없이 완료하려면 `no_change_complete=True`, 정책 거부를 Keep-all로 저장하지 않으려면 `refusal_keep_all=False`, 자체 PR 본문은 `body`로 지정합니다(`stage4.py` 참고).
2. 등록 진입점 `tools/warroom/warroom/refine.py`의 `STAGE_MODULES`에 모듈 이름을 실행 순서대로 한 줄 추가합니다(예: `("stage3", "<name>")`). 자동 탐색은 없습니다.
3. 프롬프트 `tools/warroom/prompts/<chunk_prompt>.md`·`<fix_prompt>.md`·`<policy_card>.md`와, `scripts/relation/refine/core.mjs` 기반 Stage CLI(`prepare`·`read-chunk`·`save-chunk`·`apply`·`report`·`amend`)를 둡니다.
4. 운영 설정에 `assignments.<role>`을 추가합니다.

### Drop 라인 — D1 운영 설정 (#10171)

D1(확정 Skip Sense 전체 Drop)은 정제 엔진의 **두 번째 라인**(`DROP_METHOD = "drop"`, Board의 Refinement 아래 `Drop` 칸)에서 돕니다(`stage_d1.py`, CLI `scripts/relation/d1-cli.mjs`, 프롬프트 `d1_chunk`·`d1_fix`·`d1_policy_card`, 범주 카드는 공통 `whole_drop_card`). 병렬 청크·최종화·Review FIXING·replay는 Refinement 라인과 같은 엔진이며, 생산 지시는 #10171, 리뷰 경계는 #10274(`docs/review/prompts/d1.md`)입니다.

- **착수:** 001–428 전체의 Stage 3 완료 기록(`s3_ok_SSS`)과 **같은 샤드의 Stage 4 완료 기록**(`s4_ok_SSS`: 머지 후 verify 통과 또는 공식 no-change)이 있어야 그 샤드를 시작합니다(#10330). S4 실행 중·리뷰/CI 대기·실패는 완료가 아니며, 다른 샤드의 S4 진행 여부와 S4 전체 완료는 상관없습니다. 배정은 `assignments.d1`이며 모델·effort는 오너가 지정합니다(예: `"assignments": { "d1": { "codex": "sol" } }`).
- **병행과 점유:** Drop 라인은 자기 라인 안에서만 한 번에 한 샤드를 점유합니다. Refinement 라인(S4)의 배치·PR은 Drop 라인을 막지 않고, 반대도 같습니다. 정상적인 다른 라인의 Relation 전용 PR(제목·이슈 링크·Relation 파일만)은 점유로 보지 않으며, 실제 키 충돌은 `replay-cli --relations-only`가 처리합니다. 같은 라인의 열린 생산 PR은 로컬 배치가 없어도 그 샤드를 점유합니다. 파일 목록을 알 수 없는 PR은 점유 없음으로 처리하지 않습니다.
- **열린 PR 조회:** `open_prs()`는 PR 메타데이터만 가져오고, 파일 목록은 점유 판단에 필요할 때 PR마다 한 번 페이지 단위로 조회합니다. 조회 실패는 그 PR 번호와 함께 오류로 남습니다.
- **판정 보존과 verify:** D1 CLI는 apply 뒤에도 checkpoint와 view를 배치 worktree에 남깁니다. 최종화·리뷰 수정·replay 뒤의 exact-commit verify는 `d1-cli verify --shard SSS --base <merge-base> --judgments <배치 worktree>`로, 자기 파일 `relation-SSS.jsonl`에서 D Sense의 관계가 빠짐없이 지워졌고 그 밖의 변경(다른 파일 포함)이 없는지만 봅니다. 머지 후에는 머지된 변경(`merge_sha^1..merge_sha`)을 같은 CLI verify로 확인한 뒤에만 `d1_ok_SSS`를 기록합니다. D1은 자기 Relation 파일 하나만 바꾸며(`cross_shard=False`), 다른 샤드가 소유한 D Sense 대상 관계는 남깁니다.
- **무변경 샤드:** 지울 관계가 없으면 `d1_nochange_SSS`·`d1_ok_SSS`를 기록하고 commit·PR 없이 정리합니다.
- **PR:** 제목 `[D1/<Model>] SSS`, 본문 `Refs #10171`. 본문은 apply 결과의 판정 집계(검토 Sense, D/N/H/Policy Skip, 범주별 D), 삭제한 고유 관계 수, 변경 파일·샤드 수, 비용을 씁니다.
- **리뷰 수정:** 리뷰가 지목한 Sense의 보존 판정(과 그 base 관계)만 PR context로 줍니다. 수정은 `d1-cli amend`의 `D <sense_id> <1-11>` / `N` / `H`입니다.

### Stage 4 운영 설정 (#9928, #9929)

Stage 4(선별적 Polish)는 Stage 3 다음에 등록된 정제 Stage입니다(`stage4.py`, CLI `scripts/relation/s4-cli.mjs`, 프롬프트 `s4_chunk`·`s4_fix`·`s4_policy_card`). Stage 3의 전체 샤드가 끝나야 시작하고, 각 샤드는 Stage 3 완료(`s3_ok_SSS`)에 묶입니다. 생산 지시는 #9929입니다.

로컬 `tools/warroom/.local/config.json`에는 **기존 값은 그대로 두고** 다음 두 항목만 추가합니다(로컬 설정은 커밋하지 않습니다). 이미 `sol` 프로필이 있으면 첫 항목은 건너뜁니다.

```json
"model_profiles": { "sol": { "adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium", "permission_profile": "worktree" } },
"assignments": { "stage4": { "codex": "sol" } }
```

저장 후 TUI에서 `r`로 리로드합니다. Stage 2/3·Maintainer 배정과 진행 중 작업은 바뀌지 않습니다. `refine_max_parallel`(기본 16)은 Stage 4 샤드에도 같은 의미로 적용됩니다. 다른 provider 배정은 오너가 결정하며, 배정이 없는 provider의 Line은 Stage 4 선정 시점에 `BLOCKED`로 멈춥니다.

- **무변경 샤드:** 모든 청크가 정상 판정·저장되고 공식 apply가 변경 없음을 확인하면, 그 HEAD를 shard verify한 뒤 `s4_nochange_SSS`·`s4_ok_SSS`를 기록하고 commit·PR 없이 worktree를 정리합니다. 다음 샤드 선택은 마지막 머지 PR 뒤의 연속된 무변경 완료를 건너뜁니다.
- **cross-shard·Relation 전용 PR (#9929):** 역방향 관계 편집으로 다른 샤드의 Relation 파일이 바뀔 수 있습니다. Drop 파일은 어느 샤드든 바뀌지 않습니다. spec은 `relations_only=True`이고, 이 값이 PR 검증·최종화·replay의 범위를 함께 정합니다. 생산 샤드 Sense를 한쪽 끝으로 갖는 관계의 편집 범위는 공식 CLI가 정합니다.
  - 최종화·리뷰 수정·replay 뒤의 verify는 `s4-cli verify --shard SSS --base <merge-base>`입니다. 영향 샤드 전체의 Relation 무결성을 한 번에 검사하고, Candidate·Drop은 읽지 않습니다.
  - 충돌 replay는 Supervisor가 `replay-cli --relations-only`로 실행합니다.
- **응답 누락:** 판정이 하나도 남지 않은 청크 응답은 응답 누락 경로(새 세션 1회)로 갑니다. Keep-all을 만들지 않습니다.
- **정책 거부 — record 단위 Policy Skip (#10047):** provider의 공식 거부는 그 실행 view의 Canonical record에 결속합니다.
  - 여러 record인 청크는 `SPLIT`이 되고, record마다 `NNN-<record_id>` task를 **한 번만** 실행합니다. 같은 슬롯·상한을 쓰고, 청크 번호를 그대로 쓰는 `read-chunk --record` view로 실행합니다. 단일 record 청크는 이미 결속되어 있으므로 바로 `POLICY`가 됩니다.
  - record 응답은 `RESPONDED`, record 거부는 `POLICY`입니다. 그 밖의 결과(판정 없음, 모든 실패, 중단된 실행, view 변경)는 재실행 없이 `HELD`가 됩니다.
  - 모든 record가 정리되면 응답 본문과 `P <거부 record>`를 합성해 기존 단일 writer로 저장합니다. record task는 `MERGED`가 됩니다. 모두 `none`이면 `none`으로 저장하고 이슈를 만들지 않습니다.
  - Policy Skip이 있으면 저장 전에 기존 수동 Issue 경로에 `[Policy Skip][S4/<producer>] SSS Chunk NNN`(record ID·표제어·Sense·사유)을 남깁니다.
  - 결속할 수 없는 거부나 `HELD` record가 있는 청크는 `HELD`로 미완료를 유지합니다. 다른 청크는 계속 진행합니다. 나머지가 모두 저장되면 `[Policy Hold]` 보고를 남기고 최종화 없이 ERROR로 멈춥니다. Retry해도 거부 내용은 재제출되지 않으므로 오너 결정이 필요합니다.

## Recovery (복구 lane)

Recovery는 예전 `tools/warroom/recovery-desk`의 복구 점검반을 Supervisor 안으로 옮긴 것입니다. LLM 앱이 닫혀 있어도
돕니다. **감지는 결정적**입니다. 주기적인 AI 점검은 없고, Supervisor가 확인된 장애로 case를 열 때만 Claude/Codex 복구
실행이 시작됩니다. 복구 실행의 계약은 `prompts/recovery.md`입니다. 증거 확인 → 원인 → 공통 수정 → PR·리뷰·머지 →
운영 반영(`git merge --ff-only origin/master` 후 `./kwar --no-attach`) → 원 task의 공식 저장·검증 → 정상 생산 지속까지가
그 책임입니다.

### 설정

```json
"maintainer": "terra",
"recovery": "sonnet",
"recovery_max_parallel": 1,
"recovery_stall_seconds": 600
```

- `recovery`는 `maintainer`와 같은 방식으로 **모델 ID 또는 프로필 ID**를 받습니다. `null`(기본)이면 꺼집니다. Claude와
  Codex 모두 됩니다. Claude는 `--permission-mode auto`로, Codex는 운영 Git 관리 디렉터리(`--add-dir`)와 프로필의
  `permission_profile`로 실행합니다. Codex 프로필에 `permission_profile`이 없으면 실행하지 않습니다(후속 지시
  `codex exec resume`이 Git 관리 디렉터리를 열 수 없음).
- `recovery_max_parallel`(1~2): 동시에 도는 복구 실행 수. 일일 상한이나 후속 횟수 제한은 없습니다.
- `recovery_stall_seconds`(기본 600, 60 이상): 정체 판정의 관찰 간격. 정체만 이 간격으로 **연속 3회** 확인합니다.

### 감지

Supervisor의 `tick`과 병렬 Coordinator가 매 턴 `Recovery.step()`을 부릅니다. 자기 `try` 안에서 돌기 때문에 Recovery의
오류가 Line을 멈추지 않습니다. STOPPING 중에는 새 실행을 시작하지 않고 모든 AI 시작은 `launch_gate`를 거칩니다.

- **정상(추적만, AI 없음)**: 진행 중인 작업(task/run·공식 저장·로그가 움직임), 리뷰·CI 대기, QUEUED·idle, 오너
  Stop·force-stop PAUSED, Clear 요청, `run=0`, 실제 실행 한도(사용량 한도 PAUSED).
- **즉시 case** (다음 처리 턴에 바로): 배치 `ERROR`·(오너 Stop이 아닌) `PAUSED`, 진행하지 않는 Maintainer에 묶인 공통
  결함·HELD Maintainer, PR 충돌·필수 CI(`Validate and test Typewriter`) 실패·처리되지 않은 리뷰 `-1`(직전 확인 뒤 새 push나
  수정 run이 없을 때), 머지된 수정의 반영 차단(restart request의 같은 `blocker`가 한 관찰 간격 동안 그대로), Maintainer 정지.
  Maintainer의 ERROR 접수가 가능한 ERROR는 접수할 차례를 먼저 줍니다(120초).
- **정체**: 진행 상태인데 task/run/공식 저장 진전이 3회 연속 없음. 배치 PID 하나·마지막 run 하나·로그 mtime 하나로
  정상/정지를 판정하지 않습니다.
- **머지 정체**: 현재 HEAD에 `+1`, 그 뒤 `-1` 없음, 필수 CI `SUCCESS`, `MERGEABLE`/`CLEAN`, `+1` 뒤 30분 이상이면
  Supervisor가 AI 없이 `gh pr merge --squash --match-head-commit <HEAD>`로 직접 머지합니다. Maintainer PR과 오너·외부 PR은
  대상이 아닙니다. 머지가 실패하면 case가 열립니다.
- Drain은 "현재 배치는 끝내고 다음 배치를 시작하지 않음"이므로 Drain 중인 Line의 현재 배치도 복구합니다. 다음 배치 차단은
  그대로입니다.

### 소유와 상태

- case 하나가 장애 묶음 하나입니다: `defect:<issue>`(공통 결함·Maintainer Issue와 그 종속 배치), `batch:<id>`, `supervisor`(하나뿐).
  배치 하나는 열린 case 하나에만 속합니다(`recovery_case_batches`).
- Maintainer가 정상 진행 중이면 case는 `MAINTAINER`(추적만)입니다. **Maintainer가 멈췄으면** 공식 `control.stop_maintainer`로
  넘겨받고, Maintainer 실행이 끝난 것을 확인한 뒤에만 복구 실행을 시작합니다. 같은 장애를 둘이 동시에 고치지 않습니다.
  복구가 끝나면 `control.retry_maintainer`로 되돌립니다.
- 상태: `OPEN`(실행 필요) · `MAINTAINER` · `TRACKING`(리뷰·CI·머지·정상 생산 지속 확인 대기, AI 없음) · `WAITING_OWNER` ·
  `RESOLVED`.
- 실행 보고(`STATUS`/`BOUNDARY`/`PR`)는 **주장**입니다. `RESOLVED`는 유형별 공식 증거로만 기록합니다: 실패 task의 공식
  저장과 그 뒤 생산 지속, PR 차단 해소와 머지·정리 진행, Maintainer 정상화와 종속 배치 복구, 새 Supervisor instance와
  `loaded_code_sha`의 수정 포함. 복구 PR은 머지(또는 superseded로 닫힘)되고 `code_sha`에 들어와야 합니다.
- `BOUNDARY` 주장(`limit`·`owner_control`·`denied`·`ownership`)은 공식 기록과 맞을 때만 `WAITING_OWNER`가 되고, 그
  기록이 풀릴 때만 풀립니다. `denied`는 `./recovery resume <case-id>` 또는 확인된 설정 변경으로 풉니다.
- 반복 방지: 같은 증거에 같은 지시는 다시 보내지 않습니다. 대신 근본 원인 조사·공통 수정 지시로 바꾸고, 그래도 진전이
  없으면 포기하지 않고 증거가 바뀔 때까지 30분 → 최대 6시간 간격으로 다시 확인합니다.

### 재시작 생존과 이어받기

- 복구 실행은 adapter의 분리 프로세스 그룹에서 돕니다. 복구 실행이 직접 부르는 `./kwar`도, watchdog의 재시작도 그 실행을
  죽이지 않습니다.
- 실행 기록(핀·로그·exit 경로)은 spawn **전에** `recovery_runs`에 남고, pid는 wrapper의 `<exit>.pid`로도 복구됩니다. 새
  Supervisor는 매 턴 열린 실행을 같은 기록으로 이어받습니다. case당 열린 실행은 하나뿐이며, 이 판정은 Supervisor·새
  instance·watchdog이 같이 쓰는 DB 문장 하나(`store.CLAIM_RECOVERY_RUN_SQL`)입니다.
- 복구 실행 기록은 `runs`가 아니라 `recovery_*` 테이블에 있어서 배치나 재시작 drain을 막지 않습니다. **열린 `recovery_*`
  행과 그 로그·작업물은 이력 삭제 대상이 아닙니다**(#10357 정리에서 제외).

### 외부 watchdog `./recovery`

Supervisor 자신이 죽었거나 기동하지 못하는 경우만 맡습니다. `tools/warroom/recovery_watch.py`는 표준 라이브러리만 쓰고
`warroom` 패키지를 import하지 않으므로 Supervisor 쪽 오류로 멈추지 않습니다.

```sh
./recovery            # tmux warroom-recovery에서 60초 감시 시작 (이미 돌면 그대로). ./war가 자동으로 시작
./recovery status     # Supervisor·watchdog 상태 JSON
./recovery once       # 한 번만 확인
./recovery pause      # 재시작 일시정지 (unpause로 해제)
./recovery resume <case-id>   # denied로 오너 대기 중인 case 재개
./recovery stop       # 감시 중지
```

- 먼저 `recovery-desk/guard.sh`로 운영 메인 checkout인지 확인하고, 아니면 아무것도 쓰거나 시작하지 않고 exit 3입니다.
- Supervisor가 정상(lock·runtime pid·heartbeat)이면 아무것도 하지 않습니다. 진행 중인 재시작(STOPPING 인계 창, `restarting`
  요청이 계속 확인되는 중, launcher 잠금)은 기다리고, blocker에 멈춘 재시작·죽은 Supervisor는 `./kwar --no-attach`로 한 번
  공식 재시작합니다.
- 그래도 기동하지 않으면 시도 조건(HEAD·config·venv·blocker)과 근거를 `.git/typewriter-supervisor/recovery/watchdog.json`에
  남기고, 한 번 크게 알린 뒤, 원인을 고칠 `supervisor` case와 복구 실행을 같은 DB 판정으로 엽니다(Supervisor가 다시 뜨면
  그 실행을 이어받음). **같은 조건으로는 재시작을 반복하지 않고**, HEAD·설정·환경·blocker가 바뀌면 다시 시도합니다.
- Line 제어(Stop·Drain·`run=0`)는 읽지도 쓰지도 않습니다.

### TUI

Recovery 카드는 Maintainer 카드 **바로 아래 칸**(같은 열, 다음 줄)에 있습니다. 상태는 IDLE / WORKING / TRACKING /
WAITING_OWNER / ERROR이고, watchdog의 기동 실패도 ERROR로 보입니다. Enter는 읽기 전용 상세(case·소유·차단 단위·세션·
마지막 보고·로그·대기 사유)를 엽니다. 제어 버튼은 없습니다.


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

프롬프트·설정·Supervisor는 **운영 메인 checkout**에서만 읽으며 임시 worktree를 실행 루트로 바꾸지 않습니다. **`.local/` 삭제, DB 수동 초기화, 수동 `tmux kill-session`·signal 종료, 코드 로드를 위한 배치 Retry는 금지**합니다. 일반 운영자는 `./war`와 `./kwar`, `./recovery` 및 위 공식 코드 갱신 요청만 사용합니다.

# War Room — 운영 가이드

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

**방식/배치 기준** (예: Method C, shard `001`, batch `01`, Codex):

```sh
sqlite3 -readonly -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.method='c' AND b.shard='001' AND b.batch='01'
     AND b.producer='codex' AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

S2도 같은 쿼리를 사용합니다. `b.method='s2'`, `b.batch='BB-PP'`(예: `'02-02'`)로 바꾸면 Part 단위로 조회합니다. `SELECT r.kind, r.log_file`로 바꾸면 실행 종류도 확인할 수 있습니다. 로그 내용은 `less <로그경로>` 또는 `tail -f <로그경로>`로 읽습니다.

## 실행 및 설정

아래 명령은 저장소 루트에서 실행합니다.

```sh
./war                 # TUI 열기/재연결; 대기 중인 재시작 요청 확인 및 미실행 Supervisor 기동
./kwar                # Supervisor 인스턴스만 안전하게 교체한 뒤 TUI 열기/재연결
./dashboard           # 기존 Supervisor를 공유하는 보조 Web View (http://localhost:8000)
./dashboard --port 8123
```

설정 변경은 `tools/warroom/.local/config.json` 수정 후 TUI의 `r`로 리로드합니다. 기존 AI run의 프로필·세션은 바뀌지 않습니다. 새 모델/Method에 따른 TUI 열 구성은 TUI를 다시 열어야 반영될 수 있습니다. **설정 리로드는 Python 코드 재시작이 아닙니다.**

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

`supervisor_workers`의 기본값은 **16**입니다(`tools/warroom/config.example.json`). 운영 설정에 `1`을 우연히 남기지 마세요. `1`은 직렬 회귀·장애 폴백 전용이며 1→4→16 단계 확대 절차를 다시 진행하지 않습니다. C/D 생산 세션은 운영 checkout의 CLI(`scripts/relation/d-chunk-cli.mjs`, `literary-context-cli.mjs`)를 직접 호출하므로, 코드 갱신 시 이 CLI들의 명령·입출력·checkpoint가 기존 실행과 호환돼야 합니다.

프롬프트·설정·Supervisor는 **운영 메인 checkout**에서만 읽으며 임시 worktree를 실행 루트로 바꾸지 않습니다. **`.local/` 삭제, DB 수동 초기화, 수동 `tmux kill-session`·signal 종료, 코드 로드를 위한 배치 Retry는 금지**합니다. 일반 운영자는 `./war`와 `./kwar` 및 위 공식 코드 갱신 요청만 사용합니다.

### DeepSeek GOAT 슬롯 (#6027)

`f` 선택 창의 **GOAT**는 내부 tier `api`입니다(저장값·RunSpec·로그 키는 `api` 유지). OpenCode v2 설정에
Command Code GOAT provider를 등록합니다. 키는 `COMMANDCODE_API_KEY` 환경 변수로만 주고 repo,
`.local/config.json`, PR, 로그에 기록하지 않습니다.

```json
{
  "providers": {
    "commandcode": {
      "name": "Command Code GOAT",
      "env": ["COMMANDCODE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.commandcode.ai/provider/v1" },
      "models": {
        "deepseek/deepseek-v4-flash": {
          "modelID": "deepseek/deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "variants": [{ "id": "none", "settings": { "reasoningEffort": "off" } }]
        }
      }
    }
  }
}
```

- War Room 모델 ID는 `commandcode/deepseek/deepseek-v4-flash`(`opencode models` 표기), provider에 보내는 ID는
  `modelID`입니다. `tier_efforts.api="none"`은 variant `none` → provider `reasoning_effort=off`로 매핑됩니다.
  정상 응답은 비추론의 증거가 아닙니다. Free/Go는 기존 `effort`를 상속합니다.
- Start 전 GOAT probe는 정상 종료·`text` 응답·최상위 오류 없음을 모두 요구합니다. 인증 실패·모델 없음·
  한도·429는 Start를 막습니다.
- 실행 중 GOAT의 최상위 provider 429는 한도와 일시 오류를 구분할 증거가 없으므로 종료 코드·저장물과 무관하게
  자동 재실행·다음 청크 없이 PAUSED로 보류합니다. Command Code Studio에서 확인한 뒤 Retry하면 저장 증거를
  먼저 재검증해 완료분은 AI 없이 수락하고, 미완료분만 기존 세션 계약으로 재개합니다.
- **Command Code Auto Top-up은 OFF로 둡니다.** 구독 창을 넘기면 남은 on-demand 잔액이 쓰일 수 있습니다.
  War Room은 자동 GOAT 전환·GOAT→Go/Free 폴백을 하지 않습니다. 단가 미설정 시 비용은 unknown입니다.
- 이전 `deepseek/deepseek-flash#none` 세션의 retry/fix resume은 기본적으로 보류됩니다. 검증 후에만
  `"retired_models": {"api": ["deepseek/deepseek-flash"]}`로 같은 effort·권한의 old→GOAT 재개를 허용합니다.
- 전환 순서: DeepSeek 직접 API 잔액 소진 → 진행 중 run/청크 종료 확인 → OpenCode에 provider 등록 →
  Supervisor 시작·교체(`opencode models` 목록은 Supervisor 수명 동안 한 번 읽음) → 로컬 `models.api` 변경 →
  TUI `r` → 50-record 청크 1개 smoke와 Studio 실제 차감 확인 → 점진 확장.

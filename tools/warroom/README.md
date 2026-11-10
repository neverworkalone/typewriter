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

## 실행 및 Supervisor 재시작

```sh
./war                 # TUI 열기/재연결, Supervisor가 없으면 시작
./kwar                # Supervisor만 안전하게 재시작한 뒤 TUI 열기 (운영자용 단일 Restart 진입점)
./dashboard           # 기존 Supervisor를 공유하는 보조 Web View (http://localhost:8000)
./dashboard --port 8123
```

설정 변경: `tools/warroom/.local/config.json` 수정 후 TUI에서 `r`을 눌러 리로드합니다. 실행 중인 AI run의 프로필·세션은 바뀌지 않습니다. **Python 코드 수정은 설정 리로드만으로 적용되지 않습니다.**

### Supervisor 재시작 (#5162)

**Supervisor는 언제든 교체할 수 있고, 새 Supervisor는 각 배치의 기존 상태(DB, 실행 증거, 프로세스, checkpoint, worktree, Git HEAD/remote, PR)를 확인해 그 지점부터 이어갑니다.** 다른 Line의 AI·finalization·Git/Node 작업, Stop/Clear/Drain, defect hold는 Restart를 막지 않습니다. 정상 Restart와 비정상 종료 후 재기동은 같은 경로입니다.

- **`./kwar`** — 지금 운영 checkout에 있는 코드로 Supervisor instance를 교체합니다. TUI(`warroom` 세션), AI run, 배치, checkpoint, PR은 그대로 둡니다. 같은 SHA여도 실제로 새 instance(새 PID·instance ID)가 떠야 성공이며, 이미 대기 중인 코드 갱신 요청이 있으면 같은 교체 1회에 함께 반영합니다. `./kwar` 자체는 코드를 갱신하지 않습니다. 종료 코드: `0` 새 instance 확인(TUI를 엽니다) / `1` 교체 거부·실패 / `2` 제한 시간 안에 미확인. `0`이 아니면 TUI를 열지 않고 사유를 출력합니다. 어느 경우에도 실행 중인 작업은 보존됩니다.
- **Maintainer 수정 머지** — Supervisor가 영속 요청(`.git/typewriter-supervisor/restart-requests/`)을 남기면 TUI가 사람 개입 없이 같은 절차를 진행합니다. TUI는 매번 새 프로세스로 Controller를 실행하므로 TUI를 재시작하지 않아도 배포된 Controller 코드가 쓰입니다.
- **절차** — Controller가 실행 중인 instance를 `RUNNING → STOPPING`(Store `restart_phase`, `BEGIN IMMEDIATE` CAS)으로 옮깁니다. STOPPING인 Supervisor는 새 Worker·AI·배치·Finalization을 시작하지 않고, 진행 중 Worker가 반환되면 스스로 종료합니다. **유예는 최대 30초**이며(최초 STOPPING 시각 `stopping_at` 기준, 반복 요청은 같은 절차에 합류할 뿐 시계를 되돌리지 않습니다) 넘으면 소유한 `warroom-supervisor` 세션을 종료합니다. 끊긴 Git/Node 자식은 새 instance의 fence 스캔이, 살아 있는 AI는 PID·exit 기록 재부착이, 미확정 PR/Issue 생성은 사전 영속 마커와 GitHub 재조회가 이어받습니다.
- **코드 갱신** — 요청한 수정이 운영 checkout에 없으면 Controller가 `git fetch` 후 `origin/<base>`로 fast-forward 합니다. 조건: base 브랜치, 추적 파일 변경 없음, 들어올 경로와 겹치는 미추적 파일 없음, `pnpm-lock.yaml` 불변, 대상 commit의 Supervisor 코드가 운영 venv·`config.json`으로 import·검증 통과. checkout은 **이전 instance가 종료된 뒤에만** 바뀌며 reset·stash는 하지 않습니다. 조건이 맞지 않으면 사유를 요청 파일·Audit Log에 남기고 **현재 코드로 계속 운영**합니다(5분 뒤 재확인). 코드 갱신 불가는 instance 교체를 막지 않습니다.
- **배치별 보류** — 판정할 수 없는 Git/Node 자식은 그 자식이 쓰던 worktree(또는 실제로 잡고 있던 repo/verify 작업)만 fence 합니다. 한 배치의 문제로 다른 Line이 멈추지 않습니다.
- C/D 생산 세션은 운영 checkout의 CLI(`scripts/relation/d-chunk-cli.mjs`, `literary-context-cli.mjs`)를 직접 호출하므로 코드 갱신 시점부터 새 CLI를 씁니다. 이 CLI들의 명령·입출력·checkpoint는 실행 중인 세션과 호환을 유지해야 합니다.

incident와 무관하게 특정 commit의 로드를 요청하려면:

```sh
TYPEWRITER_WARROOM_ROOT="$PWD" PYTHONPATH="$PWD/tools/warroom" \
  tools/warroom/.local/venv/bin/python -m warroom.restart_controller --request-code-sha <FULL_SHA>
```

`supervisor_workers`의 기본값은 **16**입니다(`config.example.json` 참고). 운영 `config.json`에 `1`을 override로 남기지 마세요. `1`은 직렬 회귀·장애 폴백 전용이며, 1→4→16 단계 확대는 하지 않습니다. 실제 기동 값과 현재 instance는 `runtime`(`.git/typewriter-supervisor/supervisor-runtime.json`)의 `supervisor_workers`/`instance`/`pid`/`loaded_code_sha`로 확인합니다.

이 절차가 처음 배포될 때 한 번은 `./kwar`로 교체합니다. 이전 버전 Supervisor는 STOPPING에서 스스로 종료하지 않으므로 30초 뒤 세션 종료 경로로 교체됩니다.

프롬프트·설정·Supervisor는 검증된 **운영 메인 checkout**에서만 읽습니다. 임시 worktree로 대체하지 않습니다. **`.local/` 삭제, DB 수동 초기화, `tmux kill-session`·signal에 의한 수동 종료, 코드 리로드 목적의 Retry는 금지합니다** — 재시작은 `./kwar`를 쓰세요. 장애나 코드 갱신 보류 사유는 TUI의 Supervisor 상태·Audit Log에서 확인합니다.

DeepSeek 공식 API를 사용하려면 OpenCode에서 `/connect`로 DeepSeek를 등록하고
`opencode models`에서 `deepseek/deepseek-flash`를 확인한다. 인증 정보는 OpenCode의
인증 저장소 또는 승인된 환경 변수에만 저장한다. `config.example.json`의 `models.api`와
`tier_efforts.api`를 참고해 로컬 설정에 추가하면 `f` 선택 창에서 API를 선택할 수 있다.
API의 `none`은 별도 override이며 Free/Go는 기존 `effort`를 상속한다.

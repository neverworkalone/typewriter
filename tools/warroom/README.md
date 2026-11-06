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
./dashboard           # 기존 Supervisor를 공유하는 보조 Web View (http://localhost:8000)
./dashboard --port 8123
```

설정 변경: `tools/warroom/.local/config.json` 수정 후 TUI에서 `r`을 눌러 리로드합니다. 실행 중인 AI run의 프로필·세션은 바뀌지 않습니다. **Python 코드 수정은 설정 리로드만으로 적용되지 않습니다.**

Supervisor 수정 코드를 배포했다면 운영 메인 checkout에서 `./war`를 실행합니다. 별도 restart controller가 보존된 요청(`.git/typewriter-supervisor/restart-requests/`)을 확인하고, **worker 종료·운영 루트 및 worktree 소유권·Stop/Drain/Clear/hold** 등의 조건이 안전할 때만 Supervisor를 교체합니다. 불확실하면 기존 작업을 중단하지 않고 대기합니다. 코드가 실제로 로드된 SHA와 원 생산 task의 공식 저장 진전은 별개로 확인합니다.

incident와 무관한 코드 수정의 명시적 재시작 요청:

```sh
TYPEWRITER_WARROOM_ROOT="$PWD" PYTHONPATH="$PWD/tools/warroom" \
  tools/warroom/.local/venv/bin/python -m warroom.restart_controller --request-code-sha <FULL_SHA>
```

### 병렬 Supervisor와 정상 Restart (#3774)

`supervisor_workers`의 기본값은 **16**입니다(`config.example.json` 참고). 운영 `config.json`에 `1`을 override로 남기지 마세요. `1`은 직렬 회귀·장애 폴백 전용이며, 1→4→16 단계 확대는 하지 않습니다. 실제 기동 값은 `runtime`(`.git/typewriter-supervisor/`의 runtime 기록)의 `supervisor_workers`/`instance`로 확인합니다.

workers>1 Supervisor의 모든 정상 Restart는 AI가 0개여도 `RUNNING → DRAINING → READY → STOPPING`을 거칩니다(Store `restart_phase`, `BEGIN IMMEDIATE` CAS).

- Controller는 영속 Restart 요청만 기록합니다. Coordinator만 `RUNNING → DRAINING`을 수행하고 LaunchGate를 닫아 새 AI 시작·새 배치·새 Finalization·PR review-fix·Maintainer 새 작업을 막습니다. 이미 실행 중인 AI의 종료 수거·공식 저장, Stop/Clear 처리는 계속합니다.
- 모든 Worker·AI·open run·Git/Node 자식 fence가 정리되면 Coordinator가 메모리에서 Worker 제출을 먼저 멈춘 뒤 `DRAINING → READY`로 전이합니다. READY/STOPPING에서는 Worker 제출이 0건입니다.
- Controller는 현재 instance의 READY와 요청 identity를 확인하고 CAS `READY → STOPPING`에 성공한 경우에만 Supervisor tmux 세션을 종료합니다. 시간 초과만으로 자동 취소하지 않으며, 취소는 Coordinator만 `RUNNING`으로 되돌립니다(`STOPPING`에서는 복귀 불가).
- READY 이후 접수된 Stop/Clear는 영속 요청으로 남아 새 Supervisor가 처리합니다. 수동 강제 종료·비정상 종료는 정상 Restart가 아니며, 새 instance가 시작 시 Git/Node fence 스캔으로 복구합니다.

프롬프트·설정·Supervisor는 검증된 **운영 메인 checkout**에서만 읽습니다. 임시 worktree로 대체하지 않습니다. **`.local/` 삭제, DB 수동 초기화, 강제 프로세스 종료, 코드 리로드 목적의 Retry는 금지합니다.** 장애나 재시작 지연 사유는 TUI의 Supervisor 상태·Audit Log에서 확인합니다.

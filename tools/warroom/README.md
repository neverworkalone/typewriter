# War Room — 운영 명령어

모든 명령은 Typewriter 운영 메인 checkout의 저장소 루트에서 실행합니다.

## 실행 및 재시작

```sh
./war                  # TUI 열기/재연결, Supervisor 및 watchdog 기동
./kwar                 # Supervisor 재시작 후 TUI 열기
./kwar --no-attach     # Supervisor 재시작만 수행
```

`./kwar`는 진행 중인 AI·배치·checkpoint를 보존합니다. 종료 코드: `0` 교체 성공, `1` 실패/거부, `2` 미확인.

특정 머지 커밋의 코드 반영 요청:

```sh
SHA="머지된_전체_SHA"
TYPEWRITER_WARROOM_ROOT="$PWD" PYTHONPATH="$PWD/tools/warroom" \
  tools/warroom/.local/venv/bin/python -m warroom.restart_controller --request-code-sha "$SHA"
```

`SHA`에는 원격 master에 머지된 전체 SHA를 넣습니다. `./recovery status`에서 실제 로드된 SHA를 확인합니다.

## Recovery

상태 확인 (Supervisor와 watchdog 상태 JSON):

```sh
./recovery status
```

Watchdog 화면 보기 (`Ctrl-b d`로 빠져나오기):

```sh
tmux attach -t warroom-recovery
```

| 명령 | 용도 |
| --- | --- |
| `./recovery stop` | 감시 루프 중지 |
| `./recovery start` | 감시 루프 시작 (`./war`도 자동 시작) |
| `./recovery pause` | watchdog의 재시작만 일시정지 |
| `./recovery unpause` | 재시작 일시정지 해제 |
| `./recovery once` | 포그라운드에서 한 번 점검 |
| `./recovery resume <case-id>` | 도구 거부로 오너 응답을 기다리는 case 재개 |

Recovery 카드에서 `Enter`로 case 상세·로그·대기 사유를 확인합니다. `pause` 중에도 `status`는 동작합니다.

## 설정

- 운영 설정: `tools/warroom/.local/config.json` ([설정 예제](config.example.json))
- 모델 배정: `model_profiles`, `assignments.stage2`, `assignments.stage3`, `assignments.stage4`, `assignments.d1`, `maintainer`, `recovery`.
- 병렬 실행 수: `stage2_max_parallel`, `refine_max_parallel`, `recovery_max_parallel`, `supervisor_workers`.
- 설정 저장 후 TUI에서 `r`로 리로드합니다. 코드 반영은 `./kwar` 또는 위의 코드 반영 요청을 사용합니다.

## 실행 로그

**PR 번호로 모든 run의 로그 경로 복사** (`2046`을 실제 PR 번호로 변경):

```sh
sqlite3 -readonly -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.pr_number=2046 AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

**샤드·배치로 조회** (S2 Codex `001`, Part `02-02` 예시):

```sh
sqlite3 -readonly -noheader tools/warroom/.local/warroom.db \
  "SELECT r.log_file FROM runs r JOIN batches b ON b.id=r.batch_id
   WHERE b.method='s2' AND b.shard='001' AND b.batch='02-02'
     AND b.producer='codex' AND r.log_file IS NOT NULL
   ORDER BY r.started_at, r.id;" | paste -sd ' ' - | pbcopy
```

S3는 `method='s3'`, `batch='all'`; S4는 `method='s3'`, `batch='s4'`; D1은 `method='drop'`, `batch='d1'`로 바꿉니다. 터미널에 출력하려면 `| paste -sd ' ' - | pbcopy`를 빼고, 로그는 `less` 또는 `tail -f`로 읽습니다.

미완료 배치·Recovery의 로그, `.exit`, `.exit.pid`, checkpoint는 보존합니다. 운영 DB를 수동 초기화하거나 Supervisor를 직접 종료하지 않습니다.

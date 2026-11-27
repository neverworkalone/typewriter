# War Room Recovery — 상태 패널과 보조 스크립트

복구 점검반(예전 `inspector.md`·`inspect.sh`·`session.sh`, 10분마다 AI가 점검하던 방식)은 **War Room Supervisor의
Recovery lane**과 외부 watchdog `./recovery`로 옮겨졌다. 감지는 결정적이고, case가 열릴 때만 Claude/Codex 복구 실행이
시작된다. 동작·설정·상태는 [`tools/warroom/README.md`의 "Recovery"](../README.md#recovery-복구-lane)를 본다.

이 디렉터리에 남은 것:

| 파일 | 역할 |
| --- | --- |
| `guard.sh` | 운영 메인 checkout 경계 확인 (fail-closed, 아니면 exit 3). `./recovery`와 패널이 먼저 부른다 |
| `control.sh` | 복구 실행이 쓰는 오너 상시 허용 Line Stop & Retry (`stop-retry <model> <method> <batch-id>`) |
| `status.py` | Recovery 상태를 JSON으로 출력 (운영 DB 읽기 전용 연결 + watchdog 기록) |
| `mod/` | Claude 데스크톱 앱 모드: **상태 패널과 변화 토스트만**. 점검·실행·쓰기를 하지 않는다 |

복구 실행 프롬프트(예전 `brief.md`)는 `tools/warroom/prompts/recovery.md`다.

## 패널

운영 메인 checkout에서 연 Claude Code 세션에 모드를 켠다. 앱이 닫혀 있어도 Recovery는 Supervisor 안에서 계속 돈다.

```sh
claude --plugin-dir tools/warroom/recovery-desk/mod
```

모드는 `guard.sh`를 통과한 경우에만 패널을 등록하고, 1분마다 `status.py`를 읽어 보여 준다.

## Stop & Retry 허용 규칙

Auto 분류기가 운영 DB 쓰기로 보고 막으므로, 운영 checkout의 `.claude/settings.local.json`에
`Bash(sh tools/warroom/recovery-desk/control.sh stop-retry *)` 허용 규칙을 둔다.

## 예전 기록

`.git/typewriter-supervisor/recovery-desk/`의 `ledger.json`·`sessions/`는 지우지 않는다. Supervisor가 처음 Recovery를
켤 때 `ledger.json`의 **열린 case만** 한 번 이어받는다. 그 case의 legacy tmux(`recovery-<key>`, `recovery-inspector`)가
살아 있는 동안은 추적만 하고 새 실행을 띄우지 않는다.

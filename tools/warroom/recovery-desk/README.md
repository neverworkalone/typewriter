# War Room 복구 점검반

> **Claude 전용.** 이 도구는 Claude Code(헤드리스 `claude` CLI와 Claude 데스크톱 앱 모드) 전용이다. Codex·DeepSeek 등 다른 producer나 War Room Supervisor의 실행 경로에서는 사용하지 않는다.

복구 점검반은 War Room의 **마지막 복구 수단(last resort)**이다. Maintainer가 맡아 진전 중인 장애에는 손대지
않는다. 다음 경우에만 장애마다 헤드리스 Sonnet 복구 세션을 하나씩 연다. 그 세션은 라인이 실제로 다시 진행될
때까지 책임진다(수정, PR, 운영 반영, Supervisor 재시작 포함).

- Maintainer가 맡지 않은 PAUSED·ERROR·HELD 배치
- 진전이 멈춘 배치
- 멈춘 Maintainer

| 파일 | 역할 |
| --- | --- |
| `inspector.md` | 점검 1회 프롬프트 (판정, 배정, 추적, 해결 처리) |
| `brief.md` | 복구 세션의 공통 지시. 최초 지시에 전문을 넣는다 |
| `inspect.sh` | 점검 1회를 tmux `recovery-inspector`에서 실행. 실행 중이거나 일시정지면 건너뛴다 (`--force`는 일시정지 무시) |
| `session.sh` | 복구 세션 `start` / `send`(같은 세션 resume) / `status` / `archive` |
| `status.py` | 점검반 상태를 JSON으로 출력 (읽기 전용, 앱 패널용) |
| `mod/` | Claude 데스크톱 앱 모드: 10분 점검 타이머, "복구 점검반" 패널, 변화 토스트 |

## 상태 위치

모든 상태는 git 추적 밖인 `.git/typewriter-supervisor/recovery-desk/`에 있고, 운영 DB와 분리돼 있다.

- `ledger.json`: 열린 case는 `cases`, 해결된 case는 `archived`에 있다
- `inspector.log`: 점검 로그
- `sessions/<key>.{id,log}`: 복구 세션 기록. 해결되면 `sessions/archive/`로 옮긴다 (삭제하지 않음)
- `prompts/`: 세션에 보낸 지시문
- `paused`: 이 파일이 있으면 10분 점검을 건너뛴다

해결된 case의 세션은 다시 쓰지 않는다. 같은 배치에 새 장애가 생기면 새 case, 새 세션으로 연다.

## 실행

앱 모드를 쓰는 경우, 운영 메인 checkout에서 연 Claude Code 세션에 이 모드를 켠다.

```sh
claude --plugin-dir tools/warroom/recovery-desk/mod
```

또는 `CLAUDE_CODE_PLUGIN_DIRS`에 같은 경로를 넣는다. 모드는 세션이 열려 있는 동안 10분마다 `inspect.sh`를,
1분마다 `status.py`를 실행한다. 운영 checkout이 아닌 세션에서는 아무것도 하지 않는다. 패널 버튼과
`/recovery-desk run|pause|resume`으로 조작한다.

수동으로 실행할 수도 있다.

```sh
tools/warroom/recovery-desk/inspect.sh --force         # 지금 점검 1회
tools/warroom/recovery-desk/session.sh status <key>    # 복구 세션 상태
touch .git/typewriter-supervisor/recovery-desk/paused  # 10분 점검 일시정지 (rm 하면 재개)
```

점검과 복구 세션은 `claude -p --permission-mode auto`로 돈다. Auto 분류기가 막은 동작은 우회하지 않고, 정확한
명령과 필요한 최소 조치를 보고한다. 점검 1회의 비용은 약 $0.18이다.

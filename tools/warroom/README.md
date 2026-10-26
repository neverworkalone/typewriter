# War Room — 운영 가이드

이 README는 **오너가 War Room 운영 중 찾아 쓰는 명령과 장애 대응 정보**를 정리한 문서다. 내부 아키텍처, 개발 이력, 구현 설계는 다루지 않는다. 모든 셸 명령은 별도 표시가 없으면 **Typewriter 저장소 루트**에서 실행한다.

## 생산 로그 찾기 (전체 실행 기록)

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

## Web UI (`./war-web`)

Mac 브라우저와 iPhone/iPad Safari용 **두 번째 View**다. 새 Controller·Supervisor가 아니며, 기존 `./war`·Supervisor를 바꾸지 않는다.

```sh
./war-web                 # http://localhost:8000
./war-web --port 8123     # 포트 변경
```

- **구조:** `./war`(TUI)와 `./war-web`(Web)은 같은 `warroom.store.Store` + `control.py`(SQLite)를 읽고 쓴다. 하나의 Supervisor가 AI 생산·리뷰·Cleanup을 실행한다. Web은 Supervisor·AI CLI·tmux·git·셸을 실행하지 않으며 `tools/warroom/warroom/web/`(stdlib `http.server`, 추가 의존성 없음)에 있다. `./war-web`만 실행하면 Supervisor가 없을 때 읽기 전용 OFFLINE 화면이 뜬다. Supervisor는 기존대로 `./war`가 띄운다.
- **화면:** Factory Board(모델별 A/B/C/D·Stage 2·Maintainer 카드, 2초 폴링), Batch Detail(메타데이터·Run History·Agent Log/Audit Log). iPhone 폭에서는 진행 중/오류 라인을 앞에 두고 빈 라인은 접는다. 조작: Start, Drain/Cancel Drain, Retry, Stop, Clear, Drain All, Stop All. Stop·Stop All·Clear는 대상을 보여 주는 확인 창을 거치며, 서버도 정확한 확인 값이 없으면 거절한다.
- **OFFLINE:** Supervisor heartbeat가 30초 넘게 없으면 상단에 OFFLINE을 표시하고 모든 변경 명령을 서버에서 거절한다(상태·이력 조회만 가능).
- **로그:** DB에 기록된 `runs.log_file`만, 로그 디렉터리 안의 파일일 때만 제공한다. 요청으로 경로를 지정할 수 없고 토큰류는 redact된다. 삭제된 로그는 "이력만 남음"으로 안내한다. Readable Log는 요청 단위로 렌더링하므로 Codex 명령 중복 표시 억제가 TUI만큼 정밀하지 않다(필요하면 Raw Log).

### 보안 경계

- **loopback 전용:** 서버는 `127.0.0.1`/`::1`에만 바인딩하며 `0.0.0.0`·LAN 주소는 시작 시 거부한다. 공인 인터넷 공개·Tailscale Funnel은 범위 밖이다.
- **자체 인증 없음:** 같은 Mac에서 loopback에 접속하는 프로세스는 모든 조작을 할 수 있다. 외부 기기는 승인된 사설망(Tailscale)만 믿는다.
- **웹 페이지/DNS rebinding 방어:** 모든 요청의 `Host`는 loopback(자신의 포트) 또는 `--allow-host`로 허용한 이름만 통과한다. 변경은 `POST /api/command` 하나뿐이며 `Origin` 일치, `Content-Type: application/json`, `Sec-Fetch-Site` same-origin, 4KB 본문 제한, 명령·인자 화이트리스트(`start/drain/retry/stop/clear/drain_all/stop_all`)를 요구한다. 임의 경로·셸 실행·Supervisor 제어 엔드포인트는 없다.

### Tailscale Serve (별도 운영 안내, 선택)

Tailscale은 접근 계층일 뿐 Web UI의 실행 의존성이 아니다(없어도 `localhost`로 동작). 다른 기기에서 쓰려면 Mac에서 Tailscale에 로그인한 뒤:

```sh
./war-web --allow-host <mac이름>.<tailnet>.ts.net
tailscale serve --bg 8000        # tailnet 안에서만 https://<mac이름>.<tailnet>.ts.net 로 노출
tailscale serve status           # 확인 · 끄기: tailscale serve reset
```

`--allow-host`는 Serve가 전달하는 tailnet 이름을 Host/Origin으로 허용한다. **Tailscale의 접속 허가(ACL)와 앱의 권한 경계는 다르다.** tailnet에 접속할 수 있는 기기·사용자는 이 UI의 모든 조작(Stop All 포함)을 할 수 있으므로 tailnet ACL로 대상을 제한한다. `tailscale funnel`은 사용하지 않는다.

### 테스트

```sh
node tools/warroom/run-tests.mjs    # 전체 (Web: tests/test_web_1720.py)
```

## Supervisor 코드 수정 후 재시작

```sh
tmux kill-session -t warroom-supervisor 2>/dev/null || true
tmux kill-session -t warroom 2>/dev/null || true
```

`./war` creates or reattaches the TUI and starts a fresh Supervisor if none holds its lock.
The Supervisor recovers existing batches using the persisted state and running processes;
do not delete `tools/warroom/.local/`, manually reset worktrees or press Retry just to reload code.

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
- 상태 DB: `tools/warroom/.local/warroom.db`. 로그·worktree: `tools/warroom/.local/` 아래. 해당 디렉터리는 Git에서 제외되므로 인증·로그를 커밋하지 않는다.
- Codex 권한 문제가 나면 `~/.codex/config.toml`의 지정 `permission_profile`을, Claude 권한 문제가 나면 `~/.claude/settings.json` 등 로컬 권한 설정을 확인한다. War Room이 임의로 권한을 넓히지는 않는다.

추가 생산·검증 절차의 정본은 [Relation Factory](../../docs/relation-factory.md) 및 [Stage 2 Issue #927](https://github.com/neverworkalone/typewriter/issues/927)이다. 이 README는 개발 설계서가 아니라 **오너용 운영 명령 모음**으로 유지한다.

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

# War Room — 운영 가이드

오너가 사용하는 실행·설정·로그 조회·장애 대응 명령만 정리합니다. 별도 표시가 없으면 모든 명령은 **Typewriter 저장소 루트**에서 실행합니다. 제품/생산 계약은 [Relation Factory](../../docs/relation-factory.md), S2 생산 절차는 [#927](https://github.com/neverworkalone/typewriter/issues/927)를 참고합니다.

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

프롬프트·설정·Supervisor는 검증된 **운영 메인 checkout**에서만 읽습니다. 임시 worktree로 대체하지 않습니다. **`.local/` 삭제, DB 수동 초기화, 강제 프로세스 종료, 코드 리로드 목적의 Retry는 금지합니다.** 장애나 재시작 지연 사유는 TUI의 Supervisor 상태·Audit Log에서 확인합니다.

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

## 계정 및 기본 설정

```sh
GH_CONFIG_DIR=tools/warroom/.local/gh gh auth status
# 최초 1회 설정이 필요할 때:
GH_CONFIG_DIR=tools/warroom/.local/gh gh auth login

claude auth status
codex login status
```

- 전용 GitHub 계정은 `neverworkalone-agent`입니다. gh 인증은 `.local/gh`에 격리하고, Claude/Codex는 각 CLI 계정을 사용합니다. 작업 설정 예시는 `tools/warroom/config.example.json`을 참고합니다.
- **Method C** 문학 SQLite는 `literary_index_path`, **Method D** 문어 말뭉치 SQLite는 `corpus_index_path`에 승인된 파일의 읽기 가능한 절대 경로를 각각 지정합니다. 누락되면 해당 생산을 시작하지 않습니다.
- 프로필은 `model_profiles`, 역할별 선택은 `assignments` 및 `maintainer`로 지정합니다. Stage 1은 `stage1-ab` / `stage1-c` / `stage1-d`가 `stage1`보다 우선하고, S2/S3는 `stage2` / `stage3`를 독립적으로 사용합니다. `model`, `effort`, `permission_profile`은 선택된 프로필에서 함께 적용됩니다. 기존 `producers` 기반 설정도 지원합니다.
- Codex 프로필의 `fast`는 선택적 설정입니다. `true`는 Fast 요청, `false`는 Standard 명시, 생략하면 CLI 설정 상속입니다. 모델/계정에서 지원하지 않는 Fast 요청은 자동 재시도하지 않습니다.
- 병렬도: S2 `stage2_max_parallel` 기본 16(청크 목표 `stage2_chunk_candidates` 기본 250후보), S3 `stage3_max_parallel` 기본 16. C는 배치 내 12-Sense 청크, D는 25-record 청크를 각각 최대 **8세션**으로 실행합니다. 기존 진행 중 배치의 모드·저장 상태는 보존하고, 청크 결과 저장은 Supervisor만 수행합니다.
- 사용량은 run별로 입력/캐시/출력 토큰, tool calls, 제출 실패를 저장합니다. 기록이 없는 값은 0이 아닌 `NULL`입니다. 비용 추정은 `config.json`에 선택적 `pricing`(USD/백만 토큰)을 입력한 경우에만 계산합니다.
- 상태 DB: `tools/warroom/.local/warroom.db`. 로그와 worktree도 `.local/` 아래에 있습니다. `.local/`의 인증·상태·로그는 Git에 포함하지 않습니다.

## 장애 대응 원칙

C/D/S2/S3의 공유 장애는 원 생산 배치와 증거를 보존하고 Maintainer로 연결합니다. 무코드 재개도 **정확한 원 task·session·소유권** 증명이 있을 때만 인가하며, 해결 판정은 원 task가 공식 `SAVED`가 되거나 검증된 후속 생산 단계에 도달한 뒤에만 합니다. 임의 재판정·작업물 삭제·DB 상태 변경으로 장애를 숨기지 않습니다.

Supervisor가 정상적으로 실행되지 않거나 재시작이 지연되면 **TUI 상태와 Audit Log의 구체적인 차단 이유**부터 확인하세요. 코드 재배포 자체가 생산 장애 해결을 증명하지는 않습니다.

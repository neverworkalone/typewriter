#1155 C 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며, 
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

Issue #1155의 C 생산 계약을 읽고 준수한다.

C 생산의 검색·체크포인트·Candidate 출력에는 scripts/relation/literary-context-cli.mjs를 반드시 사용한다. 절차는 docs/relation-literary-context.md의 `init → chunk/submit 반복 → export`를 따른다. 문맥·후보·Sense별 개별 명령, 관점별 빈 배열, KEEP/REMOVE 장부, 반복 `validate`는 쓰지 않는다. 승인 인덱스의 전체 SHA/FTS 재구축은 하지 않는다. 배치마다 동일 기능의 임시 스크립트를 새로 작성하지 않는다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

Codex 샌드박스에서 차단되는 `ps`·`pgrep`에 의존하지 말고, 작업의 실행 결과와 기존 기록으로 상태를 확인한다.

export가 실행한 Candidate v1 검증(1회)로 충분하다. 커밋·push하고 `batch` 라벨의 PR을 제출한다. PR 생성 직전 다른 모델을 포함한 동일 C 배치의 중복 점유를 확인한다. PR 본문에서 #1155를 참조하거나 닫지 않는다.

### 탐색별 후보 생산량 측정

기존 7관점 × 독립 2회 탐색을 모두 정상 수행한다. 각 청크에서 1차 탐색으로 발굴한 후보 수와, 2차 독립 탐색에서 1차에 없던 후보를 새롭게 발굴한 수를 구분해 집계한다. 중복 제거는 동일 source sense 내부를 기준으로 한다.

최종 PR 본문에 **1차 후보 총수 / 2차 신규 후보 총수 / 최종 편집 후 후보 총수**를 기록한다. 실제 집계값만 사용하고 추정하지 않는다.

탐색 횟수·관점·품질 기준을 변경하거나 후보 수 할당량을 두지 않는다. 후보별 태그, 관점별 집계, 별도 검증 장부, 추가 CLI 호출은 만들지 않는다. 기존 Candidate v1 출력 형식은 유지한다.

PR 제출 후 종료한다. 리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다. 다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.

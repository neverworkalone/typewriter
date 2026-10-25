#1156 D 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며, 
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

Issue #1156의 D 생산 계약을 읽고 준수한다.

D는 전용 CLI·전수 사전 `scan`·문맥/후보별 영수증 없이 #1156의 간단한 경로로 생산한다. 25-record 청크마다 승인 문어 SQLite를 read-only로 직접 검색하고(필요한 검색어만 요구 시 조회), 읽은 문맥을 직접 판독해 후보를 만들고, 청크 단위 scratch(`.warroom-scratch/`)에 중간 결과만 남겨 재개한다. 마지막에 Candidate JSONL을 조립해 `scripts/relation/candidate-contract.mjs` 검증만 실행한다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 제출한다. PR 생성 직전 다른 모델을 포함한 동일 D 배치의 중복 점유를 확인한다. PR 본문에서 #1156을 참조하거나 닫지 않는다.

PR 제출 후 종료한다. 리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다. 다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.

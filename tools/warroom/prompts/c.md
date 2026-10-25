#1155 C 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며, 
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

Issue #1155의 C 생산 계약을 읽고 준수한다.

검색·증거·checkpoint·집계·Candidate 출력에는 `docs/relation-literary-context.md`의 공통 `scripts/relation/literary-context-cli.mjs`를 사용한다. 배치마다 research/evidence 스크립트나 긴 장부를 새로 만들지 않는다. 먼저 `preflight`, 배치 `init`을 하고, 추가 활용형은 문맥 검색 전 `add-form`으로 기록한 뒤 전체 sense `scan`을 한다. `queue --status COUNTED`와 `search`로 필요한 문맥만 한정된 페이지로 읽는다. 페이지는 작품별 hit를 교차해 다양성을 돕는다. #1155의 adaptive 1–4 / 5–8 / 9–12 / 13–16 context 절차와 sense별 16개 상한을 지킨다. 중간에 표본을 끝내면 반환된 모든 문맥 판정 후 `finish-search`로 이유와 남은 hit 수를 보존한다. `INCOMPLETE`, `SEARCH_FAILED`, `UNSEARCHABLE`, `NO_VERIFIED`, `SAMPLED_NO_VERIFIED` 상태를 서로 바꾸거나 빈 결과로 합치지 않는다.

각 문맥은 정확한 Canonical sense에 대해 실제로 판독하고 `review-context`로 하나씩 판정한다. 도구는 미판독 문맥을 REJECTED 처리하거나 VERIFIED를 자동 부여하지 않는다. 모든 VERIFIED 문맥에서 정확히 일곱 lens의 `sweep 1`과 독립 재판독한 `sweep 2`를 별도 기록한다. 두 번째 호출에 `--independent-read`를 붙이는 것은 실제 재판독 뒤에만 한다. `report`는 합계를 계산하며 corpus ledger 전체를 stdout에 내보내지 않는다.

문맥·locator·checkpoint·digest cache는 `.warroom-scratch/` 안에만 둔다. 최종 Candidate는 공통 도구로 내보내고 기존 Candidate v1 validator로 전체 배치를 검사한다. 검증 결함은 보고된 record/sense/candidate만 `patch`하고, 마지막 전체 검증을 다시 통과시킨다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

Codex 샌드박스에서 차단되는 `ps`·`pgrep`에 의존하지 말고, 작업의 실행 결과와 기존 기록으로 상태를 확인한다.

Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 제출한다. PR 생성 직전 다른 모델을 포함한 동일 C 배치의 중복 점유를 확인한다. PR 본문에서 #1155를 참조하거나 닫지 않는다.

PR 제출 후 종료한다. 리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다. 다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

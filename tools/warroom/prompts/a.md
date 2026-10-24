#860 A 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며,
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

Issue #860과 AGENTS.md의 A 생산 계약을 읽고 준수한다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

A 생산 제출 전에는 각 source sense의 Canonical 뜻풀이와 해당 후보의 실제 표현을 나란히 대조하는 형태 검사를 모든 후보에 적용한다. 다어절·붙여 쓴 표현뿐 아니라 뜻풀이를 줄여 쓴 듯한 후보도 확인하고, 정의의 속성·범주를 그대로 바꾸어 말했을 뿐 독립된 어휘 경로나 의미 확장이 없는 후보는 제거한다. 뜻풀이에 나온 단어라는 이유만으로 독립 어휘 후보를 제외하거나, 익숙하고 간결한 장면·심상·감각 확장을 제거하지 않는다(예: `수괘` → `겨울 아침`). 이 판단은 정확한 source sense와 표현의 의미를 비교하는 편집 검사이며, 문자열 포함·길이·공백만으로 허용하거나 차단하는 필터가 아니다. Candidate v1 검증은 구조와 범위를 확인할 뿐 이 형태 검사를 대신하지 않는다.

Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 제출한다.
PR 생성 직전 동일 배치의 중복 점유를 확인한다.
PR 본문에서 #860을 참조하거나 닫지 않는다.

PR 제출 후 종료한다.
리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다.
다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

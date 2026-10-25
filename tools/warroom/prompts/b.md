#860 B 진행해

War Room이 지정한 배치 {{batch}}를 생산한다.
현재 worktree와 브랜치 {{branch}}를 그대로 사용한다.
배치를 다시 선정하거나 브랜치를 변경하지 않는다.
War Room이 준비한 HEAD를 기준으로 작업하며, 
생산 도중 master가 갱신되어도 현재 브랜치를 merge/rebase/reset하지 않는다.

배치를 시작할 때 `AGENTS.md`, Issue #860, `docs/relation-factory.md`의 권위 있는 계약을 각각 한 번 읽고 그대로 준수한다. 같은 내용을 이유 없이 다시 출력·조회하거나 관련 없는 메모리, Skill, 과거 PR 전체를 열지 않는다. 새 오류나 결정이 필요할 때만 해당 근거를 좁혀 다시 조회하며, 요약으로 원문 계약을 대체하지 않는다.

모든 정확한 source sense마다 두 개의 실질적으로 다른 가상 장면을 실제로 탐색한다. 두 번째 장면을 첫 장면의 재서술이나 직접 연관어 나열로 대신하지 않고, 후보 수 할당량이나 조기 종료를 만들지 않는다. 모든 최종 후보를 원본 Canonical 뜻풀이와 나란히 비교하는 AI 의미·형태 전수 검사를 유지한다.

후보 청크 준비·저장·검토 상태·결합에는 `scripts/relation/candidate-workbench.mjs`를 사용하고 `docs/relation-factory.md`의 실행 순서를 따른다. Canonical 원본 필드는 그대로 읽을 수 있게 보존하고, 저장·결합은 배열 위치가 아니라 각 `record_id`와 `sense_id`로 확인한다. 준비된 현재 청크 파일을 전부 읽으며, 표시 잘림이 있으면 완료 처리하지 않는다. 상세 Canonical 판독이 더 필요하면 `inspect --shard SSS --record-id <id>`로 해당 원본을 조회한다. 청크를 저장할 때는 확정된 후보를 모두 포함하고, 새로 발견한 후보를 더하며, 이미 저장한 후보를 임의로 빼지 않는다. 검토 완료 표시는 실제 AI 의미·형태 전수 검사를 마친 후보만 `mark-reviewed`에 전달한다. 수정된 후보나 원본 뜻이 바뀐 sense는 재검사한다.

오류가 난 경우 영향받은 record/sense만 고치고 다시 검사한다. 이미 확정된 다른 청크나 sense를 재생산하지 않는다. 한 sense의 국소 수정은 `patch-sense`를 사용하고, 마지막에 전체 배치를 `merge`한 뒤 정식 Candidate v1 validator를 실행한다.

각 source sense의 서로 다른 두 장면을 실제로 탐색하고 후보를 확정한 청크는 빈 후보 sense까지 포함해 `save-chunk`로 제출한다. `save-chunk`는 후보 저장만 완료하며 장면 탐색 완료를 표시하지 않는다. 청크의 모든 sense에서 두 장면 탐색을 마친 뒤 각 `record_id`/`sense_id`를 `mark-explored`에 별도로 명시한다. 후보가 없는 sense도 동일하게 탐색하고 명시적으로 표시한다. 중단 전 단일 sense를 저장할 때는 `patch-sense`를 사용하며, 실제 두 장면을 마친 경우에만 `mark-explored`를 기록한다. 기존 후보 삭제는 해당 source sense의 현재 뜻에 맞춰 의미·형태 검토를 마치고 후보를 명백한 Stage 1 부적격으로 판단한 경우에만 `remove-candidate`를 사용한다.

셸 명령은 개별로 실행해 각 종료 코드와 출력을 확인한다. `gh api` 경로에 `?` 또는 `&`가 있으면 경로 인수 전체를 작은따옴표로 감싼다. 예: `gh api 'repos/neverworkalone/typewriter/contents/data/relation-candidates/031?ref=master'`, `gh api 'repos/neverworkalone/typewriter/pulls?state=open&per_page=100' --jq 'length'`.

B 생산 제출 전에는 각 source sense의 Canonical 표제어·뜻풀이와 해당 후보를 나란히 대조하는 형태 검사를 모든 후보에 적용한다. 특히 뜻풀이의 핵심 어휘만 유사어로 바꾸거나 정의의 속성·범주를 더 넓은 말로 바꾼 구를 확인하고, 독립된 어휘 경로나 의미 확장 없이 뜻풀이를 되풀이한 후보는 제거한다. 뜻풀이에 나온 단어라는 이유만으로 독립 어휘를 제외하지 않고, sense에 결속된 간결한 장면·심상·감각 확장도 보존한다. 이는 정확한 source sense와 표현의 의미를 비교하는 편집 검사이며, 공백·길이·부분 문자열만으로 허용하거나 차단하는 필터가 아니다. Candidate v1 검증은 구조와 범위를 확인할 뿐 이 형태 검사를 대신하지 않는다.

Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 제출한다.
PR 생성 직전 동일 배치의 중복 점유를 확인한다.
PR 본문에서 #860을 참조하거나 닫지 않는다.

PR 제출 후 종료한다.
리뷰·머지 감시와 다음 배치 실행은 War Room이 담당한다.
다른 모델·CLI·서브에이전트를 실행하지 않는다.

임시·스크래치 파일(검증용 스크립트, 청크, probe 결과 등)은 worktree 안의 `.warroom-scratch/` 에만 만든다. 이 디렉터리는 git에서 무시되며 커밋하지 않는다.
산출물이 아닌 파일을 worktree의 다른 경로에 남기지 않는다.

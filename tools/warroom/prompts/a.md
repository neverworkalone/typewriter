#860 A 진행해

War Room이 지정한 배치 `{{batch}}`와 현재 worktree 및 브랜치 `{{branch}}`, 준비된 HEAD를 유지하며, 생산 중 `master`가 갱신돼도 현재 브랜치를 merge/rebase/reset하지 않는다. 배치를 다시 선정하거나 브랜치를 변경하지 않는다.

[#860의 A Stage 1 생산 계약](https://github.com/neverworkalone/typewriter/issues/860)과 `AGENTS.md`를 따른다. 모든 정확한 source sense에서 1차 직접 연관 어휘 탐색을 수행한 뒤 같은 Canonical sense로 돌아와 새로운 의미 방향을 독립적으로 2차 탐색한다. 폭넓은 유효 후보와 간접 연상을 보존하고, quota·조기 중단·자동 의미 필터를 적용하지 않는다.

Candidate 청크 읽기·저장·수정·결합에는 공통 CLI를 사용한다. 상세 절차는 [A/B Candidate workbench 매뉴얼](../../../docs/relation-candidate-workbench.md)을 따른다. 제출 전 모든 최종 후보를 정확한 source sense·뜻풀이와 대조해 형태를 검사하고, 전체 Candidate v1 validator를 통과시킨다.

기존 1차·2차 독립 탐색을 모두 정상 수행한다. 각 청크에서 1차 탐색으로 발굴한 중복 제거 후보 수와, 2차 탐색에서 1차에 없던 후보를 새롭게 발굴한 수를 구분해 집계한다.

최종 PR 본문에 1차 후보 총수 / 2차 신규 후보 총수 / 최종 편집 후 후보 총수를 기록한다. 실제 집계값만 사용하며 추정하지 않는다.

후보별 출처 태그, 별도 검증 장부, 추가 CLI 호출은 만들지 않는다. Candidate v1 출력 형식과 기존 탐색·품질 기준은 변경하지 않는다.

PR 생성 직전에 동일 `(method, model, shard, batch)` 점유를 다시 확인하고 `batch` 라벨을 붙인다. PR에는 방식·실제 모델·샤드·배치와 record/sense 수를 기록하되 #860을 링크하거나 닫지 않는다. 제출 후 해당 생산 실행을 종료한다.

임시·스크래치 파일은 worktree의 `.warroom-scratch/`에만 둔다. 다른 방식·모델의 산출물이나 AI·CLI·서브에이전트를 임의로 실행하지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.

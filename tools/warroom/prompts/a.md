#860 A 진행해

War Room이 지정한 배치 `{{batch}}`와 현재 worktree 및 브랜치 `{{branch}}`, 준비된 HEAD를 유지하며, 생산 중 `master`가 갱신돼도 현재 브랜치를 merge/rebase/reset하지 않는다. 배치를 다시 선정하거나 브랜치를 변경하지 않는다.

[#860의 A Stage 1 생산 계약](https://github.com/neverworkalone/typewriter/issues/860)과 `AGENTS.md`를 따른다. 각 source sense의 정확한 Canonical 의미를 고정하고, 기본 1회 통합 탐색에서 직접 연관어뿐 아니라 사물·행동·상태·원인/결과·감각·대조·간접 연상까지 가능한 의미 방향을 충분히 발굴한다. 탐색 직후 출발 sense로 돌아가 아직 발굴하지 않은 독립적인 의미 경로가 떠오르고 추가 탐색 가치가 있을 때만 그 방향을 선택적으로 2차 탐색하고, 아니면 종료한다(전문어·고유명사·단일 지시 대상은 억지 2차 금지). 미탐색 방향이 있는데 후보가 이미 많다는 이유로 조기 종료하지 않는다. 폭넓은 유효 후보와 간접 연상을 보존하되 quota·집계·탐색 기록·자동 의미 필터는 두지 않는다.

Candidate 청크 읽기·저장·수정·결합에는 공통 CLI를 사용한다. 상세 절차는 [A/B Candidate workbench 매뉴얼](../../../docs/relation-candidate-workbench.md)을 따른다. 후보 수정(정규화 중복·원본 표제어 동일·서술형 구·뜻풀이 재서술 제거)은 **청크 저장 전에 끝내고 완성된 25-record 청크를 `save-chunk` 한 번**으로 저장한다. `patch`는 이미 저장된 후보의 명확한 국소 수정에만 쓴다. 제출 전 최종 후보를 source sense·뜻풀이와 대조해 형태를 검사하고, 전체 Candidate v1 validator를 통과시킨다.

PR 생성 직전에 동일 `(method, model, shard, batch)` 점유를 다시 확인하고 `batch` 라벨을 붙인다. PR에는 방식·실제 모델·샤드·배치와 record/sense 수를 기록하되 #860을 링크하거나 닫지 않는다. PR 생성과 `batch` 라벨 확인 직후 **즉시 종료**한다. 이후 재조회·리뷰/CI/머지 polling·대기는 하지 않는다(War Room 소관).

임시·스크래치 파일은 worktree의 `.warroom-scratch/`에만 둔다. 다른 방식·모델의 산출물이나 AI·CLI·서브에이전트를 임의로 실행하지 않는다.

공통 결함(반복 가능한 공유 계층 결함)을 확인하면 `tools/warroom/prompts/shared-defect.md` 형식으로 `.warroom-scratch/shared-defect.json` 에 보고하고 멈춘다.

# D 생산 절차 V5 — 발굴 우선, 상한 없음

V4(`../v4/PROCEDURE.md`)의 편집 검증은 유지하되, **발굴 단계와 선택 단계를 분리**하고 문맥 확장을 체계화한다. 특정 표제어 예외는 두지 않는다.

## 0. V4 016/01에서 확인된 사실

- 계약·검증기·출력 코드에 후보 수 상한은 없다(코드 확인).
- V4 결과는 1개 27, 2개 87, 3개 13, 4개 이상 0 sense였다.
- V4 실행은 **초기 4문맥**을 읽고 그 안에서 발굴과 편집 선택을 **같은 판독 과정에서** 수행했다.
- 문맥 확장은 일부 sense에만 적용됐고, sense별 발굴/검증 수치를 기록하지 않았다.

따라서 3개 이하 분포의 원인은 코드 상한이 아니라 **① 초기 문맥에서 발굴 종료 ② 발굴과 선택의 혼합**으로 판단한다. 후보별 결정 로그가 없어 개별 후보가 어느 요인으로 빠졌는지는 소급 증명하지 않는다.

## 1. Phase A — 문맥 확보

1. 기존 검색기(FTS, bigram postings, LIKE 대체, `하다` 활용형)를 그대로 사용한다. 검색 조건을 바꾸지 않는다.
2. sense당 최대 **16개**의 서로 다른 문맥을 확보한다. 같은 문서는 최대 2문맥.
3. 먼저 4문맥을 읽고 각각을 `VERIFIED` / `AMBIGUOUS` / `REJECTED`로 구분한다. `VERIFIED`만 후보 생성에 쓴다.
4. 4문맥에서 후보가 나와도 종료하지 않는다. 다음 4문맥(5–8)을 읽어 **새로운 독립 관계**가 나오는지 확인한다.
5. 8문맥에서 새 관계가 나오면 12, 필요하면 16까지 확장한다.
6. 종료 사유를 sense별로 기록한다: `no_more_distinct_contexts`, `inspected_16`, `no_verified_context`, `repeated_misbinding`.

## 2. Phase B — 5관점 발굴 (선택 금지)

각 `VERIFIED` 문맥마다 다음을 **각각** 수행한다.

1. 실제 결합 표현
2. 행동·사건
3. 상황·맥락
4. 원인·결과
5. 대조·연상

관점마다 (a) 관계 존재 확인 → (b) 발견한 후보를 **전부** 임시 풀에 추가 → (c) 같은 관점의 다른 독립 관계 확인 → (d) 없으면 빈 결과 기록. 발굴 중에는 후보를 2~3개로 추리지 않는다.

## 3. Phase C — 통합

- 모든 문맥의 후보를 sense별로 모은다.
- 정확 중복 문자열만 제거한다.
- 문자열이 달라도 같은 관계면 대표를 정하고, 독립 관계면 모두 남긴다.
- 새 문맥을 읽을 때 기존 후보와 구별되는 관계가 추가되는지 확인한다.

## 4. Phase D — 편집 검증

발굴이 끝난 풀 전체에 세 기준을 적용한다: **Sense Accuracy / Context Grounding / Editorial Value**.

- 단순 공출현, 다른 sense, 뜻풀이 반복, 의미 중복은 제거.
- 표제어 포함은 자동 제거 사유가 아니다. 전문 용어·관용구·전형적 결합은 유지.
- 발굴량을 줄여 검증을 쉽게 만들지 않는다.

## 5. 기록

sense별 로컬 감사 기록: `retrieved_context_count`, `inspected_context_count`, `verified_context_count`, `initial_candidate_count`, `new_candidates_from_expansion`, `discovery_pool_count`, `rejected_sense_count`, `rejected_cooccurrence_count`, `rejected_duplicate_count`, `rejected_editorial_count`, `final_candidate_count`, `stop_reason`.

`verified_context_count`는 검토 예산이며, 다른 sense로 판명된 문맥은 후보 생성에서 제외한다. 정확한 sense-verified 부분집합은 이 값보다 작을 수 있다.

## 6. 실행 순서

1. 고정 표본(ordinal ≡ 1 mod 11, 52 sense)으로 절차 점검.
2. 표본에서 발견된 공통 문제만 수정(단어별 예외 금지).
3. 같은 규칙으로 500 records 전체 적용.
4. 후보 수가 적다는 이유로 규칙을 바꾸지 않는다.

## 7. 보고

발굴 풀과 최종 후보를 분리 보고한다. 후보 수 증가를 정확성 개선으로 주장하지 않는다. 이 회차는 016/01을 이미 관찰한 개발 실험이며 블라인드 재현이 아니다.

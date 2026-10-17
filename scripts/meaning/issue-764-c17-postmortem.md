# #764 포스트모텀 기초자료 — c17 (#814)

> 이 문서는 **현재 병합/분리 상태와 근거 자료**만 모은 읽기 전용 목록이다. 병합·분리의 옳고 그름, 규칙, 수정안을 판정하지 않는다.

## 1. 입력과 규모

- 기준 master SHA: `cf73dd4a946af4c0de40c39f62add08ceb6924a2`
- 데이터 다이제스트(canonical+meanings+adjudication, sha256): `7b521c8c6e4e111bb8c9552fb7c557748c07b24f167303fbf57d1946578b7e27`
- Meaning shard (12): `data/meanings/c17_001.jsonl`, `data/meanings/c17_002.jsonl`, `data/meanings/c17_003.jsonl`, `data/meanings/c17_004.jsonl`, `data/meanings/c17_005.jsonl`, `data/meanings/c17_006.jsonl`, `data/meanings/c17_007.jsonl`, `data/meanings/c17_008.jsonl`, `data/meanings/c17_009.jsonl`, `data/meanings/c17_010.jsonl`, `data/meanings/c17_011.jsonl`, `data/meanings/c17_012.jsonl`
- adjudication shard (1): `data/adjudication/c17_001.jsonl`

| 항목 | 수 |
| --- | ---: |
| lemma (Meaning이 있는 표제어) | 8,918 |
| canonical record | 10,066 |
| canonical sense | 11,949 |
|   └ Meaning에 귀속 | 11,945 |
|   └ adjudication DROP | 4 |
|   └ 미귀속(구조 검증 실패 시에만 0 아님) | 0 |
| Meaning | 10,316 |
| A. 2개 이상 sense를 가진 Meaning | 1,069 |
| B. 2개 이상 Meaning을 가진 lemma | 867 |
| A·B 양쪽에 해당하는 lemma | 258 |
| 검토 대상 lemma (A∪B, 중복 제외) | 1,607 |
| 목록 제외: 단일 sense·단일 Meaning lemma | 7,311 |
| 참고: 그룹 간 원어(한자) 표기가 다른 lemma | 48 |
| 참고: 과거 기록에 인용할 이유가 없는 lemma (`기록 없음`) | 0 |

구조 집계(Meaning 귀속·DROP 대조)는 `scripts/meaning/contract.mjs`의 공통 validator(`complete: true`) 결과이며, 의미적 승인 상태를 뜻하지 않는다.

## 2. 목록 위치와 읽는 법

- 전체 원문 대조 목록: [`issue-764-c17-postmortem.jsonl`](issue-764-c17-postmortem.jsonl) — lemma 한 줄(JSON)이 한 묶음이다. A와 B에 모두 해당하는 lemma는 한 줄에 전체 분할 상태가 들어 있다(`in_merged_set`, `in_split_set`).
- `groups[]`: 현재 Meaning 그룹. `meaning_id`, 현재 `gloss`, `merged`(2+ sense 여부)와 `senses[]`(sense ID, record ID, 품사, **canonical 원문 gloss**, canonical shard).
- `senses[].history`: 과거 #716/#764/#772/#774 편집 기록 중 그 sense ID가 실제로 등장한 위치(`파일:줄` 또는 `파일#JSON경로`). lemma 수준 `recorded_reasons`: 그 기록에 적힌 문장을 그대로 인용한 것(과거 기록이 lemma 단위로 쓰였으면 그룹 단위가 아닌 lemma 단위로 붙는다)이며, 없으면 `recorded_reason_status` = `기록 없음`.
- `senses[].hanja_in_canonical_text`: canonical 표제어·gloss·검색형에 문자 그대로 있는 한자 연속열. `source_original`/`source_origin`은 과거 감사 기록(`source_audit`)이 STDICT에서 옮겨 둔 값이 있을 때만 나온다.

## 3. 출처·추적

- `source sense ID → Meaning ID`는 `data/meanings/` 행의 `sense_ids`이며, JSONL에서 `groups[].senses[].sense_id`가 `groups[].meaning_id`에 속한다.
- 원문 경로: `senses[].canonical_shard`(`data/canonical/` 아래) 의 해당 record 행. 과거 기록 인용은 출처로만 쓰며 새 판정을 만들지 않는다.

## 4. 커버리지·제약

- A(2+ sense Meaning 1,069개)와 B(2+ Meaning lemma 867개)를 `data/meanings/`에서 전수 추출했다. 목록 줄 수는 검토 대상 lemma 수 1,607와 같아야 하며 `postmortem.test.mjs`가 이를 재계산해 대조한다.
- 같은 STDICT record 안의 병합과 서로 다른 record 간 병합을 모두 포함한다(A는 `sense_ids` 길이만 기준).
- 과거 이유 대조는 `scripts/meaning/issue-{716,764,772,774}-*` 의 md/jsonl/json에서 sense ID 문자열이 **정확히** 등장하는 경우만 연결한다. `s1/s2` 같은 축약 표기나 sense ID 없이 lemma만 적힌 서술은 자동 연결되지 않으므로 `기록 없음`이 “과거에 판단이 없었다”는 뜻은 아니다.
- 커밋된 canonical에는 STDICT의 원어(한자) 필드가 없다. 한자 정보는 canonical 텍스트에 문자로 남아 있거나 과거 감사가 옮겨 적은 경우만 표시되며, 없는 경우 `원어 정보 없음`이 아니라 단지 이 저장소에서 확인할 수 없음을 뜻한다.
- `distinct_hanja_across_groups`는 그룹 간 한자 표기가 서로 다르다는 사실 표시일 뿐 분리/병합 판정이 아니다.


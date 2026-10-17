# #764 포스트모텀 기초자료 — c12 (#814)

> 이 문서는 **현재 병합/분리 상태와 근거 자료**만 모은 읽기 전용 목록이다. 병합·분리의 옳고 그름, 규칙, 수정안을 판정하지 않는다.

## 1. 입력과 규모

- 기준 master SHA: `8c9a5e17116e1b73a1d814a6da6fa34f906cff7d`
- 데이터 다이제스트(canonical+meanings+adjudication, sha256): `743dc210581a204748bc40f97530ac61655fa466977cfeb06b9458d03e01079f`
- Meaning shard (80): `data/meanings/c12_001.jsonl`, `data/meanings/c12_002.jsonl`, `data/meanings/c12_003.jsonl`, `data/meanings/c12_004.jsonl`, `data/meanings/c12_005.jsonl`, `data/meanings/c12_006.jsonl`, `data/meanings/c12_007.jsonl`, `data/meanings/c12_008.jsonl`, `data/meanings/c12_009.jsonl`, `data/meanings/c12_010.jsonl`, `data/meanings/c12_011.jsonl`, `data/meanings/c12_012.jsonl`, `data/meanings/c12_013.jsonl`, `data/meanings/c12_014.jsonl`, `data/meanings/c12_015.jsonl`, `data/meanings/c12_016.jsonl`, `data/meanings/c12_017.jsonl`, `data/meanings/c12_018.jsonl`, `data/meanings/c12_019.jsonl`, `data/meanings/c12_020.jsonl`, `data/meanings/c12_021.jsonl`, `data/meanings/c12_022.jsonl`, `data/meanings/c12_023.jsonl`, `data/meanings/c12_024.jsonl`, `data/meanings/c12_025.jsonl`, `data/meanings/c12_026.jsonl`, `data/meanings/c12_027.jsonl`, `data/meanings/c12_028.jsonl`, `data/meanings/c12_029.jsonl`, `data/meanings/c12_030.jsonl`, `data/meanings/c12_031.jsonl`, `data/meanings/c12_032.jsonl`, `data/meanings/c12_033.jsonl`, `data/meanings/c12_034.jsonl`, `data/meanings/c12_035.jsonl`, `data/meanings/c12_036.jsonl`, `data/meanings/c12_037.jsonl`, `data/meanings/c12_038.jsonl`, `data/meanings/c12_039.jsonl`, `data/meanings/c12_040.jsonl`, `data/meanings/c12_041.jsonl`, `data/meanings/c12_042.jsonl`, `data/meanings/c12_043.jsonl`, `data/meanings/c12_044.jsonl`, `data/meanings/c12_045.jsonl`, `data/meanings/c12_046.jsonl`, `data/meanings/c12_047.jsonl`, `data/meanings/c12_048.jsonl`, `data/meanings/c12_049.jsonl`, `data/meanings/c12_050.jsonl`, `data/meanings/c12_051.jsonl`, `data/meanings/c12_052.jsonl`, `data/meanings/c12_053.jsonl`, `data/meanings/c12_054.jsonl`, `data/meanings/c12_055.jsonl`, `data/meanings/c12_056.jsonl`, `data/meanings/c12_057.jsonl`, `data/meanings/c12_058.jsonl`, `data/meanings/c12_059.jsonl`, `data/meanings/c12_060.jsonl`, `data/meanings/c12_061.jsonl`, `data/meanings/c12_062.jsonl`, `data/meanings/c12_063.jsonl`, `data/meanings/c12_064.jsonl`, `data/meanings/c12_065.jsonl`, `data/meanings/c12_066.jsonl`, `data/meanings/c12_067.jsonl`, `data/meanings/c12_068.jsonl`, `data/meanings/c12_069.jsonl`, `data/meanings/c12_070.jsonl`, `data/meanings/c12_071.jsonl`, `data/meanings/c12_072.jsonl`, `data/meanings/c12_073.jsonl`, `data/meanings/c12_074.jsonl`, `data/meanings/c12_075.jsonl`, `data/meanings/c12_076.jsonl`, `data/meanings/c12_077.jsonl`, `data/meanings/c12_078.jsonl`, `data/meanings/c12_079.jsonl`, `data/meanings/c12_080.jsonl`
- adjudication shard (1): `data/adjudication/c12_001.jsonl`

| 항목 | 수 |
| --- | ---: |
| lemma (Meaning이 있는 표제어) | 57,820 |
| canonical record | 69,306 |
| canonical sense | 79,935 |
|   └ Meaning에 귀속 | 79,914 |
|   └ adjudication DROP | 21 |
|   └ 미귀속(구조 검증 실패 시에만 0 아님) | 0 |
| Meaning | 69,330 |
| A. 2개 이상 sense를 가진 Meaning | 7,802 |
| B. 2개 이상 Meaning을 가진 lemma | 5,734 |
| A·B 양쪽에 해당하는 lemma | 2,270 |
| 검토 대상 lemma (A∪B, 중복 제외) | 10,533 |
| 목록 제외: 단일 sense·단일 Meaning lemma | 47,287 |
| 참고: 그룹 간 원어(한자) 표기가 다른 lemma | 617 |
| 참고: 과거 기록에 인용할 이유가 없는 lemma (`기록 없음`) | 10,469 |

구조 집계(Meaning 귀속·DROP 대조)는 `scripts/meaning/contract.mjs`의 공통 validator(`complete: true`) 결과이며, 의미적 승인 상태를 뜻하지 않는다.

## 2. 목록 위치와 읽는 법

- 전체 원문 대조 목록: [`issue-764-c12-postmortem.jsonl`](issue-764-c12-postmortem.jsonl) — lemma 한 줄(JSON)이 한 묶음이다. A와 B에 모두 해당하는 lemma는 한 줄에 전체 분할 상태가 들어 있다(`in_merged_set`, `in_split_set`).
- `groups[]`: 현재 Meaning 그룹. `meaning_id`, 현재 `gloss`, `merged`(2+ sense 여부)와 `senses[]`(sense ID, record ID, 품사, **canonical 원문 gloss**, canonical shard).
- `senses[].history`: 과거 #716/#764/#772/#774 편집 기록 중 그 sense ID가 실제로 등장한 위치(`파일:줄` 또는 `파일#JSON경로`). lemma 수준 `recorded_reasons`: 그 기록에 적힌 문장을 그대로 인용한 것(과거 기록이 lemma 단위로 쓰였으면 그룹 단위가 아닌 lemma 단위로 붙는다)이며, 없으면 `recorded_reason_status` = `기록 없음`.
- `senses[].hanja_in_canonical_text`: canonical 표제어·gloss·검색형에 문자 그대로 있는 한자 연속열. `source_original`/`source_origin`은 과거 감사 기록(`source_audit`)이 STDICT에서 옮겨 둔 값이 있을 때만 나온다.

## 3. 출처·추적

- `source sense ID → Meaning ID`는 `data/meanings/` 행의 `sense_ids`이며, JSONL에서 `groups[].senses[].sense_id`가 `groups[].meaning_id`에 속한다.
- 원문 경로: `senses[].canonical_shard`(`data/canonical/` 아래) 의 해당 record 행. 과거 기록 인용은 출처로만 쓰며 새 판정을 만들지 않는다.

## 4. 커버리지·제약

- A(2+ sense Meaning 7,802개)와 B(2+ Meaning lemma 5,734개)를 `data/meanings/`에서 전수 추출했다. 목록 줄 수는 검토 대상 lemma 수 10,533와 같아야 하며 `postmortem.test.mjs`가 이를 재계산해 대조한다.
- 같은 STDICT record 안의 병합과 서로 다른 record 간 병합을 모두 포함한다(A는 `sense_ids` 길이만 기준).
- 과거 이유 대조는 `scripts/meaning/issue-{716,764,772,774}-*` 의 md/jsonl/json에서 sense ID 문자열이 **정확히** 등장하는 경우만 연결한다. `s1/s2` 같은 축약 표기나 sense ID 없이 lemma만 적힌 서술은 자동 연결되지 않으므로 `기록 없음`이 “과거에 판단이 없었다”는 뜻은 아니다.
- 커밋된 canonical에는 STDICT의 원어(한자) 필드가 없다. 한자 정보는 canonical 텍스트에 문자로 남아 있거나 과거 감사가 옮겨 적은 경우만 표시되며, 없는 경우 `원어 정보 없음`이 아니라 단지 이 저장소에서 확인할 수 없음을 뜻한다.
- `distinct_hanja_across_groups`는 그룹 간 한자 표기가 서로 다르다는 사실 표시일 뿐 분리/병합 판정이 아니다.


# C V9 RUN — Shard 013 Batch 01 (calibration)

## 0. 식별과 동결

| 항목 | 값 |
| --- | --- |
| MODE | CALIBRATION (표준 생산 승인 전) |
| Method / Shard / Batch | C / 013 / 01 |
| Model | DeepSeek (opencode-go, `deepseek-v4.1-flash`) |
| RUN ID | `c-v9-013-01-deepseek-20261019` |
| Output | `experiments/1061/v9/013_01_c_deepseek.jsonl` |
| Output SHA-256 | `f62a27b16f3024ee932baa2ac83f14272536a2b847afa71b313efe9dac4d5bc9` |
| Procedure | `experiments/1061/v9/C_PROCEDURE.md` SHA-256 `9f53c529d0557da9cb91d4baab6e0da87aed65b45df459af2f5a81009a7980d4` |
| Git base HEAD | `d4de79918a0e6b8452a0a1f3a3250052c044c629` (`master`) |
| Canonical | `data/canonical/stdict-0013.jsonl` SHA-256 `d7d1534437da8db369c0d65eade1e63e45d73e96892aea81a4a420020114192e`, rows 1–500, 500 records / 560 senses |
| Literature index | `~/.cache/typewriter/reference/literature/indexes/public-domain-literature.sqlite` SHA-256 `07770a5f5db772b66980fe484c30c7448771f8a4629f64abd6072023f1dd99f7` (read-only, FTS5 trigram ≥3자 + 2자 `instr()` 스캔) |
| 실행 | 2026-10-19, 단일 DeepSeek run. 원문·발췌·SQLite·locator·검색 로그는 Git에 넣지 않음 |

이 배치는 개발 데이터(013/01, rows 1–500)로 이미 결과를 열람한 calibration이다. V9는
블라인드 재현 성공을 주장하지 않는다.

## 1. 규모와 검색

- Canonical: **500 records / 560 senses**. 출력도 500레코드/560센스를 그대로 보존.
- 검색: FTS5 trigram(3자 이상) + `instr()`(2자) + 실제 문자열 포함 재확인, 용언·형용사
  활용형·불규칙 활용 보강. 표제어 1자인 `건(w14505-s1)`, `걸(w14694-s1)`,
  `걸(w14694-s2)`, `검(w14721-s1)` 4 senses는 신뢰할 경계 검증 경로가 없어
  `UNSEARCHABLE`로 표시했고, 용례 없음으로 세지 않았다.
- 후보 hit unit이 있는 senses **218**, `ZERO_HITS` **338**, `UNSEARCHABLE` **4**.
  검색이 후보로 올린 문맥(작품당 최대 2, sense당 최대 16)은 **1,914**.
- 실제 판독 문맥 **1,360**: 창 전이는 1–4문맥 84 senses, 5–8문맥 108 senses,
  9–16문맥 26 senses. 16문맥 상한에 도달한 senses는 17.
- 결속 판정: **VERIFIED 393 / AMBIGUOUS 19 / REJECTED 948** (합 1,360).
  REJECTED 사유는 대부분 동음이의어·다른 품사·다른 뜻(예: `건히`의 `흥건히/온건히`,
  `거정`의 `서거정/임거정`, `건부`의 `조건부`, `건성`의 “건성으로” 부사 쓰임)과
  부분 문자열 오탐이다.

## 2. PASS B — 7관점 2회 sweep

- **393 VERIFIED 문맥**에 7관점(Image / Action / Emotion / Sensation / Scene /
  Causality / Metaphor·Contrast)을 적용해 후보를 모았다.
- 1차 sweep: 배치 판독과 동시에 각 VERIFIED 문맥에서 단어·짧은 이미지 후보를 생성.
- 2차 sweep: 전체 후보를 다시 훑으며 누락된 이미지·정서·대비를 추가하고, 동시에
  문장·사건 서술 후보를 단어/짧은 구로 환원하거나 제거했다.
- 대표 관점 예시(최종 후보에서):
  - Image: `검은 구름`, `저문 빛`, `검정 광목치마`, `움쑥 패인 눈`
  - Action: `걷어차다`, `쓸어지다`, `앉히다`, `가로지르다`
  - Emotion: `겁`, `황송`, `참담`, `초창한 기색`
  - Sensation: `찬 이슬`, `땟국`, `침`, `가래`, `매미 소리`
  - Scene: `공동묘지`, `대합실`, `검사대`, `들것`, `나루`
  - Causality: `파쇄`, `상실`, `지워지다`, `회복`
  - Metaphor/Contrast: `망각의 하천`, `거탄`, `파괴적 정신`, `검은 새떼`
- 후보별 lens 태그와 관점별 건수는 최종 ledger에 저장하지 않았고, 로컬 evidence
  단계에서만 사용했다. 총 후보 수 목표는 두지 않았다.

## 3. PASS C — 이전 버전 회복과 형식 귀속

자신의 V5/V6/V7/V8 후보를 `sense_id + 정규화 candidate`로 합친 고유 집합은 **521**이다.
V9 표현 단위 기준으로 다음과 같이 귀속했다.

| 귀속 | 건수 | 뜻 |
| --- | ---: | --- |
| RETAINED | 120 | V8에도 있고 V9에서도 유지된 적격 후보 |
| RECOVERED | 11 | V5~V7에는 있었지만 V8에서 빠졌다가 V9에서 복원한 후보 |
| FORM_EXTRACTED | 224 | 문장·사건형이거나 그 일부 문자열이 단어/짧은 구로 추출되어 출력에 반영된 후보 |
| FORM_EXCLUDED | 53 | 서술형 절·구체적 사건 설명으로 출력에서 제외한 후보 |
| TECHNICAL_EXCLUDED | 111 | 다른 sense/부분 문자열·설명 가능한 연결이 없는 주위 명사·날조 위험 후보 |
| STILL_UNVERIFIED_SOURCE | 2 | 실제 용례를 확보하지 못한 후보 |

- V6에는 있었으나 V7에서 빠진 후보 36건 중 **17건을 V9에서 문자열로 복원**했고,
  나머지는 그 문장에서 단어·짧은 구를 추출해 출력에 반영하거나(예: `과부살이`,
  `다심`, `망각의 하천`) 형식 부적격으로 로컬에 귀속했다.
- `STILL_UNVERIFIED_SOURCE` 2건(`빈둥빈둥 걸어오다`, `군성거리다`, `건들건들`의
  무위도식 sense)은 편집상 품질 DROP이 아니라 실제 용례 출처 실패로 기록했다.
- 이전 후보의 원문 근거가 로컬에 없을 때는 문맥을 재조회했고, 재조회로 확인되지 않은
  항목은 `STILL_UNVERIFIED_SOURCE` 또는 `TECHNICAL_EXCLUDED`로 구분했다.

## 4. PASS D — 표현 단위 실측과 기술적 제외

- 최종 출력 후보 **829**:
  - 공백 없는 단어 **728**
  - 공백 포함 짧은 구 **102**
  - 완전한 종결 문장·사건 서술 **0** (2차 sweep에서 환원·제거)
- 대표적인 단어/구 유형: `차표`, `수형`, `흉기`, `결산`, `안목`, `겁`, `황송`,
  `말대꾸`, `눈자위`, `검은 구름`, `움쑥 패인 눈`, `쓸쓸한 길`, `망각의 하천`,
  `한철 솟는 물`, `기초 공사`, `무거운 송낙`.
- 구체적 사건·장면 서술로 제외한 대표 예: `난쟁이의 걸음`, `고개를 까댁이며 걷다`,
  `병아리의 암수를 가려내다`, `회계기의 결산을 맞추다`, `건넛산 공동묘지로 눈이 쏠리다`.
  원문에서 추출한 단어는 각각 `걸음`, `휘둥그래진 눈`, `차표`, `결산`, `공동묘지` 등으로
  출력에 반영했다.
- 기술적 제외 대표: 다른 sense의 동음이의어(`거정`의 `서거정/임거정`), 부분 문자열
  (`건성`의 “건성으로”, `건부`의 “조건부”), 실제 문맥이 없는 조합, 출발 lemma와 정확히
  같은 후보(`겉칠`), 같은 sense 내 정규화 정확 중복.

## 5. 최종 산출

- `013_01_c_deepseek.jsonl`: **500 records / 560 senses / 829 candidates /
  448 empty senses / 112 active senses**.
- 후보가 많은 senses: `검은빛(w14521-s1) 17`, `건축(w15047-s1) 16`,
  `걸메다(w15096-s1) 16`, `검사하다(w14823-s1) 14`, `걸음걸이(w14864-s1) 14`,
  `건망증(w14951-s1) 14`, `건축하다(w15048-s1) 14`.
- 관계 상태: VERIFIED 106 senses + AMBIGUOUS 6 senses = 112 활성. `AMBIGUOUS`는
  실제 용례가 확인되지만 출발 sense와의 결속이 완전하지 않은 경우(예: `건침`,
  `걸언`, `건백`)로, 후보는 형식 적격일 때만 보존했다.
- Stage 1에 type/Tier/admission/target을 넣지 않았고 Candidate v1 계약을 통과했다.

## 6. 실행 완전성 검사

- Canonical 500레코드 순서·ID, record별 모든 sense, sense_id 일치 확인.
- 허용 필드(`record_id`, `senses[].sense_id`, `senses[].candidates`)만 사용, 후보는
  비어 있지 않은 trim 문자열, 같은 sense 내 정규화 정확 중복 0, 출발 lemma와 정확히
  같은 후보 0(입력에 `겉칠` 1건이 있어 build에서 제거), 천 단위 쉼표 숫자 파편 0.
- 계약 검사: `scripts/relation/candidate-contract.mjs`의 `validateCandidateBatch`를
  직접 호출 → `{recordCount:500, senseCount:560, candidateCount:829,
  emptySenseCount:448}`. 실험 경로(`experiments/1061/v9/`) 산출물이므로 파일명 경로
  검사(`validateCandidatePaths`)는 적용하지 않았고 batch 검증은 통과했다. 이 파일은
  정식 `data/relation-candidates/` 커서를 갱신하지 않는다.
- 원문·발췌·SQLite·검색·evidence 로그는 로컬(`~/.cache/typewriter/c-v9-1109/`)에만 둔다.

## 7. 한계와 비용

- 문학 인덱스는 공개 도메인 문학(시/소설/수필)만 포함한다. 560 senses 중 338 senses는
  `ZERO_HITS`, 4 senses는 `UNSEARCHABLE`이며 후보는 112 active senses에 집중된다.
- 창 상한 16문맥. 검색이 올린 1,914문맥 중 1,360을 판독했고 554문맥은 상한·중복
  회피로 읽지 않았다. 16문맥 밖의 추가 회수는 하지 않았다.
- 동음이의어·다른 품사 판정은 문맥 수동 판정에 의존했다. REJECTED 948건의 판정 근거는
  로컬에만 남겼다.
- 활용형 보강은 어간 규칙과 관형사형 근사에 의존하므로 완전한 형태소 분석이 아니다.
  `ZERO_HITS`를 “이 말이 쓰이지 않았다”는 뜻으로 해석하지 않는다.
- 후보별 lens 태그와 7관점별 건수, 관점별 발굴 편중은 별도로 집계하지 않았다.
- 비용·시간: 로컬 SQLite 읽기 전용 검색 + 수동 판독. 다른 모델/CLI/서브에이전트는
  호출하지 않았다. 오너/ChatGPT 독립 평가 전 FREEZE·배치 생산을 시작하지 않는다.

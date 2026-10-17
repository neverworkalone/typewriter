# Typewriter 0.3 — Experiment D: 문어 말뭉치 SQLite 문맥 생성

**Issue:** [#846](https://github.com/neverworkalone/typewriter/issues/846)
**실행일:** 2026-10-18 (KST)
**상태:** D 방식 파일럿 완료. 아래 채택/수정 평가는 생산자 잠정 판단이며 독립 리뷰가 아니다.

## 요약

고정 코호트 8개 출발 의미를 Canonical의 정확한 레코드·sense에 결속하고, 로컬 문어 말뭉치 SQLite에서 읽기 전용으로 문맥을 조회했다. 45개 완전 문단 문맥을 검토했으며, 지정 sense와 맞는 문맥은 32개였다. 그 문맥에서 말의 결·연상 후보 35개를 작성했다. `번지다`는 표본 문맥이 잉크·색·물기의 확산 sense를 뒷받침하지 않아 후보를 만들지 않았다.

후보는 `near/mood/scene/sensory/action/association`만 사용한다. 신규 `direct/antonym`, 역방향 관계, Canonical/제품 데이터, 표제어 승급 후보는 만들지 않았다. 표의 판단은 이 실험 작업자의 self-assessment이며 #841의 동일 기준 독립 비교를 대체하지 않는다.

## 이용 허가와 자료 경계

- 프로젝트의 외부 자료 기록은 국립국어원 문어 말뭉치 2025의 로컬 저장, 처리, SQLite/FTS 인덱싱, 어휘 참고 이용 허용을 기록한다. 2026-10-18 이슈 작업 중 소유자는 서명한 이용 약정에 이 목적의 외부 LLM 전송 허용이 명시되어 있다고 확인했다. 국립국어원 [모두의 말뭉치 FAQ](https://kli.korean.go.kr/m/boards/faqList.do)는 말뭉치 이용을 승인 목적에 한정하고, 공개 결과에서 원문을 제외하며 공개 전에 사전 승인을 받도록 안내한다.
- 자료 출처 표기: `국립국어원 문어말뭉치 2025(1.0). 국립국어원 모두의 말뭉치.` 이 출처 표기는 문맥 원문이나 문서별 식별자를 재현하지 않는다.
- 실제 SQLite는 `/Users/genonfire/.cache/typewriter/reference/corpus/indexes/written-corpus-2025.sqlite`에서 `mode=ro&immutable=1`로 열었다. 재구축·수정·복사하지 않았다.
- 인덱스 메타데이터: 문서 3,410개, 문단 4,988,970개, SQLite 3.53.3. 검색 가능한 자료는 모두 `문어 > 책-상상 > 문학` 범주였으므로 범주 다양성은 1개다.
- 원본 DB SHA-256: `4c357e83c6ee93a9a1e5e48a8cf53d7dec32c9387aae9f5a1192ce3484e5848b` (3,940,503,552 bytes). 논리 행 digest: `c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd`.
- PR에는 문단, 발췌문, 제목, 저자, 문서·문단 ID, 원본 DB, evidence pack을 넣지 않는다. 이 보고서에는 출발/후보 표제어, 의미 판정, 텍스트를 재현하지 않는 집계만 둔다.

## 공통 코호트와 Canonical 결속

아래 8개는 #841에서 고정한 표본이다. 뜻 힌트는 코호트 구분용으로 바꿔 쓴 것이며, source paragraph를 인용하지 않는다.

| 출발어 | Canonical record / sense | 고정 의미 힌트 |
|---|---|---|
| 나그네 | `w408179` / `w408179-s1` | 고향을 떠나 다른 곳에 머물거나 떠도는 사람 |
| 그리움 | `w44055` / `w44055-s1` | 사람이나 지나간 것을 간절히 보고 싶어 하는 마음 |
| 문턱 | `w425010` / `w425010-s1` | 출입문 아래의 물리적 턱 |
| 쓸쓸하다 | `w213407` / `w213407-s1` | 외롭고 적적한 상태 |
| 흐르다 | `w508767` / `w508767-s3` | 액체가 낮은 곳으로 내려가거나 넘쳐 움직임 |
| 기다리다 | `w405064` / `w405064-s1` | 사람이나 때가 오기를 바람 |
| 번지다 | `w434809` / `w434809-s1` | 액체가 묻어 점차 넓게 젖어 퍼짐 |
| 과거 | `w398310` / `w398310-s1` | 科擧: 옛 관리 등용 시험 제도; 過去 뜻은 제외 |

## 검색·표본 절차와 측정

- 3자 이상 검색은 FTS5 trigram literal substring, 1–2자 검색은 정확한 `instr` literal fallback을 사용했다. 짧은 검색의 집계 수치는 별도 `short-counts` 인덱스와 일치하는지 확인했다. 이 수치는 문단 내 문자열 포함 횟수나 형태소·품사·표제어 빈도가 아니다.
- 완전한 문단만 사용하고 한 출발어당 최대 8개 문맥을 넘지 않았다. 가능한 경우 서로 다른 문서에서 뽑았으며, 문서 순서에 걸쳐 표본을 나눴다. 검색 표본은 대체로 35–250 Unicode code point 문단으로 제한했다. 기준 표본의 source-text 입력은 출발어별 570–650자 이내였다. 흐르다·번지다의 활용형 확인 및 과거 sense 구분을 위해 추가한 문맥까지 포함하면 각각 833자, 1,015자, 963자였다. 모델별 정확한 토큰 카운터는 노출되지 않아 문자 수를 토큰 수로 바꾸거나 약 1,200 토큰 상한 준수를 확정하지 않는다.
- 사용한 모델은 이 Codex 세션의 모델이다. 세부 빌드 ID, temperature, 출력 토큰 설정은 인터페이스에서 확인할 수 없었다. 따라서 결과를 순수한 생성 방법 효과로 해석하지 않는다.
- 각 출발어에서 Canonical 뜻 힌트와 선택 문맥을 바탕으로 최대 8개 후보를 한 번 생성하고, 후보별 타입·상대 relevance·정확한 대상 의미를 이 작업자가 점검했다. 출력 필드는 #841의 `source_lemma, source_record_id, source_sense, method, target_text, target_record_id_or_null, relation_type, relevance, provisional_decision, reasoning, failure_reason`를 따른다. source-context 문장·문단은 보고서에 남기지 않았다.
- 검색·표본 시간은 아래 표의 측정값이며 문맥 의미 검토, 후보 작성, 전체 대화 대기 시간은 따로 계측하지 않았다. 입력/출력 토큰과 금액 비용도 측정값을 확인할 수 없어 기재하지 않는다. 별도 사람 검수는 아직 수행되지 않았다.

| 출발어 | literal 문단 hit 수 / 조회 표면 | 검토 문맥 / sense 일치 | 표본 문서 | 검색·표본 시간 |
|---|---:|---:|---:|---:|
| 나그네 | 1,650 (`나그네`) | 5 / 5 | 5 | 203 ms |
| 그리움 | 3,188 (`그리움`) | 5 / 5 | 5 | 389 ms |
| 문턱 | 2,026 (`문턱`, 2자 fallback) | 5 / 4 | 5 | 6,262 ms |
| 쓸쓸하다 | 188 (`쓸쓸하다`) | 4 / 4 | 4 | 23 ms |
| 흐르다 | 253 (`흐르다`), 4,600 (`흐르고`); 2자 variant count-only: `흘러` 30,271, `흘렀` 10,524 | 7 / 3 | 7 | 784 ms |
| 기다리다 | 1,758 (`기다리다`) | 6 / 6 | 6 | 146 ms |
| 번지다 | 15 (`번지다`), 1,036 (`번졌다`), 305 (`번지고`); 2자 `번져` count-only: 1,293 | 7 / 0 | 7 | 298 ms |
| 과거 | 25,094 (`과거`, 2자 fallback); sense-focused query hit: `과거 시험` 174, `과거시험` 162, `과거제` 28 | 6 / 5 | 6 | 5,884 ms |

검색 집계는 #841의 `과거` 문맥 입력 상한·완전 문단 8개를 대체하지 않는다. 과거 sense-focused query의 hit 수는 검색어 간 중복이 있을 수 있어 합산하지 않았다. 2자 `흘러`, `흘렀`, `번져`는 표면 부분문자열이 매우 넓어 context input으로 사용하지 않고 count-only로 남겼다.

## 후보와 잠정 평가

`target_record_id_or_null`은 현재 Canonical에서 정확한 target sense를 확인한 경우 record/sense ID를 쓴다. 정확한 표제어가 없으면 `null`과 text-only 후보를 사용한다. 각 소제목은 아래 행 전체의 `source_lemma`, `source_record_id`, `source_sense`, `method=D` 값이다. 표에는 나머지 공통 출력 필드와 `failure_reason`을 행마다 기록했다. relevance는 이 작은 후보 집합 안에서 같은 source/UI 그룹끼리 비교한 잠정 우선순위다. 모든 판단은 independent reviewer 확인 전까지 생산자 의견이다.

### 나그네 — `w408179` / `w408179-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 방랑자 | `w141383` / `w141383-s1` | association | 1 | keep | 떠도는 사람을 가리키는 가까운 표현 대안. | — |
| 고향 | `w25899` / `w25899-s3` | association | 3 | keep | 여행 중 떠나온 곳을 그리워하는 장면과 연결된다. | — |
| 소슬바람 | `w445267` / `w445267-s1` | sensory | 2 | keep | 길 위 인물의 계절감과 바람 감각을 보탠다. | — |
| 기차역 | `w51253` / `w51253-s1` | scene | 3 | keep | 여행자가 내리는 이동 장면을 연상시킨다. | — |

### 그리움 — `w44055` / `w44055-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 애틋하다 | `w457459` / `w457459-s1` | mood | 1 | keep | 간절한 그리움의 안타까운 정서와 가깝다. | — |
| 사랑 | `w435977` / `w435977-s4` | mood | 2 | keep | 그리움의 대상이 사랑하는 사람인 문맥이 있다. | — |
| 고독 | `w23543` / `w23543-s1` | mood | 3 | keep | 외로움과 함께 나타나는 정서적 색채다. | — |
| 바람 | `w426114` / `w426114-s1` | sensory | 1 | keep | 바람을 그리움의 전달 이미지로 사용하는 문맥이 있다. | — |
| 아른거리다 | `w455485` / `w455485-s1` | sensory | 3 | keep | 보고 싶은 사람의 희미한 이미지가 되살아나는 감각이다. | — |
| 사진 | `w439868` / `w439868-s1` | association | 2 | keep | 그리운 사람을 떠올리게 하는 보존된 시각 대상이다. | — |

### 문턱 — `w425010` / `w425010-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 문지방 | `w124390` / `w124390-s1` | association | 1 | keep | 물리적인 출입 경계의 가까운 표현 대안이다. | — |
| 넘다 | `w411046` / `w411046-s3` | action | 1 | keep | 문턱을 통과하는 동작이 여러 문맥에서 중심이다. | — |
| 대웅전 | `w411569` / `w411569-s1` | scene | 2 | keep | 문턱을 지나 들어가는 구체적인 공간이다. | — |
| 미술관 | `w127936` / `w127936-s1` | scene | 3 | keep | 드나드는 문턱이 있는 공공 공간이다. | — |

의미가 다른 비유적 `문턱` 표본 1개는 source-sense 근거에서 제외했다.

### 쓸쓸하다 — `w213407` / `w213407-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 외롭다 | `w466964` / `w466964-s1` | association | 1 | keep | 외로움과 함께 쓰인 가까운 정서 표현이다. | — |
| 고독 | `w23543` / `w23543-s1` | association | 2 | keep | 홀로 있다는 감정을 공유한다. | — |
| 가을 | `w389762` / `w389762-s1` | scene | 1 | keep | 적막한 들과 추수 뒤 풍경의 계절 배경이다. | — |
| 낙엽 | `w58851` / `w58851-s2` | sensory | 2 | keep | 잎이 떨어진 풍경이 시각적 정서를 만든다. | — |
| 침묵 | `w492980` / `w492980-s2` | sensory | 3 | keep | 소리가 줄어든 적막한 감각을 보탠다. | — |
| 기다리다 | `w405064` / `w405064-s1` | action | 4 | keep | 오지 않는 사람을 기다리는 상황이 쓸쓸함과 함께 있다. | — |

### 흐르다 — `w508767` / `w508767-s3` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 물줄기 | `w425157` / `w425157-s1` | scene | 1 | keep | 낮은 곳을 향해 이어지는 액체 흐름의 모습이다. | — |
| 개울 | `w11120` / `w11120-s1` | scene | 1 | keep | 골짜기와 들에 흐르는 작은 물의 풍경이다. | — |
| 강 | `w391391` / `w391391-s1` | scene | 2 | keep | 큰 물줄기의 지속적인 흐름을 떠올리게 한다. | — |
| 골짜기 | `w391656` / `w391656-s1` | scene | 3 | keep | 물이 낮은 곳으로 흘러드는 지형 이미지다. | — |
| 졸졸졸 | `null` (text-only) | sensory | 1 | keep | 약한 물 흐름의 소리를 나타내는 표현이다. | — |
| 콸콸콸 | `null` (text-only) | sensory | 2 | keep | 물이 세차게 흐르는 소리를 나타내는 표현이다. | — |

표본에는 침묵·소리·음악·물 위에서 움직이는 물체 등 다른 sense의 부분문자열도 있어 source-sense 근거에서 제외했다. 액체 흐름과 맞는 문맥 3개만 남겼다.

### 기다리다 — `w405064` / `w405064-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 돌아오다 | `w416230` / `w416230-s1` | action | 1 | keep | 기다리는 대상이 돌아오기를 바라는 상황이다. | — |
| 지치다 | `w486000` / `w486000-s1` | association | 2 | keep | 오래 기다린 뒤 기운이 빠지는 결과가 나타난다. | — |
| 전화벨 | `w477788` / `w477788-s1` | scene | 2 | keep | 응답을 기다리는 통화 장면을 구체화한다. | — |
| 마중 | `w110056` / `w110056-s1` | association | 4 | revise | 도착한 사람을 맞는 활동과 가깝지만 표본은 마중 동작을 직접 확인해 주지 않는다. | 표본이 마중 동작을 보여 주지 않아 target 확인이 필요함 |

### 번지다 — `w434809` / `w434809-s1` (method D)

**후보 0개.** 기본형과 활용형에서 검토한 7개 표본은 빛, 감정·분위기·소문, 주소 표기 등으로, 액체가 젖어 퍼지는 고정 sense를 뒷받침하지 않았다. 따라서 이 문맥으로부터 candidate를 만들지 않았고, `no useful evidence`로 기록한다. 표본에 포함되지 않은 부분문자열 hit 전체의 sense를 판정한 것은 아니며, 이 결과를 말뭉치 전체에 해당 sense의 용례가 없다는 주장으로 일반화하지 않는다.

### 과거 — `w398310` / `w398310-s1` (method D)

| target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
|---|---|---|---:|---|---|
| 시험장 | `w447105` / `w447105-s1` | scene | 1 | keep | 지정된 시험 제도의 응시 장소를 나타낸다. | — |
| 낙제 | `w406882` / `w406882-s4` | association | 1 | keep | 해당 시험에 응시했다가 실패하는 결과다. | — |
| 장원급제 | `null` (text-only) | association | 1 | keep | 시험에서 최고 성적으로 합격하는 결과를 나타낸다. | — |
| 출세 | `w496998` / `w496998-s1` | association | 2 | keep | 시험이 사회적 지위 상승의 길로 묘사되는 문맥이다. | — |
| 서생 | `w179278` / `w179278-s1` | association | 3 | keep | 유학을 공부하고 시험에 응하는 인물상과 연결된다. | — |

고빈도 2자 literal 검색에는 過去 의미가 섞였다. broad sample 1개는 과거의 지난 일을 뜻해 제외하고, 시험장·시험제 query로 고른 5개 문맥만 지정 sense에 사용했다.

## 자체 평가와 한계

- 최종 후보 35개: 잠정 `keep` 34개, `revise` 1개, `reject` 0개. `번지다`는 후보 0개다. 이는 생성 작업자의 자기 평가이며 독립 심사 점수가 아니다.
- 연상 Tier 1에 적합하다고 잠정 판단한 후보는 `나그네 → 방랑자`, `문턱 → 문지방`, `쓸쓸하다 → 외롭다` 3개다. 나머지 relevance는 같은 source/UI 그룹 안에서 상대 배치했다.
- 출발 sense의 기존 공식 `direct`/`antonym` 관계를 후보로 다시 제안한 건은 0개였다. 표본에서 확인한 오표기·동음이의·부분문자열 혼동은 sense 필터에서 제외했다.
- 한 corpus category만 있어 범주 다양성은 측정할 수 없었다. literal 검색은 활용형을 모두 포착하지 않으며, 두 글자 문자열은 오탐과 긴 검색 시간이 늘었다. `번지다`의 7개 표본은 sense에 맞지 않았지만 검색하지 않은 모든 문단에 용례가 없다는 뜻은 아니다.
- 실제 model token count, 출력 token count, 세부 설정, 생성/의미 검수 시간, 금액 비용은 측정되지 않았다. 위 수치를 추정값으로 대체하지 않았다.
- 이 파일 이외에 Canonical, relation source of truth, product, SQLite, CI 또는 다른 실험 보고서를 변경하지 않았다. 후보는 실험 결과로만 남았으며 제품 데이터로 승인되지 않았다.

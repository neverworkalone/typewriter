# D V10 절차 — 5관점 독립 2회 전수 판독 + 단어 우선 회복

이 문서는 Issue #1106의 **D V10** Stage 1 생산 절차다. 특정 016/01 배치의 결과나 단어 목록에 의존하지 않으며, 같은 Canonical·말뭉치 조건의 처음 보는 500-record 배치에도 같은 순서로 적용할 수 있도록 검색·판독·발굴·회복·형식 검사·정산 단계를 정의한다. 실행에 쓰는 로컬 스크립트와 경로는 §7에 둔다.

## 0. 역할 경계

- D는 **Stage 1 candidate generation**만 수행한다. 출력은 `record_id`, `senses[].sense_id`, `senses[].candidates[]`뿐이다.
- Tier·relevance·relation type·target ID·keep/drop·admission은 Stage 2의 결정이다. 이 절차는 그것을 예측하거나 모방하지 않는다.
- 다른 생산자(A/B/C, Codex 등)의 후보·문맥·평가를 읽지 않는다. 회복 입력은 **같은 016/01 D 생산자의 V4–V9**로 한정한다. 다른 배치의 D 결과도 복사하지 않는다.
- 승인된 문어 말뭉치 SQLite·FTS·bigram postings는 **read-only**로만 쓴다. 원문·발췌·locator·검색 로그·원문 포함 ledger·DB는 Git/PR/제품에 넣지 않는다. 필요한 증거는 로컬에만 둔다.

## 0.1 절대 금지 — 최종 후보 문장 0개 (NON-NEGOTIABLE)

최종 `senses[].candidates[]`에 **완결 문장, 서술형 절, 특정 사건/행동/절차의 설명, 또는 그 설명을 명사구로 위장한 표현을 단 하나도 넣지 않는다.** 원문에 실재했다는 사실, 짧다는 사실, Stage 2가 Drop할 수 있다는 사실은 예외 사유가 아니다.

금지 형태와 우회:

| 금지 | 우회 변형도 금지 |
| --- | --- |
| 주어+서술어가 있는 완결 문장 | 마침표만 제거, 종결형을 관형형으로 바꾼 절 |
| 한 사건의 시간순 서술 | 어미를 생략하고 명사만 나열 |
| 절차·과정 설명 | `일/장면/기술/상황/모습`을 붙여 명사구로 포장 |
| 특정 인물·장소가 등장하는 장면 요약 | 원문 절반을 잘라 구처럼 만든 문자열 |
| 뜻풀이를 축자적으로 되풀이한 조각 | 어순만 바꾼 뜻풀이 반복 |

**허용 형태:**

1. **독립 어휘(단어)** — 가장 넓게 보존한다. 흔하고 평범하며 관계가 약해도, VERIFIED source sense와 설명 가능한 연결 경로가 있으면 후보로 남긴다.
2. **짧고 응축된 비서술적 구·심상** — 단어 하나로 대체하기 어려운 독립 발견 가치가 있을 때만 선별한다. 공백이 있다는 이유만으로 일괄 배제하지 않는다.
3. **관용구·고정 결합** — 널리 알려져 있다는 사실 자체는 가치 근거가 아니다. 독립 발견 가치가 있을 때만 보존하며, 관용구로 포장한 서술문은 금지한다.

**실행 필수:** PASS B에서 원문 문장을 후보 문자열로 복사하지 않고 연상 어휘를 먼저 추출한다. PASS C에서 이전 후보를 회복할 때도 문장형은 `FORM_EXCLUDED`로 두고, 별도 독립 단어·구를 얻은 경우에만 `FORM_EXTRACTED(old→new)`로 계보를 기록한다. PASS D에서 **최종 JSONL의 모든 후보 문자열을 하나씩 읽고** 0건을 확인한다. 자동 validator 통과나 공백/정규식 검사만으로 완료를 선언하지 않는다.

## 0.2 후보 표현 단위와 일반 형식 규칙

- **동형이의·다른 용례 오결속을 먼저 의심한다.** 표제어가 다른 뜻으로 쓰인 문맥, 부분 문자열, 주변 명사만 모은 결과는 후보가 아니다. 표제어+일반 명사의 기계적 결합은 독립 어휘 가치가 없으면 제외한다. 반대로 표제어를 포함한 **진짜 별개 합성어·파생어**는 자동 금지하지 않고 개별 판정한다.
- **표제어 exact·괄호 주기 변형 금지.** `표제어(한자)`, `표제어(연도)`는 별개 후보가 아니다.
- **비어휘 형식 배제.** 숫자·수량·연도만의 표기, 문장부호가 붙은 문자열, 복수 접미 파생형 조각, 표제어의 기계적 `하다/되다/시키다` 활용형은 후보가 아니다. 다만 `코로나19`, `3D 프린터`, `5개년계획`처럼 숫자가 고유 명칭·제도의 일부인 어휘는 개별 판정한다.
- **고유명사는 개별 판정.** sense를 정의하는 사건·인물·저작·제도명은 보존할 수 있다. 단일 서사 문맥의 배경 인물·지명·선박명처럼 sense와 일반적 연결이 없는 이름은 `SOURCE_BINDING`으로 제외한다.
- 형식 판단은 어절 수·품사·`하다` 유무의 기계적 컷오프가 아니다. 형식을 통과한 **단어 후보의 약한 의미 관계는 Stage 2로 넘긴다.**

## 0.3 계수 정의 — 단위를 섞지 않는다

정산 오류를 막기 위해 다음 지표를 **별도 모집단**으로 계산하고, 서로 더하거나 맞추지 않는다.

| 지표 | 정의 |
| --- | --- |
| `search_contexts` | 검색이 확보한 고유 문맥 수(문서당 ≤2, sense당 ≤40, 중복 제거). |
| `v_verdicts_all_retrieved` | 확보한 전체 문맥에 대한 자동 sense-match `V` 판정 수. sense당 16을 넘을 수 있다. |
| `first_inspected_unique` | 실제로 처음 읽은 고유 `V` 문맥 수(sense당 최대 16). `min(v_verdicts, 16)`의 합. |
| `sweep_reread_contexts` | 두 sweep이 각각 다시 읽은 `V` 문맥 수 = `2 × first_inspected_unique`. |
| `sweep_lens_cells` | `5 × sweep_reread_contexts`. 실제로 읽지 않은 셀은 0건 발견이 아니라 `INCOMPLETE`다. |
| `raw_occurrences` | `sense × sweep × lens` 단위로 기록된 후보 등장 수(중복 포함). |
| `unique_pairs` | `sense_id + normalized_candidate` 고유 쌍. sweep 간·버전 간 중복을 합친 뒤의 수. |
| `final_candidates` | 최종 JSONL의 문자열 수. |
| `prior_unique_pairs` | V4–V9 union의 `sense_id + normalized_candidate` 고유 쌍. |
| `FORM_EXTRACTED` | **old 표현 → new 후보**의 실제 대응 쌍 수. sense 수와 혼용하지 않는다. |

`v_verdicts_all_retrieved`와 `first_inspected_unique`는 정의상 다른 모집단이다. 전자가 203×16과 맞지 않는다고 후자를 조정하거나, 반대로 총계를 맞추기 위해 판정 수를 바꾸지 않는다.

## 1. PRE-FLIGHT

1. `MODE=CALIBRATION`, `SHARD`, `BATCH`, `RUN_ID`, 실제 모델·제공자, 이 절차의 SHA-256, Canonical SHA-256, 말뭉치 index·sidecar digest, 시작 `origin/master` HEAD, 출력 경로를 기록한다.
2. Canonical 배치의 record 순서와 모든 sense(`lemma`, `pos`, `gloss`, `search_forms`, `sense_id`)를 동결하고 수를 센다.
3. 로컬 ledger 디렉터리를 만들고 25–50 records마다 checkpoint한다. 중단·재개 시 미완료 sense를 `[]`로 위장하지 않는다.
4. 작은 deterministic pilot으로 검색·파싱·형태소·검증의 **기술 오류만** 보정하고 절차를 동결한다. 후보 수를 보고 단어별 예외 규칙을 만들지 않는다.
5. 동일 Canonical SHA와 동일 말뭉치 digest의 이전 검색 snapshot이 있으면 재사용할 수 있다. 이때도 sense별 문맥 수·판정은 다시 확인하고, 문맥이 부족한 sense는 재검색한다.

## 2. PASS A — 실제 문어 사용 확보와 source-sense 검증

### 2.1 검색형 생성

표제어와 `search_forms`에서 다음을 일반 규칙으로 만든다.

- 표제어, 띄어쓰기 제거형, 다어절 표제어의 내용 토큰
- `하다/되다/시키다` 활용과 생산적 어미(`-하/해/했/한/할/합/한다/했다/하면/하며/하고/해서/하기/하여/되었/된다/됐/되면/되기/되어/시키/시켜/시킨`)
- 일반 용언 어간과 대표 불규칙 활용
- 같은 표제어의 여러 sense는 검색 pool을 공유하되 판정은 sense 단위로 분리

### 2.2 probe 순서

표제어·기본형을 **먼저**, 파생 활용형을 나중에 probe한다. 3자 이상은 FTS trigram, 2자 이하는 sidecar bigram postings 또는 `instr` LIKE를 쓴다. rowid 상한과 중단 조건을 기록한다.

### 2.3 문맥 구성

- locator, 문서 제목·저자·날짜, 일치 표면형, 일치 위치, 원문 단락을 로컬에 기록한다.
- 문서당 최대 2문맥, sense당 최대 40문맥, 중복 문맥 제거. 순위는 정확 표면형·토큰 경계·표면형 길이·문단 길이를 가중하되 부분 문자열을 버리지 않는다.
- 실제 최초 판독은 **1–4 → 5–8 → 9–12 → 13–16** 순으로 확대하고, 중단 사유를 남긴다. 16은 **최초 판독 고유 문맥**의 상한이며, 확보 문맥 수나 후속 재판독 수와 합산하지 않는다.

### 2.4 zero-hit / no-verified 재시도 사다리

1. 표제어·`search_forms` 기본 probe 재실행
2. 활용형·불규칙형·띄어쓰기·합성어 변형
3. 어간·기본형 우선 probe 순서로 재검색
4. 다른 승인 검색 경로(FTS ↔ bigram postings ↔ 부분 문자열)
5. 문맥 단위 재조회 및 문서 다양성 확대

재시도 후 실제 용례가 없으면 `ZERO_HITS`, 검색 자체가 실패하면 `SEARCH_FAILED`, 원문이 없으면 `UNSEARCHABLE`, 문맥은 있으나 정확한 sense 사용이 확인되지 않으면 `NO_VERIFIED`로 남긴다. 부분 문자열을 무작정 넓혀 오탐을 늘리지 않는다.

### 2.5 문맥 판정

- `V`: 정확히 이 sense의 쓰임이라는 긍정 증거
- `A`: 둘 이상 sense가 가능
- `R`: 다른 sense·동형이의어·다른 단어 활용형·부분 문자열 오탐

`A`는 다른 문맥 재검색으로 해소를 시도한다. 후보가 있는 sense에는 직접 `V`가 최소 하나 있어야 하며, 끝내 확인되지 않으면 `NO_VERIFIED` + 빈 배열이다. 이는 연상 강도를 미리 Drop하는 것이 아니다.

## 3. PASS B — VERIFIED 원문 5관점 × 독립 2회 전수 판독

**이 PASS가 V10의 핵심 교정이다.** 형태소 상위 토큰·문맥 근접 순위·digest 토큰 목록은 보조 단서일 뿐이며, **원문 직접 판독과 5관점 발굴을 대체하지 않는다.**

### 3.1 판독 단위

- 대상은 `first_inspected_unique`에 포함된 **모든 VERIFIED 고유 문맥**이다.
- 각 sweep은 그 문맥 전체를 처음부터 다시 읽는다. 1차 후보의 중복 검사, rank 25–96 재정렬, 바깥 창 토큰 검토, 문장→단어 형식 교정은 **2차 독립 발굴이 아니다.**
- 9–16 확장 문맥도 두 sweep에서 각각 읽는다. 확장 구간의 `NV`는 1–8 구간의 `V`를 뒤집지 않는다(서로 다른 문맥 모집단).
- digest에는 gloss, 판정, 번호가 붙은 원문 문맥을 넣고 **로컬에만** 보관한다. 후보 판단은 토큰 빈도가 아니라 원문의 행동·인과·대비·심상에서 출발한다.

### 3.2 다섯 관점

1. **coll(어휘·공기)**: 실제 결합에서 떠오르는 독립 어휘, 특이 표현의 핵심 단어
2. **act(행동·역할)**: 주체·대상·도구·역할·반응
3. **scene(상황·장면)**: 장소·시간·환경·활동·도달 상태의 독립 단어/응축 이미지
4. **cause(원인·결과)**: 동기·조건·변화·영향·대응·결과
5. **assoc(대비·감각·연상)**: 반대·대조·신체 감각·비유적/뜻밖의 연결

각 관점에서 (a) 원문 재판독 → (b) 명시·간접·느슨하지만 설명 가능한 관계 탐색 → (c) 후보와 연결 힌트 기록 → (d) 빠진 관계 재탐색 → (e) 없으면 0 기록을 수행한다.

### 3.3 후보 기록과 중복

- 로컬 결정 파일은 sense 단위로 `status(V|NV)`와 `[candidate, lens]` 목록을 기록한다. 같은 후보가 여러 관점·sweep에서 나오면 등장 횟수를 보존하되 최종 JSONL에서는 sense 내 정확 중복만 제거한다.
- sweep 1과 sweep 2의 **고유 후보 교집합·차집합**을 따로 집계한다. 2차 신규 후보 수와 중복 수를 별도로 보고한다.
- 후보 수 할당량·균등 분포·상한/하한을 두지 않는다. 새 발견이 0건인 sweep/sense도 정당한 결과다.
- 서로 다른 관점에서 같은 단어가 나온 것을 숨기지 않는다. 1차·2차·PASS C 기여는 별도로 집계한다.

## 4. PASS C — 동일 생산자 V4–V9 회복과 귀속

1. 같은 016/01 D 생산자의 V4–V9 후보 전체를 `sense_id + normalized_candidate`로 합쳐 **한 번만** 원장에 넣는다. 버전별 row 수와 고유 pair 수를 분리한다.
2. 각 이전 고유 pair는 최종 귀속 **정확히 하나**를 갖는다.
   - `RETAINED`: 이번 sweep에도 같은 문자열로 존재
   - `RECOVERED`: 이전 후보를 적격성 확인 후 복원
   - `SOURCE_UNVERIFIED`: 출발 sense의 실제 사용이 확인되지 않아 복원 불가
   - `TECHNICAL_EXCLUDED`: 비어휘·손상·표제어 괄호 변형 등 기술 결함
   - `FORM_EXCLUDED`: 문장·서술절·기계적 구·표제어 기계 파생 등 형식 결함
   - `FORM_EXTRACTED`: 금지 표현에서 별도 독립 단어·구를 추출(old→new pair로 기록)
   - `EXACT_DUPLICATE`: 공통 normalizer 기준 기존 후보와 동일(띄어쓰기 변형 포함)
   - `SOURCE_BINDING`: 단일 서사 배경 고유명사 등 sense 결속 실패
3. **단어 회복은 적극적으로.** 이전에 삭제된 약한/의외의 독립 단어라도 정확한 VERIFIED source와 표현 적격성을 확인하면 복원한다. Stage 2에서 Drop될 가능성은 배제 사유가 아니다.
4. **다어절 표현은 개별 심사.** 공백이 있다는 이유만으로 일괄 `FORM_EXCLUDED`하지 않는다. 서술형·절차·기계적 수식어+명사·뜻풀이 반복은 제외하고, 독립 발견 가치가 있는 응축 구·사건명·시대명은 복원할 수 있다. 기존 후보의 띄어쓰기 변형은 `EXACT_DUPLICATE`다.
5. `FORM_EXTRACTED`는 **old→new pair 수**로 집계한다. old 하나에서 new 여럿이 나오면 pair를 각각 세고, sense 수는 별도로 보고한다.
6. 최종 집합을 조립할 때 **sweep 신규 / PASS C 회복 / 정확 중복 제외 / 형식·소스 오류 제외**를 분리하고, 각 최종 항목의 primary origin을 기록한다. 조립 합계가 실제 최종 후보 수와 일치해야 한다.

## 5. PASS D — 기술 검사 + 문자열 전수 형식 검사

**하드 제외/수정:**

- record/sense 정렬·ID·순서·스키마 위반, 존재하지 않는 근거, 다른 뜻/부분 문자열 오탐
- 정확한 표제어, 띄어쓰기만 다른 표제어 변형, 표제어+괄호 전용 변형
- 숫자·수량·연도만의 표기, 문장부호 포함, 복수 접미 파생형 조각, 표제어 기계적 활용/파생
- 같은 sense 안 정규화 중복, 빈 문자열, 앞뒤 공백
- 단일 서사 문맥의 배경 고유명사처럼 sense 결속이 없는 문자열

**전수 검사(필수):** 최종 JSONL의 모든 후보를 하나씩 읽고 문장·서술형 절·사건/과정 설명·위장 명사구가 0건임을 확인한다. 위반이 1건이라도 있으면 수정·제거 후 다시 전수 검사한다. 어절 수·정규식·validator 통과만으로 완료를 선언하지 않는다.

**Stage 2로 이양:** 관계 강도, Tier 가능성, 근접 표현의 우열, 흔한 배경어의 가치 판단. Stage 1은 형식과 source 결속만 차단한다.

## 6. PASS E — 검증·재계산·정산

- 기존 `validateCandidateBatch`로 500 records·565 senses·ID·순서·Candidate v1·정규화 중복·source lemma 금지를 검증한다.
- **모든 수치는 최종 JSONL에서 다시 계산한다.** nonempty + empty = 전체 sense, 공백 없음 + 공백 있음 = 전체 후보, 의미 분류(단어/응축 구/관용·고정 표현)는 서로 겹치지 않게 합계를 맞춘다.
- PASS A sense verdict 합계 = 전체 sense. `first_inspected_unique`가 sense당 16을 넘지 않는지 확인한다.
- PASS B는 `VERIFIED 고유 문맥 × 5관점 × 2회`의 완료 여부와 sweep별 신규/중복/0건을 집계한다. 최초 판독과 재판독을 같은 수치에 누적하지 않는다.
- V4–V9 고유 pair 귀속 합계 = `prior_unique_pairs`. 최종 후보 = 신규 발굴 + 회복 + (정확 중복·형식/소스 오류 제외)로 독립 재현한다.
- 이전 버전 보고 수치의 표면 불일치는 **정의를 분리해 설명**하고, 숫자를 맞추기 위해 사후 보정하지 않는다.
- `final_sentence_or_event_description_count = 0`을 명시하고 `FORM_EXCLUDED`와 `FORM_EXTRACTED(old→new)`를 분리 집계한다. source 실패와 form 실패를 혼동하지 않는다.
- 원문·DB·locator·evidence ledger·원시 로그는 Git에 넣지 않는다. 미완료 sweep/sense는 `INCOMPLETE`로 보고하고 완료를 가장하지 않는다.

## 7. 실행 파이프라인 (V10에서 실제로 사용)

1. **검색** `search.mjs` → `hits.jsonl`(sense별 문맥), `search.log`. FTS trigram + short bigram postings + LIKE 사다리, 표제어 우선 probe, 문서당 ≤2, sense당 ≤40.
2. **1차 판정** `extract.py` → `analysis.json`. 문맥 `V/A/R`, sense status, 자동 `V` 판정 수(`ctx_count`), 최초 판독 16문맥, 형태소 보조 토큰.
3. **부족 문맥 재검색** `retry.mjs` → 문맥이 4개 미만인 sense에 한정한 추가 검색. 추가 수와 총계를 기록한다.
4. **digest 생성** — 1–8 문맥(`batch*.txt`)과 9–16 확장(`x_batch*.txt`). gloss·번호·원문만 포함하며 로컬 전용.
5. **수동 2회 판독/판정** → `passb/{s1,x1,s2,x2}_batch*.jsonl` (`{sense_id,status,cands:[[candidate,lens],...]}`).
6. **조립** `assemble.mjs` → V4–V9 union, 귀속 코드, 형식 제외 ledger, `final_raw.json`, `attribution.json`, `dropped.json`.
7. **출력** `emit.mjs` → Canonical 순서의 Candidate JSONL.
8. **검증** `validate.mjs`가 저장소의 `validateCandidateBatch`를 import해 `batch=01`로 검사(실험 경로이므로 CLI의 정식 경로 제약 대신 export 함수 사용).

## 8. 로컬 ledger 형식

원문 locator가 포함되므로 **로컬 전용**이다.

```json
{"sense_id":"w00000-s1","status":"V","sweeps":[["s1",[["c1",3],["c2",1]]],["s2",[["c2",5],["c3",2]]]],"extended":[["x1",[["c4",2]]]],"prior":[["이전 후보","RECOVERED"],["문장형 후보","FORM_EXCLUDED"]],"form":["old 표현","FORM_EXTRACTED","new 후보"]}
```

- `sweeps`/`extended`: sweep별 `[후보, lens]` 목록
- `prior`: V4–V9 pair별 귀속 코드
- `form`: 형식 제외/추출 기록. 추출은 old→new pair 단위

## 9. 한계

- 016/01 calibration은 이미 결과를 본 비블라인드 배치다.
- 검색 자료는 문학 문어에 치우쳐 있다.
- `ZERO_HITS`는 해당 검색 경로의 미검출이지 말뭉치 전체 부재의 증명이 아니다.
- 자동 `V` 판정은 확보 문맥 전체에 적용되지만 실제 정독은 sense당 16문맥까지다. 두 수를 같은 모집단으로 해석하지 않는다.
- 로컬 결정 파일은 `sense × sweep × lens` 단위이며, 후보→개별 문맥 귀속은 보존하지 않는다. 따라서 문맥×관점 단위의 0건 셀 수는 재계산할 수 없고, 완료 증빙은 digest의 문맥 수와 판정 파일의 sweep·lens 기록으로 남는다.
- 형태소·검색 보조 도구와 자동 판정은 편집 판단을 대체하지 않는다. 최종 후보의 작가 유용성·정확성은 독립 평가가 필요하다.

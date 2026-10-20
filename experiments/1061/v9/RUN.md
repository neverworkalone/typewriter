# D V9 RUN — 016/01 (500 records / 565 senses) · CALIBRATION

## 0. 실행 식별자

| 항목 | 값 |
| --- | --- |
| MODE | CALIBRATION (비블라인드 개발 코호트) |
| SHARD / BATCH | 016 / 01 |
| RUN_ID | d-v9-016-01 |
| 생산자(모델) | DeepSeek (D 문어 말뭉치 Stage-1) |
| 절차 | `experiments/1061/v9/D_PROCEDURE.md`, sha256 `32042de67ed571dcaa04837c343301a8f67d161874028fa8d9aba7a0c9be46f6` |
| 시작 HEAD | `2af4d21a8775659b8364156b0129615de9d5218d` (origin/master) |
| Canonical | `data/canonical/stdict-0016.jsonl` rows 1–500, sha256 `04dedfe20c9af1639343001addac61c38f5901c64a8443a5c56a0862eb2c5524` |
| 코퍼스 인덱스 | `written-corpus-2025.sqlite` sha256 `4c357e83c6ee93a9a1e5e48a8cf53d7dec32c9387aae9f5a1192ce3484e5848b` |
| bigram sidecar | `written-corpus-2025.short-postings.sqlite` sha256 `9262406ae3d4ec36f3bd7a18df646245bb525b3140e671d9313466224cb059ac` |
| 출력 | `experiments/1061/v9/016_01_d_deepseek.jsonl` (sha256 `ab99f53601db79e5d75c0c290545c055f93f1b6cd54732760cf72e538cb4d183`) |
| 형태소 분석 | khaiii v0.4 (macOS arm64), 로컬 경로 직접 로드 |

## 1. 검색 (PASS A)

- 표제어·`search_forms` 우선 probe 순서(기본형 → 활용형), FTS trigram + 2자 이하 bigram postings/LIKE 사다리, 문서당 ≤2문맥, sense당 ≤40문맥.
- **scanned** 500/500 records, **retrieved contexts** 9,651, **with hits** 334 records, **zero-hit records** 166, **zero-hit senses** 176, **retried senses** 169 (zero-hit/no-verified 재시도 사다리).
- sense status: **V 203 · NO_VERIFIED 186 · ZERO_HITS 176** (합 565).
- V 문맥 실제 판독 수: **3,520** (sense당 평균 17.3, ≥16 상한 도달 sense 다수).
- V7의 `zero_hits` 305 senses는 V9에서 **새 검색형·다른 인덱스·문맥 단위 재조회**로 재탐색했다. 결과: zero-hit sense는 176으로 줄었고(새로 실제 VERIFIED된 sense 포함), 남은 176은 재시도 후에도 실제 사용 증거 미발견, 검색 실패는 없었다.

## 2. 다섯 관점 1·2차 sweep (PASS B)

| 관점 | 1차 sweep (구현) | 2차 sweep (구현) |
| --- | --- | --- |
| 1 `coll` 어휘·공기 | 창 형태소 proximity 가중 상위 24토큰 | rank 25–96 + 바깥 창(220–420자) |
| 2 `act` 행동·역할 | 동일 | 동일 |
| 3 `scene` 상황·장면 | 동일 | 동일 |
| 4 `cause` 원인·결과 | 동일 | 동일 |
| 5 `assoc` 대비·감각 | 동일 | 동일 |

- **1차**: 203 V senses, 창 형태소 상위 24토큰 총 **4,352**개를 sense별 리뷰 digest로 제시·검토.
- **2차**: 165 senses에서 **2,114**개 신규 토큰을 리뷰 digest로 제시·검토(rank 25–96 + 바깥 창에서 파생한 distinct 9,059개 중 상위 ≤14/sense). 1차 목록 재기술이 아니라 새 결합·행동·상황·인과·대비를 찾는 순회.
- **2차 신규 채택**: **101 단어 / 43 senses** (`adds_second.json`). 인위적 할당량은 두지 않았고, 바깥 창 토큰은 노이즈 비율이 높아 채택률이 낮다.
- **1차 신규 채택**: **544 단어** (`decisions/part00..05.json`의 `add`). 다섯 관점은 sense 수준에서 함께 적용했고, 관점별 신규/재방문 계수는 위 표처럼 1차 전체 토큰과 2차 신규 토큰으로 기록한다.

## 3. 이전 버전 회복 (PASS C)

- V8 후보 = `prior_words` **394**개(다어절 953개는 `prior_phrases`), V4–V7 전용 단어 = `prior_old` **88**개.
- V8을 기준으로 `ok` 판정한 V sense에서 **V8 단어 380개 RETAINED**, V8이 버린 V4–V7 전용 단어 중 **58개 RECOVERED**(형태 적격·오결속 아님), **11개 하드 오류 제외**(예: 격변→`상징`, 격분→`수간호사`, 격분하다→`난공불락`, 결합→`반지성`).
- ok:false/미검증 sense에서 V8 단어 8개·V4–V7 전용 단어 19개가 출발 sense 오결속/미검증으로 제외(`SOURCE_UNVERIFIED`).
- **FORM_EXCLUDED**: 이전 후보 중 다어절(문장/구) **953**개 + 조각(fragment) **102**개 = **1,055**개 문자열을 그대로는 채택하지 않았다.
- **FORM_EXTRACTED**: 이전 다어절 후보가 있던 V sense 중 **121 senses**에서 별도 단어를 새로 추출·채택(서술형 문장을 후보로 되살리지 않고, 같은 VERIFIED 문맥에서 단어를 뽑았다). 무리한 변형은 하지 않았다.
- 그 밖의 형식 제외: 표제어 띄어쓰기 변형 **1**개(`격 변화`→`격변화`), 비어휘 숫자/수량 표기 **5**개(`120근`, `1표`, `3중`, `20도`, `1960년대`), 복수 파생 조각 **1**개(`결의론자들`).

## 4. 출력 집계 (PASS D/E)

- **500 records / 565 senses**, Candidate v1 스키마(`record_id`, `senses[].sense_id`, `senses[].candidates`만). 순서·ID 보존.
- 후보가 있는 sense **152**, 빈 sense **413**.
- 최종 후보 **1,060**개(고유 문자열 972; sense 간 중복 포함).
  - 단어: **1,060**
  - 응축된 다어절 구: **0**
  - 관용·고정 표현(단일 토큰 어휘로 보존, 예: `사생결단`, `부국강병`, `겸사겸사`, `일촉즉발`): 다수(별도 상한 없음)
  - 서술형 제외: §3의 FORM_EXCLUDED 1,055
  - 서술→단어 추출: §3의 FORM_EXTRACTED 121 senses
- 표제어가 포함된 복합어 후보 **43**개는 실제 sense 기여가 있는 어휘로 판단해 유지(`건축→건축가`형). routine phrase는 넣지 않았다.
- 같은 sense 내 정규화 중복 0, 표제어 exact/괄호 전용 변형 0, trimmed nonempty 위반 0.
- 검증: repo의 `validateCandidateBatch`(batch=01) 결과 **500 records / 565 senses / 1,060 candidates / 413 empty senses / 0 source-lemma candidates**.

## 5. 전수 문자열 형식 검사 (PASS D, 필수)

- 최종 후보 **1,060개 문자열을 그룹 리뷰 목록으로 전부 읽었다**(sense별 gloss와 함께). 2차 신규 101개는 2차 digest에서 별도 검토했다.
- 기계적 스캔 결과: 다어절 후보 0, 문장부호 포함 0, clause 연결 어미 종결 0, 의사 명사화(…기술/장면/사건/절차 등) 0건(단, `장면`·`불법행위`·`병행사건`·`절차`는 독립 명사로 정상).
- **`final_sentence_or_event_description_count = 0`**
- 위반 1건(`결의론자들` 복수 조각, 숫자 표기 5건, 표제어 띄어쓰기 변형 1건)은 후보 문자열 형식 단계에서 수정·제거했고, 서술형 제거 건수는 §3과 같다.

## 6. 산출물

- `experiments/1061/v9/D_PROCEDURE.md`
- `experiments/1061/v9/016_01_d_deepseek.jsonl`
- `experiments/1061/v9/RUN.md`

원문·발췌·검색 로그·ledger·SQLite·원문 포함 상세 근거는 Git/PR에 넣지 않았다(로컬 캐시 전용).

## 7. 한계 / 미완료

- 016/01은 **비블라인드 calibration** 배치다. FREEZE·BLIND·대량 생산 준비 완료를 자체 선언하지 않는다.
- 후보 수 **1,060**은 V8의 1,346보다 적다. V8의 다어절/서술형을 전부 배제하고 단어를 우선한 결과이며, **후보 수는 성공 기준이 아니다.**
- 검색 자료는 문학 문어에 치우쳐 있다. `ZERO_HITS` 176 senses는 해당 검색 경로의 미검출이지 말뭉치 전체 부재의 증명이 아니다.
- 2차 sweep의 바깥 창 토큰은 노이즈 비율이 높아, recall 확대 기여가 제한적이었다.
- 단어 후보의 약한 의미 관계·작가 유용성·Tier는 **Stage 2/독립 평가**의 몫이다. 이 문서의 수치는 구조·형식 검증이며 의미 품질 인증이 아니다.

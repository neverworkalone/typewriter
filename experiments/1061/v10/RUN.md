# D V10 RUN — shard 016 / batch 01

Issue #1106 · CALIBRATION · Stage 1(D) · 2026-10-20

## 1. 실행 metadata

| 항목 | 값 |
| --- | --- |
| MODE | `CALIBRATION` |
| SHARD / BATCH | `016` / `01` |
| RUN_ID | `d-v10-016-01` |
| 모델 / 제공자 | DeepSeek V4.1 Flash / `opencode-go` |
| 생산자 | 단일 D 생산자 세션. 다른 모델·CLI·subagent·리뷰어를 호출하지 않음. |
| 절차 SHA-256 | `a5ae7c37ddac1f895244fb75c301564bc9b649ec16eb94b3941fc3bbf974b2ce` (`D_PROCEDURE.md`) |
| Canonical SHA-256 | `04dedfe20c9af1639343001addac61c38f5901c64a8443a5c56a0862eb2c5524` (`data/canonical/stdict-0016.jsonl`) |
| 말뭉치 index SHA-256 | `4c357e83c6ee93a9a1e5e48a8cf53d7dec32c9387aae9f5a1192ce3484e5848b` (`written-corpus-2025.sqlite`) |
| sidecar SHA-256 | `9262406ae3d4ec36f3bd7a18df646245bb525b3140e671d9313466224cb059ac` (short bigram postings) |
| 실행 시작 HEAD | `origin/master` `2af4d21a8775659b8364156b0129615de9d5218d` |
| PR base HEAD | `origin/master` `234fc1f00a1714d00275fa2bc095377a326ba1c7` (Canonical SHA 동일) |
| 산출물 | `D_PROCEDURE.md`, `016_01_d_deepseek.jsonl`, `RUN.md` |

검색은 같은 Canonical SHA·같은 말뭉치 digest의 V9 deterministic snapshot을 재사용했다. snapshot의 sense별 문맥을 재확인하고, 문맥이 4개 미만인 sense만 `retry.mjs`로 추가 검색했다(9,651 → 9,654 문맥, +3). 원문·locator·검색 로그·digest는 로컬에만 있으며 Git에 넣지 않았다.

## 2. PASS A — 검색과 source-sense 판정

| 지표 | 값 |
| --- | --- |
| records / senses | 500 / 565 |
| 검색 문맥 (`search_contexts`) | 9,654 |
| 문맥이 있는 sense | 334 |
| `ZERO_HITS` | 176 |
| `NO_VERIFIED` | 186 |
| `V` sense (분석 단계) | 203 |
| 자동 `V` 판정 수 (`v_verdicts_all_retrieved`) | 3,521 |
| 최초 정독 고유 문맥 (`first_inspected_unique`, cap 16) | 1,948 |
| 1–8 구간 / 9–16 확장 구간 | 1,149 / 799 |
| 9문맥 이상 sense / 16문맥 sense / 1문맥 sense | 114 / 92 / 31 |
| 1–8에서만 `V` / 9–16에서만 `V` | 3 / 4 |

- sense 판정 합계 = 565 (`ZERO_HITS` 176 + `NO_VERIFIED` 186 + `V` 203).
- `v_verdicts_all_retrieved`는 확보 문맥 전체(≤40/sense)에 대한 자동 sense-match 판정 수다. 실제 최초 정독은 sense당 16문맥으로 제한했으므로 `min(판정 수, 16)`의 합 1,948과 다른 모집단이다(§7-A).
- 최초 정독은 1–4 → 5–8 → 9–12 → 13–16 순으로 확대했고, 16 상한은 재판독 수와 합산하지 않았다.

## 3. PASS B — 5관점 × 독립 2회 전수 판독

| 회차 | 읽은 고유 문맥 | 5관점 셀 | raw 후보 등장 | V sense / NV sense |
| --- | --- | --- | --- | --- |
| sweep 1 (1–8) | 1,149 | 5,745 | 1,168 | 126 / 77 |
| sweep 1 확장 (9–16) | 799 | 3,995 | 334 | 63 / 51 |
| sweep 2 (1–8) | 1,149 | 5,745 | 1,031 | 126 / 77 |
| sweep 2 확장 (9–16) | 799 | 3,995 | 247 | 63 / 51 |
| **합계** | **1,948 × 2회 = 3,896** | **19,480** | **2,780** | — |

- 5관점 완료 셀 = 1,948문맥 × 5관점 × 2회 = **19,480**. 실제로 읽지 않은 셀은 없다. 다만 후보→개별 문맥 귀속은 로컬 결정 파일에 보존하지 않아 문맥×관점 0건 셀 수는 재계산하지 못한다(§9).
- 모든 `V` sense×회차 셀은 최소 1개 후보를 냈다(0후보 `V` 셀 0).
- 관점별 raw 등장(1차/2차, 합계):

| lens | sweep 1 | sweep 2 | 합계 |
| --- | --- | --- | --- |
| coll | 571 | 326 | 897 |
| act | 208 | 411 | 619 |
| scene | 458 | 434 | 892 |
| cause | 135 | 70 | 205 |
| assoc | 130 | 37 | 167 |

sweep 2의 `assoc`가 0건인 것은 실제 판독 결과다(0건 할당 없음). 2차에서 관점 사용이 `act`·`scene`에 몰린 점은 §9의 한계로 남긴다.

- 고유 `sense_id + candidate` 쌍: sweep 1 **1,411**, sweep 2 **1,234**, 교집합 **85**, sweep 2 신규 **1,149**, union **2,560**.
- 2차 신규 1,149쌍은 1차 후보의 재정렬이 아니라 원문 재판독에서 나온 별도 후보다. 1·2차 모두 `V`인 sense는 130개이며, 2차만으로 활성화된 sense는 없다.
- 최종 sense 내 정확 중복만 제거했다. sweep 간 중복 85쌍은 union에서 한 번만 센다.

## 4. PASS C — V4–V9 lineage

### 4.1 입력 모수

| 버전 | 후보 row | 고유 pair | 단어 | 다어절 |
| --- | --- | --- | --- | --- |
| V4 | 240 | 240 | 177 | 63 |
| V5 | 413 | 413 | 292 | 121 |
| V6 | 668 | 668 | 426 | 242 |
| V7 | 853 | 853 | 419 | 434 |
| V8 | 1,346 | 1,346 | 478 | 868 |
| V9 | 1,060 | 1,060 | 1,060 | 0 |
| **row 합계** | **4,580** | — | — | — |
| **V4–V9 union** | — | **2,153** | **1,200** | **953** |

- V4–V8 union = 1,537 pair(584 단어 + 953 다어절). V4–V7에만 있던 pair = 191(106 단어 + 85 다어절).
- V9에만 있던 단어 = 616. V9 final 1,060 중 V8과 겹치는 것은 386, 나머지 674는 V4–V7 단어 88 + V9 sweep 신규 586이다.
- V9가 보고 시점에 분류기로 탈락시킨 102개 형태 중 V10 귀속: `RECOVERED` 45, `RETAINED` 21(이번 sweep에서 다시 발견), `SOURCE_UNVERIFIED` 26, `TECHNICAL_EXCLUDED` 7, `FORM_EXCLUDED` 2, `SOURCE_BINDING` 1. 분류기 탈락 102개 중 66개가 실제로는 적격 단어였다.

### 4.2 상호 배타 귀속 (2,153 pair)

| 코드 | 단어 | 다어절 | 합계 |
| --- | --- | --- | --- |
| `RETAINED` | 513 | 1 | 514 |
| `RECOVERED` | 496 | 4 | 500 |
| `SOURCE_UNVERIFIED` | 160 | 248 | 408 |
| `FORM_EXCLUDED` | 5 | 686 | 691 |
| `TECHNICAL_EXCLUDED` | 13 | 0 | 13 |
| `EXACT_DUPLICATE` | 0 | 14 | 14 |
| `SOURCE_BINDING` | 13 | 0 | 13 |
| **합계** | **1,200** | **953** | **2,153** |

- `RECOVERED` 500개 중 다어절 4개: `해 질 무렵`, `프랑스 혁명`, `미국 독립 전쟁`, `이성의 시대`. 각각 응축된 시간 심상·정의적 역사 사건명·시대 명칭으로 개별 심사했다.
- `EXACT_DUPLICATE` 14개는 공통 normalizer에서 기존 후보와 같은 띄어쓰기 변형이다(예: `국권 피탈` → `국권피탈`, `스콜라 철학` → `스콜라철학`, `한일 병합` → `한일병합`).
- `FORM_EXCLUDED` 다어절 686개는 953개 다어절을 개별 심사한 결과다. 서술형·절차·기계적 수식어+명사·뜻풀이 반복은 제외하고, 위 4개와 `RETAINED` 1개, `EXACT_DUPLICATE` 14개만 통과시켰다.
- attribution의 `TECHNICAL_EXCLUDED` 13개와 `SOURCE_BINDING` 13개는 §5의 PASS D 제외 항목과 교차 확인했다. 이전 pair와 겹치는 제외는 attribution에서 한 번만 계산하고, PASS B에만 있던 제외는 attribution 모수(2,153)에 들어가지 않는다.
- `FORM_EXTRACTED` = **0 old→new pair, 0 sense**. V10은 이전 다어절 표현에서 별도 후보를 추출하지 않았고, PASS C에서 회복한 단어는 이전 버전이 이미 독립 단어로 낸 후보다. 추출이 있었다면 old 하나에서 new 여럿이 나올 때 pair를 각각 세도록 절차에 정의했다.

## 5. PASS D — 형식 검사와 전수 문자열 검토

- PASS B 문자열 hard exclusion **32건**: `SOURCE_BINDING` 21(단일 서사 배경 인명·지명·선박명), `TECHNICAL_EXCLUDED` 8(표제어 띄어쓰기 변형·조사 결합 파편·수량·연대), `FORM_EXCLUDED` 3(뜻풀이 축자 반복, 상투 결합, 기계적 수식어+명사).
- PASS C 단어 개별 제외 **27건**: `TECHNICAL_EXCLUDED` 12(수량·연대 5, 문장부호 1, 표제어 괄호 주기 6), `FORM_EXCLUDED` 5(비유 부사구 파편 1, 표제어 기계 파생·활용 3, 표제어+일반 명사 결합 1), `SOURCE_BINDING` 10(단일 서사 배경 고유명사 6, V10 문맥·뜻풀이에 결속 경로가 없는 교차 sense 단어 4).
- V9가 하드 오결속으로 막았던 항목도 V10 문맥으로 개별 재판정했다. `수간호사`·`상징`·`반지성`·`설문지`는 해당 sense의 16문맥과 뜻풀이 어디에도 결속 경로가 없어 제외했고, `발버둥`은 경선 문맥에 실제로 등장해 보존했으며, `입김`은 계획에 대한 정치적 영향력이라는 설명 가능한 비유 관계로 보존했다. V9 blocklist를 그대로 적용하지 않았다.
- 표제어를 포함한 합성어·파생어 44개는 일괄 배제하지 않고 개별 판정했다. `경술국치`, `경인고속도로`, `종합격투기`, `계몽사상가`처럼 별개 어휘인 것은 보존하고, 표제어의 기계적 활용·파생과 일반 명사 결합은 제외했다.
- 숫자가 포함된 어휘는 `코로나19`, `3D 프린터`, `5개년계획`처럼 고유 명칭·제도명의 일부일 때만 보존했고, 순수 수량·연대 표기는 제외했다.
- **최종 3,028개 문자열을 전수로 읽었다.** 문장·서술형 절·사건/과정 설명·위장 명사구는 **0건**이다. 자동 validator 통과만으로 판정하지 않았다.
- `final_sentence_or_event_description_count = 0`.

## 6. 최종 산출

| 지표 | 값 |
| --- | --- |
| records / senses | 500 / 565 |
| nonempty sense | 130 |
| empty sense | 435 |
| 최종 후보 | **3,028** |
| PASS B 신규 | 2,528 (raw 2,560 − hard exclusion 32) |
| PASS C 회복 | 500 |
| 공백 없는 단어 | 3,019 |
| 공백 포함 표현 | 9 |
| 관용구로 분류한 후보 | 0 |

공백 포함 9개는 서로 겹치지 않게 분류하면 다음과 같다.

- 응축 이미지·시대명 4: `해 질 무렵`, `이성의 시대`, `빅토리아 시대`, `재즈 시대`
- 역사 사건명 2: `프랑스 혁명`, `미국 독립 전쟁`
- 다어절 고유명·제도·고정 표현 3: `후쿠자와 유키치`, `3D 프린터`, `국권 침탈`

sense별 후보 수(비어 있지 않은 130개): 최소 5, 25% 18, 중앙값 22, 75% 29, 최대 42.

최종 sense 상태: `V` 130 / `NO_VERIFIED` 259(최초 미확인 186 + 분석 단계 `V`였으나 sweep 판독에서 확인되지 않은 73) / `ZERO_HITS` 176. 비어 있지 않은 모든 sense에 직접 `V` 문맥이 있다. AMBIGUOUS-only 출력은 0개다.

## 7. V9 수치 불일치 해소

### A. `V 실제 판독 문맥 3,520` 대 `203 × 16 = 3,248`

두 수는 서로 다른 모집단이다.

- V9의 3,520은 203개 `V` sense의 `ctx_count` 합이다. `ctx_count`는 **확보한 전체 문맥(≤40/sense)에 대한 자동 `V` 판정 수**이며, sense당 16을 넘을 수 있다.
- 실제로 저장·정독한 `V` 고유 문맥은 sense당 16으로 절단한 값이며 V9에서 **1,947**이다.
- 3,248은 “모든 sense가 16개 이상의 `V` 문맥을 가졌다”는 잘못된 균일 상한 가정이다. V9 실제 분포는 1문맥 sense 31개부터 40문맥 sense까지이고, 16문맥을 넘는 sense가 89개였다.
- V10도 같은 정의를 적용해 **3,521 / 1,948 / 9,654**을 얻었다. 3,248에 맞추기 위해 판정 수나 상한을 사후 조정하지 않았다.

### B. `394 단어 + 953 다어절` 대 `V8 전체 1,346`

- V8 = **478 단어 + 868 다어절 = 1,346** 고유 pair다.
- 394 = 478 − **84**. 84는 V9가 보고 시점에 khaiii 분류기로 탈락시킨 V8 단어다(fragment 74 + inflected 10). 나머지 18개 분류기 탈락은 V4–V7 단어다(합 102).
- 953 = **V4–V8 다어절 union**(V8 868 + V4–V7에만 있던 85). V8 다어절 수가 아니다.
- 따라서 394 + 953 = 1,347은 “필터 후 V8 단어” + “다버전 다어절 union”의 우연한 합이며, 1,346의 분할이 아니다. 1,346과 정합하는 식은 `394 + 868 = 1,262 = 1,346 − 84`다.
- V9 final 1,060은 전부 단어이며, V8과 겹치는 386 + V4–V7 단어 88 + V9 sweep 신규 586으로 구성된다. 953개 다어절은 V9 final에 들어가지 않았다.

### C. `FORM_EXTRACTED 121 senses`

- 121은 **sense 수**였고 old→new **pair 수**가 아니었다. 두 단위를 같은 표에 더하면 안 된다.
- V10은 `FORM_EXTRACTED` 0 pair / 0 sense다. 이전 다어절에서 별도 후보를 추출한 사례가 없기 때문이며, 추출이 있었다면 old 하나에서 new 여럿이 나올 때 pair를 각각 세도록 절차에 정의했다.

## 8. 검증

실행한 명령과 결과(로컬 실험 경로이므로 CLI의 정식 `data/relation-candidates/` 경로 제약 대신 저장소 export 함수를 사용):

```text
$ node validate.mjs experiments/1061/v10/016_01_d_deepseek.jsonl
validateCandidateBatch: {"recordCount":500,"senseCount":565,"candidateCount":3028,"emptySenseCount":435}
source-lemma projections (schema rule): 0
```

- `validateCandidateBatch`(저장소 `scripts/relation/candidate-contract.mjs`): 500 records / 565 senses / 3,028 candidates / 435 empty senses 통과.
- source lemma exact·괄호 변형 0, sense 내 정규화 중복 0, ID·순서·스키마 위반 0.
- 최종 JSONL에서 nonempty 130 + empty 435 = 565, 단어 3,019 + 다어절 9 = 3,028를 다시 계산해 일치를 확인했다.
- V4–V9 귀속 합계 2,153 = 단어 1,200 + 다어절 953을 `attribution.json`에서 재계산해 일치를 확인했다.
- Canonical·정식 `data/relation-candidates/`·V4–V9 파일은 수정하지 않았다. PR 변경 경로는 `experiments/1061/v10/` 3개 파일뿐이다.

## 9. 한계와 미완료

- **문맥×관점 0건 셀 비재계산:** 로컬 결정 파일은 `sense × sweep × lens` 단위이며 후보→개별 문맥 귀속을 저장하지 않았다. 1,948문맥을 두 번 읽었다는 증빙은 digest의 문맥 수와 판정 파일의 sweep·lens 기록으로 남지만, “어느 문맥의 어느 관점이 0건이었는가”는 재구성할 수 없다. 완료를 가장하지 않기 위해 이 항목을 미완료로 명시한다.
- **비블라인드 calibration:** 016/01은 이전 버전의 결과를 본 배치다.
- **문학 문어 편중:** 승인 말뭉치가 문학 텍스트에 치우쳐 있다.
- **`ZERO_HITS`의 의미:** 해당 검색 경로의 미검출이지 말뭉치 전체 부재의 증명이 아니다.
- **자동 판정과 정독의 차이:** 자동 `V` 판정은 확보 문맥 전체에 적용되지만 실제 정독은 sense당 16문맥까지다. 두 수를 같은 모집단으로 해석하지 않았다.
- **2차 관점 분포:** sweep 2에서 `assoc` 0건, `act`·`scene` 편중이 나타났다. 2차 판독이 1차의 관점 분포를 재현하지 못한 점은 V11에서 점검할 일반 실패 유형이다.
- **PASS C의 의미 품질:** 회복 후보 500개(단어 496 + 다어절 4)는 형식·source 결속만 확인했고, 관계 강도·동형이의 오결속 가능성은 Stage 2 검토 부담으로 남는다.
- **독립 평가 없음:** 후보의 작가 유용성·A/B 대비 +1·Stage 2 부담은 오너/ChatGPT의 독립 평가 대상이다. 이 RUN은 FREEZE나 생산 준비 완료를 선언하지 않는다.

## 10. 제출

- PR은 `no-review` 라벨, `Refs #1106`을 사용한다(`Closes` 금지). 생산자는 자가 리뷰·승인·머지를 하지 않는다.
- 변경 경로는 `experiments/1061/v10/D_PROCEDURE.md`, `experiments/1061/v10/016_01_d_deepseek.jsonl`, `experiments/1061/v10/RUN.md` 3개뿐이다.
- 원문·locator·SQLite·evidence ledger·검색 로그는 포함하지 않았다.

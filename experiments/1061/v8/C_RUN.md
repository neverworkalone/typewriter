# C V8 RUN — Shard 013 Batch 01 (calibration)

## 0. 식별과 동결

| 항목 | 값 |
| --- | --- |
| MODE | CALIBRATION (표준 생산 승인 전) |
| Method / Shard / Batch | C / 013 / 01 |
| Model | DeepSeek (opencode-go, `deepseek-v4.1-flash`) |
| RUN ID | `c-v8-013-01-deepseek-20261019` |
| Output | `experiments/1061/v8/013_01_c_deepseek.jsonl` |
| Candidate file SHA-256 | `0bd3046f55a93b06d17c1ef3c5e365d9e69fb65669933c4c71fa53940ce0c436` |
| Procedure | `experiments/1061/v8/C_PROCEDURE.md` SHA-256 `42fd8d0b49e562943f46eaeed87ce115e89558d1e2f18d3eef9e3763eadc38ac` |
| Git base HEAD | `796c2bcfc9aab3d5bea8d1547f73a1365ade3d48` (`master`) |
| Canonical | `data/canonical/stdict-0013.jsonl` SHA-256 `d7d1534437da8db369c0d65eade1e63e45d73e96892aea81a4a420020114192e`, rows 1–500, 500 records / 560 senses |
| Literature index | `~/.cache/typewriter/reference/literature/indexes/public-domain-literature.sqlite` SHA-256 `07770a5f5db772b66980fe484c30c7448771f8a4629f64abd6072023f1dd99f7` (read-only, FTS5 trigram ≥3자 + 2자 `instr()` 스캔) |
| 실행 | 2026-10-19, 단일 DeepSeek run. 원문·발췌·SQLite·locator·검색 로그는 Git에 넣지 않음 |

이 배치는 개발 데이터(013/01, rows 1–500)로 이미 결과를 열람한 calibration이다. V8은
블라인드 재현 성공을 주장하지 않는다.

## 1. 규모

- Canonical: **500 records / 560 senses**. 출력도 500레코드/560센스를 그대로 보존.
- 검색: probe 9,117 search unit이 후보 hit. 3자 이상 FTS5 trigram, 2자 `instr()` 스캔,
  실제 문자열 포함 + 단어 시작 경계 재확인. 활용형·불규칙 활용 포함.
- 상태: `HITS 179` senses / `ZERO_HITS 377` / `UNSEARCHABLE 4`.
  - UNSEARCHABLE 4: `건(w14505-s1)`, `걸(w14694-s1)`, `걸(w14694-s2)`, `검(w14721-s1)`
    — 1자 표제어로 신뢰할 경계 검증 경로가 없어 탐색하지 않음(용례 없음으로 세지 않음).
- 문맥 창: 총 **1,399 contexts** 제공·판독. 창 전이(창 수 기준) 1창 83 / 2창 20 /
  3창 17 / 4창(16문맥) 59 senses. 16문맥 상한에 도달한 senses 59.
- 결속 판정: **VERIFIED 369 / REJECTED 993 / AMBIGUOUS 37** (합 1,399).
  REJECTED 사유는 대부분 동음이의어·다른 품사·다른 뜻(예: `거족적`의 전민족적 뜻,
  `검사국`의 일제 강점기 뜻), 부분 문자열 오탐.
- 2차 활용형 보강(관형사형·어미): VERIFIED 0인 용언·형용사 46 senses에 적용, 15 senses에
  hit. 그중 실제 출발 sense 용례를 새로 확인한 senses 6:
  `거세차다(w14567-s1) 1문맥`, `게시하다(w14591-s1) 2문맥`, `거세되다(w14706-s1) 6문맥`,
  `검누르다(w14993-s1) 6문맥`, `건너지르다(w15103-s1) 2문맥`, `건너지르다(w15103-s2) 2문맥`.
  나머지는 다른 sense·다른 단어(`걷다`+`지` 등)로 REJECTED.

## 2. PASS B — 7관점 2회 sweep

- **388 VERIFIED 문맥**(1차 369 + 2차 활용형 보강으로 새로 확인한 6 senses의 19문맥)에 7관점
  (Image/Action/Emotion/Sensation/Scene/Causality/Metaphor·Contrast)을 적용.
- **1차 sweep 236, 2차 독립 sweep 37 = 신규 273 후보.** 1차 결과를 답안으로 두지 않고
  두 번째 sweep에서 정서·장면·인과·감각 관점을 다시 훑어 누락을 추가했다.
- 신규 후보 관점 분포: image 71, action 67, association 50, sensation 22,
  scene 15, situation 15, metaphor 13, emotion 11, causality 9.
- 신규 후보 도출: 문맥 표현(exact) 261, 문맥 유도(inferred) 12.
- 실제 문맥에서 관찰한 표현을 그대로 살린 후보와, 그 장면에서 자연스럽게 떠오르는
  선택지를 함께 남겼다. `source + 동사/수식어`로 개수를 채운 기계적 생성은 하지 않았고,
  `건설적`·`건너오다`처럼 원문 결합이 반복되는 항목은 대표적인 것만 남겼다.
- Stage 2의 KEEP/DROP/Tier는 만들지 않았다.

## 3. PASS C — 이전 버전 회복

- 자기 생산물 V5/V6/V7 후보 문자열 합집합 248개(97 senses)를 대상으로 `sense_id +
  정규화 candidate` 기준으로 복원.
- **V6→V7에서 탈락한 36개 중 33개를 V8에서 복원**(RECOVERED/RETAINED). 복원하지 않은
  3개는 PASS D 기술 오류다.
- V7 REWORK 5건은 원문자와 대체 문자열을 모두 보존(어느 쪽이 나은지는 Stage 2 판단).
  V7이 편집상 이유로 버린 CO_OCCURRENCE/SAME_RELATION/LACKS_ROLE/TRIVIAL 유형은
  문맥 기반 의미 연결이 있으면 되살렸다.
- V5-only 후보 50개 중 27개 유지. 버린 23개는 `STILL_UNVERIFIED_SOURCE`(해당 sense의
  실제 용례에서 확인 불가)로 로컬 ledger에만 기록했고, 편집상 품질 DROP이 아니다.
- lineage 합계(로컬 ledger): RECOVERED 222(v5 42 / v6 158 / v7 22),
  NEW 273, EXACT_DUPLICATE 204, STILL_UNVERIFIED_SOURCE 23, TECHNICAL_EXCLUDED 3.

## 4. PASS D — 최소 hygiene / 기술적 제외

- 기술 제외 3건(전부 이전 버전 후보): `겉목(w14534-s1) 능청스럽다`(→건목01 관용적
  쓰임과 결속 불확실), `걸구(w14696-s1) 동숙을 청하다`(재물 구걸이 아닌 혼인 청구 장면),
  `검도(w14843-s1) 기선을 제압하다`(검도 경기가 아닌 전술 일반).
- 그 외 약한 연상·느슨한 이미지·문맥이 좁은 개인적 표현·의미가 가까운 후보는 삭제하지
  않고 그대로 남겼다. V7의 Gate A–D식 가혹한 필터를 사용하지 않았다.

## 5. 최종 산출

- `013_01_c_deepseek.jsonl`: **500 records / 560 senses / 495 candidates /
  463 empty senses / 97 active senses**.
- 후보가 가장 많은 senses: `검은빛(w14521-s1) 22`, `검사하다(w14823-s1) 19`,
  `건넛산(w14860-s1) 14`, `건망증(w14951-s1) 13`, `걷히다(w14645-s1) 12`,
  `걸음걸이(w14864-s1) 12`, `검사국(w15076-s1) 12`.
- 후보 문자열에 출발 lemma가 부분 포함된 비율 21%(96/495). 문맥에서 실제로 쓰인
  결합 표현(예: `검도 이단의 실력`, `검사국으로 넘어가다`)과 표제어 재제시를 구분하지
  않고 개수만으로 판단하지 않는다.
- Stage 1에 type/Tier/admission/target을 넣지 않았고, Candidate v1 계약을 통과했다.

## 6. 실행 완전성 검사

- Canonical 500레코드 순서·ID, record별 모든 sense, sense_id 일치 확인.
- 허용 필드(`record_id`, `senses[].sense_id`, `senses[].candidates`)만 사용, 후보는
  비어 있지 않은 trim 문자열, 같은 sense 내 정규화 정확 중복 0, 출발 lemma와 정확히
  같은 후보 0, 천 단위 쉼표 숫자 파편 0.
- 계약 검사: `scripts/relation/candidate-contract.mjs`의 `validateCandidateBatch`를
  직접 호출 → `{recordCount:500, senseCount:560, candidateCount:495, emptySenseCount:463}`.
  실험 경로(`experiments/1061/v8/`)에 두는 calibration 산출물이므로 파일명 경로 검사
  (`validateCandidatePaths`)는 적용하지 않았고, batch 검증(레코드·sense·중복·lemma·
  숫자 파편)은 그대로 통과했다. 이 파일은 정식 `data/relation-candidates/` 커서를
  갱신하지 않는다.
- 원문·발췌·SQLite·검색·evidence 로그는 로컬(`~/.cache/typewriter/c-v8-1109/`)에만 둔다.

## 7. 한계와 비용

- 문학 인덱스는 공개 도메인 문학(시/소설/수필)만 포함한다. 560 senses 중 377 senses는
  표제어·활용형이 코퍼스에 나타나지 않아 `ZERO_HITS`이며, 4 senses는 `UNSEARCHABLE`이다.
  이 배치의 후보는 97 active senses에 집중된다.
- 창 상한 16문맥. `>16` 단위가 있는 senses 61개는 16문맥만 검토했다(작품·작가·장르
  다양성 우선 선택). 16문맥 상한 밖의 추가 회수는 하지 않았다.
- 동음이의어·다른 품사는 자동 판별이 불가능해 문맥 수동 판정에 의존했다. REJECTED
  993건의 판정 근거는 로컬에만 남겼다.
- 2차 활용형 보강은 받침 ㄴ/ㄹ/ㅁ 관형사형과 일부 어미로 제한했다. 완전한 형태소
  분석이 아니므로 `ZERO_HITS`를 “이 말이 쓰이지 않았다”는 뜻으로 해석하지 않는다.
- 비용·시간: 로컬 SQLite 읽기 전용 검색 + 수동 판독. 다른 모델/CLI/서브에이전트는
  호출하지 않았다. 오너/ChatGPT 독립 평가 전 FREEZE·배치 생산을 시작하지 않는다.

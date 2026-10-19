# C V7 실행 기록 — 013/01 (500 records / 560 senses)

Issue #1061 / #1109. 이 문서는 관측값과 한계만 기록한다. 원문·발췌문·SQLite·
검색 로그는 넣지 않는다. 후보 문자열은 산출물이므로 예시로만 인용한다.

## 1. 환경과 입력

| 항목 | 값 |
|---|---|
| Run ID | `c-v7-013-01-20261019` |
| 모델 | DeepSeek V4.1 Flash (단일 생산자, 다른 모델·서브에이전트 호출 없음) |
| Branch / base | `opencode/issue-1109-c-v7` / `a32b058d` |
| Canonical | `data/canonical/stdict-0013.jsonl` rows 1–500 |
| Canonical SHA-256 | `d7d1534437da8db369c0d65eade1e63e45d73e96892aea81a4a420020114192e` |
| Records / senses | 500 / 560 (47 records 다의어, 최대 5 senses) |
| ID 범위 | `w14502` … `w15188` |
| 문학 인덱스 | 로컬 SQLite, read-only, SHA-256 `07770a5f5db772b66980fe484c30c7448771f8a4629f64abd6072023f1dd99f7` |
| 인덱스 규모 | 10,470 works / 864,774 units |
| 검색 계층 | FTS5 trigram(3자 이상) + `instr()` 스캔(2자) + 단어 시작 경계·포함 재확인 |
| C_PROCEDURE SHA-256 | `60bcac5db43442ffea2381ca3d7ac42fbe7cdb40cd600396ed6d3e63739d7abf` |
| 출력 | `experiments/1061/v7/013_01_c_deepseek.jsonl` |

읽지 않은 것: Codex C 013/01, 같은 배치의 다른 모델 A/B/C/D, 타 생산자 리뷰·
비교 결과, `data/relation-candidates/` 전체. 읽은 기존 산출물은 이 실험의 감사
대상인 **자신의 C V6 013/01 176개**와 그 로컬 evidence다.

## 2. PRE-FLIGHT와 파일럿

- 500 records / 560 senses를 Canonical 순서로 동결하고 sense별 상태를 만들었다.
- V6 로컬 evidence(검색 inventory·binding·pool·sweep·audit)를 읽기 전용 감사
  입력으로 등록했다. 자동 KEEP은 하지 않았다.
- 원본 순서 앞부분(1–25 records)을 파일럿으로 삼아 V7 Gate A~D의 판정 단위,
  `REWORK` 표기, ledger 수식, 7관점 방문 기록을 점검했다. 파일럿에서 확인한 공통
  실행 오류는 **판정 단위를 문자열이 아니라 `sense + context + role`로 고정**하고,
  `REWORK`를 문자열 변경/근거 보강으로 분리하는 것이었다. 본 실행 중에는 단어별
  규칙을 바꾸지 않았다.
- V6와 같은 canonical/index SHA를 확인한 뒤 검색 inventory를 동결했다. V7은
  검색 probe를 다시 실행해 상태를 재검증하고, 문맥 선택은 동일 SHA의 V6 inventory를
  재사용했다. 이는 새 문맥을 임의로 추가하지 않기 위한 결정이다.

## 3. PASS 1 — 검색 재실행과 문맥 inventory

V7은 V6의 `snapshot` probe로 560 sense의 검색을 다시 실행했다.

| 상태 | senses |
|---|---:|
| `HITS` | 179 |
| `ZERO_HITS` | 377 |
| `UNSEARCHABLE` (1자 표제어) | 4 |
| `SEARCH_FAILED` | 0 |
| **합계** | **560** |

- 재실행 원시 일치 10,992건, 경계 검증 단위 9,116건, 작품 단위 4,994건.
  V6 기록은 10,925 / 9,117 / 4,995였다. 차이는 probe/limit 계산 차이이며,
  6개 sense에서만 발생했다. 6개 모두 상태는 동일했고, 5개는 `ZERO_HITS`의
  경계 미통과 raw hit, 1개는 `HITS`의 raw/units/works 2 대 3 차이였다.
- 검색 형태별 sense 커버리지: 3자 이상 FTS trigram만 쓴 sense **351**,
  2자 `instr()`만 쓴 sense **182**, 두 형태를 함께 쓴 sense **23**, 신뢰할
  probe가 없어 `UNSEARCHABLE`인 sense **4**. probe 길이 분포는 2자 207개,
  3자 이상 536개다. 검색 도구 오류는 0건이다.
- sense별로 다양성 순위를 적용한 V6 문맥 inventory를 동결해 사용했다. 공급 총계
  **1,399개**, 실제 판독 **1,399개**(100%). V7은 그중 **369 VERIFIED 문맥을
  다시 읽고** 7관점을 재적용했다.
- 창별 공급 sense: `1–4` **179**, `5–8` **96**, `9–12` **76**, `13–16` **59**.
  창별 판독·판정은 V6 inventory와 동일하다.

| 창 | 판독 | VERIFIED | AMBIGUOUS | REJECTED |
|---|---:|---:|---:|---:|
| 1–4 | 553 | 178 | 17 | 358 |
| 5–8 | 346 | 87 | 8 | 251 |
| 9–12 | 270 | 55 | 3 | 212 |
| 13–16 | 230 | 49 | 9 | 172 |

- 공급 문맥 1,399개는 **480개 작품·77명 작가·3개 장르**(소설·수필·시)에 걸쳐
  있다. VERIFIED 369개는 **269개 작품·57명 작가·3개 장르**다.
- 문맥 가용 분포(sense별, 16 상한): 1개 35, 2개 23, 3개 12, 4개 13, 5개 7,
  6개 7, 7개 3, 8개 3, 9개 10, 11개 4, 12개 3, 13개 1, 14개 1, 15개 1, 16개 56.

## 4. PASS 2 — 판독과 sense binding

| 판정 | 건수 | 비율 |
|---|---:|---:|
| `VERIFIED` | 369 | 26.4% |
| `AMBIGUOUS` | 37 | 2.6% |
| `REJECTED` | 993 | 71.0% |
| **합계** | **1,399** | 100% |

- V7은 **369 VERIFIED 문맥 전부를 다시 읽고** Gate B(대조 sense)를 재적용했다.
- **1,030개 비VERIFIED 문맥(37 AMBIGUOUS + 993 REJECTED)은 V6의 binding 판정을
  배제 근거로 상속**했다. V7이 이 1,030개를 독립적으로 다시 읽었다고 주장하지
  않는다. 이는 이 실행의 명시적 한계다.
- 다만 `REJECTED` 993개 중 결정적 30문맥(33번째 간격 표본)을 다시 읽어 판정
  사유를 표본 검증했다. 표본에서는 다른 표제어·한자 독음·부분 문자열·다른 sense
  판정이 V6 기록과 일치했다. 이는 표본이며 993개 전체의 독립 재판독은 아니다.
- `REJECTED`의 대부분은 동음이의어·한자 독음·부분 문자열·다른 표제어였다.
  검색 성공이 sense 확인은 아니라는 V6의 결론을 유지한다.

## 5. PASS 3 — 7관점 재순회

- 369 VERIFIED 문맥 × 7관점 = **2,583 관점 방문**을 로컬 ledger에 기록했다.
- 최종 후보가 나온 `context × lens` pair는 **105개**다. 나머지는 `found: 0`으로
  기록했다.
- V6 pool 157개와 V6 2차 sweep 23개를 비교 풀로 쓰되 자동 KEEP하지 않았고,
  V7 재순회에서 **신규 17개**를 발굴했다. 신규 후보의 관점 분포:

| 관점 | 신규 |
|---|---:|
| action | 6 |
| image | 3 |
| metaphor/contrast | 3 |
| association | 2 |
| mood | 1 |
| causality | 1 |
| sensation | 1 |
| **합계** | **17** |

## 6. PASS 4 — Gate A~D와 감사

### 6.1 V6 최종 176개 전량 재감사

| 판정 | 건수 |
|---|---:|
| `KEEP` | 140 |
| `REWORK` | 5 |
| `DROP` | 31 |
| `UNCERTAIN` | 0 |
| **합계** | **176** |

- `REWORK` 5개는 모두 **기존 문자열을 더 나은 표현으로 바꾼 것**이다. 문자열을
  유지하고 근거만 보강한 `REWORK`는 0개다.
- `UNCERTAIN`을 최종 후보로 승격한 사례는 0개다.
- `DROP` 사유 분포:

| 사유 코드 | 건수 |
|---|---:|
| `CO_OCCURRENCE` | 13 |
| `SAME_RELATION` | 11 |
| `WRONG_SENSE` | 3 |
| `TRIVIAL_PARAPHRASE` | 2 |
| `FRAGMENT` | 2 |
| **합계** | **31** |

- `DROP`의 일반 유형:
  - **공출현**: 같은 문단의 장소·사물·인물이 출발 sense의 역할 없이 후보가 된
    경우. 배경 요소는 제거하고, 같은 문맥에서 출발어의 결과·정서·비유를 다시
    찾았다.
  - **동일 관계**: 한 sense 안에서 색 대비·공포 반응·검사 행위 등이 표현만 바꿔
    반복된 경우. 가장 독립적인 대표만 남겼다.
  - **다른 sense**: 교차 참조 표제어의 관용적 쓰임, 다른 대상의 乞求, 다른
    문맥의 전술 일반처럼 표면형만 같은 경우.
  - **정의 반복·관용구**: 정도를 강조하는 관용구가 새 이미지 없이 “심하다”를
    반복한 경우.
  - **파편**: 문장 중간이 잘려 독립 표현이 되지 못한 경우.
- **보존한 비유·장면**: 문맥에 결속된 간접 비유와 인과는 Gate A의 반증 보조
  질문을 통과하면 남겼다. 예: `건축공학으로도 풀지 못한 수수께끼`(REWORK),
  `건망증이 든 도회`, `피 흐르는 건설기`, `과부살이에 억세진 성격`(신규).

### 6.2 V7 신규 17개

| 판정 | 건수 |
|---|---:|
| `KEEP` | 17 |
| `DROP` | 0 |
| `UNCERTAIN` | 0 |

신규 후보는 모두 VERIFIED 문맥의 locator·역할·관계 경로를 가진다. V6에서 후보가
없던 sense 일부(성격·겉칠·겉모양·건백서·건들건들·검사대·게게·건실히)에서
재발굴했고, 일부는 기존 sense의 빈틈을 보완했다.

## 7. 최종 산출물과 장부 정합성

- Candidate v1: **500 records / 560 senses / 162 candidates / 473 empty senses**.
- 활성 sense **87개**, 활성 sense당 평균 **1.86개**.
- sense당 후보 수: 1개 51, 2개 20, 3개 4, 4개 6, 5개 4, 6개 1, 9개 1.
- 최종 후보의 관점 분포:

| 관점 | 건수 |
|---|---:|
| association | 39 |
| image | 38 |
| action | 28 |
| metaphor/contrast | 15 |
| mood | 9 |
| scene | 9 |
| sensation | 9 |
| contrast | 7 |
| causality | 4 |
| emotion | 4 |
| **합계** | **162** |

7관점 핵심 태그(image/action/emotion/sensation/scene/causality/metaphor)는
**107개**, 교차 태그(association/contrast/mood)는 **55개**다.

- 도출 방식: 원문 표현 19, 문맥 유도 143, 활용형 0.
- 동일 sense 내 중복 후보 0, source lemma와 정확히 같은 후보 0.
- `w14862-s2`와 `w14863-s1`은 Canonical에서 서로 direct 동의어인 별도 record다.
  두 sense에 같은 후보 3개가 남아 있다. 이는 같은 sense 내 중복이 아니며,
  Stage 2에서 병합 여부를 판단할 대상이다.
- pair 계보:

```
기존 176 = KEEP 140 + REWORK 5 + DROP 31 + UNCERTAIN 0
기존 유래 최종 = KEEP 140 + REWORK 문자열 5 = 145
신규 17 = KEEP 17
최종 = 145 + 17 = 162
중복 제거 = 0
source lemma exact = 0
UNCERTAIN 승격 = 0
```

## 8. 실행 시간과 비용

- 실행 시간은 시작 시점을 계측하지 않아 정확하지 않다. 로컬 파일 타임스탬프
  기준 **약 30–40분**이다.
- 판독 문맥 1,399개 중 VERIFIED 369개 재판독, 7관점 방문 2,583회, 감사 176+17건.
- 토큰 사용량은 실행 환경에서 노출되지 않아 산정하지 않았다.

## 9. 계약 검증

`validateCandidateBatch(canonicalRows, candidateRows, { batch: '01' })`:

```
recordCount=500, senseCount=560, candidateCount=162, emptySenseCount=473
```

구조 통과는 의미 정확성의 증명이 아니다. 아래 한계를 함께 본다.

## 10. 한계와 미완료·미검증

1. **독립 감사 없음.** 모든 판정은 생산자 자기 감사이며, 오너/ChatGPT의 별도
   평가를 대체하지 않는다.
2. **개발 배치.** 013/01은 V6 결과를 이미 본 calibration 배치다. V7을 블라인드
   성과로 주장하지 않는다.
3. **비VERIFIED 문맥 상속.** V7은 369 VERIFIED만 다시 읽었고, 1,030개
   AMBIGUOUS/REJECTED는 V6 판정을 배제 근거로 상속했다. 이 1,030개를 독립
   재판독한 실행이 아니다.
4. **문맥 상한 16.** V6에서 53개 sense가 `INSPECTED_16`으로 끝났다. V7은 새
   문맥을 추가하지 않았으므로, 그중 일부는 더 읽으면 추가 관계가 나올 수 있다.
5. **검색 형태의 한계.** 고어·한자 혼용·불규칙 활용·1자 표제어에서 probe가
   놓친 용례가 있을 수 있다. 4개 sense는 `UNSEARCHABLE`이다.
6. **검색 재실행 차이.** 6개 sense에서 raw/units/works 계산이 V6와 달랐다.
   상태 분류는 모두 동일했지만, 검색 계층의 완전한 bit-for-bit 재현은 아니다.
7. **문맥 선택 편향.** 다양성 순위는 결정적이지만, 승인 인덱스가 소설·수필·시에
   치우친 성격을 그대로 반영한다. 희곡·구비문학 등은 없다.
8. **동의어 record 중복.** `w14862-s2`/`w14863-s1`처럼 Canonical이 direct로
   연결한 별도 record 사이에는 같은 후보 문자열이 남아 있다. Stage 2의 병합
   판단이 필요하다.
9. **다른 생산자와 비교하지 않음.** Codex 동등성은 이 문서에서 판정하지 않는다.
   후보 수 목표도 두지 않았다.

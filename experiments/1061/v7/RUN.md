# D V7 실행 보고 — shard 016 / batch 01

- 방식/모델: D / DeepSeek V4.1 Flash
- 모드: `CALIBRATION` (개발 배치, 비블라인드)
- Canonical: `data/canonical/stdict-0016.jsonl` 1–500행
- 입력 규모: 500 records / 565 senses
- 산출물: `experiments/1061/v7/016_01_d_deepseek.jsonl`
- 절차: `experiments/1061/v7/D_PROCEDURE.md`
- Candidate v1 검증: `500 records, 565 senses, 853 candidates, 407 empty senses, 0 source-lemma candidates`
- Canonical SHA-256: `04dedfe20c9af1639343001addac61c38f5901c64a8443a5c56a0862eb2c5524`
- V6 선택 문맥 SHA-256: `26c70e7032afa783236c7c601f3e83d2b48a33d3a507bf095c6500625fe76418`
- 후보 JSONL SHA-256: `cbcfb22339c8f7ae31ad95772432fb5d8daeff4972e7dda6cb22fa25d216218e`

이 배치는 V4–V6 결과를 이미 본 개발용 배치다. 블라인드 재현 성공을 주장하지 않는다. 다른 생산자(Codex/Claude)의 후보나 평가 결과는 읽지 않았다.

## 1. 검색과 판독

| 항목 | 값 |
| --- | ---: |
| Canonical records / senses | 500 / 565 |
| 문맥이 준비된 sense | 260 |
| 준비된 문맥 수(중복 제거 후) | 2,948 |
| `VERIFIED` 문맥 판정 | 1,401 |
| `AMBIGUOUS` 문맥 판정 | 3 |
| `REJECTED` 문맥 판정 | 1,544 |
| `zero_hits` sense | 305 |
| `no_verified_context` sense | 100 |
| `inspected_all` sense(≤16문맥 전부 판독) | 66 |
| `inspected_16` sense(16문맥 전부 판독) | 94 |

문맥은 V6의 기본 검색과 `하다/되다` 어간·활용형 보충 검색 결과에서 sense별로 최대 16개를 준비했다. V7은 그 문맥을 1–4, 5–8, 9–12, 13–16 순서로 전부 읽고 sense 결속을 다시 판정했다. 준비된 문맥이 16개인 sense는 `inspected_16`, 16개 미만이면 `inspected_all`로 기록했다. `VERIFIED` 수는 읽은 문맥 수나 창 크기가 아니라, 실제로 그 sense의 쓰임을 확인한 문맥 수다.

`zero_hits` 305개는 V6 기본 검색과 보충 검색 경로에서 문맥이 잡히지 않은 sense다. 이는 말뭉치 전체에 용례가 없다는 증명이 아니며, V7에서 검색을 처음부터 다시 수행하지도 않았다.

종료 사유(sense별):

| 사유 | sense 수 |
| --- | ---: |
| `zero_hits` | 305 |
| `no_verified_context` | 100 |
| `inspected_all` | 66 |
| `inspected_16` | 94 |

## 2. 기존 V6 후보 재판정

| 판정 | 후보 수 |
| --- | ---: |
| `KEEP` | 609 |
| `REWORK` | 1 |
| `REWORK_EVIDENCE_ONLY` | 0 |
| `DROP` | 44 |
| `UNCERTAIN` | 14 |
| 합계 | **668** |

- 기존 668개를 자동 계승하지 않고 전량 `KEEP/REWORK/DROP/UNCERTAIN`으로 재판정했다.
- `UNCERTAIN` 14개는 최종 출력에서 제외했다. 모두 문맥 없이 남아 있던 기존 후보(격몽요결·계몽·어린이를 일깨우다, 경제적 풍요·자유·이유·어려움·부담·이익, 오솔길·좁은 길, 경로당·노인 공경·효도)다.
- `DROP` 44개는 다른 sense·동음이의어·부분 문자열·무근거 주변 사물·뜻풀이 반복 등이다.
- `REWORK` 1개는 `경계를 서다 → 경계병을 세우다`(w18536-s1)다.

## 3. 신규 발굴과 최종 후보

| 항목 | 값 |
| --- | ---: |
| 신규 발굴 `KEEP` | 255 |
| 기존 `KEEP` | 609 |
| 기존 `REWORK` 대체 | 1 |
| 정확 중복 제거 | 12 |
| 표제어 exact 제거 | 0 |
| 최종 후보 | **853** |
| 후보 있는 sense | 158 |
| 빈 후보 sense | 407 |

신규 후보의 derivation 분포: `exact` 249, `inflected` 4, `inferred` 2.

sense당 후보 분포: 0개 407, 1개 7, 2개 11, 3개 15, 4개 25, 5개 27, 6개 26, 7개 15, 8개 14, 9개 12, 10개 4, 11개 1, 12개 1.

관점(lens)별로 관계가 발견된 `VERIFIED` 문맥 수(중복 계수): `coll` 889, `act` 271, `scene` 167, `cause` 10, `assoc` 310. 한 문맥에서 여러 관점이 발견되면 각각 계수했다.

## 4. 품질·중복 통계

| 항목 | 값 |
| --- | ---: |
| 최종 후보 중 source lemma를 포함하는 문자열 | 276 |
| 최종 후보 중 뜻풀이에 그대로 들어 있는 문자열 | 89 |
| 같은 sense 안 정확 중복 제거 | 12 |
| 표제어 exact 후보 | 0 |

lemma 포함 후보 276개는 자동 삭제하지 않았다. `붉은 경계등`, `방수 격벽`, `계기반 다이얼`처럼 수식·대상·부품 관계를 구체화하는 표현과, `격벽을 열다`처럼 실제 행동을 나타내는 표현을 포함한다. 다만 이 비율은 Stage 2에서 추가 검토가 필요하다. 뜻풀이에 그대로 들어 있는 89개도 자동 거부하지 않았고, 실제 문맥에서 쓰임이 확인된 경우만 남겼다.

## 5. 실제로 확인한 오결속 사례

- `경계기`: 문맥 2개가 모두 심리학 스트레스 단계의 ‘경계기’였다. 초계용 항공기 sense는 `no_verified_context`.
- `견주`: 16문맥이 모두 `견주다`(비교하다)의 활용형이었다. 명주 sense는 전부 `REJECTED`.
- `결항`: 16문맥이 모두 배·비행기 운항 취소였다. ‘목을 매어 죽음’ sense는 전부 `REJECTED`.
- `경사` 동음이의 묶음: 비탈·경찰 계급·수도(京城)·경서(經史)·경사스러운 일·경찰 행정 등이 한 lemma에 겹쳐 있어, 문맥별로 다른 record의 sense로 `REJECTED` 처리했다.
- `계금`: 문맥은 `계금(計金)`과 `계금취견`뿐이어서 ‘타일러 못하게 함’·‘모든 악을 금지함’ sense는 문맥 없음.
- `경음`: 문맥은 된소리·경음악·인명뿐이어서 ‘술 많이 마시기 겨룸’·‘범종 소리 비유’ sense는 문맥 없음.
- `경력` 4개 벼슬 sense: 모든 문맥이 직업 경력(career)이어서 네 sense 모두 `no_verified_context`.
- `경련`: 모든 문맥이 몸의 발작이어서 ‘중앙 정부 소재지’ sense는 문맥 없음.

## 6. 근거가 약해 남기지 않은 후보

- 문맥이 없던 기존 후보 14개는 `UNCERTAIN`으로 최종 출력에서 제외했다.
- `센서`, `착륙 구역`, `한계선`(경계등), `도화선`(격발 장치), `길목`(경계병의 초기 후보)처럼 뜻풀이·배경지식에는 그럴듯하지만 실제 문맥이 지지하지 않은 후보는 `DROP`했다.
- `야간 공습 대비`, `불빛을 통제하다`(경계관제), `본업 외에`(겸하다)처럼 뜻풀이를 반복하거나 문맥 밖 추론인 후보는 `TRIVIAL_REPHRASE`/`UNGROUNDED`로 `DROP`했다.
- 반대로 `수면에 비친 붉은 줄`, `코를 골며 잠들다`, `철커덕하고 풀리다`처럼 원문의 감각·장면을 살린 표현은 남겼다.

## 7. 비용과 한계

- 검색은 V6 결과를 재사용했고, V7에서 원문 판독·sense 판정·후보 판정을 새로 수행했다. 검색 자체의 재현성은 V6에 의존한다.
- 판독·편집 시간은 계기하지 않았고, 토큰 사용량도 측정하지 않았다(unknown).
- 검색 자료는 문학 문어에 치우쳐 있다. 일반 문어 전체의 대표 용례로 일반화하지 않는다.
- `zero_hits` 305개는 해당 검색 경로의 미검출이다.
- 최종 후보 853개의 작가 유용성·정확성은 독립 평가가 필요하다. 후보 수가 V6(668)보다 많다는 사실을 품질 개선으로 주장하지 않는다.
- 이 배치는 결과를 이미 본 개발 배치이므로 holdout 성과가 아니다.

## 8. 재현·검증

```sh
node scripts/relation/candidate-contract.mjs \
  data/canonical/stdict-0016.jsonl \
  experiments/1061/v7/016_01_d_deepseek.jsonl
```

원문·검색 로그·sense별 감사 원장은 로컬에만 두고 Git에 넣지 않았다. Candidate JSONL에는 `record_id`, `senses[].sense_id`, `senses[].candidates`만 있다.

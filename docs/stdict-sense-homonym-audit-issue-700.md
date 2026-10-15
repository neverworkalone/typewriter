# STDICT 전량 canonical의 sense·동음이의어 분포와 뜻 중복 조사 (Issue #700)

읽기 전용 조사 보고서입니다. canonical, shard, ID, sense, gloss, 관계, provenance, SQLite, importer, 검색 런타임, UI는 바꾸지 않았고, 아래 수치는 일회성 집계 스크립트(부록 A)로 계산했습니다.

## 1. 기준과 분모

| 항목 | 값 |
| --- | --- |
| 실행 시점 master HEAD | `3964a9513cf204889f25f73226feb6a05d26aee9` (#678 최종 shard 421–428 병합 직후, `git ls-remote`로 확인) |
| 입력 | `data/canonical/stdict-0001.jsonl` … `stdict-0428.jsonl` (**428 shard**) |
| record (= 원본 entry, `id = w<target_code>`) | **427,583** (`entry` 353,251 / `expression` 74,332) |
| sense | **499,359** |
| lemma (distinct) | **357,919** |
| `data/provenance/stdict-settlement.json` 허용 집합 | included entry 427,583 / included sense 499,359로 **canonical과 일치** |

- 세 단위는 서로 다릅니다. record는 원본 entry, sense는 `<record id>-s<n>`(원본 순서, 제외된 sense는 번호 공백으로 남음), lemma는 정규화 표기이며 `lemma`는 모든 record에서 `search_forms[0]`과 같습니다(불일치 0).
- `search_forms`가 2개 이상인 record는 69,291건이지만 별칭이므로 표제어로 세지 않았습니다. 모든 lemma 집계는 `lemma` 필드만 사용합니다.
- 품사별 sense는 settlement 문서와 동일하므로 반복하지 않습니다. 모든 canonical record의 `role`은 `start`입니다.

## 2. 한 record 안의 sense 개수 (다의어)

| 구간 | record 수 | record 비율 | sense 수 | sense 비율 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 375,810 | 87.89% | 375,810 | 75.26% |
| 2–3 | 47,584 | 11.13% | 102,527 | 20.53% |
| 4–9 | 4,026 | 0.94% | 18,697 | 3.74% |
| 10–19 | 139 | 0.033% | 1,685 | 0.34% |
| 20+ | 24 | 0.006% | 640 | 0.13% |

- `record_type` 별: `expression`은 10개 이상이 0건이고 4–9가 22건에 그칩니다. 10개 이상 163건(139+24)은 전부 `entry`입니다.
- 10개 이상 163건의 품사 구성(record 기준): 동사 102, 동사+형용사 6, 명사 24, 부사 23, 형용사 7, 감탄사+명사 1.
- 최고치: `하다`(w363685) 45, `보다`(w149229) 39, **`가다`(w707) 34**, `나다` 32, `내다` 31, `놓다`·`들다` 29, `잡다` 28, `떨어지다` 27.
- **`가다`(w707)** 는 canonical에서 실제로 **한 record에 sense 34개**(s1–s34, 결번 없음)입니다. 동사 기본어의 원본 뜻풀이 구조이며, **동일 record 내 복수 sense**로 분류합니다. 이 사실만으로 오류나 중복이라고 판정하지 않습니다. 34개 gloss를 전수로 읽으면 이동(s1·s3·s4·s30·s33), 작동(s12·s21), 상태 변화(s9·s27·s28), 완곡 사망(s24), 보조적 용법(s34) 등 서로 다른 축이며 같은 글이 반복되지는 않습니다. 다만 한 화면에 모두 나열하면 길어지는 것은 사실입니다.

## 3. 동일 lemma의 복수 record (동형이의어)

lemma별 record 수:

| record 수 | 표기 그룹 수 | 그룹 비율 | 그룹에 속한 record | record 비율 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 323,118 | 90.28% | 323,118 | 75.57% |
| 2–3 | 27,550 | 7.70% | 61,884 | 14.47% |
| 4–9 | 6,611 | 1.85% | 34,102 | 7.98% |
| 10–19 | 589 | 0.16% | 7,264 | 1.70% |
| 20+ | 51 | 0.014% | 1,215 | 0.28% |

복수 record 그룹은 34,801개이며, 소속 record는 **104,465건(24.4%)** 입니다. 상위: `조사` 32, `사장` 31, `사` 30, `비`·`전`·`장` 29, `진`·`고사`·`기`·`사사` 28.

실제 검색 UI가 마주치는 **lemma 전체 sense 수**(다의어×동음이의어 합산):

| lemma 안 sense 수 | lemma 수 | 소속 record | 소속 sense |
| --- | ---: | ---: | ---: |
| 1 | 290,875 | 290,875 | 290,875 |
| 2–3 | 52,114 | 78,367 | 116,826 |
| 4–9 | 13,290 | 43,628 | 68,303 |
| 10–19 | 1,430 | 11,534 | 17,789 |
| 20+ | 210 | 3,179 | 5,566 |

상위: `사` 54(30 record), `치다` 51(13), `진`·`정`·`장` 47, `전` 45, `하다` 45(1), `뜨다` 43(13). 10개 이상인 lemma는 1,640개, 그중 20개 이상은 210개입니다. 즉 한 record의 다의성(163건)보다 **동형이의어 합산로 인한 과밀(1,640 lemma)** 이 10배 가까이 넓습니다.

동형이의어 구분 신호: 복수 record lemma 34,801개 중 record들의 품사 서명(sense 품사 집합)이 모두 같은 것이 32,159개(92.4%), 다른 것이 2,642개(7.6%)입니다. 품사만으로는 대부분 구분되지 않습니다.

**`사전`** 은 canonical에 **22 record**(sense 합 25)가 있고 모두 서로 다른 `target_code`이며, 전량을 부록 C의 S6가 다시 출력합니다. 아래는 22 record 전부의 ID, 실제 `senses.length`, canonical gloss(sense가 둘이면 둘 다)와 gloss만 근거로 한 판정입니다. 원본 한자 표기는 canonical에 없고 원본 JSON도 재대조하지 않았으므로, 한자는 gloss에 직접 병기된 경우에만 인용하며 한자어 구별을 근거로 삼지 않습니다.

| record | sense | canonical gloss (축약 없는 곳은 전문, 긴 것은 앞부분) | 판정 |
| --- | ---: | --- | --- |
| w164474 | 1 | 살아 있는 동안. | 별개 (시간) |
| w164475 | 1 | 죽기를 각오하고 싸움. 또는 그런 싸움. | 별개 (싸움) |
| w164477 | 2 | s1 개인 소유의 논밭. / s2 조선 시대에, 나라에서 개인에게 조(租)를 받을 권리를 준 논밭. … | 별개 (논밭, 두 sense는 서로 다른 뜻) |
| w164478 | 1 | 개인의 사사로운 전보. | 별개 (전보) |
| w164479 | 1 | 국가의 선전 포고 없이 개인이나 사사로운 단체가 외국에 대하여 전투를 하는 행위. … | 별개 (전투 행위) |
| w164502 | 2 | s1 ‘사천04’의 원말. / s2 개인이 위조한 가짜 돈. | 별개. s1은 다른 표제어 참조, s2는 위조 화폐 |
| w164503 | 1 | 저절로 돎. | 별개 (회전) |
| w164504 | 1 | 일이 일어나기 전. 또는 일을 시작하기 전. | 별개 (시간, w164474와 다른 뜻) |
| w164505 | 1 | 제사(祭祀)를 지내는 예전(禮典). | 별개 (제례) |
| w164506 | 1 | 모래가 많이 섞인 밭. | 별개 (밭 종류) |
| w164508 | 1 | 베틀의 북 모양으로 두 끝이 가늘어져 뾰족하고 길쭉하게 생긴 밭. | 별개 (밭 모양) |
| w164509 | 1 | 작은 규모로 물건을 파는 집. | 별개 (상점) |
| w164510 | 1 | 고려·조선 시대에, 임금이 내려 준 논밭. 주로 외교와 국방 따위의 분야에서 … | 별개. w164477-s2와 같은 '논밭'이지만 임금이 내린 땅이라는 점이 다름 |
| w173019 | 1 | 문헌 사료가 전혀 존재하지 않는 시대. 석기 시대와 청동기 시대를 이른다. | 별개 (시대) |
| w173020 | 2 | s1 역사와 전기(傳記)를 아울러 이르는 말. / s2 역사에 전해진 기록. | 별개. 두 sense는 서로 다른 뜻 |
| w173021 | 1 | 절이 소유하고 있는 밭. | 별개 (절 소유 밭) |
| w438466 | 1 | 여러 가지 사항을 모아 일정한 순서로 배열하고 그 각각에 해설을 붙인 책. … | 별개. 사항 해설 책 |
| w438467 | 1 | 스승으로부터 전하여 받음. | 별개 (전수) |
| w438468 | 1 | 국가적인 경사가 있을 때 죄인을 용서하여 놓아주던 일. | 별개 (사면) |
| w438469 | 1 | 감사의 뜻을 나타내는 전보. | 별개. w164478(사사로운 전보)과 전보라는 점은 같지만 용도가 다름 |
| w438470 | 1 | 어떤 범위 안에서 쓰이는 낱말을 모아서 일정한 순서로 배열하여 싣고 그 각각의 발음, 의미, 어원, 용법 따위를 해설한 책. … | 별개. 낱말 해설 책으로 w438466(사항 해설 책)과 gloss가 다름 |
| w444090 | 1 | 신라에서, 예부에 소속되어 사찰(寺刹)에 관한 일을 맡아보던 관아. | 별개 (관아) |

- 판정 근거는 gloss 비교입니다. 22 record 사이에 **정확히 같은 gloss는 없고**, 부록 C S6에 모든 gloss가 있습니다. 비슷한 쌍은 w438466/w438470(책: 사항 vs 낱말), w164477-s2/w164510/w173021(논밭 계열), w164478/w438469(전보)이며, 모두 gloss가 구별하는 서로 다른 뜻으로 봅니다. 다만 책 두 record는 사용자에게 구별 단서가 약합니다(원본 번호·한자 부재). 중복 의심 record는 없습니다.
- 두 record 이상이 gloss상 비슷해 보이는 위 세 묶음은 **UI에서 구별 단서가 필요한 후보**이며 병합 후보는 아닙니다.
- 사용자에게 보이는 반복은 중복이 아니라 구별 단서 없는 동음이의어 나열입니다.

## 4. 뜻풀이 중복·유사성

모든 비교는 공백 정규화 후 문자열 일치, 또는 한글·영숫자 2-gram Jaccard(결정적 지표)입니다. **의미 동일 판정이나 병합 규칙이 아니며 후보 검출용**입니다.

### 4.1 정확히 같은 gloss (측정치)

| 구분 | 건수 |
| --- | --- |
| 한 record 내부에서 같은 gloss가 반복되는 record | **16** (gloss 그룹 17, sense 34) |
| 위 그룹 중 관계(`direct`/`antonym`, 출·입) 보유 | 1 |
| 같은 lemma의 서로 다른 record 사이 같은 gloss | **141 그룹 / 134 lemma / 276 record** |
| 위 그룹 중 관계 보유 sense가 포함된 그룹 | 134 / 141 |
| (참고) 서로 다른 lemma 포함 전체에서 2회 이상 나오는 gloss 종류 | 61,586 |

- record 내부 중복 16건은 소수이며, 예시(`둘찌`, `두째`, `졸립다`, `가루`, `각히`, `거시키`, `네째`)의 gloss가 `→ .` 또는 `‘’의 본말.`입니다. 원본의 참조 대상이 정규화에서 비어 사라진 **참조형 gloss 변환 문제 가능성**이 높습니다(미확인: 원본 JSON 대조는 하지 않음).
- 같은 lemma·같은 gloss의 서로 다른 record 141 그룹은 대부분 서로 동의어 링크로 연결된 쌍으로 보입니다(예: `전락하다`, `천수`, `강병`). 관계 보유 비율이 매우 높으므로 **묶거나 숨기면 `target_sense` 결합이 손상될 위험**이 큽니다. (링크가 정확히 그 쌍을 잇는지는 전수 확인하지 않았습니다.)
- 참고: gloss가 `→`로 시작하는 순수 참조 sense가 8,617건(51건은 `→ .`처럼 대상이 비어 있음), `…의 준말/본말/원말` 등 참조형이 약 4,018건입니다. 중복과는 별개로 팝업에서 뜻이 보이지 않는 표시 품질 이슈입니다.

### 4.2 유사하지만 다른 gloss (후보, 측정치 아님)

임계값은 품질 기준이 아니라 후보 폭을 보기 위한 표시용입니다.

| Jaccard ≥ | 한 record 내부 쌍 (record) | 같은 lemma 다른 record 쌍 (lemma) |
| --- | ---: | ---: |
| 0.50 | 6,268 (3,860) | 665 (533) |
| 0.70 | 2,168 (1,820) | 135 (122) |
| 0.85 | 1,518 (1,349) | 13 (13) |

관계 보유 쌍은 record 내부 664/295/124, lemma 간 149/41/7입니다(0.50/0.70/0.85 순). 한 lemma에 sense가 400개를 넘는 그룹은 없어 건너뛴 그룹은 없습니다.

### 4.3 층화 소표본 (조사용, 전체 건수로 확대 금지)

위험군별로 고정 시드 무작위 추출 후 gloss·품사·ID를 직접 읽었습니다. 추출된 표본의 record/sense ID·품사·gloss 전문은 **부록 C**, 항목별 분류와 근거는 **부록 D**, 추출 절차는 부록 A·부록 B2에 있습니다. 분류: (a) 진짜 중복 가능성, (b) 유의미한 용법/의미 차이, (c) 별개 동음이의어, (d) 불명확.

| 위험군 | 표본 | (a) | (b) | (c) | (d) | 관찰 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| record 내부 유사(≥0.7) | 12 | 9 | 3 | 0 | 0 | (a)는 품사가 명사/관형사로 갈리는 `교훈적`, `기능적`, `관조적`, `단속적`, `독창적`, `가족적`, `대여섯째`, `자`, `도식주의적`처럼 `…것.` / `….`로 끝만 다른 쌍(관형사·명사 용법 분리). (b)는 `궁관`(동궁 vs 궁전)과 `걷다`·`갈앉히다`의 준말 참조(참조 대상 번호가 다름). |
| 같은 lemma 다른 record 유사(≥0.7) | 12 | 0 | 0 | 11 | 1 | `중장년`(중년01/장년01 vs 02), `경문`(화성/금성), `개원`(院/園), `정자형`(丁/井), `이성`, `호박색`, `주간지`(잡지/신문) 등은 한 글자 차이로 뜻이 다름. `순근하다`(순수/순박)는 (d). |
| 같은 lemma 다른 record 같은 gloss | 10 | 10 | 0 | 0 | 0 | `전락하다`, `전질하다`, `천수`, `지향성`, `집주하다`, `전락`, `강병`, `반기`, `구수`, `육부` 모두 gloss가 같고 관계 보유. 같은 단어가 원본에서 한자·어형 근거로 분리된 것으로 보입니다(한자 병기는 canonical에 없어 근거 확인 불가). |
| 다의어 ≥20 (record) | 전수 24개 중 `가다` 34 sense 전수 읽음 | 0 | 34 | 0 | 0 | 같은 글 반복 없음. 용법이 달라 분리 유지가 타당. |
| 다의어 10+ 비동사 | 3 (`축`, `길`, `쭉쭉`) | 0 | 3 | 0 | 0 | 의미/용법 차이이며 `쭉쭉`은 `죽죽` 대응 gloss 형식만 반복. |
| 동형이의어 20+ record | 3 (`기수`, `정사`, `정`) | 0 | 0 | 3 | 0 | 같은 표기·품사지만 전혀 다른 어휘(동음). |

표본이 작고 층화이므로 위 비율은 전체 중복 건수의 추정치로 쓰지 않습니다. 정성적으로 확인된 것은 세 가지입니다.

1. 같은 lemma의 다른 record는 gloss가 다르면 거의 항상 별개 어휘입니다.
2. 같은 lemma·같은 gloss의 다른 record는 중복처럼 보여도 대부분 관계가 붙어 있고, 구별 근거(한자·번호)가 canonical에 없습니다.
3. record 내부의 `-적`·`-하다` 계열 반복(끝 `것.`/`.` 차이)은 규칙으로 잡히는 유형이 뚜렷합니다.

## 5. 후속 선택을 위한 판단표

작업량은 두 갈래로 분리합니다. 아래 수치 중 *측정치*는 위 표 값이고 *추정치*는 표시했습니다.

| 작업 | 대상 | 규모 | 구분 |
| --- | --- | --- | --- |
| A. 실제 병합·그룹핑 검토 후보 | record 내부 정확 중복 | 16 record / 17 그룹 | 측정치 (대부분 `→ .` 참조 변환 문제 의심) |
| | lemma 내 정확히 같은 gloss의 다른 record | 141 그룹 / 134 lemma | 측정치, 관계 보유 134 |
| | record 내부 유사(≥0.85) | 1,349 record | 측정치(후보), 표본상 `…것.`/`.` 유형이 다수 → 규칙화 후보 |
| | lemma 간 유사(≥0.7) | 122 lemma | 측정치(후보), 표본상 대부분 별개 동음이의어 → 병합 부적합 |
| | 다의어 10+ 의 gloss 정리 | 163 record | 측정치, 표본상 중복 아님 → 병합 대상 아님 |
| B. 식별 UI 문제 | 복수 record lemma | 34,801 lemma / 104,465 record | 측정치 |
| | lemma 전체 sense 10+ | 1,640 lemma (20+는 210) | 측정치 |
| | 동형이의어 구별 단서 부족 (품사 동일) | 32,159 lemma | 측정치 |
| | 참조형 gloss (`→ …`, 준말/본말 등) | 약 8,617 + 4,018 sense | 측정치(패턴 기반, 정확도 미검증) |

**추천: 혼합.** 근거는 다음과 같습니다.

- 소량 수작업 범위: 정확 중복 record 16건과 같은 lemma 내 정확 동일 gloss 141 그룹처럼 수백 건 이하이고 위험이 큰(관계 결합) 항목은 사람이 한 건씩 확인할 만합니다. 병합·숨김은 `target_sense` 결합을 유지하는 방식이어야 합니다.
- 공통 규칙 범위: UI 과밀은 34,801개 lemma, 1,640개 긴 lemma, 12,600여 개 참조형 gloss처럼 수만 건에 걸치므로 수작업이 불가능합니다. 구별 단서(원본 동음이의 번호·한자 병기 등 canonical에 없는 정보) 노출, 긴 목록 접기, 참조형 gloss의 대상 표시는 **표시 계층의 공통 규칙**이 적합합니다. 데이터 병합 규칙으로는 삼지 않습니다.
- 유사 gloss 후보를 자동 병합하는 것은 추천하지 않습니다. 표본에서 lemma 간 유사 쌍 12건 중 11건이 별개 동음이의어였습니다.
- 임의 임계값을 품질 기준으로 선언하지 않았고, 최종 선택은 소유자에게 있습니다.

## 6. 미확인 사항

- 원본 STDICT JSON과의 재대조(참조형 gloss `→ .` 변환 원인, 동형이의어 원본 번호 `01/02` 및 한자 병기의 canonical 부재)는 하지 않았습니다.
- 정확 동일 gloss 쌍이 실제로 관계로 서로 연결된 쌍인지 전수 확인하지 않았습니다.
- 표본은 소규모 층화 표본이며(`가다` 전수 읽기 제외 약 40건) 전체 비율 추정에 쓸 수 없습니다.
- 유사 gloss 후보는 2-gram Jaccard 한 가지 지표에 의존하며 의미 판정이 아닙니다.
- 참조형 gloss 수는 정규식 기반 근사입니다.
- 검색 런타임의 실제 후보 메뉴 길이(랭킹·필터 적용 후)는 측정하지 않았고, canonical 기준 lemma 합산값만 제시했습니다.

## 부록 A. 재현 절차

저장소에 스크립트를 추가하지 않았습니다. 부록 B의 스크립트를 저장소 밖 임시 위치에 저장하고 다음 명령으로 실행하면 §2–§4의 수치가 나옵니다(약 5초).

```sh
node --max-old-space-size=6000 /path/to/census.mjs data/canonical /path/to/census.json
```

입력 확인: `data/provenance/stdict-settlement.json`의 `entries.by_status.included` = 427,583, `senses.by_status.included` = 499,359가 스크립트의 `records`·`senses` 출력과 같아야 합니다. 표본은 부록 B2(`sample2.mjs`)가 `census.json`(부록 B의 출력)을 읽어 다시 생성하며, 출력은 부록 C와 같아야 합니다.

```sh
node /path/to/sample2.mjs data/canonical /path/to/census.json
```

추출 알고리즘: LCG `seed = (seed*1103515245+12345) & 0x7fffffff`, 초기값 7, 난수 = `seed/0x7fffffff`를 **하나의 스트림**으로 S1→S5 순서로 소비합니다. 각 층의 `pick(모집단, n)`은 모집단 배열 복사본에서 `splice(floor(난수*길이),1)`을 n번 반복합니다. 모집단과 정렬 순서는 다음과 같습니다.

- S1/S2: `census.json`의 `simEx.intra`/`simEx.cross`, 즉 Jaccard ≥ 0.7 쌍을 lemma 그룹 최초 등장 순(shard 파일·줄 순)으로 `i<j` 쌍 순서대로 최대 400건까지 쌓은 목록(각각).
- S3: record 수 ≥ 20인 lemma 그룹(최초 등장 순). 각 그룹은 앞의 6 record의 첫 sense를 출력.
- S4: 첫 sense 품사가 동사가 아니고 sense 수 ≥ 10인 record(파일 순). 앞의 6 sense를 출력.
- S5: 같은 lemma의 둘 이상의 record에 걸친 정확 동일 gloss 그룹(lemma 최초 등장 순, gloss 최초 등장 순).
- S0은 `w707` 34 sense 전수, S6은 lemma `사전` 22 record 전수 출력(둘 다 무작위 아님이며 난수 스트림을 소비하지 않음).

핵심 집계 로직:

- record = 각 JSONL 줄, sense = `senses[]`, lemma 그룹 = `lemma` 문자열.
- 구간 = 1 / 2–3 / 4–9 / 10–19 / 20+, sense 개수는 `senses.length`, lemma 그룹 크기는 record 수 또는 sense 합.
- gloss 비교는 `replace(/\s+/g,' ').trim()` 후 문자열 일치.
- 유사도는 `[^가-힣A-Za-z0-9]` 제거 후 문자 2-gram 집합의 Jaccard, 같은 record 내부와 같은 lemma 그룹 내부에서만 쌍을 비교합니다.
- 관계 보유: sense의 `relations` 비어 있지 않음, 또는 다른 sense의 `relations[].target_sense`가 이 sense를 가리킴.

## 부록 B. 일회성 집계 스크립트 (저장소에는 추가하지 않음)

```js
// One-off read-only census over data/canonical/stdict-*.jsonl (issue #700).
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^stdict-\d+\.jsonl$/.test(f)).sort();
const recs = [];
for (const f of files) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) recs.push(JSON.parse(l));
const out = { shards: files.length, records: recs.length };
let senseTotal = 0;
const incoming = new Set();
for (const r of recs) { senseTotal += r.senses.length; for (const s of r.senses) for (const x of s.relations || []) incoming.add(x.target_sense); }
out.senses = senseTotal;
const bucket = (n) => (n === 1 ? '1' : n <= 3 ? '2-3' : n <= 9 ? '4-9' : n <= 19 ? '10-19' : '20+');
const B = ['1', '2-3', '4-9', '10-19', '20+'];
const mk = () => Object.fromEntries(B.map((b) => [b, { n: 0, senses: 0 }]));
const hasRel = (s) => (s.relations && s.relations.length) || incoming.has(s.id);
// 2. senses per record
const dist = mk(), byType = {}, byPos = {};
for (const r of recs) {
  const b = bucket(r.senses.length); dist[b].n++; dist[b].senses += r.senses.length;
  const t = r.record_type; byType[t] ??= mk(); byType[t][b].n++; byType[t][b].senses += r.senses.length;
  if (r.senses.length >= 10) { const p = [...new Set(r.senses.map((s) => s.pos))].sort().join('+'); byPos[p] = (byPos[p] || 0) + 1; }
}
out.sensesPerRecord = dist; out.sensesPerRecordByType = byType; out.ge10ByPos = byPos;
const sorted = [...recs].sort((a, b) => b.senses.length - a.senses.length);
out.topSenses = sorted.slice(0, 15).map((r) => [r.id, r.lemma, r.senses.length]);
out.ge10 = recs.filter((r) => r.senses.length >= 10).length; out.ge20 = recs.filter((r) => r.senses.length >= 20).length;
// 3. homonyms
const groups = new Map();
for (const r of recs) { if (!groups.has(r.lemma)) groups.set(r.lemma, []); groups.get(r.lemma).push(r); }
out.lemmas = groups.size;
const gd = Object.fromEntries(B.map((b) => [b, { groups: 0, records: 0, senses: 0 }]));
const gs = Object.fromEntries(B.map((b) => [b, { groups: 0, records: 0, senses: 0 }]));
const posMix = { multiRecordGroups: 0 };
for (const [l, rs] of groups) {
  const b = bucket(rs.length); gd[b].groups++; gd[b].records += rs.length;
  const sc = rs.reduce((a, r) => a + r.senses.length, 0); gd[b].senses += sc;
  const b2 = bucket(sc); gs[b2].groups++; gs[b2].records += rs.length; gs[b2].senses += sc;
}
out.recordsPerLemma = gd; out.sensesPerLemma = gs;
out.topLemmaRecords = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([l, rs]) => [l, rs.length, rs.reduce((a, r) => a + r.senses.length, 0)]);
out.topLemmaSenses = [...groups].sort((a, b) => b[1].reduce((x, r) => x + r.senses.length, 0) - a[1].reduce((x, r) => x + r.senses.length, 0)).slice(0, 15).map(([l, rs]) => [l, rs.length, rs.reduce((a, r) => a + r.senses.length, 0)]);
// lemma != search_forms[0]?
out.searchFormsExtra = recs.filter((r) => r.search_forms.length > 1).length;
out.lemmaNotFirstForm = recs.filter((r) => r.search_forms[0] !== r.lemma).length;
// 4. gloss duplicates
const norm = (g) => g.replace(/\s+/g, ' ').trim();
let intraRecs = 0, intraPairs = 0, intraSenses = 0, intraRelSenses = 0; const intraEx = [];
for (const r of recs) {
  const m = new Map(); for (const s of r.senses) { const g = norm(s.gloss); if (!m.has(g)) m.set(g, []); m.get(g).push(s); }
  let hit = false;
  for (const [g, ss] of m) if (ss.length > 1) { hit = true; intraPairs++; intraSenses += ss.length; if (ss.some(hasRel)) intraRelSenses++; if (intraEx.length < 8) intraEx.push([r.id, r.lemma, g.slice(0, 50), ss.length]); }
  if (hit) intraRecs++;
}
out.intraRecordExactGloss = { records: intraRecs, glossGroups: intraPairs, senses: intraSenses, groupsWithRelation: intraRelSenses, examples: intraEx };
// same lemma, different records, identical gloss
let crossGroups = 0, crossLemmas = 0, crossRecs = 0, crossRel = 0; const crossEx = []; const crossLemSet = new Set();
const crossRecSet = new Set();
for (const [l, rs] of groups) {
  if (rs.length < 2) continue;
  const m = new Map();
  for (const r of rs) for (const s of r.senses) { const g = norm(s.gloss); if (!m.has(g)) m.set(g, []); m.get(g).push([r, s]); }
  for (const [g, xs] of m) { const ids = new Set(xs.map((x) => x[0].id)); if (ids.size > 1) { crossGroups++; crossLemSet.add(l); ids.forEach((i) => crossRecSet.add(i)); if (xs.some((x) => hasRel(x[1]))) crossRel++; if (crossEx.length < 8) crossEx.push([l, [...ids], g.slice(0, 50)]); } }
}
out.crossRecordSameLemmaExactGloss = { glossGroups: crossGroups, lemmas: crossLemSet.size, records: crossRecSet.size, groupsWithRelation: crossRel, examples: crossEx };
// identical gloss anywhere across different lemmas (info only)
const allG = new Map(); for (const r of recs) for (const s of r.senses) { const g = norm(s.gloss); allG.set(g, (allG.get(g) || 0) + 1); }
out.globalGlossRepeats = { distinctGlossesRepeated: [...allG.values()].filter((v) => v > 1).length };
// similar-gloss candidates (deterministic bigram Jaccard) within records and within same-lemma groups
const bg = (g) => { const t = g.replace(/[^가-힣A-Za-z0-9]/g, ''); const s = new Set(); for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2)); return s; };
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const TH = [0.5, 0.7, 0.85];
const simIntra = { recs: [new Set(), new Set(), new Set()], pairs: [0, 0, 0] }, simCross = { lemmas: [new Set(), new Set(), new Set()], pairs: [0, 0, 0] };
const simIntraRel = [0, 0, 0], simCrossRel = [0, 0, 0]; const simEx = { intra: [], cross: [] };
for (const [l, rs] of groups) {
  const items = []; for (const r of rs) for (const s of r.senses) { const g = norm(s.gloss); items.push({ r, s, g, b: bg(g) }); }
  if (items.length > 400) { out.skippedLargeGroups = (out.skippedLargeGroups || []).concat([[l, items.length]]); continue; }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]; if (a.g === b.g) continue;
    const jv = jac(a.b, b.b); if (jv < TH[0]) continue;
    const same = a.r === b.r; const tgt = same ? simIntra : simCross; const relc = same ? simIntraRel : simCrossRel;
    const rel = hasRel(a.s) || hasRel(b.s);
    for (let t = 0; t < 3; t++) if (jv >= TH[t]) { tgt.pairs[t]++; relc[t] += rel ? 1 : 0; (same ? tgt.recs : tgt.lemmas)[t].add(same ? a.r.id : l); }
    if (jv >= 0.7 && simEx[same ? 'intra' : 'cross'].length < 400) simEx[same ? 'intra' : 'cross'].push([l, a.s.id, b.s.id, +jv.toFixed(2), a.g.slice(0, 60), b.g.slice(0, 60), rel]);
  }
}
out.similarGlossCandidates = { thresholds: TH, intraRecord: { pairs: simIntra.pairs, records: simIntra.recs.map((s) => s.size), pairsWithRelation: simIntraRel }, crossRecordSameLemma: { pairs: simCross.pairs, lemmas: simCross.lemmas.map((s) => s.size), pairsWithRelation: simCrossRel } };
// relations on risk groups
let ge10rel = 0, ge10s = 0, ge10relS = 0; for (const r of recs) if (r.senses.length >= 10) { ge10s += r.senses.length; ge10relS += r.senses.filter(hasRel).length; ge10rel += r.senses.some(hasRel) ? 1 : 0; }
out.relationsOnGe10 = { records: out.ge10, recordsWithRel: ge10rel, senses: ge10s, sensesWithRel: ge10relS };
let hom = 0, homRel = 0, homS = 0; for (const rs of groups.values()) if (rs.length > 1) for (const r of rs) { hom++; homS += r.senses.length; homRel += r.senses.filter(hasRel).length; }
out.relationsOnMultiRecordLemmas = { records: hom, senses: homS, sensesWithRel: homRel };
out.record_type_counts = {}; for (const r of recs) out.record_type_counts[r.record_type] = (out.record_type_counts[r.record_type] || 0) + 1;
// homonym pos composition: multi-record lemmas whose records share identical single pos vs differ
let samePos = 0, diffPos = 0; for (const rs of groups.values()) if (rs.length > 1) { const p = new Set(rs.map((r) => [...new Set(r.senses.map((s) => s.pos))].sort().join('+'))); p.size === 1 ? samePos++ : diffPos++; }
out.multiRecordLemmaPos = { samePosSignature: samePos, differentPosSignature: diffPos };
// saved for sampling
fs.writeFileSync(process.argv[3], JSON.stringify({ out, simEx }, null, 1));
console.log(JSON.stringify(out, null, 1));
```

## 부록 B2. 표본 추출 스크립트 (저장소에는 추가하지 않음)

```js
// Deterministic stratified sample listing for issue #700 (reads census.json produced by census.mjs).
import fs from 'node:fs';import path from 'node:path';
const dir=process.argv[2];const recs=[];
for(const f of fs.readdirSync(dir).filter(f=>/^stdict-\d+\.jsonl$/.test(f)).sort())for(const l of fs.readFileSync(path.join(dir,f),'utf8').split('\n'))if(l)recs.push(JSON.parse(l));
const byId=new Map(recs.map(r=>[r.id,r]));const sense=(id)=>{const r=byId.get(id.split('-')[0]);return r.senses.find(s=>s.id===id)};
let seed=7;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff};
const pick=(a,n)=>{const c=[...a];const o=[];while(o.length<n&&c.length)o.push(c.splice(Math.floor(rnd()*c.length),1)[0]);return o};
const {simEx}=JSON.parse(fs.readFileSync(process.argv[3]));
const line=(id)=>{const s=sense(id);return `${id}\t${s.pos}\t${s.gloss}`};
console.log('## S0 w707 가다');byId.get('w707').senses.forEach(s=>console.log(' '+line(s.id)));
console.log('## S1 intra-record similar >=0.7 (population: first 400 pairs in file/sense order)');
for(const x of pick(simEx.intra,12)){console.log(`lemma=${x[0]} jaccard=${x[3]}`);console.log(' '+line(x[1]));console.log(' '+line(x[2]))}
console.log('## S2 cross-record same-lemma similar >=0.7');
for(const x of pick(simEx.cross,12)){console.log(`lemma=${x[0]} jaccard=${x[3]}`);console.log(' '+line(x[1]));console.log(' '+line(x[2]))}
const groups=new Map();for(const r of recs){(groups.get(r.lemma)||groups.set(r.lemma,[]).get(r.lemma)).push(r)}
console.log('## S3 lemma with >=20 records');
for(const [l,rs] of pick([...groups].filter(([l,rs])=>rs.length>=20),3)){console.log(`lemma=${l} records=${rs.length}`);for(const r of rs.slice(0,6))console.log(' '+line(r.senses[0].id))}
console.log('## S4 non-verb records with >=10 senses');
for(const r of pick(recs.filter(r=>r.senses.length>=10&&r.senses[0].pos!=='verb'),3)){console.log(`${r.id} ${r.lemma} senses=${r.senses.length}`);r.senses.slice(0,6).forEach(s=>console.log(' '+line(s.id)))}
console.log('## S5 cross-record same-lemma exact gloss');
const m=[];for(const [l,rs] of groups){if(rs.length<2)continue;const mm=new Map();for(const r of rs)for(const s of r.senses)(mm.get(s.gloss)||mm.set(s.gloss,[]).get(s.gloss)).push(s.id);for(const [gl,xs] of mm)if(new Set(xs.map(i=>i.split('-')[0])).size>1)m.push([l,xs])}
for(const [l,xs] of pick(m,10)){console.log(`lemma=${l}`);xs.forEach(i=>console.log(' '+line(i)))}
console.log('## S6 lemma=사전 (all records, all senses)');
for(const r of groups.get('사전')){console.log(`${r.id} senses=${r.senses.length}`);r.senses.forEach(s=>console.log(' '+line(s.id)))}
```

## 부록 C. 표본 목록 (부록 B2 출력, canonical 원문)

ID는 `w<target_code>` record와 `-s<n>` sense이며 각 줄은 `ID<TAB>품사<TAB>gloss`입니다. S6은 무작위가 아닌 `사전` 전수 출력입니다.

```text
## S0 w707 가다
 w707-s1	verb	한곳에서 다른 곳으로 장소를 이동하다.
 w707-s2	verb	수레, 배, 자동차, 비행기 따위가 운행하거나 다니다.
 w707-s3	verb	지금 있는 곳에서 어떠한 목적을 가지고 다른 곳으로 옮기다.
 w707-s4	verb	직업이나 학업, 복무 따위로 해서 다른 곳으로 옮기다.
 w707-s5	verb	직책이나 자리를 옮기다.
 w707-s6	verb	물건이나 권리 따위가 누구에게 옮겨지다.
 w707-s7	verb	관심이나 눈길 따위가 쏠리다.
 w707-s8	verb	말이나 소식 따위가 알려지거나 전하여지다.
 w707-s9	verb	그러한 상태가 생기거나 일어나다.
 w707-s10	verb	어떤 상태나 상황을 향하여 나아가다.
 w707-s11	verb	한쪽으로 흘러가다.
 w707-s12	verb	동력원으로 하여 작동하다.
 w707-s13	verb	물체가 한쪽으로 기울어지다.
 w707-s14	verb	금, 줄, 주름살, 흠집 따위가 생기다.
 w707-s15	verb	건강에 해가 되다.
 w707-s16	verb	일정한 시간이 되거나 일정한 곳에 이르다.
 w707-s17	verb	일정한 대상에 미치어 작용하다.
 w707-s18	verb	어떤 일을 하는 데 수고가 많이 들다.
 w707-s19	verb	어떤 대상이 다른 곳으로 이동하여 사라지다.
 w707-s20	verb	지나거나 흐르다.
 w707-s21	verb	기계 따위가 제대로 작동하다.
 w707-s22	verb	외부의 충격이나 영향으로 정신을 제대로 차리지 못하는 혼미한 상태가 되다.
 w707-s23	verb	전기 따위가 꺼지거나 통하지 않다.
 w707-s24	verb	(완곡하게) 사람이 죽다.
 w707-s25	verb	어떤 일에 대하여 납득이나 이해, 짐작 따위가 되다.
 w707-s26	verb	가치나 값, 순위 따위를 나타내는 말과 결합하여 어떤 대상을 기준으로 해서 어느 정도까지 이르다.
 w707-s27	verb	원래의 상태를 잃고 상하거나 변질되다.
 w707-s28	verb	때나 얼룩이 잘 빠지다.
 w707-s29	verb	어떤 경로를 통하여 움직이다.
 w707-s30	verb	어떤 일을 하기 위하여 다른 곳으로 이동하다.
 w707-s31	verb	노름이나 내기에서 얼마의 액수를 판돈으로 걸다.
 w707-s32	verb	어떤 현상이나 상태가 유지되다.
 w707-s33	verb	일정한 목적을 가진 모임에 참석하기 위하여 이동하다.
 w707-s34	verb	앞말이 뜻하는 행동이나 상태가 진행됨을 나타내는 말.
## S1 intra-record similar >=0.7 (population: first 400 pairs in file/sense order)
lemma=궁관 jaccard=0.71
 w41329-s1	noun	동궁(東宮)에 소속되어 있던 벼슬아치.
 w41329-s2	noun	궁전에 소속되어 있던 벼슬아치.
lemma=걷다 jaccard=0.7
 w14752-s2	verb	‘거두다02[1]「2」’의 준말.
 w14752-s3	verb	‘거두다02[2]’의 준말.
lemma=교훈적 jaccard=0.92
 w34635-s1	noun	교훈이 되거나 교훈으로 삼을 만한 것.
 w34635-s2	determiner	교훈이 되거나 교훈으로 삼을 만한.
lemma=도식주의적 jaccard=0.98
 w85005-s1	noun	사물의 본질이나 구체적인 특성을 밝히기 위한 창조적 태도 없이, 일정한 형식이나 틀에 기계적으로 맞추려는 경향 같은 것.
 w85005-s2	determiner	사물의 본질이나 구체적인 특성을 밝히기 위한 창조적 태도 없이, 일정한 형식이나 틀에 기계적으로 맞추려는 경향 같은.
lemma=기능적 jaccard=0.92
 w47865-s1	noun	하는 구실이나 작용과 관련된 것.
 w47865-s2	determiner	하는 구실이나 작용과 관련된.
lemma=관조적 jaccard=0.96
 w32931-s1	noun	고요한 마음으로 사물이나 현상을 관찰하거나 비추어 보는 것.
 w32931-s3	determiner	고요한 마음으로 사물이나 현상을 관찰하거나 비추어 보는.
lemma=단속적 jaccard=0.88
 w74443-s1	noun	끊어졌다 이어졌다 하는 것.
 w74443-s2	determiner	끊어졌다 이어졌다 하는.
lemma=대여섯째 jaccard=0.93
 w79233-s1	noun	순서가 다섯 번째나 여섯 번째쯤 되는 차례.
 w79233-s2	determiner	순서가 다섯 번째나 여섯 번째쯤 되는 차례의.
lemma=자 jaccard=0.81
 w282064-s1	noun	해(垓)의 만 배가 되는 수. 즉, 10²⁴을 이른다.
 w282064-s3	determiner	해(垓)의 만 배가 되는 수의. 즉, 10²⁴을 이른다.
lemma=독창적 jaccard=0.97
 w86012-s1	noun	다른 것을 모방함이 없이 새로운 것을 처음으로 만들어 내거나 생각해 내는 것.
 w86012-s2	determiner	다른 것을 모방함이 없이 새로운 것을 처음으로 만들어 내거나 생각해 내는.
lemma=갈앉히다 jaccard=0.7
 w5966-s1	verb	‘가라앉히다[1]’의 준말.
 w5966-s2	verb	‘가라앉히다[2]「1」’의 준말.
lemma=가족적 jaccard=0.91
 w3806-s2	noun	규모나 범위가 가족 단위인 것.
 w3806-s4	determiner	규모나 범위가 가족 단위인.
## S2 cross-record same-lemma similar >=0.7
lemma=중장년 jaccard=0.78
 w535715-s1	noun	중년01「1」(中年)과 장년01(壯年)을 아울러 이르는 말.
 w536216-s1	noun	중년01「1」(中年)과 장년02「2」(長年)을 아울러 이르는 말.
lemma=경문 jaccard=0.73
 w19143-s1	noun	점술에서, 팔문(八門)의 하나. 구궁(九宮)의 하나인 화성(火星)이 본자리가 되는 길한 문이다.
 w19200-s1	noun	점술에서, 팔문(八門)의 하나. 구궁(九宮)의 하나인 금성(金星)이 본자리가 되는 흉한 문이다.
lemma=순근하다 jaccard=0.71
 w198373-s1	adjective	성품이 순수하고 조심성이 많다.
 w452569-s1	adjective	성품이 순박하고 조심성이 많다.
lemma=개원 jaccard=0.81
 w389901-s2	noun	병원이나 학원 따위와 같이 ‘원(院)’ 자로 끝나는 기관이나 시설의 하루 업무가 시작됨. 또는 그 업무를 시작함.
 w389912-s2	noun	유치원이나 동물원 따위와 같이 ‘원(園)’ 자로 끝나는 기관이나 시설의 하루 업무가 시작됨. 또는 그 업무를 시작함.
lemma=괴기하다 jaccard=0.75
 w34346-s1	adjective	괴상하고 기이하다.
 w34347-s1	adjective	이상하고 기이하다.
lemma=잘팍대다 jaccard=0.73
 w276473-s2	verb	‘잘파닥대다01「2」’의 준말.
 w276476-s1	verb	‘잘파닥대다02’의 준말.
lemma=호박색 jaccard=0.7
 w376824-s1	noun	호박(琥珀)의 빛깔과 같이 진한 노란빛을 띤 주황색.
 w517489-s1	noun	늙은 호박의 빛깔과 같이 노란빛을 띤 주황색.
lemma=주간지 jaccard=0.71
 w309519-s1	noun	한 주일에 한 번씩 발행하는 잡지.
 w488886-s1	noun	한 주일에 한 번씩 발행하는 신문.
lemma=정자형 jaccard=1
 w289189-s1	noun	‘丁’ 자처럼 생긴 모양.
 w289190-s1	noun	‘井’ 자처럼 생긴 모양.
lemma=괴기 jaccard=0.71
 w34345-s1	noun	괴상하고 기이함.
 w402417-s1	noun	이상하고 기이함.
lemma=이성 jaccard=0.7
 w268023-s1	noun	성이 다름. 또는 다른 성.
 w268024-s1	noun	성질이 다름. 또는 다른 성질.
lemma=씌다 jaccard=0.7
 w210843-s1	verb	‘쓰이다03[1]「1」’의 준말.
 w455026-s1	verb	‘쓰이다01[1]「1」’의 준말.
## S3 lemma with >=20 records
lemma=기수 records=26
 w47275-s1	noun	행사 때 대열의 앞에 서서 기를 드는 일을 맡은 사람.
 w48144-s1	noun	저절로 오고 가고 한다는 길흉화복의 운수.
 w48145-s1	noun	어떤 사실의 시초.
 w48146-s1	noun	술이 발효하기 시작함.
 w48147-s1	noun	→ 치수이강.
 w48148-s1	noun	이미 일을 끝냄.
lemma=정사 records=25
 w292962-s1	noun	육십갑자의 쉰넷째.
 w292963-s1	noun	바른 법리(法理)를 보는 사람이라는 뜻으로, ‘보살01’을 달리 이르는 말.
 w292964-s1	noun	바른 일과 사악한 일을 아울러 이르는 말.
 w292965-s1	noun	사신 가운데 우두머리가 되는 사람. 또는 그런 지위.
 w292980-s1	noun	‘정치 결사’를 줄여 이르는 말.
 w292981-s1	noun	경치 좋은 곳에 정자 모양으로 지어 한가히 거처하는 집.
lemma=정 records=26
 w479733-s1	noun	예전에, 청(淸)의 1억분의 1이 되는 수를 이르던 말. 즉, 10⁻¹²⁸을 이른다. 모든 수 가운데 가장 작은 수를 나타냈다.
 w288739-s1	noun	뼛속에 있는 골수.
 w288743-s1	noun	중국 춘추 시대, 기원전 806년에 주나라 선왕(宣王)의 아우 환공(桓公)이 세운 나라. 지금의 산시성(陝西省) 화현(華縣)에 있다가 뒤에 허난성(河南省) 신정현(新鄭縣)으로 옮겼는데, 전국 시대 초기 기원전 375년에 한(韓)나라 애후(哀侯)에게 망하였다.
 w288744-s1	noun	알약을 세는 단위.
 w289598-s1	adverb	굳이 그러고자 하는 마음이 일어나는 모양.
 w289601-s1	noun	우리나라 성(姓)의 하나. 본관은 나주(羅州), 창원(昌原), 영광(靈光), 의성(義城) 등 10여 본이 현존한다.
## S4 non-verb records with >=10 senses
w493754 축 senses=11
 w493754-s1	noun	수레바퀴의 한가운데에 뚫린 구멍에 끼우는 긴 나무 막대나 쇠막대.
 w493754-s2	noun	둘둘 말도록 되어 있는 물건의 가운데 끼는 막대.
 w493754-s3	noun	활동이나 회전의 중심.
 w493754-s4	noun	가로로 길게 이어 돌돌 둥글게 만 종이. 편지나 그 밖의 글을 쓸 때 쓴다.
 w493754-s5	noun	회전 운동이나 직선 왕복 운동으로 동력을 전달하는 둥근 막대 모양의 기계 부품.
 w493754-s6	noun	물체가 회전 운동을 할 때에 그 물체의 중심에서 회전 운동의 중심이 된다고 가정하는 직선.
w403593 길 senses=10
 w403593-s1	noun	사람이나 동물 또는 자동차 따위가 지나갈 수 있게 땅 위에 낸 일정한 너비의 공간.
 w403593-s2	noun	물 위나 공중에서 일정하게 다니는 곳.
 w403593-s3	noun	걷거나 탈것을 타고 어느 곳으로 가는 노정(路程).
 w403593-s4	noun	시간의 흐름에 따라 개인의 삶이나 사회적·역사적 발전 따위가 전개되는 과정.
 w403593-s5	noun	사람이 삶을 살아가거나 사회가 발전해 가는 데에 지향하는 방향, 지침, 목적이나 전문 분야.
 w403593-s6	noun	어떤 자격이나 신분으로서 주어진 도리나 임무.
w483003 쭉쭉 senses=11
 w483003-s1	adverb	줄이나 금 따위를 잇따라 곧게 긋는 모양. ‘죽죽01「1」’보다 센 느낌을 준다.
 w483003-s2	adverb	여럿이 잇따라 고르게 늘어서거나 가지런히 벌여 있는 모양. ‘죽죽01「2」’보다 센 느낌을 준다.
 w483003-s3	adverb	여럿이 한 줄로 끊어지지 않고 이어지는 모양. ‘죽죽01「3」’보다 센 느낌을 준다.
 w483003-s4	adverb	종이나 천 따위를 여러 가닥으로 잇따라 찢는 모양. ‘죽죽01「4」’보다 센 느낌을 준다.
 w483003-s5	adverb	물 따위를 잇따라 단숨에 들이마시는 모양. ‘죽죽01「5」’보다 센 느낌을 준다.
 w483003-s6	adverb	잇따라 입으로 아주 힘차게 빠는 소리. 또는 그 모양. ‘죽죽01「6」’보다 센 느낌을 준다.
## S5 cross-record same-lemma exact gloss
lemma=전락하다
 w292881-s1	verb	아래로 굴러떨어지다.
 w292883-s1	verb	아래로 굴러떨어지다.
lemma=전질하다
 w294368-s1	verb	무엇에 걸리거나 헛디디거나 하여 굴러 넘어지다.
 w294370-s1	verb	무엇에 걸리거나 헛디디거나 하여 굴러 넘어지다.
lemma=천수
 w324542-s1	noun	타고난 수명.
 w490718-s1	noun	타고난 수명.
lemma=지향성
 w314524-s1	noun	의식이 어떤 대상을 향하는 작용 일반. 모든 의식은 항상 일정한 대상을 지향하고 있다고 파악된다.
 w485395-s2	noun	의식이 어떤 대상을 향하는 작용 일반. 모든 의식은 항상 일정한 대상을 지향하고 있다고 파악된다.
lemma=집주하다
 w319785-s3	verb	여러 사람의 주석을 한데 모으다.
 w320050-s1	verb	여러 사람의 주석을 한데 모으다.
lemma=전락
 w292882-s1	noun	아래로 굴러떨어짐.
 w482007-s1	noun	아래로 굴러떨어짐.
lemma=강병
 w10386-s1	noun	굳세고 강한 병사나 군대.
 w388716-s1	noun	굳세고 강한 병사나 군대.
lemma=반기
 w136383-s1	noun	반란을 일으킨 무리가 그 표시로 드는 기.
 w136387-s1	noun	반란을 일으킨 무리가 그 표시로 드는 기.
lemma=구수
 w36711-s1	noun	원한이 맺힐 정도로 자기에게 해를 끼친 사람이나 집단.
 w38017-s1	noun	원한이 맺힐 정도로 자기에게 해를 끼친 사람이나 집단.
lemma=육부
 w257215-s1	noun	뱃속에 있는 여섯 가지 기관. 위, 큰창자, 작은창자, 쓸개, 방광, 삼초를 이른다. 음식물을 받아들여 소화하고 영양분을 흡수하며 찌꺼기를 내려보내는 역할을 한다.
 w470522-s3	noun	뱃속에 있는 여섯 가지 기관. 위, 큰창자, 작은창자, 쓸개, 방광, 삼초를 이른다. 음식물을 받아들여 소화하고 영양분을 흡수하며 찌꺼기를 내려보내는 역할을 한다.
## S6 lemma=사전 (all records, all senses)
w164474 senses=1
 w164474-s1	noun	살아 있는 동안.
w164475 senses=1
 w164475-s1	noun	죽기를 각오하고 싸움. 또는 그런 싸움.
w164477 senses=2
 w164477-s1	noun	개인 소유의 논밭.
 w164477-s2	noun	조선 시대에, 나라에서 개인에게 조(租)를 받을 권리를 준 논밭. 귀족이나 관료, 공신에게 지급하였는데 과전(科田), 공전(功田), 별사전, 공해전, 직전(職田), 사전(賜田), 구분전, 사전(寺田) 따위가 있다.
w164478 senses=1
 w164478-s1	noun	개인의 사사로운 전보.
w164479 senses=1
 w164479-s1	noun	국가의 선전 포고 없이 개인이나 사사로운 단체가 외국에 대하여 전투를 하는 행위. 성격상 애국적인 행위일지라도 국제법에서는 범죄로 간주한다.
w164502 senses=2
 w164502-s1	noun	‘사천04’의 원말.
 w164502-s2	noun	개인이 위조한 가짜 돈.
w164503 senses=1
 w164503-s1	noun	저절로 돎.
w164504 senses=1
 w164504-s1	noun	일이 일어나기 전. 또는 일을 시작하기 전.
w164505 senses=1
 w164505-s1	noun	제사(祭祀)를 지내는 예전(禮典).
w164506 senses=1
 w164506-s1	noun	모래가 많이 섞인 밭.
w164508 senses=1
 w164508-s1	noun	베틀의 북 모양으로 두 끝이 가늘어져 뾰족하고 길쭉하게 생긴 밭.
w164509 senses=1
 w164509-s1	noun	작은 규모로 물건을 파는 집.
w164510 senses=1
 w164510-s1	noun	고려·조선 시대에, 임금이 내려 준 논밭. 주로 외교와 국방 따위의 분야에서 나라에 큰 공을 세운 왕족이나 벼슬아치에게 내려 주었으며, 세습이 되는 토지와 안 되는 토지가 있었다.
w173019 senses=1
 w173019-s1	noun	문헌 사료가 전혀 존재하지 않는 시대. 석기 시대와 청동기 시대를 이른다.
w173020 senses=2
 w173020-s1	noun	역사와 전기(傳記)를 아울러 이르는 말.
 w173020-s2	noun	역사에 전해진 기록.
w173021 senses=1
 w173021-s1	noun	절이 소유하고 있는 밭.
w438466 senses=1
 w438466-s1	noun	여러 가지 사항을 모아 일정한 순서로 배열하고 그 각각에 해설을 붙인 책. 최근에는 콤팩트디스크 따위와 같이 종이가 아닌 저장 매체에 내용을 담아서 만들기도 한다.
w438467 senses=1
 w438467-s1	noun	스승으로부터 전하여 받음.
w438468 senses=1
 w438468-s1	noun	국가적인 경사가 있을 때 죄인을 용서하여 놓아주던 일.
w438469 senses=1
 w438469-s1	noun	감사의 뜻을 나타내는 전보.
w438470 senses=1
 w438470-s1	noun	어떤 범위 안에서 쓰이는 낱말을 모아서 일정한 순서로 배열하여 싣고 그 각각의 발음, 의미, 어원, 용법 따위를 해설한 책. 최근에는 콤팩트디스크 따위와 같이 종이가 아닌 저장 매체에 내용을 담아서 만들기도 한다.
w444090 senses=1
 w444090-s1	noun	신라에서, 예부에 소속되어 사찰(寺刹)에 관한 일을 맡아보던 관아.
```

## 부록 D. 표본별 분류와 판단 근거

분류: (a) 진짜 중복 가능성, (b) 유의미한 용법/의미 차이, (c) 별개 동음이의어, (d) 불명확. 근거는 부록 C의 gloss·품사를 직접 비교한 것입니다.

### S0 — `w707` 가다 (sense 34, 전수)

(b) 34건 전부. s1·s3·s4·s30·s33은 이동의 목적·주체 차이, s12·s21은 작동, s9·s27·s28은 상태 변화, s24는 완곡 사망, s34는 진행을 나타내는 보조 용법이며 gloss 문자열이 서로 같은 쌍은 없습니다.

### S1 — 같은 record 안 유사 (≥0.7)

| lemma | ID | 분류 | 근거 |
| --- | --- | --- | --- |
| 궁관 | w41329-s1/s2 | (b) | 동궁(東宮) 소속과 궁전 소속은 다른 기관을 가리킴 |
| 걷다 | w14752-s2/s3 | (b) | 준말의 원형 `거두다02[1]「2」`와 `[2]`가 서로 다른 sense |
| 교훈적 | w34635-s1/s2 | (a) | 같은 뜻을 명사(`것.`)·관형사로 나눔, 품사 용법이 다름 |
| 도식주의적 | w85005-s1/s2 | (a) | 위와 동일(명사/관형사) |
| 기능적 | w47865-s1/s2 | (a) | 위와 동일 |
| 관조적 | w32931-s1/s3 | (a) | 위와 동일 |
| 단속적 | w74443-s1/s2 | (a) | 위와 동일 |
| 대여섯째 | w79233-s1/s2 | (a) | 명사/관형사 용법, 끝 `의.`만 다름 |
| 자 | w282064-s1/s3 | (a) | 수사/관형사 용법, 같은 수의 뜻 |
| 독창적 | w86012-s1/s2 | (a) | 명사/관형사 |
| 갈앉히다 | w5966-s1/s2 | (b) | 준말 원형 `가라앉히다[1]`과 `[2]「1」`이 서로 다른 sense |
| 가족적 | w3806-s2/s4 | (a) | 명사/관형사 |

(a) 9건은 모두 품사 칸이 다른 쌍입니다. 뜻은 같지만 UI에서 품사 구분 없이 합치면 품사 용법이 사라지므로 병합 후보가 아니라 **표시 규칙 후보**입니다.

### S2 — 같은 lemma, 다른 record, 유사 (≥0.7)

| lemma | ID | 분류 | 근거 |
| --- | --- | --- | --- |
| 중장년 | w535715-s1 / w536216-s1 | (c) | `장년01(壯年)`과 `장년02(長年)` 참조가 다름 |
| 경문 | w19143-s1 / w19200-s1 | (c) | 화성·길한 문 vs 금성·흉한 문 |
| 순근하다 | w198373-s1 / w452569-s1 | (d) | 순수 vs 순박만 다름, 같은 뜻의 변이형인지 원본 확인 필요 |
| 개원 | w389901-s2 / w389912-s2 | (c) | 院 vs 園 |
| 괴기하다 | w34346-s1 / w34347-s1 | (c) | 괴상 vs 이상, 별개 어휘 |
| 잘팍대다 | w276473-s2 / w276476-s1 | (c) | 준말 원형이 `잘파닥대다01`과 `02` |
| 호박색 | w376824-s1 / w517489-s1 | (c) | 호박(琥珀)과 늙은 호박 |
| 주간지 | w309519-s1 / w488886-s1 | (c) | 잡지 vs 신문 |
| 정자형 | w289189-s1 / w289190-s1 | (c) | 丁 vs 井 |
| 괴기 | w34345-s1 / w402417-s1 | (c) | 괴상 vs 이상 |
| 이성 | w268023-s1 / w268024-s1 | (c) | 성(性) vs 성질 |
| 씌다 | w210843-s1 / w455026-s1 | (c) | 준말 원형이 `쓰이다03`과 `01` |

### S3 — record 20개 이상 lemma

| lemma | 분류 | 근거 |
| --- | --- | --- |
| 기수 | (c) | 기수(旗手)·운수·시초·발효 시작·치수이강 참조 등 gloss가 서로 무관한 동음 |
| 정사 | (c) | 육십갑자, 보살, 정치 결사 준말, 정자 모양의 집 등 전혀 다른 어휘 |
| 정 | (c) | 수의 단위, 골수, 나라 이름, 알약 단위, 부사, 성씨 등 서로 무관 |

### S4 — sense 10개 이상 비동사 record

| record | 분류 | 근거 |
| --- | --- | --- |
| w493754 축 (11) | (b) | 막대·중심·두루마리·부품·직선 등 비유와 전문어로 확장된 서로 다른 뜻 |
| w403593 길 (10) | (b) | 공간·노정·과정·방향·도리로 확장된 서로 다른 뜻 |
| w483003 쭉쭉 (11) | (b) | `죽죽01「n」보다 센 느낌` 형식만 반복되고 대상 동작이 모두 다름 |

### S5 — 같은 lemma, 다른 record, 정확히 같은 gloss

| lemma | ID | 분류 | 근거 |
| --- | --- | --- | --- |
| 전락하다 | w292881-s1 / w292883-s1 | (a) | gloss 동일 |
| 전질하다 | w294368-s1 / w294370-s1 | (a) | gloss 동일 |
| 천수 | w324542-s1 / w490718-s1 | (a) | gloss 동일 |
| 지향성 | w314524-s1 / w485395-s2 | (a) | gloss 동일 |
| 집주하다 | w319785-s3 / w320050-s1 | (a) | gloss 동일 |
| 전락 | w292882-s1 / w482007-s1 | (a) | gloss 동일 |
| 강병 | w10386-s1 / w388716-s1 | (a) | gloss 동일 |
| 반기 | w136383-s1 / w136387-s1 | (a) | gloss 동일 |
| 구수 | w36711-s1 / w38017-s1 | (a) | gloss 동일 |
| 육부 | w257215-s1 / w470522-s3 | (a) | gloss 동일 |

(a)는 gloss가 같다는 사실만으로 중복 가능성이 있다는 뜻이며, 같은 어형의 별개 원본 record(한자 근거 등)일 수 있습니다. 원본의 구별 근거는 canonical에 없으므로 확인하지 못했습니다. 위 10건은 모두 어느 한쪽 sense에 관계(`relations` 출·입)가 있음을 표본 추출 때 확인했습니다. 쌍 사이가 서로 연결된 관계인지는 전수 확인하지 않았습니다.

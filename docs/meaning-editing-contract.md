# Meaning 편집 계약 (Issue #715 Pilot)

`data/canonical/`의 STDICT sense를 Typewriter 사용자(작가)가 탐색하기 좋은 **meaning 단위**로 편집하는 전량 작업의 계약이다.
저장/검증 구조는 [meaning-layer.md](meaning-layer.md), 초기 투영은 #714가 만든 `1 sense = 1 meaning` 상태다.

## 판정

| 판정 | 의미 | 결과 |
| --- | --- | --- |
| KEEP | 사용자 관점에서 독립된 의미축 | 초기 meaning 그대로 둔다 |
| GLOSS EDIT | 독립 의미는 유지하되 source gloss가 작가에게 뜻을 바로 보여 주지 않는 교차참조 등이다 | meaning ID와 sense 결합을 유지하며 meaning-layer gloss만 직접 설명으로 고친다 |
| MERGE | 같은 의미축의 여러 sense | 하나의 meaning으로 합치고 **포함 sense 전체를 대표하는 새 gloss**를 쓴다 |
| DROP `duplicate` | 같은 lemma의 canonical sense와 의미가 명백히 중복 | `data/meanings/`에서 제외하고 `data/adjudication/`에 생존 sense인 `duplicate_of`를 기록한다 |
| DROP `out_of_scope` | 현재 Typewriter 제품 Meaning 수록 범위 밖이라는 개별 판정 | `data/meanings/`에서 제외하고 `data/adjudication/`에 기록한다. `duplicate_of`는 두지 않는다 |

원본 sense/gloss는 canonical에 그대로 남는다. canonical은 수정하지 않는다. GLOSS EDIT는 source-bound meaning-layer gloss 편집이며 source sense나 sense 결합은 바꾸지 않는다.

## 편집 원칙

1. **의미가 품사·문법 구분보다 우선한다.** 보조 용법(`~다 보다`, `~게 하다`)도 의미축이 같으면 합친다.
2. **같은 lemma의 모든 record/sense를 함께 본다.** 한 record만 보고 판정하지 않는다.
3. **사전학적 미세 구분**(목적·대상·수단만 다른 경우)은 작가에게 같은 뜻이면 MERGE한다. 반대로 **방향이 반대**(작동 ↔ 꺼짐), **관용·완곡 용법**(죽다, 대소변), **독립 지시 대상**은 합치지 않는다.
4. 합친 gloss는 대표 의미를 앞에 쓰고, 합쳐진 하위 용법을 문장 안에서 "~을 포함한다"로 열거한다. 새 문장을 지어내지 않고 원 gloss의 어휘를 쓴다.
5. **같은 lemma라면 record 경계와 무관하게** 실제 의미가 같을 때 MERGE할 수 있다(한 meaning이 여러 record의 sense를 참조). 다른 lemma의 sense는 합치지 않는다. 합친 meaning의 id record 번호는 구성 sense 중 가장 낮은 record 번호이며(데이터셋 검증기가 강제), `apply-edits`는 `sense_ids`를 canonical 순서로 나열한다. 의미가 다른 동음이의어는 합치지 않는다.
   **완전히 중복된 source sense**(gloss·의미가 사실상 동일)는 MERGE가 아니라 DROP `duplicate`로 처리한다.
6. DROP `duplicate`는 gloss와 의미가 사실상 동일한 sense만 대상으로 하며, `duplicate_of`는 그 자신이 DROP되지 않아야 한다. DROP `out_of_scope`는 현재 제품 대상이 아니라는 판정이다. 이는 source sense에 의미나 가치가 없다는 뜻이 아니며 canonical은 보존한다. `c20`이라는 이유만으로 자동 제외하지 않고 개별 판정을 기록한다.
7. MERGE 대표 id는 **canonical 순서상 첫 구성원의 meaning id**(`mNNN_K`)다. 번호가 연속일 필요는 없다.

## 도구와 절차

- 편집 지시는 JSON 스펙(`{ glosses: [{ sense_id, gloss }], merges: [{ senses: [sense id, ...], gloss }], drops: [{ sense_id, reason?, duplicate_of? }] }`)이다. DROP 사유 생략은 `duplicate`로 취급한다. `duplicate`는 유효한 `duplicate_of`가 필요하고, `out_of_scope`는 `duplicate_of`를 금지한다. `glosses`는 아직 MERGE되지 않은 한 sense meaning의 gloss를 고치며 ID와 sense binding은 보존한다. `node scripts/meaning/apply-edits.mjs <spec.json>`가 적용한다.
- 적용은 제자리 편집이며, 한 lemma 편집이 무관한 shard를 재배치하지 않는다.
- 잘못된 스펙(1개 sense 병합, 이미 병합/DROP된 sense, 중복 편집, 존재하지 않는 sense, 빈 gloss, 다른 lemma 병합, 같은 record든 다른 record든 존재하지 않거나 이미 DROP된 `duplicate_of`, `out_of_scope`에 포함한 `duplicate_of`, 잘못된 reason)은 **전체를 거부**하고 일부만 적용하지 않는다. 마지막 Meaning shard의 모든 행을 DROP하면 빈 파일 대신 shard 파일을 제거한다.
- 적용 후 `node scripts/meaning/validate.mjs`(complete)로 모든 canonical sense가 정확히 하나의 meaning에 있거나 DROP 기록이 있음을 확인한다.
- 스펙 파일은 편집 이력으로 보존한다 (`scripts/meaning/pilot-715.json`).

## 전량 작업용 지침(프롬프트)

> 한 lemma의 모든 record와 sense를 먼저 나열한다. 각 sense를 **작가가 찾는 의미축** 기준으로 묶는다.
> 같은 축이면 MERGE(대표 gloss를 새로 쓴다), 독립이면 KEEP한다. 독립 의미라도 source gloss가 뜻을 직접 설명하지 않는 교차참조 등이라면 source-bound GLOSS EDIT를 기록한다. 다른 record에 gloss가 사실상 동일한 sense가 있으면 DROP duplicate.
> 품사·문법 용법 차이는 이유가 되지 않는다. 방향이 반대이거나 관용 용법이면 합치지 않는다.
> 같은 lemma의 sense라면 record가 달라도 실제 의미가 같을 때 합칠 수 있다(다른 lemma는 불가). gloss까지 완전히 중복이면 MERGE가 아니라 DROP duplicate다. 제품 수록 범위 밖이라는 명시적 편집 결정은 `DROP out_of_scope`로 별도 기록하며, 이것을 `duplicate`로 위장하거나 `c20` 전체에 자동 적용하지 않는다. 확신이 없으면 KEEP한다.
> 출력은 `apply-edits` 스펙(JSON)이며 gloss는 포함하는 모든 sense를 빠짐없이 대표해야 한다.

## Pilot 결과

| lemma | 편집 전 → 후 | 비고 |
| --- | --- | --- |
| 가다 (`w707`, 34 sense) | 37 → 23 meaning | 이동·소속 이동·이전·상태 생김·방향/흐름·작동·손상·때/시간·유지/진행을 MERGE. 꺼짐·죽음·혼미·이해·정도·얼룩·내기는 KEEP |
| 하다 (`w363685`, 45 sense) | 45 → 28 | 행위·장만·갖춤·직책·말함·삼음·덧붙임/나열·인용·이유·희망·강조·태도를 MERGE. 조건·역접/결과 접속(`s33`)·대립(`s34`)·사동·필요·반복·소리 등은 KEEP |
| 보다 (`w149229`, 39 sense) | 40 → 26 | 시각·읽기·살핌·만남·돌봄·판단·경험·맛보기·결점·깨달음 보조를 MERGE |
| 사전 (25 meaning, 22 record) | 25 → 24 | 동음이의어 record는 전부 서로 다른 한자어이므로 KEEP. 같은 record의 `역사 기록`/`역사와 전기`(`w173020`)만 MERGE |
| 강피밥·강피죽 (record 2개씩) | 각 2 → 1 | 같은 lemma의 다른 record가 사실상 같은 뜻(`피로만 지은 밥`/`강피로 지은 밥` 등)이라 record 경계를 넘어 MERGE (`w9066`+`w9067`, `w9069`+`w389079`) |
| 전락하다 (2 record) | 3 → 2 | `w292883-s1`은 `w292881-s1`과 gloss·동의어 관계가 모두 동일 → DROP duplicate |

### Pilot에서 확인한 경계 사례와 판정

- **record 경계**: 같은 lemma의 의미가 같은 sense는 record가 달라도 MERGE한다(`강피밥`, `강피죽`). 의미가 완전히 같은 중복(`전락하다`)은 MERGE가 아니라 DROP duplicate다.
- **접속 기능(`하다`)**: 문법 범주가 같다는 이유로 합치지 않는다. 덧붙임(`s22`)과 나열(`s27`)은 글의 논리 방향이 같아 MERGE, 대립(`s34`)과 역접·결과·조건을 섞은 접속어(`s33`)는 방향이 달라 각각 KEEP. 문법 분류가 같다는 이유만으로 의미를 일괄 합치는 지침을 전량 작업에 확장하지 않는다.
- **조건 vs 이유(`하다`)**: 문법 기능이 비슷해 보이나 의미축이 다르다. 조건(`s30`)은 KEEP, 이유(`s40`,`s45`)만 MERGE.
- **경유 vs 시기 도달(`하다`)**: 단어 의미가 달라 KEEP.
- **작동 ↔ 꺼짐(`가다`)**: 방향이 반대이므로 합치지 않는다.
- **보조 용법의 처리(`보다`, `하다`, `가다`)**: 같은 의미축이면 본동사와 합치지 않고 보조 용법끼리 묶거나 가까운 본동사 축에 포함한다. 새 meaning 유형을 만들지 않는다.
- **사전 `‘사천04’의 원말`**: 참조형 gloss이지만 독립 지시 대상이므로 KEEP. (참조형 gloss 처리는 전량 작업에서 별도 사례가 나오면 판단한다.)

### 전량 편집에서 확인한 경계 사례

- **서로 다른 계수 단위(`짝`, Issue #716 c14)**: `w316196-s1`~`s4`는 모두 명사이자 계수 단위지만, 갈비 묶음·상자/짐짝·짐의 한쪽 편·북어/명태 600마리처럼 세는 대상과 단위 크기가 다르므로 각각 KEEP한다. 같은 문법 기능만으로 MERGE하지 않는다. 다른 계수 단위를 MERGE하려면 실제 세는 대상과 단위가 같다는 원문 근거를 확인한다.

## 리뷰 기록 (정직한 표기)

이 pilot의 작성·1차·2차 검토는 **모두 작성 agent 한 명이 수행한 자체 점검**이며 독립 리뷰가 아니다 (구현 subagent 금지 지침). 독립 Stage 1/2 PR 리뷰는 `REVIEW.md`를 따라 PR에서 별도로 이뤄진다.

- **1차 점검(과/부족 MERGE, 누락, 잘못된 DROP, gloss 포괄성)**: 전체 sense가 정확히 한 meaning에 속함을 `validate.mjs`(complete)로 확인했다. 점검 결과 `하다`의 조건·이유 합병과 경유·시기 도달 합병이 과합병으로 판단되어 분리했다. 합친 gloss는 구성 sense의 핵심어를 모두 포함하는지 눈으로 대조했다.
- **2차 점검(작가 관점의 자연스러움)**: `가다`·`보다`는 축이 소수로 정리되어 자연스러우며, `하다`의 문법 용법군은 `~다고 하다`류 인용·접속·이유·희망으로 정리되었다. 독립 검토에서 추가 지적이 나오면 스펙을 수정해 다시 적용한다.

## 전량 작업 진행 기록 (#716)

전량 편집은 초성 code 단위 PR로 나누어 진행하며, 각 PR의 스펙은 `scripts/meaning/<code>-716.json`로 보존한다. 체크리스트의 완료 표시는 해당 code PR이 병합된 뒤 이슈에서 갱신한다.

### c07 (ㅁ)

- 범위: `c07_001`~`c07_029`, lemma 21,912개 · meaning 28,572개. meaning이 하나뿐인 lemma(18,324개)는 편집할 합류 대상이 없으므로 KEEP이다.
- 검토 대상: 둘 이상의 meaning을 가진 lemma 3,588개 가운데, 같은 record에 여러 sense가 있거나 서로 다른 record 사이에 gloss가 유사한(어휘 bigram 겹침 ≥ 0.4) 2,606개 lemma(7,873 meaning)를 gloss 단위로 전수 검토했다. 나머지 982개 lemma는 서로 gloss가 겹치지 않는 다른 record(동음이의어)뿐이어서 KEEP이다.
- 결과: MERGE 533건(sense 1,099개 → meaning 533개), DROP `duplicate` 4건(`w110025-s1`, `w423316-s1`, `w114811-s2`, `w121660-s1`). 28,572 → 28,002 meaning (28,572 − (1,099 − 533) − 4). 스펙: `scripts/meaning/c07-716.json`, DROP 기록: `data/adjudication/c07_001.jsonl`.
- 새로 확인한 경계 사례와 판정:
  - **수사/관형사 쌍**(`마흔`, `만`, `막`의 수·수의): 품사 차이만이므로 MERGE한다. 같은 이유로 `~적`의 `것`/`관형` 쌍, `~하다`·`~히`·`~되다` 파생형의 `(명사)`/`(관형)` 쌍도 합친다.
  - **"매~/마다" 쌍**(`매년`, `매월` 등의 `한 해 한 해`/`해마다`): 같은 의미축이므로 MERGE한다.
  - **record 경계를 넘는 동일 의미**(`묘만`, `묘묘하다`, `밀소`, `묘표`, `무정형` 등): 같은 lemma이므로 MERGE한다. gloss가 글자 그대로 같은 경우(`만수`, `만언`, `명월`, `무상하다`)는 DROP `duplicate`로 처리한다.
  - **형태소 변이 군**(`몽그작거리다`·`몽긋대다`·`뭉그적뭉그적` 등): 한 lemma 안에서 거의 같은 두 sense(`게으르게 행동`/`비비대다`)를 합친다.
  - **기호와 그것이 나타내는 대상**: 기호(부호·표기)와 그 기호가 나타내는 연산·수량·행위는 원천 sense가 구별하면 별도 meaning으로 둔다(`마이너스`의 `뺄셈을 함`/`뺄셈의 부호`, `0보다 작은 일`/`음수 부호`, `말`의 음성 기호 체계/말하는 행위). 주제가 관련되는 것만으로는 같은 meaning의 근거가 되지 않는다(PR 리뷰 반영).
  - **지시 대상이 다른 환유 관계**: 장소·자리와 거기 모인 사람(`만장`, `만좌`, `만조`, `만당`), 장사(행위)·장수와 가게(`목상`, `미곡상`, `만물상`), 노래와 부르는 사람(`명창`), 사람의 입·말과 사람 자체(`만구`), 실제 신체 부위와 그에 빗댄 물건의 부분(`목`), 실제 맥박과 맥박처럼 움직이는 것(`맥동`), 실제 물결과 물결 같은 무늬(`물무늬`), 꿈속과 꿈 같은 기분(`몽유`), 식물 마디·뼈 관절·줄 매듭·몸 체절(`마디`, `마디마디`)처럼 연관은 있어도 작가가 가리키는 대상이 다르면 합치지 않는다. 원천 한 sense가 두 대상을 함께 적은 경우는 그 sense를 쪼개지 않고 그대로 둔다. 목록을 gloss에 나열해도 같은 의미축이 되지 않는다(PR 리뷰 반영).
  - 비유 용법(`마비`, `무쇠`), 관용 구, 반대 방향(`말끝`의 `끝`/`첫머리`), 지칭 대상이 다른 동음이의어는 합치지 않는다.
- 합친 gloss는 대표 의미를 앞에 두고 하위 용법을 "~을 포함한다"로 열거했으며, 원 gloss의 어휘만 사용했다. gloss가 잘려 확인할 수 없던 긴 gloss의 쌍은 확신이 없어 KEEP했다.

### 리뷰 기록 (정직한 표기, c07)

작성·1차·2차 점검은 모두 작성 agent 한 명의 **자체 점검**이며 독립 리뷰가 아니다(구현 subagent 금지 지침).

- **1차 점검**: lemma를 순회하며 같은 lemma의 모든 record/sense를 대조해 KEEP/MERGE/DROP을 판정했다. 한 번에 합치기 어려운 사례(조건/결과 접속 등)는 KEEP했다.
- **2차 점검**: 적용 후 `node scripts/meaning/validate.mjs`(complete)와 `scripts/meaning` 테스트, 병합 gloss 무작위 표본(길이·문장 반복 확인)으로 확인했다. 정확히 같은 gloss가 다른 sense에 남아 있는지(`dups`)와 record 간 유사도 0.8 이상 쌍도 따로 점검했다. 유사하지만 의미가 다른 쌍(`매표`의 `삼`/`팖`, `밀매`의 `팖`/`삼`, 숫자만 다른 `민봉`)은 KEEP이다.
- 독립 Stage 1/2 PR 리뷰는 `REVIEW.md`에 따라 PR에서 별도로 이뤄진다.

### c13 (ㅈ)

- 범위: `c13_001`~`c13_059`, lemma 39,935개 · meaning 58,732개. 기존 pilot DROP `w292883-s1`은 보존했다.
- 결과: MERGE 284건(568 sense → 284 meaning), 새 DROP `duplicate` 23건. `c13`은 58,732 → 58,425 meaning, adjudication은 1 → 24건이다. 스펙은 `scripts/meaning/c13-716.json`이며, canonical 원본은 바꾸지 않았다.
- 후보 검토: 같은 POS의 gloss 어휘 토큰 Jaccard가 0.5 이상인 318개 lemma 그룹을 원문 sense 기준으로 확인했다. 이와 별도로 `것`/`수`/`수의` 정의가 정확히 맞는 명사·관형 쌍 206개와, 단단한 물체의 충돌 소리에서 일반 충돌과 서로 걸리는 물체의 충돌만 다른 42쌍을 확인했다. 처음 기록한 19개 DROP은 gloss가 같고 canonical의 direct 연결도 있는 중복이었다. Stage 2 피드백에서 `조식`, `중대문`, `중도`, `지상`의 같은 lemma·같은 품사·완전히 같은 source gloss 4쌍을 추가로 확인해, direct 관계 유무를 DROP 조건으로 삼지 않고 `duplicate`로 adjudicate했다. 추가 source-bound 피드백에서 `중자`의 세 아들 중 둘째라는 구체 조건만 gloss에 남아 일반적인 `둘째 아들` 원뜻을 좁힌 점을 확인했다. MERGE는 유지하고 일반 뜻을 먼저 쓴 뒤 세 아들 사례를 덧붙였다. 같은 넓은 뜻·하위 용례 패턴인 `재질`과 `정화하다`를 대조했고, 각각 일반적인 재료의 성질과 정다운 대화를 유지하면서 목재 및 남녀 간 대화를 하위 사례로 포괄함을 확인했다. `주집`도 다시 대조했으며, `한군데로`는 모임의 지시 대상을 제한하는 별도 조건이 아니라 canonical gloss의 모임·모여듦을 구체화하는 표현으로 판단했다. 이 추가 점검도 해당 후보 패턴에 한정하며 284개 MERGE의 전수 의미 재검토를 뜻하지 않는다. 이 후보 범위 밖의 저유사도 다중 meaning lemma는 개별 대조하지 않고 KEEP으로 두었다.
- 새 경계 사례: 소리의 대상만 일반 물체에서 서로 걸리는 단단한 물체로 좁혀지는 쌍은 같은 충돌 소리 meaning으로 MERGE했다. 잠금쇠가 잠기거나 열리는 소리, 끈기 있는 물체가 달라붙는 소리, 주체가 받음/전함처럼 방향이 반대인 sense는 구분을 유지했다. 직함의 시대·기관 차이, 가족 호칭의 지칭 대상 차이도 KEEP했다.

### 리뷰 기록 (정직한 표기, c13)

작성·1차·2차 점검은 모두 작성 agent 한 명의 자체 점검이며 독립 리뷰가 아니다. 1차에는 위의 선별 후보 sense를 같은 lemma의 record 전체와 대조해 MERGE/DROP/KEEP 및 gloss 범위를 확인했다. 2차에는 편집 스펙을 다시 source ID·lemma별로 대조하고 `node scripts/meaning/validate.mjs`로 완전성 및 참조 무결성을 확인했다. 후보 범위 밖은 미검토가 아니라 KEEP으로 처리했지만, 낮은 gloss 유사도의 숨은 합병 후보가 남을 수 있다. 독립 PR 리뷰는 `REVIEW.md`의 경계를 따른다.

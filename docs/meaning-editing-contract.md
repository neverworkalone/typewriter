# Meaning 편집 계약 (Issue #715 Pilot)

`data/canonical/`의 STDICT sense를 Typewriter 사용자(작가)가 탐색하기 좋은 **meaning 단위**로 편집하는 전량 작업의 계약이다.
저장/검증 구조는 [meaning-layer.md](meaning-layer.md), 초기 투영은 #714가 만든 `1 sense = 1 meaning` 상태다.

## 판정

| 판정 | 의미 | 결과 |
| --- | --- | --- |
| KEEP | 사용자 관점에서 독립된 의미축 | 초기 meaning 그대로 둔다 |
| MERGE | 같은 의미축의 여러 sense | 하나의 meaning으로 합치고 **포함 sense 전체를 대표하는 새 gloss**를 쓴다 |
| DROP | 명백한 `duplicate`만 | `data/meanings/`에서 제외하고 `data/adjudication/`에 근거(`duplicate_of`)를 기록한다 |

원본 sense/gloss는 canonical에 그대로 남는다. canonical은 수정하지 않는다.

## 편집 원칙

1. **의미가 품사·문법 구분보다 우선한다.** 보조 용법(`~다 보다`, `~게 하다`)도 의미축이 같으면 합친다.
2. **같은 lemma의 모든 record/sense를 함께 본다.** 한 record만 보고 판정하지 않는다.
3. **사전학적 미세 구분**(목적·대상·수단만 다른 경우)은 작가에게 같은 뜻이면 MERGE한다. 반대로 **방향이 반대**(작동 ↔ 꺼짐), **관용·완곡 용법**(죽다, 대소변), **독립 지시 대상**은 합치지 않는다.
4. 합친 gloss는 대표 의미를 앞에 쓰고, 합쳐진 하위 용법을 문장 안에서 "~을 포함한다"로 열거한다. 새 문장을 지어내지 않고 원 gloss의 어휘를 쓴다.
5. **같은 lemma라면 record 경계와 무관하게** 실제 의미가 같을 때 MERGE할 수 있다(한 meaning이 여러 record의 sense를 참조). 다른 lemma의 sense는 합치지 않는다. 합친 meaning의 id record 번호는 구성 sense 중 가장 낮은 record 번호이며(데이터셋 검증기가 강제), `apply-edits`는 `sense_ids`를 canonical 순서로 나열한다. 의미가 다른 동음이의어는 합치지 않는다.
   **완전히 중복된 source sense**(gloss·의미가 사실상 동일)는 MERGE가 아니라 DROP `duplicate`로 처리한다.
6. DROP은 gloss가 사실상 동일한 sense만 대상이다. `duplicate_of`는 그 자신이 DROP되지 않아야 한다. 판단이 갈리면 KEEP한다(누락보다 보존).
7. MERGE 대표 id는 **canonical 순서상 첫 구성원의 meaning id**(`mNNN_K`)다. 번호가 연속일 필요는 없다.

## 도구와 절차

- 편집 지시는 JSON 스펙(`{ merges: [{ senses: [sense id, ...], gloss }], drops: [{ sense_id, duplicate_of }] }`)이다. `node scripts/meaning/apply-edits.mjs <spec.json>`가 적용한다.
- 적용은 제자리 편집이며, 한 lemma 편집이 무관한 shard를 재배치하지 않는다.
- 잘못된 스펙(1개 sense 병합, 이미 병합/DROP된 sense, 중복 편집, 존재하지 않는 sense, 빈 gloss, 다른 lemma 병합, 같은 record든 다른 record든 존재하지 않거나 이미 DROP된 `duplicate_of`, 잘못된 reason)은 **전체를 거부**하고 일부만 적용하지 않는다.
- 적용 후 `node scripts/meaning/validate.mjs`(complete)로 모든 canonical sense가 정확히 하나의 meaning에 있거나 DROP 기록이 있음을 확인한다.
- 스펙 파일은 편집 이력으로 보존한다 (`scripts/meaning/pilot-715.json`).

## 전량 작업용 지침(프롬프트)

> 한 lemma의 모든 record와 sense를 먼저 나열한다. 각 sense를 **작가가 찾는 의미축** 기준으로 묶는다.
> 같은 축이면 MERGE(대표 gloss를 새로 쓴다), 독립이면 KEEP, 다른 record에 gloss가 사실상 동일한 sense가 있으면 DROP duplicate.
> 품사·문법 용법 차이는 이유가 되지 않는다. 방향이 반대이거나 관용 용법이면 합치지 않는다.
> 같은 lemma의 sense라면 record가 달라도 실제 의미가 같을 때 합칠 수 있다(다른 lemma는 불가). gloss까지 완전히 중복이면 MERGE가 아니라 DROP duplicate다. 확신이 없으면 KEEP한다.
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

## 리뷰 기록 (정직한 표기)

이 pilot의 작성·1차·2차 검토는 **모두 작성 agent 한 명이 수행한 자체 점검**이며 독립 리뷰가 아니다 (구현 subagent 금지 지침). 독립 Stage 1/2 PR 리뷰는 `REVIEW.md`를 따라 PR에서 별도로 이뤄진다.

- **1차 점검(과/부족 MERGE, 누락, 잘못된 DROP, gloss 포괄성)**: 전체 sense가 정확히 한 meaning에 속함을 `validate.mjs`(complete)로 확인했다. 점검 결과 `하다`의 조건·이유 합병과 경유·시기 도달 합병이 과합병으로 판단되어 분리했다. 합친 gloss는 구성 sense의 핵심어를 모두 포함하는지 눈으로 대조했다.
- **2차 점검(작가 관점의 자연스러움)**: `가다`·`보다`는 축이 소수로 정리되어 자연스러우며, `하다`의 문법 용법군은 `~다고 하다`류 인용·접속·이유·희망으로 정리되었다. 독립 검토에서 추가 지적이 나오면 스펙을 수정해 다시 적용한다.

## 전량 재편집 결과: c08 (Issue #716, 초성 ㅂ)

- 범위: `data/meanings/c08_001..043.jsonl`. 다의 lemma 약 5,980개를 record·sense 전체 단위로 검토해 KEEP / MERGE / DROP을 판정했고, canonical 데이터는 변경하지 않았다.
- 결과: 42,590 → 41,024 meaning (MERGE 1,442건, DROP duplicate 10건 → `data/adjudication/c08_001.jsonl`). 스펙은 `scripts/meaning/spec-716-c08.json`으로 편집 이력에 보존한다.
- 주요 MERGE 유형: 같은 의미의 품사·용법 쌍(명사/관형사 용법 `-적`, 부사/형용사형), 같은 계열 의성·의태어, 같은 lemma 안의 거의 동일한 record 간 gloss, 같은 의미축의 비유·확장 용법.
- 항상 KEEP: 동음이의 한자어, 고유명사(인물·지명), 반대 의미, 독립 지시 대상, 참조형 gloss(‘준말’·‘→’) — 참조 대상 sense가 합쳐진 경우에도 별도 meaning으로 둔다. 확신이 없으면 KEEP.
- 자체 점검(정직한 표기): 판정·1차·2차 점검은 모두 작성 agent 한 명의 자체 점검이며 독립 리뷰가 아니다. 1차: `apply-edits`가 모든 충돌(중복 사용·다른 lemma·이미 합쳐진 meaning·DROP 대상)을 거부함을 확인하고 한 건의 sense id 오기를 수정했다. 2차: `validate.mjs`(complete)와 `node --test scripts/meaning/*.test.mjs`(32건)를 통과했다. 독립 Stage 1/2 리뷰는 PR에서 `REVIEW.md`에 따라 별도로 이뤄진다.

# D V7 절차 — 문맥 결속 · 감사 원장 · 전량 재판정

이 문서는 Issue #1106의 **D V7** 실험 절차다. 특정 단어의 예외 목록이나 후보 수 목표를 두지 않는다. D는 문어 말뭉치의 실제 용례에서 출발 sense의 쓰임을 확인하고, 그 문맥이 지지하는 표현만 후보로 남긴다. 다른 방식(A/B/C)이나 다른 생산자의 후보·평가 결과는 읽지 않는다.

## 0. 실행 상태

- 모드: `CALIBRATION`
- 데이터: `data/canonical/stdict-0016.jsonl` 1–500행, 500 records / 565 senses (개발용, 비블라인드)
- 기준선: V6(`experiments/1061/v6/`)의 668개 후보를 감사 입력으로만 사용한다. 자동 KEEP하지 않는다.
- 검색 자료: 로컬 문어 말뭉치 SQLite(읽기 전용)와 V6에서 만든 sense별 검색·보충 결과. 원문·검색 로그·감사 원장은 Git에 넣지 않는다.

## 1. Preflight

1. Canonical 1–500행의 record 순서와 모든 sense를 고정하고, record 수와 sense 수를 센다.
2. `manifest.json`에 sense별 `gloss_sha256`, 문맥 수, 기존 후보 수를 기록한다.
3. 검색은 V6의 기본 검색과 `하다/되다` 어간·활용형 보충 검색 결과를 사용한다. 표제어·검색형·어간이 실제 문단에 나타난 문맥만 후보 문맥으로 삼는다.
4. sense마다 서로 다른 문서를 우선해 최대 16문맥을 준비한다(가능하면 문서당 2문맥 이하).
5. 검색 실패·문맥 없음은 `zero_hits`로 기록하며, 이는 해당 검색 경로의 미검출이지 말뭉치 전체 부재의 증명이 아니다.
6. 실행 전 파일: `experiments/1061/v7/D_PROCEDURE.md`. 결과 파일: 같은 폴더의 Candidate JSONL과 `RUN.md`.

## 2. PASS 1 — 검색과 sense 결속

각 sense마다 준비된 문맥을 실제로 읽고 다음 중 하나로 판정한다.

- `V`(VERIFIED): 그 문맥이 정확히 이 sense로 쓰였다는 긍정 증거가 있다.
- `A`(AMBIGUOUS): 둘 이상의 sense가 가능해 확정할 수 없다.
- `R`(REJECTED): 다른 sense, 동음이의어, 다른 단어의 활용형, 부분 문자열 오탐 등이다.

판정에는 짧은 증거 문구를 붙인다. 표제어 토큰이 같다는 사실만으로 V가 되지 않는다. 동음이의어·다른 품사·다른 단어(예: `견주`와 `견주다`)를 구별한다. `V` 수는 읽은 문맥 수나 창 크기와 별도로 센다.

문맥은 1–4, 5–8, 9–12, 13–16의 순서로 읽는다. 준비된 문맥을 모두 읽으면 `inspected_16` 또는 `inspected_all`로 기록한다. V 문맥이 하나도 없으면 `no_verified_context`, 문맥 자체가 없으면 `zero_hits`다. 중단된 sense는 `INCOMPLETE`로 남기고 `[]`로 가장하지 않는다.

## 3. PASS 2 — 발굴

각 `V` 문맥에서 다음 다섯 관점을 각각 확인하고, 발견 여부를 5비트(`coll,act,scene,cause,assoc`)로 기록한다.

1. `coll`: 자연스러운 결합 표현·관용적 어구
2. `act`: 행동·사건·참여자 역할
3. `scene`: 구체적 상황·장면·시간·장소
4. `cause`: 원인·결과·파생 상태
5. `assoc`: 대비·연상·감각·이미지

관점마다 발견한 **독립 관계**를 적고, 같은 관계를 표현만 바꾼 중복은 후보로 세지 않는다. 후보 수의 하한·상한은 없다. 같은 문서에 같이 나온 사물·인물은 관계 경로를 설명할 수 없으면 제외한다. 표제어를 그대로 반복하는 후보는 제외한다. 표제어를 포함한 결합 표현은 독립적 쓰임이 있을 때만 남긴다.

각 후보의 로컬 원장 필드:

`source_record_id, source_sense_id, context_id, source_surface, relation_path, candidate, derivation(exact|inflected|inferred), lens, discovery_window`

`relation_path`는 그 후보가 **해당 sense**를 어떻게 확장·수식·대비·초래·참여시키는지 적는다. "같은 문단에 있음"은 경로가 아니다. 추론 표현은 근거가 된 원문 구절을 함께 적는다.

## 4. PASS 3 — sense 격리와 cluster 중복

1. **대조적 격리**: 각 V 문맥을 이 sense와 가장 가까운 다른 sense(동음이의어·다른 품사·다른 뜻)에 대조한다. 긍정 증거와, 만약 틀렸다면 가장 그럴듯한 반대 해석을 적는다. 해소되지 않으면 `UNCERTAIN`이며 KEEP이 아니다.
2. **관계 cluster**: 같은 sense 안에서 같은 의미 관계를 표현만 바꾼 후보를 묶는다. register·image·direction·role·situation·meaning이 구별될 때만 여러 개를 남긴다.
3. **gloss/lemma 겹침**: 뜻풀이를 그대로 옮긴 말, 조각, 동어 반복, 기계적 `표제어+형용사`는 후보 수를 부풀리지 않는다. 다만 실제 문맥이 지지하는 유용한 어휘 대안은 남길 수 있다.
4. **출처 gate**: KEEP은 최소 하나의 `V` 원문 문맥과 후보 관계의 근거를 가져야 한다. 사전 지식·그럴듯한 연상만 있으면 KEEP하지 않는다.

## 5. PASS 4 — 적대적 편집

발굴이 끝난 뒤 기존 후보와 신규 후보를 같은 기준으로 전량 재판정한다. 각 후보에 다음을 적용한다.

- **Sense Accuracy**: 정확히 이 sense인가, 다른 sense인가?
- **Context Grounding**: 원문이 그 관계를 실제로 지지하는가, 단순 공출현인가?
- **Writer Usefulness**: 작가가 쓸 수 있는 표현·장면·감각·행동·연상 경로인가? 직접 동의어일 필요는 없다.
- **Independent Contribution**: 같은 sense의 다른 후보와 구별되는가?
- **Strongest Counterargument**: 틀렸다면 가장 그럴듯한 반대 논리와, 이를 반박하는 원문 근거는 무엇인가?

판정은 `KEEP / REWORK / DROP / UNCERTAIN`과 이유 코드(`WRONG_SENSE, UNGROUNDED, CO_OCCURRENCE, SAME_RELATION, FRAGMENT, TRIVIAL_REPHRASE, MISREADING, GOOD_INFERRED_IMAGE, OTHER`)로 기록한다.

기존 후보의 계보:

- 같은 `(sense_id, normalized candidate)`를 유지하되 근거만 바뀌면 `REWORK_EVIDENCE_ONLY`.
- 표현을 바꾸면 `REWORK`와 `old → new`를 기록한다.
- `UNCERTAIN`은 최종 후보에서 제외하며 KEEP으로 조용히 승격하지 않는다.

## 6. PASS 5 — 수리·재발굴

`REWORK/DROP/UNCERTAIN`이 나온 sense는 실패한 gate를 적는다. sense 오결속이면 올바른 sense의 문맥을 찾거나 비워 둔다. 공출현이면 V 문맥에서 실제 관계를 다시 찾는다. 중복·동어 반복이면 다른 관계를 찾는다. 근거가 없으면 다른 문맥을 읽고, 없으면 `UNCERTAIN/DROP`으로 남긴다. 새 근거·새 관계가 없으면 중단하며, 후보 수를 채우기 위해 재시도하지 않는다.

## 7. PASS 6 — 완료 gate

로컬 스크립트로 다음을 확인한다.

- 500 records / 565 senses, Canonical 순서·ID 일치, 모든 sense에 status 존재.
- `V` 문맥마다 lens 5비트 존재, `A/R`에는 lens 없음.
- KEEP/REWORK 후보마다 `V` 문맥과 provenance 존재.
- `UNCERTAIN`이 최종 후보에 없음, 동일 sense 내 정규화 중복 없음, source lemma exact 없음.
- 기존 668개 후보 전량이 정확히 한 번씩 판정됨.
- Candidate v1 구조 검증 통과.
- `zero_hits`/검색 실패/미완료가 `[]`로 가장되지 않음.

기계적 gate 통과는 의미 정확성의 증명이 아니다. 최종 판단은 별도 평가 단계에 맡긴다.

## 8. 원장 형식

로컬 감사 원장은 JSONL 한 줄에 record 하나를 기록한다.

```json
{"record_id":"w18530","senses":[{"sense_id":"w18530-s1","iso":"pos=...; neg=...","stop":"inspected_all","ctx":[["c1","V","증거"]],"lens":[["c1","11101"]],"old":[["공습 관제","KEEP","c1","관계"]],"new":[["등화관제","c1","assoc","exact","관계"]]}]}
```

- `ctx`: `[context_id, verdict, evidence]`
- `lens`: `[context_id, "coll/act/scene/cause/assoc 5비트"]`
- `old`: `[text, decision, context_id, reason, replacement?]`
- `new`: `[text, context_id, lens, derivation, relation_path]`

Candidate JSONL에는 `record_id`, `senses[].sense_id`, `senses[].candidates`만 넣는다.

## 9. 한계

- 이 배치는 이미 V4–V6 결과를 본 개발용 배치이며 블라인드 재현이 아니다.
- 검색 자료는 문학 문어에 치우쳐 있다. 일상 대화·전문 문어 전체의 대표 용례로 일반화하지 않는다.
- V6의 검색·보충 결과를 재사용했으므로 검색 자체의 재현성은 V6에 의존한다. 원문 판독·sense 판정·후보 판정은 V7에서 새로 수행한다.
- `zero_hits`는 해당 검색 경로의 미검출이다.
- 최종 후보의 작가 유용성과 정확성은 독립 평가가 필요하다.

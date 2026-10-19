# D V8 절차 — recall-first 검색 확대 · 회복 · 하드 오류만 제외

이 문서는 Issue #1106의 **D V8** 실험 절차다. 목표는 Stage 2의 채택/제외·Tier·type을 미리 흉내 내는 것이 아니라, 승인된 문어 말뭉치의 실제 용례에서 **강한·중간·약한 의미 가능 관계를 가능한 한 많이** 확보하는 것이다. 이 배치의 결과 파일이나 특정 단어 목록에 의존하지 않으며, 처음 보는 배치에서도 같은 순서로 실행할 수 있도록 검색·판독·발굴·회복·출력 단계를 정의한다.

## 0. 역할 경계

- Stage 1(D)은 **candidate generation**만 한다. `record_id`, `senses[].sense_id`, `senses[].candidates` 외의 필드를 넣지 않는다.
- Tier·relevance·relation type·target ID·keep/drop·admission은 Stage 2의 결정이다. 이 절차는 그것을 예측하거나 모방하지 않는다.
- 다른 생산자(Codex/Claude)나 다른 방식(C)의 후보·문맥·평가를 읽지 않는다. 오직 **같은 생산자(D)의 이전 버전**만 회복 입력으로 쓴다.
- 말뭉치 SQLite·postings·FTS는 read-only로만 쓴다. 원문·발췌·검색 로그·ledger·SQLite는 Git/PR/제품에 넣지 않는다.

## 1. PRE-FLIGHT

1. `MODE`, `SHARD`, `BATCH`, `RUN_ID`, 모델, 절차 버전과 SHA, Canonical SHA-256, 코퍼스 인덱스 SHA-256, 시작 HEAD, 출력 경로를 기록한다.
2. Canonical 배치의 record 순서와 모든 sense(`lemma`, `pos`, `gloss`, `search_forms`, `sense_id`)를 동결하고 수를 센다.
3. 로컬 ledger 디렉터리를 만들고 25–50 records마다 checkpoint한다. 중단·재개 시 미완료 sense를 `[]`로 위장하지 않는다.
4. deterministic pilot(수십 records)로 검색·형태소·검증 결함을 먼저 고치고 절차를 동결한다. 단어별 예외 목록이나 후보 수 할당량을 두지 않는다.

## 2. PASS A — 실제 사용 문맥 확보

### 2.1 검색형 생성 (일반 규칙)

표제어·`search_forms`에서 다음을 **일반 규칙으로** 생성한다.

- 표제어, 띄어쓰기 제거형, 다어절 표제어의 내용 토큰
- `하다` 활용: 어간, `-하/해/했/한/할/합/한다/했다/하던/하면/하지/하게/하기/함/하여/하였/해도/해라/하자/합니다/했습니다/해요/하오/하네/하군/하든/하거나/하더라도/하지만/하며/하고/해서/해야/하러/하려/하려고`
- `되다` 활용: 어간, `-되/돼/된/될/됩/된다/됐/되던/되면/되지/되게/되기/됨/되어/되었/돼도/되어서/되자/됩니다/되었습니다/돼요/되오/되네/되든/되거나/되더라도/되지만/되며/되고/되려/되려고`
- `시키다` 활용: 어간, `-시키/시켜/시킨/시킬/시킵/시켰/시키던/시키면/시키지/시키게/시키기/시킴/시킨다/시켰다`
- 일반 용언: 어간과 생산적 어미(`-은/는/을/어/아/었/았/었던/았던/으면/면/어서/아서/고/지/게/기/던/다가/지만/며/니/냐/자/도록/듯/채/만/야/라/리라/구나`), 대표적 불규칙 활용(ㅂ·ㄷ·ㅅ·르·우·ㅎ) 보충
- 동일 표제어 안의 여러 sense는 같은 검색 pool을 공유하되, 문맥별 sense 판정은 sense 단위로 따로 한다.

### 2.2 probe 순서 (재현성의 핵심)

검색은 **표제어와 기본형을 먼저, 파생 활용형을 나중에** probe한다.

1. 표제어, 공백 제거형, `search_forms`
2. `하다/되다/시키다` 어간과 기본 활용
3. 기타 파생형은 짧은 것부터

긴 파생형만 먼저 probe하면 실제 문맥을 놓친다. probe는 최대 28개, 각각 최대 900 rowids로 상한을 두고, rowid가 충분히 모이면 중단한다. 짧은 probe는 bigram postings를, 3자 이상은 FTS를 쓴다.

### 2.3 후보 문맥 구성

- 문맥 locator(`d{document}:p{paragraph}`), 문서 제목·저자·날짜, 일치 표면형, 일치 위치, 원문 단락을 기록한다.
- 문서당 최대 2문맥을 우선해 최대 40문맥을 준비한다(중복 문맥 제거).
- 순위는 (a) 표제어와 정확히 같은 표면형, (b) 토큰 경계 일치, (c) 긴 표면형, (d) 적당한 길이의 단락을 가중한다. 다른 단어 안의 부분 문자열은 감점하되 버리지 않는다(판독에서 판정).
- 실제 판독은 4문맥 창부터 시작해 4→8→12→16으로 확장한다. 4문맥에서 서로 다른 자료가 남고 새로운 가능 관계가 보이면 5–8을 실제로 읽고, 거기서도 새 관계가 나오면 9–12, 13–16을 읽는다. 새 관계가 없으면 `saturated_4`/`saturated_8`로 중단 사유를 기록한다. 첫 후보 2–3개에서 임의 종료하지 않는다.

### 2.4 zero-hit / no-verified 재시도 사다리

검색 미검출 sense는 다음을 **순서대로** 시도하고 시도·결과를 기록한다.

1. 표제어·`search_forms` 기본 probe 재실행
2. §2.1의 활용형·불규칙형·띄어쓰기·합성어 변형
3. 어간·기본형 우선 probe 순서로 재검색(§2.2)
4. 다른 승인 인덱스/검색 경로(FTS ↔ bigram postings ↔ 부분 문자열 조회)
5. 문맥 단위 재조회 및 문서 다양성 확대

재시도 후에도 실제 용례가 없으면 정당한 `ZERO_HITS`, 검색 자체가 실패하면 `SEARCH_FAILED`, 원문이 없으면 `UNSEARCHABLE`로 남긴다. 좁은 검색어를 무작정 부분 문자열로 풀어 오탐만 키우지 않는다.

### 2.5 문맥 판정

각 문맥을 실제로 읽고 **출발 sense 기준**으로 판정한다.

- `V`(VERIFIED): 정확히 이 sense의 쓰임이라는 긍정 증거
- `A`(AMBIGUOUS): 둘 이상 sense가 가능
- `R`(REJECTED): 다른 sense·동음이의어·다른 단어 활용형·부분 문자열 오탐

`V`가 없으면 문맥이 있는 경우 `NO_VERIFIED`, 문맥 자체가 없으면 `ZERO_HITS`다. 판정 근거를 짧게 남긴다. `V` 수는 읽은 문맥 수와 별도로 센다.

## 3. PASS B — 다섯 관점 발굴 (핵심 생산 단계)

`V` 문맥마다 다음을 **별도로** 순회한다.

1. `coll`: 자연스러운 결합 표현·실제 공기·고정 표현
2. `act`: 동작·행동·사건과 그 주체·대상·역할
3. `scene`: 특징적인 상황·장면·시간·장소·결과
4. `cause`: 원인·결과·대응·변화
5. `assoc`: 대비·감각·이미지·느슨한 연상

각 관점에서 (a) 원문을 다시 읽고 (b) 명시·간접·가능성 있는 연결을 찾고 (c) 후보 문자열을 pool에 넣고 (d) 놓친 다른 관계를 재확인하고 (e) 없으면 0을 기록한다.

**2차 sweep:** 첫 sweep 뒤, 같은 `V` 문맥에서 놓친 *다른 종류*의 관계를 찾는 두 번째 순회를 한다. 첫 후보를 다시 쓰는 것이 아니라 새로운 결합·행동·상황·인과·대비를 찾는다. 관점별 `first_found / second_new_found / attempted`를 로컬에 기록한다. 새 후보가 없으면 0으로 보고한다. 인위적 할당량은 없다.

후보마다 로컬 ledger에 다음을 남긴다: `sense_id, context_locator, source_surface, sense_binding, lens, candidate, form(exact|inflected|inferred), connection_hint, source_version`. 약한 관계에 완전한 인과 증명을 요구하지 않되, "같은 문단에 있음"은 경로가 아니다.

**금지:** 뜻풀이를 그대로 옮긴 조각, 표제어+일반 수식어의 기계적 결합으로 개수 늘리기, 근거 없는 무작위 문자열.

## 4. PASS C — 이전 버전 회복

- 같은 생산자의 V4/V5/V6/V7 후보 전체를 `sense_id + candidate` 키로 모아 이번 발굴과 union한다.
- 이전 버전에서 제외된 후보를 `SOURCE_UNVERIFIED`(출발 sense 근거를 못 찾음)와 `EDITORIAL_WEAK`(관계 강도만 확신 못함)로 구분한다.
- **약한 연상·간접 관련·중복 우려·Stage 2 Drop 가능성은 Stage 1 배제 사유가 아니다.** 실제 `V` 문맥에서 설명 가능한 연결이면 회복한다.
- 잘못된 source sense·부분 문자열 오탐·조작/부재 근거·계약 위반만 하드 오류로 제외하고 사유를 남긴다.
- 이전 ledger가 없으면 다른 검색 경로로 다시 조회한다. 검증 없이 자동 유지하거나, 편집상 의심만으로 무차별 삭제하지 않는다.

## 5. PASS D — 최소 기술 품질관리 (편집 gate가 아님)

하드 제외/수정:

- 다른 `record_id/sense_id`, source sense와 무관한 문맥, 확실한 부분 문자열·형태 분석 오탐, 존재하지 않는 근거
- 정확한 출발 lemma와 동일 문자열, 같은 sense 안 정확 중복(공통 normalizer), 빈 조각·계약 위반·깨진 형식
- `V` 문맥에서 설명 가능한 관계가 전혀 없는 임의 생성 문자열

Stage 2로 이양(Stage 1에서 제거하지 않음):

- 가볍거나 약한 배경·상황이라는 주관적 판단
- 근접 의미의 여러 표현(정확 중복이 아닌 경우), 향후 Tier·가치 순위
- 원문/활용형/유도 표현 중 어느 쪽이 더 좋은지
- Stage 2에서 Drop될 가능성이 높아도 문맥과 연결 가능한 후보

`UNCERTAIN_SOURCE`(출발 sense 미확인)는 재검색 후에도 미확인이면 보존 불가, `UNCERTAIN_EDITORIAL`(관계 강도·작가 가치 판단 어려움)은 후보로 보존한다. 이 구분은 로컬 ledger에만 적고 Candidate v1에는 상태·confidence·Tier를 넣지 않는다.

## 6. PASS E — 검증과 출력

- 500 records(마지막 배치는 83)·전체 sense·ID·순서, Candidate v1 스키마
- 모든 sense에 status, `V` 문맥에 provenance, `A/R`에 후보 없음
- 같은 sense 내 정규화 중복 없음, 표제어 exact 없음, trimmed nonempty
- 이전 버전 후보 계보: `RETAINED / RECOVERED / TECHNICAL_EXCLUDED / SOURCE_UNVERIFIED / EXACT_DUPLICATE / REWORKED` 집계 일치
- `zero_hits`/검색 실패/`INCOMPLETE`를 `[]`로 가장하지 않음
- 원문/활용형/유도 구성, 결합·행동·상황·인과·연상 다양성. 일정 후보 수·균등 분포를 합격 조건으로 삼지 않는다.

기계적 gate 통과는 의미 품질 인증이 아니다. 최종 판단은 별도 평가 단계에 맡긴다.

## 7. 로컬 ledger 형식

JSONL 한 줄에 record 하나.

```json
{"record_id":"w00000","senses":[{"sense_id":"w00000-s1","stop":"inspected_4","ctx":[["c1","V","증거"],["c2","R","다른 sense"]],"lens":[["c1","11101"]],"new":["후보"],"old":[["이전 후보","RETAINED","c1","관계"]]}]}
```

- `ctx`: `[context_id, verdict, evidence]`
- `lens`: `[context_id, "coll/act/scene/cause/assoc 5비트"]`
- `new`: 이번에 발굴한 후보
- `old`: 이전 버전 후보의 계보 판정

Candidate JSONL에는 `record_id`, `senses[].sense_id`, `senses[].candidates`만 넣는다.

## 8. 한계

- 개발/calibration 배치는 이미 결과를 본 비블라인드 배치다.
- 검색 자료는 문학 문어에 치우쳐 있다.
- `ZERO_HITS`는 해당 검색 경로의 미검출이지 말뭉치 전체 부재의 증명이 아니다.
- 최종 후보의 작가 유용성·정확성은 독립 평가가 필요하다.

# STDICT 기반 새 사전 baseline 분석 (Issue #671, Task 1)

분석·설계 문서입니다. 데이터 삭제, import, 신규 validator, 대량 생산은 포함하지 않습니다. 원본 JSON은 Git 밖
`~/.cache/typewriter/reference/dict/stdict`(88개 파일, 789 MB)에 있으며 이 문서에는 집계 수치만 기록합니다.
집계는 88개 파일 전체를 읽고 계산했습니다(1회성 스크립트, 저장소에 추가하지 않음).

## 1. 소스 현황 (실측)

| 항목 | 값 |
| --- | --- |
| 파일 | `1595832_5000.json` … `_436587.json`, 88개, 연속 구간 5000개 단위 |
| `channel.total` | 436,587 |
| 실제 `item` 수 | **436,587** (보고값과 일치, `target_code` 중복 0) |
| 실제 sense 수 (`sense_code`) | **509,143** (중복 0, 정의 비어 있는 sense 0) |
| 품사 없는 항목 / sense 없는 항목 | 0 / 0 (모든 항목에 sense가 1개 이상) |
| lastBuildDate | 2026-09-06 |

구조: `channel.item[].word_info` → `word`, `word_unit`, `word_type`, `pos_info[]` → `comm_pattern_info[]` →
`sense_info[]`(`sense_code`, `definition`, `cat_info`, `lexical_info[]`). 항목 하나가 여러 `pos_info`를 가질 수
있습니다(복수 품사 항목 2,930).

### 표제어 단위(`word_unit`)

| 단위 | 항목 수 |
| --- | --- |
| 단어 | 362,255 |
| 구 | 63,010 |
| 속담 | 7,436 |
| 관용구 | 3,886 |

### 품사(`pos_info[].pos`, 항목×품사 기준) 및 sense 수

| 단위/품사 | 항목 | sense |
| --- | --- | --- |
| 단어/명사 | 270,040 | 307,281 |
| 단어/동사 | 56,474 | 75,374 |
| 단어/형용사 | 13,400 | 16,930 |
| 단어/부사 | 12,325 | 17,955 |
| 구/품사 없음 | 63,010 | 64,391 |
| 속담/구 | 7,436 | 8,216 |
| 관용구/구 | 3,886 | 4,457 |
| 단어/품사 없음 | 7,770 | 7,867 |
| 단어/관형사·의존 명사·어미·감탄사·접사·대명사·수사·조사·보조 용언 | 5,225 | 6,672 |

현재 Typewriter 품사(noun/adjective/verb/adverb)에 곧바로 대응하는 항목은 단어 4종 합계 **352,239 항목 /
417,540 sense**입니다. `expression`(구·속담·관용구)은 74,332 항목 / 77,064 sense입니다. 나머지(관형사, 의존
명사, 어미, 감탄사, 접사, 대명사, 수사, 조사, 보조 용언, 품사 없는 단어 7,770)는 현재 모델 밖입니다.
(의존 명사·대명사·수사는 `noun`에 접을 수 있으나 제품 판단이 필요합니다. 아래 결정 사항 참조.)

### 표기 부호

- 동음이의 번호: `word` 끝 숫자(`각본01`) 110,051 항목. 표기 기준 distinct 표제어 365,437개, 이 중 35,293개가
  동형이의어입니다.
- `-`: 217,391 항목(`별-천지`, `별천-하다`). 접사·파생·합성 경계 표시이며 검색 표면형에서는 제거해야 합니다.
- `^`: 61,994 항목(`병기^공업`). 구/복합어의 띄어쓰기 위치 표시이며 표면형에서는 공백으로 바꾸거나 제거합니다.
- 공백이 있는 단어형 12,333 항목.

### 관계(`lexical_info`)

sense 수준 링크 196,808건: 동의어 162,127 · 비슷한말 26,264 · 반대말 6,367 · 준말 1,564 · 본말 265 · 높임말
155 · 낮춤말 51 · 참고 어휘 15. 링크 단위는 대부분 `의미`(196,718)입니다.

- `link_target_code`는 **`sense_code`**를 가리킵니다. 196,808건 중 `sense_code`로 해석되는 것 196,782건,
  `target_code`로만 해석되는 것 19건, 어느 쪽도 해석 불가 7건입니다. `sense_code`와 `target_code`의 숫자 공간이
  겹치므로 해석 기준을 `sense_code`로 고정해야 합니다. 자기 링크 1건.
- 항목 수준 `lexical_info`(참고 어휘 45,952 등)는 sense 링크가 아니므로 Phase 1 대상에서 제외합니다.
- `target_code` 기준으로만 해석하면 58,874건이 깨진 링크로 보이므로, 변환기는 반드시 `sense_code`로 해석해야
  합니다.
- `relation_info`(부표제어 63,500, 속담 9,426, 관용구 4,438)는 항목 간 포함 관계이며 별도 항목으로도 존재하는
  경우가 많아 중복 import하지 않습니다.

기타: `cat_info`(분야) 68종, 모든 sense `type`은 `일반어`. 원어/발음/활용(`conju_info`)/어원 필드는 Phase 1에서
쓰지 않습니다.

## 2. 현재 Typewriter 구조와의 대응

| STDICT | Typewriter |
| --- | --- |
| `target_code` | record `id` (`w` + 숫자 id 규칙은 STDICT 코드와 1:1 매핑표로 보관) |
| `word` (번호·`-`·`^` 제거) | `lemma` / `search_forms[0]` |
| `word_unit`=단어 / 구·속담·관용구 | `record_type` = `entry` / `expression` |
| `pos` | `senses[].pos` (아래 어댑테이션) |
| `sense_code` | `senses[].id` (`<record>-s<n>`), 원 `sense_code`는 매핑표에 보관 |
| `definition` | `senses[].gloss` |
| `lexical_info` 동의어 / 반대말 | `relations[]` `direct` / `antonym` (relevance 없음, 아래 §3) |
| `lexical_info` 비슷한말 | 1단계에서 canonical 관계로 주입하지 않음 (§3) |

호환되지 않는 지점(실제 비호환):

1. **품사 enum**: `schema/canonical-record.schema.json`, `scripts/build/sqlite-schema.mjs`의 CHECK는
   noun/adjective/verb/adverb/expression 5종뿐입니다. 관형사·감탄사·대명사·수사·의존 명사·어미·접사·조사·보조 용언은
   표현할 수 없습니다.
2. **`role`(start/reference-only)** 은 필수 필드이며 STDICT에는 대응 개념이 없습니다. 기존 규정상 직접 검색 가능
   여부와 무관한 이력 필드이므로 baseline에서는 고정값을 쓰거나 필드를 선택 항목으로 바꿔야 합니다.
3. **record id 형식** `^[wr][0-9]{3,}$`: `target_code`(최대 6자리대)는 그대로 쓸 수 있으나 이후 접두 규칙을 정해야
   합니다.
4. **복수 품사 항목**: 한 `target_code`가 여러 품사 sense를 가질 수 있는데, 현재 모델은 sense 단위 `pos`이므로
   수용 가능합니다(변경 불필요).
5. **동형이의어**: 번호별 별도 `target_code`이므로 record 분리로 해결됩니다. 표시용 lemma는 같고 id가 다른 record가
   35,293군 생기므로 검색 결과의 동형이의어 구분 표시가 UI에서 필요한지 확인해야 합니다.
6. **`relations.note` 필수**: STDICT 동의어·반대말에는 설명문이 없습니다. 출처 관계 유형을 밝히는 정형 문구를 쓰거나
   필수를 완화해야 합니다.
7. **`near` 등 탐색형 관계는 `relevance` 1..9가 필수**(`docs/domain-model.md` #396, `dataset-integrity`)이고
   `direct`/`antonym`에는 붙일 수 없습니다. STDICT에는 이 편집 판단이 없습니다(§3).

필요한 최소 변경(추가 필드 없음):

- 품사 enum 확장(§6의 처리 계획, 결정 D1).
- `role`을 baseline 값 하나로 고정하거나 선택 항목화.
- `relations.note` 처리 방식.
- 필요하면 STDICT 식별자 보관용 매핑 필드 1개(예: record의 `source_id`)는 선택 사항이며, 매핑표를 Git 밖
  산출물이 아닌 canonical 안에 둘지에 따라 결정합니다.

## 3. 1단계에 주입할 관계와 2단계로 넘길 관계

| STDICT 링크 | 건수 | 1단계 처리 |
| --- | --- | --- |
| 동의어 | 162,127 | `direct` 주입. 사전 수록 동의어이며 `relevance`를 붙이지 않으므로 계약에 맞습니다. |
| 반대말 | 6,367 | `antonym` 주입(`relevance` 없음). |
| 비슷한말 | 26,264 | **1단계에서 주입하지 않음.** `near`는 `relevance` 1..9 편집 판단이 필수이고 STDICT에는 없습니다. 임의 상수로 채우면 편집 판단을 위조하게 되고, `near`는 말의 결이라 2단계 집필 대상입니다. 이 링크는 Git 밖 원본에 남기고 backfill의 후보 힌트로만 씁니다(§4). |
| 준말·본말·높임말·낮춤말·참고 어휘 | 약 2,050 | 대응하는 현 관계 유형이 없어 1단계 제외. 필요하면 오너가 유형 신설을 별도로 결정합니다(현 데이터로 필요성이 입증되지 않음). |

사전이 동의어로 표시한 것만 `direct`(사전급 동의어)로 옮기고 나머지는 편집 단계로 넘깁니다. 동의어 주입은 `note`에 출처 관계 유형을 정형으로
적고, 변환기는 `sense_code`로 대상 sense를 해석해 `target_sense`를 채웁니다(링크 해석 불가 7건은 제외 목록으로 기록).

수록 범위: 표제어와 sense 전체(§6 처리 계획), 뜻풀이(`definition`)는 필수. 발음, 활용, 원어, 어원, 문형, 예문, 멀티미디어,
분야 태그, 항목 수준 참고 어휘는 가져오지 않습니다. 옛 Typewriter 의미와 병합하지 않으며(`legacy` 브랜치 보존) migration도
만들지 않습니다.

## 4. 새 생산 흐름과 기존 Stage 1→2→3 재사용 판단 (코드 구현 없음)

현 Stage 1/2/3은 **어휘 발굴 → 신표제어/신품사/신의미 집필 → admission** 파이프라인입니다
(`docs/lexical-production-factory.md` §2, §5.1, §6.1). Stage 1은 코퍼스 관찰에서 canonical에 없는 표제어(`new_entry`),
새 품사(`new_pos_on_existing_lemma`), 새 의미(`new_sense_on_existing_entry`)를 후보로 만들고(`scripts/factory/stage1.mjs`,
`coverage_status`는 `uncovered`/`exact_canonical_lemma`), Stage 2 `included`는 새 의미 주장, Stage 3은 lexical admission입니다.
STDICT baseline에서는 표제어와 sense가 이미 canonical에 있으므로, "이미 있는 sense에 관계만 추가"하는 작업은 이 경로에 맞지
않습니다. 맞는 기존 경로는 **relation-only backfill**(같은 문서 §4.1: `backfill-queue-cli.mjs next` → 검토 `record` →
`backfill-queue-cli.mjs apply`, `R######` 패킷, `relation-amendments.mjs`의 `append_relations`)입니다. 이 경로는 lexical
admission 없이 기존 sense에 `near/mood/scene/sensory/action/association`(relevance 필수)과 근거(rationale)를 기록합니다.

실제 backfill 경로(HEAD 코드 기준): `backfill-queue-cli.mjs next`(`status`/`record`/`apply`) →
`backfill-queue.mjs retrievePacket` → `retrieveRelationCandidates(index, [{kind:'canonical', sense_id}])` → `record` → `apply`.
`pnpm run relation:candidates <C######>`(`stage2-candidates.mjs`)는 Stage 2 리뷰 배치의 신규 sense만 읽는 별도 명령이며 STDICT
canonical sense 백필과 연결되지 않으므로 이 설계에서 사용하지 않습니다.

**비슷한말 힌트 연결에 필요한 변경 경계.** `retrieveRelationCandidates`는 source별 `hints`를 이미 받습니다
(`candidate-retrieval.mjs`의 `source.hints`). 반면 `retrievePacket`은 `{kind:'canonical', sense_id}`만 만들고 힌트를 넘기지
않으므로 STDICT 힌트는 현재 후보로 들어가지 않습니다. 필요한 변경은 다음 경계에 한정됩니다.

1. STDICT `비슷한말` 링크를 새 canonical id로 변환한 `source sense_id → 힌트 target` 표(Git 밖 또는 결정적 파생물)를 만든다.
   `link_target_code`는 `sense_code`로 해석해 canonical sense id로 매핑한다.
2. `retrievePacket`이 그 표에서 packet 행마다 `hints`를 채워 `retrieveRelationCandidates`에 전달한다.
3. 같은 힌트가 패킷 발행(`next`), `record` 검토 시점의 재검색(`backfill-queue-cli.mjs`의 `retrievePacket` 호출), 그리고 완료 상태
   재검증(`currentCandidatesForDone`/`isReviewCurrent`)에 모두 동일하게 반영되어야 한다. 한 곳이라도 힌트가 빠지면 기록된 검토가
   stale로 판정되거나 힌트 후보가 승인에서 누락된다.

신규 검증기나 구현은 이 문서의 범위가 아니며 위는 Task 3 이후에 구현할 변경 경계입니다. 대안으로, 공식 비슷한말 후보 입력을 후속
결정으로 미루고 기존 큐는 일반 검색 기반 관계 후보만 생산하게 둘 수도 있습니다(오너 결정 D5).

기존 데이터는 `legacy`에 보존되므로 old canonical/batch/review는 migration 없이 폐기합니다. 재사용 가능한 것은 코드,
폐기하는 것은 옛 데이터입니다. 확인하지 못한 점: backfill 큐/패킷 코드와 `data/relation-backfill/` 이력이 옛 canonical
sense id를 가정하는 부분의 범위(Task 2/3에서 구현 시 확인할 사항이며, 새 validator를 요구하지 않음). 이 판단은 Stage 1
결정형(`new_entry`/`new_pos`/`new_sense`/`covered`)과 relation-only backfill의 입력/출력을 문서 수준에서 비교한 결과이고
코드를 실행해 검증하지는 않았습니다.

## 5. 실현 가능성

- 규모: 원본 789 MB는 Git 밖 보관. 변환 결과 canonical은 약 43.7만 record/50.9만 sense로 뜻풀이를 포함해 크기는
  구현 전 측정이 필요합니다(미검증). 현재 canonical은 12,312 record이므로 약 35배입니다.
- 검색: 표면형 정규화(`-`/`^`/번호 제거)와 동형이의어 id 분리가 필수입니다. 활용형 생성(`generated_surface_forms`)은 기존
  코드를 재사용할 수 있습니다.
- **라이선스**: 오너는 새 데이터에 **CC BY-SA 2.0 대한민국**을 적용하기로 선택했고 뜻풀이 수록은 필수 목표입니다. 이 문서는 그
  결정을 전제로 하며 뜻풀이 제외를 대안으로 두지 않습니다. 아직 확인되지 않은 것: 실제 다운로드본의 이용 조건·예외,
  `DATA-LICENSE.md`/NOTICE 문구 변경 필요 여부(Task 3 이전에 정리). 수록 대상의 레코드별 권리 증명은 `DATA-LICENSE.md`가
  요구하지 않습니다. 기존 AGENTS.md의 "외부 사전 정의 비복사" 원칙은 이 Reset의 오너 결정으로 대체되므로 AGENTS.md/
  `docs/data-policy.md` 갱신이 Task 2 또는 3의 범위입니다.

## 6. 전량 표제어 수록: 항목 종류별 처리 계획

오너는 불필요한 필드만 제외하라고 했으므로 항목 자체는 제외하지 않습니다. 현 모델로 바로 수록 가능한 것은 단어 4품사
352,239 + expression 74,332 = 426,571항목이며, 나머지 **약 10,016항목**(항목×품사 합계와 항목 수 차이는 복수 품사 때문에
개별 누락 수와 다를 수 있음)은 모델 확장이 필요합니다.

| 원본 종류 | 항목×품사 | 제안 처리(최소 확장) |
| --- | --- | --- |
| 의존 명사 | 870 | `senses[].pos`에 `dependent-noun` 추가 또는 `noun`으로 수록(오너 결정) |
| 대명사 | 352 | `pronoun` 추가 또는 `noun` 수록 |
| 수사 | 188 | `numeral` 추가 또는 `noun` 수록 |
| 관형사 | 1,583 | `determiner` 추가 |
| 감탄사 | 650 | `interjection` 추가 |
| 보조 동사 / 보조 형용사 | 41 / 18 | `verb` / `adjective`로 수록(보조 용언 표지는 가져오지 않음) |
| 조사 / 어미 / 접사 | 180 / 811 / 532 | `particle` / `ending` / `affix` 추가(표면형은 `-` 제거 후 저장) |
| 품사 없는 단어 | 7,770 | `expression` 또는 별도 `unclassified`로 수록(원본 `word_unit`이 단어이나 품사 없음) |

수록 판단과 enum 확장은 제안일 뿐이며, 어떤 종류를 현 파이프라인에서 검색 가능하게 둘지(예: 어미·조사는 검색 제외)는
오너의 별도 범위 결정입니다. 즉 **수록하되 검색 노출 여부는 별도**로 구분합니다.

## 7. 결정 및 권고

**권고: 조건부 GO.** 기술적으로 가능합니다(id·sense·관계가 안정적이고 모델 변경이 품사 enum, `role`, `note`에 한정). 옛
데이터는 `legacy`에 있어 Task 2의 삭제로 인한 복구 불가 위험은 없습니다. 말의 결·연상 생산은 relation-only backfill 경로를
재사용하며 Stage 1~3은 신규 표제어 보충용으로 남습니다.

오너 결정 사항:

- **D1 (품사 모델)**: §6 표의 품사 확장안(또는 `noun` 등으로 접는 안)과 검색 노출 범위.
- **D2 (품사 없는 단어 7,770)**: 수록 방식.
- **D3 (준말·본말·높임말·낮춤말 등 약 2,050건)**: 1단계 제외 권고, 관계 유형 신설은 별도 결정.
- **D5 (비슷한말 힌트)**: §4의 3개 경계를 변경해 힌트로 쓸지, 후속 결정으로 미루고 일반 검색 기반 후보만 쓸지.
- **D4 (정책 문서)**: CC BY-SA 2.0 KR 적용에 따른 `DATA-LICENSE.md`/NOTICE/AGENTS.md 변경 범위, 다운로드본의 이용 조건 확인.

Task 2와 Task 3은 이 문서가 승인된 이후에만 진행합니다.

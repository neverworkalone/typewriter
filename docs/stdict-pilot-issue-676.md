# STDICT 파일럿 결과 (Issue #676, Task 3)

STDICT 1,000개 항목을 canonical shard 한 개로 변환하고, 기존 SQLite·검색 경로와 relation-only backfill을
실데이터로 돌려 본 결과입니다. 원본 JSON(`~/.cache/typewriter/reference/dict/stdict`, 88개 파일, 436,587 항목)은 Git 밖에
있으며 여기에는 집계만 적습니다. 이 PR이 전체 사전 import나 제품 릴리스는 아닙니다.

## 1. 산출물

| 항목 | 값 |
| --- | --- |
| `data/canonical/stdict-0001.jsonl` | 정확히 **1,000 record / 1,561 sense / 154 relation**, 372,564 bytes |
| `data/provenance/stdict-0001.json` | 선택 규칙 버전, 항목별 `target_code`·`sense_code`, shard sha256, 종류별 집계 |
| 변환기 | `scripts/stdict/convert.mjs`(순수 변환), `build-shard.mjs`(결정적 선택·재생성·`--verify`) |
| 재현 | `node scripts/stdict/build-shard.mjs --verify`가 원본에서 shard와 provenance를 바이트 단위로 재생성해 비교 |

**ID 계약(이후 shard도 동일)**: record id = `w` + `target_code`(3자리 미만이면 0 채움), `candidate_id` = id,
sense id = `<record>-s<n>`(n = 원본 `pos_info → comm_pattern_info → sense_info` 순서의 1부터). `sense_code`는
provenance 파일의 `(target_code, n)`으로 복원됩니다. 이후 shard는 남은 `target_code`를 오름차순으로 이어 붙이며
기존 1,000개는 옮기거나 번호를 바꾸지 않습니다. 선택은 층위별 sha256 순서(`stdict-pilot-selection-v1`)입니다.

**전체 크기 실측**: 전 항목 변환(스크래치, 커밋 안 함)은 17초, 436,586 record / 509,142 sense, 163.5 MB(약 437개
shard)입니다. 1개는 원본 정의의 sub/sup 중첩 오류(`w516304`)로 fail-closed 보류됩니다.

## 2. #671 결정 사항의 해소

| 결정 | 이 파일럿의 처리 |
| --- | --- |
| D1 품사 | 의존 명사·대명사·수사 → `noun`, 보조 동사/형용사 → `verb`/`adjective`(보조 용언 표지는 가져오지 않음). 이렇게 접을 수 없는 관형사·감탄사·조사·어미·접사는 `determiner`·`interjection`·`particle`·`ending`·`affix`로 추가. 구·속담·관용구는 `expression`. 스키마·SQLite CHECK·`lexical-quality`의 entry POS 목록만 확장했고 SQLite 스키마 버전은 그대로입니다. |
| D2 품사 없는 단어 | `unclassified`로 수록(pilot 36 sense). 검색 노출은 다른 record와 같습니다(검색 제외는 별도 제품 결정). |
| `role` | 필수 필드를 건드리지 않고 모두 `start`(+`candidate_id` = id). |
| 관계 `note` | 정형 문구 `표준국어대사전 동의어` / `표준국어대사전 반대말`. |
| 비슷한말 | `near`로 주입하지 않음(`relevance` 위조 방지). 후보 힌트 연결(D5)은 이번에도 구현하지 않았고 아래 §5의 후보 품질 한계로 이어집니다. |
| 준말·본말 등 | 제외(D3, 변경 없음). |
| 표기 부호 | 번호(`각본01`)·`-`·`^` 제거. 접사·어미의 가장자리 `-`는 lemma에 남기고 `-` 없는 형태를 search form에 추가. `^`는 구에서는 띄어쓰기, 단어에서는 붙임이 lemma이고 나머지가 search form. |

**소유자 확인이 필요한 항목**: (a) 위 POS 확장, (b) 관형사 등의 검색 노출 범위, (c) 활용형 생성 처리(§4).

## 3. 변환·보류 집계 (pilot 1,000)

| 원본 종류 | 변환 | 보류 | 비고 |
| --- | --- | --- | --- |
| 단어 | 873 | 0 | 복수 품사 65, 다의어(2 sense 이상) 247 |
| 구 | 46 | 0 | |
| 속담 | 41 | 0 | |
| 관용구 | 40 | 0 | |
| 합계 | **1,000** | **0** | 동형이의어 lemma 26군, `-` 42, `^` 6, 괄호 14 |

sense 품사: noun 739, verb 266, adverb 121, adjective 109, expression 139, determiner 45, unclassified 36, ending 32,
affix 28, particle 26, interjection 20.

**관계(원본 `의미` 링크, 동의어/반대말 sense 링크 기준)**: 동의어 114 converted, 362 out-of-sample, 3 broken(`sense_code`로
해석 불가); 반대말 40 converted, 27 out-of-sample. out-of-sample은 pilot에 대상이 없어 쓰지 않은 것이고, broken은 원본 결함입니다.
전체 변환 기준으로는 동의어 162,123·반대말 6,356이 변환되고 broken 3, self 1입니다. `direct`/`antonym`에는 `relevance`가 없습니다.

**정의 markup**: `definition`에는 `<each_sense_no>`·`<ptrn_no>`(상호 참조 id), `<sub>`/`<sup>`, `<I>` 등, `<img>`가
섞여 있습니다. 변환기가 제거·치환(아래첨자는 유니코드 첨자)하고 종류별 건수를 provenance에 남깁니다. 모르는 태그는
보류합니다(전체 기준 1건). `<img>`는 제품 데이터가 아닌 멀티미디어라 제거하며 전체 304건입니다.

## 4. 기존 gate에 필요했던 최소 변경

실제 shard가 재현한 결함만 고쳤습니다. 모두 같은 원인, 즉 *저자가 쓴 후보를 전제한 검증을 공식 사전 원문에 적용한
것*입니다.

1. **`record.source: "stdict"` 표지(스키마 선택 필드)**와 `scripts/validate/licensed-source.mjs`. 표지가 있는 record는 저자 검수
   대상 밖입니다. 의미 감사(semantic audit)의 digest·coverage·ledger 진입점이 경계에서 한 번 제외하고, `lexical-quality`는
   구조 검사(스키마·id·POS·빈 뜻풀이)만 유지합니다. 뜻풀이 길이, `이나` 연결어, 조사 호응, 중복 lemma 같은 편집 휴리스틱은
   건너뜁니다. 동형이의어는 lemma가 같으므로 중복 lemma 검사가 필수로 깨지던 항목입니다.
2. **관계 추가 ledger**: 공식 record에 backfill 관계를 더해도 검토 행이 없으므로 `changes`에 두 review digest가 `null`인
   항목을 기록하고 record digest 연쇄만 묶습니다(`semantic-authority.mjs`, `validateFactoryAdmissionLedger`).
3. **활용형 gate**: 용언 143개 sense가 sense별 disposition을 요구했습니다. 기존 Stage 3 planner의 규칙 고정 수정(과거형
   제외 96, 없다/있다 2)과 충돌 정책을 재사용하고, 소유자가 검토하지 않은 받침 활용 클래스 45개는
   `m6-3-predicate-excluded`로 **활용형을 만들지 않게(fail closed)** 했습니다. 정규로 임의 판정하지 않았습니다.
   **전체 import 때는 28,216개가 필요**(과거형 25,010 + 없다/있다 273 + 판단 필요 2,933)하므로 전량 import 전에 소유자가
   (a) 수동 manifest 대신 전량 제외 또는 (b) 판정 경로 중 하나를 정해야 합니다. 이 경로는 *기본 canonical 디렉터리*에만
   적용되며 격리 빌드에서는 요구하지 않습니다.
4. 부수 수정: 3자리 미만 `target_code`(1~99, 99건)의 id 패딩, `placeholder` 휴리스틱이 공식 정의 `임시 증표.`를 거부하던 문제는
   구조 검사 목록에서 제외, 두 테스트가 실제 `data/validation` manifest를 읽던 것을 빈 manifest로 격리.

## 5. SQLite 검증과 검색

격리 복사본에서 pilot shard 한 개만으로 빌드했습니다. 재실행 시 모든 테이블 행이 동일합니다(1,000 record, 1,561 sense,
154 relation, generated surface form 1,334). 검증한 경로: lemma 정확 일치, 동형이의어 두 record 동시 반환(`각본` → `w100`, `w101`),
`-` 없는 접사 검색(`간`), 구(`각설이 타령`), `getRecord` sense 선택, 관계 대상 이동(`target_lemma`/`target_pos`), `unclassified`
POS 저장. 이 경로는 `tests/stdict-import.test.mjs`가 합성 fixture로 일반화해 검증합니다.

**규모 실측(스크래치)**: 전체 436,586 record 기준 canonical 읽기+스키마 4초, lexical 3초, 데이터셋 무결성(관계 168,479 포함) 1초,
SQLite 빌드 21초(258 MB, 최대 1.7 GB RSS)로 모두 통과했습니다. 관계 대상이 전부 sample 안에 있어도 dataset 무결성이 통과합니다.

## 6. backfill 시험(스크래치, 커밋 안 함)

기존 `status → next → record → apply`를 격리 worktree에서 실행했습니다. **이 세션은 소유자의 no-subagent 규칙에 따라 실제 병렬
agent 두 개를 띄우지 않았습니다.** 같은 에이전트가 서로 겹치지 않는 두 packet(25 sense씩)에 대해 별도 outcome 파일 두 개를
작성했고(상태 공유 없음), 그 뒤 서로 다른 프로세스가 동시에 `record`/`apply`를 실행하는 경합은 실제 프로세스 병렬로
재현했습니다. 따라서 "독립 작성자 2명"은 구조적으로만 시험했고 실제 다중 agent 시험은 소유자 결정이 필요합니다.

**재현된 결함과 수정(필요한 공통 경로 변경 두 가지)**

- `next`는 상태를 예약하지 않아 두 작성자가 같은 packet(200개 동일)을 받았습니다 → `next --partition I/K` 추가: sense id 해시로
  안정적인 분할이며 서로 겹치지 않고 다른 분할이 완료돼도 소속이 바뀌지 않습니다.
- `record`가 읽기→검증→원자적 교체를 잠금 없이 해 동시 실행 시 한쪽 승인이 사라졌습니다(6회 중 6회 50개 중 25개만 남음).
  → `record`/`apply`가 `<state>.lock`(원자적 `mkdir`, 살아 있는 pid 소유)을 잡고 읽기부터 쓰기까지 직렬화(수정 후 6/6 50개 보존).
  `next`/`status`는 잠그지 않습니다. 두 회귀는 `scripts/relation/backfill-queue*.test.mjs`에 있고 잠금을 끄면 실패합니다.

**결과**: 두 packet에서 `no-relations` 42, `relations-reviewed` 8(관계 near 5·direct 1·association 1·scene 1; 노출 relevance
2~7). `apply`는 R000001 한 packet으로 8개를 7개 record에 더했고 재실행은 `nothing-to-apply`(idempotent), `pnpm run validate`·SQLite
빌드 통과, UI 그룹은 유의어 `direct`, 반의어 `antonym`, 말의 결 `near`, 연상 `scene`/`association`으로 사영됩니다.

**stale-revision 계약**: 먼저 `apply`해 canonical revision이 바뀐 뒤 다른 작성자의 이전 packet을 `record`하면 거부됩니다
(fail closed). 재발급 packet은 apply로 생긴 incoming demand 때문에 순서가 바뀌어 **이미 작성한 outcome이 재사용되지 않았습니다**
(churn). 한 revision에서 모든 작성자가 `record`를 마친 뒤 한 번 `apply`하는 방식(실측 통과)을 권장합니다.

**후보 품질(희소성 한계)**: 50개 중 후보가 있는 sense는 일부이고 대부분 gloss 겹침입니다. 공식 동의어가 이미 `direct`로 들어
있는 쌍은 후보에서 제외되어(`already_related_excluded`) 새 `direct`를 만들 수 없습니다. 반면 pilot에 같이 있는 `개선되다`/
`개악되다`는 후보로 제시되지 않았습니다. 공식 비슷한말 힌트(D5) 없이 gloss 겹침만으로는 반의·유의 후보 재현율이 낮습니다. 관계 개수를
부풀리지 않고 근거 있는 `no-relations`를 허용했습니다.

## 7. 시간 실측

| 단계 | pilot(1K record) | 100K record | 전체 436,586 record |
| --- | --- | --- | --- |
| packet 발급 `next` | 0.12초(25 sense) | 5.8초(200 sense) | 15초(5 sense) ~ 28.7초(200 sense), 2.6 GB RSS |
| 작성·검토 | 실측 안 함(에이전트 한 세션이 순차 작성) | – | – |
| `record`(상태 기록) | 0.13초, 동시 시 직렬화돼 0.25초 | – | 약 14초(재검색 포함) |
| `apply` | 0.16초 | – | 21.7초, 3.3 GB RSS |
| 검증 | `pnpm run validate` 1.1초 | – | read 4초·lexical 3초·무결성 1초 |
| SQLite 빌드 | 0.16초 | 4초 | 21초 |

병렬 가능: 후보 검색과 작성(분할 packet은 서로 독립). 직렬: `record`(잠금), `apply`(Git 파일 한 벌), 검증·SQLite·CI,
리뷰·병합. 매 호출마다 canonical 전체 색인을 다시 만들어 전체 규모에서 호출당 고정 약 14초, 2.6 GB 메모리가 듭니다.

## 8. 권고

**전체 STDICT import: 조건부 GO.** 변환은 결정적이고(17초, 보류 1건) 구조·관계·SQLite가 전체 규모에서 통과합니다. 전량 import 전
소유자가 정할 것: ① POS 확장과 검색 노출 범위, ② 활용형 gate의 28,216개 처리 방식(§4-3), ③ 정의 `<img>` 제거와 `unclassified`
수록 확인, ④ 보류 1건 처리. 437개 shard는 한 PR로 올리기 크므로 shard 묶음 단위 PR(예: 20~25 shard)을 권합니다.

**10 agents × 500 sense × 10 batch/일 backfill: HOLD.** 실측하지 않은 것과 막는 것: (a) 실제 다중 agent 시험을 하지 못했고
(b) 호출당 고정 비용·메모리(14초·2.6 GB, 10개 동시 약 26 GB), (c) `apply`가 revision을 바꿔 진행 중 packet이 모두 무효가 되는 구조,
(d) 후보 품질이 비슷한말 힌트(D5) 없이는 낮음, (e) 한 PR 하나가 shard 한 벌을 바꾸므로 병합·리뷰가 직렬입니다. 다음 안전한
규모 시험: 분할 packet 3~4 agent × 200 sense를 한 revision에서 모두 `record`한 뒤 단일 `apply`·단일 PR로 병합하고, 호출당 색인
재구성 비용을 줄이는 변경(디스크 색인 재사용)을 먼저 측정하는 것입니다.

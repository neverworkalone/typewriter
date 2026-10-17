# STDICT 전체 import 기반 (Issue #678, PR A)

이 문서는 #678의 **코드/규칙 PR(PR A)** 결과입니다. 전체 436,587건 중 shard 데이터는 아직 `stdict-0001`만 있으며, 나머지는 후속
shard PR(약 20~25 shard씩)에서 같은 도구로 추가됩니다. 원본 JSON(`~/.cache/typewriter/reference/dict/stdict`)은 Git 밖에 있고 여기에는 집계만 적습니다.

## 원본 완전성

`data/provenance/stdict-source-inventory.json`이 88개 원본 파일의 이름·sha256·entry 수·sense 수와 사전 자체의 `channel.total`을 담은 신뢰 인벤토리입니다.
`readStdictItems()`(shard 생성과 정산의 유일한 원본 입력 경계)는 인벤토리를 필수로 받아, 파일이 빠지거나 더해지거나 바뀌거나 잘리면 어떤 산출물도 만들기 전에 실패합니다.
인벤토리는 88개 파일 / 436,587 entry / 509,143 sense의 완전한 다운로드에서만 생성되며, 읽을 때도 파일·entry·sense 수를 모두 대조합니다.
`node scripts/stdict/inventory.mjs [--verify]`로 생성·확인합니다.

## 수록 정책 (sense 단위, `scripts/stdict/policy.mjs`)

| 원본 sense | canonical | 비고 |
| --- | --- | --- |
| 명사·의존 명사·대명사·수사, 동사·형용사(보조 포함), 부사, 관형사, 감탄사 | 수록 | |
| 구·속담·관용구 | 수록(`expression`) | |
| 조사·어미·접사 자체의 의미 | 제외 | `스님`처럼 접사가 붙은 독립 명사는 수록 |
| 품사 없음 + `‘…’의 어근.` | 제외, 완성형의 검색 별칭 | 아래 참조 |
| 품사 없음 + 가장자리 `-`(어미성 결합형) | 제외 | |
| 품사 없음 + 독립 표현 | `unclassified`로 수록 | backfill 제외는 #683 |
| 미지원 명시 품사, 알 수 없는 markup | 항목 보류 | fail-closed |

남는 sense는 원본 순서 번호(`-s<n>`)를 유지하고 재번호를 매기지 않습니다(검증: #681). 허용 sense가 하나도 없으면 record를 만들지 않습니다.

## 어근 별칭

어근 sense의 뜻풀이가 가리키는 완성형(표기 + 동형이의어 번호)이 원본에서 **정확히 하나**이고 자기 자신이 아니며 수록되는 경우에만, 어근 표기를
그 완성형 record의 `search_forms`에 더합니다. 별칭은 record나 sense가 아니므로 backfill 대상이 되지 않고, 정확 표제어와 같은 문자열이면 둘 다
검색됩니다(검증: #682). 연결하지 못한 어근은 건수만 집계합니다(`stdict-settlement.json`의 `roots`).

## Shard 구성 (`build-shard.mjs`, `selection_version: stdict-selection-v2`)

- shard 1 = 파일럿 1,000건 중 정책이 여전히 수록하는 record(id·shard 유지) + 부족분을 아직 미배정인 적격 `target_code` 오름차순으로 보충.
- shard n≥2 = 나머지 적격 `target_code`를 오름차순 1,000건씩. 한 번 적재된 record는 옮기지 않습니다.
- `node scripts/stdict/build-shard.mjs --through N [--verify]`는 shard 1..N과 provenance를 원본에서 재생성합니다. 관계는 적재된 shard 안의 대상에만
  생기며, 아직 적재되지 않은 대상은 `out-of-sample`로 집계되어 이후 `--through`에서 같은 record 안에 추가됩니다.
- provenance(`data/provenance/stdict-NNNN.json`)는 원본 `sense_codes` 전체를 유지합니다. 수록 sense의 id 접미사 n이 그 배열의 인덱스입니다.

## 정산 (`settle.mjs`, `data/provenance/stdict-settlement.json`)

`node scripts/stdict/settle.mjs [--verify]`가 원본 전수를 수록/제외/보류로 정산합니다. 모든 항목은 한 범주에 한 번만 들어가며(`reconciliation`) 근거 없는
누락이 없습니다.

| | 값 |
| --- | --- |
| 원본 entry / sense | 436,587 / 509,143 |
| 수록 entry / sense | 427,583 / 499,359 |
| 제외 entry / sense | 9,004 / 9,784 (조사 363·어미 1,055·접사 727·어근 7,305·결합형 334 sense) |
| 보류 | 0 (`w516304`는 crossed sub/sup 변환으로 해소) |
| 어근 별칭 | 7,297 연결, 8 대상 없음(수작업 판단 필요, 연결 안 함) |
| 정의 `<img>` | 304건 제거 |
| 관계(전량 적재 가정) | 동의어 162,057·반대말 6,338 변환, broken 3, self 1 |
| shard | 428개(마지막 583건) |

## 공통 gate 변경

- 공식 출처 record끼리만 얽힌 활용형 충돌은 정책(정확 일치 우선, 모든 후보 유지)이 고정되어 있어 형태별 검토 항목을 요구하지 않습니다. 전량이면 ambiguous
  63,510·exact 873건이라 manifest가 약 20MB가 되는 문제였습니다. 저자 작성 후보가 하나라도 섞이면 기존 검토가 유지됩니다
  (`reviewableCollisions`, 회귀: `tests/surface-form-projection.test.mjs`).
- 파일럿 때 쌓인 `m6-3-surface-form-review.json` 항목은 #679 규칙으로 불필요해져 비웠습니다(생성 형태 동일).

## 전량 규모 실측

원본 읽기·색인·정책 판정·shard 배정 약 8초, 정산 약 16초, 전량 변환 5초, 용언 투영 2초(1.7GB RSS 이하).

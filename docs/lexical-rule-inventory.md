# Lexical rule inventory — M2 to PR #120

이 문서는 M2부터 PR #120까지 Typewriter의 단어 생산·편집·감사·admission·회귀 규칙을 분류한 기록이다. 규칙이 특정 `m5-*` 파일이나 과거 record ID에 등장했다는 이유만으로 batch policy가 되지는 않는다. 현재와 미래의 단어에 적용되어야 하는 규칙은 shared implementation에만 둔다.

기계적으로 검증되는 목록은 [`data/validation/lexical-rule-inventory.json`](../data/validation/lexical-rule-inventory.json)이며, `npm run validate:rules`가 다음을 확인한다.

- 다섯 classification이 모두 존재하고 rule ID가 중복되지 않는다.
- active rule의 implementation path가 repository 안에 존재한다.
- dictionary-wide/admission invariant는 `scripts/validate/`, `scripts/batch/lexical-*`, 또는 generic reviewed-import adapter가 소유한다.
- `obsolete/duplicate` 항목은 active implementation을 가질 수 없고 replacement/prohibition을 설명해야 한다.
- identifier-specific bypass 선언을 rule inventory에 등록해 공통 규칙처럼 위장할 수 없다.

## Classification

| 분류 | 의미 | 현재 소유 계층 |
| --- | --- | --- |
| dictionary-wide invariant | 기존·신규·수정된 모든 canonical record/sense에 적용되는 불변식 | canonical schema, dataset integrity, lexical quality, inventory, build, search |
| admission invariant | 새 record 또는 수정 record가 canonical에 들어가기 전에 반드시 통과해야 하는 불변식 | semantic audit, shared production state, production orchestration, lexical admission, generic batch adapter |
| batch policy | 목표 개수, reserve, ID 범위, timing, authorization처럼 한 실행에만 필요한 정책 | M5-11, Wave A2, Wave B validator와 recorder |
| historical assertion | 과거 count/digest/result를 보존하는 회귀 주장 | M5-8, M5-9, M5-10D, M5-11 base snapshot |
| obsolete/duplicate | 더 이상 실행 경로가 아니며 shared contract로 대체되었거나 금지된 과거 방식 | active owner 없음 |

## Shared production pipeline

모든 lexical admission은 아래 순서의 `lexical-production-v1` state를 남긴다. 각 stage는 실제 입력 bytes의 SHA-256으로 source-bound 된다.

```text
candidate_intake
      ↓
semantic_review → selection
      ↓             ↓
prospective_canonical
      ↓
audit
      ↓
admission
      ↓
SQLite → search → package → clean-checkout validation
```

실행별 모듈은 scope/count/ID/timing/authorization만 추가한다. 의미 판정, lemma/search-form 검사, POS/expression 판정, sense boundary, relation integrity, no-relation rationale, gloss quality는 다음 공통 계층을 사용한다.

- [`scripts/batch/lexical-production-state.mjs`](../scripts/batch/lexical-production-state.mjs) — 여섯 stage와 transition을 강제한다.
- [`scripts/batch/lexical-production.mjs`](../scripts/batch/lexical-production.mjs) — candidate, separately authored review, selection, correction, prospective binding을 조정한다.
- [`scripts/batch/lexical-admission.mjs`](../scripts/batch/lexical-admission.mjs) — complete base/prospective canonical, semantic audit, dataset integrity, lexical audit를 한 번에 검증한다.
- [`scripts/validate/lexical-quality.mjs`](../scripts/validate/lexical-quality.mjs) — 모든 record/sense의 lexical identity와 writer-facing gloss/domain 품질을 검사한다.
- [`scripts/validate/semantic-audit.mjs`](../scripts/validate/semantic-audit.mjs) — 모든 sense의 content digest, POS/type/domain/relation evidence와 review pass를 결속한다.
- [`scripts/batch/validate-batch.mjs`](../scripts/batch/validate-batch.mjs) — generic reviewed import adapter이며, missing/partial prospective input과 stale state를 fail-closed 한다.

`data/canonical/`은 여전히 canonical source of truth다. 외부 proposal, decision, timing, audit 원자료는 repository 밖에서 준비하며, Git에는 필요한 compact evidence와 최종 curated canonical만 둔다. Promotion은 complete prospective gate가 성공한 뒤의 별도 명시적 단계다.

## Full-canonical re-audit

PR #120 이후 canonical snapshot은 1,320 records / 1,278 starts / 42 reference-only / 1,588 senses다. [`data/validation/canonical-semantic-decision-source.json`](../data/validation/canonical-semantic-decision-source.json), [`data/validation/canonical-semantic-review.json`](../data/validation/canonical-semantic-review.json), [`canonical-semantic-coverage.json`](../data/validation/canonical-semantic-coverage.json), [`canonical-semantic-audit.json`](../data/validation/canonical-semantic-audit.json)이 같은 canonical content digest에 결속되어 있으며, review pass는 모든 record/sense를 포함하고 open blocker 0건을 요구한다.

기존 데이터 수정은 silent mutation이 아니다. 변경이 필요한 경우 separately authored `corrected` decision과 correction history가 있어야 하며, 새 audit가 수정 후 digest를 다시 확인한다. 기존 start를 줄이거나 record ID에 따라 검사를 생략하지 않는다.

## Historical paths

M5-10A Wave A2와 M5-10 Wave B는 historical replay를 위해 각자의 scope/chronology/previous-stage chain을 보존하지만, review artifact, prospective canonical, semantic audit, admission state는 shared contract를 사용한다. M5-8/M5-9/M5-10D의 count·digest·recovery 결과는 historical assertion으로만 남고, 미래 lexical admission의 quality exemption으로 사용되지 않는다.

새 batch는 generic `validateBatch`/`writeReviewedBatchImport`와 shared production API를 사용해야 한다. 새로운 `m5-*` lexical quality fork, partial prospective submission, direct canonical append, batch/record-ID bypass는 inventory상 obsolete/duplicate이며 허용되지 않는다.

## Validation entry points

```sh
npm run validate:rules
npm run validate:lexical
npm run validate
npm test
```

CI는 canonical schema, dataset integrity, target inventory, rule inventory, complete semantic audit, lexical regression, build/search/package 검증을 함께 실행한다. 따라서 current canonical만 손으로 고치고 producer/validator regression을 남기지 않는 변경은 clean checkout에서 재현되지 않는다.

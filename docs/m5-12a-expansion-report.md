# M5-12A exact +722 promotion report

Issue #138 completes the agent-authorized continuation of issue #98 from the
retained 1,278-start M5-12 base. It uses the shared lexical producer,
source-bound semantic decision source, complete lexical/semantic audit, and
admission transaction; it does not introduce a batch-local quality policy.

## Fixed scope

| 항목 | 값 |
| --- | ---: |
| candidate identity capacity | 802 |
| imported starts | 722 |
| reserve | 80 |
| included | 700 |
| corrected | 22 |
| held | 30 |
| rejected | 20 |
| deferred | 30 |
| processed denominator | 772 |
| final canonical starts | 2,000 |
| final expression records | 145 |

The 802 identities are Typewriter-authored and deterministically bound to
`m5-12-slot-0001` through `m5-12-slot-0802`, inventory IDs `m5-1085` through
`m5-1886`, and proposed canonical IDs `w1279` through `w2080`. Candidate bodies
are materialized only in the temporary proposal/review workspace. The tracked
identity source is [`scripts/batch/m5-12a-candidate-source.mjs`](../scripts/batch/m5-12a-candidate-source.mjs);
it records the source identity count and digest without retaining external raw
material.

## Provenance and gate

The promotion is explicitly `agent-generated`. The durable M5-12A semantic
decision source is an independently authored, candidate-by-candidate Codex
verification pass (`m5-12a-agent-semantic-review-20260920-r2`), not a
deterministic projection of the candidate generator. Generation and
verification use separate pass IDs, and the artifacts set
`human_editorial_review_complete` to `false`; no human timing or human-review
claim is made. Every selected sense has source-bound POS, expression, boundary,
relation, and explicit no-relation evidence. The prospective semantic decision
source covers all 2,042 records and 2,301 senses with zero open findings.

The fixed gate passed with zero candidate/canonical lexical collisions, a
2.85% correction rate over the 772 processed rows, zero admitted relation
tuples/noise events, complete audit coverage, and no canonical mutation before
the promotion transaction. The base relation snapshot and prospective
snapshot both contain 487 tuples.

Promotion outputs are bound in:

- [`data/batches/m5-12a-admission.json`](../data/batches/m5-12a-admission.json)
- [`data/batches/m5-12a-promotion.json`](../data/batches/m5-12a-promotion.json)
- [`data/canonical/m5-12a-expansion.jsonl`](../data/canonical/m5-12a-expansion.jsonl)
- [`data/inventory/m5-target-seed.json`](../data/inventory/m5-target-seed.json)
- [`data/validation/canonical-semantic-decision-source.json`](../data/validation/canonical-semantic-decision-source.json)

The promotion records issue #7's checkpoint at 2,000 canonical starts. No next
`+1000` expansion is created by this issue.

## Reproduction and validation

```sh
npm run batch:m5-12a:check
npm run validate
npm test
npm run build
npm run validate:package
```

The promotion command is intentionally explicit and is not part of ordinary
CI:

```sh
npm run batch:m5-12a:promote
```

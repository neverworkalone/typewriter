# M5-3 calibration batch report

Batch: `m5-3-calibration-20260907`<br>
Reviewed inventory: `m5-core-5k`, revision `m5-1`<br>
Post-import inventory revision: `m5-2`<br>
Manifest: [`data/batches/m5-3-calibration.json`](../data/batches/m5-3-calibration.json)<br>
Structured measurements: [`data/batches/m5-3-calibration-metrics.json`](../data/batches/m5-3-calibration-metrics.json)<br>
Relation event ledger: [`data/batches/m5-3-relation-diff.json`](../data/batches/m5-3-relation-diff.json)

## Outcome

The calibration batch imported 52 new search starts from the 60-row representative
inventory. It also imported 12 reference-only records to close relation targets.
The 60 candidate decisions were:

| Decision | Count | Rate of selected starts |
| --- | ---: | ---: |
| `included` | 11 | 18.33% |
| `corrected` | 41 | 68.33% |
| `held` | 4 | 6.67% |
| `rejected` | 4 | 6.67% |
| Importable starts | 52 | 86.67% |

The correction rate is 41/60 (`68.33%`) across the selected inventory, or 41/52
(`78.85%`) among the imported starts. The held and rejected decisions remain in
the manifest with decision notes. Rejected rows remain `candidate` in the seed
because the inventory status vocabulary has no `rejected` state; the manifest is
the authoritative batch decision record.

## Selection coverage

The inventory supplied by #76 already contained the selection pass, so #78 added
no second selection pass (`0` seconds of new selection preparation in this batch).
The 60 rows remained balanced across six writer-facing groups:

| Group | Selected | Imported | Held | Rejected |
| --- | ---: | ---: | ---: | ---: |
| Emotion / inner state | 10 | 9 | 1 | 0 |
| Quality / attitude | 10 | 9 | 0 | 1 |
| Sensory image | 10 | 9 | 1 | 0 |
| Scene / time / nature / space | 10 | 8 | 1 | 1 |
| Action / relation / change | 10 | 10 | 0 | 0 |
| Object / expression | 10 | 7 | 1 | 2 |

## Editorial measurements

The reviewed import contains 82 senses, 88 relations, and three independent
expression records. Sense POS counts are adjective 23, expression 3, noun 37,
and verb 19.

Relation types in the imported records are:

| Type | Count |
| --- | ---: |
| `action` | 6 |
| `association` | 7 |
| `antonym` | 1 |
| `direct` | 3 |
| `mood` | 18 |
| `near` | 27 |
| `scene` | 7 |
| `sensory` | 19 |

Twenty-three records corrected sense fields and 41 corrected relation fields.
For the records whose manifest lists `relations` as corrected, the final relation
mix is action 6, association 7, antonym 1, direct 1, mood 15, near 22, scene
4, and sensory 10. The reviewed draft intentionally stored only candidate metadata,
not relation bodies, so this final mix is not used as a relation-change metric.

M5-4 reconstructs the review changes as a relation event ledger without adding a
raw draft. The relation snapshot had 139 edges before the final admission pass and
88 after it: 51 `remove`, 0 `add`, 2 `retype`, and 4 `retarget` events. The
classified removal events are:

| Failure type | Events |
| --- | ---: |
| `arbitrary-modifier-or-place` | 19 |
| `generic-result-or-reaction` | 11 |
| `unsupported-cross-sensory` | 11 |
| `broad-common-category` | 8 |
| `sense-target-type-error` | 1 |
| `incidental-co-occurrence` | 1 |

The six changed events also carry `sense-target-type-error` because they correct a
target or relation type. Counts in this paragraph are generated from the relation
diff artifact; the earlier narrative's aggregate “five retyped or retargeted”
number was not an event-level measurement and is not retained as an authoritative
metric.

All three `direct` relations include an explicit sentence-slot substitution in
the editorial note. The first feedback pass rechecked all 52 imported starts and
82 imported senses, removed 12 broad or unsupported relation edges, corrected the
`단정하다` adjective/verb boundary, and removed the taste reading from the first
`시큰하다` sense. A second full admission audit applied the same rule to the
remaining 127 relations and removed 39 more, leaving 88. The event ledger is the
authoritative count for the final relation changes.

The admission rule kept a relation only when its stable writer-facing use is
explained by the source sense: direct/near/antonym substitution or contrast,
stable mood adjacency, a core sensory or scene image, a direct action affordance,
or a conventional association. It removed incidental co-occurrence, generic
outcomes, arbitrary modifiers or places, broad category links, and unsupported
cross-sensory links. Representative removals were `w335 안뜰 → w147 창가`,
`w318 비뚤어지다 → w054 빈틈`, `w349 얼룩 → w079 촉감`, `w311 소박하다 →
w031 다정하다`, and `w304 체념 → w240 잊다`. Representative retained links
were the direct `w305 자부심 → r038 긍지`, near `w321 미지근하다 → r042
미온`, sensory `w346 등불 → w066 빛`, and action `w352 기억을 더듬다 →
w239 기억하다`.

The final audit records zero open direct-replacement errors, zero open over-broad
relation errors, and zero open reference-closure errors. All 12 reference-only records are
referenced by an imported start with explicit target senses.

The original batch review window remains the timing baseline below. The feedback
audit was a separate editorial pass and was not individually timed.

## Timing baseline

The manifest interval from `2026-09-07T08:29:02Z` to
`2026-09-07T08:39:05Z` is 603 seconds (`00:10:03`). This is 10.05 seconds per
selected start and 11.60 seconds per imported start. Individual decision timers,
feedback fixes, final audit, held/rejected review time, and editor time were not
instrumented. The derived metrics therefore report `timing.status: "incomplete"`
and do not claim a total actual review time.

## Import and inventory transition

The reviewed canonical artifact was staged outside the repository, passed the
#77 batch validator, and then copied into
[`data/canonical/m5-3-calibration.jsonl`](../data/canonical/m5-3-calibration.jsonl).
The raw draft and temporary reviewed staging file remain outside the repository.
The 52 seed rows now retain their `m5-*` inventory identities and map to `w301`
through `w352`; the 12 closure records are `r036` through `r047`. The seed and
generated inventory moved to revision `m5-2`.

The post-import snapshot is:

| Count | Value |
| --- | ---: |
| Canonical records | 390 |
| Current starts | 352 |
| Current reference-only | 38 |
| Remaining candidate starts | 4 |
| Held rows | 7 |
| Duplicate rows | 2 |
| Inflected-form rows | 2 |

## Validation record

The following checks passed for this batch:

- `npm run batch:validate -- --manifest=/tmp/typewriter-m5-3-calibration/manifest.json --staged-records=/tmp/typewriter-m5-3-calibration/reviewed.jsonl --json=true`
- `npm run batch:metrics -- --manifest=data/batches/m5-3-calibration.json --relation-diff=data/batches/m5-3-relation-diff.json --check=data/batches/m5-3-calibration-metrics.json`
- `npm test` — 73 tests passed, including the M5-3 manifest/import/inventory and SQLite search regressions
- `npm run validate` — 390 records, 468 senses, 428 relations, and inventory revision `m5-2`
- `npm run test:unit`
- `npm run validate:search` — existing M4 search regression corpus
- SQLite representative lookups for `감격`, `미지근하다`, `여명`, and `목이 메다`, including polysemous and reference target-sense checks
- deterministic SQLite rebuild and logical snapshot comparison
- non-minified and minified product build/package validation

Chrome-for-Testing was not launched for this run, per the execution instruction;
the representative search check therefore stops at the SQLite/query contract and
does not claim a live Chrome product-flow result.

No raw draft body, external source response, or temporary staging file is part of
the repository or product package.

## Gate decision

This batch is the M5 calibration baseline, not approval for a later bulk batch. The
measured correction rate, excluded decisions, relation diff, closure result, and
incomplete timing must be reviewed against the fixed criteria in
[`m5-expansion-gate.md`](m5-expansion-gate.md) and issue #7 before selecting
another batch. No later bulk generation should begin until that gate is explicitly
updated.

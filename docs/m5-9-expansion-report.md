# M5-9 expansion report

## Scope

Batch: m5-9-expansion-20260908
Stage: m5-8-stage-01-plus-100
Selection inventory: data/batches/m5-9-preimport-inventory.json, revision m5-5
Manifest: data/batches/m5-9-expansion.json
Canonical import: data/canonical/m5-9-expansion.jsonl
Stage report: data/batches/m5-8-stage-01-plus-100.json

M5-9 is the first staged expansion after the M5-8 workflow redesign. It processes a
declared reserve pool and promotes exactly 100 new canonical start records. The
candidate list, glosses, sense decisions, relation admission, and timing notes are
Typewriter-authored editorial metadata. Raw external responses and unreviewed drafts
remain outside the repository.

## Selection and decisions

The pre-import inventory declares 112 new editorial start candidates:

| Item | Count |
| --- | ---: |
| Net canonical start target | 100 |
| Maximum reserve pool | 12 |
| Selected starts | 112 |
| Included | 82 |
| Corrected | 18 |
| Held | 4 |
| Rejected | 3 |
| Deferred unused reserve | 5 |
| Processed starts (included + corrected + held + rejected) | 107 |

The 100 included/corrected rows are m5-137–m5-236 and map deterministically
to w429–w528. Seven reserve rows were held or rejected; the five unused
reserve slots remain candidate rows and are represented as deferred in the
manifest. Deferred rows are neither canonical data nor part of the processed-start
denominator.

All 100 imported records received a reviewed lemma, POS, deterministic sense ID, and
short Typewriter-authored gloss. The follow-up audit rechecked literal/figurative and
expression boundaries for all 100 importable starts: 87 remained deliberately scoped
to one sense and 13 were split into separate senses (`w456`, `w458`, `w459`, `w460`,
`w462`, `w472`, `w481`, `w517`, `w518`, `w519`, `w520`, `w527`, `w528`). Fourteen
are expression records. Relation review ran only after the sense/POS checkpoint:
25 source-bound candidates were reviewed, 13 admitted and 12 rejected. The remaining
records intentionally have empty relation lists. No relation quota was applied.

## Canonical snapshot

| Count | Before | After |
| --- | ---: | ---: |
| Canonical records | 470 | 570 |
| start records | 428 | 528 |
| reference-only records | 42 | 42 |
| Senses | 557 | 670 |
| Relations | 449 | 462 |
| Expression records | 23 | 37 |

The relation artifact is data/batches/m5-9-expansion-relation-diff.json.
It records the 25 source-bound relation candidates and their admit/reject decisions;
13 admitted additions remain in the canonical result (`before_count: 0`,
`after_count: 13`). The 12 rejected candidates are the actual noise denominator:
12/25 = 48%, above the fixed 25% ceiling. Its SHA-256 is
`b9b70d553286d82b79aaa40f438165fef0b8a32f71b36b945170301589258153`.

## Timing record

The five required editorial passes have measured totals of 2,100 wall-clock
seconds and 1,090 editor seconds across 107 processed starts. The follow-up work
was not instrumented, so its former 02:35–02:53Z entries are not retained as
measurements. The manifest's `review.completed_at` remains the end of the initial
editorial review; the later PR feedback cycles are recorded explicitly:

| Cycle | Feedback received | Audit | Fixes |
| ---: | --- | --- | --- |
| 1 | 2026-09-08T06:29:10Z | unmeasured | unmeasured |
| 2 | 2026-09-08T07:11:30Z | unmeasured | unmeasured |
| 3 | 2026-09-08T07:35:52Z | unmeasured | unmeasured |

The derived metrics use `post-review-audit#N` and `post-review-fixes#N` keys for
these repeated entries. Because six follow-up passes are unmeasured, timing is
`incomplete`; 1,090 editor seconds is only a measured lower bound and is not used
as a complete per-start cost.

## Gate result

The derived metrics are data/batches/m5-9-expansion-metrics.json.
The independent verification flags are data/batches/m5-9-expansion-verification.json.

| Criterion | Result |
| --- | --- |
| All new senses and relations reviewed | PASS |
| Correction rate | PASS: 18/107 = 16.82% (max 50%) |
| Relation noise | FAIL: 12/25 = 48% (max 25%; M5-3 baseline 51/139 = 36.69%) |
| Editor time | FAIL: follow-up work was not instrumented; 1,090 sec is only a measured lower bound |
| Required and follow-up timing passes | FAIL: six unmeasured passes across three feedback cycles |
| Independent audit | PASS: complete, open blockers 0 |
| Canonical integrity | PASS |
| Deterministic SQLite | PASS |
| M4 search/product regression | PASS |
| Exact canonical start delta | PASS: 428 → 528 |

Decision: **HOLD PROCESS**. The relation admission process must be repaired and
re-audited before another bounded stage or bulk expansion is authorized. The five
deferred reserve candidates are not silently counted as imported starts.

## Reproduction and validation

The selection gate was run against the revision-m5-5 inventory and a clean
external copy of the 470-record pre-import canonical directory:

```sh
npm run batch:validate -- \
  --manifest=data/batches/m5-9-expansion.json \
  --staged-records=/tmp/typewriter-m5-9-preimport/reviewed.jsonl \
  --inventory=data/batches/m5-9-preimport-inventory.json \
  --canonical-dir=/tmp/typewriter-m5-9-preimport/data/canonical
```

The checked-in result is reproducible with:

```sh
npm run validate
npm run batch:metrics -- --manifest=data/batches/m5-9-expansion.json \
  --relation-diff=data/batches/m5-9-expansion-relation-diff.json \
  --check=data/batches/m5-9-expansion-metrics.json
npm run test:unit
npm test
npm run validate:search
npm run verify:m2
```

Non-minified and minified package validation were also run. Chrome for Testing was
not launched: this stage changes canonical data and deterministic build inputs, not
a browser-only boundary.

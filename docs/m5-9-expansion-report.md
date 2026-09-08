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
| Included | 93 |
| Corrected | 7 |
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
short Typewriter-authored gloss. Fourteen are expression records. Relation review
ran only after the sense/POS checkpoint and admitted 25 exact source-sense/target-
sense tuples; the remaining records intentionally have empty relation lists. No
relation quota was applied.

## Canonical snapshot

| Count | Before | After |
| --- | ---: | ---: |
| Canonical records | 470 | 570 |
| start records | 428 | 528 |
| reference-only records | 42 | 42 |
| Senses | 557 | 657 |
| Relations | 449 | 474 |
| Expression records | 23 | 37 |

The relation artifact is data/batches/m5-9-expansion-relation-diff.json.
It records 25 admitted additions for this batch (before_count: 0,
after_count: 25) and zero classified noise events. Its SHA-256 is
87183d0e5bbacd9b7c935abd30da767b5b314f3e6a78a2aa885f86fc405d252b.

## Gate result

The derived metrics are data/batches/m5-9-expansion-metrics.json.
The independent verification flags are data/batches/m5-9-expansion-verification.json.

| Criterion | Result |
| --- | --- |
| All new senses and relations reviewed | PASS |
| Correction rate | PASS: 7/107 = 6.54% (max 50%) |
| Relation noise | PASS: 0/0 = 0% (max 25%, below 51/139) |
| Editor time | PASS: 1,090/107 = 10.19 sec/processed start (max 12 sec) |
| Required timing passes | PASS: all five complete; no unmeasured pass |
| Independent audit | PASS: complete, open blockers 0 |
| Canonical integrity | PASS |
| Deterministic SQLite | PASS |
| M4 search/product regression | PASS |
| Exact canonical start delta | PASS: 428 → 528 |

Decision: **APPROVE BOUNDED**. The next +250 stage is authorized only within the
same review gate and source-bound process. The five deferred reserve candidates are
not silently counted as imported starts.

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

# M5-10A Wave A2 validation report

## Result

Issue #110 completes the Wave A2 editorial and audit workflow for the external
50-record proposal plus an 8-record decision buffer. The Codex editorial pass
reviewed all 50 starts record by record, checked all six sense-boundary fields,
and froze the reviewed staging digest. A separate Codex audit pass then
rechecked the frozen digest in a different session and artifact. Both passes
are `codex-authored`; #110 does not require a human identity or two different
actors. The completion recorders consume separately supplied decision artifacts;
they do not manufacture record decisions, relation findings, or a clean audit
result.

The reviewed, zero-blocker staging was imported into canonical, taking the
product from 578 to 628 starts. The initial PR timing claim was superseded
because its editorial completion preceded the timing session. A fresh
chronological recorder session now measures 530.207 editor seconds across 56
processed starts, or 9.467982 seconds per processed start, so the fixed gate
passes. The source-bound stage report therefore records `APPROVE BOUNDED` and
`ready_to_create: true`, while `next_stage_created` and
`next_stage_authorized` remain `false`: a passing metric does not create or
authorize a GitHub task by itself.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A2 input/base canonical | 620 | 578 | 42 | 743 | 467 | 39 |
| External proposal staging | 50 | 50 | 0 | 67 | 6 | 4 |
| Frozen reviewed staging/import | 50 | 50 | 0 | 66 | 6 | 4 |
| Current product canonical | 670 | 628 | 42 | 809 | 473 | 43 |
| Net canonical change | +50 | +50 | 0 | +66 | +6 | +4 |

The 58 selected target rows resolved to 34 `included`, 16 `corrected`, 3
`held`, 3 `rejected`, and 2 `deferred`. The six buffer rows assigned to
`held`/`rejected` are not canonical; the two deferred rows remain visible in
the inventory for a later decision. The 50 included-or-corrected rows are the
only rows imported.

## Editorial pass

The final editorial input is `codex-authored` and `complete`. It independently
records the lemma, POS, sense count, sense-boundary decisions, and record-level
decision for every selected start. All 50 starts have complete checkpoints and
all six boundary IDs are reviewed. There are 15 multi-sense split records and
16 sense-field corrections: the additional correction is a single-sense gloss
correction for `w582`. The reviewed result also removes the duplicate third
sense from `w603`, preserves the three observed senses of `w620`, and keeps the
`w621-s2 → w009-s1` relation as `association`.

The machine verification artifact therefore sets `editorial_review_complete` to
`true`. Its legacy `human_editorial_review_complete` compatibility flag is
explicitly `false`; no human identity or human-review claim is being made.

The frozen reviewed staging file is external to the repository and is bound by
SHA-256:

```text
proposal staging:  290a74905da1eea8e816dc7273acca2abe09c9a94e30217c0abb3f3e96717dd8
reviewed staging:  4be5e7571f0d219fe3a30e68eaa0dc0cca832fbfe8402fe379a46f9f4e7768a8
```

The import validator checks the reviewed digest against the actual external
JSONL bytes. Candidate bodies are not copied into review metadata; only the
reviewed canonical result is tracked in
[`data/canonical/m5-10a-wave-a2.jsonl`](../data/canonical/m5-10a-wave-a2.jsonl).

## Relation audit

The relation screen started empty and admitted the six candidates one by one
after the sense pass. All six were retained with record-specific notes: three
`mood`, one `near`, one `sensory`, and one `association`. The candidate noise
rate is `0/6 = 0%`, with no pending candidates and no relation-noise events.

The separate audit input is complete and independently bound to the same
reviewed staging digest. It rechecks all 50 promoted canonical starts and all
six relation decisions. The audit has four resolved findings (sense,
relation-noise, buffer-decision, and timing-measurement) and zero open blockers.
The editorial and audit passes use the same Codex actor ID, but distinct UUID
sessions and distinct provenance artifacts, which is the independence rule for
this milestone.

## Timing and gate

The five required passes are all complete, recorder-backed, chronological, and
have no unmeasured passes:

| Pass | Editor seconds |
| --- | ---: |
| target preparation | 32.243 |
| initial review | 350.806 |
| feedback fixes | 101.258 |
| final audit | 35.358 |
| held/rejected decisions | 10.542 |
| **total** | **530.207** |

There are 56 processed starts after excluding the two deferred buffer rows, so
the measured rate is `530.207 / 56 = 9.467982...` seconds per processed start.
Timing completeness, correction rate (`16/56`), relation noise (`0%`), audit
blockers (`0`), canonical integrity, SQLite reproducibility, and search/product
regressions also pass. The stage carries a `correction_plan` field for a future
failed timing result, but this run marks it `not-required` because the fixed
gate passes.

The timing session stops before editorial completion, and the audit starts only
after editorial completion and all timing stops. The editorial record decisions
are supplied in a separate tracked artifact, and the audit relation decisions
and findings are supplied in a second tracked artifact created during the
separate audit session. The recorder outputs bind those artifacts by path,
digest, session, and chronology.

## Source artifacts

- [`data/batches/m5-10-wave-a2.json`](../data/batches/m5-10-wave-a2.json) —
  source-bound selection, review projection, and digest bindings.
- [`data/batches/m5-10a-wave-a2-editorial-input.json`](../data/batches/m5-10a-wave-a2-editorial-input.json) —
  complete Codex editorial pass and frozen staging digest.
- [`data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json`](../data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json) —
  separately supplied record-level editorial decisions consumed by the
  editorial recorder.
- [`data/batches/m5-10a-wave-a2-audit-input.json`](../data/batches/m5-10a-wave-a2-audit-input.json) —
  separate complete audit pass over the frozen digest.
- [`data/batches/m5-10a-wave-a2-audit-decisions-20260909.json`](../data/batches/m5-10a-wave-a2-audit-decisions-20260909.json) —
  separately supplied relation reviews and audit findings consumed by the
  audit recorder.
- [`data/batches/m5-10a-wave-a2-provenance-editorial-20260909.json`](../data/batches/m5-10a-wave-a2-provenance-editorial-20260909.json)
  and [`data/batches/m5-10a-wave-a2-provenance-audit-20260909.json`](../data/batches/m5-10a-wave-a2-provenance-audit-20260909.json)
  — session, actor, completion-time, and subject-digest evidence.
- [`data/batches/m5-10a-wave-a2-timing-input.json`](../data/batches/m5-10a-wave-a2-timing-input.json)
  — current-clock timing events and work-unit evidence.
- [`data/batches/m5-10a-wave-a2-relation-diff.json`](../data/batches/m5-10a-wave-a2-relation-diff.json)
  — final six-candidate relation screen.
- [`data/batches/m5-10a-wave-a2-metrics.json`](../data/batches/m5-10a-wave-a2-metrics.json)
  — deterministically derived decisions, counts, timing, and audit metrics.
- [`data/batches/m5-10a-wave-a2.json`](../data/batches/m5-10a-wave-a2.json) —
  final stage report with the passing gate, readiness flag, and uncreated/un-authorized next-stage flags.
- [`data/inventory/m5-target-inventory.json`](../data/inventory/m5-target-inventory.json)
  — regenerated inventory with 628 current starts and the remaining candidates.
- `data/batches/m5-10a-wave-a-base-canonical/` — immutable 578-start source
  snapshot used to keep historical Wave A inputs reproducible.

The external proposal and frozen reviewed staging JSONL remain outside the
repository. No raw proposal body or unreviewed source material is canonical.

## Validation

The following deterministic checks passed:

```text
npm run validate
npm run validate:search
npm run batch:m5-10a:calibration:check
npm run batch:m5-10a:process:check
npm run batch:m5-10a:repair:check
npm run batch:m5-10a:wave-a2:check -- --staged=/private/tmp/typewriter-m5-10a-wave-a2-reviewed.jsonl
npm run verify:m2
npm run build:dictionary
npm run package
npm run test:unit
npm test
```

The full Node regression suite and unit suite were rerun after the recorder and
stage-gate changes. Chrome/CFT was not launched because this change is
covered by deterministic data, SQLite, search, and package checks and the task
explicitly requested no Chrome launch.

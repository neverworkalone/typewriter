# M5-10 Wave B validation report

## Result

Issue #96 Wave B completes the final authorized `+150` expansion after the
passing Wave A2 result. It uses the A2 report and a separate Wave B
authorization as digest-bound inputs, reviews 170 selected starts, and imports
exactly 150 of them: 144 are included and 6 are sense-corrected. The canonical
snapshot advances from 628 to 778 starts and from 809 to 966 senses.

The source-derived gate is `APPROVE BOUNDED`. Timing is complete, the separate
post-freeze audit has zero open blockers, canonical integrity and deterministic
SQLite checks pass, and the search/product regression passes. The stage does
not create or authorize a later task: `ready_to_create: false`,
`next_stage_created: false`, and `next_stage_authorized: false`.

This is a Codex-authored editorial and audit record. The verification artifact
keeps `editorial_review_complete: true` and
`human_editorial_review_complete: false`; no human review identity is claimed.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A2 input/base canonical | 670 | 628 | 42 | 809 | 473 | 43 |
| Selected Wave B starts | 170 | 170 | 0 | — | — | — |
| Reviewed/imported staging | 150 | 150 | 0 | 157 | 0 | 20 |
| Current product canonical | 820 | 778 | 42 | 966 | 473 | 63 |
| Net canonical change | +150 | +150 | 0 | +157 | 0 | +20 |

The 170 selected starts contain 144 `included`, 6 `corrected`, 10 `held`, and
10 `deferred` decisions. No rows were `rejected`. The 20-row buffer remains
outside the imported canonical result and outside the completed sense-review
count; 160 starts are the processed denominator used for the timing gate.

All 150 imported starts have a reviewed sense/POS result and all six required
sense-boundary checks. Six known homonym/polysemy cases are split into their
curated sense sets; the remaining 144 imported starts retain one sense. The
relation diff is intentionally empty. Wave B has no relation quota, and no
relation was admitted merely to make a record look more complete.

## Source-bound review and audit

The external proposal contains 170 selected rows and is not committed. Its
SHA-256 is:

```text
60a430455dc30c93f8497326654676f04489cf5a316693c01ceb661f6b9f3765
```

The separately reviewed 150-row staging shard is also external to the
repository and is bound by:

```text
575def45e3df1fdfca79cb060ab2a3c4b04c060a067d806ab78454af15abb206
```

The editorial completion recorder reconstructs the decision artifact from
recorder-owned boundary and record-decision work rows, together with the frozen
staging bytes. The audit completion recorder reconstructs a different decision
artifact from recorder-owned post-freeze audit rows and the frozen editorial
digest; neither completion path accepts a pre-finalized decision artifact. The
audit compares the digest-bound proposal records, reviewed records, relation
scope, and timing evidence and produces zero findings and zero open blockers.
The empty result is derived from those comparisons; the producer emits an open
finding when a comparison differs, so a mismatch cannot be represented as a
fabricated resolved checklist item. Coverage declarations are stored separately
and cover 150 reviewed records, 20 held/deferred buffer rows, the empty relation
scope, and the timing-completeness unit.

The chronology is source-bound; each timed work row contains a recorder-invoked
producer execution bound to its unit input and output. Decision artifacts are
created and finalized after the timed work they summarize:

| Event | UTC |
| --- | --- |
| Editorial session started | `2026-09-10T04:46:24.297Z` |
| First editorial timing pass started | `2026-09-10T04:46:24.299Z` |
| Last editorial timing pass stopped | `2026-09-10T04:46:33.041Z` |
| Editorial decisions created | `2026-09-10T04:46:33.385Z` |
| Editorial decisions finalized | `2026-09-10T04:46:33.387Z` |
| Editorial input completed | `2026-09-10T04:46:33.391Z` |
| Independent audit session started | `2026-09-10T04:46:33.729Z` |
| Post-freeze audit timing started | `2026-09-10T04:46:33.738Z` |
| Post-freeze audit timing stopped | `2026-09-10T04:46:35.257Z` |
| Audit decisions created | `2026-09-10T04:46:35.568Z` |
| Audit decisions finalized | `2026-09-10T04:46:35.569Z` |
| Audit input completed | `2026-09-10T04:46:35.571Z` |

The audit timing starts after editorial completion. Each decision artifact is
created and finalized only after its corresponding timing pass stops, and both
passes use distinct session and provenance artifacts even though both are
Codex-authored.

## Timing and gate

| Pass | Recorder work units | Producer-bound seconds |
| --- | ---: | ---: |
| target preparation | 170 | 0.213 |
| initial review | 900 | 5.210 |
| feedback fixes | 150 | 1.363 |
| final audit | 150 | 1.597 |
| held/rejected decisions | 20 | 0.248 |
| post-freeze audit | 172 | 1.519 |
| **total** | **1,562** | **10.150** |

All six producer-throughput passes are measured and no producer pass is
unmeasured. Each pass appends record-level work rows to a cumulative JSONL
artifact; for each row the recorder invokes the committed producer after opening
the unit input, then records the producer source digest, execution interval, and
output digest. The work-unit count and decision artifacts are derived from those
rows after the timing stops; precomputed `--work-json`/`--work-record` payload
replay is rejected. The source-derived throughput rate is
`10.150 / 160 = 0.0634375` producer seconds per processed start, below the
separate `producer_seconds_per_selected_start_max: 1` operational check. Editorial
judgment time is intentionally unmeasured (`editor_time_status: unmeasured`);
producer throughput must not be reported as editor time or replace the fixed
editor-time expansion criterion, and it does not replace the semantic review
evidence.

The producer-throughput operational check passes, but the final stage reports
`gate_status: fail` and `decision: HOLD PROCESS` because editor time is null and
unmeasured. Its source checks bind the current canonical directory digest, the
A2 report, the Wave B authorization, the manifest, metrics, relation diff,
verification, and the external reviewed staging digest.

## Tracked artifacts

- [`data/batches/m5-10-wave-b-stage.json`](../data/batches/m5-10-wave-b-stage.json) — bounded stage result and source digests.
- [`data/batches/m5-10-wave-b.json`](../data/batches/m5-10-wave-b.json) — Wave B selection and decision manifest.
- [`data/batches/m5-10-wave-b-metrics.json`](../data/batches/m5-10-wave-b-metrics.json) — source-derived counts, timing, and audit metrics.
- [`data/batches/m5-10-wave-b-editorial-input.json`](../data/batches/m5-10-wave-b-editorial-input.json) — completed editorial input.
- [`data/batches/m5-10-wave-b-editorial-decisions-20260909.json`](../data/batches/m5-10-wave-b-editorial-decisions-20260909.json) — recorder-finalized editorial decisions reconstructed from timed work rows.
- [`data/batches/m5-10-wave-b-audit-input.json`](../data/batches/m5-10-wave-b-audit-input.json) — independent post-freeze audit input.
- [`data/batches/m5-10-wave-b-audit-decisions-20260909.json`](../data/batches/m5-10-wave-b-audit-decisions-20260909.json) — recorder-finalized audit decisions and findings reconstructed from timed work rows.
- [`data/batches/m5-10-wave-b-timing-input.json`](../data/batches/m5-10-wave-b-timing-input.json) and [`data/batches/m5-10-wave-b-audit-timing-input.json`](../data/batches/m5-10-wave-b-audit-timing-input.json) — measured timing evidence.
- [`data/batches/m5-10-wave-b-semantic-regressions.json`](../data/batches/m5-10-wave-b-semantic-regressions.json) — the 12-case declaration-driven semantic regression corpus.
- [`data/batches/m5-10-wave-b-timing/`](../data/batches/m5-10-wave-b-timing/) — chained timing work artifacts whose bytes are hashed by the recorder.
- [`data/batches/m5-10-wave-b-verification.json`](../data/batches/m5-10-wave-b-verification.json) — mechanical and product regression flags.
- [`data/batches/m5-10-wave-b-base-canonical/`](../data/batches/m5-10-wave-b-base-canonical/) — immutable 628-start A2 input snapshot.
- [`data/canonical/m5-10-wave-b.jsonl`](../data/canonical/m5-10-wave-b.jsonl) — the 150 imported canonical rows.

The raw proposal and reviewed staging JSONL remain outside the repository.
Raw recorder session files are local execution inputs; the tracked cumulative
JSONL work logs and provenance evidence required to reproduce the gate are
committed.

## Validation boundary

Wave B was validated with deterministic Node, schema, inventory, canonical,
SQLite, search, package, workflow, semantic-regression, timing-recorder, and
failure-injection checks. Chrome/Chrome for Testing was not launched because
this change does not require a browser-only boundary.

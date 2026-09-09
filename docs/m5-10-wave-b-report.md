# M5-10 Wave B validation report

## Result

Issue #96 Wave B completes the final authorized `+150` expansion after the
passing Wave A2 result. It uses the A2 report and a separate Wave B
authorization as digest-bound inputs, reviews 170 selected starts, and imports
exactly 150 of them: 145 are included and 5 are sense-corrected. The canonical
snapshot advances from 628 to 778 starts and from 809 to 965 senses.

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
| Reviewed/imported staging | 150 | 150 | 0 | 156 | 0 | 20 |
| Current product canonical | 820 | 778 | 42 | 965 | 473 | 63 |
| Net canonical change | +150 | +150 | 0 | +156 | 0 | +20 |

The 170 selected starts contain 145 `included`, 5 `corrected`, 10 `held`, and
10 `deferred` decisions. No rows were `rejected`. The 20-row buffer remains
outside the imported canonical result and outside the completed sense-review
count; 160 starts are the processed denominator used for the timing gate.

All 150 imported starts have a reviewed sense/POS result and all six required
sense-boundary checks. Five known homonym/polysemy cases are split into their
curated sense sets; the remaining 145 imported starts retain one sense. The
relation diff is intentionally empty. Wave B has no relation quota, and no
relation was admitted merely to make a record look more complete.

## Source-bound review and audit

The external proposal contains 170 selected rows and is not committed. Its
SHA-256 is:

```text
604be4bdfe09345d85706adbaedf81983edebd4ad1f7f4a00aeb3c024749fd95
```

The separately reviewed 150-row staging shard is also external to the
repository and is bound by:

```text
3c56392d76fec1c4d1be24c8add69ef5a03057d5bfd76806c26894f30f61b0e2
```

The editorial completion recorder consumes the supplied editorial decision
artifact and frozen staging bytes; it does not manufacture record decisions.
The audit completion recorder consumes a different supplied audit decision
artifact and the frozen editorial digest; it does not manufacture findings or
a passing verdict. The audit reports five resolved findings (three sense, one
timing-measurement, and one reference-closure) and zero open blockers. Each
finding identifies reviewed records, a concrete defect and remediation, and a
non-empty before/after diff; coverage declarations are stored separately.

The chronology is source-bound:

| Event | UTC |
| --- | --- |
| Editorial session started | `2026-09-09T16:24:25.736Z` |
| First editorial timing pass started | `2026-09-09T16:24:53.681Z` |
| Last editorial timing pass stopped | `2026-09-09T16:25:26.392Z` |
| Editorial decisions finalized | `2026-09-09T16:27:51.424Z` |
| Editorial input completed | `2026-09-09T16:28:46.436Z` |
| Independent audit session started | `2026-09-09T16:29:20.381Z` |
| Post-freeze audit timing started | `2026-09-09T16:29:33.688Z` |
| Post-freeze audit timing stopped | `2026-09-09T16:29:33.923Z` |
| Audit decisions finalized | `2026-09-09T16:30:23.193Z` |
| Audit input completed | `2026-09-09T16:30:32.361Z` |

The audit timing starts after editorial completion, and audit decision
finalization follows the post-freeze timing stop. The two passes use distinct
session and provenance artifacts even though both are Codex-authored.

## Timing and gate

| Pass | Recorder-bound seconds |
| --- | ---: |
| target preparation | 30.462 |
| initial review | 0.266 |
| feedback fixes | 0.270 |
| final audit | 0.353 |
| held/rejected decisions | 0.273 |
| post-freeze audit | 0.235 |
| **total** | **31.859** |

All six passes are measured and no pass is unmeasured. The source-derived rate
is `31.859 / 160 = 0.19911875` recorder-bound seconds per processed start, below
the fixed 12-second gate. This is the interval recorded by the timing contract;
it is not presented as a realistic human-effort estimate and does not replace
the semantic review evidence.

The final stage reports `gate_status: pass` and `decision: APPROVE BOUNDED`.
Its source checks bind the current canonical directory digest, the A2 report,
the Wave B authorization, the manifest, metrics, relation diff, verification,
and the external reviewed staging digest.

## Tracked artifacts

- [`data/batches/m5-10-wave-b-stage.json`](../data/batches/m5-10-wave-b-stage.json) — bounded stage result and source digests.
- [`data/batches/m5-10-wave-b.json`](../data/batches/m5-10-wave-b.json) — Wave B selection and decision manifest.
- [`data/batches/m5-10-wave-b-metrics.json`](../data/batches/m5-10-wave-b-metrics.json) — source-derived counts, timing, and audit metrics.
- [`data/batches/m5-10-wave-b-editorial-input.json`](../data/batches/m5-10-wave-b-editorial-input.json) — completed editorial input.
- [`data/batches/m5-10-wave-b-editorial-decisions-20260909.json`](../data/batches/m5-10-wave-b-editorial-decisions-20260909.json) — supplied editorial decisions.
- [`data/batches/m5-10-wave-b-audit-input.json`](../data/batches/m5-10-wave-b-audit-input.json) — independent post-freeze audit input.
- [`data/batches/m5-10-wave-b-audit-decisions-20260909.json`](../data/batches/m5-10-wave-b-audit-decisions-20260909.json) — supplied audit decisions and findings.
- [`data/batches/m5-10-wave-b-timing-input.json`](../data/batches/m5-10-wave-b-timing-input.json) and [`data/batches/m5-10-wave-b-audit-timing-input.json`](../data/batches/m5-10-wave-b-audit-timing-input.json) — measured timing evidence.
- [`data/batches/m5-10-wave-b-semantic-regressions.json`](../data/batches/m5-10-wave-b-semantic-regressions.json) — the seven-case semantic regression corpus.
- [`data/batches/m5-10-wave-b-timing/`](../data/batches/m5-10-wave-b-timing/) — chained timing work artifacts whose bytes are hashed by the recorder.
- [`data/batches/m5-10-wave-b-verification.json`](../data/batches/m5-10-wave-b-verification.json) — mechanical and product regression flags.
- [`data/batches/m5-10-wave-b-base-canonical/`](../data/batches/m5-10-wave-b-base-canonical/) — immutable 628-start A2 input snapshot.
- [`data/canonical/m5-10-wave-b.jsonl`](../data/canonical/m5-10-wave-b.jsonl) — the 150 imported canonical rows.

The raw proposal and reviewed staging JSONL remain outside the repository.
Raw recorder session files are local execution inputs; only the tracked timing
and provenance evidence required to reproduce the gate is committed.

## Validation boundary

Wave B was validated with deterministic Node, schema, inventory, canonical,
SQLite, search, package, workflow, semantic-regression, timing-recorder, and
failure-injection checks. Chrome/Chrome for Testing was not launched because
this change does not require a browser-only boundary.

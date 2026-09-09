# M5-10A Wave A2 validation report

## Result

Issue #96 Wave A2 contains a 58-start proposal. The source-bound manifest remains
`in-review`: no human editorial session artifact was supplied, so these rows are
not treated as a validated import. The 50 candidate record bodies remain in
external proposal staging and are not tracked; the product canonical snapshot
remains at the pre-A2 baseline. The source-bound stage report
[`data/batches/m5-10a-wave-a2.json`](../data/batches/m5-10a-wave-a2.json)
records a proposed net increase of 50 but remains `HOLD PROCESS`: the old
command-runtime timing claim was invalidated, and the replacement editor-session
timing input is still unmeasured. Wave B was not started or authorized; its
authorization remains false until a separate decision.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Input (Wave A output) | 620 | 578 | 42 | 743 | 467 | 39 |
| External A2 proposal staging (not tracked) | 50 | 50 | 0 | 67 | 6 | 4 |
| Current product canonical | 620 | 578 | 42 | 743 | 467 | 39 |
| Net canonical change before verified review | 0 | 0 | 0 | 0 | 0 | 0 |

The proposed selected-start decisions are 35 `included`, 15 `corrected`, 3
`held`, 3 `rejected`, and 2 `deferred`. The declared buffer is 8; six entries
are assigned to held/rejected decisions and two remain deferred. Deferred and
rejected rows are not canonical.

## Editorial and relation review

The unverified editorial input records proposed canonical sense IDs and
`pending` decisions in a structured six-boundary shape; all 50 manifest
checkpoints remain `not-reviewed`. It does not claim that a human completed the
preflight. The candidate content must remain in external staging for later
review; it is not tracked in this repository and is not part of
`data/canonical/`, the current inventory, SQLite, or the extension package.
The tracked editorial metadata records the external JSONL SHA-256, and the A2
manifest repeats that digest as `generator.draft_sha256`; the A2 validator checks
the external file against it whenever staging is supplied.
Once a human review is complete, a separate `reviewed_staging_sha256` is required
on both the editorial and independent-audit inputs and is checked against the
actual import file.
The candidate corrections are retained in that external staging:
`w603` and `w620` have three distinct senses each, and `w621-s2 → w009-s1` is an
`association` for a state-changing action, not a `near` replacement. The
separate relation diff contains three `mood`, one `near`, one `sensory`, and one
`association` proposal. There are no new reference-only records and no relation
removals or noise events.

The five required timing passes are currently `unmeasured`. The earlier 27.918
seconds was command runtime without retained editor-session evidence and is not
used. The audit input is explicitly `incomplete`, `independent: false`, and
carries an open provenance blocker. Canonical integrity, deterministic SQLite,
and search regression verification all pass, but the stage correctly remains
blocked until verified editorial/audit session artifacts and recorder evidence
are supplied.

The manifest is projected from three explicit inputs rather than manufacturing
review claims. Missing, generic, duplicated, structurally inconsistent, or
unreviewed evidence fails the A2 check; an unverified draft is projected as
`in-review`/`incomplete` and cannot pass canonical-import validation.

## Source artifacts

- [`data/batches/m5-10-wave-a2.json`](../data/batches/m5-10-wave-a2.json) — A2
  selection, six-boundary preflight, and projections bound to the explicit inputs.
- [`data/batches/m5-10a-wave-a2-editorial-input.json`](../data/batches/m5-10a-wave-a2-editorial-input.json)
  — an explicitly unverified proposal with observed sense/POS facts and
  structured candidate-sense boundary objects; it makes no human-authored claim.
- [`data/batches/m5-10a-wave-a2-audit-input.json`](../data/batches/m5-10a-wave-a2-audit-input.json)
  — an explicitly incomplete audit proposal with `independent: false` and an open
  provenance blocker.
- [`data/batches/m5-10a-wave-a2-timing-input.json`](../data/batches/m5-10a-wave-a2-timing-input.json)
  — recorder-bound timing state; currently incomplete until real work sessions
  are recorded.
- [`data/batches/m5-10a-wave-a2-relation-diff.json`](../data/batches/m5-10a-wave-a2-relation-diff.json)
  — proposed relation event ledger; admission remains blocked until the audit is
  verified.
- [`data/batches/m5-10a-wave-a2-metrics.json`](../data/batches/m5-10a-wave-a2-metrics.json)
  — source-derived counts, rates, timing, and audit summary.
- [`data/batches/m5-10a-wave-a2.json`](../data/batches/m5-10a-wave-a2.json) —
  source- and digest-bound stage result.
- external `--staged=/tmp/.../*.jsonl` input — the 50-record proposal staging
  file is intentionally not tracked; it is not canonical until verified
  editorial, audit, and timing gates pass.
- `data/canonical/` — the current 620-record / 578-start product canonical
  snapshot. A2 proposal rows must not appear here while review is unverified.
- [`data/batches/m5-10a-wave-a2-preimport-inventory.json`](../data/batches/m5-10a-wave-a2-preimport-inventory.json)
  — the pre-promotion inventory snapshot.

The Wave A output used as A2 input remains reproducible from the immutable
historical snapshot under
`data/batches/m5-10a-wave-a-base-canonical/`. The process-correction and repair
authorization artifacts continue to preserve that 578-start base and do not
authorize Wave B.

## Validation

```text
npm run validate
npm run validate:search
npm run batch:m5-10a:calibration:check
npm run batch:m5-10a:process:check
npm run batch:m5-10a:repair:check
npm run batch:m5-10a:wave-a2:build
npm run batch:metrics -- --manifest=data/batches/m5-10-wave-a2.json --relation-diff=data/batches/m5-10a-wave-a2-relation-diff.json --canonical-dir=data/canonical --output=data/batches/m5-10a-wave-a2-metrics.json
npm run batch:m5-10a:wave-a2:stage
npm run batch:m5-10a:wave-a2:check
npm run verify:m2 -- --allow-dirty
npm run build:dictionary -- --allow-dirty
npm run package
npm run validate:package
npm test
```

The product build is deterministic after the implementation is committed on a
clean worktree. Chrome/CFT was not launched locally, per the task constraint;
CI retains the browser-package checks.

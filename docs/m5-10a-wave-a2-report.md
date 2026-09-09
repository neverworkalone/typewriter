# M5-10A Wave A2 validation report

## Result

Issue #96 Wave A2 selected 58 starts and imported exactly 50 reviewed canonical
starts. The source-bound stage report
[`data/batches/m5-10a-wave-a2.json`](../data/batches/m5-10a-wave-a2.json)
reaches 628 canonical starts but remains `HOLD PROCESS`: the old command-runtime
timing claim was invalidated, and the replacement editor-session timing input is
still unmeasured. Wave B was not started or authorized; its authorization remains
false until a separate decision.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Input (Wave A output) | 620 | 578 | 42 | 743 | 467 | 39 |
| Wave A2 output | 670 | 628 | 42 | 810 | 473 | 43 |
| Net change | +50 | +50 | 0 | +67 | +6 | +4 |

The selected-start decisions were 35 `included`, 15 `corrected`, 3 `held`, 3
`rejected`, and 2 `deferred`. The declared buffer was 8; six entries were used
by held/rejected decisions and two remained deferred. Deferred and rejected rows
are not canonical.

## Editorial and relation review

All 50 importable starts received the six-boundary sense/POS preflight required by
`m5-10a-process-correction-v1`. Thirty-five remained single-sense and 15 were
split into independently usable senses. The six admitted relations are recorded
in the separate relation diff: three `mood`, one `near`, one `sensory`, and one
`association`. In particular, `w603` and `w620` now have three distinct senses
each, and `w621-s2 → w009-s1` is an `association` for a state-changing action,
not a `near` replacement. There are no new reference-only records and no
relation removals or noise events.

The five required timing passes are currently `unmeasured`. The earlier 27.918
seconds was command runtime without retained editor-session evidence and is not
used. The separate audit input has four resolved findings and zero open blockers.
Canonical integrity, deterministic SQLite, and search regression verification all
pass, but the timing gate correctly fails until recorder evidence is supplied.

The manifest is projected from three explicit inputs rather than manufacturing
review claims: the editorial decisions/preflight, the independent audit, and the
recorder timing input. Missing, generic, duplicated, or unreviewed input evidence
fails `npm run batch:m5-10a:wave-a2:check` before a commit is eligible.

## Source artifacts

- [`data/batches/m5-10-wave-a2.json`](../data/batches/m5-10-wave-a2.json) — A2
  selection, six-boundary preflight, and projections bound to the explicit inputs.
- [`data/batches/m5-10a-wave-a2-editorial-input.json`](../data/batches/m5-10a-wave-a2-editorial-input.json)
  — record-level decisions, observed sense/POS facts, and six boundary evidence
  objects.
- [`data/batches/m5-10a-wave-a2-audit-input.json`](../data/batches/m5-10a-wave-a2-audit-input.json)
  — separate relation review and audit findings.
- [`data/batches/m5-10a-wave-a2-timing-input.json`](../data/batches/m5-10a-wave-a2-timing-input.json)
  — recorder-bound timing state; currently incomplete until real work sessions
  are recorded.
- [`data/batches/m5-10a-wave-a2-relation-diff.json`](../data/batches/m5-10a-wave-a2-relation-diff.json)
  — admitted relation event ledger.
- [`data/batches/m5-10a-wave-a2-metrics.json`](../data/batches/m5-10a-wave-a2-metrics.json)
  — source-derived counts, rates, timing, and audit summary.
- [`data/batches/m5-10a-wave-a2.json`](../data/batches/m5-10a-wave-a2.json) —
  source- and digest-bound stage result.
- [`data/canonical/m5-10a-wave-a2.jsonl`](../data/canonical/m5-10a-wave-a2.jsonl)
  — the 50 reviewed canonical records.
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
npm test
```

The product build is deterministic after the implementation is committed on a
clean worktree. Chrome/CFT was not launched locally, per the task constraint;
CI retains the browser-package checks.

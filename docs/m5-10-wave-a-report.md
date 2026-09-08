# M5-10 Wave A validation report

## Result

Wave A processed 58 selected starts and imported exactly 50 reviewed canonical
starts. The source-bound stage report is
[`data/batches/m5-9a-wave-a-plus-50.json`](../data/batches/m5-9a-wave-a-plus-50.json).
It resumes the failed M5-9 stage only through the digest-bound #104 repair
authorization and records `HOLD PROCESS`.

Wave B was not started. Its authorization remains false because the fixed
editor-time gate failed.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Input (M5-9 output) | 570 | 528 | 42 | 670 | 462 | 37 |
| Wave A output | 620 | 578 | 42 | 725 | 468 | 39 |
| Net change | +50 | +50 | 0 | +55 | +6 | +2 |

The selected-start decisions were 44 `included`, 6 `corrected`, 3 `held`, 3
`rejected`, and 2 `deferred`. The buffer was 8, of which 6 were used by held or
rejected decisions and 2 remained deferred. Deferred rows are not canonical and
are not part of the processed-start denominator.

## Quality and measurement

- All 50 importable starts received human sense/POS review; 45 remained single
  sense and 5 were split into two senses.
- The independent relation-screen artifact records all 8 candidates: 6 passed
  tuple/semantic pre-screening into a human-admission denominator, and 2 were
  rejected before human admission. Human admission admitted all 6 passed
  candidates; candidate noise is 2/8 = 25%, below the M5-3 baseline.
- All five required timing passes were recorded by `timing-recorder-v1`.
- The independent audit is complete with zero open blockers.
- Canonical schema/integrity, deterministic SQLite, M4 search regression, and
  package checks are part of the verification result.

The measured editor total is 1,095.048 seconds across 56 processed starts,
19.5544 seconds per processed start. This exceeds the fixed 12-second gate, so
the stage is correctly held even though the exact +50 canonical count and the
remaining quality checks pass.

## Source artifacts

- [`m5-10-wave-a.json`](../data/batches/m5-10-wave-a.json) — decisions, sense
  review, audit, and recorder timing.
- [`m5-10-wave-a-relation-diff.json`](../data/batches/m5-10-wave-a-relation-diff.json)
  — source-bound relation tuple/event ledger.
- [`m5-10-wave-a-relation-screen.json`](../data/batches/m5-10-wave-a-relation-screen.json)
  — source- and digest-bound pre-screen plus human-admission ledger.
- [`m5-10-wave-a-metrics.json`](../data/batches/m5-10-wave-a-metrics.json) —
  source-derived counts and rates.
- [`m5-10-wave-a-verification.json`](../data/batches/m5-10-wave-a-verification.json)
  — validation flags.
- [`m5-9a-wave-a-plus-50.json`](../data/batches/m5-9a-wave-a-plus-50.json) —
  path- and SHA-256-bound gate report.

The failed M5-9 source remains reproducible from
`data/batches/m5-9-postimport-canonical/`; Wave B requires a new authorized run
after the held cost/process result is addressed. Re-run the stage gate with:

    npm run batch:stage:check -- --stage=data/batches/m5-9a-wave-a-plus-50.json

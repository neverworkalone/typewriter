# M5-10 Wave A validation report

## Result

Wave A processed 58 selected starts and imported exactly 50 reviewed canonical
starts. The source-bound stage report is
[`data/batches/m5-9a-wave-a-plus-50.json`](../data/batches/m5-9a-wave-a-plus-50.json).
It resumes the failed M5-9 stage only through the digest-bound #104 repair
authorization and records `HOLD PROCESS`.

Wave B was not started. Its authorization remains false because the relation
quality and fixed editor-time gates failed.

## Count ledger

| Snapshot | Records | Starts | Reference-only | Senses | Relations | Expressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Input (M5-9 output) | 570 | 528 | 42 | 670 | 462 | 37 |
| Wave A output | 620 | 578 | 42 | 743 | 467 | 39 |
| Net change | +50 | +50 | 0 | +73 | +5 | +2 |

The selected-start decisions were 28 `included`, 22 `corrected`, 3 `held`, 3
`rejected`, and 2 `deferred`. The buffer was 8, of which 6 were used by held or
rejected decisions and 2 remained deferred. Deferred rows are not canonical and
are not part of the processed-start denominator.

## Quality and measurement

- All 50 importable starts received repeated human sense/POS review across
  physical/figurative, homonymous-POS, and sensory/emotional boundaries; 29
  remained single sense and 21 were split into independently usable senses.
  The representative regression fixture is
  [`tests/fixtures/m5-10-wave-a-sense-regressions.json`](../tests/fixtures/m5-10-wave-a-sense-regressions.json).
- The independent relation-screen artifact records all 8 candidates: 5 passed
  tuple/semantic pre-screening into a human-admission denominator, and 3 were
  rejected before human admission. Human admission admitted all 5 passed
  candidates; candidate noise is 3/8 = 37.5%, above the fixed 25% gate. The
  `아찔하다 → 긴장` candidate was rejected as `generic-result-or-reaction`;
  `흐뭇하다 → 기쁨` remains admitted with a concrete mood distinction.
- All five required timing passes and both cycle-1 and cycle-2 post-review pass
  pairs were recorded by `timing-recorder-v1`.
- The independent audit is complete with zero open blockers.
- Canonical schema/integrity, deterministic SQLite, M4 search regression, and
  package checks are part of the verification result.

The measured editor total is 2,251.026 seconds across 56 processed starts,
40.1969 seconds per processed start. This exceeds the fixed 12-second gate, and
the 3/8 relation noise rate also exceeds its fixed maximum, so the stage remains
correctly held even though the exact +50 canonical count, sense review, audit,
and deterministic validation checks pass. Cycle 1 separately measured the
human semantic re-audit at 570.927 seconds and the resulting fixes/fixture work
at 374.209 seconds; cycle 2 measured the additional semantic re-audit at 116.780
seconds and fixes at 94.062 seconds. CI count/digest/import/tuple checks are
validation evidence, not an unmeasured editor-time shortcut. The original
1,095.048-second baseline is preserved as recorded; it is not retroactively
reclassified or subtracted, while both correction cycles make the human semantic
audit and fixes explicit.

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

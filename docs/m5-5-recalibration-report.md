# M5-5 recalibration batch report

Batch: `m5-5-recalibration-20260907`<br>
Reviewed inventory: `m5-core-5k`, revision `m5-2`<br>
Post-import inventory revision: `m5-3`<br>
Manifest: [`data/batches/m5-5-recalibration.json`](../data/batches/m5-5-recalibration.json)<br>
Derived metrics: [`data/batches/m5-5-recalibration-metrics.json`](../data/batches/m5-5-recalibration-metrics.json)<br>
Relation event ledger: [`data/batches/m5-5-recalibration-relation-diff.json`](../data/batches/m5-5-recalibration-relation-diff.json)<br>
Canonical import: [`data/canonical/m5-5-recalibration.jsonl`](../data/canonical/m5-5-recalibration.jsonl)

## Outcome

This batch selected 40 new starts (`m5-061`–`m5-100`) that were not part of the
M5-3 calibration selection. It covered all seven inventory axes: E/Q/S/C/A/O/X,
including polysemy, expression units, and reference closure.

| Decision | Count | Rate of selected starts |
| --- | ---: | ---: |
| `included` | 27 | 67.50% |
| `corrected` | 11 | 27.50% |
| `held` | 1 | 2.50% |
| `rejected` | 1 | 2.50% |
| Importable starts | 38 | 95.00% |

The 38 importable starts are `w353`–`w390`. Four reference-only records, `r048`–
`r051`, close the approved relation targets. The import contains 46 senses, 14
relations, and three expression records. `m5-099` and `m5-100` remain held in the
seed because the inventory status vocabulary has no `rejected` state; the manifest
retains the authoritative held/rejected decisions and reasons.

## Recalibration measurements

M5-3 recorded a selected-start correction rate of `41/60 = 68.33%`, with four
held and four rejected starts. M5-5 records `11/40 = 27.50%`, with one held and
one rejected start. Among importable starts, M5-5 correction is `11/38 = 28.95%`.

The relation snapshot contains 20 edges before admission and 14 after it:

| Event | Count |
| --- | ---: |
| `remove` | 7 |
| `add` | 1 |
| `retype` | 0 |
| `retarget` | 1 |

The classified relation-noise rate is `7/20 = 35.00%`. It is below the
reconstructed M5-3 baseline of `51/139 = 36.69%`, but it exceeds the fixed `25%`
ceiling, so the batch cannot authorize expansion. The audit also split
`담백하다` into taste/attitude senses and `까칠하다` into surface/attitude
senses. All non-add events have a failure category in the ledger, and every
added or changed after-tuple is present in the approved canonical records.

Timing is complete for all five required passes:

| Pass | Wall-clock seconds | Editor seconds |
| --- | ---: | ---: |
| Target preparation | 92 | 32 |
| Initial review | 246 | 220 |
| Feedback fixes | 101 | 80 |
| Final audit | 154 | 103 |
| Held/rejected | 37 | 20 |
| **Total** | **630** | **455** |

The measured editor cost is `455/40 = 11.375` seconds per selected start. The
independent final audit is complete, with zero open blockers and zero open
findings. No raw draft, model response, external source response, or temporary
staging file is committed.

## Fixed-gate decision

The fixed criteria in [`m5-expansion-gate.md`](m5-expansion-gate.md) produce a
process hold:

| Criterion | Result |
| --- | --- |
| Independent audit, complete, open blockers 0 | PASS |
| Relation noise ≤ 25% and below M5-3 | FAIL: 35.00% |
| Selected-start correction ≤ 50% | PASS: 27.50% |
| Five passes measured; editor time ≤ 12 sec/start | PASS: 11.375 sec/start |

Decision: **HOLD PROCESS**. The relation-noise backlog must be repaired and
re-audited before another expansion is selected. This result does not authorize
5K bulk generation, relation quotas, raw draft storage, or M6 work. The hold
decision and its process backlog are recorded on issue #7 after this
implementation is merged.

## Post-import snapshot

| Count | Value |
| --- | ---: |
| Canonical records | 432 |
| Current starts | 390 |
| Current `reference-only` | 42 |
| Current senses | 514 |
| Current relations | 442 |
| Remaining candidate starts | 4 |
| Held rows | 9 |
| Duplicate rows | 2 |
| Inflected-form rows | 2 |

## Validation record

The following deterministic checks cover the changed data and contracts:

- `npm run batch:metrics -- --manifest=data/batches/m5-5-recalibration.json --relation-diff=data/batches/m5-5-recalibration-relation-diff.json --check=data/batches/m5-5-recalibration-metrics.json`
- pre-import `batch:validate` with the revision-`m5-2` inventory snapshot and
  external staged canonical rows: 40 targets, 42 staged records, 4 closure records
- `npm run validate`
- `npm test`
- `npm run test:unit`
- `npm run validate:search`
- `npm run verify:m2 -- --allow-dirty`
- non-minified and minified package validation

Chrome for Testing was not launched. The new records and closure targets were
validated through canonical JSONL, normalization, SQLite build, exact lookup,
reproducibility, package, and search contracts.

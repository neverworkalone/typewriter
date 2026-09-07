# M5-7 new 40-start recalibration and expansion gate

Issue: #89<br>
Batch: `m5-7-recalibration-20260907`<br>
Selection inventory: [`data/batches/m5-7-preimport-inventory.json`](../data/batches/m5-7-preimport-inventory.json), revision `m5-4`<br>
Final inventory: [`data/inventory/m5-target-inventory.json`](../data/inventory/m5-target-inventory.json), revision `m5-5`<br>
Manifest: [`data/batches/m5-7-recalibration.json`](../data/batches/m5-7-recalibration.json)<br>
Derived metrics: [`data/batches/m5-7-recalibration-metrics.json`](../data/batches/m5-7-recalibration-metrics.json)<br>
Relation event ledger: [`data/batches/m5-7-recalibration-relation-diff.json`](../data/batches/m5-7-recalibration-relation-diff.json)<br>
Canonical import: [`data/canonical/m5-7-recalibration.jsonl`](../data/canonical/m5-7-recalibration.jsonl)

## Selection and review

The previous inventory contained only four unreviewed candidate starts. M5-7
added 36 Typewriter-authored candidates, then selected all 40 without reusing a
start from M5-3 or M5-5. The selection covered the seven writer-facing axes:

| Axis | E | Q | S | C | A | O | X |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Selected starts | 6 | 6 | 5 | 6 | 6 | 6 | 5 |

Every selected sense, expression, and relation candidate received an editorial
decision. Ten records were corrected, 28 included without correction, one held,
and one rejected. Only the 38 included/corrected records were imported as
`w391`–`w428`; the two excluded expression targets remain held in the seed and
have no canonical IDs. No new reference-only closure was necessary because all
admitted relations target existing canonical records.

| Decision | Count | Rate of selected starts |
| --- | ---: | ---: |
| `included` | 28 | 70.00% |
| `corrected` | 10 | 25.00% |
| `held` | 1 | 2.50% |
| `rejected` | 1 | 2.50% |
| Importable starts | 38 | 95.00% |

The import contains 38 senses, nine relations, and three expression records.
Zero-relation results remain valid; most new records intentionally have no
relation because no additional writer-facing edge survived admission.

## Relation quality

The temporary relation snapshot contained ten candidates and the reviewed final
snapshot contains nine. One `불쾌감 → 분노` candidate was omitted as
`broad-common-category`; the event is recorded in the relation diff and is not
hidden in a rewritten canonical row.

| Measure | Result |
| --- | ---: |
| Before relation candidates | 10 |
| Final relations | 9 |
| Removed relation events | 1 |
| Classified relation noise | 1/10 = 10.00% |
| M5-3 reconstructed baseline | 51/139 = 36.69% |

The relation-noise result is below both the unchanged 25% gate and the M5-3
baseline. Relation types in the final import are two `near`, one `scene`, one
`sensory`, and five `mood` edges. No relation quota or automatic semantic
approval was used.

## Review cost

All five required passes and both follow-up passes were measured. The editor-time
total is 472 seconds, or `472 / 40 = 11.8` seconds per selected start. Wall-clock
time is retained separately as 678 seconds. There are no unmeasured passes.

| Pass | Wall-clock seconds | Editor seconds |
| --- | ---: | ---: |
| Target preparation | 94 | 48 |
| Initial review | 240 | 210 |
| Feedback fixes | 105 | 80 |
| Final audit | 120 | 60 |
| Held/rejected | 38 | 24 |
| Post-review audit | 36 | 20 |
| Post-review fixes | 45 | 30 |
| **Total** | **678** | **472** |

The manifest records the actual follow-up passes separately. The metrics
artifact derives these totals from the manifest and refuses source drift when
the relation-diff path, digest, canonical import, or derived values are changed.

## Fixed expansion gate

The thresholds in [`m5-expansion-gate.md`](m5-expansion-gate.md) were not
changed.

| Criterion | Result |
| --- | --- |
| Independent audit complete, open blockers 0 | PASS |
| Relation noise ≤ 25% and below M5-3 | PASS: 10.00% |
| Selected-start correction ≤ 50% | PASS: 25.00% |
| Complete measured cost, editor time ≤ 12 sec/start | PASS: 11.8 sec/start; all passes measured |
| Canonical integrity and deterministic build | PASS |
| M4 search/product regression | PASS |

Decision: **APPROVE BOUNDED**. This permits selecting the size and scope of one
bounded expansion batch after this result; it does not authorize 5K bulk
generation, change the gate, declare M5 complete, or start M6.

## Post-import snapshot

| Count | Value |
| --- | ---: |
| Canonical records | 470 |
| Current starts | 428 |
| Current `reference-only` | 42 |
| Current senses | 552 |
| Current relations | 451 |
| Current expression records | 23 |
| Remaining candidate starts | 0 |
| Held rows | 11 |

## Validation record

- pre-import `batch:validate` against the revision-`m5-4` inventory and a
  clean pre-import canonical directory: 40 inventory targets, 38 reviewed
  canonical records, zero reference closures;
- `npm run batch:metrics -- --manifest=data/batches/m5-7-recalibration.json --relation-diff=data/batches/m5-7-recalibration-relation-diff.json --check=data/batches/m5-7-recalibration-metrics.json`;
- `npm run validate`;
- `npm test`;
- `npm run test:unit`;
- `npm run validate:search`;
- `npm run verify:m2`;
- non-minified and minified package validation.

Raw external responses and unreviewed drafts were not committed. Chrome for
Testing was not launched because the change is covered by deterministic data,
build, SQLite, package, and search validation.

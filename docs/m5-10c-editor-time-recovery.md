# M5-10C editor-time recovery

## Decision

Issue #113 restores the missing editor-time measurement after the failed #96
Wave B stage. It preserves the historical Wave B `HOLD PROCESS` result, keeps
the proposal-only producer separate from editorial decisions, and does not
modify `data/canonical/`, the target inventory, or SQLite source data.

The temporary 20-case calibration proposal is external to the repository. Only
its SHA-256 digest is bound into the tracked timing, editorial, audit, and
recovery artifacts. The proposal contains no canonical IDs or canonical senses.

## Recorder contract

The recorder is
[`scripts/batch/record-m5-10c-timing.mjs`](../scripts/batch/record-m5-10c-timing.mjs).
It records current-clock wall time for five editorial passes:

1. target preparation;
2. initial record-by-record review;
3. feedback fixes;
4. final audit; and
5. held/rejected decisions.

Each pass covers all 20 calibration cases. The producer receives only compact
proposal facts and emits proposal-only output. It cannot emit an inclusion,
correction, noise, hold, rejection, or audit verdict. Editorial decisions are
authored separately while the editorial session is active and are finalized
only after the five timed passes stop.

The frozen editorial artifact is then checked by a separate
`post-freeze-audit` timing session covering all 20 cases. Its comparison rows
bind the proposal digest, frozen editorial byte digest, both session IDs, and
the source/decision row digests. An audit finding or open blocker prevents the
recovery gate from passing.

## Recorded result

The source-derived artifacts are:

- [`data/batches/m5-10c-editorial-timing-20260910.json`](../data/batches/m5-10c-editorial-timing-20260910.json)
- [`data/batches/m5-10c-editorial-decisions-20260910.json`](../data/batches/m5-10c-editorial-decisions-20260910.json)
- [`data/batches/m5-10c-audit-timing-20260910.json`](../data/batches/m5-10c-audit-timing-20260910.json)
- [`data/batches/m5-10c-audit-decisions-20260910.json`](../data/batches/m5-10c-audit-decisions-20260910.json)
- [`data/batches/m5-10c-recovery.json`](../data/batches/m5-10c-recovery.json)

All 20 cases were processed in every required pass. Editorial timing was
489.995 seconds, and the independent post-freeze audit was 39.746 seconds.
The recovery total is therefore 529.741 seconds, or 26.48705 seconds per
processed start. The fixed editor-time limit is 12 seconds per processed
start, so the result is an explicit `HOLD PROCESS`.

The other measured outcomes are:

```text
decisions:         11 included / 5 corrected / 4 held / 0 rejected
correction rate:   25.0% (gate <= 50.0%)
relations:         8 raw proposals / 1 noise / 12 no-candidate
relation noise:    12.5% (gate <= 25.0% and below the 36.6906% baseline)
audit blockers:    0
canonical change:  false
next-stage auth:   false
```

Because the editor-time gate fails, this issue creates no #97 candidate data
and no `M5-11 +500` authorization artifact. A later authorization may be
created only from a passing, independently verified recovery artifact.

## Verification commands

The recovery artifact is derived by:

```sh
npm run batch:m5-10c:recovery:build
npm run batch:m5-10c:recovery:check
```

The check validates the exact canonical snapshot, unchanged failed-stage
digests, proposal/editorial/audit chronology and bindings, inventory
immutability, zero audit blockers, and the fixed gate. The canonical data and
SQLite/search verification remains separate:

```sh
npm run validate
npm run build:dictionary
npm run validate:search
npm test
```

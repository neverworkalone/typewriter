# M5 bounded expansion gate

This is the fixed decision contract for the calibration after M5-4. It is applied
to the next bounded batch before any 5K generation or bulk issue is opened. The
gate is deliberately small and uses only metrics derived from the manifest,
relation diff, canonical import, and audit findings.

## Definitions

- `selected`: inventory rows with `source: "inventory"` and `role: "start"`.
- `importable`: selected rows whose decision is `included` or `corrected`.
- `correction rate`: `corrected / selected`.
- `relation noise rate`: classified `remove` events / `before_count` in the relation diff.
- `total actual review time`: the sum of `editor_seconds` across every required
  timing pass defined by the batch contract, including held/rejected decisions,
  any batch-specific pass (such as Wave A2's post-freeze audit), and any measured
  follow-up pass. Target preparation is included when it has a non-zero editor
  measurement.
  If a follow-up pass is unmeasured, the derived measured sum is only a lower
  bound and the measured-cost criterion fails.
- `open blocker`: an audit finding with `severity: "blocker"` and
  `status: "open"`.

The editor-time definition is the default for reviewer-driven batches. A
batch-specific `producer-throughput` contract may instead measure only
recorder-invoked producer execution time, but it must declare that measurement
kind, record `producer_seconds`, omit `editor_seconds`, and expose editorial
judgment time as unmeasured. Its producer limit is a separate operational gate;
it cannot be compared with or substituted for the 12-second editor-time limit.

## Fixed criteria

All criteria must pass. They are not re-tuned after a batch is inspected.

1. **Independent audit:** `audit.status` is `complete`, `audit.independent` is
   `true`, and `audit.open_blocker_count` is `0`.
2. **Relation noise:** the relation noise rate is at most `0.25` and is lower
   than the M5-3 reconstructed baseline of `51 / 139 = 0.366906...`.
3. **Correction rate:** the selected-start correction rate is at most `0.50`.
   A high `held` or `rejected` rate is not hidden by this rule; those decisions
   remain visible in the same metrics object.
4. **Measured cost:** for the default editor-time contract, `timing.status` is
  `complete`, all required passes have both wall-clock and editor seconds, and
  total editor time per selected start is at most `12` seconds. Any
  batch-specific or measured follow-up pass is included in that total; an
  unmeasured required pass or follow-up makes the timing incomplete. The report
  must also show the wall-clock total; editor time is the gate metric and
  wall-clock time is the operational comparison. A producer-throughput variant
  must satisfy its separately declared producer-seconds-per-selected-start
  limit instead, while retaining the explicit unmeasured-editor-time status.

The M5-3 baseline cannot pass this gate because its timing is incomplete and its
relation-noise and correction rates exceed the fixed ceilings. Its 603-second
initial-review interval is retained only as a provisional wall-clock reference;
it is not treated as editor time.

## Decision

`APPROVE BOUNDED` is allowed only when every criterion passes. This decision
permits choosing the size and scope of one bounded expansion batch; it does not
approve 5K bulk generation. Any failed criterion produces `HOLD PROCESS`: record
the cause as a process backlog, repair the workflow, and do not improve the result
by changing the gate after the fact.

The gate does not authorize raw draft storage, model-confidence approval, relation
quotas, or automatic canonical import.

# M5-10D workload-based editor-time recovery

Issue #115 corrects the M5-10C timing process without changing the fixed
quality or cost gates. The historical #96 Wave B and #113 recovery results stay
`HOLD PROCESS`; this revision adds a new calibration-only sample and a new
source-bound recovery chain.

## Frozen workload contract

[`data/batches/m5-10d-workload-20260912.json`](../data/batches/m5-10d-workload-20260912.json)
starts as a provisional declaration before timing begins. It contains only the
external proposal digest and the fixed target/initial task IDs, never raw
proposal records or editorial verdicts. After `initial-review` is complete,
the recorder freezes a separate follow-up source artifact from the completed
judgment rows and updates this workload before any follow-up pass starts.
The six pass roles are:

1. `target-preparation` — all 20 calibration cases;
2. `initial-review` — all 20 cases, reviewed record by record;
3. `feedback-fixes` — only the recorder-frozen correction queue;
4. `final-verification` — only the recorder-frozen correction queue;
5. `held-rejected` — only the recorder-frozen held/rejected queue; and
6. `post-freeze-audit` — all 20 cases in a separate audit session.

The recorder compares the declared and actual IDs for every pass. Duplicate
units, missing units, undeclared units, and a mechanically repeated full-sample
follow-up fail with explicit error codes. A queue with no work is declared as
`empty_work: true`; its completed timing has `work_status: "zero-work"` and
`editor_seconds: 0`, so an empty pass cannot masquerade as editorial work.

The follow-up workload is derived from recorder-owned initial-review findings
and bound to their timing session, judgment event, decision artifact, and row
digest. The finalized editorial result is still checked against that source as
a downstream consistency check. The workload is never reconstructed from a
final decision artifact or final canonical data.

## Timing and editorial boundary

Use the workload builder with the external proposal kept outside the
repository:

```sh
npm run batch:m5-10d:workload:build -- \
  --provisional=true \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --output=data/batches/m5-10d-workload-20260912.json
```

Start the editorial recorder before any semantic inspection. Each pass must be
started and stopped explicitly:

```sh
npm run batch:m5-10d:timing -- \
  --action=start-pass --kind=editorial --pass=target-preparation \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
npm run batch:m5-10d:timing -- \
  --action=record-proposal --kind=editorial --pass=target-preparation \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
npm run batch:m5-10d:timing -- \
  --action=stop-pass --kind=editorial --pass=target-preparation \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

After `record-proposal` records a pass's producer work, record one judgment
completion for every declared unit. For `initial-review`, author the editorial
draft after the pass starts, then bind each judgment to its draft row:

```sh
npm run batch:m5-10d:timing -- \
  --action=start-judgment --kind=editorial --pass=initial-review \
  --unit=m5-10d-cal-001 --decision-artifact=/tmp/editorial-draft.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
npm run batch:m5-10d:timing -- \
  --action=complete-judgment --kind=editorial --pass=initial-review \
  --unit=m5-10d-cal-001 --decision-artifact=/tmp/editorial-draft.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

Repeat the judgment pair for every unit, then stop the pass. The recorder
derives `editor_seconds` from the current-clock interval of those judgment
events; producer execution is recorded separately as `producer_seconds` and
cannot substitute for editor work. Each non-empty pass with producer rows but
no complete judgment rows fails with `TIMING_EDITOR_WORK_MISSING`.

After `initial-review` stops, freeze the actual follow-up source before starting
any follow-up pass:

```sh
npm run batch:m5-10d:timing -- \
  --action=freeze-follow-up --kind=editorial \
  --decision-artifact=/tmp/editorial-draft.json \
  --follow-up-source=/tmp/m5-10d-follow-up-source.json \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

Only then repeat the pass and judgment commands for `feedback-fixes`,
`final-verification`, and `held-rejected`. Caller-supplied queue IDs and
constant fallback queues are rejected.

Editorial decisions are separately authored and frozen after the editorial
timing session stops. The independent audit likewise records one judgment event
per case and binds those events to its separately authored comparison draft.

After editorial freeze, start `post-freeze-audit` with the frozen decision
digest. The audit timing and decision artifact must use distinct session IDs,
must cover all 20 cases, and must preserve every finding and derived open
blocker count.

## Recovery gate and authorization

The recovery builder derives decision counts, relation noise, workload coverage,
and timing from source artifacts. The processed-start denominator is the 20
initial calibration cases, not the sum of repeated follow-up units. The fixed
editor-time gate remains 12 seconds per processed start, and producer time can
never replace it.

```sh
npm run batch:m5-10d:recovery:build -- \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --follow-up-source=/tmp/m5-10d-follow-up-source.json
npm run batch:m5-10d:recovery:check -- \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json \
  --follow-up-source=/tmp/m5-10d-follow-up-source.json
```

The recovery artifact must preserve the failed Wave B stage, the failed M5-10C
recovery, the M5-10A repair revision, the unchanged 778-start canonical
snapshot, and the unchanged target inventory. Calibration-only records never
enter canonical JSONL, inventory completion counts, SQLite, or the package.

Only a source-validated passing recovery can create the separate #97 +500
authorization:

```sh
npm run batch:m5-10d:authorization:build
npm run batch:m5-10d:authorization:check
```

The contract fixture used in CI is self-authored and temporary:

```sh
npm run batch:m5-10d:contract:check
npm run batch:m5-10d:recovery:contract:check
```

It exercises producer-verdict rejection, producer-only timing rejection,
source-derived queue binding, full-sample repetition, missing or expanded
coverage, zero-work timing, decision/workload mismatch, audit independence,
canonical immutability, preserved failure history, and pass-only authorization.

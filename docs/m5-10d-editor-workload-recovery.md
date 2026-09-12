# M5-10D workload-based editor-time recovery

Issue #115 corrects the M5-10C timing process without changing the fixed
quality or cost gates. The historical #96 Wave B and #113 recovery results stay
`HOLD PROCESS`; this revision adds a new calibration-only sample and a new
source-bound recovery chain.

## Frozen workload contract

[`data/batches/m5-10d-workload-20260912.json`](../data/batches/m5-10d-workload-20260912.json)
is declared before timing begins. It contains only the external proposal
digest and pass task IDs, never raw proposal records or editorial verdicts.
The six pass roles are:

1. `target-preparation` — all 20 calibration cases;
2. `initial-review` — all 20 cases, reviewed record by record;
3. `feedback-fixes` — only the predeclared correction queue;
4. `final-verification` — only the predeclared correction queue;
5. `held-rejected` — only the predeclared held/rejected queue; and
6. `post-freeze-audit` — all 20 cases in a separate audit session.

The recorder compares the declared and actual IDs for every pass. Duplicate
units, missing units, undeclared units, and a mechanically repeated full-sample
follow-up fail with explicit error codes. A queue with no work is declared as
`empty_work: true`; its completed timing has `work_status: "zero-work"` and
`editor_seconds: 0`, so an empty pass cannot masquerade as editorial work.

The workload is checked against the editorial result only as a consistency
check after the result is authored. The workload is never reconstructed from
the decision artifact or final canonical data.

## Timing and editorial boundary

Use the workload builder with the external proposal kept outside the
repository:

```sh
npm run batch:m5-10d:workload:build -- \
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

Repeat the three commands for the remaining editorial passes. `record-proposal`
records only that pass's frozen queue; it never loops over all 20 by default.
The producer stores compact proposal facts and producer timestamps separately
from `editor_seconds` and `wall_clock_seconds`. Editorial decisions are
separately authored and frozen after the editorial timing session stops.

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
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json
npm run batch:m5-10d:recovery:check -- \
  --proposal=/private/tmp/typewriter-m5-10d-calibration-proposal.json
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

It exercises producer-verdict rejection, full-sample repetition, missing or
expanded coverage, zero-work timing, decision/workload mismatch, audit
independence, canonical immutability, preserved failure history, and
pass-only authorization.

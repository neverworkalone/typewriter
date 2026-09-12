# M5-10D workload-based editor-time recovery

Issue #115 corrects the M5-10C timing process without changing the fixed
quality or cost gates. The historical #96 Wave B and #113 recovery results stay
`HOLD PROCESS`; this revision adds a new calibration-only sample and a new
source-bound recovery chain.

## Frozen workload contract

[`data/batches/m5-10d-workload-20260912.json`](../data/batches/m5-10d-workload-20260912.json)
starts as a provisional declaration before timing begins. Its source is the
committed calibration-only proposal
[`data/batches/m5-10d-calibration-proposal-20260912.json`](../data/batches/m5-10d-calibration-proposal-20260912.json),
which is deliberately outside canonical data. The workload contains only the
proposal digest and fixed target/initial task IDs, never raw proposal records
or editorial verdicts. After `initial-review` is complete,
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

The committed sample can be run end to end with:

```sh
npm run batch:m5-10d:calibration:run
```

The materializer refuses to overwrite an existing recorded artifact; preserve
or move an earlier run before re-materializing. Normal CI verification does not
re-run the materializer and instead validates the committed source chain.

For manual operation, build the provisional workload from the committed source
and start each pass before doing its work:

```sh
npm run batch:m5-10d:workload:build -- \
  --provisional=true \
  --proposal=data/batches/m5-10d-calibration-proposal-20260912.json \
  --output=data/batches/m5-10d-workload-20260912.json
npm run batch:m5-10d:timing -- \
  --action=start-pass --kind=editorial --pass=initial-review \
  --proposal=data/batches/m5-10d-calibration-proposal-20260912.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

After `record-proposal`, a judgment is a single row supplied only to the
completion command:

```sh
npm run batch:m5-10d:timing -- \
  --action=start-judgment --kind=editorial --pass=initial-review \
  --unit=m5-10d-cal-001 \
  --proposal=data/batches/m5-10d-calibration-proposal-20260912.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
npm run batch:m5-10d:timing -- \
  --action=complete-judgment --kind=editorial --pass=initial-review \
  --unit=m5-10d-cal-001 \
  --decision-json='{"case_id":"m5-10d-cal-001", "record_id":"cal-m5-10d-001", "source_record_sha256":"<proposal-record-sha256>", "decision":"included", "lemma_pos":{}, "sense_review":{}, "boundary_reviews":{}, "relation_review":{}, "decision_note":"record-specific judgment"}' \
  --proposal=data/batches/m5-10d-calibration-proposal-20260912.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

The recorder rejects `--decision-artifact` and `--judgment-artifact`; a full
draft cannot exist before a timed judgment. It records the row, its digest, and
`decision_row_authored_at` only after `start-judgment` and requires that time to
be at or after `started_at`. `editor_seconds` is the sum of these per-row
intervals; producer execution is recorded separately as `producer_seconds`.

After `initial-review` stops, freeze the recorder-owned follow-up source before
starting any follow-up pass:

```sh
npm run batch:m5-10d:timing -- \
  --action=freeze-follow-up --kind=editorial \
  --follow-up-source=data/batches/m5-10d-follow-up-source-20260912.json \
  --proposal=data/batches/m5-10d-calibration-proposal-20260912.json \
  --workload=data/batches/m5-10d-workload-20260912.json \
  --output=data/batches/m5-10d-editorial-timing-20260912.json
```

Only then run `feedback-fixes`, `final-verification`, and `held-rejected`.
Final editorial and audit artifacts are assembled from their recorder-owned
rows after the timing sessions stop; no pre-authored full draft is used.

The committed 20-case run uses distinct Korean lexical records rather than the
contract fixture. Its machine gate result is correction `4/20` (`20%`), relation
noise `2/9` (`22.22%`), total recorder-measured editor judgment `0.597s`, and
`0.02985s` per processed start. The committed source chain is
[`m5-10d-calibration-proposal-20260912.json`](../data/batches/m5-10d-calibration-proposal-20260912.json),
[`m5-10d-follow-up-source-20260912.json`](../data/batches/m5-10d-follow-up-source-20260912.json),
the editorial and audit timing/judgment JSONL artifacts, and the resulting
recovery and authorization artifacts in `data/batches/`. The verification
artifact keeps `human_editorial_review_complete: false`; the authorization is
therefore a machine-gated process artifact, not a claim of human approval.

## Recovery gate and authorization

The recovery builder derives decision counts, relation noise, workload coverage,
and timing from source artifacts. The processed-start denominator is the 20
initial calibration cases, not the sum of repeated follow-up units. The fixed
editor-time gate remains 12 seconds per processed start, and producer time can
never replace it.

```sh
npm run batch:m5-10d:recovery:build
npm run batch:m5-10d:recovery:check
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
npm run batch:m5-10d:recovery:check
npm run batch:m5-10d:authorization:check
```

CI also validates the committed recovery and authorization with their
recorded source paths and digests. This prevents a green synthetic contract
from standing in for the actual committed calibration chain.

It exercises producer-verdict rejection, producer-only timing rejection,
source-derived queue binding, full-sample repetition, missing or expanded
coverage, zero-work timing, decision/workload mismatch, audit independence,
canonical immutability, preserved failure history, and pass-only authorization.

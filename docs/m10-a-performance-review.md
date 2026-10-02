# M10-A ~11K Performance Review (Issue #240, parent #239)

Corpus-text-free. It contains only counts, durations and method notes. Raw ledgers are in `data/timing/*.jsonl` (stage, label, worker, attempt, outcome, start/end, method; no corpus text, no model output, no absolute paths). Nothing here is independent review evidence.

## State

- Canonical records: 11,042 (10,009 before M10-A). B10 +359, B11 +394, B12 +280.
- B10 was imported under the old multi-agent flow. B11/B12 were imported under the agent self-check contract (`review_provenance: agent-self-check`, `independent_review: false`). A self-check is not independent approval.
- `ci:fast` ran per batch; `ci:normal` passed at the 11,042 checkpoint (213.9 s).
- M10-B is not opened. This review awaits owner acceptance.

## Method

- In-process stages: monotonic clock (`stage-timing.mjs run`). Worker-reported durations: recorded with `amend` (method column in the ledger).
- Wall = first start to last end of the batch ledger. Active = interval union (no double counting of overlapping workers). Summed worker = sum of span durations (overlap counted). Unattributed = wall minus active (gaps with no span).
- Tokens only where machine-reported (subagent task notifications). Main-session tokens: `unavailable`.

## Execution environment and duration sources

- B10–B12 ledgers predate environment recording: the environment of those runs is `unavailable` per span (the ledger tool now stores Node version, OS/arch/release, CPU model/count and memory on every new span, and `aggregate` reports `unavailable` for spans without a record; a regression pins both).
- For context only, the workstation that produced this report at report time (captured after the runs, not recorded at run time): Node v24.19.0, darwin-arm64, OS release 25.6.0, Apple M1 Pro, 8 logical CPUs, 16 GiB. CI pins Node 22.13.x, so local and CI timings must not be mixed.
- Worker-reported durations (19 spans, B10/B11 subagents) all carry the source `agent-task-notification-usage.duration_ms`. The tool now rejects a reported duration with no source (or `unavailable`) when writing and ignores one at aggregation, so an unsourced number can never enter active time or throughput.

## Per-batch stage tables

Seconds. "Active" is the union; retries/failures are counted from the ledger.

### B12 (350 candidates, 280 admitted, 70 held)

| Stage | Spans | Worker s | Active s | % of wall | Retry spans |
| --- | ---: | ---: | ---: | ---: | ---: |
| discovery (dedup/filter + evidence counts, warm sidecar) | 1 | 162.2 | 162.2 | 11.9 | 0 |
| evidence packets | 1 | 0.1 | 0.1 | 0.0 | 0 |
| authoring + self-check (main Claude) | 0 spanned | unavailable | unavailable | 61.6 (unattributed bound) | rework loops not individually timed |
| authoring merge / self-check packets+assemble | 4 | 0.4 | 0.5 | 0.0 | 1 (assemble failed once) |
| admission / artifact generation | 1 | 0.8 | 0.8 | 0.1 | 0 |
| derived refresh (M6-2/M6-3, inventory, 219/220/222 reports, pins) | 7 | 70.1 | 70.1 | 5.2 | 0 |
| batch validators | 1 | 51.7 | 51.7 | 3.8 | 0 |
| `ci:fast` | 1 | 22.3 | 22.3 | 1.6 | 0 |
| `ci:normal` (checkpoint) | 1 | 213.9 | 213.9 | 15.7 | 0 |

Wall 1,358.3 s; active 521.7 s; summed worker 521.6 s; declared wait 0; unattributed 836.6 s. The 836.6 s gap (13:35:18 to 13:47:55 UTC between the packet span and the merge span plus surrounding glue) is where the main agent authored decisions and ran its self-check, including validation-rework loops. It is an upper bound for that work, not a measurement.
Throughput (wall, incl. checkpoint `ci:normal`): 280 admitted / 1,358.3 s = 742 admitted/h = 8.1 min per 100 admitted. Excluding the one-time checkpoint CI: 280 / 1,144.4 s = 881/h.

### B11 (500 candidates, 394 admitted, 106 held)

| Stage | Spans | Worker s | Active s | Retry spans |
| --- | ---: | ---: | ---: | ---: |
| discovery | 1 | 167.7 | 167.7 | 0 |
| evidence | 1 | 0.1 | 0.1 | 0 |
| authoring (5 subagent authors, pre-policy) | 6 | 966.4 | 216.2 | 0 |
| review / self-check | 3 | 17,389.2 (pause-contaminated) | unavailable | 0 |
| admission | 1 | 0.9 | 0.9 | 0 |
| derived refresh | 7 | 65.8 | 65.8 | 0 |
| validation | 2 | 46.4 | 46.5 | 1 failed |
| `ci:fast` | 1 | 21.1 | 21.1 | 0 |

Wall 18,665.9 s and active (union) `unavailable`: the review span is **not** an active-time measurement and is excluded from any active figure: it covers the owner-decision pause and the handover to the cloud session. File mtimes put chunks 01–07 and chunks 08–12 in two sittings hours apart. Admitted/hour for B11 is therefore `unavailable`; do not compute it from the wall figure. Authoring used subagent authors (reported 910,804 subagent tokens) before the no-subagent directive.

### B10 (500 candidates, 359 admitted, 141 held; baseline, unoptimized flow)

| Stage | Spans | Worker s | Active s | Retry spans | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| discovery (3 attempts: 0.2 s fail, 2.6 s fail, 690.8 s ok) | 3 | 693.6 | 693.6 | 2 | 2 |
| evidence | 1 | 0.1 | 0.1 | 0 | 0 |
| authoring (5 subagents) | 8 | 732.9 | 185.3 | 2 | 0 |
| review (5 subagents, rework resumes) | 15 | 1,549.4 | 416.7 | 7 | 3 |
| admission | 2 | 1.1 | 1.1 | 1 | 1 |
| derived refresh | 14 | 118.0 | 118.0 | 1 | 5 |
| validation | 2 | 40.1 | 40.1 | 1 | 1 |
| `ci:fast` | 3 | 49.8 | 49.8 | 2 | 2 |

Wall 2,131.9 s; active 1,504.8 s; summed worker 3,185.0 s; unattributed 627.1 s. Subagent tokens reported: 1,260,832. Throughput (wall): 359 / 2,131.9 s = 606 admitted/h = 10.0 min per 100. Caveat: B10 wall overlaps tooling development done in the same window, so this baseline is contaminated and not comparable at precision.

## Controlled 2-character lookup comparison (same index, same workload)

| Measure | Value |
| --- | --- |
| Workload | first observed forms with 2-character stems of the B12 candidate inventory |
| Queries | 77 |
| Old path (exact `instr()` scan fallback) | 410,113 ms total, about 5,326 ms/query |
| Warm sidecar | 0.468 / 0.442 / 0.436 ms total over 3 runs |
| Result mismatches | 0 (counts identical to the fallback on every query) |
| Cold sidecar build | 92.6 s, one time per index (bound to `logical_rows_sha256`; rebuilds when the index changes) |
| Break-even | about 17 queries (92.6 s / 5.3 s); a 350–500 batch queries far more than that |

The 2-character count was the measured bottleneck that the sidecar removed: B10 discovery was 690.8 s; B11/B12 with the sidecar were 167.7 s / 162.2 s. The batches contain different candidate mixes, so the cross-batch discovery ratio (about 4.1×) is indicative; only the 2-character comparison above is exact. The remaining discovery time is broken down in the re-measurement below: it is dominated by 2-character representative-context search, not FTS or Kiwi.

## Complete per-batch stage tables (required format)

Generated from the tracked ledgers in `data/timing/` (start/end are the first start and last end across that stage's spans, UTC; "Active" is the interval union; "Summed worker" counts overlap). Every value without a machine-observed source is `unavailable`; nothing is estimated. "Declared wait" is wait recorded as an explicit ledger event: none was declared in any batch, so gaps appear only as the unattributed row. Work counts for the 2-character, 3+-character and sidecar rows come from each original run's own counters; their time is `unavailable` because the original runs were not instrumented below the stage level (see the re-measurement section for representative per-path times).

#### B10 (wall 2131.9 s, active union 1504.8 s)

| Required stage | Start → end (UTC, first→last span) | Summed worker s | Active s | Timing source | Spans / retries / failures | Declared wait | Work count |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1. Discovery, dedup, filter | 07:23:44 → 07:36:04 | 693.6 | 693.6 | monotonic | 3 spans / 2 retry / 2 failed | none declared | 500 candidates selected |
| 2a. Evidence: 1–2-char exact lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 2-char 147 (1-char 0); search 1–2-char 286 |
| 2b. Evidence: 3+-char FTS lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 353; search 1,211 |
| 2c. Sidecar cold build / warm reuse | unavailable (cold build measured once separately: 92.6 s) | unavailable | unavailable | not used (exact fallback) | unavailable | unavailable | unavailable |
| 2d. Evidence packet generation | 07:36:30 → 07:36:31 | 0.1 | 0.1 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 500 candidates |
| 3. Candidate judgment and gloss authoring | 07:37:39 → 07:51:26 | 732.9 | 185.3 | monotonic, worker-reported | 8 spans / 2 retry / 0 failed | none declared | 500 candidates |
| 4. Semantic QA / self-check (incl. rework rounds) | 07:41:32 → 07:51:49 | 1549.4 | 416.7 | monotonic, worker-reported | 15 spans / 7 retry / 3 failed | none declared | 500 candidates checked; 141 held |
| 5. Admission / artifact generation | 07:49:59 → 07:51:49 | 1.1 | 1.1 | monotonic | 2 spans / 1 retry / 1 failed | none declared | 359 admitted |
| 6. M6-2/M6-3, pins, inventory, report regeneration | 07:52:53 → 07:57:39 | 118.0 | 118.0 | monotonic | 14 spans / 1 retry / 5 failed | none declared | unavailable (files not counted) |
| 7. Batch validators | 07:51:53 → 07:53:39 | 40.1 | 40.1 | monotonic | 2 spans / 1 retry / 1 failed | none declared | 1 batch validated per attempt |
| 8. `ci:fast` (per batch) | 07:53:43 → 07:59:16 | 49.8 | 49.8 | monotonic | 3 spans / 2 retry / 2 failed | none declared | ledger-recorded runs: 3 |
| 9. `ci:normal` (checkpoint) | unavailable (no span) | unavailable | unavailable | unavailable | unavailable | unavailable | none recorded (covered by checkpoint run in B12) |
| Unattributed gap (no span) | n/a | n/a | n/a | wall − active | n/a | n/a | 627.1 s |

Query counts (original run): count 2-char 147, 3+ 353; search 1–2-char 286, 3+ 1,211.

#### B11 (wall 18665.9 s, active union unavailable s)

| Required stage | Start → end (UTC, first→last span) | Summed worker s | Active s | Timing source | Spans / retries / failures | Declared wait | Work count |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1. Discovery, dedup, filter | 08:21:21 → 08:24:08 | 167.7 | 167.7 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 500 candidates selected |
| 2a. Evidence: 1–2-char exact lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 2-char 127 (1-char 0); search 1–2-char 295 |
| 2b. Evidence: 3+-char FTS lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 373; search 1,192 |
| 2c. Sidecar cold build / warm reuse | unavailable (cold build measured once separately: 92.6 s) | unavailable | unavailable | warm reuse; per-batch time unavailable | unavailable | unavailable | unavailable |
| 2d. Evidence packet generation | 08:24:08 → 08:24:08 | 0.1 | 0.1 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 500 candidates |
| 3. Candidate judgment and gloss authoring | 08:24:13 → 08:39:20 | 966.4 | 216.2 | monotonic, worker-reported | 6 spans / 0 retry / 0 failed | none declared | 500 candidates |
| 4. Semantic QA / self-check (incl. rework rounds) | 08:39:20 → 13:29:14 (spans cross an owner-decision pause and a session handover) | 17389.2 (pause-contaminated) | unavailable | monotonic, wall | 3 spans / 0 retry / 0 failed | unavailable (pause not separately declared) | 500 candidates checked; 106 held; rework rounds unavailable |
| 5. Admission / artifact generation | 13:29:24 → 13:29:25 | 0.9 | 0.9 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 394 admitted |
| 6. M6-2/M6-3, pins, inventory, report regeneration | 13:29:49 → 13:31:54 | 65.8 | 65.8 | monotonic | 7 spans / 0 retry / 0 failed | none declared | unavailable (files not counted) |
| 7. Batch validators | 13:29:45 → 13:30:42 | 46.4 | 46.5 | monotonic | 2 spans / 1 retry / 1 failed | none declared | 1 batch validated per attempt |
| 8. `ci:fast` (per batch) | 13:32:05 → 13:32:26 | 21.1 | 21.1 | monotonic | 1 spans / 0 retry / 0 failed | none declared | ledger-recorded runs: 1 |
| 9. `ci:normal` (checkpoint) | unavailable (no span) | unavailable | unavailable | unavailable | unavailable | unavailable | none recorded (covered by checkpoint run in B12) |
| Unattributed gap (no span) | n/a | n/a | n/a | wall − active | n/a | n/a | 758.4 s |

Query counts (original run): count 2-char 127, 3+ 373; search 1–2-char 295, 3+ 1,192.

#### B12 (wall 1358.3 s, active union 521.7 s)

| Required stage | Start → end (UTC, first→last span) | Summed worker s | Active s | Timing source | Spans / retries / failures | Declared wait | Work count |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1. Discovery, dedup, filter | 13:32:36 → 13:35:18 | 162.2 | 162.2 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 350 candidates selected |
| 2a. Evidence: 1–2-char exact lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 1-char 1, 2-char 77; search 1–2-char 187 |
| 2b. Evidence: 3+-char FTS lookup | unavailable | unavailable | unavailable | not instrumented in original run | unavailable | unavailable | count 272; search 858 |
| 2c. Sidecar cold build / warm reuse | unavailable (cold build measured once separately: 92.6 s) | unavailable | unavailable | warm reuse; per-batch time unavailable | unavailable | unavailable | unavailable |
| 2d. Evidence packet generation | 13:35:18 → 13:35:18 | 0.1 | 0.1 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 350 candidates |
| 3+4. Main-agent authoring and self-check (not spanned) | unavailable | unavailable | unavailable | not measured | unavailable | unavailable | 350 candidates; 70 held; rework rounds unavailable; upper bound = unattributed gap below |
| 3h. Authoring helper span only (merge-authors) | 13:47:55 → 13:47:55 | 0.1 | 0.1 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 350 candidates (main-agent authoring not spanned) |
| 4h. Self-check helper spans only (packets, assemble) | 13:47:55 → 13:48:51 | 0.3 | 0.4 | monotonic | 3 spans / 1 retry / 1 failed | none declared | 350 candidates checked; 70 held; rework rounds unavailable |
| 5. Admission / artifact generation | 13:48:51 → 13:48:52 | 0.8 | 0.8 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 280 admitted |
| 6. M6-2/M6-3, pins, inventory, report regeneration | 13:48:59 → 13:51:07 | 70.1 | 70.1 | monotonic | 7 spans / 0 retry / 0 failed | none declared | unavailable (files not counted) |
| 7. Batch validators | 13:49:05 → 13:49:57 | 51.7 | 51.7 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 1 batch validated per attempt |
| 8. `ci:fast` (per batch) | 13:51:13 → 13:51:35 | 22.3 | 22.3 | monotonic | 1 spans / 0 retry / 0 failed | none declared | ledger-recorded runs: 1 |
| 9. `ci:normal` (checkpoint) | 13:51:40 → 13:55:14 | 213.9 | 213.9 | monotonic | 1 spans / 0 retry / 0 failed | none declared | 1 recorded run |
| Unattributed gap (no span) | n/a | n/a | n/a | wall − active | n/a | n/a | 836.6 s |

Query counts (original run): count 1-char 1, 2-char 77, 3+ 272; search 1–2-char 187, 3+ 858.


## Discovery sub-step re-measurement (lookup paths, same index and sidecar)

### Operation counts of the original B10–B12 runs

The `Spans` columns in the stage tables above are timing spans/attempts, not work units. The work counts below come from the original discovery runs' own outputs (`evidence_collection` counters and the per-candidate first query form in each run's candidate inventory, kept in ignored `data/reference/`), not from the re-selection. Per-path **time** for these original runs is `unavailable` (not instrumented then); the 2-character count path was served by the exact fallback in B10 and by the warm sidecar in B11/B12.

| Batch | Candidates | Count queries 1-char | Count queries 2-char | Count queries 3+ | Search queries 1–2-char (literal scan) | Search queries 3+ (FTS5) | Search queries total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B10 | 500 | 0 | 147 | 353 | 286 | 1,211 | 1,497 |
| B11 | 500 | 0 | 127 | 373 | 295 | 1,192 | 1,487 |
| B12 | 350 | 1 | 77 | 272 | 187 | 858 | 1,045 |

Authoring and self-check work units are the candidate and hold totals in the complete per-batch tables above; per-round rework counts for B11/B12 authoring and self-check are `unavailable`. Every required stage is listed per batch with a source or an explicit `unavailable`; the unavailable values are measurement gaps in the original runs, not omissions, and are not estimated here.

The original B10–B12 runs were not instrumented below the stage level, so per-path values for those exact runs are `unavailable`. `run-corpus-lemma-pilot.mjs` now records queries and wall milliseconds per lookup path (`evidence_collection.lookup_timing_by_path`). I re-ran discovery on the same index and warm sidecar with the cached Kiwi analysis, at the real batch sizes (350 and 500 candidates), with `stage-timing` spans (`data/timing/m10-a-substep-remeasure.jsonl`). The candidate sets are a re-selection, not the original batches (re-selection overlaps B12's set by 70 of 350 candidates), so these are representative re-measurements, not the recorded runs.

| Path | Queries (350) | Seconds (350) | Queries (500) | Seconds (500) |
| --- | ---: | ---: | ---: | ---: |
| count, 1-char literal scan | 1 | 5.80 | 1 | 5.71 |
| count, 2-char (warm sidecar) | 77 | 0.02 | 117 | 0.02 |
| count, 3+-char FTS5 trigram | 272 | 3.05 | 382 | 6.66 |
| search (representative contexts), 1-char | 1 | 0.20 | 1 | 0.25 |
| search (representative contexts), 2-char literal scan | 195 | 120.19 | 288 | 170.50 |
| search (representative contexts), 3+-char FTS5 | 849 | 4.28 | 1,194 | 8.35 |
| Lookup subtotal | 1,395 | 133.54 | 1,984 | 191.49 |
| Stage span (`run`, includes selection, Kiwi cache reuse, writing) | | 140.18 | | 197.40 |
| Not attributed to lookups | | 6.64 | | 5.91 |

- Sidecar cold construction: 92.6 s one time (separate measurement above); warm reuse is the 0.02 s rows. Old-fallback equivalence and the 410,113 ms figure remain the controlled 77-query comparison; the 117-query count was not run against the fallback, so no fallback time is claimed for it.
- 2-character search still costs 87.7 % (500) / 90.0 % (350) of lookup time and 86.4 % / 85.7 % of the discovery stage. The sidecar only covers counts; the representative-context search for 2-character forms is an `instr()` scan (about 0.6 s per query).
- Earlier text in this report that attributed the remaining ≈160 s to "3+/FTS and Kiwi" is withdrawn: 3+ lookups total 7.3 s (350) / 15.0 s (500).

## Stages by observed wall contribution (B12)

Measured stages only, ranked by observed share of wall (B12). Authoring + self-check (up to 61.6 %, untimed upper bound) is listed separately and is not ranked as an observed stage.

1. `ci:normal` checkpoint: 15.7 % (one recorded invocation, once per checkpoint)
2. Discovery: 11.9 % (was ≈32 % of B10 wall); within it, 2-character search is about 86 % (re-measured)
3. Derived refresh: 5.2 % (issue-222 report 42.0 s of 70.1 s)
4. Batch validators: 3.8 %
5. `ci:fast`: 1.6 %
6. Admission, evidence, assemble: <0.2 %

## CI invocation audit (stable table for M10-B onwards)

Counts are of *recorded or retrievable* invocations only; they are not proof that every run was captured. `ci:normal` runs the fast checkpoint first and then the continuation (`.github/workflows/ci.yml`: "fast checkpoint + continuation"), so a normal run already contains a fast run: never add the two for the same invocation.

### Local, instrumented (`data/timing` ledgers)

| Batch | `ci:fast` spans | `ci:fast` failed | `ci:fast` seconds (all spans) | `ci:normal` spans | `ci:normal` seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| B10 | 3 | 2 | 49.8 (10.0 / 19.2 / 20.6) | 0 | 0 |
| B11 | 1 | 0 | 21.1 | 0 | 0 |
| B12 | 1 | 0 | 22.3 | 1 | 213.9 |
| Total | 5 | 2 | 93.2 | 1 | 213.9 |

The 213.9 s is **one recorded B12 local invocation** (`ci-normal-checkpoint-11042`, attempt 1, ok, at the 11,042 checkpoint). It is not the whole project's normal-validation cost. Mean/median per run are not reported: one normal sample, five fast samples across different states.

### Local, uninstrumented or not retrievable

- Retrievable from this session's transcript: exactly one local `ci:normal` command (the instrumented one above) and, after the ledger snapshots, one un-spanned `ci:fast` on the committed head db2fdf2 (passed; duration `unavailable`). Local `ci:fast` runs made while diagnosing failures that were not spanned: `unavailable`.
- Local runs made by the earlier cloud session, and any manual shell invocations outside the ledger or this transcript: `unavailable` (no shell history or CI log was collected). Missing observability: no wrapper recorded invocations that were not launched through `stage-timing.mjs run`.
- Partial/aborted runs: a dirty-worktree refusal of `ci:fast` (provenance check, sub-second) happened once before the ledger moved to ignored space and once more on this PR before commit; neither produced a timed category result and neither is counted above.

### GitHub Actions `ci:normal` (remote runner wall time, kept separate)

| Run ID | Head | Trigger | Result | Observed seconds |
| --- | --- | --- | --- | ---: |
| 36988521267 | 364c382 | pull_request | success | 322 (job 09:13:20 to 09:18:42) |
| 36989234325 | c080501 | pull_request | success | 320 (job 09:20:47 to 09:26:07) |
| 37017843162 | db2fdf2 | pull_request | success | 351 (job 14:09:04 to 14:14:55) |

Three remote normal runs, one per pushed head; cumulative job time 993 s (322 + 320 + 351). These are on different hardware and must not be mixed with local `stage-timing` seconds or charged twice. Remote runs cover only pushed heads, which are not checkpoints per batch.

### Grouping of batch checkpoints

- Batches B10, B11, B12 each ran `ci:fast` (B10 three times because two attempts failed on provenance/derived-refresh problems). One local `ci:normal` covered all three batch checkpoints together (at 11,042). Normal runs avoided: 2 (B10 and B11 had none).
- Measured comparison of actual batch-by-batch vs grouped policy: not made. Savings from the two skipped normal runs would be hypothetical (no per-batch normal run was measured), so none is claimed.

### Report columns to keep for M10-B

Per invocation: category (`fast`/`normal`/`all`/deep), where (local/GitHub), batch/phase, trigger/purpose, attempt, result, head, seconds, provenance (`ledger`/`transcript`/`GitHub run`/`unavailable`). Launch every local run through `stage-timing.mjs run` so the table is complete.

## Tokens

- Subagent tokens (machine-reported): B10 1,260,832; B11 910,804 (authors only).
- Main-session tokens, including all B12 and B11 self-check work: `unavailable`.

## One next change for M10-B (recommendation, not applied)

Make the 2-character representative-context search index-backed, extending the short-count sidecar approach: it is the largest measured item in discovery (120.2 s of 140.2 s at 350 candidates; 170.5 s of 197.4 s at 500). Expected effect is an upper bound of about 2 minutes per batch if the lookup were free; equivalence to the scan must be proved the way the count sidecar was. The authoring + self-check loop is likely larger but is not measured; spanning each chunk in M10-B is a measurement task, not the optimization.

## Uncertainties

- B12 authoring/self-check time is an upper bound from ledger gaps; rework share is unmeasured.
- B11 admitted/hour is unavailable (pause-contaminated). B10 timing overlaps tool development.
- Candidate mixes differ per batch, so no cross-batch speedup beyond the controlled comparison is claimed.
- Authoring + self-check share (61.6 %) is a gap-derived upper bound and is not used to rank the next optimization.
- Sub-step lookup numbers are from re-measurement runs, not the original B10–B12 runs.

## Boundaries

No raw corpus passages, corpus indexes, model outputs or secrets are committed. The sidecar and index remain under ignored `data/reference/`. B05–B09 history and the B01–B04 re-review are untouched.

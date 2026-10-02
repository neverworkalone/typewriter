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
| review / self-check | 3 | 17,389.2 | 17,389.2 | 0 |
| admission | 1 | 0.9 | 0.9 | 0 |
| derived refresh | 7 | 65.8 | 65.8 | 0 |
| validation | 2 | 46.4 | 46.5 | 1 failed |
| `ci:fast` | 1 | 21.1 | 21.1 | 0 |

Wall 18,665.9 s, but the review span is **not** an active-time measurement: it covers the owner-decision pause and the handover to the cloud session. File mtimes put chunks 01–07 and chunks 08–12 in two sittings hours apart. Admitted/hour for B11 is therefore `unavailable`; do not compute it from the wall figure. Authoring used subagent authors (reported 910,804 subagent tokens) before the no-subagent directive.

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

1–2-character exact lookups were the measured bottleneck: B10 discovery was 690.8 s; B11/B12 with the sidecar were 167.7 s / 162.2 s. The batches contain different candidate mixes, so the cross-batch discovery ratio (about 4.1×) is indicative; only the 2-character comparison above is exact. The remaining ≈160 s is 3+-character/FTS counting and Kiwi analysis reuse, not separately timed per sub-step yet.

## Stages by observed wall contribution (B12)

1. Main-agent authoring + self-check: 61.6 % (upper bound, untimed)
2. `ci:normal` checkpoint: 15.7 % (once per checkpoint, not per batch)
3. Discovery: 11.9 % (was ≈32 % of B10 wall)
4. Derived refresh: 5.2 % (issue-222 report 42.0 s of 70.1 s)
5. Batch validators: 3.8 %
6. `ci:fast`: 1.6 %
7. Admission, evidence, assemble: <0.2 %

## Tokens

- Subagent tokens (machine-reported): B10 1,260,832; B11 910,804 (authors only).
- Main-session tokens, including all B12 and B11 self-check work: `unavailable`.

## One next change for M10-B (recommendation, not applied)

Instrument and shrink the authoring + self-check loop, the largest and least-measured stage: wrap each author/self-check chunk in `stage-timing` spans, and add a pre-assemble lint that runs the frame-count, lemma-in-citation-form and `topic_verdicts` checks before `self-check-assemble`, so those validation failures are fixed in the authoring pass instead of in rework loops. Discovery is already the second-order stage and derived refresh is a smaller fixed cost.

## Uncertainties

- B12 authoring/self-check time is an upper bound from ledger gaps; rework share is unmeasured.
- B11 admitted/hour is unavailable (pause-contaminated). B10 timing overlaps tool development.
- Candidate mixes differ per batch, so no cross-batch speedup beyond the controlled comparison is claimed.
- The lint's benefit is a hypothesis until spanned in M10-B.

## Boundaries

No raw corpus passages, corpus indexes, model outputs or secrets are committed. The sidecar and index remain under ignored `data/reference/`. B05–B09 history and the B01–B04 re-review are untouched.

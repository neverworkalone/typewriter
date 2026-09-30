# Issue #222 — M9-D scale coverage checkpoint

State: **complete**. The 7,500 record target remains reached.

## Progress

The issue started from 5,105 directly searchable canonical records at 77f52ae7ae8040146c25b75b2dcdf29f7b4f5e42. The current canonical set has 7,521 directly searchable records, leaving 0 to the target. The historical recovery batch and 8 bounded corpus batches reviewed 2860 candidates and admitted 2416 records.

| Source class | Reviewed | Admitted | Held | Rejected |
| --- | ---: | ---: | ---: | ---: |
| Historical recovery inventory | 20 | 20 | 0 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-01-20260930 | 20 | 8 | 12 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-02-20260930 | 200 | 145 | 55 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-03-20260930 | 500 | 376 | 124 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-04-20260930 | 500 | 396 | 104 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-05-20260930 | 500 | 436 | 64 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-06-20260930 | 500 | 459 | 41 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-07-20260930 | 500 | 462 | 38 | 0 |
| Local Written Corpus issue-222-m9-d-corpus-batch-08-20260930 | 120 | 114 | 6 | 0 |
| Total | 2860 | 2416 | 444 | 0 |

Admission used the ordinary source-bound lexical producer, semantic audit, and exact-search checks. There was no admission quota. Each authored batch is marked as agent-authored and not human-reviewed.

## Corpus evidence

The local snapshot contains 4,988,970 paragraphs across 3,410 documents. Each selection reviewed the same 251,086-paragraph bounded sample (5.03%). The retrieval pool contained 55,580 distinct lemma proposals before coverage checks. That pool sets review order only; it does not authorize admission.

| Corpus batch | Candidate limit | Reviewed | Admitted | Held | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| issue-222-m9-d-corpus-batch-01-20260930 | 20 | 20 | 8 | 12 | 0 |
| issue-222-m9-d-corpus-batch-02-20260930 | 200 | 200 | 145 | 55 | 0 |
| issue-222-m9-d-corpus-batch-03-20260930 | 500 | 500 | 376 | 124 | 0 |
| issue-222-m9-d-corpus-batch-04-20260930 | 500 | 500 | 396 | 104 | 0 |
| issue-222-m9-d-corpus-batch-05-20260930 | 500 | 500 | 436 | 64 | 0 |
| issue-222-m9-d-corpus-batch-06-20260930 | 500 | 500 | 459 | 41 | 0 |
| issue-222-m9-d-corpus-batch-07-20260930 | 500 | 500 | 462 | 38 | 0 |
| issue-222-m9-d-corpus-batch-08-20260930 | 120 | 120 | 114 | 6 | 0 |
| Total | — | 2840 | 2396 | 444 | 0 |

Raw paragraph text remains in ignored local reference data. Tracked evidence includes bounded paragraph identifiers and source digests only.

## Reproducibility

Run `npm run batch:issue-222:check` to validate the historical source binding and all 8 corpus batches through candidate disposition, shared admission, complete semantic coverage, exact direct search, and two identical logical SQLite builds. Run `npm run batch:issue-222:report` to regenerate this Markdown and the machine report.

The checkpoint validates 2416 records added since the baseline under exact search with 0 shared admission blockers. Logical database builds compared: 2; identical: true.

## Continuation

The M9 production ledger has processed 9 review batches from 5,105 to 7,521 directly searchable records. 0 remain to the checkpoint; continuation required: **false**. A clean batch is a review and validation checkpoint, not a reason to stop while unseen in-scope candidates remain.

## Remaining work

Continue unseen source-bound historical or corpus review batches. Batch size may grow toward 500 after consecutive clean checkpoints with manageable review and validation; continue until the 7,500-record checkpoint or a documented source, product-model, or licensing blocker.

No product-model, licensing, or source-exhaustion blocker is currently documented.

# Issue #222 — M9-D scale coverage checkpoint

State: **in_progress**. The approximately 7,500 record target is still open.

## Progress

The issue started from 5,105 directly searchable canonical records at 77f52ae7ae8040146c25b75b2dcdf29f7b4f5e42. The current canonical set has 5,133 directly searchable records, leaving 2,367 to the target. The change admits 28 records from two bounded source classes.

| Source class | Reviewed | Admitted | Held | Rejected |
| --- | ---: | ---: | ---: | ---: |
| Historical recovery inventory | 20 | 20 | 0 | 0 |
| Local Written Corpus proposals | 20 | 8 | 12 | 0 |
| Total | 40 | 28 | 12 | 0 |

Admission used the ordinary source-bound lexical producer, semantic audit, and exact-search checks. There was no admission quota. The authored decisions are marked as agent-authored and not human-reviewed.

## Corpus evidence

The local snapshot contains 4,988,970 paragraphs across 3,410 documents. The bounded sample reviewed 251,086 paragraphs (5.03%). Extraction found 55,580 distinct lemma proposals before coverage checks; this is a retrieval pool, not an admission pool. The first 20 reviewed candidates yielded 8 admissions and 12 holds. No extrapolation is made from this single batch.

Raw paragraph text remains in ignored local reference data. Tracked evidence includes bounded paragraph identifiers and source digests only.

## Reproducibility

Run `npm run batch:issue-222:check` to validate both frozen source bindings, all candidate dispositions, shared production and semantic coverage, exact direct search, and two identical logical SQLite builds. Run `npm run batch:issue-222:report` to regenerate this Markdown and the machine report.

The checkpoint validates 28 new records under exact search with 0 shared admission blockers. Logical database builds compared: 2; identical: true.

## Remaining work

Continue bounded historical and corpus review batches, each capped at 20 candidates. The current evidence does not show an external or source-policy blocker; the scale target remains incomplete because only these two batches have been reviewed. Keep the target gap visible and do not use a quota or estimated yield to admit records.

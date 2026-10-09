# Issue #222 — M9-D scale coverage checkpoint

State: **complete**. The 7,500 record target remains reached.

## Progress

The issue started from 5,105 directly searchable canonical records at 77f52ae7ae8040146c25b75b2dcdf29f7b4f5e42. The current canonical set has 12,312 directly searchable records, leaving 0 to the target. The historical recovery batch and 8 bounded corpus batches reviewed 2860 candidates and admitted 2416 records for Issue #222. The current set includes 4,791 records added after that checkpoint.

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

Run `npm run batch:issue-222:report:check` to validate the checkpoint from tracked candidate reviews, semantic decisions, imports, inventories, and current canonical data, including shared admission, semantic coverage, exact direct search, and two identical logical SQLite builds. Run `npm run batch:issue-222:check` locally for the additional permission-bound corpus evidence checks that read the shared Typewriter cache.

The checkpoint validates 2416 records added since the baseline under exact search with 0 shared admission blockers. Logical database builds compared: 2; identical: true.

## Checkpoint audit

Current canonical inventory: 12312 records, 12312 directly searchable, 0 non-searchable, 12620 senses, and 2534 relations. Relation-empty searchable records: 11653.

| Record type | Records |
| --- | ---: |
| entry | 11158 |
| expression | 1154 |

| Sense POS | Senses |
| --- | ---: |
| adjective | 546 |
| adverb | 13 |
| expression | 1176 |
| noun | 9216 |
| verb | 1669 |

Exact lemma coverage: 12312/12312; exact search-form owner keys: 12569/12569; missing owners: 0; unexpected owners: 0; cross-record collisions: 0.

### Candidate yield and disposition

The initial corpus candidate pool had 55580 distinct lemma proposals. 2033 were already exact-lemma covered and 41 had search-surface collisions; covered or colliding proposals were 3.73% of that pool.
Across reviewed batches, hold reasons were search-collision: 9; unresolved-identity: 317; unresolved-sense: 118; rejection reasons were none.

| Historical recovery remaining disposition | Count |
| --- | ---: |
| hold | 251 |
| duplicate | 2 |
| invalid-lemma | 2 |
| admit-candidate | 228 |
| needs-sense-split | 28 |
| not-a-lexical-unit | 10 |
| search-surface-collision | 1 |
| Historical rows recovered | 62 |
| Potentially recoverable rows remaining | 507 |

### Unresolved review inventory

| Source | Finding class | Count |
| --- | --- | ---: |
| current-canonical-exact-search-audit | non-searchable-canonical-records | 0 |
| current-canonical-exact-search-audit | cross-record-search-collisions | 0 |
| issue-210-historical-recovery-pool | unresolved-sense-pos-or-context-cases | 204 |
| issue-210-historical-recovery-pool | search-surface-collisions | 1 |
| issue-210-historical-recovery-pool | true-duplicates | 2 |
| issue-222-corpus-reviews | search-collision | 9 |
| issue-222-corpus-reviews | unresolved-identity | 317 |
| issue-222-corpus-reviews | unresolved-sense | 118 |

### Batch and system correction history

| Batch | POS corrections | Semantic corrections | Correction passes |
| --- | ---: | ---: | ---: |
| issue-222-m9-d-historical-batch-01-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-01-20260930 | 1 | 0 | 0 |
| issue-222-m9-d-corpus-batch-02-20260930 | 2 | 0 | 0 |
| issue-222-m9-d-corpus-batch-03-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-04-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-05-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-06-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-07-20260930 | 0 | 0 | 0 |
| issue-222-m9-d-corpus-batch-08-20260930 | 0 | 0 | 0 |

Correction rate: **NOT_MEASURED_NO_HUMAN_REVIEW**. Writer review burden: **NOT_MEASURED_NO_WRITER_REVIEW**. Systemic defect classes: 0; shared system fixes recorded: 0.

Normal CI status: read the exact-head GitHub PR check **Validate and test Typewriter** (`npm run ci:normal`); this report stores no pass/fail result and never reuses an earlier report's status. Canonical digest: `2c63d14bac10c25349bf49422faf9674ead61fe7938c6b8ef6d031750b7bc54f`.
Runtime/package impact: **dictionary-record-count-growth-runtime-contract-unchanged-package-bytes-not-measured**. The packaged dictionary grew from 5,105 to 12,312 records (+7,207; 141.18%). Runtime contract changed: false; package bytes measured: false. Issue #222 and later checkpointed work add canonical data without changing dictionary schema, search algorithm, or runtime/package code. Normal CI builds the current Extension and Web outputs and validates their product-output contracts; the dictionary record-count growth is measured here, while the package-byte delta was not measured separately. Targeted validation: normal-ci-product-build-and-output-contract.

## Continuation

The M9 production ledger processed 9 review batches from 5,105 to 7,521 directly searchable records. 0 remain to the checkpoint; continuation required: **false**. The completed M9-D checkpoint hands continued expansion to M9-E (#223).

## Remaining work

Issue #222 has reached the 7,500 directly searchable record checkpoint. Continue the next expansion stage under M9-E (#223) toward 10,000 reviewed canonical records, preserving source-bound admission and the shared search invariants.

No product-model, licensing, or source-exhaustion blocker is currently documented.

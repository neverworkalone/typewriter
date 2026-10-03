# M10-B 12K Performance Review (Issue #247, parent #239)

Corpus-text-free: counts, durations and method notes only. Raw ledgers are `data/timing/issue-223-m9-e-corpus-batch-{13,14,15}-20261003.jsonl`; the search comparisons are `data/timing/m10-b-short-search-comparison-*.json` (digests only).

## State

- Canonical records: 12,204 (11,042 after M10-A). B13 +366, B14 +399, B15 +397. Each batch: 500 candidates; admitted/held = 366/134, 399/101, 397/103.
- All three batches use the agent self-check contract (`independent_review: false`). A self-check is not independent approval. No subagents or other models were used.
- M10-C is not opened. `ci:normal` failed once (policy classification), then passed on rerun; see "CI accounting".

## 1. Two-character context search (shared reader)

- New sidecar `*.short-postings.sqlite`: delta-varint rowid lists per bigram with CRC-32; only bigrams with count ≤ 5,000 are stored. `search()` for a 2-code-point query uses the list, verifies every posted rowid with `instr`, and falls back to the exact ordered scan on any absence, mismatch, CRC/count error or stale count sidecar. 1- and 3+-character paths are unchanged. Regressions: codec, every-bigram equivalence at several limits/thresholds, corruption, stale sidecar.
- Replay on the same index, same queries, same limit (100), results compared by digest:

| Workload | Queries | Old scan | New cold first pass | New warm (3 runs) | Mismatches / omissions |
| --- | ---: | ---: | ---: | ---: | ---: |
| B05 inventory | 125 | 34,151 ms (273 ms/query) | 786 ms | 702–707 ms (≈5.6 ms/query) | 0 / 0 |
| B13 inventory | 393 | 126,068 ms (321 ms/query) | 3,422 ms | 3,240–3,373 ms (≈8.3 ms/query) | 0 / 0 |

- Build (one-time): 284.4 s, 177,446,912 bytes (4.5 % of the 3.94 GB index), 636,514 bigrams, 627,952 lists, 54,404,946 rowids, peak RSS ≈ 1.51 GB (build only). Reader memory at query time: `unavailable` (not measured).
- Amortisation: ≈ 120 s saved per ~400-query batch workload, so the build pays back after ≈ 2–3 batches. Bigrams above 5,000 matches still scan; the share of queries using that fallback in production batches was not measured.
- Discovery wall time: B13 62.2 s, B14 28.9 s, B15 35.0 s (M10-A: 162–197 s). The selection path also changed (analysis reuse), so the gain is not attributable to the sidecar alone.

## 2. Per-batch stage tables

Seconds; Active = interval union. Spans bracket tool calls; model-token counts and billing are `unavailable`.

| Stage | B13 | B14 | B15 |
| --- | ---: | ---: | ---: |
| discovery | 67.7 (5 failed spans) | 28.9 | 35.0 |
| authoring (6 chunks + merge) | 544.1 | 392.4 | 268.6 |
| self-check (6 chunks + assemble) | 500.7 | 316.0 | 121.2 |
| admission | 0.9 | 0.9 | 1.2 (1 failed) |
| derived refresh | 72.9 | 74.1 | 74.4 |
| validators | 54.3 | 61.3 | 65.4 |
| `ci:fast` | 44.6 (1 failed) | 23.6 | 23.7 |
| Wall / active | 1,729.7 / 1,285.4 | 1,030.0 / 897.5 | 879.4 / 816.7 |

Authoring and self-check are separated per chunk (see ledgers, labels `authoring-chunk-NN` / `self-check-chunk-NN`). Chunk durations: authoring B13 62–113 s, B14 55–73 s, B15 34–53 s; self-check B13 72–104 s, B14 28–70 s, B15 5–25 s.

Caveat: the downward trend is confounded. Later batches reused tooling and spec formats. The first B15 self-check pass was templated (review on PR #248 blocked it); B15 self-check was then rewritten with per-context notes and usage-sentence frames, and a shared gate (`assertSelfCheckEvidenceIsSpecific`) now rejects such passes. The rewrite is not in the B15 ledger spans above (they measure the first pass), so B15 self-check time is understated. B14 notes were also formulaic (not covered by the gate, which applies to newly assembled batches).

## 3. Rework

- B13: 92 glosses rewritten for connector (multi-span) glosses; 5 discovery failures (quoting, unsupported exclusion source, cache binding, symlinked data directory); 4 assemble retries (citation-form frames, copy-phrase violations); 3 self-check flips.
- B14: 8 connector glosses reworked; 1 flip; copy-phrase and citation-form frame fixes found at assemble.
- B15: 4 connector glosses plus 12 more found only by successive assemble runs; ambiguous-particle gloss 1; admission failed once because templated notes repeated (the repetition check normalises only lemma and digits; embedding the gloss in the note satisfied it, which weakens that check); 1 flip.
- Every defect was detected only after a whole chunk or batch was written, at `merge-authors`, `self-check-assemble` or admission.

## 4. CI accounting

Local invocations observed in ledgers: `ci:fast` B13 ×2 (first failed on a dirty worktree), B14 ×1, B15 ×1 (all passing, 21–24 s); `batch:issue-223:check` ×3 (54–65 s). `ci:normal` at the 12,204 checkpoint (commit `7d3990a`) failed once, 227.1 s: `tests/artifact-policy.test.mjs` rejected the two `data/timing/m10-b-short-search-comparison-*.json` files as unclassified. Fixed by registering that pattern in `config/artifact-policy.json`; the rerun at the policy-fix commit passed in 283.7 s (ledger label `ci-normal-rerun-after-policy-fix`). GitHub CI invocations: `unavailable` at report time (branch not yet pushed).

## 5. Bottlenecks (ranked, measured)

1. Authoring + self-check turns: 1,045 s of 1,729 s wall in B13, 708 of 1,030 in B14, 390 of 879 in B15.
2. Defects found late (section 3): each costs a full re-run of merge/assemble plus rewrite turns.
3. Fixed per-batch machinery: derived refresh ≈ 74 s + validators ≈ 55–65 s + `ci:fast` ≈ 24 s ≈ 165 s, dominated by the issue-222 report (≈ 45 s).
4. Discovery, no longer dominant (29–62 s).

## 6. One next change (not implemented)

Add a lint command that runs the existing `merge-authors` and `self-check-assemble` validators (single-span gloss, ≥ 2 words, citation-form frames, copy-phrase, ambiguous particles, note repetition) on a single chunk file as soon as it is written. This moves the defect detection of section 3 from batch end to chunk time and removes the repeated whole-batch retries.

## 7. Uncertainties

- Token use and cost: `unavailable` (no machine-readable source in the main session).
- Span times are not model-compute times; the improvement across B13→B15 mixes learning, templating and tooling.
- Self-check rows are the same agent re-reading its own decisions; admitted quality is not independently verified. B14 notes are formulaic and were not re-reviewed.
- Reader memory, fallback-query share and behaviour on a cold OS page cache were not measured; timings come from one machine.
- GitHub CI behaviour is not yet observed.

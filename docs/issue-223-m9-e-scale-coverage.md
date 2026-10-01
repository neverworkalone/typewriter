# Issue #223 — M9-E coverage checkpoint

State: **partial checkpoint; Issue #223 remains open**. The owner requested this PR include the current review scope only. B05 is a review-only checkpoint and does not change canonical data.

## Progress

The checkpoint starts from the 7,521 directly searchable records completed by Issue #222. Batches B01–B04 imported 1,206 records, bringing canonical data to 8,727. B05 records the first 195 decisions from its generated 500-candidate queue; its 165 admitted candidate decisions are deferred from canonical import at the owner's direction.

| Batch | Reviewed | Admitted decisions | Canonical imports | Held | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| B01 | 200 | 174 | 174 | 26 | 0 |
| B02 | 200 | 173 | 173 | 27 | 0 |
| B03 | 500 | 439 | 439 | 61 | 0 |
| B04 | 500 | 420 | 420 | 80 | 0 |
| B05 review-only | 195 | 165 | 0 | 30 | 0 |
| Total | 1,595 | 1,371 | 1,206 | 224 | 0 |

The 165 B05 admissions have reserved candidate IDs and source-bound lexical decisions, but no semantic-decision artifact or canonical import in this checkpoint. B05's other 305 generated candidates were not reviewed. Importing deferred candidates requires the ordinary semantic review, admission, and direct-search validation path.

## Corpus evidence and review boundary

The local 2025 Written Corpus snapshot contains 4,988,970 paragraphs across 3,410 documents. The pinned one-in-twenty sample covers 251,086 paragraphs (5.0328%). B05 reuses the cached analysis and takes the first 195 proposals from its deterministic 500-candidate queue. Candidate ordering determines review order only.

Tracked candidate evidence contains bounded source identifiers, observed forms, morphology, and digests. Paragraph text, the corpus index, and the candidate inventory remain in ignored local `data/reference/` artifacts.

Six preliminary B05 admissions with source-bound analyzer ambiguity were held, preserving the shared morphology admission gate. Their decisions and bounded evidence remain in B05's review artifact.

## Batch runner contract

`scripts/batch/build-issue-223-corpus-batch.mjs` takes a batch ID of the form `issue-223-m9-e-corpus-batch-NN-YYYYMMDD`; the date is validated and source/pass IDs derive from it. Inventory and canonical IDs continue only from lower-numbered batches, so rebuilding an earlier batch is unaffected by later artifacts. The builder never mints semantic judgments: admitted records require a separately authored `--semantic-reviews` input (one review per admitted lemma, bound to the reviewed gloss digest, with explicit gloss/sense-boundary judgments and diagnostic frames). The input is a bound envelope (`kind: authored-semantic-review-input`, matching `batch_id`, named `reviewer`, `review_status: complete`); each review states its own single-sense boundary outcome and, where the gloss has an ambiguous particle span, its topic outcome (status, state, rationale), and supplies exactly one frame per derived gloss span. The input's SHA-256 is recorded in the output `source_basis.semantic_review_input_sha256`. Missing, unbound, or mismatched reviews fail closed. Review-only batches need no semantic input.

## Known provenance limitation (owner override)

The semantic-decision sources for B01–B04 (1,206 records) were produced by the earlier builder, which generated the judgment fields (`gloss_judgment`, single-sense boundary review) itself rather than consuming independently authored reviews. They satisfy the shared validators but do not establish independent editorial review. By owner decision for this checkpoint, they remain as imported; the builder now fails closed for any later batch. Replacing them with independently authored reviews is deferred to separate follow-up work, and expansion beyond this checkpoint (including B05 imports) proceeds in a later PR under the new contract.

## Validation

The Issue #223 validator checks source-bound candidate evidence, canonical imports for B01–B04, semantic coverage, direct search, and deterministic SQLite builds. For B05 it verifies the review-only marker, the absence of semantic and canonical sidecars, and that deferred IDs and lemmas are not already canonical. Normal CI separately discovers and checks every tracked M9 corpus candidate-review artifact.

The exact-head CI result is reported by GitHub checks; this checkpoint report does not reuse prior CI status. The 10,000-record Issue #223 target remains unfinished, with 1,273 canonical records remaining from this checkpoint.

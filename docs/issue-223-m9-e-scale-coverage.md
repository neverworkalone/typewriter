# Issue #223 — M9-E coverage checkpoint

State: **partial checkpoint; Issue #223 remains open**. B05's 165 admitted candidates are now imported under the independent semantic-review input contract. B05's remaining 305 generated candidates are not yet reviewed.

## Progress

The checkpoint starts from the 7,521 directly searchable records completed by Issue #222. Batches B01–B05 imported 1,371 records, bringing canonical data to 8,892. B05 records the first 195 decisions from its generated 500-candidate queue and imports its 165 admitted candidates.

| Batch | Reviewed | Admitted decisions | Canonical imports | Held | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| B01 | 200 | 174 | 174 | 26 | 0 |
| B02 | 200 | 173 | 173 | 27 | 0 |
| B03 | 500 | 439 | 439 | 61 | 0 |
| B04 | 500 | 420 | 420 | 80 | 0 |
| B05 | 195 | 165 | 165 | 30 | 0 |
| Total | 1,595 | 1,371 | 1,371 | 224 | 0 |

B05 is the first batch built through the bound semantic-review contract: its authored review input is preserved as `data/batches/issue-223-m9-e-corpus-batch-05-semantic-review-input.json`, its digest is recorded in the semantic source, and the validator re-derives every decision row from it. B05's other 305 generated candidates were not reviewed. The 10,000-record target remains unfinished, with 1,108 canonical records remaining.

Each admitted predicate sense also needs an M6-3 surface-form disposition (`data/validation/m6-3-surface-form-review.json`). B05 required 13: twelve open-vowel past exclusions and one regular ㅎ verb (`땋다`). The shared projection still fails closed if one is missing.

## Corpus evidence and review boundary

The local 2025 Written Corpus snapshot contains 4,988,970 paragraphs across 3,410 documents. The pinned one-in-twenty sample covers 251,086 paragraphs (5.0328%). B05 reuses the cached analysis and takes the first 195 proposals from its deterministic 500-candidate queue. Candidate ordering determines review order only.

Tracked candidate evidence contains bounded source identifiers, observed forms, morphology, and digests. Paragraph text, the corpus index, and the candidate inventory remain in ignored local `data/reference/` artifacts.

Six preliminary B05 admissions with source-bound analyzer ambiguity were held, preserving the shared morphology admission gate. Their decisions and bounded evidence remain in B05's review artifact.

## Batch runner contract

`scripts/batch/build-issue-223-corpus-batch.mjs` takes a batch ID of the form `issue-223-m9-e-corpus-batch-NN-YYYYMMDD`; the date is validated and source/pass IDs derive from it. Inventory and canonical IDs continue only from lower-numbered batches, so rebuilding an earlier batch is unaffected by later artifacts. The builder never mints semantic judgments: admitted records require a separately authored `--semantic-reviews` input (one review per admitted lemma, bound to the reviewed gloss digest, with explicit gloss/sense-boundary judgments and diagnostic frames). The input is a bound envelope (`kind: authored-semantic-review-input`, matching `batch_id`, named `reviewer`, `review_status: complete`); each review states its own single-sense boundary outcome and, where the gloss has an ambiguous particle span, its topic outcome (status, state, rationale), and supplies exactly one frame per derived gloss span. The input's SHA-256 is recorded in the output `source_basis.semantic_review_input_sha256`. Missing, unbound, or mismatched reviews fail closed. The builder persists the exact input bytes as `data/batches/<batch>-semantic-review-input.json`; the Issue #223 validator re-reads that artifact, requires its digest, batch, envelope, and admitted-lemma coverage to match, and requires the semantic output reviewer to equal the input's reviewer (the shared validator takes the expected reviewer from config, defaulting to `codex-agent`). The validator also re-derives every semantic decision row from the stored input (same lemma and gloss digest) and requires an exact match, so changing any outcome, rationale, or frame in the output fails even if the artifact digest is recomputed. Only B01–B04 are exempt from carrying an input; any later batch without one fails. Review-only batches need no semantic input.

## Known provenance limitation (owner override)

The semantic-decision sources for B01–B04 (1,206 records) were produced by the earlier builder, which generated the judgment fields (`gloss_judgment`, single-sense boundary review) itself rather than consuming independently authored reviews. They satisfy the shared validators but do not establish independent editorial review. By owner decision for this checkpoint, they remain as imported; the builder now fails closed for any later batch. Replacing them with independently authored reviews is deferred to separate follow-up work, and later batches, including B05, proceed under the new contract.

## Validation

The Issue #223 validator checks source-bound candidate evidence, canonical imports for B01–B05, semantic coverage, direct search, and deterministic SQLite builds. A review-only batch, if one is used, is verified for its marker, the absence of semantic and canonical sidecars, and that deferred IDs and lemmas are not already canonical. Normal CI separately discovers and checks every tracked M9 corpus candidate-review artifact.

The exact-head CI result is reported by GitHub checks; this checkpoint report does not reuse prior CI status. The 10,000-record Issue #223 target remains unfinished, with 1,108 canonical records remaining.

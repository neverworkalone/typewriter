# Lexical factory shared contracts (issue #263, Impl 1/4)

Implements the shared foundation of [`lexical-production-factory.md`](lexical-production-factory.md).
It is a library plus a repository validator; it creates no batches, claims or agents.

| Module | Role |
| --- | --- |
| `scripts/factory/contract.mjs` | `data/candidates/C…` and `data/reviews/C…` manifests, `candidates.jsonl` rows, per-usage `C…-NNNN` ids, digests, decision-row coverage |
| `scripts/factory/transitions.mjs` | Both state machines and the linked Stage 2 / Stage 3 transitions on manifests of merged `master` vs. a merge result |
| `scripts/factory/identity-adapter.mjs` | Keeps one decision per `C…` id on top of the legacy `input+POS` intake; routes to `new_entry`, `new_pos_on_existing_lemma`, `new_sense_on_existing_entry` |
| `scripts/factory/handoff.mjs` | Typed decision rows and canonical-compatibility checks; writer-support partition |
| `scripts/factory/artifacts.mjs` | Content validation of a review's `semantic-decisions.json` and `intake-handoff.json`: existing contract ids, existing `verifyProductionHandoff`, one semantic decision per admitted candidate, reviewed lemma/hold-resolution bound to the candidate and hand-off entry |
| `scripts/factory/stage1.mjs`, `produce-candidates.mjs` | Stage 1 producer (see below) |
| `scripts/factory/validate.mjs` | Repository validator run by `ci:fast`. It always compares with the merge-base of `origin/master` (override `FACTORY_BASE_REF`; unresolved base fails closed, only `none` skips): candidate transitions are checked with or without a review, and deleted merged batches/reviews fail |

## Adjustments to the design's illustrative shapes

- Review manifest adds `history` (`[{attempt, rejected_pr}]`, one entry per rejected attempt). `rejected_pr` is valid only while `status` is `rejected` and equals the last history entry; rework (`rejected → ready`) advances `attempt` by one and may not alter history.
- Candidate manifest adds `analyzer_version` (pinned `kiwipiepy==X.Y.Z`). Candidate rows require `usage_hint`; evidence is text-free (`kind`, `ref`) and capped at five.
- `status`, `rejected_pr`, `attempt`, `history` are the only mutable manifest fields and are excluded from `manifestContentDigest`; `candidates.jsonl` and review artifacts are covered by separate byte digests, so a status-only change never changes them.
- The owner-directed `held` candidate status is **rejected** for now: there is no verifiable owner-authorization field, so an unauthorized hold cannot be told from an authorized one. Add it together with a checkable authorization contract.
- `semantic-decisions.json` applies the existing source-bound row contract to every admitted candidate against the record derived from the reviewed decision: `candidate_record_sha256`, `validateAuthoredSemanticReviewBinding`, `validateAuthoredDecisionDisposition`, `validateDistinctSenseSemanticRationales`, and the shared per-sense `validateSenseReviews` (extracted unchanged from the historical row validator: boundary decision vs. gloss writer-domains, topic-analysis `review_basis`, relation evidence), plus decision/gloss coherence, honest `human_reviewed: false` provenance and a complete review covering every candidate. Only the whole-source selection capacity/rank/axis checks of `validateAuthoredSemanticDecisionSource` are not applied; they have no factory meaning.
- Candidate transitions: `created → complete` only together with a new `ready` review in the same change; `rejected → ready` (rework) and Stage 3's `ready → complete|rejected` leave the candidate manifest unchanged.

## Compatibility findings (design §10, §12)

- `candidateKey(input+POS)` / `dedupeCandidates` / `coveredLemmas` are **unchanged** (B05–B16 history). The adapter feeds the legacy intake one representative per input+POS only to share Kiwi analysis, never passes `coveredLemmas`, and fans results back to every `C…` id, so same-lemma/POS usages stay separate and already-canonical lemmas reach review instead of `covered`.
- The current canonical writer only creates new `entry` records. `new_pos_on_existing_lemma` and `new_sense_on_existing_entry` are valid Stage 2 decisions, but **cannot be written today**; `partitionByWriterSupport` marks them `stage3-writer-required`. Stage 3 (#266) must supply the compatible writer behind the entrypoint tripwire and non-batch baseline.
- `source_candidate_id` (`C…`) is never stored in the canonical `candidate_id` field; where it is persisted in canonical output is deferred to #266.

## Stage 1 producer (issue #264, Impl 2/4)

Single serial Stage 1 entry point; it writes `data/candidates/C…/{manifest.json,candidates.jsonl}` with `status: created` and nothing else (no review rows, glosses, canonical records or paragraph text).

```bash
npm run reference:corpus:candidates -- --batch-id <run> --output-directory data/reference/<run> ...   # existing extractor, unchanged
npm run factory:stage1 -- --evidence data/reference/<run>/candidate-evidence.json --task-id T000001 [--max-candidates 500] [--dry-run]
```

| Part | Role |
| --- | --- |
| `scripts/factory/stage1.mjs` | Library: text-free evidence → usages → rows → manifest |
| `scripts/factory/produce-candidates.mjs` | CLI: corpus permission check, serial id allocation, atomic write, repository validation |

- **Input** is only the extractor's text-free `candidate-evidence.json` (`m9-corpus-candidate-evidence-v1`) under ignored `data/reference/`. Any field outside the extractor's safe hit fields (a context/paragraph text), a missing index digest, an extractor Kiwi/model version other than pinned `0.24.0`, or an unpinned live analyzer fails the run. The corpus permission record is checked first.
- **Lemma/POS** are re-derived by the pinned `kiwi_service.py` from each observed (inflected) surface form. The extractor's proposal is a hint: a mismatch or an extra content morpheme the chosen reading does not explain (`lemma_mismatch`/`pos_mismatch`; only the root the analyzer recorded for a derived verb/adjective (`derived_from` plus the root's position `derived_from_index`, added to `kiwi_service.py` proposals for XSV/XSA derivations; exactly that one occurrence), e.g. 망각 within 망각하다, is allowed; any other extra morpheme, including a repeated or prefix one such as 집+집 or 사+사랑하다, is held), a competing ranked reading or a multi-reading result (`analysis_ambiguous`), and missing/stale/unsupported/error outcomes become explicit per-row `holds`; nothing is silently guessed. Original surfaces stay in `observedForms`.
- **Identity**: one `C<batch>-<NNNN>` row per distinguishable usage, keyed by lemma + POS + evidence reference. Only an identical (lemma, POS, reference) repeats and merges; the same lemma/POS at another reference stays a separate row. Already-canonical lemmas, new POS and new senses are never dropped (`routes` in the run summary uses the factory identity adapter); the legacy `candidateKey`/`dedupeCandidates`/`coveredLemmas` path is not used. Holds are per row and never inherited by siblings.
- **Batch**: id is the next serial `C…` over local `data/candidates`, `data/reviews` and `--base-ref` (default `origin/master`; unresolved fails closed, `none` skips explicitly). Rows are sorted deterministically, so replaying the same evidence yields byte-identical output. A bound (default 500, hard max 1000) is applied to whole lemma groups; deferred lemmas are reported in the run summary for a later batch.
- **Proposal contract**: `kiwi_service.py` metadata declares `proposal_contract: derivation-root-v1` (the `derived_from*` semantics). It is separate from `service_version`, which stays `1`, so stored hand-offs and the legacy `analyzerDigest` remain valid. Stage 1 refuses an analyzer without it, and the manifest records `proposal_contract` and an `analyzer_digest` that binds it. The shared `validateCandidateBatch` (and so `ci:fast`) requires `proposal_contract`, `source_evidence_sha256` and an `analyzer_digest` equal to the pinned-run digest bound to the proposal contract; a manifest missing or predating them is rejected.
- **No regeneration**: the CLI reads every existing `data/candidates/*/candidates.jsonl` (local and on `--base-ref`) and skips usages (lemma + POS + primary evidence reference) already produced; when none are left it fails (`no unprocessed usages`). The shared validator rejects a usage repeated across batches. Deferred lemmas and later extractor runs therefore continue where earlier batches stopped.
- **Manifest** adds `analyzer_digest` and `source_evidence_sha256` to the #263 required fields, plus `source_snapshot` (`corpus:<input manifest digest>:<logical rows digest>`) and `canonical_snapshot_digest` (file names + byte digests of `data/canonical/*.jsonl`). The new batch is validated with the shared `validateCandidateBatch` and `validateFactoryRepository` before the run succeeds.
- This is not a pilot: it does not run a real corpus batch and does not claim #261.

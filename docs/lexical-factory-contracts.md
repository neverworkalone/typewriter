# Lexical factory shared contracts (issue #263, Impl 1/4)

Implements the shared foundation of [`lexical-production-factory.md`](lexical-production-factory.md).
It is a library plus a repository validator; it creates no batches, claims or agents.

| Module | Role |
| --- | --- |
| `scripts/factory/contract.mjs` | `data/candidates/C…` and `data/reviews/C…` manifests, `candidates.jsonl` rows, `C…-NNNN` ids, digests, decision-row coverage; the per-usage v1 contract (historical) and shared review contracts |
| `scripts/factory/lemma-contract.mjs` | Lemma-centered v2 candidate contract (issue #275): one candidate per citation-form lemma with nested forms, usage groups and observations |
| `scripts/factory/lemma-decisions.mjs` | Stage 2 decision rows for v2: one auditable disposition per usage group (`included`, `covered`, `search_coverage`, `rejected`, `deferred`) |
| `scripts/factory/search-form-support.mjs` | Search-form support index (shared surface-form projection) for the canonical comparison and `covered` proofs |
| `scripts/factory/transitions.mjs` | Both state machines and the linked Stage 2 / Stage 3 transitions on manifests of merged `master` vs. a merge result |
| `scripts/factory/identity-adapter.mjs` | Keeps one decision per `C…` id on top of the legacy `input+POS` intake; routes to `new_entry`, `new_pos_on_existing_lemma`, `new_sense_on_existing_entry` |
| `scripts/factory/handoff.mjs` | Typed decision rows and canonical-compatibility checks; writer-support partition |
| `scripts/factory/artifacts.mjs` | Content validation of a review's `semantic-decisions.json` and `intake-handoff.json`: existing contract ids, existing `verifyProductionHandoff`, one semantic decision per admitted candidate, reviewed lemma/hold-resolution bound to the candidate and hand-off entry |
| `scripts/factory/stage1.mjs`, `produce-candidates.mjs` | Stage 1 producer (see below) |
| `scripts/factory/validate.mjs` | Repository validator run by `ci:fast`. It always compares with the merge-base of `origin/master` (override `FACTORY_BASE_REF`; unresolved base fails closed, only `none` skips): candidate transitions are checked with or without a review, and deleted merged batches/reviews fail |

## Adjustments to the design's illustrative shapes

- Review manifest adds `history` (`[{attempt, rejected_pr}]`, one entry per rejected attempt). `rejected_pr` is valid only while `status` is `rejected` and equals the last history entry; rework (`rejected → ready`) advances `attempt` by one and may not alter history.
- Candidate manifest adds `analyzer_version` (pinned `kiwipiepy==X.Y.Z`). **v1 (historical):** candidate rows require `usage_hint`; evidence is text-free (`kind`, `ref`) and capped at five. v2 rows use the lemma-centered shape below.
- `status`, `rejected_pr`, `attempt`, `history` are the only mutable manifest fields and are excluded from `manifestContentDigest`; `candidates.jsonl` and review artifacts are covered by separate byte digests, so a status-only change never changes them.
- The owner-directed `held` candidate status is **rejected** for now: there is no verifiable owner-authorization field, so an unauthorized hold cannot be told from an authorized one. Add it together with a checkable authorization contract.
- `semantic-decisions.json` applies the existing source-bound row contract to every admitted candidate against the record derived from the reviewed decision: `candidate_record_sha256`, `validateAuthoredSemanticReviewBinding`, `validateAuthoredDecisionDisposition`, `validateDistinctSenseSemanticRationales`, and the shared per-sense `validateSenseReviews` (extracted unchanged from the historical row validator: boundary decision vs. gloss writer-domains, topic-analysis `review_basis`, relation evidence), plus decision/gloss coherence, honest `human_reviewed: false` provenance and a complete review covering every candidate. Only the whole-source selection capacity/rank/axis checks of `validateAuthoredSemanticDecisionSource` are not applied; they have no factory meaning.
- Candidate transitions: `created → complete` only together with a new `ready` review in the same change; `rejected → ready` (rework) and Stage 3's `ready → complete|rejected` leave the candidate manifest unchanged.

## Compatibility findings (design §10, §12)

- `candidateKey(input+POS)` / `dedupeCandidates` / `coveredLemmas` are **unchanged** (B05–B16 history). The adapter feeds the legacy intake one representative per input+POS only to share Kiwi analysis, never passes `coveredLemmas`, and fans results back to every `C…` id, so same-lemma/POS usages stay separate and already-canonical lemmas reach review instead of `covered`.
- The current canonical writer only creates new `entry` records. `new_pos_on_existing_lemma` and `new_sense_on_existing_entry` are valid Stage 2 decisions, but **cannot be written today**; `partitionByWriterSupport` marks them `stage3-writer-required`. Stage 3 (#266) must supply the compatible writer behind the entrypoint tripwire and non-batch baseline.
- `source_candidate_id` (`C…`) is never stored in the canonical `candidate_id` field; where it is persisted in canonical output is deferred to #266.

## Lemma-centered contract (issue #275) — active for new batches

The unit of a Stage 1 candidate is a **normalized citation-form lemma (표제어)**, not a usage row. See
[`lexical-production-factory.md`](lexical-production-factory.md) §2 and §2.3 for the normative
policy, the before/after data shape and the operator note: **"500" counts unique lemmas, not usages.**

- **Versioning.** New batches use `lexical-factory-candidate-manifest-v2`; `validateCandidateBatch`
  dispatches on the manifest `contract`. v1 data, IDs and digests (including the PR #270 / `C000001`
  500-usage comparison cohort of #274) validate unchanged. A merged batch may not change contract
  (`validateCandidateTransition`: *contract migration is not authorized*); nothing is migrated.
- **Row.** `candidate_id`, `input` (lemma), `pos_hypotheses`, `forms` (`form_id`, `surface`),
  `usage_groups` (`group_id`, `pos`, `basis: pos-default|corpus-hint`, `hint`), `observations`
  (`observation_id`, `form_id`, `group_id`, `pos`, text-free `evidence`, `analysis`
  `{status: ok, input_digest}` bound to the analyzed surface, per-observation `holds`),
  `observation_total` and `observation_digest`. Sub-identities are `C…-NNNN.fNN|gNN|oNN`.
- **Raw-text boundary.** Tracked v2 JSON may carry only single bounded word forms (`forms[].surface`, `unresolved_observations[].surface`: letters/digits/`-`/`·`, 1–24 characters, no whitespace or control characters) and opaque source references (no whitespace/control characters, ≤200). The producer fails closed on anything else and the shared validator rejects it, so a phrase, sentence or paragraph can never reach Git through the manifest or rows.
- **Holds** belong to the observation that earned them; a sibling form or the lemma is never
  held by them. Observations whose analysis yields no reliable lemma/POS (`analysis_missing|stale|error|
  unsupported`) are listed in the manifest `unresolved_observations` and are not headwords.
- **Evidence bound.** At most 64 observations per lemma, chosen deterministically so every form and
  usage group stays represented; the remainder is bound by `observation_total`/`observation_digest`
  to the locally recoverable text-free evidence. A lemma that needs more than 64 to stay covered
  fails the run instead of dropping a form or sense opportunity.
- **Canonical comparison** (`classifyLemmaCandidate`): per POS hypothesis `new_entry`,
  `new_pos_on_existing_lemma` or `new_sense_on_existing_entry` (a *possible* new sense, never
  `covered`), plus the lemma's `unsupported_forms` for the search/morphology coverage route. Stage 1
  asserts no semantic identity; `covered` exists only as a validated Stage 2 group disposition.
- **Batches.** The bound counts distinct lemmas; a lemma already present in any earlier batch (v1
  or v2) is not produced again and a later batch repeating one fails the shared validator.
  `data/candidates/C…/` may hold exactly `manifest.json` and `candidates.jsonl` (also enforced for v1),
  and `data/candidates/` only batch directories.
- **Stage 2.** A v2 decision row keeps one row per `C…` id and adds `group_decisions` (entries per
  usage group; a group may be split by `observation_ids` into independently judged sense opportunities, see design §5.1). The real extractor emits no `usage_group`, so this split is how Stage 2 separates senses. `validateLemmaDecision` binds `included` groups to reviewed senses of
  the same POS, per-group `hold_resolution`s, and the canonical proofs of `covered`/`search_coverage`
  (checked while the review is `ready`). The shared intake and hand-off receive per-observation views
  (`candidateViews`), so a hand-off entry per lemma+POS still exists and holds stay isolated.
- **Compatibility statement.** #265/#266 (Stage 2 loop and Stage 3 admission) consume
  `source_candidate_id`/`C…` identities, the typed decision rows and the hand-off unchanged; the only
  additions are the v2 candidate shape and `group_decisions`, validated in the shared validator rather
  than a batch-only path. #272–#274 (analyzer series) are independent: the candidate record carries no
  provider-specific result, only normalized per-observation outcomes; the C000001 benchmark cohort is
  untouched. The #258/#261 execution assumptions (a Stage 1 batch of 500 usage rows) are superseded by 500
  distinct lemmas; their tests are not claimed to have run here. Stage 3 canonical admission of lemma
  candidates still needs the writer for `new_pos_on_existing_lemma`/`new_sense_on_existing_entry`
  (#266, unchanged).

## Stage 1 producer (issue #264, Impl 2/4)

> Since issue #275 the producer below emits **lemma-centered v2** batches. The per-usage rules in this
> section (identity per usage, row-per-reference, `usage_hint`, five evidence references, usage-key
> dedupe across batches) describe the **historical v1** producer that created the `C000001`
> comparison cohort; they are no longer active for new batches.

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
- **Batch**: id is the next serial `C…` over local `data/candidates`, `data/reviews` and `--base-ref` (default `origin/master`; unresolved fails closed, `none` skips explicitly). Rows are sorted deterministically by lemma, so replaying the same evidence yields byte-identical output. The bound (`--max-candidates`, default 500, hard max 1000) counts **distinct lemmas**; deferred lemmas are reported in the run summary for a later batch.
- **Proposal contract**: `kiwi_service.py` metadata declares `proposal_contract: derivation-root-v1` (the `derived_from*` semantics). It is separate from `service_version`, which stays `1`, so stored hand-offs and the legacy `analyzerDigest` remain valid. Stage 1 refuses an analyzer without it, and the manifest records `proposal_contract` and an `analyzer_digest` that binds it. The shared `validateCandidateBatch` (and so `ci:fast`) requires `proposal_contract`, `source_evidence_sha256` and an `analyzer_digest` equal to the pinned-run digest bound to the proposal contract; a manifest missing or predating them is rejected.
- **No regeneration**: the CLI reads every existing `data/candidates/*/candidates.jsonl` (local and on `--base-ref`) and skips lemmas already produced; when none are left it fails (`no unprocessed lemmas`). The shared validator rejects a lemma repeated across v2 batches (and a v2 lemma already in a v1 batch). Deferred lemmas and later extractor runs therefore continue where earlier batches stopped.
- **Manifest** adds `analyzer_digest` and `source_evidence_sha256` to the #263 required fields, plus `source_snapshot` (`corpus:<input manifest digest>:<logical rows digest>`) and `canonical_snapshot_digest` (file names + byte digests of `data/canonical/*.jsonl`). The new batch is validated with the shared `validateCandidateBatch` and `validateFactoryRepository` before the run succeeds.
- This is not a pilot: it does not run a real corpus batch and does not claim #261.

## Analyzer providers (issue #272, Analyzer 1/3)

Stage 1 no longer hard-wires Kiwi. `scripts/factory/analyzer-providers.mjs` defines the Provider boundary; `resolveWithProviders` in `stage1.mjs` is the common resolution policy (`provider-resolution-v1`). **The default order is exactly `[kiwi]` (pinned `kiwipiepy==0.24.0`, `derivation-root-v1`) and its manifest, rows, holds and digests are unchanged.**

- **Provider object**: `{ id, identity: {provider_id, implementation, version, model, config}, capabilities: {n_best, derivation}, analyze(requests), assertMetadata(metadata) }`. `analyze` returns `{metadata, results}` in the `kiwi_service` shape. Each result is normalized (`analyzer-provider-result-v1`: provider, request id, input digest, outcome `success|error|unsupported|ambiguous|stale|missing`, analyses, capabilities, sidecar diagnostics). Malformed analyses (non-string lemma, POS outside `POS_VALUES`), a wrong input digest or a missing result are explicit `analysis_error`/`analysis_stale`/`analysis_missing` outcomes, never a certain result. Provider-specific diagnostics stay in the sidecar; no provider's confidence is assumed comparable.
- **Resolution policy**: a reading is `resolved`, `needs_verification` or `unresolved`. A provider declaring `n_best: false` reports one best path only, so even a clean reading is `needs_verification` (hold `analysis_ambiguous`); it is settled only by a later N-best provider agreeing on lemma/POS (a disagreement keeps `analysis_mismatch`). Order controls cost, not authority.
- **Fallback**: the next provider is asked only about the surfaces still unresolved, and only when every hold is one of `analysis_missing|unsupported|error|stale|ambiguous`. `lemma_mismatch`, `pos_mismatch` and all upstream holds (`no_evidence`, `coverage_collision`, extractor `analysis_ambiguous`, …) are never reopened or cleared by a provider. A row still unresolved keeps the union of every attempt's holds. A provider process that fails, or metadata that does not match the provider's pinned identity or the `derivation-root-v1` contract, fails the whole run closed.
- **Manifest**: for a non-default order the manifest adds `analyzer_providers` (ordered `{provider_id, identity_digest}`) and `resolution_policy`, and `analyzer_digest` additionally binds both, so a different provider, model/version, order or policy cannot share a Kiwi-only digest. The shared `validateCandidateBatch` enforces this. In this issue the pinned Kiwi must appear in every order (it anchors `analyzer_version`); a Kiwi-less order is for the successor issue.
- **Configure**: `npm run factory:stage1 -- --providers kiwi[,other] …` (default `kiwi`; unknown, repeated or uninstalled providers fail closed). `--attempt-log data/reference/<file>` writes the text-free per-surface attempt log (input digest, provider, outcome, state, holds, fallback eligibility) outside Git-tracked data. All analysis is local; no provider may send candidates or corpus text to a network.
- **Add a provider**: pin its implementation/model/version in `identity`, declare honest capabilities, implement `analyze`/`assertMetadata` (emit `proposal_contract: derivation-root-v1` metadata; omit `derived_from*` unless it can report derivations), add one `PROVIDER_REGISTRY` entry in `produce-candidates.mjs`, and add synthetic-fixture regressions in `tests/factory-analyzer-providers.test.mjs`. No other Stage 1 code changes. The fixed-cohort benchmark is #274.

## Khaiii provider (issue #273, Analyzer 2/3)

Optional second Provider `khaiii` (official Kakao Khaiii v0.4, Apache-2.0), selected only by `--providers kiwi,khaiii`; `kiwi` stays the default and Khaiii is never constructed, installed or run otherwise. Kiwi must still be in every order.

- **Runtimes** (`TYPEWRITER_KHAIII_RUNTIME=native|docker`, one shared `khaiii_service.py` normalization and one Provider interface): **`native`** consumes the verified `genonfire/khaiii` GitHub Release `v0.4` (`khaiii-0.4-macos-arm64.tar.gz`, SHA-256 `d3f9e578…08e6`, fork commit `33f78692…`, upstream `fa5fbd1…`); it is the default on every host and is installed by the explicit `node scripts/factory/fetch-khaiii-native.mjs` (downloads into `~/.cache/typewriter/khaiii`, never Git; verifies the archive SHA-256 and the archive's `MANIFEST.sha256`). **`docker`** is an explicit fallback only (a host without the native release must set `TYPEWRITER_KHAIII_RUNTIME=docker`; it is never chosen implicitly): `docker/khaiii/Dockerfile` builds the unmodified upstream `v0.4` in `ubuntu:20.04` ([`docker/khaiii/README.md`](../docker/khaiii/README.md)). A failing runtime is reported; it **never silently falls back** to the other. Both are offline at analysis time (container `--network none`; host process reads local files only).
- **Metadata**: the service reports runtime, Khaiii version, upstream tag/revision, the compiled resource-bundle digest (identical on both runtimes), and for `native` the library digest, release fork commit and release provenance digest; `assertPinnedKhaiii(metadata, runtime)` rejects any drift or a result from the other runtime (the run fails closed). The provider identity binds the runtime and the binary identity (native: archive/library/provenance/fork commit; docker: toolchain/isolation), so switching runtime or binary changes the manifest `analyzer_digest`.
- **Capabilities**: `n_best: false, derivation: false`. Khaiii returns one path and no score; nothing is invented. By the common policy its clean reading is `needs_verification` (hold `analysis_ambiguous`) and is settled only by a later N-best provider agreeing; it never clears a hold alone.
- **Normalization**: `NNG→noun`, `VV→verb`, `VA→adjective`, `MAG→adverb`; verbs/adjectives get `다`. A noun/root directly followed by `XSV/XSA` becomes the one derived predicate (망각하다), with no `derived_from*` link. Any other content morpheme (`NNP`, `NNB`, `XSN`, …), non-Hangul morphemes, multi-word or empty input are `unsupported`; an extra unrelated morpheme in the same path keeps the shared `lemma_mismatch` hold.
- **Evidence**: normal CI runs only `tests/factory-khaiii-provider.test.mjs` (synthetic contract tests and the real **native** smoke, skipped with the reason where the release is absent); it never probes, builds or runs Docker, and a regression asserts that. The Docker smoke, the native-vs-docker equality check and the missing-runtime check live in the **manual** `tests/manual/khaiii-docker.test.mjs` (`npm run test:khaiii:docker`), registered in no CI category; it is skipped with a reason when the image is absent. synthetic tests are labeled and are never proof that the official binary ran. Accuracy relative to Kiwi is not assumed (benchmark: #274).

## MeCab-ko provider (issue #281, optional third Provider)

Optional Provider `mecab`, selected only by `--providers kiwi,mecab`, `kiwi,khaiii,mecab`, `kiwi,mecab,khaiii`; `kiwi` stays the default and MeCab is never constructed, installed or run otherwise (the common #272 conditional fallback: eligible unresolved surfaces only). Khaiii's native/docker runtimes are untouched.

- **Pinned runtime** (macOS arm64, CPython 3.11): PyPI `mecab-ko` **1.0.2** wheel `mecab_ko-1.0.2-cp311-cp311-macosx_11_0_arm64.whl` (sha256 `fbe31456…0be09`; wrapper `pymecab-ko`, BSD; bundles MeCab `0.996/ko-0.9.2` as `libmecab.2.dylib`, sha256 `4e993d7f…b535`) and `mecab-ko-dic` **1.0.0** sdist (sha256 `3ba22858…1f11`; a Luminoso repackaging, Apache-2.0 dictionary notice in its `COPYING`). Loaded dictionary digest (sorted file digests of `dicdir`, incl. `sys.dic` with 811,795 entries, no user dictionary) `d65a8a68…f5da`. **The package's `version` file is empty, so the dictionary release (e.g. `2.1.1-20180720`) is not declared and is not claimed**; the content digest is the identity. Licenses are independent: the wrapper wheel declares BSD and ships MeCab's `COPYING` (GPL, LGPL or BSD, at the user's choice), the dictionary package declares Apache-2.0; the unrelated Rust rewrite shares none of this.
- **Install / run**: `node scripts/factory/setup-mecab.mjs` creates `~/.cache/typewriter/mecab/venv` (never Git) from the hash-pinned [`mecab-requirements.txt`](../scripts/factory/mecab-requirements.txt) (`pip --require-hashes`; `TYPEWRITER_MECAB_BASE_PYTHON` must be 3.11, default `python3.11`; `TYPEWRITER_MECAB_PYTHON` points the provider at another venv). Analysis is offline.
- **Metadata**: the service reports the actually loaded runtime and dictionary (wrapper/library digests, dictionary package/digest, the `sys.dic` file MeCab opened, charset, entry count, user dictionary); `assertPinnedMecab` rejects any drift and the run fails closed. A missing venv, missing/corrupt dictionary, unsupported host or malformed output is an explicit error, never a fallback.
- **Capabilities**: `n_best: false, derivation: false`. MeCab exposes `parseNBest`, but on the real dictionary `parse` and `parseNBest(1)` choose different equal-cost paths for the same input (걸어: 걷다 vs 걸다), so N-best is not a dependable signal and only `parse` is used. By the common policy its clean reading is `needs_verification`; agreement among engines is review evidence, not independent ground truth.
- **Normalization** (from the dictionary's own columns): `NNG→noun`, `MAG→adverb`, `VV/VA` stems get `다` only when an ending follows; `Inflect`/`Preanalysis` tokens are expanded through the expression column, so irregular stems come from the lexicon (걸어→걷다, 도와→돕다, 아름다운→아름답다). `NNG/XR` + `XSV/XSA` is one derived predicate (망각했다→망각하다, 행복한→행복하다) with no `derived_from*`. `NNP/NNB/VX/XSN/SL/UNKNOWN`, non-Hangul forms, bare stems, unexpandable composite tags, multi-word and empty input are `unsupported`; extra content morphemes in one path keep the shared `lemma_mismatch` hold.
- **Evidence**: normal CI runs `tests/factory-mecab-provider.test.mjs` (synthetic contract tests and the REAL smoke, which is skipped with the reason where the pinned venv is absent). Real-runtime accuracy relative to Kiwi/Khaiii is not assumed; the fixed-cohort benchmark is #274.

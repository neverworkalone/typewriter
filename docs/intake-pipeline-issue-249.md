# Source-agnostic lexical intake (issue #249)

Scope of this PR: **A** (boundaries + contract + CorpusAdapter + synthetic
adapter) and the reusable local Kiwi batch API from **B**. Replacing the
handwritten citation-form checks (B3) and the real-input comparison pilot (C)
are **deferred**: they need representative valid/invalid coverage and measured
comparison against the current pipeline, which this PR does not claim.

## Layout (`scripts/intake/`)

| File | Role |
| --- | --- |
| `candidate-contract.mjs` | Versioned (v1) candidate contract: normalize, identity key (`input` + POS), dedupe, explicit HOLD reasons. |
| `kiwi_service.py` / `kiwi-client.mjs` | One bounded local batch API (≤500/batch, one Python process per batch). Statuses `ok`/`ambiguous`/`unsupported`/`error`; run metadata pins service, kiwipiepy and model versions. |
| `pipeline.mjs` | Shared stages: contract → dedupe → coverage → Kiwi → QA hand-off or HOLD. Imports no adapter (enforced by test). |
| `adapters/corpus-adapter.mjs` | Maps #201 pilot output to the contract; corpus counts/ids stay out of it. |
| `adapters/synthetic-adapter.mjs` | Word-only second adapter proving the pipeline runs with the corpus absent. |

## Rules encoded

- Adapters propose; they never approve lemmas, senses, POS, glosses or admission.
- Kiwi is a proposal: the whole input must be explained by exactly one lemma
  (a substring match is a `lemma_mismatch` HOLD); multiple analyses are
  `analysis_ambiguous`; failures are explicit holds, not fallbacks.
- A hand-off (`semantic_qa`) carries an `analysisBinding` over input/lemma/POS and
  the analyzer digest; `verifyAnalysisBinding` fails on stale or mismatched data.
- Source is not a canonical word attribute; only bounded evidence references
  (≤5) cross the boundary. Removing the corpus adapter leaves the pipeline usable.

## Not yet done

Existing producer/assembler/builder/validator checks are untouched and keep
their own form rules; B05–B10 history and canonical/SQLite schema are unchanged.
Kiwi was not installed in the development environment, so the Python service is
tested with a synthetic analyzer; a real-Kiwi run belongs to the pilot (C).

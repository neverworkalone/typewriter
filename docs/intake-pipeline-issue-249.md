# Source-agnostic lexical intake (issue #249)

Delivers A (contract, `CorpusAdapter`, synthetic adapter), B (one local Kiwi
batch API; shared frame route; real-Kiwi fixes) and C (local pilot and
comparison). Everything below was measured with pinned `kiwipiepy==0.24.0`; the service and pipeline fail on any other version.

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

## Frame validity: one shared rule, Kiwi as corroboration (B)

`frameUsesLemma` (`scripts/batch/semantic-self-check.mjs`) is already the single
rule used by the review workflow and the corpus batch builder. Comparing it with
Kiwi on `tests/fixtures/intake-frame-cases.json` (40 labelled valid/invalid
irregular, honorific, homograph and misconjugated frames) and 2,578 real
verb/adjective frames mined from reviewed batch decisions
(`node scripts/intake/compare-frame-routes.mjs`, local Kiwi required):

| Route | valid kept | invalid accepted | valid rejected |
| --- | --- | --- | --- |
| handwritten form rule (after this PR) | 34/34 | 0/6 | 0 |
| Kiwi best-analysis | 33/34 (+1 ambiguous: 사세요 살다/사다) | 2/6 (듣어서, 가볍었다) | 0 |

Kiwi normalizes misconjugations, so it **cannot be the accept gate** (it would
admit invalid frames); it is therefore not a replacement. The comparison also
found genuine false rejects in the handwritten rule (러-irregular 푸르렀다,
ㄹ-drop adnominal 낯선, contracted + auxiliary 견뎌냈다/따뜻해졌다); these are fixed in
the shared rule with regressions. On the mined frames the corrected rule has no
frame that Kiwi accepts and the rule rejects (5 before the fix). In the other
direction Kiwi disagrees with 677/2,578 rule-accepted frames (mostly quoted
citation forms parsed as proper nouns, and ambiguous homographs).
`frameDisposition` (`frame-analysis.mjs`) encodes the result: rule rejects →
`rejected`; rule accepts + Kiwi `uses` → `confirmed`; otherwise `manual_check`.
Frame verdicts are bound to frame text, lemma, POS and analyzer digest.

## Pilot (C)

`node scripts/intake/run-intake-pilot.mjs` (output in ignored
`data/reference/pilots/issue-249/`). The corpus path took the #201 pilot's 100
candidates: 48 already covered by canonical, 10 → `semantic_qa`, 40 held for
ambiguity (39 of them the pilot's own context-level hold, preserved by the
adapter rather than overridden by citation-form analysis), 1 unsupported,
1 lemma mismatch; ~1.3 s for the Kiwi step in a single batch. The corpus-disabled
synthetic path (22 inputs: irregulars, derived predicates, homographs, unknown
and too-short words) reached the same decisions with no corpus code loaded:
13 `semantic_qa`, the rest held fail-closed (`invalid_input` for one-syllable and
non-Hangul input, `lemma_mismatch` for multi-morpheme strings and
non-words, `pos_mismatch` for a wrong submitted POS, `analysis_ambiguous`).

The pilot hands records off at `semantic_qa`. `tests/intake-end-to-end.test.mjs`
carries hand-offs through the shared `validateLexicalAddition` gate (binding
verified; production state and semantic-audit coverage built with the existing
test helpers; a QA artifact that does not match the records is rejected with
`SEMANTIC_AUDIT_SOURCE_MISMATCH`; only hand-offs with a separately authored
fixture gloss are admitted, holds never are) → real
`buildDictionary` → SQLite direct search (`푸른` → `푸르다`), once from the
`CorpusAdapter` and once from the synthetic adapter alone, whose module has no
corpus reference. The fixture glosses stand in for the source-bound QA step;
authoring new canonical words is outside this issue. Adapter holds keep their
original cause (`analysis_ambiguous` vs `coverage_collision`). The fixture QA is
bound to the hand-off key, lemma/POS, evidence references and analysis binding
(`QA_HANDOFF_BINDING_MISMATCH` on any change, checked before the SQLite build);
a word-only hand-off has empty evidence and is admitted only with QA bound to
that empty evidence. Peak memory and review/rework
cost were not measured; no quality-win claim is made beyond the table above.

B05–B10 history and canonical/SQLite/search schema are unchanged.

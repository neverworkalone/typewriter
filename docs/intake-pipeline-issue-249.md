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

Whenever an analysis is requested, the run metadata is mandatory and must match
the pinned service/model/version/`top_n` (`null`, `{}`, a missing field or an
unsupported value rejects the run, and `verifyAnalysisBinding` rejects the same
metadata). Merging duplicate candidates is input-order independent: evidence is
deduplicated, totally ordered and capped at five after the merge, and a merged
candidate lists every contributing `adapterIds` instead of the first source.

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
(`QA_HANDOFF_BINDING_MISMATCH` on any change, including the QA gloss, checked before the SQLite build);
a word-only hand-off has empty evidence and is admitted only with QA bound to
that empty evidence. Peak memory and review/rework
cost were not measured; no quality-win claim is made beyond the table above.

B05–B10 history and canonical/SQLite/search schema are unchanged.

## Production hand-off (issue #251, PR A)

The real batch route is `scripts/batch/build-issue-223-corpus-batch.mjs`
(`buildIssue223CorpusBatch`: candidate inventory/evidence + authored decisions +
self-check review input → candidate review, semantic decisions, canonical
import). Before this change it never touched `scripts/intake/`; the test helper
`tests/helpers/intake-admission.mjs` was not production QA.

`scripts/intake/production-handoff.mjs` is the source-neutral production
hand-off: `CorpusAdapter` (or any adapter) → `runIntake` (normalize, dedupe,
coverage, bounded pinned Kiwi) → one text-free `*-intake-handoff.json` per batch
(input digest, analyzer metadata/digest, per-candidate decision, holds,
`adapter_ids`, bounded evidence references, `analysis_binding`).

- `node scripts/intake/production-handoff-cli.mjs build --batch-id=… --analysis-directory=… --out=…`
  runs real local Kiwi (`TYPEWRITER_PYTHON` → the pinned kiwipiepy 0.24.0 env).
- The agent authors the review input as before, then
  `… bind --handoff=… --review-input=… --analysis-directory=… --authored-decisions=…`
  writes the `intake_handoff` block (per-admission bindings over hand-off entry,
  final POS and gloss digest; `resolutions` stay agent-authored).
- `build-issue-223-corpus-batch.mjs --intake-handoff=…` revalidates, before any
  write: contract/batch, pinned analyzer, input digest recomputed from the
  current inventory/evidence (changed input, lemma, POS, removed/reordered
  evidence, dropped adapter all fail), per-entry analysis bindings, and that
  every admitted candidate is bound to its entry/POS/gloss. Nothing is
  auto-admitted: `semantic_qa` still needs the source-bound self-check;
  reviewable holds (`analysis_ambiguous`, `lemma_mismatch`, `pos_mismatch`,
  `analysis_unsupported`, `frame_not_verified`) can be admitted only with an
  explicit resolution citing checked contexts; hard holds (`coverage_collision`,
  invalid input, missing/stale/errored analysis) and `covered` never. The shared
  `validateLexicalAddition`, `frameUsesLemma` and semantic-audit gates still run
  afterwards unchanged; Kiwi stays corroborative.
- Without `--intake-handoff` the prior workflow runs unchanged (rollback). A
  review input carrying `intake_handoff` without the flag is rejected.
- `validate-issue-223.mjs` re-verifies a tracked hand-off offline (no corpus or
  Kiwi); historical batches carry none and are untouched.

Dry run (no canonical modification): B15's analysis directory through real Kiwi
gave 500 candidates → 397 covered (already canonical), 78 `semantic_qa`, 13
`lemma_mismatch`, 12 `analysis_ambiguous`.

Each hand-off entry also stores the bounded, text-free Kiwi outcome
(`analysis_outcome`: status, input digest, ranked lemma/POS analyses). The
builder boundary recomputes every analyzer-originated decision from it
(`judgeOutcome`), so an analysis hold cannot be relabelled `semantic_qa` and
adapter holds are preserved in every branch. The recorded outcome is authenticated at the write boundary:
`buildIssue223CorpusBatch --intake-handoff` re-runs the pinned local analyzer on
the current candidates (`assertHandoffMatchesFreshAnalysis`) and requires the
whole hand-off (entries, outcomes, analyzer metadata) to equal the fresh result,
so a rewritten outcome, relabelled decision or recomputed binding is rejected
(`INTAKE_HANDOFF_FRESH_ANALYSIS`). This needs the local kiwipiepy 0.24.0 env at
build time; the offline tracked validator (`verifyTrackedHandoff`) checks
consistency only and cannot re-authenticate the analysis.

### Real-route smoke (not CI)

```bash
TYPEWRITER_PYTHON=data/reference/venv-kiwi024/bin/python \
node scripts/intake/smoke-production-route.mjs \
  --batch-id=issue-223-m9-e-corpus-batch-15-20261003 \
  --analysis-directory=data/reference/production/issue-247/corpus-batch-15
```

Needs kiwipiepy 0.24.0 and the ignored local analysis directory. It copies the
repository to a temp directory in its pre-B15 state (the working tree is never
written), builds the hand-off with real Kiwi, binds the tracked self-check, and
runs the real `build-issue-223-corpus-batch.mjs --intake-handoff`. Result for
B15: 500 candidates → 455 `semantic_qa`, 32 `lemma_mismatch`, 13
`analysis_ambiguous`; the builder imported 397 records, and the candidate review,
canonical import and semantic-decision rows are byte/row-identical to the tracked
B15 artifacts (the review input differs only by the `intake_handoff` block).
Without resolutions the builder correctly refused B15's admitted candidates that
Kiwi flagged (e.g. `양주`: `INTAKE_HANDOFF_HOLD_UNRESOLVED`); for this equivalence
smoke the tracked self-check's checked-context citations stand in as the explicit
resolutions. The smoke also checks, per adapter, that a tampered binding is
rejected by the real builder before any batch file is written, and that the
temp copy then passes `validate-issue-223.mjs` (which includes
`verifyTrackedHandoff`).

The hand-off names its `source_adapter`; the builder boundary reads the batch
inputs through that adapter (`BATCH_SOURCE_ADAPTERS`). The same smoke repeats
the whole route with `--source-adapter=synthetic-word-list`: the contract then
carries each candidate's word, POS and the holds recorded in the batch inventory
(those are facts about the candidate, so naming another adapter can never drop
them; `batchCandidatesFor` fails with `INTAKE_HANDOFF_HOLD_DROPPED` otherwise),
but no corpus evidence. For the same 500 inputs both adapters now give the same
decisions: 455 `semantic_qa`, 32 `lemma_mismatch`, 13 `analysis_ambiguous`; the
real builder imported the same 397 records, with candidate review and canonical
import identical to the tracked B15 artifacts and the tracked validator passing.
Scope note: the builder's
review rows and the reviewer's cited contexts still come from the batch's
inventory/evidence files; "synthetic" here means the intake contract does not
depend on the corpus. Feeding the builder from a source with no inventory at all
is a #251 non-goal.

### Source-hold facts and Kiwi output stability (issue #251)

- When a hand-off is used the builder records each candidate's source holds in
  its candidate-review row (`intake_source_holds`, from the CorpusAdapter rule
  including fail-closed `decision_state: held`). The row is digest-bound into the
  semantic source, so `verifyTrackedHandoff` checks source holds against the
  tracked row, not the editable hand-off; a row without the field cannot vouch
  for a hand-off (`INTAKE_HANDOFF_HOLD_ORIGIN`). The real-route smoke compares
  the review with the tracked B15 one ignoring only this field and its digest.
- kiwipiepy 0.24.0 occasionally returned a corrupted token form for a sound
  input (seen once in ~10 smoke runs: `빚어지` came back as replacement bytes), which
  surfaced as an intermittent `INTAKE_HANDOFF_FRESH_ANALYSIS`. `kiwi_service.py`
  now accepts an analysis only when two runs agree and contain no U+FFFD; otherwise
  the outcome is `error` / `unstable_output` (an explicit hold, never a guess).
  Regressions: `scripts/intake/test_kiwi_service.py`. After the change 8
  consecutive smoke runs passed and the hand-off for B15 is byte-identical to the
  earlier deterministic build. The mismatch error now names the first differing
  path.

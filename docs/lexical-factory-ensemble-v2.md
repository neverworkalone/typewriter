# Ensemble Resolver v2 and contextual fallback (issue #285)

Stage 1 policy `provider-resolution-v2-ensemble` runs **all three pinned analyzers — Kiwi, Khaiii and
MeCab-ko — on every eligible observation**, adjudicates each observation explicitly, and sends only
morphologically **unassignable** observations to the M9-style local source-context review. It adds no
fourth Provider, changes no canonical data and does not weaken Stage 2 editorial review or Stage 3
admission. Implementation: `scripts/factory/ensemble-resolver.mjs`, `context-fallback.mjs`,
`corpus-context-source.mjs`, and the shared validators in `lemma-contract.mjs` / `contract.mjs`.

## What the ensemble does and does not establish

Stage 1 analyzes the **observed eojeol (surface)**, not the surrounding sentence. Three analyzers
agreeing is evidence of **morphological agreement only**: it cannot determine contextual homograph or
sense, three correlated analyzers are not independent, and the categories below are **signal strength,
not verified correctness and not a calibrated probability**. Nothing here is automatic semantic or
canonical admission.

## Policy selection (no accidental Kiwi-only production)

| `--policy` | Providers | Use |
| --- | --- | --- |
| `provider-resolution-v2-ensemble` (alias `ensemble`) — **CLI default** | exactly `kiwi,khaiii,mecab`, fixed order | new v2 batches |
| `provider-resolution-v1` (alias `v1`) | default `[kiwi]` or an explicit conditional order | explicit compatibility / A-B baseline; historical outputs and digests unchanged |

The library `produceCandidateBatch` defaults to v1 (so historical replays are byte-identical); the
production CLI defaults to the ensemble. The run summary prints `effectivePolicy` and `providerOrder`.
Under the ensemble, `--providers` must be exactly the three in order; fewer, more or reordered providers
are refused — a run **never silently degrades** to two or one providers.

Every provider receives the **same sorted, deduplicated surface set** of the complete run, regardless of
whether another provider already looked resolved. Deduplication is per provider only; each result is mapped
back to every original observation (evidence id and usage group preserved). A missing/stale/crashing
provider, wrong pinned identity/metadata, wrong `proposal_contract`, duplicate or missing or unrequested
result ids, a result for a stale digest, malformed analyses, an unknown `status`, or a self-contradicting
response (`ok` without analyses, a refusal carrying analyses) **fail the whole production run closed**; only a
well-formed explicit `unsupported`/`error`/`ambiguous` is data (hold/queue). v1 normalization is unchanged.
There is no fake fallback success.

## Per-observation categories

Compared are normalized surface-level analysis paths: lemma + POS, alignment of the chosen reading to the
target form (the extractor hint), derivation (`derived_from_index`), the ranked Kiwi N-best alternatives
and segmentation compatibility.

| Category | Meaning | Outcome |
| --- | --- | --- |
| `concordant` | the three top readings agree, the path explains the whole surface, and no *material* Kiwi alternative competes | assigned to its lemma; no analysis hold |
| `supported_alternative` | a non-top Kiwi N-best reading is also proposed by Khaiii and/or MeCab; the rival is recorded | assigned to the better supported reading; keeps a reviewable `analysis_ambiguous` hold |
| `conflicted` | meaningful lemma/POS/segmentation disagreement (one-vs-two, Kiwi isolated, all three differ, extra morpheme, no single target, an unsupported material Kiwi rival, a provider-reported ambiguity) | **not a headword**; unresolved queue |
| `unsupported_or_unknown` | a provider has no usable output (unsupported/error) | **not a headword**; unresolved queue |

Reason codes are a closed, stable vocabulary (`ENSEMBLE_REASONS`), e.g. `three_way_agreement`,
`kiwi_alternative_supported`, `one_vs_two_disagreement`, `kiwi_isolated_pair`, `all_three_differ`,
`kiwi_unsupported_rival`, `segmentation_incompatible`, `no_single_target_morpheme`,
`extractor_hint_mismatch`, `<provider>_unusable`, `<provider>_reported_ambiguous`. A lower-ranked Kiwi
path that merely re-segments the same stem (짠 + 하다, bare 짠 for 짠하다) is not a rival; another complete
lemma (가/noun beside 가다) is.

All competing hypotheses (`{lemma, pos, supporters}` with supporters `kiwi_top|kiwi_alt|khaiii|mecab`) are
kept: `alternatives` on an assigned observation, `hypotheses` on a queue entry. Extractor/source holds
(`analysis_ambiguous`, `coverage_collision`, `no_evidence`, …) are carried unchanged and are never cleared by
2-of-3 or 3-of-3 agreement. A clear sibling form does not inherit an ambiguous sibling's state, and a clear
sibling does not hide the ambiguous form: it is kept (assigned with a hold, or in the queue).

### Review priority

Each row carries `review: {priority, categories, held, trace_sha256}`, recomputed **exactly** by the shared validator from the
row's observations: `verify_first` (a rival reading, a hold or an unresolved category exists), `high` (two or more
independent source observations, all concordant and hold-free), `standard`. `trace_sha256` is an order-independent
commitment to every observation's `(trace_digest, category, held)`. Under the ensemble policy **no observation is ever
omitted**: a lemma needing more than the 64-observation bound fails the run (split the evidence), because an unseen
observation could hide a hold or category that no tracked artifact shows and the portable validator cannot re-derive
analyzer output. Authenticity of recorded categories/holds against the real analysis is proven by the local
`verifyEnsembleTraces` check (needs the ignored `--ensemble-trace` file; not part of routine CI). Priority orders Stage 2
review effort only; per `AGENTS.md`, usefulness never admits, holds or rejects a lexical entry.

## Artifacts (still exactly `manifest.json` + `candidates.jsonl`, #284)

Under the ensemble policy the v2 manifest additionally carries (all text-free):

- `analyzer_providers` (exactly the three, in order, each `identity_digest` pinned) and
  `resolution_policy: provider-resolution-v2-ensemble`; `analyzer_digest` binds both;
- `ensemble: {contract: ensemble-resolution-v2, counts, trace_sha256}` — `trace_sha256` binds the provider
  identities, every retained observation's `trace_digest`, every queue entry's `trace_digest` and the recorded
  context decisions, so changing a provider/version/dictionary, the order, the policy or any result changes it;
- `context_fallback: {contract: context-fallback-decisions-v1, decisions, decisions_sha256}`;
- `unresolved_observations[]`: `{queue_id, surface, evidence, holds, category, reasons, hypotheses, extractor_hint,
  extractor_holds, observation_digest, trace_digest, verification}` with `verification.state`
  `needs_verification | truth_unknown | blocked`.

Rows add, per observation, `ensemble: {category, reasons, alternatives, trace_digest, resolution, [context_decision]}`
and per row `review`. The full text-free trace (Kiwi ranked N-best paths, Khaiii/MeCab best path, hint and
holds, per observation digest) is written **only locally** by `--ensemble-trace data/reference/<file>`; no raw
dump, corpus snippet or paragraph text enters Git. Tampering (omitted/reordered/replaced provider, forged
trace or category, edited decision, dropped queue entry) is rejected by the shared validator (`ci:fast`).

### The verification queue is the explicit gate

An observation in `unresolved_observations` is **absent from every candidate row**, therefore it cannot be
authored, included or admitted by Stage 2/Stage 3 (and is not counted toward the 500 distinct headwords). The
only ways out are (a) a recorded, validated context decision (below) that turns it into a lemma observation of
a v2 candidate, or (b) a later Stage 1 run after the underlying evidence/permission changed. `blocked` entries
carry their fallback blockers. If no legal/contextual verification path is available the entries remain
visible with all hypotheses; they are never silently dropped from the accounting.

## Contextual fallback (M9-style local source-context review)

Trigger: only an observation whose lemma/POS the three providers could not assign (`conflicted` /
`unsupported_or_unknown`) **and** that has a located `corpus-paragraph` reference **and** whose extractor holds
are at most `analysis_ambiguous`. `coverage_collision`, `no_evidence`, missing source and any other upstream
hold block it (`blocked_by`). Assignable observations are never re-run to inflate confidence. A form with an
assignable lemma but an unresolved *sense* remains a Stage 2 semantic issue; morphological consensus cannot
resolve its meaning.

Procedure (all local, no remote API, no network):

1. `npm run factory:stage1 -- --evidence … --task-id … --dry-run --context-review-pack data/reference/<run>/pack.json`
   writes, to ignored `data/reference/` only, each eligible queue entry with its competing hypotheses and a
   bounded window of the original paragraph (looked up by the exact approved document/paragraph ids from the
   ignored corpus index after the corpus permission record is checked; the eojeol must align as an exact,
   whitespace-delimited form, never a substring/prefix). The opened index must also be the evidence's snapshot: the
   source compares its own `index_metadata` (`input_manifest_sha256`, `logical_rows_sha256`) with the evidence
   `source_snapshot` and reports `snapshot_mismatch` otherwise — pack creation, decision recording and
   `verifyDecisionsAgainstSource` all fail closed, so a rebuilt index that reuses paragraph ids is never attributed to the
   old snapshot.
2. The primary agent reads the pack and writes `data/reference/<run>/proposals.json`
   (`{agent, proposals: [{observation_digest, outcome, lemma?, pos?, reason_code?}]}`; `agent` is **required** — the actual authoring agent, e.g. `claude` or `codex` — and is never defaulted), outcome
   `context_confirmed` (names an analyzer hypothesis), `context_reassigned` (a reading no analyzer proposed) or
   `truth_unknown`.
3. `--context-proposals …` re-verifies every proposal against the live source and records the text-free decision.
   Missing source, permission denied, weak alignment or an unverifiable reading is recorded as `truth_unknown`
   (`no_source|permission_denied|weak_alignment|conflicting_readings|verification_failed`) — never a guess.
4. `--context-replay <manifest.json>` replays recorded decisions **deterministically without any paragraph**; a
   decision whose analyzer trace/observation digest no longer matches, or that was edited, is rejected. Routine
   `ci:normal` therefore needs neither the multi-gigabyte index nor raw text; source lookup is tested separately
   with an injected stub, and `verifyDecisionsAgainstSource` (local integration check) recomputes `source_digest`
   from the live paragraph so a changed context fails closed.

A decision record is text-free: `decision_id`, `observation_digest`, `trace_digest`, `surface`, `evidence`,
`considered` (all competing hypotheses), `method: m9-local-context-review-v1`, `outcome`, `reason_code`,
`lemma/pos`, `source_digest` (snapshot + ids + digest of the paragraph + surface; reveals no text),
`decision_sha256`, and the honest attribution `author: {kind: agent-self-check, agent}`, `independent: false`,
`human_reviewed: false`. It is **not** independent or human ground truth and **not** editorial approval.

Recovered observations become part of exactly **one v2 lemma candidate** for the decided lemma (no v1 usage-row
shape), keep every pre-existing extractor hold, and always carry a reviewable `analysis_ambiguous` hold so
Stage 2 must give an explicit `hold_resolution`. The morphological category stays on the record; the recovery
is the separate `resolution: context` decision. Context that supports a lemma/POS different from the analyzer
majority is recorded as `context_reassigned` and is not accepted as a vote.

**Scope.** The fallback only recovers observed candidate surfaces. A lemma the upstream Kiwi-based extractor
never proposed cannot be recovered; it is an **extractor recall limitation**, reported as
`extractor_recall.not_extracted` and never credited to the ensemble.

## Measurement without fake ground truth

`compareResolutionPolicies` (CLI `--compare-kiwi-only`, dry) runs legacy Kiwi-only, three-Provider only and
three-Provider + contextual fallback on the **same cohort**. It reports original observations, unique
surfaces, per-provider calls/time, unique lemma proposals (the denominator is distinct lemmas, not
observations), distinct POS/sense opportunities, unresolved/held observations, held lemmas, fallback
eligible/attempted/evidence-resolved/still-unresolved, and `apparent_resolved`, `needs_verification`,
`truth_unknown`. `verified_correct`, `verified_wrong` and `accuracy` are **`not_established`** (never 0%)
unless an independently adjudicated set is supplied; model votes, AI self-checks and unknown items are never
reported as verified accuracy, and the historical #274/#283 figures (85 AI self-check judgments, v1 usages)
are not used to calibrate any approval probability.

## Operator notes

- Native runtimes (macOS arm64): pinned Kiwi (`TYPEWRITER_PYTHON`), the Khaiii v0.4 native release
  (`scripts/factory/fetch-khaiii-native.mjs`) and the MeCab-ko venv (`scripts/factory/setup-mecab.mjs`).
  `ci:normal` does not require them: synthetic fixtures cover the code path, and
  `tests/factory-ensemble-native-smoke.test.mjs` is skipped with its reason where any runtime is absent.
- A **real native three-Provider smoke** is required before calling the ensemble default operationally ready;
  the smoke result is recorded in the PR and is distinct from the mocked tests. It shows the providers were
  genuinely invoked and the batch validates; it does not claim analyzer agreement is correct.
- Completing #285 does not itself start a batch. After #285 is reviewed and merged, #261 may produce two small
  real v2 batches as a controlled pilot; ordinary 500-headword scale-up, Phase 2 and 10K production remain gated
  on an evidenced #261 Pilot PASS (#284 is already merged via #286).

# Data Review — source-bound editorial and admission contracts

Load this guide from the root `REVIEW.md` for lexical/editorial data, schema, senses,
relations, candidate→QA→admission, canonical changes and affected data producers.
The root defines stage order, same-HEAD gates, blockers and review submission.
Consult `domain-model.md` only if the affected contract needs it.

## Lexical meaning and relation decisions

**Apply the current owner decision in [relation-editorial-policy.md](relation-editorial-policy.md).**
It overrides stricter historical near/direct substitution and broader/narrower
exclusion criteria. These rules apply to new Stage 2 authoring, Stage D backfill,
Stage 1 focused review and Stage 2 independent review.

- Canonical is the source of truth; preserve real source/target sense bindings,
  POS, relation types, directions, source order, provenance and digests.
- **Dictionary: direct (유의어) and antonym (반의어)** are assessed for actual
  lexical synonymy and opposition of bound senses. A synonym need not replace
  its peer in every sentence or have identical gloss breadth, intensity or
  register. Differences alone cannot justify demotion to near/association.
  Reject genuinely unsupported dictionary relationships. No relevance field.
- **Writer exploration: near/mood (말의 결), scene/sensory/action/association
  (연상)** should enrich a writer's language and imagination. Preserve any
  intelligible creative path, even when figurative, unusual, broader/narrower,
  cross-POS or contextual. A preference for other words or a rigid
  word-substitution rule is not a veto. Association is not a dumping ground
  for legitimate dictionary synonyms.
- Reject clear broken sense bindings, plainly incoherent connections without
  a defensible writer path, illegal target-POS/type contracts, or real
  structural/semantic errors. A plausible but marginal link should ordinarily
  receive **lower relevance**, not be removed.
- **Primary exploratory review:** compare new relevance 1–9 **against
  already-authored canonical and proposed relations of the SAME source sense
  and UI group**, not against unrelated words. Inspect actual ranks and
  writer-facing reasons, flag significant inversions and unjustified
  preference. If 사람→엄마 is rank 2, a new 사람→아빠 rated 1 normally merits
  2 absent a real distinction. Equal values are fine. 4 vs 5 is ordinarily
  subjective, **not a blocker**. Relevance is ordinal display priority,
  **not** semantic distance or confidence.
- Reverse links need valid source/target identities and preserved provenance;
  do not create them for symmetry or require identical relevance across
  different source senses. Valid entries with zero relations remain
  admissible and searchable. Avoid mechanical subjective scoring validators.

## Systemic relation defects — Stage 2 and re-review

A **proven shared defect** requires an actual incorrect behavior and a
demonstrable shared rule or implementation flaw. One subjective near/mood/
association judgment, a broader definition or a slight relevance disagreement
**does not** establish a systemic defect.

1. Identify the actual cause and **bounded affected population**. For
   dictionary errors, verify the paired bound senses and relevant positive/
   negative controls. For relevance errors, demonstrate materially wrong
   same-source/same-group rank comparisons, not an abstract disagreement.
2. When genuinely shared, fix the relevant producer/policy path and verify
   the affected existing records and applicable future Stage 2/Stage D paths.
   Do not demand a word-specific exception or mechanical creativity validator.
3. Re-review the demonstrated affected class after the fix; do not inflate
   one questionable association into a mandatory audit of all near relations,
   all historical reverse links, or unrelated canonical senses.
4. **Blocking discipline:** Stage 1/2 -1 requires a concrete, material
   lexical, structural, provenance or user-facing error, or an evidenced
   substantial relevance inversion. Plausible creative routes and minor
   subjective ranking adjustments are **non-blocking feedback**.
5. Mechanical invariants (IDs, reference integrity, duplicate/self edges,
   missing targets, inconsistent fixed metadata) still use shared validators
   and their ordinary CI gate; see [review-toolchain.md](review-toolchain.md).

## Factory hand-off, honesty and fail-closed decisions

Trace **candidate → source-bound semantic QA → admission → canonical →
SQLite/direct search** across the changed boundaries. Check original
lemma/POS/gloss/sense source bindings, candidate and review digests,
provenance, reference targets, decisions, explicit hold/rejection reasons,
stable IDs and ordering, and forward/reverse relation effects.

- Factory authors and self-checks **do not** independently certify their
  own decisions as human or independent reviewer approval. M10 B11+ may
  explicitly report **AI producer self-check without subagents**; that is
  not Stage 1/2 evidence or human QA.
- Preserve historical B05–B09 decision/evidence contracts; do not retrofit
  old reviews, fake provenance, silently rewrite source history or relabel
  production output as independent work.
- Holds, unknown input, missing evidence, stale claims or failed admission
  must stay **fail-closed**; avoid silently deferring/rejecting otherwise
  valid records as a workaround for a shared producer/validator defect.
- New or rebuilt batches must have correct batch IDs, allocation, metadata
  and deterministic provenance. Keep the reviewed batch's decisions tied to
  their **current source**; imported/canonical outputs must reflect them.
- Repair systemic defects in the shared producer/validator/admission/search
  boundary, then check all applicable existing records and future additions,
  rather than hand-editing generated records or fixing one batch example.

If external materials feed authoring or product artifacts, also load
`docs/review-licensing.md`. A public research workflow is not permission
to distribute raw source material or unlicensed derived product content.

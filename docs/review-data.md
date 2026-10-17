# Data Review — source-bound editorial and admission contracts

Load this guide from the root `REVIEW.md` for lexical/editorial data, schema, senses,
relations, candidate→QA→admission, canonical changes and affected data producers.
The root defines stage order, same-HEAD gates, blockers and review submission.
Consult `domain-model.md` only if the affected contract needs it.

## Lexical meaning and relation decisions

**Apply the current owner decision in [relation-editorial-policy.md](relation-editorial-policy.md).**
It overrides stricter historical near/direct substitution and broader/narrower
exclusion criteria. These rules apply to Stage 1 focused review and Stage 2
independent review of Issue #838 말의 결/연상 and of STDICT-sourced
`direct`/`antonym` projection changes.

The 2026-10-12 clarification treats short canonical glosses as anchors for the
bound senses, not exhaustive accounts of every use. Assess the actual bound
lemma, POS, sense and gloss together with a plausible, natural, recurring
usage context. A credible contextual similarity/opposition may support
`direct`/`antonym` even when glosses emphasize different facets, sentence-level
substitution is not universal, or opposed qualities can coexist. A reviewer
should first articulate the plausible context, then decide whether a concrete
material mismatch remains.

## Issue #838 말의 결·연상 — scope split

Applies to new Typewriter-authored `near`/`mood`/`scene`/`sensory`/`action`/
`association` (see "Scope of Issue #838" in
[relation-editorial-policy.md](relation-editorial-policy.md)). The `direct`/
`antonym` rules below validate STDICT-provided relations and approved `→`
reference projections; they are not a reason to demand `direct` for, or to
authorize adding, a new authored synonym. Rules below marked *historical/STDICT
only* do not apply to the new scope.

- **STDICT immutability:** never ask the author to re-judge, add or remove an
  official `direct`/`antonym`; the existing `direct` bidirectional projection
  (#797/#834) is unchanged.
- **Tier:** 연상 Tier 1 means close enough to be informally considered a
  synonym and a real alternative expression, not merely vivid or poetic.
  Relevance is relative within the same source meaning and UI group; no quota,
  equal Tiers and zero relations are valid. Do not apply the Tier 1 criterion
  to `mood`/`near` mechanically. Block a wrong sense, wrong homograph target,
  contradictory type, forced link, or evidenced material inversion; one-band
  or taste differences are non-blocking.
- **Targets:** an ID target must bind the exact headword/homograph/sense
  (never the first string match or a different sense). Otherwise the target is
  non-empty plain text with no ID: no click action, no reverse relation, no
  invented record. Reject a fabricated ID or a wrong-meaning link used to
  avoid text.
- **Bidirectional:** new authored ID↔ID relations are explorable from both
  ends, each direction judged for type/Tier from its own source. Do not
  symmetrise STDICT or earlier exploratory relations.
- **Not implemented yet:** text-only targets, the authored-relation source of
  truth and bidirectional derivation. Verify these contracts when the
  implementing code lands; do not require them, or claim they work, before.
- **Headword candidates** (`data/headword-candidates/pr-<PR number>.jsonl`,
  Schema v1 in #838): check only syntax, required/extra fields, a real
  `source_record_id` matching `source_lemma`, same-PR duplicate
  `term`+`meaning_hint`, and obvious junk or a candidate whose same meaning is obviously already an existing headword (same spelling with a different meaning is a distinct valid candidate; never reject by spelling alone). Skip
  promotion merit and detailed QA; this never relaxes review of the PR's actual
  relations, Tier or product behaviour. The PR relation stays text regardless.
- Stage 1/2 independence, exact-HEAD verification and shared regressions are
  unchanged.

## Canonical relation contracts

- Canonical is the source of truth; preserve real source/target sense bindings,
  POS, relation types, directions, source order, provenance and digests.
- **Lexical: direct (유의어) and antonym (반의어)** are STDICT-provided (or
  approved `→` projections) and are assessed, for source/projection integrity, for meaningful
  semantic similarity or opposition between the bound senses, including
  defensible natural usage contexts. A `direct` relation can be a close
  writer-facing alternative without being interchangeable in every sentence;
  an `antonym` relation need not be a logical negation or an exclusive pair.
  Differences in short glosses, scope, register or intensity alone cannot
  justify demotion to near/association, and possible co-existence alone does
  not disprove contextual opposition. Do not accept a mere topic, co-occurrence,
  cause, side effect or contrastive scene as lexical meaning. No relevance
  field.
- **Writer exploration: near/mood (말의 결), scene/sensory/action/association
  (연상)** should enrich a writer's language and imagination. Preserve any
  intelligible creative path, even when figurative, unusual, broader/narrower,
  cross-POS or contextual. A preference for other words or a rigid
  word-substitution rule is not a veto. A close informal synonym candidate may
  be 연상 Tier 1.
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
  do not create them for symmetry (except new #838 authored ID↔ID relations and
  the existing `direct` projection, above) or require identical relevance across
  different source senses. Valid entries with zero relations remain
  admissible and searchable. Avoid mechanical subjective scoring validators.

## Systemic relation defects — Stage 2 and re-review

A **proven shared defect** requires an actual incorrect behavior and a
demonstrable shared rule or implementation flaw. One subjective near/mood/
association judgment, a broader definition or a slight relevance disagreement
**does not** establish a systemic defect.

1. Identify the actual cause and **bounded affected population**. For
   `direct`/`antonym` errors, verify both bound senses and whether a natural,
   recurring usage supports the claimed semantic relation; compare relevant
   positive/negative controls instead of treating a terse gloss as exhaustive.
   For relevance errors, demonstrate materially wrong same-source/same-group
   rank comparisons, not an abstract disagreement.
2. When genuinely shared, fix the relevant producer/policy path and verify
   the affected existing records and applicable future authoring paths.
   Do not demand a word-specific exception or mechanical creativity validator.
3. Re-review the demonstrated affected class after the fix; do not inflate
   one questionable association into a mandatory audit of all near relations,
   all historical reverse links, or unrelated canonical senses.
4. **Blocking discipline:** Stage 1/2 -1 requires a concrete, material
   lexical, structural, provenance or user-facing error, or an evidenced
   substantial relevance inversion. For a disputed `direct`/`antonym`, explain
   why the actual bound meanings remain materially unsupported after the
   plausible usage context has been considered. A defensible contextual
   reading, strict-gloss disagreement, or minor subjective ranking adjustment
   is **non-blocking feedback**.
5. Mechanical invariants (IDs, reference integrity, duplicate/self edges,
   missing targets, inconsistent fixed metadata) still use shared validators
   and their ordinary CI gate; see [review-toolchain.md](review-toolchain.md).

## Review route, honesty and fail-closed decisions

The Stage 1→2→3 lexical-production factory, its batch hand-off, Stage D packets
and batch metadata duties are **retired** (historical records are kept, not
reviewed as current procedure). Current route for data changes: **source**
(STDICT Canonical, or the #838 authored-relation source once it exists) →
**shared validator** → **build** (Full → Lite) → **runtime/UI**. For #838
authored relations, once implemented, sample exact sense/ID binding, Tier 1
assignments, both directions of ID↔ID relations, and non-clickable
reverse-less text-only rows through that route.

- Self-checks and AI producers **do not** certify their own work as human or
  independent reviewer approval; never accept invented reviewer identities or
  evidence. Do not retrofit historical reviews, fake provenance or silently
  rewrite source history.
- Missing evidence, unknown input or failed validation stay **fail-closed**;
  do not accept silently dropped valid records as a workaround for a shared
  defect.
- Repair systemic defects in the shared producer/validator/build/consumer
  boundary, then check all applicable existing records and future additions,
  rather than hand-editing generated records or fixing one example.

If external materials feed authoring or product artifacts, also load
`docs/review-licensing.md`. A public research workflow is not permission
to distribute raw source material or unlicensed derived product content.

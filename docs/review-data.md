# Data Review — source-bound editorial and admission contracts

Load this guide from the root `REVIEW.md` for lexical/editorial data, schema, senses,
relations, candidate→QA→admission, canonical changes and affected data producers.
The root defines stage order, same-HEAD gates, blockers and review submission.
Consult `domain-model.md` only if the affected contract needs it.

## Lexical meaning and relation decisions

- Canonical data is the editable source of truth, never generated drafts or
  confidence scores. Keep schema, IDs, input order and generated metadata honest.
- Review gloss, POS, sense boundaries, `direct` and `antonym` at dictionary-grade
  precision. A `direct` relation must be substitutable **for the bound sense**.
- Review `near`, `mood`, `scene`, `sensory`, `action` and `association` for
  useful, honestly typed **sense-bound** relationships; plausible subjective
  associations are not lexical equivalence.
- Judge `near` against the **actual source AND target sense definitions and POS**,
  not shared keywords in glosses. A broader/narrower term (hypernym/hyponym),
  figurative vs concrete meaning, state vs action/attitude, or trigger vs action
  normally belongs in `association`, not `near`.
- Check any **already-authored reverse link** between those same senses for
  consistent judgments. Do not invent a reverse link merely for symmetry.
- Sense distinctions, ranking and grouping must prioritize the intended writing
  use over noise. Relation enrichment **must not** block an otherwise valid
  lemma/POS/sense: zero relations are allowed at admission and direct search.
- Subjective meaning/ranking judgments require **source-bound editorial QA**;
  don't turn them into blanket mechanical synonym validators or reject all
  records without a subjective relation.

## Systemic relation defects — Stage 2 and re-review

If one relation misclassifies a broader term as `near`, do **not** simply reject
the named pair and accept a later producer claim that “all similar pairs passed”.

1. Establish the erroneous **common rule** and the **affected population**:
   all matching relations in the batch/current affected material, related
   same-source senses, previously authored reverse links and any other
   production path sharing that classification rule (including future batches).
2. For each at-risk member, examine the **source sense, actual bound target
   sense and evidence**. Use relevant positive controls (legitimate `near`)
   and negative controls (hypernyms, semantic-topic neighbors, mismatched POS,
   state/action shifts). Inspect actual results, not just a summary count.
3. Demand a **producer/common authoring-rule correction** plus a generalizable
   regression or source-bound editorial check that covers applicable existing
   data and future additions. A one-pair patch or a regression hard-coded to
   the cited words is insufficient.
4. Re-review the **entire identified affected class and changed results**,
   including new or unchanged misclassifications, before claiming class-wide
   resolution. Account for omitted, held or unverifiable members explicitly.
   A representative probe can orient the review; it **cannot** certify full
   population coverage or override independent verification.
5. Match effort to demonstrated risk. Do **not** demand an exhaustive scan of
   unrelated canonical records on every routine PR.

For mechanical invariants (schema, reference integrity, duplicate IDs,
self-references, missing targets, contradictory fixed metadata), use shared
validators and their CI evidence; only machine-checkable general rules belong
in validators. See `docs/review-toolchain.md` if the code or test changes.

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

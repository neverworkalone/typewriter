# Current relation editorial and review policy (owner decision, 2026-10-10)

This is the **authoritative current editorial contract** for relation authoring,
Stage D backfill and PR review. It supersedes contrary M1 pilot-era
near/direct substitution, broad/narrow exclusion and historical example rules
in editorial-model.md and other older guidance. The actual canonical graph is
not rewritten by this policy change.

## Different goals, different review gates

| UI group | Canonical types | Primary purpose | Reviewer gate |
| --- | --- | --- | --- |
| 유의어 | direct | Dictionary-grade lexical synonyms | Lexical accuracy at the bound senses |
| 반의어 | antonym | Dictionary-grade semantic opposites | Accurate opposite axis at the bound senses |
| 말의 결 | near, mood | Writer-facing nuance, tone and texture | Creative breadth and relative relevance |
| 연상 | scene, sensory, action, association | Evocative scenes, senses, actions and ideas | Creative breadth and relative relevance |

**Dictionary types:**
- A direct relation requires a defensible **lexical synonym relationship**
  between the actual bound senses; it does **not** demand substitution in
  every sentence, identical gloss breadth, register, intensity or habitual
  collocations. Do not demote or delete legitimate lexical synonyms merely
  because their usages differ. 차분하다 ↔ 침착하다 and 늪 ↔ 습지 illustrate
  dictionary-synonym candidates rather than mere creative associations.
- Antonym requires genuinely opposed meanings along a meaningful matching
  sense axis, not simply things found in contrasting scenes.
- False sense bindings and false dictionary claims can block. These types
  never carry relevance.

**Writer-facing exploratory types:**
- near explores expressive neighboring nuance / a word's texture, mood
  evokes emotional tone. They are not a fallback bucket for dictionary
  synonyms and do not require exact lexical substitution.
- scene opens a situation, sensory opens a sensation, action evokes a
  plausible action (respecting its existing target-POS constraint), and
  association opens another intelligible subject, object, creature, idea
  or imaginative path. Association is not a trash bin for synonyms that
  failed an overly strict direct test.
- For example, 습지 → 축축함 may be sensory, and 습지 → 모기/거머리 may be
  association. 습지 → 원숭이 may also be association in a tropical-habitat
  creative context, at a lower display priority. These are illustrative
  editorial examples, not mandated canonical facts or universal ecological
  claims.
- **Preserve plausible creative links** despite unusual imagery, subjective
  interpretation, cross-POS wording, broader/narrower scope or context
  dependence. Dictionary equivalence is not required.
- Reject a link only for a **demonstrably wrong sense/target, impossible
  type contract, or plainly incoherent connection with no intelligible
  writer path** (e.g. an unexplained bare 사람 → 컵). A reviewer merely
  preferring a different expression is not a defect.

## Relevance: 1–9, not accept/reject

Every exploratory relation has ordinal display-priority relevance:

- 1: highest first-page priority
- 3: strong
- 5: clearly useful
- 7: broader or context-dependent
- 9: peripheral but worth preserving
- 2, 4, 6, 8: intermediate editorial judgments

This is **not** semantic distance, synonym accuracy, confidence, likelihood
or a precise numeric metric. Identical ranks are allowed and rank bands
are not assumed equally spaced. Within each UI group the runtime sorts by
relevance ascending, then stable canonical source position; stored relations
are not truncated to the UI's top 100.

**The primary exploratory review task is relative calibration.** For each
new candidate, compare its relevance against the **already-authored
canonical and proposed relationships from the same source sense and the
same displayed group**. Identify meaningful inconsistent priority and
unjustified preference. For instance, if 사람 → 엄마 is relevance 2,
new 사람 → 아빠 should normally also rank 2 unless a convincing
writer-facing reason explains the distinction. Compare group peers,
not unrelated words or unrelated source senses.

When a creative path is plausible but weaker or context dependent,
**retain it with a lower priority** instead of vetoing it. A judgment call
such as 4 vs 5 is not a blocker. Do not require a universal perfect
relative order, nor mechanically score or test subjective usefulness.

## PR reviewer responsibilities and blocking threshold

1. Verify dictionary-type semantic accuracy and ordinary structural,
   source-bound, licensing, provenance and reference integrity.
2. For exploratory types, screen **only clear errors** before evaluating
   their relevance relative to existing same-source/group relationships.
   Do not demand interchangeable wording, identical glosses or a generic
   no-hypernyms rule for all creative links.
3. Suggest optional rank tweaks without blocking when disagreement is
   marginal or subjective. A **clear, material relative-priority inversion**
   that meaningfully distorts visible results can block if backed by
   actual same-source peers and specific evidence, not abstract taste.
4. A systemic relation defect requires **demonstrated shared behavior**
   and a bounded affected population. One debatable creative link or
   a one-band difference does not trigger a full near/association audit.
   Fix genuine shared producer defects and test the applicable current
   and future authoring paths, without mechanical synonym-or-creativity
   validators.
5. Respect existing authored reverse links and provenance; do not invent
   symmetry, demand equal relevance across different sources, or silently
   rewrite canonical history. Zero relations remain valid; no quotas.

Apply these principles **both** when producing new Stage 2 senses and when
enriching existing Stage D backfill senses. Stage 1 and Stage 2 PR
reviewers use the same semantics but retain their independent review stages,
exact-HEAD requirements and ordinary confirmed-error gates.

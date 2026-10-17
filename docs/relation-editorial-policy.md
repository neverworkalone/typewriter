# Current relation editorial and review policy (owner decisions, 2026-10-10 and 2026-10-12)

This is the **authoritative current editorial contract** for Typewriter
말의 결/연상 authoring and PR review, and for validating STDICT-provided
`direct`/`antonym`. It supersedes contrary M1 pilot-era near/direct
substitution, broad/narrow exclusion and historical example rules in
editorial-model.md and other older guidance. The actual canonical graph is not
rewritten by this policy change. Read the "Scope of Issue #838" section first.

The 2026-10-12 owner clarification applies a contextual, writer-facing standard
to `direct` and `antonym`. A short canonical gloss anchors the bound sense; it
does not exhaust every natural use. A recognizable, intelligible and recurring
context can establish semantic similarity or opposition even when the words
are not interchangeable in every sentence or their definitions are not
logically exclusive. This clarification does not turn either relation into a
general topic or scene association.

## Scope of Issue #838 (owner decisions; Issue #839)

[Issue #838](https://github.com/neverworkalone/typewriter/issues/838) is the single
authority for #838 말의 결/연상 authoring. Where this document, written for the
earlier Stage D / `direct`-first workflow, conflicts with it for **new
Typewriter-authored 말의 결·연상**, #838 controls. Everything below is split by
source and scope:

| Scope | Rule |
| --- | --- |
| STDICT-provided `direct`/`antonym` and approved explicit `→` reference projections (#834) | Unchanged and authoritative. Not re-judged, re-edited or extended by Typewriter. The `direct` bidirectional contract (#797/#834) stays. |
| Historical relations and calibrations (M1/M9/M10, Stage D, the `direct`/`antonym` calibration examples below) | Records of past decisions. They are **not** permission to add new Typewriter-authored `direct`/`antonym`, and the data is not rewritten. |
| New #838 Typewriter-authored 말의 결 (`near`, `mood`) and 연상 (`scene`, `sensory`, `action`, `association`) | Governed by this section. |

**What changes for new #838 authored relations:**

- **No `direct`-first step.** Do not ask "why not `direct`?" and do not move a
  close expression out of 연상/말의 결 because it could be called a synonym.
  Do not author new `direct`/`antonym` rows. The UI groups and their display
  settings are unchanged; a writer with 유의어/반의어 turned off must still be
  able to explore through 말의 결 and 연상.
- **연상 Tier 1 (relevance 1)** is for a candidate close enough that a writer
  might informally consider it a synonym and that is a real expression
  alternative, even though the dictionary does not list it (나그네 → 이방인 /
  방랑자; confirm the exact target meaning before adopting). A striking scene
  or object alone (나그네 → 여인숙 / 봇짐 / 발자국) is a valid 연상 but not Tier 1.
  Do not apply this "synonym-candidate" criterion mechanically to `mood`/`near`
  or give every relation Tier 1. 2–9 are not fixed per word class; judge
  writing value, context dependence and order against same-source/group peers.
- **Relevance 1–9** is relative display priority within the same source meaning
  and UI group. It is not confidence or a numeric distance. Equal tiers, zero
  relations and any count are valid; there is no quota (neither a minimum nor a
  fill-to-N target, and no Tier 1 quota).
- **Targets: link first, otherwise text.** Link a target only when an existing
  headword/homograph/sense matches the intended meaning exactly (a
  `과거시험` idea may point to the 과거 record for the examination system, never
  to 과거(過去)); never pick the first string match. Otherwise the target is
  plain text with no ID (a word, name, phrase or multi-word expression such as
  `디아블로와 바알`): not clickable, no reverse relation, no invented record
  or ID.
- **ID↔ID bidirectional exploration.** An approved new Typewriter-authored
  말의 결/연상 whose target is an exact record is provided in both directions.
  Each direction takes its own type and relevance from its own source meaning,
  so Tier need not match. Existing STDICT relations and earlier exploratory
  relations are **not** blindly symmetrised, and text-only targets have no
  reverse. This supersedes "do not invent symmetry" in the reviewer
  responsibilities below for this scope only.
- **Headword-promotion candidates** are collected separately, never in the
  relation rows: `data/headword-candidates/pr-<PR number>.jsonl` in the
  Schema v1 defined in #838 (`term`, `meaning_hint`, `source_lemma`,
  `source_record_id` required; `reason` optional; no status, POS, Tier or
  invented ID). The same PR's product relation is still plain text. A PR
  review checks only JSONL/schema validity, a real `source_record_id`/lemma
  correspondence and obviously absurd rows or a candidate whose same meaning is obviously already a headword (same spelling with a different meaning is a distinct, valid candidate); promotion
  merit is deferred to a separate batch review once about 1,000 unique
  candidates accumulate. The relaxed candidate review never relaxes review of
  the relations, Tier or behaviour in the same PR.
- **Generation method is undecided.** Direct generation (A) versus scene-based
  generation (B) is to be settled by a small experiment first (corpus-based C
  later). This policy approves no production prompt or bulk backfill.

**Implementation status (not yet implemented).** Text-only targets, a
Typewriter-authored relation source of truth, and ID↔ID bidirectional
derivation for #838 authored relations do not exist yet. Today
`meaning_relations.target_meaning_id` is `NOT NULL`, queries inner-join the
target, and interactive relations are buttons. Do not produce or review data
as if the text-only or bidirectional behaviour already worked; reviewers check
those contracts once the corresponding code lands. The technical docs
(`meaning-layer.md`, `domain-model.md`, `build.md`) are to be updated by that
implementation work.

**Block thresholds (this scope).** Reject a demonstrably wrong sense/homograph
target, a type that plainly contradicts the relation, a forced or incoherent
link, a fabricated headword/ID, or a text target made clickable or reversed.
Disagreement over one or two Tier bands, over 4 vs 5, or over taste is
non-blocking feedback; a clear, evidenced inversion against same-source/group
peers can block. Tier 1 handed out to scene/object associations that are not
synonym-candidate-level is a calibration defect only when it visibly distorts
that group.

## Different goals, different review gates

The table and the `direct`/`antonym` rules below describe how STDICT-provided
relations are validated. Typewriter does not author new `direct`/`antonym`.

| UI group | Canonical types | Primary purpose | Reviewer gate |
| --- | --- | --- | --- |
| 유의어 | direct | Writer-facing lexical similarity and close alternatives | Defensible semantic similarity between the bound senses in ordinary or contextual use |
| 반의어 | antonym | Writer-facing semantic opposition | Meaningful opposition between the bound senses in a natural usage context |
| 말의 결 | near, mood | Writer-facing nuance, tone and texture | Creative breadth and relative relevance |
| 연상 | scene, sensory, action, association | Evocative scenes, senses, actions and ideas | Creative breadth and relative relevance |

**Validating STDICT-provided `direct`/`antonym` (existing source and projection
integrity; not a creative-authoring workflow):**
- `direct` claims meaningful semantic similarity between the actual bound
  senses: conventional synonymy, or a natural, recurring usage in which the
  words function as close alternatives. Check lemma, POS, sense and gloss
  together; it does not require substitution in every sentence, identical gloss
  breadth, register or intensity. Differences of scope or facet alone are not
  grounds to doubt a source relation.
- The shared historical boundary (`scripts/relation/direct-boundary.mjs`) names
  six classes (`scope-only`, `same-movement`, `action-vs-agent`,
  `narrative-contrast`, `same-axis-opposition`, `different-movement`) used to
  decide whether a claimed lexical pair connects the bound meanings; it is not
  a mechanical validator and not an instruction to author `direct` rows.
  `data/validation/relation-editorial-controls.json` and
  `tests/relation-editorial-controls.test.mjs` keep sense-id-bound controls as
  audit history. Historical positive calibrations: 차분하다 ↔ 침착하다, 늪 ↔
  습지, 레슨 ↔ 수업, 꼭대기 ↔ 산꼭대기; negative: 부활절 ↔ 성탄절, 상상력 ↔
  상상하다 (kind-of-thing difference).
- `antonym` claims meaningful semantic opposition between the bound senses in a
  recognizable natural usage context; definitions need not be logically
  exclusive. Historical calibrations: 편하다 ↔ 불편하다, 시큼함 ↔ 달다, 실감 ↔
  환각; an antonym needs the same axis (패자 ↔ 승자, not 패자 ↔ 승리).
- A topic, co-occurrence, causation, side effect or contrasting scene alone is
  not lexical similarity/opposition. These types never carry relevance.
- Block only a materially false sense binding or a relation demonstrably
  unsupported after considering plausible usage contexts and the controls.
- `antonym` claims meaningful semantic opposition between the bound senses in
  a recognizable natural usage context. Ordinary, literary, figurative,
  technical, domain-specific and culinary contexts can establish the contrast.
  The definitions need not be logically exclusive, and the opposed qualities
  may coexist in one object or scene. 편하다 ↔ 불편하다 (comfort/discomfort),
  시큼함 ↔ 달다 (sour/sweet taste contrast in cooking), and 실감 ↔ 환각
  (a literary realistic/hallucinatory contrast) are positive antonym
  calibrations.
- Before blocking a debatable pair, try to state the strongest plausible,
  recurring context that supports the claimed similarity or opposition. If
  that context makes the bound relation intelligible, preserve it; a stricter
  gloss-only reading, possible co-existence, or disagreement over the best
  wording is not by itself a blocker. These types never carry relevance.
- Context alone is not enough when it supplies only a topic, co-occurrence,
  causation, a side effect, or objects placed in contrasting scenes. A sensory
  property and its descriptor, a capability and a treatment that suppresses
  it, or a substance and a resulting state may be closely related without
  expressing semantic similarity or opposition. A claimed lexical relation
  must still connect the actual bound meanings; retain useful non-lexical
  paths under a fitting exploratory type. POS differences prompt inspection,
  but are not a mechanical rejection rule.
- Block only a materially false sense binding or a relation that remains
  demonstrably unsupported after considering plausible usage contexts and
  relevant positive/negative controls.

**Writer-facing exploratory types:**
- near explores expressive neighboring nuance / a word's texture, and mood
  evokes emotional tone; neither requires exact lexical substitution.
- scene opens a situation, sensory opens a sensation, action evokes a
  plausible action (respecting its existing target-POS constraint), and
  association opens another intelligible subject, object, creature, idea
  or imaginative path. A close informal synonym candidate is legitimately
  연상 Tier 1 (see the Scope of Issue #838 section).
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
5. Reverse links: the product build mirrors every original STDICT `direct`
   (including `direct` derived from an explicit STDICT `→` reference, Issue
   #834) as a derived `direct-reverse-projection` row (Issue #797); this is
   unchanged and no other STDICT/earlier type is mirrored. New #838
   Typewriter-authored ID↔ID 말의 결/연상 are explorable in both directions
   with independently reviewed type and relevance per direction (once
   implemented); text-only targets have no reverse; earlier exploratory rows
   are not blindly reprocessed. Do not demand equal relevance across different
   sources or silently rewrite canonical history. Zero relations remain valid;
   no quotas.

Stage 1 and Stage 2 PR reviewers apply these principles with their independent
review stages, exact-HEAD requirements and ordinary confirmed-error gates.

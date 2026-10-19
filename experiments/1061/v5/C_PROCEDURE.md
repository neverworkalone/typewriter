# C Procedure (V5) — Evidence-first binding, diverse contexts, adversarial verification

Issue #1061, method C (literature context). Cohort: shard 013 / batch 02
(Canonical `stdict-0013.jsonl` rows 501–1000, 500 records / 571 senses).
This document is the C-only procedure used for `experiments/1061/v5/`.
It contains no source text, excerpts, SQLite, or search logs.

## 0. Position relative to V4

V4 added sense states (VERIFIED/AMBIGUOUS/REJECTED) and a required connection
path. V5 makes binding **evidence-first** (a sentence, not a plausible
explanation, must show the sense), adds an adversarial rebuttal step, and
separates two experiments:

- **Experiment A (frozen context)** — only the V4 context set; improves
  verification and extraction.
- **Experiment B (expanded context)** — same rules, plus new works selected for
  diversity of scene/sensation/emotion/causality.

## 1. Phase A — Evidence-first source-sense binding

For every candidate context, record what the text actually shows:

1. the surface form of the headword in the original;
2. the sentence/clause that proves the exact sense;
3. the risk of a homograph, polyseme, hanja reading, archaic form, or substring;
4. the semantic role the word performs in that sentence;
5. whether that role is **written in the text** or inferred by the model.

States:

- **VERIFIED** — a sentence proves the bound sense and the role is textual.
- **AMBIGUOUS** — two readings remain, or evidence is missing. If unresolved
  after further contexts, no candidate is produced.
- **REJECTED** — another sense, another word, a hanja reading, a spelling
  match, or a role the word does not perform.

Only VERIFIED contexts feed later phases. Search success is not binding.

## 2. Phase B — Evidence-grounded relation extraction

Each candidate carries a local record (never committed):

```
SOURCE, CONTEXT, EVIDENCE, ROLE, RELATION, CANDIDATE, DERIVATION, JUSTIFICATION
```

`EVIDENCE` and `ROLE` must be findable in the text. `RELATION` and `CANDIDATE`
may interpret or transform, but not beyond what `EVIDENCE` supports. If the
evidence cannot support the relation, drop the candidate or look for another
relation in the same context. **Explanation cannot replace evidence.**

## 3. Phase C — Diverse literary context discovery

Expansion is adaptive, not volume-driven:

1. review the existing VERIFIED contexts and candidates;
2. judge whether independent relation types are still missing;
3. if scene/sensation/emotion/causality diversity is thin, read **different
   works** for the same sense, preferring different objects, actions, senses,
   moods, causal chains, metaphors and contrasts;
4. apply Phase A to every new context;
5. stop when new contexts stop yielding new relations.

Avoid re-reading similar paragraphs from one work, and avoid concentration in a
single work or genre. Record which work/scene produced each new relation.

## 4. Phase D — Independent literary relation generation

From each VERIFIED context, examine independently:

Image · Action · Emotion · Sensation · Situation · Causality · Metaphor/Contrast

Types are search lenses, not quotas. Generate one candidate per **distinct
relation**, not several strings per phrase. Every element must pass its own
evidence check; co-present scenery, people and moods are not candidates.

Exploration does not stop at the first candidate: keep looking in the same
context and in other works. Suppress ordinary phrases containing the source
word; allow lexicalized idioms and fixed figurative phrases.

## 5. Phase E — Adversarial semantic verification

Per candidate, judge separately:

- **A. Sense accuracy** — is it the exact sense?
- **B. Evidence grounding** — does the quoted text support the relation?
- **C. Editorial value** — does a writer gain a usable choice?
- **D. Independent contribution** — distinct from the sense's other candidates?
- **E. Counterargument** — if wrong, what is the most likely reason?

In E, test co-occurrence, misreading, another sense's usage, character-level
association, background-knowledge expansion, arbitrary interpretation of a
literary phrase, and a scene description that would hold without the source
word. The counterfactual test is a support tool, never an automatic reject.
Rare metaphors with real textual support are welcome.

## 6. Re-evaluation of the previous run

Every previous candidate is KEEP / REWORK / DROP, with REWORK mandatory when the
same context supports a better relation. Prioritised cases in V4:
`건려→비껴 부는 바람`, `견문발발검→갈릴레오의 적수`, `거산→왜채`,
`건전지→네모 진 물건`, `겨자→작은 믿음`, `걸핏하면→전당`.
All six were re-read against the text and kept; each has an explicit evidence
sentence and a textual role (see the local evidence log).

## 7. Controls

- Same cohort and Candidate JSONL v1 contract as V1–V4.
- V1–V4 artifacts preserved; formal Candidate/Relations/Canonical and the #860
  cursor untouched.
- No per-word exception lists or hard-coded rules. Rules were fixed on the
  six-case sample and then applied unchanged to the whole batch.
- Only `record_id`, `senses[].sense_id`, `senses[].candidates` are committed.
- Source text, excerpts, search logs and SQLite are never committed.
- No other model or subagent is called.

## 8. Result (this run)

| Stage | senses | candidates | per sense |
|---|---|---|---|
| V4 baseline | 64 | 135 | 2.11 |
| Experiment A (frozen context) | 63 | 130 | 2.06 |
| Experiment B (expanded context) | 65 | 152 | 2.34 |

- V4 audit: 130 KEEP, 0 REWORK, 5 DROP (1 co-occurrence, 4 gloss/no-evidence).
- Experiment B: 22 new candidates from 21 newly read VERIFIED contexts across
  ~20 works (novel/essay/poem).
- Attested strings 81 / inflected 27 / context-derived 41 (149 unique).
- Relation spread: image 44, action 27, sensory 27, mood 18, association 16,
  scene 15, situation 3, contrast 1, causality 1.
- Source-word-containing: 7, all lexicalized idioms or fixed figurative phrases.

This is a producer-side self-check, not an independent audit.

# Relation Factory Stage 3 — editorial policy card (#2450)

You are refining **already-approved Stage 2 Relations** for a writer-facing Korean thesaurus. The source **Sense and its full gloss** determine meaning. For each Sense, assess its **entire displayed chunk-owned relation set together**: does each edge give a writer a genuinely useful word choice, nuance, mood, image, action or scene? **No deletion quota.** Stage 2 approval or Type/Tier alone is not a Keep reason.

- **Drop (`D`):** source lemma inflections, trivial same-root ending variants, noun forms of the same concept, reduplication/self-repetition, synonyms that add no distinct expression, accidental context objects/places, weak multi-hop associations, and wrong-source-Sense links. Examples: `깜빡대다→깜빡이다`, `어정대다→어정거리다`, `조퇴하다→조퇴`. `어정대다→낙타` is a likely overextended association; `팔딱하다 s1→심장` requires exact Sense judgment.
- **Keep (implicit):** meaningful stylistic alternatives, fresh but intelligible sensory/scene/mood associations and valuable expression changes. Protect `깜빡대다→가물가물` for memory, `→점멸/명멸` for light. Do not Drop just because a word is unfamiliar, indirect, or in a weak Tier. Do not keep generic synonyms by default.
- **ID relation is bidirectional:** deleting its stored row removes **both** directions. Check the usefulness of the reverse direction before marking `D`. A single edge cannot be directionally hidden in this phase.
- **Link Repair (`L <row> T<target>`):** only for **existing text-only** rows when a shown Canonical Record/Sense **exactly matches** the intended meaning. Compare **every same-spelling target Sense with its full gloss**, not the first spelling match. If uncertain or missing, **Keep text-only**. Preserve the original Type and Tier.
- **Do not** invent candidates, add/retarget non-text Relations, reassign source Senses, change Type/Tier, or edit Canonical/STDICT direct/antonym. No regex-only semantic Drop or target guess.
- **Output only changes:** `chunk NN` then `D 1 5 9`, `L 4 T1` or `none` as the current compact view permits. **Do not list Keep rows or add prose.** The CLI owns candidate accounting and file changes; you judge editorial value.


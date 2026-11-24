# Relation Factory Stage 4 — selective Polish policy card (#9928, #9929)

You are a **vocabulary editor choosing expressions from a novelist's point of view**, not an auditor of dictionary data. The shared Polish/Stage 4 principles are in `docs/relation-editorial-policy.md` (*Polish and Stage 4 — shared editorial principles*); this card is their working summary. Every judgment is made for one **exact Sense and its full gloss**.

> 내가 소설에 이 단어를 썼는데 너무 여러 번 써서 다른 표현으로 바꾸고 싶다. 혹은 이 단어와 유사한 결을 가진 말을 떠올리고 싶다.

## 1. Skip or Polish — value as a search start

First ask, for each Sense: **would a writer search this word directly to find an alternative or a word of similar texture?** Writers search ordinary headwords and their inflected forms. Finding `물 뿌린 듯이` from `고요하다` is valuable; editing `물 뿌린 듯이` as a search start is not.

- **Polish first:** ordinary main verbs, adjectives, adverbs and interjections, especially emotion, action, state, sensation and description. Rare native words, archaic or dialect words and onomatopoeia/mimetic words are not excluded for that reason. A valuable search word with no Relation yet still gets Add judgment.
- **Nouns:** search for *expression* → Polish; search for *information* → Skip.
  - Polish first: emotion/mind (고독, 애련, 비통), character/attitude (야성미, 위엄), action/state/situation/relationships (부침, 흉계, 갈등), general abstractions (현실, 운명, 여운), sensation/nature/landscape (그늘, 노을, 말소리). Academic technical concepts are Skip even when abstract.
  - Judge: ordinary concrete things, body parts, people (창문, 아랫배, 큰형) — Polish only when a writer would search them for description or metaphor; when unclear, use your discretion.
  - Skip first: names that identify a specific object (박공지붕, 교통카드), specific foods, plants and animals (육개장, 가는쑥부쟁이). Appearing in a scene is not enough.
- **Determiners:** Polish those that change quality, degree, attitude or descriptive texture (새, 헌, 온갖, 갖은, 네까짓, and `-적` forms such as 구시대적·단도직입적). Skip pure quantity/order/designation Senses (각, the ordinal Sense of 셋째).
- **Always Skip as a search start:** idioms and proverbs; technical terms, specific classification names, proper nouns, units, and purely grammatical Senses (also for verbs/adjectives). `expression` POS also includes other compound expressions: judge their meaning and use.
- Judge polysemy and homonyms **per Sense**. These examples are directions, not word lists. There is no Skip quota or target ratio.
- **Skip** omits Add, Drop and Set/rebind **for judgments made while reviewing that Sense**. It is a normal result, never a cover for a failure. A skipped Sense's Relations may still be edited while reviewing another, Polished Sense, and a skipped expression (including an idiom) may be an Add target or a kept Relation of a Polished Sense.

## 2. Polish — Add, Drop, Set, rebind

- **Add:** from the exact gloss, first think *independently of the current list* of alternatives, nuances, images, sensations and actions, then compare with the shown forward and reverse Relations. Add only **missing, useful core expressions**. No count target. Bind to the exact Canonical Sense (homonyms are never chosen by spelling); use text-only only when no Canonical Sense has that meaning. Never a proper noun.
- **Drop:** wrong-Sense links, forced associations, overly general words and redundancy without independent expression value. Keep surprising but useful literary associations.
- **Set / rebind first:** when an expression is useful but bound to the wrong Sense, Type or Tier, correct it rather than deleting it.
- **Redundancy is judged over the whole list of one Sense**, forward and reverse together: does each item give a choice beyond those already shown? When inflections, derivations, nominalizations or adverbial forms repeat practically the same choice in meaning, tone and literary use, keep the most natural representative and Drop the rest (e.g. with `쓸쓸하다` present in a `막막하다` Sense, `쓸쓸함`/`쓸쓸히` are Drop first, while `적적하다`, `고독`, `정적` add a different tone or scene and stay). Shared POS, root or surface form alone is never a Drop reason. Consider the other Sense's independent search value and the two-way effect; valid links of different source Senses are not duplicates.
- Respect good existing data. **No change is a normal result.**
- An ID Relation projects both ways: dropping it removes both directions. Type/Tier of an ID row is shared by both directions.
- Types: `near` (writer-facing nuance; close informal synonym at Tier 1), `mood`, `scene`, `sensory`, `action` (target must be a verb or expression), `association`. Tier `1..9` is relative to the Sense's peers. Typewriter never authors `direct`/`antonym`.

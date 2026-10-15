# Issue #716 c17 meaning audit

## Scope and result

- Baseline: `master` at `b2027bfb19df22d53c130df9931a4dbb537abf18`.
- Reviewed all twelve c17 meaning shards: 11,949 initial meanings across 8,918 lemmas. The projection had 1,607 lemmas with multiple canonical senses (853 with multiple senses in one source record and 754 spanning records).
- Kept all 8,918 lemmas. Merged 260 same-lemma groups covering 549 canonical senses, reducing the shard by 289 meanings. Recorded four exact duplicate drops with same-lemma retained targets. The result has 11,656 c17 meanings and four c17 adjudications.
- Added 457 direct meaning-layer glosses for opaque source cross-references. Three further references are represented by their same-lemma merge glosses: the two `태국` senses and the `특명` abbreviation sense. The malformed source reference for `w343533-s1` (`→ .`) remains an explicit hold rather than a guessed gloss.
- `data/canonical/` was not changed.

## Editorial checks

The source-bound pass considered each c17 lemma, its records, and the bound canonical senses. Multi-sense decisions use the actual sense meanings and POS; shared spelling, related subject matter, or a reference to a homonymous headword was not by itself treated as evidence to merge. Merge decisions, direct glosses, and duplicate-drop targets are preserved in [`issue-716-c17.json`](issue-716-c17.json).

Representative checks included resolving the `태국` official-name and transliteration senses into one direct country gloss that preserves both distinctions; correcting `테이블`'s opaque reference to the furniture meaning rather than the homonymous fortune-telling sense of `탁자`; and writing a direct adjective gloss for `틀리다` where its source reference points to a mismatched `다르다` entry. The `통발` fish-fin sense and the two uses of `트기` were checked against their bound source meanings rather than inferred from the more familiar homonyms. Four drops are exact duplicate meanings, each retaining a valid meaning for the same lemma.

PR review found that the `타살하다` merge gloss “남을 때려서 죽이다” covered `w335986-s1` (“때려서 죽이다”) but narrowed the broader `w335984-s1` (“남을 죽이다”). Both the edit spec and materialized gloss now state the broad meaning first and identify beating as a specific use.

The malformed `트더지다` reference remains held because its source target cannot be identified from `→ .`. No replacement meaning was guessed. All other eligible c17 cross-reference meanings received a direct gloss or were covered by an already direct same-lemma merge gloss.

These source-bound editorial checks were performed by the assigned primary agent in this context. They are recorded as agent self-check, not independent review or human editorial approval. PR review is a separate gate.

## Validation

Replaying the complete edit spec from the recorded baseline with the production `applyEdits` function matches the stored result by meaning ID and adjudication sense ID: 497,671 meanings and 37 adjudications, with no mismatches. The c17 output contains 11,656 meanings and four adjudications. `node scripts/meaning/validate.mjs` passed for the full dataset, and `git diff --check` passed.

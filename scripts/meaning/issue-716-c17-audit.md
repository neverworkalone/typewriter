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

A Stage 2 source-bound follow-up compared merged glosses with the full bound source glosses, focusing on source-specific qualifiers, alternatives, and sub-uses that could be made to sound jointly required or disappear. It found scope contractions in `타들다` (`w497104-s1/s2`), `타락하다` (`w340902-s1/s2/s3`), `타이머` (`w346095-s2/s3`), `토지 회사` (`w496041-s1/s2`), `퇴행`/`퇴행하다` (`w344077-s1/s3/s4/s5`, `w344078-s1/s2/s3/s4`), `통칭되다`/`통칭하다` (`w535547-s1/s2`, `w350243-s1` + `w495546-s1`), `통치`/`통치하다` (`w349699-s1` + `w496026-s1`, `w349700-s1` + `w349702-s1`), and `특허` (`w496057-s1/s2`). The edit spec and outputs now preserve the alternatives or enumerate each bound sub-use. The `통치` senses remain merged because both source glosses share the same `다스리다` action axis under the meaning contract; the revised gloss lists territorial rule and strict rule as alternatives instead of making strictness a condition of governing a country or region. The `특허` merge likewise retains the shared grant/permission axis but separates the broad permission gloss from its administrative-law use. These source-bound edits do not change canonical records or sense bindings.

The malformed `트더지다` reference remains held because its source target cannot be identified from `→ .`. No replacement meaning was guessed. All other eligible c17 cross-reference meanings received a direct gloss or were covered by an already direct same-lemma merge gloss.

The Stage 1 follow-up identified one remaining scope omission in the `토지 회사` merge: the prior gloss did not preserve `w496041-s1`'s condition that landlords become shareholders in a particular region. The revised gloss now states that condition only for the first source use, preserves its listed land-management and sales activities, and separately retains `w496041-s2`'s land-distribution-business use. Both the edit spec and materialized row keep the original two sense bindings.

These source-bound editorial checks were performed by the assigned primary agent in this context. They are recorded as agent self-check, not independent review or human editorial approval. PR review is a separate gate.

## Validation

After the review follow-up, replaying the complete edit spec from baseline `b2027bfb19df22d53c130df9931a4dbb537abf18` with production `applyEdits` matches the stored result by meaning ID and adjudication sense ID: 497,671 meanings and 37 adjudications, with zero missing, extra, or changed rows. The c17 output contains 11,656 meanings and four adjudications. `node scripts/meaning/validate.mjs` passed for the full dataset, and `git diff --check` passed.

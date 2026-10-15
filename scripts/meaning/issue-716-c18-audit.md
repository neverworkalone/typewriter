# Issue #716 C18 source-bound meaning pass (ㅍ)

## Scope and result

C18 contains 16 meaning shards (`c18_001`–`c18_016`) with 15,571 initial meanings/sense references across 11,571 lemmas. Of these, 2,166 lemmas have multiple meanings (6,166 rows). This pass records 121 merges covering 259 source senses and two exact-duplicate drops. C18 now has 15,431 meaning rows; all 15,571 canonical senses are accounted for by a meaning or adjudication. The full dataset validator passes.

The edit specification is [`scripts/meaning/issue-716-c18-edits.json`](issue-716-c18-edits.json). It changes only C18 meaning shards and adds two rows to `data/adjudication/c18_001.jsonl`. `data/canonical/` is unchanged.

## Decisions

- **37 noun/determiner pairs:** within one canonical record, the glosses differ only by the nominalizer `것`. The noun gloss is retained; POS alone does not create a separate writer-facing meaning.
- **84 other same-lemma merges:** source glosses were compared together and merged where they describe one meaning axis, including destructive action and its abstract extension, equivalent historical office titles across periods, equivalent institutional closure senses across the 院/園 record split, and identical status/action definitions across records. Each merged gloss uses source wording to cover the included senses.
- **Two duplicate drops:** `w498155-s1` (`판`) is an exact same-lemma/POS/gloss duplicate of `w498126-s6`; `w365419-s1` (`필련`) is an exact same-lemma/POS/gloss duplicate of `w365418-s1`. Both drops are recorded with `reason: duplicate` and point to a retained sense.
- **Distinct axes retained:** examples include the physical, social, and psychological senses of `파도`; the different institutional and daily-closing senses of `폐원`; the physical and figurative senses of `폭발`; the water-wave and color senses of homographic `파랑`; and bird-wing versus fish-tail flapping senses. Similar wording or shared imagery alone was not sufficient to merge them.

## Review provenance and remaining work

The source-bound author pass and follow-up check were performed in this primary agent context. This is **agent self-check**, not independent first/second review or human editorial approval. The PR review process remains separate.

This pass commits the 121 selected merges and two duplicates; it does **not** claim that every remaining C18 multi-meaning group has received KEEP adjudication or that C18 has completed the two review stages in Issue #716. Unchanged rows retain their current state pending the remaining editorial review. Keep Issue #716 open until those reviews and any required follow-up edits are complete.

# Issue #764 C04 Meaning re-edit

## Scope and evidence

This is the C04 (ㄷ) source-bound self-check at baseline `417aaf0fd718c6b1695b177b685348cdd6205729`. The 30 C04 Meaning shards contained 21,202 lemmas and 29,644 one-sense Meaning rows. I reviewed all 3,880 multi-Meaning lemmas (12,322 source senses), including lemmas whose glosses have little textual overlap. The other 17,322 lemmas had one source sense each and could not be regrouped.

[`issue-764-c04-decisions.jsonl`](issue-764-c04-decisions.jsonl) records every reviewed lemma, its complete source sense IDs and parts of speech, and its full final KEEP/MERGE/DROP partition. Original glosses remain in canonical data at the recorded baseline; [`issue-764-c04.json`](issue-764-c04.json) contains each merged gloss and each adjudication.

| Measure | Before | After |
| --- | ---: | ---: |
| C04 lemmas | 21,202 | 21,202 |
| C04 canonical senses | 29,644 | 29,644 |
| C04 Meaning rows | 29,644 | 26,998 |
| Multi-Meaning lemmas reviewed | 3,880 | — |
| Lemmas with changed grouping or duplicate adjudication | — | 1,670 |
| Duplicate DROP rows | — | 8 |
| Repository adjudications | 117 | 125 |

MERGE combines 4,433 source senses into 1,795 Meaning rows, reducing the row count by 2,638. The eight DROP rows remove exact same-lemma, same-POS duplicate source senses; each surviving target remains represented. The 17,322 single-source lemmas are unchanged. Canonical JSONL is unchanged.

## Stage 2 feedback follow-up at the reviewed PR HEAD

The review identified concrete under-merges among same-record senses that the first self-check had left separate. I rechecked those canonical glosses and changed the source-preserving Meaning groups rather than relying on the prior KEEP decisions. The follow-up adds eleven merge groups across `던지다` (`w415145-s1..s12`), `돌다` (`w416923-s1..s22`), `돌리다` (`w411305-s1..s15`), `돌아가다` (`w413657-s1..s15`), `대다` (`w80022-s1..s17`), `당기다` (`w413558-s1..s4`), `더하다` (`w414967-s1..s4`), `덜다` (`w412339-s1..s2`), `대기` (the large-vessel senses `w78068-s1..s3` and atmosphere senses `w79004-s1/s2`), and `달` (`w413863-s1/s2`). These are physical-to-figurative, general-to-specific, or naturally metonymic uses of one lexical identity; unrelated senses in those lemmas remain separate. The existing `단` group was expanded to include `w74065-s1` with `w412736-s1/s2` and `w515246-s1`, whose exception, exclusivity, and “mere small amount” uses share a limiting function.

[`issue-764-c04-review-corrections.json`](issue-764-c04-review-corrections.json) records the exact before/after repartitions applied to the previous PR output. The updated primary spec remains the canonical-baseline replay spec. Replaying it with production `applyEdits` over the 3,880 reviewed multi-Meaning lemmas matched all 9,676 current Meaning rows exactly. This is a source-bound self-check, not an independent review; the separate review gate remains pending.

## Boundary decisions

- `등골` merges the back groove, vertebrae and spinal cord as connected uses of the same back/spine identity; the middle-ear ossicle remains separate.
- `디스크` groups audio/storage media separately from the spinal disc and colloquial disease use; the physical media and anatomical body part remain distinct.
- `당당` keeps the wide-eyed stare apart from a confident manner, despite identical spelling.
- `대기` merges the waiting, on-call and military standby uses as one waiting identity. Its Chinese and Joseon large military flag records also share one military-banner identity; the repeated Joseon definition is dropped against its live same-lemma target.
- Redirect-only senses such as `둠` → `못` / `늪` and `들매다` → `쩔쩔매다` / `헤매다` remain source-bound and are not merged with one another or rewritten.
- The duplicate DROP set includes identical noun/adjective senses repeated across same-lemma records, including the same-meaning records for `대의`, `동의`, and `대기하다`. The two `등` stem glosses that read alike remain attached to their separate plant senses because their local `「1」` references identify different source meanings.

Merged glosses concatenate the included canonical glosses without rewriting their individual descriptions, preserving each actual use and any source cross-reference wording. Meaning grouping and the wording of individual source glosses remain separate decisions.

## Provenance and review status

Semantic decisions and this audit are an **agent self-check** in the primary context against canonical source senses. They are not an independent first or second review, and they do not claim human editorial approval. Independent review remains pending under Issue #764. This audit does not close the parent issue.

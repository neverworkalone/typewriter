# Issue #764 C04 Meaning re-edit

## Scope and evidence

This is the C04 (ㄷ) source-bound self-check at baseline `417aaf0fd718c6b1695b177b685348cdd6205729`. The 30 C04 Meaning shards contained 21,202 lemmas and 29,644 one-sense Meaning rows. I reviewed all 3,880 multi-Meaning lemmas (12,322 source senses), including lemmas whose glosses have little textual overlap. The other 17,322 lemmas had one source sense each and could not be regrouped.

[`issue-764-c04-decisions.jsonl`](issue-764-c04-decisions.jsonl) records every reviewed lemma, its complete source sense IDs and parts of speech, and its full final KEEP/MERGE/DROP partition. Original glosses remain in canonical data at the recorded baseline; [`issue-764-c04.json`](issue-764-c04.json) contains each merged gloss and each adjudication.

| Measure | Before | After |
| --- | ---: | ---: |
| C04 lemmas | 21,202 | 21,202 |
| C04 canonical senses | 29,644 | 29,644 |
| C04 Meaning rows | 29,644 | 27,086 |
| Multi-Meaning lemmas reviewed | 3,880 | — |
| Lemmas with changed grouping or duplicate adjudication | — | 1,662 |
| Duplicate DROP rows | — | 8 |
| Repository adjudications | 117 | 125 |

MERGE combines 4,334 source senses into 1,784 Meaning rows, reducing the row count by 2,550. The eight DROP rows remove exact same-lemma, same-POS duplicate source senses; each surviving target remains represented. All other reviewed source senses remain in separate Meanings. The 17,322 single-source lemmas are unchanged. Canonical JSONL is unchanged.

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

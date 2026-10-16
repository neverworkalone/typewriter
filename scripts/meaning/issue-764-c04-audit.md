# Issue #764 C04 Meaning re-edit

## Scope and evidence

This is the C04 (ㄷ) source-bound self-check at baseline `417aaf0fd718c6b1695b177b685348cdd6205729`. The 30 C04 Meaning shards contained 21,202 lemmas and 29,644 one-sense Meaning rows. I reviewed all 3,880 multi-Meaning lemmas (12,322 source senses), including lemmas whose glosses have little textual overlap. The other 17,322 lemmas had one source sense each and could not be regrouped.

[`issue-764-c04-decisions.jsonl`](issue-764-c04-decisions.jsonl) records every reviewed lemma, its complete source sense IDs and parts of speech, and its full final KEEP/MERGE/DROP partition. Original glosses remain in canonical data at the recorded baseline; [`issue-764-c04.json`](issue-764-c04.json) contains each merged gloss and each adjudication.

| Measure | Before | After |
| --- | ---: | ---: |
| C04 lemmas | 21,202 | 21,202 |
| C04 canonical senses | 29,644 | 29,644 |
| C04 Meaning rows | 29,644 | 25,126 |
| Multi-Meaning lemmas reviewed | 3,880 | 1,887 |
| Lemmas with changed grouping or duplicate adjudication | — | 2,785 |
| Duplicate DROP rows | — | 8 |
| Repository adjudications | 117 | 125 |

MERGE combines 7,594 source senses into 3,084 Meaning rows, reducing the row count by 4,510. The eight DROP rows remove exact same-lemma, same-POS duplicate source senses; each surviving target remains represented. The 17,322 single-source lemmas are unchanged. Canonical JSONL is unchanged.

## Stage 2 feedback follow-up at the reviewed PR HEAD

The review identified concrete under-merges among same-record senses that the first self-check had left separate. I rechecked those canonical glosses and changed the source-preserving Meaning groups rather than relying on the prior KEEP decisions. The follow-up adds eleven merge groups across `던지다` (`w415145-s1..s12`), `돌다` (`w416923-s1..s22`), `돌리다` (`w411305-s1..s15`), `돌아가다` (`w413657-s1..s15`), `대다` (`w80022-s1..s17`), `당기다` (`w413558-s1..s4`), `더하다` (`w414967-s1..s4`), `덜다` (`w412339-s1..s2`), `대기` (the large-vessel senses `w78068-s1..s3` and atmosphere senses `w79004-s1/s2`), and `달` (`w413863-s1/s2`). These are physical-to-figurative, general-to-specific, or naturally metonymic uses of one lexical identity; unrelated senses in those lemmas remain separate. The existing `단` group was expanded to include `w74065-s1` with `w412736-s1/s2` and `w515246-s1`, whose exception, exclusivity, and “mere small amount” uses share a limiting function.

[`issue-764-c04-review-corrections.json`](issue-764-c04-review-corrections.json) records the exact before/after repartitions applied to the previous PR output. At checkpoint `e23b55533527cb16eb004f6b824ed68a04c969f0`, the primary spec replay matched all 9,676 Meaning rows for the 3,880 reviewed multi-Meaning lemmas. The subsequent same-record audit below updates that result. This is a source-bound self-check, not an independent review; the separate review gate remains pending.

## Stage 1 follow-up — complete same-record split audit

Stage 1 feedback on checkpoint `e23b55533527cb16eb004f6b824ed68a04c969f0` reported that the remaining same-record split risk set had not been re-evaluated. I reconstructed that set from the exact prior output at `2dd74bcc7d5def7c8d3eb712839c62c9264821f1`: **1,495 distinct lemmas**, each with at least one canonical record whose active senses appeared in multiple Meaning rows. The adjacent `대기하다` record was not counted because its only remaining active sense was already grouped with its duplicate target.

I compared all **5,741 canonical senses**, including each committed source gloss and part of speech, and recorded a source-bound KEEP/MERGE/DROP partition and candidate-specific rationale for every lemma. Seven existing duplicate drops in this candidate set remain attached to their original `duplicate_of` targets. The audit artifact records the baseline record-to-Meaning split, complete source senses, final groups, retained duplicate adjudications, and truthful primary-agent self-check provenance. It does not claim independent review or human approval.

The audit produces 3,448 final Meaning groups from 5,734 retained senses: 1,558 multi-sense groups and 1,890 singleton groups. **692 lemmas** retain more than one Meaning after review; the other reviewed candidates are not forced into one group when their source senses describe independent lexical identities. Against checkpoint `e23b55533527cb16eb004f6b824ed68a04c969f0`, 1,263 candidate lemmas change their sense partition and eight more retain their partition while correcting a gloss; 224 candidates already match the final source-bound result. The candidate output falls from 5,324 to 3,448 Meaning rows. Across all 30 C04 shards, the result has 21,202 lemmas, 25,122 Meaning rows, and 1,886 multi-Meaning lemmas.

[`issue-764-c04-same-record-audit.jsonl`](issue-764-c04-same-record-audit.jsonl) contains the complete 1,495-lemma source-bound record. [`issue-764-c04-review-corrections-002.json`](issue-764-c04-review-corrections-002.json) records exact before snapshots and output groups for the Stage 1 follow-up; [`issue-764-c04-review-corrections-003.json`](issue-764-c04-review-corrections-003.json) records the exact `0c67b62c9ab3c10a1e9870c7fb04369bf962e5ba` before snapshots and this Stage 2 follow-up. [`issue-764-c04-review-corrections-004.json`](issue-764-c04-review-corrections-004.json) records the exact `0cebf6816a1a8c6378e9431dca082f0a90c36db3` before snapshot for the Stage 1 follow-up on `도식적`. [`issue-764-c04-decisions.jsonl`](issue-764-c04-decisions.jsonl) and the canonical-baseline replay spec are updated from those decisions; production replay matches the edited Meaning shards.

## Stage 2 follow-up — experience, space/time and low-intensity extensions

The Stage 2 review found three context-transfer splits in the 1,495-lemma set. I compared the cited source glosses with the exact current Meaning memberships and checked the same-record candidates in those limited classes; this is a source-bound self-check of the raised classes, not a second full audit of all meanings.

- `당하다`: `w414033-s1/s4/s5` all describe undergoing harm, unwanted treatment or a bad event, so they now share one Meaning. `s2` (being placed in a time or circumstance) joins that experience frame. `s3` (facing and overcoming) and `s6` (handling work or responsibility) share a separate coping/management use. `s7/s8` remain together as correspondence and appropriateness.
- `당장`: `w414190-s1/s2/s3` now share the immediate deictic use spanning the exact place where an event happens and the time immediately after it. The unrelated shrine-servant and party-funeral records remain separate.
- `담담하다` and `담담히`: the six senses in each `w413991`/`w76370` record now share the restrained, low-intensity quality across calmness, objectivity, quiet flow, indifference and plain or refreshing taste. The separate `w76425-s1` deep-and-wide-water sense stays separate.

The class-limited comparison found the related `달래다`, `도살되다`, `당처`, `담백하다` and `담박하다` candidates already grouped across their experience, location or sensory extensions. This check did not automatically merge unrelated homonyms or other same-record candidates. The exact current before state and resulting groups for the four changed lemmas are recorded in `issue-764-c04-review-corrections-003.json`; original source glosses are preserved verbatim in each combined Meaning.

The audit rechecks the Stage 2 positive controls (`던지다`, `돌다`, `대다`, `단`) and preserves explicit boundaries such as the media-versus-spine distinction in `디스크` and the wide-eyed-versus-confident senses of `당당`. These are examples of source-bound decisions, not a rule to merge every same-record pair.


## Stage 1 follow-up — concrete-to-figurative schema extension

The follow-up review found a remaining same-record split in `도식적` (`w83863-s1..s4`). The first pair describes a diagram or schema that represents an object's structure, relations, or changes; the second describes the figurative tendency to force an object mechanically into a fixed form or schema. The source record itself pairs the noun and determiner forms for these two applications, and adjacent `도식주의적` and `도식화되다` entries preserve the same concrete/figurative connection. With no evidence of independent homonyms, the four senses now share one Meaning while all four source glosses remain verbatim. This corrects the earlier KEEP decision that treated literal and figurative application as separate lexical identities. The precise before state and replayable result are in `issue-764-c04-review-corrections-004.json`; the primary baseline replay spec and same-record audit carry the same final grouping. The updated C04 shards contain 25,121 Meaning rows across 21,202 lemmas, including 1,885 multi-Meaning lemmas; repository-wide validation passes with 490,602 meanings and 125 adjudications.

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

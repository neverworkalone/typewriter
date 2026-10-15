# Issue #716 C19 (ㅎ) source-bound edit pass

## Scope and result

C19 contains 34 meaning shards (`c19_001`–`c19_034`): 33,624 existing meanings covering 33,641 canonical sense references and 24,465 lemmas. The source-bound census found 4,825 lemmas with multiple meanings. This pass makes only edits supported by exact canonical evidence:

- 108 MERGE pairs: 97 noun/determiner pairs across 89 lemmas have source glosses that become byte-for-byte identical after removing only the noun nominalizer `것` or the determiner's attributive ending `의`; the `한의학적` noun/determiner pair (`w505373-s1`, `w505373-s2`) has an identical verbatim gloss. Ten additional pairs share one meaning axis across grammatical framing, a domain example, or the same object and counting unit; their source-bound decisions are recorded below.
- 11 DROP decisions in 10 duplicate groups: same-lemma, same-POS canonical senses have verbatim-identical glosses. Each dropped sense has a surviving `duplicate_of`; the canonical sense is not modified.

The resulting C19 area has 33,505 meanings, 33,630 referenced senses, and 11 adjudicated duplicate senses. The edit specification is `scripts/meaning/issue-716-c19.json`; it touches only C19 meaning shards and `data/adjudication/c19_001.jsonl`. `data/canonical/` remains unchanged.

## Noun/determiner evidence

Each of the 97 normalized pairs was checked within the same lemma: the canonical noun and determiner glosses differ only by `것` or `의`, with the rest of the source definition unchanged. The MERGE retains the noun-form gloss and keeps each separate definition axis separate. For example, `함축적`, `획일적`, `하향적`, `현실적`, `희극적`, `희망적`, `활동적`, and `한정적` each have multiple distinct noun/determiner pairs; the edit spec merges only the matched pairs, not all meanings of the lemma. The verbatim-identical `한의학적` pair is separately justified by its same-lemma source gloss.

## Other source-bound same-axis merges

- `현재` (`w505822-s2`, `w505822-s6`): both define the reference time as “기준으로 삼은 그 시점”; the adverb adds only the locative particle. The noun-form gloss preserves the shared time-point meaning.
- `한창` (`w502461-s1`, `w502461-s2`): both define the peak at which an event is most active or a state is most mature. The noun's “때” and adverb's “모양” are retained together in the representative gloss.
- `헝겁` (`w370107-s1`, `w370107-s2`): both describe confused, flurried behavior caused by intense delight; the source varies only between the action noun “짓” and adverbial “모양”. The representative gloss includes both forms.
- `항정선` (`w366825-s1`, `w366825-s2`): both define the same line crossing each meridian at an equal angle; the only difference is whether the route is an aircraft's or a ship's. The representative gloss names both vehicles.
- `항정선 항로` (`w366826-s1`, `w366826-s2`): both are routes following a rhumb line; only the vehicle (aircraft or ship) differs.
- `행` (`w372771-s1`, `w372771-s2`): the counted object is the same line of writing; one source sense names it and the other names its counting unit.
- `획` (`w385092-s1`, `w385092-s2`): the counted object is the same stroke or dot; one source sense names the mark and the other names its counting unit.
- `해` (`w365162-s2`, `w365162-s4`): both identify the same Earth-to-Sun orbital period; the latter explicitly uses that period as a counting unit.
- `호동` (`w369125-s1`, `w369125-s2`): both identify a dwelling divided by household number; the latter explicitly counts that same dwelling.
- `호` (`w369574-s1`, `w369574-s2`): both identify the house formed by a registered household; the latter explicitly counts that same house.

## Duplicate evidence

Every duplicate pair was checked against the canonical gloss, lemma, POS, and source relations. The same-lemma `direct` links corroborate the exact matches; for the `황어` pair, both senses link to the same canonical target sense.

| Lemma | Retained sense | Dropped sense(s) | Evidence |
| --- | --- | --- | --- |
| 형상 | `w370241-s1` | `w370242-s1`, `w503517-s1` | Same noun gloss; direct synonym links connect the records. |
| 호선 | `w380525-s1` | `w380526-s1` | Same noun gloss; reciprocal direct synonym link. |
| 홍도 | `w374744-s1` | `w501783-s3` | Same noun gloss; reciprocal direct synonym link. |
| 홍초 | `w378966-s1` | `w378967-s1` | Same noun gloss; direct synonym link. |
| 화각 | `w373722-s1`, `w373722-s2` | `w508206-s1`, `w508206-s3` | Each matching noun gloss has a direct synonym link to its retained sense. The distinct lens-angle sense remains. |
| 황어 | `w506300-s2` | `w518047-s1` | Same noun gloss; both link to `w486132-s2`. The distinct freshwater-fish sense remains. |
| 황황하다 | `w385829-s2` | `w507619-s1` | Same adjective gloss; reciprocal direct synonym link. |
| 황황히 | `w385830-s2` | `w385835-s1` | Same adverb gloss; reciprocal direct synonym link. |
| 회심곡 | `w380441-s1` | `w508237-s1` | Same noun gloss; direct synonym link. The second `회심곡` meaning remains. |

## Review provenance and remaining work

The source-bound author check and follow-up check were performed in this primary agent context. This is agent self-check, not independent first/second review or human editorial approval. The review process required by Issue #716 remains separate.

This pass does not claim that every C19 polysemy group has been adjudicated. Its census screened exact same-lemma/POS/gloss duplicates and narrowly defined noun/determiner equivalence; it did not inspect every multi-meaning lemma. The remaining groups are pending, and unchanged rows are not complete KEEP decisions. C19 must not be marked complete on the strength of this partial pass; Issue #716 remains open.

## Follow-up status — c19_001

On 2026-10-15, a source-bound pass reviewed the 142 non-pilot multi-meaning lemma groups in `c19_001`; the `하다` senses were already edited in the #715 pilot. The shard began with 983 meanings / 1,000 canonical sense references across 660 lemmas, including 517 single-source-sense singleton lemmas. After focused Stage 2 PR review corrections, 50 MERGE decisions (46 pairs and four three-sense groups) reduce the shard to 929 meanings while preserving all 1,000 source references. No new DROP was needed; the 11 prior C19 adjudications remain unchanged.

The follow-up audit is `scripts/meaning/issue-716-c19-001-audit.md`, with edits in `scripts/meaning/issue-716-c19-001.json`. The full C19 projection now has 33,451 meanings and 33,630 canonical sense references. Repository validation passed at 498,397 meanings / 33 adjudications. This completes authoring decisions for the `c19_001` shard only; the other C19 groups remain pending and Issue #716 stays open. The independent PR review stages remain required.


## Follow-up status — c19_002

On 2026-10-15, a source-bound pass reviewed all 119 multi-meaning lemma groups in c19_002; the 615 single-source-sense lemmas remain single-sense KEEP. The shard started with 1,001 meanings and 1,001 canonical sense references across 734 lemmas. It now has 967 meanings with all 1,001 references preserved after 34 MERGE decisions and no DROP decisions.

The audit is scripts/meaning/issue-716-c19-002-audit.md, with the reproducible edit specification in scripts/meaning/issue-716-c19-002.json. The full C19 projection now has 33,417 meanings and 33,630 canonical sense references; its 11 prior duplicate adjudications are unchanged. node scripts/meaning/validate.mjs passed with 497,018 meanings and 117 adjudications, and git diff --check passed. Canonical data remains unchanged.

Stage 2 review found that the `하송` and `하송하다` glosses narrowed the broader “send downward” source senses to an inferior recipient and an object. Both glosses and their audit rationale now state the general spatial direction first and keep the superior-to-subordinate object-sending condition within the honorific use. The 34 MERGE decisions, 967 meanings, 1,001 references, and 11 prior adjudications are unchanged. A focused comparison of all 34 merge glosses for narrower actor, recipient, or target constraints found no other affected group.

This completes authoring decisions for c19_002 only. Multi-meaning groups in the remaining C19 shards are still pending, and Issue #716 remains open. The independent PR review stages remain required.


## Follow-up status — c19_003

On 2026-10-16, a source-bound pass reviewed all 131 multi-meaning lemma groups in `c19_003`; the 612 single-source-sense lemmas remain KEEP. The shard started with 993 meanings and 1,001 canonical sense references across 743 lemmas. After applying the PR #750 feedback, it has 956 meanings with all 1,001 references preserved after 34 MERGE decisions and no DROP decisions. The initial candidate pass retained six proposed merges as KEEP after comparing their distinct financial role, age range, historical office, record medium/content, and dry-state/susceptibility meanings. Five additional pairs were separated after checking the distinct source referents/functions in `학익`, `학수`, `학려`, `한 치 앞을 못 보다`, and `학번`. A follow-up gloss review restored the `한계 주파수` source distinction between the minimum frequency and its corresponding incident/radiation energy; the 34-MERGE/956-meaning counts did not change. An existing pair of meaning rows for `하향적` remains split; each row already contains its noun/determiner source senses, and the general downward direction and downward-blooming plant trait remain distinct.

The audit is `scripts/meaning/issue-716-c19-003-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-003.json`. The full C19 projection now has 33,380 meanings and 33,630 canonical sense references; its 11 prior C19 adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,981 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_003 only. Multi-meaning groups in the remaining C19 shards are still pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_004

On 2026-10-16, a source-bound pass reviewed all 147 multi-meaning lemma groups in `c19_004`; the 574 single-meaning lemma groups retain their existing meanings except for eligible source-reference gloss edits. The shard started with 999 meanings and 1,003 canonical sense references across 721 lemmas. It now has 979 meanings with all 1,003 references preserved after 19 MERGE decisions covering 39 source senses, six direct cross-reference GLOSS EDITs, and no DROP decisions. Four source groups already merged at the base remain unchanged. No lemma overlaps another C19 shard.

Stage 2 review separated 한바다’s literal sea from its non-sea metaphor and 한숨’s brief time interval from rest or sleep. The edit spec, audit, and regenerated shard retain the four original singleton meanings. I rechecked the remaining 19 MERGE source groups against their canonical glosses for decisions based only on shared imagery or short duration and found no additional cases.

The audit is `scripts/meaning/issue-716-c19-004-audit.md`, with reproducible edits in `scripts/meaning/issue-716-c19-004.json`. Two malformed or unresolved cross-references remain held with no guessed gloss. The full C19 projection now has 33,360 meanings and 33,630 canonical sense references; its 11 prior C19 adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,961 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_004 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_005

On 2026-10-16, a source-bound pass reviewed all 145 multi-meaning lemma groups in `c19_005`; the 614 single-meaning lemmas retain their existing meanings. The shard started with 998 meanings and 1,001 canonical sense references across 759 lemmas. It now has 980 meanings with all 1,001 references preserved after 18 MERGE decisions covering 36 source senses and no GLOSS EDIT or DROP. Three already-grouped meanings in `한정적` and `한창` were preserved. The audit includes all source senses for both the 130 groups that still have multiple rows and the 15 groups reduced to one row.

The audit is `scripts/meaning/issue-716-c19-005-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-005.json`. The full C19 projection now has 33,342 meanings and 33,630 canonical sense references; its 11 prior duplicate adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,943 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_005 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_005 after PR #753

After PR #753 merged, the audit wording for the `한창` merge was updated to preserve the source frequency sentence that the described skin condition is common among people with higher body weight. The 18 MERGE decisions, 980 meaning rows, and 1,001 canonical references are unchanged. This is an audit clarification only.

## Follow-up status — c19_006

On 2026-10-16, a source-bound pass reviewed all 139 multi-meaning lemma groups in `c19_006`; the 616 single-meaning lemmas retain their existing meanings. The shard began with 996 meanings and 1,002 canonical sense references across 755 lemmas. It now has 955 meanings with all 1,002 references preserved after 41 MERGE decisions covering 82 senses, eight source-bound cross-reference GLOSS EDITs, and no DROP decisions. Six already-grouped meaning rows from the base remain intact. Three ambiguous cross-reference targets remain explicitly unresolved. The audit includes every source sense in the 139 multi-meaning groups and records each MERGE or KEEP decision.

The audit is `scripts/meaning/issue-716-c19-006-audit.md`, with reproducible edits in `scripts/meaning/issue-716-c19-006.json`. PR feedback led to separating `합집`'s general collection action from the book produced by publication and `합작품`'s literal collaborative work from its figurative use for a joint achievement. The other 41 MERGE decisions were rechecked for those result-object and literal/figurative boundaries; no further pair met those conditions. The feedback submission account matched the PR author and is not counted as independent review. The full C19 projection now has 33,301 meanings and 33,630 canonical sense references; prior adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,902 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_006 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_007

On 2026-10-16, a source-bound pass reviewed all 108 multi-meaning lemma groups in `c19_007`; the 683 single-meaning lemmas retain their meanings. The shard began with 993 meaning rows and 1,000 canonical sense references across 791 lemmas. It now has 967 meanings, preserving all 1,000 references, after 26 MERGE decisions covering 52 source senses, seven source-bound cross-reference GLOSS EDITs, and no DROP decisions. Seven existing grouped meanings from the base remain intact. The source audit records every canonical sense and KEEP/MERGE disposition in all 108 multi-meaning groups.

The audit is `scripts/meaning/issue-716-c19-007-audit.md`, with reproducible edits in `scripts/meaning/issue-716-c19-007.json`. The seven edits resolve exact cross-reference targets; `항간 → 행간02` remains held because its target entry has two senses and the source does not identify one. Stage 2 feedback identified that the general year-skipping senses of `해거리` and `해거리하다` are distinct from the tree fruit-bearing phenomenon; their source-bound base singleton meanings were restored. The other 26 MERGEs were checked for the same type of conflation and no additional case was found. The feedback account matches the PR author and is not counted as independent review. The full C19 projection now has 33,275 meanings and 33,630 canonical sense references; prior adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,876 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_007 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_008

On 2026-10-16, a source-bound pass reviewed all 147 multi-meaning lemma groups in `c19_008` (434 canonical sense references); the 566 single-meaning lemmas retain their existing meanings. The shard began with 998 meaning rows and 1,000 canonical sense references across 713 lemmas. It now has 948 meanings, preserving all 1,000 references, after 40 MERGE decisions covering 90 source senses (a net reduction of 50 meaning rows), 13 exact cross-reference GLOSS EDITs, and no DROP decisions. The two pre-existing grouped meanings in `해석적` are unchanged. No C19 shard has a lemma overlap with this shard. A Stage 1 review identified that the `해산미역` merge combined seaweed with a pejorative for a person; the merge was removed, both source senses were restored as KEEP meanings, and the audit rationale was corrected. A Stage 2 review also found and removed the same physical-dissection/abstract-analysis conflation in `해부`, `해부되다`, and `해부하다`; the other 40 merges were checked for this pattern with no additional case found. The `해석` gloss now preserves both the interpreting act and the interpreted content.

The complete source review is `scripts/meaning/issue-716-c19-008-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-008.json`. All 13 arrows resolve to exact canonical target senses; no sense binding changed. The full C19 projection now has 33,225 meanings and 33,630 canonical sense references; the 11 prior C19 adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,826 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_008 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.

## Follow-up status — c19_009

On 2026-10-16, a source-bound pass reviewed all 118 multi-meaning lemma groups in `c19_009` (348 canonical sense references); the 649 single-meaning lemmas retain their existing meanings except for exact cross-reference gloss edits. The shard began with 997 meaning rows and 1,000 canonical sense references across 767 lemmas. It now has 979 meaning rows, preserving all 1,000 references, after 17 MERGE decisions covering 35 source senses (a net reduction of 18 rows), ten exact cross-reference GLOSS EDITs, and no DROP decisions. Five cross-references remain held because the committed projection does not identify one target sense. No lemma overlaps another C19 shard.

The complete source review is `scripts/meaning/issue-716-c19-009-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-009.json`. The full C19 projection now has 33,207 meanings and 33,630 canonical sense references; the 11 prior C19 adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,808 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged.

This completes authoring decisions for c19_009 only. The remaining C19 shards are pending, and Issue #716 remains open. The independent PR review stages remain required.


## Follow-up correction — c19_009 audit

After PR #757 merged, the indexed “원말” summary in scripts/meaning/issue-716-c19-009-audit.md was corrected: 해자05 belongs to w369632-s1, and the omitted 해태04 reference belongs to w502809-s1. w502149-s1 remains a separate 해좌 meaning. This documentation correction changes no meaning data or edit decisions.

## Follow-up status — c19_010

On 2026-10-16, a source-bound pass reviewed the 145 multi-meaning lemma groups in `c19_010`; the other 564 single-meaning lemma groups retain their existing meanings except for exact cross-reference gloss edits. The shard began with 995 meaning rows and 1,000 canonical sense references across 709 lemmas. After review feedback, it has 940 rows, preserving all 1,000 references, after 45 MERGE decisions covering 100 source senses (a net reduction of 55 rows), 13 exact cross-reference GLOSS EDITs, and no DROP decisions.

The complete source review is `scripts/meaning/issue-716-c19-010-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-010.json`. Feedback led to keeping the two `행정 경찰` source senses separate because one denotes police personnel/organization and the other the policing action, and to making the `행혀나` gloss directly understandable without looking up `행여`. All 46 original MERGE decisions were rechecked for action/agent and place/action mismatches; after splitting `행정 경찰`, the other 45 remain. `향도` remains merged because its broader source sense explicitly includes both guiding and the guide person, while the second sense specifies the military guide role. No other mismatch in those categories was found. The feedback submission account matches the PR author and is not counted as an independent review.

The full C19 projection now has 33,152 meaning rows and 33,630 canonical sense references. `node scripts/meaning/validate.mjs` passed with 496,753 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged. This completes authoring decisions for `c19_010` only; remaining C19 work and Issue #716 stay open. Independent PR review stages remain required.

## Follow-up status — c19_011

On 2026-10-16, a source-bound pass reviewed all 149 multi-meaning lemma groups in `c19_011` (440 canonical sense references); the other 560 singleton lemma groups retain their meaning units except for exact source-bound cross-reference GLOSS EDITs. The shard began with 999 meaning rows and 1,005 canonical sense references across 709 lemmas. It now has 972 rows, preserving all 1,005 references, after 21 MERGE decisions covering 48 source senses (a net reduction of 27 rows), 22 GLOSS EDITs, and no DROP decisions. Six pre-existing grouped meanings remain intact. Five cross-reference targets remain held because the committed source projection does not identify one exact target sense; `허백당` was resolved to the historical `성현` sense whose source gloss names that pen name. No exact same-lemma, same-POS, same-source-gloss duplicates or cross-shard lemma overlaps were found.

The complete source review is `scripts/meaning/issue-716-c19-011-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-011.json`. The full C19 projection now has 33,125 meaning rows and 33,630 canonical sense references. `node scripts/meaning/validate.mjs` passed with 496,726 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged. This completes authoring decisions for `c19_011` only; remaining C19 work and Issue #716 stay open. Independent Stage 1 and Stage 2 PR reviews remain required.

## Follow-up status — c19_012

On 2026-10-16, a source-bound pass reviewed all 157 multi-meaning lemma groups in `c19_012` (387 canonical source senses). The other 612 single-meaning groups, covering 613 source senses, were checked; the existing grouped meaning for 헌신적 remains intact. The shard began with 999 meaning rows and 1,000 canonical sense references across 769 lemmas. It now has 974 rows, preserving all 1,000 references, after 25 MERGE decisions covering 50 source senses (a net reduction of 25 rows), 21 cross-reference GLOSS EDITs, and no DROP decisions. Ten cross-references remain held because the committed canonical projection does not identify an exact target sense. No C19 shard has a lemma overlap with this shard, and no exact same-lemma, same-POS, same-source-gloss pair was found.

The complete source review is `scripts/meaning/issue-716-c19-012-audit.md`, with reproducible edits in `scripts/meaning/issue-716-c19-012.json`. The full C19 projection now has 33,100 meaning rows and 33,630 canonical sense references. `node scripts/meaning/validate.mjs` passed with 496,701 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged. This completes authoring decisions for `c19_012` only; remaining C19 work and Issue #716 stay open. Independent Stage 1 and Stage 2 PR reviews remain required.

## Follow-up status — c19_013

On 2026-10-16, a source-bound pass reviewed all 126 multi-meaning lemma groups in `c19_013` (331 canonical source senses). The other 666 single-meaning lemma groups cover 669 source senses; their bindings were checked, and the three existing grouped rows for `헝겁`, `혁명적`, and `혁신적` remain unchanged. The shard began with 997 meaning rows and 1,000 canonical sense references across 792 lemmas. It now has 986 rows, preserving all 1,000 references, after 10 MERGE decisions covering 21 source senses (a net reduction of 11 rows), 26 source-bound GLOSS EDITs, and no DROP decisions. Ten cross-reference targets remain held because the committed canonical projection does not identify one exact target sense. No lemma overlaps another C19 shard.

The complete source review is `scripts/meaning/issue-716-c19-013-audit.md`, with the reproducible edit specification in `scripts/meaning/issue-716-c19-013.json`. The full C19 projection now has 33,089 meaning rows and 33,630 canonical sense references; the 11 prior C19 adjudications are unchanged. `node scripts/meaning/validate.mjs` passed with 496,690 meanings and 117 adjudications, and `git diff --check` passed. Canonical data remains unchanged. This completes authoring decisions for `c19_013` only; remaining C19 shards and Issue #716 stay open. Independent Stage 1 and Stage 2 PR reviews remain required.

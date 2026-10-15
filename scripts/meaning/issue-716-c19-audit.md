# Issue #716 C19 (ㅎ) source-bound edit pass

## Scope and result

C19 contains 34 meaning shards (`c19_001`–`c19_034`): 33,624 existing meanings covering 33,641 canonical sense references and 24,465 lemmas. The source-bound census found 4,825 lemmas with multiple meanings. This pass makes only edits supported by exact canonical evidence:

- 102 MERGE pairs: 97 noun/determiner pairs across 89 lemmas have source glosses that become byte-for-byte identical after removing only the noun nominalizer `것` or the determiner's attributive ending `의`; the `한의학적` noun/determiner pair (`w505373-s1`, `w505373-s2`) has an identical verbatim gloss. Four additional pairs share one meaning axis across grammatical framing or a domain example; their source-bound decisions are recorded below.
- 11 DROP decisions in 10 duplicate groups: same-lemma, same-POS canonical senses have verbatim-identical glosses. Each dropped sense has a surviving `duplicate_of`; the canonical sense is not modified.

The resulting C19 area has 33,511 meanings, 33,630 referenced senses, and 11 adjudicated duplicate senses. The edit specification is `scripts/meaning/issue-716-c19.json`; it touches only C19 meaning shards and `data/adjudication/c19_001.jsonl`. `data/canonical/` remains unchanged.

## Noun/determiner evidence

Each of the 97 normalized pairs was checked within the same lemma: the canonical noun and determiner glosses differ only by `것` or `의`, with the rest of the source definition unchanged. The MERGE retains the noun-form gloss and keeps each separate definition axis separate. For example, `함축적`, `획일적`, `하향적`, `현실적`, `희극적`, `희망적`, `활동적`, and `한정적` each have multiple distinct noun/determiner pairs; the edit spec merges only the matched pairs, not all meanings of the lemma. The verbatim-identical `한의학적` pair is separately justified by its same-lemma source gloss.

## Other source-bound same-axis merges

- `현재` (`w505822-s2`, `w505822-s6`): both define the reference time as “기준으로 삼은 그 시점”; the adverb adds only the locative particle. The noun-form gloss preserves the shared time-point meaning.
- `한창` (`w502461-s1`, `w502461-s2`): both define the peak at which an event is most active or a state is most mature. The noun's “때” and adverb's “모양” are retained together in the representative gloss.
- `헝겁` (`w370107-s1`, `w370107-s2`): both describe confused, flurried behavior caused by intense delight; the source varies only between the action noun “짓” and adverbial “모양”. The representative gloss includes both forms.
- `항정선` (`w366825-s1`, `w366825-s2`): both define the same line crossing each meridian at an equal angle; the only difference is whether the route is an aircraft's or a ship's. The representative gloss names both vehicles.

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

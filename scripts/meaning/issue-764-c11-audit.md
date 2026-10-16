# Issue #764 C11 meaning boundary audit

## Scope and evidence

This is the C11 source-bound self-check for Issue #764, based on `origin/master` at `1ca8deb3e32f50b82be6e749b916b9ea755605c9`. The audit reads every canonical C11 record and sense together with the current #716 Meaning rows. The executable decision record is [`issue-764-c11.json`](issue-764-c11.json): it contains exact `before` snapshots and a final group for every C11 lemma, including lemmas whose grouping is retained.

| Measure | Before | After |
| --- | ---: | ---: |
| C11 canonical records | 2,120 | 2,120 |
| C11 lemmas | 2,006 | 2,006 |
| C11 canonical senses | 2,725 | 2,725 |
| C11 Meaning rows | 2,660 | 2,155 |
| C11 lemmas with multiple canonical senses | 373 | 373 |
| C11 single-sense lemmas explicitly retained | 1,633 | 1,633 |
| C11 lemmas whose Meaning count changed | — | 281 |
| Repository adjudications | 117 | 117 |

Every canonical C11 sense occurs in exactly one final group. The edit has no drops and appends no adjudications. Canonical JSONL is unchanged. The complete `before`/`groups` mapping provides the source-sense membership for all 2,006 lemmas; the application checks exact current snapshots and complete, non-overlapping sense coverage before writing.

## Boundary decisions

- `쌀쌀하다` (`w455618-s1`, `w455618-s2`) is one Meaning: physical coldness in weather or wind and coldness in a person's disposition share the cold core. Its representative gloss covers both.
- `싸이다` separates `w214500-s1`, the causative of defecating/urinating, from `w454438-s1..s4`, the covering, enclosing, being surrounded by a situation, and social-envelopment uses. `쌔다` follows the same boundary for its `싸이다` short forms and keeps `쌓이다` short forms in their accumulation family.
- `쐐기질` and `쐐기질하다` combine literal wedging with the figurative act of intruding between people: inserting a wedge and inserting oneself to obstruct are a direct metaphorical extension. The separate `쐐기(를) 박다` use that means making a firm commitment remains distinct from the interference group.
- `쓸리다` has three groups. Friction and abrasion (`w208548-s1`, `w208801-s2`, `w455256-s1`) share rubbing contact; sweeping, transferring, crowding, or being carried across (`w208562-s1..s2`, `w208801-s1`, `w208801-s3..s5`) share a sweeping movement; leaning to one side (`w454100-s1`) has no such contact or movement evidence and remains separate.
- `쌈박` and its repeated forms keep cutting sounds separate from blinking. The matching expressive form alone does not establish one lexical identity. The same boundary is used for `씀벅`/`씀뻑` forms: repeated blinking and a pricking, stinging sensation remain separate because neither action is a natural extension of the other.
- Clear independent identities remain separate, including the two `쌍계사` temples, the mill part and dog called `쌀개`, the obligation and paired-dance senses of `쌍무`, and the linguistic, musical, and astronomical senses of `쌍성`.
- Context and grammatical role do not create a split by themselves. For example, `쌓다`/`쌓이다` keep the physical piling, accumulated foundations or experience, and repeated/intensified auxiliary use together through the accumulation core; `쓰다` still separates burial, game-piece movement, bitter/unpleasant experience, writing, covering or bearing, use/spending, and the independent “도리에 맞는 바른 상태” sense.

## Follow-up: complete multi-Meaning re-audit on PR #766

After review `5542036285` on PR #766 (HEAD `8611c1fcc32c35c831343cd243dd727c97de88e5`), I reopened every one of the 102 lemmas that still had multiple Meaning rows, checked all 393 bound canonical senses and their POS/glosses, and revised the full repartition spec. This was a source-bound self-check in the primary agent context. The spec now has an exact `before` snapshot and final source-sense partition for all 2,006 C11 lemmas; `apply-edits.mjs` validates complete, non-overlapping coverage before writing.

| Follow-up measure | PR HEAD | Re-audited result |
| --- | ---: | ---: |
| C11 Meaning rows | 2,155 | 2,127 |
| Previously multi-Meaning lemmas reviewed | 102 | 102 |
| Canonical senses in those lemmas | 393 | 393 |
| Meaning rows for those lemmas | 251 | 223 |
| Lemmas now represented by one Meaning | — | 15 |
| Lemmas that retain distinct Meaning groups | — | 87 |
| Lemmas with a changed Meaning-row count in this follow-up | — | 24 |

The four substantive reviewer examples were checked against their exact source bindings. `쐐기` (`w211904-s1`, `w211904-s2`) now groups the two moth-larva descriptions under the shared caterpillar category while retaining the wedge-tool group. `쎄리깐` (`w214782-s1`, `w214782-s2`) now groups police station and substation as facility subtypes. `쌕쌕거림` (`w512341-s1`, `w512341-s2`) now groups the two rough-breathing sounds. `썰렁썰렁하다` (`w452544-s1`, `w452544-s4`) now groups the cool breeze and chilly state. The related verb lemmas `쌕쌕거리다` (`w214514-s1`, `w214514-s2`) and `쌕쌕대다` (`w214515-s1`, `w214515-s2`) already bound both senses to one Meaning each on the reviewed HEAD, so no edit was needed there.

The audit did not treat a shared broad category or a repeated form as sufficient evidence to merge. It retained the following multi-group boundaries after comparing the actual bound meanings; within a listed lemma, the exact merged groups and source IDs are in the executable spec.

| Lemma(s) | Source-bound reason for retaining distinct groups |
| --- | --- |
| `싸개`, `싸개질`, `싸개질하다` | Wrapping materials/actions, infant excretion, and a crowd's quarrel are separate targets; only the two wrapping uses are grouped. |
| `싸다` | Excretion, enclosing/wrapping (including the kindling bundle), the five fast/forceful adjective uses, and low price/appropriate or light punishment are four meaning families. The adjective uses share a quick/strong quality across the source examples. |
| `싸이다`, `쌔다` | The causative of excretion differs from enclosure and social/atmospheric surrounding. `쌔다` also retains the separate accumulation family from `쌓이다`. |
| `싸지르다` | Roaming, setting a fire, and vulgar excretion have different actions and source roots. |
| `싹` | The noun for a sprout and its “beginning/sign” extensions differs from the adverbial cutting/wiping and complete-removal uses; the latter are grouped as action and result. |
| `싹을 밟다` | Suppressing a new undertaking and noticing a sign describe opposite outcomes, not one idiom sense. |
| `쌀개` | A mill component and a dog are homonyms with different referents. |
| `쌀쌀` | Slow simmering, warming, crawling, and head movement form a gentle, gradual-motion family; abdominal pain is a bodily sensation and stays separate. |
| `쌈` | Leaf-wrapped food, the short form of “싸움,” count units for bundled needles/textile, and the gold-weight unit have distinct referents. The two bundle-count uses are grouped. |
| `쌈박`, `쌈박쌈박`, `쌈박쌈박하다`, `쌈빡`, `쌈빡쌈빡`, `쌈빡쌈빡하다` | Cutting soft material and blinking are different physical actions; expressive sound similarity does not establish a shared meaning. |
| `쌍` | The paired drum rhythm and pair/count senses share a two-part pairing; the anger expletive is unrelated. |
| `쌍가마`, `쌍견`, `쌍계`, `쌍계사` | Paired scalp whorls, a cooking pot, and a horse palanquin; a cocoon and shoulders; a topknot and twin chicks; and two separately located named temples have distinct referents. |
| `쌍구`, `쌍구법` | The outline-copying/engraving/painting techniques are grouped; the three-finger brush grip is a different action. |
| `쌍권총` | Literal pistols and student slang for two failed courses share the numeral but the source gloss provides no lexical bridge beyond “two.” |
| `쌍글하다`, `쌍동` | A smiling verb and a cross-reference to `쌍그렇다` differ; cutting and twin children also have unrelated actions/referents. Redirect senses remain bound as supplied. |
| `쌍무`, `쌍미`, `쌍봉`, `쌍서` | Mutual contractual duties versus paired dance; beautiful things/people versus eyebrows; gymnastics apparatus versus phoenixes versus mountain peaks; and a double consonant versus living as a pair are distinct source targets. The two “beautiful” senses of `쌍미` are grouped. |
| `쌍성`, `쌍수`, `쌍시`, `쌍아` | Phonological initial consonants, reed-pipe sound, binary stars; sleeves, dual number, Buddhist trees, hands; persimmon versus historical market; and eyebrows, tonsillitis, paired plant shoots denote different domains. Within `쌍수`, the two dual-number senses and the two paired-tree senses are grouped. |
| `쌍일`, `쌍주`, `쌍청`, `쌍현` | The intensified form of `상일` differs from calendar even/yin days (the latter are grouped); paired pillars versus silk; a painting versus paired voices; and a bowstring illusion versus a two-string instrument have distinct meanings. |
| `쌕쌔기`, `쌤` | A redirect to `쌕쌕이` differs from the named insect; a construction jamb, mine shaft, and slang for `쌤통` have different referents. |
| `쌩쌩하다`, `씽씽하다`, `씩씩하다` | Sound-producing motion differs from freshness/vigor; for `씽씽하다`, wind/object/cicada sounds are grouped. Strength/dignity differs from panting in `씩씩하다`. |
| `써내다`, `써레`, `써리다` | A redirect to peeling differs from writing/submitting; a coastal shell-and-seaweed scraper differs from a paddy harrow; peeling/cutting differs from harrowing. |
| `썩`, `썩썩`, `썩정이`, `썰다` | Cutting/sweeping/chewing sounds and their removal result differ from “very” and “quickly”; `썩썩` keeps “quickly” apart from its grouped cutting/rubbing sounds. A rotten object differs from the redirect to `삭정이`; harrowing differs from cutting with a blade. |
| `썰렁썰렁하다` | Cool breeze and chilly state are grouped; boiling water and arm/tail movement are separate actions. |
| `썸벅`, `썸벅썸벅`, `썸뻑`, `썸뻑썸뻑` | Cutting sounds differ from redirects to blinking or prickling forms; the redirect bindings are preserved rather than normalized into a new sense. |
| `쏙` | The adverbial movement/state-change family differs from the crustacean name. |
| `쐐기`, `쐐기(를) 박다[치다]`, `쐬벌이` | The wedge/tool family differs from the grouped moth-larva subtypes; a firm assurance differs from interference/disruption in the idiom; earning money and theft are not treated as one action merely because both are slang. |
| `쑥`, `쑥대머리`, `쑥방망이` | A gullible person/action, movement/state-change adverb, and mugwort plant are separate; disheveled hair differs from the pansori title; the plant differs from the rice-cake tool. |
| `쓰`, `쓰다`, `쓰렁쓰렁`, `쓰리` | A Japanese city differs from a Morse dash; `쓰다` retains burial, game-piece movement, bitter/unpleasant state, writing, covering/bearing, use/spending, and “proper state” groups; secrecy, perfunctory work, and estrangement are distinct; an ice-fishing tool differs from the redirect to pickpocket. |
| `쓰이다`, `씌다`, `씌우다` | Writing, covering, and use/cause families remain distinct; ghost possession in `씌다` is separate from the covered/written/used roots. |
| `쓱싹`, `쓴술` | Sawing/filing sound differs from dishonest handling or miscalculation; the mel-rice wine term differs from bitter medicinal wine. |
| `쓸다`, `쓸리다` | Sweeping/rubbing/dragging/spreading and gathering uses share physical sweep/contact extensions, but the Buddhist chant is a separate noun. `쓸리다` also keeps abrasion, sweep/displacement, and tilting as three groups because tilt lacks the contact/movement evidence of the others. |
| `씀벅거리다`, `씀벅대다`, `씀벅씀벅`, `씀벅씀벅하다`, `씀벅이다`, `씀뻑거리다`, `씀뻑대다`, `씀뻑씀뻑`, `씀뻑씀뻑하다`, `씀뻑이다` | Repeated blinking is a visible action; prickling/stinging in the eye or flesh is a bodily sensation. They remain separate across these related lexical forms. |
| `씨` | The interjection, weaving thread, part-of-speech term, surname/honorific/pronoun, and seed/source metaphor are separate; the related address/pronoun senses and the seed/metaphorical-source senses are grouped internally. |
| `씨룩` | Redirects to `씰긋` and `씰룩` describe different facial motions and remain distinct. |

The 15 lemmas reduced to one Meaning in this re-audit are `ㅆ`, `싸라기`, `싹싹`, `쌍어`, `쌔물거리다`, `쌔물대다`, `쌔물쌔물`, `쌔물쌔물하다`, `쌕쌕거림`, `썩썩거리다`, `썩썩대다`, `썩은 새끼로 범[호랑이] 잡기`, `쎄리`, `쎄리깐`, and `쏘아`. These groupings preserve a shared lexical core: letter/sound, rice grain/ice pellet, cut-and-remove action/result, source-backed paired-fish metaphor, smiling/coy conduct, respiratory sound, related cut/rub sounds, two outcomes of one proverb, same slang target class, or command/action under that command.

Three candidate merges from an early pass were deliberately not retained after this full comparison: `쌍권총` literal pistols vs student slang, `쐬벌이` money-making vs theft, and `썩썩` quickness vs sound. A shared numeral, broad activity category, or adverbial form alone did not establish a source-supported natural extension. The final spec also keeps the literal “quickly” sense of `썩썩` separate while grouping its two cutting/rubbing sound senses.

## Gloss checks

Merged glosses lead with the shared image or action, then state the important extension. The review corrected several inherited or overbroad drafts during this pass: `쌍그렇다` and `쌀쌀히` no longer mention senses absent from their source bindings; `쏙`/`쏙쏙` and `쑥`/`쑥쑥` now state an in/out or movement/change core rather than unrelated lists; and accumulation, abrasion, pouring, and falling glosses were tightened to preserve the core relation. Cross-reference source senses remain bound and are not silently rewritten in canonical data.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the repository's canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. The independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C11 PR and does not close the overall issue.

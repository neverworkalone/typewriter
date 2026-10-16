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

## Gloss checks

Merged glosses lead with the shared image or action, then state the important extension. The review corrected several inherited or overbroad drafts during this pass: `쌍그렇다` and `쌀쌀히` no longer mention senses absent from their source bindings; `쏙`/`쏙쏙` and `쑥`/`쑥쑥` now state an in/out or movement/change core rather than unrelated lists; and accumulation, abrasion, pouring, and falling glosses were tightened to preserve the core relation. Cross-reference source senses remain bound and are not silently rewritten in canonical data.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the repository's canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. The independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C11 PR and does not close the overall issue.

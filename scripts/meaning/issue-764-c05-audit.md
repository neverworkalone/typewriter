# Issue #764 C05 Meaning boundary audit

## Scope and evidence

This is the source-bound self-check for C05 (`ㄸ`) on the exact `origin/master` base `417aaf0fd718c6b1695b177b685348cdd6205729`. I read the complete set of canonical C05 records and senses together with the existing Meaning rows for each lemma. The executable decision record is [`issue-764-c05.json`](issue-764-c05.json): it contains an exact `before` snapshot and a complete, non-overlapping final sense partition for every C05 lemma, including unchanged one-sense lemmas.

| Measure | Before | After |
| --- | ---: | ---: |
| C05 canonical records (STDICT) | 2,505 | 2,505 |
| C05 lemmas | 2,317 | 2,317 |
| C05 canonical senses | 3,505 | 3,505 |
| C05 Meaning rows | 3,347 | 2,483 |
| Lemmas with more than one Meaning | 465 | 117 |
| Lemmas whose final partition changed | — | 411 |

The source-bound boundary review covered all 465 lemmas that had multiple Meaning rows and all 77 lemmas that had multiple canonical senses grouped under one Meaning (542 lemmas total). The other 1,775 C05 lemmas each had one canonical sense and one Meaning and retain that binding. The complete spec has 2,317 repartitions; 411 final partitions differ from their recorded `before` boundaries. All 3,505 canonical senses remain assigned exactly once. There are no drops and no adjudication changes. The net Meaning reduction is 864 rows.

The representative gloss was rewritten for each newly combined Meaning group; existing glosses were retained when a final group exactly matched its recorded `before` row. Canonical JSONL is unchanged. Applying the complete spec to a clean archive of the exact base completed with 494,261 total repository meanings and 117 adjudications. The resulting SHA-256 values of `c05_001.jsonl` through `c05_004.jsonl` match the current worktree exactly.

This is an **agent self-check in the primary context**, not an independent review. Issue #764 still requires independent first- and second-pass reviews; those remain pending for the PR. This audit does not claim completion of Issue #764.

## Follow-up audit after Stage 2 findings

The Stage 2 findings were checked against the exact canonical sense texts and the Issue #764 boundary contract. I accepted the identified under-merges and the source-usage omissions. The previous source-bound audit had correctly treated source membership as structural evidence, but had not kept enough original wording in several high-risk representative glosses.

- `뜯다` now groups `w414673-s1..s9`; its gloss includes each bound source use, including blood-feeding (`s6`), the chest-aching use (`s8`), and extorting money (`s9`). `뜯어내다` groups `w98200-s1..s3`. `뜯기다` groups the three causative and five passive senses across `w98196` and `w414502`, including the extortion use.
- `떠나가다` groups the movement and hyperbolic “주위가 떠서 나갈 듯이” sound use. `뚝뚝` groups the physical dropping/breaking uses with falling grades/ranks and spatial separation. `뚝` groups its abrupt stopping, dropping, lowering and separation uses with the matching drop/break/hit/detach sound family; the cross-reference to `둑` stays separate.
- `뜻하다` groups intention, prior thought and having a meaning. `뜻있다` groups intention, an implicit circumstance and value/merit. Both glosses retain the source formulations.
- `딱` and `딱딱` now group the snap/break sound with abrupt stopping, firm contact, exact fit and related manner uses. The glosses retain every source use, including displeasure and sudden encounters. This decision is based on the shared sharp contact/snap and cutoff uses, not sound resemblance alone. `딱지` now groups covering/crust uses with attached marks, cards, tickets, documents and figurative labels; the gloss states those uses individually.
- `떡판` now groups the oil-press board, rice-cake boards, flat-body/face extensions and the food-board good-fortune metaphor. The common board/flat-shape image is present in the source wording.
- `떨치다` groups shaking something off, abandoning thoughts/honor/desire, and making fame or reputation widely known. The source senses explicitly share the honor/reputation axis; the gloss preserves all three uses.
- The same movement/result review grouped all six source uses for each of `뜰먹거리다`, `뜰먹대다`, `뜰먹이다`, `뜰먹뜰먹`, and `뜰먹뜰먹하다`. The five `딸막*` controls already grouped their six corresponding uses; their glosses now also retain the rising-price and throbbing-wound uses verbatim.
- Other same-record follow-ups grouped the printing/pattern and video-copy uses of `뜨다` (`w419350`), perception/visibility uses of `뜨이다` and its short form `띄다`, fermentation/swelling uses of `뜨다` (`w98122`), the clump/softness figurative uses of `떡`, and the same-age variants of `띠동갑`. `딸깍발이` retains both person references together because the source’s wooden-clog name image extends from the poor scholar to the Japanese-person use. The sound-making/button/bird/insect redirects under `딱따기` remain separate because the source does not establish a shared lexical identity from sound similarity alone.
- `따먹다`, `땅파기`, `떡달이`, `똑따기`, `떡을 치다`, `딸딸이` (bell/vehicles), and `똥차` were also checked against the actual source meanings and their figurative or naming links. Their resulting glosses preserve the original usages. Canonical and adjudication files remain unchanged.

### Same-record split census

The Stage 2 review identified 43 canonical records across 40 lemmas whose senses were still assigned to multiple Meanings. After this source-bound follow-up, 28 of those records are now within one Meaning; 15 records across 15 lemmas remain split. Each remaining split was rechecked against its bound source senses. The retained boundaries are:

| Lemma / record | Remaining distinction | Source-bound reason for KEEP |
| --- | --- | --- |
| `딱따기` / `w96682` | Button; bird; grasshopper redirects | The redirects identify different lexical items; the shared clicking/pecking sound alone does not establish one word identity. |
| `딴꾼` / `w418201` | Police helper who catches thieves versus violent/unprincipled person | The source provides no shared role or figurative path beyond both referring to people. |
| `딸딸이` / `w418205` | Bell and rattling vehicles/bicycles grouped versus masturbation slang | The first group has a repeated clatter/motion naming link; no source-bound link joins the sexual slang. |
| `떡` / `w97292` | Rice-cake/food family versus slang for drugs (`s4`) | Food, bait, bread and the explicit rice-cake figuratives are grouped; the drug slang has no source-supported food/texture extension. |
| `똘똘하다` / `w97760` | Intelligent/clever versus physically solid/sturdy | Cognition and physical soundness are distinct source meanings without a demonstrated extension. |
| `똘똘히` / `w418474` | Intelligent/clever versus physically solid/sturdy | The adverbial source uses distinguish mental sharpness from physical firmness; neither wording establishes the other. |
| `똥` / `w416752` | Feces/ink/metal residue versus gold slang and a Hanafuda card | The residue senses are grouped; the two slang/card references are independent labels in the source. |
| `똥집` / `w97348` | Large intestine/stomach versus body weight (`s2`) | The two digestive-organ senses are grouped; the weight slang has no source-bound link to either organ. |
| `뚱보` / `w415203` | Surly, unsociable person versus overweight person | The source points to separate characterizations, with no lexical extension between them. |
| `뜨다` / `w419352` | Slowness/dullness versus spatial distance/long duration | Sluggish action and distance/duration are distinct source concepts without a demonstrated extension. |
| `뜨르르` / `w100616` | Fluent/unimpeded action and rapid rumor-spread are grouped; ostentatious/clamorous use remains separate | The first two share fluent movement/spread; the source does not connect that manner to the showy/clamorous sense. Their separate rolling-sound records also remain distinct. |
| `뜨르르하다` / `w418940` | Fluent/unimpeded action and rapid rumor-spread are grouped; ostentatious/clamorous use remains separate | The adjective repeats the same split: the first two form a fluent-spread family, while the source does not connect it to the showy/clamorous sense. |
| `뜰뜰` / `w419339` | Rolling-wheel sound versus force/order being carried out | The source does not connect the sound to implementation of authority. |
| `뜸팡이` / `w98503` | Yeast/fungus versus enzyme | Their use in food production overlaps, but the source defines different biological entities and roles. |
| `띵띵` / `w99399` | Swollen/solid/intense state uses versus string-twang sound | The state cluster has a coherent tension/fullness axis; a plucked-string sound is a distinct use without a source-supported extension. |

### Gloss-coverage risk cohort and adversarial check

I rechecked the 46 preexisting Meaning groups with at least five bound senses, then expanded around the demonstrated compression defect. Where a compact summary hid an actual source use, the representative gloss now retains the original source formulations rather than relying on a broad umbrella phrase. This includes `떨어지다` (`w98003-s1..s27`), `떼다` (`w418583-s1..s17`), `떨어뜨리다`/`떨어트리다`, `떨구다`, `따다`, both `떨다` families, all four `뚫다`/`뚫리다`/`뚫어뜨리다`/`뚫어트리다` families, `뜨다` (`w414491`, `w419352`), `딱`/`딱딱`, `떡`/`떡떡`, `따르르`, and the ten `뜰먹*`/`딸막*` groups. In particular, the revised source wording makes the prior examples `w418583-s5` (wholesale purchase for trade) and `w418583-s17` (fortune telling with hwatu) visible in the same Meaning gloss.

The follow-up Stage 2 review found that the earlier fix to `m99271` still compressed four of its other 15 source uses: `w99383-s2` (work in a particular capacity), `w99383-s3` (colloquial “run away”), and `w414830-s7/s8` (swinging and seesawing). The revised gloss now preserves all 15 bound source glosses, including those four and the other 11 uses. The focused manual regression `scripts/meaning/issue-764-c05-gloss-coverage.test.mjs` confirms the prior compact gloss misses the four cited senses and the current spec/output retain each of the 15 canonical source formulations. This is a source-bound regression for this demonstrated omission, not a general string-based semantic validator.

The separate adversarial cases `w414673-s8` (a bound source use can be omitted from its gloss) and `w414673-s9` (a related extension can be split while structural coverage still passes) remain relevant. `땅`'s land/soil versus impact-sound senses and `땀`'s sweat/effort versus stitch senses remain negative controls for over-merging. These examples expose distinct editorial failure modes; none mechanically determines other lemmas' boundaries.

## Validation and limits

- The updated spec has an exact `before` snapshot and assigns each of the 3,505 C05 senses exactly once; it introduces no drops or adjudication edits.
- The latest spec was replayed from the clean archive of base `417aaf0fd718c6b1695b177b685348cdd6205729`: `apply-edits` reported 2,317 repartitions and 0 drops, and all four generated C05 shard hashes matched the worktree.
- `node scripts/meaning/validate.mjs` and the focused C05 gloss-coverage regression pass. Clean-worktree `ci:normal` is run after the intended edits are committed. The independent Stage 1/2 review markers from earlier HEADs are stale and require fresh review on the new HEAD; this self-check does not claim either review gate has passed.

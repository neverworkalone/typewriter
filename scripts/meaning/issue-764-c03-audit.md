# Issue #764 C03 Meaning boundary audit

## Scope and evidence

This is the C03 (ㄴ) source-bound self-check for Issue #764, based on `origin/master` at `d209ecd2a57cb52df5274abf92675084c6a92ffe`. It re-judged every C03 lemma with multiple current Meaning rows (or an already grouped Meaning) against that lemma's full canonical record and sense set: 2,552 lemmas and 7,326 current Meaning rows. The executable decision record is [`issue-764-c03.json`](issue-764-c03.json). It records the exact `before` rows and a complete final partition for each of the 1,835 changed lemmas. The other 717 candidates retain their current groupings and glosses; single-Meaning lemmas are untouched.

| Measure | Before | After |
| --- | ---: | ---: |
| C03 lemmas | 13,691 | 13,691 |
| Canonical C03 senses in Meaning rows | 18,465 | 18,465 |
| C03 Meaning rows | 18,465 | 15,735 |
| Candidate Meaning rows across re-judged lemmas | 7,326 | 4,596 |
| Multi-Meaning lemmas re-judged | 2,552 | — |
| Lemmas whose grouping changed | — | 1,835 |
| Multi-Meaning lemmas retained as is | — | 717 |
| New repository adjudications | 0 | 0 |

Every canonical C03 sense remains in exactly one Meaning. No sense is dropped and no adjudication is added. Canonical JSONL is unchanged. `apply-edits` checked each changed lemma against its exact current snapshot and wrote the recorded full partition.

## Boundary decisions

- Merge the contextual, grammatical, concrete/abstract, and figurative uses of one lexical identity when the source senses show a natural extension. Examples include `내리다` (one verb's downward movement, lowering, descent, reduction, and conventional extensions), `놓다` (placing/releasing through its established concrete and idiomatic uses), `높다`/`높이` (height across spatial, quantitative, evaluative, and grammatical uses), and `너울` (a face-covering veil and its figurative use for outward appearance).
- Preserve multiple real uses in the gloss rather than replacing the source distinctions with a narrow shared abstraction. For example, `눈` groups the eye, sight, judgment, gaze, typhoon center, and plant bud uses; ruler marks, net openings, and Go intersections form another group, while falling snow and the independent shoe ornament remain separate.
- Group a word's closely related category or conventional-use variants where the source supports one identity. `날라리` groups the unreliable, flighty person and slapdash work senses, while its specific “기둥서방” sense and the separate fishing-item and brass-instrument entries stay apart. `노양` groups the two source senses for the Yijing “old yang” concept but keeps the unrelated term for a woman past marrying age separate.
- Keep different referents and action axes apart even when the spelling, context, or source record is shared. Examples retained separately include `남천정`'s two distinct historical military formations, `노등` as a street lantern versus a historical lantern festival, `넘보다` meaning to look down on someone versus to covet something, `내물` as an object inside versus an object sent from the palace, and `내차` as a secret loan versus an early payment. `남양` groups the Pacific-region and Pacific-Ocean uses but keeps the Yangtze-south region, local place names, and cross-reference record separate.
- Cross-reference senses remain bound to their own source senses; a redirect such as `논풀` → `갈풀` is not rewritten into the target lemma. Canonical record and sense boundaries remain available in the source data even where their uses share one Meaning.

## Gloss checks

Each grouped gloss was compared with every canonical source gloss bound to it, including alternate usages and distinct action/event dimensions. Single-sense groups retain their current gloss unless the complete repartition explicitly changes their grouping. The edit spec and output were checked for missing, duplicated, or foreign sense IDs; the repository Meaning validator passed.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. Issue #764 remains open; this shard audit is evidence for its review process and does not close the overall issue.


## PR Stage 1 blocker follow-up — repeated group glosses

On PR #785 HEAD `943182e682865fdcfe2da78c4c3f814532427758`, the Stage 1 review `PRR_kwDOUOHJZ88AAAABSoSqVg` identified identical composite glosses reused across distinct Meaning groups. I checked all changed `groups` in the C03 edit specification and confirmed 26 affected lemmas, then compared the bound senses with their canonical glosses. The first PR output had 15,745 C03 Meaning rows; this correction merges ten connected usage groups and results in 15,735 C03 Meaning rows (4,596 rows across the re-judged candidate lemmas). No canonical sense is dropped and no adjudication is added.
The exact-baseline replay completed all 1,835 repartitions and produced 491,487 corpus meanings with 117 adjudications. `node scripts/meaning/validate.mjs`, `git diff --check`, and a targeted check that all 26 edited spec partitions exactly match their shard sense bindings and have no repeated group gloss passed. Canonical and adjudication data remain unchanged.

| Lemma | Source-bound resolution |
| --- | --- |
| `낙수` | Kept the fallen-ear/after-story, Buddhist pleasure, dance gesture, and eaves/paddy-water meanings separate; each gloss now describes only its bound group. Other `낙수` meanings were unchanged. |
| `난` | Kept the mythical bird/bell and printed page/column meanings separate. |
| `난계` | Kept disorder/chaotic sequence separate from orchid-fragrance friendship and its gathering. |
| `난도` | Kept difficult road/degree of difficulty separate from indiscriminate beating or cutting. |
| `난문` | Kept biological micropore separate from difficult text, question, or problem. |
| `난발` | Kept reckless shooting/issuing separate from luxuriant blooming or clear appearance. |
| `난발하다` | Kept reckless shooting/issuing separate from blooming or becoming evident. |
| `난방` | Kept room heating/warmed room separate from orchid fragrance, virtue, and the figurative orchid-scented chamber. |
| `난봉` | Kept the mythical-bird and figurative excellence/friendship/marital-harmony uses separate from profligate conduct or its practitioner. |
| `난장` | Kept the corporal punishment, orchid-like writing/letter, special market/stall, and chaotic gathering/examination-ground groups distinct; each received a group-scoped gloss. |
| `난전` | Kept unlicensed stalls separate from the empress's or king's palace. |
| `난행` | Kept difficulty/arduous practice separate from violent, disorderly, or obscene conduct. |
| `난행하다` | Kept acting violently/disorderly/obscenely separate from being difficult or arduous. |
| `날다` | Merged fading/dispersal/evaporation with flight, rapid movement, and colloquial escape as connected “move or dissipate away” uses; kept the distinct textile-warping action separate. |
| `날름` | Kept the adverbial quick flick/movement separate from the mechanical valve, trigger, or membrane senses. |
| `넘다` | Merged physical crossing, exceeding time/limits/capacity, overcoming difficulty, overflow, and over-grinding the blade into one connected “pass beyond” Meaning; kept the distinct Go connection sense separate. |
| `넘어가다` | Merged tipping/crossing with transfer, transition, passing time or situations, exceeding a limit, and passing over a problem; other senses were unchanged. |
| `넘어뛰다` | Merged physical jumping with overcoming difficulty, skipping a sequence, and exceeding a range or standard. |
| `넘어서다` | Merged physical crossing with passing beyond a standard, limit, difficulty, or time; kept the distinct “mind/opinion inclines” sense separate. |
| `넘어오다` | Merged tipping/crossing this way with people, things, rights, work, order, or time moving this way; other senses were unchanged. |
| `넣다` | Merged putting into a space/range with mixing or inserting among other things; the remaining distinct verb uses were unchanged. |
| `노기` | Kept crossroads/choice separate from seasoned or late-blooming vitality. |
| `느리다` | Merged slow movement/work and lengthened sound with weak force or a mild, unsharp disposition; kept the separate loose-weave sense. |
| `늘어지다` | Merged physical stretching/drooping with loss of bodily energy and slowing; separate extension-of-time/space and carefree senses were unchanged. |
| `능금` | Kept patterned silk bedding/sliding door separate from the small apple-like fruit. |
| `늦추다` | Merged delaying a time, slowing a tempo, loosening something, and easing tension as connected ways of making something later, slower, or less tight. |

The remaining unique-gloss groups in these lemmas retain their recorded partitions. This source-bound author self-check does not replace or relabel the independent PR review. Canonical data and adjudications remain unchanged; Issue #764 remains open.


## PR Stage 2 blocker follow-up — same-record verb over-splitting

On PR #785 HEAD `7fdb43bc9660ba11145a20925f24d712e530612a`, the Stage 2 review identified three concrete under-merges: `녹다` (`w408835-s1..s11`), `넣다` (`w406793-s1..s14`), and `늘어지다` (`w410211-s1..s6`). I compared every cited source gloss with the edit's exact `before` rows and accepted the finding: these are connected uses of one verb, not independent homonyms. I merged each connected set and wrote one gloss retaining all bound source uses.

To bound the related-risk check, I enumerated C03 standard-dictionary entries having at least four all-verb senses from one canonical record, currently split across at least three Meaning rows. The pre-fix output contained 11 such entries. I source-checked all senses in that cohort, merged the connected uses below, and preserved independent same-lemma records in the negative controls. The same query returns zero remaining entries in this defined cohort after replay; it is not a census of every C03 lexical judgment.

| Lemma | Source-bound resolution |
| --- | --- |
| `녹다` | Merged verb senses `w408835-s1..s11`, including melting/dissolving, bodily and emotional loosening, loss, flavor, absorption/disappearance, intoxication, and infatuation. Kept the independent tea-noun record `w67524-s1` separate. |
| `넣다` | Merged `w406793-s1..s14` as the same verb of putting/adding/including: spatial and range placement, mixing/inserting, membership, machine operation, bank deposits, engraving, third-party insertion, document submission, force, stoking a fire, newspaper delivery, and planting. |
| `늘어지다` | Merged `w410211-s1..s6`: physical lengthening/drooping and their bodily, temporal/spatial, speed, and relaxed-state uses. |
| `높이다` | Merged `w68572-s1..s15` as the causative use of raising/increasing, including pitch/loudness, strength of an opinion, status, reputation, and honorific treatment. |
| `넘기다` | Merged `w411059-s1..s11` as causing something to pass over, through, or to another party, including time, obstacles, pages, hair, falling, swallowing, transfer, overflow, and a missed shot. |
| `넘어가다` | Merged `w408063-s1..s15` as one verb of tipping, crossing, transfer, and passage, retaining the source's sunset, page-turning, death, temptation, swallowing, voice, and neglect uses in the gloss. |
| `놀리다` | Merged the seven causative uses `w407520-s1..s7` of `놀다` (play, idle time, rest, unused resources, body movement, tool use, and careless speech). Kept the independent mocking record `w69050` and re-washing record `w407350` separate. |
| `날리다` | Merged `w407593-s1..s7` and passive use `w407794-s1` under the same flight/dispatch verb, including physical movement, fame, loss, careless completion, and a directed smile. |
| `넘어오다` | Merged `w65136-s1..s7` as movement or transfer toward this side/current time, including a tilted object, a moved heart, and something rising through the throat. |
| `놓이다` | Merged `w409425-s1..s7` as passive/state uses of `놓다`: placement/installation, a set trap, inserted material or ingredients, and worries or tension being released. |
| `넘겨보다` | Merged `w509707-s1..s4` as looking over or toward something, extending to interest, desire, and inference. |

The manual checkpoint `issue-764-c03-editorial-checkpoint.manual.mjs` records old-snapshot-fails/new-output-passes cases for all 11 groups, checks the source-linked gloss signals, and retains negative controls for eye/snow `눈`, the distinct `낙수` identities, `난계` disorder/friendship, the tea-noun `녹다`, and `놀리다`'s independent records. It is intentionally outside the CI registry and is run directly. `node scripts/meaning/validate.mjs` remains the complete structural/sense-coverage check. The 54 additional merges reduce C03 from 15,735 to 15,681 Meaning rows. The final replay contains 491,433 corpus meanings and 117 adjudications; no canonical or adjudication data changed, and Issue #764 remains open.

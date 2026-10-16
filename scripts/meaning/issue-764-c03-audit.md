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

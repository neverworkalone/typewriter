# Issue #764 C03 Meaning boundary audit

## Scope and evidence

This is the C03 (ㄴ) source-bound self-check for Issue #764, based on `origin/master` at `d209ecd2a57cb52df5274abf92675084c6a92ffe`. It re-judged every C03 lemma with multiple current Meaning rows (or an already grouped Meaning) against that lemma's full canonical record and sense set: 2,552 lemmas and 7,326 current Meaning rows. The executable decision record is [`issue-764-c03.json`](issue-764-c03.json). It records the exact `before` rows and a complete final partition for each of the 1,835 changed lemmas. The other 717 candidates retain their current groupings and glosses; single-Meaning lemmas are untouched.

| Measure | Before | After |
| --- | ---: | ---: |
| C03 lemmas | 13,691 | 13,691 |
| Canonical C03 senses in Meaning rows | 18,465 | 18,465 |
| C03 Meaning rows | 18,465 | 15,745 |
| Candidate Meaning rows across re-judged lemmas | 7,326 | 4,606 |
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

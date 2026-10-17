# Issue #764 C08 Meaning audit

## Scope and evidence

This is the primary-agent, source-bound self-check for Issue #764's C08 (ㅂ) range. The edit spec re-partitions all **5,982 lemmas that had multiple Meanings** at baseline, covering **17,968 canonical senses**. The companion [`issue-764-c08-audit.jsonl`](issue-764-c08-audit.jsonl) records each lemma’s pre-edit Meaning IDs, bound canonical sense IDs/POS, source record identity, final Meaning IDs/groups, candidate-specific working notes, and the resulting agent self-check decision. The edit spec and generated shard contain the corresponding source and final gloss text. The remaining **24,636 single-Meaning rows** were not repartitioned.

- Baseline head: `6f37ba315daa77a5dfe4974d39721c0919bf7937`.
- C08 Meaning rows: 42,590 before; 36,482 after.
- Repartitioned lemmas: 5,982; baseline Meaning rows: 17,954; final groups for them: 11,846.
- Final output includes 24,636 untouched singleton rows; all 30,618 C08 lemmas remain represented.
- The final groups contain each of the 17,968 affected canonical sense IDs exactly once. No canonical JSONL, adjudication, or DROP changed.
- The full C08 canonical source is the committed `data/canonical/` projection. For STDICT headword/Hanja metadata, the self-check also used the local cached snapshot dated 2026-09-06; this was not a live API query. No raw cache/API response is included.

This is **agent self-check only** (`independent: false`, `human_reviewed: false`). Issue #764's independent Stage 1 and Stage 2 reviews remain separate and are not claimed complete.

## Boundary decisions

The pass treats source record/sense numbers, part of speech, field, literal/figurative status, and referent differences as evidence to assess rather than automatic split rules. It joins natural extensions of one lexical identity and preserves unrelated homonyms, people, places, distinct Hanja compounds, and unrelated cross-references. Each final group retains its bound canonical sense IDs; the final Meaning glosses are recorded in the generated C08 shards and edit spec.

Representative controls include `보이다`/`뵈다` (one lexical identity across grammatical and honorific use); `방지` and `배제` (distinct source-bound Hanja compounds stay apart); `불사하다` (不仕 “not take office” and 不辭 “not decline” remain separate); `비화` (the 飛火 spark and its spreading-consequence use merge, while other Hanja homonyms stay apart); and `비트` (the bound `beat` senses are checked against the distinct hideout, beet plant, and data-unit words rather than merged by spelling alone). For `보다`, seeing, reading, inspection, care, consideration, experience, and trial uses group by natural extension, while divination, exam-taking, provisioning, bodily/sexual euphemisms, trade, reliance, grammatical auxiliaries, and the comparative particle remain split.

Earlier working notes may contain the word “HOLD”; those labels marked questions before this source-bound recheck. Every entry in the ledger has `review_state: resolved-source-bound-agent-self-check`, the bound canonical evidence, final groups, and a final outcome. Earlier working notes remain visible as context, not as the current review state. `보다` now has 25 final groups: 10 groups join source uses with a shared lexical axis, while the independent senses and comparative particle remain separate; every source gloss is retained in its final group. The three last reviewed boundaries are `빙장`/`빙장하다` (氷藏 general ice storage and fish preservation are one storage family; 聘丈 stays apart), `빚거간` (broker service/person and the `빚지시` cross-reference are one occupational/service concept), and `빛발`/`빛살` (ordinary and technical light-ray descriptions are one beam/path concept). The final source-bound recheck also separates `분열하다`’s 分列 and 分裂 identities, keeps distinct `불순`/`불신` Hanja families apart, groups the related `不退` Buddhist non-retreat forms, and separates `빙빙`’s dizziness sense from circling/roaming.

## Cross-record follow-up

The initial PR head had 588 repartitioned lemmas with a final Meaning group spanning multiple canonical source records. A source-ID check of the bound canonical glosses and recorded `source_original` where present confirmed 15 overmerges, which are corrected in the spec, audit ledger, and generated Meaning shards:

- The review-confirmed `반납`, `반납하다`, and `반과` boundaries now keep 返納/半納 and 飯果/飯菓/飯顆 identities separate.
- Ten additional compound boundaries now remain separate: `방공` (防共/防空), `방패` (方牌 vs 防牌/旁牌), `방화대` (防火帶/防火隊), `방랑기` (放浪氣/放浪記), `보강` (補強/補講), `병기하다` (竝起/竝記), `반류` (反流/伴流), `반심` (叛心/半心), `반주` (伴奏/伴走), and `반항` (反抗/反航).
- Two Korean-transcription entries also keep distinct named referents separate: the `발렌슈타인` play and historical commander, and the `베크렐` unit and physicist.

After the initial 15 corrections, 573 cross-record groups remained. A focused sibling-form scan found 29 derived lemma rows across 27 base stems where a `-하다` or `-되다` group crossed source records and the bare lemma separated the corresponding source identities. The scan compared the bound canonical senses and recorded `source_original`; it generated candidates for editorial assessment rather than treating Hanja differences as automatic splits. The follow-up corrected 12 more affected lemmas: the six new Stage 2 cases `반송`, `반송되다`, `반송하다`, `방공하다`, `반항하다`, and `반주하다` (24 source senses); four clear derivative mismatches in `반행하다`, `보강하다`, `복장하다`, and `불사하다`; and the previously recorded KEEP/final-group contradictions in `반상` and `반상하다`. Within each compound family, the final groups preserve the same-record extensions for 伴送/搬送/返送, and tests assert the `반송되다` direct relation projects only to the 返送 Meaning.

The remaining 563 cross-record groups still include plausible same-identity extensions; this follow-up does not claim an independent semantic review of all remaining groups. The checked sibling candidates that remain joined include broad state change in `변성`, recompense in `보상`, and division/scattering uses in `분단` and `분산`, based on their bound glosses rather than Hanja alone. `scripts/meaning/contract.test.mjs` checks corrected source-ID boundaries, same-record positive controls, exact spec-to-output replay, audit decisions against final groups, audit baseline/count parity, and the actual relation projection endpoints and provenance. This is author self-check evidence, not independent review, and the remaining 563 groups stay open to independent review.

## Limits and review status

No live dictionary API or external AI reviewer was used. Source Hanja checks used the local STDICT cache snapshot noted above. This audit does not substitute for the independent reviews required by Issue #764.

# Issue #220 — M9-B historical recovery checkpoint

## Scope and selection

This checkpoint re-opened the first 40 numeric M5-13 Typewriter-authored fit reserves from the pinned Issue #210 historical inventory. The earlier M5 fit/reserve result sets lineage and review order only. Every row received a fresh Issue #220 decision and passed the shared source-bound producer, semantic audit, admission, and exact-search boundary before an admitted record entered canonical data.

The two independent review slices contain 20 rows each. There was no admission or relation quota. A held row remains in the target inventory with its unresolved lexical-unit or sense-boundary basis; it is not counted as a canonical recovery.

## Outcome

| Measure | Result |
| --- | ---: |
| Reviewed | 40 |
| Admitted and searchable | 18 |
| Held for unresolved lexical or sense boundaries | 22 |
| Rejected | 0 |
| Duplicates | 0 |
| Search collisions | 0 |
| Corrected | 0 (0.0% of reviewed) |
| Relations added | 0 |
| Admitted with zero relations | 18 |

| Batch | Reviewed | Admitted | Held | Rejected | Duplicate | Collision | Corrected |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 13 | 7 | 0 | 0 | 0 | 0 |
| 2 | 20 | 5 | 15 | 0 | 0 | 0 | 0 |

## Candidate dispositions

| Order | Batch | Inventory | Lemma | Decision | Lexical-unit status | Canonical ID |
| ---: | ---: | --- | --- | --- | --- | --- |
| 1 | 1 | m5-2153 | 악의 | included | supported | w5384 |
| 2 | 1 | m5-2154 | 질투심 | included | supported | w5385 |
| 3 | 1 | m5-2155 | 미움 | included | supported | w5386 |
| 4 | 1 | m5-2156 | 미운 정 | held | unresolved | — |
| 5 | 1 | m5-2157 | 싫증 | included | supported | w5388 |
| 6 | 1 | m5-2158 | 싫증남 | held | unresolved | — |
| 7 | 1 | m5-2159 | 권태감 | included | supported | w5390 |
| 8 | 1 | m5-2160 | 무기력 | included | supported | w5391 |
| 9 | 1 | m5-2311 | 단절 | included | supported | w5392 |
| 10 | 1 | m5-2312 | 잔여 | included | supported | w5393 |
| 11 | 1 | m5-2314 | 흔들림 | included | supported | w5394 |
| 12 | 1 | m5-2315 | 정돈 | included | supported | w5395 |
| 13 | 1 | m5-2316 | 뒤섞임 | included | supported | w5396 |
| 14 | 1 | m5-2317 | 배치 | included | supported | w5397 |
| 15 | 1 | m5-2318 | 배경 | held | unresolved | — |
| 16 | 1 | m5-2319 | 전경 | included | supported | w5399 |
| 17 | 1 | m5-2473 | 손끝의 저림 | held | unresolved | — |
| 18 | 1 | m5-2474 | 손끝의 온도 | held | unresolved | — |
| 19 | 1 | m5-2475 | 발바닥의 감각 | held | unresolved | — |
| 20 | 1 | m5-2476 | 발목의 긴장 | held | unresolved | — |
| 21 | 2 | m5-2477 | 피부의 소름 | held | unresolved | — |
| 22 | 2 | m5-2478 | 살갗의 떨림 | held | unresolved | — |
| 23 | 2 | m5-2479 | 몸속의 진동 | held | unresolved | — |
| 24 | 2 | m5-2480 | 몸에 밴 냄새 | held | unresolved | — |
| 25 | 2 | m5-2633 | 골목 안쪽 | held | unresolved | — |
| 26 | 2 | m5-2634 | 시장 입구 | held | unresolved | — |
| 27 | 2 | m5-2635 | 역 앞 | held | unresolved | — |
| 28 | 2 | m5-2636 | 학교 뒤 | held | unresolved | — |
| 29 | 2 | m5-2637 | 병원 옆 | held | unresolved | — |
| 30 | 2 | m5-2638 | 공원 한쪽 | held | unresolved | — |
| 31 | 2 | m5-2639 | 집 앞 | held | unresolved | — |
| 32 | 2 | m5-2640 | 집 뒤 | held | unresolved | — |
| 33 | 2 | m5-2811 | 믿다 | included | supported | w5416 |
| 34 | 2 | m5-2812 | 망각하다 | included | supported | w5417 |
| 35 | 2 | m5-2813 | 되새기다 | included | supported | w5418 |
| 36 | 2 | m5-2814 | 새겨두다 | held | unresolved | — |
| 37 | 2 | m5-2815 | 기다려주다 | held | unresolved | — |
| 38 | 2 | m5-2817 | 다가와주다 | held | unresolved | — |
| 39 | 2 | m5-2818 | 떠나가다 | included | supported | w5422 |
| 40 | 2 | m5-2819 | 떠나보내다 | included | supported | w5423 |

## Historical checkpoint

The pinned Issue #210 candidate inventory contains 584 classified rows. After the 18 M9-B admissions and 20 later M9-D historical recoveries, 507 historical rows remain potentially recoverable. Added to the current 10,009 canonical records, they yield a bounded source-pool ceiling of 10,516, 4,516 above 6,000. This is a source-pool limit, not a reason to admit held rows or reconstruct absent candidates.

| Remaining Issue #210 disposition | Count |
| --- | ---: |
| admit-candidate | 228 |
| duplicate | 2 |
| hold | 251 |
| invalid-lemma | 2 |
| needs-sense-split | 28 |
| not-a-lexical-unit | 10 |
| search-surface-collision | 1 |
| unsupported-scope | 0 |
| wrong-pos | 0 |
| Recovered in the current inventory | 62 |

Current canonical totals: 10,009 records (9,967 starts and 42 reference-only records), 10,271 senses, 487 relations, and 10,266 canonical search-form rows. Relation-empty searchable records: 9,673.

| Record type | Records |
| --- | ---: |
| entry | 8855 |
| expression | 1154 |

Sense POS distribution:

| POS | Senses |
| --- | ---: |
| adjective | 474 |
| adverb | 9 |
| expression | 1176 |
| noun | 7250 |
| verb | 1362 |

Direct exact lemma coverage: 10009/10009; non-searchable records: 0. Exact search-form owner keys: 10266/10266; missing owners: 0; unexpected owners: 0; cross-record collision keys: 0.

| Surface-form regression | Included forms | Excluded forms | Result |
| --- | --- | --- | --- |
| 되새기다 (w5418) | 되새기는, 되새긴, 되새길 | 되새겼다 | pass |
| 떠나보내다 (w5423) | 떠나보내는, 떠나보낸, 떠나보낼 | 떠나보냈다 | pass |

## Defect tracking and shared fixes

| Defect class | Count | Batches | Affected candidate IDs | Resolution |
| --- | ---: | --- | --- | --- |
| Historical lexical-unit fixedness is not established by the retained source | 21 | 1, 2 | w5387, w5389, w5400, w5401, w5402, w5403, w5404, w5405, w5406, w5407, w5408, w5409, w5410, w5411, w5412, w5413, w5414, w5415, w5419, w5420, w5421 | Held by the shared source-bound lexical-unit contract; no row-specific admission exception was added. |
| Authored topic-span analysis was omitted from the shared production evidence projection | 1 | 1 | w5399 | Fixed in the shared projection so authored topic_analysis and topic_analyses reach the exact-span semantic audit. |
| A fresh one-sense gloss combined distinct sentence frames and writer routes | 1 | 1 | w5398 | Kept the candidate held until separately reviewed senses are authored; the shared frame-and-route gate requires a genuine writer-route difference, not a different argument frame alone. |
| Two admitted verb senses needed explicit M6-3 surface-form decisions | 2 | 2 | w5418, w5423 | Added sense-bound authored classifications/exclusions to the shared M6-3 review source; the common projection gate remains fail-closed. |

| Shared fix area | Batches | Files | Fix |
| --- | --- | --- | --- |
| single-sense writer-boundary admission | 1, 2 | scripts/validate/lexical-quality.mjs, scripts/batch/authored-semantic-decision-source.mjs | The shared source-bound gate requires exact-gloss frame spans and compares sentence frames together with writer routes; unresolved splits stay held until a multi-sense candidate is authored. |
| historical candidate materialization | 1, 2 | scripts/batch/lexical-production.mjs | The common producer accepts explicit historical inventory identities and retains source positions when a pinned source pool is split into bounded review batches. |
| authored semantic evidence projection | 1 | scripts/batch/validate-issue-211.mjs | The common producer projects authored topic_analysis and topic_analyses into the shared semantic evidence for the exact reviewed span, including w5399. |
| surface-form decision coverage | 2 | data/validation/m6-3-surface-form-review.json | Added sense-bound M6-3 decisions for the two admitted verb senses whose regular inflection or open-vowel past projection needed explicit review; the shared projection remains fail-closed. |

Normal CI: `npm run ci:normal` — pending for canonical digest `4b5c39c3944439f7a667ba0090a8cb52a5cf95bc38d82d52eac47f4142c18432`.
Extension/Web parity is covered by the normal CI product builds and output-contract validation: pending.

## Reproduction

Run `npm run batch:issue-220:check` to verify the frozen selection and input digests, both 20-row source-bound reviews, ordinary shared production and semantic audit, promotion/seed/canonical parity, direct search, deterministic SQLite output, and this report. Run `npm run batch:issue-220:report` after an authorized input change to regenerate this Markdown and the machine checkpoint.

The frozen pre-recovery canonical, seed, and Issue #210 inventory snapshots are project-authored data. No external dictionary or corpus material was added.

# Issue #210 — Historical exclusion recovery inventory

Generated from the machine inventory at `data/inventory/issue-210-recovery-inventory.json`. The generator builds a temporary SQLite database and checks current canonical search coverage without changing canonical records.

## Scope and policy

The current invariant from Issues #207–#209 is: every valid lexical entry within Typewriter's supported scope may serve as a searchable start. Historical roles and decisions remain recorded as history; they do not determine current search eligibility. This report inventories current unresolved candidates and records Issues #219/#220's separately validated dispositions for bounded reserve slices. Issue #221's corpus-derived admissions are audited separately and do not enter the historical M5 recovery pool. Relation counts are not admission quotas.

The audit screened all 1,562 M5 target rows, joined all 100 Issue #204 decisions (90 map to M5 rows; 10 admitted rows are tracked separately), audited 10,864 promotion ledger events, traced 4 corrected M5-3 policy cases, and checked all current reference-only records. The M1–M4 pilot tables and handoffs do not preserve a complete standalone rejected/deferred candidate ledger. No unavailable ephemeral drafts or external raw material were reconstructed.

## Counts

Issue #219 result: 20 reviewed; 0 admitted, 10 held, and 10 rejected as compositional phrases. Issue #220 result: 40 reviewed; 18 recovered, 22 held, and 0 rejected. Issue #221 result: 20 bounded corpus candidates reviewed; 11 admitted, 9 held, and 0 rejected. Its 11 source-bound promotion events are included in the ledger audit.

| Measure | Count |
| --- | ---: |
| Recovery candidate records classified | 584 |
| Issue #204 records already admitted and searchable | 10 |
| Current canonical records | 12,312 |
| Current non-searchable lexical records | 0 |
| Current reference-only records, now searchable | 42 |
| Confirmed active usefulness/generality exclusions (#204) | 0 |
| Historical policy-rejection events, including later holds/corrections | 31 |
| True duplicate proposals | 2 |
| Invalid inflected-form proposals | 2 |
| Confirmed non-lexical proposals | 10 |
| Search-surface collisions | 1 |
| Explicit unresolved sense/POS/context cases | 204 |
| Additional rationale or lexical-unit holds | 75 |
| Unsupported lexical categories | 0 |
| Exact canonical search keys checked | 12,569 |

The 31 historical policy-rejection events include 25 Issue #204 rejects re-reviewed in Issue #211 (24 recovered and searchable, one held for an unresolved sense boundary), two M5-10A2 rejections that later became holds for lexical boundaries, and four M5-3 rejections later corrected and included in M5-7. No Issue #204 row remains an active usefulness/generality exclusion. The two M5-10A2 holds retain their blockers, and the four corrected cases are already searchable. M5's seven “insufficient admission priority” rejections and 20 generic M5-12A rejects remain on hold because their durable rationale does not establish a specific usefulness-only reason or lexical invalidity. The inventory also preserves 11 earlier M5 reject-to-hold transitions; two are the mixed utility cases counted above, while the others retain identity, sense, phrase, or context blockers.

All 12,312 current canonical records resolve directly. Their 12,569 canonical lemma/search-form keys have no missing owner, unexpected owner, or cross-record collision. This includes 42 historical reference-only records (41 entries and 1 expression); all their current lemmas resolve by the same canonical ID.

## New review states

| State | Count |
| --- | ---: |
| `admit-candidate` | 228 |
| `duplicate` | 2 |
| `hold` | 251 |
| `invalid-lemma` | 2 |
| `needs-sense-split` | 28 |
| `not-a-lexical-unit` | 10 |
| `recovered` | 62 |
| `search-surface-collision` | 1 |

`admit-candidate` means eligible for fresh bounded review, not admitted. It includes 194 remaining M5-13/14/15 capacity reserves, 35 older capacity-deferred rows whose authored candidate body must be recovered, and 19 open M5 candidates. Issue #219 reviewed 20 of the original 254 reserves; Issue #220 separately reviewed 40 M5-13 reserves and recorded 18 recoveries plus 22 unresolved lexical-unit holds. Issue #211 recovered 24 of the 25 mandatory Issue #204 candidates; the remaining candidate is held for a source-bound sense split. Holds preserve unresolved identity, context, sense, lexical-unit, or historical-rationale questions. The 20 generic M5-12A rejects are not called non-lexical: their candidate-specific lexical-unit status is unresolved. No proposed POS or record type falls outside the current supported category set.

## Mandatory Issue #204 rejects

The full historical rationale and follow-up are retained in the JSON inventory.

| #204 ordinal | Lemma | Proposed POS | Current canonical coverage | New review state |
| ---: | --- | --- | --- | --- |
| 4 | 없다 | adjective | canonical-lemma-present | `recovered` |
| 6 | 사람 | noun | canonical-lemma-present | `recovered` |
| 15 | 많다 | adjective | canonical-lemma-present | `recovered` |
| 24 | 만들다 | verb | canonical-lemma-present | `recovered` |
| 34 | 동안 | noun | canonical-lemma-present | `recovered` |
| 35 | 내다 | verb | no-canonical-lemma-match | `needs-sense-split` |
| 38 | 필요 | noun | canonical-lemma-present | `recovered` |
| 39 | 처음 | noun | canonical-lemma-present | `recovered` |
| 44 | 다음 | noun | canonical-lemma-present | `recovered` |
| 46 | 지금 | noun | canonical-lemma-present | `recovered` |
| 52 | 친구 | noun | canonical-lemma-present | `recovered` |
| 60 | 그때 | noun | canonical-lemma-present | `recovered` |
| 70 | 오늘 | noun | canonical-lemma-present | `recovered` |
| 72 | 여자 | noun | canonical-lemma-present | `recovered` |
| 73 | 이해 | noun | canonical-lemma-present | `recovered` |
| 75 | 인간 | noun | canonical-lemma-present | `recovered` |
| 76 | 남자 | noun | canonical-lemma-present | `recovered` |
| 80 | 준비 | noun | canonical-lemma-present | `recovered` |
| 81 | 중요 | noun | canonical-lemma-present | `recovered` |
| 84 | 넣다 | verb | canonical-lemma-present | `recovered` |
| 87 | 가능 | noun | canonical-lemma-present | `recovered` |
| 88 | 마지막 | noun | canonical-lemma-present | `recovered` |
| 90 | 아버지 | noun | canonical-lemma-present | `recovered` |
| 97 | 아래 | noun | canonical-lemma-present | `recovered` |
| 99 | 조금 | noun | canonical-lemma-present | `recovered` |

## Recommended bounded recovery order

| Order | Candidate group | Count | Batch size | Gate |
| ---: | --- | ---: | --- | --- |
| 1 | Issue #204 mandatory rejects | 1 | Issue #211 completed the source-bound 25-candidate re-review: 24 admitted and one held. | Resolve the remaining 내다 sense split with source-bound evidence; preserve the old Issue #204 rejection and #211 hold as history. |
| 2 | Previously included M5-13/14/15 reserve candidates deferred only by capacity | 194 | Issue #219 calibrated a 20-record first batch; review later batches in bounded groups sized from observed defects and workload. | Treat historical fit as useful provenance, then re-run current lexical identity and sense checks; do not admit by quota. Issues #219 and #220 reviewed 60 rows; #220 admitted 18 and held 22 for unresolved lexical-unit evidence. |
| 3 | Legacy capacity-deferred and open M5 candidate rows | 34 | Separate source recovery from 10–20 record review batches. | Recover missing authored candidate content for 35 legacy deferred rows; route 19 open candidates through normal review. |
| 4 | Held or otherwise unresolved rows | 279 | Resolve blockers individually, then place only cleared records into later bounded batches. | Keep the 203 explicit sense/POS/context/lexical-unit cases and 75 additional rationale holds visible until their evidence is complete. |
| 5 | Already represented, invalid surface, or collision cases | 5 | No recovery batch until the identity condition changes. | Preserve the 2 true duplicates, 2 inflected-form proposals, and 1 search collision as separate outcomes. |

## Current reference-only records

| ID | Lemma | Record type | POS |
| --- | --- | --- | --- |
| r036 | 감탄 | entry | noun |
| r037 | 공허 | entry | noun |
| r038 | 긍지 | entry | noun |
| r039 | 긴박하다 | entry | adjective |
| r040 | 탄력 | entry | noun |
| r041 | 따스함 | entry | noun |
| r042 | 미온 | entry | noun |
| r043 | 새벽빛 | entry | noun |
| r044 | 물결 | entry | noun |
| r045 | 잔상 | entry | noun |
| r046 | 말막힘 | entry | noun |
| r047 | 속내 | entry | noun |
| r048 | 문틈 | entry | noun |
| r049 | 표면 | entry | noun |
| r050 | 연기 | entry | noun |
| r051 | 발자국 | entry | noun |
| r001 | 향내 | entry | noun |
| r002 | 감촉 | entry | noun |
| r004 | 달콤함 | entry | noun |
| r005 | 아픔 | entry | noun |
| r006 | 음성 | entry | noun |
| r008 | 덤덤하다 | entry | adjective |
| r009 | 평안 | entry | noun |
| r010 | 거닐다 | entry | verb |
| r012 | 응시하다 | entry | verb |
| r013 | 원하다 | entry | verb |
| r014 | 작성하다 | entry | verb |
| r015 | 사용하다 | entry | verb |
| r016 | 착용하다 | entry | verb |
| r017 | 안도하다 | entry | verb |
| r018 | 호흡을 가다듬다 | expression | expression |
| r019 | 헤매다 | entry | verb |
| r020 | 찜찜하다 | entry | adjective |
| r026 | 서먹하다 | entry | adjective |
| r028 | 약 | entry | noun |
| r029 | 색조 | entry | noun |
| r030 | 또렷하다 | entry | adjective |
| r031 | 쉬다 | entry | verb |
| r032 | 뉘우침 | entry | noun |
| r033 | 고독 | entry | noun |
| r034 | 낱말 | entry | noun |
| r035 | 서적 | entry | noun |

## Source manifest

Every path below is hashed in the machine inventory. The inventory preserves each row's prior disposition/rationale, later decision events where available, current query results, new state, and follow-up.

| Artifact | SHA-256 |
| --- | --- |
| `AGENTS.md` | `758f33c363e0d0b0473f4e82076c721a08960724366cb2a679043c90b10e29b0` |
| `config/artifact-policy.json` | `02aad4bdcd09a0f9f2066f21e5c5972074cf9c1019631e72482f89268c247bd7` |
| `data/batches/issue-204-pilot-decisions.json` | `f2f6636b3fd2edf9c85d3f19e657a1edee9a6f9779d81fc427792a054f96c58b` |
| `data/batches/issue-204-semantic-decisions.json` | `66d96ed2b0c104dab185625ebd5f09ef06b21092c9b84e1f3d1ad0d8b76fd60e` |
| `data/batches/issue-211-lexical-unit-source.json` | `683ac43752125bdc23de25cf5c3f5c64c406055706609d719bee8f847eb22185` |
| `data/batches/issue-211-semantic-decisions.json` | `f55f82ba211c68a4c427f2a133ab1f36ab4b0fcada315d692c239ffe13cf6262` |
| `data/batches/issue-219-m9-a-base-canonical/issue-204-corpus-pilot.jsonl` | `d600ef23a911afa4c8e6bbb7ecce51260767225601c0c9c9adeb62287ae72843` |
| `data/batches/issue-219-m9-a-base-canonical/issue-211-bounded-recovery.jsonl` | `3844cfa4d38e4d99cfd4623670913b224f6b77feaf507d8d48589fb3e95531e9` |
| `data/batches/issue-219-m9-a-base-canonical/m5-10-wave-a.jsonl` | `08e0afedcfb7c530b3e22f9144f43c1d8c923dc545ab96fec1cc961eaca384ed` |
| `data/batches/issue-219-m9-a-base-canonical/m5-10-wave-b.jsonl` | `575def45e3df1fdfca79cb060ab2a3c4b04c060a067d806ab78454af15abb206` |
| `data/batches/issue-219-m9-a-base-canonical/m5-10a-wave-a2.jsonl` | `4be5e7571f0d219fe3a30e68eaa0dc0cca832fbfe8402fe379a46f9f4e7768a8` |
| `data/batches/issue-219-m9-a-base-canonical/m5-11-expansion.jsonl` | `8d3d51bae63503b209e1a7713e8a67fc74616ca03cd80f135a37a0247cf763ed` |
| `data/batches/issue-219-m9-a-base-canonical/m5-12a-expansion.jsonl` | `3f4362a8fb109a6d2d44bf9cc42f63d64cb58c5ddae0084dcab5ac5fe347be45` |
| `data/batches/issue-219-m9-a-base-canonical/m5-13-expansion.jsonl` | `4af53e85dba0ee65906c51d7ba68d439e78b7bdd77ab50438e42f3afb0fda426` |
| `data/batches/issue-219-m9-a-base-canonical/m5-14-expansion.jsonl` | `53ce22151cb109b651a16f842c7cc73f43663fcf065b503222472e129658bf87` |
| `data/batches/issue-219-m9-a-base-canonical/m5-15-expansion.jsonl` | `69a686c84da2f65effc659fda3dee969de460cc9ea853d9723d0dbf9f36026b4` |
| `data/batches/issue-219-m9-a-base-canonical/m5-3-calibration.jsonl` | `2a080a0d473a071917d58860621d9e9b965c7737776b753fd1534a96f50c7d3a` |
| `data/batches/issue-219-m9-a-base-canonical/m5-5-recalibration.jsonl` | `8e75e819159891ce60d2c4c5c7821cc89f30f54efcee1c38ea9c5a102fe980a0` |
| `data/batches/issue-219-m9-a-base-canonical/m5-7-recalibration.jsonl` | `a37677f7569e016e5e8f9525b978ec4911ff0c9afb5ba7f65d3c40dae5fc71c1` |
| `data/batches/issue-219-m9-a-base-canonical/m5-9-expansion.jsonl` | `a47e9322813780efd2eae29b2b5784bcd2948d7c3f7de621174ebee4a35ce4c4` |
| `data/batches/issue-219-m9-a-base-canonical/pilot.jsonl` | `d45c15164ef6f146ee51d40e265746515120a556b1e2fb65e057ed36781dff1d` |
| `data/batches/issue-219-m9-a-base-issue-210-recovery-inventory.json` | `fcaa572119d307a1efc0f15782b8d77a0585f4e9786e735ce42623dd4710e539` |
| `data/batches/issue-219-m9-a-base-seed.json` | `28f2d5a1b0d9f75386d7c39e8d41a923db6a2ade020c0eb57c6fa4832b2f32da` |
| `data/batches/issue-219-m9-a-lexical-unit-source.json` | `65c1b93e16840cb339ff3fb8a522f044783a909c265dff14fdad38cdc3dbb1c2` |
| `data/batches/issue-219-m9-a-recovery-selection.json` | `ac16f899ae4e16267b4703888e5caf6a045ff3db2f8b707e6697f316b4de4ed0` |
| `data/batches/issue-219-m9-a-semantic-decisions.json` | `0b1ccd65f45ec2fe3f5051c9a0c0792bd38b54219757b0c2534b52fbc4b48416` |
| `data/batches/issue-220-m9-b-base-canonical/issue-204-corpus-pilot.jsonl` | `d600ef23a911afa4c8e6bbb7ecce51260767225601c0c9c9adeb62287ae72843` |
| `data/batches/issue-220-m9-b-base-canonical/issue-211-bounded-recovery.jsonl` | `3844cfa4d38e4d99cfd4623670913b224f6b77feaf507d8d48589fb3e95531e9` |
| `data/batches/issue-220-m9-b-base-canonical/issue-219-m9-a-recovery.jsonl` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `data/batches/issue-220-m9-b-base-canonical/m5-10-wave-a.jsonl` | `08e0afedcfb7c530b3e22f9144f43c1d8c923dc545ab96fec1cc961eaca384ed` |
| `data/batches/issue-220-m9-b-base-canonical/m5-10-wave-b.jsonl` | `575def45e3df1fdfca79cb060ab2a3c4b04c060a067d806ab78454af15abb206` |
| `data/batches/issue-220-m9-b-base-canonical/m5-10a-wave-a2.jsonl` | `4be5e7571f0d219fe3a30e68eaa0dc0cca832fbfe8402fe379a46f9f4e7768a8` |
| `data/batches/issue-220-m9-b-base-canonical/m5-11-expansion.jsonl` | `8d3d51bae63503b209e1a7713e8a67fc74616ca03cd80f135a37a0247cf763ed` |
| `data/batches/issue-220-m9-b-base-canonical/m5-12a-expansion.jsonl` | `3f4362a8fb109a6d2d44bf9cc42f63d64cb58c5ddae0084dcab5ac5fe347be45` |
| `data/batches/issue-220-m9-b-base-canonical/m5-13-expansion.jsonl` | `4af53e85dba0ee65906c51d7ba68d439e78b7bdd77ab50438e42f3afb0fda426` |
| `data/batches/issue-220-m9-b-base-canonical/m5-14-expansion.jsonl` | `53ce22151cb109b651a16f842c7cc73f43663fcf065b503222472e129658bf87` |
| `data/batches/issue-220-m9-b-base-canonical/m5-15-expansion.jsonl` | `69a686c84da2f65effc659fda3dee969de460cc9ea853d9723d0dbf9f36026b4` |
| `data/batches/issue-220-m9-b-base-canonical/m5-3-calibration.jsonl` | `2a080a0d473a071917d58860621d9e9b965c7737776b753fd1534a96f50c7d3a` |
| `data/batches/issue-220-m9-b-base-canonical/m5-5-recalibration.jsonl` | `8e75e819159891ce60d2c4c5c7821cc89f30f54efcee1c38ea9c5a102fe980a0` |
| `data/batches/issue-220-m9-b-base-canonical/m5-7-recalibration.jsonl` | `a37677f7569e016e5e8f9525b978ec4911ff0c9afb5ba7f65d3c40dae5fc71c1` |
| `data/batches/issue-220-m9-b-base-canonical/m5-9-expansion.jsonl` | `a47e9322813780efd2eae29b2b5784bcd2948d7c3f7de621174ebee4a35ce4c4` |
| `data/batches/issue-220-m9-b-base-canonical/pilot.jsonl` | `d45c15164ef6f146ee51d40e265746515120a556b1e2fb65e057ed36781dff1d` |
| `data/batches/issue-220-m9-b-base-issue-210-recovery-inventory.json` | `5dbe54ee92b5f8548e41208a46e73f5b68c3fb1d1562afefd5a39f85d9670dde` |
| `data/batches/issue-220-m9-b-base-seed.json` | `394f7fa65fc22a1706af2dbb663e9eb2880ad265ecb2c6a619d6d6d5c59687f7` |
| `data/batches/issue-220-m9-b-batch-01-lexical-unit-source.json` | `35e8a05ddaf63202ca66ef648cd0ac057676b1177760aef22ca96d5d72503011` |
| `data/batches/issue-220-m9-b-batch-01-semantic-decisions.json` | `3ce1c8db0f214449a6c3b1489ac2958f5385e6c3996c878899c0d95bbcb2d6c4` |
| `data/batches/issue-220-m9-b-batch-02-lexical-unit-source.json` | `e190d5f30333756eb11caa0ac28332100da2dc47c2566e24a8a214e6d17c1fed` |
| `data/batches/issue-220-m9-b-batch-02-semantic-decisions.json` | `01c1415e6b51ae14f0e2db08fad0dd5e2f0a73b32bbc9f1431496e636d5199d6` |
| `data/batches/issue-220-m9-b-selection.json` | `6ecc172fb2286cf0babd010c3b125cacd6553300ca66f5fa7b11afd981bd0be9` |
| `data/batches/issue-221-corpus-candidate-review.json` | `e3b5a98a5b097e8df1e0459756a7f6c018e46cc3d16c8f7a817a0e49aa524019` |
| `data/batches/issue-221-corpus-semantic-decisions.json` | `a87fa0b4f72f6eb19fdc933ad0dd43e832ad48870ccb1cdb1a146485ddd3f474` |
| `data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json` | `a68e4c75b2d5ae06abcd94f381621641a934ff6a260b711715fcfadb37b5bf37` |
| `data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json` | `f6c204ed6129a222b71f62d7b68d5b00ebfef9a1ffaf3e58040f8f1ebeeb0df7` |
| `data/batches/issue-222-m9-d-corpus-batch-02-candidate-review.json` | `07398de5ace5b47232ea80cec2bd931d8222be233f2e8409079134325742c308` |
| `data/batches/issue-222-m9-d-corpus-batch-02-semantic-decisions.json` | `9c65156902d45236a6ae4756f9be609e93c95b7e1df2887d6c332595a5b5f8b2` |
| `data/batches/issue-222-m9-d-corpus-batch-03-candidate-review.json` | `fcfaa5a94b922b4f2da6e2de6d5df766f3c00c5d67af7ba285f4c264e9d6838d` |
| `data/batches/issue-222-m9-d-corpus-batch-03-semantic-decisions.json` | `57d438bf60e95c93133bffe360ee80c922106c725c925137ec6fd86db38bec5d` |
| `data/batches/issue-222-m9-d-corpus-batch-04-candidate-review.json` | `b9a573862194a993393be2dd503668abecda50e722902725074825b96e38f04e` |
| `data/batches/issue-222-m9-d-corpus-batch-04-semantic-decisions.json` | `36152105f6690ce2b24a3c380dff3a8fcb7347edd333514556a575099493b2d5` |
| `data/batches/issue-222-m9-d-corpus-batch-05-candidate-review.json` | `27e831674d0fdd21d45caf28af535bcd6139a8de55491b7e882abb2ad991eb17` |
| `data/batches/issue-222-m9-d-corpus-batch-05-semantic-decisions.json` | `8ecb7187dd5504fb60241f544af10dc1112f39738f28f541274812b80f23ccf7` |
| `data/batches/issue-222-m9-d-corpus-batch-06-candidate-review.json` | `1a313556433ef96e5670570e0471f884233ca2ca6c95c8c340a47efbfa29043a` |
| `data/batches/issue-222-m9-d-corpus-batch-06-semantic-decisions.json` | `7db2fe1c1e0162df9b5888b70617332f066963aa44c941d6435309578f58ff73` |
| `data/batches/issue-222-m9-d-corpus-batch-07-candidate-review.json` | `90575d5e5c7b0c8a869f2a2128e7ad55f0d96444650da080dd848bb32e180873` |
| `data/batches/issue-222-m9-d-corpus-batch-07-semantic-decisions.json` | `79c6714e6a73fb9503eeca6c1bf800f8a1296aed170bf74852019ec35796f934` |
| `data/batches/issue-222-m9-d-corpus-batch-08-candidate-review.json` | `b6e57696378e045068af3bd26728ce80f9abd5cd1800d676bbf351d136bddcf2` |
| `data/batches/issue-222-m9-d-corpus-batch-08-semantic-decisions.json` | `4f1ac02e5bb6372bdd1e7b6df7c93db55e7525405fd895cb9baf5dd1bbb97c73` |
| `data/batches/issue-222-m9-d-historical-base-m5-target-seed.json` | `a1a9c7b629c428a3fa7c979acdff96e9557735d0384248a84c54fcbf945170dd` |
| `data/batches/issue-222-m9-d-historical-base-recovery-inventory.json` | `42525a3de9668f53092c3a7ed483e4a9b377aeb2f03f0de0500299e8b5f6917d` |
| `data/batches/issue-222-m9-d-historical-candidate-source.json` | `924f641d2bb1db718a64d24f06a366e0bcc1f931f345eebbf7cac863776bd6fb` |
| `data/batches/issue-222-m9-d-historical-semantic-decisions.json` | `bae98303dc4c5326df4c79c6e650446cd27b50adfd99fe08120c725def30a6e0` |
| `data/batches/m5-10-wave-a.json` | `dfa26d82b83eafee4f957d6320ead3e193dce45b192845c5f84b8b35fe2d6720` |
| `data/batches/m5-10-wave-b.json` | `44bd8a9a151ca796ded42425d8b667541d6816fa53a880e76fd73f9a20474e1c` |
| `data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json` | `cd88034957489497b892e486aaf6ce95bb6224b03cff8931b8bf09096fb6af4d` |
| `data/batches/m5-10a-wave-a2-preimport-inventory.json` | `430bcd92fba17e8696ebdf222ca07d5ad1911a644c16ce2edc77799a09089149` |
| `data/batches/m5-10c-editorial-decisions-20260910.json` | `581c40feff8b8a3823eade34c3f343bf1d6a15e6727734e7d7c677298c53ded8` |
| `data/batches/m5-10c-editorial-work-held-rejected-20260910.jsonl` | `bb74669d5b6b2b007826cf3e7e9ed101441263a4bbae45ccde545e0968a4d4f1` |
| `data/batches/m5-10d-editorial-decisions-20260912.json` | `e03a41b5e2c65eafeecca47e0f09ff52a950f5556c0c1fac195b5e0dbb3fbfdc` |
| `data/batches/m5-10d-editorial-judgment-held-rejected-20260912.jsonl` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `data/batches/m5-11-admission.json` | `330a1d453f01d1116a8f9fd305364b6bff154ec38c8300413753c8fb58406a6c` |
| `data/batches/m5-11-review.json` | `171c1e30eba40e7513fdc10ba5d8118231ba7b5a7400ef477e0311e60c425326` |
| `data/batches/m5-12-base-inventory.json` | `f2a7c36547ca4db4b3dd2bc2b3b5f8962e991aa900b42ffce34533b84e57bc67` |
| `data/batches/m5-12-review.json` | `b2e9697be48b0d3fe7c4dd8b1041a30f8d5cca19e321f55cfc279a677efb2afc` |
| `data/batches/m5-12a-admission.json` | `33639ee2e0240703d0882fea6219d87ea0d912bc8453969e05e103faa780bba7` |
| `data/batches/m5-12a-semantic-decisions.json` | `720348e78becee62249ed4761cf154a8c794b10c1ff2609d95d90daa811d4edf` |
| `data/batches/m5-13-admission.json` | `ae131f70eea91fb8f4361773c25c15c7f589343d60b5539be72ed70c8e91c7a2` |
| `data/batches/m5-13-lexical-unit-source.json` | `ac8087e4a9f9dc71a4be0814213fb56aa6fa254249b8423f4ed1d11e9b170aa3` |
| `data/batches/m5-13-review.json` | `1e19074335e5d4b7e125ae770cd12890a82653cf20cd1d9215b0242d2c62a394` |
| `data/batches/m5-13-semantic-decisions.json` | `b3e238b8715c46ed813e4faacac442ad66333b206c245c202d72a00c08ad5bf1` |
| `data/batches/m5-14-admission.json` | `3c8de414434fe7bd570ae1acd1e75cc026f1720c6f4bdde80c7983874eb2debd` |
| `data/batches/m5-14-review.json` | `ed7f03743f6ff713d1c929622cd2244ed1ccf8b03b20c06e2e547f689a8b1024` |
| `data/batches/m5-14-semantic-decisions.json` | `dabd7d3d13f8dbd2ed6e7fa3dca1c2a1ace233eda08de62ef842cb7dd095f5dc` |
| `data/batches/m5-15-admission.json` | `80eb475720b65f425587635cb3e00fa07f4e1d609ea2c5e18a3604f8d92dd0ff` |
| `data/batches/m5-15-review.json` | `cdf53f110ea5f9faf5e8763c6e3d8230c88026412ca1853c10bf78bbf19a42e2` |
| `data/batches/m5-15-semantic-decisions.json` | `01698848d7f2d8f3704429c41a934e7e81997bc25c46ca7c1a16b2dc2084e366` |
| `data/batches/m5-3-calibration.json` | `24a829940621e5aafd9d72e272a61b3e36233f99446399e9dd856fe433810253` |
| `data/batches/m5-5-recalibration.json` | `1c49096d4e7b6a20279b2ac98b3787e7a66ad6a9a32be26e49f98607c0eec726` |
| `data/batches/m5-7-preimport-inventory.json` | `2b7c76070daba0bda2c566045231abbdc4eda3c5dd2f365df8372fb7af9c388d` |
| `data/batches/m5-7-recalibration.json` | `b58317f22cb18a79f5fdc05108ed158cff8f2aa0fa9d44e3f81fa8c6deaa2b3d` |
| `data/batches/m5-9-expansion.json` | `236325006a4adab62b7ca5dd420dfa5b7dbb0b5633ca29091ae448019b80fa7d` |
| `data/batches/m5-9-preimport-inventory.json` | `08716ca1ec9d58c0f54c99773421944792589763cf33f23c0a6ec539c8164120` |
| `data/canonical/factory-C000001-a1.jsonl` | `c3f7c478c82b9bf301cdc41af3d91692aa34dde4d6d622508b59a5c75f34f5ed` |
| `data/canonical/factory-C000002-a2.jsonl` | `6d0eb3c618864fc8a3fe525b05d08d4d033b9d694c0bcf0da4b3730358bff375` |
| `data/canonical/factory-C000003-a1.jsonl` | `4e110d5ac57d907f5dc157a7345389aba2040cf91002cddb12c9904c1a9fb1e8` |
| `data/canonical/issue-204-corpus-pilot.jsonl` | `860e30410f38849c0f0e18a9f9e569911f9a427dddb017a4001df1db7be85ff6` |
| `data/canonical/issue-211-bounded-recovery.jsonl` | `e8043bd7c930cb57fc458cefe61befbdb13274ff7332dad780388bc32d12a975` |
| `data/canonical/issue-219-m9-a-recovery.jsonl` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `data/canonical/issue-220-m9-b-batch-01.jsonl` | `3f3712afd4d744379b7cebb1aee0c0267889944ba249b201d3f2e1189daa4615` |
| `data/canonical/issue-220-m9-b-batch-02.jsonl` | `4a6ca9d4534f5e734f9956c814102e4dbb591fc1d48d8c7e58c4e347c8c9ea1a` |
| `data/canonical/issue-221-corpus-production.jsonl` | `c4284056bb13a79af88551a97e226f407c4e7caf9fa1cf0ae70081396d821aab` |
| `data/canonical/issue-222-m9-d-corpus-batch-01.jsonl` | `0cd8526c80b7bf3bd4eaadf60ac9c1048a2fe1c6b0136c7d7949f8d77199e967` |
| `data/canonical/issue-222-m9-d-corpus-batch-02.jsonl` | `382a1ce612cb58b29094948f091be74654adaec851e1119138bd9a8566b2d606` |
| `data/canonical/issue-222-m9-d-corpus-batch-03.jsonl` | `61d2df47d28adb8e03567befed9f2c57e1afb5e0f459112cd5ddbf870d6aad2e` |
| `data/canonical/issue-222-m9-d-corpus-batch-04.jsonl` | `e2f944857597f2d5354ccd4ac22654090c55b9c2a0adad1865a6eb52d2b508b9` |
| `data/canonical/issue-222-m9-d-corpus-batch-05.jsonl` | `56179e9ce2f2aed9e47ab0ecd0b3d8c09830a9aba5e91ac93c9e2f2be925c0fb` |
| `data/canonical/issue-222-m9-d-corpus-batch-06.jsonl` | `7c371e47d25ebf3ff233a591480522f2841b29df4f23b6db52cc2c57910dfbde` |
| `data/canonical/issue-222-m9-d-corpus-batch-07.jsonl` | `0725cecdbc2cf4e483d3579723589e1fb8c5525d3a27516fb0fa35db2180ea7b` |
| `data/canonical/issue-222-m9-d-corpus-batch-08.jsonl` | `24627abc735e1815998cbf0817d72fd560838b8804c143f764b38d86a16d1523` |
| `data/canonical/issue-222-m9-d-historical-batch-01.jsonl` | `a962f6334c6f8a01d80eadee08286d26fe791b953b61ad1a752f6f9e677c6f94` |
| `data/canonical/issue-223-m9-e-corpus-batch-01.jsonl` | `e3364c0e372c22349939a3d823b5c508b5880c8cd4911d21097014f1f4224f11` |
| `data/canonical/issue-223-m9-e-corpus-batch-02.jsonl` | `668862272fadb88908cc65cb6fc3151fadac723cc2a60d0566f3618ee9480692` |
| `data/canonical/issue-223-m9-e-corpus-batch-03.jsonl` | `9836db7d0c5f914a5cbc0c0fb339310bd9a42ad2060ba691043a17e01857c858` |
| `data/canonical/issue-223-m9-e-corpus-batch-04.jsonl` | `3c2aede30881bc489a9003a00090527c8e96fd7a3bb84954d46668cdd6c0c5ec` |
| `data/canonical/issue-223-m9-e-corpus-batch-05.jsonl` | `b5d9c4856326e0ce529ae5baa31633788b39a4bf41d400ca96b386fce471a15b` |
| `data/canonical/issue-223-m9-e-corpus-batch-06.jsonl` | `096be48be381ea0b01997286b9530b97845e8cc04040e34a9b2819688055957a` |
| `data/canonical/issue-223-m9-e-corpus-batch-07.jsonl` | `177fa85d8f5cdfe8cba681ba360c0e1c2a4a834ba2e39b3294a0ba468ef8c519` |
| `data/canonical/issue-223-m9-e-corpus-batch-08.jsonl` | `5e45c75c3d5ad8d1414e5a11fe8365963ea24ea7d8d13eb6c2071573c93105eb` |
| `data/canonical/issue-223-m9-e-corpus-batch-09.jsonl` | `164e5f48483e04f297273ecf5d64bd760911c5ca7e0cda6ee170a5cc9b8a611f` |
| `data/canonical/issue-223-m9-e-corpus-batch-10.jsonl` | `84cbc6f924156ccfd0bde9cc6505732b6cf1db99adfe48c172ae003dadde03b1` |
| `data/canonical/issue-223-m9-e-corpus-batch-11.jsonl` | `0ae0ca398706f146916fedbbb8a0262e568cd11b6a9c7128ab80b1ac80ea192d` |
| `data/canonical/issue-223-m9-e-corpus-batch-12.jsonl` | `01c34291a500c9acfbd1f635f0b6aff9a4ab6c7b6e6ac78df545736de89c644b` |
| `data/canonical/issue-223-m9-e-corpus-batch-13.jsonl` | `a3122e2de2a10712c8f836d10912c24d076b186ad203b9fe8923e82159054600` |
| `data/canonical/issue-223-m9-e-corpus-batch-14.jsonl` | `b4a07d1a243f396f540aacc26add3bc37b5a259a85d753939891fb5d4cfe8acd` |
| `data/canonical/issue-223-m9-e-corpus-batch-15.jsonl` | `f4cf85faa2edd6601953821f42303598c8b6bde14492d4f97a108788db832f7d` |
| `data/canonical/m5-10-wave-a.jsonl` | `cd4cbb534a25abc26948ca2b95dc05f67ef169c0ecbb9091679eca360751fa5f` |
| `data/canonical/m5-10-wave-b.jsonl` | `843a572b8d5e40fa552342f6eaa753b24be218ae176441bdc2aa2b840187ddd1` |
| `data/canonical/m5-10a-wave-a2.jsonl` | `6847ca98497c45778e9cda7c302055bc11f1cfaf5b8a531e5a7838d51cfb2adc` |
| `data/canonical/m5-11-expansion.jsonl` | `ea7aaeaf1c9685a80604bad44b100a9726a4f6e0c5dc18ffaa2722daf99c7b5b` |
| `data/canonical/m5-12a-expansion.jsonl` | `ea5e3361665f1c4b57730068c755f29038594c82d3ce21bdf772d3b70f6342aa` |
| `data/canonical/m5-13-expansion.jsonl` | `9f170fc581a2183e8e04c112c60fcf2566a97ae51c6b26f6595ca1b4f4fc21f4` |
| `data/canonical/m5-14-expansion.jsonl` | `a738c4923b450479fd7c298826c568738f49da7128f8cac1b12275a8e710dbbb` |
| `data/canonical/m5-15-expansion.jsonl` | `2b6e543733cd214869b101fea29d4c1a415a2ed0f3f0ed55006ad9688216e831` |
| `data/canonical/m5-3-calibration.jsonl` | `cb289bb88c8bc817deca1fbcd4cc69df84d5bbecefc434705a2f42d111f6f6c8` |
| `data/canonical/m5-5-recalibration.jsonl` | `0e871e9e819eac91a54daabdf65f2a3e47fa5da5303f76471b3ad0811e856a23` |
| `data/canonical/m5-7-recalibration.jsonl` | `b66f103383c2d108e08c9570ab2af4d533a387e4dbfeda8923c79fcc7ee03594` |
| `data/canonical/m5-9-expansion.jsonl` | `e82d8f2f550712983c8cf6c25352245218539741e4a217cddc8b47665aa2df79` |
| `data/canonical/pilot.jsonl` | `4eb59d3b8d16ec71ff80f5fff6665697b5a9be56bb88360839fa8051d9593d5c` |
| `data/inventory/m5-target-promotions.jsonl` | `07d623ce84afca980f957eae4497d29ac847cc8de7999c0f8278a5cc760bef4a` |
| `data/inventory/m5-target-seed.json` | `6c580008269555ff1f3227a2e1d1ec1732066d6e428be119c7d1deddf02d742a` |
| `data/validation/canonical-semantic-decision-source.json` | `a01ce23d4c13ad78705e56a42ac1d8ba1ac5a582557ab8f159f802c32e184949` |
| `data/validation/issue-219-m9-lexical-batch-report.json` | `011c5ecd8326ba72029b1225eb175ddb37a613770f8e327c85156c160ea5c2bb` |
| `data/validation/issue-220-m9-b-checkpoint-report.json` | `5f80ee82f77596f994b8ca1ddebca442b13c9a68e4df18464d8e4ef25641c0b6` |
| `data/validation/m6-2-inflection-exceptions.json` | `0c042487df854df06aecd72f32bafb08d79235e7ad7628641cdc9194979886b7` |
| `data/validation/m6-3-surface-form-review.json` | `eb59acc81975489f44272477f507c178319b47c197505e1a75356ad837ffa0de` |
| `docs/editorial-model.md` | `06351e898e7cf62151acd3789828233c7a3448d471bc1144b409e5c68e1c12b0` |
| `docs/external-material-review-customs-terminology.md` | `ce7395c649ba9d4eecf2ed3362be2f9859116a398aee85534005e1ea624bce2a` |
| `docs/issue-208-searchable-start-retrospective.md` | `3e5dfd512389b4a505010686c10c32e0cdfdbb328290e1f4f0bc92a8f6aa6621` |
| `docs/issue-211-bounded-lexical-recovery.md` | `e0a264b879f612b32fd20ebbb3c0a475d324ded5f461d4d0406f27bcb820a294` |
| `docs/issue-219-m9-a-recovery.md` | `8b58ba80f5d35ae7bd516bdc21090c803aa460f30816efe4e031540bb8669bcc` |
| `docs/issue-220-m9-b-checkpoint.md` | `dcc399376db7c88a1603d4a3b6326845bc58dd0d6144aa8a196ab58f4c463437` |
| `docs/m3-handoff.md` | `215dedb02808c108ba06c9d20258d9fde5c03b3c5a35da556320a8c652ab3b04` |
| `docs/m4-handoff.md` | `4492845b7a362c70b4ddb7a4c7582f2d37b3e6d2c9a9afa394edb414ed714c49` |
| `docs/m5-16-final-audit-report.md` | `a60a58a20551d72c0388b8fd99fe5d92b3fd19c3a76cd3701c7d7e8fc82739f8` |
| `docs/m5-target-inventory.md` | `a819063b520935291f310d59a78ca37c9616d3266039ebd4952a61e48a82f88e` |
| `docs/m6-1-quality-baseline.json` | `4eb83fd3d19c8ff0b522300430e4107f002850907161f2bdcd97ba3872195209` |
| `docs/m6-1-searchable-lexical-baseline.json` | `1bb15c9a6f65c5120c9bfdd651521f0c73ab8583e0c8a4a3fd76b75751f86d53` |
| `docs/m6-1-searchable-lexical-baseline.md` | `bf0a12fc1473a95dbbb72a6df47bdd253254fa92ff12ba678fd373595201f8c3` |
| `docs/m9-bounded-lexical-batches.md` | `06f1fd2ee398cba59f62a2b347e212d9e921cbdfa14e5cf9931bb22e4a78e70d` |
| `docs/m9-corpus-production.md` | `ca87c8da1dd97b80e5b02d5b92204d215534586d0a860e7aa0931241b9f1917e` |
| `docs/pilot-scope.md` | `9d1d23b63c828838e5b326ee69e080f57a68ffae6e0e31dfe05e99d0865e6881` |
| `package.json` | `a9aa27ca3f1973a19dad38a8816068cd93816bf7817c0a7cc02f9428fa682f4a` |
| `schema/issue-220-m9-b-checkpoint-report.schema.json` | `ca40281d0863a36e36b6a2d5f3d7886efc0cc136ffddff8117a4a306d27e1710` |
| `schema/m9-lexical-batch-report.schema.json` | `e2137ba54f1610f11412c8e6ce6da2cafc3f9b8b7a8b51dedb03c93b1db76dcb` |
| `scripts/batch/authored-semantic-decision-source.mjs` | `714257a9d0573636c9b7102772adb39ac19497a13d2848b972aac14089aa0156` |
| `scripts/batch/lexical-production.mjs` | `182e156e22b768c72cd5a335c316da41ebd103430cab5feb0a3161a1dca49867` |
| `scripts/batch/lexical-selection.mjs` | `4a80f1b9a6391536f46e2faaf53bed87508b649211837471c0545a64a32a1e9c` |
| `scripts/batch/m5-13-candidate-source.mjs` | `e7fdb25526acf99e42c2f12891e7f74e56b41a93cbfd0036628a1d334566cb69` |
| `scripts/batch/m5-13-decision-source.mjs` | `a4c5972f19608b74fefc89cd86bf31d453c2fac17033471cba5aead527516537` |
| `scripts/batch/validate-issue-211.mjs` | `e3ec5866aeef95af4f980b0772d73466dc71d8558f93c4ab1622c7008c5b48e2` |
| `scripts/batch/validate-issue-219.mjs` | `1736364b20811d5298c384c16533cd1145191d2656e70da1d1315df27217a174` |
| `scripts/batch/validate-issue-220.mjs` | `496b83a2caf694ad844b4ddbd227a37e96dd959f6ccb8749f6d78f1928624003` |
| `scripts/batch/validate-issue-221.mjs` | `b27a0d0964da86809064231cbf5a069e391dccf5732e63914fb1168190b36f42` |
| `scripts/batch/validate-issue-222.mjs` | `c953344986fe1167555b06a075f99ac2eb47b86bcbc08182c3f30bafcec4fbdc` |
| `scripts/ci/registry.mjs` | `5a9a6fb0a22da4f40f2afe8060036a1528be7aef5bb345befa377ea136af8184` |
| `scripts/inventory/build-issue-210-recovery-inventory.mjs` | `677fcf09e31406a57518f84a53d97711ad5e9cab54263a974f8441eff44878f8` |
| `scripts/reference/corpus-candidate-review.test.mjs` | `bf7b92b975d417130febac9961e9f3b0a2caf62bfb83b42a3edac38c9cb1c73b` |
| `scripts/reference/corpus_lemma_pilot.py` | `4dca35401b6abe6cc3ac35245568e3dc0d5ab838748635ab527507b2ae9b71ef` |
| `scripts/reference/run-corpus-lemma-pilot.mjs` | `5173b6c41e2eaa9790d1586b59b6a2eeaf9e2bc7205ab3e8401c6d77913f20e1` |
| `scripts/reference/run-corpus-lemma-pilot.test.mjs` | `744f0841ab2e11318633424466b8894f96153c9eeaf77b078d728ecf4e3f5545` |
| `scripts/reference/test-corpus-lemma-pilot.py` | `7482672846dd308b8a0330fd247c87cd9b07131b95fbb79946b34bb3509a839c` |
| `scripts/reference/validate-corpus-candidate-review.mjs` | `7f5cfe1d9b413873d7290eccc1b1ca339627aea51a3ab6fd89cd1033d2ff1f84` |
| `scripts/validate/corpus-candidate-review.mjs` | `184b1fa634e20c635715d98c3a581770f97b1cbdfe2a27111936e259b15ac6fb` |
| `scripts/validate/semantic-audit.mjs` | `3ba8d1a04137edd5ccdcdc6959d5c8aca532f131a9564f5f64090985877a182a` |
| `scripts/validate/semantic-decision-row.mjs` | `60dbb9338957d3e8acd3b763800b778e17eb9938e5e51382cb3e94f505f75544` |
| `tests/issue-211-search.test.mjs` | `34e50c936cdac2e3764789d67ff206de39e2284297348e956e250e2ae94e8237` |
| `tests/issue-219-content-digest.test.mjs` | `a6d5daecfb4985724cb5e14a74269f1cad0ca44697199f30a689ce4a532beeda` |
| `tests/issue-219-search.test.mjs` | `970902e707d1acf2aae7f3eea74869abd83a21a477d6b755a2e1d6f61cad6cd2` |
| `tests/lexical-production-candidates.test.mjs` | `cbfdf7b81d734823def0fb38bd31507d81fd2ad5e6af63a1151e1233fc42563b` |
| `tests/searchable-start-contract.test.mjs` | `3542cffdcb7865d3308b1468b31d335b46c5d21f677d5d8485037756a14b1a68` |

## Known limits

- M1–M4 provide a 300-item pilot selection table, canonical pilot records, and historical M3/M4 handoffs, but not a complete durable list of every rejected or deferred candidate. The inventory does not infer omitted lemmas from those missing lists.
- Historical M5 decision notes such as “insufficient admission priority” are preserved as ambiguous evidence. They remain on hold until candidate-specific lexical grounds can be recovered.
- Issue #211 re-reviewed all 25 Issue #204 rejects through the shared semantic and admission contracts. Twenty-four now have admitted canonical bodies; one remains held because its current single-sense gloss collapses distinct uses.
- Issue #220 reviewed two bounded M5-13 reserve batches. The complete Issue #210 historical pool cannot reach 6,000 records even if every remaining candidate/hold/sense-split row is resolved: its calculated ceiling is 12819, short by 0. Issue #221's corpus admissions are part of today's canonical baseline but remain outside that historical pool. Further expansion requires the next approved source workflow, not reconstruction from absent historical material.
- Current search coverage describes canonical lookup only; it does not claim editorial quality, writer satisfaction, or relation completeness.

## Reproduction

`npm run inventory:issue-210` checks the committed JSON and Markdown against current canonical data and source digests. Use `npm run inventory:issue-210:write` to regenerate both outputs after an authorized source change.

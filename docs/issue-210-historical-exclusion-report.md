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
| `AGENTS.md` | `512e9c2e896716406322c929353eb9eb1230b4adc79b386c0039117be2e0b25c` |
| `config/artifact-policy.json` | `82ea4ed94bb2eaf8a1dfbc2a8b5c6a5f04eb88643437d619632c7aaa57685969` |
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
| `data/canonical/factory-C000001-a1.jsonl` | `993310f561451828bdc401120d4f5da6584a027c4265635575a593a02170416e` |
| `data/canonical/factory-C000002-a2.jsonl` | `c404b9b88046add64f011bc100730997b0fde415ae0f070c397e7628312007c2` |
| `data/canonical/factory-C000003-a1.jsonl` | `bf90afe89e6f388230ac2fe941dd10f3cfc2b38ce3b123fc4d67fbd1f39aecee` |
| `data/canonical/issue-204-corpus-pilot.jsonl` | `fc4784db74ddfdf1b287179c8d4b3dea68757deb4d33360e98730c063c72c0c3` |
| `data/canonical/issue-211-bounded-recovery.jsonl` | `02d71583856c525a6c5ec9570943f7bde33409d0f62c4423d91cc7191c2c6b35` |
| `data/canonical/issue-219-m9-a-recovery.jsonl` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `data/canonical/issue-220-m9-b-batch-01.jsonl` | `71fd95c855955db9b120eedd384efdf4c9485683b11a1d12a7d5be0581107fb7` |
| `data/canonical/issue-220-m9-b-batch-02.jsonl` | `e5f3979c82828f8a66b28b3414a291a810cf1badcdd15f4153b86035c4a0e9f5` |
| `data/canonical/issue-221-corpus-production.jsonl` | `63e9fda3062407f9cb95afba5f90a8e225f325faa8011be5fc5ae130216df4ce` |
| `data/canonical/issue-222-m9-d-corpus-batch-01.jsonl` | `242eb4ef7585b0af0834f6814337b60a49a95bb6000899b7863f69d92d0a4199` |
| `data/canonical/issue-222-m9-d-corpus-batch-02.jsonl` | `598d921bd2cda7b404a30fc372b2e95e95da256be3abb6a7cfbfb9ffcfa82ade` |
| `data/canonical/issue-222-m9-d-corpus-batch-03.jsonl` | `e8acb32936daacc191e058dc21b2dc846b3f68dd3e085f849d0919ac3712f600` |
| `data/canonical/issue-222-m9-d-corpus-batch-04.jsonl` | `2ef4af507fde4479d97eb107090a4ecbb302b30b27eaa178d19105bbc0b6ad9b` |
| `data/canonical/issue-222-m9-d-corpus-batch-05.jsonl` | `60158bb7ea1a61dd2bf15e394076238787d13027135915b47674ff65a23b02ba` |
| `data/canonical/issue-222-m9-d-corpus-batch-06.jsonl` | `d450bf34775d05a2c810fc7e26d80753114a7ee874f9b224eb880f41ddbf5c62` |
| `data/canonical/issue-222-m9-d-corpus-batch-07.jsonl` | `3474a4158118a45f014ed1fe833e07f551a9d2ca1d2259ec50693881c7cd3e4a` |
| `data/canonical/issue-222-m9-d-corpus-batch-08.jsonl` | `34f36f4edbb164ca722b10863c70a26e49251d4060dc2e772b524d73369d2b48` |
| `data/canonical/issue-222-m9-d-historical-batch-01.jsonl` | `c63c26b0a5b11cb3daf1a9c5bf378cc64d29fd5ab18ab6121c8c0091e28c79aa` |
| `data/canonical/issue-223-m9-e-corpus-batch-01.jsonl` | `452aac75e206a8bda81e630377e1079128feda097e7116487f96a2a761d3b689` |
| `data/canonical/issue-223-m9-e-corpus-batch-02.jsonl` | `69fbe3b91a6db259cf14a93dc1ff2834cb8eca697fb4fda312f545b130306570` |
| `data/canonical/issue-223-m9-e-corpus-batch-03.jsonl` | `720183cef88c2b2081fa9aceb4d29b2d3fd1c8cbc86792b59f16389cdb337b9e` |
| `data/canonical/issue-223-m9-e-corpus-batch-04.jsonl` | `a1d6c1ecdccc2061d417d52fbfc7c7b8ec4903b20c4546f920568c23e026a773` |
| `data/canonical/issue-223-m9-e-corpus-batch-05.jsonl` | `4857e75412d32e0efe2bff0ddcc5f667d9958114febdb61475b68f3d94d09db5` |
| `data/canonical/issue-223-m9-e-corpus-batch-06.jsonl` | `c3dcbbd3abfe86bc34caa16b37535608040ba17ae229e17319714b1a7fc9c53c` |
| `data/canonical/issue-223-m9-e-corpus-batch-07.jsonl` | `b1925ece9800193955ae3c59779b1ed66dc9501919d69a294b342480b7e48696` |
| `data/canonical/issue-223-m9-e-corpus-batch-08.jsonl` | `33421e4112c0e413592bfa2277e192665519973fe227c2ce9607e6b78e4402a2` |
| `data/canonical/issue-223-m9-e-corpus-batch-09.jsonl` | `3f9f0c1c06a28ed5328769c5a5ba7380633771b01e701e0b80fb13f1cc8f00fe` |
| `data/canonical/issue-223-m9-e-corpus-batch-10.jsonl` | `b6db202335a0cca9763bc8a1a28c7ef55ed413c4a86aa26a0eb862c2b233155f` |
| `data/canonical/issue-223-m9-e-corpus-batch-11.jsonl` | `f7bc22a380221838d8ec112fac3dacc62bb84bfe0bef6e6ffe7360de62fb6e35` |
| `data/canonical/issue-223-m9-e-corpus-batch-12.jsonl` | `e9df5e0ee7f2a32b4f95e5cd6960d7ed96842e6b29af38986c2385ce19614d25` |
| `data/canonical/issue-223-m9-e-corpus-batch-13.jsonl` | `8ab6628232b3059188d5109bce0094750a5b394203bd09ffc567e8af0662de69` |
| `data/canonical/issue-223-m9-e-corpus-batch-14.jsonl` | `bb4650718ce34d60ae5d5fe16c0aa4ac62d01a58fe3652342f7b19bfed42a7d5` |
| `data/canonical/issue-223-m9-e-corpus-batch-15.jsonl` | `de72d9344bbbeccf47ae06db5167977e0ca2ce79ff17198b9ec6c6d75d98a681` |
| `data/canonical/m5-10-wave-a.jsonl` | `00cfdc0601e2065b6cc1b359e8ce3c686dca66346c7708be302544275275fbc6` |
| `data/canonical/m5-10-wave-b.jsonl` | `eac66a2ff4220387941c711b5a85e598131d3be3bee92e5ab1093805ec24b3dc` |
| `data/canonical/m5-10a-wave-a2.jsonl` | `49b5db67c782a3018e83a0d44107a0ec8c2d9a991d63e573317d2421a6e36afc` |
| `data/canonical/m5-11-expansion.jsonl` | `057ef9a872df7dc402d0d903c8c051fba1e0c6420c2e82f07d9195a9163ede31` |
| `data/canonical/m5-12a-expansion.jsonl` | `bba832c5d16813b7626f56ccd31b7a91ee4cce51b63acb54ff5cf124e713a1a3` |
| `data/canonical/m5-13-expansion.jsonl` | `1866f789a7ca28b199f5b0a20e54ce36a6276025526252c2477cc9f22307c6d3` |
| `data/canonical/m5-14-expansion.jsonl` | `2d5cd5a79f82ab4da059e9b6d8f182f6b7b259f4acf2ab4fd0d690a9ffd618c5` |
| `data/canonical/m5-15-expansion.jsonl` | `5dfa68afd958de72c9b122946da3e804c961d9d0195eff6304b2c380846be538` |
| `data/canonical/m5-3-calibration.jsonl` | `b35fda7f10976af6a6bc3a7f3c028430f2c10a52a926c2685205e904c6e41617` |
| `data/canonical/m5-5-recalibration.jsonl` | `ea90ae7adc4073083768a38fc6f40b8df2e8c80bafac78b401f734cfd1614428` |
| `data/canonical/m5-7-recalibration.jsonl` | `731b4f66d78d5c3bc4c444071a0372f2dbf387cea50bfbbdef04f3a1d03b3851` |
| `data/canonical/m5-9-expansion.jsonl` | `b8d568b6656080cca6c2a4b6d95bd8fa39d1b5b840c911e4b3f6b6f0d652ce2e` |
| `data/canonical/pilot.jsonl` | `8fe09f2a2a259ee993d2f56098a3689188042b6485fe23fa998a1afe669a731c` |
| `data/inventory/m5-target-promotions.jsonl` | `07d623ce84afca980f957eae4497d29ac847cc8de7999c0f8278a5cc760bef4a` |
| `data/inventory/m5-target-seed.json` | `6c580008269555ff1f3227a2e1d1ec1732066d6e428be119c7d1deddf02d742a` |
| `data/validation/canonical-semantic-decision-source.json` | `ce7344e7252795a41ff75d28177d4050d21a4164c34ab16f8d866bb222b7c960` |
| `data/validation/issue-219-m9-lexical-batch-report.json` | `edcc902d57ecb2a28589994fd5c01dee2d11a31fa8c1c835850bb9e341a90033` |
| `data/validation/issue-220-m9-b-checkpoint-report.json` | `be58c65c7959df34fc525fadc1131d9896e43aa827f1cdc263272cc3eb5599d4` |
| `data/validation/m6-2-inflection-exceptions.json` | `0c042487df854df06aecd72f32bafb08d79235e7ad7628641cdc9194979886b7` |
| `data/validation/m6-3-surface-form-review.json` | `eb59acc81975489f44272477f507c178319b47c197505e1a75356ad837ffa0de` |
| `docs/editorial-model.md` | `06351e898e7cf62151acd3789828233c7a3448d471bc1144b409e5c68e1c12b0` |
| `docs/external-material-review-customs-terminology.md` | `ce7395c649ba9d4eecf2ed3362be2f9859116a398aee85534005e1ea624bce2a` |
| `docs/issue-208-searchable-start-retrospective.md` | `3e5dfd512389b4a505010686c10c32e0cdfdbb328290e1f4f0bc92a8f6aa6621` |
| `docs/issue-211-bounded-lexical-recovery.md` | `e0a264b879f612b32fd20ebbb3c0a475d324ded5f461d4d0406f27bcb820a294` |
| `docs/issue-219-m9-a-recovery.md` | `8b58ba80f5d35ae7bd516bdc21090c803aa460f30816efe4e031540bb8669bcc` |
| `docs/issue-220-m9-b-checkpoint.md` | `60079705e70e0702b374a276640e08c047a8096e75af27a58decc899ff387d6c` |
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
| `package.json` | `16a43f4c30503c27cd8880c74126419595d91113526d102a401732a0eb7a4526` |
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
| `scripts/ci/registry.mjs` | `72904af8f048b26602811c969f41afc0d6c4a473240320985c77d206f759e0f9` |
| `scripts/inventory/build-issue-210-recovery-inventory.mjs` | `5d4f77e7f031d4eb1a69b1e361e83a5447ed34ac635cf22cf682102a79ecbf15` |
| `scripts/reference/corpus-candidate-review.test.mjs` | `bf7b92b975d417130febac9961e9f3b0a2caf62bfb83b42a3edac38c9cb1c73b` |
| `scripts/reference/corpus_lemma_pilot.py` | `6e249da2be67644bd4c3791640d6f7831f5818cae067aec8029eb825ced5272f` |
| `scripts/reference/run-corpus-lemma-pilot.mjs` | `de794599544ffae609b63b72089257c31293f2c818ffe17bff76713699ded4d8` |
| `scripts/reference/run-corpus-lemma-pilot.test.mjs` | `e9ac512db170f63472605c7049edfd4e2829e59044c0cac8c51d3d3a8f133ca4` |
| `scripts/reference/test-corpus-lemma-pilot.py` | `a69179272ff4ef54c753163bb212effb5ab78339c8e11dfbd96e372ae34c65f2` |
| `scripts/reference/validate-corpus-candidate-review.mjs` | `7f5cfe1d9b413873d7290eccc1b1ca339627aea51a3ab6fd89cd1033d2ff1f84` |
| `scripts/validate/corpus-candidate-review.mjs` | `184b1fa634e20c635715d98c3a581770f97b1cbdfe2a27111936e259b15ac6fb` |
| `scripts/validate/semantic-audit.mjs` | `f12fd56d5e15a1236e0b300dc94ea74edcec44925db5f65468f010e91bed7975` |
| `scripts/validate/semantic-decision-row.mjs` | `60dbb9338957d3e8acd3b763800b778e17eb9938e5e51382cb3e94f505f75544` |
| `tests/issue-211-search.test.mjs` | `c1bf5a61b4546e0b770221bb377f2f506c4cceee82858822cc3779476525f374` |
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

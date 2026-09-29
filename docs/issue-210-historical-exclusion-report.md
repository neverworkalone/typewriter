# Issue #210 — Historical exclusion recovery inventory

Generated from the machine inventory at `data/inventory/issue-210-recovery-inventory.json`. The generator builds a temporary SQLite database and checks current canonical search coverage without changing canonical records.

## Scope and policy

The current invariant from Issues #207–#209 is: every valid lexical entry within Typewriter's supported scope may serve as a searchable start. Historical roles and decisions remain recorded as history; they do not determine current search eligibility. This report inventories current unresolved candidates and records Issue #219's separately validated admission of a bounded reserve slice. Relation counts are not admission quotas.

The audit screened all 1,561 M5 target rows, joined all 100 Issue #204 decisions (90 map to M5 rows; 10 admitted rows are tracked separately), audited 3,757 promotion ledger events, traced 4 corrected M5-3 policy cases, and checked all current reference-only records. The M1–M4 pilot tables and handoffs do not preserve a complete standalone rejected/deferred candidate ledger. No unavailable ephemeral drafts or external raw material were reconstructed.

## Counts

Issue #219 result: 20 reviewed; 1 admitted, 9 held, and 10 rejected as compositional phrases.

| Measure | Count |
| --- | ---: |
| Recovery candidate records classified | 583 |
| Issue #204 records already admitted and searchable | 10 |
| Current canonical records | 5,077 |
| Current non-searchable lexical records | 0 |
| Current reference-only records, now searchable | 42 |
| Confirmed active usefulness/generality exclusions (#204) | 0 |
| Historical policy-rejection events, including later holds/corrections | 31 |
| True duplicate proposals | 2 |
| Invalid inflected-form proposals | 2 |
| Confirmed non-lexical proposals | 10 |
| Search-surface collisions | 1 |
| Explicit unresolved sense/POS/context cases | 181 |
| Additional rationale or lexical-unit holds | 75 |
| Unsupported lexical categories | 0 |
| Exact canonical search keys checked | 5,333 |

The 31 historical policy-rejection events include 25 Issue #204 rejects re-reviewed in Issue #211 (24 recovered and searchable, one held for an unresolved sense boundary), two M5-10A2 rejections that later became holds for lexical boundaries, and four M5-3 rejections later corrected and included in M5-7. No Issue #204 row remains an active usefulness/generality exclusion. The two M5-10A2 holds retain their blockers, and the four corrected cases are already searchable. M5's seven “insufficient admission priority” rejections and 20 generic M5-12A rejects remain on hold because their durable rationale does not establish a specific usefulness-only reason or lexical invalidity. The inventory also preserves 11 earlier M5 reject-to-hold transitions; two are the mixed utility cases counted above, while the others retain identity, sense, phrase, or context blockers.

All 5,077 current canonical records resolve directly. Their 5,333 canonical lemma/search-form keys have no missing owner, unexpected owner, or cross-record collision. This includes 42 historical reference-only records (41 entries and 1 expression); all their current lemmas resolve by the same canonical ID.

## New review states

| State | Count |
| --- | ---: |
| `admit-candidate` | 288 |
| `duplicate` | 2 |
| `hold` | 229 |
| `invalid-lemma` | 2 |
| `needs-sense-split` | 27 |
| `not-a-lexical-unit` | 10 |
| `recovered` | 24 |
| `search-surface-collision` | 1 |

`admit-candidate` means eligible for fresh bounded review, not admitted. It includes 234 remaining source-reviewed capacity reserves, 35 older capacity-deferred rows whose authored candidate body must be recovered, and 19 open M5 candidates. Issue #219 reviewed 20 of the original 254 M5-13/14/15 capacity reserves: 1 admitted and searchable, 10 rejected as compositional phrases, and 9 held for unresolved fixedness evidence. Issue #211 recovered 24 of the 25 mandatory Issue #204 candidates; the remaining candidate is held for a source-bound sense split. Holds preserve unresolved identity, context, sense, lexical-unit, or historical-rationale questions. The 20 generic M5-12A rejects are not called non-lexical: their candidate-specific lexical-unit status is unresolved. No proposed POS or record type falls outside the current supported category set.

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
| 2 | Previously included M5-13/14/15 reserve candidates deferred only by capacity | 234 | Issue #219 calibrated a 20-record first batch; review later batches in bounded groups sized from observed defects and workload. | Treat historical fit as useful provenance, then re-run current lexical identity and sense checks; do not admit by quota. Issue #219 admitted 1 of the original 254; 9 remain held and 10 were rejected as compositional phrases. |
| 3 | Legacy capacity-deferred and open M5 candidate rows | 54 | Separate source recovery from 10–20 record review batches. | Recover missing authored candidate content for 35 legacy deferred rows; route 19 open candidates through normal review. |
| 4 | Held or otherwise unresolved rows | 256 | Resolve blockers individually, then place only cleared records into later bounded batches. | Keep the 172 explicit sense/POS/context cases and 75 other rationale or lexical-unit holds visible until their evidence is complete. |
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
| `data/batches/issue-219-m9-a-semantic-decisions.json` | `3768d2a12398989d012d003c1c93f5f661d8be4ca00091542d74284d37e49d07` |
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
| `data/canonical/issue-204-corpus-pilot.jsonl` | `d600ef23a911afa4c8e6bbb7ecce51260767225601c0c9c9adeb62287ae72843` |
| `data/canonical/issue-211-bounded-recovery.jsonl` | `3844cfa4d38e4d99cfd4623670913b224f6b77feaf507d8d48589fb3e95531e9` |
| `data/canonical/issue-219-m9-a-recovery.jsonl` | `a5835bf370977fb468eba4ad60e051ac4ac8ad54f67f9adb3f34a7378447828d` |
| `data/canonical/m5-10-wave-a.jsonl` | `08e0afedcfb7c530b3e22f9144f43c1d8c923dc545ab96fec1cc961eaca384ed` |
| `data/canonical/m5-10-wave-b.jsonl` | `575def45e3df1fdfca79cb060ab2a3c4b04c060a067d806ab78454af15abb206` |
| `data/canonical/m5-10a-wave-a2.jsonl` | `4be5e7571f0d219fe3a30e68eaa0dc0cca832fbfe8402fe379a46f9f4e7768a8` |
| `data/canonical/m5-11-expansion.jsonl` | `8d3d51bae63503b209e1a7713e8a67fc74616ca03cd80f135a37a0247cf763ed` |
| `data/canonical/m5-12a-expansion.jsonl` | `3f4362a8fb109a6d2d44bf9cc42f63d64cb58c5ddae0084dcab5ac5fe347be45` |
| `data/canonical/m5-13-expansion.jsonl` | `4af53e85dba0ee65906c51d7ba68d439e78b7bdd77ab50438e42f3afb0fda426` |
| `data/canonical/m5-14-expansion.jsonl` | `53ce22151cb109b651a16f842c7cc73f43663fcf065b503222472e129658bf87` |
| `data/canonical/m5-15-expansion.jsonl` | `69a686c84da2f65effc659fda3dee969de460cc9ea853d9723d0dbf9f36026b4` |
| `data/canonical/m5-3-calibration.jsonl` | `2a080a0d473a071917d58860621d9e9b965c7737776b753fd1534a96f50c7d3a` |
| `data/canonical/m5-5-recalibration.jsonl` | `8e75e819159891ce60d2c4c5c7821cc89f30f54efcee1c38ea9c5a102fe980a0` |
| `data/canonical/m5-7-recalibration.jsonl` | `a37677f7569e016e5e8f9525b978ec4911ff0c9afb5ba7f65d3c40dae5fc71c1` |
| `data/canonical/m5-9-expansion.jsonl` | `a47e9322813780efd2eae29b2b5784bcd2948d7c3f7de621174ebee4a35ce4c4` |
| `data/canonical/pilot.jsonl` | `d45c15164ef6f146ee51d40e265746515120a556b1e2fb65e057ed36781dff1d` |
| `data/inventory/m5-target-promotions.jsonl` | `745227dbdb59f11e1026193fd759fe15526e278374a0f115b88676503c7afaa5` |
| `data/inventory/m5-target-seed.json` | `60ffc2ed4625678166438561b3eff3c39a2348b99fe411b1717be1cdceee875a` |
| `data/validation/canonical-semantic-decision-source.json` | `d8d89c5eff46511a0dd45708dab8615968980496f8ced9c51fc92ebfef7428d1` |
| `data/validation/issue-219-m9-lexical-batch-report.json` | `e447704d92f979a27950c29f871c3c952970b883c266f44f047f3a10f9a001ee` |
| `data/validation/m6-2-inflection-exceptions.json` | `037661676b8ab5e106a4a9889f3e018d97c9b5d8c4c4b18367d4247cbc8916c6` |
| `data/validation/m6-3-surface-form-review.json` | `0f6cc8f968c7a208dfcee33e33d82936827dbe2ea9433de27ab4c249501cce60` |
| `docs/editorial-model.md` | `308d56389339f8aa82247ef6382f314637087351b911e4cf642bee055ae2bdaf` |
| `docs/issue-208-searchable-start-retrospective.md` | `3e5dfd512389b4a505010686c10c32e0cdfdbb328290e1f4f0bc92a8f6aa6621` |
| `docs/issue-211-bounded-lexical-recovery.md` | `e0a264b879f612b32fd20ebbb3c0a475d324ded5f461d4d0406f27bcb820a294` |
| `docs/issue-219-m9-a-recovery.md` | `4505a8872a0547e0a9713687b43fc2a5fe753f28a5c3f65170b5081af7996cb5` |
| `docs/m3-handoff.md` | `215dedb02808c108ba06c9d20258d9fde5c03b3c5a35da556320a8c652ab3b04` |
| `docs/m4-handoff.md` | `4492845b7a362c70b4ddb7a4c7582f2d37b3e6d2c9a9afa394edb414ed714c49` |
| `docs/m5-16-final-audit-report.md` | `a60a58a20551d72c0388b8fd99fe5d92b3fd19c3a76cd3701c7d7e8fc82739f8` |
| `docs/m5-target-inventory.md` | `a819063b520935291f310d59a78ca37c9616d3266039ebd4952a61e48a82f88e` |
| `docs/m6-1-quality-baseline.json` | `4eb83fd3d19c8ff0b522300430e4107f002850907161f2bdcd97ba3872195209` |
| `docs/m6-1-searchable-lexical-baseline.json` | `1bb15c9a6f65c5120c9bfdd651521f0c73ab8583e0c8a4a3fd76b75751f86d53` |
| `docs/m6-1-searchable-lexical-baseline.md` | `bf0a12fc1473a95dbbb72a6df47bdd253254fa92ff12ba678fd373595201f8c3` |
| `docs/m9-bounded-lexical-batches.md` | `19d605c2721690cb28dfdb5726c84443cd88ccdfd32ceb97e030b34b0fff8e68` |
| `docs/pilot-scope.md` | `9d1d23b63c828838e5b326ee69e080f57a68ffae6e0e31dfe05e99d0865e6881` |
| `package.json` | `646d30d330d3ec73bf7e49075e65045145a6af2e0820898ee48f7c0deb5550c8` |
| `schema/m9-lexical-batch-report.schema.json` | `e2137ba54f1610f11412c8e6ce6da2cafc3f9b8b7a8b51dedb03c93b1db76dcb` |
| `scripts/batch/authored-semantic-decision-source.mjs` | `e5248f1956a6db753b3927c1314fa439cbf704c906393ab51dbe79ea2fb069ee` |
| `scripts/batch/lexical-production.mjs` | `ff86fba91b48dbcf8cafaf87199f22b64d8fff57a3cee3e2a32e8f3f93fa2d91` |
| `scripts/batch/validate-issue-211.mjs` | `661f8ca260d3b477806cbf2744122d103094baecc3b8a3f7c0f60cd9fdf7a7e7` |
| `scripts/batch/validate-issue-219.mjs` | `03cfa1a1ff8a8fc05e7192fa135d8608b2cf5d0c732679526fb49cb5f3b178fd` |
| `scripts/ci/registry.mjs` | `4f987aea0c52062ebce819d6b31ce43652db42b80055fd63e0be766baef3e2f4` |
| `scripts/inventory/build-issue-210-recovery-inventory.mjs` | `a53bf4817c8629211c42203b4a48320f0e157a7d51ba5c73b833fbf0c6b27289` |
| `scripts/validate/semantic-decision-row.mjs` | `3019f5ce59c778a6e913f30c49c915508dfbb1792db891f410af86ff6a857d3e` |
| `tests/issue-211-search.test.mjs` | `2c8936af05ef33e592cc9482f239ef75609ebcfbd992a2ade1b79856897cde25` |
| `tests/issue-219-content-digest.test.mjs` | `a6d5daecfb4985724cb5e14a74269f1cad0ca44697199f30a689ce4a532beeda` |
| `tests/issue-219-search.test.mjs` | `5251920ce88977d5ea2cd26f7e7861264e773f2a0b97aea819e8b78e125967b1` |
| `tests/lexical-production-candidates.test.mjs` | `323d63a9b6252f0ceae89a26c266527abb6ce98d36a51ee47e18fd75bab1b3a8` |
| `tests/searchable-start-contract.test.mjs` | `b655b1fff0ceb85c261802b09f81c470a623f6c8a2318c57226fb129d6159092` |

## Known limits

- M1–M4 provide a 300-item pilot selection table, canonical pilot records, and historical M3/M4 handoffs, but not a complete durable list of every rejected or deferred candidate. The inventory does not infer omitted lemmas from those missing lists.
- Historical M5 decision notes such as “insufficient admission priority” are preserved as ambiguous evidence. They remain on hold until candidate-specific lexical grounds can be recovered.
- Issue #211 re-reviewed all 25 Issue #204 rejects through the shared semantic and admission contracts. Twenty-four now have admitted canonical bodies; one remains held because its current single-sense gloss collapses distinct uses.
- Current search coverage describes canonical lookup only; it does not claim editorial quality, writer satisfaction, or relation completeness.

## Reproduction

`npm run inventory:issue-210` checks the committed JSON and Markdown against current canonical data and source digests. Use `npm run inventory:issue-210:write` to regenerate both outputs after an authorized source change.

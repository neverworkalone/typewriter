# M6-1 searchable lexical baseline and 1.0 gates

## Decision

This snapshot measures direct search across every valid supported canonical
record, including records whose historical role was `reference-only`. Role
counts remain available as provenance, while reachability, relation-gap, and
writer-facing candidate measures use the complete searchable population. The
snapshot does not establish writer satisfaction, full-corpus relation
correctness, or useful ranking where the product exposes no ambiguous result.

The population correction keeps the existing bounded M6-2/M6-3 forms and
collision review. It does not authorize corpus recovery, broader morphology,
bulk relation generation, or ranking redesign.

## Reproduction

`docs/m6-1-searchable-lexical-baseline.json` is the machine-readable snapshot. It binds the
canonical JSONL digest and the M4 search regression fixture digest. The
checker reloads canonical JSONL without a shared cached context, builds a
temporary SQLite database, checks all distinct valid canonical lemmas and
search forms, and compares the derived metrics, gate contract, and generated
report with the committed artifacts. The temporary database is deleted after
the run.

```sh
npm run baseline:m6-1
node --test tests/m6-1-quality-baseline.test.mjs
```

This version is tied to the Issue #209 start canonical digest. If a later M6
change changes canonical data or the search population contract, preserve this
version as historical evidence and create a new versioned baseline.

## Measured snapshot

### Snapshot identity

| Field | Value |
| --- | --- |
| Issue | #209 |
| Issue-start repository commit | e4bdaeb119481e0cd13d070d4b2e5ddb703ed06a |
| Canonical content digest | 34e71c58f9855fd2f5f4cd7478c77a40e8b2f1ba63bc29201b3f3ed86d0b3e09 |
| Canonical JSONL files | 14 |
| M4 regression fixture SHA-256 | 2736c19b37896730066426deb650af8d12fa10a2dd337d4c7834790f170e1e27 |

### Canonical inventory

| Measure | Count |
| --- | --- |
| Canonical records | 5,052 |
| Direct-searchable records | 5,052 |
| Direct-searchable senses | 5,314 |
| Historical start-role records | 5,010 |
| Historical reference-only-role records | 42 |
| All senses | 5,314 |
| Historical start-role senses | 5,272 |
| Historical reference-only-role senses | 42 |
| Expression records | 1,154 |
| Directed relation tuples | 487 |

| Role | Record type | Count |
| --- | --- | --- |
| start | entry | 3,857 |
| start | expression | 1,153 |
| reference-only | entry | 41 |
| reference-only | expression | 1 |

| Role | Records by sense count | Single-sense | Polysemous |
| --- | --- | --- | --- |
| start | 1 sense(s): 4,761; 2 sense(s): 237; 3 sense(s): 11; 4 sense(s): 1 | 4,761 | 249 |
| reference-only | 1 sense(s): 42 | 42 | 0 |

POS sense counts and records containing that POS by role. Record counts can overlap.

| POS | start senses | start records | reference-only senses | reference-only records |
| --- | --- | --- | --- | --- |
| Adjective | 309 | 254 | 5 | 5 |
| Adverb | 4 | 4 | 0 | 0 |
| Expression | 1,175 | 1,153 | 1 | 1 |
| Noun | 3,125 | 3,032 | 27 | 27 |
| Verb | 659 | 570 | 9 | 9 |

### Searchable-record relation coverage, type, and direction

| Searchable record type | Relation-bearing | Relation-empty | Total |
| --- | --- | --- | --- |
| entry | 317 | 3,581 | 3,898 |
| expression | 19 | 1,135 | 1,154 |
| Total | 336 (6.65%) | 4,716 (93.35%) | 5,052 |

| Relation type | Directed tuples | Target roles |
| --- | --- | --- |
| action | 35 | reference-only: 2, start: 33 |
| antonym | 51 | start: 51 |
| association | 47 | reference-only: 3, start: 44 |
| direct | 22 | reference-only: 20, start: 2 |
| mood | 81 | reference-only: 2, start: 79 |
| near | 111 | reference-only: 13, start: 98 |
| scene | 44 | reference-only: 3, start: 41 |
| sensory | 96 | reference-only: 9, start: 87 |

| Direction measure | Counts |
| --- | --- |
| Source roles | start: 487 |
| Target roles | reference-only: 52, start: 435 |
| Source role → target role | start->reference-only: 52, start->start: 435 |
| Source POS | {"adjective":78,"expression":25,"noun":312,"verb":72} |
| Tuples with a same-type, same-sense reverse | 86 |

Coverage and correctness are separate. No relation-density target or reverse-edge requirement is inferred from these counts.

### Search reachability and regression evidence

| Search-form measure | Count |
| --- | --- |
| Searchable form values | 5,308 |
| Distinct searchable form values | 5,308 |
| Records containing their lemma as a form | 5,052 |
| Records with an alternate form | 253 |
| Alternate form values | 256 |
| Cross-record form collision groups | 0 |
| Distinct exact searchable keys | 5,308 |
| Cross-record exact-key collision groups | 0 |
| Multi-result exact keys | 0 |
| Writer-facing exact-query population | 5,308 |
| Exact queries with at least two record/sense candidates | 342 |
| Ambiguous queries with multiple records | 3 |
| Ambiguous queries with multiple senses in one record only | 339 |
| Candidate options across ambiguous queries | 698 |
| Writer-facing options per exact query | {"1":4966,"2":329,"3":12,"4":1} |

| Exhaustive runtime key check | Count |
| --- | --- |
| Keys queried | 5,308 |
| Expected keys reachable | 5,308 |
| Missing expected results | 0 |
| Unexpected results | 0 |
| Unexpected keys | 0 |
| Unsupported canonical keys | 0 |
| Mismatched keys | 0 |

M4 corpus m4-search-regressions (schema 2, 12 cases):

| Input class | Cases |
| --- | --- |
| editorial-gap | 1 |
| exact-lemma | 5 |
| exact-search-form | 1 |
| no-data | 1 |
| normalization-candidate | 2 |
| unsupported | 2 |

| Evaluation | Cases |
| --- | --- |
| baseline | 10 |
| pending | 2 |

| Recorded actual status | Cases |
| --- | --- |
| no-match | 2 |
| ready | 9 |
| unsupported | 1 |

| Regression disposition | Value |
| --- | --- |
| Baseline cases matching recorded expectations | 10/10 |
| Pending case IDs | m4-editorial-gap-record-without-relations, m4-unsupported-inflected-form |
| Expected/actual mismatch IDs retained as pending | m4-editorial-gap-record-without-relations, m4-unsupported-inflected-form |

### Frozen benchmark and quality gates

| Sampling rule | Contract |
| --- | --- |
| Stable seed | m6-1-searchable-lexical-benchmark-v2 |
| Stable hash | input: seed + U+0000 + stratum + U+0000 + stable_unit_id; encoding: UTF-8 bytes of the exact strings; digest: lowercase SHA-256 hexadecimal; order: digest ascending; ties compare stable_unit_id UTF-8 bytes ascending; normalization: none; do not trim, NFC-normalize, or locale-sort sample identifiers |
| Direct relation sample | min(60, current direct-tuple count); census when the current count is 60 or less. Current population: 22. |
| Other relation samples | min(20, current tuple count for that type); census when a type has fewer than 20 tuples. Report all eight canonical relation types separately; a type with zero tuples is coverage evidence, not a pass on correctness. |
| Relation-gap sample | min(80, current relation-empty searchable record count). Strata: record_type × first-sense POS; first sense follows canonical order. Allocation: Set each initial quota to min(10, stratum population). Allocate remaining slots to remaining capacities with the Hamilton largest-remainder method: floor each exact proportional quota, then give leftover slots by descending fractional remainder, breaking ties by stratum UTF-8 byte order. If a stratum reaches capacity, repeat over the remaining capacities. |
| Ambiguous-query sample | min(40, writer-facing ambiguous exact-query count); at least 20 cases are required to evaluate a ranking change. |
| Ranking candidate population | exact query whose ordered writer-facing candidate list has at least two record/sense options. One candidate per record when it has zero or one sense; one candidate per sense when a record has multiple senses. Preserve runtime record order and canonical sense order, matching DictionaryPanel exact-mode candidateOptions. Population metric: metrics.search.writer_facing_candidate_population.ambiguous_query_count. |
| Writer-task sample | 100 tasks from 10 writers, 10 tasks each. Fill the assigned slots before reviewing outcomes. If a slot is unfilled, HOLD; do not replace a result after seeing its outcome. |
| Writer-task participant allocation | Assign five participants to pattern A and five to pattern B before collection. Pattern A per participant: 3 direct replacement, 2 sense choice, 2 expression exploration, 2 relation exploration, 1 no-data/policy boundary. Pattern B: 3 direct replacement, 2 sense choice, 1 expression exploration, 3 relation exploration, 1 no-data/policy boundary. |
| Writer-task source | Writer-authored needs and Typewriter-authored prompts; do not retain the writers’ original sentences in Git. |

| Sample family | Stratum | Stable unit ID | Eligible population |
| --- | --- | --- | --- |
| relation_tuple | JSON.stringify(["relation", type]) | JSON.stringify([source_record_id, source_sense_id, target_record_id, target_sense_id ?? null, type]) | one canonical directed relation tuple |
| relation_gap_record | JSON.stringify([record_type, first_sense.pos]) | canonical record.id | valid searchable canonical record with no outgoing relation on any sense |
| ambiguous_query | exact-writer-facing-candidate-query | exact runtime-normalized query string, preserving its codepoints | runtime exact-query result expands to at least two ordered (record, sense) candidate options in interactive DictionaryPanel exact mode |
| writer_task | task_intent | opaque_task_id assigned before outcome collection; never derived from writer text | preassigned writer task in one of the fixed intent slots |

| Writer-task intent | Tasks |
| --- | --- |
| direct_replacement | 30 |
| sense_choice | 20 |
| expression_exploration | 15 |
| relation_exploration | 25 |
| no_data_or_policy_boundary | 10 |

Each canonical review case receives 2 independent judgments. A designated editorial decision owner adjudicates disagreements before the case is counted. Keep case IDs, structured outcomes, and source digests. Do not commit writer sentences, raw query context, or external source text.

| Quality dimension | Baseline status | Sample | PASS condition | Machine threshold |
| --- | --- | --- | --- | --- |
| canonical-integrity | PASS | Exhaustive validators and semantic audit. | All canonical/schema/integrity/semantic-audit checks pass; every changed record and sense is covered; zero blocking findings. | {"covered_records":1,"covered_senses":1,"blocking_findings":0} |
| direct-substitutability | NOT_MEASURED | Stable-hash sample up to 60 directed tuples; current population of 22 is a census. | At least 95% of sampled direct tuples are judged substitutable in the recorded sense and direction; zero critical POS or sense-boundary errors. | {"accepted_rate":0.95,"critical_errors":0} |
| relation-usefulness-and-type-honesty | NOT_MEASURED | Up to 20 stable-hash directed tuples per non-direct type; report each type separately. Keep direct relations under their stricter gate. | For every non-empty relation type, at least 80% of its sample is both writer-useful and correctly typed, sense-bound, and directed; zero critical POS or sense-boundary errors. | {"accepted_rate_per_type":0.8,"critical_errors":0} |
| relation-coverage-and-gaps | MEASURED_NO_DENSITY_GATE | Up to 80 relation-empty searchable records, stratified by record type and first-sense POS, plus the relation-exploration writer tasks. | Review every selected gap and disposition it. At least 80% of writer tasks whose stated need is relation exploration reach one relevant result; record remaining high-demand gaps explicitly. | {"reviewed_gap_sample":1,"relation_exploration_task_success":0.8} |
| search-reachability-and-boundaries | PASS | Exhaustive unique canonical keys plus the shared M4 regression corpus. Pending cases remain pending until an explicit policy decision. | 100% of valid searchable canonical lemmas and curated search forms resolve to their expected IDs; zero unexpected results or missing results; all non-pending M4 cases retain their expected results and policy boundaries. | {"exact_key_reachability":1,"unexpected_results":0,"missing_results":0} |
| ranking-and-order-usefulness | NOT_MEASURED | Stable-hash sample up to 40 exact queries with at least two writer-facing (record, sense) candidates. N/A only when no such case is exposed; a ranking change with fewer than 20 cases is HOLD. | For a ranking or sense-order change, at least 80% of the top writer-facing candidates match the adjudicated writer choice across at least 20 ambiguous exact-query tasks; preserve deterministic record and sense ordering. | {"writer_preferred_top_candidate":0.8,"minimum_ambiguous_tasks":20} |
| writer-task-usefulness | NOT_MEASURED | 100 tasks from 10 writers, ten tasks each, with the fixed intent counts above. | At least 80 of 100 tasks produce a result the writer says they would use or deliberately adapt; every intent and any POS/record-type slice with at least 10 tasks scores at least 70%; zero critical misleading-result cases. | {"overall_success_rate":0.8,"minimum_slice_success_rate":0.7,"critical_misleading_results":0} |

| Overall decision | Semantics |
| --- | --- |
| pass | Every applicable dimension passes and every required sample is complete. |
| hold | Any dimension fails, required evidence is missing, or a reviewer disagreement remains unadjudicated. |
| not_applicable | Use only when the current product and the proposed change expose no cases for that dimension. A missing sample is HOLD, not N/A. |
| combine | Do not average dimensions or let a strong result in one dimension offset a failure in another. |

### M5 inherited risks and scope

| Risk | Source | Recorded measure | Disposition |
| --- | --- | --- | --- |
| relation-candidate-noise-is-stage-specific | docs/m5-16-final-audit-report.md | 9 | Keep each M5 proposal denominator with its stage. The stage-specific candidate noise rates do not measure the correctness of all 487 current canonical tuples. |
| editor-time-is-incomplete | docs/m5-16-final-audit-report.md | 6199.055 | This is a partial lower bound, not total M5 editor time; do not treat agent-gated stages as zero human time. |
| m5-10k-and-morphology-not-authorized | https://github.com/neverworkalone/typewriter/issues/173 | — | This correction preserves the existing bounded M6-2/M6-3 morphology contract while authorizing no corpus expansion, broader morphology, bulk relation generation, or ranking architecture. |

## Interpretation and limits

Search reachability, corpus coverage, relation correctness, and writer
usefulness are separate measures. A searchable record without a relation is
not by itself an editorial defect. A directed relation is authored as a
direction and does not imply a reverse edge. Historical M5 candidate-noise
rates retain their stage-specific denominators and do not estimate the
correctness of the current canonical relation set.

Pending M4 cases preserve unresolved morphology and editorial-gap policy.
They are recorded as pending evidence rather than silently treated as either
passing or failing this baseline.

No canonical data was changed to improve a baseline metric.

## Validation

Run the M6 baseline checker, its focused tests, current normal CI, and the
existing search regression validator/tests. This change does not affect a
browser-only boundary, so Chrome for Testing is not required.

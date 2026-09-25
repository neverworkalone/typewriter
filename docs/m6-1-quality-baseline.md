# M6-1 5K quality baseline and 1.0 gates

## Decision

The M6 starting snapshot is the accepted 5K canonical dictionary at `master`
commit `296289cef9109729d63ad1f8ced791a13d74617c`. Its canonical-content digest
is `8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`.
The measured counts reconcile with the M5-16 handoff.

The strongest measured result is exact search reachability: every distinct
canonical start key is reachable in a temporary SQLite build, with no missing
or unexpected result and no `reference-only` leak. The largest measured gap is
relation coverage: only 336 of 5,000 starts have any outgoing relation. That is
a coverage fact, not a finding that the other records are wrong or need a
relation. The current snapshot does not establish writer satisfaction,
full-corpus relation correctness, or useful ranking among multiple results.

This issue fixes the baseline and prospective gates. It authorizes no 10K
expansion, morphology, bulk relation generation, or ranking redesign.
The completion boundary is M6-2 planning/implementation only.

## Reproduction

`docs/m6-1-quality-baseline.json` is the machine-readable snapshot. It binds the
canonical JSONL digest and the current M4 search regression fixture digest. The
checker reloads the canonical JSONL without a shared cached context, builds a
temporary SQLite database, checks all distinct start lemmas and search forms,
and compares the derived metrics and gate contract with the committed snapshot.
The temporary database is deleted after the run.

```sh
npm run baseline:m6-1
node --test tests/m6-1-quality-baseline.test.mjs
```

The snapshot is tied to the issue-start canonical digest. If a later M6 change
changes canonical data, preserve this version as historical evidence and create
a new versioned baseline instead of rewriting this one.

## Canonical inventory

| Measure | Count | Notes |
| --- | ---: | --- |
| Canonical records | 5,042 | All record types and roles |
| Search starts | 5,000 | Includes entries and expressions |
| Reference-only records | 42 | Not free-search starts |
| All senses | 5,301 | 5,259 on starts and 42 on reference-only records |
| Directed relation tuples | 487 | Sense-bound; no symmetry is assumed |
| Expression records | 1,154 | 1,153 starts and one reference-only record |

Start record type and sense profile:

| Start profile | Count |
| --- | ---: |
| Entry records | 3,847 |
| Expression records | 1,153 |
| Single-sense starts | 4,754 |
| Two-sense starts | 234 |
| Three-sense starts | 11 |
| Four-sense starts | 1 |
| Polysemous starts | 246 |

The POS table counts senses and starts with at least one sense of that POS.
Record counts can overlap because a polysemous record may contain more than one
POS.

| POS | Start senses | Starts containing POS |
| --- | ---: | ---: |
| Noun | 3,113 | 3,023 |
| Verb | 658 | 569 |
| Adjective | 309 | 254 |
| Adverb | 4 | 4 |
| Expression | 1,175 | 1,153 |

The 42 reference-only records have 41 entry records and one expression record;
their senses are 41 nouns and one expression, and all 42 are single-sense.

Every start includes its lemma in `search_forms`. There are 251 additional
curated search-form values across 248 starts. The 5,251 start search-form
values are distinct across records, so the current snapshot has no exact-key
collision that returns multiple start records.

## Relation coverage and relation correctness

Coverage is reported independently of correctness:

| Start record type | Relation-bearing | Relation-empty | Total |
| --- | ---: | ---: | ---: |
| Entry | 317 | 3,530 | 3,847 |
| Expression | 19 | 1,134 | 1,153 |
| **Total** | **336 (6.72%)** | **4,664 (93.28%)** | **5,000** |

The 487 directed tuples by canonical type are:

| Relation type | Directed tuples |
| --- | ---: |
| `direct` | 22 |
| `near` | 111 |
| `antonym` | 51 |
| `mood` | 81 |
| `scene` | 44 |
| `sensory` | 96 |
| `action` | 35 |
| `association` | 47 |

All 487 tuples originate on `start` records. Their targets are 435 `start`
records and 52 `reference-only` records. Eighty-six tuples have a reverse tuple
with the same type and sense binding. The remaining direction patterns are not
automatically defects: a relation is an authored direction, not an implied
undirected edge.

The M5-15 global semantic audit covers all 5,042 records and 5,301 senses with
zero open blockers. That establishes audit coverage and canonical consistency;
it is not a new human usefulness review of every relation. M5-16's focused
writer-facing sample reviewed nine cases with zero open blockers. M5 candidate
noise results used different stage-specific denominators, and M5-12A through
M5-15 admitted no new relation tuples. Those figures remain historical process
evidence and do not estimate correctness of the 487 current tuples. Relation
correctness and writer usefulness are therefore marked **not measured** for
this 5K baseline.

## Search reachability and known gaps

The issue-start runtime build checked every distinct exact lemma or curated
search form:

| Check | Result |
| --- | ---: |
| Distinct start keys checked | 5,251 |
| Keys returning the expected start records | 5,251 |
| Missing expected results | 0 |
| Unexpected results | 0 |
| `reference-only` results from free search | 0 |
| Cross-record exact-key collision groups | 0 |

The shared M4 regression corpus has 12 cases: 10 baseline cases match their
recorded expectations, and two remain pending. It contains four exact-lemma
cases, one exact-search-form case, two normalization cases, one no-data case,
three unsupported-policy cases, and one editorial-gap case.

The pending cases preserve unresolved policy rather than failed baseline gates:

- `m4-unsupported-inflected-form`: `담담했다` currently returns no match; M4
  leaves morphology classification pending.
- `m4-editorial-gap-record-without-relations`: `마당` is searchable but has no
  relation; whether a useful relation is missing remains an editorial question.

Other specific boundaries already represented include the blocked
free-searching of a reference-only target, exact expression spacing, NFC,
surrounding-whitespace trimming, and a no-data query. The remaining search and
relation evidence gaps are:

- There is no current writer-task success rate.
- Direct relations are only 22 of 487 tuples, and their whole-corpus
  substitutability has not been independently sampled.
- The 4,664 relation-empty starts have not been sampled for writer demand; low
  coverage alone does not authorize filling them.
- No multi-result exact key exists, so ranking usefulness is not exercised.
- The two pending M4 cases require explicit future policy/editorial decisions.

## Frozen benchmark and 1.0 gates

The machine-readable gate contract is embedded in the JSON snapshot as
`m6-1-quality-gates-v1`. Thresholds below are prospective policy floors, not
claims measured from the 5K corpus. They are frozen before M6 evidence
collection; changing them requires a new version before the next sample is
reviewed.

| Dimension | Sampling rule | PASS threshold |
| --- | --- | --- |
| Canonical integrity | Exhaustive schema, integrity, and semantic audit | 100% of changed records and senses covered; zero blocking findings |
| Direct substitutability | Up to 60 directed `direct` tuples; the current 22 are a census | At least 95% judged substitutable in the recorded sense and direction; zero critical POS/sense errors |
| Other relation usefulness and type honesty | Up to 20 tuples per non-direct type; report all eight types separately | At least 80% per type are writer-useful and correctly typed, sense-bound, and directed; zero critical errors |
| Relation coverage and gaps | Up to 80 relation-empty starts, stratified by record type and first-sense POS; 25 relation-exploration writer tasks | Review and disposition the gap sample; at least 80% of relation-exploration tasks reach one relevant result. No corpus-density quota. |
| Search reachability and boundaries | Exhaust every unique start key plus the shared M4 corpus | 100% expected key reachability; zero missing/unexpected results or role leaks; all non-pending M4 cases retain their contract |
| Ranking and order usefulness | Up to 40 ambiguous queries; at least 20 required for a ranking change | At least 80% of top results match the adjudicated writer choice; retain deterministic ordering and exact-match tiers |
| Writer-task usefulness | 100 tasks from 10 writers, 10 tasks each | At least 80/100 useful outcomes; each intent and any POS/record-type slice with 10+ cases is at least 70%; zero critical misleading results |

The 100 writer tasks are split before collection: 30 direct replacement, 20
sense choice, 15 expression exploration, 25 relation exploration, and 10
no-data or policy-boundary tasks. Each canonical review case receives two
independent judgments; a designated editorial decision owner adjudicates
disagreements. For relation-empty records, allocate ten per non-empty
`record_type × first-sense POS` stratum (or census a smaller stratum), then
allocate remaining slots proportionally by largest remainder. Within each
stratum and relation type, select the lowest SHA-256 values of
`seed + NUL + stratum + NUL + stable_unit_id`, using the fixed seed
`m6-1-quality-benchmark-v1`.

An overall **PASS** requires every applicable dimension to pass with complete
evidence. Any failed threshold, missing sample, or unresolved reviewer
disagreement is **HOLD**. **N/A** is allowed only when the current product and
the proposed change expose no cases for that dimension; missing evidence is
never N/A. Dimensions are not averaged. Ranking is N/A at this baseline because
there are no ambiguous exact keys; a ranking change with fewer than 20 relevant
cases is HOLD.

## M5 risks retained

- Relation proposals had different stage-specific noise denominators. Keep
  those stage results separate; do not present an aggregate as the current
  relation correctness rate.
- The M5-16 report's 6,199.055 seconds of measured editor-time components are a
  partial lower bound. M5-3 was partial, M5-5 and M5-9 had unmeasured follow-up
  work, and Wave B producer time is not editor time. M5-11 through M5-15 mark
  human time `not-required`, not zero.
- M5 reached 5K under its accepted automated bounded gate. This baseline does
  not revisit those M5 decisions or claim an unmeasured human-time total.

No canonical data was added or changed to improve a metric.

## Validation

On the issue branch, run the M6 baseline checker, the focused metric tests,
current normal CI, and the existing search regression validator/tests. No
browser-only boundary changes are in scope, so Chrome for Testing is not
required.

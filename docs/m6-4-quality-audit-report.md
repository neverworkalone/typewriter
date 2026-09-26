# M6-4 5K writer-facing lexical quality audit

## Decision

**HOLD.** The M6-1 sampling contract has been applied to the issue-start 5K
canonical snapshot, and the selected cases are reproducible. The editorial
benchmark is not complete: 242 canonical review cases require 484 independent
judgments, no writer-choice outcomes were recorded for the separate ambiguous
query ranking sample, and no writer-task outcomes were available. Under the
fixed M6-1 contract, the 162 relation tuples and 80 relation-gap records are
canonical review cases; the 40 ambiguous queries are ranking cases, not
additional canonical cases. M6-1 requires writer-choice results across at
least 20 ambiguous exact-query tasks before a ranking change. The separate
writer-task plan requires 100 tasks completed by 10 writers. Its
exact-reachability gate also records two unexpected runtime results (`끈`,
`열`). No judgments or writer outcomes are inferred or fabricated here.

The exact sample is recorded in
[`m6-4-quality-audit-sample.json`](m6-4-quality-audit-sample.json). Recreate and
check it with:

```sh
node scripts/validate/m6-4-quality-audit.mjs --write
npm run audit:m6-4
```

The sample is bound to M6-1 contract `m6-1-quality-gates-v2`, seed
`m6-1-quality-benchmark-v1`, canonical revision
`8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`, the M6-1
baseline artifact, the M4 regression fixture digest, the M6-3 collision-review
manifest, and the relevant runtime source digests. M6-1 thresholds and sample
rules were not changed.

`npm run audit:m6-4` rebuilds this sample while its issue-start canonical,
baseline, M6-3 review, and runtime inputs are unchanged. If a later revision
changes those inputs, the command verifies this immutable issue-start snapshot
by its committed bytes and pinned source identity instead of recalculating it
against a later canonical corpus. Normal CI performs that inexpensive frozen
snapshot verification; it does not launch the full audit CLI or build a second
SQLite database. Use the standalone command for full re-derivation. A later
corpus needs its own audit sample.

## Measured corpus and selected samples

The issue-start corpus contains 5,000 searchable starts, 487 directed relation
tuples, and 4,664 starts without an outgoing relation on any sense (93.28%).
The gap count describes coverage, not quality: emptiness alone is neither an
editorial failure nor evidence that a writer needs another relation.

| Relation type | Population | Selected | Selection |
| --- | ---: | ---: | --- |
| direct | 22 | 22 | census |
| near | 111 | 20 | stable hash |
| mood | 81 | 20 | stable hash |
| scene | 44 | 20 | stable hash |
| sensory | 96 | 20 | stable hash |
| action | 35 | 20 | stable hash |
| association | 47 | 20 | stable hash |
| antonym | 51 | 20 | stable hash |
| **Total** | **487** | **162** | |

The fixed 80-record gap sample uses the M6-1 stratification and Hamilton
allocation:

| Stratum (record type × first-sense POS) | Population | Selected |
| --- | ---: | ---: |
| entry × adjective | 195 | 11 |
| entry × adverb | 4 | 4 |
| entry × noun | 2,816 | 32 |
| entry × verb | 515 | 14 |
| expression × expression | 1,134 | 19 |
| **Total** | **4,664** | **80** |

The current runtime exposes 338 exact queries with at least two record/sense
choices; 40 were selected. Of these, 336 are choices among senses within one
start record and two are cross-record exact-key collisions caused by generated
surface forms. The sample contains 39 two-candidate queries and one
three-candidate query. Neither collision was selected into the 40-query sample,
but both are included in its eligible population and the reachability result
below. This measures the available choice set, not whether the order matches
writers' preferred result.

The writer-task plan preserves the fixed allocation: five participant slots
use pattern A and five use pattern B, for 30 direct-replacement, 20 sense-choice,
15 expression-exploration, 25 relation-exploration, and 10 no-data/policy
boundary tasks. Recruitment, filled slots, and recorded outcomes are all zero.

The fixed independent-judgment protocol applies to 242 canonical cases
(162 relation tuples plus 80 relation-gap records), requiring 484 judgments.
The 40 ambiguous-query cases use the separate ranking protocol: no writer-choice
outcomes are recorded; at least 20 such tasks are required to evaluate a ranking
change. These two evidence families are not combined.

## Findings by quality dimension

| Dimension | Evidence and status |
| --- | --- |
| Direct substitutability | **Not measured.** The full 22-tuple direct sample is selected; the required 44 independent judgments are absent. |
| Other relation usefulness and type honesty | **Not measured.** The seven per-type samples are selected (20 each); the required 280 independent judgments are absent. No type is treated as passing based on tuple counts. |
| Relation gaps | **Coverage measured; impact not measured.** The 80 selected empty records still need two independent dispositions each (160 judgments total) as honest emptiness or a harmful gap. No density target is applied. |
| Search reachability and boundaries | **HOLD.** All 5,251 canonical exact keys return their expected start IDs, with zero missing keys, unsupported keys, or reference-only leaks. The current runtime also returns two extra records: `w1081` for `끈` (expected `w2969`) and `w192` for `열` (expected `w110`). The frozen M6-1 v2 gate requires zero unexpected results. The M4 regression corpus has 10/10 baseline cases matching expectations; two existing cases remain pending. |
| Ranking and order usefulness | **Not measured.** The 40-query sample is selected; 0/40 writer-choice outcomes are recorded. M6-1 requires at least 20 ambiguous exact-query task outcomes to evaluate a ranking change. The population includes 336 within-record sense choices and two cross-record exact-query collisions. |
| Writer-task usefulness | **Not measured.** The contract requires 100 outcomes from 10 writers; 0 were available. |
| Vocabulary coverage | **Not established.** Expected exact keys resolve, but this does not show which words writers tried and could not find. No user telemetry is present in the repository, and no real writer-task failures were observed. |

### Search reachability finding

**Classification: current search result-set mismatch against the frozen
M6-1 v2 reachability gate.** The runtime returns two extra start records for
canonical exact queries: `끈` returns `w2969` plus generated candidate `w1081`,
and `열` returns `w110` plus generated candidate `w192`. The M6-3 collision
manifest reviewed and retained both generated candidates. That M6-3 approval
does not remove them from the M6-1 v2 runtime result set or change its
zero-unexpected-results requirement. Accordingly, `npm run baseline:m6-1`
reports the two mismatches and exits nonzero. The M6-4 audit records them as a
HOLD finding; it does not filter candidates or revise the frozen gate.

The two additional cross-record choices raise the current writer-facing
ambiguous-query population from the M6-1 snapshot's 336 to 338. Both remain
eligible for the frozen stable-hash sample, even though neither falls within
the selected 40. The ranking sample therefore uses the current full runtime
candidate set.

The repository's real failure/boundary evidence is limited to its checked-in
regression fixtures. The M4 baseline has the pending editorial-gap case
`m4-editorial-gap-record-without-relations` and pending unsupported-inflection
case `m4-unsupported-inflected-form`; their pending disposition is preserved.
These cases are not writer telemetry and are not counted as observed user
failures.

## Root-cause classification and M6-5 backlog

No sampled relation has been judged, so this audit supports no canonical data
correction, producer/admission defect, typed-relation defect, harmful empty gap,
ranking defect, or vocabulary coverage claim. The one reproduced issue is the
current-runtime result-set mismatch against the frozen M6-1 exact-reachability
gate described above.

The bounded M6-5 evidence backlog is:

1. Obtain two independent judgments for each of the 162 relation tuples and 80
   relation-empty records (484 judgments total); adjudicate every disagreement
   before counting outcomes.
2. Collect writer-choice outcomes for the selected ambiguous-query ranking
   sample separately. Preserve the M6-1 minimum of 20 outcomes before evaluating
   any ranking change.
3. Recruit 10 writers and complete the preallocated 100-task pattern without
   replacing a task after seeing its outcome. Keep original sentences and raw
   query context out of Git.
4. Use those results to classify any corrections by root cause and rank only
   evidence-backed work. The current audit authorizes no bulk relation filling
   and no ranking change.
5. Resolve the two current search-result mismatches against the frozen
   reachability gate before treating the search dimension as passing. Preserve
   the M6-1 v2 contract unless a separately versioned successor is approved
   before new evidence collection.
6. Consider vocabulary coverage separately after real writer tasks expose
   concrete unmet needs. Current evidence does not show that 5K is insufficient.

No 10K or post-M6-5 expansion is recommended from this evidence. Expansion
remains unauthorized until writer-facing evidence demonstrates a coverage
deficit and an owner makes a separate decision.

## Acceptance status

| M6-4 criterion | Status |
| --- | --- |
| Apply the frozen M6-1 benchmark and sample rules | **Partial:** all canonical sample identities are selected reproducibly; human review and writer-task collection remain incomplete. |
| Report direct accuracy, relation usefulness/noise, gaps, ranking, and vocabulary separately | **Partial:** each dimension and its evidence state are reported separately; editorial outcomes remain unmeasured. |
| Classify findings by root cause | **Complete for available evidence:** one frozen-gate result-set mismatch; no relation-quality or vocabulary-coverage claim is inferred. |
| Decide whether sampled empty relations are honest or harmful | **HOLD:** requires the missing independent editorial judgments. |
| Define a bounded evidence-based M6-5 correction scope | **Partial:** only evidence collection is justified; data corrections cannot yet be scoped. |
| Avoid inferring authorization for expansion | **Complete:** no expansion is supported or authorized by this report. |
| Provide enough evidence for an owner decision | **Partial:** the owner can decide whether to schedule the fixed review; quality and expansion decisions remain open. |

## Validation

The following deterministic checks were run against the frozen M6-1 v2 contract:

- `node --test tests/m6-1-quality-baseline.test.mjs` — 9/9 passed, including a
  synthetic exact-plus-generated cross-record result that remains visible to
  the reachability and candidate-population checks.
- `npm run baseline:m6-1` — reports the expected M6-1 v2 failure: two
  unexpected runtime results, for `끈` and `열`.
- `npm run audit:m6-4` — all selected sample identities and source digests
  reproduce across 282 selected units: 242 canonical review cases and 40
  ambiguous queries. There are 0/484 independent canonical-case judgments,
  0/40 writer-choice outcomes on the ranking sample, and 0/100 writer-task
  outcomes, so the audit stays on HOLD. Its fixed-source boundary switches to
  historical snapshot verification after issue-start inputs change.
- `tests/m6-4-quality-audit.test.mjs` — valid sample comparison passes, while
  altered case identity, selection hash, source digest, decision status, and
  pinned historical identity are rejected; baseline/runtime changes block a
  `--write` without invoking sample generation or modifying the frozen file.
  The test also keeps canonical judgments separate from ranking choices.
  Normal CI registers this test and verifies the frozen sample bytes without
  launching the full audit CLI.
- `npm run ci:normal` — all canonical, lexical, toolchain, batch, product, and
  artifact categories passed; artifact policy reported `workingTreeClean: true`.
- `git diff --check`.

The change does not affect a browser-only boundary; Chrome for Testing is not
required.

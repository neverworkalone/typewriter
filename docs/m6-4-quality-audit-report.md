# M6-4 5K writer-facing lexical quality audit

## Decision

**HOLD.** The M6-1 sampling contract has been applied to the issue-start 5K
canonical snapshot, and the selected cases are reproducible. The editorial
benchmark is not complete: no independent case judgments or writer-task
outcomes were available. The fixed M6-1 contract requires two independent
judgments for each selected case and 100 tasks completed by 10 writers. No
judgments or writer outcomes are inferred or fabricated here.

The exact sample is recorded in
[`m6-4-quality-audit-sample.json`](m6-4-quality-audit-sample.json). Recreate and
check it with:

```sh
node scripts/validate/m6-4-quality-audit.mjs --write
npm run audit:m6-4
```

The sample is bound to M6-1 contract `m6-1-quality-gates-v2`, seed
`m6-1-quality-benchmark-v1`, canonical revision
`8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`, the M4
regression fixture digest, the M6-3 collision-review manifest, and the relevant
runtime source digests. M6-1 thresholds and sample rules were not changed.

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

There are 336 exact queries with at least two record/sense choices in the M6-1
writer-facing population; 40 were selected. All 336 are choices among senses
within one start record. None are cross-record exact-key collisions. The
sample contains 39 two-candidate queries and one three-candidate query. This
measures the available choice set, not whether the canonical sense order
matches writers' preferred result.

The writer-task plan preserves the fixed allocation: five participant slots
use pattern A and five use pattern B, for 30 direct-replacement, 20 sense-choice,
15 expression-exploration, 25 relation-exploration, and 10 no-data/policy
boundary tasks. Recruitment, filled slots, and recorded outcomes are all zero.

## Findings by quality dimension

| Dimension | Evidence and status |
| --- | --- |
| Direct substitutability | **Not measured.** The full 22-tuple direct sample is selected; the required 44 independent judgments are absent. |
| Other relation usefulness and type honesty | **Not measured.** The seven per-type samples are selected (20 each); the required 280 independent judgments are absent. No type is treated as passing based on tuple counts. |
| Relation gaps | **Coverage measured; impact not measured.** The 80 selected empty records still need independent dispositions as honest emptiness or a harmful gap. No density target is applied. |
| Search reachability and boundaries | **PASS for M6-1 exact keys.** All 5,251 canonical exact keys resolve to their expected start IDs; no missing, unexpected exact, unsupported, or reference-only results remain. The M4 regression corpus has 10/10 baseline cases matching expectations; two existing cases remain pending. |
| Ranking and order usefulness | **Not measured.** The 40-query sample is selected, but no writer-preferred candidate outcomes are recorded. The population consists of within-record sense choices. |
| Writer-task usefulness | **Not measured.** The contract requires 100 outcomes from 10 writers; 0 were available. |
| Vocabulary coverage | **Not established.** Exact-key reachability is complete, but that says nothing about vocabulary writers tried and could not find. No user telemetry is present in the repository, and no real writer-task failures were observed. |

### Search validator finding

**Classification: shared validator/audit gap.** After M6-3 added reviewed
surface-form results, the M6-1 exact-key baseline began counting two approved
generated candidates as unexpected exact results. For query `끈`, the exact
candidate is `w2969` and the M6-3-reviewed generated candidate is `w1081`.
For `열`, the exact candidate is `w110` and the reviewed generated candidate
is `w192`. The M6-3 collision manifest explicitly retains both generated
candidates while preserving exact-match precedence.

The M6-1 checker now filters its exact-key measure by exact-lemma and
exact-search-form provenance. The M6-3 surface-form validator remains
responsible for generated-form candidates. This preserves the frozen M6-1
metrics and thresholds while making the historical exact-key gate compatible
with the later reviewed projection. No canonical data or generated database
was changed.

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
shared M6-1 search-audit scope gap described above.

The bounded M6-5 evidence backlog is:

1. Obtain two independent judgments for each of the 162 relation tuples, 80
   relation-empty records, and 40 ambiguous-query cases; adjudicate every
   disagreement before counting outcomes.
2. Recruit 10 writers and complete the preallocated 100-task pattern without
   replacing a task after seeing its outcome. Keep original sentences and raw
   query context out of Git.
3. Use those results to classify any corrections by root cause and rank only
   evidence-backed work. The current audit authorizes no bulk relation filling
   and no ranking change.
4. Consider vocabulary coverage separately after real writer tasks expose
   concrete unmet needs. Current evidence does not show that 5K is insufficient.

No 10K or post-M6-5 expansion is recommended from this evidence. Expansion
remains unauthorized until writer-facing evidence demonstrates a coverage
deficit and an owner makes a separate decision.

## Acceptance status

| M6-4 criterion | Status |
| --- | --- |
| Apply the frozen M6-1 benchmark and sample rules | **Partial:** all canonical sample identities are selected reproducibly; human review and writer-task collection remain incomplete. |
| Report direct accuracy, relation usefulness/noise, gaps, ranking, and vocabulary separately | **Partial:** each dimension and its evidence state are reported separately; editorial outcomes remain unmeasured. |
| Classify findings by root cause | **Complete for available evidence:** one shared audit gap; no unsupported data or product defect claims. |
| Decide whether sampled empty relations are honest or harmful | **HOLD:** requires the missing independent editorial judgments. |
| Define a bounded evidence-based M6-5 correction scope | **Partial:** only evidence collection is justified; data corrections cannot yet be scoped. |
| Avoid inferring authorization for expansion | **Complete:** no expansion is supported or authorized by this report. |
| Provide enough evidence for an owner decision | **Partial:** the owner can decide whether to schedule the fixed review; quality and expansion decisions remain open. |

## Validation

The following deterministic checks passed after the M6-1 provenance correction:

- `node --test tests/m6-1-quality-baseline.test.mjs` — 9/9 passed.
- `npm run baseline:m6-1` — the frozen canonical digest matches; 5,251/5,251
  exact keys are reachable.
- `npm run audit:m6-4` — all selected sample identities and source digests
  reproduce; 0/564 independent judgments are present, so the audit stays on
  HOLD.
- `npm run ci:normal` — all canonical, lexical, toolchain, batch, product, and
  generated-artifact checks passed; the final artifact-policy check reported a
  clean working tree.
- `git diff --check`.

The change does not affect a browser-only boundary; Chrome for Testing is not
required.

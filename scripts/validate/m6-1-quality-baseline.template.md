# M6-1 5K quality baseline and 1.0 gates

## Decision

This issue records the accepted issue-start canonical dictionary, its measured
search behavior, and the prospective quality gates for M6 evidence. The
snapshot is a measurement of the current curated corpus; it does not establish
writer satisfaction, full-corpus relation correctness, or useful ranking where
the product exposes no ambiguous result.

The completion boundary is M6-2 planning and implementation. This issue does
not authorize corpus expansion, morphology, bulk relation generation, or
ranking redesign.

## Reproduction

`docs/m6-1-quality-baseline.json` is the machine-readable snapshot. It binds the
canonical JSONL digest and the M4 search regression fixture digest. The
checker reloads canonical JSONL without a shared cached context, builds a
temporary SQLite database, checks all distinct start lemmas and search forms,
and compares the derived metrics, gate contract, and generated report with the
committed artifacts. The temporary database is deleted after the run.

```sh
npm run baseline:m6-1
node --test tests/m6-1-quality-baseline.test.mjs
```

The snapshot is tied to the issue-start canonical digest. If a later M6 change
changes canonical data, preserve this version as historical evidence and
create a new versioned baseline instead of rewriting it.

## Measured snapshot

{{M6_1_GENERATED_SNAPSHOT}}

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

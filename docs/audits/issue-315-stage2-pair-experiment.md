# Experiment #315 — Stage 2 QA on the cherry-picked Stage 1 pair C000003 + C000004

> **EXPERIMENTAL COMPARISON PR. DO NOT MERGE INTO `master`.**
> This PR is based on a synthetic branch, not on `master`. The Stage 1 PRs #312 and #313 are
> **not** merged by this experiment, no `stage2-claims/*` ref was created, no tracking Issue was
> claimed, and the real Stage 2 queue and claim state are untouched. No canonical JSONL was edited.

Issue: [#315](https://github.com/neverworkalone/typewriter/issues/315) (related to #262).

## Frozen input and synthetic base

| Item | SHA |
| --- | --- |
| Frozen base (`master` at freeze) | `59e0e326bc7d966da2ac706f8bf3ed8e02f9c7a1` |
| #312 head | `02b971545174b27f25a692db6a32a12b7fa6eae0` |
| #313 head | `4079825bce8d1d804e5b41707eeaf2e7952ca4f5` |
| Synthetic base (Stage 2 input snapshot) | `7c059d64b57015fa7d186ebe17b1598a39179850` |

The synthetic branch `experiment/315-synthetic-312-313` was built from the frozen base by
cherry-picking, in order, #312's `02b9715` and then #313's `e9775f2`, `35c3378`, `4079825`.
(#313 is stacked on #312; its own first commit is the same `02b9715`, applied once.) Verification
after the cherry-picks: `git diff pr313-head synthetic` is empty, the only paths relative to the
frozen base are `data/candidates/C000003/*`, `data/candidates/C000004/*`,
`scripts/factory/corpus-context-source.mjs` and `tests/factory-ensemble.test.mjs`; the Stage 1
candidate bytes are unchanged by this PR except the declared operational `status: created → complete`.
Current `master` was never substituted. The canonical snapshot digest of both batches
(`43269c02…dd73`) equals the digest of the canonical data in this tree.

Candidate bytes digests: C000003 `15a8bb8c41988984f7e8d9fc356ade4ac6af6f402a3007c6647ef44c89dda057`,
C000004 `3f34c27f47f229c194ffcecfb4643a3c212d1245c4d3f82b3ea0679bc765b80c`.

## Method and provenance

Normal factory Stage 2 contract, run in one primary Claude context. **Provenance is honest agent
self-check** (`reviewer: claude-agent-self-check`, `human_reviewed: false`): no subagents, no other
model or CLI, no independent or human review is claimed. Every observation was judged against its
bounded original paragraph from the local, ignored corpus index (permission-gated, read-only);
no paragraph text, window or index data is committed. Decision reasons cite observation ids,
canonical sense ids and the judged meaning; any run of five or more non-space characters copied from
a candidate's source paragraphs was mechanically replaced by `원문 용례` before writing, and a scan of
every tracked reason, hold resolution, rationale and gloss found 0 residual overlaps at that length
(observed surface forms and lemma spellings are the only source-derived strings). Candidate decisions were authored per
observation, with split groups where one usage group held distinguishable senses; the review
artifacts (`decisions.jsonl`, `semantic-decisions.json`, `intake-handoff.json`, manifests) were
generated from those authored decisions by a local scratch script that is **not** committed (no
permanent factory feature was added). The hand-off was built by the shared intake with the pinned
`kiwipiepy==0.24.0`. Review manifests are `status: ready`, `attempt: 1`; candidate manifests are
`status: complete`.

Policies applied (shared rules, no batch-specific exceptions):

- an inflected/derived surface mistaken for a noun lemma (e.g. a verb 관형형 under a noun candidate),
  a proper name, or another headword's form → `rejected` (lemma identity);
- an observation whose POS differs from the usage group's only POS hypothesis, an auxiliary /
  constructional use with no lexical-sense evidence, and every upstream hard hold
  (`coverage_collision`) → `deferred` (never admitted, never silently dropped);
- meaning already canonical for the same lemma/POS → `covered` / `search_coverage` (per
  observation, proved against the canonical sense and the search-form projection);
- a distinct homograph or evidence-backed new sense is added as a new sense / new POS on the
  existing entry, never auto-`covered` from lemma/POS equality;
- gloss/sense admission uses the shared source-bound gates, including the single-axis writer-domain
  rule; relations are not authored (`no-relations`), and no admission, hold or rejection used
  commonness, usefulness or relation count.

## Results

| | C000003 | C000004 | Total |
| --- | ---: | ---: | ---: |
| Candidates (distinct lemmas) | 508 | 502 | 1,010 |
| Observations | 775 | 972 | 1,747 |
| **Candidate dispositions** | | | |
| included | 167 | 121 | 288 |
| rejected | 335 | 374 | 709 |
| held | 6 | 7 | 13 |
| deferred / corrected (candidate level) | 0 / 0 | 0 / 0 | 0 / 0 |
| Reviewed senses authored | 178 | 135 | 313 |
| **Usage-group entries** | | | |
| included | 178 | 135 | 313 |
| covered | 128 | 259 | 387 |
| search_coverage | 276 | 319 | 595 |
| rejected | 15 | 20 | 35 |
| deferred | 10 | 8 | 18 |
| **Observation fate** | | | |
| in an included group | 220 | 190 | 410 |
| covered | 144 | 284 | 428 |
| search_coverage | 384 | 465 | 849 |
| rejected | 16 | 22 | 38 |
| deferred | 11 | 11 | 22 |
| **Targets of included candidates** | | | |
| new_entry | 132 | 99 | 231 |
| new_sense_on_existing_entry | 32 | 19 | 51 |
| new_pos_on_existing_lemma | 3 | 3 | 6 |

`rejected` candidates are valid in-scope lemmas whose every observation was already canonical
(covered / search_coverage, zero new lexical content) or invalid identity (lemma/POS mismatch,
proper name); `held` candidates carry only deferred groups. Counts are group- and observation-level
facts, not quality scores.

### Hold resolution and correction

Stage 1 holds on observations: C000003 — 297 `analysis_ambiguous`, 13 `pos_mismatch`, 10
`lemma_mismatch`, 2 `coverage_collision` (299 held observations); C000004 — 452
`analysis_ambiguous`, 12 `pos_mismatch`, 8 `lemma_mismatch`, 7 `coverage_collision` (455 held
observations). Every included group with a held observation (or a held hand-off entry) carries a
candidate-specific `hold_resolution`: **126** in C000003 and **107** in C000004 judged on held
observations (all included groups carry the resolution text). Outcomes of the held observations:

| Hold | → included | → covered / search_coverage | → rejected | → deferred |
| --- | ---: | ---: | ---: | ---: |
| analysis_ambiguous (C000003 / C000004) | 155 / 139 | 118 / 282 | 16 / 22 | 8 / 9 |
| lemma_mismatch | 1 / 2 | 0 / 1 | 9 / 5 | 0 / 0 |
| pos_mismatch | 9 / 4 | 0 / 0 | 1 / 6 | 3 / 2 |
| coverage_collision (hard) | 0 / 0 | 0 / 1 | 0 / 0 | 2 / 6 |

No `corrected` dispositions: Stage 2 did not alter Stage 1 identity data; it only disposed it.
Lemma/POS mismatches that were real were rejected or deferred; the few mismatch holds that were
included were resolved by context (e.g. the observed surface really is the candidate lemma).

### Candidates introduced by contextual fallback

Provenance permits splitting by the Stage 1 `ensemble.resolution` of a candidate's observations
(`context` = decided by the local context review; `ensemble` = decided by the analyzer ensemble):

| Class | Batch | Candidates | included | rejected | held | Observations | obs in included groups |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| context-only | C000003 | 134 | 54 | 79 | 1 | 134 | 54 |
| context-only | C000004 | 133 | 45 | 87 | 1 | 136 | 45 |
| mixed (context + ensemble) | C000004 | 191 | 39 | 152 | 0 | 478 | 80 |
| ensemble-only | C000003 | 374 | 113 | 256 | 5 | 641 | 166 |
| ensemble-only | C000004 | 178 | 37 | 135 | 6 | 358 | 65 |

C000003 has no mixed candidates. Every context-only observation carried a Stage 1 hold. 99 of
the 267 context-only candidates (37%) were included, versus 150 of 552 (27%) ensemble-only and
39 of 191 (20%) mixed candidates; these are outcome counts for comparison, not a quality claim
about either route.

## Validation

- `node scripts/factory/validate.mjs` equivalent against the synthetic base
  (`FACTORY_BASE_REF` = `7c059d64`): **0 errors** (candidate `created → complete` and review
  `ready` transitions, per-observation group accounting, canonical proofs, source-bound semantic
  decisions with boundary pairs, hand-off verification, review/candidate digest bindings).
  The scratch run enlarged the git buffer; see the finding below.
- Shared validators exercised through that run: `validateLemmaDecision` (canonical sense and
  search-form-support proofs), `validateReviewArtifacts` (hand-off, decision-source row binding,
  distinct sense rationales, boundary pairs), `validateDecisionHandoff`.
- `node --test` of the factory suites (contracts, Stage 1, lemma, analyzer providers, ensemble,
  Stage 2 worker, Stage 3 worker): 128 tests, 128 pass.
- Expected, by design: `npm run ci:fast`'s *factory batch contracts* step run against the default
  base `origin/master` fails for this tree (`C000003/C000004: new candidate manifest must start as
  created`, because the synthetic base already contains the Stage 1 batches). Against the
  synthetic base the same validator passes (above). This is the reason the PR must not be merged
  into `master`.
- Canonical JSONL unchanged (`git diff` shows no `data/canonical` change); non-mutating preflight
  against the exact canonical snapshot `43269c02940ba52619da19cadbcee63268ada4217a5320213fc4c915f047dd73`.

## Findings

1. **Systemic defect (shared tooling).** `scripts/factory/validate.mjs`' `git()` helper uses
   `execFileSync` without `maxBuffer`. Loading the base manifest of a v2 batch (C000003 = 1.0 MB,
   C000004 = 1.7 MB) throws `ENOBUFS`, so `runCli()` reports
   "cannot resolve factory base … refusing to skip transition checks". The CI step
   *Validate factory candidate/review batch contracts* will fail for every PR once these batches
   are on `master`. Not fixed here (experiment scope); a follow-up fix with a regression is
   recommended (`stage2-worker.mjs` / `stage3-worker.mjs` already pass a 64 MiB buffer).
2. Single-agent self-check at this scale (1,010 lemmas, 1,747 observations) is feasible in one
   context. 313 candidates carry more than one entry for a usage group: mostly the mandatory
   `covered` / `search_coverage` separation by search-form support, plus sense-level splits where
   one default group held different evidence-backed meanings.
3. Several hard-hold and POS-mismatch outcomes are deferrals, not rejections, so a later Stage 1
   run with a verb/adverb POS hypothesis can pick them up without losing the evidence.

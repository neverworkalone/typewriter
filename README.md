# Typewriter
[![CI](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml)

> **작가를 위한, 말의 결을 찾는 사전.**

Typewriter is a writer-focused Korean lexical and imagery dictionary.

It is designed for moments when a writer wants to:

- replace a repeated word without flattening the sentence;
- find another word with a similar tone, texture, or emotional color;
- move from a word to a related image, scene, sensation, action, or association;
- explore nearby expressions without asking an AI to rewrite the sentence.

Typewriter is not a general Korean dictionary, a generic thesaurus, or an AI writing assistant.

The writer writes the sentence. Typewriter helps the writer find words.

## Product direction

A conventional dictionary asks:

> What does this word mean?

A thesaurus asks:

> What words have a similar meaning?

Typewriter asks:

> What might a writer who reached for this word want to find next?

That can include strict alternatives as well as wider writer-useful relationships.

Current working relation categories include:

- `direct` — directly substitutable alternatives in a relevant sense
- `near` — close in meaning, but not fully interchangeable
- `mood` — similar emotional or tonal color
- `scene` — related scene or situation
- `sensory` — related sensory image
- `action` — action associated with the source mood or situation
- `association` — broader writer-useful association

These categories are intentionally provisional. They will be refined through real pilot data and actual writing use.

## Architecture

Typewriter separates canonical dictionary data from application-specific database output.

```text
reference material / LLM draft
        ↓
normalization · validation · curation
        ↓
canonical JSONL
        ↓
deterministic build
        ↓
dictionary.sqlite
        ↓
Chrome Extension
```

Principles:

- canonical JSONL is the source of truth;
- SQLite is a generated artifact;
- the Chrome extension uses the packaged dictionary database read-only;
- recent searches, favorites, settings, and other user data stay separate from the dictionary database;
- runtime lookup should not depend on external dictionary or AI services.

The UI-independent search state and Editorial Model v1 projection are documented in
[`docs/domain-model.md`](docs/domain-model.md).

The M4 input support boundary and shared search regression corpus are documented in
[`docs/search-regressions.md`](docs/search-regressions.md).

The deterministic candidate tiers and tie rules are documented in
[`docs/search-candidates.md`](docs/search-candidates.md).

The M4 failure-state contract and M5 handoff are documented in
[`docs/m4-handoff.md`](docs/m4-handoff.md).

The M5 target inventory, start-count contract, selection axes, and calibration
quality gate are documented in [`docs/m5-target-inventory.md`](docs/m5-target-inventory.md).

The M5 reviewed batch workflow, external staging boundary, manifest contract, and
canonical import gate are documented in
[`docs/m5-batch-workflow.md`](docs/m5-batch-workflow.md).

All current and future word admissions use the same dictionary-wide lexical
quality and prospective-canonical audit described in
[`docs/lexical-quality-pipeline.md`](docs/lexical-quality-pipeline.md). Run
`npm run validate:lexical` for the standalone complete-canonical report; the
regular `npm run validate` invokes the same audit through dataset integrity.

The first M5-3 calibration batch measurements and expansion gate are recorded in
[`docs/m5-3-calibration-report.md`](docs/m5-3-calibration-report.md).

The M5-5 recalibration batch and fixed-gate decision are recorded in
[`docs/m5-5-recalibration-report.md`](docs/m5-5-recalibration-report.md).

The M5-4 relation-review, event-level measurement, and fixed bounded-expansion
criteria are documented in [`docs/m5-expansion-gate.md`](docs/m5-expansion-gate.md).

The M5-6 relation-admission regressions and review-cost process correction are
documented in [`docs/m5-6-relation-process.md`](docs/m5-6-relation-process.md).

The M5-7 new 40-start recalibration and fixed expansion-gate result are recorded
in [`docs/m5-7-expansion-report.md`](docs/m5-7-expansion-report.md).

The M5-8 staged editorial workflow, candidate-buffer contract, fixed expansion
ladder, and process regressions are documented in
[`docs/m5-8-editorial-workflow.md`](docs/m5-8-editorial-workflow.md).

The M5-9A repair contract preserves the failed M5-9 gate, separates relation
pre-screen from human admission, and limits resume authorization to #96's first
50-start validation wave. Run npm run batch:repair:check to verify its
digest-bound artifacts.

The #96 Wave A result is recorded in
[`docs/m5-10-wave-a-report.md`](docs/m5-10-wave-a-report.md); it reaches 578
starts but remains `HOLD PROCESS` because relation noise is 3/8 and the measured
editor-time gate is above the fixed limit, so Wave B is not authorized.

The #107 process correction and digest-bound repair authorization are documented in
[`docs/m5-10a-process-correction.md`](docs/m5-10a-process-correction.md). They add
record-level sense evidence, a source-bound noncanonical 20-case candidate-generation
calibration, and independent relation/timing checkpoints while preserving the
578-start pre-A2 base snapshot. The #96 Wave A2 result is recorded in
[`docs/m5-10a-wave-a2-report.md`](docs/m5-10a-wave-a2-report.md); its reviewed
50-row result is imported and the canonical snapshot is 628 starts. The complete
chronological timing chain measures the five editorial passes plus the distinct
post-freeze audit pass: 649.344 seconds across 56 processed starts (11.595429
seconds per processed start), passing the fixed gate. The editorial session
begins before the first timing pass; the audit timing pass begins after editorial
completion and stops before audit decision finalization. Editorial and audit
decision artifacts record `finalized_at` and are bound to the completion inputs
by digest. The stage only sets
`ready_to_create`; it keeps next-stage creation and authorization false until a
real task is separately authorized. Editorial and audit decisions are supplied
through separate tracked artifacts, not generated by the completion recorders.

The #96 Wave B result is recorded in
[`docs/m5-10-wave-b-report.md`](docs/m5-10-wave-b-report.md). It starts from the
A2 snapshot at 628 starts, processes 170 selected starts, imports 150 reviewed
starts (144 included and 6 sense-corrected), and reaches the exact 778-start
target with 157 imported senses. The producer-throughput operational check is
complete and passes its separate 1-second limit (10.150 producer-bound seconds
across 160 processed starts, or 0.0634375 producer seconds per processed start),
and the independent audit produces zero findings and zero open blockers.
However, the source-derived expansion gate is `HOLD PROCESS`: editorial
judgment time is explicitly unmeasured, so the fixed editor-time criterion
cannot pass and producer time is not allowed to replace it. Canonical/SQLite/search
regressions pass. The semantic regression
corpus is a declaration-driven 12-case set covering the six corrected proposal
records, one canonical regression, and four synthetic homonym/POS/polysemy/
space-phrase cases. The result is
Codex-authored (`human_editorial_review_complete: false`); the stage still keeps
`next_stage_created: false` and `next_stage_authorized: false`. Run
`npm run batch:m5-10:wave-b:check -- --staged=/path/to/reviewed.jsonl --proposal=/path/to/proposal.jsonl`
to verify the digest-bound Wave B artifacts. The timing recorder invokes the
proposal-only producer for each unit inside the pass interval and binds its
input, execution timestamps, source digest, and output in recorder-owned work
logs. Editorial and audit rows are authored one at a time after their judgment
timers start, then assembled and finalized only after the corresponding timing
passes stop; no production verdict plan is available to the recorder.

Issue #115's M5-10D workload correction is documented in
[`docs/m5-10d-editor-workload-recovery.md`](docs/m5-10d-editor-workload-recovery.md).
The committed calibration-only proposal is
[`data/batches/m5-10d-calibration-proposal-20260912.json`](data/batches/m5-10d-calibration-proposal-20260912.json),
and its source, follow-up source, timing logs, decisions, recovery, and
authorization are all revalidatable from a clean checkout. The workflow freezes
the target and initial workload before timing, derives follow-up
queues from recorder-owned initial-review judgment findings before those passes
start, measures editor time only from per-unit judgment intervals, records empty
passes as zero-work, and keeps the independent post-freeze audit over all 20
calibration cases. Its source-derived recovery can create the separate #97 +500
authorization only when the existing fixed gates pass; the contract and recovery
checks are
`npm run batch:m5-10d:contract:check` and
`npm run batch:m5-10d:recovery:contract:check`, followed by the committed
artifact checks `npm run batch:m5-10d:recovery:check` and
`npm run batch:m5-10d:authorization:check`.

Issue #97's M5-11A work is promoted through the owner-authorized automated
editorial path. The digest-bound #115 authorization and 550-row candidate pool
produce exactly 488 included + 12 corrected imported starts. The reserve contains
8 held, 7 rejected, and 35 deferred candidates. Canonical
advances from 778 to 1,278 starts (820 to 1,320 records); imported IDs are
deterministically rebased to `w779`~`w1278` in catalog order. The semantic
verification contract splits 140 multi-sense records, admits 14 relation tuples,
emits 550 source-bound per-candidate findings, and checks all candidate rows for sense/POS/expression/relation decisions and
verification-based selection ranks. The compact review summary and
admission/promotion evidence record the source digests, automated verification
pass separation, and the explicit fact that no human editorial review, human
timing, or external human audit is claimed. Run `npm run batch:m5-11:check` to
revalidate the promoted outputs from durable evidence.
The post-merge semantic correction pass separately reviewed nine affected
records, reduced the canonical sense count to 1,579, and refreshed the complete
canonical audit plus M5-11 derived evidence through
`npm run batch:m5-11:evidence:refresh`. The shared lexical-quality gate now
rejects the same malformed gloss and high-confidence duplicate/usage/paraphrase
patterns for future admissions.
The proposal, editorial decision, verification, relation diff, and reviewed
import bodies remain outside the repository; only the explicit promotion step
mutates canonical, seed, and inventory. See
[`docs/m5-11-expansion-report.md`](docs/m5-11-expansion-report.md) for the
count arithmetic and source/output digests.

The M3 product UI reuses that projection in the popup and the Settings preview.
Display choices are user data stored under the extension's local `storage` area;
they never enter the read-only dictionary database.

## Data policy

External APIs, dictionaries, corpora, and LLMs may be used as reference, verification, or draft-generation tools when their terms permit the intended use.

The repository should contain Typewriter's curated canonical data, not raw third-party dumps.

Do not commit:

- raw API responses;
- scraped dictionary pages;
- copied restricted dictionary entries;
- bulk third-party datasets without an explicit compatible license.

Reformatting, combining, paraphrasing, or translating third-party material does not automatically remove its original license or terms.

For the detailed storage boundaries and external-material review record, see [`docs/repository-structure.md`](docs/repository-structure.md) and [`docs/data-policy.md`](docs/data-policy.md).

## Development strategy

Typewriter is intentionally developed in stages.

1. **Project Foundation**  
   Establish repository, policy, validation, and development rules.

2. **Lexical Model Pilot**  
   Use a small set of representative writer-facing vocabulary to validate the editorial model.

3. **Dictionary Toolchain**  
   Build and validate the canonical JSONL → SQLite pipeline.

4. **Vertical Slice**  
   Build a usable Chrome extension with the small pilot dictionary.

5. **Writer Search UX**  
   Refine search, ranking, keyboard-first interaction, and exploration flow through real use.

6. **Core Dictionary Scale-up**  
   Expand only after the model and product behavior have been validated.

7. **Quality, hardening, and release**  
   Improve data quality, database performance, packaging, and Chrome Web Store readiness.

Do not scale an unvalidated lexical model.

## Repository policy

This repository is private and proprietary.

The source code, canonical dictionary data, lexical relations, classifications, rankings, tags, curated associations, and generated database are not open source unless a specific file or subdirectory explicitly states otherwise.

See [`LICENSE.md`](LICENSE.md).

## Development and review

Implementation work must follow [`AGENTS.md`](AGENTS.md).

Pull-request reviews must follow [`REVIEW.md`](REVIEW.md).

Local validation commands and the CI workflow are documented in [`docs/development.md`](docs/development.md).

## Status

Typewriter is in early development.

The product direction, data architecture, and repository policy are established. The lexical model and implementation are still being validated.

---

Copyright © 2026 Never Work Alone. All rights reserved.

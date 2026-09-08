# M5-8 staged editorial workflow

Issue: #93<br>
Parent execution plan: #7<br>
Scope: process contract and regression controls only; no canonical import

M5-7 showed that a small batch can pass structural validation while still
leaking mixed senses, incorrect POS, broad relations, and unmeasured work into
the reported gate. M5-8 fixes that boundary before another data batch is
selected. The process keeps human editorial review as the authority and makes
the repeated work measurable without creating future data issues in advance.

The M5-7 re-audit gives the fixed starting point for the redesign:

| Measure | M5-7 result | Gate |
| --- | ---: | --- |
| Selected-start correction | `15/40 = 37.5%` | pass (`≤ 50%`) |
| Relation noise | `3/10 = 30%` | fail (`≤ 25%`) |
| Editor time | `782/40 = 19.55 sec/start` | fail (`≤ 12 sec/start`) |

The result is therefore `HOLD PROCESS`; the new workflow addresses the failure
locations before another data batch is selected.

The machine-readable contract is
[`data/batches/m5-8-expansion-plan.json`](../data/batches/m5-8-expansion-plan.json).
It records the fixed phase order, admission rules, timing requirements, gate
thresholds, and the allowed `+N` ladder. It is a plan, not a batch manifest,
candidate list, or promise that all future stages will be opened.
Each executed stage must additionally produce the source-bound shape defined by
[`schema/m5-8-stage-report.schema.json`](../schema/m5-8-stage-report.schema.json):
input revision/snapshot, target and buffer, included/corrected/held/rejected/
deferred decisions, actual canonical count, source-derived metrics, and gate
decision. The report must point to the manifest, derived metrics artifact,
relation diff, canonical directory, and verification artifact, with a SHA-256
digest for each. The verification artifact uses
[`schema/m5-8-stage-verification.schema.json`](../schema/m5-8-stage-verification.schema.json).
The validator loads those artifacts and rejects a report whose
paths, digests, decisions, metrics, or canonical snapshot drift from them. A
stage after the first also names and digests the previous stage's passed report;
its input snapshot must equal that report's actual output snapshot.

## Invariant and counting unit

This issue changes no canonical JSONL. The M5-8 preflight baseline is:

| Count | Value |
| --- | ---: |
| Canonical records | 470 |
| Canonical starts | 428 |
| `reference-only` records | 42 |
| Senses | 557 |
| Relations | 449 |
| Expression records | 23 |

The unit for every expansion stage is `canonical-start-net-increase`. A sense,
relation, expression, `reference-only` closure, held row, rejected row,
duplicate, or inflected form is not a start increase.

## Phase order and checkpoints

Every stage follows this order. A later phase cannot silently repair an
unfinished earlier phase.

| Phase | Required output | Boundary |
| --- | --- | --- |
| `target-preparation` | Inventory revision, selected starts, and declared candidate buffer | Raw drafts and external material stay outside the repository. |
| `sense-review` | Human-confirmed lemma/POS and sense decisions | Check lemma/POS, sense boundaries, literal/figurative use, sensory/state/action distinctions, and expression boundaries. |
| `relation-review` | Optional admitted relation candidates per confirmed sense | Starts from an empty relation list; a relation is emitted only after sense review is complete. |
| `independent-audit` | Independent findings and open-blocker status | Recheck the reviewed result, source bindings, exact counts, timing, and regressions. |
| `gate-and-promotion` | Source-derived metrics and a stage decision | Promote only the exact net start target after every gate criterion passes. |

The sense checkpoint has three possible outcomes: `complete`, `held`, or
`rejected`. For `held` or `rejected`, relation review remains `not-started` and
its output count is zero. The executable checkpoint helper rejects relation
output before a complete sense/POS decision, while still allowing a completed
sense with zero relations.

### Batch partition and rework boundaries

The partition unit is a selected start. The reviewer closes the sense/POS
checkpoint for that partition before relation review begins. Sense corrections,
relation corrections, independent-audit findings, and any post-review fixes are
separate rework boundaries; a later boundary cannot silently absorb time or
decisions from an earlier one.

### Sense/POS review

Sense review is a separate first pass, not a field edited opportunistically while
relations are being chosen. For each selected lemma the editor explicitly checks:

- lemma and part of speech;
- literal versus figurative use;
- physical, sensory, state, and action distinctions;
- same-surface-form sense boundaries; and
- expression-unit boundaries.

The reviewer records unresolved cases as held or rejected. A provisional
`single`/`polysemy` label or an author suggestion never substitutes for this
checkpoint.

### Relation review and admission

After the sense checkpoint, relation review still starts with
`relations: []`. Zero relations is a valid result. There is no per-record or
per-type quota. A candidate relation must identify:

1. the exact `source_sense`;
2. the exact `target_sense`;
3. the direction `source sense → target sense`;
4. an honest relation `type`; and
5. a short writer-facing reason tied to that source sense.

The human editor admits a candidate only when the source/target/type are correct,
the direction is clear, and the reason demonstrates a stable writer-facing use.
Generic co-occurrence, broad category membership, arbitrary place or modifier,
generic result or reaction, unsupported cross-sensory movement, and
source/target/type errors remain rejection categories from the v2 relation
contract. Automated checks may validate those fields and their source bindings;
they do not decide semantic quality, generate a relation, or turn confidence into
approval.

## Timing and source binding

Each batch manifest must measure these required passes:

1. `target-preparation`
2. `initial-review`
3. `feedback-fixes`
4. `final-audit`
5. `held-rejected`

If review feedback arrives after the initial review, add a paired
`post-review-audit` and `post-review-fixes` entry for every feedback cycle. The
optional entries use a one-based `cycle` when more than one cycle is present and
bind both entries to the recorded `feedback_received_at`. The metrics artifact
uses keys such as `post-review-fixes#2` so repeated work cannot overwrite an
earlier cycle. Every measured pass records `started_at`, `completed_at`,
`wall_clock_seconds`, and `editor_seconds`; a measured follow-up cannot start
before its feedback was received. The timestamps and durations cover the actual
work event; they are not estimates or backfilled values. If a follow-up was not
instrumented, both entries for that cycle remain `unmeasured`, the timing status
is `incomplete`, and only the measured lower bound is exposed. Missing cycles,
unpaired follow-up entries, and stale pre-feedback timestamps are invalid.

`npm run batch:metrics` remains the source-derived calculation for decision
counts, correction rates, relation noise, canonical import counts, audit status,
and timing totals. The manifest's relation-diff path and digest continue to bind
the event ledger to that calculation.

## M5-9A repair authorization

M5-9 ended at HOLD PROCESS; its stage report and canonical result remain
historical records. The repair contract in issue #104 does not rewrite that
failure or add canonical data. It binds the failed stage report by SHA-256 to
data/batches/m5-9a-repair-authorization.json and binds the 25 source candidates
to the separate data/batches/m5-9a-relation-screen.json artifact.

The relation screen retains all 25 proposals in its pre-screen denominator. It
records 12 tuple/semantic pre-screen rejections and passes 13 candidates to a
separate human-admission record; only those 13 admitted tuples remain final
relations. The source-bound regression is checked against M5-9's 12 rejected
candidate reviews and 13 add events. The policy keeps relation output empty by
default and uses no quota. A candidate is not rejected by a keyword list:
source/target senses, direction, type, and a concrete writer-facing use are
recorded and checked as one tuple.

Manifests that use the repaired timing contract set
measurement.timing.contract_version to m5-9a-v1. The timing recorder's
`batch:timing:feedback` command records the current UTC feedback event and
appends the next one-based paired follow-up cycle. `batch:timing:start` records
the current start timestamp for a pass, and `batch:timing:stop` records the
current stop timestamp and derives wall-clock/editor seconds; neither command
accepts user-supplied timestamps or durations. An unmeasured pass cannot carry
an estimated duration. The recorder marks an unfinished session as
`in-progress`, and the validator marks the timing incomplete until both
follow-up passes are measured. Missing, duplicated, or out-of-order cycles are
rejected.

The repair authorization permits only #96's first 50-start validation wave
(528 → 578). It does not authorize the remaining 200 starts or Wave B. A later
stage that follows a failed report must reference both that report and a valid
digest-bound repair authorization; a passed stage still requires the ordinary
passed-report chain.

Run the repair check with:

    npm run batch:repair:check

## Candidate buffer and exact net increase

The candidate buffer is a maximum reserve pool, not a required number of failed
decisions. It absorbs held or rejected selections without pretending that they
became canonical starts. For a stage with target `N` and buffer `B`, where `D`
is the actual held-plus-rejected count:

```text
selected starts       = N + B
imported starts        = N
held/rejected starts   = D, where D <= B
unused buffer          = B - D (recorded as deferred)
new cumulative starts  = base starts + N
```

Selection and processing are separate denominators. Let `P` be the number of
processed starts:

```text
processed starts       = included + corrected + held + rejected
deferred starts        = selected starts - processed starts
```

The metrics artifact keeps `selected_start_count` for the full selection scope
and records `processed_start_count` when deferred candidates exist. The
correction-rate and editor-time gate fields retain their historical
`*_selected_start` names, but their denominators are `P`; deferred reserve
capacity cannot dilute either gate.

The buffer is declared before selection and is not part of the cumulative target.
The stage validator rejects a count where the buffer is imported, where the
selected count does not include it, or where actual held/rejected decisions
exceed it. Unused capacity is not falsely converted into a rejection and is not
imported. For example, from the current 428 starts, a `+100` stage with a
12-start buffer selects 112; if seven candidates are held/rejected, five are
recorded as deferred and exactly 100 starts are imported, ending at 528.

## Fixed promotion ladder

The ladder is a permitted sequence, not a set of pre-created issues. Stage `n+1`
may be opened only after stage `n` has passed the fixed gate and its result has
been recorded. No later-stage issue is created in M5-8.

| Sequence | Net start increase | Cumulative start target |
| ---: | ---: | ---: |
| 1 | `+100` | 528 |
| 2 | `+250` | 778 |
| 3 | `+500` | 1,278 |
| 4 | `+722` | 2,000 |
| 5 | `+1,000` | 3,000 |
| 6 | `+1,000` | 4,000 |
| 7 | `+1,000` | 5,000 |

The numeric gate is not relaxed as the batch grows. The `+N` value is verified
against the actual canonical start delta after promotion, not against the number
of candidates selected or the number of rows drafted.

## Fixed gate and stop rule

Every stage must pass all of the following:

- every new sense and relation received human editorial review;
- processed-start correction rate `≤ 50%` (the report field is
  `correction_rate_of_selected`);
- relation noise `≤ 25%` and below the reconstructed M5-3 baseline;
- complete measured editor time `≤ 12 seconds/processed start`;
- zero unmeasured timing passes;
- independent audit complete with zero open blockers;
- canonical integrity, deterministic SQLite, and M4 search/product regression;
- exact `+N` canonical start increase and cumulative target.

The stage report's `included + corrected` count must equal the target net
increase, `held + rejected` must not exceed the candidate buffer, and
`deferred` must be the unused buffer. Its actual canonical snapshot must report
the planned cumulative start count. Its gate decision is derived from the
source-loaded correction, noise, timing, audit, and regression fields; a
manually declared pass that disagrees with those values is invalid.

If one criterion fails, the result is `HOLD PROCESS`. Record the failed cause as
process backlog, repair the process, and stop. Do not change the threshold,
count the buffer as imported, authorize or start the next stage, or batch-generate
5,000 records to bypass the failure. A roadmap issue may already exist for
visibility; the stage report separates that creation state from authorization.

## Regression controls

The self-authored fixture
[`tests/fixtures/m5-8-process-regressions.json`](../tests/fixtures/m5-8-process-regressions.json)
binds the workflow to M5-7's known failures without copying a raw draft. It
checks that:

- `섬세하다`, `은은하다`, `내려앉다`, and `되돌아가다` retain separate senses;
- `서걱하다` retains `verb` POS;
- `단추 → 손끝`, `고마움 → 다정하다`, and `불쾌감 → 분노` remain omitted from
  canonical relation output; and
- the fixture covers the relation-diff removal events and their failure
  categories.

The executable checks are:

```sh
npm run batch:process:check
npm run batch:admission:check
npm test
npm run test:unit
```

`batch:process:check` also verifies the exact 470/428/42/557/449/23 baseline,
the phase contract, the seven-stage ladder, candidate-buffer arithmetic, and
the no-next-stage-after-failure rule. It adds no canonical record or generated
SQLite content.

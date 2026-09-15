# M5 reviewed batch workflow

## Purpose and boundary

M5-2 defines the repeatable boundary between target selection, temporary draft
work, editorial review, and canonical import. It does not generate a production
batch and it does not make an LLM response editorial truth.

The workflow is:

```text
target inventory revision
        ↓
external temporary draft workspace
        ↓  (raw response stays outside the repository)
record-level editorial review
        ↓
reviewed canonical JSONL in external staging
        ↓  batch manifest + import gate
data/canonical/*.jsonl
        ↓
normalize · validate · deterministic SQLite build
```

The temporary workspace is outside the repository. The tracked manifest, when a
real batch is ready to be recorded, contains review metadata only. The raw model
response, scraped material, unreviewed draft, secret, and local path never enter
Git or the product package.

## Manifest contract

The contract is [`schema/batch-manifest.schema.json`](../schema/batch-manifest.schema.json).
The batch validator executes that schema for structural checks and keeps only
cross-file checks (inventory membership, staged mapping, lexical collisions, and
reference closure) in [`scripts/batch/validate-batch.mjs`](../scripts/batch/validate-batch.mjs).

A manifest records:

- `batch_id`, target `inventory_id`, and the exact `inventory_revision`;
- generator `model_id`, `tool_version`, `prompt_version`, and an optional SHA-256
  digest of an external draft artifact;
- `generated_at`, review status, reviewer, and completion time;
- the SHA-256 digest of the separately authored complete semantic-audit
  envelope;
- one decision per reviewed inventory target or reference-closure record; and
- the final `canonical_id` for every `included` or `corrected` record.

Record decisions are deliberately explicit:

| Decision | Canonical staging | Meaning |
| --- | --- | --- |
| `included` | required | Reviewed record enters the batch unchanged from the reviewed decision. |
| `corrected` | required | Reviewed record enters after named fields were corrected. |
| `held` | forbidden | Review is recorded, but the record is not importable. |
| `rejected` | forbidden | Review decision excludes the record from this batch. |
| `deferred` | forbidden | The candidate remains in an unused reserve pool for a later selection. |

`confidence` is not a manifest field. An unknown field such as `confidence` or
`raw_response` is rejected, because editorial decisions must be represented by a
human review status, decision, correction fields, and note.

Reference-only records created to close a relation graph use
`source: "reference-closure"`, `role: "reference-only"`, and `related_to`. They
do not pretend to be search-start inventory targets. The validator requires the
new reference record to be referenced by a staged record and checks its target
record and target sense through the normal dataset-integrity validator.

## Staging and import gate

The reviewed canonical JSONL is supplied separately from the manifest and must be
outside the repository:

```sh
npm run batch:validate -- \
  --manifest=/tmp/typewriter-m5-2/batch.json \
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl \
  --semantic-audit=/tmp/typewriter-m5-2/semantic-audit.json
```

The gate checks, before any canonical import:

1. manifest shape, timestamps, review completion, decision fields, and forbidden
   unknown fields;
2. target inventory ID/revision and editorial target status;
3. staged records are approved exactly once by the manifest;
4. deterministic IDs: new `start` rows continue the next `wNNN+` IDs and
   `reference-only` rows continue the next `rNNN+` IDs in manifest order;
5. deterministic sense IDs (`<record-id>-s1`, `<record-id>-s2`, …);
6. duplicate record IDs, lemmas, search forms, and canonical collisions;
7. record roles, relation targets, target senses, action target parts of speech,
   and reference closure; and
8. the separately authored semantic-audit envelope is present, digest-bound to
   the manifest, and covers the existing canonical dataset plus staged rows;
9. the existing canonical dataset plus staged rows as one dataset, without
   modifying the existing canonical directory.

After the gate passes, an editor may create an external import artifact:

```sh
npm run batch:import -- \
  --manifest=/tmp/typewriter-m5-2/batch.json \
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl \
  --semantic-audit=/tmp/typewriter-m5-2/semantic-audit.json \
  --output=/tmp/typewriter-m5-2/canonical-import.jsonl
```

`batch:import` writes only the validated reviewed rows, sorted by canonical ID. It
does not modify `data/canonical/`, does not build SQLite, and refuses output paths
inside the repository or canonical input. The editor performs the final deliberate
canonical-file change together with the corresponding M5 seed transition
(`status: "promoted"` plus `canonical_id`), rebuilds the target inventory
projection in memory, and then runs the ordinary canonical validator, normalizer,
and build checks. A held or
rejected row can never be emitted by this command.

## ID and reproducibility rules

The manifest's record order is the deterministic allocation order. Within each
role, the first approved new record receives the next available ID for that role:
`wNNN+` for `start` and `rNNN+` for `reference-only` (`NNN+` means at least three
digits). Sense IDs are assigned from
the record ID in sense order. The gate rejects an explicit ID that does not match
this allocation, so a second run with the same reviewed input has the same logical
IDs.

This does not claim that an LLM draft is bit-for-bit reproducible. The manifest
captures the model/tool/prompt identity and optional external draft digest for
audit. The reviewed canonical rows are a separate editorial artifact. Their
normalization and SQLite build are deterministic and are validated independently
by the existing M2 pipeline and reproducibility tests.

## Failure behavior and fixtures

The M5-2 fixture tests use self-authored reviewed rows in a temporary directory;
they do not add those rows to `data/canonical/` or the product package. The tests
cover a valid start plus reference closure, incomplete review, unapproved staged
rows, non-deterministic IDs, lexical collisions, invalid confidence metadata,
orphaned reference closure, and repository-local staging rejection.

No raw external response is needed to reproduce a validator failure. Keep any such
material outside the repository and reduce the failure to a small self-authored
canonical fixture.

## Commands

```sh
node --test tests/batch-workflow.test.mjs
npm run batch:validate -- --manifest=/path/to/batch.json --staged-records=/tmp/reviewed.jsonl
npm run batch:import -- --manifest=/path/to/batch.json --staged-records=/tmp/reviewed.jsonl --output=/tmp/import.jsonl
```

The batch commands are workflow gates, not runtime services. They add no external
dictionary, LLM, cloud, or network dependency to the Chrome extension.

## M5-9 staged expansion application

M5-9 applies the M5-8 staged workflow to a real +100 canonical-start batch. The
pre-import inventory is preserved at
data/batches/m5-9-preimport-inventory.json with revision m5-5; it contains the
112 selected candidates before promotion. The final seed advances to m5-6,
promotes only the 100 included/corrected rows, retains seven held/rejected
decisions outside canonical, and leaves five unused reserve rows as candidates.

The checked-in artifacts are:

- data/batches/m5-9-expansion.json: 112 explicit decisions and seven complete
  timing passes, including the measured post-review audit and fixes;
- data/batches/m5-9-expansion-relation-diff.json: 25 source-bound relation
  candidates, with 13 admitted and 12 rejected;
- data/batches/m5-9-expansion-metrics.json: source-derived counts, rates, timing,
  and audit summary;
- data/batches/m5-8-stage-01-plus-100.json: path- and SHA-256-bound stage result;
  and
- docs/m5-9-expansion-report.md: the gate decision and validation record.

The stage reports the exact 428 → 528 canonical-start transition. Issue #96 may
already exist for roadmap visibility, but the stage's authorization flag remains
false while this gate is failed. Its relation
candidate noise rate is 12/25 = 48%, so the fixed gate records `HOLD PROCESS` and
does not authorize the next bounded ladder stage. Deferred reserve rows are visible
in the manifest and metrics, but never inflate the import count or make editor cost
appear lower.

## M5-9A repair and resume boundary

Issue #104 records the repair boundary after the failed M5-9 stage. The tracked
data/batches/m5-9a-relation-screen.json artifact keeps all 25 M5-9 relation
proposals in a pre-screen denominator, rejects the known 12 failure cases before
human admission, and records the remaining 13 human-admitted tuples separately.
It is source-bound to the historical relation diff; it contains no raw draft or
external response.

data/batches/m5-9a-repair-authorization.json binds that screen and the unchanged
failed stage report by SHA-256. Its scope is deliberately limited to #96 Wave A:
the first 50-start validation wave, 528 → 578. It does not authorize the remaining
200 starts or Wave B. The expansion plan nevertheless records Wave B as the
unambiguous +200 continuation needed to complete the composite 778 target; the
+500 ladder stage may rejoin through Wave B only after that wave passes and
proves the 778 output. The executable check is npm run batch:repair:check.

## M5-10 Wave A validation result

The first #96 wave is recorded independently in
[`data/batches/m5-10-wave-a.json`](../data/batches/m5-10-wave-a.json), with its
reviewed relation diff, separate relation screen, derived metrics, canonical
import, verification result, and source-bound stage report. It starts from the historical M5-9 output of 528
starts and imports exactly 50 reviewed starts, reaching 620 records / 578 starts
/ 42 reference-only records / 743 senses / 467 relations / 39 expressions.

The wave selected 58 starts: 28 included, 22 corrected, 3 held, 3 rejected, and
2 deferred. All 50 importable starts were re-audited for physical/figurative,
homonymous-POS, and sensory/emotional boundaries; 21 records were split. The 8
relation candidates were screened separately from human admission; 5 passed and
were admitted while 3 were rejected, for a candidate noise rate of 3/8 = 37.5%.
All five timing passes and both cycle-1 and cycle-2 post-review pass pairs are
recorder-measured and the independent audit has no open blockers. The exact source-derived report
nevertheless records `HOLD PROCESS`: total editor time was 2,251.026 seconds,
or 40.1969 seconds per processed start, above the fixed 12-second limit; the
relation noise gate also fails.

Wave B was not started and the Wave A stage report keeps
`next_stage_authorized: false`. The historical M5-9 canonical source is retained
under `data/batches/m5-9-postimport-canonical/` so its failed report remains
reproducible after the current canonical directory advances.

## M5-10A Wave A2 result

The A2 result is recorded in
[`docs/m5-10a-wave-a2-report.md`](m5-10a-wave-a2-report.md). It selects 58
starts, reviews all 50 importable rows in external staging, and imports the
zero-blocker reviewed result, taking the product snapshot from 578 to 628
starts. The completed editorial and audit inputs are `codex-authored`; the
audit is independent through distinct sessions and artifacts, not through a
human-identity requirement. The recorders consume separately supplied editorial
and audit decision artifacts and never manufacture semantic decisions or clean
findings. All five editorial timing passes and the distinct post-freeze audit
timing pass are measured in chronological order, and the complete
11.595429-second processed-start rate is within the fixed 12-second gate. The
stage is
`APPROVE BOUNDED` and `ready_to_create: true`, but `next_stage_created: false`
and `next_stage_authorized: false`; a passing metric does not create or
authorize a GitHub task implicitly. The second corrected chronological timing
run measures 649.344 seconds across 56 processed starts, with the editorial
session starting before the first timing pass. Editorial finalization is
recorded after the last editorial timing stop; the post-freeze audit timing
starts after editorial completion and stops before audit decision finalization
in the distinct audit session.

## M5-10 Wave B result

Issue #96's Wave B is recorded in
[`m5-10-wave-b-report.md`](m5-10-wave-b-report.md). It consumes the passing A2
report and a separate digest-bound Wave B authorization, then processes 170
selected starts: 144 are included, 6 are sense-corrected and imported, 10 are
held, and 10 are deferred. The 20-row buffer is therefore not counted as
completed sense review; the canonical snapshot advances exactly from 628 to
778 starts and contains 157 imported senses.

The Wave B editorial and audit completion recorders generate their decision
artifacts only after the corresponding timing pass stops. The artifacts are
reconstructed 1:1 from recorder-owned work rows: editorial boundary and record
decisions from the editorial timing log, and relation/audit coverage and
findings from the independent post-freeze timing log. A pre-finalized decision
artifact is rejected. The editorial input records all six sense-boundary checks for
the 150 imported starts; six known homonym/polysemy records are corrected into
explicit sense sets and the 12-case declaration-driven semantic regression
corpus is checked during proposal preflight and canonical validation. The relation diff remains empty
because this wave has no relation quota. A distinct post-freeze audit session
checks the frozen reviewed-staging digest. The tracked verification artifact explicitly distinguishes
`editorial_review_complete: true` from
`human_editorial_review_complete: false`.

The independent audit now derives its result from the record, relation, and
timing comparisons: the current source-bound inputs produce zero findings and
zero open blockers. A producer mismatch becomes an open finding during audit;
it is not silently converted into a resolved finding. The five editorial timing
passes and the distinct post-freeze audit pass are complete and chronological.
Their source-derived producer-throughput total is 10.150 seconds across 1,562
recorder-created work units and 160 processed starts. Each work row binds the
unit input to a producer execution and output that occurred inside its timing
pass; precomputed payload replay is rejected. This producer interval is used by
the separate operational throughput check, not as a claim about human editorial
effort. Editorial judgment time remains explicitly unmeasured and does not get
substituted by producer time. The fixed editor-time expansion criterion therefore
fails and the Wave B stage is `HOLD PROCESS`; `ready_to_create`,
`next_stage_created`, and `next_stage_authorized` remain false. No later stage
artifact or task is created implicitly.

The proposal and reviewed staging JSONL remain outside the repository; tracked
metadata stores their SHA-256 digests and never copies raw proposal bodies.

## M5-11A +500 admission

Issue #97 consumes the digest-bound authorization from #115 and promotes the
owner-authorized automated M5-11A result. The frozen candidate pool contains
550 rows: 500 are imported (`included + corrected`), and 50 are `deferred`.
`processed_start_count` is exactly `included + corrected + held + rejected`, so
deferred rows are not part of either the processed denominator or canonical.
The canonical snapshot advances from 778 to 1,278 starts and from 820 to 1,320
records.

`scripts/batch/build-m5-11-expansion.mjs` still requires a separately supplied
proposal and editorial artifact outside the repository. In the M5-11A mode the
editorial artifact is explicitly `agent-generated`, carries truthful Codex
provenance, and must declare `human_editorial_review_complete: false`. The
validator checks every candidate record/sense, all six boundary keys, source
digests, lexical collisions, placeholder glosses, relation targets, the M4
search regression, and deterministic SQLite evidence. Generation and
verification pass IDs must be distinct. Relation quota is not imposed, so an
empty relation diff is valid.

Human timing and an external human audit are not required by the current #119
owner policy; durable evidence records both as `not-required` and makes no
human-completion claim. Raw proposal/decision/verification/import bodies remain
external. The explicit `scripts/batch/promote-m5-11.mjs` command is the only
step that mutates canonical, seed, and inventory after the passing manifest is
revalidated. `npm run batch:m5-11:check` validates the committed promotion
evidence and outputs without the external inputs.

## M5-10A process correction and A2 authorization

Issue #107 records the process correction after the Wave A failure. It does not
promote the failed Wave A gate, add canonical rows, or authorize Wave B. The
source-bound process artifact is
[`data/batches/m5-10a-process-correction.json`](../data/batches/m5-10a-process-correction.json),
and its executable check is `npm run batch:m5-10a:process:check`.

The next sense review must record one `sense_review.preflight.record_checkpoints`
entry for every selected inventory start. The separate editorial input records
boundary evidence as structured `applicability`, `candidate_sense_ids`, `decision`,
and `contrasts` fields. The six
boundaries are:

1. physical versus figurative usage;
2. homonym and part-of-speech separation;
3. sensory, emotion, state, and action separation;
4. directional symmetry such as upper/lower or inside/outside;
5. compound word versus spaced phrase; and
6. ordinary word versus idiom.

An importable checkpoint is complete only when its canonical ID, observed sense
facts, lemma/POS review, at least one checked (applicable) boundary, and all
boundary evidence are complete. Reviewed evidence must cite the canonical
candidate senses and an actual structured contrast when applicable;
`not-applicable` and `not-reviewed` cite no sense in the generated manifest, and
copied or generic contrast evidence is rejected. A missing boundary is explicitly
listed and blocks relation review for that record. An unverified proposal keeps
every checkpoint `not-reviewed`.
The regression fixture contains 21 known Wave A sense-boundary cases; its exact
case IDs and boundary coverage are digest-bound to the process artifact.

Relation admission keeps the relation list empty until sense preflight is complete.
The historical 25-proposal regression remains 13 pre-screen passes and 12
pre-screen rejections for failure reproducibility only. Upstream correction is
proven separately by the source-bound, noncanonical 20-case calibration dry-run:
its fixed generator emits zero pre-screened noise candidates; a separately
authored audit input supplies per-proposal decisions, and the validator derives
the raw-proposal noise rate from those decisions. That audited rate must stay
below the 25% relation-noise and 12 editor-seconds-per-processed-start gates.
The builder refuses to authorize a run without the audit input. Run
`npm run batch:m5-10a:calibration:check` before the process and repair checks.

The M5-10A timing contract distinguishes editorial passes (human or Codex) from mechanical
count, digest, import, tuple, SQLite, search, and package checks. Mechanical
validation is recorded as verification evidence and never subtracted from editor
seconds. A complete timing result must have measurements for the five required
passes and every recorded follow-up pair; an unmeasured pass keeps the gate
incomplete. Wave A2 additionally requires a separately recorded
`post-freeze-audit` pass over the frozen staging; its editor seconds are included
in the source-derived total and gate.

Wave A2 binds its proposal metadata and gate state to separate editorial, audit,
and timing inputs. Completion also requires separately supplied editorial and
audit decision artifacts; the recorders bind those inputs by digest, session,
and chronology but do not generate semantic decisions or clean findings. The
50 candidate record bodies are supplied through an
external `--staged=/tmp/.../*.jsonl` path and are never committed. The tracked
proposal metadata binds that external JSONL by SHA-256, and the A2 validator
rejects a supplied staging file whose digest differs; the generated manifest
repeats the proposal digest as `generator.draft_sha256`. A completed verified
editorial pass (human-authored or Codex-authored) and independent audit also carry the final `reviewed_staging_sha256`,
which the import validator checks against the bytes passed as `--staged`. An input
without a verified session artifact must remain
`unverified-draft`/`in-review` (or `incomplete`) and cannot claim a verified
editorial review or independent audit. Editorial timing is recorded in
`data/batches/m5-10a-wave-a2-timing-input.json`, while the required A2
post-freeze audit timing is recorded separately in
`data/batches/m5-10a-wave-a2-audit-timing-input.json`. The earlier 27.918-second
command-runtime claim is invalid and is not copied into the new manifest. Use
`npm run batch:m5-10a:wave-a2:timing` to record each pass from current-clock
start/stop events; every completed pass must also cite the exact A2 work-unit
set and before/after artifact digests. Until that recorder output exists, the
builder emits `timing.status: "incomplete"` and the stage remains `HOLD PROCESS`.

The digest-bound authorization is
[`data/batches/m5-10a-repair-authorization.json`](../data/batches/m5-10a-repair-authorization.json),
validated with `npm run batch:m5-10a:repair:check`. It preserves the failed Wave A
metrics (37.5% relation noise and 40.1969 editor seconds per processed start),
keeps the canonical snapshot at 578 starts, and authorizes only #96 Wave A2:
exactly +50 starts, from 578 to 628. It does not authorize the +150 Wave B step;
Wave B still requires a passing A2 result and a later authorization.

Legacy manifests that predate M5-10A continue to use
measurement.timing.contract_version `m5-9a-v1`. Batches using the M5-10A process
correction carry `sense_review.preflight.process_revision` set to
`m5-10a-process-correction-v1`; the timing recorder then records
`measurement.timing.contract_version` as `m5-10a-v1`. The timing recorder records the
current feedback event with `npm run batch:timing:feedback`, then records each
session with `npm run batch:timing:start` and `npm run batch:timing:stop`.
The stop command derives wall-clock/editor seconds from its start/stop pair;
the CLI accepts neither user-supplied timestamps nor durations. The validator
rejects timing values on unmeasured passes and requires paired one-based
follow-up cycles. A session left in progress or a follow-up with missing work
keeps the derived timing incomplete; no time is estimated or backfilled.
`final-audit` and post-review audit time must include the editorial semantic checks
they claim. M5-10A's final-audit timing pass must also carry the complete audited
case-ID set and raw-proposal digest, and the calibration audit session must equal
that timed pass session. CI's mechanical count/digest/import/tuple checks are
validation evidence and must not be used to reduce editor seconds; representative
semantic regressions should run before the full-sample audit.

## M5-4 draft and review contract

M5-4 makes the quality and measurement rules part of the batch contract. A new
manifest should keep the generator identity in `generator.prompt_version`, and its
`measurement` object must point to a reviewable relation-diff artifact and its
SHA-256 digest. The metrics command uses the declared artifact path exactly; a
different `--relation-diff` path is rejected. The artifact contains only relation
identities and before/after fields; it is not a raw model response or an unreviewed
draft.

The current versioned draft contract is [`m5-draft-template-v2.md`](m5-draft-template-v2.md);
[`m5-draft-template-v1.md`](m5-draft-template-v1.md) is the preceding contract.
The draft template/prompt must treat every relation as optional. It should ask for
the source sense, target sense, relation type, and a short writer-facing reason, but
it must never ask an author to fill a relation quota. When the evidence is weak, the
correct result is an empty relation list and an editorial gap. A relation is not
admitted merely because the target co-occurs with the source or because a record
would look more complete with another edge.

The following failure types are the shared vocabulary for the draft prompt and the
editorial review checklist:

| Failure type | Review question |
| --- | --- |
| `incidental-co-occurrence` | Is this merely something that may appear nearby in a scene or sentence? |
| `generic-result-or-reaction` | Is the target only a common consequence, response, trace, or aftermath? |
| `arbitrary-modifier-or-place` | Is a place, object, modifier, or scene detail being attached without a stable writer-facing use? |
| `broad-common-category` | Is the target a broad category or generic neighbor that does not preserve the source sense? |
| `unsupported-cross-sensory` | Does the edge jump between senses without a concrete sensory image or explanation? |
| `sense-target-type-error` | Are the source sense, target sense, part of speech, or relation type wrong? |

The reviewer may keep a wider `scene`, `sensory`, `action`, or `association`
relation when its note explains a stable use for the source sense. The failure type
describes why a candidate was removed or changed; it does not turn the relation
types into a second ranking system.

### Relation diff and pass timing

Each temporary relation snapshot gives every relation a stable `id` and records its
`source_sense`, target, target sense, and type. The diff command then emits one event
per `add`, `remove`, `retype`, or `retarget`:

```sh
npm run batch:diff -- \
  --batch-id=m5-4-example \
  --before=/tmp/typewriter-m5-4/draft-relations.json \
  --after=/tmp/typewriter-m5-4/final-relations.json \
  --output=/tmp/typewriter-m5-4/relation-diff.json
```

If a source sense changes, the old relation must be removed and a new relation
added; changing `source_sense` under the same relation ID is rejected. This makes a
retarget or retype measurable instead of hiding it in a rewritten final JSONL.
The final artifact may add a controlled failure type to each reviewed event, but it
never includes the draft prose or external source text.

The baseline editorial-time contract has five required editorial passes in every
new measurement manifest:

1. `target-preparation`
2. `initial-review`
3. `feedback-fixes`
4. `final-audit`
5. `held-rejected`

Each editorial-time pass records wall-clock seconds and editor seconds separately.
A manifest may be marked `incomplete` while an older baseline is being repaired,
but a completed metrics artifact is rejected if any required pass is missing
either measurement. Wave B's `m5-10b-v3` contract is an explicit
`producer-throughput` variant: it records `producer_seconds` for recorder-invoked
producer executions, forbids `editor_seconds`, and marks editorial judgment time
as unmeasured. Its separate producer throughput gate must not be interpreted as
the historical 12-second editor-time gate.
Wave A2 adds one required `post-freeze-audit` pass in a distinct timing artifact
after editorial completion; that pass is combined with the five editorial passes
for the A2 source-derived total and gate.
When reviewer feedback arrives after the five-pass review has ended, the manifest
adds a paired `post-review-audit` and `post-review-fixes` entry for that feedback
cycle. Repeated cycles carry a one-based `cycle` and both entries carry the same
`feedback_received_at`; derived metrics key them as `post-review-audit#2` and
`post-review-fixes#2`. The audit and fixes passes must be measured from their
actual follow-up work and cannot backfill or estimate an earlier pass. If a
follow-up edit time was not instrumented, both entries for that cycle remain
`unmeasured`, the timing status is `incomplete`, and the derived metrics expose
measured timing only as a lower bound. Missing cycles or timestamps before the
recorded feedback are rejected.
The metrics command derives decision counts, sense/relation corrections,
canonical counts, relation-diff counts, rates, audit findings, and timing totals
from the source artifacts:

```sh
npm run batch:metrics -- \
  --manifest=data/batches/m5-3-calibration.json \
  --relation-diff=data/batches/m5-3-relation-diff.json \
  --output=/tmp/typewriter-metrics.json
```

To detect drift in a checked-in metrics artifact, use `--check` instead of
`--output`. Hand-editing a source path, digest-backed relation event, or derived
count fails the comparison. The event validator also checks that every added,
retyped, or retargeted `after` tuple exists in the approved canonical batch and
that every removed or changed `before` tuple is absent from the final batch.

M5-8 stage reports use the same metrics artifact as a source rather than copying
its values by hand. They additionally bind the report to the raw manifest,
relation diff, canonical directory, and a small verification artifact through
path and SHA-256 checks. An unused candidate-buffer slot is represented by a
`deferred` manifest decision; it is not changed into a false `held` or
`rejected` decision and does not enter the canonical import count. The metrics
artifact retains the full `selected_start_count`, adds `processed_start_count`
when deferred rows exist, and uses `included + corrected + held + rejected`
as the denominator for correction rate and editor time per start. This keeps an
unused reserve from making a stage appear cheaper or less correction-heavy.

The historical M5-3 artifact is intentionally marked `timing.status: "incomplete"`:
its 603-second initial-review wall-clock interval is retained, while feedback,
final-audit, held/rejected, and editor-time measurements are explicitly unmeasured.
Its reconstructed relation diff is an audit ledger, not a raw draft.

### M5-6 process correction

M5-6 fixes the two process gaps found in M5-5 without changing the expansion
gate. The seven M5-5 removed relation events are tracked as self-authored
regression cases in
[`tests/fixtures/relation-admission/m5-5-regressions.json`](../tests/fixtures/relation-admission/m5-5-regressions.json)
and are validated against their original event IDs and tuples. The fixture
records the expected human action (`omit` or an explicitly reviewed retarget);
it is not a semantic auto-approval rule and its events are not added to a new
noise-rate measurement.

The next batch must record `target-preparation`, `initial-review`,
`feedback-fixes`, `final-audit`, and `held-rejected`. If feedback arrives after
those passes, `post-review-audit` and `post-review-fixes` are recorded as
separate passes. An unmeasured follow-up keeps timing incomplete and the
derived measured total a lower bound; once measured, the same source-derived
metrics calculation includes it. See
[`m5-6-relation-process.md`](m5-6-relation-process.md) for the complete
process correction and the canonical no-change invariant.

### M5-7 application and gate result

M5-7 applies the v2 relation process to 40 previously unreviewed starts. The
revision-`m5-4` selection inventory is preserved as
`data/batches/m5-7-preimport-inventory.json`; the final inventory advances to
revision `m5-5` after only the 38 included/corrected records are promoted.
The batch manifest, relation diff, and derived metrics report all seven timing
passes, including a measured re-audit and correction pass after PR feedback.
Its fixed-gate result is `HOLD PROCESS` and is documented in
[`m5-7-expansion-report.md`](m5-7-expansion-report.md).

### M5-8 process redesign

Before another data batch is selected, apply the staged workflow in
[`m5-8-editorial-workflow.md`](m5-8-editorial-workflow.md) and validate its
machine-readable plan with `npm run batch:process:check`. The plan separates a
human sense/POS checkpoint from optional relation admission, keeps relation
output empty until sense review is complete, measures actual timing events, and
defines candidate-buffer arithmetic so `+N` means the exact canonical start
delta. It fixes the M5-7 sense/POS and relation regressions without adding
canonical rows or pre-creating later-stage issues. A failed quality, cost, audit,
or exact-count gate produces `HOLD PROCESS` and blocks the next stage.

The pre-defined expansion decision is documented in
[`m5-expansion-gate.md`](m5-expansion-gate.md). A later calibration must apply that
gate without changing its thresholds after seeing the result.

# M5-10A process correction

## Decision

Issue #107 corrects the review process after the failed #96 Wave A result. It
does not change canonical data, convert the historical `HOLD PROCESS` result to
a pass, or authorize Wave B.

The pre-A2 canonical snapshot preserved by this process correction is:

```text
620 records / 578 starts / 42 reference-only / 743 senses / 467 relations / 39 expressions
```

The failed Wave A evidence remains bound to the process correction, including
37.5% relation noise (`3/8`) and 40.1969 editor seconds per processed start.

## Sense preflight

Every selected inventory start in a future M5-10A manifest must have exactly one
`sense_review.preflight.record_checkpoints` entry. A checkpoint records:

- `inventory_id` and the importability `status`;
- whether lemma/POS review was completed;
- observed sense count and POS values;
- six structured boundary evidence objects, each with `applicability`,
  `candidate_sense_ids`, `decision`, and any actual `contrasts`;
- `missing_boundary_ids`; and
- a human-readable note.

The six boundary IDs are fixed in the process revision
`m5-10a-process-correction-v1`:

1. `physical-figurative` — physical and figurative usage;
2. `homonym-pos` — homonym and part-of-speech separation;
3. `sensory-emotion-state-action` — sensory, emotion, state, and action meanings;
4. `directional-symmetry` — paired directions such as upper/lower or inside/outside;
5. `compound-spaced-phrase` — compound word versus spaced phrase; and
6. `word-idiom` — ordinary word versus idiom.

An `included` or `corrected` record maps to a `complete` checkpoint only after a
verified human session. It must carry its canonical ID, observed sense/POS facts,
completed lemma/POS review, at least one checked (applicable) boundary, and no
unreviewed boundary. A `held`, `rejected`, or `deferred` record cannot carry a
canonical ID.
Reviewed evidence cites the exact canonical candidate senses and records a
structured contrast when the boundary applies; `not-applicable` and
`not-reviewed` make no generated sense claim. Any boundary marked `not-reviewed`
must be repeated in `missing_boundary_ids`; that omission blocks relation review
for the record. Reused or generic contrast evidence is rejected after removing
record IDs, lemmas, and glosses from its fingerprint.

An input without a verifiable session artifact is an `unverified-draft`; it must
remain `in-review`, every promoted boundary stays `unreviewed`/`pending`, and it
cannot be used as a completed import manifest. The artifact must bind the actor,
UUID session, completion time, input digest, and its own digest before a complete
human review can be accepted.

The self-authored regression fixture
[`tests/fixtures/m5-10-wave-a-sense-regressions.json`](../tests/fixtures/m5-10-wave-a-sense-regressions.json)
keeps the 21 known Wave A sense-boundary cases, their expected sense/POS/gloss
values, and their required boundary IDs. The process validator checks the exact
case set, canonical values, and boundary coverage before the next sample is
reviewed.

## Relation candidate-generation calibration

The historical M5-9A `25 → 13 + 12` relation regression is retained only to
preserve the failed denominator. It is not evidence that candidate-generation
noise was corrected. The actual A2 precondition is the separate noncanonical
20-case calibration in
[`tests/fixtures/m5-10a-relation-generation-calibration.json`](../tests/fixtures/m5-10a-relation-generation-calibration.json).

The deterministic generator in `scripts/batch/relation-generation.mjs` consumes
that fixture and the current canonical senses. The fixture contains only a
source sense and its preflight evidence: it has no target, relation type,
direction, expected action, generation basis, suppression label, or writer-use
oracle. The generator independently selects a target and relation type
from actual gloss content and separate contracts for `direct`, `near`, `mood`,
`scene`, `sensory`, `action`, and `association`. A request with no
contract-valid, writer-useful target remains visible as a normal
`no-valid-candidate` result; it is not forced into a relation or silently
counted as an upstream suppression. The source-bound result therefore accounts
for all 20 unlabelled requests without hiding a pre-labelled bad tuple.
None of the calibration cases is imported into canonical data, every generated
target remains inside the pre-existing scope, and every generated tuple is
checked to be absent from the canonical relation set.

The builder does not manufacture an editorial verdict. The separately authored
[`data/batches/m5-10a-relation-calibration-audit.json`](../data/batches/m5-10a-relation-calibration-audit.json)
records one `admit`, `reject`, or `correct` decision for each raw proposal and a
not-applicable review for each no-candidate case. A missing audit input blocks
the build, and `independent`, counts, rates, and gate status are not accepted
from the build output as proof; the validator derives them from the audit cases
and findings. The current regenerated set has nine raw proposals and eleven
no-candidate results. The four previously reported false-positive patterns are
absent from that set.

The fixed gate requires all 20 calibration cases to have record-specific,
non-boilerplate boundary evidence. Checked evidence carries the observed
canonical gloss and a meaning/use note; `not-applicable` evidence carries an
explicit reason and no sense claim. The full audit reviews all 20 requests,
including no-candidate results, and every raw proposal, recomputes noise,
 correction rate, and admission counts,
and leaves zero open blockers. The audit records a distinct auditor identity,
audit timestamp, UUID session, and source digest; `independent: true` alone is not
accepted. Editor time is read only from
the separate `timing-recorder-v1` session artifact. Each pass must be explicitly
started and stopped through the recorder CLI, which persists an in-progress
session; automatic waits, handwritten timestamps, and backfilled sessions fail.
The measured time is at or below 12 editor seconds per processed start, with
matching fixture/canonical/plan/timing digests. Run the validator before the
process and repair checks:

```sh
npm run batch:m5-10a:calibration:check
```

## Historical relation admission

Relation output starts empty. Candidates are not admitted merely because they
co-occur, could be a result or reaction, name a nearby object/place/modifier,
belong to a broad category, or have a source/target sense mismatch.

The deterministic pre-screen denominator and human-admission denominator remain
separate and reproducible. The bound 25-proposal regression has:

```text
25 proposals → 13 pre-screen passes + 12 pre-screen rejects
             → 13 human-admission cases → 13 admitted relations
```

The known pre-screen rejection categories are `generic-result-or-reaction` (7),
`arbitrary-modifier-or-place` (3), and `broad-common-category` (2). The existing
M5-9A relation-screen artifact is retained as the source-bound historical
regression; the historical Wave A relation screen is validated independently.
The controlled pre-screen vocabulary also includes incidental co-occurrence,
unsupported cross-sensory jumps, and source/target sense or type errors. This
historical classification is not used as the calibration success metric.

## Timing boundary

The M5-10A timing contract is `m5-10a-v1`. It measures the five required human
editorial passes—target preparation, initial review, feedback fixes, final audit,
and held/rejected decisions—and each recorded post-review audit/fixes pair.
For the calibration artifact, run `batch:m5-10a:calibration:timing` with
`--action=start|stop`, `--pass=<required pass>`, and persisted `--input` /
`--output` session paths. Stopping `final-audit` additionally requires the
audited case IDs and raw-proposal SHA-256 digest:

```sh
npm run batch:m5-10a:calibration:timing -- \
  --action=stop --pass=final-audit \
  --case-ids=m5-10a-cal-001,...,m5-10a-cal-020 \
  --raw-proposal-sha256=<sha256> \
  --input=/tmp/typewriter-m5-10a-timing-session.json \
  --output=/tmp/typewriter-m5-10a-timing-session.json
```

The recorder derives duration from explicit current-clock start/stop events and
emits the final artifact only after all five passes have been stopped. The
final-audit session requires complete 20-case coverage and is the audit session
bound into the calibration artifact; a short or coverage-free audit is rejected.
It still requires feedback timestamps for follow-up cycles.

Mechanical count, digest, import, tuple, canonical, SQLite, search, and package
checks are verification evidence, not editorial work. They are explicitly
excluded from editor seconds. A missing or unmeasured pass leaves timing
incomplete and fails the gate; no time is estimated or backfilled.

## Source-bound authorization

`data/batches/m5-10a-process-correction.json` binds the historical stage,
Wave A manifest/metrics, historical relation artifacts, the 20-case calibration
fixture and dry-run, its timing-recorder session artifact, regression fixture,
canonical directory digest, and machine verification artifact. Validate the
calibration and process contract with:

```sh
npm run batch:m5-10a:calibration:check
npm run batch:m5-10a:process:check
```

`data/batches/m5-10a-repair-authorization.json` binds the failed Wave A stage
and the process-correction digest. Validate it with:

```sh
npm run batch:m5-10a:repair:check
```

The authorization is deliberately narrow:

```text
#96 Wave A2: 578 → 628 starts, net +50 only
Wave B:     net +150, unauthorized until A2 passes and is separately authorized
```

The candidate buffer must be declared before selection, and canonical mutation is
false in the authorization. No Wave B batch, quota, canonical start, or M6 work
is created by #107.

## Wave A2 execution

Issue #96 Wave A2's proposal is recorded in its separate report
[`docs/m5-10a-wave-a2-report.md`](m5-10a-wave-a2-report.md). The current canonical
snapshot contains the declared 50-start delta from the 58-start selection, but
the manifest remains `in-review` because no verified editorial or independent
audit session artifact is attached. Its bounded stage remains `HOLD PROCESS`
until those artifacts and the separate editor-session timing input contain real
evidence. The A2 stage still sets `next_stage_authorized: false`; Wave B is not
included in the A2 batch.

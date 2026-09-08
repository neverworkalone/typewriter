# M5-10A process correction

## Decision

Issue #107 corrects the review process after the failed #96 Wave A result. It
does not change canonical data, convert the historical `HOLD PROCESS` result to
a pass, or authorize Wave B.

The current canonical snapshot remains:

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
- the result of all six boundary checks;
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

An `included` or `corrected` record maps to a `complete` checkpoint and must
carry its canonical ID, observed sense/POS facts, completed lemma/POS review,
and no unreviewed boundary. A `held`, `rejected`, or `deferred` record cannot
carry a canonical ID. Any boundary marked `not-reviewed` must be repeated in
`missing_boundary_ids`; that omission blocks relation review for the record.

The self-authored regression fixture
[`tests/fixtures/m5-10-wave-a-sense-regressions.json`](../tests/fixtures/m5-10-wave-a-sense-regressions.json)
keeps the 21 known Wave A sense-boundary cases, their expected sense/POS/gloss
values, and their required boundary IDs. The process validator checks the exact
case set, canonical values, and boundary coverage before the next sample is
reviewed.

## Relation admission

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
M5-9A relation-screen artifact is retained as the source-bound regression; the
historical Wave A relation screen is validated independently. The controlled
pre-screen vocabulary also includes incidental co-occurrence, unsupported
cross-sensory jumps, and source/target sense or type errors.

## Timing boundary

The M5-10A timing contract is `m5-10a-v1`. It measures the five required human
editorial passes—target preparation, initial review, feedback fixes, final audit,
and held/rejected decisions—and each recorded post-review audit/fixes pair.
The timing recorder derives duration from its recorded start/stop timestamps and
requires feedback timestamps for follow-up cycles.

Mechanical count, digest, import, tuple, canonical, SQLite, search, and package
checks are verification evidence, not editorial work. They are explicitly
excluded from editor seconds. A missing or unmeasured pass leaves timing
incomplete and fails the gate; no time is estimated or backfilled.

## Source-bound authorization

`data/batches/m5-10a-process-correction.json` binds the historical stage,
Wave A manifest/metrics, relation artifacts, regression fixture, canonical
directory digest, and machine verification artifact. Validate it with:

```sh
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

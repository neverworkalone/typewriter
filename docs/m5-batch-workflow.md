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
- one decision per reviewed inventory target or reference-closure record; and
- the final `canonical_id` for every `included` or `corrected` record.

Record decisions are deliberately explicit:

| Decision | Canonical staging | Meaning |
| --- | --- | --- |
| `included` | required | Reviewed record enters the batch unchanged from the reviewed decision. |
| `corrected` | required | Reviewed record enters after named fields were corrected. |
| `held` | forbidden | Review is recorded, but the record is not importable. |
| `rejected` | forbidden | Review decision excludes the record from this batch. |

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
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl
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
8. the existing canonical dataset plus staged rows as one dataset, without
   modifying the existing canonical directory.

After the gate passes, an editor may create an external import artifact:

```sh
npm run batch:import -- \
  --manifest=/tmp/typewriter-m5-2/batch.json \
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl \
  --output=/tmp/typewriter-m5-2/canonical-import.jsonl
```

`batch:import` writes only the validated reviewed rows, sorted by canonical ID. It
does not modify `data/canonical/`, does not build SQLite, and refuses output paths
inside the repository or canonical input. The editor performs the final deliberate
canonical-file change together with the corresponding M5 seed transition
(`status: "promoted"` plus `canonical_id`), regenerates the target inventory, and
then runs the ordinary canonical validator, normalizer, and build checks. A held or
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

## M5-4 draft and review contract

M5-4 makes the quality and measurement rules part of the batch contract. A new
manifest should keep the generator identity in `generator.prompt_version`, and its
`measurement` object must point to a reviewable relation-diff artifact and its
SHA-256 digest. The metrics command uses the declared artifact path exactly; a
different `--relation-diff` path is rejected. The artifact contains only relation
identities and before/after fields; it is not a raw model response or an unreviewed
draft.

The versioned draft contract is [`m5-draft-template-v1.md`](m5-draft-template-v1.md).
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

Five timing passes are required in every new measurement manifest:

1. `target-preparation`
2. `initial-review`
3. `feedback-fixes`
4. `final-audit`
5. `held-rejected`

Each pass records wall-clock seconds and editor seconds separately. A manifest may
be marked `incomplete` while an older baseline is being repaired, but a completed
metrics artifact is rejected if any required pass is missing either measurement.
When reviewer feedback arrives after the five-pass review has ended, the manifest
may add the controlled `post-review-audit` and `post-review-fixes` passes. The
audit pass must be measured from the actual follow-up work; it must not backfill
or estimate an earlier pass. If the feedback-fix edit time was not instrumented,
`post-review-fixes` must remain `unmeasured`, the timing status must be
`incomplete`, and the derived metrics expose measured timing as a lower bound.
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

The historical M5-3 artifact is intentionally marked `timing.status: "incomplete"`:
its 603-second initial-review wall-clock interval is retained, while feedback,
final-audit, held/rejected, and editor-time measurements are explicitly unmeasured.
Its reconstructed relation diff is an audit ledger, not a raw draft.

The pre-defined expansion decision is documented in
[`m5-expansion-gate.md`](m5-expansion-gate.md). A later calibration must apply that
gate without changing its thresholds after seeing the result.

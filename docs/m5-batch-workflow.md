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
The executable validator is [`scripts/batch/validate-batch.mjs`](../scripts/batch/validate-batch.mjs).

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
4. deterministic IDs: new `start` rows continue the next `wNNN` IDs and
   `reference-only` rows continue the next `rNNN` IDs in manifest order;
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
`wNNN` for `start` and `rNNN` for `reference-only`. Sense IDs are assigned from
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

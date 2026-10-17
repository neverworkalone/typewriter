# Canonical and product validation

The approved editable dictionary source is `data/canonical/*.jsonl`. The product pipeline validates those records, builds Full SQLite, projects the Lite extension database, and packages the runtime assets. Canonical records and their source-bound sense order remain the authority; the build does not read the retired Meaning editing shards.

## Commands

From the repository root:

```sh
node scripts/validate/canonical-jsonl.mjs
node scripts/validate/dataset-integrity.mjs
node scripts/validate/surface-form-projection.mjs
pnpm run ci:normal
pnpm run ci:deep
```

`ci:normal` runs the complete current Canonical audit, one current-revision SQLite build, applicable relation checks, product tests/builds, and artifact validation. `ci:deep` runs the registered current-system reproducibility checks; `ci:all` runs Normal before Deep. Pull requests run Normal except documentation-only changes, with affected Deep checks added through `ci:pr`.

The canonical validator checks UTF-8, JSON parsing, and the row schema. Dataset integrity checks current record/sense identity and source-bound references. Surface-form validation checks the current projection and search path. Build and package checks protect the Full-to-Lite projection, deterministic metadata, relation targets, offline runtime, and product boundary.

Tests are registered only for durable current product or data/build contracts. See [`docs/review-toolchain.md`](../../docs/review-toolchain.md) for the threshold and [`docs/test-inventory-823.md`](../../docs/test-inventory-823.md) for the file-by-file audit. A one-off check of a UI style or implementation choice is performed for that change and does not become an automatic CI test.

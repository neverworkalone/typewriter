// Declared registry of scripts that can write canonical lexical records (issue #251).
// `tests/production-entrypoints.test.mjs` scans scripts/ and fails when a writer
// exists that is not declared here, so a new unchecked production path cannot
// appear silently.
export const ACTIVE_PRODUCTION_ENTRYPOINTS = Object.freeze({
  'scripts/batch/build-issue-223-corpus-batch.mjs': 'Corpus batch builder (B05+). Batches from INTAKE_HANDOFF_FIRST_BATCH require the shared intake hand-off.',
});

// Historical, batch-specific pipelines. Each writes a fixed, already-completed
// batch's artifact (constant output path, no batch-id argument) and is re-verified
// by its own validator; none can admit a new batch.
export const HISTORICAL_ENTRYPOINTS = Object.freeze({
  'scripts/batch/m5-12a-pipeline.mjs': 'm5-12a-expansion.jsonl',
  'scripts/batch/m5-13-pipeline.mjs': 'm5-13-expansion.jsonl',
  'scripts/batch/m5-14-pipeline.mjs': 'm5-14-expansion.jsonl',
  'scripts/batch/m5-15-pipeline.mjs': 'm5-15-expansion.jsonl',
  'scripts/batch/promote-m5-11.mjs': 'm5-11 promotion (fixed batch)',
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildM9ProductionProgress } from '../scripts/batch/m9-production-progress.mjs';

const schemaPath = new URL('../schema/m9-production-progress.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const cliPath = fileURLToPath(new URL('../scripts/batch/m9-production-progress.mjs', import.meta.url));

const cleanLowYieldInput = {
  checkpoint_target: 7500,
  canonical_count_at_start: 5105,
  canonical_count_now: 5107,
  batches_processed: 3,
  candidate_yield: {
    selected_count: 200,
    admitted_count: 2,
    held_count: 178,
    rejected_count: 20,
  },
  defect_classes: [],
  source_exhausted: false,
  blocker: null,
};

test('clean low-yield batches preserve standards and continue to the issue checkpoint', () => {
  const progress = buildM9ProductionProgress(cleanLowYieldInput);
  assert.deepEqual(progress, {
    schema_version: 1,
    checkpoint_target: 7500,
    canonical_count_at_start: 5105,
    canonical_count_now: 5107,
    net_admitted_this_run: 2,
    remaining_to_checkpoint: 2393,
    batches_processed: 3,
    candidate_yield: {
      selected_count: 200,
      admitted_count: 2,
      held_count: 178,
      rejected_count: 20,
    },
    defect_classes: [],
    blocker: null,
    continuation_required: true,
    stop_reason: null,
  });
  assert.deepEqual(Object.keys(progress).sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(progress.candidate_yield).sort(),
    [...schema.properties.candidate_yield.required].sort(),
  );
});

test('progress and continuation state are deterministic for equivalent input', () => {
  const first = buildM9ProductionProgress({
    ...cleanLowYieldInput,
    defect_classes: ['surface-collision', 'sense-boundary'],
  });
  const second = buildM9ProductionProgress({
    ...cleanLowYieldInput,
    defect_classes: ['sense-boundary', 'surface-collision', 'sense-boundary'],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.defect_classes, ['sense-boundary', 'surface-collision']);
  assert.equal(first.continuation_required, false);
  assert.equal(first.stop_reason, 'systemic-defect');
});

test('progress CLI reads JSON input and emits the normalized report', () => {
  const result = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    input: JSON.stringify(cleanLowYieldInput),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), buildM9ProductionProgress(cleanLowYieldInput));
});

test('checkpoint, source exhaustion, and explicit blockers produce stable stop states', () => {
  const atCheckpoint = buildM9ProductionProgress({
    ...cleanLowYieldInput,
    canonical_count_now: 7502,
  });
  assert.equal(atCheckpoint.remaining_to_checkpoint, 0);
  assert.equal(atCheckpoint.continuation_required, false);
  assert.equal(atCheckpoint.stop_reason, 'checkpoint-reached');

  const exhausted = buildM9ProductionProgress({
    ...cleanLowYieldInput,
    source_exhausted: true,
  });
  assert.equal(exhausted.continuation_required, false);
  assert.equal(exhausted.stop_reason, 'source-exhaustion');

  const licensingHold = buildM9ProductionProgress({
    ...cleanLowYieldInput,
    blocker: 'licensing',
  });
  assert.equal(licensingHold.continuation_required, false);
  assert.equal(licensingHold.stop_reason, 'product-or-licensing-blocker');
  assert.equal(licensingHold.blocker, 'licensing');
});

test('progress rejects inconsistent counts and unsupported input', () => {
  assert.throws(() => buildM9ProductionProgress({
    ...cleanLowYieldInput,
    candidate_yield: { ...cleanLowYieldInput.candidate_yield, admitted_count: 3 },
  }), /selected_count must equal/u);
  assert.throws(() => buildM9ProductionProgress({
    ...cleanLowYieldInput,
    canonical_count_now: 5104,
  }), /cannot be below/u);
  assert.throws(() => buildM9ProductionProgress({
    ...cleanLowYieldInput,
    unexpected: true,
  }), /unsupported fields/u);
});

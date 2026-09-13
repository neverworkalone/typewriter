import assert from 'node:assert/strict';
import test from 'node:test';

import { validateM511 } from '../scripts/batch/validate-m5-11.mjs';

test('M5-11 records the bounded +500 result and fixed-gate hold', async () => {
  const result = await validateM511();

  assert.equal(result.batch_id, 'm5-11-expansion-20260913');
  assert.deepEqual(result.canonical, {
    record_count: 1320,
    start_count: 1278,
    reference_only_count: 42,
    sense_count: 1466,
    relation_count: 473,
    expression_count: 63,
  });
  assert.deepEqual(result.decisions, {
    included_start_count: 500,
    corrected_start_count: 0,
    held_start_count: 0,
    rejected_start_count: 0,
    deferred_start_count: 50,
    processed_start_count: 500,
  });
  assert.equal(result.gate_status, 'fail');
  assert.deepEqual(result.gate_failures, [
    'editor_time',
    'timing_complete',
    'human_editorial_review',
  ]);
});

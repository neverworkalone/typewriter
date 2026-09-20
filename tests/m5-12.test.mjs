import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  M5_12_CATALOG,
} from '../scripts/batch/m5-12-catalog.mjs';
import {
  M5_12_BATCH_ID,
  M5_12_BASE_SUMMARY,
  M5_12_TARGET,
  validateM512,
} from '../scripts/batch/validate-m5-12.mjs';

test('M5-12 declares exactly one bounded candidate pool without candidate bodies', () => {
  assert.equal(M5_12_CATALOG.length, M5_12_TARGET.selected_start_count);
  assert.equal(
    new Set(M5_12_CATALOG.map(({ inventory_id: inventoryId }) => inventoryId)).size,
    M5_12_CATALOG.length,
  );
  assert.deepEqual(
    M5_12_CATALOG.at(0),
    {
      catalog_index: 0,
      inventory_id: 'm5-1085',
      axis: 'E',
      flags: ['mood-range'],
    },
  );
  assert.deepEqual(
    M5_12_CATALOG.at(-1),
    {
      catalog_index: 801,
      inventory_id: 'm5-1886',
      axis: 'X',
      flags: ['direct-boundary'],
    },
  );
  for (const entry of M5_12_CATALOG) {
    assert.equal(Object.hasOwn(entry, 'lemma'), false);
    assert.equal(Object.hasOwn(entry, 'pos'), false);
    assert.equal(Object.hasOwn(entry, 'candidate_record'), false);
  }
});

test('M5-12 remains on HOLD before human editorial review and promotion', async () => {
  const result = await validateM512();

  assert.equal(result.batch_id, M5_12_BATCH_ID);
  assert.deepEqual(result.canonical, M5_12_BASE_SUMMARY);
  assert.deepEqual(result.target, M5_12_TARGET);
  assert.equal(result.gate_status, 'fail');
  assert.deepEqual(result.gate_failures, [
    'editorial_decision_artifact',
    'human_editorial_review',
    'timing_complete',
    'audit',
    'canonical_promotion',
  ]);
  assert.equal(result.human_editorial_review_complete, false);
  assert.equal(result.promotion.canonical_mutation, false);
  assert.equal(result.promotion.seed_mutation, false);
  assert.equal(result.promotion.inventory_mutation, false);
});

test('M5-12 stage evidence contains no canonical import artifact', async () => {
  const stage = JSON.parse(await readFile('data/batches/m5-12-stage.json', 'utf8'));
  const review = JSON.parse(await readFile('data/batches/m5-12-review.json', 'utf8'));

  assert.equal(stage.gate.decision, 'HOLD PROCESS');
  assert.equal(stage.promotion.canonical_mutation, false);
  assert.equal(review.decision_artifact, null);
  assert.equal(review.human_editorial_review_complete, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  M5_12_CATALOG,
} from '../scripts/batch/m5-12-catalog.mjs';
import {
  M5_12_TARGET,
  validateM512Catalog,
} from '../scripts/batch/validate-m5-12.mjs';

test('M5-12 declares capacity slots without pretending they are selected candidates', () => {
  assert.equal(M5_12_CATALOG.length, M5_12_TARGET.selection_slot_count);
  assert.equal(
    new Set(M5_12_CATALOG.map(({ slot_id: slotId }) => slotId)).size,
    M5_12_CATALOG.length,
  );
  assert.deepEqual(
    M5_12_CATALOG.at(0),
    {
      catalog_index: 0,
      slot_id: 'm5-12-slot-0001',
      axis: 'E',
      flags: ['mood-range'],
    },
  );
  assert.deepEqual(
    M5_12_CATALOG.at(-1),
    {
      catalog_index: 801,
      slot_id: 'm5-12-slot-0802',
      axis: 'X',
      flags: ['direct-boundary'],
    },
  );
  for (const entry of M5_12_CATALOG) {
    assert.equal(Object.hasOwn(entry, 'inventory_id'), false);
    assert.equal(Object.hasOwn(entry, 'lemma'), false);
    assert.equal(Object.hasOwn(entry, 'pos'), false);
    assert.equal(Object.hasOwn(entry, 'candidate_record'), false);
  }
});

test('M5-12 rejects a catalog row that smuggles an unbound inventory target', () => {
  const driftedCatalog = M5_12_CATALOG.map((entry, index) => (
    index === 0 ? { ...entry, inventory_id: 'm5-9999' } : entry
  ));

  assert.throws(
    () => validateM512Catalog(driftedCatalog),
    (error) => error.code === 'CATALOG_SHAPE_ERROR',
  );
});

test('M5-12 stage evidence contains no canonical import artifact', async () => {
  const stage = JSON.parse(await readFile('data/batches/m5-12-stage.json', 'utf8'));
  const review = JSON.parse(await readFile('data/batches/m5-12-review.json', 'utf8'));

  assert.equal(stage.gate.decision, 'HOLD PROCESS');
  assert.equal(stage.promotion.canonical_mutation, false);
  assert.equal(review.decision_artifact, null);
  assert.equal(review.human_editorial_review_complete, false);
  assert.equal(stage.predecessor_expansion.artifact, 'data/batches/m5-11-promotion.json');
  assert.equal(stage.predecessor_expansion.gate_status, 'pass');
});

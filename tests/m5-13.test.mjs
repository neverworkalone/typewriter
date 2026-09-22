import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  M5_13_CATALOG,
} from '../scripts/batch/m5-13-catalog.mjs';
import {
  M5_13_TARGET,
  validateM513,
  validateM513Catalog,
} from '../scripts/batch/validate-m5-13.mjs';
import { loadCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import { parseJsonWithUniqueKeys } from '../scripts/validate/unique-json.mjs';

test('M5-13 declares capacity slots without pretending they are selected candidates', () => {
  assert.equal(M5_13_CATALOG.length, M5_13_TARGET.selection_slot_count);
  assert.equal(
    new Set(M5_13_CATALOG.map(({ slot_id: slotId }) => slotId)).size,
    M5_13_CATALOG.length,
  );
  assert.deepEqual(M5_13_CATALOG.at(0), {
    catalog_index: 0,
    slot_id: 'm5-13-slot-0001',
    axis: 'E',
    flags: ['mood-range'],
  });
  assert.deepEqual(M5_13_CATALOG.at(-1), {
    catalog_index: 1099,
    slot_id: 'm5-13-slot-1100',
    axis: 'X',
    flags: ['direct-boundary'],
  });
  for (const entry of M5_13_CATALOG) {
    assert.equal(Object.hasOwn(entry, 'inventory_id'), false);
    assert.equal(Object.hasOwn(entry, 'lemma'), false);
    assert.equal(Object.hasOwn(entry, 'pos'), false);
    assert.equal(Object.hasOwn(entry, 'candidate_record'), false);
  }
});

test('M5-13 rejects a catalog row that smuggles an unbound inventory target', () => {
  const driftedCatalog = M5_13_CATALOG.map((entry, index) => (
    index === 0 ? { ...entry, inventory_id: 'm5-9999' } : entry
  ));

  assert.throws(
    () => validateM513Catalog(driftedCatalog),
    (error) => error.code === 'CATALOG_SHAPE_ERROR',
  );
});

test('M5-13 stage validation binds the current canonical authority and keeps promotion blocked', async () => {
  const result = await validateM513();
  assert.equal(result.canonical.start_count, 2000);
  assert.equal(result.target.net_start_increase, 1000);
  assert.equal(result.target.cumulative_start_target, 3000);
  assert.equal(result.target.candidate_identity_count, 0);
  assert.equal(result.decisions.unresolved_slot_count, 1100);
  assert.equal(result.gate_status, 'fail');
  assert.equal(result.promotion.canonical_mutation, false);
  assert.equal(result.promotion.seed_mutation, false);
});

test('M5-13 validation consumes a supplied shared canonical context', async () => {
  const canonicalContext = await loadCanonicalContext({ contextPath: null });
  const metricsBefore = { ...canonicalContext.metrics };

  const result = await validateM513({ canonicalContext });

  assert.equal(result.canonical.start_count, 2000);
  assert.deepEqual(canonicalContext.metrics, metricsBefore);
});

test('M5-13 stage evidence contains no canonical import artifact or review decision', async () => {
  const stage = parseJsonWithUniqueKeys(
    await readFile('data/batches/m5-13-stage.json', 'utf8'),
    'data/batches/m5-13-stage.json',
  );
  const review = parseJsonWithUniqueKeys(
    await readFile('data/batches/m5-13-review.json', 'utf8'),
    'data/batches/m5-13-review.json',
  );

  assert.equal(stage.contract_version, 'lexical-batch-pre-admission-stage-v1');
  assert.equal(review.contract_version, 'lexical-batch-pre-admission-review-v1');
  assert.equal(stage.gate.decision, 'HOLD PROCESS');
  assert.equal(stage.promotion.canonical_mutation, false);
  assert.equal(review.decision_artifact, null);
  assert.equal(review.human_editorial_review_complete, false);
  assert.equal(stage.predecessor_expansion.artifact, 'data/batches/m5-12a-admission.json');
  assert.equal(stage.predecessor_expansion.gate_status, 'pass');
});

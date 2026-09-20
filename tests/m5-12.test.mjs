import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  M5_12_CATALOG,
} from '../scripts/batch/m5-12-catalog.mjs';
import {
  M5_12_BATCH_ID,
  M5_12_BASE_SUMMARY,
  M5_12_TARGET,
  validateM512Catalog,
  validateM512,
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
  assert.equal(stage.predecessor_expansion.artifact, 'data/batches/m5-11-promotion.json');
  assert.equal(stage.predecessor_expansion.gate_status, 'pass');
});

test('M5-12 rejects a stale predecessor promotion digest before candidate work', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12-predecessor-'));
  const stagePath = path.join(temporaryDirectory, 'stage.json');
  try {
    const stage = JSON.parse(await readFile('data/batches/m5-12-stage.json', 'utf8'));
    stage.source.predecessor_promotion_sha256 = '0'.repeat(64);
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');

    await assert.rejects(
      validateM512({ stagePath }),
      (error) => error.code === 'DIGEST_MISMATCH',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-12 rejects a checkpoint tree that is not derived from the bound Git commit', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12-checkpoint-'));
  const stagePath = path.join(temporaryDirectory, 'stage.json');
  try {
    const stage = JSON.parse(await readFile('data/batches/m5-12-stage.json', 'utf8'));
    stage.previous_stage.checkpoint_tree = stage.previous_stage.checkpoint_pr_head;
    await writeFile(stagePath, `${JSON.stringify(stage)}\n`, 'utf8');

    await assert.rejects(
      validateM512({ stagePath }),
      (error) => error.code === 'CHECKPOINT_PROVENANCE_MISMATCH',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

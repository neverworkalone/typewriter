import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import { validateBatch } from '../scripts/batch/validate-batch.mjs';
import {
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');
const CURRENT_CANONICAL_DIRECTORY = path.resolve('data/canonical');
const A2_CANONICAL_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-10a-wave-a2.jsonl');

async function readBatchJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-10A Wave A2 validates the bounded +50 promotion and keeps Wave B blocked', async () => {
  const [manifest, relationDiff, metrics, stage, plan, canonical] = await Promise.all([
    readBatchJson('m5-10-wave-a2.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readBatchJson('m5-10a-wave-a2-metrics.json'),
    readBatchJson('m5-10a-wave-a2.json'),
    readBatchJson('m5-8-expansion-plan.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);

  const batch = await validateBatch({
    manifestPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a2.json'),
    stagedRecordsPath: A2_CANONICAL_PATH,
    inventoryPath: path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-preimport-inventory.json'),
    canonicalDirectory: BASE_CANONICAL_DIRECTORY,
    allowRepositoryStaging: true,
  });

  assert.equal(manifest.batch_id, 'm5-10-wave-a2-20260909');
  assert.equal(manifest.records.length, 58);
  assert.deepEqual(manifest.sense_review, {
    status: 'complete',
    reviewed_start_count: 50,
    scoped_single_sense_count: 35,
    split_record_count: 15,
    split_canonical_ids: [
      'w588', 'w595', 'w598', 'w599', 'w603', 'w604', 'w606', 'w609',
      'w617', 'w618', 'w619', 'w620', 'w621', 'w622', 'w628',
    ],
    note: manifest.sense_review.note,
    preflight: manifest.sense_review.preflight,
  });
  assert.deepEqual(batch.counts, {
    included: 35,
    held: 3,
    rejected: 3,
    corrected: 15,
    deferred: 2,
  });
  assert.equal(batch.canonicalRecordCount, 620);
  assert.equal(batch.stagedRecordCount, 50);
  assert.equal(batch.targetCount, 58);

  validateRelationDiff(relationDiff);
  assert.deepEqual(summarizeRelationDiff(relationDiff), {
    before_count: 0,
    after_count: 6,
    added_count: 6,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -6,
    noise_event_count: 0,
    noise_rate_of_before: 0,
    classification_counts: {},
    candidate_count: 6,
    admitted_candidate_count: 6,
    rejected_candidate_count: 0,
    noise_denominator_count: 6,
    noise_rate_of_candidates: 0,
  });

  assertMetricsMatch(metrics, createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonical.records,
    source: metrics.source,
  }));
  assert.equal(metrics.derived.canonical_import.imported_start_count, 50);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 65);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 6);
  assert.equal(metrics.derived.timing.status, 'complete');
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, []);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-10a-wave-a2-plus-50',
    imported_start_count: 50,
    candidate_buffer: 8,
    gate_status: 'pass',
  });
  assert.deepEqual(stage.actual.canonical_snapshot, {
    record_count: 670,
    start_count: 628,
    reference_only_count: 42,
    sense_count: 808,
    relation_count: 473,
    expression_count: 43,
  });
  assert.equal(stage.next_stage_created, false);
  assert.equal(stage.next_stage_authorized, false);
});

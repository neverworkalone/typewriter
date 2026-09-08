import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import {
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import {
  validateBatchManifest,
} from '../scripts/batch/validate-batch.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
  validateTargetInventory,
} from '../scripts/validate/target-inventory.mjs';
import {
  findRecordsByExactTerm,
  getRecord,
} from '../scripts/build/query.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-9 imports exactly 100 reviewed starts and passes the source-bound gate', async () => {
  const [manifest, relationDiff, metrics, stage, plan, verification, canonicalResult, inventoryResult, preImportInventory] = await Promise.all([
    readJson('m5-9-expansion.json'),
    readJson('m5-9-expansion-relation-diff.json'),
    readJson('m5-9-expansion-metrics.json'),
    readJson('m5-8-stage-01-plus-100.json'),
    readJson('m5-8-expansion-plan.json'),
    readJson('m5-9-expansion-verification.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readTargetInventory(DEFAULT_INVENTORY_PATH),
    readJson('m5-9-preimport-inventory.json'),
  ]);

  validateBatchManifest(manifest);
  validateRelationDiff(relationDiff);
  const regeneratedMetrics = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source: metrics.source,
  });
  assertMetricsMatch(metrics, regeneratedMetrics);
  assert.deepEqual(summarizeRelationDiff(relationDiff), {
    before_count: 0,
    after_count: 25,
    added_count: 25,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -25,
    noise_event_count: 0,
    noise_rate_of_before: 0,
    classification_counts: {},
  });

  assert.deepEqual(metrics.derived.selection, {
    selected_start_count: 112,
    processed_start_count: 107,
  });
  assert.deepEqual(metrics.derived.decisions, {
    included: 93,
    corrected: 7,
    held: 4,
    rejected: 3,
    deferred: 5,
    importable_start_count: 100,
    correction_rate_of_selected: 7 / 107,
    correction_rate_of_importable: 7 / 100,
    held_rate: 4 / 107,
    rejected_rate: 3 / 107,
    held_or_rejected_rate: 7 / 107,
    sense_field_correction_count: 7,
    relation_field_correction_count: 0,
  });
  assert.deepEqual(metrics.derived.canonical_import, {
    imported_start_count: 100,
    imported_reference_only_count: 0,
    imported_record_count: 100,
    imported_sense_count: 100,
    imported_relation_count: 25,
    imported_expression_count: 14,
    relation_type_counts: {
      mood: 8,
      near: 5,
      action: 3,
      sensory: 4,
      scene: 5,
    },
  });
  assert.equal(metrics.derived.timing.status, 'complete');
  assert.equal(metrics.derived.timing.total_editor_seconds, 1090);
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, []);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-8-stage-01-plus-100',
    imported_start_count: 100,
    candidate_buffer: 12,
    gate_status: 'pass',
  });
  assert.equal(stage.next_stage_created, true);

  assert.deepEqual({
    record_count: canonicalResult.records.length,
    start_count: canonicalResult.records.filter(({ record }) => record.role === 'start').length,
    reference_only_count: canonicalResult.records.filter(({ record }) => record.role === 'reference-only').length,
    sense_count: canonicalResult.records.reduce((count, { record }) => count + record.senses.length, 0),
    relation_count: canonicalResult.records.reduce(
      (count, { record }) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: canonicalResult.records.filter(({ record }) => record.record_type === 'expression').length,
  }, {
    record_count: 570,
    start_count: 528,
    reference_only_count: 42,
    sense_count: 657,
    relation_count: 474,
    expression_count: 37,
  });

  const inventorySummary = await validateTargetInventory();
  assert.equal(inventorySummary.revision, 'm5-6');
  assert.equal(inventorySummary.inventoryEntryCount, 597);
  assert.equal(inventorySummary.currentStartCount, 528);
  assert.equal(inventorySummary.candidateStartCount, 5);
  assert.equal(inventorySummary.plannedStartCount, 533);
  assert.equal(inventorySummary.heldCount, 18);
  assert.equal(preImportInventory.revision, 'm5-5');
  assert.deepEqual(preImportInventory.canonical_snapshot, {
    record_count: 470,
    start_count: 428,
    reference_only_count: 42,
  });
  assert.equal(
    preImportInventory.entries.filter(
      (entry) => entry.source === 'editorial' && entry.status === 'candidate',
    ).length,
    112,
  );
  assert.equal(verification.human_editorial_review_complete, true);
});

test('M5-9 admitted records and reserve decisions are visible in local search', async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-9-search-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    const first = await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(first.recordCount, 570);
      assert.equal(first.metadata.start_count, '528');
      assert.deepEqual(findRecordsByExactTerm(database, '애틋하다').map(({ id }) => id), ['w429']);
      assert.deepEqual(findRecordsByExactTerm(database, '시리다').map(({ id }) => id), ['w459']);
      assert.deepEqual(findRecordsByExactTerm(database, '개울').map(({ id }) => id), ['w475']);
      assert.deepEqual(findRecordsByExactTerm(database, '다가서다').map(({ id }) => id), ['w487']);
      assert.deepEqual(findRecordsByExactTerm(database, '장화').map(({ id }) => id), ['w501']);
      assert.deepEqual(findRecordsByExactTerm(database, '가슴이 뛰다').map(({ id }) => id), ['w515']);
      assert.deepEqual(findRecordsByExactTerm(database, '격앙되다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '폭신하다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '기어오르다'), []);
      assert.equal(getRecord(database, 'w429').senses[0].relations[0].target, 'w060');
      assert.equal(getRecord(database, 'w447').senses[0].relations[0].type, 'action');
      assert.equal(getRecord(database, 'w447').senses[0].relations[0].target, 'w218');
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

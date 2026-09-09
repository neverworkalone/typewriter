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
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  readTargetInventory,
  validateTargetInventory,
} from '../scripts/validate/target-inventory.mjs';
import {
  findRecordsByExactTerm,
  getRecord,
} from '../scripts/build/query.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const HISTORICAL_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-9-postimport-canonical');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');
const PRE_A2_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-preimport-inventory.json');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-9 imports exactly 100 reviewed starts and records the failed source-bound gate', async () => {
  const [manifest, relationDiff, metrics, stage, plan, verification, canonicalResult, inventoryResult, preImportInventory] = await Promise.all([
    readJson('m5-9-expansion.json'),
    readJson('m5-9-expansion-relation-diff.json'),
    readJson('m5-9-expansion-metrics.json'),
    readJson('m5-8-stage-01-plus-100.json'),
    readJson('m5-8-expansion-plan.json'),
    readJson('m5-9-expansion-verification.json'),
    readCanonicalRecords(HISTORICAL_CANONICAL_DIRECTORY),
    readTargetInventory(PRE_A2_INVENTORY_PATH),
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
    after_count: 13,
    added_count: 13,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -13,
    noise_event_count: 12,
    noise_rate_of_before: 0,
    classification_counts: {
      'broad-common-category': 2,
      'generic-result-or-reaction': 7,
      'arbitrary-modifier-or-place': 3,
    },
    candidate_count: 25,
    admitted_candidate_count: 13,
    rejected_candidate_count: 12,
    noise_denominator_count: 25,
    noise_rate_of_candidates: 12 / 25,
  });

  assert.deepEqual(metrics.derived.selection, {
    selected_start_count: 112,
    processed_start_count: 107,
  });
  assert.deepEqual(metrics.derived.decisions, {
    included: 82,
    corrected: 18,
    held: 4,
    rejected: 3,
    deferred: 5,
    importable_start_count: 100,
    correction_rate_of_selected: 18 / 107,
    correction_rate_of_importable: 18 / 100,
    held_rate: 4 / 107,
    rejected_rate: 3 / 107,
    held_or_rejected_rate: 7 / 107,
    sense_field_correction_count: 18,
    relation_field_correction_count: 0,
  });
  assert.deepEqual(metrics.derived.canonical_import, {
    imported_start_count: 100,
    imported_reference_only_count: 0,
    imported_record_count: 100,
    imported_sense_count: 113,
    imported_relation_count: 13,
    imported_expression_count: 14,
    relation_type_counts: {
      mood: 3,
      near: 5,
      sensory: 4,
      action: 1,
    },
  });
  assert.equal(metrics.derived.timing.status, 'incomplete');
  assert.equal(metrics.derived.timing.total_editor_seconds, null);
  assert.equal(metrics.derived.timing.measured_wall_clock_seconds, 2100);
  assert.equal(metrics.derived.timing.measured_editor_seconds, 1090);
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, [
    'post-review-audit#1',
    'post-review-fixes#1',
    'post-review-audit#2',
    'post-review-fixes#2',
    'post-review-audit#3',
    'post-review-fixes#3',
  ]);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);
  assert.deepEqual(metrics.derived.sense_review, {
    status: 'complete',
    reviewed_start_count: 100,
    scoped_single_sense_count: 87,
    split_record_count: 13,
    split_canonical_ids: [
      'w456',
      'w458',
      'w459',
      'w460',
      'w462',
      'w472',
      'w481',
      'w517',
      'w518',
      'w519',
      'w520',
      'w527',
      'w528',
    ],
  });

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-8-stage-01-plus-100',
    imported_start_count: 100,
    candidate_buffer: 12,
    gate_status: 'fail',
  });
  assert.equal(stage.next_stage_created, true);
  assert.equal(stage.next_stage_authorized, false);
  assert.equal(stage.metrics.timing_status, 'incomplete');
  assert.equal(stage.metrics.total_editor_seconds, null);
  assert.equal(stage.metrics.measured_editor_seconds, 1090);
  assert.equal(stage.metrics.unmeasured_timing_pass_count, 6);

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
    sense_count: 670,
    relation_count: 462,
    expression_count: 37,
  });

  const inventorySummary = await validateTargetInventory({
    inventoryPath: PRE_A2_INVENTORY_PATH,
    canonicalDirectory: BASE_CANONICAL_DIRECTORY,
  });
  assert.equal(inventorySummary.revision, 'm5-10');
  assert.equal(inventorySummary.inventoryEntryCount, 713);
  assert.equal(inventorySummary.currentStartCount, 578);
  assert.equal(inventorySummary.candidateStartCount, 59);
  assert.equal(inventorySummary.plannedStartCount, 637);
  assert.equal(inventorySummary.heldCount, 30);
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
      inputDirectory: BASE_CANONICAL_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(first.recordCount, 620);
      assert.equal(first.metadata.start_count, '578');
      assert.deepEqual(findRecordsByExactTerm(database, '애틋하다').map(({ id }) => id), ['w429']);
      assert.deepEqual(findRecordsByExactTerm(database, '시리다').map(({ id }) => id), ['w459']);
      assert.deepEqual(findRecordsByExactTerm(database, '개울').map(({ id }) => id), ['w475']);
      assert.deepEqual(findRecordsByExactTerm(database, '다가서다').map(({ id }) => id), ['w487']);
      assert.deepEqual(findRecordsByExactTerm(database, '장화').map(({ id }) => id), ['w501']);
      assert.deepEqual(findRecordsByExactTerm(database, '가슴이 뛰다').map(({ id }) => id), ['w515']);
      assert.deepEqual(findRecordsByExactTerm(database, '감탄스럽다').map(({ id }) => id), ['w529']);
      assert.deepEqual(findRecordsByExactTerm(database, '눈길을 주다').map(({ id }) => id), ['w577']);
      assert.deepEqual(findRecordsByExactTerm(database, '손에 잡히다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '격앙되다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '폭신하다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '기어오르다'), []);
      assert.equal(getRecord(database, 'w430').senses[0].relations[0].target, 'w029');
      assert.deepEqual(getRecord(database, 'w447').senses[0].relations, []);
      assert.deepEqual(getRecord(database, 'w501').senses[0].relations, []);
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

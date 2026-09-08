import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeReviewedBatchImport } from '../scripts/batch/import-reviewed-batch.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import { validateBatch } from '../scripts/batch/validate-batch.mjs';
import { validateExpansionStage } from '../scripts/batch/validate-m5-8-process.mjs';
import { validateWaveARelationScreen } from '../scripts/batch/validate-wave-a-relation-screen.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import { validateRelationDiff } from '../scripts/batch/relation-diff.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const CANONICAL_IMPORT_PATH = path.join(DEFAULT_CANONICAL_DIRECTORY, 'm5-10-wave-a.jsonl');
const HISTORICAL_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-9-postimport-canonical');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-10 Wave A reproduces its source-bound +50 gate and import boundary', async () => {
  const [manifest, relationDiff, relationScreen, metrics, stage, plan, canonical] = await Promise.all([
    readJson('m5-10-wave-a.json'),
    readJson('m5-10-wave-a-relation-diff.json'),
    readJson('m5-10-wave-a-relation-screen.json'),
    readJson('m5-10-wave-a-metrics.json'),
    readJson('m5-9a-wave-a-plus-50.json'),
    readJson('m5-8-expansion-plan.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);

  validateRelationDiff(relationDiff);
  assert.deepEqual(
    await validateWaveARelationScreen(),
    {
      artifact_id: relationScreen.artifact_id,
      process_revision: relationScreen.process_revision,
      proposal_count: 8,
      pre_screened_count: 8,
      pre_screen_pass_count: 6,
      pre_screen_rejected_count: 2,
      human_admission_denominator: 6,
      human_admission_reviewed_count: 6,
      human_admitted_count: 6,
      human_rejected_count: 0,
      final_relation_count: 6,
      failure_category_counts: {
        'broad-common-category': 1,
        'generic-result-or-reaction': 1,
      },
      source: {
        screen: 'data/batches/m5-10-wave-a-relation-screen.json',
        screen_sha256: '6b45117076d67363850dad4fc9ef3bf9c2b9d3123caa3911d5089215abbf48d0',
        relation_diff: 'data/batches/m5-10-wave-a-relation-diff.json',
        relation_diff_sha256: 'f245ac56cc7dc0b7968d805a4f63d689134cfc1d8b812c4a6b77ffbaabdf3243',
      },
    },
  );
  assert.equal(stage.source.relation_screen, 'data/batches/m5-10-wave-a-relation-screen.json');
  const regeneratedMetrics = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonical.records,
    source: metrics.source,
  });
  assertMetricsMatch(metrics, regeneratedMetrics);

  assert.deepEqual(metrics.derived.selection, {
    selected_start_count: 58,
    processed_start_count: 56,
  });
  assert.deepEqual(metrics.derived.decisions, {
    included: 44,
    corrected: 6,
    held: 3,
    rejected: 3,
    deferred: 2,
    importable_start_count: 50,
    correction_rate_of_selected: 6 / 56,
    correction_rate_of_importable: 6 / 50,
    held_rate: 3 / 56,
    rejected_rate: 3 / 56,
    held_or_rejected_rate: 6 / 56,
    sense_field_correction_count: 5,
    relation_field_correction_count: 0,
  });
  assert.deepEqual(metrics.derived.relation_diff, {
    before_count: 0,
    after_count: 6,
    added_count: 6,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -6,
    noise_event_count: 2,
    noise_rate_of_before: 0,
    classification_counts: {
      'broad-common-category': 1,
      'generic-result-or-reaction': 1,
    },
    candidate_count: 8,
    admitted_candidate_count: 6,
    rejected_candidate_count: 2,
    noise_denominator_count: 8,
    noise_rate_of_candidates: 0.25,
  });
  assert.equal(metrics.derived.timing.status, 'complete');
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, []);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);
  assert.deepEqual({
    record_count: canonical.records.length,
    start_count: canonical.records.filter(({ record }) => record.role === 'start').length,
    reference_only_count: canonical.records.filter(({ record }) => record.role === 'reference-only').length,
    sense_count: canonical.records.reduce((count, { record }) => count + record.senses.length, 0),
    relation_count: canonical.records.reduce(
      (count, { record }) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: canonical.records.filter(({ record }) => record.record_type === 'expression').length,
  }, {
    record_count: 620,
    start_count: 578,
    reference_only_count: 42,
    sense_count: 725,
    relation_count: 468,
    expression_count: 39,
  });

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-9a-wave-a-plus-50',
    imported_start_count: 50,
    candidate_buffer: 8,
    gate_status: 'fail',
  });
  assert.equal(stage.decision, 'HOLD PROCESS');
  assert.equal(stage.next_stage_authorized, false);
  assert.equal(stage.next_stage_created, false);
  assert.ok(
    metrics.derived.timing.total_editor_seconds
      / metrics.derived.selection.processed_start_count > 12,
    'the recorded Wave A work must explain the failed editor-time gate',
  );

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10-wave-a-'));
  try {
    const stagedRecordsPath = path.join(temporaryDirectory, 'reviewed.jsonl');
    const outputPath = path.join(temporaryDirectory, 'import.jsonl');
    const waveRecords = await readFile(CANONICAL_IMPORT_PATH, 'utf8');
    await writeFile(stagedRecordsPath, waveRecords, 'utf8');

    const summary = await validateBatch({
      manifestPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a.json'),
      stagedRecordsPath,
      inventoryPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a-preimport-inventory.json'),
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
    });
    assert.equal(summary.canonicalRecordCount, 570);
    assert.equal(summary.stagedRecordCount, 50);
    assert.equal(summary.targetCount, 58);
    assert.equal(summary.referenceClosureCount, 0);
    assert.deepEqual(summary.counts, {
      included: 44,
      held: 3,
      rejected: 3,
      corrected: 6,
      deferred: 2,
    });

    const imported = await writeReviewedBatchImport({
      manifestPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a.json'),
      stagedRecordsPath,
      outputPath,
      inventoryPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a-preimport-inventory.json'),
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
    });
    assert.equal(imported.outputRecordCount, 50);
    assert.equal(await readFile(outputPath, 'utf8'), waveRecords);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

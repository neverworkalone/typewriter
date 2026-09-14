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
import { writeSemanticAuditFixture } from './helpers/semantic-audit-fixture.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const CANONICAL_IMPORT_PATH = path.join(DEFAULT_CANONICAL_DIRECTORY, 'm5-10-wave-a.jsonl');
const WAVE_A_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');
const HISTORICAL_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-9-postimport-canonical');
const SENSE_REGRESSION_PATH = path.resolve('tests/fixtures/m5-10-wave-a-sense-regressions.json');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-10 Wave A reproduces its source-bound +50 gate and import boundary', async () => {
  const [manifest, relationDiff, relationScreen, metrics, stage, plan, canonical, senseRegression] = await Promise.all([
    readJson('m5-10-wave-a.json'),
    readJson('m5-10-wave-a-relation-diff.json'),
    readJson('m5-10-wave-a-relation-screen.json'),
    readJson('m5-10-wave-a-metrics.json'),
    readJson('m5-9a-wave-a-plus-50.json'),
    readJson('m5-8-expansion-plan.json'),
    readCanonicalRecords(WAVE_A_CANONICAL_DIRECTORY),
    readFile(SENSE_REGRESSION_PATH, 'utf8').then(JSON.parse),
  ]);

  validateRelationDiff(relationDiff);
  const rejectedRelation = relationDiff.candidate_reviews.find(
    ({ relation_id }) => relation_id === 'm5-10-w535-s2-r1',
  );
  assert.deepEqual(
    {
      decision: rejectedRelation.decision,
      error_category: rejectedRelation.error_category,
    },
    {
      decision: 'reject',
      error_category: 'generic-result-or-reaction',
    },
  );
  assert.equal(
    relationDiff.events.some(({ relation_id }) => relation_id === 'm5-10-w535-s2-r1'),
    false,
  );
  assert.deepEqual(
    await validateWaveARelationScreen(),
    {
      artifact_id: relationScreen.artifact_id,
      process_revision: relationScreen.process_revision,
      proposal_count: 8,
      pre_screened_count: 8,
      pre_screen_pass_count: 5,
      pre_screen_rejected_count: 3,
      human_admission_denominator: 5,
      human_admission_reviewed_count: 5,
      human_admitted_count: 5,
      human_rejected_count: 0,
      final_relation_count: 5,
      failure_category_counts: {
        'broad-common-category': 1,
        'generic-result-or-reaction': 2,
      },
      source: {
        screen: 'data/batches/m5-10-wave-a-relation-screen.json',
        screen_sha256: '31e39c9eaedb276193a1e039a62792a864e51033ec275717f59e8f2072570e52',
        relation_diff: 'data/batches/m5-10-wave-a-relation-diff.json',
        relation_diff_sha256: '55e508094ca3b62863213b582a97fd575aa90a0fc26708cc333a33185f7d64e0',
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
    included: 28,
    corrected: 22,
    held: 3,
    rejected: 3,
    deferred: 2,
    importable_start_count: 50,
    correction_rate_of_selected: 22 / 56,
    correction_rate_of_importable: 22 / 50,
    held_rate: 3 / 56,
    rejected_rate: 3 / 56,
    held_or_rejected_rate: 6 / 56,
    sense_field_correction_count: 21,
    relation_field_correction_count: 1,
  });
  assert.deepEqual(metrics.derived.relation_diff, {
    before_count: 0,
    after_count: 5,
    added_count: 5,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -5,
    noise_event_count: 3,
    noise_rate_of_before: 0,
    classification_counts: {
      'broad-common-category': 1,
      'generic-result-or-reaction': 2,
    },
    candidate_count: 8,
    admitted_candidate_count: 5,
    rejected_candidate_count: 3,
    noise_denominator_count: 8,
    noise_rate_of_candidates: 3 / 8,
  });
  assert.deepEqual(metrics.derived.sense_review, {
    status: 'complete',
    reviewed_start_count: 50,
    scoped_single_sense_count: 29,
    split_record_count: 21,
    split_canonical_ids: senseRegression.sense_cases.map(({ canonical_id }) => canonical_id),
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
    sense_count: 743,
    relation_count: 467,
    expression_count: 39,
  });

  const canonicalById = new Map(canonical.records.map(({ record }) => [record.id, record]));
  assert.equal(senseRegression.canonical_artifact, 'data/canonical/m5-10-wave-a.jsonl');
  for (const senseCase of senseRegression.sense_cases) {
    const record = canonicalById.get(senseCase.canonical_id);
    assert.ok(record, `${senseCase.case_id} must reference a canonical record`);
    assert.equal(record.senses.length, senseCase.expected_sense_count, senseCase.case_id);
    assert.deepEqual(record.senses.map(({ pos }) => pos), senseCase.expected_pos, senseCase.case_id);
    assert.deepEqual(record.senses.map(({ gloss }) => gloss), senseCase.expected_glosses, senseCase.case_id);
  }

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
    const semanticAuditPath = path.join(temporaryDirectory, 'semantic-audit.json');
    const validatedManifestPath = path.join(temporaryDirectory, 'manifest.json');
    const outputPath = path.join(temporaryDirectory, 'import.jsonl');
    const waveRecords = await readFile(CANONICAL_IMPORT_PATH, 'utf8');
    await writeFile(stagedRecordsPath, waveRecords, 'utf8');
    const semanticAudit = await writeSemanticAuditFixture(
      semanticAuditPath,
      canonical.records,
      { artifactId: 'm5-10-wave-a-test-semantic-audit' },
    );
    const validatedManifest = structuredClone(manifest);
    validatedManifest.review.semantic_audit_sha256 = semanticAudit.sha256;
    await writeFile(validatedManifestPath, `${JSON.stringify(validatedManifest, null, 2)}\n`, 'utf8');

    const summary = await validateBatch({
      manifestPath: validatedManifestPath,
      stagedRecordsPath,
      semanticAuditPath,
      inventoryPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a-preimport-inventory.json'),
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
    });
    assert.equal(summary.canonicalRecordCount, 570);
    assert.equal(summary.stagedRecordCount, 50);
    assert.equal(summary.targetCount, 58);
    assert.equal(summary.referenceClosureCount, 0);
    assert.deepEqual(summary.counts, {
      included: 28,
      held: 3,
      rejected: 3,
      corrected: 22,
      deferred: 2,
    });

    const imported = await writeReviewedBatchImport({
      manifestPath: validatedManifestPath,
      stagedRecordsPath,
      semanticAuditPath,
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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFeedbackCycle,
  nextFeedbackCycle,
} from '../scripts/batch/timing.mjs';
import {
  DEFAULT_RELATION_SCREEN_PATH,
  validateRelationScreen,
} from '../scripts/batch/relation-screen.mjs';
import {
  sha256File,
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import { validateM59Repair } from '../scripts/batch/validate-m5-9-repair.mjs';
import { validateBatchManifest } from '../scripts/batch/validate-batch.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('M5-9A validates the failed stage, separated relation screen, and first-50 authorization', async () => {
  const result = await validateM59Repair();

  assert.equal(result.failed_stage.gate_status, 'fail');
  assert.equal(result.failed_stage.decision, 'HOLD PROCESS');
  assert.deepEqual(result.relation_regression, {
    artifact_id: 'm5-9a-relation-screen-20260908',
    process_revision: 'm5-9a-relation-admission-v1',
    proposal_count: 25,
    pre_screened_count: 25,
    pre_screen_pass_count: 13,
    pre_screen_rejected_count: 12,
    human_admission_denominator: 13,
    human_admission_reviewed_count: 13,
    human_admitted_count: 13,
    human_rejected_count: 0,
    final_relation_count: 13,
    failure_category_counts: {
      'arbitrary-modifier-or-place': 3,
      'broad-common-category': 2,
      'generic-result-or-reaction': 7,
    },
  });
  assert.deepEqual(result.canonical_snapshot, {
    record_count: 570,
    start_count: 528,
    reference_only_count: 42,
    sense_count: 670,
    relation_count: 462,
    expression_count: 37,
  });
  assert.deepEqual(result.authorization, {
    target_issue: 96,
    target_wave: 'wave-a-plus-50-validation',
    net_start_increase: 50,
  });
});

test('M5-9A retains all 25 proposals while keeping pre-screen and admission denominators separate', async () => {
  const relationScreen = await readJson(DEFAULT_RELATION_SCREEN_PATH);
  const relationDiff = await readJson('data/batches/m5-9-expansion-relation-diff.json');
  const result = validateRelationScreen(relationScreen, relationDiff);

  assert.equal(result.proposal_count, 25);
  assert.equal(result.pre_screened_count, 25);
  assert.equal(result.pre_screen_rejected_count, 12);
  assert.equal(result.human_admission_denominator, 13);
  assert.equal(result.human_admitted_count, 13);
  assert.equal(result.final_relation_count, 13);
  assert.ok(relationScreen.candidates.every(({ pre_screen }) => pre_screen.method === 'tuple-and-semantic-review'));
  assert.ok(relationScreen.candidates.every(({ pre_screen }) => (
    pre_screen.source_sense_locked && pre_screen.target_sense_locked
  )));
});

test('known M5-9 rejected errors cannot pass the new pre-screen', async () => {
  const relationScreen = await readJson(DEFAULT_RELATION_SCREEN_PATH);
  const relationDiff = await readJson('data/batches/m5-9-expansion-relation-diff.json');
  const tampered = structuredClone(relationScreen);
  const candidate = tampered.candidates.find(({ candidate_id }) => candidate_id.endsWith('0001'));
  candidate.pre_screen.decision = 'pass';
  candidate.pre_screen.semantic_result = 'stable-writer-use';
  delete candidate.pre_screen.error_category;
  candidate.human_admission = {
    status: 'reviewed',
    decision: 'reject',
    error_category: 'generic-result-or-reaction',
    reason: relationDiff.candidate_reviews[0].review_note,
  };

  assert.throws(
    () => validateRelationScreen(tampered, relationDiff),
    (error) => error.code === 'PRESCREEN_FALSE_POSITIVE',
  );
});

test('relation screen rejects raw draft fields at the schema boundary', async () => {
  const relationScreen = await readJson(DEFAULT_RELATION_SCREEN_PATH);
  const relationDiff = await readJson('data/batches/m5-9-expansion-relation-diff.json');
  relationScreen.raw_response = 'not allowed';

  assert.throws(
    () => validateRelationScreen(relationScreen, relationDiff),
    (error) => error.code === 'SCHEMA_ERROR',
  );
});

test('repair authorization is digest-bound and cannot be retargeted to another stage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-9a-auth-'));
  try {
    const authorization = await readJson('data/batches/m5-9a-repair-authorization.json');
    authorization.source.failed_stage_report_sha256 = '0'.repeat(64);
    const authorizationPath = path.join(directory, 'authorization.json');
    await writeFile(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8');

    await assert.rejects(
      validateM59Repair({ authorizationPath }),
      (error) => error.code === 'SOURCE_DIGEST_MISMATCH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed stage cannot enter the next-stage validator without repair authorization', async () => {
  const failedStage = await readJson('data/batches/m5-8-stage-01-plus-100.json');
  const plan = await readJson('data/batches/m5-8-expansion-plan.json');
  const nextStage = structuredClone(failedStage);
  nextStage.stage_id = 'm5-8-stage-02-plus-250';
  nextStage.input = {
    inventory_revision: failedStage.input.inventory_revision,
    canonical_snapshot: structuredClone(failedStage.actual.canonical_snapshot),
    previous_stage_report: {
      path: 'data/batches/m5-8-stage-01-plus-100.json',
      sha256: await sha256File('data/batches/m5-8-stage-01-plus-100.json'),
    },
  };
  nextStage.target = {
    net_start_increase: 250,
    cumulative_start_target: 778,
    candidate_buffer: 12,
    selected_start_count: failedStage.target.selected_start_count,
  };

  await assert.rejects(
    validateExpansionStage(nextStage, plan),
    (error) => error.code === 'MISSING_REPAIR_AUTHORIZATION',
  );
});

test('strict timing derives wall-clock duration, rejects backfill, and generates paired cycles', async () => {
  const manifest = await readJson('data/batches/m5-9-expansion.json');
  const strictManifest = structuredClone(manifest);
  strictManifest.measurement.timing.contract_version = 'm5-9a-v1';
  assert.doesNotThrow(() => validateBatchManifest(strictManifest));

  const durationTampered = structuredClone(strictManifest);
  durationTampered.measurement.timing.passes[0].wall_clock_seconds += 1;
  assert.throws(
    () => validateBatchManifest(durationTampered),
    (error) => error.code === 'TIMING_DURATION_DRIFT',
  );

  const backfilled = structuredClone(strictManifest);
  const unmeasured = backfilled.measurement.timing.passes.find(
    ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
  );
  unmeasured.editor_seconds = 1;
  assert.throws(
    () => validateBatchManifest(backfilled),
    (error) => error.code === 'UNMEASURED_TIMING_VALUE',
  );

  assert.equal(nextFeedbackCycle(manifest), 4);
  const updated = appendFeedbackCycle(manifest, {
    feedbackReceivedAt: '2026-09-08T08:00:00Z',
  });
  assert.equal(updated.measurement.timing.contract_version, 'm5-9a-v1');
  assert.deepEqual(
    updated.measurement.timing.passes.slice(-2).map(({ id, cycle, feedback_received_at, status }) => ({
      id,
      cycle,
      feedback_received_at,
      status,
    })),
    [
      {
        id: 'post-review-audit',
        cycle: 4,
        feedback_received_at: '2026-09-08T08:00:00Z',
        status: 'unmeasured',
      },
      {
        id: 'post-review-fixes',
        cycle: 4,
        feedback_received_at: '2026-09-08T08:00:00Z',
        status: 'unmeasured',
      },
    ],
  );
  assert.equal(manifest.measurement.timing.contract_version, undefined);
});

test('M5-9A repair leaves canonical counts unchanged', async () => {
  const { records } = await readCanonicalRecords();
  assert.equal(records.length, 570);
  assert.equal(records.filter(({ record }) => record.role === 'start').length, 528);
  assert.equal(records.filter(({ record }) => record.role === 'reference-only').length, 42);
});

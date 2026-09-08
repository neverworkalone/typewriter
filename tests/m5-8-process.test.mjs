import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  validateExpansionPlan,
  validateExpansionStage,
  validateM58Process,
  validateReviewCheckpoint,
} from '../scripts/batch/validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const PLAN_PATH = path.resolve('data/batches/m5-8-expansion-plan.json');
const FIXTURE_PATH = path.resolve('tests/fixtures/m5-8-process-regressions.json');
const RELATION_DIFF_PATH = path.resolve('data/batches/m5-7-recalibration-relation-diff.json');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('M5-8 plan fixes the workflow phases, gate, and seven-stage ladder', async () => {
  const plan = await readJson(PLAN_PATH);
  const result = validateExpansionPlan(plan);

  assert.deepEqual(result.phase_order, [
    'target-preparation',
    'sense-review',
    'relation-review',
    'independent-audit',
    'gate-and-promotion',
  ]);
  assert.deepEqual(result.partition, {
    unit: 'selected-start',
    reviewer_checkpoint: 'sense-review-complete-before-relation-review',
    rework_boundaries: [
      'sense-review',
      'relation-review',
      'independent-audit',
      'post-review-fixes',
    ],
  });
  assert.deepEqual(result.stage_report, {
    required_sections: [
      'input',
      'target',
      'decisions',
      'actual',
      'metrics',
      'source',
      'gate',
    ],
    source_artifacts: ['manifest', 'metrics', 'canonical_directory'],
  });
  assert.deepEqual(
    result.ladder.map(({ target_net_start_increase, cumulative_start_target }) => [
      target_net_start_increase,
      cumulative_start_target,
    ]),
    [[100, 528], [250, 778], [500, 1278], [722, 2000], [1000, 3000], [1000, 4000], [1000, 5000]],
  );
  assert.deepEqual(
    {
      correction_rate_max: result.gate.correction_rate_max,
      relation_noise_rate_max: result.gate.relation_noise_rate_max,
      editor_seconds_per_selected_start_max: result.gate.editor_seconds_per_selected_start_max,
      relation_noise_baseline: result.gate.relation_noise_baseline,
      failure_decision: result.gate.failure_decision,
    },
    {
      correction_rate_max: 0.5,
      relation_noise_rate_max: 0.25,
      editor_seconds_per_selected_start_max: 12,
      relation_noise_baseline: { noise_event_count: 51, before_count: 139 },
      failure_decision: 'HOLD PROCESS',
    },
  );
});

test('relation output is blocked until the sense/POS checkpoint is complete', () => {
  assert.throws(
    () => validateReviewCheckpoint({
      sense_status: 'in-review',
      relation_status: 'in-review',
      relation_output_count: 1,
    }),
    (error) => error.code === 'RELATION_BEFORE_SENSE',
  );
  assert.throws(
    () => validateReviewCheckpoint({
      sense_status: 'held',
      relation_status: 'not-started',
      relation_output_count: 1,
    }),
    (error) => error.code === 'RELATION_BEFORE_SENSE',
  );
  assert.deepEqual(
    validateReviewCheckpoint({
      sense_status: 'complete',
      relation_status: 'complete',
      relation_output_count: 0,
    }),
    {
      sense_status: 'complete',
      relation_status: 'complete',
      relation_output_count: 0,
    },
  );
});

test('candidate buffers are excluded from net starts and failed gates stop promotion', async () => {
  const plan = await readJson(PLAN_PATH);
  const validStage = {
    schema_version: '1',
    stage_id: 'm5-8-stage-01-plus-100',
    input: {
      inventory_revision: 'm5-5',
      canonical_snapshot: {
        record_count: 470,
        start_count: 428,
        reference_only_count: 42,
        sense_count: 557,
        relation_count: 449,
        expression_count: 23,
      },
    },
    target: {
      net_start_increase: 100,
      cumulative_start_target: 528,
      candidate_buffer: 12,
      selected_start_count: 112,
    },
    decisions: {
      included_start_count: 100,
      corrected_start_count: 0,
      held_start_count: 8,
      rejected_start_count: 4,
    },
    actual: {
      canonical_snapshot: {
        record_count: 570,
        start_count: 528,
        reference_only_count: 42,
        sense_count: 657,
        relation_count: 449,
        expression_count: 23,
      },
      imported_start_count: 100,
    },
    metrics: {
      correction_rate_of_selected: 0,
      relation_noise_rate_of_before: 0,
      total_wall_clock_seconds: 1200,
      total_editor_seconds: 1000,
      editor_seconds_per_selected_start: 1000 / 112,
      timing_status: 'complete',
      unmeasured_timing_pass_count: 0,
      audit_status: 'complete',
      audit_independent: true,
      open_audit_blocker_count: 0,
      human_editorial_review_complete: true,
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
    },
    source: {
      manifest: '/tmp/m5-8-stage-01-manifest.json',
      metrics: '/tmp/m5-8-stage-01-metrics.json',
      canonical_directory: '/tmp/m5-8-stage-01-canonical',
    },
    gate_status: 'pass',
    decision: 'APPROVE BOUNDED',
    next_stage_created: false,
  };

  assert.deepEqual(validateExpansionStage(validStage, plan), {
    stage_id: 'm5-8-stage-01-plus-100',
    imported_start_count: 100,
    candidate_buffer: 12,
    gate_status: 'pass',
  });
  assert.throws(
    () => validateExpansionStage({
      ...validStage,
      actual: { ...validStage.actual, imported_start_count: 112 },
    }, plan),
    (error) => error.code === 'ACTUAL_IMPORT_MISMATCH',
  );
  assert.throws(
    () => validateExpansionStage({
      ...validStage,
      metrics: { ...validStage.metrics, relation_noise_rate_of_before: 0.3 },
    }, plan),
    (error) => error.code === 'GATE_STATUS_MISMATCH',
  );
  assert.throws(
    () => validateExpansionStage({
      ...validStage,
      actual: {
        ...validStage.actual,
        canonical_snapshot: { ...validStage.actual.canonical_snapshot, start_count: 527 },
      },
    }, plan),
    (error) => error.code === 'CANONICAL_START_MISMATCH',
  );
  assert.throws(
    () => validateExpansionStage({
      ...validStage,
      input: {
        ...validStage.input,
        canonical_snapshot: { ...validStage.input.canonical_snapshot, start_count: 427 },
      },
    }, plan),
    (error) => error.code === 'BASE_START_MISMATCH',
  );
  assert.throws(
    () => validateExpansionStage({
      ...validStage,
      metrics: { ...validStage.metrics, relation_noise_rate_of_before: 0.3 },
      gate_status: 'fail',
      decision: 'HOLD PROCESS',
      next_stage_created: true,
    }, plan),
    (error) => error.code === 'NEXT_STAGE_AFTER_FAILURE',
  );
});

test('M5-7 sense/POS and relation failures are regressions with no canonical count change', async () => {
  const [plan, fixture, relationDiff, canonical] = await Promise.all([
    readJson(PLAN_PATH),
    readJson(FIXTURE_PATH),
    readJson(RELATION_DIFF_PATH),
    readCanonicalRecords(),
  ]);

  const result = validateM58Process({
    plan,
    fixture,
    canonicalRecordInfos: canonical.records,
    relationDiff,
  });

  assert.equal(result.regressions.sense_case_count, 5);
  assert.equal(result.regressions.relation_case_count, 3);
  assert.equal(canonical.records.length, 470);
  assert.equal(
    canonical.records.filter(({ record }) => record.role === 'start').length,
    428,
  );
  assert.equal(
    canonical.records.filter(({ record }) => record.role === 'reference-only').length,
    42,
  );

  const missingRegression = structuredClone(fixture);
  missingRegression.relation_cases.pop();
  assert.throws(
    () => validateM58Process({
      plan,
      fixture: missingRegression,
      canonicalRecordInfos: canonical.records,
      relationDiff,
    }),
    (error) => error.code === 'RELATION_FIXTURE_COVERAGE',
  );

  const changedSenseExpectation = structuredClone(fixture);
  changedSenseExpectation.sense_cases[0].expected_sense_count = 1;
  assert.throws(
    () => validateM58Process({
      plan,
      fixture: changedSenseExpectation,
      canonicalRecordInfos: canonical.records,
      relationDiff,
    }),
    (error) => error.code === 'SENSE_REGRESSION',
  );
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SOURCE_ARTIFACT_VALIDATION_VERSION,
  hashCanonicalDirectory,
  loadExpansionStageSources,
  sha256File,
  validateExpansionPlan,
  validateExpansionStage,
  validateM58Process,
  validateReviewCheckpoint,
} from '../scripts/batch/validate-m5-8-process.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

const PLAN_PATH = path.resolve('data/batches/m5-8-expansion-plan.json');
const FIXTURE_PATH = path.resolve('tests/fixtures/m5-8-process-regressions.json');
const RELATION_DIFF_PATH = path.resolve('data/batches/m5-7-recalibration-relation-diff.json');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

const BASELINE_SNAPSHOT = {
  record_count: 470,
  start_count: 428,
  reference_only_count: 42,
  sense_count: 557,
  relation_count: 449,
  expression_count: 23,
};

const ACTUAL_SNAPSHOT = {
  record_count: 570,
  start_count: 528,
  reference_only_count: 42,
  sense_count: 657,
  relation_count: 449,
  expression_count: 23,
};

function makeValidStage({
  included = 95,
  corrected = 5,
  held = 4,
  rejected = 3,
  deferred = 12 - held - rejected,
  nextStageCreated = false,
} = {}) {
  const selectedStartCount = 112;
  return {
    schema_version: '1',
    stage_id: 'm5-8-stage-01-plus-100',
    input: {
      inventory_revision: 'm5-5',
      canonical_snapshot: structuredClone(BASELINE_SNAPSHOT),
    },
    target: {
      net_start_increase: 100,
      cumulative_start_target: 528,
      candidate_buffer: 12,
      selected_start_count: selectedStartCount,
    },
    decisions: {
      included_start_count: included,
      corrected_start_count: corrected,
      held_start_count: held,
      rejected_start_count: rejected,
      deferred_start_count: deferred,
    },
    buffer: {
      available_count: 12,
      used_count: held + rejected,
      unused_count: deferred,
    },
    actual: {
      canonical_snapshot: structuredClone(ACTUAL_SNAPSHOT),
      imported_start_count: included + corrected,
    },
    metrics: {
      correction_rate_of_selected: corrected / selectedStartCount,
      relation_noise_rate_of_before: 0,
      total_wall_clock_seconds: 1200,
      measured_wall_clock_seconds: 1200,
      total_editor_seconds: 1000,
      measured_editor_seconds: 1000,
      editor_seconds_per_selected_start: 1000 / selectedStartCount,
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
      manifest_sha256: 'a'.repeat(64),
      metrics: '/tmp/m5-8-stage-01-metrics.json',
      metrics_sha256: 'b'.repeat(64),
      relation_diff: '/tmp/m5-8-stage-01-relation-diff.json',
      relation_diff_sha256: 'c'.repeat(64),
      canonical_directory: '/tmp/m5-8-stage-01-canonical',
      canonical_sha256: 'd'.repeat(64),
      verification: '/tmp/m5-8-stage-01-verification.json',
      verification_sha256: 'e'.repeat(64),
    },
    gate_status: 'pass',
    decision: 'APPROVE BOUNDED',
    next_stage_created: nextStageCreated,
  };
}

function sourceArtifactsFor(stage) {
  return {
    validation: SOURCE_ARTIFACT_VALIDATION_VERSION,
    paths: {
      manifest: path.resolve(stage.source.manifest),
      metrics: path.resolve(stage.source.metrics),
      relation_diff: path.resolve(stage.source.relation_diff),
      canonical_directory: path.resolve(stage.source.canonical_directory),
      verification: path.resolve(stage.source.verification),
    },
    digests: {
      manifest_sha256: stage.source.manifest_sha256,
      metrics_sha256: stage.source.metrics_sha256,
      relation_diff_sha256: stage.source.relation_diff_sha256,
      canonical_sha256: stage.source.canonical_sha256,
      verification_sha256: stage.source.verification_sha256,
    },
    inventory_revision: stage.input.inventory_revision,
    selected_start_count: stage.target.selected_start_count,
    decisions: structuredClone(stage.decisions),
    imported_start_count: stage.actual.imported_start_count,
    canonical_snapshot: structuredClone(stage.actual.canonical_snapshot),
    metrics: structuredClone(stage.metrics),
  };
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
      'buffer',
      'actual',
      'metrics',
      'source',
      'gate',
    ],
    source_artifacts: ['manifest', 'metrics', 'relation_diff', 'canonical_directory', 'verification'],
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

test('candidate buffers are maximum reserve pools and failed gates stop promotion', async () => {
  const plan = await readJson(PLAN_PATH);
  const underusedBufferStage = makeValidStage();
  assert.deepEqual(await validateExpansionStage(
    underusedBufferStage,
    plan,
    sourceArtifactsFor(underusedBufferStage),
  ), {
    stage_id: 'm5-8-stage-01-plus-100',
    imported_start_count: 100,
    candidate_buffer: 12,
    gate_status: 'pass',
  });
  assert.equal(underusedBufferStage.decisions.held_start_count + underusedBufferStage.decisions.rejected_start_count, 7);
  assert.equal(underusedBufferStage.decisions.deferred_start_count, 5);
  assert.equal(underusedBufferStage.actual.imported_start_count, 100);

  const fullyUsedBufferStage = makeValidStage({ held: 12, rejected: 0 });
  assert.deepEqual(await validateExpansionStage(
    fullyUsedBufferStage,
    plan,
    sourceArtifactsFor(fullyUsedBufferStage),
  ), {
    stage_id: 'm5-8-stage-01-plus-100',
    imported_start_count: 100,
    candidate_buffer: 12,
    gate_status: 'pass',
  });
  assert.equal(fullyUsedBufferStage.decisions.deferred_start_count, 0);

  const insufficientBufferStage = makeValidStage({ held: 13, rejected: 0, deferred: 0 });
  await assert.rejects(
    validateExpansionStage(insufficientBufferStage, plan, sourceArtifactsFor(insufficientBufferStage)),
    (error) => error.code === 'BUFFER_EXHAUSTED',
  );

  const importedCountTampered = {
    ...underusedBufferStage,
    actual: { ...underusedBufferStage.actual, imported_start_count: 112 },
  };
  await assert.rejects(
    validateExpansionStage(importedCountTampered, plan, sourceArtifactsFor(importedCountTampered)),
    (error) => error.code === 'ACTUAL_IMPORT_MISMATCH',
  );
  await assert.rejects(
    validateExpansionStage({
      ...underusedBufferStage,
      metrics: { ...underusedBufferStage.metrics, relation_noise_rate_of_before: 0.3 },
    }, plan, sourceArtifactsFor(underusedBufferStage)),
    (error) => error.code === 'SOURCE_METRIC_DRIFT',
  );
  await assert.rejects(
    validateExpansionStage({
      ...underusedBufferStage,
      actual: {
        ...underusedBufferStage.actual,
        canonical_snapshot: { ...underusedBufferStage.actual.canonical_snapshot, start_count: 527 },
      },
    }, plan, sourceArtifactsFor(underusedBufferStage)),
    (error) => error.code === 'SOURCE_CANONICAL_SNAPSHOT_DRIFT',
  );
  const baseTampered = {
    ...underusedBufferStage,
    input: {
      ...underusedBufferStage.input,
      canonical_snapshot: { ...underusedBufferStage.input.canonical_snapshot, start_count: 427 },
    },
  };
  await assert.rejects(
    validateExpansionStage(baseTampered, plan, sourceArtifactsFor(baseTampered)),
    (error) => error.code === 'BASE_START_MISMATCH',
  );
  const failedStage = {
    ...underusedBufferStage,
    metrics: { ...underusedBufferStage.metrics, relation_noise_rate_of_before: 0.3 },
    gate_status: 'fail',
    decision: 'HOLD PROCESS',
    next_stage_created: true,
  };
  await assert.rejects(
    validateExpansionStage(failedStage, plan, sourceArtifactsFor(failedStage)),
    (error) => error.code === 'NEXT_STAGE_AFTER_FAILURE',
  );
  await assert.rejects(
    validateExpansionStage({
      ...underusedBufferStage,
      source: {
        ...underusedBufferStage.source,
        metrics: '/tmp/m5-8-stage-01-missing-metrics.json',
      },
    }, plan),
    (error) => error.code === 'MISSING_SOURCE_ARTIFACT',
  );

  const followUpWithoutPrevious = makeValidStage();
  followUpWithoutPrevious.stage_id = 'm5-8-stage-02-plus-250';
  followUpWithoutPrevious.input.canonical_snapshot = structuredClone(ACTUAL_SNAPSHOT);
  followUpWithoutPrevious.target = {
    net_start_increase: 250,
    cumulative_start_target: 778,
    candidate_buffer: 12,
    selected_start_count: 262,
  };
  await assert.rejects(
    validateExpansionStage(
      followUpWithoutPrevious,
      plan,
      sourceArtifactsFor(followUpWithoutPrevious),
    ),
    (error) => error.code === 'MISSING_PREVIOUS_STAGE',
  );
});

test('stage source loading binds metrics and verification to real artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-8-stage-'));
  try {
    const manifestPath = path.resolve('data/batches/m5-7-recalibration.json');
    const metricsPath = path.resolve('data/batches/m5-7-recalibration-metrics.json');
    const relationDiffPath = RELATION_DIFF_PATH;
    const verificationPath = path.join(directory, 'verification.json');
    await writeFile(verificationPath, `${JSON.stringify({
      schema_version: '1',
      human_editorial_review_complete: true,
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
    }, null, 2)}\n`, 'utf8');

    const stage = makeValidStage();
    stage.source = {
      manifest: manifestPath,
      manifest_sha256: await sha256File(manifestPath),
      metrics: metricsPath,
      metrics_sha256: await sha256File(metricsPath),
      relation_diff: relationDiffPath,
      relation_diff_sha256: await sha256File(relationDiffPath),
      canonical_directory: DEFAULT_CANONICAL_DIRECTORY,
      canonical_sha256: await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY),
      verification: verificationPath,
      verification_sha256: await sha256File(verificationPath),
    };

    const loaded = await loadExpansionStageSources(stage);
    assert.equal(loaded.validation, SOURCE_ARTIFACT_VALIDATION_VERSION);
    assert.equal(loaded.inventory_revision, 'm5-4');
    assert.equal(loaded.selected_start_count, 40);
    assert.deepEqual(loaded.decisions, {
      included_start_count: 23,
      corrected_start_count: 15,
      held_start_count: 1,
      rejected_start_count: 1,
      deferred_start_count: 0,
    });
    assert.equal(loaded.imported_start_count, 38);
    assert.deepEqual(loaded.canonical_snapshot, BASELINE_SNAPSHOT);

    const tamperedMetrics = await readJson(metricsPath);
    tamperedMetrics.derived.decisions.included += 1;
    const tamperedMetricsPath = path.join(directory, 'tampered-metrics.json');
    await writeFile(tamperedMetricsPath, `${JSON.stringify(tamperedMetrics, null, 2)}\n`, 'utf8');
    const tamperedStage = {
      ...stage,
      source: {
        ...stage.source,
        metrics: tamperedMetricsPath,
        metrics_sha256: await sha256File(tamperedMetricsPath),
      },
    };
    await assert.rejects(
      loadExpansionStageSources(tamperedStage),
      (error) => error.code === 'METRICS_DRIFT',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('follow-up stages require a digest-bound previous passed report', async () => {
  const plan = await readJson(PLAN_PATH);
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-8-chain-'));
  try {
    const previousStage = makeValidStage({ nextStageCreated: true });
    const previousPath = path.join(directory, 'stage-01.json');
    await writeFile(previousPath, `${JSON.stringify(previousStage, null, 2)}\n`, 'utf8');

    const followUpStage = makeValidStage();
    followUpStage.stage_id = 'm5-8-stage-02-plus-250';
    followUpStage.input.canonical_snapshot = {
      ...ACTUAL_SNAPSHOT,
      record_count: ACTUAL_SNAPSHOT.record_count + 1,
    };
    followUpStage.input.previous_stage_report = {
      path: previousPath,
      sha256: await sha256File(previousPath),
    };
    followUpStage.target = {
      net_start_increase: 250,
      cumulative_start_target: 778,
      candidate_buffer: 12,
      selected_start_count: 262,
    };

    await assert.rejects(
      validateExpansionStage(followUpStage, plan, sourceArtifactsFor(followUpStage)),
      (error) => error.code === 'STAGE_CHAIN_INPUT_MISMATCH',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

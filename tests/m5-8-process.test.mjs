import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hashCanonicalDirectory,
  loadExpansionStageSources,
  sha256File,
  validateExpansionPlan,
  validateExpansionStage,
  validateM58Process,
  validateReviewCheckpoint,
} from '../scripts/batch/validate-m5-8-process.mjs';
import { createMetricsArtifact } from '../scripts/batch/derive-metrics.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

const PLAN_PATH = path.resolve('data/batches/m5-8-expansion-plan.json');
const FIXTURE_PATH = path.resolve('tests/fixtures/m5-8-process-regressions.json');
const RELATION_DIFF_PATH = path.resolve('data/batches/m5-7-recalibration-relation-diff.json');
let fixtureSequence = 0;

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

const CURRENT_CANONICAL_SNAPSHOT = {
  record_count: 570,
  start_count: 528,
  reference_only_count: 42,
  sense_count: 670,
  relation_count: 462,
  expression_count: 37,
};

function isM58BaselineRecord({ record }) {
  return record.role === 'reference-only'
    || (record.id.startsWith('w') && Number(record.id.slice(1)) <= 428);
}

function makeValidStage({
  included = 95,
  corrected = 5,
  held = 4,
  rejected = 3,
  deferred = 12 - held - rejected,
  nextStageCreated = false,
  nextStageAuthorized = false,
} = {}) {
  const selectedStartCount = 112;
  const processedStartCount = selectedStartCount - deferred;
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
      correction_rate_of_selected: corrected / processedStartCount,
      relation_noise_rate_of_before: 0,
      total_wall_clock_seconds: 1200,
      measured_wall_clock_seconds: 1200,
      total_editor_seconds: 1000,
      measured_editor_seconds: 1000,
      editor_seconds_per_selected_start: 1000 / processedStartCount,
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
    next_stage_authorized: nextStageAuthorized,
  };
}

async function createRelationDiffFixture() {
  const batchId = `m5-8-process-test-${process.pid}`;
  const relationDiffPath = path.resolve(
    'data/batches',
    `m5-8-process-test-${process.pid}-${fixtureSequence += 1}.json`,
  );
  const relationDiff = {
    schema_version: '1',
    batch_id: batchId,
    before_count: 0,
    after_count: 0,
    events: [],
    source_note: 'Self-authored temporary relation diff for M5-8 validation tests.',
  };
  await writeFile(relationDiffPath, `${JSON.stringify(relationDiff, null, 2)}\n`, 'utf8');
  return { batchId, relationDiff, relationDiffPath };
}

function syntheticCanonicalRecord(id) {
  return {
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma: `테스트${id}`,
    search_forms: [`테스트${id}`],
    senses: [{
      id: `${id}-s1`,
      pos: 'noun',
      gloss: 'M5-8 source-bound validation fixture record',
    }],
  };
}

async function createStageFixture({
  relationDiff,
  relationDiffPath,
  included = 95,
  corrected = 5,
  held = 4,
  rejected = 3,
  deferred = 12 - held - rejected,
  verificationOverrides = {},
  nextStageCreated = false,
  nextStageAuthorized = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-8-stage-fixture-'));
  try {
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory, { recursive: true });
    const baseCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    const baselineRecords = baseCanonical.records.filter(isM58BaselineRecord);
    const approvedCount = included + corrected;
    const syntheticIds = Array.from({ length: approvedCount }, (_, index) => (
      `w${String(1000 + index).padStart(3, '0')}`
    ));
    const canonicalRecords = [
      ...baselineRecords.map(({ record }) => record),
      ...syntheticIds.map((id) => syntheticCanonicalRecord(id)),
    ];
    await writeFile(
      path.join(canonicalDirectory, 'fixture.jsonl'),
      `${canonicalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const canonicalResult = await readCanonicalRecords(canonicalDirectory);

    const selectedStartCount = included + corrected + held + rejected + deferred;
    const records = Array.from({ length: selectedStartCount }, (_, index) => {
      let decision;
      if (index < included) {
        decision = 'included';
      } else if (index < included + corrected) {
        decision = 'corrected';
      } else if (index < included + corrected + held) {
        decision = 'held';
      } else if (index < included + corrected + held + rejected) {
        decision = 'rejected';
      } else {
        decision = 'deferred';
      }
      const record = {
        source: 'inventory',
        inventory_id: `m5-8-fixture-${String(index + 1).padStart(3, '0')}`,
        role: 'start',
        decision,
        decision_note: 'Self-authored source-bound validation fixture decision.',
      };
      if (decision === 'included' || decision === 'corrected') {
        record.canonical_id = syntheticIds[index];
      }
      if (decision === 'corrected') record.corrected_fields = ['senses'];
      return record;
    });
    const manifest = {
      schema_version: '1',
      batch_id: relationDiff.batch_id,
      inventory_id: 'm5-core-5k',
      inventory_revision: 'm5-5',
      generator: {
        model_id: 'human-editorial-expansion',
        tool_version: 'typewriter-m5-8-test-fixture-1',
        prompt_version: 'm5-8-test-fixture-v1',
      },
      generated_at: '2026-09-08T00:00:00Z',
      review: {
        status: 'complete',
        reviewer: 'typewriter-m5-8-test-fixture',
        completed_at: '2026-09-08T00:05:00Z',
      },
      measurement: {
        schema_version: '1',
        relation_diff: {
          artifact: `data/batches/${path.basename(relationDiffPath)}`,
          sha256: await sha256File(relationDiffPath),
        },
        timing: {
          status: 'complete',
          passes: [
            'target-preparation',
            'initial-review',
            'feedback-fixes',
            'final-audit',
            'held-rejected',
          ].map((id) => ({
            id,
            status: 'complete',
            started_at: '2026-09-08T00:00:00Z',
            completed_at: '2026-09-08T00:01:00Z',
            wall_clock_seconds: 240,
            editor_seconds: 200,
          })),
        },
        audit: {
          status: 'complete',
          independent: true,
          findings: [],
        },
      },
      records,
    };
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const metrics = createMetricsArtifact({
      manifest,
      relationDiff,
      canonicalRecords: canonicalResult.records,
      source: {
        manifest: manifestPath,
        relation_diff: relationDiffPath,
        canonical_directory: canonicalDirectory,
      },
    });
    const metricsPath = path.join(directory, 'metrics.json');
    await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');

    const verification = {
      schema_version: '1',
      human_editorial_review_complete: true,
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
      ...verificationOverrides,
    };
    const verificationPath = path.join(directory, 'verification.json');
    await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');

    const processedStartCount = included + corrected + held + rejected;
    const actualSnapshot = {
      record_count: BASELINE_SNAPSHOT.record_count + approvedCount,
      start_count: BASELINE_SNAPSHOT.start_count + approvedCount,
      reference_only_count: BASELINE_SNAPSHOT.reference_only_count,
      sense_count: BASELINE_SNAPSHOT.sense_count + approvedCount,
      relation_count: BASELINE_SNAPSHOT.relation_count,
      expression_count: BASELINE_SNAPSHOT.expression_count,
    };
    const correctionRate = corrected / processedStartCount;
    const editorSeconds = metrics.derived.timing.total_editor_seconds;
    const editorSecondsPerSelectedStart = editorSeconds / processedStartCount;
    const gatePass = correctionRate <= 0.5
      && editorSecondsPerSelectedStart <= 12
      && Object.values(verification).every((value) => value === true || value === '1');
    const stage = {
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
        canonical_snapshot: actualSnapshot,
        imported_start_count: approvedCount,
      },
      metrics: {
        correction_rate_of_selected: correctionRate,
        relation_noise_rate_of_before: metrics.derived.relation_diff.noise_rate_of_before,
        total_wall_clock_seconds: metrics.derived.timing.total_wall_clock_seconds,
        measured_wall_clock_seconds: metrics.derived.timing.measured_wall_clock_seconds,
        total_editor_seconds: editorSeconds,
        measured_editor_seconds: metrics.derived.timing.measured_editor_seconds,
        editor_seconds_per_selected_start: editorSecondsPerSelectedStart,
        timing_status: metrics.derived.timing.status,
        unmeasured_timing_pass_count: metrics.derived.timing.unmeasured_passes.length,
        audit_status: metrics.derived.audit.status,
        audit_independent: metrics.derived.audit.independent,
        open_audit_blocker_count: metrics.derived.audit.open_blocker_count,
        human_editorial_review_complete: verification.human_editorial_review_complete,
        canonical_integrity: verification.canonical_integrity,
        deterministic_sqlite: verification.deterministic_sqlite,
        search_product_regression: verification.search_product_regression,
      },
      source: {
        manifest: manifestPath,
        manifest_sha256: await sha256File(manifestPath),
        metrics: metricsPath,
        metrics_sha256: await sha256File(metricsPath),
        relation_diff: relationDiffPath,
        relation_diff_sha256: await sha256File(relationDiffPath),
        canonical_directory: canonicalDirectory,
        canonical_sha256: await hashCanonicalDirectory(canonicalDirectory),
        verification: verificationPath,
        verification_sha256: await sha256File(verificationPath),
      },
      gate_status: gatePass ? 'pass' : 'fail',
      decision: gatePass ? 'APPROVE BOUNDED' : 'HOLD PROCESS',
      next_stage_created: nextStageCreated,
      next_stage_authorized: nextStageAuthorized,
    };
    return { directory, stage };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
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
  const relationFixture = await createRelationDiffFixture();
  const fixtureDirectories = [];
  try {
    const underusedBufferFixture = await createStageFixture(relationFixture);
    fixtureDirectories.push(underusedBufferFixture.directory);
    const underusedBufferStage = underusedBufferFixture.stage;
    assert.deepEqual(await validateExpansionStage(underusedBufferStage, plan), {
      stage_id: 'm5-8-stage-01-plus-100',
      imported_start_count: 100,
      candidate_buffer: 12,
      gate_status: 'pass',
    });
    assert.equal(underusedBufferStage.decisions.held_start_count + underusedBufferStage.decisions.rejected_start_count, 7);
    assert.equal(underusedBufferStage.decisions.deferred_start_count, 5);
    assert.equal(underusedBufferStage.actual.imported_start_count, 100);

    const fullyUsedBufferFixture = await createStageFixture({
      ...relationFixture,
      held: 12,
      rejected: 0,
    });
    fixtureDirectories.push(fullyUsedBufferFixture.directory);
    const fullyUsedBufferStage = fullyUsedBufferFixture.stage;
    assert.deepEqual(await validateExpansionStage(fullyUsedBufferStage, plan), {
      stage_id: 'm5-8-stage-01-plus-100',
      imported_start_count: 100,
      candidate_buffer: 12,
      gate_status: 'pass',
    });
    assert.equal(fullyUsedBufferStage.decisions.deferred_start_count, 0);

    const insufficientBufferFixture = await createStageFixture({
      ...relationFixture,
      held: 13,
      rejected: 0,
      deferred: 0,
    });
    fixtureDirectories.push(insufficientBufferFixture.directory);
    await assert.rejects(
      validateExpansionStage(insufficientBufferFixture.stage, plan),
      (error) => error.code === 'BUFFER_SELECTION_MISMATCH',
    );

    const importedCountTampered = structuredClone(underusedBufferStage);
    importedCountTampered.actual.imported_start_count = 112;
    await assert.rejects(
      validateExpansionStage(importedCountTampered, plan),
      (error) => error.code === 'SOURCE_IMPORT_DRIFT',
    );
    const metricsTampered = structuredClone(underusedBufferStage);
    metricsTampered.metrics.relation_noise_rate_of_before = 0.3;
    await assert.rejects(
      validateExpansionStage(metricsTampered, plan),
      (error) => error.code === 'SOURCE_METRIC_DRIFT',
    );
    const canonicalTampered = structuredClone(underusedBufferStage);
    canonicalTampered.actual.canonical_snapshot.start_count = 527;
    await assert.rejects(
      validateExpansionStage(canonicalTampered, plan),
      (error) => error.code === 'SOURCE_CANONICAL_SNAPSHOT_DRIFT',
    );
    const baseTampered = structuredClone(underusedBufferStage);
    baseTampered.input.canonical_snapshot.start_count = 427;
    await assert.rejects(
      validateExpansionStage(baseTampered, plan),
      (error) => error.code === 'BASE_START_MISMATCH',
    );

    const failedFixture = await createStageFixture({
      ...relationFixture,
      verificationOverrides: { search_product_regression: false },
      nextStageCreated: true,
    });
    fixtureDirectories.push(failedFixture.directory);
    assert.deepEqual(await validateExpansionStage(failedFixture.stage, plan), {
      stage_id: 'm5-8-stage-01-plus-100',
      imported_start_count: 100,
      candidate_buffer: 12,
      gate_status: 'fail',
    });
    await assert.rejects(
      validateExpansionStage({
        ...failedFixture.stage,
        next_stage_authorized: true,
      }, plan),
      (error) => error.code === 'NEXT_STAGE_AFTER_FAILURE',
    );
    await assert.rejects(
      validateExpansionStage({
        ...makeValidStage(),
        source: {
          ...makeValidStage().source,
          metrics: '/tmp/m5-8-stage-01-missing-metrics.json',
        },
      }, plan),
      (error) => error.code === 'MISSING_SOURCE_ARTIFACT',
    );

    const followUpWithoutPrevious = structuredClone(underusedBufferStage);
    followUpWithoutPrevious.stage_id = 'm5-8-stage-02-plus-250';
    followUpWithoutPrevious.target = {
      net_start_increase: 250,
      cumulative_start_target: 778,
      candidate_buffer: 12,
      selected_start_count: 112,
    };
    await assert.rejects(
      validateExpansionStage(followUpWithoutPrevious, plan),
      (error) => error.code === 'MISSING_PREVIOUS_STAGE',
    );
  } finally {
    await Promise.all(fixtureDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    await rm(relationFixture.relationDiffPath, { force: true });
  }
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
    stage.actual.canonical_snapshot = structuredClone(CURRENT_CANONICAL_SNAPSHOT);
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
    assert.deepEqual(loaded.canonical_snapshot, CURRENT_CANONICAL_SNAPSHOT);

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
  const relationFixture = await createRelationDiffFixture();
  const fixtureDirectories = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-8-chain-'));
  try {
    const currentFixture = await createStageFixture(relationFixture);
    fixtureDirectories.push(currentFixture.directory);
    const previousStage = structuredClone(currentFixture.stage);
    previousStage.next_stage_created = true;
    previousStage.next_stage_authorized = true;
    const previousPath = path.join(directory, 'stage-01.json');
    await writeFile(previousPath, `${JSON.stringify(previousStage, null, 2)}\n`, 'utf8');

    const followUpStage = structuredClone(currentFixture.stage);
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
      selected_start_count: 112,
    };

    await assert.rejects(
      validateExpansionStage(followUpStage, plan),
      (error) => error.code === 'STAGE_CHAIN_INPUT_MISMATCH',
    );
  } finally {
    await Promise.all(fixtureDirectories.map((fixtureDirectory) => rm(fixtureDirectory, { recursive: true, force: true })));
    await rm(directory, { recursive: true, force: true });
    await rm(relationFixture.relationDiffPath, { force: true });
  }
});

test('M5-7 sense/POS and relation failures are regressions with no canonical count change', async () => {
  const [plan, fixture, relationDiff, canonicalResult] = await Promise.all([
    readJson(PLAN_PATH),
    readJson(FIXTURE_PATH),
    readJson(RELATION_DIFF_PATH),
    readCanonicalRecords(),
  ]);
  const canonical = {
    ...canonicalResult,
    records: canonicalResult.records.filter(isM58BaselineRecord),
  };

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

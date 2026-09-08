import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFeedbackCycle,
  main as timingMain,
  nextFeedbackCycle,
  startTimingPass,
  stopTimingPass,
} from '../scripts/batch/timing.mjs';
import {
  DEFAULT_RELATION_SCREEN_PATH,
  validateRelationScreen,
} from '../scripts/batch/relation-screen.mjs';
import {
  hashCanonicalDirectory,
  sha256File,
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import { createMetricsArtifact } from '../scripts/batch/derive-metrics.mjs';
import { validateM59Repair } from '../scripts/batch/validate-m5-9-repair.mjs';
import { validateBatchManifest } from '../scripts/batch/validate-batch.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

let repairWaveFixtureSequence = 0;
const HISTORICAL_CANONICAL_DIRECTORY = path.resolve('data/batches/m5-9-postimport-canonical');

function syntheticWaveRecord(id, index) {
  const lemma = `검증어${index + 1}`;
  return {
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma,
    search_forms: [lemma],
    senses: [{
      id: `${id}-s1`,
      pos: 'noun',
      gloss: 'Self-authored repair-wave validation fixture record.',
    }],
  };
}

async function createRepairWaveStageFixture() {
  const sequence = repairWaveFixtureSequence += 1;
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-9a-wave-'));
  const relationDiffPath = path.resolve(
    'data/batches',
    `m5-9a-wave-a-test-${process.pid}-${sequence}.json`,
  );
  try {
    const baseCanonical = await readCanonicalRecords(HISTORICAL_CANONICAL_DIRECTORY);
    const syntheticRecords = Array.from({ length: 50 }, (_, index) => (
      syntheticWaveRecord(`w${String(9001 + index)}`, index)
    ));
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory, { recursive: true });
    await writeFile(
      path.join(canonicalDirectory, 'wave-a.jsonl'),
      [
        ...baseCanonical.records.map(({ record }) => record),
        ...syntheticRecords,
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
    const canonical = await readCanonicalRecords(canonicalDirectory);

    const batchId = `m5-10-wave-a-test-${process.pid}-${sequence}`;
    const relationDiff = {
      schema_version: '1',
      batch_id: batchId,
      before_count: 0,
      after_count: 0,
      events: [],
      source_note: 'Self-authored repair-wave validation fixture relation diff.',
    };
    await writeFile(relationDiffPath, `${JSON.stringify(relationDiff, null, 2)}\n`, 'utf8');

    const manifest = {
      schema_version: '1',
      batch_id: batchId,
      inventory_id: 'm5-core-5k',
      inventory_revision: 'm5-5',
      generator: {
        model_id: 'human-editorial-expansion',
        tool_version: 'typewriter-m5-9a-wave-test-1',
        prompt_version: 'm5-9a-wave-test-v1',
      },
      generated_at: '2026-09-08T10:00:00Z',
      review: {
        status: 'complete',
        reviewer: 'typewriter-m5-9a-wave-test',
        completed_at: '2026-09-08T11:00:00Z',
      },
      measurement: {
        schema_version: '1',
        relation_diff: {
          artifact: `data/batches/${path.basename(relationDiffPath)}`,
          sha256: await sha256File(relationDiffPath),
        },
        timing: {
          contract_version: 'm5-9a-v1',
          status: 'complete',
          passes: [
            'target-preparation',
            'initial-review',
            'feedback-fixes',
            'final-audit',
            'held-rejected',
          ].map((id, index) => ({
            id,
            status: 'complete',
            started_at: `2026-09-08T10:0${index}:00Z`,
            completed_at: `2026-09-08T10:0${index}:30Z`,
            wall_clock_seconds: 30,
            editor_seconds: 20,
            session_id: `wave-a-test-${index + 1}`,
            recording_source: 'timing-recorder-v1',
          })),
        },
        audit: {
          status: 'complete',
          independent: true,
          findings: [],
        },
      },
      records: [
        ...syntheticRecords.map((record, index) => ({
          source: 'inventory',
          inventory_id: `m5-10-wave-a-test-${String(index + 1).padStart(3, '0')}`,
          role: 'start',
          decision: 'included',
          canonical_id: record.id,
          decision_note: 'Self-authored repair-wave validation fixture decision.',
        })),
        {
          source: 'inventory',
          inventory_id: 'm5-10-wave-a-test-051',
          role: 'start',
          decision: 'deferred',
          decision_note: 'Self-authored repair-wave validation fixture reserve decision.',
        },
        {
          source: 'inventory',
          inventory_id: 'm5-10-wave-a-test-052',
          role: 'start',
          decision: 'deferred',
          decision_note: 'Self-authored repair-wave validation fixture reserve decision.',
        },
      ],
    };
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const metrics = createMetricsArtifact({
      manifest,
      relationDiff,
      canonicalRecords: canonical.records,
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
    };
    const verificationPath = path.join(directory, 'verification.json');
    await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');

    const snapshot = {
      record_count: canonical.records.length,
      start_count: canonical.records.filter(({ record }) => record.role === 'start').length,
      reference_only_count: canonical.records.filter(
        ({ record }) => record.role === 'reference-only',
      ).length,
      sense_count: canonical.records.reduce((count, { record }) => count + record.senses.length, 0),
      relation_count: canonical.records.reduce((count, { record }) => (
        count + record.senses.reduce(
          (senseCount, sense) => senseCount + (sense.relations ?? []).length,
          0,
        )
      ), 0),
      expression_count: canonical.records.filter(
        ({ record }) => record.record_type === 'expression',
      ).length,
    };
    const failedStage = await readJson('data/batches/m5-8-stage-01-plus-100.json');
    const stage = {
      schema_version: '1',
      stage_id: 'm5-9a-wave-a-plus-50',
      input: {
        inventory_revision: 'm5-5',
        canonical_snapshot: structuredClone(failedStage.actual.canonical_snapshot),
        previous_stage_report: {
          path: 'data/batches/m5-8-stage-01-plus-100.json',
          sha256: await sha256File('data/batches/m5-8-stage-01-plus-100.json'),
        },
        repair_authorization: {
          path: 'data/batches/m5-9a-repair-authorization.json',
          sha256: await sha256File('data/batches/m5-9a-repair-authorization.json'),
        },
      },
      target: {
        net_start_increase: 50,
        cumulative_start_target: 578,
        candidate_buffer: 2,
        selected_start_count: 52,
      },
      decisions: {
        included_start_count: 50,
        corrected_start_count: 0,
        held_start_count: 0,
        rejected_start_count: 0,
        deferred_start_count: 2,
      },
      buffer: {
        available_count: 2,
        used_count: 0,
        unused_count: 2,
      },
      actual: {
        canonical_snapshot: snapshot,
        imported_start_count: 50,
      },
      metrics: {
        correction_rate_of_selected: 0,
        relation_noise_rate_of_before: 0,
        total_wall_clock_seconds: metrics.derived.timing.total_wall_clock_seconds,
        measured_wall_clock_seconds: metrics.derived.timing.measured_wall_clock_seconds,
        total_editor_seconds: metrics.derived.timing.total_editor_seconds,
        measured_editor_seconds: metrics.derived.timing.measured_editor_seconds,
        editor_seconds_per_selected_start: 2,
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
      gate_status: 'pass',
      decision: 'APPROVE BOUNDED',
      next_stage_created: true,
      next_stage_authorized: true,
    };
    return {
      directory,
      relationDiffPath,
      stage,
      canonicalRecords: canonical.records.map(({ record }) => record),
      syntheticRecords,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    await rm(relationDiffPath, { force: true });
    throw error;
  }
}

function canonicalSnapshotFromRecords(records) {
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce((count, record) => (
      count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations ?? []).length,
        0,
      )
    ), 0),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function stageMetricsFromFixture(metrics, verification) {
  const { decisions, relation_diff: relationDiff, timing, audit } = metrics.derived;
  return {
    correction_rate_of_selected: decisions.correction_rate_of_selected,
    relation_noise_rate_of_before: relationDiff.noise_rate_of_before,
    total_wall_clock_seconds: timing.total_wall_clock_seconds,
    measured_wall_clock_seconds: timing.measured_wall_clock_seconds,
    total_editor_seconds: timing.total_editor_seconds,
    measured_editor_seconds: timing.measured_editor_seconds,
    editor_seconds_per_selected_start: timing.total_editor_seconds === null
      ? null
      : timing.total_editor_seconds / (
        metrics.derived.selection.processed_start_count
          ?? metrics.derived.selection.selected_start_count
      ),
    timing_status: timing.status,
    unmeasured_timing_pass_count: timing.unmeasured_passes.length,
    audit_status: audit.status,
    audit_independent: audit.independent,
    open_audit_blocker_count: audit.open_blocker_count,
    human_editorial_review_complete: verification.human_editorial_review_complete,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
  };
}

async function createFollowOnStageFixture({
  directory,
  previousStage,
  previousStagePath,
  baseCanonicalRecords,
  addedRecords,
  stageId,
  stageLabel,
  targetNetStartIncrease,
  cumulativeStartTarget,
}) {
  const sequence = repairWaveFixtureSequence += 1;
  const stageDirectory = path.join(directory, stageLabel);
  const relationDiffPath = path.resolve(
    'data/batches',
    `m5-9a-repair-chain-${process.pid}-${sequence}.json`,
  );
  try {
    const canonicalDirectory = path.join(stageDirectory, 'canonical');
    await mkdir(canonicalDirectory, { recursive: true });
    const allCanonicalRecords = [...baseCanonicalRecords, ...addedRecords];
    await writeFile(
      path.join(canonicalDirectory, 'stage.jsonl'),
      `${allCanonicalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const canonical = await readCanonicalRecords(canonicalDirectory);
    const batchId = `m5-10-${stageLabel}-${process.pid}-${sequence}`;
    const relationDiff = {
      schema_version: '1',
      batch_id: batchId,
      before_count: 0,
      after_count: 0,
      events: [],
      source_note: `Self-authored ${stageLabel} repair-chain validation fixture relation diff.`,
    };
    await writeFile(relationDiffPath, `${JSON.stringify(relationDiff, null, 2)}\n`, 'utf8');

    const manifest = {
      schema_version: '1',
      batch_id: batchId,
      inventory_id: 'm5-core-5k',
      inventory_revision: 'm5-5',
      generator: {
        model_id: 'human-editorial-expansion',
        tool_version: `typewriter-m5-9a-${stageLabel}-test-1`,
        prompt_version: `m5-9a-${stageLabel}-test-v1`,
      },
      generated_at: '2026-09-08T10:00:00Z',
      review: {
        status: 'complete',
        reviewer: `typewriter-m5-9a-${stageLabel}-test`,
        completed_at: '2026-09-08T11:00:00Z',
      },
      measurement: {
        schema_version: '1',
        relation_diff: {
          artifact: `data/batches/${path.basename(relationDiffPath)}`,
          sha256: await sha256File(relationDiffPath),
        },
        timing: {
          contract_version: 'm5-9a-v1',
          status: 'complete',
          passes: [
            'target-preparation',
            'initial-review',
            'feedback-fixes',
            'final-audit',
            'held-rejected',
          ].map((id, index) => ({
            id,
            status: 'complete',
            started_at: `2026-09-08T10:0${index}:00Z`,
            completed_at: `2026-09-08T10:0${index}:30Z`,
            wall_clock_seconds: 30,
            editor_seconds: 20,
            session_id: `${stageLabel}-test-${index + 1}`,
            recording_source: 'timing-recorder-v1',
          })),
        },
        audit: {
          status: 'complete',
          independent: true,
          findings: [],
        },
      },
      records: [
        ...addedRecords.map((record, index) => ({
          source: 'inventory',
          inventory_id: `${batchId}-inventory-${String(index + 1).padStart(3, '0')}`,
          role: 'start',
          decision: 'included',
          canonical_id: record.id,
          decision_note: `Self-authored ${stageLabel} repair-chain validation fixture decision.`,
        })),
        {
          source: 'inventory',
          inventory_id: `${batchId}-inventory-${String(addedRecords.length + 1).padStart(3, '0')}`,
          role: 'start',
          decision: 'deferred',
          decision_note: `Self-authored ${stageLabel} repair-chain validation fixture reserve decision.`,
        },
        {
          source: 'inventory',
          inventory_id: `${batchId}-inventory-${String(addedRecords.length + 2).padStart(3, '0')}`,
          role: 'start',
          decision: 'deferred',
          decision_note: `Self-authored ${stageLabel} repair-chain validation fixture reserve decision.`,
        },
      ],
    };
    const manifestPath = path.join(stageDirectory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const metrics = createMetricsArtifact({
      manifest,
      relationDiff,
      canonicalRecords: canonical.records,
      source: {
        manifest: manifestPath,
        relation_diff: relationDiffPath,
        canonical_directory: canonicalDirectory,
      },
    });
    const metricsPath = path.join(stageDirectory, 'metrics.json');
    await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
    const verification = {
      schema_version: '1',
      human_editorial_review_complete: true,
      canonical_integrity: true,
      deterministic_sqlite: true,
      search_product_regression: true,
    };
    const verificationPath = path.join(stageDirectory, 'verification.json');
    await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
    const stage = {
      schema_version: '1',
      stage_id: stageId,
      input: {
        inventory_revision: 'm5-5',
        canonical_snapshot: structuredClone(previousStage.actual.canonical_snapshot),
        previous_stage_report: {
          path: previousStagePath,
          sha256: await sha256File(previousStagePath),
        },
      },
      target: {
        net_start_increase: targetNetStartIncrease,
        cumulative_start_target: cumulativeStartTarget,
        candidate_buffer: 2,
        selected_start_count: targetNetStartIncrease + 2,
      },
      decisions: {
        included_start_count: targetNetStartIncrease,
        corrected_start_count: 0,
        held_start_count: 0,
        rejected_start_count: 0,
        deferred_start_count: 2,
      },
      buffer: {
        available_count: 2,
        used_count: 0,
        unused_count: 2,
      },
      actual: {
        canonical_snapshot: canonicalSnapshotFromRecords(
          canonical.records.map(({ record }) => record),
        ),
        imported_start_count: targetNetStartIncrease,
      },
      metrics: stageMetricsFromFixture(metrics, verification),
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
      gate_status: 'pass',
      decision: 'APPROVE BOUNDED',
      next_stage_created: true,
      next_stage_authorized: true,
    };
    const stagePath = path.join(stageDirectory, 'stage.json');
    await writeFile(stagePath, `${JSON.stringify(stage, null, 2)}\n`, 'utf8');
    return {
      stage,
      stagePath,
      relationDiffPath,
      canonicalRecords: allCanonicalRecords,
    };
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true });
    await rm(relationDiffPath, { force: true });
    throw error;
  }
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

test('a valid repair reference carries a Wave A +50 stage through the full validator', async () => {
  const fixture = await createRepairWaveStageFixture();
  try {
    const plan = await readJson('data/batches/m5-8-expansion-plan.json');
    const result = await validateExpansionStage(fixture.stage, plan);
    assert.deepEqual(result, {
      stage_id: 'm5-9a-wave-a-plus-50',
      imported_start_count: 50,
      candidate_buffer: 2,
      gate_status: 'pass',
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.relationDiffPath, { force: true });
  }
});

test('Wave A repair authorization rejects missing, retargeted, and mismatched stage inputs', async () => {
  const fixture = await createRepairWaveStageFixture();
  try {
    const plan = await readJson('data/batches/m5-8-expansion-plan.json');
    const cases = [
      {
        name: 'missing authorization',
        mutate(stage) {
          delete stage.input.repair_authorization;
        },
        code: 'MISSING_REPAIR_AUTHORIZATION',
      },
      {
        name: 'wrong authorization digest',
        mutate(stage) {
          stage.input.repair_authorization.sha256 = '0'.repeat(64);
        },
        code: 'AUTHORIZATION_DIGEST_MISMATCH',
      },
      {
        name: 'plus-51 target',
        mutate(stage) {
          stage.target.net_start_increase = 51;
        },
        code: 'REPAIR_TARGET_MISMATCH',
      },
      {
        name: 'plus-250 target',
        mutate(stage) {
          stage.target.net_start_increase = 250;
        },
        code: 'REPAIR_TARGET_MISMATCH',
      },
      {
        name: 'wrong cumulative target',
        mutate(stage) {
          stage.target.cumulative_start_target = 579;
        },
        code: 'REPAIR_TARGET_MISMATCH',
      },
    ];

    for (const { name, mutate, code } of cases) {
      const tampered = structuredClone(fixture.stage);
      mutate(tampered);
      await assert.rejects(
        validateExpansionStage(tampered, plan),
        (error) => error.code === code,
        `${name} must be rejected by the Wave A contract`,
      );
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.relationDiffPath, { force: true });
  }
});

test('repair waves rejoin stage 3 only after a passed Wave B', async () => {
  const fixture = await createRepairWaveStageFixture();
  const relationDiffPaths = [fixture.relationDiffPath];
  try {
    const plan = await readJson('data/batches/m5-8-expansion-plan.json');
    const waveAStagePath = path.join(fixture.directory, 'wave-a-stage.json');
    await writeFile(waveAStagePath, `${JSON.stringify(fixture.stage, null, 2)}\n`, 'utf8');

    const waveB = await createFollowOnStageFixture({
      directory: fixture.directory,
      previousStage: fixture.stage,
      previousStagePath: waveAStagePath,
      baseCanonicalRecords: fixture.canonicalRecords,
      addedRecords: Array.from({ length: 200 }, (_, index) => (
        syntheticWaveRecord(`w${9051 + index}`, index + 50)
      )),
      stageId: 'm5-9a-wave-b-plus-200',
      stageLabel: 'wave-b',
      targetNetStartIncrease: 200,
      cumulativeStartTarget: 778,
    });
    relationDiffPaths.push(waveB.relationDiffPath);

    const stage3 = await createFollowOnStageFixture({
      directory: fixture.directory,
      previousStage: waveB.stage,
      previousStagePath: waveB.stagePath,
      baseCanonicalRecords: waveB.canonicalRecords,
      addedRecords: Array.from({ length: 500 }, (_, index) => (
        syntheticWaveRecord(`w${9251 + index}`, index + 250)
      )),
      stageId: 'm5-8-stage-03-plus-500',
      stageLabel: 'stage-3',
      targetNetStartIncrease: 500,
      cumulativeStartTarget: 1278,
    });
    relationDiffPaths.push(stage3.relationDiffPath);

    const result = await validateExpansionStage(stage3.stage, plan);
    assert.deepEqual(result, {
      stage_id: 'm5-8-stage-03-plus-500',
      imported_start_count: 500,
      candidate_buffer: 2,
      gate_status: 'pass',
    });

    const waveAOnly = structuredClone(stage3.stage);
    waveAOnly.input.previous_stage_report = {
      path: waveAStagePath,
      sha256: await sha256File(waveAStagePath),
    };
    await assert.rejects(
      validateExpansionStage(waveAOnly, plan),
      (error) => error.code === 'STAGE_CHAIN_MISMATCH',
    );

    const heldWaveB = structuredClone(waveB.stage);
    heldWaveB.gate_status = 'fail';
    heldWaveB.decision = 'HOLD PROCESS';
    heldWaveB.next_stage_authorized = false;
    const heldWaveBPath = path.join(fixture.directory, 'wave-b-held-stage.json');
    await writeFile(heldWaveBPath, `${JSON.stringify(heldWaveB, null, 2)}\n`, 'utf8');
    const blockedStage3 = structuredClone(stage3.stage);
    blockedStage3.input.previous_stage_report = {
      path: heldWaveBPath,
      sha256: await sha256File(heldWaveBPath),
    };
    await assert.rejects(
      validateExpansionStage(blockedStage3, plan),
      (error) => error.code === 'REPAIR_REJOIN_GATE_FAILURE',
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    for (const relationDiffPath of relationDiffPaths) {
      await rm(relationDiffPath, { force: true });
    }
  }
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

  const manuallyCompleted = structuredClone(strictManifest);
  const manualPass = manuallyCompleted.measurement.timing.passes.find(
    ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
  );
  manualPass.status = 'complete';
  manualPass.started_at = '2026-09-08T08:00:00Z';
  manualPass.completed_at = '2026-09-08T08:00:10Z';
  manualPass.wall_clock_seconds = 10;
  manualPass.editor_seconds = 10;
  assert.throws(
    () => validateBatchManifest(manuallyCompleted),
    (error) => error.code === 'TIMING_PROVENANCE_REQUIRED',
  );

  const missingCycle = structuredClone(strictManifest);
  delete missingCycle.measurement.timing.passes.find(
    ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
  ).cycle;
  assert.throws(
    () => validateBatchManifest(missingCycle),
    (error) => error.code === 'TIMING_CYCLE_REQUIRED',
  );

  const feedbackBeforeReview = structuredClone(strictManifest);
  for (const pass of feedbackBeforeReview.measurement.timing.passes) {
    if (pass.cycle === 1) pass.feedback_received_at = '2026-09-08T02:00:00Z';
  }
  assert.throws(
    () => validateBatchManifest(feedbackBeforeReview),
    (error) => error.code === 'FEEDBACK_BEFORE_REVIEW',
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

test('timing recorder owns feedback timestamps and start/stop duration transitions', async () => {
  const manifest = await readJson('data/batches/m5-9-expansion.json');
  const withoutFollowUps = structuredClone(manifest);
  withoutFollowUps.measurement.timing.passes = withoutFollowUps.measurement.timing.passes
    .filter(({ id }) => !id.startsWith('post-review-'));

  const startedAudit = startTimingPass(withoutFollowUps, {
    passId: 'post-review-audit',
    now: '2026-09-08T08:00:00Z',
    sessionId: 'test-audit-session',
  });
  const audit = startedAudit.measurement.timing.passes.find(
    ({ id }) => id === 'post-review-audit',
  );
  assert.deepEqual(
    {
      cycle: audit.cycle,
      feedback_received_at: audit.feedback_received_at,
      started_at: audit.started_at,
      status: audit.status,
      session_id: audit.session_id,
      recording_source: audit.recording_source,
    },
    {
      cycle: 1,
      feedback_received_at: '2026-09-08T08:00:00.000Z',
      started_at: '2026-09-08T08:00:00.000Z',
      status: 'in-progress',
      session_id: 'test-audit-session',
      recording_source: 'timing-recorder-v1',
    },
  );
  assert.throws(
    () => startTimingPass(startedAudit, {
      passId: 'post-review-audit',
      now: '2026-09-08T08:00:01Z',
      sessionId: 'duplicate-session',
    }),
    (error) => error.code === 'DUPLICATE_TIMING_START',
  );
  assert.throws(
    () => stopTimingPass(startedAudit, {
      passId: 'post-review-audit',
      now: '2026-09-07T23:59:59Z',
    }),
    (error) => error.code === 'TIMING_ORDER',
  );

  const stoppedAudit = stopTimingPass(startedAudit, {
    passId: 'post-review-audit',
    now: '2026-09-08T08:00:12Z',
  });
  const completedAudit = stoppedAudit.measurement.timing.passes.find(
    ({ id }) => id === 'post-review-audit',
  );
  assert.equal(completedAudit.status, 'complete');
  assert.equal(completedAudit.completed_at, '2026-09-08T08:00:12.000Z');
  assert.equal(completedAudit.wall_clock_seconds, 12);
  assert.equal(completedAudit.editor_seconds, 12);

  const startedFixes = startTimingPass(stoppedAudit, {
    passId: 'post-review-fixes',
    now: '2026-09-08T08:00:13Z',
    sessionId: 'test-fixes-session',
  });
  const stoppedFixes = stopTimingPass(startedFixes, {
    passId: 'post-review-fixes',
    now: '2026-09-08T08:00:20Z',
  });
  assert.equal(stoppedFixes.measurement.timing.status, 'complete');
  const startedSecondAudit = startTimingPass(stoppedFixes, {
    passId: 'post-review-audit',
    now: '2026-09-08T08:00:21Z',
    sessionId: 'test-second-audit-session',
  });
  const secondAudit = startedSecondAudit.measurement.timing.passes.find(
    ({ id, cycle }) => id === 'post-review-audit' && cycle === 2,
  );
  assert.equal(secondAudit.status, 'in-progress');
  assert.equal(secondAudit.feedback_received_at, '2026-09-08T08:00:21.000Z');
  assert.throws(
    () => stopTimingPass(startedSecondAudit, {
      passId: 'post-review-audit',
      now: '2026-09-08T08:00:22Z',
    }),
    (error) => error.code === 'AMBIGUOUS_TIMING_PASS',
  );
  assert.throws(
    () => stopTimingPass(stoppedFixes, {
      passId: 'post-review-fixes',
      now: '2026-09-08T08:00:21Z',
    }),
    (error) => error.code === 'DUPLICATE_TIMING_STOP',
  );

  assert.throws(
    () => startTimingPass(withoutFollowUps, {
      passId: 'post-review-fixes',
      now: '2026-09-08T08:00:01Z',
      sessionId: 'missing-cycle-session',
    }),
    (error) => error.code === 'MISSING_TIMING_CYCLE',
  );

  const missingStart = structuredClone(withoutFollowUps);
  const heldRejected = missingStart.measurement.timing.passes.find(
    ({ id }) => id === 'held-rejected',
  );
  heldRejected.status = 'unmeasured';
  delete heldRejected.started_at;
  delete heldRejected.completed_at;
  delete heldRejected.wall_clock_seconds;
  delete heldRejected.editor_seconds;
  assert.throws(
    () => stopTimingPass(missingStart, {
      passId: 'held-rejected',
      now: '2026-09-08T08:00:01Z',
    }),
    (error) => error.code === 'TIMING_NOT_STARTED',
  );

  await assert.rejects(
    timingMain([
      '--action=feedback',
      '--manifest=data/batches/m5-9-expansion.json',
      '--output=/tmp/typewriter-m5-9a-manual.json',
      '--feedback-received-at=2026-09-08T08:00:00Z',
    ]),
    (error) => error.code === 'MANUAL_TIMING_INPUT',
  );
});

test('timing CLI records feedback and session timestamps from its current clock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-9a-cli-'));
  try {
    const manifest = await readJson('data/batches/m5-9-expansion.json');
    manifest.measurement.timing.passes = manifest.measurement.timing.passes
      .filter(({ id }) => !id.startsWith('post-review-'));
    const manifestPath = path.join(directory, 'manifest.json');
    const feedbackPath = path.join(directory, 'feedback.json');
    const startedPath = path.join(directory, 'started.json');
    const stoppedPath = path.join(directory, 'stopped.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const beforeFeedback = Date.now();
    const feedback = await timingMain([
      '--action=feedback',
      `--manifest=${manifestPath}`,
      `--output=${feedbackPath}`,
    ]);
    const afterFeedback = Date.now();
    const feedbackPass = feedback.measurement.timing.passes.find(
      ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
    );
    assert.ok(Date.parse(feedbackPass.feedback_received_at) >= beforeFeedback - 1000);
    assert.ok(Date.parse(feedbackPass.feedback_received_at) <= afterFeedback + 1000);

    const started = await timingMain([
      '--action=start',
      `--manifest=${feedbackPath}`,
      `--output=${startedPath}`,
      '--pass=post-review-audit',
    ]);
    const startedPass = started.measurement.timing.passes.find(
      ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
    );
    assert.equal(startedPass.status, 'in-progress');
    assert.equal(startedPass.recording_source, 'timing-recorder-v1');

    const stopped = await timingMain([
      '--action=stop',
      `--manifest=${startedPath}`,
      `--output=${stoppedPath}`,
      '--pass=post-review-audit',
      '--cycle=1',
    ]);
    const stoppedPass = stopped.measurement.timing.passes.find(
      ({ id, cycle }) => id === 'post-review-audit' && cycle === 1,
    );
    assert.equal(stoppedPass.status, 'complete');
    assert.equal(
      stoppedPass.wall_clock_seconds,
      (Date.parse(stoppedPass.completed_at) - Date.parse(stoppedPass.started_at)) / 1000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-9A repair leaves canonical counts unchanged', async () => {
  const { records } = await readCanonicalRecords();
  assert.equal(records.length, 620);
  assert.equal(records.filter(({ record }) => record.role === 'start').length, 578);
  assert.equal(records.filter(({ record }) => record.role === 'reference-only').length, 42);
});

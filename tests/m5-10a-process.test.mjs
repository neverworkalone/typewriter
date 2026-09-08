import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  appendFeedbackCycle,
  startTimingPass,
} from '../scripts/batch/timing.mjs';
import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
  validateBatchManifest,
  validateSensePreflightRecords,
} from '../scripts/batch/validate-batch.mjs';
import {
  validateM5AProcess,
} from '../scripts/batch/validate-m5-10a-process.mjs';
import {
  validateM5ARepair,
} from '../scripts/batch/validate-m5-10a-repair.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const WAVE_A_MANIFEST_PATH = path.resolve('data/batches/m5-10-wave-a.json');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function makePreflightManifest() {
  const manifest = await readJson(WAVE_A_MANIFEST_PATH);
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const canonicalById = new Map(canonical.records.map(({ record }) => [record.id, record]));

  manifest.sense_review.preflight = {
    process_revision: M5_10A_PROCESS_REVISION,
    boundary_ids: [...M5_10A_SENSE_BOUNDARY_IDS],
    record_checkpoints: manifest.records.map((record) => {
      const complete = record.decision === 'included' || record.decision === 'corrected';
      const canonicalRecord = complete ? canonicalById.get(record.canonical_id) : undefined;
      return {
        inventory_id: record.inventory_id,
        ...(complete ? { canonical_id: record.canonical_id } : {}),
        status: complete ? 'complete' : record.decision,
        lemma_pos: complete ? 'checked' : 'not-reviewed',
        observed_sense_count: canonicalRecord?.senses.length ?? 0,
        observed_pos: canonicalRecord?.senses.map(({ pos }) => pos) ?? [],
        boundary_checks: Object.fromEntries(
          M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => [
            boundaryId,
            complete ? 'checked' : 'not-reviewed',
          ]),
        ),
        missing_boundary_ids: complete ? [] : [...M5_10A_SENSE_BOUNDARY_IDS],
        note: complete
          ? 'Self-authored process-contract fixture checkpoint.'
          : 'Self-authored held or deferred process-contract fixture checkpoint.',
      };
    }),
  };
  return { manifest, canonical };
}

function assertErrorCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('M5-10A process correction and repair authorization remain source-bound', async () => {
  const process = await validateM5AProcess();
  assert.equal(process.process_revision, M5_10A_PROCESS_REVISION);
  assert.equal(process.canonical_snapshot.start_count, 578);
  assert.equal(process.sense_preflight.regression_case_count, 21);
  assert.deepEqual(process.sense_preflight.required_boundary_coverage, {
    'physical-figurative': 17,
    'homonym-pos': 1,
    'sensory-emotion-state-action': 7,
    'directional-symmetry': 2,
    'compound-spaced-phrase': 1,
    'word-idiom': 3,
  });
  assert.equal(process.relation_pre_screen.pre_screen_rejected_count, 12);
  assert.equal(process.timing.unmeasured_pass_count, 0);
  assert.deepEqual(process.verification, {
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    package: true,
  });

  const authorization = await validateM5ARepair();
  assert.deepEqual(authorization.authorization, {
    target_issue: 96,
    target_wave: 'wave-a2-plus-50-validation',
    base_start_count: 578,
    net_start_increase: 50,
    cumulative_start_target: 628,
    max_net_start_increase: 50,
    candidate_buffer_policy: 'declare-before-selection',
    canonical_mutation: false,
    wave_a2_authorized: true,
    wave_b_net_start_increase: 150,
    wave_b_authorized: false,
    requires_wave_a2_pass_before_wave_b: true,
  });
  assert.equal(authorization.failed_stage.gate_status, 'fail');
  assert.equal(authorization.failed_stage.decision, 'HOLD PROCESS');
});

test('sense preflight records every selected start and preserves canonical sense facts', async () => {
  const { manifest, canonical } = await makePreflightManifest();
  validateBatchManifest(manifest);

  assert.equal(manifest.sense_review.preflight.record_checkpoints.length, manifest.records.length);
  assert.deepEqual(
    manifest.sense_review.preflight.boundary_ids,
    M5_10A_SENSE_BOUNDARY_IDS,
  );

  const completeCheckpoints = manifest.sense_review.preflight.record_checkpoints
    .filter(({ status }) => status === 'complete');
  const stagedCompleteRecords = canonical.records.filter(({ record }) => (
    completeCheckpoints.some(({ canonical_id: canonicalId }) => canonicalId === record.id)
  ));
  validateSensePreflightRecords(manifest, stagedCompleteRecords);

  const missingCheckpoint = structuredClone(manifest);
  missingCheckpoint.sense_review.preflight.record_checkpoints.pop();
  assertErrorCode(() => validateBatchManifest(missingCheckpoint), 'PREFLIGHT_COVERAGE_MISMATCH');

  const incompleteBoundary = structuredClone(manifest);
  incompleteBoundary.sense_review.preflight.record_checkpoints[0].boundary_checks['physical-figurative'] = 'not-reviewed';
  assertErrorCode(() => validateBatchManifest(incompleteBoundary), 'PREFLIGHT_BOUNDARY_MISMATCH');

  const missingPreflight = structuredClone(manifest);
  delete missingPreflight.sense_review.preflight;
  missingPreflight.measurement.timing.contract_version = 'm5-10a-v1';
  assertErrorCode(() => validateBatchManifest(missingPreflight), 'MISSING_FIELD');

  const mismatchedCanonical = structuredClone(stagedCompleteRecords);
  mismatchedCanonical[0].record.senses.pop();
  assertErrorCode(
    () => validateSensePreflightRecords(manifest, mismatchedCanonical),
    'PREFLIGHT_CANONICAL_MISMATCH',
  );
});

test('timing recorder adopts the M5-10A contract when preflight is present', async () => {
  const { manifest } = await makePreflightManifest();
  manifest.measurement.timing.status = 'incomplete';
  manifest.measurement.timing.passes = manifest.measurement.timing.passes
    .filter(({ id }) => !['post-review-audit', 'post-review-fixes'].includes(id))
    .map(({ id }) => ({
      id,
      status: 'unmeasured',
      note: 'Self-authored timing-contract fixture pass.',
    }));

  const started = startTimingPass(manifest, {
    passId: 'initial-review',
    now: '2026-09-08T13:00:00.000Z',
    sessionId: 'm5-10a-process-test',
  });
  assert.equal(started.measurement.timing.contract_version, 'm5-10a-v1');
  assert.equal(
    started.measurement.timing.passes.find(({ id }) => id === 'initial-review').status,
    'in-progress',
  );

  const withFeedback = appendFeedbackCycle(manifest, {
    feedbackReceivedAt: '2026-09-08T13:00:00.000Z',
    auditNote: 'Self-authored timing-contract fixture audit.',
    fixesNote: 'Self-authored timing-contract fixture fixes.',
  });
  assert.equal(withFeedback.measurement.timing.contract_version, 'm5-10a-v1');
  assert.deepEqual(
    withFeedback.measurement.timing.passes.slice(-2).map(({ id, cycle, status }) => ({ id, cycle, status })),
    [
      { id: 'post-review-audit', cycle: 1, status: 'unmeasured' },
      { id: 'post-review-fixes', cycle: 1, status: 'unmeasured' },
    ],
  );
});

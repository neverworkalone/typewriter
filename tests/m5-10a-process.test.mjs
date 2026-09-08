import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
  DEFAULT_CALIBRATION_ARTIFACT_PATH,
  validateM5A10ACalibration,
} from '../scripts/batch/validate-m5-10a-calibration.mjs';
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
      const checkedBoundaryIds = complete
        ? ['physical-figurative', 'sensory-emotion-state-action']
        : [];
      const senseIds = canonicalRecord?.senses.map(({ id }) => id) ?? [];
      return {
        inventory_id: record.inventory_id,
        ...(complete ? { canonical_id: record.canonical_id } : {}),
        status: complete ? 'complete' : record.decision,
        lemma_pos: complete ? 'checked' : 'not-reviewed',
        observed_sense_count: canonicalRecord?.senses.length ?? 0,
        observed_pos: canonicalRecord?.senses.map(({ pos }) => pos) ?? [],
        boundary_checks: Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => {
          const status = complete && checkedBoundaryIds.includes(boundaryId)
            ? 'checked'
            : complete ? 'not-applicable' : 'not-reviewed';
          return [boundaryId, {
            status,
            rationale: complete
              ? `${record.inventory_id} ${record.canonical_id} ${boundaryId} reviewed against ${senseIds.join(', ')}`
              : `${record.inventory_id} ${boundaryId} remains not-reviewed because the record is ${record.decision}`,
            sense_ids: status === 'checked' ? senseIds : [],
          }];
        })),
        missing_boundary_ids: complete ? [] : [...M5_10A_SENSE_BOUNDARY_IDS],
        note: complete
          ? `${record.inventory_id} process-contract fixture checkpoint with record-specific boundary evidence.`
          : `${record.inventory_id} held or deferred process-contract fixture checkpoint.`,
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
  assert.deepEqual(process.candidate_generation, {
    process_revision: 'm5-10a-relation-generation-v1',
    calibration_artifact: 'data/batches/m5-10a-relation-calibration.json',
    calibration_artifact_sha256: process.candidate_generation.calibration_artifact_sha256,
    calibration_case_count: 20,
    generated_candidate_count: 15,
    suppressed_candidate_count: 5,
    pre_screen_noise_count: 0,
    noise_rate_of_emitted_candidates: 0,
    editor_seconds_per_processed_start: 8,
    unmeasured_pass_count: 0,
    preflight_case_count: 20,
    preflight_evidence_case_count: 20,
    fixed_gate_status: 'passed',
  });
  assert.equal(process.timing.unmeasured_pass_count, 0);
  assert.deepEqual(process.verification, {
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    candidate_generation_calibration: true,
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
  incompleteBoundary.sense_review.preflight.record_checkpoints[0].boundary_checks['physical-figurative'].status = 'not-reviewed';
  incompleteBoundary.sense_review.preflight.record_checkpoints[0].boundary_checks['physical-figurative'].sense_ids = [];
  assertErrorCode(() => validateBatchManifest(incompleteBoundary), 'PREFLIGHT_BOUNDARY_MISMATCH');

  const allNotApplicable = structuredClone(manifest);
  const allNotApplicableCheckpoint = allNotApplicable.sense_review.preflight.record_checkpoints[0];
  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    allNotApplicableCheckpoint.boundary_checks[boundaryId] = {
      status: 'not-applicable',
      rationale: `${allNotApplicableCheckpoint.inventory_id} ${boundaryId} was not applicable`,
      sense_ids: [],
    };
  }
  assertErrorCode(() => validateBatchManifest(allNotApplicable), 'PREFLIGHT_INCOMPLETE');

  const duplicateEvidence = structuredClone(manifest);
  const firstCheckpoint = duplicateEvidence.sense_review.preflight.record_checkpoints[0];
  const secondCheckpoint = duplicateEvidence.sense_review.preflight.record_checkpoints[1];
  const sharedEvidence = `${firstCheckpoint.inventory_id} ${secondCheckpoint.inventory_id} physical-figurative ${firstCheckpoint.boundary_checks['physical-figurative'].sense_ids.join(',')} ${secondCheckpoint.boundary_checks['physical-figurative'].sense_ids.join(',')} shared evidence`;
  firstCheckpoint.boundary_checks['physical-figurative'].rationale = sharedEvidence;
  secondCheckpoint.boundary_checks['physical-figurative'].rationale = sharedEvidence;
  assertErrorCode(() => validateBatchManifest(duplicateEvidence), 'PREFLIGHT_GENERIC_EVIDENCE');

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

  const mismatchedPos = structuredClone(manifest);
  const mismatchedPosCheckpoint = mismatchedPos.sense_review.preflight.record_checkpoints
    .find(({ status }) => status === 'complete');
  mismatchedPosCheckpoint.observed_pos = mismatchedPosCheckpoint.observed_pos
    .map((pos) => (pos === 'noun' ? 'verb' : 'noun'));
  assertErrorCode(
    () => validateSensePreflightRecords(mismatchedPos, stagedCompleteRecords),
    'PREFLIGHT_CANONICAL_MISMATCH',
  );

  const mismatchedEvidence = structuredClone(manifest);
  const mismatchedEvidenceCheckpoint = mismatchedEvidence.sense_review.preflight.record_checkpoints
    .find(({ status }) => status === 'complete');
  mismatchedEvidenceCheckpoint.boundary_checks['physical-figurative'].sense_ids = ['w999-s1'];
  assertErrorCode(() => validateBatchManifest(mismatchedEvidence), 'PREFLIGHT_EVIDENCE_MISMATCH');

  const relationWithoutPreflight = structuredClone(manifest);
  const relationCheckpoint = relationWithoutPreflight.sense_review.preflight.record_checkpoints
    .find(({ canonical_id: canonicalId }) => canonicalId === 'w529');
  relationCheckpoint.status = 'held';
  relationCheckpoint.lemma_pos = 'not-reviewed';
  relationCheckpoint.observed_sense_count = 0;
  relationCheckpoint.observed_pos = [];
  relationCheckpoint.canonical_id = undefined;
  delete relationCheckpoint.canonical_id;
  assertErrorCode(
    () => validateSensePreflightRecords(relationWithoutPreflight, stagedCompleteRecords),
    'PREFLIGHT_RELATION_GATE',
  );
});

test('M5-10A calibration is an upstream fixed gate, not historical classification', async () => {
  const calibration = await validateM5A10ACalibration({ artifactPath: DEFAULT_CALIBRATION_ARTIFACT_PATH });
  assert.equal(calibration.case_count, 20);
  assert.equal(calibration.generated_candidate_count, 15);
  assert.equal(calibration.suppressed_candidate_count, 5);
  assert.equal(calibration.pre_screen_noise_count, 0);
  assert.equal(calibration.noise_rate_of_emitted_candidates, 0);
  assert.equal(calibration.editor_seconds_per_processed_start, 8);
  assert.equal(calibration.unmeasured_pass_count, 0);
  assert.deepEqual(calibration.preflight, {
    case_count: 20,
    evidence_case_count: 20,
    unresolved_boundary_count: 0,
    duplicate_evidence_count: 0,
  });
});

test('M5-10A calibration rejects noise, time, audit, digest, and preflight tampering', async () => {
  const mutations = [
    ['noise', (artifact) => { artifact.calibration.generation.noise_rate_of_emitted_candidates = 0.5; }],
    ['time', (artifact) => { artifact.calibration.timing.editor_seconds = 260; }],
    ['audit', (artifact) => { artifact.calibration.audit.open_blocker_count = 1; }],
    ['digest', (artifact) => { artifact.source.fixture_sha256 = '0'.repeat(64); }],
    ['preflight', (artifact) => { artifact.calibration.preflight.evidence_case_count = 19; }],
  ];
  const original = await readJson(DEFAULT_CALIBRATION_ARTIFACT_PATH);
  for (const [label, mutate] of mutations) {
    const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-calibration-'));
    try {
      const artifactPath = path.join(directory, 'calibration.json');
      const mutated = structuredClone(original);
      mutate(mutated);
      await writeFile(artifactPath, `${JSON.stringify(mutated, null, 2)}\n`);
      await assert.rejects(
        () => validateM5A10ACalibration({ artifactPath }),
        (error) => typeof error?.code === 'string',
        `${label} tampering must fail calibration validation`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
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

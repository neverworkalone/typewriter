import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  appendFeedbackCycle,
  createCalibrationTimingSession,
  finalizeCalibrationTimingRecording,
  startCalibrationTimingPass,
  stopCalibrationTimingPass,
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
  validateCalibrationFixtureEvidence,
  validateM5A10ACalibration,
} from '../scripts/batch/validate-m5-10a-calibration.mjs';
import { verifyCalibrationTimingRecording } from '../scripts/batch/timing.mjs';
import {
  classifyRelationRequest,
  generateRelationCandidates,
} from '../scripts/batch/relation-generation.mjs';
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
    process_revision: 'm5-10a-relation-generation-v3',
    calibration_artifact: 'data/batches/m5-10a-relation-calibration.json',
    calibration_artifact_sha256: process.candidate_generation.calibration_artifact_sha256,
    calibration_case_count: 20,
    request_count: 20,
    raw_proposal_count: 20,
    generation_suppressed_count: 0,
    pre_screen_noise_count: 0,
    noise_rate_of_raw_proposals: 0,
    editor_seconds_per_processed_start: process.candidate_generation.editor_seconds_per_processed_start,
    correction_rate: 0,
    unmeasured_pass_count: 0,
    preflight_case_count: 20,
    preflight_evidence_case_count: 20,
    timing_source: 'data/batches/m5-10a-relation-calibration-timing.json',
    timing_source_sha256: process.candidate_generation.timing_source_sha256,
    fixed_gate_status: 'passed',
  });
  assert.ok(process.candidate_generation.editor_seconds_per_processed_start > 0);
  assert.ok(process.candidate_generation.editor_seconds_per_processed_start <= 12);
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
  assert.equal(calibration.request_count, 20);
  assert.equal(calibration.raw_proposal_count, 20);
  assert.equal(calibration.generation_suppressed_count, 0);
  assert.equal(calibration.generated_candidate_count, 20);
  assert.equal(calibration.suppressed_candidate_count, 0);
  assert.equal(calibration.pre_screen_noise_count, 0);
  assert.equal(calibration.noise_rate_of_raw_proposals, 0);
  assert.ok(calibration.editor_seconds_per_processed_start > 0);
  assert.ok(calibration.editor_seconds_per_processed_start <= 12);
  assert.equal(calibration.correction_rate, 0);
  assert.equal(calibration.unmeasured_pass_count, 0);
  assert.deepEqual(calibration.preflight, {
    status: 'complete',
    case_count: 20,
    evidence_case_count: 20,
    unresolved_boundary_count: 0,
    duplicate_evidence_count: 0,
    checked_boundary_counts: {
      'physical-figurative': 8,
      'homonym-pos': 7,
      'sensory-emotion-state-action': 15,
      'directional-symmetry': 7,
      'compound-spaced-phrase': 5,
      'word-idiom': 5,
    },
  });
});

test('M5-10A calibration rejects oracle labels, unseen negatives, and canonical tuple reuse', async () => {
  const fixture = await readJson('tests/fixtures/m5-10a-relation-generation-calibration.json');
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const baseline = generateRelationCandidates(fixture, canonical.records);
  const stable = (result) => ({
    request_count: result.request_count,
    raw_proposal_count: result.raw_proposal_count,
    generation_suppressed_count: result.generation_suppressed_count,
    pre_screen_noise_count: result.pre_screen_noise_count,
    noise_rate_of_raw_proposals: result.noise_rate_of_raw_proposals,
    suppressed_category_counts: result.suppressed_category_counts,
    generated_candidates: [...result.generated_candidates].sort((a, b) => a.case_id.localeCompare(b.case_id)),
    suppressed_candidates: [...result.suppressed_candidates].sort((a, b) => a.case_id.localeCompare(b.case_id)),
  });
  const labeled = structuredClone(fixture);
  for (const calibrationCase of labeled.cases) {
    calibrationCase.expected_action = 'emit';
    calibrationCase.generation_basis = 'sense-anchored-writer-use';
    calibrationCase.expected_suppression_category = 'incidental-co-occurrence';
    calibrationCase.relation = {
      target: 'w999',
      target_sense: 'w999-s1',
      type: 'direct',
    };
    calibrationCase.direction = {
      from: 'w999-s1',
      to: 'w998-s1',
    };
  }
  const shuffled = structuredClone(fixture);
  shuffled.cases.reverse();
  assert.deepEqual(stable(generateRelationCandidates(labeled, canonical.records)), stable(baseline));
  assert.deepEqual(stable(generateRelationCandidates(shuffled, canonical.records)), stable(baseline));
  assert.equal(baseline.generated_candidates.length, 20);
  assert.deepEqual(baseline.suppressed_candidates, []);
  const canonicalTuples = new Set(canonical.records.flatMap(({ record }) => record.senses.flatMap((sense) => (
    (sense.relations ?? []).map((relation) => `${sense.id}\u0000${relation.target_sense}\u0000${relation.type}`)
  ))));
  for (const candidate of baseline.generated_candidates) {
    const tuple = `${candidate.source_sense}\u0000${candidate.relation.target_sense}\u0000${candidate.relation.type}`;
    assert.equal(canonicalTuples.has(tuple), false, `${candidate.case_id} must be noncanonical`);
  }
});

test('M5-10A relation contracts classify type independently from actual gloss content', async () => {
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const request = (sourceSense, target, type, direction = { from: sourceSense, to: target.target_sense }) => ({
    source_sense: sourceSense,
    relation: { ...target },
    direction,
  });
  const unrelated = { target: 'w026', target_sense: 'w026-s1' };
  assert.equal(
    classifyRelationRequest(request('w015-s1', { ...unrelated, type: 'direct' }), canonical.records),
    'incidental-co-occurrence',
  );
  assert.equal(
    classifyRelationRequest(request('w015-s1', { ...unrelated, type: 'near' }), canonical.records),
    'incidental-co-occurrence',
  );

  const sharedPair = { target: 'w021', target_sense: 'w021-s1' };
  assert.equal(
    classifyRelationRequest(request('w003-s1', { ...sharedPair, type: 'direct' }), canonical.records),
    'incidental-co-occurrence',
  );
  assert.equal(
    classifyRelationRequest(request('w003-s1', { ...sharedPair, type: 'near' }), canonical.records),
    undefined,
  );
  assert.equal(
    classifyRelationRequest(request('w003-s1', { ...sharedPair, type: 'mood' }), canonical.records),
    undefined,
  );

  const unseenBroadRecord = {
    id: 'w998',
    lemma: '즐거움',
    role: 'start',
    record_type: 'entry',
    senses: [{
      id: 'w998-s1',
      pos: 'noun',
      gloss: '기분이나 감정을 포괄하는 일반적인 즐거운 마음',
    }],
  };
  assert.equal(
    classifyRelationRequest(
      request('w003-s1', { target: 'w998', target_sense: 'w998-s1', type: 'mood' }),
      [...canonical.records, unseenBroadRecord],
    ),
    'broad-common-category',
  );
  assert.equal(
    classifyRelationRequest(request('w091-s1', { target: 'w061', target_sense: 'w061-s1', type: 'sensory' }), canonical.records),
    'unsupported-cross-sensory',
  );
});

test('M5-10A calibration rejects noise, time, audit, digest, preflight, and timing provenance tampering', async () => {
  const mutations = [
    ['noise', (artifact) => { artifact.calibration.generation.noise_rate_of_raw_proposals = 0.5; }],
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
  const timing = await readJson('data/batches/m5-10a-relation-calibration-timing.json');
  timing.session_id = 'm5-10a-hand-written-session';
  assertErrorCode(() => verifyCalibrationTimingRecording(timing), 'TIMING_PROVENANCE_REQUIRED');
});

test('M5-10A calibration rejects regular boilerplate in sense evidence', async () => {
  const fixture = await readJson('tests/fixtures/m5-10a-relation-generation-calibration.json');
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const mutated = structuredClone(fixture);
  const first = mutated.cases[0].preflight.boundary_checks['physical-figurative'];
  const second = mutated.cases[1].preflight.boundary_checks['physical-figurative'];
  second.observed_use = first.observed_use;
  second.rationale = `${mutated.cases[1].case_id} physical-figurative ${mutated.cases[1].source_sense}: ${second.observed_use}; observed canonical meaning “곁에 사람이 없거나 마음을 나눌 곳이 없어 허전한 느낌” was checked before relation screening.`;
  second.source_note = `${mutated.cases[1].case_id} physical-figurative source note: ${second.observed_use}; canonical sense ${mutated.cases[1].source_sense} means “곁에 사람이 없거나 마음을 나눌 곳이 없어 허전한 느낌”, providing a meaning/use observation for this boundary.`;
  assertErrorCode(
    () => validateCalibrationFixtureEvidence(mutated, canonical.records),
    'CALIBRATION_GENERIC_EVIDENCE',
  );

  const sameCaseCopy = structuredClone(fixture);
  const sameCase = sameCaseCopy.cases[0];
  const physical = sameCase.preflight.boundary_checks['physical-figurative'];
  const homonym = sameCase.preflight.boundary_checks['homonym-pos'];
  const copiedUse = physical.observed_use;
  const originalHomonymUse = homonym.observed_use;
  homonym.observed_use = copiedUse;
  homonym.rationale = homonym.rationale.replace(
    originalHomonymUse,
    copiedUse,
  );
  homonym.source_note = homonym.source_note.replace(
    originalHomonymUse,
    copiedUse,
  );
  assertErrorCode(
    () => validateCalibrationFixtureEvidence(sameCaseCopy, canonical.records),
    'CALIBRATION_GENERIC_EVIDENCE',
  );
});

test('calibration timing requires explicit persisted start/stop events', () => {
  const session = createCalibrationTimingSession({ processedStartCount: 20 });
  assert.equal(session.passes.filter(({ status }) => status === 'unmeasured').length, 5);
  session.passes[0] = startCalibrationTimingPass({
    passId: 'target-preparation',
    now: '2026-09-09T00:00:00.000Z',
  });
  assert.equal(session.passes.filter(({ status }) => status === 'in-progress').length, 1);
  assert.equal(session.passes.slice(1).every(({ status }) => status === 'unmeasured'), true);
  session.passes[0] = stopCalibrationTimingPass(session.passes[0], {
    now: '2026-09-09T00:00:01.000Z',
  });
  assert.equal(session.passes[0].editor_seconds, 1);
  assert.throws(
    () => finalizeCalibrationTimingRecording(session),
    (error) => error?.code === 'TIMING_PROVENANCE_REQUIRED',
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALIBRATION_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/m6-5-correction-calibration.json',
);
const M6_4_SAMPLE_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/m6-4-quality-audit-sample.json');
const M6_3_REVIEW_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/m6-3-surface-form-review.json',
);

async function readBytes(filePath) {
  return readFile(filePath);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeExpectedDispositions(sample) {
  const dispositions = [];
  for (const relationType of Object.keys(sample.frozen_sampling.relation_tuples).sort()) {
    for (const item of sample.frozen_sampling.relation_tuples[relationType].cases) {
      dispositions.push({
        unit_type: 'relation_tuple',
        stable_unit_id: item.stable_unit_id,
        selection_hash: item.selection_hash,
        status: 'held',
        reason_code: 'independent_judgments_not_recorded',
      });
    }
  }
  for (const item of sample.frozen_sampling.relation_gaps.cases) {
    dispositions.push({
      unit_type: 'relation_gap',
      stable_unit_id: item.record_id,
      selection_hash: item.selection_hash,
      status: 'held',
      reason_code: 'independent_judgments_not_recorded',
    });
  }
  for (const item of sample.frozen_sampling.ambiguous_queries.cases) {
    dispositions.push({
      unit_type: 'ranking_query',
      stable_unit_id: item.stable_unit_id,
      selection_hash: item.selection_hash,
      status: 'held',
      reason_code: 'writer_choice_outcomes_not_recorded',
    });
  }
  for (const item of [
    { query: '끈', expected_ids: ['w2969'], actual_ids: ['w2969', 'w1081'] },
    { query: '열', expected_ids: ['w110'], actual_ids: ['w110', 'w192'] },
  ]) {
    dispositions.push({
      unit_type: 'exact_key_result_set',
      stable_unit_id: item.query,
      selection_hash: null,
      expected_ids: item.expected_ids,
      actual_ids: item.actual_ids,
      status: 'held',
      reason_code: 'm6_1_v2_vs_m6_2_m6_3_contract_conflict',
    });
  }
  return dispositions;
}

test('M6-5 decisions bind the exact M6-4 sample and disposition every selected unit', async () => {
  const [calibrationBytes, sampleBytes, reviewBytes] = await Promise.all([
    readBytes(CALIBRATION_PATH),
    readBytes(M6_4_SAMPLE_PATH),
    readBytes(M6_3_REVIEW_PATH),
  ]);
  const calibration = JSON.parse(calibrationBytes.toString('utf8'));
  const sample = JSON.parse(sampleBytes.toString('utf8'));
  const review = JSON.parse(reviewBytes.toString('utf8'));

  assert.equal(calibration.calibration_id, 'm6-5-bounded-correction-calibration-v1');
  assert.equal(calibration.issue, 177);
  assert.equal(calibration.decision, 'HOLD');
  assert.equal(calibration.source.m6_4_sample_sha256, sha256(sampleBytes));
  assert.equal(calibration.source.m6_4_issue_start_commit, sample.source.issue_start_commit);
  assert.equal(calibration.source.canonical_revision, sample.source.canonical_revision);
  assert.equal(calibration.source.baseline_contract_version, 'm6-1-quality-gates-v2');
  for (const [relativePath, expectedDigest] of [
    ['docs/m6-1-quality-baseline.json', calibration.source.m6_1_baseline_sha256],
    ['docs/m6-4-quality-audit-report.md', calibration.source.m6_4_report_sha256],
    ['data/validation/m6-3-surface-form-review.json', calibration.source.m6_3_surface_form_review_sha256],
    ...Object.entries(calibration.source.current_runtime_sha256),
  ]) {
    assert.equal(
      expectedDigest,
      sha256(await readBytes(path.join(REPOSITORY_DIRECTORY, relativePath))),
      `${relativePath} changed since the M6-5 decision artifact was authored`,
    );
  }
  assert.deepEqual(
    calibration.bounded_dispositions,
    makeExpectedDispositions(sample),
    'every selected relation, gap, and ranking unit must have one exact held disposition',
  );
  assert.deepEqual(calibration.disposition_counts, {
    corrected: 0,
    held: calibration.bounded_dispositions.length,
    rejected: 0,
  });
  assert.deepEqual(calibration.disposition_counts_by_type, {
    exact_key_result_set: 2,
    ranking_query: 40,
    relation_gap: 80,
    relation_tuple: 162,
  });
  assert.equal(calibration.bounded_dispositions.length, 284);
  assert.deepEqual(calibration.exact_search_gate.mismatched_queries, ['끈', '열']);
  for (const finding of calibration.bounded_dispositions.filter(
    ({ unit_type }) => unit_type === 'exact_key_result_set',
  )) {
    const collision = review.reviewed_collisions.exact_generated.find(
      ({ form }) => form === finding.stable_unit_id,
    );
    assert.ok(collision, `M6-3 must contain the reviewed collision for ${finding.stable_unit_id}`);
    assert.deepEqual(
      [...new Set(collision.exact_candidates.map(({ record_id: recordId }) => recordId))],
      finding.expected_ids,
    );
    assert.deepEqual(
      [...new Set([
        ...collision.exact_candidates.map(({ record_id: recordId }) => recordId),
        ...collision.generated_candidates.map(({ record_id: recordId }) => recordId),
      ])],
      finding.actual_ids,
    );
  }
  assert.equal(calibration.relation_calibration.relation_default, 'empty');
  assert.equal(calibration.relation_calibration.relation_quota, 'none');
  assert.equal(calibration.relation_calibration.noise_rate, null);
  assert.equal(calibration.workload.independent_judgments_required, 484);
  assert.equal(calibration.workload.independent_judgments_recorded, 0);
  assert.equal(calibration.workload.ranking_writer_choices_recorded, 0);
});

test('M6-5 calibration keeps relation noise unmeasured when no proposal was authorized', async () => {
  const calibration = JSON.parse((await readBytes(CALIBRATION_PATH)).toString('utf8'));
  assert.deepEqual(calibration.relation_calibration, {
    relation_default: 'empty',
    relation_quota: 'none',
    proposed_candidate_count: 0,
    admitted_count: 0,
    rejected_count: 0,
    noise_rate: null,
    measurement_status: 'NOT_MEASURED_NO_AUTHORIZED_PROPOSALS',
  });
});

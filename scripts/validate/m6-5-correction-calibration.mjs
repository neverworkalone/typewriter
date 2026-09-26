import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_MANIFEST_PATH = 'data/validation/m6-5-correction-calibration.json';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const M6_5_FROZEN_SOURCE_IDENTITY = deepFreeze({
  m6_5_issue_start_commit: 'e04f4e5b3a913b769896cfea1e3b518adfe5b9f8',
  m6_4_issue_start_commit: '4226a97f162b1f4a7401a74893c3d28018d33385',
  canonical_revision: '8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9',
  canonical_file_count: 13,
  baseline_contract_version: 'm6-1-quality-gates-v2',
  m6_1_baseline_sha256: '4eb83fd3d19c8ff0b522300430e4107f002850907161f2bdcd97ba3872195209',
  m6_4_sample_sha256: 'afe42789a95fb5c06cf77ec36bc7904231d889da772c6348bd25adb8d625e9b8',
  m6_4_report_sha256: '19af2343f2eb4e1b44f565e9c1f60edaaf805782fd9373904c6333ea00d6e5ca',
  m6_3_surface_form_review_sha256: '380e67ce30af6376906bca75f4c703da565dad59c27e094ec049629e861b5e22',
  issue_start_runtime_sha256: {
    'scripts/validate/m6-1-quality-baseline.mjs': 'c66b1d9c0f9570514bd10fd9db73c9d53ed79b70a53d4ca53d9392c4b0b27eaa',
    'scripts/build/query.mjs': 'fab784bb887e265764f8231e6c7b05240ba2173b591a77f93b2c7663e5fc785b',
    'src/runtime/search-query.js': '66480e70fbc9f636675cb93ebc59163e88792675d55d011c1da5ff141864a655',
    'src/domain/exact-search-candidates.js': '7b9f4563f724cacfe8c14b5fa5553f6d9ef5bae144c605518f157d2e589c77e0',
    'scripts/inflection/surface-form-projection.mjs': 'ac45f89c529b91de01396c2468863ca82ab91738ea803fb4e49ad02808d893ed',
  },
});

export const M6_5_FROZEN_DISPOSITIONS_SHA256 = '5dfe90dc99f7075f29626775b7bc6ff2c5c2c5a33f5ba606c859fbd177371db4';
export const M6_5_FROZEN_MANIFEST_SHA256 = 'e465e9c03d289c84b4bacdf2e4a3bf1d1f7b53ad9eff623e89d5d5e49a7efc76';

const EXPECTED_DISPOSITION_COUNTS = deepFreeze({
  corrected: 0,
  held: 284,
  rejected: 0,
});

const EXPECTED_DISPOSITION_COUNTS_BY_TYPE = deepFreeze({
  exact_key_result_set: 2,
  ranking_query: 40,
  relation_gap: 80,
  relation_tuple: 162,
});

const EXPECTED_EXACT_KEY_FINDINGS = deepFreeze([
  {
    unit_type: 'exact_key_result_set',
    stable_unit_id: '끈',
    selection_hash: null,
    expected_ids: ['w2969'],
    actual_ids: ['w2969', 'w1081'],
    status: 'held',
    reason_code: 'm6_1_v2_vs_m6_2_m6_3_contract_conflict',
  },
  {
    unit_type: 'exact_key_result_set',
    stable_unit_id: '열',
    selection_hash: null,
    expected_ids: ['w110'],
    actual_ids: ['w110', 'w192'],
    status: 'held',
    reason_code: 'm6_1_v2_vs_m6_2_m6_3_contract_conflict',
  },
]);

const EXPECTED_RELATION_CALIBRATION = deepFreeze({
  relation_default: 'empty',
  relation_quota: 'none',
  proposed_candidate_count: 0,
  admitted_count: 0,
  rejected_count: 0,
  noise_rate: null,
  measurement_status: 'NOT_MEASURED_NO_AUTHORIZED_PROPOSALS',
});

const EXPECTED_WORKLOAD = deepFreeze({
  canonical_cases: 242,
  independent_judgments_required: 484,
  independent_judgments_recorded: 0,
  ranking_queries: 40,
  ranking_writer_choices_required_for_change: 20,
  ranking_writer_choices_recorded: 0,
  writer_task_results_required: 100,
  writer_task_results_recorded: 0,
  editor_time_seconds_recorded: 0,
  status: 'NOT_MEASURED',
});

const EXPECTED_EXACT_SEARCH_GATE = deepFreeze({
  contract_version: 'm6-1-quality-gates-v2',
  unexpected_result_count: 2,
  mismatched_queries: ['끈', '열'],
  status: 'HOLD',
});

function assertExactKeys(value, expectedKeys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepStrictEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
    `${label} contains missing or unknown fields`,
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function countBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [
    value,
    values.filter((item) => item === value).length,
  ]));
}

function assertDisposition(row, index) {
  const label = `bounded_dispositions[${index}]`;
  const commonKeys = ['unit_type', 'stable_unit_id', 'selection_hash', 'status', 'reason_code'];
  const typeKeys = {
    relation_tuple: commonKeys,
    relation_gap: commonKeys,
    ranking_query: commonKeys,
    exact_key_result_set: [...commonKeys, 'expected_ids', 'actual_ids'],
  };
  assert.equal(typeof row?.unit_type, 'string', `${label}.unit_type is required`);
  assert.ok(Object.hasOwn(typeKeys, row.unit_type), `${label} has an unknown unit_type`);
  assertExactKeys(row, typeKeys[row.unit_type], label);
  assert.equal(typeof row.stable_unit_id, 'string', `${label}.stable_unit_id must be a string`);
  assert.ok(row.stable_unit_id.length > 0, `${label}.stable_unit_id must not be empty`);
  assert.equal(row.status, 'held', `${label}.status must remain held pending evidence/policy`);

  const reasonByType = {
    relation_tuple: 'independent_judgments_not_recorded',
    relation_gap: 'independent_judgments_not_recorded',
    ranking_query: 'writer_choice_outcomes_not_recorded',
    exact_key_result_set: 'm6_1_v2_vs_m6_2_m6_3_contract_conflict',
  };
  assert.equal(row.reason_code, reasonByType[row.unit_type], `${label}.reason_code disagrees with its type`);

  if (row.unit_type === 'exact_key_result_set') {
    assert.equal(row.selection_hash, null, `${label}.selection_hash must be null for exhaustive gate findings`);
    assert.ok(Array.isArray(row.expected_ids) && row.expected_ids.every((id) => typeof id === 'string'));
    assert.ok(Array.isArray(row.actual_ids) && row.actual_ids.every((id) => typeof id === 'string'));
  } else {
    assert.match(row.selection_hash, /^[0-9a-f]{64}$/u, `${label}.selection_hash must be a SHA-256 digest`);
  }
}

export function assertM6_5CalibrationManifest(manifest) {
  assertExactKeys(manifest, [
    'schema_version',
    'calibration_id',
    'issue',
    'decision',
    'source',
    'disposition_counts',
    'disposition_counts_by_type',
    'bounded_dispositions',
    'relation_calibration',
    'workload',
    'exact_search_gate',
  ], 'M6-5 calibration');
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.calibration_id, 'm6-5-bounded-correction-calibration-v1');
  assert.equal(manifest.issue, 177);
  assert.equal(manifest.decision, 'HOLD');

  assertExactKeys(manifest.source, Object.keys(M6_5_FROZEN_SOURCE_IDENTITY), 'source');
  assert.deepStrictEqual(manifest.source, M6_5_FROZEN_SOURCE_IDENTITY, 'source identity changed');

  assert.ok(Array.isArray(manifest.bounded_dispositions));
  const unitIds = new Set();
  for (const [index, row] of manifest.bounded_dispositions.entries()) {
    assertDisposition(row, index);
    const identity = `${row.unit_type}\u0000${row.stable_unit_id}`;
    assert.ok(!unitIds.has(identity), `duplicate disposition ${identity}`);
    unitIds.add(identity);
  }

  const derivedCounts = Object.fromEntries(['corrected', 'held', 'rejected'].map((status) => [
    status,
    manifest.bounded_dispositions.filter((row) => row.status === status).length,
  ]));
  assertExactKeys(manifest.disposition_counts, ['corrected', 'held', 'rejected'], 'disposition_counts');
  assert.deepStrictEqual(manifest.disposition_counts, derivedCounts, 'disposition counts do not match rows');
  assert.deepStrictEqual(manifest.disposition_counts, EXPECTED_DISPOSITION_COUNTS);

  const derivedCountsByType = countBy(manifest.bounded_dispositions.map(({ unit_type }) => unit_type));
  assertExactKeys(
    manifest.disposition_counts_by_type,
    Object.keys(EXPECTED_DISPOSITION_COUNTS_BY_TYPE),
    'disposition_counts_by_type',
  );
  assert.deepStrictEqual(
    manifest.disposition_counts_by_type,
    derivedCountsByType,
    'disposition type counts do not match rows',
  );
  assert.deepStrictEqual(manifest.disposition_counts_by_type, EXPECTED_DISPOSITION_COUNTS_BY_TYPE);
  assert.equal(
    sha256(Buffer.from(JSON.stringify(manifest.bounded_dispositions))),
    M6_5_FROZEN_DISPOSITIONS_SHA256,
    'bounded case identities or dispositions changed',
  );

  const exactFindings = manifest.bounded_dispositions.filter(
    ({ unit_type }) => unit_type === 'exact_key_result_set',
  );
  assert.deepStrictEqual(exactFindings, EXPECTED_EXACT_KEY_FINDINGS);
  assertExactKeys(manifest.relation_calibration, Object.keys(EXPECTED_RELATION_CALIBRATION), 'relation_calibration');
  assert.deepStrictEqual(manifest.relation_calibration, EXPECTED_RELATION_CALIBRATION);
  assertExactKeys(manifest.workload, Object.keys(EXPECTED_WORKLOAD), 'workload');
  assert.deepStrictEqual(manifest.workload, EXPECTED_WORKLOAD);
  assertExactKeys(manifest.exact_search_gate, Object.keys(EXPECTED_EXACT_SEARCH_GATE), 'exact_search_gate');
  assert.deepStrictEqual(manifest.exact_search_gate, EXPECTED_EXACT_SEARCH_GATE);

  return {
    calibration_id: manifest.calibration_id,
    decision: manifest.decision,
    disposition_counts: manifest.disposition_counts,
  };
}

export function assertM6_5CalibrationHistoricalSnapshot({ manifest, manifestBytes }) {
  assert.ok(Buffer.isBuffer(manifestBytes), 'manifestBytes must be a Buffer');
  assert.equal(
    sha256(manifestBytes),
    M6_5_FROZEN_MANIFEST_SHA256,
    'M6-5 historical checkpoint bytes changed',
  );
  assert.deepStrictEqual(
    JSON.parse(manifestBytes.toString('utf8')),
    manifest,
    'parsed M6-5 snapshot differs from its pinned bytes',
  );
  return assertM6_5CalibrationManifest(manifest);
}

export async function validateM6_5CalibrationSnapshot({
  repositoryDirectory = DEFAULT_REPOSITORY_DIRECTORY,
} = {}) {
  const manifestBytes = await readFile(path.join(repositoryDirectory, DEFAULT_MANIFEST_PATH));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  return assertM6_5CalibrationHistoricalSnapshot({ manifest, manifestBytes });
}

async function main() {
  const result = await validateM6_5CalibrationSnapshot();
  console.log(
    `M6-5 historical checkpoint verified: ${result.calibration_id}; `
    + `${result.disposition_counts.held} held decisions; `
    + `sha256=${M6_5_FROZEN_MANIFEST_SHA256}`,
  );
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  await main();
}

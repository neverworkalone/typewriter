import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertM6_5CalibrationHistoricalSnapshot,
  assertM6_5CalibrationManifest,
  M6_5_FROZEN_MANIFEST_SHA256,
  M6_5_FROZEN_SOURCE_IDENTITY,
  validateM6_5CalibrationSnapshot,
} from '../scripts/validate/m6-5-correction-calibration.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_RELATIVE_PATH = 'data/validation/m6-5-correction-calibration.json';

async function readManifest(repositoryDirectory = REPOSITORY_DIRECTORY) {
  const manifestBytes = await readFile(path.join(repositoryDirectory, MANIFEST_RELATIVE_PATH));
  return {
    manifestBytes,
    manifest: JSON.parse(manifestBytes.toString('utf8')),
  };
}

test('M6-5 frozen checkpoint validates its closed shape and complete issue-start source identity', async () => {
  const { manifest, manifestBytes } = await readManifest();
  assert.equal(assertM6_5CalibrationManifest(manifest).decision, 'HOLD');
  assert.deepEqual(manifest.source, M6_5_FROZEN_SOURCE_IDENTITY);
  assert.equal(manifest.source.canonical_file_count, 13);
  assert.deepEqual(Object.keys(manifest.source.issue_start_runtime_sha256).sort(), [
    'scripts/build/query.mjs',
    'scripts/inflection/surface-form-projection.mjs',
    'scripts/validate/m6-1-quality-baseline.mjs',
    'src/domain/exact-search-candidates.js',
    'src/runtime/search-query.js',
  ]);
  assert.equal(
    assertM6_5CalibrationHistoricalSnapshot({ manifest, manifestBytes }).disposition_counts.held,
    284,
  );
  assert.equal(
    (await validateM6_5CalibrationSnapshot()).decision,
    'HOLD',
  );
  assert.match(M6_5_FROZEN_MANIFEST_SHA256, /^[0-9a-f]{64}$/u);
});

test('M6-5 verifier rejects status, count, source, case, workload, gate, and unknown-field tampering', async () => {
  const { manifest } = await readManifest();
  const mutations = [
    ['decision status', (value) => { value.decision = 'PASS'; }],
    ['source binding', (value) => { value.source.m6_4_sample_sha256 = 'a'.repeat(64); }],
    ['case disposition', (value) => { value.bounded_dispositions[0].status = 'corrected'; }],
    ['case identity', (value) => { value.bounded_dispositions[0].stable_unit_id = 'altered-case'; }],
    ['decision count', (value) => { value.disposition_counts.held = 283; }],
    ['workload result', (value) => { value.workload.writer_task_results_recorded = 100; }],
    ['gate status', (value) => { value.exact_search_gate.status = 'PASS'; }],
    ['gate finding count', (value) => { value.exact_search_gate.unexpected_result_count = 0; }],
    ['relation noise claim', (value) => { value.relation_calibration.noise_rate = 0; }],
    ['unknown top-level field', (value) => { value.authorized = true; }],
    ['unknown nested field', (value) => { value.workload.unreviewed_override = true; }],
  ];

  for (const [label, mutate] of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(
      () => assertM6_5CalibrationManifest(changed),
      (error) => error instanceof assert.AssertionError,
      label,
    );
  }
});

test('M6-5 historical verification remains valid when live issue-start inputs have changed', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'm6-5-historical-checkpoint-'));
  const { manifestBytes } = await readManifest();
  try {
    const manifestPath = path.join(temporaryDirectory, MANIFEST_RELATIVE_PATH);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifestBytes);

    const changedInputs = [
      'docs/m6-1-quality-baseline.json',
      'docs/m6-4-quality-audit-sample.json',
      'docs/m6-4-quality-audit-report.md',
      'data/validation/m6-3-surface-form-review.json',
      ...Object.keys(M6_5_FROZEN_SOURCE_IDENTITY.issue_start_runtime_sha256),
    ];
    for (const relativePath of changedInputs) {
      const changedPath = path.join(temporaryDirectory, relativePath);
      await mkdir(path.dirname(changedPath), { recursive: true });
      await writeFile(changedPath, `later issue-start input: ${relativePath}\n`);
    }

    assert.equal((await validateM6_5CalibrationSnapshot({
      repositoryDirectory: temporaryDirectory,
    })).decision, 'HOLD');

    await writeFile(manifestPath, Buffer.concat([manifestBytes, Buffer.from(' ')]));
    await assert.rejects(
      validateM6_5CalibrationSnapshot({ repositoryDirectory: temporaryDirectory }),
      /historical checkpoint bytes changed/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

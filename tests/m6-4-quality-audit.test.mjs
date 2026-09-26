import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertM6QualityAuditHistoricalSnapshot,
  assertM6QualityAuditManifestMatches,
  determineM6QualityAuditVerificationMode,
} from '../scripts/validate/m6-4-quality-audit.mjs';

const digest = 'a'.repeat(64);

function manifestFixture() {
  return {
    audit_id: 'm6-4-writer-facing-quality-audit-v1',
    issue: 176,
    decision: 'HOLD',
    source: {
      baseline_id: 'm6-1-5k-quality-baseline-v1',
      baseline_contract_version: 'm6-1-quality-gates-v2',
      m6_1_baseline_sha256: digest,
      canonical_revision: digest,
      runtime_file_sha256: { 'scripts/build/query.mjs': digest },
    },
    frozen_sampling: {
      ambiguous_queries: {
        cases: [{
          stable_unit_id: '끈',
          selection_hash: digest,
        }],
      },
    },
    review_status: { independent_judgments_recorded: 0 },
  };
}

test('M6-4 verification rebuilds the live sample only while all bound sources match', () => {
  const common = {
    currentCanonicalRevision: 'canonical-v1',
    frozenCanonicalRevision: 'canonical-v1',
    currentRuntimeFileSha256: { 'scripts/build/query.mjs': digest },
    frozenRuntimeFileSha256: { 'scripts/build/query.mjs': digest },
    currentBaselineSha256: digest,
    frozenBaselineSha256: digest,
    currentM6_3ReviewSha256: digest,
    frozenM6_3ReviewSha256: digest,
  };

  assert.equal(determineM6QualityAuditVerificationMode(common), 'rebuild-current-sample');
  assert.equal(determineM6QualityAuditVerificationMode({
    ...common,
    currentCanonicalRevision: 'canonical-v2',
  }), 'verify-frozen-historical-sample');
  assert.equal(determineM6QualityAuditVerificationMode({
    ...common,
    currentRuntimeFileSha256: { 'scripts/build/query.mjs': 'b'.repeat(64) },
  }), 'verify-frozen-historical-sample');
});

test('M6-4 manifest verifier accepts a valid build and rejects altered identity, selection, source, or status', () => {
  const committed = manifestFixture();
  assert.doesNotThrow(() => assertM6QualityAuditManifestMatches(
    committed,
    structuredClone(committed),
  ));

  const mutations = [
    (manifest) => { manifest.frozen_sampling.ambiguous_queries.cases[0].stable_unit_id = '열'; },
    (manifest) => { manifest.frozen_sampling.ambiguous_queries.cases[0].selection_hash = 'b'.repeat(64); },
    (manifest) => { manifest.source.runtime_file_sha256['scripts/build/query.mjs'] = 'b'.repeat(64); },
    (manifest) => { manifest.decision = 'PASS'; },
    (manifest) => { manifest.review_status.independent_judgments_recorded = 1; },
  ];

  for (const mutate of mutations) {
    const tampered = structuredClone(committed);
    mutate(tampered);
    assert.throws(() => assertM6QualityAuditManifestMatches(committed, tampered));
  }
});

test('M6-4 historical snapshot verification accepts its pinned baseline and rejects tampered bytes', () => {
  const manifest = manifestFixture();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const expectedManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const baseline = {
    baseline_id: 'm6-1-5k-quality-baseline-v1',
    quality_gates: { contract_version: 'm6-1-quality-gates-v2' },
    source: { canonical_revision: digest },
  };
  const inputs = {
    manifest,
    baseline,
    baselineSha256: digest,
    manifestBytes,
    expectedManifestSha256,
    runtimePaths: ['scripts/build/query.mjs'],
  };

  assert.doesNotThrow(() => assertM6QualityAuditHistoricalSnapshot(inputs));
  assert.throws(() => assertM6QualityAuditHistoricalSnapshot({
    ...inputs,
    manifestBytes: Buffer.from(`${manifestBytes.toString()} `),
  }), /historical sample bytes changed/);
  assert.throws(() => assertM6QualityAuditHistoricalSnapshot({
    ...inputs,
    baselineSha256: 'b'.repeat(64),
  }), /fixed M6-1 baseline artifact/);
});

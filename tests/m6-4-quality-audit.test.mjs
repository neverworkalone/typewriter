import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertM6QualityAuditHistoricalSnapshot,
  assertM6QualityAuditManifestMatches,
  determineM6QualityAuditVerificationMode,
  M6_4_FROZEN_SOURCE_IDENTITY,
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

test('M6-4 historical snapshot stays valid when current baseline inputs change and rejects tampering', () => {
  const manifest = {
    audit_id: 'm6-4-writer-facing-quality-audit-v1',
    issue: 176,
    decision: 'HOLD',
    source: structuredClone(M6_4_FROZEN_SOURCE_IDENTITY),
    review_status: { selected_canonical_case_count: 282 },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const expectedManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const inputs = {
    manifest,
    manifestBytes,
    expectedManifestSha256,
  };

  const changedBaselineMode = determineM6QualityAuditVerificationMode({
    currentCanonicalRevision: M6_4_FROZEN_SOURCE_IDENTITY.canonical_revision,
    frozenCanonicalRevision: M6_4_FROZEN_SOURCE_IDENTITY.canonical_revision,
    currentRuntimeFileSha256: M6_4_FROZEN_SOURCE_IDENTITY.runtime_file_sha256,
    frozenRuntimeFileSha256: M6_4_FROZEN_SOURCE_IDENTITY.runtime_file_sha256,
    currentBaselineSha256: 'b'.repeat(64),
    frozenBaselineSha256: M6_4_FROZEN_SOURCE_IDENTITY.m6_1_baseline_sha256,
    currentM6_3ReviewSha256: M6_4_FROZEN_SOURCE_IDENTITY.m6_3_surface_form_review_sha256,
    frozenM6_3ReviewSha256: M6_4_FROZEN_SOURCE_IDENTITY.m6_3_surface_form_review_sha256,
  });
  assert.equal(changedBaselineMode, 'verify-frozen-historical-sample');
  assert.doesNotThrow(() => assertM6QualityAuditHistoricalSnapshot(inputs));
  assert.throws(() => assertM6QualityAuditHistoricalSnapshot({
    ...inputs,
    manifestBytes: Buffer.from(`${manifestBytes.toString()} `),
  }), /historical sample bytes changed/);

  const changedSourceManifest = structuredClone(manifest);
  changedSourceManifest.source.m6_1_baseline_sha256 = 'b'.repeat(64);
  const changedSourceBytes = Buffer.from(JSON.stringify(changedSourceManifest));
  assert.throws(() => assertM6QualityAuditHistoricalSnapshot({
    ...inputs,
    manifest: changedSourceManifest,
    manifestBytes: changedSourceBytes,
    expectedManifestSha256: createHash('sha256').update(changedSourceBytes).digest('hex'),
  }), /pinned issue-start source/);
});

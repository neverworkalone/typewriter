import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  M5_12A_BASE_CANONICAL_SHA256,
  M5_12A_DECISION_COUNTS,
  M5_12A_FINAL_SUMMARY,
  buildM512A,
  buildM512AReviewRows,
  commitM512APromotionTransaction,
  validateCandidateIdentityBinding,
  validateM512AFinal,
} from '../scripts/batch/m5-12a-pipeline.mjs';
import {
  M5_12A_IMPORT_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_CANDIDATE_IDENTITIES,
} from '../scripts/batch/m5-12a-candidate-source.mjs';
import { hashCanonicalDirectory } from '../scripts/batch/validate-m5-8-process.mjs';
import { makeM512ACandidateRecord } from '../scripts/batch/m5-12a-pipeline.mjs';

test('M5-12A binds all 802 identities and admits exactly 722 through the shared producer', async () => {
  const result = await buildM512A();

  assert.equal(result.identities.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.artifacts.candidateRecords.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.importedRecords.length, M5_12A_IMPORT_COUNT);
  assert.deepEqual(result.admission.actual, M5_12A_FINAL_SUMMARY);
  assert.deepEqual(result.admission.decisions, {
    ...M5_12A_DECISION_COUNTS,
    deferred_denominator_excluded: true,
  });
  assert.equal(result.admission.gate.gate_status, 'pass');
  assert.equal(result.admission.verification.human_editorial_review_complete, false);
  assert.equal(result.admission.verification.generation_pass_id, 'm5-12a-generation-20260920');
  assert.equal(result.admission.verification.verification_pass_id, 'm5-12a-verification-20260920');
  assert.equal(result.admission.provenance.batch_local_quality_fork, false);
  assert.equal(result.relation.events.length, 0);
});

test('M5-12A rejects identity drift and canonical collisions before admission', async () => {
  const result = await buildM512A();
  const common = {
    baseRecords: result.inputs.baseCanonical.records,
    baseSeed: result.inputs.baseSeed,
  };

  const drifted = structuredClone(result.identities);
  drifted[0].candidate_record_id = 'w9999';
  assert.throws(
    () => validateCandidateIdentityBinding({
      ...common,
      identities: drifted,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'SLOT_SOURCE_DRIFT',
  );

  const collidingIdentities = structuredClone(result.identities);
  const collidingRecords = structuredClone(result.artifacts.candidateRecords);
  collidingIdentities[0].lemma = '담담하다';
  collidingRecords[0].lemma = '담담하다';
  collidingRecords[0].search_forms = ['담담하다'];
  assert.throws(
    () => validateCandidateIdentityBinding({
      ...common,
      identities: collidingIdentities,
      candidateRecords: collidingRecords,
    }),
    (error) => error.code === 'CANDIDATE_COLLISION',
  );
});

test('M5-12A keeps authored decisions bound to candidate identity under permutation', async () => {
  const result = await buildM512A();
  const originalByCandidateId = new Map(result.reviewRows.map((row) => [row.candidate_id, {
    decision: row.decision,
    rank: row.semantic_review.selection.rank,
    score: row.semantic_review.selection.score,
  }]));
  const permutedIdentities = [...M5_12A_CANDIDATE_IDENTITIES].reverse();
  const permutedRows = buildM512AReviewRows({
    identities: permutedIdentities,
    candidateRecords: permutedIdentities.map(makeM512ACandidateRecord),
    semanticDecisionSource: result.semanticDecisionSource,
  });

  assert.notDeepEqual(
    permutedRows.map((row) => row.candidate_id),
    result.reviewRows.map((row) => row.candidate_id),
  );
  for (const row of permutedRows) {
    assert.deepEqual(originalByCandidateId.get(row.candidate_id), {
      decision: row.decision,
      rank: row.semantic_review.selection.rank,
      score: row.semantic_review.selection.score,
    });
  }
});

test('M5-12A shared production rejects copied semantic evidence before admission', async () => {
  const result = await buildM512A();
  const reviews = structuredClone(result.reviewRows);
  reviews[0].semantic_review.authored_decision.candidate_record_sha256 = '0'.repeat(64);

  await assert.rejects(
    () => import('../scripts/batch/lexical-production.mjs').then(({ validateLexicalProduction }) => (
      validateLexicalProduction({
        batchId: 'm5-12a-expansion-20260920',
        candidateRecords: result.artifacts.candidateRecords,
        reviews,
        baseRecords: result.inputs.baseCanonical.records,
        prospectiveRecords: result.prospective.canonical.records,
        semanticAudit: result.semanticAudit,
        productionState: result.production.production_state,
        productionStateSources: result.production.production_state_sources,
        productionPayloads: result.production.production_payloads,
        catalogCount: M5_12A_SELECTION_COUNT,
        expectedSelectedCount: M5_12A_IMPORT_COUNT,
        checkPilotCompleteness: true,
      })
    )),
    (error) => error.code === 'LEXICAL_SEMANTIC_BINDING',
  );
});

test('M5-12A final promotion preserves the exact canonical, seed, and semantic authority digests', async () => {
  const result = await validateM512AFinal();

  assert.deepEqual(result.current, M5_12A_FINAL_SUMMARY);
  assert.equal(result.gate.gate_status, 'pass');
  assert.equal(result.semantic_audit.coverage_complete, true);
  assert.equal(result.semantic_audit.review_complete, true);
});

test('M5-12A promotion rolls back every output when the committed canonical digest drifts', async () => {
  const result = await buildM512A();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-rollback-'));
  const currentCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const currentSeedPath = path.join(temporaryDirectory, 'seed.json');
  const decisionSourcePath = path.join(temporaryDirectory, 'decision-source.json');
  const canonicalImportPath = path.join(currentCanonicalDirectory, 'm5-12a-expansion.jsonl');
  const admissionPath = path.join(temporaryDirectory, 'admission.json');
  const promotionPath = path.join(temporaryDirectory, 'promotion.json');

  try {
    await cp(path.resolve('data/batches/m5-12-base-canonical'), currentCanonicalDirectory, { recursive: true });
    await writeFile(currentSeedPath, result.inputs.baseSeedBytes);
    await writeFile(decisionSourcePath, result.inputs.currentDecisionSourceBytes);
    const beforeCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const beforeSeedBytes = await readFile(currentSeedPath);
    const beforeDecisionSourceBytes = await readFile(decisionSourcePath);

    const driftedResult = {
      ...result,
      prospective: {
        ...result.prospective,
        importBytes: Buffer.from('not-jsonl-canonical-data\n', 'utf8'),
      },
    };
    await assert.rejects(
      commitM512APromotionTransaction({
        result: driftedResult,
        currentCanonicalDirectory,
        currentSeedPath,
        decisionSourcePath,
        canonicalImportPath,
        admissionPath,
        promotionPath,
      }),
      (error) => error.code === 'PROMOTION_DIGEST_MISMATCH',
    );

    assert.equal(await hashCanonicalDirectory(currentCanonicalDirectory), beforeCanonicalDigest);
    assert.equal(beforeCanonicalDigest, M5_12A_BASE_CANONICAL_SHA256);
    assert.deepEqual(await readFile(currentSeedPath), beforeSeedBytes);
    assert.deepEqual(await readFile(decisionSourcePath), beforeDecisionSourceBytes);
    await assert.rejects(stat(canonicalImportPath), { code: 'ENOENT' });
    await assert.rejects(stat(admissionPath), { code: 'ENOENT' });
    await assert.rejects(stat(promotionPath), { code: 'ENOENT' });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-12A rejects a failed preflight without mutating promotion outputs', async () => {
  const result = await buildM512A();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-preflight-rollback-'));
  const currentCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const currentSeedPath = path.join(temporaryDirectory, 'seed.json');
  const decisionSourcePath = path.join(temporaryDirectory, 'decision-source.json');
  const canonicalImportPath = path.join(currentCanonicalDirectory, 'm5-12a-expansion.jsonl');
  const admissionPath = path.join(temporaryDirectory, 'admission.json');
  const promotionPath = path.join(temporaryDirectory, 'promotion.json');

  try {
    await cp(path.resolve('data/batches/m5-12-base-canonical'), currentCanonicalDirectory, { recursive: true });
    await writeFile(currentSeedPath, result.inputs.baseSeedBytes);
    await writeFile(decisionSourcePath, result.inputs.currentDecisionSourceBytes);
    const beforeCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const beforeSeedBytes = await readFile(currentSeedPath);
    const beforeDecisionSourceBytes = await readFile(decisionSourcePath);
    const failedPreflight = {
      ...result,
      preflight: {
        ...result.preflight,
        checks: {
          ...result.preflight.checks,
          package_validation: {
            ...result.preflight.checks.package_validation,
            status: 'fail',
          },
        },
      },
    };

    await assert.rejects(
      commitM512APromotionTransaction({
        result: failedPreflight,
        currentCanonicalDirectory,
        currentSeedPath,
        decisionSourcePath,
        canonicalImportPath,
        admissionPath,
        promotionPath,
      }),
      (error) => error.code === 'PROMOTION_PREFLIGHT_REQUIRED',
    );

    assert.equal(await hashCanonicalDirectory(currentCanonicalDirectory), beforeCanonicalDigest);
    assert.deepEqual(await readFile(currentSeedPath), beforeSeedBytes);
    assert.deepEqual(await readFile(decisionSourcePath), beforeDecisionSourceBytes);
    await assert.rejects(stat(canonicalImportPath), { code: 'ENOENT' });
    await assert.rejects(stat(admissionPath), { code: 'ENOENT' });
    await assert.rejects(stat(promotionPath), { code: 'ENOENT' });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

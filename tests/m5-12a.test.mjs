import { createHash } from 'node:crypto';
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
  M5_12A_FINAL_SUMMARY,
  buildM512A,
  buildM512AReviewRows,
  commitM512APromotionTransaction,
  validateCandidateIdentityBinding,
  validateM512AFinal,
} from '../scripts/batch/m5-12a-pipeline.mjs';
import {
  M5_12A_IMPORT_COUNT,
  M5_12A_RESERVE_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_CANDIDATE_IDENTITIES,
} from '../scripts/batch/m5-12a-candidate-source.mjs';
import {
  serializeM512ADecisionSource,
  validateM512ADecisionSource,
} from '../scripts/batch/m5-12a-decision-source.mjs';
import { hashCanonicalDirectory } from '../scripts/batch/validate-m5-8-process.mjs';
import { makeM512ACandidateRecord } from '../scripts/batch/m5-12a-pipeline.mjs';
import {
  buildM512ASemanticDecisionScaffold,
} from '../scripts/batch/build-m5-12a-decision-scaffold.mjs';

test('M5-12A binds all 802 identities and admits exactly 722 through the shared producer', async () => {
  const result = await buildM512A();

  assert.equal(result.identities.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.artifacts.candidateRecords.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.importedRecords.length, M5_12A_IMPORT_COUNT);
  assert.deepEqual(result.admission.actual, M5_12A_FINAL_SUMMARY);
  const decisions = result.admission.decisions;
  const processed = decisions.included + decisions.corrected + decisions.held + decisions.rejected;
  assert.equal(decisions.included + decisions.corrected, M5_12A_IMPORT_COUNT);
  assert.ok(decisions.held + decisions.rejected <= M5_12A_RESERVE_COUNT);
  assert.equal(decisions.processed_start_count, processed);
  assert.equal(decisions.deferred, M5_12A_SELECTION_COUNT - processed);
  assert.equal(decisions.deferred_denominator_excluded, true);
  assert.equal(result.admission.gate.gate_status, 'pass');
  assert.equal(result.admission.verification.human_editorial_review_complete, false);
  assert.equal(result.admission.verification.generation_pass_id, 'm5-12a-generation-20260920');
  assert.equal(result.admission.verification.verification_pass_id, 'm5-12a-agent-semantic-review-20260920-r2');
  assert.equal(result.admission.provenance.batch_local_quality_fork, false);
  assert.equal(result.relation.events.length, 0);
});

test('M5-12A decision scaffolding cannot manufacture or overwrite semantic authority', async () => {
  const sourcePath = path.resolve('data/batches/m5-12a-semantic-decisions.json');
  const sourceBefore = await readFile(sourcePath);
  const source = JSON.parse(sourceBefore);
  const scaffold = buildM512ASemanticDecisionScaffold();

  assert.equal(scaffold.candidates.length, M5_12A_SELECTION_COUNT);
  assert.equal(scaffold.candidate_source.identity_count, M5_12A_SELECTION_COUNT);
  assert.ok(scaffold.candidates.every((candidate) => (
    Object.keys(candidate).sort().join(',')
    === 'candidate_record_id,candidate_record_sha256,inventory_id,sense_id'
  )));
  assert.ok(scaffold.candidates.every((candidate) => (
    !Object.prototype.hasOwnProperty.call(candidate, 'decision')
    && !Object.prototype.hasOwnProperty.call(candidate, 'rank')
    && !Object.prototype.hasOwnProperty.call(candidate, 'score')
  )));
  assert.notEqual(
    createHash('sha256').update(sourceBefore).digest('hex'),
    '7c655a342a23223b8a4039e126abd2b789edfb21',
    'the durable source must not remain the artifact produced by the removed generator',
  );
  assert.equal(source.review.review_pass_id, 'm5-12a-agent-semantic-review-20260920-r2');
  assert.equal(source.review.reviewed_candidate_count, M5_12A_SELECTION_COUNT);
  assert.equal(source.provenance.generator_version, 'm5-12a-authored-semantic-review-v2');
  assert.equal(source.provenance.human_reviewed, false);
  const identityByCandidateId = new Map(M5_12A_CANDIDATE_IDENTITIES.map((identity) => [identity.candidate_record_id, identity]));
  const admittedExpressionCount = source.decisions.filter((row) => (
    identityByCandidateId.get(row.candidate_record_id).axis === 'X'
      && ['included', 'corrected'].includes(row.decision)
  )).length;
  const nonExpressionReserveCount = source.decisions.filter((row) => (
    identityByCandidateId.get(row.candidate_record_id).axis !== 'X'
      && ['held', 'rejected', 'deferred'].includes(row.decision)
  )).length;
  assert.ok(admittedExpressionCount > 2, 'the authored review must not retain the old non-expression cutoff');
  assert.ok(nonExpressionReserveCount > 0, 'the authored review must record semantic holds outside the expression axis');
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});

test('M5-12A decision contract accepts a different legal outcome distribution', async () => {
  const result = await buildM512A();
  const source = structuredClone(result.semanticDecisionSource.source);
  let movedToHeld = 0;
  let movedToIncluded = 0;
  for (const row of source.decisions) {
    if (row.decision === 'included' && movedToHeld < 10) {
      row.decision = 'held';
      movedToHeld += 1;
    } else if (row.decision === 'deferred' && movedToIncluded < 10) {
      row.decision = 'included';
      movedToIncluded += 1;
    }
  }
  const alternate = serializeM512ADecisionSource(source);
  const validated = validateM512ADecisionSource({
    source: alternate.source,
    sourceBytes: alternate.bytes,
    identities: result.identities,
    candidateRecords: result.artifacts.candidateRecords,
  });

  assert.equal(validated.counts.included, 700);
  assert.equal(validated.counts.corrected, 22);
  assert.equal(validated.counts.held, 40);
  assert.equal(validated.counts.rejected, 20);
  assert.equal(validated.counts.deferred, 20);

  const invalid = structuredClone(result.semanticDecisionSource.source);
  invalid.decisions.find(({ decision }) => decision === 'included').decision = 'held';
  const invalidSerialized = serializeM512ADecisionSource(invalid);
  assert.throws(
    () => validateM512ADecisionSource({
      source: invalidSerialized.source,
      sourceBytes: invalidSerialized.bytes,
      identities: result.identities,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'M5_12A_DECISION_SOURCE_SCOPE',
  );
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

test('M5-12A shared production rejects an altered authored correction output', async () => {
  const result = await buildM512A();
  const reviews = structuredClone(result.reviewRows);
  const corrected = reviews.find(({ decision }) => decision === 'corrected');
  corrected.reviewed_record.search_forms.push('unauthorized-correction');

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

test('M5-12A rejects a failed shared product preflight without mutating promotion outputs', async () => {
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
          search_product_regression: {
            ...result.preflight.checks.search_product_regression,
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

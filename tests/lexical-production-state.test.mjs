import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEXICAL_PRODUCTION_STAGE_IDS,
  createLexicalProductionRun,
  createLexicalProductionState,
  productionSourceBytes,
  productionStageBytes,
  validateLexicalProductionState,
} from '../scripts/batch/lexical-production-state.mjs';

function makeRun(batchId = 'future-batch-2040') {
  const run = createLexicalProductionRun({ batchId });
  const stageBytes = (stageId, value) => productionStageBytes(
    stageId,
    productionSourceBytes({ batch_id: batchId, stage: stageId, value }),
  );
  const candidateIntake = run.completeCandidateIntake({
    sourcePath: `external:${batchId}:candidate-intake`,
    sourceBytes: stageBytes('candidate_intake', 1),
  });
  const semanticReview = run.completeSemanticReview({
    predecessor: candidateIntake,
    sourcePath: `external:${batchId}:semantic-review`,
    sourceBytes: stageBytes('semantic_review', 2),
  });
  const selection = run.completeSelection({
    predecessor: semanticReview,
    sourcePath: `external:${batchId}:selection`,
    sourceBytes: stageBytes('selection', 3),
    policy: 'shared-quality-and-reviewed-selection-v2',
  });
  const prospectiveCanonical = run.completeProspectiveCanonical({
    predecessor: selection,
    sourcePath: `external:${batchId}:prospective-canonical`,
    sourceBytes: stageBytes('prospective_canonical', 4),
  });
  const preAudit = run.getPreAuditState();
  assert.equal(preAudit.status, 'awaiting-audit');
  assert.equal(preAudit.stages.length, 4);
  assert.throws(
    () => run.getPreAdmissionState(),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_INCOMPLETE',
  );
  const audit = run.completeAudit({
    predecessor: prospectiveCanonical,
    sourcePath: `external:${batchId}:audit`,
    sourceBytes: stageBytes('audit', 5),
  });
  const authorization = run.authorizeAdmission({
    predecessor: audit,
    authorizationRef: `${batchId}:authorization`,
    authorizationBytes: productionSourceBytes({ batch_id: batchId, authorization: true }),
  });
  const admission = run.completeAdmission({
    authorization,
    sourcePath: `external:${batchId}:admission`,
    sourceBytes: stageBytes('admission', 6),
    admissionResult: {
      status: 'admitted',
      gate_digest: '0'.repeat(64),
    },
  });
  return {
    run,
    admission,
    state: run.getState(),
    sourceBytesByStage: run.getSourceBytesByStage(),
  };
}

test('shared producer emits and validates all six transitions with lineage', () => {
  const { state, sourceBytesByStage } = makeRun();
  const result = validateLexicalProductionState(state, {
    batchId: 'future-batch-2040',
    sourceBytesByStage,
  });

  assert.equal(result.stage_count, 6);
  assert.deepEqual(
    result.stages.map(({ id }) => id),
    LEXICAL_PRODUCTION_STAGE_IDS,
  );
  assert.equal(result.stages.at(-1).decision, 'admit');
  assert.equal(result.stages.at(-1).admission_status, 'admitted');
  assert.equal(result.stages[0].input_sha256, null);
  assert.equal(result.stages[1].predecessor.stage_id, 'candidate_intake');
  assert.equal(result.stages[1].input_sha256, result.stages[0].output_sha256);
  assert.ok(result.stages.every((stage) => stage.transition_sha256));
});

test('post-hoc descriptors and fabricated pre-admission admission fail closed', () => {
  assert.throws(
    () => createLexicalProductionState({
      batchId: 'future-batch-2041',
      stages: Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((id) => [id, {}])),
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );

  const run = createLexicalProductionRun({ batchId: 'future-batch-2041' });
  const stageBytes = (stageId, value) => productionStageBytes(
    stageId,
    productionSourceBytes({ stage_id: stageId, value }),
  );
  const candidate = run.completeCandidateIntake({ sourcePath: 'candidate', sourceBytes: stageBytes('candidate_intake', 1) });
  const review = run.completeSemanticReview({ predecessor: candidate, sourcePath: 'review', sourceBytes: stageBytes('semantic_review', 2) });
  const selection = run.completeSelection({ predecessor: review, sourcePath: 'selection', sourceBytes: stageBytes('selection', 3), policy: 'shared' });
  const prospective = run.completeProspectiveCanonical({ predecessor: selection, sourcePath: 'prospective', sourceBytes: stageBytes('prospective_canonical', 4) });
  const audit = run.completeAudit({ predecessor: prospective, sourcePath: 'audit', sourceBytes: stageBytes('audit', 5) });
  assert.throws(
    () => run.getState(),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_NOT_ADMITTED',
  );
  assert.throws(
    () => run.completeAdmission({
      predecessor: audit,
      sourcePath: 'admission',
      sourceBytes: stageBytes('admission', 6),
      admissionResult: { status: 'admitted', gate_digest: '0'.repeat(64) },
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION',
  );
  const authorization = run.authorizeAdmission({
    predecessor: audit,
    authorizationRef: 'future-batch-2041:authorization',
    authorizationBytes: productionSourceBytes({ authorization: true }),
  });
  assert.throws(
    () => run.completeAdmission({
      authorization,
      sourcePath: 'admission',
      sourceBytes: stageBytes('admission', 6),
      admissionResult: { status: 'pending', gate_digest: '0'.repeat(64) },
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION',
  );
});

test('producer rejects omitted predecessors, reused payloads, and stale source bytes', () => {
  const run = createLexicalProductionRun({ batchId: 'future-batch-2042' });
  const raw = productionSourceBytes({ same: true });
  const candidate = run.completeCandidateIntake({
    sourcePath: 'candidate',
    sourceBytes: productionStageBytes('candidate_intake', raw),
  });
  assert.throws(
    () => run.completeSelection({
      predecessor: candidate,
      sourcePath: 'selection',
      sourceBytes: productionStageBytes('selection', raw),
      policy: 'shared',
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );

  const valid = makeRun('future-batch-2043');
  const stale = { ...valid.sourceBytesByStage, audit: productionStageBytes('audit', productionSourceBytes({ stale: true })) };
  assert.throws(
    () => validateLexicalProductionState(valid.state, { sourceBytesByStage: stale }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  assert.throws(
    () => validateLexicalProductionState(valid.state, {
      batchId: 'future-batch-special-case',
      sourceBytesByStage: valid.sourceBytesByStage,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_SCOPE',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEXICAL_PRODUCTION_STAGE_IDS,
  createLexicalProductionPayload,
  createLexicalProductionRun,
  createLexicalProductionState,
  productionSourceBytes,
  productionStageBytes,
  productionValueSha256,
  validateLexicalProductionState,
} from '../scripts/batch/lexical-production-state.mjs';

function payloadFor(stageId, batchId, input, output, inputKind, outputKind, details) {
  return {
    stageId,
    batchId,
    input,
    output,
    inputKind,
    outputKind,
    details,
  };
}

function typedRecord(id, lemma = id) {
  return {
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma,
    search_forms: [lemma],
    senses: [{
      id: `${id}-s1`,
      pos: 'noun',
      gloss: `${lemma} reviewed sense`,
    }],
  };
}

function emitThroughAudit(batchId) {
  const run = createLexicalProductionRun({ batchId });
  const candidateOutput = [typedRecord(`${batchId}:candidate`, 'candidate')];
  const reviewedRecord = typedRecord(`${batchId}:reviewed`, 'reviewed');
  const reviewRows = [{
    candidate_id: `${batchId}:candidate`,
    decision: 'included',
    semantic_review: {},
    reviewed_record: reviewedRecord,
  }];
  const reviewedValues = [reviewedRecord];
  const reviewOutput = { review_rows: reviewRows, reviewed_records: reviewedValues };
  const selectionOutput = { selected_records: reviewedValues, selection_ranks: [1] };
  const prospectiveOutput = [typedRecord(`${batchId}:prospective`, 'prospective')];
  const auditOutput = {
    prospective_records_sha256: productionValueSha256(prospectiveOutput),
    semantic_audit_sha256: productionValueSha256({ semantic_audit: batchId }),
    lexical_audit_sha256: productionValueSha256({ lexical_audit: batchId }),
  };
  const payloadSpecs = {
    candidate_intake: payloadFor(
      'candidate_intake', batchId, null, candidateOutput,
      'none', 'candidate-records', {
        candidate_records_sha256: productionValueSha256(candidateOutput),
        candidate_count: candidateOutput.length,
      },
    ),
    semantic_review: payloadFor(
      'semantic_review', batchId, candidateOutput, reviewOutput,
      'candidate-records', 'reviewed-records', {
        candidate_records_sha256: productionValueSha256(candidateOutput),
        review_rows_sha256: productionValueSha256(reviewRows),
        reviewed_records_sha256: productionValueSha256(reviewedValues),
      },
    ),
    selection: payloadFor(
      'selection', batchId, reviewOutput, selectionOutput,
      'reviewed-records', 'selected-records', {
        reviewed_records_sha256: productionValueSha256(reviewedValues),
        selected_records_sha256: productionValueSha256(reviewedValues),
        selection_ranks_sha256: productionValueSha256([1]),
      },
    ),
    prospective_canonical: payloadFor(
      'prospective_canonical', batchId, selectionOutput, prospectiveOutput,
      'selected-records', 'prospective-canonical', {
        base_records_sha256: productionValueSha256([]),
        prospective_records_sha256: productionValueSha256(prospectiveOutput),
      },
    ),
    audit: payloadFor(
      'audit', batchId, prospectiveOutput, auditOutput,
      'prospective-canonical', 'complete-canonical-audit', {
        ...auditOutput,
      },
    ),
  };
  const payloads = Object.fromEntries(
    Object.entries(payloadSpecs).map(([stageId, spec]) => [
      stageId,
      createLexicalProductionPayload(spec),
    ]),
  );
  const candidateIntake = run.completeCandidateIntake({
    sourcePath: `external:${batchId}:candidate-intake`, payloadSpec: payloadSpecs.candidate_intake,
  });
  const semanticReview = run.completeSemanticReview({
    predecessor: candidateIntake, sourcePath: `external:${batchId}:semantic-review`, payloadSpec: payloadSpecs.semantic_review,
  });
  const selection = run.completeSelection({
    predecessor: semanticReview, sourcePath: `external:${batchId}:selection`, payloadSpec: payloadSpecs.selection,
    policy: 'shared-quality-and-reviewed-selection-v2',
  });
  const prospectiveCanonical = run.completeProspectiveCanonical({
    predecessor: selection, sourcePath: `external:${batchId}:prospective-canonical`, payloadSpec: payloadSpecs.prospective_canonical,
  });
  const audit = run.completeAudit({
    predecessor: prospectiveCanonical, sourcePath: `external:${batchId}:audit`, payloadSpec: payloadSpecs.audit,
  });
  return { run, audit, auditOutput, payloads, payloadSpecs };
}

function makeRun(batchId = 'future-batch-2040') {
  const { run, audit, auditOutput, payloads, payloadSpecs } = emitThroughAudit(batchId);
  const authorization = run.authorizeAdmission({
    predecessor: audit,
    authorizationRef: `${batchId}:authorization`,
    authorizationBytes: productionSourceBytes({ batch_id: batchId, authorization: true }),
  });
  const admissionOutput = { status: 'admitted', gate_digest: '0'.repeat(64) };
  payloadSpecs.admission = payloadFor(
    'admission', batchId, auditOutput, admissionOutput,
    'complete-canonical-audit', 'admitted-canonical', {
      authorization_sha256: authorization.authorization_sha256, gate_sha256: admissionOutput.gate_digest,
    },
  );
  payloads.admission = createLexicalProductionPayload(payloadSpecs.admission);
  const admission = run.completeAdmission({
    authorization, sourcePath: `external:${batchId}:admission`, payloadSpec: payloadSpecs.admission, admissionResult: admissionOutput,
  });
  return {
    run, admission, state: run.getState(), sourceBytesByStage: run.getSourceBytesByStage(), payloads,
  };
}

test('shared producer emits and validates all six transitions with lineage', () => {
  const { state, sourceBytesByStage, payloads } = makeRun();
  const result = validateLexicalProductionState(state, {
    batchId: 'future-batch-2040', sourceBytesByStage, expectedPayloads: payloads,
  });
  assert.equal(result.stage_count, 6);
  assert.deepEqual(result.stages.map(({ id }) => id), LEXICAL_PRODUCTION_STAGE_IDS);
  assert.equal(result.stages.at(-1).decision, 'admit');
  assert.equal(result.stages.at(-1).admission_status, 'admitted');
  assert.equal(result.stages[0].input_sha256, null);
  assert.equal(result.stages[1].predecessor.stage_id, 'candidate_intake');
  assert.equal(result.stages[1].input_sha256, result.stages[0].output_sha256);
  assert.ok(result.stages.every((stage) => stage.transition_sha256));
  assert.ok(result.stages.every((stage) => stage.payload_mode === 'live'));
});

test('post-hoc descriptors and fabricated pre-admission admission fail closed', () => {
  assert.throws(
    () => createLexicalProductionState({
      batchId: 'future-batch-2041', stages: Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((id) => [id, {}])),
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );
  const { run, audit, payloads } = emitThroughAudit('future-batch-2041');
  assert.throws(() => run.getState(), (error) => error.code === 'LEXICAL_PRODUCTION_STATE_NOT_ADMITTED');
  assert.throws(
    () => run.completeAdmission({
      predecessor: audit, sourcePath: 'admission', payload: payloads.audit,
      admissionResult: { status: 'admitted', gate_digest: '0'.repeat(64) },
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION',
  );
  const authorization = run.authorizeAdmission({
    predecessor: audit, authorizationRef: 'future-batch-2041:authorization', authorizationBytes: productionSourceBytes({ authorization: true }),
  });
  assert.throws(
    () => run.completeAdmission({
      authorization, sourcePath: 'admission', payload: payloads.audit,
      admissionResult: { status: 'pending', gate_digest: '0'.repeat(64) },
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION',
  );
});

test('producer rejects omitted predecessors, reused payloads, and stale source bytes', () => {
  const run = createLexicalProductionRun({ batchId: 'future-batch-2042' });
  const fabricatedCandidate = [{ id: 'future-batch-2042:candidate' }];
  assert.throws(
    () => createLexicalProductionPayload({
      stageId: 'candidate_intake',
      batchId: 'future-batch-2042',
      input: null,
      output: fabricatedCandidate,
      inputKind: 'none',
      outputKind: 'candidate-records',
      details: {
        candidate_records_sha256: productionValueSha256(fabricatedCandidate),
        candidate_count: fabricatedCandidate.length,
      },
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_VALUE',
  );
  assert.throws(
    () => run.completeCandidateIntake({ sourcePath: 'candidate', sourceBytes: productionSourceBytes({ same: true }) }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );
  assert.throws(
    () => run.completeCandidateIntake({ sourcePath: 'candidate', payload: { arbitrary: true } }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );
  const valid = makeRun('future-batch-2043');
  const stale = { ...valid.sourceBytesByStage, audit: productionStageBytes('audit', productionSourceBytes({ stale: true })) };
  assert.throws(
    () => validateLexicalProductionState(valid.state, { sourceBytesByStage: stale, expectedPayloads: valid.payloads }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_BINDING',
  );
  assert.throws(
    () => validateLexicalProductionState(valid.state, {
      batchId: 'future-batch-special-case', sourceBytesByStage: valid.sourceBytesByStage, expectedPayloads: valid.payloads,
    }),
    (error) => error.code === 'LEXICAL_PRODUCTION_STATE_SCOPE',
  );
});

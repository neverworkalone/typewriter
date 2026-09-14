import { createHash } from 'node:crypto';

export const LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION = 'lexical-production-state-v2';
export const LEXICAL_PRODUCTION_PIPELINE_VERSION = 'lexical-production-v1';
export const LEXICAL_PRODUCTION_STAGE_SOURCE_CONTRACT_VERSION = 'lexical-production-stage-source-v1';
export const LEXICAL_PRODUCTION_PAYLOAD_CONTRACT_VERSION = 'lexical-production-payload-v1';
const LEXICAL_PRODUCTION_REPLAY_PAYLOAD_CONTRACT_VERSION = 'lexical-production-replay-payload-v1';

/**
 * Every lexical producer uses the same state machine. Batch modules may
 * constrain scope, counts, IDs, timing, or authorization, but they cannot
 * remove a producer transition or replace it with a batch-local shortcut.
 */
export const LEXICAL_PRODUCTION_STAGE_IDS = Object.freeze([
  'candidate_intake',
  'semantic_review',
  'selection',
  'prospective_canonical',
  'audit',
  'admission',
]);

export const LEXICAL_PRODUCTION_STAGE_TRANSITIONS = Object.freeze({
  candidate_intake: Object.freeze({ from: 'created', to: 'candidate-intake-complete' }),
  semantic_review: Object.freeze({ from: 'candidate-intake-complete', to: 'semantic-review-complete' }),
  selection: Object.freeze({ from: 'semantic-review-complete', to: 'selection-complete' }),
  prospective_canonical: Object.freeze({ from: 'selection-complete', to: 'prospective-canonical-complete' }),
  audit: Object.freeze({ from: 'prospective-canonical-complete', to: 'audit-complete' }),
  admission: Object.freeze({ from: 'audit-complete', to: 'admission-complete' }),
});

export const LEXICAL_PRODUCTION_STAGE_OPERATIONS = Object.freeze({
  candidate_intake: 'validate-candidate-intake-output',
  semantic_review: 'validate-semantic-review-output',
  selection: 'validate-selection-output',
  prospective_canonical: 'validate-prospective-canonical-output',
  audit: 'validate-complete-canonical-audit-output',
  admission: 'commit-authorized-admission-output',
});

const LEXICAL_PRODUCTION_DECISIONS = Object.freeze([
  'included',
  'corrected',
  'held',
  'rejected',
  'deferred',
]);

const PRODUCER_RUNS = new WeakMap();
const STAGE_TOKENS = new WeakMap();
const AUTHORIZATION_TOKENS = new WeakMap();
const FINAL_TOKENS = new WeakMap();
const REPLAY_RUN = Symbol('lexical-production-replay-run');

function fail(message, code = 'LEXICAL_PRODUCTION_STATE_ERROR') {
  const error = new Error(message);
  error.name = 'LexicalProductionStateError';
  error.code = code;
  throw error;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'LEXICAL_PRODUCTION_STATE_VALUE');
  }
  return value;
}

function requireDigest(value, label) {
  requireString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 digest`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  return value;
}

function asBytes(bytes, label) {
  if (bytes === undefined || bytes === null || typeof bytes.length !== 'number') {
    fail(`${label} must provide source bytes`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  return Buffer.from(bytes);
}

function digestBytes(bytes) {
  return createHash('sha256').update(asBytes(bytes, 'production state source bytes')).digest('hex');
}

function stageInput(stageEvidence, stageId) {
  if (Array.isArray(stageEvidence)) {
    return stageEvidence.find((stage) => stage?.id === stageId);
  }
  return stageEvidence?.[stageId];
}

function stageLabel(stageId) {
  return `production_state.stages.${stageId}`;
}

function transitionDigest({
  contractVersion = LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION,
  pipelineVersion,
  batchId,
  stage,
}) {
  return digestBytes(Buffer.from(JSON.stringify({
    contract_version: contractVersion,
    pipeline_version: pipelineVersion,
    batch_id: batchId,
    id: stage.id,
    status: stage.status,
    transition: stage.transition,
    source_path: stage.source_path,
    payload_sha256: stage.payload_sha256,
    payload_mode: stage.payload_mode,
    payload_input_sha256: stage.payload_input_sha256,
    payload_output_sha256: stage.payload_output_sha256,
    source_sha256: stage.source_sha256,
    input_sha256: stage.input_sha256,
    output_sha256: stage.output_sha256,
    predecessor: stage.predecessor,
    operation: stage.operation,
    ...(stage.policy === undefined ? {} : { policy: stage.policy }),
    ...(stage.decision === undefined ? {} : { decision: stage.decision }),
    ...(stage.authorization_ref === undefined ? {} : { authorization_ref: stage.authorization_ref }),
    ...(stage.authorization_sha256 === undefined ? {} : { authorization_sha256: stage.authorization_sha256 }),
    ...(stage.admission_status === undefined ? {} : { admission_status: stage.admission_status }),
    ...(stage.admission_result_sha256 === undefined ? {} : { admission_result_sha256: stage.admission_result_sha256 }),
  }), 'utf8'));
}

function parseStageSource(stageId, sourceBytes, label = `production stage ${stageId}`) {
  const bytes = asBytes(sourceBytes, `${label}.source_bytes`);
  const sourceSha256 = digestBytes(bytes);
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label}.source_bytes must be a producer-owned stage envelope: ${error.message}`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  requireObject(envelope, `${label}.source_envelope`);
  if (envelope.contract_version !== LEXICAL_PRODUCTION_STAGE_SOURCE_CONTRACT_VERSION) {
    fail(`${label}.source_envelope.contract_version is unsupported`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (envelope.stage_id !== stageId) {
    fail(`${label}.source_envelope.stage_id must be ${stageId}`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  const payloadSha256 = requireDigest(envelope.payload_sha256, `${label}.source_envelope.payload_sha256`);
  if (!Object.hasOwn(envelope, 'payload')) {
    fail(`${label}.source_envelope.payload is required for typed producer binding`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  const payloadBytes = productionSourceBytes(envelope.payload);
  if (digestBytes(payloadBytes) !== payloadSha256) {
    fail(`${label}.source_envelope.payload_sha256 does not match its typed payload`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  return { bytes, sourceSha256, payloadSha256, payload: envelope.payload };
}

function stageEnvelopeBytes(stageId, payload) {
  const payloadBytes = productionSourceBytes(payload);
  return Buffer.from(`${JSON.stringify({
    contract_version: LEXICAL_PRODUCTION_STAGE_SOURCE_CONTRACT_VERSION,
    stage_id: stageId,
    payload_sha256: digestBytes(payloadBytes),
    payload,
  })}\n`, 'utf8');
}

/**
 * Serialize a producer output as a stage-owned envelope. A caller cannot
 * turn an arbitrary post-hoc descriptor into a completed stage: every stage
 * method accepts only this envelope, and the envelope is bound to the
 * payload digest and stage id.
 */
export function productionStageBytes(stageId, payloadBytes) {
  if (!LEXICAL_PRODUCTION_STAGE_IDS.includes(stageId)) {
    fail(`unknown lexical production stage ${stageId}`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  const bytes = asBytes(payloadBytes, `production stage ${stageId}.payload_bytes`);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`production stage ${stageId}.payload_bytes must be JSON: ${error.message}`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  return stageEnvelopeBytes(stageId, payload);
}

/**
 * Read the typed payloads emitted by a live producer from its persisted stage
 * envelopes. Active admission callers use these only as an additional binding
 * after they have supplied the producer-owned source bytes; raw artifacts and
 * replay envelopes are not accepted here.
 */
export function readLexicalProductionPayloads(sourceBytesByStage) {
  const sources = requireObject(sourceBytesByStage, 'production state source bytes');
  return Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((stageId) => [
    stageId,
    parseStageSource(
      stageId,
      sources[stageId],
      `production state ${stageId}`,
    ).payload,
  ]));
}

function replayStageBytes(stageId, sourceBytes) {
  const bytes = asBytes(sourceBytes, `production stage ${stageId}.source_bytes`);
  try {
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope?.contract_version === LEXICAL_PRODUCTION_STAGE_SOURCE_CONTRACT_VERSION
      && envelope?.stage_id === stageId
      && Object.hasOwn(envelope, 'payload')) {
      parseStageSource(stageId, bytes);
      return bytes;
    }
  } catch {
    // Historical and external replay inputs may be JSONL or another raw
    // artifact. They are wrapped below with an explicit replay-only payload.
  }
  return stageEnvelopeBytes(stageId, {
    contract_version: LEXICAL_PRODUCTION_REPLAY_PAYLOAD_CONTRACT_VERSION,
    mode: 'replay',
    stage_id: stageId,
    raw_sha256: digestBytes(bytes),
    raw_bytes_base64: bytes.toString('base64'),
  });
}

export function productionSourceBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export function productionValueSha256(value) {
  return digestBytes(productionSourceBytes(value));
}

function requirePayloadDigest(value, label) {
  return requireDigest(value, label);
}

function requirePayloadValue(value, label) {
  if (value === undefined) {
    fail(`${label} must be supplied as a typed producer value`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  return value;
}

function assertPayloadDigest(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must bind the exact typed producer value`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
}

function assertPayloadObject(value, label) {
  requireObject(value, label);
  return value;
}

function assertPayloadArray(value, label) {
  requireArray(value, label);
  return value;
}

function assertTypedRecord(value, label) {
  const record = assertPayloadObject(value, label);
  requireString(record.id, `${label}.id`);
  requireString(record.lemma, `${label}.lemma`);
  requireString(record.record_type, `${label}.record_type`);
  if (!['entry', 'expression'].includes(record.record_type)) {
    fail(`${label}.record_type is not a supported lexical record type`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  }
  requireString(record.role, `${label}.role`);
  if (!['start', 'reference-only'].includes(record.role)) {
    fail(`${label}.role is not a supported lexical record role`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  }
  const searchForms = assertPayloadArray(record.search_forms, `${label}.search_forms`);
  if (searchForms.length === 0 || searchForms.some((form) => typeof form !== 'string' || form.trim().length === 0)) {
    fail(`${label}.search_forms must contain non-empty strings`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  }
  const senses = assertPayloadArray(record.senses, `${label}.senses`);
  if (senses.length === 0) {
    fail(`${label}.senses must contain at least one typed sense`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
  }
  for (const [index, sense] of senses.entries()) {
    const senseLabel = `${label}.senses[${index}]`;
    const typedSense = assertPayloadObject(sense, senseLabel);
    requireString(typedSense.id, `${senseLabel}.id`);
    requireString(typedSense.pos, `${senseLabel}.pos`);
    requireString(typedSense.gloss, `${senseLabel}.gloss`);
  }
  return record;
}

function assertTypedRecordArray(value, label) {
  const records = assertPayloadArray(value, label);
  records.forEach((record, index) => assertTypedRecord(record, `${label}[${index}]`));
  return records;
}

function assertTypedReviewRows(value, label) {
  const rows = assertPayloadArray(value, label);
  rows.forEach((row, index) => {
    const rowLabel = `${label}[${index}]`;
    const reviewRow = assertPayloadObject(row, rowLabel);
    requireString(reviewRow.candidate_id, `${rowLabel}.candidate_id`);
    requireString(reviewRow.decision, `${rowLabel}.decision`);
    if (!LEXICAL_PRODUCTION_DECISIONS.includes(reviewRow.decision)) {
      fail(`${rowLabel}.decision is not a supported lexical production decision`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
    }
    assertPayloadObject(reviewRow.semantic_review, `${rowLabel}.semantic_review`);
    if (['included', 'corrected'].includes(reviewRow.decision)) {
      assertTypedRecord(reviewRow.reviewed_record, `${rowLabel}.reviewed_record`);
    } else if (Object.hasOwn(reviewRow, 'reviewed_record')) {
      fail(`${rowLabel}.reviewed_record is not allowed for a non-selected decision`, 'LEXICAL_PRODUCTION_STATE_SHAPE');
    }
  });
  return rows;
}

function assertPayloadOutputDetails(stageId, input, output, details) {
  const label = labelForPayload(stageId);
  requirePayloadValue(output, `${label}.output`);
  requireObject(details, `${label}.details`);
  if (stageId === 'candidate_intake') {
    assertTypedRecordArray(output, `${label}.output`);
    assertPayloadDigest(
      details.candidate_records_sha256,
      productionValueSha256(output),
      `${label}.details.candidate_records_sha256`,
    );
    if (details.candidate_count !== output.length) {
      fail(`${label}.details.candidate_count must bind the candidate output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
    }
    return;
  }

  requirePayloadValue(input, `${label}.input`);
  if (stageId === 'semantic_review') {
    assertTypedRecordArray(input, `${label}.input`);
    const outputObject = assertPayloadObject(output, `${label}.output`);
    assertTypedReviewRows(outputObject.review_rows, `${label}.output.review_rows`);
    assertTypedRecordArray(outputObject.reviewed_records, `${label}.output.reviewed_records`);
    assertPayloadDigest(
      details.candidate_records_sha256,
      productionValueSha256(input),
      `${label}.details.candidate_records_sha256`,
    );
    assertPayloadDigest(
      details.review_rows_sha256,
      productionValueSha256(outputObject.review_rows),
      `${label}.details.review_rows_sha256`,
    );
    assertPayloadDigest(
      details.reviewed_records_sha256,
      productionValueSha256(outputObject.reviewed_records),
      `${label}.details.reviewed_records_sha256`,
    );
    return;
  }

  if (stageId === 'selection') {
    const inputObject = assertPayloadObject(input, `${label}.input`);
    const outputObject = assertPayloadObject(output, `${label}.output`);
    assertTypedRecordArray(inputObject.reviewed_records, `${label}.input.reviewed_records`);
    assertTypedRecordArray(outputObject.selected_records, `${label}.output.selected_records`);
    assertPayloadArray(outputObject.selection_ranks, `${label}.output.selection_ranks`);
    if (outputObject.selection_ranks.length !== outputObject.selected_records.length
      || outputObject.selection_ranks.some((rank) => !Number.isInteger(rank) || rank < 0)) {
      fail(
        `${label}.output.selection_ranks must bind one non-negative integer rank per selected record `
        + `(received ${outputObject.selection_ranks.length} ranks for ${outputObject.selected_records.length} records)`,
        'LEXICAL_PRODUCTION_STATE_BINDING',
      );
    }
    assertPayloadDigest(
      details.reviewed_records_sha256,
      productionValueSha256(inputObject.reviewed_records),
      `${label}.details.reviewed_records_sha256`,
    );
    assertPayloadDigest(
      details.selected_records_sha256,
      productionValueSha256(outputObject.selected_records),
      `${label}.details.selected_records_sha256`,
    );
    assertPayloadDigest(
      details.selection_ranks_sha256,
      productionValueSha256(outputObject.selection_ranks),
      `${label}.details.selection_ranks_sha256`,
    );
    return;
  }

  if (stageId === 'prospective_canonical') {
    const inputObject = assertPayloadObject(input, `${label}.input`);
    assertTypedRecordArray(inputObject.selected_records, `${label}.input.selected_records`);
    assertTypedRecordArray(output, `${label}.output`);
    assertPayloadDigest(
      details.prospective_records_sha256,
      productionValueSha256(output),
      `${label}.details.prospective_records_sha256`,
    );
    requirePayloadDigest(details.base_records_sha256, `${label}.details.base_records_sha256`);
    return;
  }

  if (stageId === 'audit') {
    assertPayloadArray(input, `${label}.input`);
    const outputObject = assertPayloadObject(output, `${label}.output`);
    if (JSON.stringify(details) !== JSON.stringify(outputObject)) {
      fail(`${label}.details must equal the complete-canonical audit output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
    }
    assertPayloadDigest(
      details.prospective_records_sha256,
      productionValueSha256(input),
      `${label}.details.prospective_records_sha256`,
    );
    return;
  }

  if (stageId === 'admission') {
    const inputObject = assertPayloadObject(input, `${label}.input`);
    const outputObject = assertPayloadObject(output, `${label}.output`);
    requirePayloadDigest(inputObject.prospective_records_sha256, `${label}.input.prospective_records_sha256`);
    requirePayloadDigest(inputObject.semantic_audit_sha256, `${label}.input.semantic_audit_sha256`);
    requirePayloadDigest(inputObject.lexical_audit_sha256, `${label}.input.lexical_audit_sha256`);
    if (outputObject.status !== 'admitted') {
      fail(`${label}.output.status must be admitted`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
    }
    requirePayloadDigest(outputObject.gate_digest, `${label}.output.gate_digest`);
    assertPayloadDigest(
      details.gate_sha256,
      outputObject.gate_digest,
      `${label}.details.gate_sha256`,
    );
    requirePayloadDigest(details.authorization_sha256, `${label}.details.authorization_sha256`);
  }
}

function validateLivePayload(stageId, payload, {
  batchId,
  predecessorPayloadOutputSha256,
  input,
  output,
} = {}) {
  requireObject(payload, `production stage ${stageId}.payload`);
  if (payload.contract_version !== LEXICAL_PRODUCTION_PAYLOAD_CONTRACT_VERSION) {
    fail(`production stage ${stageId}.payload.contract_version is unsupported`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (payload.mode !== 'live') {
    fail(`production stage ${stageId}.payload.mode must be live`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (payload.stage_id !== stageId) {
    fail(`production stage ${stageId}.payload.stage_id must match the emitted stage`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  requireString(payload.batch_id, `production stage ${stageId}.payload.batch_id`);
  if (payload.batch_id !== batchId) {
    fail(`production stage ${stageId}.payload.batch_id is not bound to ${batchId}`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const inputSha256 = payload.input_sha256 === null
    ? null
    : requirePayloadDigest(payload.input_sha256, `production stage ${stageId}.payload.input_sha256`);
  const outputSha256 = requirePayloadDigest(payload.output_sha256, `production stage ${stageId}.payload.output_sha256`);
  if (!Object.hasOwn(payload, 'input')) {
    fail(`production stage ${stageId}.payload.input must preserve the exact typed operation input`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (!Object.hasOwn(payload, 'output')) {
    fail(`production stage ${stageId}.payload.output must preserve the exact typed operation output`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (payload.input === undefined) {
    fail(`production stage ${stageId}.payload.input must be null or a typed value`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  requirePayloadValue(payload.output, `production stage ${stageId}.payload.output`);
  if ((inputSha256 === null && payload.input !== null)
    || (inputSha256 !== null && productionValueSha256(payload.input) !== inputSha256)) {
    fail(`production stage ${stageId}.payload.input_sha256 does not bind its exact typed input`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (productionValueSha256(payload.output) !== outputSha256) {
    fail(`production stage ${stageId}.payload.output_sha256 does not bind its exact typed output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (predecessorPayloadOutputSha256 === undefined) {
    if (inputSha256 !== null) {
      fail(`production stage ${stageId}.payload.input_sha256 must begin at null`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
    }
  } else if (inputSha256 !== predecessorPayloadOutputSha256) {
    fail(`production stage ${stageId}.payload.input_sha256 must consume the validated predecessor payload`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  requireString(payload.input_kind, `production stage ${stageId}.payload.input_kind`);
  requireString(payload.output_kind, `production stage ${stageId}.payload.output_kind`);
  const expectedKinds = {
    candidate_intake: ['none', 'candidate-records'],
    semantic_review: ['candidate-records', 'reviewed-records'],
    selection: ['reviewed-records', 'selected-records'],
    prospective_canonical: ['selected-records', 'prospective-canonical'],
    audit: ['prospective-canonical', 'complete-canonical-audit'],
    admission: ['complete-canonical-audit', 'admitted-canonical'],
  }[stageId];
  if (payload.input_kind !== expectedKinds[0] || payload.output_kind !== expectedKinds[1]) {
    fail(`${labelForPayload(stageId)} must declare the typed input/output for its operation`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  const details = requireObject(payload.details, `production stage ${stageId}.payload.details`);
  const requiredDetails = {
    candidate_intake: ['candidate_records_sha256', 'candidate_count'],
    semantic_review: ['candidate_records_sha256', 'review_rows_sha256', 'reviewed_records_sha256'],
    selection: ['reviewed_records_sha256', 'selected_records_sha256', 'selection_ranks_sha256'],
    prospective_canonical: ['base_records_sha256', 'prospective_records_sha256'],
    audit: ['prospective_records_sha256', 'semantic_audit_sha256', 'lexical_audit_sha256'],
    admission: ['authorization_sha256', 'gate_sha256'],
  }[stageId];
  for (const key of requiredDetails) {
    if (key.endsWith('_sha256')) requirePayloadDigest(details[key], `production stage ${stageId}.payload.details.${key}`);
    else if (!Number.isInteger(details[key]) || details[key] < 0) {
      fail(`production stage ${stageId}.payload.details.${key} must be a non-negative integer`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
    }
  }
  assertPayloadOutputDetails(stageId, payload.input, payload.output, details);
  return { inputSha256, outputSha256 };
}

function labelForPayload(stageId) {
  return `production stage ${stageId}.payload`;
}

export function createLexicalProductionPayload({
  stageId,
  batchId,
  input,
  output,
  inputKind,
  outputKind,
  details,
} = {}) {
  if (!LEXICAL_PRODUCTION_STAGE_IDS.includes(stageId)) {
    fail(`unknown lexical production stage ${stageId}`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  requireString(batchId, 'production payload.batch_id');
  requireString(inputKind, `production payload ${stageId}.input_kind`);
  requireString(outputKind, `production payload ${stageId}.output_kind`);
  requireObject(details, `production payload ${stageId}.details`);
  requirePayloadValue(output, `production payload ${stageId}.output`);
  const payload = {
    contract_version: LEXICAL_PRODUCTION_PAYLOAD_CONTRACT_VERSION,
    mode: 'live',
    stage_id: stageId,
    batch_id: batchId,
    input: input === undefined ? null : structuredClone(input),
    output: structuredClone(requirePayloadValue(output)),
    input_sha256: input === null || input === undefined ? null : productionValueSha256(input),
    output_sha256: productionValueSha256(output),
    input_kind: inputKind,
    output_kind: outputKind,
    details: structuredClone(details),
  };
  validateLivePayload(stageId, payload, {
    batchId,
    predecessorPayloadOutputSha256: payload.input_sha256 === null ? undefined : payload.input_sha256,
    input,
    output,
  });
  return Object.freeze(payload);
}

export function productionBytesSha256(bytes) {
  return digestBytes(bytes);
}

export function isLexicalProductionRun(value) {
  return Boolean(value && typeof value === 'object' && PRODUCER_RUNS.has(value));
}

function stageTokenFor(run, stageId, token, label) {
  const tokenState = STAGE_TOKENS.get(token);
  if (!tokenState || tokenState.run !== run || tokenState.stageId !== stageId) {
    fail(`${label} must be the immediately preceding producer output`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  return tokenState;
}

function sourceInputForStage(stageId, sourceBytes, sourcePath) {
  requireString(sourcePath, `production stage ${stageId}.source_path`);
  return parseStageSource(stageId, sourceBytes);
}

function newStageToken(run, stage) {
  const token = Object.freeze({
    stage_id: stage.id,
    output_sha256: stage.output_sha256,
    payload_output_sha256: stage.payload_output_sha256,
  });
  STAGE_TOKENS.set(token, {
    run,
    stageId: stage.id,
    outputSha256: stage.output_sha256,
    payloadOutputSha256: stage.payload_output_sha256,
  });
  return token;
}

function makeStage(run, stageId, {
  predecessor,
  sourcePath,
  sourceBytes,
  policy,
  decision,
  authorizationRef,
  authorizationSha256,
  admissionStatus,
  admissionResultSha256,
  payload,
  payloadSpec,
} = {}) {
  const runState = PRODUCER_RUNS.get(run);
  if (!runState) fail('producer run is not owned by the shared lexical producer', 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  if (runState.completed.has(stageId)) {
    fail(`producer stage ${stageId} cannot be emitted more than once`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  const stageIndex = LEXICAL_PRODUCTION_STAGE_IDS.indexOf(stageId);
  const expectedPredecessorStageId = stageIndex === 0
    ? undefined
    : LEXICAL_PRODUCTION_STAGE_IDS[stageIndex - 1];
  let predecessorState;
  if (expectedPredecessorStageId === undefined) {
    if (predecessor !== undefined) {
      fail(`${stageId} cannot have a predecessor`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
    }
  } else {
    predecessorState = stageTokenFor(
      run,
      expectedPredecessorStageId,
      predecessor,
      `production stage ${stageId}.predecessor`,
    );
  }
  let parsedSource;
  let payloadMode;
  let payloadInputSha256;
  let payloadOutputSha256;
  if (runState.replay) {
    parsedSource = sourceInputForStage(stageId, sourceBytes, sourcePath);
    payloadMode = 'replay';
    payloadInputSha256 = predecessorState?.payloadOutputSha256 ?? null;
    payloadOutputSha256 = parsedSource.payloadSha256;
  } else {
    if (sourceBytes !== undefined || payload !== undefined) {
      fail(`${stageId} must be emitted from a typed producer payload, not caller-supplied source bytes`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
    }
    if (!payloadSpec || typeof payloadSpec !== 'object' || Array.isArray(payloadSpec)) {
      fail(`${stageId} must be emitted by the producer from an exact typed input/output specification`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
    }
    const typedPayloadValue = {
      ...payloadSpec,
      stageId,
      batchId: runState.batchId,
    };
    const typedPayload = createLexicalProductionPayload(typedPayloadValue);
    if (typedPayload.input_sha256 !== (predecessorState?.payloadOutputSha256 ?? null)) {
      fail(`${stageId} typed input does not consume the validated predecessor payload`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
    }
    parsedSource = parseStageSource(
      stageId,
      productionStageBytes(stageId, productionSourceBytes(typedPayload)),
      `production stage ${stageId}`,
    );
    payloadMode = 'live';
    payloadInputSha256 = typedPayload.input_sha256;
    payloadOutputSha256 = typedPayload.output_sha256;
  }
  if (runState.sourceDigests.has(parsedSource.sourceSha256)) {
    fail(`${stageId} reuses source bytes already consumed by another producer stage`, 'LEXICAL_PRODUCTION_STATE_REUSED_SOURCE');
  }
  if (runState.payloadDigests.has(parsedSource.payloadSha256)) {
    fail(`${stageId} reuses a payload already consumed by another producer stage`, 'LEXICAL_PRODUCTION_STATE_REUSED_SOURCE');
  }
  const transition = LEXICAL_PRODUCTION_STAGE_TRANSITIONS[stageId];
  const stage = {
    id: stageId,
    status: 'complete',
    transition: { ...transition },
    source_path: sourcePath,
    payload_sha256: parsedSource.payloadSha256,
    payload_mode: payloadMode,
    payload_input_sha256: payloadInputSha256,
    payload_output_sha256: payloadOutputSha256,
    source_sha256: parsedSource.sourceSha256,
    input_sha256: predecessorState?.outputSha256 ?? null,
    output_sha256: parsedSource.sourceSha256,
    predecessor: predecessorState
      ? { stage_id: expectedPredecessorStageId, output_sha256: predecessorState.outputSha256 }
      : null,
    operation: LEXICAL_PRODUCTION_STAGE_OPERATIONS[stageId],
  };
  if (policy !== undefined) stage.policy = requireString(policy, `${stageLabel(stageId)}.policy`);
  if (decision !== undefined) stage.decision = requireString(decision, `${stageLabel(stageId)}.decision`);
  if (authorizationRef !== undefined) stage.authorization_ref = requireString(
    authorizationRef,
    `${stageLabel(stageId)}.authorization_ref`,
  );
  if (authorizationSha256 !== undefined) stage.authorization_sha256 = requireDigest(
    authorizationSha256,
    `${stageLabel(stageId)}.authorization_sha256`,
  );
  if (admissionStatus !== undefined) stage.admission_status = requireString(
    admissionStatus,
    `${stageLabel(stageId)}.admission_status`,
  );
  if (admissionResultSha256 !== undefined) stage.admission_result_sha256 = requireDigest(
    admissionResultSha256,
    `${stageLabel(stageId)}.admission_result_sha256`,
  );
  stage.transition_sha256 = transitionDigest({
    pipelineVersion: runState.pipelineVersion,
    batchId: runState.batchId,
    stage,
  });
  Object.defineProperty(stage, '_sourceBytes', {
    value: parsedSource.bytes,
    enumerable: false,
  });
  runState.completed.set(stageId, stage);
  runState.sourceDigests.add(parsedSource.sourceSha256);
  runState.payloadDigests.add(parsedSource.payloadSha256);
  return newStageToken(run, stage);
}

function assertAdmissionAuthorization(run, authorization) {
  const tokenState = AUTHORIZATION_TOKENS.get(authorization);
  if (!tokenState || tokenState.run !== run) {
    fail('admission requires an authorization emitted by the shared producer run', 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
  }
  const auditTokenState = STAGE_TOKENS.get(tokenState.predecessor);
  if (!auditTokenState || auditTokenState.run !== run || auditTokenState.stageId !== 'audit') {
    fail('admission authorization must follow the validated audit output', 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  return tokenState;
}

/**
 * Create a live producer. The only way to obtain a completed state is to
 * emit each stage through the immediately preceding token and then complete
 * admission with an authorization token and an admitted result.
 */
export function createLexicalProductionRun({
  batchId,
  pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
  [REPLAY_RUN]: replay = false,
} = {}) {
  requireString(batchId, 'production_run.batch_id');
  requireString(pipelineVersion, 'production_run.pipeline_version');
  const run = {};
  const runState = {
    batchId,
    pipelineVersion,
    completed: new Map(),
    sourceDigests: new Set(),
    payloadDigests: new Set(),
    final: false,
    replay,
  };
  PRODUCER_RUNS.set(run, runState);
  Object.assign(run, {
    completeCandidateIntake(options = {}) {
      return makeStage(run, 'candidate_intake', options);
    },
    completeSemanticReview(options = {}) {
      return makeStage(run, 'semantic_review', options);
    },
    completeSelection(options = {}) {
      return makeStage(run, 'selection', options);
    },
    completeProspectiveCanonical(options = {}) {
      return makeStage(run, 'prospective_canonical', options);
    },
    completeAudit(options = {}) {
      return makeStage(run, 'audit', options);
    },
    authorizeAdmission({ predecessor, authorizationRef, authorizationBytes } = {}) {
      if (runState.final) fail('admission authorization cannot be emitted after admission', 'LEXICAL_PRODUCTION_STATE_TRANSITION');
      const auditState = stageTokenFor(run, 'audit', predecessor, 'production admission authorization.predecessor');
      requireString(authorizationRef, 'production admission authorization.authorization_ref');
      const bytes = asBytes(authorizationBytes, 'production admission authorization.authorization_bytes');
      const authorization = Object.freeze({
        authorization_ref: authorizationRef,
        authorization_sha256: digestBytes(bytes),
      });
      AUTHORIZATION_TOKENS.set(authorization, {
        run,
        predecessor,
        predecessorOutputSha256: auditState.outputSha256,
        predecessorPayloadOutputSha256: auditState.payloadOutputSha256,
        authorizationRef,
        authorizationSha256: authorization.authorization_sha256,
      });
      return authorization;
    },
    completeAdmission({
      authorization,
      sourcePath,
      sourceBytes,
      payload,
      payloadSpec,
      decision = 'admit',
      admissionResult,
    } = {}) {
      if (runState.final) fail('admission cannot be emitted more than once', 'LEXICAL_PRODUCTION_STATE_TRANSITION');
      const authorizationState = assertAdmissionAuthorization(run, authorization);
      if (decision !== 'admit') {
        fail('production admission decision must be admit', 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
      }
      requireObject(admissionResult, 'production admission result');
      if (admissionResult.status !== 'admitted') {
        fail('production admission stage requires a successful admitted result', 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
      }
      const gateDigest = requireDigest(admissionResult.gate_digest, 'production admission result.gate_digest');
      if (!runState.replay) {
        if (payload !== undefined) {
          fail('admission must be emitted from the producer-owned typed input/output specification', 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
        }
        const payloadDetails = requireObject(payloadSpec?.details, 'production admission payload.details');
        if (payloadDetails.authorization_sha256 !== authorizationState.authorizationSha256) {
          fail('production admission payload must bind the emitted authorization', 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
        }
        if (payloadDetails.gate_sha256 !== gateDigest) {
          fail('production admission payload must bind the successful admission gate', 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
        }
      }
      const admissionToken = makeStage(run, 'admission', {
        predecessor: authorizationState.predecessor,
        sourcePath,
        sourceBytes,
        payload,
        payloadSpec,
        decision,
        authorizationRef: authorizationState.authorizationRef,
        authorizationSha256: authorizationState.authorizationSha256,
        admissionStatus: 'admitted',
        admissionResultSha256: digestBytes(Buffer.from(JSON.stringify({
          status: admissionResult.status,
          gate_digest: gateDigest,
        }), 'utf8')),
      });
      runState.final = true;
      FINAL_TOKENS.set(admissionToken, { run });
      return admissionToken;
    },
    getPreAdmissionState() {
      const stages = LEXICAL_PRODUCTION_STAGE_IDS.slice(0, -1).map((id) => runState.completed.get(id));
      if (stages.some((stage) => !stage)) {
        fail('producer run is not ready for admission', 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
      }
      return {
        contract_version: LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION,
        pipeline_version: pipelineVersion,
        batch_id: batchId,
        producer_mode: runState.replay ? 'replay' : 'live',
        status: 'awaiting-admission',
        stages: stages.map((stage) => structuredClone(stage)),
      };
    },
    getPreAuditState() {
      const stages = LEXICAL_PRODUCTION_STAGE_IDS.slice(0, 4).map((id) => runState.completed.get(id));
      if (stages.some((stage) => !stage)) {
        fail('producer run is not ready for audit', 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
      }
      return {
        contract_version: LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION,
        pipeline_version: pipelineVersion,
        batch_id: batchId,
        producer_mode: runState.replay ? 'replay' : 'live',
        status: 'awaiting-audit',
        stages: stages.map((stage) => structuredClone(stage)),
      };
    },
    getPreAdmissionSourceBytesByStage() {
      const stages = LEXICAL_PRODUCTION_STAGE_IDS.slice(0, -1);
      if (stages.some((stageId) => !runState.completed.has(stageId))) {
        fail('producer run is not ready for admission', 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
      }
      return Object.fromEntries(stages.map((stageId) => [
        stageId,
        runState.completed.get(stageId)._sourceBytes,
      ]));
    },
    getPreAuditSourceBytesByStage() {
      const stages = LEXICAL_PRODUCTION_STAGE_IDS.slice(0, 4);
      if (stages.some((stageId) => !runState.completed.has(stageId))) {
        fail('producer run is not ready for audit', 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
      }
      return Object.fromEntries(stages.map((stageId) => [
        stageId,
        runState.completed.get(stageId)._sourceBytes,
      ]));
    },
    getState() {
      if (!runState.final) {
        fail('complete production state is unavailable before admitted output is emitted', 'LEXICAL_PRODUCTION_STATE_NOT_ADMITTED');
      }
      return buildState(runState);
    },
    getSourceBytesByStage() {
      if (!runState.final) {
        fail('production source bytes are unavailable before admitted output is emitted', 'LEXICAL_PRODUCTION_STATE_NOT_ADMITTED');
      }
      return Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((stageId) => [
        stageId,
        runState.completed.get(stageId)._sourceBytes,
      ]));
    },
  });
  return Object.freeze(run);
}

function buildState(runState) {
  return {
    contract_version: LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION,
    pipeline_version: runState.pipelineVersion,
    batch_id: runState.batchId,
    producer_mode: runState.replay ? 'replay' : 'live',
    stages: LEXICAL_PRODUCTION_STAGE_IDS.map((stageId) => {
      const stage = runState.completed.get(stageId);
      const copy = structuredClone(stage);
      delete copy._sourceBytes;
      return copy;
    }),
  };
}

/**
 * Build a state from external stage payloads for verifiers and historical
 * replay tools. This is a producer execution adapter, not a metadata
 * constructor: it emits the first five stages in order, authorizes admission,
 * and emits the final stage only with an admitted result.
 */
export function produceLexicalProductionState({
  batchId,
  pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
  stages,
} = {}) {
  requireString(batchId, 'production_state.batch_id');
  const run = createLexicalProductionRun({ batchId, pipelineVersion, [REPLAY_RUN]: true });
  const stageValues = Object.fromEntries(LEXICAL_PRODUCTION_STAGE_IDS.map((stageId) => {
    const input = stageInput(stages, stageId);
    requireObject(input, `production stage evidence.${stageId}`);
    return [stageId, input];
  }));
  const tokens = {};
  const stageBytesByStage = {};
  for (const stageId of LEXICAL_PRODUCTION_STAGE_IDS.slice(0, -1)) {
    const input = stageValues[stageId];
    const stageBytes = replayStageBytes(
      stageId,
      asBytes(input.source_bytes, `production stage evidence.${stageId}.source_bytes`),
    );
    stageBytesByStage[stageId] = stageBytes;
    const methodName = {
      candidate_intake: 'completeCandidateIntake',
      semantic_review: 'completeSemanticReview',
      selection: 'completeSelection',
      prospective_canonical: 'completeProspectiveCanonical',
      audit: 'completeAudit',
    }[stageId];
    tokens[stageId] = run[methodName]({
      ...(stageId === 'candidate_intake'
        ? {}
        : {
          predecessor: tokens[LEXICAL_PRODUCTION_STAGE_IDS[
            LEXICAL_PRODUCTION_STAGE_IDS.indexOf(stageId) - 1
          ]],
        }),
      sourcePath: requireString(input.source_path, `production stage evidence.${stageId}.source_path`),
      sourceBytes: stageBytes,
      ...(stageId === 'selection' ? { policy: input.policy ?? 'shared-selection-policy' } : {}),
    });
  }
  const admissionInput = stageValues.admission;
  const authorizationRef = requireString(
    admissionInput.authorization_ref,
    'production stage evidence.admission.authorization_ref',
  );
  const authorizationBytes = admissionInput.authorization_bytes !== undefined
    ? asBytes(admissionInput.authorization_bytes, 'production stage evidence.admission.authorization_bytes')
    : asBytes(admissionInput.source_bytes, 'production stage evidence.admission.source_bytes');
  const authorization = run.authorizeAdmission({
    predecessor: tokens.audit,
    authorizationRef,
    authorizationBytes,
  });
  const admissionStageBytes = replayStageBytes(
    'admission',
    asBytes(admissionInput.source_bytes, 'production stage evidence.admission.source_bytes'),
  );
  stageBytesByStage.admission = admissionStageBytes;
  run.completeAdmission({
    authorization,
    sourcePath: requireString(admissionInput.source_path, 'production stage evidence.admission.source_path'),
    sourceBytes: admissionStageBytes,
    decision: 'admit',
    admissionResult: { status: 'admitted', gate_digest: digestBytes(admissionStageBytes) },
  });
  const state = run.getState();
  return { state, sources: stageBytesByStage };
}

/**
 * The old API accepted six arbitrary descriptors and marked them complete.
 * Keep the name only as a fail-closed migration guard so a future producer
 * cannot silently reintroduce post-hoc state construction.
 */
export function createLexicalProductionState({ producer } = {}) {
  const final = FINAL_TOKENS.get(producer);
  if (!final) {
    fail(
      'createLexicalProductionState requires a final producer output; stages cannot be supplied as post-hoc metadata',
      'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
    );
  }
  return final.run.getState();
}

function sourceBytesFor(stageId, sourceBytesByStage) {
  if (sourceBytesByStage && Object.hasOwn(sourceBytesByStage, stageId)) {
    return sourceBytesByStage[stageId];
  }
  return undefined;
}

function normalizeValidationSourceBytes(stageId, sourceBytes, { allowReplay = false } = {}) {
  const bytes = asBytes(sourceBytes, `production state ${stageId}.source_bytes`);
  try {
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope?.contract_version === LEXICAL_PRODUCTION_STAGE_SOURCE_CONTRACT_VERSION
      && envelope?.stage_id === stageId) {
      return bytes;
    }
  } catch {
    // Raw artifact bytes are wrapped below for compatibility with callers
    // that read the external source file directly.
  }
  if (allowReplay) return replayStageBytes(stageId, bytes);
  fail(
    `production state ${stageId}.source_bytes must be a typed producer envelope`,
    'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED',
  );
}

function stageIndexFor(stageId) {
  return LEXICAL_PRODUCTION_STAGE_IDS.indexOf(stageId);
}

function validateStage(
  stage,
  stageId,
  sourceBytesByStage,
  state,
  seenSources,
  seenPayloads,
  { allowReplay = false, expectedPayload } = {},
) {
  const label = stageLabel(stageId);
  requireObject(stage, label);
  if (stage.id !== stageId) fail(`${label}.id must be ${stageId}`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  if (stage.status !== 'complete') fail(`${label}.status must be complete`, 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
  const transition = LEXICAL_PRODUCTION_STAGE_TRANSITIONS[stageId];
  requireObject(stage.transition, `${label}.transition`);
  if (stage.transition.from !== transition.from || stage.transition.to !== transition.to) {
    fail(`${label}.transition is not the shared lexical producer transition`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  requireString(stage.source_path, `${label}.source_path`);
  const payloadSha256 = requireDigest(stage.payload_sha256, `${label}.payload_sha256`);
  const sourceSha256 = requireDigest(stage.source_sha256, `${label}.source_sha256`);
  const outputSha256 = requireDigest(stage.output_sha256, `${label}.output_sha256`);
  if (sourceSha256 !== outputSha256) {
    fail(`${label}.output_sha256 must bind the emitted producer output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (seenSources.has(sourceSha256)) {
    fail(`${label}.source_sha256 reuses bytes from another producer stage`, 'LEXICAL_PRODUCTION_STATE_REUSED_SOURCE');
  }
  seenSources.add(sourceSha256);
  if (seenPayloads.has(payloadSha256)) {
    fail(`${label}.payload_sha256 reuses a payload from another producer stage`, 'LEXICAL_PRODUCTION_STATE_REUSED_SOURCE');
  }
  seenPayloads.add(payloadSha256);
  const suppliedSourceBytes = sourceBytesFor(stageId, sourceBytesByStage);
  if (suppliedSourceBytes === undefined) {
    fail(`${label} requires producer-owned source bytes for digest verification`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  const sourceBytes = normalizeValidationSourceBytes(stageId, suppliedSourceBytes, {
    allowReplay: state.producer_mode === 'replay',
  });
  const parsed = parseStageSource(stageId, sourceBytes, label);
  if (parsed.sourceSha256 !== sourceSha256 || parsed.payloadSha256 !== payloadSha256) {
    fail(`${label} source envelope does not match its persisted producer output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (!['live', 'replay'].includes(stage.payload_mode)) {
    fail(`${label}.payload_mode must identify a live or replay producer output`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (stage.payload_mode === 'replay' && (state.producer_mode !== 'replay' || !allowReplay)) {
    fail(`${label} replay output is not accepted by the live admission validator`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  const payloadInputSha256 = stage.payload_input_sha256 === null
    ? null
    : requireDigest(stage.payload_input_sha256, `${label}.payload_input_sha256`);
  const payloadOutputSha256 = requireDigest(stage.payload_output_sha256, `${label}.payload_output_sha256`);
  if (stage.payload_mode === 'live') {
    const livePayload = validateLivePayload(stageId, parsed.payload, {
      batchId: state.batch_id,
      predecessorPayloadOutputSha256: stageIndexFor(stageId) === 0
        ? undefined
        : state.stages[stageIndexFor(stageId) - 1].payload_output_sha256,
    });
    if (livePayload.inputSha256 !== payloadInputSha256 || livePayload.outputSha256 !== payloadOutputSha256) {
      fail(`${label} typed payload lineage does not match the persisted producer output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
    }
    if (expectedPayload !== undefined && JSON.stringify(parsed.payload) !== JSON.stringify(expectedPayload)) {
      fail(`${label} typed payload is not the exact operation input/output checked by the pipeline`, 'LEXICAL_PRODUCTION_STATE_BINDING');
    }
  } else if (payloadInputSha256 !== (stageIndexFor(stageId) === 0
    ? null
    : state.stages[stageIndexFor(stageId) - 1].payload_output_sha256)
    || payloadOutputSha256 !== payloadSha256) {
    fail(`${label} replay payload lineage does not match the persisted producer output`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  const stageIndex = LEXICAL_PRODUCTION_STAGE_IDS.indexOf(stageId);
  if (stageIndex === 0) {
    if (stage.input_sha256 !== null || stage.predecessor !== null) {
      fail(`${label} must begin the producer lineage`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
    }
  } else {
    const previous = state.stages[stageIndex - 1];
    const previousOutput = requireDigest(previous.output_sha256, `${label} predecessor output`);
    if (stage.input_sha256 !== previousOutput
      || JSON.stringify(stage.predecessor) !== JSON.stringify({
        stage_id: LEXICAL_PRODUCTION_STAGE_IDS[stageIndex - 1],
        output_sha256: previousOutput,
      })) {
      fail(`${label} must consume the immediately preceding producer output`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
    }
  }
  if (stage.operation !== LEXICAL_PRODUCTION_STAGE_OPERATIONS[stageId]) {
    fail(`${label}.operation is not the shared producer operation`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  requireDigest(stage.transition_sha256, `${label}.transition_sha256`);
  if (stage.transition_sha256 !== transitionDigest({
    pipelineVersion: state.pipeline_version,
    batchId: state.batch_id,
    stage,
  })) {
    fail(`${label}.transition_sha256 does not bind the producer transition`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (stageId === 'selection') requireString(stage.policy, `${label}.policy`);
  if (stageId === 'admission') {
    if (stage.decision !== 'admit') {
      fail(`${label}.decision must be the explicit admit decision`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
    }
    requireString(stage.authorization_ref, `${label}.authorization_ref`);
    requireDigest(stage.authorization_sha256, `${label}.authorization_sha256`);
    if (stage.admission_status !== 'admitted') {
      fail(`${label}.admission_status must prove a successful admission`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
    }
    requireDigest(stage.admission_result_sha256, `${label}.admission_result_sha256`);
  }
}

/**
 * Validate compact state emitted by a live producer. A state copied from a
 * hand-written descriptor fails because it lacks payload lineage, producer
 * operations, and transition digests.
 */
export function validateLexicalProductionState(
  state,
  {
    batchId,
    pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
    sourceBytesByStage,
    expectedPayloads,
    allowReplay = false,
    label = 'production_state',
  } = {},
) {
  requireObject(state, label);
  if (state.contract_version !== LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION) {
    fail(`${label}.contract_version is unsupported`, 'LEXICAL_PRODUCTION_STATE_SCHEMA');
  }
  if (state.pipeline_version !== pipelineVersion) {
    fail(`${label}.pipeline_version does not match the shared lexical producer`, 'LEXICAL_PRODUCTION_STATE_SCHEMA');
  }
  if (!['live', 'replay'].includes(state.producer_mode)) {
    fail(`${label}.producer_mode must identify a live or replay producer`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (state.producer_mode === 'replay' && !allowReplay) {
    fail(`${label} replay output is not accepted by the live admission validator`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (state.producer_mode === 'live' && expectedPayloads === undefined) {
    fail(`${label} live output requires the exact typed payloads checked by the pipeline`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  requireString(state.batch_id, `${label}.batch_id`);
  if (batchId !== undefined && state.batch_id !== batchId) {
    fail(`${label}.batch_id is not bound to ${batchId}`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const stages = requireArray(state.stages, `${label}.stages`);
  if (stages.length !== LEXICAL_PRODUCTION_STAGE_IDS.length) {
    fail(`${label}.stages must contain exactly ${LEXICAL_PRODUCTION_STAGE_IDS.length} shared stages`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const stageIds = stages.map((stage) => stage?.id);
  if (JSON.stringify(stageIds) !== JSON.stringify(LEXICAL_PRODUCTION_STAGE_IDS)) {
    fail(`${label}.stages must appear in the shared transition order`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  const seenSources = new Set();
  const seenPayloads = new Set();
  for (const [index, stageId] of LEXICAL_PRODUCTION_STAGE_IDS.entries()) {
    validateStage(stages[index], stageId, sourceBytesByStage, state, seenSources, seenPayloads, {
      allowReplay,
      expectedPayload: expectedPayloads?.[stageId],
    });
  }
  return {
    contract_version: state.contract_version,
    pipeline_version: state.pipeline_version,
    batch_id: state.batch_id,
    producer_mode: state.producer_mode,
    stage_count: stages.length,
    stages: stages.map((stage) => structuredClone(stage)),
  };
}

export function validateLexicalProductionPreAdmissionState(
  state,
  {
    batchId,
    pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
    sourceBytesByStage,
    expectedPayloads,
    allowReplay = false,
    label = 'production_pre_admission',
  } = {},
) {
  requireObject(state, label);
  if (state.contract_version !== LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION
    || state.pipeline_version !== pipelineVersion) {
    fail(`${label} does not use the shared producer contract`, 'LEXICAL_PRODUCTION_STATE_SCHEMA');
  }
  if (!['live', 'replay'].includes(state.producer_mode)) {
    fail(`${label}.producer_mode is required`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (state.producer_mode === 'replay' && !allowReplay) {
    fail(`${label} replay output is not accepted by the live admission validator`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  requireString(state.batch_id, `${label}.batch_id`);
  if (batchId !== undefined && state.batch_id !== batchId) {
    fail(`${label}.batch_id is not bound to ${batchId}`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  if (state.status !== 'awaiting-admission') {
    fail(`${label}.status must remain pre-admission until shared validation succeeds`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
  }
  const stages = requireArray(state.stages, `${label}.stages`);
  if (stages.length !== LEXICAL_PRODUCTION_STAGE_IDS.length - 1) {
    fail(`${label}.stages must contain exactly five pre-admission stages`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const fullState = { ...state, stages: [...stages, { id: 'admission', status: 'not-emitted' }] };
  const seenSources = new Set();
  const seenPayloads = new Set();
  for (const [index, stageId] of LEXICAL_PRODUCTION_STAGE_IDS.slice(0, -1).entries()) {
    validateStage(stages[index], stageId, sourceBytesByStage, fullState, seenSources, seenPayloads, {
      allowReplay,
      expectedPayload: expectedPayloads?.[stageId],
    });
  }
  return {
    contract_version: state.contract_version,
    pipeline_version: state.pipeline_version,
    batch_id: state.batch_id,
    stage_count: stages.length,
    status: state.status,
    stages: stages.map((stage) => structuredClone(stage)),
  };
}

export function validateLexicalProductionPreAuditState(
  state,
  {
    batchId,
    pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
    sourceBytesByStage,
    expectedPayloads,
    allowReplay = false,
    label = 'production_pre_audit',
  } = {},
) {
  requireObject(state, label);
  if (state.contract_version !== LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION
    || state.pipeline_version !== pipelineVersion) {
    fail(`${label} does not use the shared producer contract`, 'LEXICAL_PRODUCTION_STATE_SCHEMA');
  }
  if (!['live', 'replay'].includes(state.producer_mode)) {
    fail(`${label}.producer_mode is required`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  if (state.producer_mode === 'replay' && !allowReplay) {
    fail(`${label} replay output is not accepted by the live admission validator`, 'LEXICAL_PRODUCTION_STATE_PRODUCER_REQUIRED');
  }
  requireString(state.batch_id, `${label}.batch_id`);
  if (batchId !== undefined && state.batch_id !== batchId) {
    fail(`${label}.batch_id is not bound to ${batchId}`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  if (state.status !== 'awaiting-audit') {
    fail(`${label}.status must remain pre-audit until shared audit checks succeed`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
  }
  const stages = requireArray(state.stages, `${label}.stages`);
  if (stages.length !== 4) {
    fail(`${label}.stages must contain exactly four pre-audit stages`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const fullState = {
    ...state,
    stages: [...stages, { id: 'audit', status: 'not-emitted' }, { id: 'admission', status: 'not-emitted' }],
  };
  const seenSources = new Set();
  const seenPayloads = new Set();
  for (const [index, stageId] of LEXICAL_PRODUCTION_STAGE_IDS.slice(0, 4).entries()) {
    validateStage(stages[index], stageId, sourceBytesByStage, fullState, seenSources, seenPayloads, {
      allowReplay,
      expectedPayload: expectedPayloads?.[stageId],
    });
  }
  return {
    contract_version: state.contract_version,
    pipeline_version: state.pipeline_version,
    batch_id: state.batch_id,
    stage_count: stages.length,
    status: state.status,
    stages: stages.map((stage) => structuredClone(stage)),
  };
}

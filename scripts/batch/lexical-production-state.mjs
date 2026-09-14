import { createHash } from 'node:crypto';

export const LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION = 'lexical-production-state-v1';
export const LEXICAL_PRODUCTION_PIPELINE_VERSION = 'lexical-production-v1';

/**
 * Every lexical producer uses the same state machine.  Batch modules may
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
  admission: Object.freeze({ from: 'audit-complete', to: 'admission-authorized' }),
});

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

function digestBytes(bytes) {
  if (bytes === undefined || bytes === null || typeof bytes.length !== 'number') {
    fail('production state source bytes are required for digest verification', 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceBytesFor(stageId, stage, sourceBytesByStage) {
  if (sourceBytesByStage && Object.hasOwn(sourceBytesByStage, stageId)) {
    return sourceBytesByStage[stageId];
  }
  if (Object.hasOwn(stage, 'source_bytes')) return stage.source_bytes;
  return undefined;
}

function stageInput(stageEvidence, stageId) {
  if (Array.isArray(stageEvidence)) {
    return stageEvidence.find((stage) => stage?.id === stageId);
  }
  return stageEvidence?.[stageId];
}

/**
 * Build serializable state metadata from caller-owned stage source bytes.
 * Bytes are deliberately consumed only to calculate a digest and never
 * copied into the state artifact.
 */
export function createLexicalProductionState({
  batchId,
  pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
  stages,
} = {}) {
  requireString(batchId, 'production_state.batch_id');
  requireString(pipelineVersion, 'production_state.pipeline_version');
  const stageValues = LEXICAL_PRODUCTION_STAGE_IDS.map((stageId) => {
    const input = stageInput(stages, stageId);
    requireObject(input, `production_state.stages.${stageId}`);
    const transition = LEXICAL_PRODUCTION_STAGE_TRANSITIONS[stageId];
    const sourcePath = requireString(input.source_path, `production_state.stages.${stageId}.source_path`);
    let sourceSha256 = input.source_sha256;
    if (input.source_bytes !== undefined) {
      sourceSha256 = digestBytes(input.source_bytes);
    }
    requireDigest(sourceSha256, `production_state.stages.${stageId}.source_sha256`);
    const stage = {
      id: stageId,
      status: input.status ?? 'complete',
      transition: {
        from: input.transition?.from ?? transition.from,
        to: input.transition?.to ?? transition.to,
      },
      source_path: sourcePath,
      source_sha256: sourceSha256,
    };
    if (input.policy !== undefined) stage.policy = requireString(input.policy, `production_state.stages.${stageId}.policy`);
    if (input.decision !== undefined) stage.decision = requireString(input.decision, `production_state.stages.${stageId}.decision`);
    if (input.authorization_ref !== undefined) {
      stage.authorization_ref = requireString(
        input.authorization_ref,
        `production_state.stages.${stageId}.authorization_ref`,
      );
    }
    return stage;
  });
  return {
    contract_version: LEXICAL_PRODUCTION_STATE_CONTRACT_VERSION,
    pipeline_version: pipelineVersion,
    batch_id: batchId,
    stages: stageValues,
  };
}

function validateStage(stage, stageId, sourceBytesByStage) {
  const label = `production_state.stages.${stageId}`;
  requireObject(stage, label);
  if (stage.id !== stageId) fail(`${label}.id must be ${stageId}`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  if (stage.status !== 'complete') fail(`${label}.status must be complete`, 'LEXICAL_PRODUCTION_STATE_INCOMPLETE');
  const transition = LEXICAL_PRODUCTION_STAGE_TRANSITIONS[stageId];
  requireObject(stage.transition, `${label}.transition`);
  if (stage.transition.from !== transition.from || stage.transition.to !== transition.to) {
    fail(`${label}.transition is not the shared lexical producer transition`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  requireString(stage.source_path, `${label}.source_path`);
  requireDigest(stage.source_sha256, `${label}.source_sha256`);
  const sourceBytes = sourceBytesFor(stageId, stage, sourceBytesByStage);
  if (sourceBytes === undefined) {
    fail(`${label} requires source bytes for digest verification`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (digestBytes(sourceBytes) !== stage.source_sha256) {
    fail(`${label}.source_sha256 does not match its source bytes`, 'LEXICAL_PRODUCTION_STATE_BINDING');
  }
  if (stageId === 'selection') {
    requireString(stage.policy, `${label}.policy`);
  }
  if (stageId === 'admission') {
    if (stage.decision !== 'admit') {
      fail(`${label}.decision must be the explicit admit decision`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
    }
    if (typeof stage.authorization_ref !== 'string' || stage.authorization_ref.trim().length === 0) {
      fail(`${label}.authorization_ref must identify the explicit authorization`, 'LEXICAL_PRODUCTION_STATE_AUTHORIZATION');
    }
  }
}

/**
 * Validate the complete producer state and bind every stage to the bytes that
 * were actually consumed by the caller.  The returned object is safe to put
 * in a compact gate artifact; it contains no source payloads.
 */
export function validateLexicalProductionState(
  state,
  {
    batchId,
    pipelineVersion = LEXICAL_PRODUCTION_PIPELINE_VERSION,
    sourceBytesByStage,
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
  requireString(state.batch_id, `${label}.batch_id`);
  if (batchId !== undefined && state.batch_id !== batchId) {
    fail(`${label}.batch_id is not bound to ${batchId}`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const stages = Array.isArray(state.stages) ? state.stages : undefined;
  if (!stages || stages.length !== LEXICAL_PRODUCTION_STAGE_IDS.length) {
    fail(`${label}.stages must contain exactly ${LEXICAL_PRODUCTION_STAGE_IDS.length} shared stages`, 'LEXICAL_PRODUCTION_STATE_SCOPE');
  }
  const stageIds = stages.map((stage) => stage?.id);
  if (JSON.stringify(stageIds) !== JSON.stringify(LEXICAL_PRODUCTION_STAGE_IDS)) {
    fail(`${label}.stages must appear in the shared transition order`, 'LEXICAL_PRODUCTION_STATE_TRANSITION');
  }
  for (const [index, stageId] of LEXICAL_PRODUCTION_STAGE_IDS.entries()) {
    validateStage(stages[index], stageId, sourceBytesByStage);
  }
  return {
    contract_version: state.contract_version,
    pipeline_version: state.pipeline_version,
    batch_id: state.batch_id,
    stage_count: stages.length,
    stages: stages.map(({ id, status, transition, source_path, source_sha256, policy, decision, authorization_ref }) => ({
      id,
      status,
      transition,
      source_path,
      source_sha256,
      ...(policy === undefined ? {} : { policy }),
      ...(decision === undefined ? {} : { decision }),
      ...(authorization_ref === undefined ? {} : { authorization_ref }),
    })),
  };
}

export function productionSourceBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

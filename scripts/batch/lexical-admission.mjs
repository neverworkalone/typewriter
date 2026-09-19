import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import {
  auditCanonicalLexicalQuality,
  buildNominalTermPositions,
  validateLexicalRecord,
} from '../validate/lexical-quality.mjs';
import {
  buildSemanticTopicEvidence,
  canonicalRecordsSha256,
  validateSemanticAuditCoverage,
} from '../validate/semantic-audit.mjs';
import {
  createLexicalProductionPayload,
  productionBytesSha256,
  productionValueSha256,
  productionSourceBytes,
  isLexicalProductionRun,
  validateLexicalProductionPreAuditState,
  validateLexicalProductionState,
} from './lexical-production-state.mjs';

export const LEXICAL_ADMISSION_PIPELINE_VERSION = 'lexical-admission-v1';

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function requireBatchId(batchId) {
  if (typeof batchId !== 'string' || batchId.trim().length === 0) {
    throw new Error('lexical admission requires a non-empty batch_id');
  }
  return batchId;
}

function asRecordInfos(records, source, fallbackPath) {
  return records.map((recordInfo, index) => {
    if (recordInfo?.record) return recordInfo;
    return {
      record: recordInfo,
      source,
      filePath: fallbackPath,
      lineNumber: index + 1,
    };
  });
}

/**
 * Common lexical-addition pipeline.
 *
 * A batch supplies scope, selection and ID policy around this function.  The
 * lexical producer/quality contract itself is intentionally batch-neutral:
 * candidate bodies are checked, reviewed canonical bodies are checked, and
 * the complete prospective dictionary is checked for every admission.
 */
function validateLexicalAdditionInternal({
  batchId,
  candidateRecords = [],
  reviewedRecords = [],
  baseRecords,
  prospectiveRecords,
  semanticAudit,
  productionState,
  productionStateSources,
  productionRun,
  productionAuditStage,
  productionAuthorizationEvidence,
  productionAdmissionStage,
  productionPayloads,
  allowReplay = false,
  checkPilotCompleteness = false,
  candidateLabel = 'candidate records',
  reviewedLabel = 'reviewed canonical records',
  prospectiveLabel = 'prospective canonical dataset',
} = {}) {
  requireBatchId(batchId);
  if (baseRecords === undefined) {
    throw new Error('lexical admission requires the complete current base_records');
  }
  if (prospectiveRecords === undefined) {
    throw new Error('lexical admission requires the complete prospective_records');
  }
  if (semanticAudit === undefined) {
    throw new Error('lexical admission requires source-bound semantic_audit coverage');
  }
  let validatedProductionState;
  let validatedProductionPayloads = productionPayloads;
  if (productionRun !== undefined) {
    if (!isLexicalProductionRun(productionRun)) {
      throw new Error('lexical admission requires a producer-owned live production run');
    }
    const preAuditState = productionRun.getPreAuditState();
    const preAuditSources = productionStateSources ?? productionRun.getPreAuditSourceBytesByStage();
    validateLexicalProductionPreAuditState(preAuditState, {
      batchId,
      sourceBytesByStage: preAuditSources,
      expectedPayloads: productionPayloads,
    });
  } else {
    if (productionState === undefined) {
      throw new Error('lexical admission requires the complete production_state');
    }
    if (productionState.producer_mode === 'replay' && !allowReplay) {
      const error = new Error(
        'active lexical admission requires a live producer run; replay state is reserved for explicit historical verification',
      );
      error.code = 'LEXICAL_PRODUCTION_REPLAY_FORBIDDEN';
      throw error;
    }
    const replayState = productionState.producer_mode === 'replay';
    validatedProductionState = validateLexicalProductionState(productionState, {
      batchId,
      sourceBytesByStage: productionStateSources,
      expectedPayloads: replayState ? undefined : productionPayloads,
      allowReplay,
    });
  }
  const candidateInfos = asRecordInfos(candidateRecords, 'candidate', candidateLabel);
  const reviewedInfos = asRecordInfos(reviewedRecords, 'reviewed', reviewedLabel);
  const baseInfos = asRecordInfos(baseRecords, 'base-canonical', 'base-canonical');
  const prospectiveInfos = asRecordInfos(prospectiveRecords, 'prospective-canonical', prospectiveLabel);
  const nominalTerms = buildNominalTermPositions([
    ...candidateInfos,
    ...reviewedInfos,
    ...baseInfos,
    ...prospectiveInfos,
  ]);

  const baseRecordsById = new Map(baseInfos.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  const prospectiveRecordsById = new Map(prospectiveInfos.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  if (baseRecordsById.size !== baseInfos.length) {
    throw new Error('lexical admission base_records contains duplicate record IDs');
  }
  if (prospectiveRecordsById.size !== prospectiveInfos.length) {
    throw new Error('lexical admission prospective_records contains duplicate record IDs');
  }
  const reviewedInfosById = new Map();
  for (const recordInfo of reviewedInfos) {
    const record = recordOf(recordInfo);
    if (reviewedInfosById.has(record.id)) {
      throw new Error(`lexical admission reviewed records contains duplicate record ID ${record.id}`);
    }
    reviewedInfosById.set(record.id, recordInfo);
    if (baseRecordsById.has(record.id) && recordInfo.decision !== 'corrected') {
      throw new Error(`lexical admission replacement of base record ${record.id} requires an explicit corrected decision`);
    }
  }
  for (const [recordId, baseRecord] of baseRecordsById) {
    const prospectiveRecord = prospectiveRecordsById.get(recordId);
    if (!prospectiveRecord) {
      throw new Error(`lexical admission prospective_records is missing base record ${recordId}`);
    }
    if (JSON.stringify(prospectiveRecord) !== JSON.stringify(baseRecord)
      && reviewedInfosById.get(recordId)?.decision !== 'corrected') {
      throw new Error(`lexical admission prospective_records does not preserve base record ${recordId}`);
    }
  }

  for (const [index, recordInfo] of candidateInfos.entries()) {
    validateLexicalRecord(recordOf(recordInfo), {
      label: `${candidateLabel}[${index}]`,
      mode: 'candidate',
      nominalTerms,
    });
  }
  for (const [index, recordInfo] of reviewedInfos.entries()) {
    validateLexicalRecord(recordOf(recordInfo), {
      label: `${reviewedLabel}[${index}]`,
      mode: 'canonical',
      nominalTerms,
    });
  }

  const semanticAuditCoverage = validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: baseInfos,
    label: `${batchId} semantic audit`,
    requireDecisionSource: !allowReplay,
  });
  const topicEvidence = buildSemanticTopicEvidence(prospectiveInfos, semanticAudit, {
    label: `${batchId} semantic audit`,
  });
  const indexes = validateDatasetRecords(prospectiveInfos, {
    checkPilotCompleteness,
    semanticAudit,
    requireSemanticAudit: true,
    semanticAuditBaseRecords: baseInfos,
    requireDecisionSource: !allowReplay,
  });
  // Keep an explicit audit result at this boundary so callers can bind the
  // exact complete-canonical report into their gate evidence.  The dataset
  // validator has already enforced the same report before returning.
  const audit = auditCanonicalLexicalQuality(prospectiveInfos, {
    scope: `${batchId}:prospective-canonical`,
    throwOnError: true,
    topicEvidence,
  });

  if (productionRun !== undefined) {
    if (productionAuditStage === undefined
      || productionAuthorizationEvidence === undefined
      || productionAdmissionStage === undefined) {
      throw new Error('lexical admission requires producer authorization and admission stage evidence');
    }
    const auditOutput = {
      prospective_records_sha256: productionValueSha256(prospectiveInfos.map(recordOf)),
      semantic_audit_sha256: productionValueSha256(semanticAudit),
      lexical_audit_sha256: productionValueSha256(audit),
    };
    const auditPayloadSpec = {
      input: productionPayloads?.outputs?.prospectiveOutput
        ?? prospectiveInfos.map(recordOf),
      output: auditOutput,
      inputKind: 'prospective-canonical',
      outputKind: 'complete-canonical-audit',
      details: auditOutput,
    };
    const auditPayload = createLexicalProductionPayload({
      stageId: 'audit',
      batchId,
      ...auditPayloadSpec,
    });
    const auditToken = productionRun.completeAudit({
      predecessor: productionAuditStage.predecessor,
      sourcePath: productionAuditStage.sourcePath,
      payloadSpec: auditPayloadSpec,
    });
    const authorization = productionRun.authorizeAdmission({
      predecessor: auditToken,
      authorizationRef: productionAuthorizationEvidence.authorizationRef,
      authorizationBytes: productionAuthorizationEvidence.authorizationBytes,
    });
    const gateBytes = productionSourceBytes({
      batch_id: batchId,
      pipeline_version: LEXICAL_ADMISSION_PIPELINE_VERSION,
      candidate_count: candidateInfos.length,
      reviewed_count: reviewedInfos.length,
      prospective_record_count: prospectiveInfos.length,
      semantic_audit: semanticAuditCoverage,
      lexical_audit: audit,
    });
    const admissionOutput = {
      status: 'admitted',
      gate_digest: productionBytesSha256(gateBytes),
    };
    const admissionPayloadSpec = {
      input: auditOutput,
      output: admissionOutput,
      inputKind: 'complete-canonical-audit',
      outputKind: 'admitted-canonical',
      details: {
        authorization_sha256: authorization.authorization_sha256,
        gate_sha256: admissionOutput.gate_digest,
      },
    };
    const admissionPayload = createLexicalProductionPayload({
      stageId: 'admission',
      batchId,
      ...admissionPayloadSpec,
    });
    const admissionToken = productionRun.completeAdmission({
      authorization,
      sourcePath: productionAdmissionStage.sourcePath,
      payloadSpec: admissionPayloadSpec,
      decision: 'admit',
      admissionResult: admissionOutput,
    });
    // The token is deliberately consumed only after every shared admission
    // check above has succeeded.  A producer run that fails earlier cannot
    // expose a completed admission state.
    void admissionToken;
    validatedProductionState = validateLexicalProductionState(productionRun.getState(), {
      batchId,
      sourceBytesByStage: productionRun.getSourceBytesByStage(),
      expectedPayloads: {
        ...productionPayloads,
        audit: auditPayload,
        admission: admissionPayload,
      },
    });
    validatedProductionPayloads = {
      ...productionPayloads,
      audit: auditPayload,
      admission: admissionPayload,
    };
  }

  return {
    pipeline_version: LEXICAL_ADMISSION_PIPELINE_VERSION,
    batch_id: batchId,
    candidate_count: candidateInfos.length,
    reviewed_count: reviewedInfos.length,
    prospective_record_count: prospectiveInfos.length,
    base_record_count: baseInfos.length,
    base_records_sha256: canonicalRecordsSha256(baseInfos),
    production_state: validatedProductionState,
    production_payloads: validatedProductionPayloads,
    semantic_audit: semanticAuditCoverage,
    indexes,
    audit,
  };
}

/**
 * Validate a new admission.  Replay is not an option on the common API:
 * active and future registrations must be backed by a live producer run.
 */
export function validateLexicalAddition(options = {}) {
  if (options?.allowReplay === true) {
    const error = new Error(
      'generic lexical admission never accepts replay; use validateHistoricalLexicalAddition for explicit historical verification',
    );
    error.code = 'LEXICAL_PRODUCTION_REPLAY_FORBIDDEN';
    throw error;
  }
  return validateLexicalAdditionInternal({ ...options, allowReplay: false });
}

/**
 * Historical verification boundary for durable/replayed artifacts.  Keeping
 * this separate makes the replay exception visible at every caller.
 */
export function validateHistoricalLexicalAddition(options = {}) {
  if (options?.allowReplay !== true) {
    const error = new Error(
      'historical lexical admission requires an explicit allowReplay: true opt-in',
    );
    error.code = 'LEXICAL_PRODUCTION_REPLAY_OPT_IN_REQUIRED';
    throw error;
  }
  return validateLexicalAdditionInternal({ ...options, allowReplay: true });
}

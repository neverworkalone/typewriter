import { isVerifiedImmutable, recordCompleteRevisionCheck } from '../validate/immutable-digest.mjs';
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
  assertAdmissionInputsBoundToProducer,
  assertCompletedAdmissionTailBoundToProducer,
  assertProspectiveRecordsDerivedFromBaseRecords,
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

const AUDIT_SCOPE_SENTINEL = '\u0000typewriter-audit-scope\u0000';

function substituteAuditScope(value, scope) {
  if (typeof value === 'string') return value.split(AUDIT_SCOPE_SENTINEL).join(scope);
  if (Array.isArray(value)) return value.map((item) => substituteAuditScope(item, scope));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, substituteAuditScope(item, scope)],
    ));
  }
  return value;
}

// The complete-canonical lexical audit depends only on the record set and the
// topic projection; the batch scope appears solely as text inside the report.
// With a shared context over verified-immutable records it is computed once under
// a sentinel scope and each batch receives the exact report for its own scope.
// Any blocking finding re-runs the direct audit so the failure is identical.
function completeLexicalAuditForScope(prospectiveInfos, {
  scope,
  topicEvidence,
  sharedContext,
  memoKey,
}) {
  const direct = () => auditCanonicalLexicalQuality(prospectiveInfos, {
    scope,
    throwOnError: true,
    topicEvidence,
  });
  if (!sharedContext || !prospectiveInfos.every(isVerifiedImmutable)) return direct();
  sharedContext.derived ??= {};
  sharedContext.derived.admissionLexicalAudit ??= {};
  let core = sharedContext.derived.admissionLexicalAudit[memoKey];
  if (!core) {
    core = auditCanonicalLexicalQuality(prospectiveInfos, {
      scope: AUDIT_SCOPE_SENTINEL,
      throwOnError: false,
      topicEvidence,
    });
    sharedContext.derived.admissionLexicalAudit[memoKey] = core;
    recordCompleteRevisionCheck(sharedContext, 'lexical-audit', 'computed');
  } else {
    recordCompleteRevisionCheck(sharedContext, 'lexical-audit', 'reused');
  }
  if (core.blocking_finding_count > 0) return direct();
  return substituteAuditScope(core, scope);
}

function asRecordInfos(records, source, fallbackPath) {
  // Already-wrapped record infos keep their array identity so a shared canonical
  // context (and its identity-keyed audit cache) still describes this input.
  if (records.every((recordInfo) => recordInfo?.record)) return records;
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
  canonicalContext,
  allowReplay = false,
  allowHistoricalRelationEnrichment = false,
  checkPilotCompleteness = false,
  candidateLabel = 'candidate records',
  reviewedLabel = 'reviewed canonical records',
  prospectiveLabel = 'prospective canonical dataset',
} = {}) {
  if (allowHistoricalRelationEnrichment && !allowReplay) {
    const error = new Error('historical relation enrichment requires explicit replay authorization');
    error.code = 'LEXICAL_PRODUCTION_REPLAY_OPT_IN_REQUIRED';
    throw error;
  }
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
      allowReplay,
      allowHistoricalRelationEnrichment,
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
      allowHistoricalRelationEnrichment,
    });
  }
  const hasProducerBinding = validatedProductionState?.producer_mode === 'live'
    || productionRun !== undefined
    || validatedProductionPayloads !== undefined;
  const producerCandidateRecords = validatedProductionPayloads?.candidate_intake?.output;
  const boundCandidateRecords = hasProducerBinding && candidateRecords.length === 0
    ? producerCandidateRecords ?? []
    : candidateRecords;
  const candidateInfos = asRecordInfos(boundCandidateRecords, 'candidate', candidateLabel);
  const reviewedInfos = asRecordInfos(reviewedRecords, 'reviewed', reviewedLabel);
  const baseInfos = asRecordInfos(baseRecords, 'base-canonical', 'base-canonical');
  const prospectiveInfos = asRecordInfos(prospectiveRecords, 'prospective-canonical', prospectiveLabel);
  if (canonicalContext !== undefined) {
    // The very same record array is trivially the complete prospective set; any
    // other array must still match the context by content digest.
    if (!Array.isArray(canonicalContext?.records)
      || (canonicalContext.records !== prospectiveInfos
        && canonicalRecordsSha256(canonicalContext.records.map(recordOf))
          !== canonicalRecordsSha256(prospectiveInfos.map(recordOf)))) {
      const error = new Error(
        'lexical admission canonical_context must describe the complete prospective_records exactly',
      );
      error.code = 'LEXICAL_ADMISSION_CONTEXT_MISMATCH';
      throw error;
    }
  }
  let producerDecisionsByRecordId;
  if (hasProducerBinding) {
    producerDecisionsByRecordId = assertAdmissionInputsBoundToProducer(
      validatedProductionPayloads,
      {
        candidateRecords: candidateInfos.map(recordOf),
        baseRecords: baseInfos.map(recordOf),
        reviewedRecordInfos: reviewedInfos,
        prospectiveRecords: prospectiveInfos.map(recordOf),
        semanticAudit,
        requireAudit: validatedProductionState?.producer_mode === 'live',
        allowHistoricalRelationEnrichment,
      },
      `${batchId} lexical admission`,
    );
  }
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
    const producerDecision = producerDecisionsByRecordId?.get(record.id);
    const decision = producerDecision ?? recordInfo.decision;
    if (reviewedInfosById.has(record.id)) {
      throw new Error(`lexical admission reviewed records contains duplicate record ID ${record.id}`);
    }
    reviewedInfosById.set(record.id, recordInfo);
    if (baseRecordsById.has(record.id) && decision !== 'corrected') {
      throw new Error(`lexical admission replacement of base record ${record.id} requires a producer-owned corrected decision`);
    }
  }
  for (const [recordId, baseRecord] of baseRecordsById) {
    const prospectiveRecord = prospectiveRecordsById.get(recordId);
    if (!prospectiveRecord) {
      throw new Error(`lexical admission prospective_records is missing base record ${recordId}`);
    }
    if (JSON.stringify(prospectiveRecord) !== JSON.stringify(baseRecord)
      && (producerDecisionsByRecordId?.get(recordId) ?? reviewedInfosById.get(recordId)?.decision) !== 'corrected') {
      throw new Error(`lexical admission prospective_records does not preserve base record ${recordId} without a producer-owned corrected decision`);
    }
  }
  assertProspectiveRecordsDerivedFromBaseRecords(
    baseInfos.map(recordOf),
    reviewedInfos.map(recordOf),
    prospectiveInfos.map(recordOf),
    `${batchId} lexical admission`,
    { allowHistoricalRelationEnrichment },
  );

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

  // A shared canonical context for exactly this prospective set and audit lets
  // every batch reuse digests and the topic projection instead of recomputing the
  // complete-canonical derivation; batch-specific base checks still run per call.
  const sharedContext = canonicalContext !== undefined
    && canonicalContext.records === prospectiveInfos
    && canonicalContext.semanticAudit === semanticAudit
    ? canonicalContext
    : undefined;
  const hashCache = sharedContext?.semanticAuditCache;
  const semanticAuditCoverage = validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: baseInfos,
    label: `${batchId} semantic audit`,
    requireDecisionSource: !allowReplay,
    // Historical replay validates the recorded artifact and its digests as-is;
    // current admission still requires complete span-bound topic evidence.
    requireTopicAnalysis: !allowReplay,
    hashCache,
  });
  const topicEvidenceKey = allowReplay ? 'replay' : 'current';
  const memoizedTopicEvidence = sharedContext?.derived?.admissionTopicEvidence?.[topicEvidenceKey];
  if (sharedContext) {
    recordCompleteRevisionCheck(sharedContext, 'topic-evidence', memoizedTopicEvidence ? 'reused' : 'computed');
  }
  const topicEvidence = memoizedTopicEvidence ?? buildSemanticTopicEvidence(prospectiveInfos, semanticAudit, {
    label: `${batchId} semantic audit`,
    requireTopicAnalysis: !allowReplay,
    hashCache,
  });
  if (sharedContext && !memoizedTopicEvidence) {
    sharedContext.derived ??= {};
    sharedContext.derived.admissionTopicEvidence ??= {};
    sharedContext.derived.admissionTopicEvidence[topicEvidenceKey] = topicEvidence;
  }
  const indexes = validateDatasetRecords(prospectiveInfos, {
    context: canonicalContext,
    checkPilotCompleteness,
    semanticAudit,
    requireSemanticAudit: true,
    semanticAuditBaseRecords: baseInfos,
    requireDecisionSource: !allowReplay,
    requireTopicAnalysis: !allowReplay,
    // Live admission validates the entire prospective canonical dictionary.
    // Historical replay stays on its recorded contract and does not inherit
    // current M6-3 classifications or collision-review requirements.
    requireSurfaceFormProjection: !allowReplay,
    requireSurfaceFormClassifications: !allowReplay,
    requireSurfaceFormCollisionReview: !allowReplay,
  });
  // Keep an explicit audit result at this boundary so callers can bind the
  // exact complete-canonical report into their gate evidence.  The dataset
  // validator has already enforced the same report before returning.
  const audit = completeLexicalAuditForScope(prospectiveInfos, {
    scope: `${batchId}:prospective-canonical`,
    topicEvidence,
    sharedContext,
    memoKey: topicEvidenceKey,
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
      allowReplay,
      allowHistoricalRelationEnrichment,
    });
    validatedProductionPayloads = {
      ...productionPayloads,
      audit: auditPayload,
      admission: admissionPayload,
    };
    producerDecisionsByRecordId = assertAdmissionInputsBoundToProducer(
      validatedProductionPayloads,
      {
        candidateRecords: candidateInfos.map(recordOf),
        baseRecords: baseInfos.map(recordOf),
        reviewedRecordInfos: reviewedInfos,
        prospectiveRecords: prospectiveInfos.map(recordOf),
        semanticAudit,
        requireAudit: true,
        allowHistoricalRelationEnrichment,
      },
      `${batchId} lexical admission`,
    );
  }

  if (validatedProductionState?.producer_mode === 'live') {
    assertCompletedAdmissionTailBoundToProducer(
      validatedProductionPayloads,
      {
        batchId,
        pipelineVersion: LEXICAL_ADMISSION_PIPELINE_VERSION,
        candidateCount: candidateInfos.length,
        reviewedCount: reviewedInfos.length,
        prospectiveRecordCount: prospectiveInfos.length,
        semanticAuditCoverage,
        lexicalAudit: audit,
      },
      `${batchId} lexical admission`,
    );
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

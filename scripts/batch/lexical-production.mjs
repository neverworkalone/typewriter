import { validateLexicalAddition } from './lexical-admission.mjs';
import {
  createLexicalProductionRun,
  productionBytesSha256,
  productionStageBytes,
  validateLexicalProductionPreAuditState,
  validateLexicalProductionState,
} from './lexical-production-state.mjs';
import { validateLexicalSemanticReview } from '../validate/lexical-quality.mjs';

export const LEXICAL_PRODUCTION_PIPELINE_VERSION = 'lexical-production-v1';
export const LEXICAL_PRODUCTION_DECISIONS = Object.freeze([
  'included',
  'corrected',
  'held',
  'rejected',
  'deferred',
]);

export class LexicalProductionError extends Error {
  constructor(message, code = 'LEXICAL_PRODUCTION_ERROR') {
    super(message);
    this.name = 'LexicalProductionError';
    this.code = code;
  }
}

function fail(message, code = 'LEXICAL_PRODUCTION_ERROR') {
  throw new LexicalProductionError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'LEXICAL_PRODUCTION_SHAPE');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'LEXICAL_PRODUCTION_SHAPE');
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'LEXICAL_PRODUCTION_VALUE');
  }
  return value;
}

function requireSourceBytes(value, label) {
  if (!value || typeof value.length !== 'number') {
    fail(`${label} must provide the source bytes for digest verification`, 'LEXICAL_PRODUCTION_STAGE_BINDING');
  }
  return value;
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function semanticReviewInput(entry, index) {
  const label = `production.reviews[${index}]`;
  requireObject(entry, label);
  requireString(entry.candidate_id, `${label}.candidate_id`);
  requireString(entry.decision, `${label}.decision`);
  if (!LEXICAL_PRODUCTION_DECISIONS.includes(entry.decision)) {
    fail(`${label}.decision is not a supported production decision`, 'LEXICAL_PRODUCTION_DECISION');
  }
  requireObject(entry.semantic_review, `${label}.semantic_review`);
  return entry;
}

function validateStageEvidence(
  stageEvidence,
  {
    productionState,
    batchId,
    productionStateSources,
  } = {},
) {
  if (productionState !== undefined) {
    try {
      const state = validateLexicalProductionState(productionState, {
        batchId,
        sourceBytesByStage: productionStateSources,
      });
      return {
        state,
        run: undefined,
        authorization: undefined,
        authorizationEvidence: undefined,
        auditStage: undefined,
        admissionStage: undefined,
        sources: productionStateSources,
      };
    } catch (error) {
      fail(`production_state failed: ${error.message}`, error.code);
    }
  }
  if (stageEvidence === undefined) {
    fail('production.stage_evidence or production_state is required', 'LEXICAL_PRODUCTION_STAGE_REQUIRED');
  }
  const stages = requireObject(stageEvidence, 'production.stage_evidence');
  const stageIds = [
    'candidate_intake',
    'semantic_review',
    'selection',
    'prospective_canonical',
    'audit',
    'admission',
  ];
  for (const stageId of stageIds) {
    const stage = requireObject(stages[stageId], `production.stage_evidence.${stageId}`);
    if (stage.status !== 'complete') {
      fail(
        `production.stage_evidence.${stageId}.status must be complete`,
        'LEXICAL_PRODUCTION_STAGE_REQUIRED',
      );
    }
    requireString(stage.source_path, `production.stage_evidence.${stageId}.source_path`);
    const sourceBytes = requireSourceBytes(
      stage.source_bytes,
      `production.stage_evidence.${stageId}.source_bytes`,
    );
    if (stage.source_sha256 !== undefined && productionBytesSha256(sourceBytes) !== stage.source_sha256) {
      fail(
        `production.stage_evidence.${stageId}.source_sha256 does not match its source bytes`,
        'LEXICAL_PRODUCTION_STAGE_BINDING',
      );
    }
  }
  try {
    const run = createLexicalProductionRun({ batchId });
    const tokens = {};
    const methodNames = {
      candidate_intake: 'completeCandidateIntake',
      semantic_review: 'completeSemanticReview',
      selection: 'completeSelection',
      prospective_canonical: 'completeProspectiveCanonical',
      audit: 'completeAudit',
    };
    for (const stageId of stageIds.slice(0, 4)) {
      const stage = stages[stageId];
      const previousStageId = stageIds[stageIds.indexOf(stageId) - 1];
      const sourceBytes = productionStageBytes(stageId, stage.source_bytes);
      tokens[stageId] = run[methodNames[stageId]]({
        ...(previousStageId ? { predecessor: tokens[previousStageId] } : {}),
        sourcePath: stage.source_path,
        sourceBytes,
        ...(stageId === 'selection' ? { policy: stage.policy ?? 'shared-selection-policy' } : {}),
      });
    }
    const auditEvidence = stages.audit;
    const admissionEvidence = stages.admission;
    const authorizationBytes = admissionEvidence.authorization_bytes === undefined
      ? admissionEvidence.source_bytes
      : admissionEvidence.authorization_bytes;
    const auditStage = {
      predecessor: tokens.prospective_canonical,
      sourcePath: auditEvidence.source_path,
      sourceBytes: productionStageBytes('audit', auditEvidence.source_bytes),
    };
    const admissionStage = {
      sourcePath: admissionEvidence.source_path,
      sourceBytes: productionStageBytes('admission', admissionEvidence.source_bytes),
    };
    const preAuditState = run.getPreAuditState();
    const preAuditSources = run.getPreAuditSourceBytesByStage();
    validateLexicalProductionPreAuditState(preAuditState, {
      batchId,
      sourceBytesByStage: preAuditSources,
    });
    return {
      state: undefined,
      run,
      authorization: undefined,
      authorizationEvidence: {
        authorizationRef: admissionEvidence.authorization_ref,
        authorizationBytes,
      },
      auditStage,
      admissionStage,
      sources: preAuditSources,
    };
  } catch (error) {
    fail(`production stage evidence failed: ${error.message}`, error.code);
  }
}

/**
 * Batch-neutral production/review orchestration.
 *
 * A caller supplies candidate records and source-bound review rows.  The
 * function owns the stage order and shared semantic checks; a batch may only
 * add its own scope/count/ID policy around the returned result.
 */
export function validateLexicalProduction({
  batchId,
  candidateRecords,
  reviews,
  corrections = [],
  baseRecords,
  prospectiveRecords,
  semanticAudit,
  stageEvidence,
  productionState,
  productionStateSources,
  checkPilotCompleteness = false,
  catalogCount,
  expectedSelectedCount,
  candidateLabel = 'production candidate records',
  reviewedLabel = 'production reviewed records',
  prospectiveLabel = 'production prospective canonical records',
} = {}) {
  if (typeof batchId !== 'string' || batchId.trim().length === 0) {
    fail('production.batch_id must be a non-empty string', 'LEXICAL_PRODUCTION_SCOPE');
  }
  const candidates = requireArray(candidateRecords, 'production.candidate_records');
  const reviewRows = requireArray(reviews, 'production.reviews');
  const correctionRows = requireArray(corrections, 'production.corrections');
  if (candidates.length === 0 && correctionRows.length === 0) {
    fail('production must contain candidate records or reviewed corrections', 'LEXICAL_PRODUCTION_SCOPE');
  }
  if (reviewRows.length !== candidates.length) {
    fail('production.reviews must cover every candidate record', 'LEXICAL_PRODUCTION_SCOPE');
  }
  if (catalogCount !== undefined && catalogCount !== candidates.length) {
    fail(
      `production.catalog_count ${catalogCount} must cover the complete candidate pool (${candidates.length})`,
      'LEXICAL_PRODUCTION_SCOPE',
    );
  }
  if (baseRecords === undefined) {
    fail('production.base_records is required; admissions must bind the current canonical base', 'LEXICAL_PROSPECTIVE_REQUIRED');
  }
  if (prospectiveRecords === undefined) {
    fail('production.prospective_records is required; partial batch input cannot be admitted', 'LEXICAL_PROSPECTIVE_REQUIRED');
  }
  if (semanticAudit === undefined) {
    fail('production.semantic_audit is required; semantic coverage cannot be inferred from a batch delta', 'SEMANTIC_AUDIT_REQUIRED');
  }
  const candidateRecordsById = new Map();
  for (const [index, candidateInfo] of candidates.entries()) {
    const candidate = recordOf(candidateInfo);
    requireString(candidate.id, `production.candidate_records[${index}].id`);
    if (candidateRecordsById.has(candidate.id)) {
      fail(`production.candidate_records contains duplicate candidate ${candidate.id}`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    candidateRecordsById.set(candidate.id, candidate);
  }
  const selectedRecords = [];
  const ranks = [];
  const candidateIds = new Set();
  for (const [index, rawEntry] of reviewRows.entries()) {
    const entry = semanticReviewInput(rawEntry, index);
    const candidate = recordOf(candidates[index]);
    if (entry.candidate_id !== candidate.id) {
      fail(`production.reviews[${index}].candidate_id is not bound to ${candidate.id}`, 'LEXICAL_PRODUCTION_BINDING');
    }
    if (candidateIds.has(entry.candidate_id)) {
      fail(`production.reviews contains duplicate candidate ${entry.candidate_id}`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    candidateIds.add(entry.candidate_id);
    const reviewedRecord = entry.reviewed_record ? recordOf(entry.reviewed_record) : undefined;
    if (['included', 'corrected'].includes(entry.decision)) {
      if (!reviewedRecord) fail(`production.reviews[${index}] selected decision is missing reviewed_record`, 'LEXICAL_PRODUCTION_REVIEW_MISSING');
      const duplicateSelectedId = selectedRecords.some((recordInfo) => recordOf(recordInfo).id === reviewedRecord.id);
      if (duplicateSelectedId) {
        fail(`production.reviews selects duplicate reviewed record ${reviewedRecord.id}`, 'LEXICAL_PRODUCTION_SCOPE');
      }
      selectedRecords.push({
        record: entry.reviewed_record,
        decision: entry.decision,
        semantic_review: entry.semantic_review,
      });
    } else if (reviewedRecord) {
      fail(`production.reviews[${index}] non-selected decision must not carry reviewed_record`, 'LEXICAL_PRODUCTION_REVIEW_MISMATCH');
    }
    let result;
    try {
      result = validateLexicalSemanticReview(entry.semantic_review, {
        decision: entry.decision,
        candidateRecord: candidate,
        reviewedRecord,
        inventoryId: entry.inventory_id,
        expectedRecordType: entry.expected_record_type,
        catalogCount: catalogCount ?? candidates.length,
        requireSemanticEvidence: true,
        selectionRationaleTokens: ['verification', 'coverage'],
      });
    } catch (error) {
      fail(`production.reviews[${index}] semantic review failed: ${error.message}`, error.code);
    }
    ranks.push(result.selection_rank);
  }

  const correctionRecords = [];
  const correctionIds = new Set();
  const baseRecordsById = new Map(
    (baseRecords ?? []).map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]),
  );
  for (const [index, rawEntry] of correctionRows.entries()) {
    const label = `production.corrections[${index}]`;
    const entry = requireObject(rawEntry, label);
    requireString(entry.record_id, `${label}.record_id`);
    if (correctionIds.has(entry.record_id)) {
      fail(`${label}.record_id is duplicated`, 'LEXICAL_PRODUCTION_SCOPE');
    }
    correctionIds.add(entry.record_id);
    if (entry.decision !== 'corrected') {
      fail(`${label}.decision must be corrected`, 'LEXICAL_PRODUCTION_DECISION');
    }
    const baseRecord = baseRecordsById.get(entry.record_id);
    if (!baseRecord) {
      fail(`${label}.record_id is not present in base_records`, 'LEXICAL_PRODUCTION_BINDING');
    }
    const reviewedRecord = recordOf(entry.reviewed_record);
    if (!reviewedRecord || reviewedRecord.id !== entry.record_id) {
      fail(`${label}.reviewed_record must replace the named base record`, 'LEXICAL_PRODUCTION_BINDING');
    }
    requireObject(entry.semantic_review, `${label}.semantic_review`);
    let result;
    try {
      result = validateLexicalSemanticReview(entry.semantic_review, {
        decision: 'corrected',
        candidateRecord: baseRecord,
        reviewedRecord,
        inventoryId: entry.inventory_id,
        expectedRecordType: entry.expected_record_type,
        catalogCount: catalogCount ?? Math.max(candidates.length, 1),
        requireSemanticEvidence: true,
        selectionRationaleTokens: ['verification', 'coverage'],
      });
    } catch (error) {
      fail(`${label} semantic review failed: ${error.message}`, error.code);
    }
    correctionRecords.push({
      record: reviewedRecord,
      decision: 'corrected',
      semantic_review: entry.semantic_review,
    });
    ranks.push(result.selection_rank);
  }

  if (new Set(ranks).size !== ranks.length) {
    fail('production semantic selection ranks must be unique', 'LEXICAL_PRODUCTION_SELECTION');
  }
  const selectedCount = selectedRecords.length + correctionRecords.length;
  if (expectedSelectedCount !== undefined && selectedCount !== expectedSelectedCount) {
    fail(`production selected ${selectedCount} record(s), expected ${expectedSelectedCount}`, 'LEXICAL_PRODUCTION_SELECTION');
  }

  const prospectiveRecordsById = new Map(
    prospectiveRecords.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]),
  );
  for (const [index, entry] of reviewRows.entries()) {
    if (!['included', 'corrected'].includes(entry.decision)) continue;
    const reviewedRecord = recordOf(entry.reviewed_record);
    const prospectiveRecord = prospectiveRecordsById.get(reviewedRecord.id);
    if (!prospectiveRecord || JSON.stringify(prospectiveRecord) !== JSON.stringify(reviewedRecord)) {
      fail(
        `production.reviews[${index}].reviewed_record is not present unchanged in prospective_records`,
        'LEXICAL_PRODUCTION_BINDING',
      );
    }
  }

  const productionContext = validateStageEvidence(stageEvidence, {
    productionState,
    batchId,
    productionStateSources,
  });

  let admission;
  try {
    admission = validateLexicalAddition({
      batchId,
      candidateRecords: candidates,
      reviewedRecords: [...selectedRecords, ...correctionRecords],
      baseRecords,
      prospectiveRecords,
      semanticAudit,
      productionState: productionContext.state,
      productionStateSources: productionContext.sources,
      productionRun: productionContext.run,
      productionAuditStage: productionContext.auditStage,
      productionAuthorizationEvidence: productionContext.authorizationEvidence,
      productionAdmissionStage: productionContext.admissionStage,
      checkPilotCompleteness,
      candidateLabel,
      reviewedLabel,
      prospectiveLabel,
    });
  } catch (error) {
    fail(`production admission failed: ${error.message}`, error.code);
  }
  return {
    pipeline_version: LEXICAL_PRODUCTION_PIPELINE_VERSION,
    batch_id: batchId,
    candidate_count: candidates.length,
    selected_count: selectedCount,
    correction_count: correctionRecords.length,
    review_count: reviewRows.length,
    selection_ranks: ranks,
    production_state: admission.production_state,
    production_state_sources: productionContext.run
      ? productionContext.run.getSourceBytesByStage()
      : productionContext.sources,
    admission,
  };
}

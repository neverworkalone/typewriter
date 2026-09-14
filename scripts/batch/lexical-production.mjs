import { createHash } from 'node:crypto';

import { validateLexicalAddition } from './lexical-admission.mjs';
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

function validateStageEvidence(stageEvidence) {
  const stages = requireObject(stageEvidence, 'production.stage_evidence');
  for (const stageId of ['candidate_intake', 'semantic_review', 'selection']) {
    const stage = requireObject(stages[stageId], `production.stage_evidence.${stageId}`);
    if (stage.status !== 'complete') {
      fail(`production.stage_evidence.${stageId}.status must be complete`, 'LEXICAL_PRODUCTION_STAGE_INCOMPLETE');
    }
    requireString(stage.source_path, `production.stage_evidence.${stageId}.source_path`);
    requireString(stage.source_sha256, `production.stage_evidence.${stageId}.source_sha256`);
    if (!/^[a-f0-9]{64}$/u.test(stage.source_sha256)) {
      fail(`production.stage_evidence.${stageId}.source_sha256 must be a SHA-256 digest`, 'LEXICAL_PRODUCTION_STAGE_BINDING');
    }
    const sourceBytes = requireSourceBytes(
      stage.source_bytes,
      `production.stage_evidence.${stageId}.source_bytes`,
    );
    const actualDigest = createHash('sha256').update(sourceBytes).digest('hex');
    if (actualDigest !== stage.source_sha256) {
      fail(
        `production.stage_evidence.${stageId}.source_sha256 does not match source_bytes`,
        'LEXICAL_PRODUCTION_STAGE_BINDING',
      );
    }
  }
  requireString(stages.selection.policy, 'production.stage_evidence.selection.policy');
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
  baseRecords,
  prospectiveRecords,
  semanticAudit,
  stageEvidence,
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
  if (candidates.length === 0) fail('production.candidate_records must not be empty', 'LEXICAL_PRODUCTION_SCOPE');
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
  validateStageEvidence(stageEvidence);

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
      selectedRecords.push(entry.reviewed_record);
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

  if (new Set(ranks).size !== ranks.length) {
    fail('production semantic selection ranks must be unique', 'LEXICAL_PRODUCTION_SELECTION');
  }
  if (expectedSelectedCount !== undefined && selectedRecords.length !== expectedSelectedCount) {
    fail(`production selected ${selectedRecords.length} record(s), expected ${expectedSelectedCount}`, 'LEXICAL_PRODUCTION_SELECTION');
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

  let admission;
  try {
    admission = validateLexicalAddition({
      batchId,
      candidateRecords: candidates,
      reviewedRecords: selectedRecords,
      baseRecords,
      prospectiveRecords,
      semanticAudit,
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
    selected_count: selectedRecords.length,
    review_count: reviewRows.length,
    selection_ranks: ranks,
    admission,
  };
}

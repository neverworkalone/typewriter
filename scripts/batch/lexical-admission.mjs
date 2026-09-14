import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import {
  auditCanonicalLexicalQuality,
  validateLexicalRecord,
} from '../validate/lexical-quality.mjs';

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
export function validateLexicalAddition({
  batchId,
  candidateRecords = [],
  reviewedRecords = [],
  prospectiveRecords,
  checkPilotCompleteness = false,
  candidateLabel = 'candidate records',
  reviewedLabel = 'reviewed canonical records',
  prospectiveLabel = 'prospective canonical dataset',
} = {}) {
  requireBatchId(batchId);
  const candidateInfos = asRecordInfos(candidateRecords, 'candidate', candidateLabel);
  const reviewedInfos = asRecordInfos(reviewedRecords, 'reviewed', reviewedLabel);
  const prospectiveInfos = asRecordInfos(
    prospectiveRecords ?? reviewedRecords,
    'prospective-canonical',
    prospectiveLabel,
  );

  for (const [index, recordInfo] of candidateInfos.entries()) {
    validateLexicalRecord(recordOf(recordInfo), {
      label: `${candidateLabel}[${index}]`,
      mode: 'candidate',
    });
  }
  for (const [index, recordInfo] of reviewedInfos.entries()) {
    validateLexicalRecord(recordOf(recordInfo), {
      label: `${reviewedLabel}[${index}]`,
      mode: 'canonical',
    });
  }

  let indexes = null;
  let audit = auditCanonicalLexicalQuality([], {
    scope: `${batchId}:prospective-canonical`,
    throwOnError: true,
  });
  if (prospectiveInfos.length > 0) {
    indexes = validateDatasetRecords(prospectiveInfos, { checkPilotCompleteness });
    // Keep an explicit audit result at this boundary so callers can bind the
    // exact complete-canonical report into their gate evidence.  The dataset
    // validator has already enforced the same report before returning.
    audit = auditCanonicalLexicalQuality(prospectiveInfos, {
      scope: `${batchId}:prospective-canonical`,
      throwOnError: true,
    });
  }

  return {
    pipeline_version: LEXICAL_ADMISSION_PIPELINE_VERSION,
    batch_id: batchId,
    candidate_count: candidateInfos.length,
    reviewed_count: reviewedInfos.length,
    prospective_record_count: prospectiveInfos.length,
    indexes,
    audit,
  };
}

import { createHash } from 'node:crypto';

// Data-level control behind the intake hand-off policy (issue #251, PR B).
// Every canonical record is either part of a validated Issue #223 corpus batch
// import (reviewed candidate-review, and from INTAKE_HANDOFF_FIRST_BATCH the
// intake hand-off) or belongs to the frozen non-batch baseline. Whatever script,
// file name or path variable inserted a record, an id outside both changes the
// baseline digest and fails validation. Changing the baseline is an explicit,
// reviewed edit of data/validation/canonical-non-batch-baseline.json.
export const BASELINE_CONTRACT = 'canonical-non-batch-baseline-v1';

const idsDigest = (ids) => createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');

export function nonBatchRecordIds(canonicalRecords, batchImportRecords) {
  const batchIds = new Set(batchImportRecords.map((record) => record.id));
  return canonicalRecords
    .map((info) => (info?.record ?? info).id)
    .filter((id) => !batchIds.has(id));
}

export function makeBaseline({ canonicalRecords, batchImportRecords, throughBatch }) {
  const ids = nonBatchRecordIds(canonicalRecords, batchImportRecords);
  return { schema_version: '1', contract_version: BASELINE_CONTRACT, through_batch: throughBatch, record_count: ids.length, record_ids_sha256: idsDigest(ids) };
}

export function assertCanonicalOnlyFromReviewedBatches({ canonicalRecords, batchImportRecords, baseline }) {
  if (baseline?.contract_version !== BASELINE_CONTRACT) throw new Error('canonical non-batch baseline has an unsupported contract version');
  const ids = nonBatchRecordIds(canonicalRecords, batchImportRecords);
  if (ids.length !== baseline.record_count || idsDigest(ids) !== baseline.record_ids_sha256) {
    const error = new Error(`canonical data contains ${ids.length} record(s) outside validated corpus batches, baseline expects ${baseline.record_count}; new records must enter through a reviewed batch (candidate-review${'' } and, from batch 16, the intake hand-off)`);
    error.code = 'CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH';
    throw error;
  }
  return true;
}

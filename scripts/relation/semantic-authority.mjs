import path from 'node:path';

import { isLicensedSourceRecord } from '../validate/licensed-source.mjs';
import { SEMANTIC_DECISION_SOURCE_ARRAYS } from '../lib/sharded-json-sources.mjs';
import { RelationPlanError, canonicalRecordSha256 } from './plan.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  compactSemanticReviewRecord,
  readAuthoredBatchDecisionSources,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import { planShardedJsonChanges, readShardedJson } from '../lib/sharded-json.mjs';

const AUTHORITY_PATH = 'data/validation/canonical-semantic-decision-source.json';
const failSystemic = (message, code) => { throw new RelationPlanError(message, { category: 'systemic', code }); };

function boundText(record, sense, sourceCandidateId, text) {
  const value = typeof text === 'string' && text.trim() ? text.trim() : `${sourceCandidateId}: approved Canonical relation decision.`;
  return `${record.id} ${sense.id} ${sha256Json(sense.gloss).slice(0, 12)} [${sourceCandidateId}]: ${value}`;
}

function buildReviewForRelationAmendment({ record, beforeReview, amendments, batchId, attempt }) {
  if (!beforeReview) failSystemic(`${record.id}: relation amendment has no preserved semantic review`, 'RELATION_BASE_REVIEW_MISSING');
  const full = structuredClone(beforeReview);
  delete full.authored_batch_decision;
  full.record_sha256 = canonicalRecordSha256(record);
  for (const amendment of amendments) {
    const sense = record.senses.find(({ id }) => id === amendment.source_sense_id);
    const review = full.sense_reviews?.find(({ sense_id: id }) => id === amendment.source_sense_id);
    if (!sense || !review) failSystemic(`${record.id}: prior semantic review omitted ${amendment.source_sense_id}`, 'RELATION_BASE_REVIEW_MISSING');
    const text = boundText(record, sense, amendment.source_candidate_id,
      `relation packet ${batchId} attempt ${attempt} appended ${amendment.relation.type} relation ${amendment.relation_id} to ${amendment.relation.target}; rationale digest ${amendment.rationale_sha256.slice(0, 12)}.`);
    const previous = review.relation_rationale ?? review.relation?.rationale;
    const hadNone = (review.relation_decision ?? review.relation?.decision) === 'no-relations';
    review.relation_decision = 'relations-reviewed';
    review.relation_rationale = hadNone || !previous ? text : `${previous} ${text}`;
    delete review.no_relation_rationale;
    if (review.relation) {
      review.relation.decision = 'relations-reviewed';
      review.relation.rationale = review.relation_rationale;
      delete review.relation.no_relation_rationale;
    }
    review.sense_sha256 = canonicalRecordSha256(sense);
  }
  return compactSemanticReviewRecord(full);
}

function buildReviewForRelationCorrection({ record, beforeReview, corrections, batchId, attempt }) {
  if (!beforeReview) failSystemic(`${record.id}: relation correction has no preserved semantic review`, 'RELATION_BASE_REVIEW_MISSING');
  const full = structuredClone(beforeReview);
  delete full.authored_batch_decision;
  full.record_sha256 = canonicalRecordSha256(record);
  for (const correction of corrections) {
    const sense = record.senses.find(({ id }) => id === correction.source_sense_id);
    const review = full.sense_reviews?.find(({ sense_id: id }) => id === correction.source_sense_id);
    if (!sense || !review) failSystemic(`${record.id}: prior semantic review omitted ${correction.source_sense_id}`, 'RELATION_BASE_REVIEW_MISSING');
    const change = correction.relation === null
      ? `removed ${correction.previous_relation.type} relation ${correction.previous_relation_id} to ${correction.previous_relation.target}`
      : `changed ${correction.previous_relation.type} relation ${correction.previous_relation_id} to ${correction.relation.type} ${correction.relation_id} for ${correction.previous_relation.target}`;
    const text = boundText(record, sense, correction.source_candidate_id,
      `relation packet ${batchId} attempt ${attempt} ${change}; rationale digest ${correction.rationale_sha256.slice(0, 12)}.`);
    const previous = review.relation_rationale ?? review.relation?.rationale ?? review.no_relation_rationale ?? review.relation?.no_relation_rationale;
    const kept = (sense.relations ?? []).length > 0;
    const joined = previous ? `${previous} ${text}` : text;
    review.relation_decision = kept ? 'relations-reviewed' : 'no-relations';
    if (kept) { review.relation_rationale = joined; delete review.no_relation_rationale; }
    else { review.no_relation_rationale = joined; delete review.relation_rationale; }
    if (review.relation) {
      review.relation.decision = review.relation_decision;
      if (kept) { review.relation.rationale = joined; delete review.relation.no_relation_rationale; }
      else { review.relation.no_relation_rationale = joined; delete review.relation.rationale; }
    }
    review.sense_sha256 = canonicalRecordSha256(sense);
  }
  return compactSemanticReviewRecord(full);
}

// The complete audit binds the unchanged canonical base to its reviewed source. Cache only a passing result, keyed by the
// complete input content so a changed record, authority source, or batch decision source always triggers a fresh audit.
let lastBaseAudit;

function baseAuditReviewsById(baseCanonicalRecords, source, batchDecisionSources) {
  const batchKeys = batchDecisionSources.map((entry) => (entry?.sourceSha256 && entry.sourcePath
    ? [entry.sourcePath, entry.sourceSha256]
    : undefined));
  const key = batchKeys.includes(undefined) ? undefined : sha256Json([
    sha256Json(baseCanonicalRecords), sha256Json(source), batchKeys,
  ]);
  if (key !== undefined && lastBaseAudit?.key === key) return lastBaseAudit.reviewsById;
  let baseAudit;
  try {
    baseAudit = buildSemanticAuditFromDecisionSource(baseCanonicalRecords, source, {
      baseRecords: baseCanonicalRecords,
      batchDecisionSources,
      artifactId: 'relation-base-canonical-semantic-audit',
    });
  } catch (error) {
    failSystemic(`latest canonical semantic authority failed its source-bound audit: ${error.message}`, 'RELATION_BASE_SEMANTIC_AUTHORITY');
  }
  const reviewsById = new Map(structuredClone(baseAudit.review.records).map((review) => [review.record_id, review]));
  lastBaseAudit = key === undefined ? undefined : { key, reviewsById };
  return reviewsById;
}

/** Append a reviewed Canonical relation change to the source-bound semantic authority. */
export async function buildRelationSemanticAuthority({ root, baseCanonicalRecords, plan } = {}) {
  const sourcePath = path.join(root, AUTHORITY_PATH);
  let source;
  try { source = await readShardedJson(sourcePath); }
  catch (error) {
    if (error instanceof SyntaxError) failSystemic(`canonical semantic authority is invalid JSON: ${error.message}`, 'RELATION_SEMANTIC_AUTHORITY_JSON');
    failSystemic(`canonical semantic authority is unavailable: ${error.message}`, 'RELATION_SEMANTIC_AUTHORITY_MISSING');
  }

  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const baseReviewById = baseAuditReviewsById(baseCanonicalRecords, source, batchDecisionSources);
  const baseById = new Map(baseCanonicalRecords.map((record) => [record.id, record]));
  const reviewById = { get: (id) => (baseReviewById.has(id) ? structuredClone(baseReviewById.get(id)) : undefined) };
  const afterById = new Map(baseById);
  for (const [id, update] of plan.records) afterById.set(id, update.record);
  const afterRecords = [...afterById.values()];
  const outputRows = new Map((source.authored_review.records ?? []).map((row) => [row.record_id, row]));
  const oldCompactById = new Map(outputRows);
  const changes = [];

  for (const change of plan.changes) {
    const record = afterById.get(change.entry_id);
    const beforeRecord = baseById.get(change.entry_id);
    if (isLicensedSourceRecord(record)) {
      changes.push({ ...change, previous_semantic_review_sha256: null, semantic_review_sha256: null });
      continue;
    }
    let reviewed;
    if (change.operation === 'append_relations') {
      const amendments = (plan.relationAmendments ?? []).filter((item) => item.source_record_id === change.entry_id && item.outcome === 'appended');
      reviewed = buildReviewForRelationAmendment({ record, beforeReview: reviewById.get(change.entry_id), amendments, batchId: plan.batchId, attempt: plan.attempt });
    } else if (change.operation === 'amend_relations') {
      const corrections = (plan.relationCorrections ?? []).filter((item) => item.source_record_id === change.entry_id && item.outcome === 'amended');
      reviewed = buildReviewForRelationCorrection({ record, beforeReview: reviewById.get(change.entry_id), corrections, batchId: plan.batchId, attempt: plan.attempt });
    } else {
      failSystemic(`${change.entry_id}: relation authority cannot record ${change.operation}`, 'RELATION_OPERATION_UNSUPPORTED');
    }
    const previous = oldCompactById.get(change.entry_id);
    outputRows.set(change.entry_id, reviewed);
    changes.push({
      ...change,
      previous_semantic_review_sha256: sha256Json(previous),
      previous_semantic_review: structuredClone(previous),
      previous_record: structuredClone(beforeRecord),
      semantic_review_sha256: sha256Json(reviewed),
    });
  }

  source.source.canonical_records_sha256 = canonicalRecordsSha256(afterRecords);
  source.authored_review.source.canonical_records_sha256 = source.source.canonical_records_sha256;
  source.authored_review.records = [...outputRows.values()].sort((left, right) => left.record_id.localeCompare(right.record_id, 'en', { numeric: true }));
  const event = {
    batch_id: plan.batchId,
    attempt: plan.attempt,
    semantic_decisions_sha256: plan.reviewManifest.semantic_decisions_sha256,
    entries: [],
    ...(plan.relationAmendments?.length ? { relation_amendments: structuredClone(plan.relationAmendments) } : {}),
    ...(plan.relationCorrections?.length ? { relation_corrections: structuredClone(plan.relationCorrections) } : {}),
    changes,
  };
  event.sha256 = sha256Json(event);
  source.factory_admissions = [...(source.factory_admissions ?? []), event];
  source.authored_review_sha256 = sha256Json(source.authored_review);

  const { changed } = await planShardedJsonChanges(source, sourcePath, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
  const sourceFiles = [...changed].map(([file, text]) => ({ path: path.posix.join(path.posix.dirname(AUTHORITY_PATH), file), text }));
  plan.reviewManifest.admission.semantic_authority = {
    path: AUTHORITY_PATH,
    source_id: source.source_id,
    admission_sha256: event.sha256,
  };
  return {
    sourcePath: AUTHORITY_PATH,
    sourceFiles,
    sourceObject: source,
    sourceEvent: event,
    canonicalRecordsSha256: source.source.canonical_records_sha256,
  };
}

export { AUTHORITY_PATH };

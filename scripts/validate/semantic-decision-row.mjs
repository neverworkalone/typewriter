import { createHash } from 'node:crypto';

const RECONSTRUCTIBLE_DECISION_FIELDS = Object.freeze([
  'source_sha256',
  'sense_id',
  'sense_gloss_sha256',
  'pos',
  'record_type',
  'observed_domain_axes',
  'domain_evidence',
  'connector_observations',
  'semantic_rationale',
  'boundary_rationale',
  'relation_decision',
  'relation_count',
  'relation_ids',
  'no_relation_rationale',
]);

export const AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION = 'source-bound-semantic-review-v1';
export const SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v3';
export const GRANDFATHERED_M5_12A_DECISION_SOURCE = Object.freeze({
  path: 'data/batches/m5-12a-semantic-decisions.json',
  source_id: 'm5-12a-authored-semantic-decisions-20260920-r4',
  contract_version: 'lexical-semantic-decision-source-v2',
  artifact_sha256: 'da9b12da6b276ce221b44fde17e0582597fd940be3324465a809fc4c316eff5b',
  file_sha256: '720348e78becee62249ed4761cf154a8c794b10c1ff2609d95d90daa811d4edf',
});

export function isGrandfatheredM512ADecisionSource({
  source,
  sourcePath,
  sourceSha256,
  artifactSha256,
} = {}) {
  return sourcePath === GRANDFATHERED_M5_12A_DECISION_SOURCE.path
    && source?.source_id === GRANDFATHERED_M5_12A_DECISION_SOURCE.source_id
    && source?.contract_version === GRANDFATHERED_M5_12A_DECISION_SOURCE.contract_version
    && (artifactSha256 ?? source?.artifact_sha256)
      === GRANDFATHERED_M5_12A_DECISION_SOURCE.artifact_sha256
    && sourceSha256 === GRANDFATHERED_M5_12A_DECISION_SOURCE.file_sha256;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function reviewDecisionEvidence(row) {
  return {
    decision: row.decision,
    gloss_judgment: row.gloss_judgment,
    decision_rationale: row.decision_rationale,
  };
}

/**
 * Author a binding envelope at the same boundary as the semantic decision.
 * Importers must validate this recorded envelope, never attach or refresh it.
 */
export function authorSemanticReviewBinding(row, candidateRecord) {
  return {
    contract_version: AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
    candidate_record_id: candidateRecord.id,
    candidate_record_sha256: sha256Json(candidateRecord),
    decision_evidence_sha256: sha256Json(reviewDecisionEvidence(row)),
    sense_evidence: candidateRecord.senses.map((sense, index) => ({
      sense_id: sense.id,
      sense_sha256: sha256Json(sense),
      gloss_sha256: sha256Json(sense.gloss),
      evidence_sha256: sha256Json(row.sense_reviews?.[index]),
    })),
  };
}

/** Validate authored review bindings without reconstructing them in the importer. */
export function validateAuthoredSemanticReviewBinding(row, candidateRecord) {
  const binding = row?.review_binding;
  const fail = (message) => {
    const error = new Error(message);
    error.code = 'SEMANTIC_DECISION_REVIEW_BINDING';
    throw error;
  };
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.contract_version !== AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION) {
    fail('authored semantic review binding contract is missing or unsupported');
  }
  if (binding.candidate_record_id !== candidateRecord.id
    || binding.candidate_record_sha256 !== sha256Json(candidateRecord)) {
    fail(`${candidateRecord.id} review binding does not identify the exact reviewed candidate`);
  }
  if (binding.decision_evidence_sha256 !== sha256Json(reviewDecisionEvidence(row))) {
    fail(`${candidateRecord.id} review binding does not cover its authored verdict and rationale`);
  }
  if (!Array.isArray(binding.sense_evidence)
    || binding.sense_evidence.length !== candidateRecord.senses.length
    || !Array.isArray(row.sense_reviews)
    || row.sense_reviews.length !== candidateRecord.senses.length) {
    fail(`${candidateRecord.id} review binding does not cover every candidate sense`);
  }
  for (const [index, sense] of candidateRecord.senses.entries()) {
    const evidence = binding.sense_evidence[index];
    const senseReview = row.sense_reviews[index];
    if (!evidence || evidence.sense_id !== sense.id
      || evidence.sense_sha256 !== sha256Json(sense)
      || evidence.gloss_sha256 !== sha256Json(sense.gloss)
      || evidence.evidence_sha256 !== sha256Json(senseReview)) {
      fail(`${candidateRecord.id} review binding does not cover its exact authored sense evidence`);
    }
  }
  return binding;
}

/**
 * Normalize an authored batch row for its immutable row binding. The full
 * row remains the durable authored source; this digest intentionally ignores
 * projections that are validated from the candidate/canonical record.
 */
export function compactAuthoredSemanticDecisionRow(row) {
  const normalized = structuredClone(row);
  for (const field of RECONSTRUCTIBLE_DECISION_FIELDS) delete normalized[field];
  if (Array.isArray(normalized.sense_reviews)) {
    normalized.sense_reviews = normalized.sense_reviews.map((senseReview) => {
      const compact = structuredClone(senseReview);
      for (const field of RECONSTRUCTIBLE_DECISION_FIELDS) {
        if (field !== 'sense_id'
          && field !== 'semantic_rationale'
          && field !== 'boundary_rationale'
          && field !== 'relation_decision'
          && field !== 'relation_count'
          && field !== 'relation_ids'
          && field !== 'no_relation_rationale') {
          delete compact[field];
        }
      }
      if (compact.review_basis) {
        compact.review_basis = Object.fromEntries(
          Object.entries(compact.review_basis)
            .filter(([key]) => key === 'topic_analysis' || key === 'topic_analyses'),
        );
        if (Object.keys(compact.review_basis).length === 0) delete compact.review_basis;
      }
      return compact;
    });
  }
  return normalized;
}

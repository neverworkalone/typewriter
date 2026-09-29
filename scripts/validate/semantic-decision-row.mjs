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

export const AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION = 'source-bound-semantic-review-v2';
export const SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v4';
export const GRANDFATHERED_LEGACY_DISPOSITION_SOURCES = Object.freeze([
  Object.freeze({
    path: 'data/batches/m5-13-semantic-decisions.json',
    source_id: 'm5-13-authored-semantic-decisions-20260923-r6',
    contract_version: 'lexical-semantic-decision-source-v3',
    artifact_sha256: '6ee1835952f11ca713a8cebe4648f235e793bc770ab3ca760f40a8921a736f2b',
    file_sha256: 'b3e238b8715c46ed813e4faacac442ad66333b206c245c202d72a00c08ad5bf1',
  }),
  Object.freeze({
    path: 'data/batches/m5-14-semantic-decisions.json',
    source_id: 'm5-14-authored-semantic-decisions-20260923-r1',
    contract_version: 'lexical-semantic-decision-source-v3',
    artifact_sha256: '22a377cbd1a9dceac15c6a2aba9c775573ae03ccd2f9d03983771a50ffd41eaa',
    file_sha256: 'dabd7d3d13f8dbd2ed6e7fa3dca1c2a1ace233eda08de62ef842cb7dd095f5dc',
  }),
  Object.freeze({
    path: 'data/batches/m5-15-semantic-decisions.json',
    source_id: 'm5-15-authored-semantic-decisions-20260923-r1',
    contract_version: 'lexical-semantic-decision-source-v3',
    artifact_sha256: '4ce0a9040953a7bcac521e901e102b240c2f1c06ed60a2104a5794a7f036ff70',
    file_sha256: '01698848d7f2d8f3704429c41a934e7e81997bc25c46ca7c1a16b2dc2084e366',
  }),
  Object.freeze({
    path: 'data/batches/issue-204-semantic-decisions.json',
    source_id: 'issue-204-authored-semantic-decisions-20260928-r1',
    contract_version: 'lexical-semantic-decision-source-v3',
    artifact_sha256: 'bd48c2a3ac46c47926be5939be41607c45863dbf149274d76e370f4d14476504',
    file_sha256: '66d96ed2b0c104dab185625ebd5f09ef06b21092c9b84e1f3d1ad0d8b76fd60e',
  }),
]);

export function isGrandfatheredLegacyDispositionSource({
  source,
  sourcePath,
  sourceSha256,
  artifactSha256,
} = {}) {
  return GRANDFATHERED_LEGACY_DISPOSITION_SOURCES.some((legacy) => (
    sourcePath === legacy.path
      && source?.source_id === legacy.source_id
      && source?.contract_version === legacy.contract_version
      && (artifactSha256 ?? source?.artifact_sha256) === legacy.artifact_sha256
      && sourceSha256 === legacy.file_sha256
  ));
}

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
  const evidence = {
    decision: row.decision,
    gloss_judgment: row.gloss_judgment,
    decision_rationale: row.decision_rationale,
  };
  if (Object.hasOwn(row, 'hold_basis')) evidence.hold_basis = row.hold_basis;
  if (Object.hasOwn(row, 'rejection_basis')) evidence.rejection_basis = row.rejection_basis;
  if (Object.hasOwn(row, 'lexical_unit_review')) evidence.lexical_unit_review = row.lexical_unit_review;
  return evidence;
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

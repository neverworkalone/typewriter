import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  findAmbiguousParticleFragments,
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
  requiresTopicAnalysis,
  validateAuthoredTopicAnalysis,
  validateLexicalRecord,
} from '../validate/lexical-quality.mjs';
import { inspectSenseBoundaryPairs } from '../validate/sense-boundary.mjs';
import {
  M5_12A_BATCH_ID,
  M5_12A_CANDIDATE_IDENTITIES,
  M5_12A_CANDIDATE_SOURCE_ID,
  M5_12A_IMPORT_COUNT,
  M5_12A_RESERVE_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_ISSUE,
  M5_12A_PARENT_ISSUE,
  M5_12A_GENERATION_PASS_ID,
  M5_12A_VERIFICATION_PASS_ID,
} from './m5-12a-candidate-source.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);

export const M5_12A_SEMANTIC_DECISION_SOURCE_ID = 'm5-12a-authored-semantic-decisions-20260920-r4';
export const M5_12A_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-12a-semantic-decisions.json',
);
export const M5_12A_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v1';
export const M5_12A_SEMANTIC_DECISION_SOURCE_POLICY = 'source-authored-quality-coverage-v1';
export const M5_12A_AUTHORED_SEMANTIC_REVIEW_VERSION = 'm5-12a-authored-semantic-review-v4';

const DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);
const IMPORTABLE = new Set(['included', 'corrected']);
const GLOSS_JUDGMENTS = new Set(['fit', 'needs-context', 'reject']);
const MAX_CORRECTION_RATE = 0.5;

export class M512ADecisionSourceError extends Error {
  constructor(message, code = 'M5_12A_DECISION_SOURCE_ERROR') {
    super(message);
    this.name = 'M512ADecisionSourceError';
    this.code = code;
  }
}

function fail(message, code = 'M5_12A_DECISION_SOURCE_ERROR') {
  throw new M512ADecisionSourceError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'M5_12A_DECISION_SOURCE_SHAPE');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'M5_12A_DECISION_SOURCE_VALUE');
  }
  return value;
}

function requireDigest(value, label) {
  requireString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 digest`, 'M5_12A_DECISION_SOURCE_VALUE');
  }
  return value;
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function candidateIdentityDigest(identities) {
  return sha256Json(identities);
}

function expectedDecisionCounts(rows) {
  return Object.fromEntries([...DECISIONS].map((decision) => [
    decision,
    rows.filter((row) => row.decision === decision).length,
  ]));
}

function sourceForArtifactDigest(source) {
  const withoutDigest = structuredClone(source);
  delete withoutDigest.artifact_sha256;
  withoutDigest.decisions = withoutDigest.decisions.map((row) => {
    const normalized = { ...row };
    normalized.source_sha256 = null;
    return normalized;
  });
  return withoutDigest;
}

function validateAuthoredCandidateRecord(candidate, identity, label) {
  requireObject(candidate, label);
  validateLexicalRecord(candidate, {
    label,
    mode: 'candidate',
    expectedId: identity.candidate_record_id,
    expectedLemma: identity.lemma,
  });
  if (candidate.record_type !== identity.record_type
    || candidate.role !== 'start'
    || candidate.candidate_id !== identity.candidate_record_id
    || candidate.senses.some((sense, index) => sense.id !== `${identity.candidate_record_id}-s${index + 1}`)
    || !candidate.senses.some((sense) => sense.pos === identity.pos)) {
    fail(`${label} is not bound to the authored candidate identity`, 'M5_12A_CANDIDATE_SOURCE_BINDING');
  }
  return candidate;
}

/**
 * Return the authored evidence for every candidate sense.  The legacy
 * one-sense row shape remains readable for old authored rows, but a
 * multi-sense candidate must carry an explicit per-sense review instead of
 * silently inheriting the first sense's evidence.
 */
export function decisionSenseReviews(candidate, row, label = 'decision') {
  if (row.sense_reviews === undefined) {
    if (candidate.senses.length !== 1) {
      fail(
        `${label}.sense_reviews must explicitly cover every authored sense`,
        'M5_12A_DECISION_SOURCE_SCOPE',
      );
    }
    return [{ ...row, sense_id: candidate.senses[0].id }];
  }
  if (!Array.isArray(row.sense_reviews) || row.sense_reviews.length !== candidate.senses.length) {
    fail(
      `${label}.sense_reviews must contain one review for every authored sense`,
      'M5_12A_DECISION_SOURCE_SCOPE',
    );
  }
  const expectedIds = candidate.senses.map(({ id }) => id);
  const actualIds = row.sense_reviews.map(({ sense_id: senseId }) => senseId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || new Set(actualIds).size !== actualIds.length) {
    fail(
      `${label}.sense_reviews must cover authored senses in source order`,
      'M5_12A_DECISION_SOURCE_BINDING',
    );
  }
  return row.sense_reviews;
}

function validateAuthoredBoundaryPairs(candidate, row, label) {
  const expectedPairs = inspectSenseBoundaryPairs(candidate);
  const pairs = row.boundary_pairs;
  if (!Array.isArray(pairs) || pairs.length !== expectedPairs.length) {
    fail(
      `${label}.boundary_pairs must review every authored sense pair`,
      'M5_12A_DECISION_SOURCE_SCOPE',
    );
  }
  const expectedByKey = new Map(expectedPairs.map((pair) => [
    `${pair.left_sense_id}:${pair.right_sense_id}`,
    pair,
  ]));
  const seen = new Set();
  for (const [index, pair] of pairs.entries()) {
    const pairLabel = `${label}.boundary_pairs[${index}]`;
    requireObject(pair, pairLabel);
    const key = `${pair.left_sense_id}:${pair.right_sense_id}`;
    if (seen.has(key)) fail(`${pairLabel} is duplicated`, 'M5_12A_DECISION_SOURCE_SCOPE');
    seen.add(key);
    const expected = expectedByKey.get(key);
    if (!expected) fail(`${pairLabel} is not bound to an authored sense pair`, 'M5_12A_DECISION_SOURCE_BINDING');
    if (!['distinct', 'duplicate', 'nested', 'usage-variant', 'overlapping'].includes(pair.relationship)
      || !['retain', 'merge', 'rewrite', 'fail'].includes(pair.decision)) {
      fail(`${pairLabel} contains an unsupported boundary outcome`, 'M5_12A_DECISION_SOURCE_VALUE');
    }
    const leftSense = candidate.senses.find(({ id }) => id === pair.left_sense_id);
    const rightSense = candidate.senses.find(({ id }) => id === pair.right_sense_id);
    const leftGlossSha256 = sha256Json(leftSense.gloss);
    const rightGlossSha256 = sha256Json(rightSense.gloss);
    if (pair.left_gloss_sha256 !== leftGlossSha256 || pair.right_gloss_sha256 !== rightGlossSha256) {
      fail(`${pairLabel} gloss evidence does not bind the authored sense pair`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    requireString(pair.evidence_basis, `${pairLabel}.evidence_basis`);
    requireString(pair.distinguishing_feature, `${pairLabel}.distinguishing_feature`);
    requireString(pair.decision_source_id, `${pairLabel}.decision_source_id`);
    requireString(pair.rationale, `${pairLabel}.rationale`);
    if (!pair.rationale.includes(candidate.id)
      || !pair.rationale.includes(pair.left_sense_id)
      || !pair.rationale.includes(pair.right_sense_id)
      || !pair.rationale.includes(leftGlossSha256.slice(0, 12))
      || !pair.rationale.includes(rightGlossSha256.slice(0, 12))) {
      fail(`${pairLabel}.rationale must cite the authored pair and gloss evidence`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
  }
  if (seen.size !== expectedPairs.length) {
    fail(`${label}.boundary_pairs must cover every authored sense pair`, 'M5_12A_DECISION_SOURCE_SCOPE');
  }
  return pairs;
}

/**
 * Candidate bodies are authored input, not a projection of the identity
 * catalogue.  Keep this boundary explicit so a future pipeline cannot fall
 * back to a gloss/template factory when the durable source is incomplete.
 */
export function candidateRecordsFromM512ADecisionSource(
  source,
  identities = M5_12A_CANDIDATE_IDENTITIES,
) {
  requireObject(source, 'M5-12A semantic decision source');
  const candidates = source.candidate_records;
  if (!Array.isArray(candidates) || candidates.length !== identities.length) {
    fail(
      `M5-12A semantic decision source must contain ${identities.length} authored candidate records`,
      'M5_12A_CANDIDATE_SOURCE_SCOPE',
    );
  }
  const candidateDigest = requireDigest(
    source.candidate_records_sha256,
    'M5-12A semantic decision source.candidate_records_sha256',
  );
  if (candidateDigest !== sha256Json(candidates)) {
    fail('M5-12A authored candidate record digest is not reproducible', 'M5_12A_CANDIDATE_SOURCE_BINDING');
  }
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const byId = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const identity = identityById.get(candidate?.id);
    if (!identity) fail(`authored candidate ${candidate?.id ?? index} is outside the identity source`, 'M5_12A_CANDIDATE_SOURCE_SCOPE');
    if (byId.has(candidate.id)) fail(`duplicate authored candidate ${candidate.id}`, 'M5_12A_CANDIDATE_SOURCE_SCOPE');
    byId.set(candidate.id, validateAuthoredCandidateRecord(
      candidate,
      identity,
      `M5-12A authored candidate ${candidate.id}`,
    ));
  }
  return identities.map((identity) => {
    const candidate = byId.get(identity.candidate_record_id);
    if (!candidate) fail(`authored candidate ${identity.candidate_record_id} is missing`, 'M5_12A_CANDIDATE_SOURCE_SCOPE');
    return structuredClone(candidate);
  });
}

export function serializeM512ADecisionSource(source) {
  const withoutDigest = sourceForArtifactDigest(source);
  const artifactSha256 = sha256Json(withoutDigest);
  const serialized = {
    ...withoutDigest,
    decisions: source.decisions.map((row) => ({
      ...row,
      source_sha256: artifactSha256,
    })),
    artifact_sha256: artifactSha256,
  };
  return {
    source: serialized,
    artifactSha256,
    bytes: Buffer.from(`${JSON.stringify(serialized, null, 2)}\n`, 'utf8'),
  };
}

export function applyM512ADecisionCorrection(candidate, correction) {
  const label = `correction for ${candidate.id}`;
  requireObject(correction, label);
  if (correction.action !== 'replace-authored-record') {
    fail(`${label}.action must be replace-authored-record; batch-local search aliases are not supported`, 'M5_12A_CORRECTION_POLICY');
  }
  const correctedRecord = requireObject(correction.record, `${label}.record`);
  validateLexicalRecord(correctedRecord, {
    label: `${label}.record`,
    mode: 'candidate',
    expectedId: candidate.id,
    expectedLemma: candidate.lemma,
  });
  if (correctedRecord.record_type !== candidate.record_type
    || correctedRecord.role !== candidate.role
    || correctedRecord.candidate_id !== candidate.candidate_id) {
    fail(`${label}.record must preserve the candidate identity`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const collapsedLemma = candidate.lemma.replace(/\s+/gu, '');
  if (collapsedLemma !== candidate.lemma && correctedRecord.search_forms.includes(collapsedLemma)) {
    fail(`${label}.record cannot add a collapsed internal-whitespace alias; use the shared search policy`, 'M5_12A_CORRECTION_SEARCH_POLICY');
  }
  if (correction.output_record_sha256 !== sha256Json(correctedRecord)) {
    fail(`${label}.output_record_sha256 does not bind the corrected record`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  return structuredClone(correctedRecord);
}

function validateDecisionRow(row, {
  identity,
  candidate,
  sourceSha256,
  decisionSourceId,
} = {}) {
  const label = `decision ${identity.inventory_id}`;
  requireObject(row, label);
  if (row.inventory_id !== identity.inventory_id) fail(`${label}.inventory_id is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  if (row.candidate_record_id !== candidate.id) fail(`${label}.candidate_record_id is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  if (row.candidate_record_sha256 !== sha256Json(candidate)) fail(`${label}.candidate_record_sha256 does not bind the candidate`, 'M5_12A_DECISION_SOURCE_BINDING');
  requireString(row.decision, `${label}.decision`);
  if (!DECISIONS.has(row.decision)) fail(`${label}.decision is unsupported`, 'M5_12A_DECISION_SOURCE_VALUE');
  if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > M5_12A_SELECTION_COUNT) {
    fail(`${label}.rank must be within the complete candidate pool`, 'M5_12A_DECISION_SOURCE_VALUE');
  }
  if (!Number.isFinite(row.score)) fail(`${label}.score must be finite`, 'M5_12A_DECISION_SOURCE_VALUE');
  requireString(row.decision_rationale, `${label}.decision_rationale`);
  if (!row.decision_rationale.includes(identity.inventory_id)
    || !row.decision_rationale.includes(candidate.id)) {
    fail(`${label}.decision_rationale must cite the inventory and candidate identity`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.source_sha256 !== sourceSha256) fail(`${label}.source_sha256 is not bound to the decision artifact`, 'M5_12A_DECISION_SOURCE_BINDING');
  if (row.review_pass_id !== M5_12A_VERIFICATION_PASS_ID) fail(`${label}.review_pass_id is not bound to the authored verification pass`, 'M5_12A_DECISION_SOURCE_PROVENANCE');
  if (!GLOSS_JUDGMENTS.has(row.gloss_judgment)) fail(`${label}.gloss_judgment is unsupported`, 'M5_12A_DECISION_SOURCE_VALUE');
  if (IMPORTABLE.has(row.decision) && row.gloss_judgment !== 'fit') {
    fail(`${label} importable decision requires a fit gloss judgment`, 'M5_12A_DECISION_SOURCE_COHERENCE');
  }
  if (row.record_type !== candidate.record_type) {
    fail(`${label}.record_type is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.decision === 'corrected') {
    applyM512ADecisionCorrection(candidate, row.correction);
  } else if (Object.hasOwn(row, 'correction')) {
    fail(`${label}.correction is only allowed for corrected decisions`, 'M5_12A_DECISION_SOURCE_VALUE');
  }

  const senseReviews = decisionSenseReviews(candidate, row, label);
  for (const [senseIndex, senseReview] of senseReviews.entries()) {
    const senseLabel = `${label}.sense_reviews[${senseIndex}]`;
    const sense = candidate.senses[senseIndex];
    requireObject(senseReview, senseLabel);
    if (senseReview.sense_id !== sense.id
      || senseReview.sense_gloss_sha256 !== sha256Json(sense.gloss)
      || senseReview.pos !== sense.pos
      || senseReview.record_type !== candidate.record_type) {
      fail(`${senseLabel} is not source-bound to the authored sense`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    requireString(senseReview.semantic_rationale, `${senseLabel}.semantic_rationale`);
    const reviewBasis = requireObject(
      senseReview.review_basis ?? (senseIndex === 0 ? row.review_basis : undefined),
      `${senseLabel}.review_basis`,
    );
    if (reviewBasis.lexical_unit !== candidate.lemma
      || reviewBasis.gloss_sha256 !== sha256Json(sense.gloss)
      || reviewBasis.review_pass_id !== M5_12A_VERIFICATION_PASS_ID
      || reviewBasis.reviewer !== 'codex-agent') {
      fail(`${senseLabel}.review_basis is not bound to the authored verification pass`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    if (requiresTopicAnalysis(sense.gloss) && reviewBasis.topic_analysis === undefined) {
      fail(
        `${senseLabel}.review_basis.topic_analysis is required for ambiguous particle spans ${JSON.stringify(findAmbiguousParticleFragments(sense.gloss))}`,
        'M5_12A_DECISION_SOURCE_SCOPE',
      );
    }
    if (reviewBasis.topic_analysis !== undefined) {
      validateAuthoredTopicAnalysis(
        sense.gloss,
        reviewBasis.topic_analysis,
        {
          decisionSourceId,
          label: `${senseLabel}.review_basis.topic_analysis`,
        },
      );
    }
    const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
    const connectorObservations = inspectGlossConnectors(sense.gloss);
    if (JSON.stringify(senseReview.observed_domain_axes) !== JSON.stringify(domainEvidence.axes)
      || JSON.stringify(senseReview.domain_evidence) !== JSON.stringify(domainEvidence.matches)
      || JSON.stringify(senseReview.connector_observations) !== JSON.stringify(connectorObservations)) {
      fail(`${senseLabel} semantic observations do not bind the candidate gloss`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    const expectedBoundaryDecision = domainEvidence.axes.length > 1 ? 'coordinated' : 'atomic';
    if (senseReview.boundary_action !== 'retain'
      || senseReview.boundary_classification !== 'atomic'
      || senseReview.boundary_decision !== expectedBoundaryDecision) {
      fail(`${senseLabel} boundary decision is not a source-bound atomic review`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    const relationCount = sense.relations?.length ?? 0;
    if (senseReview.relation_count !== relationCount) {
      fail(`${senseLabel}.relation_count does not bind the authored candidate`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    if (!Array.isArray(senseReview.relation_ids) || senseReview.relation_ids.length !== relationCount) {
      fail(`${senseLabel}.relation_ids must bind every authored relation tuple`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    const expectedRelationDecision = relationCount === 0 ? 'no-relations' : 'relations-reviewed';
    if (senseReview.relation_decision !== expectedRelationDecision) {
      fail(`${senseLabel}.relation_decision must be ${expectedRelationDecision}`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
    if (relationCount === 0) {
      requireString(senseReview.no_relation_rationale, `${senseLabel}.no_relation_rationale`);
      if (!senseReview.no_relation_rationale.includes(identity.inventory_id)
        || !senseReview.no_relation_rationale.includes(sense.id)) {
        fail(`${senseLabel}.no_relation_rationale must cite the source-bound sense`, 'M5_12A_DECISION_SOURCE_BINDING');
      }
    } else if (senseReview.no_relation_rationale !== undefined) {
      fail(`${senseLabel}.no_relation_rationale cannot accompany authored relations`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
  }

  if (candidate.senses.length > 1 || row.boundary_pairs !== undefined) {
    validateAuthoredBoundaryPairs(candidate, row, label);
  }

  const firstSense = candidate.senses[0];
  const firstReview = senseReviews[0];
  if (row.sense_id !== undefined && row.sense_id !== firstSense.id) {
    fail(`${label}.sense_id is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.sense_gloss_sha256 !== undefined
    && row.sense_gloss_sha256 !== sha256Json(firstSense.gloss)) {
    fail(`${label}.sense_gloss_sha256 does not bind the candidate gloss`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.pos !== undefined && row.pos !== firstSense.pos) {
    fail(`${label}.pos is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.observed_domain_axes !== undefined
    && JSON.stringify(row.observed_domain_axes) !== JSON.stringify(firstReview.observed_domain_axes)) {
    fail(`${label}.observed_domain_axes must bind the first authored sense`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const relationCount = senseReviews.reduce((sum, senseReview) => sum + senseReview.relation_count, 0);
  const relationIds = senseReviews.flatMap((senseReview) => senseReview.relation_ids);
  const relationDecision = relationCount === 0 ? 'no-relations' : 'relations-reviewed';
  if (row.relation_count !== relationCount
    || JSON.stringify(row.relation_ids ?? []) !== JSON.stringify(relationIds)
    || row.relation_decision !== relationDecision) {
    fail(`${label} aggregate relation evidence does not bind every authored sense`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (relationCount === 0) {
    requireString(row.no_relation_rationale, `${label}.no_relation_rationale`);
    if (!row.no_relation_rationale.includes(identity.inventory_id)
      || candidate.senses.some(({ id }) => !row.no_relation_rationale.includes(id))) {
      fail(`${label}.no_relation_rationale must cite every source-bound sense`, 'M5_12A_DECISION_SOURCE_BINDING');
    }
  } else if (row.no_relation_rationale !== undefined) {
    fail(`${label}.no_relation_rationale cannot accompany authored relations`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  return row;
}

export function validateM512ADecisionSource({
  source,
  sourceBytes,
  identities = M5_12A_CANDIDATE_IDENTITIES,
  candidateRecords,
} = {}) {
  requireObject(source, 'M5-12A semantic decision source');
  if (source.schema_version !== '1'
    || source.contract_version !== M5_12A_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION
    || source.kind !== 'separately-authored-semantic-decision-source') {
    fail('M5-12A semantic decision source contract is unsupported', 'M5_12A_DECISION_SOURCE_CONTRACT');
  }
  if (source.source_id !== M5_12A_SEMANTIC_DECISION_SOURCE_ID) fail('M5-12A semantic decision source ID drifted', 'M5_12A_DECISION_SOURCE_BINDING');
  if (source.issue !== M5_12A_ISSUE || source.parent_issue !== M5_12A_PARENT_ISSUE || source.batch_id !== M5_12A_BATCH_ID) {
    fail('M5-12A semantic decision source scope drifted', 'M5_12A_DECISION_SOURCE_SCOPE');
  }
  if (source.authoring_mode !== 'agent-authored-decision') fail('M5-12A decision source must record agent authoring truthfully', 'M5_12A_DECISION_SOURCE_PROVENANCE');
  const provenance = requireObject(source.provenance, 'M5-12A semantic decision source.provenance');
  if (provenance.human_reviewed !== false
    || provenance.generator_version !== M5_12A_AUTHORED_SEMANTIC_REVIEW_VERSION
    || provenance.generation_pass_id !== M5_12A_GENERATION_PASS_ID
    || provenance.verification_pass_id !== M5_12A_VERIFICATION_PASS_ID
    || provenance.generation_pass_id === provenance.verification_pass_id) {
    fail('M5-12A decision source provenance is not truthful or separated', 'M5_12A_DECISION_SOURCE_PROVENANCE');
  }
  const review = requireObject(source.review, 'M5-12A semantic decision source.review');
  if (review.review_pass_id !== M5_12A_VERIFICATION_PASS_ID
    || review.reviewer !== 'codex-agent'
    || review.status !== 'complete'
    || review.candidate_count !== identities.length
    || review.reviewed_candidate_count !== identities.length
    || review.prior_generator_replaced !== true) {
    fail('M5-12A authored semantic review is incomplete or not independent of the prior generator', 'M5_12A_DECISION_SOURCE_PROVENANCE');
  }
  const candidateSource = requireObject(source.candidate_source, 'M5-12A semantic decision source.candidate_source');
  if (candidateSource.source_id !== M5_12A_CANDIDATE_SOURCE_ID
    || candidateSource.identity_sha256 !== candidateIdentityDigest(identities)
    || candidateSource.identity_count !== identities.length) {
    fail('M5-12A semantic decision source is not bound to the identity source', 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const selection = requireObject(source.selection, 'M5-12A semantic decision source.selection');
  if (selection.policy !== M5_12A_SEMANTIC_DECISION_SOURCE_POLICY
    || selection.capacity !== M5_12A_SELECTION_COUNT
    || selection.imported !== M5_12A_IMPORT_COUNT
    || selection.reserve !== M5_12A_RESERVE_COUNT) {
    fail('M5-12A semantic decision source selection policy drifted', 'M5_12A_DECISION_SOURCE_SCOPE');
  }
  if (!Buffer.isBuffer(sourceBytes)) fail('M5-12A semantic decision source bytes are required', 'M5_12A_DECISION_SOURCE_BINDING');
  const sourceBytesSha256 = sha256(sourceBytes);
  const artifactSha256 = requireDigest(source.artifact_sha256, 'M5-12A semantic decision source.artifact_sha256');
  if (artifactSha256 !== sha256Json(sourceForArtifactDigest(source))) {
    fail('M5-12A semantic decision source artifact digest is not reproducible', 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const authoredCandidateRecords = candidateRecordsFromM512ADecisionSource(source, identities);
  if (!Array.isArray(candidateRecords) || candidateRecords.length !== authoredCandidateRecords.length) {
    fail('M5-12A validation requires the complete authored candidate record set', 'M5_12A_CANDIDATE_SOURCE_SCOPE');
  }
  for (const [index, candidate] of candidateRecords.entries()) {
    if (JSON.stringify(candidate) !== JSON.stringify(authoredCandidateRecords[index])) {
      fail(`candidate ${candidate?.id ?? index} does not match the durable authored candidate source`, 'M5_12A_CANDIDATE_SOURCE_BINDING');
    }
  }
  const rows = source.decisions;
  if (!Array.isArray(rows) || rows.length !== identities.length) {
    fail(`M5-12A semantic decision source must contain ${identities.length} decisions`, 'M5_12A_DECISION_SOURCE_SCOPE');
  }
  const candidateById = new Map(candidateRecords.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const seenIds = new Set();
  const seenRanks = new Set();
  for (const row of rows) {
    const identity = identityById.get(row.candidate_record_id);
    const candidate = candidateById.get(row.candidate_record_id);
    if (!identity || !candidate) fail(`decision ${row.candidate_record_id} is not in the candidate identity source`, 'M5_12A_DECISION_SOURCE_SCOPE');
    if (seenIds.has(row.candidate_record_id)) fail(`duplicate decision ${row.candidate_record_id}`, 'M5_12A_DECISION_SOURCE_SCOPE');
    if (seenRanks.has(row.rank)) fail(`duplicate selection rank ${row.rank}`, 'M5_12A_DECISION_SOURCE_SCOPE');
    seenIds.add(row.candidate_record_id);
    seenRanks.add(row.rank);
    validateDecisionRow(row, {
      identity,
      candidate,
      sourceSha256: artifactSha256,
      decisionSourceId: source.source_id,
    });
  }
  if (seenRanks.size !== M5_12A_SELECTION_COUNT) fail('M5-12A semantic decision ranks are incomplete', 'M5_12A_DECISION_SOURCE_SCOPE');
  const counts = expectedDecisionCounts(rows);
  const imported = counts.included + counts.corrected;
  const heldOrRejected = counts.held + counts.rejected;
  const processed = rows.length - counts.deferred;
  const expectedDeferred = identities.length - imported - heldOrRejected;
  if (imported !== M5_12A_IMPORT_COUNT
    || heldOrRejected > M5_12A_RESERVE_COUNT
    || counts.deferred !== expectedDeferred
    || processed !== imported + heldOrRejected
    || processed <= 0
    || counts.corrected / processed > MAX_CORRECTION_RATE) {
    fail(`M5-12A semantic decision contract is invalid: ${JSON.stringify({
      ...counts,
      imported,
      held_or_rejected: heldOrRejected,
      processed,
      expected_deferred: expectedDeferred,
    })}`, 'M5_12A_DECISION_SOURCE_SCOPE');
  }
  for (const row of rows) {
    const decisionIsImportable = IMPORTABLE.has(row.decision);
    const rankIsWithinImportBoundary = row.rank <= imported;
    if (decisionIsImportable !== rankIsWithinImportBoundary) {
      fail(
        `decision ${row.candidate_record_id} decision/rank selection evidence contradicts the authored import boundary`,
        'M5_12A_DECISION_SOURCE_COHERENCE',
      );
    }
  }
  return {
    source,
    sourceBytes,
    sourceSha256: sourceBytesSha256,
    artifactSha256,
    rows,
    byCandidateId: new Map(rows.map((row) => [row.candidate_record_id, row])),
    counts,
  };
}

export async function readM512ADecisionSource(
  decisionSourcePath = M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
) {
  const sourceBytes = await readFile(decisionSourcePath);
  let source;
  try {
    source = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    fail(`M5-12A semantic decision source is not valid JSON: ${error.message}`, 'M5_12A_DECISION_SOURCE_JSON');
  }
  return { source, sourceBytes };
}

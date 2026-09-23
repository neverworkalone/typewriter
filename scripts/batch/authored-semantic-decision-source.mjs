import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  inspectWriterDomainEvidence,
  validateLexicalRecord,
  validateTopicAnalysisEvidence,
} from '../validate/lexical-quality.mjs';
import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  compactAuthoredSemanticDecisionRow,
  validateAuthoredSemanticReviewBinding,
} from '../validate/semantic-decision-row.mjs';
import { selectReviewedCandidates } from './lexical-selection.mjs';

const DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);
const IMPORTABLE = new Set(['included', 'corrected']);
const GLOSS_JUDGMENTS = new Set(['fit', 'needs-context', 'reject']);
const MAX_CORRECTION_RATE = 0.5;

export class AuthoredSemanticDecisionSourceError extends Error {
  constructor(message, code = 'AUTHORED_SEMANTIC_DECISION_SOURCE_ERROR') {
    super(message);
    this.name = 'AuthoredSemanticDecisionSourceError';
    this.code = code;
  }
}

function fail(message, suffix, config) {
  throw new AuthoredSemanticDecisionSourceError(message, `${config.errorPrefix}_${suffix}`);
}

function requireObject(value, label, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'DECISION_SOURCE_SHAPE', config);
  }
  return value;
}

function requireString(value, label, config) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'DECISION_SOURCE_VALUE', config);
  }
  return value;
}

function requireDigest(value, label, config) {
  requireString(value, label, config);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 digest`, 'DECISION_SOURCE_VALUE', config);
  }
  return value;
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
  withoutDigest.decisions = withoutDigest.decisions.map(compactAuthoredSemanticDecisionRow);
  return withoutDigest;
}

function validateAuthoredCandidateRecord(candidate, identity, label, config) {
  requireObject(candidate, label, config);
  try {
    validateLexicalRecord(candidate, {
      label,
      mode: 'candidate',
      expectedId: identity.candidate_record_id,
      expectedLemma: identity.lemma,
    });
  } catch (error) {
    fail(`${label} failed shared lexical intake: ${error.message}`, 'CANDIDATE_SOURCE_BINDING', config);
  }
  if (candidate.record_type !== identity.record_type
    || candidate.role !== 'start'
    || candidate.candidate_id !== identity.candidate_record_id
    || candidate.senses.some((sense, index) => sense.id !== `${identity.candidate_record_id}-s${index + 1}`)
    || !candidate.senses.some((sense) => sense.pos === identity.pos)) {
    fail(`${label} is not bound to the authored candidate identity`, 'CANDIDATE_SOURCE_BINDING', config);
  }
  return candidate;
}

export function candidateRecordsFromAuthoredSemanticDecisionSource(source, identities, config) {
  requireObject(source, `${config.label} semantic decision source`, config);
  const candidates = source.candidate_records;
  if (!Array.isArray(identities)
    || !Array.isArray(candidates)
    || candidates.length !== identities.length) {
    fail(`${config.label} semantic decision source must contain the complete authored candidate set`, 'CANDIDATE_SOURCE_SCOPE', config);
  }
  if (source.candidate_records_sha256 !== sha256Json(candidates)) {
    fail(`${config.label} authored candidate record digest is not reproducible`, 'CANDIDATE_SOURCE_BINDING', config);
  }
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const byId = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const identity = identityById.get(candidate?.id);
    if (!identity) {
      fail(`authored candidate ${candidate?.id ?? index} is outside the identity source`, 'CANDIDATE_SOURCE_SCOPE', config);
    }
    if (byId.has(candidate.id)) fail(`duplicate authored candidate ${candidate.id}`, 'CANDIDATE_SOURCE_SCOPE', config);
    byId.set(candidate.id, validateAuthoredCandidateRecord(
      candidate,
      identity,
      `${config.label} authored candidate ${candidate.id}`,
      config,
    ));
  }
  return identities.map((identity) => {
    const candidate = byId.get(identity.candidate_record_id);
    if (!candidate) fail(`authored candidate ${identity.candidate_record_id} is missing`, 'CANDIDATE_SOURCE_SCOPE', config);
    return structuredClone(candidate);
  });
}

export function decisionSenseReviews(candidate, row, label, config) {
  if (!Array.isArray(row.sense_reviews) || row.sense_reviews.length !== candidate.senses.length) {
    fail(`${label}.sense_reviews must contain one review for every authored sense`, 'DECISION_SOURCE_SCOPE', config);
  }
  const expectedIds = candidate.senses.map(({ id }) => id);
  const actualIds = row.sense_reviews.map(({ sense_id: senseId }) => senseId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || new Set(actualIds).size !== actualIds.length) {
    fail(`${label}.sense_reviews must cover authored senses in source order`, 'DECISION_SOURCE_BINDING', config);
  }
  return row.sense_reviews;
}

function validateDecisionRow(row, { identity, candidate, decisionSourceId, reviewPassCandidates, config } = {}) {
  const label = `decision ${identity.inventory_id}`;
  requireObject(row, label, config);
  if (row.inventory_id !== identity.inventory_id || row.candidate_record_id !== candidate.id) {
    fail(`${label} is not source-bound`, 'DECISION_SOURCE_BINDING', config);
  }
  if (row.candidate_record_sha256 !== sha256Json(candidate)) {
    fail(`${label}.candidate_record_sha256 does not bind the candidate`, 'DECISION_SOURCE_BINDING', config);
  }
  if (!DECISIONS.has(row.decision)) fail(`${label}.decision is unsupported`, 'DECISION_SOURCE_VALUE', config);
  if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > config.selectionCount) {
    fail(`${label}.rank must be within the complete candidate pool`, 'DECISION_SOURCE_VALUE', config);
  }
  if (Object.hasOwn(row, 'score')) {
    fail(`${label}.score is a derived ranking proxy; selection must use source-bound axis coverage`, 'DECISION_SOURCE_VALUE', config);
  }
  if (row.selection_axis !== identity.axis) {
    fail(`${label}.selection_axis does not match the source-bound candidate axis`, 'DECISION_SOURCE_BINDING', config);
  }
  requireString(row.decision_rationale, `${label}.decision_rationale`, config);
  if (!row.decision_rationale.includes(identity.inventory_id)
    || !row.decision_rationale.includes(candidate.id)) {
    fail(`${label}.decision_rationale must cite the inventory and candidate identity`, 'DECISION_SOURCE_BINDING', config);
  }
  if (!reviewPassCandidates.get(row.review_pass_id)?.has(candidate.id)) {
    fail(`${label}.review_pass_id is not authorized for this candidate`, 'DECISION_SOURCE_PROVENANCE', config);
  }
  if (!GLOSS_JUDGMENTS.has(row.gloss_judgment)) fail(`${label}.gloss_judgment is unsupported`, 'DECISION_SOURCE_VALUE', config);
  const expectedJudgment = row.decision === 'rejected'
    ? 'reject'
    : IMPORTABLE.has(row.decision) ? 'fit' : 'needs-context';
  if (row.gloss_judgment !== expectedJudgment) {
    fail(`${label}.gloss_judgment contradicts its authored decision`, 'DECISION_SOURCE_COHERENCE', config);
  }
  const senseReviews = decisionSenseReviews(candidate, row, label, config);
  try {
    validateAuthoredSemanticReviewBinding(row, candidate);
  } catch (error) {
    fail(`${label} semantic evidence binding failed: ${error.message}`, 'DECISION_SOURCE_BINDING', config);
  }
  for (const [senseIndex, senseReview] of senseReviews.entries()) {
    const senseLabel = `${label}.sense_reviews[${senseIndex}]`;
    const sense = candidate.senses[senseIndex];
    requireObject(senseReview, senseLabel, config);
    if (senseReview.sense_id !== sense.id) fail(`${senseLabel} is not source-bound`, 'DECISION_SOURCE_BINDING', config);
    requireString(senseReview.semantic_rationale, `${senseLabel}.semantic_rationale`, config);
    requireString(senseReview.boundary_rationale, `${senseLabel}.boundary_rationale`, config);
    if (senseReview.boundary_action !== 'retain' || senseReview.boundary_classification !== 'atomic') {
      fail(`${senseLabel} must retain an atomic writer-facing unit`, 'DECISION_SOURCE_BINDING', config);
    }
    const domains = inspectWriterDomainEvidence(sense.gloss);
    const expectedBoundaryDecision = domains.axes.length > 1 ? 'coordinated' : 'atomic';
    if (senseReview.boundary_decision !== expectedBoundaryDecision) {
      fail(`${senseLabel}.boundary_decision does not bind the reviewed gloss domains`, 'DECISION_SOURCE_BINDING', config);
    }
    validateTopicAnalysisEvidence(sense.gloss, senseReview.review_basis ?? {}, {
      decisionSourceId,
      incompleteCode: `${config.errorPrefix}_DECISION_SOURCE_SCOPE`,
      label: `${senseLabel}.review_basis`,
    });
    if (senseReview.relation_count !== 0
      || !Array.isArray(senseReview.relation_ids)
      || senseReview.relation_ids.length !== 0
      || senseReview.relation_decision !== 'no-relations') {
      fail(`${senseLabel} relation evidence is not source-bound`, 'DECISION_SOURCE_BINDING', config);
    }
    requireString(senseReview.no_relation_rationale, `${senseLabel}.no_relation_rationale`, config);
    if (!senseReview.no_relation_rationale.includes(identity.inventory_id)
      || !senseReview.no_relation_rationale.includes(sense.id)) {
      fail(`${senseLabel}.no_relation_rationale must cite the source-bound sense`, 'DECISION_SOURCE_BINDING', config);
    }
  }
  return row;
}

export function serializeAuthoredSemanticDecisionSource(source) {
  const withoutDigest = sourceForArtifactDigest(source);
  const artifactSha256 = sha256Json(withoutDigest);
  const serialized = {
    ...withoutDigest,
    decisions: source.decisions.map(compactAuthoredSemanticDecisionRow),
    artifact_sha256: artifactSha256,
  };
  return {
    source: serialized,
    artifactSha256,
    bytes: Buffer.from(`${JSON.stringify(serialized, null, 2)}\n`, 'utf8'),
  };
}

export function validateAuthoredSemanticDecisionSource({
  source,
  sourceBytes,
  identities,
  candidateRecords,
  config,
} = {}) {
  requireObject(source, `${config.label} semantic decision source`, config);
  if (source.schema_version !== '1'
    || source.contract_version !== SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION
    || source.review_binding_contract_version !== AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION
    || source.kind !== 'separately-authored-semantic-decision-source') {
    fail(`${config.label} semantic decision source contract is unsupported`, 'DECISION_SOURCE_CONTRACT', config);
  }
  if (source.source_id !== config.sourceId
    || source.issue !== config.issue
    || source.parent_issue !== config.parentIssue
    || source.batch_id !== config.batchId
    || source.authoring_mode !== 'agent-authored-decision') {
    fail(`${config.label} semantic decision source scope drifted`, 'DECISION_SOURCE_SCOPE', config);
  }
  const provenance = requireObject(source.provenance, `${config.label} semantic decision source.provenance`, config);
  if (provenance.human_reviewed !== false
    || provenance.generator_version !== config.semanticReviewVersion
    || provenance.generation_pass_id !== config.generationPassId
    || provenance.verification_pass_id !== config.verificationPassId
    || provenance.generation_pass_id === provenance.verification_pass_id) {
    fail(`${config.label} source provenance is not truthful or separated`, 'DECISION_SOURCE_PROVENANCE', config);
  }
  const review = requireObject(source.review, `${config.label} semantic decision source.review`, config);
  if (review.review_pass_id !== config.verificationPassId
    || review.reviewer !== 'codex-agent'
    || review.status !== 'complete'
    || review.candidate_count !== identities.length
    || review.reviewed_candidate_count !== identities.length
    || review.prior_generator_replaced !== true
    || review.prior_generator_verification_pass_id !== config.generationPassId) {
    fail(`${config.label} authored semantic review is incomplete`, 'DECISION_SOURCE_PROVENANCE', config);
  }
  if (!Array.isArray(review.correction_passes)) {
    fail(`${config.label} correction-pass provenance is missing`, 'DECISION_SOURCE_PROVENANCE', config);
  }
  const reviewPassCandidates = new Map([
    [review.review_pass_id, new Set(identities.map(({ candidate_record_id: id }) => id))],
  ]);
  const correctionPassCandidateIds = new Map();
  for (const [index, correctionPassValue] of review.correction_passes.entries()) {
    const correctionPass = requireObject(correctionPassValue, `${config.label} review.correction_passes[${index}]`, config);
    if (correctionPass.review_pass_id !== config.correctionPassId
      || correctionPass.prior_review_pass_id !== review.review_pass_id
      || correctionPass.reviewer !== 'codex-agent'
      || correctionPass.status !== 'complete'
      || !Array.isArray(correctionPass.candidate_record_ids)
      || correctionPass.candidate_record_ids.length === 0
      || correctionPass.candidate_record_count !== correctionPass.candidate_record_ids.length
      || typeof correctionPass.method !== 'string'
      || correctionPass.method.trim().length === 0
      || new Set(correctionPass.candidate_record_ids).size !== correctionPass.candidate_record_ids.length
      || correctionPass.candidate_record_ids.some((id) => !identities.some((identity) => identity.candidate_record_id === id))
      || reviewPassCandidates.has(correctionPass.review_pass_id)) {
      fail(`${config.label} correction pass is not source-bound to unique candidate identities`, 'DECISION_SOURCE_PROVENANCE', config);
    }
    const candidateIds = new Set(correctionPass.candidate_record_ids);
    reviewPassCandidates.set(correctionPass.review_pass_id, candidateIds);
    correctionPassCandidateIds.set(correctionPass.review_pass_id, candidateIds);
  }
  const candidateSource = requireObject(source.candidate_source, `${config.label} semantic decision source.candidate_source`, config);
  if (candidateSource.source_id !== config.candidateSourceId
    || candidateSource.identity_sha256 !== candidateIdentityDigest(identities)
    || candidateSource.identity_count !== identities.length) {
    fail(`${config.label} source is not bound to the identity source`, 'DECISION_SOURCE_BINDING', config);
  }
  const selection = requireObject(source.selection, `${config.label} semantic decision source.selection`, config);
  if (selection.policy !== config.selectionPolicy
    || selection.capacity !== config.selectionCount
    || selection.imported !== config.importCount
    || selection.reserve !== config.reserveCount
    || selection.coverage_field !== 'selection_axis'
    || !Array.isArray(selection.coverage_basis)
    || selection.coverage_basis.length === 0
    || selection.coverage_basis.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    fail(`${config.label} selection policy drifted`, 'DECISION_SOURCE_SCOPE', config);
  }
  requireString(selection.selection_rationale, `${config.label} semantic decision source.selection.selection_rationale`, config);
  if (!Buffer.isBuffer(sourceBytes)) fail(`${config.label} semantic decision source bytes are required`, 'DECISION_SOURCE_BINDING', config);
  const artifactSha256 = requireDigest(source.artifact_sha256, `${config.label} semantic decision source.artifact_sha256`, config);
  if (artifactSha256 !== sha256Json(sourceForArtifactDigest(source))) {
    fail(`${config.label} semantic decision source artifact digest is not reproducible`, 'DECISION_SOURCE_BINDING', config);
  }
  const authoredCandidateRecords = candidateRecordsFromAuthoredSemanticDecisionSource(source, identities, config);
  if (!Array.isArray(candidateRecords) || candidateRecords.length !== authoredCandidateRecords.length) {
    fail(`${config.label} validation requires the complete authored candidate set`, 'CANDIDATE_SOURCE_SCOPE', config);
  }
  for (const [index, candidate] of candidateRecords.entries()) {
    if (JSON.stringify(candidate) !== JSON.stringify(authoredCandidateRecords[index])) {
      fail(`candidate ${candidate?.id ?? index} does not match the durable authored source`, 'CANDIDATE_SOURCE_BINDING', config);
    }
  }
  if (!Array.isArray(source.decisions) || source.decisions.length !== identities.length) {
    fail(`${config.label} semantic decision source must contain ${identities.length} decisions`, 'DECISION_SOURCE_SCOPE', config);
  }
  const candidateById = new Map(candidateRecords.map((candidate) => [candidate.id, candidate]));
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const seenIds = new Set();
  const seenRanks = new Set();
  for (const row of source.decisions) {
    const identity = identityById.get(row.candidate_record_id);
    const candidate = candidateById.get(row.candidate_record_id);
    if (!identity || !candidate) fail(`decision ${row.candidate_record_id} is outside the identity source`, 'DECISION_SOURCE_SCOPE', config);
    if (seenIds.has(row.candidate_record_id) || seenRanks.has(row.rank)) {
      fail(`${config.label} decisions contain duplicate identity or rank`, 'DECISION_SOURCE_SCOPE', config);
    }
    seenIds.add(row.candidate_record_id);
    seenRanks.add(row.rank);
    validateDecisionRow(row, {
      identity,
      candidate,
      decisionSourceId: source.source_id,
      reviewPassCandidates,
      config,
    });
  }
  if (seenIds.size !== identities.length || seenRanks.size !== config.selectionCount) {
    fail(`${config.label} selection coverage is incomplete`, 'DECISION_SOURCE_SCOPE', config);
  }
  for (const [reviewPassId, candidateIds] of correctionPassCandidateIds) {
    const recordedIds = source.decisions
      .filter((row) => row.review_pass_id === reviewPassId)
      .map(({ candidate_record_id: id }) => id);
    if (recordedIds.length !== candidateIds.size || recordedIds.some((id) => !candidateIds.has(id))) {
      fail(`${config.label} correction pass ${reviewPassId} does not exactly cover its amended candidates`, 'DECISION_SOURCE_PROVENANCE', config);
    }
  }
  const counts = expectedDecisionCounts(source.decisions);
  const selectionResult = selectReviewedCandidates(source.decisions, {
    capacity: config.importCount,
    coverageField: selection.coverage_field,
  });
  if (selectionResult.status !== 'pass') {
    fail(`${config.label} semantic review produced fewer qualified candidates than the admission capacity`, 'SELECTION_HOLD', config);
  }
  const imported = selectionResult.selected.length;
  const heldOrRejected = counts.held + counts.rejected;
  const processed = source.decisions.length - counts.deferred;
  const expectedDeferred = identities.length - imported - selectionResult.reserve.length - heldOrRejected;
  if (imported !== config.importCount
    || selectionResult.reserve.length + heldOrRejected + counts.deferred !== config.reserveCount
    || counts.deferred !== expectedDeferred
    || processed !== counts.included + counts.corrected + heldOrRejected
    || processed <= 0
    || counts.corrected / processed > MAX_CORRECTION_RATE) {
    fail(`${config.label} decision contract is invalid: ${JSON.stringify({ ...counts, imported, heldOrRejected, processed })}`, 'DECISION_SOURCE_SCOPE', config);
  }
  if (JSON.stringify(review.decision_counts) !== JSON.stringify(counts)
    || JSON.stringify(review.counts) !== JSON.stringify(counts)) {
    fail(`${config.label} review counts do not match authored decisions`, 'DECISION_SOURCE_SCOPE', config);
  }
  return {
    source,
    sourceBytes,
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    artifactSha256,
    rows: source.decisions,
    byCandidateId: new Map(source.decisions.map((row) => [row.candidate_record_id, row])),
    counts,
    selection: selectionResult,
  };
}

export async function readAuthoredSemanticDecisionSource(sourcePath, config) {
  const sourceBytes = await readFile(sourcePath);
  let source;
  try {
    source = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    fail(`${config.label} semantic decision source is not valid JSON: ${error.message}`, 'DECISION_SOURCE_JSON', config);
  }
  return { source, sourceBytes };
}

export function authoredSemanticDecisionRowDigest(row) {
  return sha256Json(compactAuthoredSemanticDecisionRow(row));
}

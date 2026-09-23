import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  inspectWriterDomainEvidence,
  validateLexicalRecord,
  validateTopicAnalysisEvidence,
} from '../validate/lexical-quality.mjs';
import { compactAuthoredSemanticDecisionRow } from '../validate/semantic-decision-row.mjs';
import {
  M5_13_BATCH_ID,
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CANDIDATE_SOURCE_ID,
  M5_13_GENERATION_PASS_ID,
  M5_13_GENERATOR_VERSION,
  M5_13_IMPORT_COUNT,
  M5_13_ISSUE,
  M5_13_PARENT_ISSUE,
  M5_13_RESERVE_COUNT,
  M5_13_SELECTION_COUNT,
  M5_13_SEMANTIC_REVIEW_VERSION,
  M5_13_VERIFICATION_PASS_ID,
} from './m5-13-candidate-source.mjs';
import { selectReviewedCandidates } from './lexical-selection.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);

export const M5_13_SEMANTIC_DECISION_SOURCE_ID = 'm5-13-authored-semantic-decisions-20260923-r4';
export const M5_13_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-13-semantic-decisions.json',
);
export const M5_13_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v2';
export const M5_13_SEMANTIC_DECISION_SOURCE_POLICY = 'shared-quality-coverage-selection-v4';

const DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);
const IMPORTABLE = new Set(['included', 'corrected']);
const GLOSS_JUDGMENTS = new Set(['fit', 'needs-context', 'reject']);
const MAX_CORRECTION_RATE = 0.5;

export class M513DecisionSourceError extends Error {
  constructor(message, code = 'M5_13_DECISION_SOURCE_ERROR') {
    super(message);
    this.name = 'M513DecisionSourceError';
    this.code = code;
  }
}

function fail(message, code = 'M5_13_DECISION_SOURCE_ERROR') {
  throw new M513DecisionSourceError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'M5_13_DECISION_SOURCE_SHAPE');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'M5_13_DECISION_SOURCE_VALUE');
  }
  return value;
}

function requireDigest(value, label) {
  requireString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a SHA-256 digest`, 'M5_13_DECISION_SOURCE_VALUE');
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

export const compactM513DecisionRow = compactAuthoredSemanticDecisionRow;

function sourceForArtifactDigest(source) {
  const withoutDigest = structuredClone(source);
  delete withoutDigest.artifact_sha256;
  withoutDigest.decisions = withoutDigest.decisions.map(compactM513DecisionRow);
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
    fail(`${label} is not bound to the authored candidate identity`, 'M5_13_CANDIDATE_SOURCE_BINDING');
  }
  return candidate;
}

export function candidateRecordsFromM513DecisionSource(
  source,
  identities = M5_13_CANDIDATE_IDENTITIES,
) {
  requireObject(source, 'M5-13 semantic decision source');
  const candidates = source.candidate_records;
  if (!Array.isArray(candidates) || candidates.length !== identities.length) {
    fail(
      `M5-13 semantic decision source must contain ${identities.length} authored candidate records`,
      'M5_13_CANDIDATE_SOURCE_SCOPE',
    );
  }
  if (source.candidate_records_sha256 !== sha256Json(candidates)) {
    fail('M5-13 authored candidate record digest is not reproducible', 'M5_13_CANDIDATE_SOURCE_BINDING');
  }
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const byId = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const identity = identityById.get(candidate?.id);
    if (!identity) fail(`authored candidate ${candidate?.id ?? index} is outside the identity source`, 'M5_13_CANDIDATE_SOURCE_SCOPE');
    if (byId.has(candidate.id)) fail(`duplicate authored candidate ${candidate.id}`, 'M5_13_CANDIDATE_SOURCE_SCOPE');
    byId.set(candidate.id, validateAuthoredCandidateRecord(
      candidate,
      identity,
      `M5-13 authored candidate ${candidate.id}`,
    ));
  }
  return identities.map((identity) => {
    const candidate = byId.get(identity.candidate_record_id);
    if (!candidate) fail(`authored candidate ${identity.candidate_record_id} is missing`, 'M5_13_CANDIDATE_SOURCE_SCOPE');
    return structuredClone(candidate);
  });
}

export function decisionSenseReviews(candidate, row, label = 'decision') {
  if (!Array.isArray(row.sense_reviews) || row.sense_reviews.length !== candidate.senses.length) {
    fail(`${label}.sense_reviews must contain one review for every authored sense`, 'M5_13_DECISION_SOURCE_SCOPE');
  }
  const expectedIds = candidate.senses.map(({ id }) => id);
  const actualIds = row.sense_reviews.map(({ sense_id: senseId }) => senseId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || new Set(actualIds).size !== actualIds.length) {
    fail(`${label}.sense_reviews must cover authored senses in source order`, 'M5_13_DECISION_SOURCE_BINDING');
  }
  return row.sense_reviews;
}

function validateDecisionRow(row, { identity, candidate, decisionSourceId } = {}) {
  const label = `decision ${identity.inventory_id}`;
  requireObject(row, label);
  if (row.inventory_id !== identity.inventory_id || row.candidate_record_id !== candidate.id) {
    fail(`${label} is not source-bound`, 'M5_13_DECISION_SOURCE_BINDING');
  }
  if (row.candidate_record_sha256 !== sha256Json(candidate)) {
    fail(`${label}.candidate_record_sha256 does not bind the candidate`, 'M5_13_DECISION_SOURCE_BINDING');
  }
  if (!DECISIONS.has(row.decision)) fail(`${label}.decision is unsupported`, 'M5_13_DECISION_SOURCE_VALUE');
  if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > M5_13_SELECTION_COUNT) {
    fail(`${label}.rank must be within the complete candidate pool`, 'M5_13_DECISION_SOURCE_VALUE');
  }
  if (!Number.isFinite(row.score)) fail(`${label}.score must be finite`, 'M5_13_DECISION_SOURCE_VALUE');
  requireString(row.decision_rationale, `${label}.decision_rationale`);
  requireString(row.selection_rationale, `${label}.selection_rationale`);
  if (!row.decision_rationale.includes(identity.inventory_id)
    || !row.decision_rationale.includes(candidate.id)
    || !row.selection_rationale.includes(identity.inventory_id)) {
    fail(`${label} rationale must cite the inventory and candidate identity`, 'M5_13_DECISION_SOURCE_BINDING');
  }
  if (row.review_pass_id !== M5_13_VERIFICATION_PASS_ID) {
    fail(`${label}.review_pass_id is not bound to the verification pass`, 'M5_13_DECISION_SOURCE_PROVENANCE');
  }
  if (!GLOSS_JUDGMENTS.has(row.gloss_judgment)) fail(`${label}.gloss_judgment is unsupported`, 'M5_13_DECISION_SOURCE_VALUE');
  const expectedJudgment = row.decision === 'rejected'
    ? 'reject'
    : IMPORTABLE.has(row.decision) ? 'fit' : 'needs-context';
  if (row.gloss_judgment !== expectedJudgment) {
    fail(`${label}.gloss_judgment contradicts its authored decision`, 'M5_13_DECISION_SOURCE_COHERENCE');
  }
  const senseReviews = decisionSenseReviews(candidate, row, label);
  for (const [senseIndex, senseReview] of senseReviews.entries()) {
    const senseLabel = `${label}.sense_reviews[${senseIndex}]`;
    const sense = candidate.senses[senseIndex];
    requireObject(senseReview, senseLabel);
    if (senseReview.sense_id !== sense.id) fail(`${senseLabel} is not source-bound`, 'M5_13_DECISION_SOURCE_BINDING');
    requireString(senseReview.semantic_rationale, `${senseLabel}.semantic_rationale`);
    requireString(senseReview.boundary_rationale, `${senseLabel}.boundary_rationale`);
    if (senseReview.boundary_action !== 'retain' || senseReview.boundary_classification !== 'atomic') {
      fail(`${senseLabel} must retain an atomic writer-facing unit`, 'M5_13_DECISION_SOURCE_BINDING');
    }
    const domains = inspectWriterDomainEvidence(sense.gloss);
    const expectedBoundaryDecision = domains.axes.length > 1 ? 'coordinated' : 'atomic';
    if (senseReview.boundary_decision !== expectedBoundaryDecision) {
      fail(`${senseLabel}.boundary_decision does not bind the reviewed gloss domains`, 'M5_13_DECISION_SOURCE_BINDING');
    }
    validateTopicAnalysisEvidence(sense.gloss, senseReview.review_basis ?? {}, {
      decisionSourceId,
      incompleteCode: 'M5_13_DECISION_SOURCE_SCOPE',
      label: `${senseLabel}.review_basis`,
    });
    if (senseReview.relation_count !== 0
      || !Array.isArray(senseReview.relation_ids)
      || senseReview.relation_ids.length !== 0
      || senseReview.relation_decision !== 'no-relations') {
      fail(`${senseLabel} relation evidence is not source-bound`, 'M5_13_DECISION_SOURCE_BINDING');
    }
    requireString(senseReview.no_relation_rationale, `${senseLabel}.no_relation_rationale`);
    if (!senseReview.no_relation_rationale.includes(identity.inventory_id)
      || !senseReview.no_relation_rationale.includes(sense.id)) {
      fail(`${senseLabel}.no_relation_rationale must cite the source-bound sense`, 'M5_13_DECISION_SOURCE_BINDING');
    }
  }
  return row;
}

export function serializeM513DecisionSource(source) {
  const withoutDigest = sourceForArtifactDigest(source);
  const artifactSha256 = sha256Json(withoutDigest);
  const serialized = {
    ...withoutDigest,
    decisions: source.decisions.map(compactM513DecisionRow),
    artifact_sha256: artifactSha256,
  };
  return {
    source: serialized,
    artifactSha256,
    bytes: Buffer.from(`${JSON.stringify(serialized, null, 2)}\n`, 'utf8'),
  };
}

export function validateM513DecisionSource({
  source,
  sourceBytes,
  identities = M5_13_CANDIDATE_IDENTITIES,
  candidateRecords,
} = {}) {
  requireObject(source, 'M5-13 semantic decision source');
  if (source.schema_version !== '1'
    || source.contract_version !== M5_13_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION
    || source.kind !== 'separately-authored-semantic-decision-source') {
    fail('M5-13 semantic decision source contract is unsupported', 'M5_13_DECISION_SOURCE_CONTRACT');
  }
  if (source.source_id !== M5_13_SEMANTIC_DECISION_SOURCE_ID
    || source.issue !== M5_13_ISSUE
    || source.parent_issue !== M5_13_PARENT_ISSUE
    || source.batch_id !== M5_13_BATCH_ID
    || source.authoring_mode !== 'agent-authored-decision') {
    fail('M5-13 semantic decision source scope drifted', 'M5_13_DECISION_SOURCE_SCOPE');
  }
  const provenance = requireObject(source.provenance, 'M5-13 semantic decision source.provenance');
  if (provenance.human_reviewed !== false
    || provenance.generator_version !== M5_13_SEMANTIC_REVIEW_VERSION
    || provenance.generation_pass_id !== M5_13_GENERATION_PASS_ID
    || provenance.verification_pass_id !== M5_13_VERIFICATION_PASS_ID
    || provenance.generation_pass_id === provenance.verification_pass_id) {
    fail('M5-13 source provenance is not truthful or separated', 'M5_13_DECISION_SOURCE_PROVENANCE');
  }
  const review = requireObject(source.review, 'M5-13 semantic decision source.review');
  if (review.review_pass_id !== M5_13_VERIFICATION_PASS_ID
    || review.reviewer !== 'codex-agent'
    || review.status !== 'complete'
    || review.candidate_count !== identities.length
    || review.reviewed_candidate_count !== identities.length
    || review.prior_generator_replaced !== true
    || review.prior_generator_verification_pass_id !== M5_13_GENERATION_PASS_ID) {
    fail('M5-13 authored semantic review is incomplete', 'M5_13_DECISION_SOURCE_PROVENANCE');
  }
  const candidateSource = requireObject(source.candidate_source, 'M5-13 semantic decision source.candidate_source');
  if (candidateSource.source_id !== M5_13_CANDIDATE_SOURCE_ID
    || candidateSource.identity_sha256 !== candidateIdentityDigest(identities)
    || candidateSource.identity_count !== identities.length) {
    fail('M5-13 source is not bound to the identity source', 'M5_13_DECISION_SOURCE_BINDING');
  }
  const selection = requireObject(source.selection, 'M5-13 semantic decision source.selection');
  if (selection.policy !== M5_13_SEMANTIC_DECISION_SOURCE_POLICY
    || selection.capacity !== M5_13_SELECTION_COUNT
    || selection.imported !== M5_13_IMPORT_COUNT
    || selection.reserve !== M5_13_RESERVE_COUNT) {
    fail('M5-13 selection policy drifted', 'M5_13_DECISION_SOURCE_SCOPE');
  }
  if (!Buffer.isBuffer(sourceBytes)) fail('M5-13 semantic decision source bytes are required', 'M5_13_DECISION_SOURCE_BINDING');
  const artifactSha256 = requireDigest(source.artifact_sha256, 'M5-13 semantic decision source.artifact_sha256');
  if (artifactSha256 !== sha256Json(sourceForArtifactDigest(source))) {
    fail('M5-13 semantic decision source artifact digest is not reproducible', 'M5_13_DECISION_SOURCE_BINDING');
  }
  const authoredCandidateRecords = candidateRecordsFromM513DecisionSource(source, identities);
  if (!Array.isArray(candidateRecords) || candidateRecords.length !== authoredCandidateRecords.length) {
    fail('M5-13 validation requires the complete authored candidate set', 'M5_13_CANDIDATE_SOURCE_SCOPE');
  }
  for (const [index, candidate] of candidateRecords.entries()) {
    if (JSON.stringify(candidate) !== JSON.stringify(authoredCandidateRecords[index])) {
      fail(`candidate ${candidate?.id ?? index} does not match the durable authored source`, 'M5_13_CANDIDATE_SOURCE_BINDING');
    }
  }
  if (!Array.isArray(source.decisions) || source.decisions.length !== identities.length) {
    fail(`M5-13 semantic decision source must contain ${identities.length} decisions`, 'M5_13_DECISION_SOURCE_SCOPE');
  }
  const candidateById = new Map(candidateRecords.map((candidate) => [candidate.id, candidate]));
  const identityById = new Map(identities.map((identity) => [identity.candidate_record_id, identity]));
  const seenIds = new Set();
  const seenRanks = new Set();
  for (const row of source.decisions) {
    const identity = identityById.get(row.candidate_record_id);
    const candidate = candidateById.get(row.candidate_record_id);
    if (!identity || !candidate) fail(`decision ${row.candidate_record_id} is outside the identity source`, 'M5_13_DECISION_SOURCE_SCOPE');
    if (seenIds.has(row.candidate_record_id) || seenRanks.has(row.rank)) fail('M5-13 decisions contain duplicate identity or rank', 'M5_13_DECISION_SOURCE_SCOPE');
    seenIds.add(row.candidate_record_id);
    seenRanks.add(row.rank);
    validateDecisionRow(row, { identity, candidate, decisionSourceId: source.source_id });
  }
  if (seenIds.size !== identities.length || seenRanks.size !== M5_13_SELECTION_COUNT) fail('M5-13 selection coverage is incomplete', 'M5_13_DECISION_SOURCE_SCOPE');
  const counts = expectedDecisionCounts(source.decisions);
  const selectionResult = selectReviewedCandidates(source.decisions, {
    capacity: M5_13_IMPORT_COUNT,
  });
  if (selectionResult.status !== 'pass') {
    fail('M5-13 semantic review produced fewer qualified candidates than the admission capacity', 'M5_13_SELECTION_HOLD');
  }
  const imported = selectionResult.selected.length;
  const heldOrRejected = counts.held + counts.rejected;
  const processed = source.decisions.length - counts.deferred;
  const expectedDeferred = identities.length - imported - selectionResult.reserve.length - heldOrRejected;
  if (imported !== M5_13_IMPORT_COUNT
    || selectionResult.reserve.length + heldOrRejected + counts.deferred !== M5_13_RESERVE_COUNT
    || counts.deferred !== expectedDeferred
    || processed !== counts.included + counts.corrected + heldOrRejected
    || processed <= 0
    || counts.corrected / processed > MAX_CORRECTION_RATE) {
    fail(`M5-13 decision contract is invalid: ${JSON.stringify({ ...counts, imported, heldOrRejected, processed })}`, 'M5_13_DECISION_SOURCE_SCOPE');
  }
  if (JSON.stringify(review.decision_counts) !== JSON.stringify(counts)
    || JSON.stringify(review.counts) !== JSON.stringify(counts)) {
    fail('M5-13 review counts do not match authored decisions', 'M5_13_DECISION_SOURCE_SCOPE');
  }
  return {
    source,
    sourceBytes,
    sourceSha256: sha256(sourceBytes),
    artifactSha256,
    rows: source.decisions,
    byCandidateId: new Map(source.decisions.map((row) => [row.candidate_record_id, row])),
    counts,
    selection: selectionResult,
  };
}

export async function readM513DecisionSource(
  decisionSourcePath = M5_13_SEMANTIC_DECISION_SOURCE_PATH,
) {
  const sourceBytes = await readFile(decisionSourcePath);
  let source;
  try {
    source = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    fail(`M5-13 semantic decision source is not valid JSON: ${error.message}`, 'M5_13_DECISION_SOURCE_JSON');
  }
  return { source, sourceBytes };
}

export function buildM513DecisionSource() {
  fail(
    'M5-13 semantic decisions are a separately authored durable artifact; the shared producer cannot regenerate or overwrite them',
    'M5_13_DECISION_SOURCE_REGENERATION',
  );
}

export function buildM513DecisionScaffold({ identities = M5_13_CANDIDATE_IDENTITIES } = {}) {
  return {
    source_id: M5_13_SEMANTIC_DECISION_SOURCE_ID,
    candidate_source_id: M5_13_CANDIDATE_SOURCE_ID,
    candidate_identity_count: identities.length,
    selection_capacity: M5_13_SELECTION_COUNT,
    import_target: M5_13_IMPORT_COUNT,
    reserve_capacity: M5_13_RESERVE_COUNT,
    writes_decision_artifact: false,
  };
}

export function applyM513DecisionCorrection() {
  fail('M5-13 corrections must be authored in the durable semantic decision source', 'M5_13_CORRECTION_POLICY');
}

export function decisionRowDigest(row) {
  return sha256Json(compactM513DecisionRow(row));
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
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

export const M5_12A_SEMANTIC_DECISION_SOURCE_ID = 'm5-12a-authored-semantic-decisions-20260920-r2';
export const M5_12A_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-12a-semantic-decisions.json',
);
export const M5_12A_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v1';
export const M5_12A_SEMANTIC_DECISION_SOURCE_POLICY = 'source-authored-quality-coverage-v1';
export const M5_12A_AUTHORED_SEMANTIC_REVIEW_VERSION = 'm5-12a-authored-semantic-review-v2';

const DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);
const IMPORTABLE = new Set(['included', 'corrected']);
const GLOSS_JUDGMENTS = new Set(['fit', 'needs-context', 'reject']);
const CORRECTION_ACTIONS = new Set(['append-normalized-search-form']);
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
  if (!CORRECTION_ACTIONS.has(correction.action)) {
    fail(`${label}.action is unsupported`, 'M5_12A_DECISION_SOURCE_VALUE');
  }
  if (!Array.isArray(correction.output_search_forms)
    || correction.output_search_forms.length === 0
    || correction.output_search_forms.some((form) => typeof form !== 'string' || form.trim().length === 0)) {
    fail(`${label}.output_search_forms must contain non-empty strings`, 'M5_12A_DECISION_SOURCE_VALUE');
  }
  const normalizedLemma = candidate.lemma.replaceAll(' ', '');
  if (normalizedLemma === candidate.lemma) {
    fail(`${label} must change a spaced lemma`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const expectedSearchForms = [...new Set([...candidate.search_forms, normalizedLemma])];
  if (JSON.stringify(correction.output_search_forms) !== JSON.stringify(expectedSearchForms)) {
    fail(`${label}.output_search_forms does not bind the authored correction`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const correctedRecord = {
    ...structuredClone(candidate),
    search_forms: [...correction.output_search_forms],
  };
  if (correction.output_record_sha256 !== sha256Json(correctedRecord)) {
    fail(`${label}.output_record_sha256 does not bind the corrected record`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  return correctedRecord;
}

function validateDecisionRow(row, {
  identity,
  candidate,
  sourceSha256,
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
  const reviewBasis = requireObject(row.review_basis, `${label}.review_basis`);
  if (reviewBasis.lexical_unit !== candidate.lemma
    || reviewBasis.gloss_sha256 !== sha256Json(candidate.senses[0].gloss)
    || reviewBasis.review_pass_id !== M5_12A_VERIFICATION_PASS_ID
    || reviewBasis.reviewer !== 'codex-agent') {
    fail(`${label}.review_basis is not bound to the authored verification pass`, 'M5_12A_DECISION_SOURCE_BINDING');
  }

  const sense = candidate.senses[0];
  if (row.sense_id !== sense.id) fail(`${label}.sense_id is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  if (row.sense_gloss_sha256 !== sha256Json(sense.gloss)) fail(`${label}.sense_gloss_sha256 does not bind the candidate gloss`, 'M5_12A_DECISION_SOURCE_BINDING');
  if (row.pos !== sense.pos || row.record_type !== candidate.record_type) {
    fail(`${label} POS or record type is not source-bound`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.decision === 'corrected') {
    applyM512ADecisionCorrection(candidate, row.correction);
  } else if (Object.hasOwn(row, 'correction')) {
    fail(`${label}.correction is only allowed for corrected decisions`, 'M5_12A_DECISION_SOURCE_VALUE');
  }

  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  const connectorObservations = inspectGlossConnectors(sense.gloss);
  if (JSON.stringify(row.observed_domain_axes) !== JSON.stringify(domainEvidence.axes)
    || JSON.stringify(row.domain_evidence) !== JSON.stringify(domainEvidence.matches)
    || JSON.stringify(row.connector_observations) !== JSON.stringify(connectorObservations)) {
    fail(`${label} semantic observations do not bind the candidate gloss`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  const expectedBoundaryDecision = domainEvidence.axes.length > 1 ? 'coordinated' : 'atomic';
  if (row.boundary_action !== 'retain'
    || row.boundary_classification !== 'atomic'
    || row.boundary_decision !== expectedBoundaryDecision) {
    fail(`${label} boundary decision is not a source-bound atomic review`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  if (row.relation_decision !== 'no-relations' || row.relation_count !== 0) {
    fail(`${label} relation decision is not explicit no-relation evidence`, 'M5_12A_DECISION_SOURCE_BINDING');
  }
  requireString(row.no_relation_rationale, `${label}.no_relation_rationale`);
  if (!row.no_relation_rationale.includes(identity.inventory_id)
    || !row.no_relation_rationale.includes(sense.id)) {
    fail(`${label}.no_relation_rationale must cite the source-bound sense`, 'M5_12A_DECISION_SOURCE_BINDING');
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
    validateDecisionRow(row, { identity, candidate, sourceSha256: artifactSha256 });
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

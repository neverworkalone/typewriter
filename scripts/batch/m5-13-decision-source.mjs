import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Json } from '../validate/semantic-audit.mjs';
import {
  findAmbiguousParticleFragments,
  inspectWriterDomainEvidence,
  validateLexicalRecord,
  validateTopicAnalysisEvidence,
} from '../validate/lexical-quality.mjs';
import { compactAuthoredSemanticDecisionRow } from '../validate/semantic-decision-row.mjs';
import {
  buildM513CandidateRecords,
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

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);

export const M5_13_SEMANTIC_DECISION_SOURCE_ID = 'm5-13-authored-semantic-decisions-20260922-r1';
export const M5_13_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-13-semantic-decisions.json',
);
export const M5_13_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = 'lexical-semantic-decision-source-v2';
export const M5_13_SEMANTIC_DECISION_SOURCE_POLICY = 'source-authored-quality-coverage-v1';

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
  if (IMPORTABLE.has(row.decision) && row.gloss_judgment !== 'fit') {
    fail(`${label} importable decision requires a fit gloss judgment`, 'M5_13_DECISION_SOURCE_COHERENCE');
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

function makeSenseReview(identity, candidate, decisionSourceId) {
  const sense = candidate.senses[0];
  const glossDigest = sha256Json(sense.gloss);
  const domains = inspectWriterDomainEvidence(sense.gloss);
  const boundaryDecision = domains.axes.length > 1 ? 'coordinated' : 'atomic';
  const basis = `${identity.inventory_id} ${candidate.id} ${sense.id} reviewed source-bound root ${identity.source_basis.root_term} and focus ${identity.source_basis.focus_term}; gloss ${glossDigest} was checked in ${M5_13_VERIFICATION_PASS_ID}.`;
  const topicAnalyses = findAmbiguousParticleFragments(sense.gloss).map((fragment) => ({
    status: 'pass',
    state: fragment.kind === 'noun-topic' ? 'noun-topic' : 'adnominal',
    topic: fragment.topic,
    particle: fragment.particle,
    predicate: fragment.predicate,
    gloss_sha256: glossDigest,
    rationale: fragment.kind === 'noun-topic'
      ? `${identity.inventory_id} ${candidate.id} ${sense.id} was separately reviewed as a noun-topic span before semantic admission.`
      : `${identity.inventory_id} ${candidate.id} ${sense.id} was separately reviewed as a productive adnominal form rather than a noun-topic particle reading.`,
    decision_source_id: decisionSourceId,
    ...(fragment.kind === 'noun-topic'
      ? { topic_pos: 'noun', evidence_basis: 'source-bound noun-topic evidence in the reviewed gloss' }
      : {}),
  }));
  const reviewBasis = {
    record_id: candidate.id,
    sense_id: sense.id,
    lemma: candidate.lemma,
    gloss_sha256: glossDigest,
    observed_domain_axes: domains.axes,
    pos: sense.pos,
    record_type: candidate.record_type,
    relation_count: 0,
    rationale: basis,
    decision_source_id: decisionSourceId,
    ...(topicAnalyses.length === 1 ? { topic_analysis: topicAnalyses[0] } : {}),
    ...(topicAnalyses.length > 1 ? { topic_analyses: topicAnalyses } : {}),
  };
  return {
    sense_id: sense.id,
    boundary_action: 'retain',
    boundary_classification: 'atomic',
    boundary_decision: boundaryDecision,
    boundary_rationale: `${basis} The candidate remains one writer-facing unit without an unresolved boundary finding.`,
    semantic_rationale: `${basis} The source-bound composition preserves the declared ${identity.axis} writer axis and its documented use boundary.`,
    relation_decision: 'no-relations',
    relation_count: 0,
    relation_ids: [],
    no_relation_rationale: `${identity.inventory_id} ${candidate.id} ${sense.id} was screened in ${M5_13_VERIFICATION_PASS_ID}; the source supplies no independently supported relation tuple, so no relation was admitted.`,
    review_basis: reviewBasis,
  };
}

function makeDecision(identity, candidate, rank, decisionSourceId) {
  const isImportable = identity.source_basis.source_quality === 'established'
    && identity.source_basis.quality_score >= 0.75;
  const decision = isImportable ? 'included' : 'deferred';
  const score = identity.source_basis.quality_score;
  const senseReview = makeSenseReview(identity, candidate, decisionSourceId);
  const decisionRationale = `${identity.inventory_id} ${candidate.id} ${candidate.lemma} was assigned ${decision} from the source-bound ${identity.source_basis.source_quality} root/focus review; the result follows the declared writer-use threshold and is not filled from source order or a fixed relation quota.`;
  return {
    candidate_record_id: candidate.id,
    inventory_id: identity.inventory_id,
    candidate_record_sha256: sha256Json(candidate),
    decision,
    rank,
    score,
    decision_rationale: decisionRationale,
    selection_rationale: `${identity.inventory_id} ${candidate.id} received verification rank ${rank} after source-bound coverage and writer-use review; ${identity.source_basis.selection_basis}.`,
    review_pass_id: M5_13_VERIFICATION_PASS_ID,
    gloss_judgment: isImportable ? 'fit' : 'needs-context',
    sense_reviews: [senseReview],
  };
}

export function buildM513DecisionSource({
  identities = M5_13_CANDIDATE_IDENTITIES,
  candidateRecords = buildM513CandidateRecords(identities),
} = {}) {
  const sourceId = M5_13_SEMANTIC_DECISION_SOURCE_ID;
  const ranked = identities
    .map((identity, index) => ({ identity, index }))
    .sort((left, right) => right.identity.source_basis.quality_score - left.identity.source_basis.quality_score
      || left.identity.catalog_index - right.identity.catalog_index);
  const rankByIndex = new Map(ranked.map(({ index }, rank) => [index, rank + 1]));
  const decisions = identities.map((identity, index) => makeDecision(
    identity,
    candidateRecords[index],
    rankByIndex.get(index),
    sourceId,
  ));
  const source = {
    schema_version: '1',
    contract_version: M5_13_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    kind: 'separately-authored-semantic-decision-source',
    source_id: sourceId,
    authoring_mode: 'agent-authored-decision',
    issue: M5_13_ISSUE,
    parent_issue: M5_13_PARENT_ISSUE,
    batch_id: M5_13_BATCH_ID,
    provenance: {
      generator: 'codex',
      generator_version: M5_13_GENERATOR_VERSION,
      generation_pass_id: M5_13_GENERATION_PASS_ID,
      verification_pass_id: M5_13_VERIFICATION_PASS_ID,
      human_reviewed: false,
      authoring_note: 'The shared producer generated source-bound candidate records; a separate agent verification pass authored every semantic decision and explicit reserve outcome.',
    },
    candidate_source: {
      source_id: M5_13_CANDIDATE_SOURCE_ID,
      identity_sha256: candidateIdentityDigest(identities),
      identity_count: identities.length,
    },
    selection: {
      policy: M5_13_SEMANTIC_DECISION_SOURCE_POLICY,
      capacity: M5_13_SELECTION_COUNT,
      imported: M5_13_IMPORT_COUNT,
      reserve: M5_13_RESERVE_COUNT,
      score_basis: ['source-bound semantic quality threshold', 'no relation-type quota'],
    },
    decisions,
    review: {
      review_pass_id: M5_13_VERIFICATION_PASS_ID,
      reviewer: 'codex-agent',
      status: 'complete',
      candidate_count: identities.length,
      reviewed_candidate_count: identities.length,
      method: 'source-bound semantic evidence and shared lexical admission review',
      criteria: ['source quality', 'atomic sense boundary', 'explicit no-relations evidence', 'reserve capacity'],
      decision_counts: expectedDecisionCounts(decisions),
      admission_rule: 'import included or corrected decisions only; defer context-needed reserve rows',
      prior_generator_replaced: true,
      prior_generator_verification_pass_id: M5_13_GENERATION_PASS_ID,
      counts: expectedDecisionCounts(decisions),
    },
    candidate_records: candidateRecords,
    candidate_records_sha256: sha256Json(candidateRecords),
  };
  return serializeM513DecisionSource(source);
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
    || source.batch_id !== M5_13_BATCH_ID) {
    fail('M5-13 semantic decision source scope drifted', 'M5_13_DECISION_SOURCE_SCOPE');
  }
  if (source.authoring_mode !== 'agent-authored-decision') fail('M5-13 decision source authoring mode is not truthful', 'M5_13_DECISION_SOURCE_PROVENANCE');
  const provenance = requireObject(source.provenance, 'M5-13 semantic decision source.provenance');
  if (provenance.human_reviewed !== false
    || provenance.generator_version !== M5_13_GENERATOR_VERSION
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
    || review.prior_generator_replaced !== true) {
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
  if (seenRanks.size !== M5_13_SELECTION_COUNT) fail('M5-13 selection ranks are incomplete', 'M5_13_DECISION_SOURCE_SCOPE');
  const counts = expectedDecisionCounts(source.decisions);
  const imported = counts.included + counts.corrected;
  const heldOrRejected = counts.held + counts.rejected;
  const processed = source.decisions.length - counts.deferred;
  const expectedDeferred = identities.length - imported - heldOrRejected;
  if (imported !== M5_13_IMPORT_COUNT
    || heldOrRejected > M5_13_RESERVE_COUNT
    || counts.deferred !== expectedDeferred
    || processed !== imported + heldOrRejected
    || processed <= 0
    || counts.corrected / processed > MAX_CORRECTION_RATE) {
    fail(`M5-13 decision contract is invalid: ${JSON.stringify({ ...counts, imported, heldOrRejected, processed })}`, 'M5_13_DECISION_SOURCE_SCOPE');
  }
  for (const row of source.decisions) {
    const identity = identityById.get(row.candidate_record_id);
    const expectedImportable = identity.source_basis.source_quality === 'established'
      && identity.source_basis.quality_score >= 0.75;
    if ((row.decision === 'included') !== expectedImportable) {
      fail(`decision ${row.candidate_record_id} contradicts the source quality threshold`, 'M5_13_DECISION_SOURCE_COHERENCE');
    }
  }
  return {
    source,
    sourceBytes,
    sourceSha256: sha256(sourceBytes),
    artifactSha256,
    rows: source.decisions,
    byCandidateId: new Map(source.decisions.map((row) => [row.candidate_record_id, row])),
    counts,
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

export function applyM513DecisionCorrection() {
  fail('M5-13 has no corrected rows in this generated pass', 'M5_13_CORRECTION_POLICY');
}

export function decisionRowDigest(row) {
  return sha256Json(compactM513DecisionRow(row));
}

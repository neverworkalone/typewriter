import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { M5_11_CATALOG } from './m5-11-catalog.mjs';
import {
  BROAD_GLOSS_CONNECTOR_PATTERN,
  hasBroadGlossConnector,
  validateLexicalRecord,
  validateLexicalSemanticReview,
} from '../validate/lexical-quality.mjs';

export const M5_11_BATCH_ID = 'm5-11-expansion-20260913';
export const M5_11_AGENT_REVIEW_MODE = 'agent-generated';
export const M5_11_AGENT_PROVENANCE_KIND = 'agent_generated';
export const M5_11_AGENT_GENERATOR = 'codex';
export const M5_11_AGENT_EDITORIAL_VERSION = 'm5-11a-agent-editorial-v2';
export const M5_11_AGENT_SEMANTIC_REVIEW_VERSION = 'm5-11a-semantic-review-v2';
export const M5_11_AGENT_RELATION_BEARING_AXES = Object.freeze(['Q', 'S', 'C', 'A', 'O', 'X']);
export const M5_11_AGENT_MIN_AXIS_COVERAGE_RATIO = 0.8;
export const M5_11_BROAD_GLOSS_PATTERN = BROAD_GLOSS_CONNECTOR_PATTERN;
export const M5_11_AGENT_GATE_DECISION = 'APPROVE AUTOMATED BOUNDED';
export const M5_11_BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
export const M5_11_DECISIONS = Object.freeze([
  'included',
  'corrected',
  'held',
  'rejected',
  'deferred',
]);

export class M511EditorialValidationError extends Error {
  constructor(message, code = 'M5_11_EDITORIAL_VALIDATION_ERROR') {
    super(message);
    this.name = 'M511EditorialValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_EDITORIAL_VALIDATION_ERROR') {
  throw new M511EditorialValidationError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'EDITORIAL_SHAPE_ERROR');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'EDITORIAL_VALUE_ERROR');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'EDITORIAL_SHAPE_ERROR');
  return value;
}

function assertJsonEqual(actual, expected, label, code) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${label} does not match the canonical record`, code);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function sha256ProposalRow({ inventory_id: inventoryId, candidate_lemma: candidateLemma, candidate_record: candidateRecord }) {
  return sha256Json({
    inventory_id: inventoryId,
    candidate_lemma: candidateLemma,
    candidate_record: candidateRecord,
  });
}

export function expectedInventoryId(index) {
  return `m5-${String(535 + index).padStart(3, '0')}`;
}

export function expectedCanonicalId(importIndex) {
  return `w${String(779 + importIndex).padStart(3, '0')}`;
}

export function isM511AgentGeneratedArtifact(artifact) {
  return artifact?.review_mode === M5_11_AGENT_REVIEW_MODE
    || artifact?.provenance?.kind === M5_11_AGENT_PROVENANCE_KIND;
}

export const hasM511BroadGlossConnector = hasBroadGlossConnector;

function validateSharedLexicalRecord(record, options) {
  try {
    return validateLexicalRecord(record, options);
  } catch (error) {
    fail(error.message, error.code);
  }
}

export function validateM511AgentProvenance(artifact, label = 'M5-11 agent artifact') {
  requireObject(artifact, label);
  if (artifact.review_mode !== M5_11_AGENT_REVIEW_MODE) {
    fail(`${label}.review_mode must be ${M5_11_AGENT_REVIEW_MODE}`, 'EDITORIAL_PROVENANCE_ERROR');
  }
  const provenance = requireObject(artifact.provenance, `${label}.provenance`);
  if (provenance.kind !== M5_11_AGENT_PROVENANCE_KIND) {
    fail(`${label}.provenance.kind must be ${M5_11_AGENT_PROVENANCE_KIND}`, 'EDITORIAL_PROVENANCE_ERROR');
  }
  if (provenance.generator !== M5_11_AGENT_GENERATOR) {
    fail(`${label}.provenance.generator must be ${M5_11_AGENT_GENERATOR}`, 'EDITORIAL_PROVENANCE_ERROR');
  }
  requireString(provenance.generator_version, `${label}.provenance.generator_version`);
  requireString(provenance.pass_id, `${label}.provenance.pass_id`);
  if (artifact.human_editorial_review_complete !== false) {
    fail(`${label} must not claim human editorial review`, 'EDITORIAL_HUMAN_ATTRIBUTION');
  }
  return provenance;
}

function validateProposalArtifact(proposal, catalog) {
  requireObject(proposal, 'M5-11 frozen proposal artifact');
  if (proposal.schema_version !== '1') {
    fail('M5-11 frozen proposal schema_version must be 1', 'EDITORIAL_PROPOSAL_SCHEMA_ERROR');
  }
  if (proposal.issue !== 97 || proposal.batch_id !== M5_11_BATCH_ID) {
    fail('M5-11 frozen proposal is not bound to issue #97', 'EDITORIAL_PROPOSAL_SCOPE_MISMATCH');
  }
  if (proposal.catalog_sha256 !== sha256Json(catalog)) {
    fail('M5-11 frozen proposal catalog digest drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  if (proposal.catalog_count !== catalog.length) {
    fail('M5-11 frozen proposal catalog count drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  const proposals = requireArray(proposal.proposals, 'M5-11 frozen proposal.proposals');
  if (proposals.length !== catalog.length) {
    fail('M5-11 frozen proposal must cover the complete catalog', 'EDITORIAL_PROPOSAL_SCOPE_MISMATCH');
  }
  const normalized = [];
  for (const [index, catalogEntry] of catalog.entries()) {
    const label = `proposal.proposals[${index}]`;
    const row = requireObject(proposals[index], label);
    const expectedInventoryId = expectedInventoryIdForIndex(index);
    if (catalogEntry.inventory_id !== expectedInventoryId || row.inventory_id !== expectedInventoryId) {
      fail(`${label}.inventory_id is out of catalog order`, 'EDITORIAL_PROPOSAL_SCOPE_MISMATCH');
    }
    const candidateLemma = requireString(row.candidate_lemma, `${label}.candidate_lemma`);
    const candidateRecord = requireObject(row.candidate_record, `${label}.candidate_record`);
    validateCandidateRecord(candidateRecord, candidateLemma, `${label}.candidate_record`);
    const proposalSha256 = requireString(row.proposal_sha256, `${label}.proposal_sha256`);
    if (proposalSha256 !== sha256ProposalRow(row)) {
      fail(`${label}.proposal_sha256 does not bind the proposal body`, 'EDITORIAL_PROPOSAL_BINDING');
    }
    normalized.push(row);
  }
  return normalized;
}

function expectedInventoryIdForIndex(index) {
  return `m5-${String(535 + index).padStart(3, '0')}`;
}

function validateCandidateRecord(record, expectedLemma, label) {
  requireObject(record, label);
  if (!['entry', 'expression'].includes(record.record_type)) {
    fail(`${label}.record_type must be entry or expression`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  if (record.role !== 'start') {
    fail(`${label}.role must be start`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  requireString(record.id, `${label}.id`);
  if (record.candidate_id !== record.id) {
    fail(`${label}.candidate_id must bind the candidate-local record id`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  requireString(record.lemma, `${label}.lemma`);
  if (record.lemma !== expectedLemma) {
    fail(`${label}.lemma must match candidate_lemma`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  const searchForms = requireArray(record.search_forms, `${label}.search_forms`);
  if (searchForms.length === 0 || searchForms.some((form) => typeof form !== 'string' || form.trim().length === 0)) {
    fail(`${label}.search_forms must contain non-empty strings`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  const senses = requireArray(record.senses, `${label}.senses`);
  if (senses.length === 0) fail(`${label}.senses must not be empty`, 'EDITORIAL_PROPOSAL_BINDING');
  for (const [senseIndex, sense] of senses.entries()) {
    const senseLabel = `${label}.senses[${senseIndex}]`;
    requireObject(sense, senseLabel);
    requireString(sense.id, `${senseLabel}.id`);
    if (!sense.id.startsWith(`${record.id}-`)) {
      fail(`${senseLabel}.id must remain candidate-local`, 'EDITORIAL_PROPOSAL_BINDING');
    }
    requireString(sense.pos, `${senseLabel}.pos`);
    requireString(sense.gloss, `${senseLabel}.gloss`);
    if (record.record_type === 'expression' && sense.pos !== 'expression') {
      fail(`${senseLabel}.pos must be expression for an expression proposal`, 'EDITORIAL_PROPOSAL_BINDING');
    }
    if (record.record_type === 'entry' && sense.pos === 'expression') {
      fail(`${senseLabel}.pos cannot be expression for an entry proposal`, 'EDITORIAL_PROPOSAL_BINDING');
    }
    if (sense.relations !== undefined && !Array.isArray(sense.relations)) {
      fail(`${senseLabel}.relations must be an array when present`, 'EDITORIAL_PROPOSAL_BINDING');
    }
  }
  return record;
}

export function rebaseM511CandidateRecord(candidateRecord, expectedId) {
  return {
    ...candidateRecord,
    id: expectedId,
    candidate_id: expectedId,
    senses: candidateRecord.senses.map((sense, index) => ({
      ...sense,
      id: `${expectedId}-s${index + 1}`,
    })),
  };
}

function validateBoundaryChecks(checks, record, inventoryId, label) {
  requireObject(checks, `${label}.boundary_checks`);
  assert.deepEqual(
    Object.keys(checks).sort(),
    [...M5_11_BOUNDARY_IDS].sort(),
    `${label}.boundary_checks keys`,
  );
  let checkedBoundaryCount = 0;
  for (const boundaryId of M5_11_BOUNDARY_IDS) {
    const check = requireObject(checks[boundaryId], `${label}.${boundaryId}`);
    if (!['checked', 'not-applicable'].includes(check.status)) {
      fail(`${label}.${boundaryId}.status must be checked or not-applicable`, 'EDITORIAL_BOUNDARY_INCOMPLETE');
    }
    requireString(check.rationale, `${label}.${boundaryId}.rationale`);
    if (!check.rationale.includes(inventoryId)) {
      fail(
        `${label}.${boundaryId}.rationale must identify ${inventoryId}`,
        'EDITORIAL_BOUNDARY_EVIDENCE_MISMATCH',
      );
    }
    requireString(check.contrast, `${label}.${boundaryId}.contrast`);
    requireArray(check.sense_ids, `${label}.${boundaryId}.sense_ids`);
    for (const senseId of check.sense_ids) {
      requireString(senseId, `${label}.${boundaryId}.sense_ids entry`);
      if (!record.senses.some(({ id }) => id === senseId)) {
        fail(`${label}.${boundaryId} references unknown sense ${senseId}`, 'EDITORIAL_BOUNDARY_BINDING');
      }
    }
    if (check.status === 'checked') {
      checkedBoundaryCount += 1;
      if (check.sense_ids.length === 0) {
        fail(
          `${label}.${boundaryId} checked evidence must cite at least one sense`,
          'EDITORIAL_BOUNDARY_EVIDENCE_MISMATCH',
        );
      }
      if (check.sense_ids.some((senseId) => !check.rationale.includes(senseId))) {
        fail(
          `${label}.${boundaryId}.rationale must cite every checked sense`,
          'EDITORIAL_BOUNDARY_EVIDENCE_MISMATCH',
        );
      }
    } else if (check.sense_ids.length > 0) {
      fail(
        `${label}.${boundaryId} not-applicable evidence must not cite senses`,
        'EDITORIAL_BOUNDARY_EVIDENCE_MISMATCH',
      );
    }
  }
  if (checkedBoundaryCount === 0) {
    fail(`${label} must contain at least one checked sense boundary`, 'EDITORIAL_BOUNDARY_INCOMPLETE');
  }
}

function validateCanonicalRecord(record, expectedId, label, expectedLemma) {
  requireObject(record, label);
  if (record.id !== expectedId) fail(`${label}.id must be ${expectedId}`, 'EDITORIAL_CANONICAL_BINDING');
  if (!['entry', 'expression'].includes(record.record_type)) {
    fail(`${label}.record_type must be entry or expression`, 'EDITORIAL_CANONICAL_BINDING');
  }
  if (record.role !== 'start') fail(`${label}.role must be start`, 'EDITORIAL_CANONICAL_BINDING');
  if (record.candidate_id !== expectedId) fail(`${label}.candidate_id must bind ${expectedId}`, 'EDITORIAL_CANONICAL_BINDING');
  if (Object.hasOwn(record, 'corrected_lemma')) {
    fail(`${label}.corrected_lemma belongs on the decision, not the canonical record`, 'EDITORIAL_CANONICAL_BINDING');
  }
  requireString(record.lemma, `${label}.lemma`);
  requireArray(record.search_forms, `${label}.search_forms`);
  if (record.search_forms.length === 0 || record.search_forms.some((form) => typeof form !== 'string' || form.trim().length === 0)) {
    fail(`${label}.search_forms must contain non-empty strings`, 'EDITORIAL_CANONICAL_BINDING');
  }
  if (record.lemma !== expectedLemma) {
    fail(`${label}.lemma must bind the catalog candidate or decision correction`, 'EDITORIAL_CANONICAL_BINDING');
  }
  const senses = requireArray(record.senses, `${label}.senses`);
  if (senses.length === 0) fail(`${label}.senses must not be empty`, 'EDITORIAL_SENSE_INCOMPLETE');
  const senseIds = new Set();
  for (const [senseIndex, sense] of senses.entries()) {
    const senseLabel = `${label}.senses[${senseIndex}]`;
    requireObject(sense, senseLabel);
    const expectedSenseId = `${expectedId}-s${senseIndex + 1}`;
    if (sense.id !== expectedSenseId) fail(`${senseLabel}.id must be ${expectedSenseId}`, 'EDITORIAL_SENSE_BINDING');
    if (senseIds.has(sense.id)) fail(`${senseLabel}.id is duplicated`, 'EDITORIAL_SENSE_BINDING');
    senseIds.add(sense.id);
    requireString(sense.pos, `${senseLabel}.pos`);
    requireString(sense.gloss, `${senseLabel}.gloss`);
    if (record.record_type === 'expression' && sense.pos !== 'expression') {
      fail(`${senseLabel}.pos must be expression for an expression record`, 'EDITORIAL_CANONICAL_BINDING');
    }
    if (record.record_type === 'entry' && sense.pos === 'expression') {
      fail(`${senseLabel}.pos cannot be expression for an entry record`, 'EDITORIAL_CANONICAL_BINDING');
    }
    if (sense.relations !== undefined && !Array.isArray(sense.relations)) {
      fail(`${senseLabel}.relations must be an array when present`, 'EDITORIAL_RELATION_BINDING');
    }
  }
  validateSharedLexicalRecord(record, {
    label,
    mode: 'canonical',
    expectedId,
    expectedLemma,
  });
  return record;
}

function validateSenseReview(review, record, label) {
  if (review.status !== 'complete') {
    fail(`${label}.status must be complete before admission`, 'EDITORIAL_SENSE_INCOMPLETE');
  }
  if (!Number.isInteger(review.observed_sense_count) || review.observed_sense_count < 1) {
    fail(`${label}.observed_sense_count must be a positive integer`, 'EDITORIAL_SENSE_INCOMPLETE');
  }
  assertJsonEqual(
    review.observed_sense_count,
    record.senses.length,
    `${label}.observed_sense_count`,
    'EDITORIAL_SENSE_MISMATCH',
  );
  const observedSenseIds = requireArray(review.observed_sense_ids, `${label}.observed_sense_ids`);
  assertJsonEqual(
    observedSenseIds,
    record.senses.map(({ id }) => id),
    `${label}.observed_sense_ids`,
    'EDITORIAL_SENSE_MISMATCH',
  );
  const observedPos = requireArray(review.observed_pos, `${label}.observed_pos`);
  assertJsonEqual(
    observedPos,
    record.senses.map(({ pos }) => pos),
    `${label}.observed_pos`,
    'EDITORIAL_SENSE_MISMATCH',
  );
  const note = requireString(review.note, `${label}.note`);
  if (observedSenseIds.some((senseId) => !note.includes(senseId))) {
    fail(`${label}.note must cite every observed sense`, 'EDITORIAL_SENSE_EVIDENCE_MISMATCH');
  }
}

function validateDecision(decision, catalogEntry, proposalRow, expectedId, importIndex) {
  const label = `decisions[${importIndex}]`;
  requireObject(decision, label);
  if (catalogEntry.inventory_id !== expectedInventoryId(importIndex)) {
    fail(`${label} catalog inventory binding is out of order`, 'EDITORIAL_SCOPE_MISMATCH');
  }
  if (decision.inventory_id !== expectedInventoryId(importIndex)) {
    fail(`${label}.inventory_id is out of catalog order`, 'EDITORIAL_SCOPE_MISMATCH');
  }
  if (!M5_11_DECISIONS.includes(decision.decision)) {
    fail(`${label}.decision is invalid`, 'EDITORIAL_DECISION_INVALID');
  }
  const candidateLemma = requireString(decision.candidate_lemma, `${label}.candidate_lemma`);
  if (candidateLemma !== proposalRow.candidate_lemma) {
    fail(`${label}.candidate_lemma does not match the frozen proposal`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  if (decision.candidate_proposal_sha256 !== proposalRow.proposal_sha256) {
    fail(`${label}.candidate_proposal_sha256 does not match the frozen proposal`, 'EDITORIAL_PROPOSAL_BINDING');
  }
  const importable = decision.decision === 'included' || decision.decision === 'corrected';
  if (importable) {
    if (decision.sense_review?.status !== 'complete') {
      fail(`${label} requires a complete sense_review before admission`, 'EDITORIAL_SENSE_INCOMPLETE');
    }
    if (decision.decision !== 'corrected' && decision.corrected_lemma !== undefined) {
      fail(`${label}.corrected_lemma is only valid for corrected decisions`, 'EDITORIAL_CANONICAL_BINDING');
    }
    const correctedLemma = decision.corrected_lemma === undefined
      ? candidateLemma
      : requireString(decision.corrected_lemma, `${label}.corrected_lemma`);
    const record = validateCanonicalRecord(
      decision.canonical_record,
      expectedId,
      `${label}.canonical_record`,
      correctedLemma,
    );
    if (decision.decision === 'included'
      && sha256Json(record) !== sha256Json(rebaseM511CandidateRecord(proposalRow.candidate_record, expectedId))) {
      fail(`${label}.canonical_record does not match the frozen proposal body`, 'EDITORIAL_PROPOSAL_BINDING');
    }
    validateBoundaryChecks(
      decision.sense_review.boundary_checks,
      record,
      decision.inventory_id,
      `${label}.sense_review`,
    );
    validateSenseReview(decision.sense_review, record, `${label}.sense_review`);
    return { decision, record };
  }

  if (decision.canonical_record !== undefined) {
    fail(`${label} cannot carry a canonical_record before admission`, 'EDITORIAL_UNREVIEWED_IMPORT');
  }
  if (decision.sense_review?.status === 'complete') {
    fail(`${label} cannot claim complete sense review without admission`, 'EDITORIAL_UNREVIEWED_IMPORT');
  }
  return { decision, record: undefined };
}

function validateSemanticReview(review, {
  decision,
  catalogEntry,
  proposalRow,
  record,
  index,
  catalogCount = 550,
} = {}) {
  const inventoryId = catalogEntry.inventory_id;
  const label = `decisions[${index}].semantic_review`;
  const proposalRecord = proposalRow.candidate_record;
  if (review.axis !== catalogEntry.axis) {
    fail(`${label}.axis must bind ${inventoryId} catalog axis`, 'EDITORIAL_SEMANTIC_BINDING');
  }
  assertJsonEqual(review.flags, catalogEntry.flags, `${label}.flags`, 'EDITORIAL_SEMANTIC_BINDING');
  const expectedRecordType = catalogEntry.flags.includes('expression-unit') ? 'expression' : 'entry';
  let sharedResult;
  try {
    sharedResult = validateLexicalSemanticReview(review, {
      decision: decision.decision,
      candidateRecord: proposalRecord,
      reviewedRecord: ['included', 'corrected'].includes(decision.decision)
        ? record
        : undefined,
      inventoryId,
      label,
      version: M5_11_AGENT_SEMANTIC_REVIEW_VERSION,
      expectedRecordType,
      catalogCount,
      // M5-11A's automated semantic pass deliberately requires every broad
      // connector to be resolved before selection.  The same shared module
      // also supplies the less restrictive, domain-aware canonical audit.
      rejectAnyBroadConnector: true,
      requireSemanticEvidence: true,
      selectionRationaleTokens: ['verification', 'coverage'],
    });
  } catch (error) {
    fail(error.message, error.code);
  }

  return {
    inventory_id: inventoryId,
    decision: decision.decision,
    axis: catalogEntry.axis,
    ...sharedResult,
    record_type: record.record_type,
  };
}

export function evaluateM511SemanticCoverage({
  semantic,
  catalog = M5_11_CATALOG,
  expectedImportedCount = 500,
} = {}) {
  requireObject(semantic, 'M5-11 semantic review summary');
  const candidateAxisCounts = Object.fromEntries(
    [...new Set(catalog.map(({ axis }) => axis))].map((axis) => [
      axis,
      catalog.filter((entry) => entry.axis === axis).length,
    ]),
  );
  const selectedAxisCounts = semantic.selected_axis_counts ?? {};
  const minimumAxisCounts = Object.fromEntries(
    Object.entries(candidateAxisCounts).map(([axis, count]) => [
      axis,
      Math.ceil(count * expectedImportedCount / catalog.length * M5_11_AGENT_MIN_AXIS_COVERAGE_RATIO),
    ]),
  );
  const axisCoverage = Object.fromEntries(
    Object.entries(minimumAxisCounts).map(([axis, minimum]) => [
      axis,
      (selectedAxisCounts[axis] ?? 0) >= minimum,
    ]),
  );
  const expressionCandidateCount = catalog.filter(({ flags }) => flags.includes('expression-unit')).length;
  const minimumExpressionCount = Math.ceil(
    expressionCandidateCount * expectedImportedCount / catalog.length * M5_11_AGENT_MIN_AXIS_COVERAGE_RATIO,
  );
  const expressionCoverage = semantic.selected_expression_unit_count >= minimumExpressionCount;
  const relationBearingAxes = M5_11_AGENT_RELATION_BEARING_AXES.filter(
    (axis) => (selectedAxisCounts[axis] ?? 0) > 0,
  );
  const selectedRelationEvidenceByAxis = semantic.selected_relation_evidence_by_axis ?? {};
  const relationCoverage = relationBearingAxes.every((axis) => {
    const evidence = selectedRelationEvidenceByAxis[axis];
    if (!evidence) return false;
    return evidence.record_count === selectedAxisCounts[axis]
      && Number.isInteger(evidence.sense_count)
      && Number.isInteger(evidence.relation_sense_count)
      && Number.isInteger(evidence.no_relation_sense_count)
      && Number.isInteger(evidence.relation_tuple_count)
      && evidence.sense_count > 0
      && evidence.relation_sense_count >= 0
      && evidence.no_relation_sense_count >= 0
      && evidence.relation_tuple_count >= 0
      && evidence.relation_sense_count + evidence.no_relation_sense_count === evidence.sense_count
      && evidence.relation_tuple_count >= evidence.relation_sense_count;
  });
  return {
    minimum_axis_counts: minimumAxisCounts,
    selected_axis_counts: selectedAxisCounts,
    axis_coverage: axisCoverage,
    axis_coverage_complete: Object.values(axisCoverage).every(Boolean),
    expression_candidate_count: expressionCandidateCount,
    minimum_expression_count: minimumExpressionCount,
    selected_expression_unit_count: semantic.selected_expression_unit_count,
    expression_coverage_complete: expressionCoverage,
    relation_bearing_axes: relationBearingAxes,
    selected_relation_axis_counts: semantic.selected_relation_axis_counts ?? {},
    selected_relation_evidence_by_axis: selectedRelationEvidenceByAxis,
    relation_coverage_complete: relationCoverage,
  };
}

function validateM511AgentSemanticReviews({
  artifact,
  catalog,
  proposalRows,
  normalized,
  expectedImportedCount,
} = {}) {
  const reviews = [];
  const ranks = [];
  let importedCount = 0;
  for (const [index, catalogEntry] of catalog.entries()) {
    const decisionResult = normalized[index];
    const record = decisionResult.record ?? proposalRows[index].candidate_record;
    const reviewResult = validateSemanticReview(artifact.decisions[index].semantic_review, {
      decision: decisionResult.decision,
      catalogEntry,
      proposalRow: proposalRows[index],
      record,
      index,
      catalogCount: catalog.length,
    });
    reviews.push(reviewResult);
    ranks.push(reviewResult.selection_rank);
    if (decisionResult.record) importedCount += 1;
  }
  const expectedRanks = Array.from({ length: catalog.length }, (_, index) => index + 1);
  assertJsonEqual(
    [...ranks].sort((left, right) => left - right),
    expectedRanks,
    'M5-11 semantic selection ranks',
    'EDITORIAL_SELECTION_BINDING',
  );
  const selectedRanks = reviews
    .filter(({ decision }) => ['included', 'corrected'].includes(decision))
    .map(({ selection_rank: rank }) => rank)
    .sort((left, right) => left - right);
  assertJsonEqual(
    selectedRanks,
    Array.from({ length: expectedImportedCount }, (_, index) => index + 1),
    'M5-11 semantic selected ranks',
    'EDITORIAL_SELECTION_BINDING',
  );
  const selected = reviews.filter(({ decision }) => ['included', 'corrected'].includes(decision));
  const selectedAxisCounts = Object.fromEntries(
    [...new Set(catalog.map(({ axis }) => axis))].map((axis) => [
      axis,
      selected.filter(({ axis: selectedAxis }) => selectedAxis === axis).length,
    ]),
  );
  const candidateAxisCounts = Object.fromEntries(
    [...new Set(catalog.map(({ axis }) => axis))].map((axis) => [
      axis,
      catalog.filter(({ axis: candidateAxis }) => candidateAxis === axis).length,
    ]),
  );
  const selectedRelationAxisCounts = Object.fromEntries(
    [...new Set(catalog.map(({ axis }) => axis))].map((axis) => [
      axis,
      selected.filter(({ axis: selectedAxis, relation_count: relationCount }) => (
        selectedAxis === axis && relationCount > 0
      )).length,
    ]),
  );
  const selectedRelationEvidenceByAxis = Object.fromEntries(
    [...new Set(catalog.map(({ axis }) => axis))].map((axis) => {
      const axisReviews = selected.filter(({ axis: selectedAxis }) => selectedAxis === axis);
      return [axis, {
        record_count: axisReviews.length,
        sense_count: axisReviews.reduce((sum, review) => sum + review.sense_count, 0),
        relation_sense_count: axisReviews.reduce((sum, review) => sum + review.relation_sense_count, 0),
        no_relation_sense_count: axisReviews.reduce((sum, review) => sum + review.no_relation_sense_count, 0),
        relation_tuple_count: axisReviews.reduce((sum, review) => sum + review.relation_count, 0),
      }];
    }),
  );
  const relationBindings = selected.flatMap(({ relation_bindings: bindings }) => bindings);
  const semantic = {
    version: M5_11_AGENT_SEMANTIC_REVIEW_VERSION,
    complete: true,
    candidate_count: catalog.length,
    selected_count: importedCount,
    broad_gloss_count: reviews.reduce((sum, review) => sum + review.broad_gloss_count, 0),
    split_record_count: reviews.filter(({ sense_count: senseCount }) => senseCount > 1).length,
    split_sense_count: reviews.reduce(
      (sum, review) => sum + (review.sense_count > 1 ? review.sense_count : 0),
      0,
    ),
    selected_axis_counts: selectedAxisCounts,
    candidate_axis_counts: candidateAxisCounts,
    selected_expression_unit_count: selected.filter(({ record_type: recordType }) => recordType === 'expression').length,
    selected_relation_axis_counts: selectedRelationAxisCounts,
    selected_relation_evidence_by_axis: selectedRelationEvidenceByAxis,
    relation_candidate_count: selected.reduce((sum, review) => sum + review.relation_count, 0),
    no_relation_rationale_count: reviews.reduce(
      (sum, review) => sum + review.no_relation_rationale_count,
      0,
    ),
    selection_rank_valid: true,
    relation_bindings: relationBindings,
  };
  return {
    semantic,
    findings: artifact.decisions.map((decision, index) => ({
      inventory_id: decision.inventory_id,
      candidate_lemma: proposalRows[index].candidate_lemma,
      decision: normalized[index].decision.decision,
      semantic_review: structuredClone(decision.semantic_review),
    })),
  };
}

export function validateM511EditorialDecisions(
  artifact,
  {
    catalog = M5_11_CATALOG,
    proposal,
    requireHumanCompletion = true,
    expectedImportedCount = 500,
  } = {},
) {
  requireObject(artifact, 'editorial decision artifact');
  if (artifact.schema_version !== '1') fail('editorial decision schema_version must be 1', 'EDITORIAL_SCHEMA_ERROR');
  if (artifact.issue !== 97 || artifact.batch_id !== M5_11_BATCH_ID) {
    fail('editorial decision artifact is not bound to M5-11 issue #97', 'EDITORIAL_SCOPE_MISMATCH');
  }
  if (artifact.catalog_sha256 !== sha256Json(catalog)) {
    fail('editorial decision artifact catalog digest drifted', 'EDITORIAL_SOURCE_MISMATCH');
  }
  if (artifact.catalog_count !== catalog.length) {
    fail('editorial decision artifact catalog count drifted', 'EDITORIAL_SOURCE_MISMATCH');
  }
  const proposalRows = validateProposalArtifact(proposal, catalog);
  try {
    // Candidate intake is always shared with later batches. Complete-base,
    // review, selection, and prospective-canonical binding are enforced by
    // lexical-production at the admission boundary once all rows are known.
    proposalRows.forEach(({ candidate_record: candidateRecord }, index) => {
      validateSharedLexicalRecord(candidateRecord, {
        label: `M5-11 candidate records[${index}]`,
        mode: 'candidate',
      });
    });
  } catch (error) {
    fail(error.message, error.code);
  }
  if (artifact.proposal_sha256 !== sha256Json(proposal)) {
    fail('editorial decision artifact proposal digest drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  if (artifact.proposal_count !== proposalRows.length) {
    fail('editorial decision artifact proposal count drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  const agentGenerated = isM511AgentGeneratedArtifact(artifact);
  if (agentGenerated) {
    validateM511AgentProvenance(artifact, 'M5-11 editorial decision artifact');
    if (artifact.editorial_review_complete !== true) {
      fail('automated editorial review must be complete before M5-11 admission', 'EDITORIAL_REVIEW_INCOMPLETE');
    }
    if (![M5_11_AGENT_GATE_DECISION, 'APPROVE BOUNDED'].includes(artifact.gate_decision)) {
      fail(
        `M5-11 automated admission requires an explicit ${M5_11_AGENT_GATE_DECISION} decision`,
        'EDITORIAL_GATE_REQUIRED',
      );
    }
  } else {
    if (requireHumanCompletion && artifact.human_editorial_review_complete !== true) {
      fail('human editorial review is required before M5-11 admission', 'EDITORIAL_HUMAN_REVIEW_REQUIRED');
    }
    if (artifact.gate_decision !== 'APPROVE BOUNDED') {
      fail('M5-11 admission requires an explicit APPROVE BOUNDED decision', 'EDITORIAL_GATE_REQUIRED');
    }
  }
  const decisions = requireArray(artifact.decisions, 'editorial decision artifact.decisions');
  if (decisions.length !== catalog.length) fail('editorial decision scope must cover the complete catalog', 'EDITORIAL_SCOPE_MISMATCH');

  const normalized = [];
  let importedCount = 0;
  const decisionCounts = Object.fromEntries(M5_11_DECISIONS.map((decision) => [decision, 0]));
  const seenInventoryIds = new Set();
  for (const [index, catalogEntry] of catalog.entries()) {
    const decisionResult = validateDecision(
      decisions[index],
      catalogEntry,
      proposalRows[index],
      expectedCanonicalId(importedCount),
      index,
    );
    if (seenInventoryIds.has(decisionResult.decision.inventory_id)) {
      fail(`duplicate inventory_id ${decisionResult.decision.inventory_id}`, 'EDITORIAL_SCOPE_MISMATCH');
    }
    seenInventoryIds.add(decisionResult.decision.inventory_id);
    decisionCounts[decisionResult.decision.decision] += 1;
    if (decisionResult.record) importedCount += 1;
    normalized.push(decisionResult);
  }
  if (importedCount !== expectedImportedCount) {
    fail(`editorial decision artifact must admit exactly ${expectedImportedCount} rows, received ${importedCount}`, 'EDITORIAL_COUNT_MISMATCH');
  }
  const totalDecisionCount = Object.values(decisionCounts).reduce((sum, count) => sum + count, 0);
  if (totalDecisionCount !== catalog.length) {
    fail('editorial decision artifact decision counts do not cover the catalog', 'EDITORIAL_COUNT_MISMATCH');
  }
  const expectedDeferredCount = catalog.length - importedCount - decisionCounts.held - decisionCounts.rejected;
  if (decisionCounts.deferred !== expectedDeferredCount) {
    fail(
      `editorial decision artifact deferred count must equal the unused reserve remainder (${expectedDeferredCount})`,
      'EDITORIAL_COUNT_MISMATCH',
    );
  }
  const semanticResult = agentGenerated
    ? validateM511AgentSemanticReviews({
      artifact,
      catalog,
      proposalRows,
      normalized,
      expectedImportedCount,
    })
    : undefined;
  const semantic = semanticResult?.semantic;
  return {
    artifact,
    decisions: normalized,
    proposalRows,
    importedRecords: normalized.filter(({ record }) => record).map(({ record }) => record),
    decisionCounts,
    ...(semantic ? { semantic, semantic_findings: semanticResult.findings } : {}),
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { M5_11_CATALOG } from './m5-11-catalog.mjs';

export const M5_11_BATCH_ID = 'm5-11-expansion-20260913';
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
    requireArray(candidateRecord.senses, `${label}.candidate_record.senses`);
    if (candidateRecord.lemma !== candidateLemma) {
      fail(`${label}.candidate_record.lemma must match candidate_lemma`, 'EDITORIAL_PROPOSAL_BINDING');
    }
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

function rebaseProposalRecord(candidateRecord, expectedId) {
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
    if (sense.relations !== undefined && !Array.isArray(sense.relations)) {
      fail(`${senseLabel}.relations must be an array when present`, 'EDITORIAL_RELATION_BINDING');
    }
  }
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
      && sha256Json(record) !== sha256Json(rebaseProposalRecord(proposalRow.candidate_record, expectedId))) {
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
  if (artifact.proposal_sha256 !== sha256Json(proposal)) {
    fail('editorial decision artifact proposal digest drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  if (artifact.proposal_count !== proposalRows.length) {
    fail('editorial decision artifact proposal count drifted', 'EDITORIAL_PROPOSAL_SOURCE_MISMATCH');
  }
  if (requireHumanCompletion && artifact.human_editorial_review_complete !== true) {
    fail('human editorial review is required before M5-11 admission', 'EDITORIAL_HUMAN_REVIEW_REQUIRED');
  }
  if (artifact.gate_decision !== 'APPROVE BOUNDED') {
    fail('M5-11 admission requires an explicit APPROVE BOUNDED decision', 'EDITORIAL_GATE_REQUIRED');
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
  return {
    artifact,
    decisions: normalized,
    importedRecords: normalized.filter(({ record }) => record).map(({ record }) => record),
    decisionCounts,
  };
}

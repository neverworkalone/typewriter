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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function expectedInventoryId(index) {
  return `m5-${String(535 + index).padStart(3, '0')}`;
}

export function expectedCanonicalId(importIndex) {
  return `w${String(779 + importIndex).padStart(3, '0')}`;
}

function validateBoundaryChecks(checks, record, label) {
  requireObject(checks, `${label}.boundary_checks`);
  assert.deepEqual(
    Object.keys(checks).sort(),
    [...M5_11_BOUNDARY_IDS].sort(),
    `${label}.boundary_checks keys`,
  );
  for (const boundaryId of M5_11_BOUNDARY_IDS) {
    const check = requireObject(checks[boundaryId], `${label}.${boundaryId}`);
    if (!['checked', 'not-applicable'].includes(check.status)) {
      fail(`${label}.${boundaryId}.status must be checked or not-applicable`, 'EDITORIAL_BOUNDARY_INCOMPLETE');
    }
    requireString(check.rationale, `${label}.${boundaryId}.rationale`);
    requireString(check.contrast, `${label}.${boundaryId}.contrast`);
    requireArray(check.sense_ids, `${label}.${boundaryId}.sense_ids`);
    for (const senseId of check.sense_ids) {
      requireString(senseId, `${label}.${boundaryId}.sense_ids entry`);
      if (!record.senses.some(({ id }) => id === senseId)) {
        fail(`${label}.${boundaryId} references unknown sense ${senseId}`, 'EDITORIAL_BOUNDARY_BINDING');
      }
    }
  }
}

function validateCanonicalRecord(record, catalogEntry, expectedId, label, expectedLemma = catalogEntry.lemma) {
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
  if (catalogEntry.flags?.includes('mixed-sense-review') && senses.length < 2) {
    fail(`${label}.senses must preserve the mixed-sense candidate boundary`, 'EDITORIAL_MIXED_SENSE_COLLAPSE');
  }
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

function validateDecision(decision, catalogEntry, expectedId, importIndex) {
  const label = `decisions[${importIndex}]`;
  requireObject(decision, label);
  if (decision.inventory_id !== expectedInventoryId(importIndex)) {
    fail(`${label}.inventory_id is out of catalog order`, 'EDITORIAL_SCOPE_MISMATCH');
  }
  if (!M5_11_DECISIONS.includes(decision.decision)) {
    fail(`${label}.decision is invalid`, 'EDITORIAL_DECISION_INVALID');
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
      ? catalogEntry.lemma
      : requireString(decision.corrected_lemma, `${label}.corrected_lemma`);
    const record = validateCanonicalRecord(
      decision.canonical_record,
      catalogEntry,
      expectedId,
      `${label}.canonical_record`,
      correctedLemma,
    );
    validateBoundaryChecks(decision.sense_review.boundary_checks, record, `${label}.sense_review`);
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
    requireHumanCompletion = true,
    expectedImportedCount = 500,
    expectedDeferredCount = 50,
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
  const seenInventoryIds = new Set();
  for (const [index, catalogEntry] of catalog.entries()) {
    const decisionResult = validateDecision(
      decisions[index],
      catalogEntry,
      expectedCanonicalId(importedCount),
      index,
    );
    if (seenInventoryIds.has(decisionResult.decision.inventory_id)) {
      fail(`duplicate inventory_id ${decisionResult.decision.inventory_id}`, 'EDITORIAL_SCOPE_MISMATCH');
    }
    seenInventoryIds.add(decisionResult.decision.inventory_id);
    if (decisionResult.record) importedCount += 1;
    normalized.push(decisionResult);
  }
  if (importedCount !== expectedImportedCount) {
    fail(`editorial decision artifact must admit exactly ${expectedImportedCount} rows, received ${importedCount}`, 'EDITORIAL_COUNT_MISMATCH');
  }
  if (decisions.filter(({ decision }) => decision === 'deferred').length !== expectedDeferredCount) {
    fail(`editorial decision artifact must defer exactly ${expectedDeferredCount} reserve rows`, 'EDITORIAL_COUNT_MISMATCH');
  }
  return {
    artifact,
    decisions: normalized,
    importedRecords: normalized.filter(({ record }) => record).map(({ record }) => record),
  };
}

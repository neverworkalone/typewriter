import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
  assertExternalStagingPath,
  validateBatch,
  validateBatchManifest,
} from './validate-batch.mjs';
import { createMetricsArtifact, assertMetricsMatch } from './derive-metrics.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import { evaluateExpansionGate, hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';

const require = createRequire(import.meta.url);
const EDITORIAL_DECISIONS_SCHEMA = require('../../schema/m5-10-wave-b-editorial-decisions.schema.json');
const AUDIT_DECISIONS_SCHEMA = require('../../schema/m5-10-wave-b-audit-decisions.schema.json');
const SEMANTIC_REGRESSION_SCHEMA = require('../../schema/m5-10-wave-b-semantic-regressions.schema.json');
const schemaOptions = {
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
};
const editorialDecisionsSchemaValidator = new Ajv2020(schemaOptions).compile(EDITORIAL_DECISIONS_SCHEMA);
const auditDecisionsSchemaValidator = new Ajv2020(schemaOptions).compile(AUDIT_DECISIONS_SCHEMA);
const semanticRegressionSchemaValidator = new Ajv2020(schemaOptions).compile(SEMANTIC_REGRESSION_SCHEMA);

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');

export const WAVE_B_BATCH_ID = 'm5-10-wave-b-20260909';
export const WAVE_B_STAGE_ID = 'm5-10-wave-b-plus-150';
export const WAVE_B_INVENTORY_ID = 'm5-core-5k';
export const WAVE_B_INVENTORY_REVISION = 'm5-11';
export const WAVE_B_BASE_START_COUNT = 628;
export const WAVE_B_IMPORTED_START_COUNT = 150;
export const WAVE_B_CUMULATIVE_START_COUNT = 778;
export const WAVE_B_SELECTED_START_COUNT = 170;
export const WAVE_B_PROCESSED_START_COUNT = 160;
export const WAVE_B_BUFFER_COUNT = 20;
export const WAVE_B_TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);
export const WAVE_B_AUDIT_TIMING_PASS_IDS = Object.freeze(['post-freeze-audit']);
export const WAVE_B_IMPORT_INVENTORY_IDS = Object.freeze(
  Array.from({ length: WAVE_B_IMPORTED_START_COUNT }, (_, index) => `m5-${index + 365}`),
);
export const WAVE_B_BUFFER_INVENTORY_IDS = Object.freeze(
  Array.from({ length: WAVE_B_BUFFER_COUNT }, (_, index) => `m5-${index + 515}`),
);
export const WAVE_B_SELECTED_INVENTORY_IDS = Object.freeze([
  ...WAVE_B_IMPORT_INVENTORY_IDS,
  ...WAVE_B_BUFFER_INVENTORY_IDS,
]);
export const WAVE_B_IMPORTED_CANONICAL_IDS = Object.freeze(
  Array.from({ length: WAVE_B_IMPORTED_START_COUNT }, (_, index) => `w${String(index + 629).padStart(3, '0')}`),
);
export const WAVE_B_PROPOSAL_CANONICAL_IDS = Object.freeze(
  Array.from({ length: WAVE_B_SELECTED_START_COUNT }, (_, index) => `w${String(index + 629).padStart(3, '0')}`),
);

export const DEFAULT_OUTPUT_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b.json');
export const DEFAULT_EDITORIAL_INPUT_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-editorial-input.json');
export const DEFAULT_AUDIT_INPUT_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-audit-input.json');
export const DEFAULT_TIMING_INPUT_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-timing-input.json');
export const DEFAULT_AUDIT_TIMING_INPUT_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-audit-timing-input.json');
export const DEFAULT_RELATION_DIFF_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-relation-diff.json');
export const DEFAULT_METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-metrics.json');
export const DEFAULT_STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json');
export const DEFAULT_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-verification.json');
export const DEFAULT_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-preimport-inventory.json');
export const DEFAULT_BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-base-canonical');
export const DEFAULT_PLAN_PATH = path.join(BATCH_DIRECTORY, 'm5-8-expansion-plan.json');
export const DEFAULT_AUTHORIZATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-authorization.json');
export const DEFAULT_SEMANTIC_REGRESSION_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-semantic-regressions.json');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECISIONS = Object.freeze(['included', 'corrected', 'held', 'rejected', 'deferred']);

export class WaveBValidationError extends Error {
  constructor(message, code = 'M5_10_WAVE_B_VALIDATION_ERROR') {
    super(message);
    this.name = 'WaveBValidationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new WaveBValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'MISMATCH') {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest`, 'INVALID_DIGEST');
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${label} must be a UUID v4`, 'INVALID_SESSION_ID');
}

function requireIsoDate(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, 'INVALID_TIMESTAMP');
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveArtifactPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(REPOSITORY_DIRECTORY, filePath);
}

function validateTimingArtifact(artifact, label, { pathOverride } = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail(`${label} must be an artifact reference`, 'TIMING_ARTIFACT_MISSING');
  requireString(artifact.path, `${label}.path`);
  requireSha256(artifact.sha256, `${label}.sha256`);
  if (pathOverride !== undefined) requireString(pathOverride, `${label} runtime path`);
  const artifactPath = pathOverride ?? artifact.path;
  let bytes;
  try {
    bytes = readFileSync(resolveArtifactPath(artifactPath));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${artifactPath}`, 'TIMING_ARTIFACT_MISSING');
    throw error;
  }
  assertEqual(sha256Bytes(bytes), artifact.sha256, `${label}.sha256 was not computed from the artifact bytes`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  return artifact;
}

export function createWaveBTimingProof(timing) {
  const copy = structuredClone(timing);
  delete copy.recording_proof_sha256;
  return sha256Bytes(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function readTimingWorkLog(artifact, label) {
  const validated = validateTimingArtifact(artifact, label);
  const bytes = readFileSync(resolveArtifactPath(artifact.path));
  if (bytes.length > 0 && bytes.at(-1) !== 10) fail(`${label} must be newline-terminated JSONL`, 'TIMING_WORK_LOG_INVALID');
  const rows = bytes.length === 0
    ? []
    : bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`${label} line ${index + 1} is not valid JSON: ${error.message}`, 'TIMING_WORK_LOG_INVALID');
      }
    });
  return { artifact: validated, bytes, rows };
}

function workRowsForPass(timing, passId) {
  const pass = timing.passes.find(({ id }) => id === passId);
  if (!pass) fail(`${passId} is missing from the timing input`, 'TIMING_SCOPE_MISMATCH');
  return readTimingWorkLog(pass.work_evidence.output_artifact, `${passId} output work log`).rows
    .filter((row) => row.kind === 'work' && row.pass_id === passId && row.session_id === pass.session_id);
}

export function validateWaveBTimingDecisionWork({ timingInput, auditTimingInput = timingInput, editorialInput, auditInput } = {}) {
  if (!timingInput || !editorialInput) return { verified: false };
  const importedRecords = editorialInput.records.slice(0, WAVE_B_IMPORTED_START_COUNT);
  const bufferRecords = editorialInput.records.slice(WAVE_B_IMPORTED_START_COUNT);
  const initialRows = workRowsForPass(timingInput, 'initial-review');
  const expectedBoundaryRows = importedRecords.flatMap((recordReview) => M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => {
    const evidence = recordReview.boundary_evidence[boundaryId];
    return {
      inventory_id: recordReview.inventory_id,
      proposal_canonical_id: recordReview.proposal_canonical_id,
      boundary_id: boundaryId,
      applicability: evidence.applicability,
      decision: evidence.decision,
      candidate_sense_ids: evidence.candidate_sense_ids,
      contrasts: evidence.contrasts,
      rationale: evidence.rationale,
    };
  }));
  assertEqual(initialRows.map(({ unit_id: unitId }) => unitId), expectedBoundaryRows.map(({ inventory_id: inventoryId, boundary_id: boundaryId }) => `${inventoryId}:${boundaryId}`), 'timed boundary work scope drifted', 'TIMING_DECISION_BINDING');
  assertEqual(initialRows.map(({ payload }) => payload), expectedBoundaryRows, 'timed boundary work does not match editorial evidence', 'TIMING_DECISION_BINDING');

  const finalRows = workRowsForPass(timingInput, 'final-audit');
  assertEqual(finalRows.map(({ unit_id: unitId }) => unitId), importedRecords.map(({ canonical_id: canonicalId }) => canonicalId), 'timed final decision scope drifted', 'TIMING_DECISION_BINDING');
  assertEqual(finalRows.map(({ payload }) => payload.record_review), importedRecords, 'timed final decision work does not match editorial records', 'TIMING_DECISION_BINDING');
  const bufferRows = workRowsForPass(timingInput, 'held-rejected');
  assertEqual(bufferRows.map(({ unit_id: unitId }) => unitId), bufferRecords.map(({ inventory_id: inventoryId }) => inventoryId), 'timed buffer decision scope drifted', 'TIMING_DECISION_BINDING');
  assertEqual(bufferRows.map(({ payload }) => payload.record_review), bufferRecords, 'timed buffer decision work does not match editorial records', 'TIMING_DECISION_BINDING');

  if (auditInput) {
    const auditRows = workRowsForPass(auditTimingInput, 'post-freeze-audit');
    const timingSnapshotRows = auditRows.filter(({ unit_id: unitId }) => unitId === 'wave-b-timing-completeness');
    assertEqual(timingSnapshotRows.length, 1, 'timed audit work must include one complete decision snapshot', 'TIMING_AUDIT_BINDING');
    assertEqual(timingSnapshotRows[0].payload.coverage, auditInput.coverage, 'timed audit coverage snapshot drifted', 'TIMING_AUDIT_BINDING');
    assertEqual(timingSnapshotRows[0].payload.findings, auditInput.findings, 'timed audit findings snapshot drifted', 'TIMING_AUDIT_BINDING');
    for (const row of auditRows) {
      assertEqual(row.payload.audit_id, auditInput.audit_id, `${row.unit_id} timed audit work audit binding drifted`, 'TIMING_AUDIT_BINDING');
      assertEqual(row.payload.unit_id, row.unit_id, `${row.unit_id} timed audit work unit binding drifted`, 'TIMING_AUDIT_BINDING');
      assertEqual(row.payload.status, 'verified', `${row.unit_id} timed audit work is not verified`, 'TIMING_AUDIT_BINDING');
    }
  }
  return { verified: true, boundaryCount: initialRows.length, finalDecisionCount: finalRows.length, bufferDecisionCount: bufferRows.length };
}

export function deriveWaveBTimingUnitSets({ editorialInput, auditInput } = {}) {
  if (!editorialInput || !auditInput) return undefined;
  const selectedRecords = editorialInput.records ?? [];
  const importedRecords = selectedRecords.slice(0, WAVE_B_IMPORTED_START_COUNT);
  const bufferRecords = selectedRecords.slice(WAVE_B_IMPORTED_START_COUNT);
  const boundaryIds = editorialInput.sense_review?.boundary_ids ?? M5_10A_SENSE_BOUNDARY_IDS;
  const auditWorkUnitIds = auditInput.coverage?.audit_work_unit_ids;
  if (!Array.isArray(auditWorkUnitIds)) return undefined;
  return {
    'target-preparation': selectedRecords.map(({ inventory_id: inventoryId }) => inventoryId),
    'initial-review': importedRecords.flatMap(({ inventory_id: inventoryId }) => boundaryIds.map((boundaryId) => `${inventoryId}:${boundaryId}`)),
    'feedback-fixes': importedRecords.map(({ canonical_id: canonicalId }) => canonicalId),
    'final-audit': importedRecords.map(({ canonical_id: canonicalId }) => canonicalId),
    'held-rejected': bufferRecords.map(({ inventory_id: inventoryId }) => inventoryId),
    'post-freeze-audit': [...auditWorkUnitIds],
  };
}

function exactIds(actual, expected, label) {
  assertEqual(actual, expected, `${label} coverage drifted`, 'COVERAGE_MISMATCH');
  if (new Set(actual).size !== actual.length) fail(`${label} contains duplicate IDs`, 'DUPLICATE_ID');
}

function validateDecisionSchema(value, validator, label) {
  if (validator(value)) return;
  const error = validator.errors?.[0];
  fail(
    error ? `${label} schema validation failed at ${error.instancePath} ${error.message}` : `${label} schema validation failed`,
    'SCHEMA_ERROR',
  );
}

function recordOf(recordInfo) {
  return recordInfo.record ?? recordInfo;
}

function recordsById(recordInfos) {
  return new Map(recordInfos.map((recordInfo) => {
    const record = recordOf(recordInfo);
    return [record.id, record];
  }));
}

function inventoryById(entries) {
  return new Map(entries.map((entry) => [entry.inventory_id ?? entry.id, entry]));
}

const BOUNDARY_DIMENSIONS = Object.freeze({
  'physical-figurative': new Set(['physical', 'figurative', 'usage']),
  'homonym-pos': new Set(['homonym', 'pos', 'usage']),
  'sensory-emotion-state-action': new Set(['sensory', 'emotion', 'state', 'action']),
  'directional-symmetry': new Set(['direction', 'symmetry', 'argument']),
  'compound-spaced-phrase': new Set(['compound', 'spacing', 'form']),
  'word-idiom': new Set(['word', 'idiom', 'usage']),
});

function stripEvidenceIdentifiers(text, {
  inventoryId,
  canonicalId,
  lemma,
  boundaryId,
  senseIds = [],
  glosses = [],
} = {}) {
  let normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  for (const token of [inventoryId, canonicalId, lemma, boundaryId, ...senseIds, ...glosses]
    .filter((token) => typeof token === 'string' && token.length > 0)
    .sort((left, right) => right.length - left.length)) {
    normalized = normalized.replaceAll(token, ' ');
  }
  return normalized.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();
}

function validateContrast(contrast, canonicalRecord, boundaryId, label) {
  if (!contrast || typeof contrast !== 'object' || Array.isArray(contrast)) fail(`${label} contrast must be an object`, 'INVALID_BOUNDARY_CONTRAST');
  const senseIds = new Set(canonicalRecord.senses.map(({ id }) => id));
  for (const side of ['left_sense_id', 'right_sense_id']) {
    if (!senseIds.has(contrast[side])) fail(`${label} contrast cites an unknown ${side}`, 'CONTRAST_SENSE_MISMATCH');
  }
  if (contrast.left_sense_id === contrast.right_sense_id) fail(`${label} contrast must compare two senses`, 'CONTRAST_SENSE_MISMATCH');
  if (!BOUNDARY_DIMENSIONS[boundaryId]?.has(contrast.dimension)) fail(`${label} contrast dimension is invalid for ${boundaryId}`, 'CONTRAST_DIMENSION_MISMATCH');
  if (!Array.isArray(contrast.facets) || contrast.facets.length === 0) fail(`${label} contrast.facets must contain an actual distinction`, 'CONTRAST_FACETS_REQUIRED');
  for (const field of ['left_observation', 'right_observation', 'difference']) requireString(contrast[field], `${label} contrast.${field}`);
  if (contrast.left_observation === contrast.right_observation) fail(`${label} contrast observations must differ`, 'GENERIC_EDITORIAL_EVIDENCE');
  if (contrast.difference.length < 12) fail(`${label} contrast.difference is too generic`, 'GENERIC_EDITORIAL_EVIDENCE');
  return contrast;
}

function validateBoundaryEvidence(evidence, inventoryId, proposalId, senseIds, canonicalRecord, boundaryId, label) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail(`${label} must be an object`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.review_status, 'reviewed', `${label}.review_status must be reviewed`, 'UNREVIEWED_BOUNDARY');
  if (!['applicable', 'not-applicable'].includes(evidence.applicability)) fail(`${label}.applicability is invalid`, 'INVALID_BOUNDARY_EVIDENCE');
  if (!['keep', 'split'].includes(evidence.decision)) fail(`${label}.decision is invalid`, 'INVALID_BOUNDARY_DECISION');
  assertEqual(evidence.candidate_sense_ids, senseIds, `${label}.candidate_sense_ids drifted`, 'BOUNDARY_SENSE_MISMATCH');
  if (!Array.isArray(evidence.contrasts)) fail(`${label}.contrasts must be an array`, 'INVALID_BOUNDARY_CONTRAST');
  if (evidence.applicability === 'not-applicable') {
    assertEqual(evidence.decision, 'keep', `${label}.not-applicable boundary must keep the candidate senses`, 'INVALID_BOUNDARY_DECISION');
    assertEqual(evidence.contrasts, [], `${label}.not-applicable boundary must not carry contrasts`, 'UNEXPECTED_BOUNDARY_CONTRAST');
  } else if (evidence.decision === 'split' && evidence.contrasts.length === 0) {
    fail(`${label}.applicable split boundary must include an actual contrast`, 'BOUNDARY_CONTRAST_REQUIRED');
  } else if (canonicalRecord.senses.length > 1 && evidence.contrasts.length === 0) {
    fail(`${label}.applicable multi-sense boundary must include an actual contrast`, 'BOUNDARY_CONTRAST_REQUIRED');
  }
  for (const [contrastIndex, contrast] of evidence.contrasts.entries()) {
    validateContrast(contrast, canonicalRecord, boundaryId, `${label}.contrasts[${contrastIndex}]`);
  }
  requireString(evidence.rationale, `${label}.rationale`);
  for (const token of [inventoryId, proposalId, ...senseIds]) {
    if (!evidence.rationale.includes(token)) fail(`${label}.rationale must cite ${token}`, 'BOUNDARY_EVIDENCE_MISMATCH');
  }
}

function validateUnreviewedBoundaryEvidence(evidence, inventoryId, proposalId, label) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail(`${label} must be an object`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.review_status, 'unreviewed', `${label}.review_status must be unreviewed`, 'UNEXPECTED_BOUNDARY_REVIEW');
  assertEqual(evidence.applicability, 'unknown', `${label}.applicability must be unknown`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.decision, 'pending', `${label}.decision must be pending`, 'INVALID_BOUNDARY_DECISION');
  assertEqual(evidence.candidate_sense_ids, [], `${label}.candidate_sense_ids must be empty`, 'BOUNDARY_SENSE_MISMATCH');
  assertEqual(evidence.contrasts, [], `${label}.contrasts must be an explicit empty array`, 'UNEXPECTED_BOUNDARY_CONTRAST');
  requireString(evidence.rationale, `${label}.rationale`);
  for (const token of [inventoryId, proposalId]) {
    if (!evidence.rationale.includes(token)) fail(`${label}.rationale must cite ${token}`, 'BOUNDARY_EVIDENCE_MISMATCH');
  }
}

function validateRecordReview(recordReview, index, inventoryEntries, referenceById, semanticCasesByCanonicalId) {
  const expectedInventoryId = WAVE_B_SELECTED_INVENTORY_IDS[index];
  assertEqual(recordReview.inventory_id, expectedInventoryId, `editorial record ${index} inventory scope drifted`, 'EDITORIAL_SCOPE_MISMATCH');
  const imported = index < WAVE_B_IMPORTED_START_COUNT;
  const expectedProposalId = WAVE_B_PROPOSAL_CANONICAL_IDS[index];
  const semanticCase = semanticCasesByCanonicalId.get(expectedProposalId);
  const reviewed = index < WAVE_B_IMPORTED_START_COUNT;
  const reference = referenceById.get(expectedProposalId);
  if (reviewed && !reference) fail(`${expectedProposalId} is missing from Wave B reference records`, 'MISSING_REFERENCE_RECORD');
  const expectedDecision = imported
    ? ((semanticCase?.scope === 'wave-b-proposal' && semanticCase.required_decision === 'split')
      || reference?.senses.length > 1 ? 'corrected' : 'included')
    : index < 160 ? 'held' : 'deferred';
  assertEqual(recordReview.proposal_canonical_id, expectedProposalId, `${expectedInventoryId} proposal canonical ID drifted`, 'PROPOSAL_SCOPE_MISMATCH');
  assertEqual(recordReview.decision, expectedDecision, `${expectedInventoryId} decision drifted`, 'EDITORIAL_DECISION_MISMATCH');
  if (imported) assertEqual(recordReview.canonical_id, expectedProposalId, `${expectedInventoryId} canonical ID drifted`, 'CANONICAL_SCOPE_MISMATCH');
  else if (Object.hasOwn(recordReview, 'canonical_id')) fail(`${expectedInventoryId} buffer decision must not carry canonical_id`, 'BUFFER_CANONICAL_LEAK');
  const inventoryEntry = inventoryEntries.get(expectedInventoryId);
  if (!inventoryEntry) fail(`${expectedInventoryId} is missing from target inventory`, 'MISSING_INVENTORY_TARGET');
  const expectedLemma = reference?.lemma ?? inventoryEntry.lemma;
  const expectedPos = reviewed
    ? reference?.senses?.map(({ pos }) => pos) ?? inventoryEntry.pos
    : [];
  const expectedSenseIds = reviewed ? reference.senses.map(({ id }) => id) : [];
  assertEqual(recordReview.observed_sense_count, reviewed ? expectedSenseIds.length : 0, `${expectedInventoryId} sense review scope drifted`, 'SENSE_SCOPE_MISMATCH');
  assertEqual(recordReview.observed_pos, expectedPos, `${expectedInventoryId} observed POS drifted`, 'POS_SCOPE_MISMATCH');
  requireString(recordReview.decision_note, `${expectedInventoryId}.decision_note`);
  for (const token of [expectedInventoryId, expectedProposalId, expectedLemma]) {
    if (!recordReview.decision_note.includes(token)) fail(`${expectedInventoryId}.decision_note must cite ${token}`, 'DECISION_EVIDENCE_MISMATCH');
  }
  assertEqual(
    Object.keys(recordReview.boundary_evidence).sort(),
    [...M5_10A_SENSE_BOUNDARY_IDS].sort(),
    `${expectedInventoryId} boundary evidence scope drifted`,
    'BOUNDARY_SCOPE_MISMATCH',
  );
  if (reviewed && recordReview.decision === 'corrected') {
    assertEqual(recordReview.corrected_fields, ['senses'], `${expectedInventoryId}.corrected_fields must identify the sense correction`, 'CORRECTION_FIELD_MISMATCH');
  } else if (reviewed && Object.hasOwn(recordReview, 'corrected_fields')) {
    fail(`${expectedInventoryId} included record must not carry corrected_fields`, 'CORRECTION_FIELD_MISMATCH');
  }
  const rationaleFingerprints = new Set();
  let applicableBoundaryCount = 0;
  let notApplicableBoundaryCount = 0;
  let contrastCount = 0;
  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    const label = `${expectedInventoryId}.boundary_evidence.${boundaryId}`;
    if (reviewed) {
      const evidence = recordReview.boundary_evidence[boundaryId];
      validateBoundaryEvidence(evidence, expectedInventoryId, expectedProposalId, expectedSenseIds, reference, boundaryId, label);
      if (evidence.applicability === 'applicable') applicableBoundaryCount += 1;
      else notApplicableBoundaryCount += 1;
      contrastCount += evidence.contrasts.length;
      const fingerprint = stripEvidenceIdentifiers(evidence.rationale, {
        inventoryId: expectedInventoryId,
        canonicalId: expectedProposalId,
        lemma: expectedLemma,
        boundaryId,
        senseIds: expectedSenseIds,
        glosses: reference.senses.map(({ gloss }) => gloss),
      });
      if (rationaleFingerprints.has(fingerprint)) fail(`${label}.rationale reuses normalized evidence from another boundary`, 'GENERIC_EDITORIAL_EVIDENCE');
      rationaleFingerprints.add(fingerprint);
    } else {
      validateUnreviewedBoundaryEvidence(recordReview.boundary_evidence[boundaryId], expectedInventoryId, expectedProposalId, label);
    }
  }
  if (reviewed && (notApplicableBoundaryCount === 0 || (applicableBoundaryCount === M5_10A_SENSE_BOUNDARY_IDS.length && contrastCount === 0))) {
    fail(`${expectedInventoryId} uses blanket applicable boundary evidence without a record-specific contrast`, 'GENERIC_EDITORIAL_EVIDENCE');
  }
  if (reviewed && contrastCount === 0 && rationaleFingerprints.size <= 1) {
    fail(`${expectedInventoryId} uses one normalized rationale for every empty boundary result`, 'GENERIC_EDITORIAL_EVIDENCE');
  }
  if (reviewed && reference.senses.length > 1 && applicableBoundaryCount === 0) {
    fail(`${expectedInventoryId} multi-sense review must identify an applicable boundary`, 'BOUNDARY_APPLICABILITY_MISSING');
  }
  if (reviewed && reference.senses.length > 1) {
    if (recordReview.decision === 'included') {
      fail(`${expectedInventoryId} has multiple candidate senses and cannot be accepted as one included sense`, 'SEMANTIC_SINGLE_SENSE_ACCEPTED');
    }
    const expectedPairs = new Set(allContrastPairs(expectedSenseIds));
    const actualPairs = new Set(
      Object.values(recordReview.boundary_evidence)
        .flatMap(({ contrasts }) => contrasts)
        .map(({ left_sense_id: left, right_sense_id: right }) => contrastPairKey(left, right)),
    );
    assertEqual(actualPairs, expectedPairs, `${expectedInventoryId} multi-sense evidence must cover every candidate distinction`, 'BOUNDARY_CONTRAST_COVERAGE');
  }
}

function readSemanticRegressionCorpus() {
  let corpus;
  try {
    corpus = JSON.parse(readFileSync(DEFAULT_SEMANTIC_REGRESSION_PATH, 'utf8'));
  } catch (error) {
    fail(`semantic regression corpus cannot be read: ${error.message}`, 'SEMANTIC_CORPUS_MISSING');
  }
  validateDecisionSchema(corpus, semanticRegressionSchemaValidator, 'Wave B semantic regression corpus');
  return corpus;
}

function semanticCaseMap(corpus) {
  return new Map(corpus.cases.map((semanticCase) => [semanticCase.canonical_id, semanticCase]));
}

function contrastPairKey(left, right) {
  return [left, right].sort().join('|');
}

function allContrastPairs(senseIds) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < senseIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < senseIds.length; rightIndex += 1) {
      pairs.push(contrastPairKey(senseIds[leftIndex], senseIds[rightIndex]));
    }
  }
  return pairs;
}

function validateSemanticCaseShape(semanticCase) {
  const label = `semantic regression ${semanticCase.case_id}`;
  const candidateIds = semanticCase.candidate_senses.map(({ id }) => id);
  assertEqual(candidateIds, semanticCase.expected_sense_ids, `${label} candidate sense IDs drifted`, 'SEMANTIC_CASE_CONTRACT');
  assertEqual(candidateIds.length, semanticCase.expected_sense_count, `${label} candidate sense count drifted`, 'SEMANTIC_CASE_CONTRACT');
  assertEqual(semanticCase.candidate_senses.map(({ pos }) => pos), semanticCase.expected_pos, `${label} candidate POS drifted`, 'SEMANTIC_CASE_CONTRACT');
  assertEqual(semanticCase.candidate_senses.map(({ gloss }) => gloss), semanticCase.expected_glosses, `${label} candidate glosses drifted`, 'SEMANTIC_CASE_CONTRACT');
  assertEqual(semanticCase.source_evidence.candidate_sense_ids, candidateIds, `${label} source evidence candidate IDs drifted`, 'SEMANTIC_CASE_CONTRACT');
  if (!semanticCase.source_evidence.note.includes(semanticCase.case_id)) fail(`${label} source evidence must identify its case`, 'SEMANTIC_CASE_CONTRACT');
  const expectedPairs = new Set(allContrastPairs(candidateIds));
  const declaredPairs = new Set(semanticCase.contrast_pairs.map(([left, right]) => contrastPairKey(left, right)));
  if (candidateIds.length > 1) {
    assertEqual(semanticCase.required_applicability, 'applicable', `${label} multi-candidate evidence must be applicable`, 'SEMANTIC_CASE_CONTRACT');
    assertEqual(semanticCase.required_decision, 'split', `${label} multi-candidate evidence must split`, 'SEMANTIC_CASE_CONTRACT');
    assertEqual(declaredPairs, expectedPairs, `${label} contrast pairs do not cover every candidate distinction`, 'SEMANTIC_CASE_CONTRACT');
  } else if (semanticCase.required_decision === 'split') {
    fail(`${label} cannot split a single candidate sense`, 'SEMANTIC_CASE_CONTRACT');
  }
}

export function validateWaveBSemanticRegression({ corpus = readSemanticRegressionCorpus(), referenceRecords = [], editorialRecords = [] } = {}) {
  validateDecisionSchema(corpus, semanticRegressionSchemaValidator, 'Wave B semantic regression corpus');
  for (const category of ['homonym', 'pos', 'polysemy', 'space-phrase']) {
    if (!corpus.categories.includes(category)) fail(`semantic regression corpus is missing the ${category} category`, 'SEMANTIC_CORPUS_COVERAGE');
  }
  const caseIds = corpus.cases.map(({ case_id: caseId }) => caseId);
  if (new Set(caseIds).size !== caseIds.length) fail('semantic regression corpus contains duplicate case IDs', 'SEMANTIC_CORPUS_COVERAGE');
  const canonicalIds = corpus.cases.map(({ canonical_id: canonicalId }) => canonicalId);
  if (new Set(canonicalIds).size !== canonicalIds.length) fail('semantic regression corpus contains duplicate target IDs', 'SEMANTIC_CORPUS_COVERAGE');
  for (const category of ['homonym', 'pos', 'polysemy', 'space-phrase']) {
    if (!corpus.cases.some((semanticCase) => semanticCase.scope === 'synthetic-regression' && semanticCase.case_type === category)) {
      fail(`semantic regression corpus is missing a synthetic ${category} case`, 'SEMANTIC_CORPUS_COVERAGE');
    }
  }
  const referenceById = recordsById(referenceRecords);
  const reviewByInventoryId = new Map(editorialRecords.map((recordReview) => [recordReview.inventory_id, recordReview]));
  for (const semanticCase of corpus.cases) {
    const label = `semantic regression ${semanticCase.case_id}`;
    validateSemanticCaseShape(semanticCase);
    if (semanticCase.scope === 'synthetic-regression') {
      if (!semanticCase.canonical_id.startsWith('synthetic-')) fail(`${label} synthetic target must use a synthetic ID`, 'SEMANTIC_CORPUS_COVERAGE');
      continue;
    }
    if (semanticCase.canonical_id.startsWith('synthetic-')) fail(`${label} production regression target cannot use a synthetic ID`, 'SEMANTIC_CORPUS_COVERAGE');
    const record = referenceById.get(semanticCase.canonical_id);
    if (!record) fail(`${label} references missing canonical record ${semanticCase.canonical_id}`, 'MISSING_REFERENCE_RECORD');
    assertEqual(record.lemma, semanticCase.lemma, `${label} lemma drifted`, 'SEMANTIC_CORPUS_MISMATCH');
    assertEqual(record.senses.map(({ id }) => id), semanticCase.expected_sense_ids, `${label} sense IDs drifted`, 'SEMANTIC_CORPUS_MISMATCH');
    assertEqual(record.senses.length, semanticCase.expected_sense_count, `${label} sense count drifted`, 'SEMANTIC_CORPUS_MISMATCH');
    assertEqual(record.senses.map(({ pos }) => pos), semanticCase.expected_pos, `${label} POS drifted`, 'SEMANTIC_CORPUS_MISMATCH');
    assertEqual(record.senses.map(({ gloss }) => gloss), semanticCase.expected_glosses, `${label} glosses drifted`, 'SEMANTIC_CORPUS_MISMATCH');

    if (semanticCase.scope !== 'wave-b-proposal') continue;
    const recordReview = reviewByInventoryId.get(semanticCase.inventory_id);
    if (!recordReview) fail(`${label} is not connected to proposal preflight`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    assertEqual(recordReview.canonical_id, semanticCase.canonical_id, `${label} preflight canonical binding drifted`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    assertEqual(recordReview.observed_sense_count, semanticCase.expected_sense_count, `${label} preflight sense count drifted`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    const evidence = recordReview.boundary_evidence?.[semanticCase.boundary_id];
    if (!evidence) fail(`${label} preflight boundary evidence is missing`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    assertEqual(evidence.applicability, semanticCase.required_applicability, `${label} preflight applicability drifted`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    assertEqual(evidence.decision, semanticCase.required_decision, `${label} preflight decision drifted`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    assertEqual(evidence.candidate_sense_ids, semanticCase.expected_sense_ids, `${label} preflight sense coverage drifted`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    requireString(evidence.rationale, `${label} preflight rationale`);
    if (!evidence.rationale.includes(semanticCase.case_id)) fail(`${label} preflight rationale must cite its corpus case`, 'SEMANTIC_PREFLIGHT_DISCONNECTED');
    const actualPairs = new Set((evidence.contrasts ?? []).map(({ left_sense_id: left, right_sense_id: right }) => contrastPairKey(left, right)));
    const expectedPairs = new Set(semanticCase.contrast_pairs.map(([left, right]) => contrastPairKey(left, right)));
    assertEqual(actualPairs, expectedPairs, `${label} preflight contrast coverage drifted`, 'SEMANTIC_PREFLIGHT_CONTRAST_MISMATCH');
    if (semanticCase.candidate_senses.length > 1 && recordReview.decision === 'included') {
      fail(`${label} source evidence with multiple candidates cannot be accepted as a single included sense`, 'SEMANTIC_SINGLE_SENSE_ACCEPTED');
    }
  }
  return { verified: true, caseCount: corpus.cases.length };
}

export function validateWaveBEditorialInput({ input, inventoryEntries = [], referenceRecords = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Wave B editorial input must be an object', 'INVALID_EDITORIAL_INPUT');
  assertEqual(input.schema_version, '2', 'Wave B editorial input schema version drifted', 'SCHEMA_VERSION');
  assertEqual(input.batch_id, WAVE_B_BATCH_ID, 'Wave B editorial input batch_id drifted', 'BATCH_ID_MISMATCH');
  assertEqual(input.inventory_id, WAVE_B_INVENTORY_ID, 'Wave B editorial inventory_id drifted', 'INVENTORY_ID_MISMATCH');
  assertEqual(input.inventory_revision, WAVE_B_INVENTORY_REVISION, 'Wave B editorial inventory revision drifted', 'INVENTORY_REVISION_MISMATCH');
  assertEqual(input.source_kind, 'codex-authored', 'Wave B editorial source kind must be explicit', 'SOURCE_KIND_MISMATCH');
  assertEqual(input.status, 'complete', 'Wave B editorial input is not complete', 'EDITORIAL_INCOMPLETE');
  requireString(input.input_id, 'editorial input_id');
  requireIsoDate(input.created_at, 'editorial created_at');
  requireIsoDate(input.completed_at, 'editorial completed_at');
  if (Date.parse(input.completed_at) < Date.parse(input.created_at)) fail('editorial completed_at precedes created_at', 'TIMESTAMP_ORDER');
  assertEqual(input.sense_review?.boundary_ids, M5_10A_SENSE_BOUNDARY_IDS, 'Wave B editorial boundary IDs drifted', 'BOUNDARY_SCOPE_MISMATCH');
  assertEqual(input.sense_review?.status, 'complete', 'Wave B editorial sense review is incomplete', 'SENSE_REVIEW_INCOMPLETE');
  assertEqual(input.sense_review?.reviewed_start_count, WAVE_B_IMPORTED_START_COUNT, 'Wave B reviewed start count drifted', 'SENSE_REVIEW_COUNT_MISMATCH');
  requireString(input.sense_review?.note, 'editorial sense_review.note');
  requireSha256(input.proposal_staging?.sha256, 'editorial proposal_staging.sha256');
  assertEqual(input.proposal_staging?.format, 'canonical-jsonl', 'Wave B proposal format drifted', 'PROPOSAL_FORMAT_MISMATCH');
  assertEqual(input.proposal_staging?.record_count, WAVE_B_SELECTED_START_COUNT, 'Wave B proposal record count drifted', 'PROPOSAL_COUNT_MISMATCH');
  requireSha256(input.reviewed_staging_sha256, 'editorial reviewed_staging_sha256');
  requireString(input.timing_artifact?.path, 'editorial timing_artifact.path');
  requireSha256(input.timing_artifact?.sha256, 'editorial timing_artifact.sha256');
  requireString(input.decision_artifact?.path, 'editorial decision_artifact.path');
  requireSha256(input.decision_artifact?.sha256, 'editorial decision_artifact.sha256');
  assertEqual(input.provenance?.verification_status, 'verified', 'editorial provenance is not verified', 'PROVENANCE_MISMATCH');
  assertEqual(input.provenance?.actor_kind, 'codex', 'editorial provenance actor kind drifted', 'PROVENANCE_MISMATCH');
  requireString(input.provenance?.actor_id, 'editorial provenance actor_id');
  requireUuid(input.provenance?.session_id, 'editorial provenance session_id');
  requireString(input.provenance?.artifact, 'editorial provenance artifact');
  requireSha256(input.provenance?.sha256, 'editorial provenance artifact sha256');
  const entries = inventoryById(inventoryEntries);
  const referenceById = recordsById(referenceRecords);
  const semanticCorpus = readSemanticRegressionCorpus();
  const semanticCasesByCanonicalId = semanticCaseMap(semanticCorpus);
  if (!Array.isArray(input.records)) fail('Wave B editorial records must be an array', 'INVALID_EDITORIAL_RECORDS');
  exactIds(input.records.map(({ inventory_id: id }) => id), WAVE_B_SELECTED_INVENTORY_IDS, 'editorial record');
  for (const [index, recordReview] of input.records.entries()) validateRecordReview(recordReview, index, entries, referenceById, semanticCasesByCanonicalId);
  validateWaveBSemanticRegression({ corpus: semanticCorpus, referenceRecords, editorialRecords: input.records });
  const importedReviews = input.records.slice(0, WAVE_B_IMPORTED_START_COUNT);
  const splitCanonicalIds = importedReviews
    .filter((recordReview) => referenceById.get(recordReview.canonical_id)?.senses.length > 1)
    .map(({ canonical_id: canonicalId }) => canonicalId);
  assertEqual(input.sense_review.scoped_single_sense_count, WAVE_B_IMPORTED_START_COUNT - splitCanonicalIds.length, 'Wave B single-sense count drifted', 'SENSE_SCOPE_MISMATCH');
  assertEqual(input.sense_review.split_record_count, splitCanonicalIds.length, 'Wave B split record count drifted', 'SENSE_SCOPE_MISMATCH');
  assertEqual(input.sense_review.split_canonical_ids, splitCanonicalIds, 'Wave B split canonical scope drifted', 'SENSE_SCOPE_MISMATCH');
  const counts = Object.fromEntries(DECISIONS.map((decision) => [decision, input.records.filter((record) => record.decision === decision).length]));
  assertEqual(counts, {
    included: WAVE_B_IMPORTED_START_COUNT - splitCanonicalIds.length,
    corrected: splitCanonicalIds.length,
    held: input.records.slice(WAVE_B_IMPORTED_START_COUNT, WAVE_B_PROCESSED_START_COUNT).length,
    rejected: 0,
    deferred: input.records.slice(WAVE_B_PROCESSED_START_COUNT).length,
  }, 'Wave B editorial decision counts drifted', 'EDITORIAL_DECISION_COUNTS');
  return {
    verified: true,
    selectedStartCount: WAVE_B_SELECTED_START_COUNT,
    processedStartCount: WAVE_B_PROCESSED_START_COUNT,
    importedStartCount: WAVE_B_IMPORTED_START_COUNT,
    decisionCounts: counts,
  };
}

export function validateWaveBEditorialDecisionArtifact(decisionArtifact) {
  if (!decisionArtifact || typeof decisionArtifact !== 'object' || Array.isArray(decisionArtifact)) {
    fail('Wave B editorial decision artifact must be an object', 'INVALID_DECISION_ARTIFACT');
  }
  validateDecisionSchema(decisionArtifact, editorialDecisionsSchemaValidator, 'Wave B editorial decision artifact');
  assertEqual(decisionArtifact.schema_version, '1', 'editorial decision artifact schema version drifted', 'DECISION_ARTIFACT_SCHEMA');
  assertEqual(decisionArtifact.artifact_id, 'm5-10-wave-b-editorial-decisions-20260909', 'editorial decision artifact ID drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.batch_id, WAVE_B_BATCH_ID, 'editorial decision artifact batch_id drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.source_kind, 'codex-authored', 'editorial decision artifact source kind drifted', 'DECISION_ARTIFACT_PROVENANCE');
  assertEqual(decisionArtifact.actor_kind, 'codex', 'editorial decision artifact actor kind drifted', 'DECISION_ARTIFACT_PROVENANCE');
  requireString(decisionArtifact.actor_id, 'editorial decision artifact actor_id');
  requireString(decisionArtifact.session_id, 'editorial decision session_id');
  requireUuid(decisionArtifact.session_id, 'editorial decision session_id');
  requireIsoDate(decisionArtifact.created_at, 'editorial decision created_at');
  requireIsoDate(decisionArtifact.finalized_at, 'editorial decision finalized_at');
  assertTimestampOrder(decisionArtifact.created_at, decisionArtifact.finalized_at, 'editorial decision artifact', 'DECISION_ARTIFACT_CHRONOLOGY');
  requireSha256(decisionArtifact.proposal_staging_sha256, 'editorial decision proposal digest');
  requireSha256(decisionArtifact.reviewed_staging_sha256, 'editorial decision reviewed digest');
  exactIds(decisionArtifact.records?.map(({ inventory_id: id }) => id), WAVE_B_SELECTED_INVENTORY_IDS, 'editorial decision artifact records');
  requireString(decisionArtifact.note, 'editorial decision artifact note');
  return structuredClone(decisionArtifact);
}

function validateDecisionArtifact(decisionArtifact, input) {
  validateWaveBEditorialDecisionArtifact(decisionArtifact);
  assertEqual(decisionArtifact.input_id, input.input_id, 'editorial decision artifact input binding drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.proposal_staging_sha256, input.proposal_staging.sha256, 'editorial decision artifact proposal digest drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.reviewed_staging_sha256, input.reviewed_staging_sha256, 'editorial decision artifact reviewed digest drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.records, input.records, 'editorial input does not match the separate decision artifact', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.session_id, input.provenance.session_id, 'editorial decision session drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.finalized_at, input.decision_artifact.finalized_at, 'editorial decision finalization timestamp drifted', 'DECISION_ARTIFACT_BINDING');
  return decisionArtifact;
}

export function validateWaveBAuditDecisionArtifact(decisionArtifact) {
  if (!decisionArtifact || typeof decisionArtifact !== 'object' || Array.isArray(decisionArtifact)) {
    fail('Wave B audit decision artifact must be an object', 'INVALID_DECISION_ARTIFACT');
  }
  validateDecisionSchema(decisionArtifact, auditDecisionsSchemaValidator, 'Wave B audit decision artifact');
  assertEqual(decisionArtifact.schema_version, '1', 'audit decision artifact schema version drifted', 'DECISION_ARTIFACT_SCHEMA');
  assertEqual(decisionArtifact.artifact_id, 'm5-10-wave-b-audit-decisions-20260909', 'audit decision artifact ID drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.batch_id, WAVE_B_BATCH_ID, 'audit decision artifact batch_id drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.source_kind, 'codex-authored', 'audit decision artifact source kind drifted', 'DECISION_ARTIFACT_PROVENANCE');
  assertEqual(decisionArtifact.actor_kind, 'codex', 'audit decision artifact actor kind drifted', 'DECISION_ARTIFACT_PROVENANCE');
  requireString(decisionArtifact.actor_id, 'audit decision artifact actor_id');
  requireString(decisionArtifact.session_id, 'audit decision session_id');
  requireUuid(decisionArtifact.session_id, 'audit decision session_id');
  requireIsoDate(decisionArtifact.created_at, 'audit decision created_at');
  requireIsoDate(decisionArtifact.finalized_at, 'audit decision finalized_at');
  assertTimestampOrder(decisionArtifact.created_at, decisionArtifact.finalized_at, 'audit decision artifact', 'DECISION_ARTIFACT_CHRONOLOGY');
  requireSha256(decisionArtifact.reviewed_staging_sha256, 'audit decision reviewed digest');
  exactIds(decisionArtifact.reviewed_record_ids, WAVE_B_IMPORTED_CANONICAL_IDS, 'audit decision artifact canonical scope');
  exactIds(decisionArtifact.reviewed_buffer_inventory_ids, WAVE_B_BUFFER_INVENTORY_IDS, 'audit decision artifact buffer scope');
  assertEqual(decisionArtifact.relation_reviews, [], 'audit decision artifact relation scope drifted', 'DECISION_ARTIFACT_DRIFT');
  const semanticCorpus = readSemanticRegressionCorpus();
  assertEqual(decisionArtifact.coverage?.semantic_regression_case_ids, semanticCorpus.cases.map(({ case_id: caseId }) => caseId), 'audit decision semantic coverage drifted', 'AUDIT_COVERAGE_MISMATCH');
  exactIds(decisionArtifact.findings?.map(({ id }) => id), [
    'wave-b-audit-semantic-regressions',
    'wave-b-audit-boundary-evidence',
    'wave-b-audit-timing-artifact',
    'wave-b-audit-finding-evidence',
    'wave-b-audit-canonical-regeneration',
  ], 'audit decision artifact findings');
  requireString(decisionArtifact.note, 'audit decision artifact note');
  return structuredClone(decisionArtifact);
}

function validateAuditDecisionArtifact(decisionArtifact, audit, editorialInput) {
  validateWaveBAuditDecisionArtifact(decisionArtifact);
  assertEqual(decisionArtifact.audit_id, audit.audit_id, 'audit decision artifact audit binding drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.editorial_input_id, editorialInput.input_id, 'audit decision artifact editorial binding drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.reviewed_staging_sha256, editorialInput.reviewed_staging_sha256, 'audit decision artifact reviewed digest drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.reviewed_record_ids, audit.reviewed_record_ids, 'audit decision artifact canonical scope drifted', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.reviewed_buffer_inventory_ids, audit.reviewed_buffer_inventory_ids, 'audit decision artifact buffer scope drifted', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.relation_reviews, audit.relation_reviews, 'audit decision artifact relation scope drifted', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.coverage, audit.coverage, 'audit decision artifact coverage drifted', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.findings, audit.findings, 'audit decision artifact findings drifted', 'DECISION_ARTIFACT_DRIFT');
  assertEqual(decisionArtifact.session_id, audit.provenance.session_id, 'audit decision session drifted', 'DECISION_ARTIFACT_BINDING');
  assertEqual(decisionArtifact.finalized_at, audit.decision_artifact.finalized_at, 'audit decision finalization timestamp drifted', 'DECISION_ARTIFACT_BINDING');
  return decisionArtifact;
}

function provenanceSubjectSha256(input) {
  const subject = structuredClone(input);
  subject.provenance.sha256 = null;
  return sha256Bytes(Buffer.from(JSON.stringify(subject), 'utf8'));
}

export async function validateWaveBProvenanceArtifact({ input, subjectKind } = {}) {
  const subjectId = subjectKind === 'editorial' ? input.input_id : input.audit_id;
  const artifactPath = path.resolve(REPOSITORY_DIRECTORY, input.provenance.artifact);
  const artifactBytes = await readFile(artifactPath);
  let artifact;
  try {
    artifact = JSON.parse(artifactBytes.toString('utf8'));
  } catch (error) {
    fail(`${subjectKind} provenance artifact is not valid JSON: ${error.message}`, 'PROVENANCE_ARTIFACT_INVALID');
  }
  assertEqual(artifact.schema_version, '1', `${subjectKind} provenance schema version drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.subject_kind, subjectKind, `${subjectKind} provenance subject kind drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.subject_id, subjectId, `${subjectKind} provenance subject ID drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.subject_sha256, provenanceSubjectSha256(input), `${subjectKind} provenance input digest drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(input.provenance.sha256, sha256Bytes(artifactBytes), `${subjectKind} provenance artifact digest drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.session_id, input.provenance.session_id, `${subjectKind} provenance session drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.actor_id, input.provenance.actor_id, `${subjectKind} provenance actor drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.completed_at, input.completed_at, `${subjectKind} provenance completion drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  requireIsoDate(artifact.started_at, `${subjectKind} provenance started_at`);
  requireIsoDate(artifact.completed_at, `${subjectKind} provenance completed_at`);
  if (Date.parse(artifact.completed_at) < Date.parse(artifact.started_at)) fail(`${subjectKind} provenance completed before started`, 'PROVENANCE_ARTIFACT_MISMATCH');
  return artifact;
}

export function validateWaveBAuditInput({ audit, editorialInput, relationDiff } = {}) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) fail('Wave B audit input must be an object', 'INVALID_AUDIT_INPUT');
  assertEqual(audit.schema_version, '2', 'Wave B audit schema version drifted', 'SCHEMA_VERSION');
  assertEqual(audit.batch_id, WAVE_B_BATCH_ID, 'Wave B audit batch_id drifted', 'BATCH_ID_MISMATCH');
  assertEqual(audit.source_kind, 'codex-authored', 'Wave B audit source kind must be explicit', 'SOURCE_KIND_MISMATCH');
  assertEqual(audit.status, 'complete', 'Wave B audit is not complete', 'AUDIT_INCOMPLETE');
  assertEqual(audit.independent, true, 'Wave B audit must be independent', 'AUDIT_NOT_INDEPENDENT');
  assertEqual(audit.editorial_input_id, editorialInput.input_id, 'Wave B audit editorial input binding drifted', 'AUDIT_INPUT_BINDING');
  assertEqual(audit.reviewed_staging_sha256, editorialInput.reviewed_staging_sha256, 'Wave B audit staging digest drifted', 'AUDIT_STAGING_BINDING');
  assertEqual(audit.provenance?.verification_status, 'verified', 'audit provenance is not verified', 'PROVENANCE_MISMATCH');
  assertEqual(audit.provenance?.actor_kind, 'codex', 'audit provenance actor kind drifted', 'PROVENANCE_MISMATCH');
  requireString(audit.provenance?.actor_id, 'audit provenance actor_id');
  requireUuid(audit.provenance?.session_id, 'audit provenance session_id');
  requireString(audit.provenance?.artifact, 'audit provenance artifact');
  requireSha256(audit.provenance?.sha256, 'audit provenance artifact sha256');
  exactIds(audit.reviewed_record_ids, WAVE_B_IMPORTED_CANONICAL_IDS, 'Wave B audit canonical scope');
  exactIds(audit.reviewed_buffer_inventory_ids, WAVE_B_BUFFER_INVENTORY_IDS, 'Wave B audit buffer scope');
  assertEqual(audit.relation_reviews, [], 'Wave B relation review must retain an explicit empty output', 'RELATION_REVIEW_SCOPE');
  if (!relationDiff || relationDiff.before_count !== 0 || relationDiff.after_count !== 0 || relationDiff.events.length !== 0) fail('Wave B audit requires an empty relation diff', 'RELATION_DIFF_NOT_EMPTY');
  const semanticCorpus = readSemanticRegressionCorpus();
  assertEqual(audit.coverage?.status, 'complete', 'Wave B audit coverage is incomplete', 'AUDIT_COVERAGE_MISMATCH');
  exactIds(audit.coverage?.reviewed_record_ids, WAVE_B_IMPORTED_CANONICAL_IDS, 'Wave B audit coverage canonical scope');
  exactIds(audit.coverage?.reviewed_buffer_inventory_ids, WAVE_B_BUFFER_INVENTORY_IDS, 'Wave B audit coverage buffer scope');
  assertEqual(audit.coverage?.semantic_regression_case_ids, semanticCorpus.cases.map(({ case_id: caseId }) => caseId), 'Wave B audit semantic coverage drifted', 'AUDIT_COVERAGE_MISMATCH');
  const requiredAuditWorkUnitIds = [...audit.reviewed_record_ids, ...audit.reviewed_buffer_inventory_ids];
  if (!Array.isArray(audit.coverage?.audit_work_unit_ids)) fail('Wave B audit work-unit coverage is missing', 'AUDIT_COVERAGE_MISMATCH');
  assertEqual(
    audit.coverage.audit_work_unit_ids,
    [...requiredAuditWorkUnitIds, 'wave-b-relation-screen', 'wave-b-timing-completeness'],
    'Wave B audit work-unit coverage drifted',
    'AUDIT_COVERAGE_MISMATCH',
  );
  assertEqual(audit.coverage?.relation_scope, { before_count: 0, after_count: 0, candidate_count: 0 }, 'Wave B audit relation coverage drifted', 'AUDIT_COVERAGE_MISMATCH');
  requireString(audit.audit_id, 'audit_id');
  requireString(audit.auditor_id, 'auditor_id');
  requireIsoDate(audit.created_at, 'audit created_at');
  requireIsoDate(audit.completed_at, 'audit completed_at');
  requireString(audit.decision_artifact?.path, 'audit decision_artifact.path');
  requireSha256(audit.decision_artifact?.sha256, 'audit decision_artifact.sha256');
  requireString(audit.editorial_timing_artifact?.path, 'audit editorial_timing_artifact.path');
  requireSha256(audit.editorial_timing_artifact?.sha256, 'audit editorial_timing_artifact.sha256');
  requireString(audit.timing_artifact?.path, 'audit timing_artifact.path');
  requireSha256(audit.timing_artifact?.sha256, 'audit timing_artifact.sha256');
  requireIsoDate(audit.decision_artifact?.created_at, 'audit decision_artifact.created_at');
  requireIsoDate(audit.decision_artifact?.finalized_at, 'audit decision_artifact.finalized_at');
  if (!Array.isArray(audit.findings) || audit.findings.length !== 5) fail('Wave B audit must contain five resolved findings', 'AUDIT_FINDINGS_MISMATCH');
  const findingIds = audit.findings.map(({ id }) => id);
  exactIds(findingIds, [
    'wave-b-audit-semantic-regressions',
    'wave-b-audit-boundary-evidence',
    'wave-b-audit-timing-artifact',
    'wave-b-audit-finding-evidence',
    'wave-b-audit-canonical-regeneration',
  ], 'Wave B audit findings');
  const findingDefects = new Set();
  const reviewedRecordIdSet = new Set(audit.reviewed_record_ids);
  for (const finding of audit.findings) {
    if (!['sense', 'relation-noise', 'timing-measurement', 'reference-closure'].includes(finding.category)) fail(`${finding.id} has an invalid audit category`, 'AUDIT_FINDING_CATEGORY');
    assertEqual(finding.status, 'resolved', `${finding.id} must be resolved`, 'OPEN_AUDIT_FINDING');
    if (finding.severity === 'blocker') fail(`${finding.id} cannot be a blocker in a passing audit`, 'OPEN_AUDIT_BLOCKER');
    if (!Array.isArray(finding.evidence_refs) || finding.evidence_refs.length === 0) fail(`${finding.id} lacks evidence_refs`, 'AUDIT_EVIDENCE_MISSING');
    if (!Array.isArray(finding.target_record_ids) || finding.target_record_ids.length === 0) fail(`${finding.id} lacks target_record_ids`, 'AUDIT_TARGET_MISSING');
    for (const recordId of finding.target_record_ids) {
      if (!/^w[0-9]{3,}$/u.test(recordId)) fail(`${finding.id} has an invalid target record ${recordId}`, 'AUDIT_TARGET_MISSING');
      if (!reviewedRecordIdSet.has(recordId)) fail(`${finding.id} targets record ${recordId} outside the reviewed audit scope`, 'AUDIT_TARGET_SCOPE');
    }
    requireString(finding.defect, `${finding.id}.defect`);
    requireString(finding.remediation, `${finding.id}.remediation`);
    if (!finding.diff_evidence || typeof finding.diff_evidence !== 'object' || Array.isArray(finding.diff_evidence)) fail(`${finding.id} lacks diff_evidence`, 'AUDIT_DIFF_EVIDENCE_MISSING');
    requireString(finding.diff_evidence.kind, `${finding.id}.diff_evidence.kind`);
    if (!Object.hasOwn(finding.diff_evidence, 'before') || !Object.hasOwn(finding.diff_evidence, 'after')) fail(`${finding.id}.diff_evidence must include before and after`, 'AUDIT_DIFF_EVIDENCE_MISSING');
    if (JSON.stringify(finding.diff_evidence.before) === JSON.stringify(finding.diff_evidence.after)) fail(`${finding.id}.diff_evidence does not show a remediation`, 'AUDIT_DIFF_EVIDENCE_MISSING');
    if (!Array.isArray(finding.diff_evidence.changed_fields) || finding.diff_evidence.changed_fields.length === 0) fail(`${finding.id}.diff_evidence.changed_fields is empty`, 'AUDIT_DIFF_EVIDENCE_MISSING');
    const normalizedDefect = stripEvidenceIdentifiers(`${finding.defect} ${finding.remediation}`);
    if (findingDefects.has(normalizedDefect)) fail(`${finding.id} reuses normalized audit defect evidence`, 'GENERIC_EDITORIAL_EVIDENCE');
    findingDefects.add(normalizedDefect);
    requireString(finding.note, `${finding.id}.note`);
  }
  return { verified: true, findingCount: audit.findings.length, openBlockerCount: 0 };
}

function validateTimingPass(pass, passId, expectedSha256, expectedAuditSessionId, expectedUnitIds) {
  assertEqual(pass.id, passId, `${passId} timing pass ID drifted`, 'TIMING_SCOPE_MISMATCH');
  assertEqual(pass.status, 'complete', `${passId} timing pass is not complete`, 'TIMING_INCOMPLETE');
  requireIsoDate(pass.started_at, `${passId}.started_at`);
  requireIsoDate(pass.completed_at, `${passId}.completed_at`);
  requireUuid(pass.session_id, `${passId}.session_id`);
  assertEqual(pass.recording_source, 'timing-recorder-v3', `${passId}.recording_source drifted`, 'TIMING_PROVENANCE_MISMATCH');
  const elapsed = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) fail(`${passId} timing chronology is invalid`, 'TIMING_CHRONOLOGY');
  assertEqual(pass.wall_clock_seconds, elapsed, `${passId}.wall_clock_seconds drifted from timestamps`, 'TIMING_DURATION_DRIFT');
  assertEqual(pass.editor_seconds, elapsed, `${passId}.editor_seconds drifted from timestamps`, 'TIMING_DURATION_DRIFT');
  requireString(pass.output_artifact_created_at, `${passId}.output_artifact_created_at`);
  assertTimestampOrder(pass.started_at, pass.output_artifact_created_at, `${passId} output artifact creation`, 'TIMING_WORK_LOG_CHRONOLOGY');
  assertTimestampOrder(pass.output_artifact_created_at, pass.completed_at, `${passId} output artifact and stop`, 'TIMING_WORK_LOG_CHRONOLOGY');
  requireSha256(pass.work_evidence?.before_sha256, `${passId}.work_evidence.before_sha256`);
  requireSha256(pass.work_evidence?.after_sha256, `${passId}.work_evidence.after_sha256`);
  requireString(pass.work_evidence?.note, `${passId}.work_evidence.note`);
  const inputArtifact = validateTimingArtifact(pass.work_evidence?.input_artifact, `${passId}.work_evidence.input_artifact`);
  const outputArtifact = validateTimingArtifact(pass.work_evidence?.output_artifact, `${passId}.work_evidence.output_artifact`);
  const workLog = validateTimingArtifact(pass.work_evidence?.work_log, `${passId}.work_evidence.work_log`);
  assertEqual(pass.work_evidence.before_sha256, inputArtifact.sha256, `${passId}.before_sha256 is not the input artifact digest`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  assertEqual(pass.work_evidence.after_sha256, outputArtifact.sha256, `${passId}.after_sha256 is not the output artifact digest`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  assertEqual(workLog, outputArtifact, `${passId} work log and output artifact drifted`, 'TIMING_WORK_LOG_BINDING');
  if (inputArtifact.path === outputArtifact.path || inputArtifact.sha256 === outputArtifact.sha256) fail(`${passId} timing pass must record a real content transition`, 'TIMING_ARTIFACT_TRANSITION_MISSING');
  const inputBytes = readFileSync(resolveArtifactPath(inputArtifact.path));
  const { bytes: outputBytes, rows } = readTimingWorkLog(outputArtifact, `${passId} output work log`);
  if (!outputBytes.subarray(0, inputBytes.length).equals(inputBytes)) fail(`${passId} output work log must preserve the cumulative input prefix`, 'TIMING_WORK_LOG_CHAIN_MISMATCH');
  const workRows = rows.filter((row) => row.kind === 'work' && row.pass_id === passId && row.session_id === pass.session_id);
  if (workRows.length === 0) fail(`${passId} output work log contains no recorder-bound work rows`, 'TIMING_WORK_LOG_EMPTY');
  const unitIds = workRows.map(({ unit_id: unitId }) => unitId);
  exactIds(unitIds, pass.work_evidence.unit_ids, `${passId} derived work evidence`);
  assertEqual(pass.work_evidence.unit_count, unitIds.length, `${passId} work evidence count drifted from output work log`, 'TIMING_WORK_EVIDENCE_MISMATCH');
  if (expectedUnitIds) exactIds(unitIds, expectedUnitIds, `${passId} work scope`);
  const unitKinds = new Set(workRows.map(({ unit_kind: unitKind }) => unitKind));
  if (unitKinds.size !== 1) fail(`${passId} output work log must use one unit kind`, 'TIMING_WORK_EVIDENCE_MISMATCH');
  assertEqual(pass.work_evidence.unit_kind, [...unitKinds][0], `${passId} work evidence kind drifted from output work log`, 'TIMING_WORK_EVIDENCE_MISMATCH');
  if (!Array.isArray(pass.work_evidence.work_event_ids) || pass.work_evidence.work_event_ids.length !== unitIds.length) fail(`${passId} work event scope is incomplete`, 'TIMING_EVENT_BINDING');
  if (new Set(pass.work_evidence.work_event_ids).size !== pass.work_evidence.work_event_ids.length) fail(`${passId} work event IDs contain duplicates`, 'TIMING_EVENT_BINDING');
  for (const row of workRows) {
    assertEqual(row.schema_version, '1', `${passId} work row schema version drifted`, 'TIMING_WORK_LOG_INVALID');
    assertEqual(row.kind, 'work', `${passId} work row kind drifted`, 'TIMING_WORK_LOG_INVALID');
    assertEqual(row.pass_id, passId, `${passId} work row pass binding drifted`, 'TIMING_WORK_LOG_INVALID');
    assertEqual(row.session_id, pass.session_id, `${passId} work row session binding drifted`, 'TIMING_WORK_LOG_INVALID');
    requireString(row.unit_id, `${passId} work row unit_id`);
    requireString(row.unit_kind, `${passId} work row unit_kind`);
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) fail(`${passId} output work log contains an invalid payload`, 'TIMING_WORK_LOG_INVALID');
    requireIsoDate(row.recorded_at, `${passId} work row recorded_at`);
    assertTimestampOrder(pass.started_at, row.recorded_at, `${passId} work row start`, 'TIMING_WORK_LOG_CHRONOLOGY');
    assertTimestampOrder(row.recorded_at, pass.completed_at, `${passId} work row stop`, 'TIMING_WORK_LOG_CHRONOLOGY');
  }
  if (passId === 'post-freeze-audit') {
    requireUuid(pass.audit_session_id, `${passId}.audit_session_id`);
    assertEqual(pass.audit_session_id, expectedAuditSessionId, `${passId}.audit_session_id drifted`, 'AUDIT_TIMING_BINDING');
    assertEqual(pass.reviewed_staging_sha256, expectedSha256, `${passId}.reviewed_staging_sha256 drifted`, 'AUDIT_TIMING_BINDING');
  } else if (Object.hasOwn(pass, 'audit_session_id') || Object.hasOwn(pass, 'reviewed_staging_sha256')) {
    fail(`${passId} editorial pass must not carry audit-only binding fields`, 'TIMING_BINDING_MISMATCH');
  }
  return { rows, workRows, unitIds };
}

function assertTimestampOrder(earlier, later, label, code, { strict = false } = {}) {
  const earlierMs = Date.parse(earlier);
  const laterMs = Date.parse(later);
  if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) fail(`${label} contains an invalid timestamp`, code);
  if (strict ? laterMs <= earlierMs : laterMs < earlierMs) {
    fail(`${label} timestamp order is invalid`, code);
  }
}

export function validateWaveBChronology({ editorialInput, auditInput, timingInput, auditTimingInput } = {}) {
  const editorialFirst = timingInput.passes[0].started_at;
  const editorialLast = timingInput.passes.at(-1).completed_at;
  const auditFirst = auditTimingInput.passes[0].started_at;
  const auditLast = auditTimingInput.passes.at(-1).completed_at;

  assertTimestampOrder(editorialInput.created_at, editorialFirst, 'editorial session and timing', 'EDITORIAL_TIMING_CHRONOLOGY');
  assertTimestampOrder(editorialInput.created_at, editorialInput.decision_artifact.created_at, 'editorial session and decision creation', 'EDITORIAL_DECISION_CHRONOLOGY');
  assertTimestampOrder(editorialInput.decision_artifact.created_at, editorialInput.decision_artifact.finalized_at, 'editorial decision creation and finalization', 'EDITORIAL_DECISION_CHRONOLOGY');
  assertTimestampOrder(editorialInput.decision_artifact.finalized_at, editorialFirst, 'editorial decision and timing start', 'EDITORIAL_DECISION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(editorialLast, editorialInput.completed_at, 'editorial timing and completion', 'EDITORIAL_COMPLETION_CHRONOLOGY', { strict: true });
  assertEqual(editorialInput.timing_artifact.started_at, editorialFirst, 'editorial timing start binding drifted', 'EDITORIAL_TIMING_BINDING');
  assertEqual(editorialInput.timing_artifact.completed_at, editorialLast, 'editorial timing completion binding drifted', 'EDITORIAL_TIMING_BINDING');

  assertTimestampOrder(editorialInput.completed_at, auditInput.created_at, 'editorial completion and audit session', 'AUDIT_SESSION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditInput.created_at, auditFirst, 'audit session and post-freeze timing', 'AUDIT_TIMING_CHRONOLOGY');
  assertTimestampOrder(editorialInput.completed_at, auditFirst, 'editorial completion and post-freeze audit', 'AUDIT_TIMING_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditInput.created_at, auditInput.decision_artifact.created_at, 'audit session and decision creation', 'AUDIT_DECISION_CHRONOLOGY');
  assertTimestampOrder(auditInput.decision_artifact.created_at, auditInput.decision_artifact.finalized_at, 'audit decision creation and finalization', 'AUDIT_DECISION_CHRONOLOGY');
  assertTimestampOrder(auditInput.decision_artifact.finalized_at, auditFirst, 'audit decision and timing start', 'AUDIT_DECISION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditLast, auditInput.completed_at, 'audit timing and completion', 'AUDIT_COMPLETION_CHRONOLOGY', { strict: true });
  assertEqual(auditInput.editorial_timing_artifact.started_at, editorialFirst, 'audit editorial timing start binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.editorial_timing_artifact.completed_at, editorialLast, 'audit editorial timing completion binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.timing_artifact.started_at, auditFirst, 'audit timing start binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.timing_artifact.completed_at, auditLast, 'audit timing completion binding drifted', 'AUDIT_TIMING_BINDING');
  return { editorialFirst, editorialLast, auditFirst, auditLast };
}

export function validateWaveBTimingInput(timing, { timingKind, reviewedStagingSha256, reviewedStagingPath, auditSessionId, expectedUnitIdsByPass } = {}) {
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) fail('Wave B timing input must be an object', 'INVALID_TIMING_INPUT');
  assertEqual(timing.schema_version, '2', 'Wave B timing schema version drifted', 'SCHEMA_VERSION');
  assertEqual(timing.batch_id, WAVE_B_BATCH_ID, 'Wave B timing batch_id drifted', 'BATCH_ID_MISMATCH');
  assertEqual(timing.timing_kind, timingKind, 'Wave B timing kind drifted', 'TIMING_KIND_MISMATCH');
  assertEqual(timing.recorder_version, 'wave-b-timing-recorder-v3', 'Wave B timing recorder version drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.recording_source, 'timing-recorder-v3', 'Wave B timing recording source drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.recorder_command, 'node scripts/batch/record-m5-10-wave-b-timing.mjs', 'Wave B timing recorder command drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.status, 'complete', 'Wave B timing is not complete', 'TIMING_INCOMPLETE');
  requireUuid(timing.session_id, 'timing session_id');
  requireString(timing.timing_id, 'timing_id');
  assertEqual(timing.processed_start_count, WAVE_B_PROCESSED_START_COUNT, 'Wave B timing processed count drifted', 'PROCESSED_COUNT_MISMATCH');
  const expectedPassIds = timingKind === 'editorial' ? WAVE_B_TIMING_PASS_IDS : WAVE_B_AUDIT_TIMING_PASS_IDS;
  if (timingKind === 'post-freeze-audit') {
    const stagingArtifact = validateTimingArtifact(timing.reviewed_staging_artifact, 'post-freeze audit reviewed staging artifact', { pathOverride: reviewedStagingPath });
    assertEqual(stagingArtifact.sha256, reviewedStagingSha256, 'post-freeze audit staging artifact digest drifted', 'AUDIT_TIMING_BINDING');
    assertEqual(timing.reviewed_staging_sha256, stagingArtifact.sha256, 'post-freeze audit staging digest was not recorder-derived', 'AUDIT_TIMING_BINDING');
  } else if (Object.hasOwn(timing, 'reviewed_staging_artifact') || Object.hasOwn(timing, 'reviewed_staging_sha256')) {
    fail('editorial timing must not carry post-freeze staging binding fields', 'TIMING_BINDING_MISMATCH');
  }
  exactIds(timing.passes?.map(({ id }) => id), expectedPassIds, `${timingKind} timing passes`);
  const passWork = new Map();
  for (const pass of timing.passes) {
    passWork.set(pass.id, validateTimingPass(pass, pass.id, reviewedStagingSha256, auditSessionId, expectedUnitIdsByPass?.[pass.id]));
  }
  for (let index = 1; index < timing.passes.length; index += 1) {
    assertEqual(
      timing.passes[index - 1].work_evidence.output_artifact.sha256,
      timing.passes[index].work_evidence.input_artifact.sha256,
      `${timingKind} timing pass artifact chain is discontinuous at ${timing.passes[index].id}`,
      'TIMING_ARTIFACT_CHAIN_MISMATCH',
    );
    assertTimestampOrder(
      timing.passes[index - 1].completed_at,
      timing.passes[index].started_at,
      `${timingKind} timing passes`,
      'TIMING_CHRONOLOGY',
    );
  }
  const expectedEventCount = timing.passes.reduce((sum, pass) => sum + pass.work_evidence.unit_count + 2, 0);
  if (!Array.isArray(timing.events) || timing.events.length !== expectedEventCount) fail(`${timingKind} timing event count drifted`, 'TIMING_EVENT_COVERAGE');
  const eventIds = timing.events.map(({ event_id: eventId }) => eventId);
  if (eventIds.some((eventId) => typeof eventId !== 'string' || !/^m5-10-wave-b-timing-event-[0-9]{4}$/u.test(eventId))) {
    fail(`${timingKind} timing contains an invalid event ID`, 'TIMING_EVENT_BINDING');
  }
  if (new Set(eventIds).size !== eventIds.length) fail(`${timingKind} timing event IDs contain duplicates`, 'TIMING_EVENT_BINDING');
  let eventIndex = 0;
  for (const pass of timing.passes) {
    const startEvent = timing.events[eventIndex++];
    assertEqual(startEvent, { event_id: startEvent.event_id, pass_id: pass.id, kind: 'start', session_id: pass.session_id, at: pass.started_at }, `${timingKind} start event binding drifted`, 'TIMING_EVENT_BINDING');
    const workRows = passWork.get(pass.id).workRows;
    const workEventIds = pass.work_evidence.work_event_ids;
    assertEqual(workEventIds.length, workRows.length, `${pass.id} work event count drifted`, 'TIMING_EVENT_BINDING');
    for (const [rowIndex, row] of workRows.entries()) {
      const workEvent = timing.events[eventIndex++];
      assertEqual(workEvent.event_id, workEventIds[rowIndex], `${pass.id} work event ID drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.pass_id, pass.id, `${pass.id} work event pass binding drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.kind, 'work', `${pass.id} work event kind drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.session_id, pass.session_id, `${pass.id} work event session binding drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.at, row.recorded_at, `${pass.id} work event timestamp drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.unit_id, row.unit_id, `${pass.id} work event unit binding drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.unit_kind, row.unit_kind, `${pass.id} work event kind binding drifted`, 'TIMING_EVENT_BINDING');
      assertEqual(workEvent.payload_sha256, sha256Bytes(Buffer.from(JSON.stringify(row.payload), 'utf8')), `${pass.id} work event payload binding drifted`, 'TIMING_EVENT_BINDING');
    }
    const stopEvent = timing.events[eventIndex++];
    assertEqual(stopEvent, { event_id: stopEvent.event_id, pass_id: pass.id, kind: 'stop', session_id: pass.session_id, at: pass.completed_at }, `${timingKind} stop event binding drifted`, 'TIMING_EVENT_BINDING');
    assertEqual(workEventIds, timing.events.slice(eventIndex - workRows.length - 1, eventIndex - 1).map(({ event_id: eventId }) => eventId), `${pass.id} work event scope drifted`, 'TIMING_EVENT_BINDING');
  }
  assertEqual(eventIndex, timing.events.length, `${timingKind} timing event coverage drifted`, 'TIMING_EVENT_COVERAGE');
  assertEqual(timing.recording_proof_sha256, createWaveBTimingProof(timing), `${timingKind} timing recording proof drifted`, 'TIMING_RECORDING_PROOF_MISMATCH');
  return {
    status: timing.status,
    passCount: expectedPassIds.length,
    totalEditorSeconds: timing.passes.reduce((sum, pass) => sum + pass.editor_seconds, 0),
  };
}

function preflightBoundaryChecks(recordReview, canonicalId) {
  return Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => {
    const evidence = recordReview.boundary_evidence[boundaryId];
    return [boundaryId, {
      status: 'checked',
      rationale: evidence.rationale,
      sense_ids: [...evidence.candidate_sense_ids],
    }];
  }));
}

function preflightCheckpoint(recordReview, processed) {
  const imported = ['included', 'corrected'].includes(recordReview.decision);
  const checkpoint = {
    inventory_id: recordReview.inventory_id,
    status: processed ? 'complete' : recordReview.decision,
    lemma_pos: processed ? 'checked' : 'not-reviewed',
    observed_sense_count: processed ? recordReview.observed_sense_count : 0,
    observed_pos: processed ? [...recordReview.observed_pos] : [],
    boundary_checks: processed
      ? preflightBoundaryChecks(recordReview, recordReview.canonical_id ?? recordReview.proposal_canonical_id)
      : Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => [boundaryId, {
        status: 'not-reviewed',
        rationale: `${recordReview.inventory_id} ${boundaryId}: buffer remains outside the import set.`,
        sense_ids: [],
      }])),
    missing_boundary_ids: processed ? [] : [...M5_10A_SENSE_BOUNDARY_IDS],
    note: recordReview.decision_note,
  };
  if (imported) checkpoint.canonical_id = recordReview.canonical_id;
  return checkpoint;
}

export function createWaveBManifest({ editorialInput, auditInput, timingInput, auditTimingInput, relationDiffSource, editorialInputSource, auditInputSource, timingInputSource, auditTimingInputSource, reviewedStagingPath } = {}) {
  validateWaveBAuditInput({ audit: auditInput, editorialInput, relationDiff: relationDiffSource.value });
  const expectedUnitIdsByPass = deriveWaveBTimingUnitSets({ editorialInput, auditInput });
  validateWaveBTimingInput(timingInput, { timingKind: 'editorial', reviewedStagingSha256: editorialInput.reviewed_staging_sha256, auditSessionId: auditInput.provenance.session_id, expectedUnitIdsByPass });
  validateWaveBTimingInput(auditTimingInput, { timingKind: 'post-freeze-audit', reviewedStagingSha256: editorialInput.reviewed_staging_sha256, reviewedStagingPath, auditSessionId: auditInput.provenance.session_id, expectedUnitIdsByPass });
  validateWaveBTimingDecisionWork({ timingInput, auditTimingInput, editorialInput, auditInput });
  validateWaveBChronology({ editorialInput, auditInput, timingInput, auditTimingInput });
  const manifest = {
    schema_version: '1',
    batch_id: WAVE_B_BATCH_ID,
    inventory_id: WAVE_B_INVENTORY_ID,
    inventory_revision: WAVE_B_INVENTORY_REVISION,
    generator: {
      model_id: 'wave-b-downstream-builder',
      tool_version: 'typewriter-m5-10-wave-b-2',
      prompt_version: 'not-used-for-provenance',
      draft_sha256: editorialInput.proposal_staging.sha256,
    },
    generated_at: editorialInput.created_at,
    review: {
      status: 'complete',
      reviewer: editorialInput.provenance.actor_id,
      completed_at: editorialInput.completed_at,
      input_artifact: editorialInputSource.path,
      input_sha256: editorialInputSource.sha256,
      reviewed_staging_sha256: editorialInput.reviewed_staging_sha256,
    },
    sense_review: {
      status: 'complete',
      reviewed_start_count: WAVE_B_IMPORTED_START_COUNT,
      scoped_single_sense_count: editorialInput.sense_review.scoped_single_sense_count,
      split_record_count: editorialInput.sense_review.split_record_count,
      split_canonical_ids: [...editorialInput.sense_review.split_canonical_ids],
      note: editorialInput.sense_review.note,
      preflight: {
        process_revision: M5_10A_PROCESS_REVISION,
        boundary_ids: [...M5_10A_SENSE_BOUNDARY_IDS],
        record_checkpoints: editorialInput.records.map((recordReview, index) => preflightCheckpoint(recordReview, index < WAVE_B_IMPORTED_START_COUNT)),
      },
    },
    measurement: {
      schema_version: '1',
      relation_diff: { artifact: relationDiffSource.path, sha256: relationDiffSource.sha256 },
      timing: {
        contract_version: 'm5-10b-v2',
        source_artifact: timingInputSource.path,
        source_sha256: timingInputSource.sha256,
        audit_source_artifact: auditTimingInputSource.path,
        audit_source_sha256: auditTimingInputSource.sha256,
        status: 'complete',
        passes: [...timingInput.passes, ...auditTimingInput.passes].map((pass) => structuredClone(pass)),
      },
      audit: {
        source_artifact: auditInputSource.path,
        source_sha256: auditInputSource.sha256,
        reviewed_staging_sha256: auditInput.reviewed_staging_sha256,
        status: 'complete',
        independent: true,
        coverage: structuredClone(auditInput.coverage),
        findings: auditInput.findings.map((finding) => structuredClone(finding)),
      },
    },
    records: editorialInput.records.map((recordReview) => {
      const record = {
        source: 'inventory',
        inventory_id: recordReview.inventory_id,
        role: 'start',
        decision: recordReview.decision,
        decision_note: recordReview.decision_note,
      };
      if (recordReview.decision === 'included' || recordReview.decision === 'corrected') record.canonical_id = recordReview.canonical_id;
      if (recordReview.decision === 'corrected') record.corrected_fields = [...recordReview.corrected_fields];
      return record;
    }),
  };
  validateBatchManifest(manifest);
  return manifest;
}

function relativeSourcePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256Bytes(bytes) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
}

function mergeReferenceRecords(...recordLists) {
  const byId = new Map();
  for (const list of recordLists) {
    for (const recordInfo of list) {
      const record = recordOf(recordInfo);
      if (byId.has(record.id) && JSON.stringify(recordOf(byId.get(record.id))) !== JSON.stringify(record)) fail(`conflicting Wave B reference record ${record.id}`, 'REFERENCE_RECORD_CONFLICT');
      if (!byId.has(record.id)) byId.set(record.id, recordInfo);
    }
  }
  return [...byId.values()];
}

function validateProposalStaging(proposalRecords, editorialInput) {
  exactIds(proposalRecords.map(recordOf).map(({ id }) => id), WAVE_B_PROPOSAL_CANONICAL_IDS, 'Wave B proposal staging');
  assertEqual(proposalRecords.length, WAVE_B_SELECTED_START_COUNT, 'Wave B proposal staging count drifted', 'PROPOSAL_COUNT_MISMATCH');
  const semanticCasesByCanonicalId = semanticCaseMap(readSemanticRegressionCorpus());
  for (const recordInfo of proposalRecords) {
    const record = recordOf(recordInfo);
    const semanticCase = semanticCasesByCanonicalId.get(record.id);
    const expectedSenseCount = semanticCase?.scope === 'wave-b-proposal' ? semanticCase.expected_sense_count : 1;
    if (record.senses.length > 1 && semanticCase?.scope !== 'wave-b-proposal') {
      fail(`proposal ${record.id} contains multiple candidate senses without a declared semantic regression case`, 'SEMANTIC_CORPUS_COVERAGE');
    }
    if (record.role !== 'start' || record.senses.length !== expectedSenseCount) fail(`proposal ${record.id} is outside the declared Wave B sense scope`, 'PROPOSAL_RECORD_MISMATCH');
  }
  const importedById = new Map(proposalRecords.slice(0, WAVE_B_IMPORTED_START_COUNT).map(recordOf).map((record) => [record.id, record]));
  for (const canonicalId of WAVE_B_IMPORTED_CANONICAL_IDS) {
    if (!importedById.has(canonicalId)) fail(`proposal staging is missing ${canonicalId}`, 'PROPOSAL_SCOPE_MISMATCH');
  }
  requireSha256(editorialInput.proposal_staging.sha256, 'proposal staging digest');
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(recordOf);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce((sum, record) => sum + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0), 0),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

export function createWaveBStageMetrics(metrics, verification) {
  const { decisions, relation_diff: relationDiff, timing, audit } = metrics.derived;
  const processedStartCount = metrics.derived.selection.processed_start_count ?? metrics.derived.selection.selected_start_count;
  return {
    correction_rate_of_selected: decisions.correction_rate_of_selected,
    relation_noise_rate_of_before: relationDiff.noise_rate_of_before,
    relation_noise_candidate_count: relationDiff.candidate_count ?? 0,
    relation_noise_rate_of_candidates: relationDiff.noise_rate_of_candidates ?? 0,
    total_wall_clock_seconds: timing.total_wall_clock_seconds,
    measured_wall_clock_seconds: timing.measured_wall_clock_seconds,
    total_editor_seconds: timing.total_editor_seconds,
    measured_editor_seconds: timing.measured_editor_seconds,
    editor_seconds_per_selected_start: timing.total_editor_seconds === null ? null : timing.total_editor_seconds / processedStartCount,
    timing_status: timing.status,
    unmeasured_timing_pass_count: timing.unmeasured_passes.length,
    audit_status: audit.status,
    audit_independent: audit.independent,
    open_audit_blocker_count: audit.open_blocker_count,
    editorial_review_complete: verification.editorial_review_complete,
    human_editorial_review_complete: verification.human_editorial_review_complete,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
  };
}

function validateAuthorization(authorization, previousStage, previousStageSha256, expectedSha256) {
  assertEqual(authorization.schema_version, '1', 'Wave B authorization schema version drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.issue, 96, 'Wave B authorization issue drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.parent_issue, 7, 'Wave B authorization parent issue drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.decision, 'AUTHORIZE WAVE B', 'Wave B authorization decision drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.wave?.stage_id, WAVE_B_STAGE_ID, 'Wave B authorization stage drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.wave?.net_start_increase, WAVE_B_IMPORTED_START_COUNT, 'Wave B authorization target drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.wave?.cumulative_start_target, WAVE_B_CUMULATIVE_START_COUNT, 'Wave B authorization cumulative target drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.canonical_mutation, false, 'Wave B authorization must preserve the proposal boundary', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.previous_gate?.path, 'data/batches/m5-10a-wave-a2.json', 'Wave B authorization previous gate path drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.previous_gate?.sha256, previousStageSha256, 'Wave B authorization previous gate digest drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(authorization.previous_gate?.actual_start_count, WAVE_B_BASE_START_COUNT, 'Wave B authorization previous count drifted', 'AUTHORIZATION_MISMATCH');
  assertEqual(previousStage.gate_status, 'pass', 'Wave B requires a passing A2 gate', 'PREVIOUS_GATE_NOT_PASS');
  assertEqual(previousStage.actual.canonical_snapshot.start_count, WAVE_B_BASE_START_COUNT, 'Wave B previous A2 snapshot drifted', 'PREVIOUS_GATE_MISMATCH');
  requireString(authorization.note, 'Wave B authorization note');
  if (expectedSha256 && authorization.proposal_sha256 !== expectedSha256) fail('Wave B authorization proposal digest drifted', 'AUTHORIZATION_MISMATCH');
}

function validateStage(stage, { metrics, verification, manifestSource, metricsSource, relationDiffSource, verificationSource, canonicalSnapshot, canonicalDirectory, canonicalSha256, previousStage, previousStageSha256, authorization, authorizationSha256, expectedGate }) {
  assertEqual(stage.schema_version, '1', 'Wave B stage schema version drifted', 'STAGE_SCHEMA');
  assertEqual(stage.stage_id, WAVE_B_STAGE_ID, 'Wave B stage ID drifted', 'STAGE_SCOPE_MISMATCH');
  assertEqual(stage.input.inventory_revision, WAVE_B_INVENTORY_REVISION, 'Wave B stage inventory revision drifted', 'STAGE_INPUT_MISMATCH');
  assertEqual(stage.input.canonical_snapshot.start_count, WAVE_B_BASE_START_COUNT, 'Wave B stage base start count drifted', 'STAGE_INPUT_MISMATCH');
  assertEqual(stage.target, { net_start_increase: 150, cumulative_start_target: 778, candidate_buffer: 20, selected_start_count: 170 }, 'Wave B stage target drifted', 'STAGE_TARGET_MISMATCH');
  const decisionMetrics = metrics.derived.decisions;
  assertEqual(stage.decisions, {
    included_start_count: decisionMetrics.included,
    corrected_start_count: decisionMetrics.corrected,
    held_start_count: decisionMetrics.held,
    rejected_start_count: decisionMetrics.rejected,
    deferred_start_count: decisionMetrics.deferred,
  }, 'Wave B stage decisions drifted', 'STAGE_DECISION_MISMATCH');
  assertEqual(stage.buffer, { available_count: 20, used_count: 10, unused_count: 10 }, 'Wave B stage buffer drifted', 'STAGE_BUFFER_MISMATCH');
  assertEqual(stage.actual.canonical_snapshot, canonicalSnapshot, 'Wave B stage canonical snapshot drifted', 'STAGE_CANONICAL_MISMATCH');
  assertEqual(stage.actual.imported_start_count, 150, 'Wave B stage imported count drifted', 'STAGE_IMPORT_MISMATCH');
  assertEqual(stage.metrics, createWaveBStageMetrics(metrics, verification), 'Wave B stage metrics drifted', 'STAGE_METRIC_MISMATCH');
  assertEqual(stage.gate_status, expectedGate.gate_status, 'Wave B stage gate status drifted', 'GATE_STATUS_MISMATCH');
  assertEqual(stage.decision, expectedGate.decision, 'Wave B stage decision drifted', 'GATE_DECISION_MISMATCH');
  assertEqual(stage.next_stage_created, false, 'Wave B cannot claim a created next stage', 'NEXT_STAGE_CREATED');
  assertEqual(stage.next_stage_authorized, false, 'Wave B cannot authorize a later stage', 'NEXT_STAGE_AUTHORIZED');
  assertEqual(stage.source.manifest, relativeSourcePath(manifestSource.path), 'Wave B stage manifest path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.manifest_sha256, manifestSource.sha256, 'Wave B stage manifest digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.metrics, relativeSourcePath(metricsSource.path), 'Wave B stage metrics path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.metrics_sha256, metricsSource.sha256, 'Wave B stage metrics digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.relation_diff, relativeSourcePath(relationDiffSource.path), 'Wave B stage relation path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.relation_diff_sha256, relationDiffSource.sha256, 'Wave B stage relation digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.canonical_directory, relativeSourcePath(canonicalDirectory), 'Wave B stage canonical path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.canonical_sha256, canonicalSha256, 'Wave B stage canonical digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.verification, relativeSourcePath(verificationSource.path), 'Wave B stage verification path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.verification_sha256, verificationSource.sha256, 'Wave B stage verification digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.previous_stage_report?.sha256, previousStageSha256, 'Wave B stage previous report digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.authorization?.sha256, authorizationSha256, 'Wave B stage authorization digest drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.previous_stage_report?.path, 'data/batches/m5-10a-wave-a2.json', 'Wave B stage previous report path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(stage.source.authorization?.path, 'data/batches/m5-10-wave-b-authorization.json', 'Wave B stage authorization path drifted', 'STAGE_SOURCE_MISMATCH');
  assertEqual(authorization.decision, 'AUTHORIZE WAVE B', 'Wave B stage authorization is not affirmative', 'AUTHORIZATION_MISMATCH');
  return { stage_id: stage.stage_id, imported_start_count: stage.actual.imported_start_count, candidate_buffer: stage.target.candidate_buffer, gate_status: stage.gate_status };
}

export async function validateWaveB({
  manifestPath = DEFAULT_OUTPUT_PATH,
  editorialInputPath = DEFAULT_EDITORIAL_INPUT_PATH,
  auditInputPath = DEFAULT_AUDIT_INPUT_PATH,
  timingInputPath = DEFAULT_TIMING_INPUT_PATH,
  auditTimingInputPath = DEFAULT_AUDIT_TIMING_INPUT_PATH,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
  metricsPath = DEFAULT_METRICS_PATH,
  stagePath = DEFAULT_STAGE_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  baseCanonicalDirectory = DEFAULT_BASE_CANONICAL_DIRECTORY,
  planPath = DEFAULT_PLAN_PATH,
  authorizationPath = DEFAULT_AUTHORIZATION_PATH,
  stagedRecordsPath,
  proposalPath,
} = {}) {
  if (!stagedRecordsPath) fail('Wave B validation requires an external --staged path', 'MISSING_STAGED_PATH');
  const resolvedStagedRecordsPath = path.resolve(stagedRecordsPath);
  assertExternalStagingPath(resolvedStagedRecordsPath);
  const [manifestSource, editorialSource, auditSource, timingSource, auditTimingSource, relationDiffSource, metricsSource, stageSource, verificationSource, planSource, authorizationSource] = await Promise.all([
    readJsonSource(manifestPath, 'Wave B manifest'),
    readJsonSource(editorialInputPath, 'Wave B editorial input'),
    readJsonSource(auditInputPath, 'Wave B audit input'),
    readJsonSource(timingInputPath, 'Wave B timing input'),
    readJsonSource(auditTimingInputPath, 'Wave B audit timing input'),
    readJsonSource(relationDiffPath, 'Wave B relation diff'),
    readJsonSource(metricsPath, 'Wave B metrics'),
    readJsonSource(stagePath, 'Wave B stage'),
    readJsonSource(verificationPath, 'Wave B verification'),
    readJsonSource(planPath, 'M5-8 expansion plan'),
    readJsonSource(authorizationPath, 'Wave B authorization'),
  ]);
  const [canonical, baseCanonical, staged, canonicalSha256] = await Promise.all([
    readCanonicalRecords(canonicalDirectory),
    readCanonicalRecords(baseCanonicalDirectory),
    readCanonicalRecords(resolvedStagedRecordsPath),
    hashCanonicalDirectory(canonicalDirectory),
  ]);
  const editorialDecisionPath = path.resolve(REPOSITORY_DIRECTORY, editorialSource.value.decision_artifact.path);
  const auditDecisionPath = path.resolve(REPOSITORY_DIRECTORY, auditSource.value.decision_artifact.path);
  const [editorialDecisionSource, auditDecisionSource] = await Promise.all([
    readJsonSource(editorialDecisionPath, 'Wave B editorial decision artifact'),
    readJsonSource(auditDecisionPath, 'Wave B audit decision artifact'),
  ]);
  const inventorySummary = await validateTargetInventory();
  assertEqual(inventorySummary.revision, WAVE_B_INVENTORY_REVISION, 'current inventory revision drifted', 'INVENTORY_REVISION_MISMATCH');
  assertEqual(inventorySummary.canonicalRecordCount, canonical.records.length, 'current canonical record count drifted', 'CANONICAL_COUNT_MISMATCH');
  assertEqual(inventorySummary.currentStartCount, WAVE_B_CUMULATIVE_START_COUNT, 'current canonical start count drifted', 'CANONICAL_COUNT_MISMATCH');
  assertEqual(inventorySummary.candidateStartCount, 19, 'current candidate buffer count drifted', 'INVENTORY_COUNT_MISMATCH');
  assertEqual(inventorySummary.heldCount, 40, 'current held count drifted', 'INVENTORY_COUNT_MISMATCH');
  const preimportInventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const editorialInventoryEntries = preimportInventory.entries;
  const proposalRecords = proposalPath ? (await readCanonicalRecords(proposalPath)).records : [];
  if (proposalPath) {
    const proposalBytes = await readFile(proposalPath);
    assertEqual(sha256Bytes(proposalBytes), editorialSource.value.proposal_staging.sha256, 'external proposal digest drifted', 'PROPOSAL_DIGEST_MISMATCH');
    validateProposalStaging(proposalRecords, editorialSource.value);
  }
  const referenceRecords = mergeReferenceRecords(canonical.records, staged.records, proposalRecords);
  const editorial = validateWaveBEditorialInput({ input: editorialSource.value, inventoryEntries: editorialInventoryEntries, referenceRecords });
  const audit = validateWaveBAuditInput({ audit: auditSource.value, editorialInput: editorialSource.value, relationDiff: relationDiffSource.value });
  validateDecisionArtifact(editorialDecisionSource.value, editorialSource.value);
  assertEqual(editorialDecisionSource.sha256, editorialSource.value.decision_artifact.sha256, 'editorial decision artifact digest drifted', 'DECISION_ARTIFACT_BINDING');
  validateAuditDecisionArtifact(auditDecisionSource.value, auditSource.value, editorialSource.value);
  assertEqual(auditDecisionSource.sha256, auditSource.value.decision_artifact.sha256, 'audit decision artifact digest drifted', 'DECISION_ARTIFACT_BINDING');
  await Promise.all([
    validateWaveBProvenanceArtifact({ input: editorialSource.value, subjectKind: 'editorial' }),
    validateWaveBProvenanceArtifact({ input: auditSource.value, subjectKind: 'audit' }),
  ]);
  const expectedUnitIdsByPass = deriveWaveBTimingUnitSets({ editorialInput: editorialSource.value, auditInput: auditSource.value });
  validateWaveBTimingInput(timingSource.value, { timingKind: 'editorial', reviewedStagingSha256: editorialSource.value.reviewed_staging_sha256, auditSessionId: auditSource.value.provenance.session_id, expectedUnitIdsByPass });
  validateWaveBTimingInput(auditTimingSource.value, { timingKind: 'post-freeze-audit', reviewedStagingSha256: editorialSource.value.reviewed_staging_sha256, reviewedStagingPath: resolvedStagedRecordsPath, auditSessionId: auditSource.value.provenance.session_id, expectedUnitIdsByPass });
  validateWaveBTimingDecisionWork({ timingInput: timingSource.value, auditTimingInput: auditTimingSource.value, editorialInput: editorialSource.value, auditInput: auditSource.value });
  validateWaveBChronology({
    editorialInput: editorialSource.value,
    auditInput: auditSource.value,
    timingInput: timingSource.value,
    auditTimingInput: auditTimingSource.value,
  });
  assertEqual(editorialSource.value.timing_artifact.path, relativeSourcePath(timingInputPath), 'editorial timing artifact path drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(editorialSource.value.timing_artifact.sha256, timingSource.sha256, 'editorial timing artifact digest drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(editorialSource.value.timing_artifact.started_at, timingSource.value.passes[0].started_at, 'editorial timing start drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(editorialSource.value.timing_artifact.completed_at, timingSource.value.passes.at(-1).completed_at, 'editorial timing completion drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.editorial_timing_artifact.path, relativeSourcePath(timingInputPath), 'audit editorial timing path drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.editorial_timing_artifact.sha256, timingSource.sha256, 'audit editorial timing digest drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.path, relativeSourcePath(auditTimingInputPath), 'audit timing artifact path drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.sha256, auditTimingSource.sha256, 'audit timing artifact digest drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.started_at, auditTimingSource.value.passes[0].started_at, 'audit timing start drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.completed_at, auditTimingSource.value.passes[0].completed_at, 'audit timing completion drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.audit_session_id, auditSource.value.provenance.session_id, 'audit timing session drifted', 'TIMING_ARTIFACT_BINDING');
  assertEqual(auditSource.value.timing_artifact.reviewed_staging_sha256, editorialSource.value.reviewed_staging_sha256, 'audit timing staging digest drifted', 'TIMING_ARTIFACT_BINDING');
  validateRelationDiff(relationDiffSource.value);
  assertEqual(relationDiffSource.value.batch_id, WAVE_B_BATCH_ID, 'Wave B relation diff batch_id drifted', 'BATCH_ID_MISMATCH');
  assertEqual({ before_count: relationDiffSource.value.before_count, after_count: relationDiffSource.value.after_count, event_count: relationDiffSource.value.events.length }, { before_count: 0, after_count: 0, event_count: 0 }, 'Wave B relation diff must remain empty', 'RELATION_DIFF_NOT_EMPTY');
  validateBatchManifest(manifestSource.value);
  const projectedManifest = createWaveBManifest({
    editorialInput: editorialSource.value,
    auditInput: auditSource.value,
    timingInput: timingSource.value,
    auditTimingInput: auditTimingSource.value,
    relationDiffSource: { ...relationDiffSource, path: relativeSourcePath(relationDiffPath) },
    editorialInputSource: { path: relativeSourcePath(editorialInputPath), sha256: editorialSource.sha256 },
    auditInputSource: { path: relativeSourcePath(auditInputPath), sha256: auditSource.sha256 },
    timingInputSource: { path: relativeSourcePath(timingInputPath), sha256: timingSource.sha256 },
    auditTimingInputSource: { path: relativeSourcePath(auditTimingInputPath), sha256: auditTimingSource.sha256 },
    reviewedStagingPath: resolvedStagedRecordsPath,
  });
  assertEqual(manifestSource.value, projectedManifest, 'Wave B manifest differs from explicit input artifacts', 'MANIFEST_DRIFT');
  const batchResult = await validateBatch({ manifestPath, stagedRecordsPath: resolvedStagedRecordsPath, inventoryPath, canonicalDirectory: baseCanonicalDirectory });
  exactIds(staged.records.map(recordOf).map(({ id }) => id), WAVE_B_IMPORTED_CANONICAL_IDS, 'Wave B reviewed staging');
  assertEqual(staged.records.length, WAVE_B_IMPORTED_START_COUNT, 'Wave B reviewed staging count drifted', 'STAGED_COUNT_MISMATCH');
  const verification = verificationSource.value;
  assertEqual(verification.schema_version, '1', 'Wave B verification schema version drifted', 'VERIFICATION_MISMATCH');
  assertEqual(verification.batch_id, WAVE_B_BATCH_ID, 'Wave B verification batch_id drifted', 'VERIFICATION_MISMATCH');
  for (const key of ['editorial_review_complete', 'canonical_integrity', 'deterministic_sqlite', 'search_product_regression']) assertEqual(verification[key], true, `Wave B verification ${key} failed`, 'VERIFICATION_FAILED');
  assertEqual(verification.human_editorial_review_complete, false, 'Wave B human review attribution drifted', 'VERIFICATION_ATTRIBUTION_MISMATCH');
  const regeneratedMetrics = createMetricsArtifact({
    manifest: manifestSource.value,
    relationDiff: relationDiffSource.value,
    canonicalRecords: canonical.records,
    source: metricsSource.value.source,
  });
  assertMetricsMatch(metricsSource.value, regeneratedMetrics);
  assertEqual(metricsSource.value.derived.selection, { selected_start_count: 170, processed_start_count: 160 }, 'Wave B metrics selection drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.decisions, regeneratedMetrics.derived.decisions, 'Wave B metrics decisions drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.canonical_import, regeneratedMetrics.derived.canonical_import, 'Wave B canonical import metrics drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.relation_diff.before_count, 0, 'Wave B relation metrics before_count drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.relation_diff.after_count, 0, 'Wave B relation metrics after_count drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.timing.status, 'complete', 'Wave B metrics timing is incomplete', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.timing.unmeasured_passes, [], 'Wave B metrics contains unmeasured passes', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.audit, { status: 'complete', independent: true, finding_count: 5, open_finding_count: 0, open_blocker_count: 0, finding_counts: { sense: 3, 'timing-measurement': 1, 'reference-closure': 1 } }, 'Wave B audit metrics drifted', 'METRICS_DRIFT');
  const expectedGate = evaluateExpansionGate(createWaveBStageMetrics(metricsSource.value, verification), planSource.value);
  const stageResult = validateStage(stageSource.value, {
    metrics: metricsSource.value,
    verification,
    manifestSource: { path: manifestPath, sha256: manifestSource.sha256 },
    metricsSource: { path: metricsPath, sha256: metricsSource.sha256 },
    relationDiffSource: { path: relationDiffPath, sha256: relationDiffSource.sha256 },
    verificationSource: { path: verificationPath, sha256: verificationSource.sha256 },
    canonicalSnapshot: canonicalSummary(canonical.records),
    canonicalDirectory,
    canonicalSha256,
    previousStage: JSON.parse(await readFile(path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2.json'), 'utf8')),
    previousStageSha256: sha256Bytes(await readFile(path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2.json'))),
    authorization: authorizationSource.value,
    authorizationSha256: authorizationSource.sha256,
    expectedGate,
  });
  const previousStagePath = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2.json');
  const previousStage = JSON.parse(await readFile(previousStagePath, 'utf8'));
  const previousStageSha256 = sha256Bytes(await readFile(previousStagePath));
  validateAuthorization(authorizationSource.value, previousStage, previousStageSha256, editorialSource.value.proposal_staging.sha256);
  assertEqual(canonicalSummary(baseCanonical.records), { record_count: 670, start_count: 628, reference_only_count: 42, sense_count: 809, relation_count: 473, expression_count: 43 }, 'Wave B base canonical snapshot drifted', 'BASE_CANONICAL_MISMATCH');
  const baseSummary = canonicalSummary(baseCanonical.records);
  const importSummary = metricsSource.value.derived.canonical_import;
  assertEqual(canonicalSummary(canonical.records), {
    record_count: baseSummary.record_count + importSummary.imported_record_count,
    start_count: baseSummary.start_count + importSummary.imported_start_count,
    reference_only_count: baseSummary.reference_only_count + importSummary.imported_reference_only_count,
    sense_count: baseSummary.sense_count + importSummary.imported_sense_count,
    relation_count: baseSummary.relation_count + importSummary.imported_relation_count,
    expression_count: baseSummary.expression_count + importSummary.imported_expression_count,
  }, 'Wave B final canonical snapshot drifted', 'CANONICAL_MISMATCH');
  return {
    batch: { batch_id: WAVE_B_BATCH_ID, validation_status: 'validated', selected_start_count: editorial.selectedStartCount, processed_start_count: editorial.processedStartCount, imported_start_count: batchResult.stagedRecordCount, staged_record_count: staged.records.length },
    metrics: metricsSource.value.derived,
    stage: stageResult,
    gate: expectedGate,
    inventory: inventorySummary,
    baseCanonical: canonicalSummary(baseCanonical.records),
    canonical: canonicalSummary(canonical.records),
    audit: { independent: audit.verified, finding_count: audit.findingCount },
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  validateWaveB({
    manifestPath: args.manifest ?? DEFAULT_OUTPUT_PATH,
    editorialInputPath: args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH,
    auditInputPath: args.audit ?? DEFAULT_AUDIT_INPUT_PATH,
    timingInputPath: args.timing ?? DEFAULT_TIMING_INPUT_PATH,
    auditTimingInputPath: args['audit-timing'] ?? DEFAULT_AUDIT_TIMING_INPUT_PATH,
    relationDiffPath: args.relation ?? DEFAULT_RELATION_DIFF_PATH,
    metricsPath: args.metrics ?? DEFAULT_METRICS_PATH,
    stagePath: args.stage ?? DEFAULT_STAGE_PATH,
    verificationPath: args.verification ?? DEFAULT_VERIFICATION_PATH,
    inventoryPath: args.inventory ?? DEFAULT_INVENTORY_PATH,
    canonicalDirectory: args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY,
    baseCanonicalDirectory: args['base-canonical-dir'] ?? DEFAULT_BASE_CANONICAL_DIRECTORY,
    planPath: args.plan ?? DEFAULT_PLAN_PATH,
    authorizationPath: args.authorization ?? DEFAULT_AUTHORIZATION_PATH,
    stagedRecordsPath: args.staged,
    proposalPath: args.proposal,
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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

export const WAVE_B_TIMING_WORK_UNIT_CONTRACT = Object.freeze({
  'target-preparation': {
    unit_kind: 'selected-target',
    unit_ids: WAVE_B_SELECTED_INVENTORY_IDS,
  },
  'initial-review': {
    unit_kind: 'boundary-check',
    unit_ids: WAVE_B_SELECTED_INVENTORY_IDS.slice(0, WAVE_B_IMPORTED_START_COUNT).flatMap((inventoryId) => (
      M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => `${inventoryId}:${boundaryId}`)
    )),
  },
  'feedback-fixes': {
    unit_kind: 'sense-correction',
    unit_ids: WAVE_B_IMPORTED_CANONICAL_IDS,
  },
  'final-audit': {
    unit_kind: 'final-audit-item',
    unit_ids: WAVE_B_IMPORTED_CANONICAL_IDS,
  },
  'held-rejected': {
    unit_kind: 'buffer-decision',
    unit_ids: WAVE_B_BUFFER_INVENTORY_IDS,
  },
  'post-freeze-audit': {
    unit_kind: 'post-freeze-audit-item',
    unit_ids: [
      ...WAVE_B_IMPORTED_CANONICAL_IDS,
      ...WAVE_B_BUFFER_INVENTORY_IDS,
      'wave-b-relation-screen',
      'wave-b-timing-completeness',
    ],
  },
});

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

export function createWaveBTimingProof(timing) {
  const copy = structuredClone(timing);
  delete copy.recording_proof_sha256;
  return sha256Bytes(Buffer.from(JSON.stringify(copy), 'utf8'));
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

function validateBoundaryEvidence(evidence, inventoryId, proposalId, label) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail(`${label} must be an object`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.review_status, 'reviewed', `${label}.review_status must be reviewed`, 'UNREVIEWED_BOUNDARY');
  if (!['applicable', 'not-applicable'].includes(evidence.applicability)) fail(`${label}.applicability is invalid`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.decision, 'keep', `${label}.decision must be keep`, 'INVALID_BOUNDARY_DECISION');
  if (!Array.isArray(evidence.candidate_sense_ids) || evidence.candidate_sense_ids.length !== 1) fail(`${label}.candidate_sense_ids must contain one sense`, 'INVALID_BOUNDARY_EVIDENCE');
  assertEqual(evidence.candidate_sense_ids, [`${proposalId}-s1`], `${label}.candidate_sense_ids drifted`, 'BOUNDARY_SENSE_MISMATCH');
  if (!Array.isArray(evidence.contrasts) || evidence.contrasts.length !== 0) fail(`${label}.contrasts must be an explicit empty array for the single-sense scope`, 'UNEXPECTED_BOUNDARY_CONTRAST');
  requireString(evidence.rationale, `${label}.rationale`);
  for (const token of [inventoryId, proposalId, `${proposalId}-s1`]) {
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

function validateRecordReview(recordReview, index, inventoryEntries, referenceById) {
  const expectedInventoryId = WAVE_B_SELECTED_INVENTORY_IDS[index];
  assertEqual(recordReview.inventory_id, expectedInventoryId, `editorial record ${index} inventory scope drifted`, 'EDITORIAL_SCOPE_MISMATCH');
  const imported = index < WAVE_B_IMPORTED_START_COUNT;
  const expectedProposalId = WAVE_B_PROPOSAL_CANONICAL_IDS[index];
  const expectedDecision = imported ? 'included' : index < 160 ? 'held' : 'deferred';
  const reviewed = index < WAVE_B_IMPORTED_START_COUNT;
  assertEqual(recordReview.proposal_canonical_id, expectedProposalId, `${expectedInventoryId} proposal canonical ID drifted`, 'PROPOSAL_SCOPE_MISMATCH');
  assertEqual(recordReview.decision, expectedDecision, `${expectedInventoryId} decision drifted`, 'EDITORIAL_DECISION_MISMATCH');
  if (imported) assertEqual(recordReview.canonical_id, expectedProposalId, `${expectedInventoryId} canonical ID drifted`, 'CANONICAL_SCOPE_MISMATCH');
  else if (Object.hasOwn(recordReview, 'canonical_id')) fail(`${expectedInventoryId} buffer decision must not carry canonical_id`, 'BUFFER_CANONICAL_LEAK');
  const inventoryEntry = inventoryEntries.get(expectedInventoryId);
  if (!inventoryEntry) fail(`${expectedInventoryId} is missing from target inventory`, 'MISSING_INVENTORY_TARGET');
  const reference = referenceById.get(expectedProposalId);
  const expectedLemma = reference?.lemma ?? inventoryEntry.lemma;
  const expectedPos = reviewed
    ? reference?.senses?.map(({ pos }) => pos) ?? inventoryEntry.pos
    : [];
  assertEqual(recordReview.observed_sense_count, reviewed ? 1 : 0, `${expectedInventoryId} sense review scope drifted`, 'SENSE_SCOPE_MISMATCH');
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
  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    const label = `${expectedInventoryId}.boundary_evidence.${boundaryId}`;
    if (reviewed) {
      validateBoundaryEvidence(recordReview.boundary_evidence[boundaryId], expectedInventoryId, expectedProposalId, label);
    } else {
      validateUnreviewedBoundaryEvidence(recordReview.boundary_evidence[boundaryId], expectedInventoryId, expectedProposalId, label);
    }
  }
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
  assertEqual(input.sense_review?.scoped_single_sense_count, WAVE_B_IMPORTED_START_COUNT, 'Wave B single-sense count drifted', 'SENSE_SCOPE_MISMATCH');
  assertEqual(input.sense_review?.split_record_count, 0, 'Wave B must not claim split records', 'SENSE_SCOPE_MISMATCH');
  assertEqual(input.sense_review?.split_canonical_ids, [], 'Wave B split canonical scope must be empty', 'SENSE_SCOPE_MISMATCH');
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
  if (!Array.isArray(input.records)) fail('Wave B editorial records must be an array', 'INVALID_EDITORIAL_RECORDS');
  exactIds(input.records.map(({ inventory_id: id }) => id), WAVE_B_SELECTED_INVENTORY_IDS, 'editorial record');
  for (const [index, recordReview] of input.records.entries()) validateRecordReview(recordReview, index, entries, referenceById);
  const counts = Object.fromEntries(DECISIONS.map((decision) => [decision, input.records.filter((record) => record.decision === decision).length]));
  assertEqual(counts, { included: 150, corrected: 0, held: 10, rejected: 0, deferred: 10 }, 'Wave B editorial decision counts drifted', 'EDITORIAL_DECISION_COUNTS');
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
  exactIds(decisionArtifact.findings?.map(({ id }) => id), [
    'wave-b-audit-scope',
    'wave-b-audit-relation-screen',
    'wave-b-audit-buffer',
    'wave-b-audit-timing',
    'wave-b-audit-determinism',
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
    'wave-b-audit-scope',
    'wave-b-audit-relation-screen',
    'wave-b-audit-buffer',
    'wave-b-audit-timing',
    'wave-b-audit-determinism',
  ], 'Wave B audit findings');
  for (const finding of audit.findings) {
    if (!['sense', 'relation-noise', 'timing-measurement', 'reference-closure'].includes(finding.category)) fail(`${finding.id} has an invalid audit category`, 'AUDIT_FINDING_CATEGORY');
    assertEqual(finding.status, 'resolved', `${finding.id} must be resolved`, 'OPEN_AUDIT_FINDING');
    if (finding.severity === 'blocker') fail(`${finding.id} cannot be a blocker in a passing audit`, 'OPEN_AUDIT_BLOCKER');
    if (!Array.isArray(finding.evidence_refs) || finding.evidence_refs.length === 0) fail(`${finding.id} lacks evidence_refs`, 'AUDIT_EVIDENCE_MISSING');
    requireString(finding.note, `${finding.id}.note`);
  }
  return { verified: true, findingCount: audit.findings.length, openBlockerCount: 0 };
}

function validateTimingPass(pass, passId, expectedSha256, expectedAuditSessionId) {
  assertEqual(pass.id, passId, `${passId} timing pass ID drifted`, 'TIMING_SCOPE_MISMATCH');
  assertEqual(pass.status, 'complete', `${passId} timing pass is not complete`, 'TIMING_INCOMPLETE');
  requireIsoDate(pass.started_at, `${passId}.started_at`);
  requireIsoDate(pass.completed_at, `${passId}.completed_at`);
  requireUuid(pass.session_id, `${passId}.session_id`);
  assertEqual(pass.recording_source, 'timing-recorder-v1', `${passId}.recording_source drifted`, 'TIMING_PROVENANCE_MISMATCH');
  const elapsed = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) fail(`${passId} timing chronology is invalid`, 'TIMING_CHRONOLOGY');
  assertEqual(pass.wall_clock_seconds, elapsed, `${passId}.wall_clock_seconds drifted from timestamps`, 'TIMING_DURATION_DRIFT');
  assertEqual(pass.editor_seconds, elapsed, `${passId}.editor_seconds drifted from timestamps`, 'TIMING_DURATION_DRIFT');
  const contract = WAVE_B_TIMING_WORK_UNIT_CONTRACT[passId];
  assertEqual(pass.work_evidence?.unit_kind, contract.unit_kind, `${passId} work evidence kind drifted`, 'TIMING_WORK_EVIDENCE_MISMATCH');
  assertEqual(pass.work_evidence?.unit_count, contract.unit_ids.length, `${passId} work evidence count drifted`, 'TIMING_WORK_EVIDENCE_MISMATCH');
  exactIds(pass.work_evidence?.unit_ids, contract.unit_ids, `${passId} work evidence`);
  requireSha256(pass.work_evidence?.before_sha256, `${passId}.work_evidence.before_sha256`);
  requireSha256(pass.work_evidence?.after_sha256, `${passId}.work_evidence.after_sha256`);
  requireString(pass.work_evidence?.note, `${passId}.work_evidence.note`);
  if (passId === 'post-freeze-audit') {
    requireUuid(pass.audit_session_id, `${passId}.audit_session_id`);
    assertEqual(pass.audit_session_id, expectedAuditSessionId, `${passId}.audit_session_id drifted`, 'AUDIT_TIMING_BINDING');
    assertEqual(pass.reviewed_staging_sha256, expectedSha256, `${passId}.reviewed_staging_sha256 drifted`, 'AUDIT_TIMING_BINDING');
  } else if (Object.hasOwn(pass, 'audit_session_id') || Object.hasOwn(pass, 'reviewed_staging_sha256')) {
    fail(`${passId} editorial pass must not carry audit-only binding fields`, 'TIMING_BINDING_MISMATCH');
  }
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
  assertTimestampOrder(editorialLast, editorialInput.decision_artifact.finalized_at, 'editorial timing and decision finalization', 'EDITORIAL_DECISION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(editorialInput.decision_artifact.finalized_at, editorialInput.completed_at, 'editorial decision and completion', 'EDITORIAL_COMPLETION_CHRONOLOGY', { strict: true });
  assertEqual(editorialInput.timing_artifact.started_at, editorialFirst, 'editorial timing start binding drifted', 'EDITORIAL_TIMING_BINDING');
  assertEqual(editorialInput.timing_artifact.completed_at, editorialLast, 'editorial timing completion binding drifted', 'EDITORIAL_TIMING_BINDING');

  assertTimestampOrder(editorialInput.completed_at, auditInput.created_at, 'editorial completion and audit session', 'AUDIT_SESSION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditInput.created_at, auditFirst, 'audit session and post-freeze timing', 'AUDIT_TIMING_CHRONOLOGY');
  assertTimestampOrder(editorialInput.completed_at, auditFirst, 'editorial completion and post-freeze audit', 'AUDIT_TIMING_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditLast, auditInput.decision_artifact.finalized_at, 'audit timing and decision finalization', 'AUDIT_DECISION_CHRONOLOGY', { strict: true });
  assertTimestampOrder(auditInput.decision_artifact.finalized_at, auditInput.completed_at, 'audit decision and completion', 'AUDIT_COMPLETION_CHRONOLOGY', { strict: true });
  assertEqual(auditInput.editorial_timing_artifact.started_at, editorialFirst, 'audit editorial timing start binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.editorial_timing_artifact.completed_at, editorialLast, 'audit editorial timing completion binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.timing_artifact.started_at, auditFirst, 'audit timing start binding drifted', 'AUDIT_TIMING_BINDING');
  assertEqual(auditInput.timing_artifact.completed_at, auditLast, 'audit timing completion binding drifted', 'AUDIT_TIMING_BINDING');
  return { editorialFirst, editorialLast, auditFirst, auditLast };
}

export function validateWaveBTimingInput(timing, { timingKind, reviewedStagingSha256, auditSessionId } = {}) {
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) fail('Wave B timing input must be an object', 'INVALID_TIMING_INPUT');
  assertEqual(timing.schema_version, '1', 'Wave B timing schema version drifted', 'SCHEMA_VERSION');
  assertEqual(timing.batch_id, WAVE_B_BATCH_ID, 'Wave B timing batch_id drifted', 'BATCH_ID_MISMATCH');
  assertEqual(timing.timing_kind, timingKind, 'Wave B timing kind drifted', 'TIMING_KIND_MISMATCH');
  assertEqual(timing.recorder_version, 'wave-b-timing-recorder-v1', 'Wave B timing recorder version drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.recording_source, 'timing-recorder-v1', 'Wave B timing recording source drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.recorder_command, 'node scripts/batch/record-m5-10-wave-b-timing.mjs', 'Wave B timing recorder command drifted', 'TIMING_PROVENANCE_MISMATCH');
  assertEqual(timing.status, 'complete', 'Wave B timing is not complete', 'TIMING_INCOMPLETE');
  requireUuid(timing.session_id, 'timing session_id');
  requireString(timing.timing_id, 'timing_id');
  assertEqual(timing.processed_start_count, WAVE_B_PROCESSED_START_COUNT, 'Wave B timing processed count drifted', 'PROCESSED_COUNT_MISMATCH');
  const expectedPassIds = timingKind === 'editorial' ? WAVE_B_TIMING_PASS_IDS : WAVE_B_AUDIT_TIMING_PASS_IDS;
  exactIds(timing.passes?.map(({ id }) => id), expectedPassIds, `${timingKind} timing passes`);
  for (const pass of timing.passes) validateTimingPass(pass, pass.id, reviewedStagingSha256, auditSessionId);
  for (let index = 1; index < timing.passes.length; index += 1) {
    assertTimestampOrder(
      timing.passes[index - 1].completed_at,
      timing.passes[index].started_at,
      `${timingKind} timing passes`,
      'TIMING_CHRONOLOGY',
    );
  }
  if (!Array.isArray(timing.events) || timing.events.length !== expectedPassIds.length * 2) fail(`${timingKind} timing event count drifted`, 'TIMING_EVENT_COVERAGE');
  const expectedEvents = timing.passes.flatMap((pass, index) => ([
    { event_id: `m5-10-wave-b-timing-event-${String(index * 2 + 1).padStart(4, '0')}`, pass_id: pass.id, kind: 'start', session_id: pass.session_id, at: pass.started_at },
    { event_id: `m5-10-wave-b-timing-event-${String(index * 2 + 2).padStart(4, '0')}`, pass_id: pass.id, kind: 'stop', session_id: pass.session_id, at: pass.completed_at },
  ]));
  assertEqual(timing.events, expectedEvents, `${timingKind} timing events drifted from pass timestamps`, 'TIMING_EVENT_BINDING');
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
      sense_ids: [`${canonicalId}-s1`],
    }];
  }));
}

function preflightCheckpoint(recordReview, processed) {
  const imported = recordReview.decision === 'included';
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

export function createWaveBManifest({ editorialInput, auditInput, timingInput, auditTimingInput, relationDiffSource, editorialInputSource, auditInputSource, timingInputSource, auditTimingInputSource } = {}) {
  validateWaveBAuditInput({ audit: auditInput, editorialInput, relationDiff: relationDiffSource.value });
  validateWaveBTimingInput(timingInput, { timingKind: 'editorial', reviewedStagingSha256: editorialInput.reviewed_staging_sha256, auditSessionId: auditInput.provenance.session_id });
  validateWaveBTimingInput(auditTimingInput, { timingKind: 'post-freeze-audit', reviewedStagingSha256: editorialInput.reviewed_staging_sha256, auditSessionId: auditInput.provenance.session_id });
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
      scoped_single_sense_count: WAVE_B_IMPORTED_START_COUNT,
      split_record_count: 0,
      split_canonical_ids: [],
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
        contract_version: 'm5-10a-v1',
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
      if (recordReview.decision === 'included') record.canonical_id = recordReview.canonical_id;
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
  for (const recordInfo of proposalRecords) {
    const record = recordOf(recordInfo);
    if (record.role !== 'start' || record.senses.length !== 1) fail(`proposal ${record.id} is outside the single-sense start scope`, 'PROPOSAL_RECORD_MISMATCH');
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
  assertEqual(stage.decisions, { included_start_count: 150, corrected_start_count: 0, held_start_count: 10, rejected_start_count: 0, deferred_start_count: 10 }, 'Wave B stage decisions drifted', 'STAGE_DECISION_MISMATCH');
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
  assertExternalStagingPath(stagedRecordsPath);
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
    readCanonicalRecords(stagedRecordsPath),
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
  assertEqual(inventorySummary.canonicalRecordCount, 820, 'current canonical record count drifted', 'CANONICAL_COUNT_MISMATCH');
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
  validateWaveBTimingInput(timingSource.value, { timingKind: 'editorial', reviewedStagingSha256: editorialSource.value.reviewed_staging_sha256, auditSessionId: auditSource.value.provenance.session_id });
  validateWaveBTimingInput(auditTimingSource.value, { timingKind: 'post-freeze-audit', reviewedStagingSha256: editorialSource.value.reviewed_staging_sha256, auditSessionId: auditSource.value.provenance.session_id });
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
  });
  assertEqual(manifestSource.value, projectedManifest, 'Wave B manifest differs from explicit input artifacts', 'MANIFEST_DRIFT');
  const batchResult = await validateBatch({ manifestPath, stagedRecordsPath, inventoryPath, canonicalDirectory: baseCanonicalDirectory });
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
  assertEqual(metricsSource.value.derived.decisions, {
    included: 150, corrected: 0, held: 10, rejected: 0, deferred: 10, importable_start_count: 150,
    correction_rate_of_selected: 0, correction_rate_of_importable: 0, held_rate: 10 / 160, rejected_rate: 0, held_or_rejected_rate: 10 / 160,
    sense_field_correction_count: 0, relation_field_correction_count: 0,
  }, 'Wave B metrics decisions drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.canonical_import, { imported_start_count: 150, imported_reference_only_count: 0, imported_record_count: 150, imported_sense_count: 150, imported_relation_count: 0, imported_expression_count: 20, relation_type_counts: {} }, 'Wave B canonical import metrics drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.relation_diff.before_count, 0, 'Wave B relation metrics before_count drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.relation_diff.after_count, 0, 'Wave B relation metrics after_count drifted', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.timing.status, 'complete', 'Wave B metrics timing is incomplete', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.timing.unmeasured_passes, [], 'Wave B metrics contains unmeasured passes', 'METRICS_DRIFT');
  assertEqual(metricsSource.value.derived.audit, { status: 'complete', independent: true, finding_count: 5, open_finding_count: 0, open_blocker_count: 0, finding_counts: { sense: 2, 'relation-noise': 1, 'timing-measurement': 1, 'reference-closure': 1 } }, 'Wave B audit metrics drifted', 'METRICS_DRIFT');
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
  assertEqual(canonicalSummary(canonical.records), { record_count: 820, start_count: 778, reference_only_count: 42, sense_count: 959, relation_count: 473, expression_count: 63 }, 'Wave B final canonical snapshot drifted', 'CANONICAL_MISMATCH');
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

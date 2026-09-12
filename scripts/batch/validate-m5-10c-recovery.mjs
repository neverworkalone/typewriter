import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { M5_10C_PRODUCER_VERSION } from './produce-m5-10c-work.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');

export const M5_10C_BATCH_ID = 'm5-10c-editor-time-recovery-20260910';
export const M5_10C_PROCESS_REVISION = 'm5-10c-editor-time-recovery-v1';
export const M5_10C_CASE_COUNT = 20;
export const M5_10C_PROCESSED_START_COUNT = 20;
export const M5_10C_BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
export const M5_10C_EDITORIAL_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);
export const M5_10C_AUDIT_PASS_IDS = Object.freeze(['post-freeze-audit']);
export const M5_10C_CANONICAL_SNAPSHOT = Object.freeze({
  record_count: 820,
  start_count: 778,
  reference_only_count: 42,
  sense_count: 966,
  relation_count: 473,
  expression_count: 63,
});
export const M5_10C_RELATION_NOISE_BASELINE = 51 / 139;
export const M5_10C_EDITOR_SECONDS_PER_PROCESSED_START_MAX = 12;
export const M5_10C_RELATION_NOISE_RATE_MAX = 0.25;
export const M5_10C_CORRECTION_RATE_MAX = 0.5;

export const DEFAULT_PROPOSAL_ARTIFACT = 'external:m5-10c-calibration-proposal';
export const DEFAULT_PROPOSAL_PATH = '/private/tmp/typewriter-m5-10c-calibration-proposal.json';
export const DEFAULT_EDITORIAL_SESSION_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-editorial-session.json');
export const DEFAULT_EDITORIAL_TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-editorial-timing-20260910.json');
export const DEFAULT_EDITORIAL_DECISIONS_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-editorial-decisions-20260910.json');
export const DEFAULT_AUDIT_SESSION_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-audit-session.json');
export const DEFAULT_AUDIT_TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-audit-timing-20260910.json');
export const DEFAULT_AUDIT_DECISIONS_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-audit-decisions-20260910.json');
export const DEFAULT_RECOVERY_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-recovery.json');
export const DEFAULT_AUTHORIZATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-m5-11-authorization-20260910.json');
export const DEFAULT_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-verification.json');
export const DEFAULT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
export const DEFAULT_INVENTORY_PATH = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-inventory.json');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CASE_ID_PATTERN = /^m5-10c-cal-[0-9]{3}$/u;
const RECORD_ID_PATTERN = /^cal-m5-10c-[0-9]{3}$/u;
const SENSE_ID_PATTERN = /^cal-m5-10c-[0-9]{3}-s[0-9]+$/u;
const FORBIDDEN_PROPOSAL_KEYS = Object.freeze([
  'decision',
  'verdict',
  'clean',
  'noise_assessment',
  'correction',
  'audit',
  'approved',
  'included',
  'rejected',
  'held',
  'status',
]);

const requireSchema = createRequire(import.meta.url);
const schemaOptions = {
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
};
const proposalValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-calibration-proposal.schema.json'));
const editorialValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-editorial-decisions.schema.json'));
const auditValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-audit-decisions.schema.json'));
const recoveryValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-recovery.schema.json'));
const authorizationValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-authorization.schema.json'));
const timingValidator = new Ajv2020(schemaOptions).compile(requireSchema('../../schema/m5-10c-timing.schema.json'));

export class M5CRecoveryValidationError extends Error {
  constructor(message, code = 'M5_10C_RECOVERY_VALIDATION_ERROR') {
    super(message);
    this.name = 'M5CRecoveryValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_10C_RECOVERY_VALIDATION_ERROR') {
  throw new M5CRecoveryValidationError(message, code);
}

function schemaPath(error, root) {
  const parts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') parts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') parts.push(error.params.additionalProperty);
  return parts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    root,
  );
}

function validateSchema(value, validator, root, label, code = 'SCHEMA_ERROR') {
  if (validator(value)) return;
  const error = validator.errors?.[0];
  fail(
    error
      ? `${label} schema validation failed at ${schemaPath(error, root)} ${error.message}`
      : `${label} schema validation failed`,
    code,
  );
}

function assertEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function requireString(value, label, code = 'INVALID_VALUE') {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`, code);
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest`, 'INVALID_DIGEST');
  return value;
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${label} must be a UUID v4`, 'INVALID_SESSION_ID');
  return value;
}

function requireTimestamp(value, label) {
  requireString(value, label, 'INVALID_TIMESTAMP');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, 'INVALID_TIMESTAMP');
  }
  return value;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function resolveRepositoryPath(value, label) {
  requireString(value, label, 'SOURCE_PATH_MISMATCH');
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${label} must remain inside the repository`, 'SOURCE_PATH_MISMATCH');
  return resolved;
}

function resolveAnyPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_DIRECTORY, value);
}

async function readSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFileAsync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_SOURCE_JSON');
  }
  return { value, bytes, sha256: sha256Bytes(bytes), path: filePath };
}

function readSyncBytes(filePath, label) {
  try {
    return readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    throw error;
  }
}

function assertNoProposalVerdicts(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PROPOSAL_KEYS.includes(key)) fail(`${label} contains producer/editorial verdict key ${key}`, 'PRODUCER_VERDICT_FORBIDDEN');
    assertNoProposalVerdicts(child, `${label}.${key}`);
  }
}

function recordDigest(record) {
  return sha256Json(record);
}

function caseIds(proposal) {
  return proposal.cases.map(({ case_id: caseId }) => caseId);
}

function assertExactIds(actual, expected, label, code = 'CASE_COVERAGE_MISMATCH') {
  assertEqual(actual, expected, `${label} coverage drifted`, code);
  if (new Set(actual).size !== actual.length) fail(`${label} contains duplicate IDs`, code);
}

function recordById(proposal) {
  return new Map(proposal.cases.map((item) => [item.record.id, item.record]));
}

function senseIndex(proposal) {
  const result = new Map();
  for (const item of proposal.cases) {
    for (const sense of item.record.senses) result.set(sense.id, { caseRecord: item, record: item.record, sense });
  }
  return result;
}

function validateProposalRelations(proposal) {
  const records = recordById(proposal);
  const senses = senseIndex(proposal);
  for (const item of proposal.cases) {
    assertNoProposalVerdicts(item, `${item.case_id} proposal`);
    if (!CASE_ID_PATTERN.test(item.case_id)) fail(`${item.case_id} is not an M5-10C case`, 'PROPOSAL_SCOPE_MISMATCH');
    if (!RECORD_ID_PATTERN.test(item.record.id)) fail(`${item.case_id} proposal record is not calibration-only`, 'PROPOSAL_SCOPE_MISMATCH');
    const caseNumber = item.case_id.slice(-3);
    assertEqual(item.record.id, `cal-m5-10c-${caseNumber}`, `${item.case_id} record identity`, 'PROPOSAL_SCOPE_MISMATCH');
    const expectedSensePrefix = `cal-m5-10c-${caseNumber}-`;
    if (item.record.senses.some(({ id }) => !SENSE_ID_PATTERN.test(id) || !id.startsWith(expectedSensePrefix))) {
      fail(`${item.case_id} contains a sense outside its calibration record`, 'PROPOSAL_SCOPE_MISMATCH');
    }
    if (new Set(item.record.senses.map(({ id }) => id)).size !== item.record.senses.length) {
      fail(`${item.case_id} contains duplicate sense IDs`, 'PROPOSAL_SCOPE_MISMATCH');
    }
    if (item.relation_candidate === null || item.relation_candidate === undefined) continue;
    const candidate = item.relation_candidate;
    if (candidate.source_sense && !item.record.senses.some(({ id }) => id === candidate.source_sense)) {
      fail(`${item.case_id} relation candidate source is outside its record`, 'PROPOSAL_RELATION_MISMATCH');
    }
    if (!records.has(candidate.target_record) || !senses.has(candidate.target_sense)) {
      fail(`${item.case_id} relation candidate target is outside the calibration sample`, 'PROPOSAL_RELATION_MISMATCH');
    }
    if (records.get(candidate.target_record).senses.every(({ id }) => id !== candidate.target_sense)) {
      fail(`${item.case_id} relation candidate target sense does not belong to its target record`, 'PROPOSAL_RELATION_MISMATCH');
    }
    assertEqual(candidate.direction, { from: candidate.source_sense, to: candidate.target_sense }, `${item.case_id} relation direction`, 'PROPOSAL_RELATION_MISMATCH');
    if (candidate.target_record === item.record.id) fail(`${item.case_id} relation candidate self-references`, 'PROPOSAL_RELATION_MISMATCH');
  }
}

export function validateM5CProposal(proposal, { canonicalRecords = [] } = {}) {
  validateSchema(proposal, proposalValidator, 'proposal', 'M5-10C calibration proposal', 'PROPOSAL_SCHEMA_ERROR');
  assertEqual(proposal.process_revision, M5_10C_PROCESS_REVISION, 'proposal process revision drifted', 'PROPOSAL_SCOPE_MISMATCH');
  assertEqual(proposal.case_count, M5_10C_CASE_COUNT, 'proposal case count drifted', 'CASE_COVERAGE_MISMATCH');
  assertExactIds(caseIds(proposal), Array.from({ length: M5_10C_CASE_COUNT }, (_, index) => `m5-10c-cal-${String(index + 1).padStart(3, '0')}`), 'proposal cases');
  validateProposalRelations(proposal);
  const canonicalIds = new Set(canonicalRecords.map((entry) => (entry.record ?? entry).id));
  for (const item of proposal.cases) {
    if (canonicalIds.has(item.record.id)) fail(`${item.case_id} proposal record entered canonical data`, 'CALIBRATION_CANONICAL_MUTATION');
    if (item.record.senses.some(({ id }) => canonicalRecords.some((entry) => (entry.record ?? entry).senses.some((sense) => sense.id === id)))) {
      fail(`${item.case_id} proposal sense entered canonical data`, 'CALIBRATION_CANONICAL_MUTATION');
    }
  }
  const compactCases = proposal.cases.map((item) => ({
    phase: 'proposal',
    case_id: item.case_id,
    record_id: item.record.id,
    source_record_sha256: recordDigest(item.record),
    source_sense_ids: item.record.senses.map(({ id }) => id),
    source_pos: item.record.senses.map(({ pos }) => pos),
    relation_candidate: item.relation_candidate ?? null,
  }));
  return {
    proposal,
    case_ids: caseIds(proposal),
    compact_cases: compactCases,
    by_case: new Map(proposal.cases.map((item, index) => [item.case_id, { ...item, compact: compactCases[index] }])),
    by_record_id: recordById(proposal),
    source_record_digests: new Map(proposal.cases.map((item) => [item.case_id, recordDigest(item.record)])),
  };
}

function timingPassIds(timing) {
  return timing.timing_kind === 'editorial' ? M5_10C_EDITORIAL_PASS_IDS : M5_10C_AUDIT_PASS_IDS;
}

function workRowsForPass(timing, pass) {
  const evidence = pass.work_evidence;
  if (!evidence || typeof evidence !== 'object') fail(`${pass.id} is missing recorder work evidence`, 'TIMING_INCOMPLETE');
  const logPath = resolveAnyPath(evidence.path);
  const bytes = readSyncBytes(logPath, `${pass.id} timing work log`);
  if (bytes.length > 0 && bytes.at(-1) !== 10) fail(`${pass.id} timing work log is not newline-terminated`, 'TIMING_WORK_LOG_INVALID');
  const rows = bytes.length === 0
    ? []
    : bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`${pass.id} timing work log line ${index + 1} is invalid JSON: ${error.message}`, 'TIMING_WORK_LOG_INVALID');
      }
    });
  assertEqual(sha256Bytes(bytes), evidence.sha256, `${pass.id} timing work log digest drifted`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  const workRows = rows.filter((row) => (
    row.kind === 'work'
    && row.pass_id === pass.id
    && row.session_id === timing.session_id
    && row.pass_session_id === pass.session_id
  ));
  assertEqual(workRows.map(({ unit_id: unitId }) => unitId), evidence.unit_ids, `${pass.id} recorder scope`, 'TIMING_SCOPE_MISMATCH');
  if (new Set(evidence.unit_ids).size !== evidence.unit_ids.length) fail(`${pass.id} timing scope contains duplicate unit IDs`, 'TIMING_SCOPE_MISMATCH');
  assertEqual(workRows.length, evidence.unit_count, `${pass.id} timing work count`, 'TIMING_SCOPE_MISMATCH');
  return { rows, workRows, bytes };
}

function validateProposalOnlyWorkRow(row, passId) {
  if (!row.input || typeof row.input !== 'object' || typeof row.input.payload !== 'object') fail(`${passId} work row is missing recorder-bound input`, 'PRODUCER_INPUT_MISSING');
  if (row.input.payload.record || row.input.payload.senses || row.input.payload.lemma || row.input.payload.gloss) {
    fail(`${passId} work row stores raw proposal record content`, 'RAW_PROPOSAL_IN_REPOSITORY');
  }
  assertNoProposalVerdicts(row.input.payload, `${passId}:${row.unit_id} input`);
  if (!row.producer || typeof row.producer !== 'object') fail(`${passId} work row is missing producer execution`, 'PRODUCER_EXECUTION_MISSING');
  assertEqual(row.producer.export, 'produce', `${passId} producer export`, 'PRODUCER_PROVENANCE_MISMATCH');
  if (!String(row.producer.module).endsWith('scripts/batch/produce-m5-10c-work.mjs')) fail(`${passId} used a non-M5-10C producer`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.payload.producer_version, M5_10C_PRODUCER_VERSION, `${passId} producer version`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.payload.proposal_only, true, `${passId} producer output is not proposal-only`, 'PRODUCER_VERDICT_FORBIDDEN');
  assertNoProposalVerdicts(row.payload, `${passId}:${row.unit_id} producer output`);
  assertEqual(row.producer.input_payload_sha256, row.input.payload_sha256, `${passId}:${row.unit_id} producer input digest`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.producer.output_sha256, sha256Json(row.payload), `${passId}:${row.unit_id} producer output digest`, 'PRODUCER_PROVENANCE_MISMATCH');
  requireTimestamp(row.recorded_at, `${passId}:${row.unit_id}.recorded_at`);
  requireTimestamp(row.producer.started_at, `${passId}:${row.unit_id}.producer.started_at`);
  requireTimestamp(row.producer.completed_at, `${passId}:${row.unit_id}.producer.completed_at`);
  if (Date.parse(row.producer.completed_at) < Date.parse(row.producer.started_at)) fail(`${passId}:${row.unit_id} producer chronology is invalid`, 'TIMING_CHRONOLOGY');
  assertEqual(row.recorded_at, row.producer.completed_at, `${passId}:${row.unit_id} recorded_at`, 'PRODUCER_PROVENANCE_MISMATCH');
  return row;
}

export function createM5CConcreteTimingProof(timing) {
  const copy = structuredClone(timing);
  delete copy.recording_proof_sha256;
  return sha256Json(copy);
}

export function validateM5CTiming(timing, {
  timingKind = timing?.timing_kind,
  expectedProposalSha256,
  expectedEditorialSessionId,
  expectedAuditSessionId,
  expectedEditorialDecisionsSha256,
  expectedProposalCases,
  expectedUnitIds,
} = {}) {
  validateSchema(timing, timingValidator, 'timing', 'M5-10C timing', 'TIMING_SCHEMA_ERROR');
  if (timing.timing_kind !== timingKind) fail(`timing kind must be ${timingKind}`, 'TIMING_KIND_MISMATCH');
  assertEqual(timing.measurement_kind, 'editor-judgment', 'timing measurement kind drifted', 'TIMING_MEASUREMENT_KIND');
  requireUuid(timing.session_id, 'timing session_id');
  requireTimestamp(timing.started_at, 'timing started_at');
  if (timing.timing_kind === 'editorial') requireUuid(timing.editorial_session_id, 'timing editorial_session_id');
  if (timing.timing_kind === 'post-freeze-audit') {
    requireUuid(timing.editorial_session_id, 'timing editorial_session_id');
    requireUuid(timing.audit_session_id, 'timing audit_session_id');
    requireSha256(timing.editorial_decisions_sha256, 'timing editorial_decisions_sha256');
    requireTimestamp(timing.editorial_finalized_at, 'timing editorial_finalized_at');
  }
  if (expectedProposalSha256 !== undefined) assertEqual(timing.proposal_sha256, expectedProposalSha256, 'timing proposal digest drifted', 'TIMING_SOURCE_BINDING');
  if (expectedEditorialSessionId !== undefined) assertEqual(timing.editorial_session_id, expectedEditorialSessionId, 'timing editorial session binding drifted', 'TIMING_SOURCE_BINDING');
  if (expectedAuditSessionId !== undefined) assertEqual(timing.audit_session_id, expectedAuditSessionId, 'timing audit session binding drifted', 'TIMING_SOURCE_BINDING');
  if (expectedEditorialDecisionsSha256 !== undefined) assertEqual(timing.editorial_decisions_sha256, expectedEditorialDecisionsSha256, 'audit timing editorial freeze digest drifted', 'TIMING_SOURCE_BINDING');
  const expectedPassIds = timingPassIds(timing);
  assertExactIds(timing.passes.map(({ id }) => id), expectedPassIds, `${timing.timing_kind} timing passes`, 'TIMING_SCOPE_MISMATCH');
  if (timing.status !== 'complete') fail(`${timing.timing_kind} timing is incomplete`, 'TIMING_INCOMPLETE');
  let totalEditorSeconds = 0;
  let totalWallClockSeconds = 0;
  let totalProducerSeconds = 0;
  const expectedCasesById = expectedProposalCases === undefined
    ? undefined
    : new Map(expectedProposalCases instanceof Map
      ? expectedProposalCases
      : expectedProposalCases.map((item) => [item.case_id, item]));
  for (const pass of timing.passes) {
    if (pass.status !== 'complete') fail(`${pass.id} timing pass is not complete`, 'TIMING_INCOMPLETE');
    requireUuid(pass.session_id, `${pass.id}.session_id`);
    requireTimestamp(pass.started_at, `${pass.id}.started_at`);
    requireTimestamp(pass.completed_at, `${pass.id}.completed_at`);
    const elapsed = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
    if (elapsed < 0) fail(`${pass.id} completed before it started`, 'TIMING_CHRONOLOGY');
    if (pass.editor_seconds > 0 && pass.editor_seconds === pass.producer_seconds) {
      fail(`${pass.id} copied producer execution into editor time`, 'TIMING_PRODUCER_SUBSTITUTION');
    }
    assertEqual(pass.editor_seconds, elapsed, `${pass.id} editor seconds`, 'TIMING_DERIVATION_MISMATCH');
    assertEqual(pass.wall_clock_seconds, elapsed, `${pass.id} wall-clock seconds`, 'TIMING_DERIVATION_MISMATCH');
    const { workRows } = workRowsForPass(timing, pass);
    if (expectedUnitIds !== undefined) {
      assertExactIds(pass.work_evidence.unit_ids, expectedUnitIds, `${pass.id} timing units`, 'TIMING_SCOPE_MISMATCH');
    }
    let producerSeconds = 0;
    for (const row of workRows) {
      validateProposalOnlyWorkRow(row, pass.id);
      assertEqual(row.input.payload.case_id, row.unit_id, `${pass.id}:${row.unit_id} input unit`, 'PRODUCER_INPUT_MISMATCH');
      if (expectedCasesById !== undefined) {
        const expectedCase = expectedCasesById.get(row.unit_id);
        if (!expectedCase) fail(`${pass.id}:${row.unit_id} is outside the proposal case set`, 'PRODUCER_INPUT_MISMATCH');
        assertEqual(row.input.payload, expectedCase, `${pass.id}:${row.unit_id} proposal input`, 'PRODUCER_INPUT_MISMATCH');
      }
      const producerElapsed = (Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000;
      producerSeconds += producerElapsed;
      if (Date.parse(row.producer.started_at) < Date.parse(pass.started_at)
        || Date.parse(row.producer.completed_at) > Date.parse(pass.completed_at)) {
        fail(`${pass.id}:${row.unit_id} producer execution is outside its editor pass`, 'TIMING_CHRONOLOGY');
      }
    }
    assertEqual(pass.producer_seconds, producerSeconds, `${pass.id} producer seconds`, 'TIMING_DERIVATION_MISMATCH');
    totalEditorSeconds += pass.editor_seconds;
    totalWallClockSeconds += pass.wall_clock_seconds;
    totalProducerSeconds += pass.producer_seconds;
  }
  if (timing.completed_at !== undefined) {
    requireTimestamp(timing.completed_at, 'timing completed_at');
    if (Date.parse(timing.completed_at) < Date.parse(timing.started_at)) fail('timing completed before it started', 'TIMING_CHRONOLOGY');
  }
  assertEqual(timing.recording_proof_sha256, createM5CConcreteTimingProof(timing), 'timing recording proof drifted', 'TIMING_PROOF_MISMATCH');
  return {
    status: timing.status,
    timing_kind: timing.timing_kind,
    session_id: timing.session_id,
    editorial_session_id: timing.editorial_session_id,
    audit_session_id: timing.audit_session_id,
    editorial_decisions_sha256: timing.editorial_decisions_sha256,
    total_editor_seconds: totalEditorSeconds,
    total_wall_clock_seconds: totalWallClockSeconds,
    total_producer_seconds: totalProducerSeconds,
    unmeasured_pass_count: timing.passes.filter(({ status }) => status !== 'complete').length,
    pass_ids: expectedPassIds,
    passes: Object.fromEntries(timing.passes.map((pass) => [pass.id, {
      editor_seconds: pass.editor_seconds,
      wall_clock_seconds: pass.wall_clock_seconds,
      producer_seconds: pass.producer_seconds,
      unit_count: pass.work_evidence.unit_count,
      unit_ids: [...pass.work_evidence.unit_ids],
    }])),
  };
}

function requireRecordSpecificEvidence(text, caseId, boundaryId, sourceSenseIds, label) {
  requireString(text, label, 'EDITORIAL_EVIDENCE_MISMATCH');
  if (!text.includes(caseId) || !text.includes(boundaryId) || !sourceSenseIds.some((senseId) => text.includes(senseId))) {
    fail(`${label} is not record-specific`, 'EDITORIAL_EVIDENCE_MISMATCH');
  }
}

function validateEditorialRows(records, proposalInfo) {
  assertExactIds(records.map(({ case_id: caseId }) => caseId), proposalInfo.case_ids, 'editorial records');
  const producerPayloads = new Set(proposalInfo.compact_cases.map((item) => JSON.stringify(item)));
  for (const row of records) {
    const source = proposalInfo.by_case.get(row.case_id);
    if (!source) fail(`${row.case_id} editorial record is outside proposal`, 'EDITORIAL_SCOPE_MISMATCH');
    assertEqual(row.record_id, source.record.id, `${row.case_id} record ID`, 'EDITORIAL_SOURCE_BINDING');
    assertEqual(row.source_record_sha256, recordDigest(source.record), `${row.case_id} source record digest`, 'EDITORIAL_SOURCE_BINDING');
    assertEqual(row.lemma_pos.observed_pos, source.record.senses.map(({ pos }) => pos), `${row.case_id} POS observation`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_sense_count, source.record.senses.length, `${row.case_id} sense count`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_sense_ids, source.record.senses.map(({ id }) => id), `${row.case_id} sense IDs`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_pos, source.record.senses.map(({ pos }) => pos), `${row.case_id} sense POS`, 'EDITORIAL_SENSE_MISMATCH');
    requireRecordSpecificEvidence(row.lemma_pos.note, row.case_id, 'lemma-pos', source.record.senses.map(({ id }) => id), `${row.case_id}.lemma_pos.note`);
    requireRecordSpecificEvidence(row.sense_review.note, row.case_id, 'sense-review', source.record.senses.map(({ id }) => id), `${row.case_id}.sense_review.note`);
    const evidenceFingerprints = new Set();
    for (const boundaryId of M5_10C_BOUNDARY_IDS) {
      const evidence = row.boundary_reviews[boundaryId];
      requireRecordSpecificEvidence(evidence.evidence, row.case_id, boundaryId, source.record.senses.map(({ id }) => id), `${row.case_id}.${boundaryId}.evidence`);
      const fingerprint = evidence.evidence.normalize('NFC').replaceAll(row.case_id, '{case}').replaceAll(boundaryId, '{boundary}');
      if (evidenceFingerprints.has(fingerprint)) fail(`${row.case_id} reuses boundary evidence`, 'GENERIC_EDITORIAL_EVIDENCE');
      evidenceFingerprints.add(fingerprint);
    }
    if (row.decision === 'corrected') {
      if (!Array.isArray(row.corrected_fields) || row.corrected_fields.length === 0) fail(`${row.case_id} corrected decision has no corrected_fields`, 'EDITORIAL_DECISION_MISMATCH');
    } else if (row.corrected_fields !== undefined) {
      fail(`${row.case_id} non-corrected decision carries corrected_fields`, 'EDITORIAL_DECISION_MISMATCH');
    }
    requireRecordSpecificEvidence(row.decision_note, row.case_id, row.record_id, source.record.senses.map(({ id }) => id), `${row.case_id}.decision_note`);
    if (producerPayloads.has(JSON.stringify(row))) fail(`${row.case_id} editorial decision was copied from a producer payload`, 'EDITORIAL_DECISION_ORACLE');
    const candidate = source.relation_candidate;
    const relation = row.relation_review;
    if (candidate === null || candidate === undefined) {
      assertEqual(relation.outcome, 'no-valid-candidate', `${row.case_id} relation outcome`, 'RELATION_REVIEW_MISMATCH');
      assertEqual(relation.decision, 'not-applicable', `${row.case_id} no-candidate decision`, 'RELATION_REVIEW_MISMATCH');
      assertEqual(relation.noise_assessment, 'not-applicable', `${row.case_id} no-candidate noise`, 'RELATION_REVIEW_MISMATCH');
      assertEqual(relation.correction, 'none', `${row.case_id} no-candidate correction`, 'RELATION_REVIEW_MISMATCH');
    } else {
      assertEqual(relation.outcome, 'raw-proposal', `${row.case_id} relation outcome`, 'RELATION_REVIEW_MISMATCH');
      for (const key of ['source_sense', 'target_record', 'target_sense', 'type', 'direction']) {
        assertEqual(relation[key], candidate[key], `${row.case_id} relation ${key}`, 'RELATION_REVIEW_MISMATCH');
      }
      if (relation.decision === 'admit') {
        assertEqual(relation.noise_assessment, 'clean', `${row.case_id} admitted candidate noise`, 'RELATION_REVIEW_MISMATCH');
        assertEqual(relation.correction, 'none', `${row.case_id} admitted candidate correction`, 'RELATION_REVIEW_MISMATCH');
      } else if (relation.decision === 'reject') {
        assertEqual(relation.noise_assessment, 'noise', `${row.case_id} rejected candidate noise`, 'RELATION_REVIEW_MISMATCH');
        assertEqual(relation.correction, 'none', `${row.case_id} rejected candidate correction`, 'RELATION_REVIEW_MISMATCH');
      } else {
        assertEqual(relation.decision, 'correct', `${row.case_id} relation decision`, 'RELATION_REVIEW_MISMATCH');
        assertEqual(relation.correction, 'corrected', `${row.case_id} relation correction`, 'RELATION_REVIEW_MISMATCH');
      }
      requireRecordSpecificEvidence(relation.note, row.case_id, 'relation-review', [candidate.source_sense, candidate.target_sense], `${row.case_id}.relation_review.note`);
    }
  }
}

export function validateM5CEditorialDecisions(editorial, proposalInfo, timingSummary) {
  validateSchema(editorial, editorialValidator, 'editorial', 'M5-10C editorial decisions', 'EDITORIAL_SCHEMA_ERROR');
  assertEqual(editorial.batch_id, M5_10C_BATCH_ID, 'editorial batch ID drifted', 'EDITORIAL_SOURCE_BINDING');
  assertEqual(editorial.proposal_sha256, proposalInfo.proposal_sha256, 'editorial proposal digest drifted', 'EDITORIAL_SOURCE_BINDING');
  assertEqual(editorial.timing_session_id, timingSummary.session_id, 'editorial timing session drifted', 'EDITORIAL_SOURCE_BINDING');
  requireUuid(editorial.editorial_session_id, 'editorial editorial_session_id');
  validateEditorialRows(editorial.records, proposalInfo);
  const timingObject = timingSummary.timing;
  const lastStop = Math.max(...timingObject.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
  requireTimestamp(editorial.draft_created_at, 'editorial draft_created_at');
  if (Date.parse(editorial.draft_created_at) < Date.parse(timingObject.started_at)
    || Date.parse(editorial.draft_created_at) > lastStop) {
    fail('editorial decision draft was not authored during the editorial timing session', 'EDITORIAL_DECISION_CHRONOLOGY');
  }
  if (Date.parse(editorial.created_at) <= lastStop) fail('editorial decision artifact was created before the editorial timing stopped', 'EDITORIAL_DECISION_CHRONOLOGY');
  if (Date.parse(editorial.finalized_at) <= Date.parse(editorial.created_at)) fail('editorial decision artifact finalization chronology is invalid', 'EDITORIAL_DECISION_CHRONOLOGY');
  if (editorial.editorial_session_id !== timingObject.editorial_session_id) fail('editorial decision artifact session is not the recorder session', 'EDITORIAL_SOURCE_BINDING');
  return {
    editorial,
    record_by_case: new Map(editorial.records.map((row) => [row.case_id, row])),
    sha256: sha256Json(editorial),
    final_stop_at: new Date(lastStop).toISOString(),
  };
}

function validateAuditRows(audit, editorialInfo, proposalInfo) {
  assertExactIds(audit.case_reviews.map(({ case_id: caseId }) => caseId), proposalInfo.case_ids, 'audit cases');
  for (const review of audit.case_reviews) {
    const source = proposalInfo.by_case.get(review.case_id);
    const editorial = editorialInfo.record_by_case.get(review.case_id);
    assertEqual(review.source_record_sha256, recordDigest(source.record), `${review.case_id} audit source digest`, 'AUDIT_COMPARISON_MISMATCH');
    assertEqual(review.editorial_record_sha256, sha256Json(editorial), `${review.case_id} audit editorial digest`, 'AUDIT_COMPARISON_MISMATCH');
    requireRecordSpecificEvidence(review.note, review.case_id, 'audit', [source.record.senses[0].id], `${review.case_id}.audit.note`);
  }
  if (audit.findings.length !== 0) fail('M5-10C audit contains findings and cannot pass the calibration gate', 'AUDIT_FINDING_PRESENT');
  assertEqual(audit.open_blocker_count, 0, 'audit open blocker count drifted', 'AUDIT_BLOCKER_COUNT');
}

export function validateM5CAuditDecisions(audit, editorialInfo, proposalInfo, auditTimingSummary) {
  validateSchema(audit, auditValidator, 'audit', 'M5-10C audit decisions', 'AUDIT_SCHEMA_ERROR');
  assertEqual(audit.batch_id, M5_10C_BATCH_ID, 'audit batch ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.proposal_sha256, proposalInfo.proposal_sha256, 'audit proposal digest drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.editorial_decisions_sha256, editorialInfo.sha256, 'audit editorial freeze digest drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.audit_session_id, auditTimingSummary.audit_session_id, 'audit session ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.timing_session_id, auditTimingSummary.session_id, 'audit timing session ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.editorial_session_id, editorialInfo.editorial.editorial_session_id, 'audit editorial session ID drifted', 'AUDIT_SOURCE_BINDING');
  if (audit.audit_session_id === audit.editorial_session_id) fail('audit session must be independent from editorial session', 'AUDIT_INDEPENDENCE');
  if (audit.timing_session_id === editorialInfo.editorial.timing_session_id) fail('audit timing session must be independent from editorial timing', 'AUDIT_INDEPENDENCE');
  const editorialFinalizedAt = Date.parse(editorialInfo.editorial.finalized_at);
  const auditTimingObject = auditTimingSummary.timing;
  const auditStartedAt = Date.parse(auditTimingObject.passes[0].started_at);
  const auditStoppedAt = Math.max(...auditTimingObject.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
  requireTimestamp(audit.draft_created_at, 'audit draft_created_at');
  if (auditStartedAt <= editorialFinalizedAt) fail('post-freeze audit timing started before editorial freeze', 'AUDIT_TIMING_CHRONOLOGY');
  if (Date.parse(audit.draft_created_at) < auditStartedAt || Date.parse(audit.draft_created_at) > auditStoppedAt) {
    fail('audit decision draft was not authored during the independent audit timing session', 'AUDIT_DECISION_CHRONOLOGY');
  }
  if (Date.parse(audit.created_at) <= auditStoppedAt) fail('audit decision artifact was created before post-freeze timing stopped', 'AUDIT_DECISION_CHRONOLOGY');
  if (Date.parse(audit.finalized_at) <= Date.parse(audit.created_at)) fail('audit decision artifact finalization chronology is invalid', 'AUDIT_DECISION_CHRONOLOGY');
  validateAuditRows(audit, editorialInfo, proposalInfo);
  return {
    audit,
    sha256: sha256Json(audit),
    open_blocker_count: audit.open_blocker_count,
    finding_count: audit.findings.length,
  };
}

function canonicalSnapshot(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce((count, record) => count + record.senses.reduce((senseCount, sense) => senseCount + (sense.relations?.length ?? 0), 0), 0),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function validateFailedWaveBSource(stage, sourceFiles) {
  assertEqual(stage.stage_id, 'm5-10-wave-b-plus-150', 'failed Wave B stage ID drifted', 'FAILED_STAGE_MISMATCH');
  assertEqual(stage.gate_status, 'fail', 'failed Wave B gate was changed', 'FAILED_STAGE_GATE_CHANGED');
  assertEqual(stage.decision, 'HOLD PROCESS', 'failed Wave B decision was changed', 'FAILED_STAGE_DECISION_CHANGED');
  assertEqual(stage.next_stage_authorized, false, 'failed Wave B authorized a later stage', 'FAILED_STAGE_AUTHORIZATION_CHANGED');
  assertEqual(stage.metrics.measurement_kind, 'producer-throughput', 'failed Wave B measurement kind changed', 'FAILED_STAGE_HISTORY_CHANGED');
  assertEqual(stage.metrics.editor_time_status, 'unmeasured', 'failed Wave B editor-time history changed', 'FAILED_STAGE_HISTORY_CHANGED');
  assertEqual(stage.metrics.total_editor_seconds, null, 'failed Wave B editor-time history changed', 'FAILED_STAGE_HISTORY_CHANGED');
  assertEqual(stage.actual.canonical_snapshot, M5_10C_CANONICAL_SNAPSHOT, 'failed Wave B canonical snapshot drifted', 'FAILED_STAGE_SNAPSHOT_MISMATCH');
  for (const [key, source] of Object.entries(sourceFiles)) {
    const ref = stage.source[key];
    if (!ref) fail(`failed Wave B stage is missing source ${key}`, 'FAILED_STAGE_SOURCE_MISSING');
    const bytes = readSyncBytes(resolveRepositoryPath(ref, `failed stage source ${key}`), `failed stage source ${key}`);
    assertEqual(sha256Bytes(bytes), stage.source[`${key}_sha256`], `failed Wave B ${key} digest drifted`, 'FAILED_STAGE_SOURCE_MISMATCH');
    assertEqual(sha256Bytes(bytes), source.sha256, `failed Wave B ${key} source changed`, 'FAILED_STAGE_SOURCE_MISMATCH');
  }
}

function validateVerification(verification, canonicalSnapshotValue) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) fail('M5-10C verification artifact is missing', 'VERIFICATION_MISSING');
  assertEqual(verification.status, 'passed', 'M5-10C verification did not pass', 'VERIFICATION_FAILED');
  assertEqual(verification.editorial_review_complete, true, 'editorial review is incomplete', 'VERIFICATION_FAILED');
  assertEqual(verification.human_editorial_review_complete, false, 'M5-10C must not claim human review', 'VERIFICATION_PROVENANCE');
  for (const key of ['canonical_integrity', 'deterministic_sqlite', 'search_product_regression', 'calibration_canonical_mutation']) {
    assertEqual(verification[key], key === 'calibration_canonical_mutation' ? false : true, `verification ${key} drifted`, 'VERIFICATION_FAILED');
  }
  if (!Array.isArray(verification.checks) || verification.checks.length < 4 || verification.checks.some(({ status }) => status !== 'pass')) {
    fail('verification checks are incomplete', 'VERIFICATION_FAILED');
  }
  assertEqual(verification.canonical_snapshot, canonicalSnapshotValue, 'verification canonical snapshot drifted', 'VERIFICATION_FAILED');
}

export function evaluateM5CRecoveryGate({ correctionRate, relationNoiseRate, timing, audit, editorial, canonicalMutation, inventoryMutation, verification, failedStage } = {}) {
  const qualityPasses = {
    correction_rate: Number.isFinite(correctionRate) && correctionRate <= M5_10C_CORRECTION_RATE_MAX,
    relation_noise_rate: Number.isFinite(relationNoiseRate)
      && relationNoiseRate <= M5_10C_RELATION_NOISE_RATE_MAX
      && relationNoiseRate < M5_10C_RELATION_NOISE_BASELINE,
    editor_seconds_per_processed_start: Number.isFinite(timing?.total_editor_seconds)
      && timing.total_editor_seconds / M5_10C_PROCESSED_START_COUNT <= M5_10C_EDITOR_SECONDS_PER_PROCESSED_START_MAX,
    timing_complete: timing?.status === 'complete' && timing?.unmeasured_pass_count === 0,
    audit_open_blockers: audit?.status === 'complete' && audit?.independent === true && audit?.open_blocker_count === 0,
    editorial_review_complete: editorial?.status === 'complete',
    calibration_canonical_mutation: canonicalMutation === false,
    inventory_mutation: inventoryMutation === false,
    canonical_integrity: verification?.canonical_integrity === true,
    deterministic_sqlite: verification?.deterministic_sqlite === true,
    search_product_regression: verification?.search_product_regression === true,
    failed_stage_preserved: failedStage?.gate_status === 'fail'
      && failedStage?.decision === 'HOLD PROCESS'
      && failedStage?.next_stage_authorized === false,
  };
  const failures = Object.entries(qualityPasses).filter(([, passed]) => !passed).map(([key]) => key);
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    gate_status: failures.length === 0 ? 'pass' : 'fail',
    decision: failures.length === 0 ? 'APPROVE BOUNDED' : 'HOLD PROCESS',
    quality_passes: qualityPasses,
    failures,
  };
}

function sourcePathFor(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`source path escapes repository: ${filePath}`, 'SOURCE_PATH_MISMATCH');
  return relative;
}

function readSourceReference(filePath, label) {
  const resolved = resolveRepositoryPath(filePath, label);
  const bytes = readSyncBytes(resolved, label);
  return { path: sourcePathFor(resolved), sha256: sha256Bytes(bytes) };
}

export async function validateM5CRecovery({
  artifactPath = DEFAULT_RECOVERY_PATH,
  proposalPath = DEFAULT_PROPOSAL_PATH,
  editorialPath = DEFAULT_EDITORIAL_DECISIONS_PATH,
  editorialTimingPath = DEFAULT_EDITORIAL_TIMING_PATH,
  auditPath = DEFAULT_AUDIT_DECISIONS_PATH,
  auditTimingPath = DEFAULT_AUDIT_TIMING_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  failedStagePath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json'),
  failedManifestPath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b.json'),
  failedMetricsPath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-metrics.json'),
  failedVerificationPath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-verification.json'),
  failedRelationDiffPath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-relation-diff.json'),
  repairRevisionPath = path.join(BATCH_DIRECTORY, 'm5-10a-process-correction.json'),
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  inventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  const [artifactSource, proposalSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource, verificationSource, failedStageSource, failedManifestSource, failedMetricsSource, failedVerificationSource, failedRelationDiffSource, repairSource, inventorySource, canonical] = await Promise.all([
    readSource(artifactPath, 'M5-10C recovery artifact'),
    readSource(proposalPath, 'M5-10C calibration proposal'),
    readSource(editorialPath, 'M5-10C editorial decisions'),
    readSource(editorialTimingPath, 'M5-10C editorial timing'),
    readSource(auditPath, 'M5-10C audit decisions'),
    readSource(auditTimingPath, 'M5-10C audit timing'),
    readSource(verificationPath, 'M5-10C verification'),
    readSource(failedStagePath, 'failed Wave B stage'),
    readSource(failedManifestPath, 'failed Wave B manifest'),
    readSource(failedMetricsPath, 'failed Wave B metrics'),
    readSource(failedVerificationPath, 'failed Wave B verification'),
    readSource(failedRelationDiffPath, 'failed Wave B relation diff'),
    readSource(repairRevisionPath, 'M5-10A repair revision'),
    readSource(inventoryPath, 'M5 target inventory'),
    readCanonicalRecords(canonicalDirectory),
  ]);
  const proposalInfo = validateM5CProposal(proposalSource.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposalSource.sha256;
  const editorialTiming = validateM5CTiming(editorialTimingSource.value, {
    timingKind: 'editorial',
    expectedProposalSha256: proposalSource.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
    expectedUnitIds: proposalInfo.case_ids,
  });
  editorialTiming.timing = editorialTimingSource.value;
  const editorialInfo = validateM5CEditorialDecisions(editorialSource.value, proposalInfo, editorialTiming);
  editorialInfo.sha256 = editorialSource.sha256;
  const auditTiming = validateM5CTiming(auditTimingSource.value, {
    timingKind: 'post-freeze-audit',
    expectedProposalSha256: proposalSource.sha256,
    expectedEditorialSessionId: editorialSource.value.editorial_session_id,
    expectedAuditSessionId: auditSource.value.audit_session_id,
    expectedEditorialDecisionsSha256: editorialInfo.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
    expectedUnitIds: proposalInfo.case_ids,
  });
  auditTiming.timing = auditTimingSource.value;
  const auditInfo = validateM5CAuditDecisions(auditSource.value, editorialInfo, proposalInfo, auditTiming);
  const currentCanonicalSnapshot = canonicalSnapshot(canonical.records);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(canonicalDirectory);
  const initialCanonicalDirectorySha256 = editorialTimingSource.value.canonical_directory_sha256;
  const auditInitialCanonicalDirectorySha256 = auditTimingSource.value.canonical_directory_sha256;
  assertEqual(initialCanonicalDirectorySha256, canonicalDirectorySha256, 'canonical data changed during M5-10C recovery', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(auditInitialCanonicalDirectorySha256, canonicalDirectorySha256, 'canonical data changed before post-freeze audit', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(auditInitialCanonicalDirectorySha256, initialCanonicalDirectorySha256, 'editorial and audit canonical snapshots differ', 'CALIBRATION_CANONICAL_MUTATION');
  const inventoryBeforeSha256 = editorialTimingSource.value.inventory_sha256;
  const inventoryAfterSha256 = inventorySource.sha256;
  assertEqual(inventoryBeforeSha256, inventoryAfterSha256, 'target inventory changed during M5-10C recovery', 'CALIBRATION_INVENTORY_MUTATION');
  assertEqual(auditTimingSource.value.inventory_sha256, inventoryAfterSha256, 'target inventory changed before post-freeze audit', 'CALIBRATION_INVENTORY_MUTATION');
  validateSchema(artifactSource.value, recoveryValidator, 'recovery', 'M5-10C recovery', 'RECOVERY_SCHEMA_ERROR');
  const artifact = artifactSource.value;
  assertEqual(artifact.process_revision, M5_10C_PROCESS_REVISION, 'recovery process revision drifted', 'RECOVERY_SCOPE_MISMATCH');
  assertEqual(artifact.canonical_snapshot, currentCanonicalSnapshot, 'recovery canonical snapshot drifted', 'RECOVERY_CANONICAL_MISMATCH');
  assertEqual(currentCanonicalSnapshot, M5_10C_CANONICAL_SNAPSHOT, 'current canonical snapshot is not the Wave B base', 'RECOVERY_CANONICAL_MISMATCH');
  assertEqual(artifact.source.proposal_sha256, proposalSource.sha256, 'recovery proposal digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.editorial_decisions_sha256, editorialSource.sha256, 'recovery editorial digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.editorial_timing_sha256, editorialTimingSource.sha256, 'recovery editorial timing digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.audit_decisions_sha256, auditSource.sha256, 'recovery audit digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.audit_timing_sha256, auditTimingSource.sha256, 'recovery audit timing digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.verification_sha256, verificationSource.sha256, 'recovery verification digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.canonical_directory_sha256, canonicalDirectorySha256, 'recovery canonical directory digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.before_sha256, inventoryBeforeSha256, 'recovery inventory before digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.after_sha256, inventoryAfterSha256, 'recovery inventory after digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.before_sha256, artifact.inventory_snapshot.after_sha256, 'calibration mutated the inventory', 'CALIBRATION_INVENTORY_MUTATION');
  assertEqual(artifact.inventory_snapshot.completed_start_count, currentCanonicalSnapshot.start_count, 'inventory completed start count drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_stage_sha256, failedStageSource.sha256, 'failed stage digest drifted', 'FAILED_STAGE_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_manifest_sha256, failedManifestSource.sha256, 'failed manifest digest drifted', 'FAILED_STAGE_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_metrics_sha256, failedMetricsSource.sha256, 'failed metrics digest drifted', 'FAILED_STAGE_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_verification_sha256, failedVerificationSource.sha256, 'failed verification digest drifted', 'FAILED_STAGE_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_relation_diff_sha256, failedRelationDiffSource.sha256, 'failed relation diff digest drifted', 'FAILED_STAGE_SOURCE_MISMATCH');
  assertEqual(artifact.source.repair_revision_sha256, repairSource.sha256, 'repair revision digest drifted', 'REPAIR_REVISION_MISMATCH');
  const failedStage = failedStageSource.value;
  validateFailedWaveBSource(failedStage, {
    manifest: failedManifestSource,
    metrics: failedMetricsSource,
    verification: failedVerificationSource,
    relation_diff: failedRelationDiffSource,
  });
  assertEqual(repairSource.value.process_revision, 'm5-10a-process-correction-v1', 'repair revision changed', 'REPAIR_REVISION_MISMATCH');
  assertEqual(repairSource.value.canonical_scope.snapshot.start_count, 578, 'repair revision canonical base changed', 'REPAIR_REVISION_MISMATCH');
  const inventory = inventorySource.value;
  assertEqual(inventory.revision, 'm5-11', 'inventory revision drifted', 'INVENTORY_SOURCE_MISMATCH');
  assertEqual(inventory.canonical_snapshot.start_count, currentCanonicalSnapshot.start_count, 'inventory canonical snapshot drifted', 'INVENTORY_SOURCE_MISMATCH');
  validateVerification(verificationSource.value, currentCanonicalSnapshot);
  const decisionCounts = Object.fromEntries(['included', 'corrected', 'held', 'rejected'].map((decision) => [decision, editorialSource.value.records.filter((row) => row.decision === decision).length]));
  const correctionRate = decisionCounts.corrected / M5_10C_PROCESSED_START_COUNT;
  const relationReviews = editorialSource.value.records.map(({ relation_review: review }) => review);
  const rawProposalCount = relationReviews.filter(({ outcome }) => outcome === 'raw-proposal').length;
  const noiseCount = relationReviews.filter(({ outcome, noise_assessment: assessment }) => outcome === 'raw-proposal' && assessment === 'noise').length;
  const relationNoiseRate = rawProposalCount === 0 ? 0 : noiseCount / rawProposalCount;
  const totalEditorSeconds = editorialTiming.total_editor_seconds + auditTiming.total_editor_seconds;
  const totalWallClockSeconds = editorialTiming.total_wall_clock_seconds + auditTiming.total_wall_clock_seconds;
  const totalProducerSeconds = editorialTiming.total_producer_seconds + auditTiming.total_producer_seconds;
  const calibration = {
    case_count: M5_10C_CASE_COUNT,
    processed_start_count: M5_10C_PROCESSED_START_COUNT,
    decision_counts: decisionCounts,
    correction_rate: correctionRate,
    relation: {
      raw_proposal_count: rawProposalCount,
      noise_count: noiseCount,
      noise_rate: relationNoiseRate,
      no_candidate_count: relationReviews.filter(({ outcome }) => outcome === 'no-valid-candidate').length,
    },
    timing: {
      status: 'complete',
      measurement_kind: 'editor-judgment',
      total_wall_clock_seconds: totalWallClockSeconds,
      total_editor_seconds: totalEditorSeconds,
      total_producer_seconds: totalProducerSeconds,
      editor_seconds_per_processed_start: totalEditorSeconds / M5_10C_PROCESSED_START_COUNT,
      producer_seconds_per_processed_start: totalProducerSeconds / M5_10C_PROCESSED_START_COUNT,
      unmeasured_pass_count: 0,
      pass_ids: [...M5_10C_EDITORIAL_PASS_IDS, ...M5_10C_AUDIT_PASS_IDS],
    },
    audit: {
      status: 'complete',
      independent: true,
      case_count: M5_10C_CASE_COUNT,
      open_blocker_count: auditInfo.open_blocker_count,
      finding_count: auditInfo.finding_count,
    },
    canonical_mutation: false,
  };
  assertEqual(artifact.calibration, calibration, 'recovery calibration metrics drifted', 'RECOVERY_METRIC_MISMATCH');
  const gate = evaluateM5CRecoveryGate({
    correctionRate,
    relationNoiseRate,
    timing: { ...calibration.timing },
    audit: calibration.audit,
    editorial: { status: 'complete' },
    canonicalMutation: artifact.canonical_mutation,
    inventoryMutation: artifact.inventory_snapshot.before_sha256 !== artifact.inventory_snapshot.after_sha256,
    verification: verificationSource.value,
    failedStage,
  });
  assertEqual(artifact.gate_status, gate.gate_status, 'recovery gate status drifted', 'RECOVERY_GATE_MISMATCH');
  assertEqual(artifact.decision, gate.decision, 'recovery decision drifted', 'RECOVERY_GATE_MISMATCH');
  if (artifact.gate_status === 'pass') assertEqual(artifact.ready_to_create, true, 'passing recovery must be ready to create #97', 'RECOVERY_GATE_MISMATCH');
  if (artifact.gate_status === 'fail') assertEqual(artifact.ready_to_create, false, 'failed recovery cannot be ready to create #97', 'RECOVERY_GATE_MISMATCH');
  return {
    artifact,
    artifact_sha256: artifactSource.sha256,
    proposal: proposalInfo,
    editorial: editorialInfo,
    audit: auditInfo,
    timing: { editorial: editorialTiming, audit: auditTiming },
    canonical: { snapshot: currentCanonicalSnapshot, directory_sha256: canonicalDirectorySha256 },
    inventory: { revision: inventory.revision, sha256: inventorySource.sha256 },
    calibration,
    gate,
    failed_stage: failedStage,
  };
}

export async function validateM5CAuthorization({
  authorizationPath = DEFAULT_AUTHORIZATION_PATH,
  recoveryPath = DEFAULT_RECOVERY_PATH,
  failedStagePath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json'),
  repairRevisionPath = path.join(BATCH_DIRECTORY, 'm5-10a-process-correction.json'),
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  inventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  const [authorizationSource, recoverySource, failedStageSource, repairSource, inventorySource] = await Promise.all([
    readSource(authorizationPath, 'M5-10C authorization'),
    readSource(recoveryPath, 'M5-10C recovery artifact'),
    readSource(failedStagePath, 'failed Wave B stage'),
    readSource(repairRevisionPath, 'M5-10A repair revision'),
    readSource(inventoryPath, 'M5 target inventory'),
  ]);
  validateSchema(authorizationSource.value, authorizationValidator, 'authorization', 'M5-10C authorization', 'AUTHORIZATION_SCHEMA_ERROR');
  const authorization = authorizationSource.value;
  assertEqual(recoverySource.value.gate_status, 'pass', 'authorization requires a passing M5-10C recovery gate', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(recoverySource.value.decision, 'APPROVE BOUNDED', 'authorization requires an approved M5-10C recovery decision', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(recoverySource.value.ready_to_create, true, 'authorization requires recovery ready_to_create', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.source.recovery_artifact_sha256, recoverySource.sha256, 'authorization recovery digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.failed_stage.sha256, failedStageSource.sha256, 'authorization failed stage digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.repair_revision === 'data/batches/m5-10a-process-correction.json', true, 'authorization repair source drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.canonical_directory_sha256, await hashCanonicalDirectory(canonicalDirectory), 'authorization canonical digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.inventory_sha256, inventorySource.sha256, 'authorization inventory digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.failed_stage.gate_status, failedStageSource.value.gate_status, 'authorization failed gate drifted', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.failed_stage.decision, failedStageSource.value.decision, 'authorization failed decision drifted', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.failed_stage.next_stage_authorized, failedStageSource.value.next_stage_authorized, 'authorization failed-stage authorization drifted', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(repairSource.value.process_revision, 'm5-10a-process-correction-v1', 'authorization repair revision changed', 'REPAIR_REVISION_MISMATCH');
  return { authorization, authorization_sha256: authorizationSource.sha256, recovery_sha256: recoverySource.sha256 };
}

export function mainArgumentMap(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = mainArgumentMap(process.argv.slice(2));
  const action = args.action ?? 'recovery';
  const run = action === 'authorization' ? validateM5CAuthorization : validateM5CRecovery;
  run({
    ...(args.artifact ? { artifactPath: path.resolve(args.artifact) } : {}),
    ...(args.authorization ? { authorizationPath: path.resolve(args.authorization) } : {}),
    ...(args.recovery ? { recoveryPath: path.resolve(args.recovery) } : {}),
    ...(args.proposal ? { proposalPath: path.resolve(args.proposal) } : {}),
    ...(args.editorial ? { editorialPath: path.resolve(args.editorial) } : {}),
    ...(args['editorial-timing'] ? { editorialTimingPath: path.resolve(args['editorial-timing']) } : {}),
    ...(args.audit ? { auditPath: path.resolve(args.audit) } : {}),
    ...(args['audit-timing'] ? { auditTimingPath: path.resolve(args['audit-timing']) } : {}),
  }).then((result) => console.log(JSON.stringify(result.gate ?? result.authorization, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  DEFAULT_SEED_PATH,
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_10D_PRODUCER_VERSION } from './produce-m5-10d-work.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const HISTORICAL_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-11-base-canonical');
const HISTORICAL_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-base-inventory.json');

export const M5_10D_BATCH_ID = 'm5-10d-editor-time-recalibration-20260912';
export const M5_10D_PROCESS_REVISION = 'm5-10d-editor-workload-v1';
export const M5_10D_FOLLOW_UP_SOURCE_KIND = 'recorder-owned-initial-review-findings';
export const M5_10D_CASE_COUNT = 20;
export const M5_10D_PROCESSED_START_COUNT = 20;
export const M5_10D_BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
export const M5_10D_EDITORIAL_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-verification',
  'held-rejected',
]);
export const M5_10D_AUDIT_PASS_IDS = Object.freeze(['post-freeze-audit']);
export const M5_10D_PASS_IDS = Object.freeze([...M5_10D_EDITORIAL_PASS_IDS, ...M5_10D_AUDIT_PASS_IDS]);
export const M5_10D_CANONICAL_SNAPSHOT = Object.freeze({
  record_count: 820,
  start_count: 778,
  reference_only_count: 42,
  sense_count: 966,
  relation_count: 473,
  expression_count: 63,
});
export const M5_10D_RELATION_NOISE_BASELINE = 51 / 139;
export const M5_10D_EDITOR_SECONDS_PER_PROCESSED_START_MAX = 12;
export const M5_10D_RELATION_NOISE_RATE_MAX = 0.25;
export const M5_10D_CORRECTION_RATE_MAX = 0.5;

export const DEFAULT_WORKLOAD_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-workload-20260912.json');
export const M5_10D_PROPOSAL_ARTIFACT = 'data/batches/m5-10d-calibration-proposal-20260912.json';
export const M5_10D_FOLLOW_UP_ARTIFACT = 'data/batches/m5-10d-follow-up-source-20260912.json';
export const DEFAULT_PROPOSAL_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-calibration-proposal-20260912.json');
export const DEFAULT_FOLLOW_UP_SOURCE_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-follow-up-source-20260912.json');
export const DEFAULT_EDITORIAL_TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-editorial-timing-20260912.json');
export const DEFAULT_EDITORIAL_DECISIONS_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-editorial-decisions-20260912.json');
export const DEFAULT_AUDIT_TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-audit-timing-20260912.json');
export const DEFAULT_AUDIT_DECISIONS_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-audit-decisions-20260912.json');
export const DEFAULT_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-verification-20260912.json');
export const DEFAULT_RECOVERY_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-recovery.json');
export const DEFAULT_AUTHORIZATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-m5-11-authorization-20260912.json');
export const DEFAULT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
export const DEFAULT_INVENTORY_PATH = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-inventory.json');

export const DEFAULT_FAILED_STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json');
export const DEFAULT_FAILED_RECOVERY_PATH = path.join(BATCH_DIRECTORY, 'm5-10c-recovery.json');
export const DEFAULT_REPAIR_REVISION_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-process-correction.json');
export const DEFAULT_FAILED_MANIFEST_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b.json');
export const DEFAULT_FAILED_METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-metrics.json');
export const DEFAULT_FAILED_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-verification.json');
export const DEFAULT_FAILED_RELATION_DIFF_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-relation-diff.json');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CASE_ID_PATTERN = /^m5-10d-cal-[0-9]{3}$/u;
const RECORD_ID_PATTERN = /^cal-m5-10d-[0-9]{3}$/u;
const SENSE_ID_PATTERN = /^cal-m5-10d-[0-9]{3}-s[1-9][0-9]*$/u;
const VERDICT_KEYS = new Set([
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
]);
const RAW_PROPOSAL_KEYS = new Set(['record', 'senses', 'lemma', 'gloss', 'search_forms']);
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
const compileSchema = (name) => new Ajv2020(schemaOptions).compile(
  requireSchema(`../../schema/${name}.schema.json`),
);
const proposalValidator = compileSchema('m5-10d-calibration-proposal');
const workloadValidator = compileSchema('m5-10d-workload');
const followUpSourceValidator = compileSchema('m5-10d-follow-up-source');
const timingValidator = compileSchema('m5-10d-timing');
const editorialValidator = compileSchema('m5-10d-editorial-decisions');
const auditValidator = compileSchema('m5-10d-audit-decisions');
const recoveryValidator = compileSchema('m5-10d-recovery');
const authorizationValidator = compileSchema('m5-10d-authorization');
const verificationValidator = compileSchema('m5-10d-verification');

export class M5DRecoveryValidationError extends Error {
  constructor(message, code = 'M5_10D_RECOVERY_VALIDATION_ERROR') {
    super(message);
    this.name = 'M5DRecoveryValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_10D_RECOVERY_VALIDATION_ERROR') {
  throw new M5DRecoveryValidationError(message, code);
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

function requireTimestamp(value, label, code = 'INVALID_TIMESTAMP') {
  requireString(value, label, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, code);
  }
  return value;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function resolveAnyPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_DIRECTORY, value);
}

function sourcePathFor(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(filePath);
  return relative;
}

async function readSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
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

export async function readInventorySource(filePath, canonicalDirectory) {
  if (path.resolve(filePath) === path.resolve(DEFAULT_INVENTORY_PATH)) {
    const value = await buildTargetInventory({
      canonicalDirectory,
      seedPath: DEFAULT_SEED_PATH,
    });
    const bytes = serializeTargetInventory(value);
    return { value, bytes, sha256: sha256Bytes(bytes), path: filePath };
  }
  return readSource(filePath, 'M5 target inventory');
}

function readSyncBytes(filePath, label) {
  try {
    return readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    throw error;
  }
}

function assertNoVerdictKeys(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (VERDICT_KEYS.has(key)) fail(`${label} contains editorial verdict key ${key}`, 'PRODUCER_VERDICT_FORBIDDEN');
    assertNoVerdictKeys(child, `${label}.${key}`);
  }
}

function assertNoRawProposal(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (RAW_PROPOSAL_KEYS.has(key)) fail(`${label} stores raw proposal field ${key}`, 'RAW_PROPOSAL_IN_REPOSITORY');
    assertNoRawProposal(child, `${label}.${key}`);
  }
}

function assertExactIds(actual, expected, label, code = 'CASE_COVERAGE_MISMATCH') {
  assertEqual(actual, expected, `${label} coverage drifted`, code);
  if (new Set(actual).size !== actual.length) fail(`${label} contains duplicate IDs`, code);
}

function allCaseIds() {
  return Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
}

function recordForEntry(entry) {
  return entry?.record ?? entry;
}

function canonicalSnapshot(recordInfos) {
  const records = recordInfos.map(recordForEntry);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce(
      (count, record) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function proposalCaseIds(proposal) {
  return proposal.cases.map(({ case_id: caseId }) => caseId);
}

function proposalRecordById(proposal) {
  return new Map(proposal.cases.map(({ record }) => [record.id, record]));
}

function proposalSenseIndex(proposal) {
  const result = new Map();
  for (const item of proposal.cases) {
    for (const sense of item.record.senses) result.set(sense.id, { item, record: item.record, sense });
  }
  return result;
}

function validateProposalRelations(proposal) {
  const records = proposalRecordById(proposal);
  const senses = proposalSenseIndex(proposal);
  for (const item of proposal.cases) {
    assertNoVerdictKeys(item, `${item.case_id} proposal`);
    if (!CASE_ID_PATTERN.test(item.case_id)) fail(`${item.case_id} is not an M5-10D case`, 'PROPOSAL_SCOPE_MISMATCH');
    if (!RECORD_ID_PATTERN.test(item.record.id)) fail(`${item.case_id} proposal record is not calibration-only`, 'PROPOSAL_SCOPE_MISMATCH');
    const number = item.case_id.slice(-3);
    assertEqual(item.record.id, `cal-m5-10d-${number}`, `${item.case_id} record identity`, 'PROPOSAL_SCOPE_MISMATCH');
    const expectedSensePrefix = `cal-m5-10d-${number}-`;
    if (item.record.senses.some(({ id }) => !SENSE_ID_PATTERN.test(id) || !id.startsWith(expectedSensePrefix))) {
      fail(`${item.case_id} contains a sense outside its calibration record`, 'PROPOSAL_SCOPE_MISMATCH');
    }
    if (new Set(item.record.senses.map(({ id }) => id)).size !== item.record.senses.length) {
      fail(`${item.case_id} contains duplicate sense IDs`, 'PROPOSAL_SCOPE_MISMATCH');
    }
    const candidate = item.relation_candidate;
    if (candidate === null || candidate === undefined) continue;
    if (!item.record.senses.some(({ id }) => id === candidate.source_sense)) {
      fail(`${item.case_id} relation source is outside its record`, 'PROPOSAL_RELATION_MISMATCH');
    }
    if (!records.has(candidate.target_record) || !senses.has(candidate.target_sense)) {
      fail(`${item.case_id} relation target is outside the calibration sample`, 'PROPOSAL_RELATION_MISMATCH');
    }
    if (records.get(candidate.target_record).senses.every(({ id }) => id !== candidate.target_sense)) {
      fail(`${item.case_id} relation target sense does not belong to its target record`, 'PROPOSAL_RELATION_MISMATCH');
    }
    assertEqual(candidate.direction, { from: candidate.source_sense, to: candidate.target_sense }, `${item.case_id} relation direction`, 'PROPOSAL_RELATION_MISMATCH');
    if (candidate.target_record === item.record.id) fail(`${item.case_id} relation self-references`, 'PROPOSAL_RELATION_MISMATCH');
  }
}

export function validateM5DProposal(proposal, { canonicalRecords = [], excludedRecords = [] } = {}) {
  validateSchema(proposal, proposalValidator, 'proposal', 'M5-10D calibration proposal', 'PROPOSAL_SCHEMA_ERROR');
  assertEqual(proposal.process_revision, M5_10D_PROCESS_REVISION, 'proposal process revision drifted', 'PROPOSAL_SCOPE_MISMATCH');
  assertEqual(proposal.case_count, M5_10D_CASE_COUNT, 'proposal case count drifted', 'CASE_COVERAGE_MISMATCH');
  assertExactIds(proposalCaseIds(proposal), allCaseIds(), 'proposal cases');
  validateProposalRelations(proposal);
  const existing = [...canonicalRecords, ...excludedRecords].map(recordForEntry);
  const existingIds = new Set(existing.map((record) => record.id));
  const existingLexemes = new Set(existing.flatMap((record) => [record.lemma, ...(record.search_forms ?? [])]));
  for (const item of proposal.cases) {
    if (existingIds.has(item.record.id) || item.record.senses.some(({ id }) => existing.some((record) => record.senses.some((sense) => sense.id === id)))) {
      fail(`${item.case_id} calibration data overlaps an existing record or sense`, 'CALIBRATION_SCOPE_OVERLAP');
    }
    if (existingLexemes.has(item.record.lemma) || item.record.search_forms.some((form) => existingLexemes.has(form))) {
      fail(`${item.case_id} calibration lemma overlaps an existing lexical form`, 'CALIBRATION_SCOPE_OVERLAP');
    }
  }
  const compactCases = proposal.cases.map((item) => ({
    phase: 'proposal',
    case_id: item.case_id,
    record_id: item.record.id,
    source_record_sha256: sha256Json(item.record),
    source_sense_ids: item.record.senses.map(({ id }) => id),
    source_pos: item.record.senses.map(({ pos }) => pos),
    relation_candidate: item.relation_candidate ?? null,
  }));
  return {
    proposal,
    case_ids: proposalCaseIds(proposal),
    compact_cases: compactCases,
    by_case: new Map(proposal.cases.map((item, index) => [item.case_id, { ...item, compact: compactCases[index] }])),
    source_record_digests: new Map(proposal.cases.map((item) => [item.case_id, sha256Json(item.record)])),
  };
}

function followUpSourceValue(sourceInput) {
  return sourceInput?.value ?? sourceInput;
}

function followUpSourceDigest(sourceInput) {
  return sourceInput?.sha256;
}

export function deriveM5DFollowUpQueues(source) {
  const value = followUpSourceValue(source);
  return {
    feedback: value.findings.filter(({ finding_kind: findingKind }) => findingKind === 'correction').map(({ case_id: caseId }) => caseId),
    heldRejected: value.findings
      .filter(({ finding_kind: findingKind }) => findingKind === 'held' || findingKind === 'rejected')
      .map(({ case_id: caseId }) => caseId),
  };
}

export function validateM5DFollowUpSource(sourceInput, {
  proposalCaseIds = allCaseIds(),
  proposalSha256,
  proposalCasesById,
  timingSessionId,
  initialPassSessionId,
  initialJudgmentRows,
  initialJudgmentLogSha256,
  initialPass,
  freezeEventId,
} = {}) {
  const source = followUpSourceValue(sourceInput);
  validateSchema(source, followUpSourceValidator, 'follow-up source', 'M5-10D follow-up source', 'FOLLOW_UP_SOURCE_SCHEMA_ERROR');
  assertEqual(source.batch_id, M5_10D_BATCH_ID, 'follow-up source batch ID drifted', 'WORKLOAD_SOURCE_BINDING');
  assertEqual(source.source_kind, M5_10D_FOLLOW_UP_SOURCE_KIND, 'follow-up source kind drifted', 'WORKLOAD_SOURCE_BINDING');
  if (proposalSha256 !== undefined) assertEqual(source.proposal_sha256, proposalSha256, 'follow-up source proposal digest drifted', 'WORKLOAD_SOURCE_BINDING');
  if (timingSessionId !== undefined) assertEqual(source.timing_session_id, timingSessionId, 'follow-up source timing session drifted', 'WORKLOAD_SOURCE_BINDING');
  if (initialPassSessionId !== undefined) assertEqual(source.source_pass_session_id, initialPassSessionId, 'follow-up source pass session drifted', 'WORKLOAD_SOURCE_BINDING');
  if (freezeEventId !== undefined) assertEqual(source.freeze_event_id, freezeEventId, 'follow-up source freeze event drifted', 'WORKLOAD_SOURCE_BINDING');
  const proposalOrder = new Map(proposalCaseIds.map((caseId, index) => [caseId, index]));
  const findingIds = new Set();
  let previousOrder = -1;
  for (const finding of source.findings) {
    if (!proposalOrder.has(finding.case_id)) fail(`${finding.case_id} follow-up finding is outside the proposal`, 'WORKLOAD_SOURCE_SCOPE');
    if (findingIds.has(finding.case_id)) fail(`${finding.case_id} is duplicated in follow-up findings`, 'WORKLOAD_SOURCE_SCOPE');
    findingIds.add(finding.case_id);
    const order = proposalOrder.get(finding.case_id);
    if (order <= previousOrder) fail('follow-up findings are not in proposal order', 'WORKLOAD_SOURCE_SCOPE');
    previousOrder = order;
    assertEqual(finding.record_id, `cal-m5-10d-${finding.case_id.slice(-3)}`, `${finding.case_id} follow-up record ID`, 'WORKLOAD_SOURCE_BINDING');
    if (proposalCasesById) {
      const proposal = proposalCasesById.get(finding.case_id) ?? proposalCasesById[finding.case_id];
      if (!proposal) fail(`${finding.case_id} follow-up finding has no proposal record`, 'WORKLOAD_SOURCE_SCOPE');
      assertEqual(finding.source_record_sha256, sha256Json(proposal.record), `${finding.case_id} follow-up source record digest`, 'WORKLOAD_SOURCE_BINDING');
    }
  }
  if (initialJudgmentRows) {
    if (initialJudgmentLogSha256 !== undefined) {
      assertEqual(source.source_judgment_artifact_sha256, initialJudgmentLogSha256, 'follow-up source judgment log digest drifted', 'WORKLOAD_SOURCE_BINDING');
    }
    const rowsById = new Map(initialJudgmentRows.map((row) => [row.judgment_id, row]));
    for (const finding of source.findings) {
      const judgment = rowsById.get(finding.source_judgment_id);
      if (!judgment) fail(`${finding.case_id} follow-up finding is not bound to an initial judgment event`, 'WORKLOAD_SOURCE_BINDING');
      assertEqual(judgment.pass_id, 'initial-review', `${finding.case_id} follow-up source pass`, 'WORKLOAD_SOURCE_BINDING');
      assertEqual(judgment.unit_id, finding.case_id, `${finding.case_id} follow-up judgment unit`, 'WORKLOAD_SOURCE_BINDING');
      assertEqual(judgment.pass_session_id, source.source_pass_session_id, `${finding.case_id} follow-up pass session`, 'WORKLOAD_SOURCE_BINDING');
      assertEqual(judgment.evidence.decision_row_sha256, finding.source_judgment_row_sha256, `${finding.case_id} follow-up judgment digest`, 'WORKLOAD_SOURCE_BINDING');
    }
  }
  if (initialPass && Date.parse(source.created_at) < Date.parse(initialPass.completed_at)) {
    fail('follow-up source was created before initial-review completed', 'WORKLOAD_SOURCE_CHRONOLOGY');
  }
  const queues = deriveM5DFollowUpQueues(source);
  return {
    source,
    correction_ids: queues.feedback,
    held_rejected_ids: queues.heldRejected,
    finding_ids: [...findingIds],
    sha256: followUpSourceDigest(sourceInput),
  };
}

export function freezeM5DWorkload(workload, followUpSource, {
  proposalCaseIds = allCaseIds(),
  proposalSha256,
  proposalCasesById,
  followUpSha256,
  timingSessionId,
  freezeEventId,
  frozenAt = new Date().toISOString(),
} = {}) {
  validateM5DWorkload(workload, { proposalCaseIds, proposalSha256, proposalCasesById });
  if (workload.declaration_status !== 'pre-review') fail('only a pre-review workload can receive the initial-review queue', 'WORKLOAD_FREEZE_STATE');
  const sourceValue = followUpSourceValue(followUpSource);
  const sourceInfo = validateM5DFollowUpSource(followUpSource, {
    proposalCaseIds,
    proposalSha256,
    proposalCasesById,
    timingSessionId,
  });
  if (followUpSha256 !== undefined) assertEqual(sourceInfo.sha256, followUpSha256, 'follow-up source digest drifted', 'WORKLOAD_SOURCE_BINDING');
  const next = structuredClone(workload);
  next.declaration_status = 'frozen';
  next.frozen_at = frozenAt;
  next.source = {
    ...next.source,
    follow_up_artifact: next.source.proposal_artifact === 'contract:m5-10d-calibration-proposal'
      ? 'contract:m5-10d-follow-up-source'
      : M5_10D_FOLLOW_UP_ARTIFACT,
    follow_up_sha256: sourceInfo.sha256,
    follow_up_source_kind: M5_10D_FOLLOW_UP_SOURCE_KIND,
    follow_up_timing_session_id: sourceValue.timing_session_id,
    follow_up_pass_id: sourceValue.source_pass_id,
    follow_up_freeze_event_id: freezeEventId ?? sourceValue.freeze_event_id,
  };
  const queues = {
    'feedback-fixes': sourceInfo.correction_ids,
    'final-verification': sourceInfo.correction_ids,
    'held-rejected': sourceInfo.held_rejected_ids,
  };
  for (const pass of next.passes) {
    if (!queues[pass.id]) continue;
    const expectedUnitIds = queues[pass.id];
    pass.declared_at = frozenAt;
    pass.expected_unit_ids = [...expectedUnitIds];
    pass.expected_unit_count = expectedUnitIds.length;
    pass.expected_unit_set_sha256 = workloadUnitSetSha256(expectedUnitIds);
    pass.empty_work = expectedUnitIds.length === 0;
  }
  return next;
}

export function workloadUnitSetSha256(unitIds) {
  return sha256Json(unitIds);
}

const PASS_CONTRACT = Object.freeze({
  'target-preparation': { role: 'target-preparation', unit_kind: 'calibration-start', declaration_source: 'pre-review-sample' },
  'initial-review': { role: 'semantic-review', unit_kind: 'calibration-start', declaration_source: 'pre-review-sample' },
  'feedback-fixes': { role: 'feedback-fix', unit_kind: 'feedback-fix', declaration_source: 'source-derived-initial-findings' },
  'final-verification': { role: 'final-verification', unit_kind: 'final-verification', declaration_source: 'source-derived-correction-findings' },
  'held-rejected': { role: 'held-rejected', unit_kind: 'held-rejected', declaration_source: 'source-derived-initial-findings' },
  'post-freeze-audit': { role: 'post-freeze-audit', unit_kind: 'audit-review', declaration_source: 'frozen-editorial-sample' },
});

export function validateM5DWorkload(workload, {
  proposalCaseIds = allCaseIds(),
  proposalSha256,
  proposalCasesById,
  followUpSource,
  timingSessionId,
} = {}) {
  validateSchema(workload, workloadValidator, 'workload', 'M5-10D workload', 'WORKLOAD_SCHEMA_ERROR');
  assertEqual(workload.process_revision, M5_10D_PROCESS_REVISION, 'workload process revision drifted', 'WORKLOAD_SCOPE_MISMATCH');
  assertEqual(workload.case_count, M5_10D_CASE_COUNT, 'workload case count drifted', 'WORKLOAD_SCOPE_MISMATCH');
  assertEqual(workload.processed_start_count, M5_10D_PROCESSED_START_COUNT, 'workload denominator drifted', 'WORKLOAD_SCOPE_MISMATCH');
  if (proposalSha256 !== undefined) assertEqual(workload.source.proposal_sha256, proposalSha256, 'workload proposal digest drifted', 'WORKLOAD_SOURCE_BINDING');
  requireTimestamp(workload.frozen_at, 'workload frozen_at');
  const passMap = new Map();
  assertExactIds(workload.passes.map(({ id }) => id), M5_10D_PASS_IDS, 'workload passes', 'WORKLOAD_SCOPE_MISMATCH');
  for (const pass of workload.passes) {
    const expectedContract = PASS_CONTRACT[pass.id];
    assertEqual(
      { role: pass.role, unit_kind: pass.unit_kind, declaration_source: pass.declaration_source },
      expectedContract,
      `${pass.id} workload role`,
      'WORKLOAD_ROLE_MISMATCH',
    );
    requireTimestamp(pass.declared_at, `${pass.id}.declared_at`);
    if (Date.parse(pass.declared_at) > Date.parse(workload.frozen_at)) fail(`${pass.id} was declared after workload freeze`, 'WORKLOAD_CHRONOLOGY');
    assertEqual(pass.expected_unit_count, pass.expected_unit_ids.length, `${pass.id} workload count`, 'WORKLOAD_SCOPE_MISMATCH');
    assertEqual(pass.expected_unit_set_sha256, workloadUnitSetSha256(pass.expected_unit_ids), `${pass.id} workload digest`, 'WORKLOAD_DIGEST_MISMATCH');
    assertEqual(pass.empty_work, pass.expected_unit_ids.length === 0, `${pass.id} empty-work declaration`, 'WORKLOAD_EMPTY_PASS_MISMATCH');
    for (const unitId of pass.expected_unit_ids) {
      if (!proposalCaseIds.includes(unitId)) fail(`${pass.id} declares ${unitId} outside proposal`, 'WORKLOAD_SCOPE_MISMATCH');
    }
    passMap.set(pass.id, pass);
  }
  assertExactIds(passMap.get('target-preparation').expected_unit_ids, proposalCaseIds, 'target-preparation workload', 'WORKLOAD_SCOPE_MISMATCH');
  assertExactIds(passMap.get('initial-review').expected_unit_ids, proposalCaseIds, 'initial-review workload', 'WORKLOAD_SCOPE_MISMATCH');
  assertExactIds(passMap.get('post-freeze-audit').expected_unit_ids, proposalCaseIds, 'post-freeze-audit workload', 'WORKLOAD_SCOPE_MISMATCH');
  assertExactIds(
    passMap.get('final-verification').expected_unit_ids,
    passMap.get('feedback-fixes').expected_unit_ids,
    'final-verification workload',
    'WORKLOAD_ROLE_MISMATCH',
  );
  const initial = new Set(passMap.get('initial-review').expected_unit_ids);
  const feedback = new Set(passMap.get('feedback-fixes').expected_unit_ids);
  const verification = new Set(passMap.get('final-verification').expected_unit_ids);
  const held = new Set(passMap.get('held-rejected').expected_unit_ids);
  const hasFollowUpWork = feedback.size > 0 || verification.size > 0 || held.size > 0;
  const hasFollowUpSource = Boolean(
    workload.source.follow_up_artifact
      || workload.source.follow_up_sha256
      || workload.source.follow_up_source_kind
      || workload.source.follow_up_timing_session_id
      || workload.source.follow_up_pass_id
      || workload.source.follow_up_freeze_event_id,
  );
  if (workload.declaration_status === 'pre-review' && hasFollowUpWork) {
    fail('pre-review workload cannot contain follow-up units before initial findings are frozen', 'WORKLOAD_SOURCE_REQUIRED');
  }
  if (hasFollowUpWork || hasFollowUpSource) {
    if (!workload.source.follow_up_sha256 || !workload.source.follow_up_source_kind || !workload.source.follow_up_timing_session_id) {
      fail('follow-up workload requires a recorder-owned source artifact digest', 'WORKLOAD_SOURCE_REQUIRED');
    }
    if (!followUpSource) fail('follow-up workload source artifact is missing', 'WORKLOAD_SOURCE_REQUIRED');
    const followUpInfo = validateM5DFollowUpSource(followUpSource, {
      proposalCaseIds,
      proposalSha256,
      proposalCasesById,
      timingSessionId,
    });
    const sourceDigest = followUpSourceDigest(followUpSource);
    if (!sourceDigest) fail('follow-up source artifact digest is missing', 'WORKLOAD_SOURCE_REQUIRED');
    assertEqual(workload.source.follow_up_sha256, sourceDigest, 'workload follow-up source digest drifted', 'WORKLOAD_SOURCE_BINDING');
    assertEqual(workload.source.follow_up_source_kind, M5_10D_FOLLOW_UP_SOURCE_KIND, 'workload follow-up source kind drifted', 'WORKLOAD_SOURCE_BINDING');
    assertEqual(workload.source.follow_up_timing_session_id, followUpSourceValue(followUpSource).timing_session_id, 'workload follow-up timing session drifted', 'WORKLOAD_SOURCE_BINDING');
    assertEqual(workload.source.follow_up_pass_id, 'initial-review', 'workload follow-up source pass drifted', 'WORKLOAD_SOURCE_BINDING');
    assertEqual(workload.source.follow_up_freeze_event_id, followUpSourceValue(followUpSource).freeze_event_id, 'workload follow-up freeze event drifted', 'WORKLOAD_SOURCE_BINDING');
    assertExactIds([...feedback], followUpInfo.correction_ids, 'feedback-fixes source alignment', 'WORKLOAD_SOURCE_BINDING');
    assertExactIds([...verification], followUpInfo.correction_ids, 'final-verification source alignment', 'WORKLOAD_SOURCE_BINDING');
    assertExactIds([...held], followUpInfo.held_rejected_ids, 'held-rejected source alignment', 'WORKLOAD_SOURCE_BINDING');
  }
  for (const unitId of [...feedback, ...verification, ...held]) {
    if (!initial.has(unitId)) fail(`${unitId} follow-up workload is outside initial review`, 'WORKLOAD_SCOPE_MISMATCH');
  }
  if ([...feedback].some((unitId) => held.has(unitId))) fail('feedback and held/rejected workloads overlap', 'WORKLOAD_OVERLAP');
  if (feedback.size === M5_10D_CASE_COUNT || held.size === M5_10D_CASE_COUNT) fail('follow-up workload mechanically repeats the full sample', 'WORKLOAD_REPETITION');
  return {
    workload,
    sha256: undefined,
    case_ids: [...proposalCaseIds],
    by_pass: passMap,
  };
}

export function validateM5DWorkloadDecisionAlignment(workloadInfo, editorialInfo) {
  const decisions = new Map(editorialInfo.editorial.records.map((row) => [row.case_id, row.decision]));
  const expectedFeedback = editorialInfo.editorial.records.filter(({ decision }) => decision === 'corrected').map(({ case_id: caseId }) => caseId);
  const expectedHeld = editorialInfo.editorial.records
    .filter(({ decision }) => decision === 'held' || decision === 'rejected')
    .map(({ case_id: caseId }) => caseId);
  const actualFeedback = workloadInfo.by_pass.get('feedback-fixes').expected_unit_ids;
  const actualVerification = workloadInfo.by_pass.get('final-verification').expected_unit_ids;
  const actualHeld = workloadInfo.by_pass.get('held-rejected').expected_unit_ids;
  assertExactIds(actualFeedback, expectedFeedback, 'feedback-fixes decision alignment', 'WORKLOAD_DECISION_MISMATCH');
  assertExactIds(actualVerification, expectedFeedback, 'final-verification decision alignment', 'WORKLOAD_DECISION_MISMATCH');
  assertExactIds(actualHeld, expectedHeld, 'held-rejected decision alignment', 'WORKLOAD_DECISION_MISMATCH');
  for (const unitId of workloadInfo.case_ids) {
    if (!decisions.has(unitId)) fail(`${unitId} has no editorial decision`, 'EDITORIAL_SCOPE_MISMATCH');
  }
  return true;
}

function timingPassIds(timingKind) {
  return timingKind === 'editorial' ? M5_10D_EDITORIAL_PASS_IDS : M5_10D_AUDIT_PASS_IDS;
}

function parseWorkLog(pass) {
  const evidence = pass.work_evidence;
  if (!evidence || typeof evidence !== 'object') fail(`${pass.id} is missing recorder work evidence`, 'TIMING_INCOMPLETE');
  const logPath = resolveAnyPath(evidence.path);
  const bytes = readSyncBytes(logPath, `${pass.id} timing work log`);
  if (bytes.length > 0 && bytes.at(-1) !== 10) fail(`${pass.id} work log is not newline-terminated`, 'TIMING_WORK_LOG_INVALID');
  const rows = bytes.length === 0 ? [] : bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${pass.id} work log line ${index + 1} is invalid JSON: ${error.message}`, 'TIMING_WORK_LOG_INVALID');
    }
  });
  assertEqual(sha256Bytes(bytes), evidence.sha256, `${pass.id} work log digest drifted`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  return { rows, bytes };
}

function parseJudgmentLog(pass) {
  const evidence = pass.judgment_evidence;
  if (!evidence || typeof evidence !== 'object') fail(`${pass.id} is missing recorder judgment evidence`, 'TIMING_EDITOR_WORK_MISSING');
  const logPath = resolveAnyPath(evidence.path);
  const bytes = readSyncBytes(logPath, `${pass.id} timing judgment log`);
  if (bytes.length > 0 && bytes.at(-1) !== 10) fail(`${pass.id} judgment log is not newline-terminated`, 'TIMING_JUDGMENT_LOG_INVALID');
  const rows = bytes.length === 0 ? [] : bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${pass.id} judgment log line ${index + 1} is invalid JSON: ${error.message}`, 'TIMING_JUDGMENT_LOG_INVALID');
    }
  });
  assertEqual(sha256Bytes(bytes), evidence.sha256, `${pass.id} judgment log digest drifted`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
  return { rows, bytes };
}

function validateProposalOnlyWorkRow(row, passId, expectedCase) {
  if (!row || typeof row !== 'object' || row.kind !== 'work') fail(`${passId} contains a non-work row`, 'TIMING_WORK_LOG_INVALID');
  if (!row.input || typeof row.input !== 'object' || typeof row.input.payload !== 'object') fail(`${passId} row is missing bound input`, 'PRODUCER_INPUT_MISSING');
  assertNoVerdictKeys(row.input.payload, `${passId}:${row.unit_id} input`);
  assertNoRawProposal(row.input.payload, `${passId}:${row.unit_id} input`);
  if (!row.producer || typeof row.producer !== 'object') fail(`${passId}:${row.unit_id} is missing producer execution`, 'PRODUCER_EXECUTION_MISSING');
  if (!String(row.producer.module).endsWith('scripts/batch/produce-m5-10d-work.mjs')) fail(`${passId} used a non-M5-10D producer`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.producer.export, 'produce', `${passId} producer export`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.producer.version, M5_10D_PRODUCER_VERSION, `${passId} producer version`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.payload.producer_version, M5_10D_PRODUCER_VERSION, `${passId} payload producer version`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.payload.proposal_only, true, `${passId} producer output is not proposal-only`, 'PRODUCER_VERDICT_FORBIDDEN');
  assertNoVerdictKeys(row.payload, `${passId}:${row.unit_id} output`);
  assertNoRawProposal(row.payload, `${passId}:${row.unit_id} output`);
  assertEqual(row.input.payload, expectedCase, `${passId}:${row.unit_id} proposal input`, 'PRODUCER_INPUT_MISMATCH');
  assertEqual(row.input.payload_sha256, sha256Json(row.input.payload), `${passId}:${row.unit_id} input digest`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.producer.input_payload_sha256, row.input.payload_sha256, `${passId}:${row.unit_id} producer input digest`, 'PRODUCER_PROVENANCE_MISMATCH');
  assertEqual(row.producer.output_sha256, sha256Json(row.payload), `${passId}:${row.unit_id} producer output digest`, 'PRODUCER_PROVENANCE_MISMATCH');
  requireTimestamp(row.recorded_at, `${passId}:${row.unit_id}.recorded_at`);
  requireTimestamp(row.producer.started_at, `${passId}:${row.unit_id}.producer.started_at`);
  requireTimestamp(row.producer.completed_at, `${passId}:${row.unit_id}.producer.completed_at`);
  if (Date.parse(row.producer.completed_at) < Date.parse(row.producer.started_at)) fail(`${passId}:${row.unit_id} producer chronology is invalid`, 'TIMING_CHRONOLOGY');
  assertEqual(row.recorded_at, row.producer.completed_at, `${passId}:${row.unit_id} recorded_at`, 'PRODUCER_PROVENANCE_MISMATCH');
  return row;
}

function validateJudgmentArtifact(row, pass, timing, expectedCasesById, expectedProposalSha256) {
  const evidence = row.evidence;
  requireString(evidence.path, `${pass.id}:${row.unit_id} judgment artifact path`, 'TIMING_EDITOR_WORK_MISSING');
  requireSha256(evidence.decision_artifact_sha256, `${pass.id}:${row.unit_id} decision artifact digest`);
  requireSha256(evidence.decision_row_sha256, `${pass.id}:${row.unit_id} decision row digest`);
  const expectedCase = expectedCasesById?.get(row.unit_id);
  if (!expectedCase) fail(`${pass.id}:${row.unit_id} judgment is outside proposal`, 'EDITORIAL_SCOPE_MISMATCH');
  assertEqual(evidence.path, pass.judgment_evidence.path, `${pass.id}:${row.unit_id} decision row log path`, 'TIMING_SOURCE_BINDING');
  assertEqual(evidence.decision_artifact_kind, 'recorder-owned-decision-row', `${pass.id}:${row.unit_id} judgment artifact kind`, 'TIMING_EDITORIAL_PROVENANCE');
  if (!row.decision_row || typeof row.decision_row !== 'object' || Array.isArray(row.decision_row)) {
    fail(`${pass.id}:${row.unit_id} recorder-owned decision row is missing`, 'TIMING_EDITOR_WORK_MISSING');
  }
  assertEqual(row.decision_row.case_id, row.unit_id, `${pass.id}:${row.unit_id} decision row case`, 'TIMING_SOURCE_BINDING');
  assertEqual(row.decision_row.source_record_sha256, expectedCase.source_record_sha256, `${pass.id}:${row.unit_id} decision row source`, 'TIMING_SOURCE_BINDING');
  assertEqual(evidence.source_record_sha256, expectedCase.source_record_sha256, `${pass.id}:${row.unit_id} source record`, 'TIMING_SOURCE_BINDING');
  assertEqual(evidence.decision_row_sha256, sha256Json(row.decision_row), `${pass.id}:${row.unit_id} decision row digest`, 'TIMING_SOURCE_BINDING');
  assertEqual(evidence.decision_artifact_sha256, evidence.decision_row_sha256, `${pass.id}:${row.unit_id} decision row artifact digest`, 'TIMING_SOURCE_BINDING');
  const expectedSourceArtifactSha256 = timing.timing_kind === 'post-freeze-audit'
    ? timing.editorial_decisions_sha256
    : expectedProposalSha256;
  const expectedSourceArtifactKind = timing.timing_kind === 'post-freeze-audit'
    ? 'editorial-decisions'
    : 'proposal';
  assertEqual(evidence.source_artifact_kind, expectedSourceArtifactKind, `${pass.id}:${row.unit_id} source artifact kind`, 'TIMING_SOURCE_BINDING');
  assertEqual(evidence.source_artifact_sha256, expectedSourceArtifactSha256, `${pass.id}:${row.unit_id} source artifact digest`, 'TIMING_SOURCE_BINDING');
  if (!['decision-json', 'decision-file'].includes(evidence.decision_input_kind)) {
    fail(`${pass.id}:${row.unit_id} judgment input kind is invalid`, 'TIMING_EDITOR_WORK_MISSING');
  }
  requireSha256(evidence.decision_input_sha256, `${pass.id}:${row.unit_id} decision input digest`);
  requireTimestamp(evidence.decision_input_authored_at, `${pass.id}:${row.unit_id} decision input authored_at`, 'TIMING_EDITOR_WORK_MISSING');
  assertEqual(evidence.decision_input_authored_at, row.decision_row_authored_at, `${pass.id}:${row.unit_id} decision input authored_at`, 'TIMING_SOURCE_BINDING');
  if (Date.parse(evidence.decision_input_authored_at) < Date.parse(row.started_at)) {
    fail(`${pass.id}:${row.unit_id} decision input was authored before judgment started`, 'TIMING_EDITOR_WORK_MISSING');
  }
}

export function validateM5DDecisionRowChronology(row, label = 'decision row') {
  requireTimestamp(row.started_at, `${label} started_at`);
  requireTimestamp(row.completed_at, `${label} completed_at`);
  requireTimestamp(row.decision_row_authored_at, `${label} decision_row_authored_at`, 'TIMING_EDITOR_WORK_MISSING');
  if (Date.parse(row.completed_at) < Date.parse(row.started_at)) fail(`${label} chronology is invalid`, 'TIMING_CHRONOLOGY');
  if (Date.parse(row.decision_row_authored_at) < Date.parse(row.started_at)) fail(`${label} existed before judgment started`, 'TIMING_EDITOR_WORK_MISSING');
  if (Date.parse(row.decision_row_authored_at) > Date.parse(row.completed_at)) fail(`${label} was authored after completion`, 'TIMING_EDITOR_WORK_MISSING');
}

export function deriveM5DPassTiming(pass, judgmentRows = []) {
  const judgmentSeconds = judgmentRows.reduce((total, row) => total + ((Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000), 0);
  const expectedUnitCount = pass.work_evidence?.expected_unit_ids?.length ?? judgmentRows.length;
  if (expectedUnitCount === 0) {
    return { editorSeconds: 0, judgmentSeconds };
  }
  requireTimestamp(pass.judgment_window_started_at, `${pass.id} judgment_window_started_at`);
  const windowStartedAt = Date.parse(pass.judgment_window_started_at);
  const passStartedAt = Date.parse(pass.started_at);
  const passCompletedAt = Date.parse(pass.completed_at);
  if (windowStartedAt < passStartedAt || passCompletedAt < windowStartedAt) {
    fail(`${pass.id} continuous judgment window chronology is invalid`, 'TIMING_CHRONOLOGY');
  }
  const firstJudgment = judgmentRows[0];
  if (!firstJudgment || Date.parse(firstJudgment.started_at) !== windowStartedAt) {
    fail(`${pass.id} continuous judgment window is not bound to its first judgment`, 'TIMING_SOURCE_BINDING');
  }
  const editorSeconds = (passCompletedAt - windowStartedAt) / 1000;
  if (editorSeconds < judgmentSeconds) {
    fail(`${pass.id} continuous judgment window is shorter than its judgment rows`, 'TIMING_DERIVATION_MISMATCH');
  }
  return { editorSeconds, judgmentSeconds };
}

function validateJudgmentRow(row, pass, timing, expectedCasesById, expectedProposalSha256) {
  if (!row || typeof row !== 'object' || row.kind !== 'judgment') fail(`${pass.id} contains a non-judgment row`, 'TIMING_JUDGMENT_LOG_INVALID');
  requireString(row.pass_id, `${pass.id} judgment pass_id`, 'TIMING_JUDGMENT_LOG_INVALID');
  requireString(row.session_id, `${pass.id} judgment session_id`, 'TIMING_JUDGMENT_LOG_INVALID');
  requireUuid(row.pass_session_id, `${pass.id} judgment pass_session_id`);
  requireUuid(row.judgment_id, `${pass.id} judgment_id`);
  requireString(row.unit_id, `${pass.id} judgment unit_id`, 'TIMING_JUDGMENT_LOG_INVALID');
  validateM5DDecisionRowChronology(row, `${pass.id}:${row.unit_id} judgment`);
  requireTimestamp(row.recorded_at, `${pass.id}:${row.unit_id} judgment recorded_at`);
  assertEqual(row.recorded_at, row.completed_at, `${pass.id}:${row.unit_id} judgment recorded_at`, 'TIMING_JUDGMENT_LOG_INVALID');
  if (!row.evidence || typeof row.evidence !== 'object') fail(`${pass.id}:${row.unit_id} judgment evidence is missing`, 'TIMING_EDITOR_WORK_MISSING');
  validateJudgmentArtifact(row, pass, timing, expectedCasesById, expectedProposalSha256);
  if (row.judgment_mode !== timing.judgment_mode) fail(`${pass.id}:${row.unit_id} judgment mode drifted`, 'TIMING_EDITORIAL_PROVENANCE');
  if (row.start_invocation_id === row.complete_invocation_id) fail(`${pass.id}:${row.unit_id} judgment start and completion invocation were reused`, 'TIMING_JUDGMENT_INVOCATION_REUSED');
  if (timing.judgment_mode === 'manual-separate-invocation' && row.start_process_id === row.complete_process_id) {
    fail(`${pass.id}:${row.unit_id} production judgment start and completion ran in one process`, 'TIMING_JUDGMENT_INVOCATION_REUSED');
  }
  return row;
}

export function createM5DConcreteTimingProof(timing) {
  const copy = structuredClone(timing);
  delete copy.recording_proof_sha256;
  return sha256Json(copy);
}

export function validateM5DTiming(timing, {
  timingKind = timing?.timing_kind,
  workloadInfo,
  expectedProposalSha256,
  expectedEditorialSessionId,
  expectedAuditSessionId,
  expectedEditorialDecisionsSha256,
  expectedProposalCases,
} = {}) {
  validateSchema(timing, timingValidator, 'timing', 'M5-10D timing', 'TIMING_SCHEMA_ERROR');
  if (timing.timing_kind !== timingKind) fail(`timing kind must be ${timingKind}`, 'TIMING_KIND_MISMATCH');
  assertEqual(timing.measurement_kind, 'editor-judgment', 'timing measurement kind drifted', 'TIMING_MEASUREMENT_KIND');
  if (!['manual-separate-invocation', 'contract-synthetic'].includes(timing.judgment_mode)) {
    fail('timing judgment mode is missing or unsupported', 'TIMING_EDITORIAL_PROVENANCE');
  }
  requireUuid(timing.session_id, 'timing session_id');
  requireTimestamp(timing.started_at, 'timing started_at');
  requireSha256(timing.workload_sha256, 'timing workload_sha256');
  if (!Array.isArray(timing.workload_history) || timing.workload_history.length === 0) fail('timing workload history is missing', 'TIMING_SOURCE_BINDING');
  for (const [index, revision] of timing.workload_history.entries()) {
    requireSha256(revision.sha256, `timing workload_history[${index}].sha256`);
    requireTimestamp(revision.recorded_at, `timing workload_history[${index}].recorded_at`);
  }
  if (!timing.workload_history.some(({ sha256: digest }) => digest === timing.workload_sha256)) fail('timing current workload is absent from workload history', 'TIMING_SOURCE_BINDING');
  if (workloadInfo) assertEqual(timing.workload_sha256, workloadInfo.sha256, 'timing workload digest drifted', 'TIMING_SOURCE_BINDING');
  if (expectedProposalSha256 !== undefined) assertEqual(timing.proposal_sha256, expectedProposalSha256, 'timing proposal digest drifted', 'TIMING_SOURCE_BINDING');
  if (timingKind === 'editorial') requireUuid(timing.editorial_session_id, 'timing editorial_session_id');
  if (timingKind === 'post-freeze-audit') {
    requireUuid(timing.editorial_session_id, 'timing editorial_session_id');
    requireUuid(timing.audit_session_id, 'timing audit_session_id');
    requireSha256(timing.editorial_decisions_sha256, 'timing editorial_decisions_sha256');
    requireTimestamp(timing.editorial_finalized_at, 'timing editorial_finalized_at');
  }
  if (expectedEditorialSessionId !== undefined) assertEqual(timing.editorial_session_id, expectedEditorialSessionId, 'timing editorial session drifted', 'TIMING_SOURCE_BINDING');
  if (expectedAuditSessionId !== undefined) assertEqual(timing.audit_session_id, expectedAuditSessionId, 'timing audit session drifted', 'TIMING_SOURCE_BINDING');
  if (expectedEditorialDecisionsSha256 !== undefined) assertEqual(timing.editorial_decisions_sha256, expectedEditorialDecisionsSha256, 'timing editorial freeze digest drifted', 'TIMING_SOURCE_BINDING');
  const expectedPasses = timingPassIds(timingKind);
  assertExactIds(timing.passes.map(({ id }) => id), expectedPasses, `${timingKind} timing passes`, 'TIMING_SCOPE_MISMATCH');
  if (timing.status !== 'complete') fail(`${timingKind} timing is incomplete`, 'TIMING_INCOMPLETE');
  const expectedCasesById = expectedProposalCases === undefined
    ? undefined
    : new Map(expectedProposalCases instanceof Map ? expectedProposalCases : expectedProposalCases.map((item) => [item.case_id, item]));
  let totalEditorSeconds = 0;
  let totalWallClockSeconds = 0;
  let totalProducerSeconds = 0;
  const producerPayloads = [];
  const judgmentRows = [];
  const judgmentRowsByPass = {};
  const judgmentLogSha256ByPass = {};
  const passSummaries = {};
  for (const pass of timing.passes) {
    if (pass.status !== 'complete') fail(`${pass.id} timing pass is not complete`, 'TIMING_INCOMPLETE');
    requireUuid(pass.session_id, `${pass.id}.session_id`);
    requireTimestamp(pass.started_at, `${pass.id}.started_at`);
    requireTimestamp(pass.completed_at, `${pass.id}.completed_at`);
    if (workloadInfo) {
      const declaration = workloadInfo.by_pass.get(pass.id);
      if (!declaration) fail(`${pass.id} has no frozen workload declaration`, 'WORKLOAD_SCOPE_MISMATCH');
      if (Date.parse(declaration.declared_at) > Date.parse(pass.started_at)) fail(`${pass.id} started before its workload was declared`, 'WORKLOAD_CHRONOLOGY');
      assertEqual(pass.work_evidence.expected_unit_ids, declaration.expected_unit_ids, `${pass.id} expected workload`, 'TIMING_SCOPE_MISMATCH');
      assertEqual(pass.work_evidence.expected_unit_set_sha256, declaration.expected_unit_set_sha256, `${pass.id} workload set digest`, 'TIMING_SOURCE_BINDING');
      assertEqual(pass.work_status, declaration.empty_work ? 'zero-work' : 'work', `${pass.id} work status`, 'TIMING_EMPTY_PASS_MISMATCH');
    }
    requireSha256(pass.workload_sha256, `${pass.id}.workload_sha256`);
    if (!timing.workload_history.some(({ sha256: digest }) => digest === pass.workload_sha256)) fail(`${pass.id} workload revision is absent from timing history`, 'TIMING_SOURCE_BINDING');
    const elapsed = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
    if (elapsed < 0) fail(`${pass.id} completed before it started`, 'TIMING_CHRONOLOGY');
    const { rows } = parseWorkLog(pass);
    const expectedIds = pass.work_evidence.expected_unit_ids;
    const rowsIds = rows.map(({ unit_id: unitId }) => unitId);
    assertExactIds(rowsIds, expectedIds, `${pass.id} actual recorder scope`, 'TIMING_SCOPE_MISMATCH');
    assertEqual(pass.work_evidence.actual_unit_ids, rowsIds, `${pass.id} actual workload evidence`, 'TIMING_SCOPE_MISMATCH');
    assertEqual(pass.work_evidence.unit_count, rows.length, `${pass.id} recorder work count`, 'TIMING_SCOPE_MISMATCH');
    const { rows: judgmentLogRows } = parseJudgmentLog(pass);
    const judgmentLogBytes = readSyncBytes(resolveAnyPath(pass.judgment_evidence.path), `${pass.id} timing judgment log`);
    judgmentLogSha256ByPass[pass.id] = sha256Bytes(judgmentLogBytes);
    const judgmentIds = judgmentLogRows.map(({ unit_id: unitId }) => unitId);
    const expectedJudgmentEventIds = expectedIds.map((unitId) => `m5-10d-judgment-${pass.id}-${unitId}`);
    assertExactIds(judgmentIds, expectedIds, `${pass.id} actual judgment scope`, 'TIMING_EDITOR_WORK_MISSING');
    assertEqual(pass.judgment_evidence.actual_unit_ids, judgmentIds, `${pass.id} actual judgment evidence`, 'TIMING_EDITOR_WORK_MISSING');
    assertEqual(pass.judgment_evidence.unit_count, judgmentLogRows.length, `${pass.id} judgment count`, 'TIMING_EDITOR_WORK_MISSING');
    assertEqual(pass.judgment_evidence.expected_unit_ids, expectedIds, `${pass.id} expected judgment workload`, 'TIMING_SCOPE_MISMATCH');
    assertEqual(pass.judgment_evidence.expected_unit_set_sha256, pass.work_evidence.expected_unit_set_sha256, `${pass.id} judgment workload digest`, 'TIMING_SOURCE_BINDING');
    assertEqual(pass.judgment_evidence.event_ids, expectedJudgmentEventIds, `${pass.id} judgment event coverage`, 'TIMING_EDITOR_WORK_MISSING');
    assertEqual(sha256Bytes(readSyncBytes(resolveAnyPath(pass.judgment_evidence.path), `${pass.id} timing judgment log`)), pass.judgment_evidence.sha256, `${pass.id} judgment log digest`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
    for (const row of judgmentLogRows) {
      validateJudgmentRow(row, pass, timing, expectedCasesById, expectedProposalSha256);
      assertEqual(row.pass_id, pass.id, `${pass.id}:${row.unit_id} judgment pass`, 'TIMING_JUDGMENT_LOG_INVALID');
      assertEqual(row.session_id, timing.session_id, `${pass.id}:${row.unit_id} judgment session`, 'TIMING_SOURCE_BINDING');
      assertEqual(row.pass_session_id, pass.session_id, `${pass.id}:${row.unit_id} judgment pass session`, 'TIMING_SOURCE_BINDING');
      if (Date.parse(row.started_at) < Date.parse(pass.started_at) || Date.parse(row.completed_at) > Date.parse(pass.completed_at)) fail(`${pass.id}:${row.unit_id} judgment is outside its pass`, 'TIMING_CHRONOLOGY');
      const event = timing.events.find(({ event_id: eventId }) => eventId === `m5-10d-judgment-${pass.id}-${row.unit_id}`);
      if (!event) fail(`${pass.id}:${row.unit_id} judgment completion event is missing`, 'TIMING_EDITOR_WORK_MISSING');
      assertEqual(event.pass_session_id, pass.session_id, `${pass.id}:${row.unit_id} judgment event pass session`, 'TIMING_SOURCE_BINDING');
      assertEqual(event.decision_artifact_sha256, row.evidence.decision_artifact_sha256, `${pass.id}:${row.unit_id} judgment event artifact`, 'TIMING_SOURCE_BINDING');
      assertEqual(event.decision_row_sha256, row.evidence.decision_row_sha256, `${pass.id}:${row.unit_id} judgment event row`, 'TIMING_SOURCE_BINDING');
    }
    const derivedTiming = deriveM5DPassTiming(pass, judgmentLogRows);
    assertEqual(pass.judgment_seconds, derivedTiming.judgmentSeconds, `${pass.id} judgment seconds`, 'TIMING_DERIVATION_MISMATCH');
    assertEqual(pass.editor_seconds, derivedTiming.editorSeconds, `${pass.id} editor seconds`, 'TIMING_DERIVATION_MISMATCH');
    if (expectedIds.length === 0) {
      assertEqual(pass.work_status, 'zero-work', `${pass.id} empty pass status`, 'TIMING_EMPTY_PASS_MISMATCH');
      assertEqual(pass.editor_seconds, 0, `${pass.id} empty pass editor time`, 'TIMING_EMPTY_PASS_MISMATCH');
      assertEqual(pass.judgment_seconds, 0, `${pass.id} empty pass judgment time`, 'TIMING_EMPTY_PASS_MISMATCH');
    } else {
      assertEqual(pass.work_status, 'work', `${pass.id} non-empty pass status`, 'TIMING_EMPTY_PASS_MISMATCH');
      if (judgmentLogRows.length === 0) fail(`${pass.id} has producer work but no editor judgment events`, 'TIMING_EDITOR_WORK_MISSING');
    }
    assertEqual(pass.wall_clock_seconds, elapsed, `${pass.id} wall-clock seconds`, 'TIMING_DERIVATION_MISMATCH');
    let producerSeconds = 0;
    for (const row of rows) {
      if (!expectedCasesById) fail(`${pass.id} cannot validate work without proposal cases`, 'PRODUCER_INPUT_MISSING');
      const expectedCase = expectedCasesById.get(row.unit_id);
      if (!expectedCase) fail(`${pass.id}:${row.unit_id} is outside proposal`, 'PRODUCER_INPUT_MISMATCH');
      const validated = validateProposalOnlyWorkRow(row, pass.id, expectedCase);
      producerPayloads.push(validated.payload);
      producerSeconds += (Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000;
      if (Date.parse(row.producer.started_at) < Date.parse(pass.started_at)
        || Date.parse(row.producer.completed_at) > Date.parse(pass.completed_at)) {
        fail(`${pass.id}:${row.unit_id} producer execution is outside its editor pass`, 'TIMING_CHRONOLOGY');
      }
    }
    assertEqual(pass.producer_seconds, producerSeconds, `${pass.id} producer seconds`, 'TIMING_DERIVATION_MISMATCH');
    const judgmentLogSource = parseJudgmentLog(pass);
    assertEqual(pass.judgment_evidence.sha256, sha256Bytes(judgmentLogSource.bytes), `${pass.id} judgment evidence digest`, 'TIMING_ARTIFACT_DIGEST_MISMATCH');
    for (const eventId of expectedJudgmentEventIds) {
      if (!timing.events.some(({ event_id: candidate }) => candidate === eventId)) fail(`${pass.id} missing judgment event ${eventId}`, 'TIMING_EDITOR_WORK_MISSING');
    }
    judgmentRows.push(...judgmentLogRows);
    judgmentRowsByPass[pass.id] = judgmentLogRows;
    totalEditorSeconds += pass.editor_seconds;
    totalWallClockSeconds += pass.wall_clock_seconds;
    totalProducerSeconds += pass.producer_seconds;
    passSummaries[pass.id] = {
      work_status: pass.work_status,
      editor_seconds: pass.editor_seconds,
      wall_clock_seconds: pass.wall_clock_seconds,
      producer_seconds: pass.producer_seconds,
      judgment_seconds: pass.judgment_seconds,
      unit_count: pass.work_evidence.unit_count,
      expected_unit_ids: [...expectedIds],
      actual_unit_ids: [...rowsIds],
    };
  }
  if (timing.status === 'complete' && Array.isArray(timing.active_judgments) && timing.active_judgments.length > 0) fail('timing completed with active judgment events', 'TIMING_EDITOR_WORK_MISSING');
  if (timing.completed_at !== undefined) {
    requireTimestamp(timing.completed_at, 'timing completed_at');
    if (Date.parse(timing.completed_at) < Date.parse(timing.started_at)) fail('timing completed before it started', 'TIMING_CHRONOLOGY');
  }
  assertEqual(timing.recording_proof_sha256, createM5DConcreteTimingProof(timing), 'timing recording proof drifted', 'TIMING_PROOF_MISMATCH');
  return {
    timing,
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
    pass_ids: expectedPasses,
    zero_work_pass_ids: timing.passes.filter(({ work_status: workStatus }) => workStatus === 'zero-work').map(({ id }) => id),
    passes: passSummaries,
    producer_payloads: producerPayloads,
    judgment_rows: judgmentRows,
    judgment_rows_by_pass: judgmentRowsByPass,
    judgment_log_sha256_by_pass: judgmentLogSha256ByPass,
  };
}

function requireRecordSpecificEvidence(text, caseId, marker, senseIds, label) {
  requireString(text, label, 'EDITORIAL_EVIDENCE_MISMATCH');
  if (!text.includes(caseId) || !text.includes(marker) || !senseIds.some((senseId) => text.includes(senseId))) {
    fail(`${label} is not record-specific`, 'EDITORIAL_EVIDENCE_MISMATCH');
  }
}

function validateEditorialRows(records, proposalInfo, producerPayloads = []) {
  assertExactIds(records.map(({ case_id: caseId }) => caseId), proposalInfo.case_ids, 'editorial records');
  const producerPayloadSet = new Set(producerPayloads.map((payload) => JSON.stringify(payload)));
  const evidenceFingerprints = new Set();
  for (const row of records) {
    const source = proposalInfo.by_case.get(row.case_id);
    if (!source) fail(`${row.case_id} editorial record is outside proposal`, 'EDITORIAL_SCOPE_MISMATCH');
    const sourceSenseIds = source.record.senses.map(({ id }) => id);
    const sourcePos = source.record.senses.map(({ pos }) => pos);
    assertEqual(row.record_id, source.record.id, `${row.case_id} record ID`, 'EDITORIAL_SOURCE_BINDING');
    assertEqual(row.source_record_sha256, sha256Json(source.record), `${row.case_id} source record digest`, 'EDITORIAL_SOURCE_BINDING');
    assertEqual(row.lemma_pos.observed_pos, sourcePos, `${row.case_id} POS observation`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_sense_count, source.record.senses.length, `${row.case_id} sense count`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_sense_ids, sourceSenseIds, `${row.case_id} sense IDs`, 'EDITORIAL_SENSE_MISMATCH');
    assertEqual(row.sense_review.observed_pos, sourcePos, `${row.case_id} sense POS`, 'EDITORIAL_SENSE_MISMATCH');
    requireRecordSpecificEvidence(row.lemma_pos.note, row.case_id, 'lemma-pos', sourceSenseIds, `${row.case_id}.lemma_pos.note`);
    requireRecordSpecificEvidence(row.sense_review.note, row.case_id, 'sense-review', sourceSenseIds, `${row.case_id}.sense_review.note`);
    for (const boundaryId of M5_10D_BOUNDARY_IDS) {
      const evidence = row.boundary_reviews[boundaryId];
      requireRecordSpecificEvidence(evidence.evidence, row.case_id, boundaryId, sourceSenseIds, `${row.case_id}.${boundaryId}.evidence`);
      const fingerprint = evidence.evidence.normalize('NFC')
        .replaceAll(row.case_id, '{case}')
        .replaceAll(row.record_id, '{record}')
        .replaceAll(source.record.lemma, '{lemma}')
        .replaceAll(boundaryId, '{boundary}')
        .replaceAll(/cal-m5-10d-[0-9]{3}-s[1-9][0-9]*/gu, '{sense}');
      if (evidenceFingerprints.has(fingerprint)) fail(`${row.case_id} reuses generic boundary evidence`, 'GENERIC_EDITORIAL_EVIDENCE');
      evidenceFingerprints.add(fingerprint);
      if (evidence.applicability === 'applicable' && evidence.decision !== 'split' && source.record.senses.length > 1) {
        fail(`${row.case_id} applicable boundary did not preserve a split`, 'EDITORIAL_SENSE_MISMATCH');
      }
    }
    if (row.decision === 'corrected') {
      if (!Array.isArray(row.corrected_fields) || row.corrected_fields.length === 0) fail(`${row.case_id} corrected decision has no corrected_fields`, 'EDITORIAL_DECISION_MISMATCH');
    } else if (row.corrected_fields !== undefined) {
      fail(`${row.case_id} non-corrected decision carries corrected_fields`, 'EDITORIAL_DECISION_MISMATCH');
    }
    requireRecordSpecificEvidence(row.decision_note, row.case_id, row.record_id, sourceSenseIds, `${row.case_id}.decision_note`);
    if (producerPayloadSet.has(JSON.stringify(row))) fail(`${row.case_id} decision was copied from a producer payload`, 'EDITORIAL_DECISION_ORACLE');
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

export function validateM5DEditorialDecisionChronology(editorial, timingSummary) {
  const timing = timingSummary.timing ?? timingSummary;
  const initialPass = timing.passes.find(({ id }) => id === 'initial-review');
  if (!initialPass) fail('editorial timing is missing initial-review', 'TIMING_SCOPE_MISMATCH');
  const firstPassStartedAt = Date.parse(initialPass.started_at);
  const lastStop = Math.max(...timing.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
  requireTimestamp(editorial.draft_created_at, 'editorial draft_created_at');
  if (Date.parse(editorial.draft_created_at) < firstPassStartedAt || Date.parse(editorial.draft_created_at) > lastStop) {
    fail('editorial decision draft was not authored during semantic review timing', 'EDITORIAL_DECISION_CHRONOLOGY');
  }
  if (Date.parse(editorial.created_at) <= lastStop) fail('editorial decision artifact was created before timing stopped', 'EDITORIAL_DECISION_CHRONOLOGY');
  if (Date.parse(editorial.finalized_at) <= Date.parse(editorial.created_at)) fail('editorial finalization chronology is invalid', 'EDITORIAL_DECISION_CHRONOLOGY');
  return { final_stop_at: new Date(lastStop).toISOString() };
}

function validateEditorialJudgmentBindings(editorial, timingSummary) {
  const rowsByPass = timingSummary.judgment_rows_by_pass ?? {};
  for (const passId of ['initial-review', 'feedback-fixes', 'final-verification', 'held-rejected']) {
    for (const judgment of rowsByPass[passId] ?? []) {
      const decision = editorial.records.find(({ case_id: caseId }) => caseId === judgment.unit_id);
      if (!decision) fail(`${judgment.unit_id} editorial judgment has no finalized decision row`, 'EDITORIAL_SCOPE_MISMATCH');
      if (!judgment.decision_row) fail(`${judgment.unit_id} editorial judgment has no recorder-owned decision row`, 'EDITORIAL_SOURCE_BINDING');
      assertEqual(judgment.decision_row, decision, `${judgment.unit_id} editorial decision row`, 'EDITORIAL_SOURCE_BINDING');
      assertEqual(judgment.evidence.decision_row_sha256, sha256Json(decision), `${judgment.unit_id} editorial decision digest`, 'EDITORIAL_SOURCE_BINDING');
    }
  }
}

export function validateM5DEditorialDecisions(editorial, proposalInfo, timingSummary) {
  validateSchema(editorial, editorialValidator, 'editorial', 'M5-10D editorial decisions', 'EDITORIAL_SCHEMA_ERROR');
  assertEqual(editorial.batch_id, M5_10D_BATCH_ID, 'editorial batch ID drifted', 'EDITORIAL_SOURCE_BINDING');
  assertEqual(editorial.proposal_sha256, proposalInfo.proposal_sha256, 'editorial proposal digest drifted', 'EDITORIAL_SOURCE_BINDING');
  assertEqual(editorial.timing_session_id, timingSummary.session_id, 'editorial timing session drifted', 'EDITORIAL_SOURCE_BINDING');
  assertEqual(editorial.editorial_session_id, timingSummary.timing.editorial_session_id, 'editorial session drifted', 'EDITORIAL_SOURCE_BINDING');
  validateEditorialRows(editorial.records, proposalInfo, timingSummary.producer_payloads ?? []);
  validateEditorialJudgmentBindings(editorial, timingSummary);
  const chronology = validateM5DEditorialDecisionChronology(editorial, timingSummary);
  return {
    editorial,
    record_by_case: new Map(editorial.records.map((row) => [row.case_id, row])),
    sha256: undefined,
    final_stop_at: chronology.final_stop_at,
  };
}

export function validateM5DAuditDraftFindings(findings, expectedCaseIds = allCaseIds()) {
  if (!Array.isArray(findings)) fail('audit findings must be an array', 'AUDIT_FINDINGS_INVALID');
  const expected = new Set(expectedCaseIds);
  const ids = new Set();
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail('audit finding must be an object', 'AUDIT_FINDINGS_INVALID');
    if (Object.keys(finding).some((key) => !['id', 'severity', 'status', 'category', 'case_id', 'note'].includes(key))) fail('audit finding contains an unsupported field', 'AUDIT_FINDINGS_INVALID');
    for (const field of ['id', 'severity', 'status', 'category', 'case_id', 'note']) requireString(finding[field], `audit finding ${field}`, 'AUDIT_FINDINGS_INVALID');
    if (!/^m5-10d-audit-[a-z0-9-]+$/u.test(finding.id) || ids.has(finding.id)) fail(`audit finding ID is invalid or duplicated: ${finding.id}`, 'AUDIT_FINDINGS_INVALID');
    ids.add(finding.id);
    if (!['warning', 'blocker'].includes(finding.severity) || !['open', 'closed'].includes(finding.status)) fail('audit finding severity or status is invalid', 'AUDIT_FINDINGS_INVALID');
    if (!['source', 'sense', 'relation', 'timing', 'provenance'].includes(finding.category)) fail('audit finding category is invalid', 'AUDIT_FINDINGS_INVALID');
    if (!expected.has(finding.case_id)) fail(`audit finding case is outside the calibration sample: ${finding.case_id}`, 'AUDIT_FINDINGS_INVALID');
    if (!finding.note.includes(finding.case_id)) fail(`audit finding is not record-specific: ${finding.id}`, 'AUDIT_FINDINGS_INVALID');
  }
  return {
    findings,
    open_blocker_count: findings.filter(({ severity, status }) => severity === 'blocker' && status === 'open').length,
  };
}

function validateAuditRows(audit, editorialInfo, proposalInfo) {
  assertExactIds(audit.case_reviews.map(({ case_id: caseId }) => caseId), proposalInfo.case_ids, 'audit cases');
  for (const review of audit.case_reviews) {
    const source = proposalInfo.by_case.get(review.case_id);
    const editorial = editorialInfo.record_by_case.get(review.case_id);
    assertEqual(review.source_record_sha256, sha256Json(source.record), `${review.case_id} audit source digest`, 'AUDIT_COMPARISON_MISMATCH');
    assertEqual(review.editorial_record_sha256, sha256Json(editorial), `${review.case_id} audit editorial digest`, 'AUDIT_COMPARISON_MISMATCH');
    assertEqual(review.source_comparison, 'match', `${review.case_id} source comparison`, 'AUDIT_COMPARISON_MISMATCH');
    assertEqual(review.decision_comparison, 'match', `${review.case_id} decision comparison`, 'AUDIT_COMPARISON_MISMATCH');
    assertEqual(review.relation_comparison, 'match', `${review.case_id} relation comparison`, 'AUDIT_COMPARISON_MISMATCH');
    requireRecordSpecificEvidence(review.note, review.case_id, 'audit', source.record.senses.map(({ id }) => id), `${review.case_id}.audit.note`);
    if ('decision' in review || 'boundary_reviews' in review || 'relation_review' in review) fail(`${review.case_id} audit reused editorial output`, 'AUDIT_ORACLE_REUSE');
  }
  const findings = validateM5DAuditDraftFindings(audit.findings, proposalInfo.case_ids);
  assertEqual(audit.open_blocker_count, findings.open_blocker_count, 'audit open blocker count is not source-derived', 'AUDIT_BLOCKER_COUNT');
}

function validateAuditJudgmentBindings(audit, auditTimingSummary) {
  for (const judgment of auditTimingSummary.judgment_rows_by_pass?.['post-freeze-audit'] ?? []) {
    const review = audit.case_reviews.find(({ case_id: caseId }) => caseId === judgment.unit_id);
    if (!review) fail(`${judgment.unit_id} audit judgment has no finalized comparison row`, 'AUDIT_SCOPE_MISMATCH');
    if (!judgment.decision_row) fail(`${judgment.unit_id} audit judgment has no recorder-owned comparison row`, 'AUDIT_SOURCE_BINDING');
    assertEqual(judgment.decision_row, review, `${judgment.unit_id} audit comparison row`, 'AUDIT_SOURCE_BINDING');
    assertEqual(judgment.evidence.decision_row_sha256, sha256Json(review), `${judgment.unit_id} audit comparison digest`, 'AUDIT_SOURCE_BINDING');
  }
}

export function validateM5DAuditIndependence(audit, editorialInfo, auditTimingSummary) {
  const timing = auditTimingSummary.timing ?? auditTimingSummary;
  assertEqual(audit.audit_session_id, timing.audit_session_id, 'audit session ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.timing_session_id, timing.session_id, 'audit timing session ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.editorial_session_id, editorialInfo.editorial.editorial_session_id, 'audit editorial session ID drifted', 'AUDIT_SOURCE_BINDING');
  if (audit.audit_session_id === audit.editorial_session_id) fail('audit session must be independent', 'AUDIT_INDEPENDENCE');
  if (audit.timing_session_id === editorialInfo.editorial.timing_session_id) fail('audit timing session must be independent', 'AUDIT_INDEPENDENCE');
}

export function validateM5DAuditDecisions(audit, editorialInfo, proposalInfo, auditTimingSummary) {
  validateSchema(audit, auditValidator, 'audit', 'M5-10D audit decisions', 'AUDIT_SCHEMA_ERROR');
  assertEqual(audit.batch_id, M5_10D_BATCH_ID, 'audit batch ID drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.proposal_sha256, proposalInfo.proposal_sha256, 'audit proposal digest drifted', 'AUDIT_SOURCE_BINDING');
  assertEqual(audit.editorial_decisions_sha256, editorialInfo.sha256, 'audit editorial digest drifted', 'AUDIT_SOURCE_BINDING');
  validateM5DAuditIndependence(audit, editorialInfo, auditTimingSummary);
  const timing = auditTimingSummary.timing ?? auditTimingSummary;
  const editorialFinalizedAt = Date.parse(editorialInfo.editorial.finalized_at);
  const auditStartedAt = Date.parse(timing.passes[0].started_at);
  const auditStoppedAt = Math.max(...timing.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
  if (auditStartedAt <= editorialFinalizedAt) fail('post-freeze audit started before editorial freeze', 'AUDIT_TIMING_CHRONOLOGY');
  requireTimestamp(audit.draft_created_at, 'audit draft_created_at');
  if (Date.parse(audit.draft_created_at) < auditStartedAt || Date.parse(audit.draft_created_at) > auditStoppedAt) fail('audit draft was not authored during audit timing', 'AUDIT_DECISION_CHRONOLOGY');
  if (Date.parse(audit.created_at) <= auditStoppedAt) fail('audit artifact was created before timing stopped', 'AUDIT_DECISION_CHRONOLOGY');
  if (Date.parse(audit.finalized_at) <= Date.parse(audit.created_at)) fail('audit finalization chronology is invalid', 'AUDIT_DECISION_CHRONOLOGY');
  validateAuditRows(audit, editorialInfo, proposalInfo);
  validateAuditJudgmentBindings(audit, auditTimingSummary);
  return {
    audit,
    sha256: undefined,
    open_blocker_count: audit.open_blocker_count,
    finding_count: audit.findings.length,
  };
}

export function validateM5DFailedStageContract(stage) {
  assertEqual(stage.stage_id, 'm5-10-wave-b-plus-150', 'failed Wave B stage ID drifted', 'FAILED_STAGE_MISMATCH');
  assertEqual(stage.gate_status, 'fail', 'failed Wave B gate was changed', 'FAILED_STAGE_GATE_CHANGED');
  assertEqual(stage.decision, 'HOLD PROCESS', 'failed Wave B decision was changed', 'FAILED_STAGE_DECISION_CHANGED');
  assertEqual(stage.next_stage_authorized, false, 'failed Wave B authorized a later stage', 'FAILED_STAGE_AUTHORIZATION_CHANGED');
  assertEqual(stage.actual.canonical_snapshot, M5_10D_CANONICAL_SNAPSHOT, 'failed Wave B canonical snapshot drifted', 'FAILED_STAGE_SNAPSHOT_MISMATCH');
  assertEqual(stage.metrics.measurement_kind, 'producer-throughput', 'failed Wave B measurement kind changed', 'FAILED_STAGE_HISTORY_CHANGED');
  assertEqual(stage.metrics.editor_time_status, 'unmeasured', 'failed Wave B editor-time history changed', 'FAILED_STAGE_HISTORY_CHANGED');
  assertEqual(stage.metrics.total_editor_seconds, null, 'failed Wave B editor-time history changed', 'FAILED_STAGE_HISTORY_CHANGED');
}

export function validateM5DPreviousRecovery(recovery) {
  assertEqual(recovery.issue, 113, 'M5-10C recovery issue changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.status, 'complete', 'M5-10C recovery status changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.gate_status, 'fail', 'M5-10C recovery gate changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.decision, 'HOLD PROCESS', 'M5-10C recovery decision changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.ready_to_create, false, 'M5-10C recovery authorization changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.next_stage_created, false, 'M5-10C recovery created a later stage', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.next_stage_authorized, false, 'M5-10C recovery authorized a later stage', 'FAILED_RECOVERY_HISTORY_CHANGED');
  assertEqual(recovery.canonical_snapshot, M5_10D_CANONICAL_SNAPSHOT, 'M5-10C recovery canonical snapshot changed', 'FAILED_RECOVERY_HISTORY_CHANGED');
}

export function validateM5DVerification(verification, snapshot) {
  validateSchema(verification, verificationValidator, 'verification', 'M5-10D verification', 'VERIFICATION_SCHEMA_ERROR');
  assertEqual(verification.status, 'passed', 'M5-10D verification did not pass', 'VERIFICATION_FAILED');
  assertEqual(verification.editorial_review_complete, true, 'editorial review is incomplete', 'VERIFICATION_FAILED');
  assertEqual(verification.human_editorial_review_complete, false, 'M5-10D must not claim human review', 'VERIFICATION_PROVENANCE');
  for (const key of ['canonical_integrity', 'deterministic_sqlite', 'search_product_regression', 'calibration_canonical_mutation']) {
    assertEqual(verification[key], key === 'calibration_canonical_mutation' ? false : true, `verification ${key} drifted`, 'VERIFICATION_FAILED');
  }
  if (verification.checks.length < 4 || verification.checks.some(({ status }) => status !== 'pass')) fail('verification checks are incomplete', 'VERIFICATION_FAILED');
  assertEqual(verification.canonical_snapshot, snapshot, 'verification canonical snapshot drifted', 'VERIFICATION_FAILED');
}

export function evaluateM5DRecoveryGate({ correctionRate, relationNoiseRate, timing, audit, editorial, canonicalMutation, inventoryMutation, verification, failedStage, failedRecovery, workloadCoverage } = {}) {
  const qualityPasses = {
    correction_rate: Number.isFinite(correctionRate) && correctionRate <= M5_10D_CORRECTION_RATE_MAX,
    relation_noise_rate: Number.isFinite(relationNoiseRate)
      && relationNoiseRate <= M5_10D_RELATION_NOISE_RATE_MAX
      && relationNoiseRate < M5_10D_RELATION_NOISE_BASELINE,
    editor_seconds_per_processed_start: Number.isFinite(timing?.total_editor_seconds)
      && timing.total_editor_seconds / M5_10D_PROCESSED_START_COUNT <= M5_10D_EDITOR_SECONDS_PER_PROCESSED_START_MAX,
    timing_complete: timing?.status === 'complete' && timing?.unmeasured_pass_count === 0,
    workload_coverage: workloadCoverage === true,
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
    failed_recovery_preserved: failedRecovery?.gate_status === 'fail'
      && failedRecovery?.decision === 'HOLD PROCESS'
      && failedRecovery?.ready_to_create === false,
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

export function assertM5DRecoveryAuthorizable(recoveryResult) {
  assertEqual(recoveryResult?.gate?.gate_status, 'pass', 'authorization requires a source-validated passing recovery gate', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(recoveryResult?.gate?.decision, 'APPROVE BOUNDED', 'authorization requires an approved recovery decision', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(recoveryResult?.artifact?.ready_to_create, true, 'authorization requires recovery ready_to_create', 'AUTHORIZATION_SCOPE_MISMATCH');
  return recoveryResult;
}

function validateFailedSourceDigests(stage, sourceFiles) {
  validateM5DFailedStageContract(stage);
  for (const [key, source] of Object.entries(sourceFiles)) {
    const digestKey = `${key}_sha256`;
    if (!stage.source?.[key] || !stage.source?.[digestKey]) fail(`failed Wave B stage is missing source ${key}`, 'FAILED_STAGE_SOURCE_MISSING');
    const bytes = readSyncBytes(resolveAnyPath(stage.source[key]), `failed Wave B ${key}`);
    assertEqual(sha256Bytes(bytes), stage.source[digestKey], `failed Wave B ${key} digest drifted`, 'FAILED_STAGE_SOURCE_MISMATCH');
    assertEqual(sha256Bytes(bytes), source.sha256, `failed Wave B ${key} source changed`, 'FAILED_STAGE_SOURCE_MISMATCH');
  }
}

export function deriveM5DCalibration(editorialTiming, auditTiming, editorial, audit, workloadCoverage) {
  const decisionCounts = Object.fromEntries(['included', 'corrected', 'held', 'rejected'].map((decision) => [decision, editorial.records.filter((row) => row.decision === decision).length]));
  const correctionRate = decisionCounts.corrected / M5_10D_PROCESSED_START_COUNT;
  const relationReviews = editorial.records.map(({ relation_review: review }) => review);
  const rawProposalCount = relationReviews.filter(({ outcome }) => outcome === 'raw-proposal').length;
  const noiseCount = relationReviews.filter(({ outcome, noise_assessment: assessment }) => outcome === 'raw-proposal' && assessment === 'noise').length;
  const relationNoiseRate = rawProposalCount === 0 ? 0 : noiseCount / rawProposalCount;
  const editorialTimingSummary = editorialTiming;
  const auditTimingSummary = auditTiming;
  const totalEditorSeconds = editorialTimingSummary.total_editor_seconds + auditTimingSummary.total_editor_seconds;
  const totalWallClockSeconds = editorialTimingSummary.total_wall_clock_seconds + auditTimingSummary.total_wall_clock_seconds;
  const totalProducerSeconds = editorialTimingSummary.total_producer_seconds + auditTimingSummary.total_producer_seconds;
  return {
    case_count: M5_10D_CASE_COUNT,
    processed_start_count: M5_10D_PROCESSED_START_COUNT,
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
      editor_seconds_per_processed_start: totalEditorSeconds / M5_10D_PROCESSED_START_COUNT,
      producer_seconds_per_processed_start: totalProducerSeconds / M5_10D_PROCESSED_START_COUNT,
      unmeasured_pass_count: 0,
      pass_ids: [...M5_10D_PASS_IDS],
      zero_work_pass_ids: [...editorialTiming.zero_work_pass_ids, ...auditTiming.zero_work_pass_ids],
    },
    audit: {
      status: 'complete',
      independent: true,
      case_count: M5_10D_CASE_COUNT,
      open_blocker_count: audit.open_blocker_count,
      finding_count: audit.findings.length,
    },
    canonical_mutation: false,
    workload_coverage: workloadCoverage,
  };
}

export async function validateM5DRecovery({
  artifactPath = DEFAULT_RECOVERY_PATH,
  proposalPath = DEFAULT_PROPOSAL_PATH,
  workloadPath = DEFAULT_WORKLOAD_PATH,
  followUpSourcePath = DEFAULT_FOLLOW_UP_SOURCE_PATH,
  editorialPath = DEFAULT_EDITORIAL_DECISIONS_PATH,
  editorialTimingPath = DEFAULT_EDITORIAL_TIMING_PATH,
  auditPath = DEFAULT_AUDIT_DECISIONS_PATH,
  auditTimingPath = DEFAULT_AUDIT_TIMING_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  failedStagePath = DEFAULT_FAILED_STAGE_PATH,
  failedRecoveryPath = DEFAULT_FAILED_RECOVERY_PATH,
  repairRevisionPath = DEFAULT_REPAIR_REVISION_PATH,
  failedManifestPath = DEFAULT_FAILED_MANIFEST_PATH,
  failedMetricsPath = DEFAULT_FAILED_METRICS_PATH,
  failedVerificationPath = DEFAULT_FAILED_VERIFICATION_PATH,
  failedRelationDiffPath = DEFAULT_FAILED_RELATION_DIFF_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  inventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  const [artifactSource, proposalSource, workloadSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource, verificationSource, failedStageSource, failedRecoverySource, repairSource, failedManifestSource, failedMetricsSource, failedVerificationSource, failedRelationDiffSource, inventorySource, canonical] = await Promise.all([
    readSource(artifactPath, 'M5-10D recovery artifact'),
    readSource(proposalPath, 'M5-10D calibration proposal'),
    readSource(workloadPath, 'M5-10D workload'),
    readSource(editorialPath, 'M5-10D editorial decisions'),
    readSource(editorialTimingPath, 'M5-10D editorial timing'),
    readSource(auditPath, 'M5-10D audit decisions'),
    readSource(auditTimingPath, 'M5-10D audit timing'),
    readSource(verificationPath, 'M5-10D verification'),
    readSource(failedStagePath, 'failed Wave B stage'),
    readSource(failedRecoveryPath, 'M5-10C recovery'),
    readSource(repairRevisionPath, 'M5-10A process correction'),
    readSource(failedManifestPath, 'failed Wave B manifest'),
    readSource(failedMetricsPath, 'failed Wave B metrics'),
    readSource(failedVerificationPath, 'failed Wave B verification'),
    readSource(failedRelationDiffPath, 'failed Wave B relation diff'),
    readInventorySource(inventoryPath, canonicalDirectory),
    readCanonicalRecords(canonicalDirectory),
  ]);
  const followUpSource = workloadSource.value.source.follow_up_sha256
    ? await readSource(followUpSourcePath, 'M5-10D follow-up source')
    : undefined;
  const proposalInfo = validateM5DProposal(proposalSource.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposalSource.sha256;
  const workloadInfo = validateM5DWorkload(workloadSource.value, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: proposalSource.sha256,
    proposalCasesById: proposalInfo.by_case,
    followUpSource,
    timingSessionId: editorialTimingSource.value.session_id,
  });
  workloadInfo.sha256 = workloadSource.sha256;
  const editorialTiming = validateM5DTiming(editorialTimingSource.value, {
    timingKind: 'editorial',
    workloadInfo,
    expectedProposalSha256: proposalSource.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
  });
  if (followUpSource) {
    const initialPass = editorialTimingSource.value.passes.find(({ id }) => id === 'initial-review');
    validateM5DFollowUpSource(followUpSource, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256: proposalSource.sha256,
      proposalCasesById: proposalInfo.by_case,
      timingSessionId: editorialTimingSource.value.session_id,
      initialPassSessionId: initialPass.session_id,
      initialJudgmentRows: editorialTiming.judgment_rows_by_pass?.['initial-review'],
      initialJudgmentLogSha256: editorialTiming.judgment_log_sha256_by_pass?.['initial-review'],
      initialPass,
      freezeEventId: workloadSource.value.source.follow_up_freeze_event_id,
    });
  }
  const editorialInfo = validateM5DEditorialDecisions(editorialSource.value, proposalInfo, editorialTiming);
  editorialInfo.sha256 = editorialSource.sha256;
  const workloadCoverage = validateM5DWorkloadDecisionAlignment(workloadInfo, editorialInfo);
  const auditTiming = validateM5DTiming(auditTimingSource.value, {
    timingKind: 'post-freeze-audit',
    workloadInfo,
    expectedProposalSha256: proposalSource.sha256,
    expectedEditorialSessionId: editorialSource.value.editorial_session_id,
    expectedAuditSessionId: auditSource.value.audit_session_id,
    expectedEditorialDecisionsSha256: editorialInfo.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
  });
  const auditInfo = validateM5DAuditDecisions(auditSource.value, editorialInfo, proposalInfo, auditTiming);
  const currentSnapshot = canonicalSnapshot(canonical.records);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(canonicalDirectory);
  assertEqual(editorialTimingSource.value.canonical_directory_sha256, canonicalDirectorySha256, 'canonical data changed during M5-10D editorial work', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(auditTimingSource.value.canonical_directory_sha256, canonicalDirectorySha256, 'canonical data changed before M5-10D audit', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(editorialTimingSource.value.inventory_sha256, inventorySource.sha256, 'target inventory changed during M5-10D editorial work', 'CALIBRATION_INVENTORY_MUTATION');
  assertEqual(auditTimingSource.value.inventory_sha256, inventorySource.sha256, 'target inventory changed before M5-10D audit', 'CALIBRATION_INVENTORY_MUTATION');
  assertEqual(currentSnapshot, M5_10D_CANONICAL_SNAPSHOT, 'current canonical snapshot is not the 778-start base', 'RECOVERY_CANONICAL_MISMATCH');
  validateFailedSourceDigests(failedStageSource.value, {
    manifest: failedManifestSource,
    metrics: failedMetricsSource,
    verification: failedVerificationSource,
    relation_diff: failedRelationDiffSource,
  });
  validateM5DPreviousRecovery(failedRecoverySource.value);
  assertEqual(repairSource.value.process_revision, 'm5-10a-process-correction-v1', 'repair revision changed', 'REPAIR_REVISION_MISMATCH');
  assertEqual(repairSource.value.canonical_scope.snapshot.start_count, 578, 'repair revision canonical base changed', 'REPAIR_REVISION_MISMATCH');
  assertEqual(inventorySource.value.revision, 'm5-11', 'inventory revision drifted', 'INVENTORY_SOURCE_MISMATCH');
  assertEqual(inventorySource.value.canonical_snapshot.start_count, currentSnapshot.start_count, 'inventory canonical snapshot drifted', 'INVENTORY_SOURCE_MISMATCH');
  validateM5DVerification(verificationSource.value, currentSnapshot);
  validateSchema(artifactSource.value, recoveryValidator, 'recovery', 'M5-10D recovery', 'RECOVERY_SCHEMA_ERROR');
  const artifact = artifactSource.value;
  const proposalReferences = path.resolve(proposalPath) === path.resolve(DEFAULT_PROPOSAL_PATH)
    ? [M5_10D_PROPOSAL_ARTIFACT]
    : [sourcePathFor(proposalPath), 'contract:m5-10d-calibration-proposal'];
  const followUpReferences = path.resolve(followUpSourcePath) === path.resolve(DEFAULT_FOLLOW_UP_SOURCE_PATH)
    ? [M5_10D_FOLLOW_UP_ARTIFACT]
    : [sourcePathFor(followUpSourcePath), 'contract:m5-10d-follow-up-source'];
  if (!proposalReferences.includes(artifact.source.proposal_artifact)) {
    fail(`recovery proposal artifact reference is not bound to ${sourcePathFor(proposalPath)}`, 'RECOVERY_SOURCE_MISMATCH');
  }
  if (!followUpReferences.includes(artifact.source.follow_up_source)) {
    fail(`recovery follow-up source reference is not bound to ${sourcePathFor(followUpSourcePath)}`, 'RECOVERY_SOURCE_MISMATCH');
  }
  assertEqual(artifact.canonical_snapshot, currentSnapshot, 'recovery canonical snapshot drifted', 'RECOVERY_CANONICAL_MISMATCH');
  assertEqual(artifact.source.failed_stage_sha256, failedStageSource.sha256, 'recovery failed stage digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_manifest_sha256, failedManifestSource.sha256, 'recovery failed manifest digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_metrics_sha256, failedMetricsSource.sha256, 'recovery failed metrics digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_verification_sha256, failedVerificationSource.sha256, 'recovery failed verification digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_relation_diff_sha256, failedRelationDiffSource.sha256, 'recovery failed relation diff digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.failed_recovery_sha256, failedRecoverySource.sha256, 'recovery M5-10C digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.repair_revision_sha256, repairSource.sha256, 'recovery repair revision digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.workload_sha256, workloadSource.sha256, 'recovery workload digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.follow_up_source_sha256, followUpSource?.sha256, 'recovery follow-up source digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.proposal_sha256, proposalSource.sha256, 'recovery proposal digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.editorial_decisions_sha256, editorialSource.sha256, 'recovery editorial digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.editorial_timing_sha256, editorialTimingSource.sha256, 'recovery editorial timing digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.audit_decisions_sha256, auditSource.sha256, 'recovery audit digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.audit_timing_sha256, auditTimingSource.sha256, 'recovery audit timing digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.verification_sha256, verificationSource.sha256, 'recovery verification digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.canonical_directory_sha256, canonicalDirectorySha256, 'recovery canonical digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.source.inventory_sha256, inventorySource.sha256, 'recovery inventory digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.before_sha256, inventorySource.sha256, 'recovery inventory before digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.after_sha256, inventorySource.sha256, 'recovery inventory after digest drifted', 'RECOVERY_SOURCE_MISMATCH');
  assertEqual(artifact.inventory_snapshot.before_sha256, artifact.inventory_snapshot.after_sha256, 'calibration mutated inventory', 'CALIBRATION_INVENTORY_MUTATION');
  const calibration = deriveM5DCalibration(editorialTiming, auditTiming, editorialSource.value, auditSource.value, workloadCoverage);
  assertEqual(artifact.calibration, calibration, 'recovery calibration metrics drifted', 'RECOVERY_METRIC_MISMATCH');
  const gate = evaluateM5DRecoveryGate({
    correctionRate: calibration.correction_rate,
    relationNoiseRate: calibration.relation.noise_rate,
    timing: calibration.timing,
    audit: calibration.audit,
    editorial: { status: 'complete' },
    canonicalMutation: artifact.canonical_mutation,
    inventoryMutation: artifact.inventory_snapshot.before_sha256 !== artifact.inventory_snapshot.after_sha256,
    verification: verificationSource.value,
    failedStage: failedStageSource.value,
    failedRecovery: failedRecoverySource.value,
    workloadCoverage,
  });
  assertEqual(artifact.gate_status, gate.gate_status, 'recovery gate status drifted', 'RECOVERY_GATE_MISMATCH');
  assertEqual(artifact.decision, gate.decision, 'recovery decision drifted', 'RECOVERY_GATE_MISMATCH');
  assertEqual(artifact.ready_to_create, gate.gate_status === 'pass', 'recovery ready_to_create drifted', 'RECOVERY_GATE_MISMATCH');
  return {
    artifact,
    artifact_sha256: artifactSource.sha256,
    proposal: proposalInfo,
    workload: workloadInfo,
    editorial: editorialInfo,
    audit: auditInfo,
    timing: { editorial: editorialTiming, audit: auditTiming },
    canonical: { snapshot: currentSnapshot, directory_sha256: canonicalDirectorySha256 },
    inventory: { revision: inventorySource.value.revision, sha256: inventorySource.sha256 },
    calibration,
    gate,
    failed_stage: failedStageSource.value,
    failed_recovery: failedRecoverySource.value,
  };
}

export async function validateM5DAuthorization({
  authorizationPath = DEFAULT_AUTHORIZATION_PATH,
  recoveryPath = DEFAULT_RECOVERY_PATH,
  ...options
} = {}) {
  const recoveryResult = await validateM5DRecovery({ artifactPath: recoveryPath, ...options });
  assertM5DRecoveryAuthorizable(recoveryResult);
  const [authorizationSource, recoverySource, stageSource, workloadSource, repairSource, inventorySource] = await Promise.all([
    readSource(authorizationPath, 'M5-10D authorization'),
    readSource(recoveryPath, 'M5-10D recovery'),
    readSource(options.failedStagePath ?? DEFAULT_FAILED_STAGE_PATH, 'failed Wave B stage'),
    readSource(options.workloadPath ?? DEFAULT_WORKLOAD_PATH, 'M5-10D workload'),
    readSource(options.repairRevisionPath ?? DEFAULT_REPAIR_REVISION_PATH, 'M5-10A process correction'),
    readInventorySource(options.inventoryPath ?? DEFAULT_INVENTORY_PATH, options.canonicalDirectory ?? DEFAULT_CANONICAL_DIRECTORY),
  ]);
  validateSchema(authorizationSource.value, authorizationValidator, 'authorization', 'M5-10D authorization', 'AUTHORIZATION_SCHEMA_ERROR');
  const authorization = authorizationSource.value;
  assertEqual(authorization.source.recovery_artifact_sha256, recoverySource.sha256, 'authorization recovery digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.workload_sha256, workloadSource.sha256, 'authorization workload digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.canonical_directory_sha256, recoveryResult.canonical.directory_sha256, 'authorization canonical digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.failed_stage.sha256, stageSource.sha256, 'authorization failed stage digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.repair_revision_sha256, repairSource.sha256, 'authorization repair digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.source.inventory_sha256, inventorySource.sha256, 'authorization inventory digest drifted', 'AUTHORIZATION_SOURCE_MISMATCH');
  assertEqual(authorization.failed_stage.gate_status, 'fail', 'authorization failed gate changed', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.failed_stage.decision, 'HOLD PROCESS', 'authorization failed decision changed', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.target.base_start_count, recoveryResult.canonical.snapshot.start_count, 'authorization base snapshot drifted', 'AUTHORIZATION_SCOPE_MISMATCH');
  assertEqual(authorization.target.candidate_data_created, false, 'authorization created candidate data', 'AUTHORIZATION_SCOPE_MISMATCH');
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

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const args = mainArgumentMap(process.argv.slice(2));
  const run = args.action === 'authorization' ? validateM5DAuthorization : validateM5DRecovery;
  const historicalDefaults = existsSync(HISTORICAL_CANONICAL_DIRECTORY)
    && existsSync(HISTORICAL_INVENTORY_PATH)
    ? {
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
      inventoryPath: HISTORICAL_INVENTORY_PATH,
    }
    : {};
  run({
    ...historicalDefaults,
    ...(args.artifact ? { artifactPath: path.resolve(args.artifact) } : {}),
    ...(args.authorization ? { authorizationPath: path.resolve(args.authorization) } : {}),
    ...(args.recovery ? { recoveryPath: path.resolve(args.recovery) } : {}),
    ...(args.proposal ? { proposalPath: path.resolve(args.proposal) } : {}),
    ...(args.workload ? { workloadPath: path.resolve(args.workload) } : {}),
    ...(args['follow-up-source'] ? { followUpSourcePath: path.resolve(args['follow-up-source']) } : {}),
    ...(args.editorial ? { editorialPath: path.resolve(args.editorial) } : {}),
    ...(args['editorial-timing'] ? { editorialTimingPath: path.resolve(args['editorial-timing']) } : {}),
    ...(args.audit ? { auditPath: path.resolve(args.audit) } : {}),
    ...(args['audit-timing'] ? { auditTimingPath: path.resolve(args['audit-timing']) } : {}),
    ...(args.verification ? { verificationPath: path.resolve(args.verification) } : {}),
    ...(args['canonical-dir'] ? { canonicalDirectory: path.resolve(args['canonical-dir']) } : {}),
    ...(args.inventory ? { inventoryPath: path.resolve(args.inventory) } : {}),
  }).then((result) => console.log(JSON.stringify(result.gate ?? result.authorization, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

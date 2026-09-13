import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  evaluateExpansionGate,
  hashCanonicalDirectory,
} from './validate-m5-8-process.mjs';
import { buildDictionary } from '../build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getRecord,
  getSenseRelations,
} from '../build/query.mjs';
import { validateM5DAuthorization } from './validate-m5-10d-recovery.mjs';
import {
  M5_11_BATCH_ID,
  expectedCanonicalId,
  sha256Json,
  validateM511EditorialDecisions,
} from './m5-11-editorial.mjs';
import { M5_11_CATALOG } from './m5-11-catalog.mjs';
import {
  M5_11_BASE_CANONICAL_SHA256,
  M5_11_BASE_INVENTORY_SHA256,
  M5_11_BASE_SEED_SHA256,
  M5_11_BASE_SUMMARY,
  REPOSITORY_DIRECTORY,
  resolveRepositoryPath,
} from './validate-m5-11.mjs';
import { validateRelationDiff, summarizeRelationDiff } from './relation-diff.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { assertValidSearchRegressionCorpus } from '../validate/search-regressions.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_PLAN = require('../../data/batches/m5-8-expansion-plan.json');
const M4_SEARCH_REGRESSION_CORPUS = require('../../tests/fixtures/search-regressions/m4-baseline.json');

export const M5_11_EDITORIAL_TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-verification',
  'held-rejected',
]);
export const M5_11_AUDIT_TIMING_PASS_IDS = Object.freeze(['post-freeze-audit']);
export const M5_11_TIMING_PASS_IDS = Object.freeze([
  ...M5_11_EDITORIAL_TIMING_PASS_IDS,
  ...M5_11_AUDIT_TIMING_PASS_IDS,
]);
export const M5_11_TIMING_RECORDER_VERSION = 'm5-11-timing-recorder-v2';
export const M5_11_TIMING_RECORDING_COMMAND = 'node scripts/batch/record-m5-11-timing.mjs';
export const M5_11_TIMING_CLOCK_SOURCE = 'system-clock';
export const M5_11_PROSPECTIVE_VERIFIER_VERSION = 'm5-11-prospective-verifier-v2';
export const M5_11_MACHINE_CHECK_IDS = Object.freeze([
  'canonical-integrity',
  'deterministic-sqlite',
  'search-product-regression',
  'raw-material-exclusion',
]);

const AUDIT_SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'info']);
const AUDIT_STATUSES = Object.freeze(['open', 'closed', 'accepted', 'not-applicable']);

export class M511AdmissionValidationError extends Error {
  constructor(message, code = 'M5_11_ADMISSION_VALIDATION_ERROR') {
    super(message);
    this.name = 'M511AdmissionValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_ADMISSION_VALIDATION_ERROR') {
  throw new M511AdmissionValidationError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'ARTIFACT_SHAPE_ERROR');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'ARTIFACT_VALUE_ERROR');
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'ARTIFACT_SHAPE_ERROR');
  return value;
}

function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number`, 'ARTIFACT_VALUE_ERROR');
  }
  return value;
}

function assertDeep(actual, expected, label, code = 'ARTIFACT_BINDING_ERROR') {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${label} does not match the bound value`, code);
  }
}

function assertExactIds(actual, expected, label, code = 'ARTIFACT_SCOPE_ERROR') {
  assertDeep(actual, expected, label, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createM511TimingProof(artifact) {
  const { recording_proof_sha256: ignored, ...payload } = artifact;
  return sha256Json(payload);
}

function catalogIds(catalog) {
  return catalog.map(({ inventory_id: inventoryId }) => inventoryId);
}

function canonicalSummary(records) {
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce(
        (inner, sense) => inner + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function importedRecordIds(importedRecords) {
  return importedRecords.map(({ id }) => id);
}

function isoTimestamp(value, label) {
  requireString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO timestamp`, 'TIMING_VALUE_ERROR');
  return timestamp;
}

function validateArtifactHeader(artifact, label) {
  requireObject(artifact, label);
  if (artifact.schema_version !== '1') fail(`${label}.schema_version must be 1`, 'ARTIFACT_SCHEMA_ERROR');
  if (artifact.issue !== 97 || artifact.batch_id !== M5_11_BATCH_ID) {
    fail(`${label} is not bound to issue #97`, 'ARTIFACT_SCOPE_ERROR');
  }
}

function validateFileSource(source, label) {
  requireObject(source, label);
  requireString(source.path, `${label}.path`);
  if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
    fail(`${label}.sha256 must be a SHA-256 digest`, 'SOURCE_DIGEST_MISMATCH');
  }
  return source;
}

function assertSecondsEqual(actual, expected, label, code = 'TIMING_DERIVATION_MISMATCH') {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    fail(`${label} must equal the recorder-derived duration`, code);
  }
}

function validateTimingEvent(event, {
  artifact,
  pass,
  unitId,
  label,
} = {}) {
  requireObject(event, label);
  requireString(event.event_id, `${label}.event_id`);
  if (event.kind !== 'work') fail(`${label}.kind must be work`, 'TIMING_EVENT_BINDING');
  if (event.pass_id !== pass.id) fail(`${label}.pass_id is not bound to ${pass.id}`, 'TIMING_EVENT_BINDING');
  if (event.session_id !== artifact.session_id) fail(`${label}.session_id is not bound to the timing session`, 'TIMING_EVENT_BINDING');
  if (event.unit_id !== unitId) fail(`${label}.unit_id is not bound to ${unitId}`, 'TIMING_EVENT_BINDING');
  if (event.recording_source !== pass.recording_source) fail(`${label}.recording_source drifted`, 'TIMING_PROVENANCE_ERROR');
  const started = isoTimestamp(event.started_at, `${label}.started_at`);
  const completed = isoTimestamp(event.completed_at, `${label}.completed_at`);
  const recorded = isoTimestamp(event.recorded_at, `${label}.recorded_at`);
  if (completed <= started) fail(`${label} must have a positive recorded duration`, 'TIMING_DERIVATION_MISMATCH');
  if (recorded !== completed) fail(`${label}.recorded_at must equal completed_at`, 'TIMING_EVENT_BINDING');
  if (started < isoTimestamp(pass.started_at, `${label}.pass.started_at`)
    || completed > isoTimestamp(pass.completed_at, `${label}.pass.completed_at`)) {
    fail(`${label} is outside its timing pass`, 'TIMING_CHRONOLOGY_ERROR');
  }
  return {
    seconds: (completed - started) / 1000,
    started_at: started,
    completed_at: completed,
  };
}

function validateTimingPass(pass, expectedIds, catalogIdSet, label, {
  artifact,
  eventsById,
  audit = false,
} = {}) {
  requireObject(pass, label);
  requireString(pass.id, `${label}.id`);
  if (!expectedIds.includes(pass.id)) fail(`${label}.id is not a required timing pass`, 'TIMING_SCOPE_ERROR');
  if (pass.status !== 'complete') fail(`${label}.status must be complete`, 'TIMING_INCOMPLETE');
  const unitIds = requireArray(pass.unit_ids, `${label}.unit_ids`);
  if (new Set(unitIds).size !== unitIds.length) fail(`${label}.unit_ids contains duplicates`, 'TIMING_SCOPE_ERROR');
  for (const unitId of unitIds) {
    if (!catalogIdSet.has(unitId)) fail(`${label}.unit_ids contains ${unitId} outside the catalog`, 'TIMING_SCOPE_ERROR');
  }
  if (pass.unit_count !== unitIds.length) fail(`${label}.unit_count does not match unit_ids`, 'TIMING_SCOPE_ERROR');
  const eventIds = requireArray(pass.event_ids, `${label}.event_ids`);
  if (new Set(eventIds).size !== eventIds.length) fail(`${label}.event_ids contains duplicates`, 'TIMING_SCOPE_ERROR');
  if (unitIds.length > 0 && eventIds.length === 0) fail(`${label} has work but no recorder events`, 'TIMING_PROVENANCE_ERROR');
  requireFiniteNumber(pass.wall_clock_seconds, `${label}.wall_clock_seconds`);
  const started = isoTimestamp(pass.started_at, `${label}.started_at`);
  const completed = isoTimestamp(pass.completed_at, `${label}.completed_at`);
  if (completed < started) fail(`${label}.completed_at precedes started_at`, 'TIMING_CHRONOLOGY_ERROR');
  if (pass.recording_source !== M5_11_TIMING_RECORDER_VERSION) {
    fail(`${label}.recording_source must identify the M5-11 recorder`, 'TIMING_PROVENANCE_ERROR');
  }
  const elapsed = (completed - started) / 1000;
  assertSecondsEqual(pass.wall_clock_seconds, elapsed, `${label}.wall_clock_seconds`);
  const eventResults = eventIds.map((eventId, eventIndex) => {
    const event = eventsById.get(eventId);
    if (!event) fail(`${label}.event_ids[${eventIndex}] is not present in the recorder event log`, 'TIMING_EVENT_BINDING');
    return {
      event,
      ...validateTimingEvent(event, {
        artifact,
        pass,
        unitId: unitIds[eventIndex],
        label: `${label}.events[${eventIndex}]`,
      }),
    };
  });
  assertExactIds(
    eventResults.map(({ event }) => event.unit_id),
    unitIds,
    `${label}.event unit scope`,
    'TIMING_EVENT_BINDING',
  );
  if (unitIds.length > 0) {
    let previousCompletedAt = started;
    for (const [eventIndex, { started_at: eventStartedAt, completed_at: eventCompletedAt }] of eventResults.entries()) {
      if (eventStartedAt !== previousCompletedAt) {
        fail(
          `${label}.events[${eventIndex}] is not contiguous with the preceding recorder event`,
          'TIMING_CHRONOLOGY_ERROR',
        );
      }
      previousCompletedAt = eventCompletedAt;
    }
    if (eventResults[0].started_at !== started || eventResults.at(-1).completed_at !== completed) {
      fail(`${label}.events do not cover the complete recorder pass`, 'TIMING_CHRONOLOGY_ERROR');
    }
  }
  const measuredSeconds = eventResults.reduce((sum, { seconds }) => sum + seconds, 0);
  const durationField = audit ? 'audit_seconds' : 'editor_seconds';
  requireFiniteNumber(pass[durationField], `${label}.${durationField}`);
  assertSecondsEqual(pass[durationField], measuredSeconds, `${label}.${durationField}`);
  return {
    ...pass,
    derived_editor_seconds: audit ? 0 : measuredSeconds,
    derived_audit_seconds: audit ? measuredSeconds : 0,
    derived_started_at: started,
    derived_completed_at: completed,
    derived_event_count: eventResults.length,
  };
}

export function validateM511TimingArtifact(
  artifact,
  {
    source,
    catalog = M5_11_CATALOG,
    importedInventoryIds = [],
    reserveInventoryIds = [],
    timingKind = 'editorial',
    expectedSessionId,
    proposalSourceSha256,
    editorialSourceSha256,
    auditSourceSha256,
    editorialTimingSourceSha256,
    afterTimingArtifact,
  } = {},
) {
  const label = `M5-11 ${timingKind} timing artifact`;
  validateArtifactHeader(artifact, label);
  if (artifact.timing_kind !== timingKind) fail(`${label}.timing_kind is invalid`, 'TIMING_SCOPE_ERROR');
  validateFileSource(source, `${label} source file`);
  const binding = requireObject(artifact.source, `${label}.source`);
  if (proposalSourceSha256 !== undefined && binding.proposal_sha256 !== proposalSourceSha256) {
    fail(`${label} proposal source drifted`, 'TIMING_SOURCE_MISMATCH');
  }
  if (editorialSourceSha256 !== undefined && binding.editorial_sha256 !== editorialSourceSha256) {
    fail(`${label} editorial decision source drifted`, 'TIMING_SOURCE_MISMATCH');
  }
  if (auditSourceSha256 !== undefined && binding.audit_sha256 !== auditSourceSha256) {
    fail(`${label} audit source drifted`, 'TIMING_SOURCE_MISMATCH');
  }
  if (editorialTimingSourceSha256 !== undefined && binding.editorial_timing_sha256 !== editorialTimingSourceSha256) {
    fail(`${label} editorial timing source drifted`, 'TIMING_SOURCE_MISMATCH');
  }
  requireString(artifact.session_id, `${label}.session_id`);
  if (expectedSessionId !== undefined && artifact.session_id !== expectedSessionId) {
    fail(`${label}.session_id does not match the bound audit session`, 'TIMING_PROVENANCE_ERROR');
  }
  const passes = requireArray(artifact.passes, `${label}.passes`);
  const expectedPasses = timingKind === 'editorial'
    ? M5_11_EDITORIAL_TIMING_PASS_IDS
    : M5_11_AUDIT_TIMING_PASS_IDS;
  if (artifact.recorder_version !== M5_11_TIMING_RECORDER_VERSION) {
    fail(`${label}.recorder_version must identify the M5-11 recorder`, 'TIMING_PROVENANCE_ERROR');
  }
  if (artifact.recording_source !== M5_11_TIMING_RECORDER_VERSION) {
    fail(`${label}.recording_source must identify the M5-11 recorder`, 'TIMING_PROVENANCE_ERROR');
  }
  if (artifact.recorder_command !== M5_11_TIMING_RECORDING_COMMAND) {
    fail(`${label}.recorder_command must identify the M5-11 timing recorder`, 'TIMING_PROVENANCE_ERROR');
  }
  if (artifact.clock_source !== M5_11_TIMING_CLOCK_SOURCE) {
    fail(`${label}.clock_source must identify the system clock`, 'TIMING_PROVENANCE_ERROR');
  }
  if (!/^[a-f0-9]{64}$/u.test(artifact.recording_proof_sha256)
    || artifact.recording_proof_sha256 !== createM511TimingProof(artifact)) {
    fail(`${label}.recording_proof_sha256 does not match the recorder-produced session`, 'TIMING_PROVENANCE_ERROR');
  }
  const recorder = requireObject(artifact.recorder, `${label}.recorder`);
  if (recorder.version !== M5_11_TIMING_RECORDER_VERSION) {
    fail(`${label}.recorder.version must identify the M5-11 recorder`, 'TIMING_PROVENANCE_ERROR');
  }
  if (recorder.session_id !== artifact.session_id) {
    fail(`${label}.recorder.session_id is not bound to the timing session`, 'TIMING_PROVENANCE_ERROR');
  }
  const recorderEvents = requireArray(artifact.recorder_events, `${label}.recorder_events`);
  if (!/^[a-f0-9]{64}$/u.test(recorder.recorder_event_log_sha256)
    || recorder.recorder_event_log_sha256 !== sha256Json(recorderEvents)) {
    fail(`${label}.recorder.recorder_event_log_sha256 does not bind start/stop events`, 'TIMING_PROVENANCE_ERROR');
  }
  if (recorder.recorder_event_count !== recorderEvents.length) {
    fail(`${label}.recorder.recorder_event_count does not match start/stop events`, 'TIMING_PROVENANCE_ERROR');
  }
  const events = requireArray(artifact.events, `${label}.events`);
  if (!/^[a-f0-9]{64}$/u.test(recorder.event_log_sha256)) {
    fail(`${label}.recorder.event_log_sha256 must be a SHA-256 digest`, 'TIMING_PROVENANCE_ERROR');
  }
  if (recorder.event_log_sha256 !== sha256Json(events)) {
    fail(`${label}.recorder.event_log_sha256 does not bind the recorder event log`, 'TIMING_PROVENANCE_ERROR');
  }
  if (recorder.event_count !== events.length) {
    fail(`${label}.recorder.event_count does not match the recorder event log`, 'TIMING_PROVENANCE_ERROR');
  }
  const eventsById = new Map();
  for (const [index, event] of events.entries()) {
    requireObject(event, `${label}.events[${index}]`);
    requireString(event.event_id, `${label}.events[${index}].event_id`);
    if (eventsById.has(event.event_id)) fail(`${label}.events contains duplicate event_id ${event.event_id}`, 'TIMING_SCOPE_ERROR');
    eventsById.set(event.event_id, event);
  }
  const recorderEventsByKey = new Map();
  for (const [index, event] of recorderEvents.entries()) {
    const eventLabel = `${label}.recorder_events[${index}]`;
    requireObject(event, eventLabel);
    requireString(event.event_id, `${eventLabel}.event_id`);
    if (!['start', 'stop'].includes(event.kind)) {
      fail(`${eventLabel}.kind must be start or stop`, 'TIMING_PROVENANCE_ERROR');
    }
    if (!expectedPasses.includes(event.pass_id)) {
      fail(`${eventLabel}.pass_id is not a required timing pass`, 'TIMING_SCOPE_ERROR');
    }
    if (event.session_id !== artifact.session_id) {
      fail(`${eventLabel}.session_id is not bound to the timing session`, 'TIMING_PROVENANCE_ERROR');
    }
    const at = isoTimestamp(event.at, `${eventLabel}.at`);
    const key = `${event.pass_id}:${event.kind}`;
    if (recorderEventsByKey.has(key)) fail(`${eventLabel} duplicates ${key}`, 'TIMING_SCOPE_ERROR');
    recorderEventsByKey.set(key, { ...event, at });
  }
  assertExactIds(
    passes.map(({ id }) => id),
    expectedPasses,
    `${label}.passes`,
    'TIMING_SCOPE_ERROR',
  );
  const catalogIdSet = new Set(catalogIds(catalog));
  const passById = new Map();
  let editorSeconds = 0;
  let auditSeconds = 0;
  let unmeasuredPassCount = 0;
  let previousCompletedAt;
  const passIntervals = [];
  for (const [index, pass] of passes.entries()) {
    const passStartedAt = isoTimestamp(pass.started_at, `${label}.passes[${index}].started_at`);
    if (previousCompletedAt !== undefined && passStartedAt < previousCompletedAt) {
      fail(`${label}.passes[${index}] starts before the preceding pass completed`, 'TIMING_CHRONOLOGY_ERROR');
    }
    const validated = validateTimingPass(
      pass,
      expectedPasses,
      catalogIdSet,
      `${label}.passes[${index}]`,
      {
        artifact,
        eventsById,
        audit: timingKind === 'post-freeze-audit',
      },
    );
    const recorderStart = recorderEventsByKey.get(`${validated.id}:start`);
    const recorderStop = recorderEventsByKey.get(`${validated.id}:stop`);
    if (!recorderStart || !recorderStop
      || recorderStart.at !== validated.derived_started_at
      || recorderStop.at !== validated.derived_completed_at) {
      fail(`${label}.${validated.id} is not bound to recorder start/stop events`, 'TIMING_PROVENANCE_ERROR');
    }
    passById.set(validated.id, validated);
    if (timingKind === 'editorial') editorSeconds += validated.derived_editor_seconds;
    else auditSeconds += validated.derived_audit_seconds;
    previousCompletedAt = validated.derived_completed_at;
    passIntervals.push({
      id: validated.id,
      unit_count: validated.unit_count,
      event_count: validated.derived_event_count,
      started_at: validated.started_at,
      completed_at: validated.completed_at,
      wall_clock_seconds: validated.wall_clock_seconds,
      measured_seconds: timingKind === 'editorial'
        ? validated.derived_editor_seconds
        : validated.derived_audit_seconds,
    });
  }
  assertExactIds(
    [...eventsById.keys()],
    passes.flatMap(({ event_ids: eventIds }) => eventIds),
    `${label}.events scope`,
    'TIMING_EVENT_BINDING',
  );
  assertExactIds(
    [...recorderEventsByKey.keys()].sort(),
    expectedPasses.flatMap((passId) => [`${passId}:start`, `${passId}:stop`]).sort(),
    `${label}.recorder_events scope`,
    'TIMING_PROVENANCE_ERROR',
  );

  if (afterTimingArtifact !== undefined) {
    const previousPass = requireArray(afterTimingArtifact.passes, `${label}.preceding timing passes`).at(-1);
    const firstPass = passes[0];
    if (!previousPass || !firstPass) {
      fail(`${label} cannot establish chronology against the preceding timing session`, 'TIMING_CHRONOLOGY_ERROR');
    }
    if (isoTimestamp(firstPass.started_at, `${label}.passes[0].started_at`)
      < isoTimestamp(previousPass.completed_at, `${label}.preceding completed_at`)) {
      fail(`${label} starts before the editorial timing session completed`, 'TIMING_CHRONOLOGY_ERROR');
    }
  }

  if (timingKind === 'editorial') {
    assertExactIds(
      passById.get('target-preparation').unit_ids,
      catalogIds(catalog),
      `${label}.target-preparation.unit_ids`,
      'TIMING_SCOPE_ERROR',
    );
    assertExactIds(
      passById.get('initial-review').unit_ids,
      catalogIds(catalog),
      `${label}.initial-review.unit_ids`,
      'TIMING_SCOPE_ERROR',
    );
    assertExactIds(
      passById.get('final-verification').unit_ids,
      importedInventoryIds,
      `${label}.final-verification.unit_ids`,
      'TIMING_SCOPE_ERROR',
    );
    assertExactIds(
      passById.get('held-rejected').unit_ids,
      reserveInventoryIds,
      `${label}.held-rejected.unit_ids`,
      'TIMING_SCOPE_ERROR',
    );
  } else {
    assertExactIds(
      passById.get('post-freeze-audit').unit_ids,
      catalogIds(catalog),
      `${label}.post-freeze-audit.unit_ids`,
      'TIMING_SCOPE_ERROR',
    );
  }

  return {
    status: 'complete',
    timing_kind: timingKind,
    session_id: artifact.session_id,
    editor_seconds: timingKind === 'editorial' ? editorSeconds : 0,
    audit_seconds: timingKind === 'post-freeze-audit' ? auditSeconds : 0,
    unmeasured_pass_count: unmeasuredPassCount,
    pass_ids: [...expectedPasses],
    recording_proof_sha256: artifact.recording_proof_sha256,
    pass_intervals: passIntervals,
  };
}

export function validateM511AuditArtifact(
  audit,
  {
    source,
    catalog = M5_11_CATALOG,
    editorialSourceSha256,
    proposalSourceSha256,
    editorialSessionId,
  } = {},
) {
  const label = 'M5-11 independent audit artifact';
  validateArtifactHeader(audit, label);
  validateFileSource(source, `${label} source file`);
  requireString(audit.audit_id, `${label}.audit_id`);
  requireString(audit.session_id, `${label}.session_id`);
  requireString(audit.editorial_session_id, `${label}.editorial_session_id`);
  if (editorialSessionId !== undefined && audit.editorial_session_id !== editorialSessionId) {
    fail(`${label}.editorial_session_id drifted`, 'AUDIT_PROVENANCE_ERROR');
  }
  if (audit.session_id === audit.editorial_session_id) {
    fail(`${label} must use a distinct session`, 'AUDIT_NOT_INDEPENDENT');
  }
  if (audit.independent !== true) fail(`${label}.independent must be true`, 'AUDIT_NOT_INDEPENDENT');
  if (audit.status !== 'complete') fail(`${label}.status must be complete`, 'AUDIT_INCOMPLETE');
  if (audit.source.editorial_sha256 !== editorialSourceSha256) {
    fail(`${label} editorial decision source drifted`, 'AUDIT_SOURCE_MISMATCH');
  }
  if (audit.source.proposal_sha256 !== proposalSourceSha256) {
    fail(`${label} proposal source drifted`, 'AUDIT_SOURCE_MISMATCH');
  }
  const reviewedIds = requireArray(audit.reviewed_inventory_ids, `${label}.reviewed_inventory_ids`);
  assertExactIds(
    reviewedIds,
    catalogIds(catalog),
    `${label}.reviewed_inventory_ids`,
    'AUDIT_SCOPE_ERROR',
  );
  const findings = requireArray(audit.findings, `${label}.findings`);
  const findingIds = new Set();
  for (const [index, finding] of findings.entries()) {
    const findingLabel = `${label}.findings[${index}]`;
    requireObject(finding, findingLabel);
    requireString(finding.id, `${findingLabel}.id`);
    if (findingIds.has(finding.id)) fail(`${findingLabel}.id is duplicated`, 'AUDIT_SCOPE_ERROR');
    findingIds.add(finding.id);
    if (!AUDIT_SEVERITIES.includes(finding.severity)) fail(`${findingLabel}.severity is invalid`, 'AUDIT_VALUE_ERROR');
    if (!AUDIT_STATUSES.includes(finding.status)) fail(`${findingLabel}.status is invalid`, 'AUDIT_VALUE_ERROR');
    requireString(finding.note, `${findingLabel}.note`);
  }
  const openBlockerCount = findings.filter(
    ({ severity, status }) => severity === 'blocker' && status === 'open',
  ).length;
  if (audit.open_blocker_count !== openBlockerCount) {
    fail(`${label}.open_blocker_count is not derived from findings`, 'AUDIT_METRICS_MISMATCH');
  }
  return {
    status: audit.status,
    independent: audit.independent,
    open_blocker_count: openBlockerCount,
    finding_count: findings.length,
    session_id: audit.session_id,
  };
}

export function validateM511VerificationArtifact(
  verification,
  {
    source,
    finalSummary,
    reviewedImportSha256,
    editorialSourceSha256,
    proposalSourceSha256,
    relationDiffSha256,
    machineVerification,
  } = {},
) {
  const label = 'M5-11 verification artifact';
  validateArtifactHeader(verification, label);
  validateFileSource(source, `${label} source file`);
  for (const key of [
    'editorial_review_complete',
    'human_editorial_review_complete',
    'canonical_integrity',
    'deterministic_sqlite',
    'search_product_regression',
    'raw_material_excluded',
  ]) {
    if (verification[key] !== true) fail(`${label}.${key} must be true`, 'VERIFICATION_GATE_ERROR');
  }
  if (verification.reviewed_import_sha256 !== reviewedImportSha256) {
    fail(`${label}.reviewed_import_sha256 drifted`, 'VERIFICATION_SOURCE_MISMATCH');
  }
  if (verification.editorial_sha256 !== editorialSourceSha256) {
    fail(`${label}.editorial_sha256 drifted`, 'VERIFICATION_SOURCE_MISMATCH');
  }
  if (verification.proposal_sha256 !== proposalSourceSha256) {
    fail(`${label}.proposal_sha256 drifted`, 'VERIFICATION_SOURCE_MISMATCH');
  }
  if (verification.relation_diff_sha256 !== relationDiffSha256) {
    fail(`${label}.relation_diff_sha256 drifted`, 'VERIFICATION_SOURCE_MISMATCH');
  }
  assertDeep(verification.final_canonical_summary, finalSummary, `${label}.final_canonical_summary`, 'VERIFICATION_METRICS_MISMATCH');
  const checks = requireArray(verification.checks, `${label}.checks`);
  if (verification.machine_generated !== true) {
    fail(`${label}.machine_generated must be true`, 'VERIFICATION_PROVENANCE_ERROR');
  }
  if (verification.verifier_version !== M5_11_PROSPECTIVE_VERIFIER_VERSION) {
    fail(`${label}.verifier_version is not the M5-11 prospective verifier`, 'VERIFICATION_PROVENANCE_ERROR');
  }
  if (!/^[a-f0-9]{64}$/u.test(verification.prospective_canonical_sha256)) {
    fail(`${label}.prospective_canonical_sha256 must be a SHA-256 digest`, 'VERIFICATION_SOURCE_MISMATCH');
  }
  assertExactIds(
    checks.map(({ id }) => id),
    M5_11_MACHINE_CHECK_IDS,
    `${label}.checks`,
    'VERIFICATION_GATE_ERROR',
  );
  const checksById = new Map();
  for (const [index, check] of checks.entries()) {
    const checkLabel = `${label}.checks[${index}]`;
    requireObject(check, checkLabel);
    if (check.status !== 'pass') fail(`${checkLabel}.status must be pass`, 'VERIFICATION_GATE_ERROR');
    if (!/^[a-f0-9]{64}$/u.test(check.result_sha256)) {
      fail(`${checkLabel}.result_sha256 must be a SHA-256 digest`, 'VERIFICATION_PROVENANCE_ERROR');
    }
    checksById.set(check.id, check);
  }
  for (const [field, checkId] of [
    ['canonical_integrity', 'canonical-integrity'],
    ['deterministic_sqlite', 'deterministic-sqlite'],
    ['search_product_regression', 'search-product-regression'],
    ['raw_material_excluded', 'raw-material-exclusion'],
  ]) {
    if (verification[field] !== (checksById.get(checkId)?.status === 'pass')) {
      fail(`${label}.${field} is not derived from its machine check`, 'VERIFICATION_GATE_ERROR');
    }
  }
  if (machineVerification !== undefined) {
    assertDeep(
      {
        machine_generated: verification.machine_generated,
        verifier_version: verification.verifier_version,
        prospective_canonical_sha256: verification.prospective_canonical_sha256,
        final_canonical_summary: verification.final_canonical_summary,
        checks: verification.checks,
      },
      machineVerification,
      `${label} machine report`,
      'VERIFICATION_PROVENANCE_ERROR',
    );
  }
  return {
    editorial_review_complete: verification.editorial_review_complete,
    human_editorial_review_complete: verification.human_editorial_review_complete,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
    raw_material_excluded: verification.raw_material_excluded,
    machine_generated: verification.machine_generated,
    verifier_version: verification.verifier_version,
    prospective_canonical_sha256: verification.prospective_canonical_sha256,
    checks: verification.checks,
  };
}

function relationTupleKey(sourceSense, relation) {
  return JSON.stringify([
    sourceSense,
    relation.target,
    relation.target_sense ?? null,
    relation.type,
  ]);
}

function relationSetFromRecords(records) {
  const tuples = new Set();
  for (const record of records) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) {
        tuples.add(relationTupleKey(sense.id, relation));
      }
    }
  }
  return tuples;
}

function relationTupleFromEvent(event, side) {
  return relationTupleKey(event.source_sense, event[side]);
}

function validateRelationEvidence(relationDiff, importedRecords, baseRecords, batchId) {
  validateRelationDiff(relationDiff);
  if (relationDiff.batch_id !== batchId) fail('relation diff batch_id drifted', 'RELATION_SOURCE_MISMATCH');
  const actualRelationTuples = relationSetFromRecords(importedRecords);
  const importedSourceSenses = new Set(
    importedRecords.flatMap((record) => record.senses.map(({ id }) => id)),
  );
  const expectedRelationTuples = relationSetFromRecords(baseRecords);
  for (const event of relationDiff.events) {
    if (!importedSourceSenses.has(event.source_sense)) {
      fail(
        `relation diff event ${event.event_id} mutates a non-imported source sense`,
        'RELATION_SOURCE_NOT_IMPORTED',
      );
    }
    const beforeTuple = event.before ? relationTupleFromEvent(event, 'before') : undefined;
    const afterTuple = event.after ? relationTupleFromEvent(event, 'after') : undefined;
    if (event.operation === 'remove' || event.operation === 'retype' || event.operation === 'retarget') {
      if (!expectedRelationTuples.has(beforeTuple)) {
        fail(`relation diff event ${event.event_id} removes or changes an absent relation`, 'RELATION_BEFORE_NOT_CANONICAL');
      }
      expectedRelationTuples.delete(beforeTuple);
    }
    if (event.operation === 'add' || event.operation === 'retype' || event.operation === 'retarget') {
      expectedRelationTuples.add(afterTuple);
    }
    if (event.operation === 'add' || event.operation === 'retype' || event.operation === 'retarget') {
      if (importedSourceSenses.has(event.source_sense) && !actualRelationTuples.has(afterTuple)) {
        fail(`relation diff event ${event.event_id} is absent from the reviewed canonical records`, 'RELATION_AFTER_NOT_CANONICAL');
      }
    }
  }
  for (const tuple of actualRelationTuples) {
    const [sourceSense] = JSON.parse(tuple);
    if (importedSourceSenses.has(sourceSense) && !expectedRelationTuples.has(tuple)) {
      fail(`reviewed canonical relation ${tuple} is absent from the relation diff`, 'RELATION_DIFF_MISSING_FINAL');
    }
  }
  for (const tuple of expectedRelationTuples) {
    const [sourceSense] = JSON.parse(tuple);
    if (importedSourceSenses.has(sourceSense) && !actualRelationTuples.has(tuple)) {
      fail(`relation diff relation ${tuple} is absent from the reviewed canonical records`, 'RELATION_AFTER_NOT_CANONICAL');
    }
  }
  return summarizeRelationDiff(relationDiff);
}

function validateImportedRecords(importedRecords, baseRecords, expectedImportedCount, checkPilotCompleteness) {
  if (importedRecords.length !== expectedImportedCount) {
    fail(`reviewed import must contain exactly ${expectedImportedCount} records`, 'CANONICAL_COUNT_MISMATCH');
  }
  const expectedIds = importedRecords.map((_, index) => expectedCanonicalId(index));
  assertExactIds(importedRecordIds(importedRecords), expectedIds, 'reviewed import canonical IDs', 'CANONICAL_ID_MISMATCH');
  for (const [index, record] of importedRecords.entries()) {
    if (record.role !== 'start' || record.candidate_id !== record.id) {
      fail(`reviewed import record ${record.id} must be a canonical start`, 'CANONICAL_BINDING_ERROR');
    }
    const expectedSenseIds = record.senses.map((_, senseIndex) => `${record.id}-s${senseIndex + 1}`);
    assertExactIds(
      record.senses.map(({ id }) => id),
      expectedSenseIds,
      `reviewed import ${record.id} sense IDs`,
      'CANONICAL_ID_MISMATCH',
    );
    if (record.id !== expectedIds[index]) fail(`reviewed import ID order drifted at ${index}`, 'CANONICAL_ID_MISMATCH');
  }
  validateDatasetRecords(
    [
      ...baseRecords.map((record, index) => ({
        record,
        filePath: 'base-canonical',
        lineNumber: index + 1,
      })),
      ...importedRecords.map((record, index) => ({
        record,
        filePath: 'external-reviewed-import',
        lineNumber: index + 1,
      })),
    ],
    { checkPilotCompleteness },
  );
}

function createReviewedImportBytes(records) {
  return Buffer.from(
    records.length === 0
      ? ''
      : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function relationSignature(relation) {
  return JSON.stringify([
    relation.source_sense_id,
    relation.target_record_id,
    relation.target_sense_id,
    relation.type,
  ]);
}

function validateM4SearchRegressionAgainstDatabase(database) {
  try {
    assertValidSearchRegressionCorpus(M4_SEARCH_REGRESSION_CORPUS);
  } catch (error) {
    fail(`M4 search regression corpus is invalid: ${error.message}`, 'VERIFICATION_SEARCH_FAILED');
  }

  const observations = [];
  for (const searchCase of M4_SEARCH_REGRESSION_CORPUS.cases.filter(
    ({ evaluation }) => evaluation === 'baseline',
  )) {
    const response = findRecordsBySearchTerm(database, searchCase.query);
    if (response.status !== searchCase.actual.status) {
      fail(`M4 baseline ${searchCase.id} status drifted`, 'VERIFICATION_SEARCH_FAILED');
    }
    if (searchCase.actual.reason !== undefined && response.reason !== searchCase.actual.reason) {
      fail(`M4 baseline ${searchCase.id} reason drifted`, 'VERIFICATION_SEARCH_FAILED');
    }
    const rows = response.matches;
    const resultIds = rows.map(({ id }) => id);
    assertDeep(
      resultIds,
      searchCase.actual.result_ids,
      `M4 baseline ${searchCase.id} result IDs`,
      'VERIFICATION_SEARCH_FAILED',
    );

    for (const assertion of searchCase.assertions) {
      if (assertion.kind === 'record') {
        const record = getRecord(database, assertion.record_id);
        if (!record) fail(
          `M4 baseline ${searchCase.id} is missing record ${assertion.record_id}`,
          'VERIFICATION_SEARCH_FAILED',
        );
        if (assertion.in_results !== resultIds.includes(assertion.record_id)) {
          fail(`M4 baseline ${searchCase.id} record membership drifted`, 'VERIFICATION_SEARCH_FAILED');
        }
        for (const field of ['record_type', 'role']) {
          if (assertion[field] !== undefined && record[field] !== assertion[field]) {
            fail(`M4 baseline ${searchCase.id} ${field} drifted`, 'VERIFICATION_SEARCH_FAILED');
          }
        }
        if (assertion.sense_ids !== undefined) {
          assertDeep(
            record.senses.map(({ id }) => id),
            assertion.sense_ids,
            `M4 baseline ${searchCase.id} sense order`,
            'VERIFICATION_SEARCH_FAILED',
          );
        }
        if (assertion.relation_count !== undefined) {
          const relationCount = record.senses.reduce(
            (sum, sense) => sum + sense.relations.length,
            0,
          );
          if (relationCount !== assertion.relation_count) {
            fail(`M4 baseline ${searchCase.id} relation count drifted`, 'VERIFICATION_SEARCH_FAILED');
          }
        }
      } else if (assertion.kind === 'relation') {
        const actualRelation = getSenseRelations(database, assertion.source_sense_id)
          .map((relation) => ({
            source_sense_id: assertion.source_sense_id,
            target_record_id: relation.target,
            target_sense_id: relation.target_sense,
            type: relation.type,
          }))
          .find((relation) => relationSignature(relation) === relationSignature(assertion));
        if (!actualRelation) {
          fail(`M4 baseline ${searchCase.id} relation ${relationSignature(assertion)} drifted`, 'VERIFICATION_SEARCH_FAILED');
        }
      }
    }

    if (searchCase.selection?.kind === 'relation-target') {
      const source = getRecord(database, searchCase.selection.source_record_id);
      const sourceSense = source?.senses.find(({ id }) => id === searchCase.selection.source_sense_id);
      const targetRelation = sourceSense?.relations.find(({ target, target_sense, type }) => (
        target === searchCase.selection.record_id
        && target_sense === searchCase.selection.sense_id
        && type === searchCase.selection.relation_type
      ));
      const selected = getRecord(database, searchCase.selection.record_id);
      if (!targetRelation || !selected || selected.role !== 'reference-only') {
        fail(`M4 baseline ${searchCase.id} relation selection drifted`, 'VERIFICATION_SEARCH_FAILED');
      }
      if (!selected.senses.some(({ id }) => id === searchCase.selection.sense_id)) {
        fail(`M4 baseline ${searchCase.id} selected sense drifted`, 'VERIFICATION_SEARCH_FAILED');
      }
    }

    observations.push({
      id: searchCase.id,
      query: searchCase.query,
      status: response.status,
      reason: response.reason,
      result_ids: resultIds,
      selected_record_id: searchCase.selection?.record_id ?? null,
      relation_assertion_count: searchCase.assertions.filter(({ kind }) => kind === 'relation').length,
    });
  }
  return {
    corpus_id: M4_SEARCH_REGRESSION_CORPUS.corpus_id,
    evaluation: 'baseline',
    case_count: observations.length,
    cases: observations,
  };
}

export async function runM511ProspectiveVerification({
  baseCanonicalDirectory,
  importedRecords,
  expectedFinalSummary,
  checkPilotCompleteness = true,
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-verification-'));
  const temporaryCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const temporarySqlitePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  try {
    await cp(baseCanonicalDirectory, temporaryCanonicalDirectory, { recursive: true });
    await writeFile(
      path.join(temporaryCanonicalDirectory, 'm5-11-expansion.jsonl'),
      createReviewedImportBytes(importedRecords),
    );
    const canonical = await readCanonicalRecords(temporaryCanonicalDirectory);
    const records = canonical.records.map(recordOf);
    validateDatasetRecords(canonical.records, { checkPilotCompleteness });
    const finalSummary = canonicalSummary(records);
    assertDeep(finalSummary, expectedFinalSummary, 'prospective canonical summary', 'VERIFICATION_METRICS_MISMATCH');
    const prospectiveCanonicalSha256 = await hashCanonicalDirectory(temporaryCanonicalDirectory);

    const build = await buildDictionary({
      inputDirectory: temporaryCanonicalDirectory,
      outputPath: temporarySqlitePath,
      metadata: {
        source_revision: M5_11_BATCH_ID,
        source_revision_source: 'prospective-m5-11-verifier',
        source_revision_verified: 'false',
      },
      checkPilotCompleteness,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });

    const database = new DatabaseSync(temporarySqlitePath, { readOnly: true });
    let sqliteObservation;
    let searchObservation;
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get();
      const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
      const counts = {
        records: database.prepare('SELECT COUNT(*) AS count FROM records').get().count,
        starts: database.prepare("SELECT COUNT(*) AS count FROM records WHERE role = 'start'").get().count,
        references: database.prepare("SELECT COUNT(*) AS count FROM records WHERE role = 'reference-only'").get().count,
        senses: database.prepare('SELECT COUNT(*) AS count FROM senses').get().count,
        relations: database.prepare('SELECT COUNT(*) AS count FROM relations').get().count,
      };
      if (integrity?.integrity_check !== 'ok' || foreignKeys.length > 0) {
        fail('prospective SQLite integrity checks failed', 'VERIFICATION_SQLITE_FAILED');
      }
      assertDeep(
        counts,
        {
          records: expectedFinalSummary.record_count,
          starts: expectedFinalSummary.start_count,
          references: expectedFinalSummary.reference_only_count,
          senses: expectedFinalSummary.sense_count,
          relations: expectedFinalSummary.relation_count,
        },
        'prospective SQLite counts',
        'VERIFICATION_SQLITE_FAILED',
      );
      sqliteObservation = {
        build: {
          recordCount: build.recordCount,
          senseCount: build.senseCount,
          relationCount: build.relationCount,
        },
        integrity: integrity.integrity_check,
        foreign_key_errors: foreignKeys,
        counts,
      };

      searchObservation = {
        m4: validateM4SearchRegressionAgainstDatabase(database),
        admitted_lemmas: importedRecords.map((record) => ({
          record_id: record.id,
          lemma: record.lemma,
          result_ids: findRecordsByExactTerm(database, record.lemma).map(({ id }) => id),
        })),
      };
      if (searchObservation.admitted_lemmas.some(
        ({ record_id: recordId, result_ids: resultIds }) => !resultIds.includes(recordId),
      )) {
        fail('prospective search regression did not find every admitted lemma', 'VERIFICATION_SEARCH_FAILED');
      }
    } finally {
      database.close();
    }

    const canonicalFiles = await readdir(temporaryCanonicalDirectory);
    if (canonicalFiles.some((fileName) => !fileName.endsWith('.jsonl'))) {
      fail('prospective canonical directory contains non-canonical raw material', 'VERIFICATION_RAW_MATERIAL');
    }
    const canonicalText = await Promise.all(
      canonicalFiles.map((fileName) => readFile(path.join(temporaryCanonicalDirectory, fileName), 'utf8')),
    );
    if (canonicalText.join('\n').includes('proposal-')) {
      fail('prospective canonical directory contains candidate-local proposal IDs', 'VERIFICATION_RAW_MATERIAL');
    }
    const rawMaterialObservation = {
      canonical_files: canonicalFiles,
      candidate_local_ids_present: false,
      external_input_paths_present: false,
    };

    const checks = [
      {
        id: 'canonical-integrity',
        status: 'pass',
        result_sha256: sha256Json({ finalSummary, prospectiveCanonicalSha256 }),
      },
      {
        id: 'deterministic-sqlite',
        status: 'pass',
        result_sha256: sha256Json(sqliteObservation),
      },
      {
        id: 'search-product-regression',
        status: 'pass',
        result_sha256: sha256Json(searchObservation),
      },
      {
        id: 'raw-material-exclusion',
        status: 'pass',
        result_sha256: sha256Json(rawMaterialObservation),
      },
    ];
    return {
      machine_generated: true,
      verifier_version: M5_11_PROSPECTIVE_VERIFIER_VERSION,
      prospective_canonical_sha256: prospectiveCanonicalSha256,
      final_canonical_summary: finalSummary,
      checks,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function deriveM511AdmissionGate({
  catalog = M5_11_CATALOG,
  proposal,
  editorial,
  editorialSource,
  proposalSource,
  editorialTiming,
  editorialTimingSource,
  audit,
  auditSource,
  auditTiming,
  auditTimingSource,
  relationDiff,
  relationDiffSource,
  verification,
  verificationSource,
  reviewedImportSource,
  baseRecords,
  baseSummary = canonicalSummary(baseRecords),
  expectedImportedCount = 500,
  expectedCumulativeStartCount = baseSummary.start_count + expectedImportedCount,
  candidateBuffer = 50,
  checkPilotCompleteness = true,
  plan = DEFAULT_PLAN,
  machineVerification,
} = {}) {
  const editorialResult = validateM511EditorialDecisions(editorial, {
    catalog,
    proposal,
    expectedImportedCount,
  });
  const importedRecords = editorialResult.importedRecords;
  const decisions = editorialResult.decisionCounts;
  const importedInventoryIds = editorialResult.decisions
    .filter(({ record }) => record)
    .map(({ decision }) => decision.inventory_id);
  const reserveInventoryIds = editorialResult.decisions
    .filter(({ record }) => !record)
    .map(({ decision }) => decision.inventory_id);
  if (decisions.held + decisions.rejected + decisions.deferred !== candidateBuffer) {
    fail('decision reserve must exactly fill the declared candidate buffer', 'DECISION_COUNT_MISMATCH');
  }
  const processedStartCount = decisions.included + decisions.corrected + decisions.held + decisions.rejected;
  if (processedStartCount === 0) fail('processed_start_count must be positive', 'DECISION_COUNT_MISMATCH');
  validateFileSource(editorialSource, 'M5-11 editorial decision source file');
  validateFileSource(proposalSource, 'M5-11 frozen proposal source file');

  const importBytes = reviewedImportSource?.bytes;
  const reviewedImportSha256 = reviewedImportSource?.sha256 ?? sha256Json(importedRecords);
  const finalRecords = [...baseRecords, ...importedRecords];
  const finalSummary = canonicalSummary(finalRecords);
  validateImportedRecords(importedRecords, baseRecords, expectedImportedCount, checkPilotCompleteness);
  if (finalSummary.start_count !== expectedCumulativeStartCount) {
    fail(`final canonical start count must be ${expectedCumulativeStartCount}`, 'CANONICAL_COUNT_MISMATCH');
  }
  if (finalSummary.record_count !== baseSummary.record_count + expectedImportedCount) {
    fail('final canonical record count drifted from the base plus import', 'CANONICAL_COUNT_MISMATCH');
  }
  const relationSummary = validateRelationEvidence(
    relationDiff,
    importedRecords,
    baseRecords,
    M5_11_BATCH_ID,
  );
  const editorialTimingResult = validateM511TimingArtifact(editorialTiming, {
    source: editorialTimingSource,
    catalog,
    importedInventoryIds,
    reserveInventoryIds,
    timingKind: 'editorial',
    proposalSourceSha256: proposalSource.sha256,
    editorialSourceSha256: editorialSource.sha256,
  });
  const auditTimingResult = validateM511TimingArtifact(auditTiming, {
    source: auditTimingSource,
    catalog,
    timingKind: 'post-freeze-audit',
    expectedSessionId: audit.session_id,
    proposalSourceSha256: proposalSource.sha256,
    editorialSourceSha256: editorialSource.sha256,
    auditSourceSha256: auditSource.sha256,
    editorialTimingSourceSha256: editorialTimingSource.sha256,
    afterTimingArtifact: editorialTiming,
  });
  const auditResult = validateM511AuditArtifact(audit, {
    source: auditSource,
    catalog,
    editorialSourceSha256: editorialSource.sha256,
    proposalSourceSha256: proposalSource.sha256,
    editorialSessionId: editorialTiming.session_id,
  });
  const verificationResult = validateM511VerificationArtifact(verification, {
    source: verificationSource,
    finalSummary,
    reviewedImportSha256,
    editorialSourceSha256: editorialSource.sha256,
    proposalSourceSha256: proposalSource.sha256,
    relationDiffSha256: relationDiffSource.sha256,
    machineVerification,
  });
  if (auditTiming.session_id !== audit.session_id) {
    fail('audit timing session does not match the independent audit', 'AUDIT_PROVENANCE_ERROR');
  }
  if (importBytes && sha256(importBytes) !== reviewedImportSha256) {
    fail('reviewed import digest could not be recomputed', 'CANONICAL_SOURCE_MISMATCH');
  }

  const relationNoiseRate = relationSummary.noise_rate_of_candidates
    ?? relationSummary.noise_rate_of_before;
  const editorSecondsPerProcessedStart = editorialTimingResult.editor_seconds / processedStartCount;
  const metrics = {
    correction_rate_of_selected: decisions.corrected / processedStartCount,
    relation_noise_rate_of_candidates: relationNoiseRate,
    editor_seconds_per_selected_start: editorSecondsPerProcessedStart,
    editor_seconds_per_processed_start: editorSecondsPerProcessedStart,
    editor_time_status: 'measured',
    timing_status: editorialTimingResult.status === 'complete' && auditTimingResult.status === 'complete'
      ? 'complete'
      : 'incomplete',
    unmeasured_timing_pass_count: editorialTimingResult.unmeasured_pass_count
      + auditTimingResult.unmeasured_pass_count,
    audit_status: auditResult.status,
    audit_independent: auditResult.independent,
    open_audit_blocker_count: auditResult.open_blocker_count,
    editorial_review_complete: verificationResult.editorial_review_complete,
    human_editorial_review_complete: verificationResult.human_editorial_review_complete,
    canonical_integrity: verificationResult.canonical_integrity,
    deterministic_sqlite: verificationResult.deterministic_sqlite,
    search_product_regression: verificationResult.search_product_regression,
  };
  const gate = evaluateExpansionGate(metrics, plan);
  const exactNetStartIncrease = finalSummary.start_count - baseSummary.start_count === expectedImportedCount;
  gate.quality_passes.exact_net_start_increase = exactNetStartIncrease;
  gate.gate_status = Object.values(gate.quality_passes).every(Boolean) ? 'pass' : 'fail';
  gate.decision = gate.gate_status === 'pass' ? 'APPROVE BOUNDED' : plan.gate.failure_decision;

  const gateEvidence = {
    schema_version: '1',
    evidence_version: 'm5-11-gate-evidence-v1',
    batch_id: M5_11_BATCH_ID,
    base_summary: baseSummary,
    final_summary: finalSummary,
    decision_counts: {
      ...decisions,
      processed_start_count: processedStartCount,
      imported_start_count: importedRecords.length,
    },
    processed_start_count: processedStartCount,
    imported_start_count: importedRecords.length,
    relation: relationSummary,
    timing: {
      editorial: editorialTimingResult,
      audit: auditTimingResult,
    },
    audit: auditResult,
    verification: verificationResult,
    metrics,
    gate,
  };

  return {
    batch_id: M5_11_BATCH_ID,
    decision_counts: decisions,
    editorial_decisions: editorialResult.decisions,
    proposal_rows: editorialResult.proposalRows,
    processed_start_count: processedStartCount,
    imported_inventory_ids: importedInventoryIds,
    reserve_inventory_ids: reserveInventoryIds,
    imported_records: importedRecords,
    base_summary: baseSummary,
    final_summary: finalSummary,
    relation: relationSummary,
    timing: {
      editorial: editorialTimingResult,
      audit: auditTimingResult,
    },
    audit: auditResult,
    verification: verificationResult,
    metrics,
    gate,
    gate_evidence: gateEvidence,
    sources: {
      proposal: proposalSource,
      editorial: editorialSource,
      editorial_timing: editorialTimingSource,
      audit: auditSource,
      audit_timing: auditTimingSource,
      relation_diff: relationDiffSource,
      verification: verificationSource,
      reviewed_import: reviewedImportSource,
    },
  };
}

function assertExternalInput(filePath, label) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (!relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new M511AdmissionValidationError(
      `${label} must remain outside the repository until the gate passes: ${resolved}`,
      'EXTERNAL_INPUT_REQUIRED',
    );
  }
  return resolved;
}

async function readJsonSource(filePath, label, { external = true } = {}) {
  const resolved = external ? assertExternalInput(filePath, label) : resolveRepositoryPath(filePath, label);
  let bytes;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${resolved}`, 'MISSING_INPUT');
    throw error;
  }
  try {
    return {
      path: resolved,
      bytes,
      sha256: sha256(bytes),
      value: JSON.parse(bytes.toString('utf8')),
    };
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
}

async function readReviewedImportSource(filePath, label = 'M5-11 reviewed import') {
  const resolved = assertExternalInput(filePath, label);
  let bytes;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${resolved}`, 'MISSING_INPUT');
    throw error;
  }
  const text = bytes.toString('utf8');
  const records = text.trim().length === 0
    ? []
    : text.trimEnd().split('\n').map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`${label} line ${index + 1} is not valid JSON: ${error.message}`, 'INVALID_JSON');
      }
    });
  return { path: resolved, bytes, sha256: sha256(bytes), value: records };
}

export async function validateM511Admission({
  proposalPath,
  editorialDecisionPath,
  editorialTimingPath,
  auditPath,
  auditTimingPath,
  relationDiffPath,
  verificationPath,
  reviewedImportPath,
  catalog = M5_11_CATALOG,
  baseCanonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-base-canonical'),
  currentCanonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/canonical'),
  baseInventoryPath = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-base-inventory.json'),
  currentInventoryPath = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-inventory.json'),
  currentSeedPath = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-seed.json'),
  authorizationPath = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-10d-m5-11-authorization-20260912.json'),
  checkPilotCompleteness = true,
  expectedImportedCount = 500,
  expectedCumulativeStartCount = 1278,
  candidateBuffer = 50,
  plan = DEFAULT_PLAN,
  requirePrePromotionSnapshot = true,
} = {}) {
  const required = {
    proposalPath,
    editorialDecisionPath,
    editorialTimingPath,
    auditPath,
    auditTimingPath,
    relationDiffPath,
    verificationPath,
    reviewedImportPath,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) fail(`${key} is required`, 'MISSING_INPUT');
  }
  const [proposalSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource, relationDiffSource, verificationSource, reviewedImportSource] = await Promise.all([
    readJsonSource(proposalPath, 'M5-11 frozen proposal'),
    readJsonSource(editorialDecisionPath, 'M5-11 editorial decisions'),
    readJsonSource(editorialTimingPath, 'M5-11 editorial timing'),
    readJsonSource(auditPath, 'M5-11 independent audit'),
    readJsonSource(auditTimingPath, 'M5-11 audit timing'),
    readJsonSource(relationDiffPath, 'M5-11 relation diff'),
    readJsonSource(verificationPath, 'M5-11 verification'),
    readReviewedImportSource(reviewedImportPath),
  ]);
  const authorizationSource = await readJsonSource(
    authorizationPath,
    'M5-11 authorization',
    { external: false },
  );
  let currentInventoryBytes;
  let currentSeedBytes;
  if (requirePrePromotionSnapshot) {
    [currentInventoryBytes, currentSeedBytes] = await Promise.all([
      readFile(currentInventoryPath),
      readFile(currentSeedPath),
    ]);
  }
  const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory);
  const baseSummary = canonicalSummary(baseCanonical.records.map(recordOf));
  assertDeep(baseSummary, M5_11_BASE_SUMMARY, 'M5-11 base canonical summary', 'BASE_CANONICAL_MISMATCH');
  assertDeep(
    await hashCanonicalDirectory(baseCanonicalDirectory),
    M5_11_BASE_CANONICAL_SHA256,
    'M5-11 base canonical digest',
    'BASE_CANONICAL_MISMATCH',
  );
  if (requirePrePromotionSnapshot) {
    assertDeep(
      await hashCanonicalDirectory(currentCanonicalDirectory),
      M5_11_BASE_CANONICAL_SHA256,
      'current canonical must remain at the pre-import snapshot',
      'UNAUTHORIZED_PROMOTION',
    );
    assertDeep(
      sha256(currentInventoryBytes),
      M5_11_BASE_INVENTORY_SHA256,
      'current inventory must remain at the pre-import snapshot',
      'UNAUTHORIZED_PROMOTION',
    );
    assertDeep(
      sha256(currentSeedBytes),
      M5_11_BASE_SEED_SHA256,
      'current seed must remain at the pre-import snapshot',
      'UNAUTHORIZED_PROMOTION',
    );
  }
  const authorizationResult = await validateM5DAuthorization({
    authorizationPath: authorizationSource.path,
    canonicalDirectory: baseCanonicalDirectory,
    inventoryPath: baseInventoryPath,
  });
  assertDeep(
    authorizationResult.authorization_sha256,
    authorizationSource.sha256,
    'M5-11 authorization digest',
    'AUTHORIZATION_CHAIN_MISMATCH',
  );
  if (authorizationResult.authorization.decision !== 'AUTHORIZE M5-11 +500 VALIDATION') {
    fail('M5-11 authorization decision is not the required validation authorization', 'AUTHORIZATION_CHAIN_MISMATCH');
  }
  const editorialPreview = validateM511EditorialDecisions(editorialSource.value, {
    catalog,
    proposal: proposalSource.value,
    expectedImportedCount,
  });
  const previewBaseRecords = baseCanonical.records.map(recordOf);
  validateImportedRecords(
    editorialPreview.importedRecords,
    previewBaseRecords,
    expectedImportedCount,
    checkPilotCompleteness,
  );
  const previewFinalSummary = canonicalSummary([
    ...previewBaseRecords,
    ...editorialPreview.importedRecords,
  ]);
  const machineVerification = await runM511ProspectiveVerification({
    baseCanonicalDirectory,
    importedRecords: editorialPreview.importedRecords,
    expectedFinalSummary: previewFinalSummary,
    checkPilotCompleteness,
  });
  const result = deriveM511AdmissionGate({
    catalog,
    proposal: proposalSource.value,
    editorial: editorialSource.value,
    editorialSource,
    proposalSource,
    editorialTiming: editorialTimingSource.value,
    editorialTimingSource,
    audit: auditSource.value,
    auditSource,
    auditTiming: auditTimingSource.value,
    auditTimingSource,
    relationDiff: relationDiffSource.value,
    relationDiffSource,
    verification: verificationSource.value,
    verificationSource,
    reviewedImportSource,
    baseRecords: baseCanonical.records.map(recordOf),
    baseSummary,
    expectedImportedCount,
    expectedCumulativeStartCount,
    candidateBuffer,
    checkPilotCompleteness,
    plan,
    machineVerification,
  });
  if (reviewedImportSource.value.length !== result.imported_records.length) {
    fail('reviewed import does not match the editorial decision records', 'CANONICAL_SOURCE_MISMATCH');
  }
  for (const [index, record] of reviewedImportSource.value.entries()) {
    assertDeep(record, result.imported_records[index], `reviewed import record ${index}`, 'CANONICAL_SOURCE_MISMATCH');
  }
  return {
    ...result,
    sources: {
      ...result.sources,
      authorization: authorizationSource,
      base_inventory: {
        path: baseInventoryPath,
        sha256: sha256(await readFile(baseInventoryPath)),
      },
    },
    authorization: authorizationResult.authorization.decision,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }));
  validateM511Admission({
    proposalPath: args.proposal,
    editorialDecisionPath: args.editorial,
    editorialTimingPath: args['editorial-timing'],
    auditPath: args.audit,
    auditTimingPath: args['audit-timing'],
    relationDiffPath: args['relation-diff'],
    verificationPath: args.verification,
    reviewedImportPath: args.output,
  })
    .then((result) => console.log(JSON.stringify({
      batch_id: result.batch_id,
      gate: result.gate,
      final_summary: result.final_summary,
      decision_counts: result.decision_counts,
      processed_start_count: result.processed_start_count,
    }, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

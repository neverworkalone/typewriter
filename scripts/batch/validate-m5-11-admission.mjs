import assert from 'node:assert/strict';
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
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
  M5_11_AGENT_GATE_DECISION,
  M5_11_AGENT_GENERATOR,
  M5_11_AGENT_PROVENANCE_KIND,
  M5_11_AGENT_REVIEW_MODE,
  evaluateM511SemanticCoverage,
  expectedCanonicalId,
  isM511AgentGeneratedArtifact,
  rebaseM511CandidateRecord,
  sha256Json,
  validateM511AgentProvenance,
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
import { validateLexicalAddition } from './lexical-admission.mjs';
import { validateLexicalProduction } from './lexical-production.mjs';
import {
  createLexicalProductionRun,
  produceLexicalProductionState,
  productionSourceBytes,
  productionValueSha256,
} from './lexical-production-state.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
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
export const M5_11_TIMING_RECORDER_VERSION = 'm5-11-timing-recorder-v3';
export const M5_11_TIMING_RECORDING_COMMAND = 'node scripts/batch/record-m5-11-timing.mjs';
export const M5_11_TIMING_CLOCK_SOURCE = 'system-clock';
export const M5_11_TIMING_LIFECYCLE_VERSION = 'm5-11-timing-lifecycle-v1';
export const M5_11_TIMING_PROVENANCE_VERSION = 'm5-11-timing-provenance-v1';
export const M5_11_TIMING_PROVENANCE_ALGORITHM = 'ed25519';
export const M5_11_PROSPECTIVE_VERIFIER_VERSION = 'm5-11-prospective-verifier-v3';
export const M5_11_MACHINE_CHECK_IDS = Object.freeze([
  'canonical-integrity',
  'deterministic-sqlite',
  'search-product-regression',
  'raw-material-exclusion',
  'semantic-quality',
]);
export const M5_11_AGENT_GATE_EVIDENCE_VERSION = 'm5-11a-gate-evidence-v2';

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

function createM511ProductionEvidence({
  batchId = M5_11_BATCH_ID,
  baseRecords = [],
  importedRecords = [],
  proposalSource,
  editorialSource,
  semanticAuditSource,
  admissionSource,
  materializeState = false,
} = {}) {
  const recordValue = (recordInfo) => recordInfo?.record ?? recordInfo;
  const prospectiveRecords = [
    ...baseRecords.map(recordValue),
    ...importedRecords.map(recordValue),
  ];
  const prospectiveBytes = productionSourceBytes(prospectiveRecords);
  const finalSource = admissionSource ?? editorialSource;
  if (!proposalSource || !editorialSource || !semanticAuditSource || !finalSource) {
    fail('M5-11 production state requires source-bound proposal, editorial, semantic-audit, and admission artifacts', 'MISSING_PRODUCTION_STATE');
  }
  const stages = {
    candidate_intake: {
      status: 'complete',
      source_path: proposalSource.path,
      source_bytes: proposalSource.bytes,
      source_sha256: proposalSource.sha256,
    },
    semantic_review: {
      status: 'complete',
      source_path: editorialSource.path,
      source_bytes: editorialSource.bytes,
      source_sha256: editorialSource.sha256,
    },
    selection: {
      status: 'complete',
      source_path: editorialSource.path,
      source_bytes: editorialSource.bytes,
      source_sha256: editorialSource.sha256,
      policy: 'semantic-quality-and-coverage',
    },
    prospective_canonical: {
      status: 'complete',
      source_path: 'external:prospective-canonical-record-values',
      source_bytes: prospectiveBytes,
      source_sha256: sha256(prospectiveBytes),
    },
    audit: {
      status: 'complete',
      source_path: semanticAuditSource.path,
      source_bytes: semanticAuditSource.bytes,
      source_sha256: semanticAuditSource.sha256,
    },
    admission: {
      status: 'complete',
      source_path: finalSource.path,
      source_bytes: finalSource.bytes,
      source_sha256: finalSource.sha256,
      decision: 'admit',
      authorization_ref: finalSource.path,
    },
  };
  if (!materializeState) return { stageEvidence: stages };

  // Legacy M5-11 artifacts remain valid historical inputs, but an active
  // gate must execute the same live producer used by future admissions. The
  // raw files above are inputs to this adapter; they are not replay state.
  const proposalValue = requireObject(proposalSource.value, 'M5-11 proposal source');
  const editorialValue = requireObject(editorialSource.value, 'M5-11 editorial source');
  const proposalRows = requireArray(proposalValue.proposals, 'M5-11 proposal source.proposals');
  const decisions = requireArray(editorialValue.decisions, 'M5-11 editorial source.decisions');
  if (proposalRows.length !== decisions.length) {
    fail('M5-11 live producer proposal and decision counts differ', 'PRODUCTION_SCOPE_MISMATCH');
  }
  const candidateRecords = proposalRows.map(({ candidate_record: candidateRecord }, index) => {
    const decision = decisions[index];
    return decision.canonical_record
      ? rebaseM511CandidateRecord(candidateRecord, decision.canonical_record.id)
      : candidateRecord;
  });
  const reviewRows = decisions.map((decision, index) => ({
    candidate_id: candidateRecords[index].id,
    decision: decision.decision,
    semantic_review: decision.semantic_review ?? {
      status: 'complete',
      source: 'external-editorial-decision',
    },
    ...(decision.canonical_record ? { reviewed_record: decision.canonical_record } : {}),
  }));
  const reviewedRecords = decisions
    .filter(({ canonical_record: canonicalRecord }) => canonicalRecord)
    .map(({ canonical_record: canonicalRecord }) => canonicalRecord);
  const selectedIndexes = decisions
    .map((decision, index) => (decision.canonical_record ? index : null))
    .filter((index) => index !== null);
  const reviewOutput = {
    review_rows: reviewRows,
    reviewed_records: reviewedRecords,
  };
  const selectionOutput = {
    selected_records: reviewedRecords,
    selection_ranks: selectedIndexes,
  };
  const prospectiveOutput = [
    ...baseRecords.map(recordValue),
    ...importedRecords.map(recordValue),
  ];
  const auditOutput = {
    prospective_records_sha256: productionValueSha256(prospectiveOutput),
    semantic_audit_sha256: productionValueSha256(semanticAuditSource.value),
    lexical_audit_sha256: productionValueSha256({
      artifact_id: `${batchId}:lexical-audit`,
      blocking_finding_count: 0,
    }),
  };
  const run = createLexicalProductionRun({ batchId });
  const candidateToken = run.completeCandidateIntake({
    sourcePath: proposalSource.path,
    payloadSpec: {
      input: null,
      output: candidateRecords,
      inputKind: 'none',
      outputKind: 'candidate-records',
      details: {
        candidate_records_sha256: productionValueSha256(candidateRecords),
        candidate_count: candidateRecords.length,
      },
    },
  });
  const reviewToken = run.completeSemanticReview({
    predecessor: candidateToken,
    sourcePath: editorialSource.path,
    payloadSpec: {
      input: candidateRecords,
      output: reviewOutput,
      inputKind: 'candidate-records',
      outputKind: 'reviewed-records',
      details: {
        candidate_records_sha256: productionValueSha256(candidateRecords),
        review_rows_sha256: productionValueSha256(reviewRows),
        reviewed_records_sha256: productionValueSha256(reviewedRecords),
      },
    },
  });
  const selectionToken = run.completeSelection({
    predecessor: reviewToken,
    sourcePath: editorialSource.path,
    payloadSpec: {
      input: reviewOutput,
      output: selectionOutput,
      inputKind: 'reviewed-records',
      outputKind: 'selected-records',
      details: {
        reviewed_records_sha256: productionValueSha256(reviewedRecords),
        selected_records_sha256: productionValueSha256(reviewedRecords),
        selection_ranks_sha256: productionValueSha256(selectedIndexes),
      },
    },
    policy: 'semantic-quality-and-coverage',
  });
  const prospectiveToken = run.completeProspectiveCanonical({
    predecessor: selectionToken,
    sourcePath: 'external:prospective-canonical-record-values',
    payloadSpec: {
      input: selectionOutput,
      output: prospectiveOutput,
      inputKind: 'selected-records',
      outputKind: 'prospective-canonical',
      details: {
        base_records_sha256: productionValueSha256(baseRecords.map(recordValue)),
        base_records: baseRecords.map(recordValue),
        prospective_records_sha256: productionValueSha256(prospectiveOutput),
      },
    },
  });
  const auditToken = run.completeAudit({
    predecessor: prospectiveToken,
    sourcePath: semanticAuditSource.path,
    payloadSpec: {
      input: prospectiveOutput,
      output: auditOutput,
      inputKind: 'prospective-canonical',
      outputKind: 'complete-canonical-audit',
      details: auditOutput,
    },
  });
  const authorization = run.authorizeAdmission({
    predecessor: auditToken,
    authorizationRef: finalSource.path,
    authorizationBytes: finalSource.bytes,
  });
  const admissionOutput = {
    status: 'admitted',
    gate_digest: productionValueSha256({
      batch_id: batchId,
      candidate_count: candidateRecords.length,
      reviewed_count: reviewedRecords.length,
      prospective_record_count: prospectiveOutput.length,
      semantic_audit_sha256: auditOutput.semantic_audit_sha256,
      authorization_sha256: authorization.authorization_sha256,
    }),
  };
  run.completeAdmission({
    authorization,
    sourcePath: finalSource.path,
    payloadSpec: {
      input: auditOutput,
      output: admissionOutput,
      inputKind: 'complete-canonical-audit',
      outputKind: 'admitted-canonical',
      details: {
        authorization_sha256: authorization.authorization_sha256,
        gate_sha256: admissionOutput.gate_digest,
      },
    },
    decision: 'admit',
    admissionResult: admissionOutput,
  });
  const sources = run.getSourceBytesByStage();
  const payloads = Object.fromEntries(Object.entries(sources).map(([stageId, bytes]) => [
    stageId,
    JSON.parse(bytes.toString('utf8')).payload,
  ]));
  return {
    stageEvidence: stages,
    state: run.getState(),
    sources,
    payloads,
  };
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
  const payload = structuredClone(artifact);
  delete payload.recording_proof_sha256;
  if (payload.recorder?.provenance) {
    delete payload.recorder.provenance.signed_recording_proof_sha256;
    delete payload.recorder.provenance.signature_base64;
  }
  return sha256Json(payload);
}

export function validateM511TimingProvenance(
  provenance,
  recordingProofSha256,
  label = 'M5-11 timing recorder provenance',
) {
  requireObject(provenance, `${label} object`);
  if (provenance.version !== M5_11_TIMING_PROVENANCE_VERSION
    || provenance.algorithm !== M5_11_TIMING_PROVENANCE_ALGORITHM) {
    fail(`${label} is not an M5-11 recorder signature`, 'TIMING_PROVENANCE_ERROR');
  }
  if (!/^[a-zA-Z0-9+/]+={0,2}$/u.test(provenance.public_key_spki_base64 ?? '')) {
    fail(`${label} public key is invalid`, 'TIMING_PROVENANCE_ERROR');
  }
  if (!/^[a-zA-Z0-9+/]+={0,2}$/u.test(provenance.signature_base64 ?? '')) {
    fail(`${label} signature is invalid`, 'TIMING_PROVENANCE_ERROR');
  }
  if (provenance.signed_recording_proof_sha256 !== recordingProofSha256) {
    fail(`${label} does not sign the recording proof`, 'TIMING_PROVENANCE_ERROR');
  }
  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(provenance.public_key_spki_base64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    valid = verifySignature(
      null,
      Buffer.from(recordingProofSha256, 'utf8'),
      publicKey,
      Buffer.from(provenance.signature_base64, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail(`${label} signature does not verify the recording proof`, 'TIMING_PROVENANCE_ERROR');
  return {
    version: provenance.version,
    algorithm: provenance.algorithm,
    public_key_spki_base64: provenance.public_key_spki_base64,
    signed_recording_proof_sha256: provenance.signed_recording_proof_sha256,
    signature_base64: provenance.signature_base64,
  };
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

function recordInfos(records, source, filePath = source) {
  return records.map((recordInfo, index) => recordInfo?.record
    ? recordInfo
    : {
      record: recordInfo,
      source,
      filePath,
      lineNumber: index + 1,
    });
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

export function validateM511TimingLifecycle(
  artifact,
  {
    timingKind,
    expectedPasses,
    recorderEventsByKey,
    source,
    label,
  } = {},
) {
  const lifecycle = requireObject(artifact.recorder?.lifecycle, `${label}.recorder.lifecycle`);
  const expectedArtifactKind = timingKind === 'editorial'
    ? 'editorial-decisions'
    : 'independent-audit';
  if (lifecycle.version !== M5_11_TIMING_LIFECYCLE_VERSION
    || lifecycle.artifact_kind !== expectedArtifactKind
    || lifecycle.binding_mode !== 'start-before-artifact-finalization') {
    fail(`${label} does not contain the recorder lifecycle contract`, 'TIMING_PROVENANCE_ERROR');
  }
  if (lifecycle.artifact_existed_at_session_start !== false
    || lifecycle.artifact_bound_at_stop !== true
    || lifecycle.private_key_path !== null) {
    fail(`${label} does not prove artifact finalization occurred during the recorder session`, 'TIMING_PROVENANCE_ERROR');
  }
  requireString(lifecycle.artifact_path, `${label}.recorder.lifecycle.artifact_path`);
  const artifactPath = path.resolve(lifecycle.artifact_path);
  const artifactRelativePath = path.relative(REPOSITORY_DIRECTORY, artifactPath);
  if (!artifactRelativePath.startsWith('..') || path.isAbsolute(artifactRelativePath)) {
    fail(`${label} bound artifact must remain outside the repository`, 'TIMING_PROVENANCE_ERROR');
  }
  if (artifactPath === path.resolve(source.path)) {
    fail(`${label} bound artifact cannot be the timing session itself`, 'TIMING_PROVENANCE_ERROR');
  }
  const startEvent = recorderEventsByKey.get(`${expectedPasses[0]}:start`);
  const finalStopEvent = recorderEventsByKey.get(`${expectedPasses.at(-1)}:stop`);
  if (!startEvent || !finalStopEvent
    || isoTimestamp(lifecycle.session_started_at, `${label}.recorder.lifecycle.session_started_at`) !== startEvent.at
    || lifecycle.session_start_event_id !== startEvent.event_id
    || isoTimestamp(lifecycle.artifact_bound_at, `${label}.recorder.lifecycle.artifact_bound_at`) !== finalStopEvent.at
    || lifecycle.artifact_bound_event_id !== finalStopEvent.event_id
    || lifecycle.artifact_bound_pass_id !== expectedPasses.at(-1)) {
    fail(`${label} artifact binding is not attached to recorder-owned lifecycle events`, 'TIMING_PROVENANCE_ERROR');
  }
  const sourceKey = timingKind === 'editorial' ? 'editorial_sha256' : 'audit_sha256';
  if (!/^[a-f0-9]{64}$/u.test(lifecycle.artifact_sha256 ?? '')
    || lifecycle.artifact_sha256 !== artifact.source?.[sourceKey]) {
    fail(`${label} finalized artifact digest is not source-bound`, 'TIMING_SOURCE_MISMATCH');
  }
  if (!Number.isInteger(lifecycle.artifact_byte_count) || lifecycle.artifact_byte_count <= 0) {
    fail(`${label} finalized artifact byte count is invalid`, 'TIMING_PROVENANCE_ERROR');
  }
  return {
    version: lifecycle.version,
    artifact_kind: lifecycle.artifact_kind,
    binding_mode: lifecycle.binding_mode,
    artifact_existed_at_session_start: lifecycle.artifact_existed_at_session_start,
    artifact_bound_at_stop: lifecycle.artifact_bound_at_stop,
    session_started_at: lifecycle.session_started_at,
    session_start_event_id: lifecycle.session_start_event_id,
    artifact_bound_at: lifecycle.artifact_bound_at,
    artifact_bound_event_id: lifecycle.artifact_bound_event_id,
    artifact_bound_pass_id: lifecycle.artifact_bound_pass_id,
    artifact_sha256: lifecycle.artifact_sha256,
    artifact_byte_count: lifecycle.artifact_byte_count,
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
  const expectedBindingKeys = timingKind === 'editorial'
    ? ['proposal_sha256', 'editorial_sha256']
    : ['proposal_sha256', 'editorial_sha256', 'audit_sha256', 'editorial_timing_sha256'];
  assertExactIds(
    Object.keys(binding).sort(),
    [...expectedBindingKeys].sort(),
    `${label}.source`,
    'TIMING_SOURCE_MISMATCH',
  );
  for (const [key, digest] of Object.entries(binding)) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      fail(`${label}.source.${key} is not a SHA-256 digest`, 'TIMING_SOURCE_MISMATCH');
    }
  }
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
  const recorderProvenance = validateM511TimingProvenance(
    recorder.provenance,
    artifact.recording_proof_sha256,
    `${label}.recorder.provenance`,
  );
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
      start_event_id: recorderStart.event_id,
      stop_event_id: recorderStop.event_id,
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
  const lifecycle = validateM511TimingLifecycle(artifact, {
    timingKind,
    expectedPasses,
    recorderEventsByKey,
    source,
    label,
  });

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
    source_binding: { ...binding },
    recorder: {
      version: recorder.version,
      session_id: recorder.session_id,
      event_count: recorder.event_count,
      event_log_sha256: recorder.event_log_sha256,
      recorder_event_count: recorder.recorder_event_count,
      recorder_event_log_sha256: recorder.recorder_event_log_sha256,
      provenance: recorderProvenance,
      lifecycle,
    },
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
  const agentGenerated = isM511AgentGeneratedArtifact(audit);
  if (agentGenerated) validateM511AgentProvenance(audit, label);
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
    ...(agentGenerated ? { agent_generated_provenance: true } : {}),
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
    generationPassId,
    semanticSummary,
    semanticCoverage,
    semanticFindings,
  } = {},
) {
  const label = 'M5-11 verification artifact';
  validateArtifactHeader(verification, label);
  validateFileSource(source, `${label} source file`);
  const agentGenerated = isM511AgentGeneratedArtifact(verification);
  if (agentGenerated) {
    const provenance = validateM511AgentProvenance(verification, label);
    if (provenance.pass_id !== verification.verification_pass_id) {
      fail(`${label}.provenance.pass_id must bind the verification pass`, 'VERIFICATION_PROVENANCE_ERROR');
    }
    if (verification.editorial_review_complete !== true
      || verification.automated_editorial_review_complete !== true) {
      fail(`${label} automated editorial review must be complete`, 'VERIFICATION_GATE_ERROR');
    }
    if (verification.generation_verification_separated !== true) {
      fail(`${label} must prove separate generation and verification passes`, 'VERIFICATION_PROVENANCE_ERROR');
    }
    requireString(verification.generation_pass_id, `${label}.generation_pass_id`);
    requireString(verification.verification_pass_id, `${label}.verification_pass_id`);
    if (verification.generation_pass_id === verification.verification_pass_id) {
      fail(`${label} generation and verification passes must be distinct`, 'VERIFICATION_PROVENANCE_ERROR');
    }
    if (generationPassId !== undefined && verification.generation_pass_id !== generationPassId) {
      fail(`${label}.generation_pass_id does not bind the editorial generation pass`, 'VERIFICATION_PROVENANCE_ERROR');
    }
    if (verification.generation_editorial_sha256 !== editorialSourceSha256) {
      fail(`${label}.generation_editorial_sha256 drifted`, 'VERIFICATION_SOURCE_MISMATCH');
    }
    if (verification.semantic_quality_complete !== true
      || !verification.semantic_summary
      || !verification.semantic_coverage) {
      fail(`${label} must include complete semantic-quality evidence`, 'VERIFICATION_SEMANTIC_QUALITY');
    }
    if (semanticSummary !== undefined) {
      assertDeep(
        verification.semantic_summary,
        semanticSummary,
        `${label}.semantic_summary`,
        'VERIFICATION_SEMANTIC_QUALITY',
      );
    }
    if (semanticCoverage !== undefined) {
      assertDeep(
        verification.semantic_coverage,
        semanticCoverage,
        `${label}.semantic_coverage`,
        'VERIFICATION_SEMANTIC_QUALITY',
      );
    }
    const findings = requireArray(verification.semantic_findings, `${label}.semantic_findings`);
    if (!Number.isInteger(verification.semantic_finding_count)
      || verification.semantic_finding_count !== findings.length
      || findings.length === 0) {
      fail(`${label}.semantic_finding_count does not cover per-candidate findings`, 'VERIFICATION_SEMANTIC_QUALITY');
    }
    for (const [index, finding] of findings.entries()) {
      const findingLabel = `${label}.semantic_findings[${index}]`;
      requireObject(finding, findingLabel);
      requireString(finding.inventory_id, `${findingLabel}.inventory_id`);
      requireString(finding.candidate_lemma, `${findingLabel}.candidate_lemma`);
      requireString(finding.decision, `${findingLabel}.decision`);
      requireObject(finding.semantic_review, `${findingLabel}.semantic_review`);
    }
    if (verification.semantic_findings_sha256 !== sha256Json(findings)) {
      fail(`${label}.semantic_findings_sha256 drifted`, 'VERIFICATION_SEMANTIC_QUALITY');
    }
    if (semanticFindings !== undefined) {
      assertDeep(
        findings,
        semanticFindings,
        `${label}.semantic_findings`,
        'VERIFICATION_SEMANTIC_QUALITY',
      );
    }
  } else {
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
  }
  for (const key of [
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
  if (agentGenerated
    && verification.semantic_quality_complete !== (checksById.get('semantic-quality')?.status === 'pass')) {
    fail(`${label}.semantic_quality_complete is not derived from its machine check`, 'VERIFICATION_GATE_ERROR');
  }
  if (machineVerification !== undefined) {
    const machineReport = {
      machine_generated: verification.machine_generated,
      verifier_version: verification.verifier_version,
      prospective_canonical_sha256: verification.prospective_canonical_sha256,
      final_canonical_summary: verification.final_canonical_summary,
      checks: verification.checks,
      machine_check_evidence: verification.machine_check_evidence,
      ...(verification.semantic_summary !== undefined
        ? { semantic_summary: verification.semantic_summary }
        : {}),
      ...(verification.semantic_coverage !== undefined
        ? { semantic_coverage: verification.semantic_coverage }
        : {}),
      ...(verification.semantic_finding_count !== undefined
        ? { semantic_finding_count: verification.semantic_finding_count }
        : {}),
      ...(verification.semantic_findings_sha256 !== undefined
        ? { semantic_findings_sha256: verification.semantic_findings_sha256 }
        : {}),
    };
    assertDeep(
      machineReport,
      machineVerification,
      `${label} machine report`,
      'VERIFICATION_PROVENANCE_ERROR',
    );
  }
  if (agentGenerated) {
    const evidence = requireObject(verification.machine_check_evidence, `${label}.machine_check_evidence`);
    for (const checkId of M5_11_MACHINE_CHECK_IDS) {
      requireObject(evidence[checkId], `${label}.machine_check_evidence.${checkId}`);
    }
  }
  return {
    review_mode: verification.review_mode ?? null,
    editorial_review_complete: verification.editorial_review_complete,
    automated_editorial_review_complete: verification.automated_editorial_review_complete ?? false,
    human_editorial_review_complete: verification.human_editorial_review_complete ?? false,
    agent_generated_provenance: agentGenerated,
    generation_verification_separated: agentGenerated
      ? verification.generation_verification_separated
      : false,
    generation_pass_id: verification.generation_pass_id ?? null,
    verification_pass_id: verification.verification_pass_id ?? null,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
    raw_material_excluded: verification.raw_material_excluded,
    semantic_quality_complete: verification.semantic_quality_complete ?? false,
    ...(verification.semantic_summary !== undefined
      ? { semantic_summary: verification.semantic_summary }
      : {}),
    ...(verification.semantic_coverage !== undefined
      ? { semantic_coverage: verification.semantic_coverage }
      : {}),
    ...(agentGenerated
      ? {
        semantic_finding_count: verification.semantic_finding_count,
        semantic_findings_sha256: verification.semantic_findings_sha256,
      }
      : {}),
    machine_generated: verification.machine_generated,
    verifier_version: verification.verifier_version,
    prospective_canonical_sha256: verification.prospective_canonical_sha256,
    checks: verification.checks,
    ...(agentGenerated ? { machine_check_evidence: verification.machine_check_evidence } : {}),
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

function validateM511SemanticRelationBindings(semantic, relationDiff) {
  const bindings = requireArray(semantic.relation_bindings, 'M5-11 semantic relation_bindings');
  const semanticRelationIds = bindings.flatMap(({ relation_ids: relationIds }) => relationIds);
  const semanticRelationIdSet = new Set(semanticRelationIds);
  if (semanticRelationIdSet.size !== semanticRelationIds.length) {
    fail('M5-11 semantic relation IDs must be unique', 'EDITORIAL_RELATION_BINDING');
  }
  const admittedEvents = relationDiff.events.filter(({ operation }) => (
    operation === 'add' || operation === 'retype' || operation === 'retarget'
  ));
  const eventRelationIds = admittedEvents.map(({ relation_id: relationId }) => relationId);
  assertExactIds(
    [...semanticRelationIds].sort(),
    [...eventRelationIds].sort(),
    'M5-11 semantic relation decisions',
    'EDITORIAL_RELATION_BINDING',
  );
  for (const event of admittedEvents) {
    const binding = bindings.find(({ source_sense: sourceSense, relation_ids: relationIds }) => (
      sourceSense === event.source_sense && relationIds.includes(event.relation_id)
    ));
    if (!binding) {
      fail(
        `relation diff event ${event.event_id} is not bound to a per-sense semantic decision`,
        'EDITORIAL_RELATION_BINDING',
      );
    }
  }
  return {
    relation_decision_count: semanticRelationIds.length,
    relation_event_count: admittedEvents.length,
  };
}

function validateImportedRecords(
  importedRecords,
  baseRecords,
  expectedImportedCount,
  checkPilotCompleteness,
  { semanticAudit, productionState, productionStateSources, productionPayloads } = {},
) {
  if (importedRecords.length !== expectedImportedCount) {
    fail(`reviewed import must contain exactly ${expectedImportedCount} records`, 'CANONICAL_COUNT_MISMATCH');
  }
  const placeholderGloss = /^(?:placeholder|tbd|todo|n\/a|na|미정|미작성|임시|예시|테스트)(?:[\s:.-]|$)/iu;
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
    for (const [senseIndex, sense] of record.senses.entries()) {
      if (typeof sense.gloss !== 'string' || sense.gloss.trim().length === 0 || placeholderGloss.test(sense.gloss.trim())) {
        fail(
          `reviewed import ${record.id} sense ${senseIndex + 1} has an empty or placeholder gloss`,
          'SCHEMA_INTEGRITY_BLOCKER',
        );
      }
    }
  }
  const baseRecordInfos = recordInfos(baseRecords, 'base-canonical');
  const importedRecordInfos = recordInfos(importedRecords, 'external-reviewed-import');
  const prospectiveRecordInfos = [...baseRecordInfos, ...importedRecordInfos];
  if (semanticAudit === undefined) {
    fail('M5-11 reviewed import requires a separately authored prospective semantic audit', 'MISSING_SEMANTIC_AUDIT');
  }
  validateLexicalAddition({
    batchId: M5_11_BATCH_ID,
    baseRecords: baseRecordInfos,
    reviewedRecords: importedRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit,
    productionState,
    productionStateSources,
    productionPayloads,
    checkPilotCompleteness,
    candidateLabel: 'M5-11 candidate records',
    reviewedLabel: 'M5-11 reviewed records',
    prospectiveLabel: 'M5-11 prospective canonical records',
  });
  return 0;
}

function validateM511SharedProduction({
  editorialResult,
  catalog,
  baseRecords,
  importedRecords,
  proposalSource,
  editorialSource,
  expectedImportedCount,
  checkPilotCompleteness,
  semanticAudit,
  productionStageEvidence,
  productionState,
  productionStateSources,
} = {}) {
  const candidateRecords = editorialResult.proposalRows.map(({ candidate_record: candidateRecord }, index) => {
    const reviewedRecord = editorialResult.decisions[index].record;
    const producerCandidate = reviewedRecord
      ? rebaseM511CandidateRecord(candidateRecord, reviewedRecord.id)
      : candidateRecord;
    return {
      record: producerCandidate,
      source: 'm5-11-frozen-proposal',
      filePath: 'm5-11-frozen-proposal',
      lineNumber: index + 1,
    };
  });
  const baseRecordInfos = recordInfos(baseRecords, 'm5-11-base-canonical');
  const importedRecordInfos = recordInfos(importedRecords, 'm5-11-reviewed-import');
  const prospectiveRecordInfos = [...baseRecordInfos, ...importedRecordInfos];
  if (semanticAudit === undefined) {
    fail('M5-11 shared production requires a separately authored prospective semantic audit', 'MISSING_SEMANTIC_AUDIT');
  }
  const reviews = catalog.map((catalogEntry, index) => {
    const decisionResult = editorialResult.decisions[index];
    return {
      candidate_id: candidateRecords[index].record.id,
      inventory_id: catalogEntry.inventory_id,
      decision: decisionResult.decision.decision,
      semantic_review: editorialResult.artifact.decisions[index].semantic_review,
      ...(decisionResult.record ? { reviewed_record: decisionResult.record } : {}),
      expected_record_type: catalogEntry.flags.includes('expression-unit') ? 'expression' : 'entry',
    };
  });
  const production = validateLexicalProduction({
    batchId: M5_11_BATCH_ID,
    candidateRecords,
    reviews,
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit,
    stageEvidence: productionStageEvidence,
    productionState,
    productionStateSources,
    checkPilotCompleteness,
    catalogCount: catalog.length,
    expectedSelectedCount: expectedImportedCount,
    candidateLabel: 'M5-11 shared production candidates',
    reviewedLabel: 'M5-11 shared production reviewed records',
    prospectiveLabel: 'M5-11 shared production prospective records',
  });
  return {
    production,
    semanticAudit,
  };
}

function normalizedLexicalValue(value) {
  return value.normalize('NFC');
}

function addLexicalOwner(ownersByValue, value, ownerId) {
  const normalized = normalizedLexicalValue(value);
  const owners = ownersByValue.get(normalized) ?? [];
  if (!owners.includes(ownerId)) owners.push(ownerId);
  ownersByValue.set(normalized, owners);
}

function validateCandidateLexicalCollisions(proposalRows, baseRecords, importedRecords) {
  const baseOwners = new Map();
  for (const record of baseRecords) {
    for (const value of [record.lemma, ...record.search_forms]) {
      addLexicalOwner(baseOwners, value, record.id);
    }
  }

  const candidateOwners = new Map();
  for (const row of proposalRows) {
    const values = [row.candidate_lemma, ...row.candidate_record.search_forms];
    for (const value of values) {
      const normalized = normalizedLexicalValue(value);
      const existingOwners = baseOwners.get(normalized);
      if (existingOwners?.length) {
        fail(
          `candidate ${row.inventory_id} collides with canonical lexical value ${normalized} (${existingOwners.join(', ')})`,
          'LEXICAL_COLLISION',
        );
      }
      addLexicalOwner(candidateOwners, value, row.inventory_id);
    }
  }

  for (const [value, owners] of candidateOwners) {
    if (owners.length > 1) {
      fail(
        `candidate lexical value ${value} is duplicated by ${owners.join(', ')}`,
        'LEXICAL_COLLISION',
      );
    }
  }

  const importedOwners = new Map();
  for (const record of importedRecords) {
    for (const value of [record.lemma, ...record.search_forms]) {
      const normalized = normalizedLexicalValue(value);
      const existingOwners = baseOwners.get(normalized);
      if (existingOwners?.length) {
        fail(
          `promoted canonical record ${record.id} collides with canonical lexical value ${normalized} (${existingOwners.join(', ')})`,
          'LEXICAL_COLLISION',
        );
      }
      addLexicalOwner(importedOwners, value, record.id);
    }
  }
  for (const [value, owners] of importedOwners) {
    if (owners.length > 1) {
      fail(
        `promoted canonical lexical value ${value} is duplicated by ${owners.join(', ')}`,
        'LEXICAL_COLLISION',
      );
    }
  }

  return { canonical_collision_count: 0, candidate_collision_count: 0 };
}

function notRequiredTimingEvidence(timingKind) {
  return {
    status: 'not-required',
    policy: 'agent-generated',
    measurement_kind: 'agent-processing',
    timing_kind: timingKind,
    session_id: null,
    pass_ids: [],
    pass_intervals: [],
    editor_seconds: null,
    audit_seconds: null,
    unmeasured_pass_count: 0,
  };
}

function notRequiredAuditEvidence() {
  return {
    status: 'not-required',
    policy: 'agent-generated',
    independent: null,
    session_id: null,
    open_blocker_count: 0,
    finding_count: 0,
  };
}

export function evaluateM511AgentGate({
  metrics,
  plan = DEFAULT_PLAN,
  exactNetStartIncrease,
  expectedImportedCount = 500,
  expectedCumulativeStartCount = 1278,
  expectedCandidatePoolCount = 550,
  expectedReserveCount = 50,
} = {}) {
  const relationNoiseRate = metrics.relation_noise_rate_of_candidates
    ?? metrics.relation_noise_rate_of_before;
  const baselineRate = plan.gate.relation_noise_baseline.noise_event_count
    / plan.gate.relation_noise_baseline.before_count;
  const qualityPasses = {
    candidate_pool: metrics.candidate_pool_count === expectedCandidatePoolCount,
    imported_start_count: metrics.imported_start_count === expectedImportedCount,
    reserve_count: metrics.reserve_count === expectedReserveCount,
    canonical_lexical_collisions: metrics.canonical_collision_count === 0,
    candidate_lexical_collisions: metrics.candidate_collision_count === 0,
    placeholder_glosses: metrics.placeholder_gloss_count === 0,
    correction_rate: Number.isFinite(metrics.correction_rate_of_selected)
      && metrics.correction_rate_of_selected <= plan.gate.correction_rate_max,
    relation_noise_rate: Number.isFinite(relationNoiseRate)
      && relationNoiseRate <= plan.gate.relation_noise_rate_max,
    relation_noise_below_baseline: !plan.gate.relation_noise_below_m5_3_baseline_required
      || Number.isFinite(relationNoiseRate) && relationNoiseRate < baselineRate,
    automated_editorial_review: metrics.automated_editorial_review_complete === true,
    agent_generated_provenance: metrics.agent_generated_provenance === true,
    generation_verification_separated: metrics.generation_verification_separated === true,
    schema_integrity_blockers: metrics.schema_integrity_blocker_count === 0,
    relation_target_blockers: metrics.relation_target_blocker_count === 0,
    canonical_integrity: metrics.canonical_integrity === true,
    deterministic_sqlite: metrics.deterministic_sqlite === true,
    search_product_regression: metrics.search_product_regression === true,
    semantic_quality: metrics.semantic_review_complete === true
      && metrics.semantic_quality_blocker_count === 0,
    semantic_selection: metrics.semantic_selection_rank_valid === true,
    semantic_axis_coverage: metrics.semantic_axis_coverage_complete === true,
    semantic_expression_coverage: metrics.semantic_expression_coverage_complete === true,
    semantic_relation_coverage: metrics.semantic_relation_coverage_complete === true,
    exact_net_start_increase: exactNetStartIncrease === true,
    cumulative_start_target: metrics.final_start_count === expectedCumulativeStartCount,
  };
  // Preserve the shape of already-promoted M5-11A evidence while requiring
  // the common production stage for every newly derived gate.  New admission
  // metrics always include this field; historical summaries predate the
  // batch-neutral producer contract and are independently covered by the
  // complete canonical semantic audit.
  if (metrics.shared_lexical_production !== undefined) {
    qualityPasses.shared_lexical_production = metrics.shared_lexical_production === true;
  }
  const gateStatus = Object.values(qualityPasses).every(Boolean) ? 'pass' : 'fail';
  return {
    policy: M5_11_AGENT_REVIEW_MODE,
    quality_passes: qualityPasses,
    gate_status: gateStatus,
    decision: gateStatus === 'pass' ? M5_11_AGENT_GATE_DECISION : plan.gate.failure_decision,
  };
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
  semanticAudit,
  productionState,
  productionStateSources,
  productionPayloads,
  expectedFinalSummary,
  checkPilotCompleteness = true,
  semanticSummary = null,
  semanticCoverage = null,
  semanticFindings = null,
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-verification-'));
  const temporaryCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const temporarySqlitePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  try {
    const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory);
    const baseRecordInfos = baseCanonical.records;
    await cp(baseCanonicalDirectory, temporaryCanonicalDirectory, { recursive: true });
    await writeFile(
      path.join(temporaryCanonicalDirectory, 'm5-11-expansion.jsonl'),
      createReviewedImportBytes(importedRecords),
    );
    const canonical = await readCanonicalRecords(temporaryCanonicalDirectory);
    const records = canonical.records.map(recordOf);
    if (semanticAudit === undefined) {
      fail('M5-11 prospective verification requires the pre-written semantic audit', 'MISSING_SEMANTIC_AUDIT');
    }
    const lexicalAdmission = validateLexicalAddition({
      batchId: M5_11_BATCH_ID,
      baseRecords: baseRecordInfos,
      reviewedRecords: importedRecords,
      prospectiveRecords: canonical.records,
      semanticAudit,
      productionState,
      productionStateSources,
      productionPayloads,
      checkPilotCompleteness,
      prospectiveLabel: 'M5-11 prospective verification canonical records',
    });
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
    const completeCanonicalReview = semanticAudit?.review?.review_pass
      ? {
        artifact_id: semanticAudit.review.artifact_id ?? null,
        contract_version: semanticAudit.review.contract_version ?? null,
        review_pass_id: semanticAudit.review.review_pass.id,
        status: semanticAudit.review.review_pass.status,
        reviewer: semanticAudit.review.review_pass.reviewer,
        record_count: semanticAudit.review.review_pass.record_count,
        sense_count: semanticAudit.review.review_pass.sense_count,
        open_finding_count: semanticAudit.review.review_pass.open_finding_count,
        correction_count: semanticAudit.review.review_pass.correction_count,
        boundary_decision_source_version: semanticAudit.review.review_pass.boundary_decision_source_version,
        canonical_records_sha256: semanticAudit.source?.canonical_records_sha256 ?? null,
        review_sha256: sha256Json(semanticAudit.review),
      }
      : null;
    const semanticObservation = {
      status: semanticSummary && semanticCoverage ? 'pass' : 'not-required',
      semantic_audit: lexicalAdmission.semantic_audit,
      complete_canonical_review: completeCanonicalReview,
      summary: semanticSummary,
      coverage: semanticCoverage,
      finding_count: semanticFindings?.length ?? 0,
      findings_sha256: semanticFindings ? sha256Json(semanticFindings) : null,
    };
    if (semanticSummary && semanticCoverage
      && (semanticSummary.complete !== true
        || semanticSummary.broad_gloss_count !== 0
        || semanticCoverage.axis_coverage_complete !== true
        || semanticCoverage.expression_coverage_complete !== true
        || semanticCoverage.relation_coverage_complete !== true
        || !Array.isArray(semanticFindings)
        || semanticFindings.length === 0)) {
      fail('prospective semantic-quality verification did not pass', 'VERIFICATION_SEMANTIC_QUALITY');
    }

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
      {
        id: 'semantic-quality',
        status: 'pass',
        result_sha256: sha256Json(semanticObservation),
      },
    ];
    const machineCheckEvidence = {
      'canonical-integrity': {
        final_summary: finalSummary,
        prospective_canonical_sha256: prospectiveCanonicalSha256,
        semantic_audit: lexicalAdmission.semantic_audit,
      },
      'deterministic-sqlite': sqliteObservation,
      'search-product-regression': searchObservation,
      'raw-material-exclusion': rawMaterialObservation,
      'semantic-quality': semanticObservation,
    };
    return {
      machine_generated: true,
      verifier_version: M5_11_PROSPECTIVE_VERIFIER_VERSION,
      prospective_canonical_sha256: prospectiveCanonicalSha256,
      final_canonical_summary: finalSummary,
      checks,
      machine_check_evidence: machineCheckEvidence,
      semantic_summary: semanticSummary,
      semantic_coverage: semanticCoverage,
      semantic_finding_count: semanticFindings?.length ?? 0,
      semantic_findings_sha256: semanticFindings ? sha256Json(semanticFindings) : null,
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
  semanticAuditSource,
  baseRecords,
  baseSummary = canonicalSummary(baseRecords),
  expectedImportedCount = 500,
  expectedCumulativeStartCount = baseSummary.start_count + expectedImportedCount,
  candidateBuffer = 50,
  checkPilotCompleteness = true,
  plan = DEFAULT_PLAN,
  machineVerification,
  expectedCandidatePoolCount = 550,
  semanticAudit,
  productionState,
  productionStateSources,
  authorizationSource,
} = {}) {
  if (semanticAudit === undefined) {
    fail('M5-11 admission gate requires the pre-written prospective semantic audit', 'MISSING_SEMANTIC_AUDIT');
  }
  validateFileSource(semanticAuditSource, 'M5-11 prospective semantic audit source file');
  assertDeep(
    semanticAuditSource.value,
    semanticAudit,
    'M5-11 prospective semantic audit source value',
    'SEMANTIC_AUDIT_SOURCE_MISMATCH',
  );
  const editorialResult = validateM511EditorialDecisions(editorial, {
    catalog,
    proposal,
    expectedImportedCount,
  });
  const agentGenerated = isM511AgentGeneratedArtifact(editorial);
  const semantic = agentGenerated ? editorialResult.semantic : undefined;
  const semanticCoverage = agentGenerated
    ? evaluateM511SemanticCoverage({
      semantic,
      catalog,
      expectedImportedCount,
    })
    : undefined;
  const importedRecords = editorialResult.importedRecords;
  const productionEvidence = productionState
    ? { state: productionState, sources: productionStateSources }
    : createM511ProductionEvidence({
      batchId: M5_11_BATCH_ID,
      baseRecords,
      importedRecords,
      proposalSource,
      editorialSource,
      semanticAuditSource,
      admissionSource: authorizationSource ?? reviewedImportSource,
      materializeState: !agentGenerated,
    });
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
  const collisionSummary = validateCandidateLexicalCollisions(
    editorialResult.proposalRows,
    baseRecords,
    importedRecords,
  );

  const importBytes = reviewedImportSource?.bytes;
  const reviewedImportSha256 = reviewedImportSource?.sha256 ?? sha256Json(importedRecords);
  const finalRecords = [...baseRecords, ...importedRecords];
  const finalSummary = canonicalSummary(finalRecords);
  const prospectiveRecordInfos = [
    ...recordInfos(baseRecords, 'm5-11-base-canonical'),
    ...recordInfos(importedRecords, 'm5-11-reviewed-import'),
  ];
  const sharedProduction = agentGenerated
    ? validateM511SharedProduction({
      editorialResult,
      catalog,
      baseRecords,
      importedRecords,
      proposalSource,
      editorialSource,
      expectedImportedCount,
      checkPilotCompleteness,
      semanticAudit,
      productionStageEvidence: productionEvidence.stageEvidence,
      productionState: productionEvidence.state,
      productionStateSources: productionEvidence.sources,
    })
    : null;
  const admittedProductionState = sharedProduction?.production.production_state ?? productionEvidence.state;
  const admittedProductionSources = sharedProduction?.production.production_state_sources
    ?? productionEvidence.sources;
  const admittedProductionPayloads = sharedProduction?.production.production_payloads
    ?? productionEvidence.payloads;
  const placeholderGlossCount = validateImportedRecords(
    importedRecords,
    baseRecords,
    expectedImportedCount,
    checkPilotCompleteness,
    {
      semanticAudit,
      productionState: admittedProductionState,
      productionStateSources: admittedProductionSources,
      productionPayloads: admittedProductionPayloads,
    },
  );
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
  if (agentGenerated) {
    validateM511SemanticRelationBindings(semantic, relationDiff);
  }
  if (!agentGenerated && (!editorialTiming || !audit || !auditTiming)) {
    fail('legacy M5-11 admission requires editorial and audit timing artifacts', 'MISSING_INPUT');
  }
  if (agentGenerated && ((audit && !auditSource) || (auditTiming && !auditTimingSource))) {
    fail('automated M5-11 audit artifacts require their source bindings', 'AUDIT_PROVENANCE_ERROR');
  }
  const editorialTimingResult = editorialTiming
    ? validateM511TimingArtifact(editorialTiming, {
      source: editorialTimingSource,
      catalog,
      importedInventoryIds,
      reserveInventoryIds,
      timingKind: 'editorial',
      proposalSourceSha256: proposalSource.sha256,
      editorialSourceSha256: editorialSource.sha256,
    })
    : notRequiredTimingEvidence('editorial');
  const auditTimingResult = auditTiming
    ? validateM511TimingArtifact(auditTiming, {
      source: auditTimingSource,
      catalog,
      timingKind: 'post-freeze-audit',
      expectedSessionId: audit?.session_id,
      proposalSourceSha256: proposalSource.sha256,
      editorialSourceSha256: editorialSource.sha256,
      auditSourceSha256: auditSource?.sha256,
      editorialTimingSourceSha256: editorialTimingSource?.sha256,
      afterTimingArtifact: editorialTiming,
    })
    : notRequiredTimingEvidence('post-freeze-audit');
  const auditResult = audit
    ? validateM511AuditArtifact(audit, {
      source: auditSource,
      catalog,
      editorialSourceSha256: editorialSource.sha256,
      proposalSourceSha256: proposalSource.sha256,
      editorialSessionId: editorialTiming?.session_id,
    })
    : notRequiredAuditEvidence();
  const verificationResult = validateM511VerificationArtifact(verification, {
    source: verificationSource,
    finalSummary,
    reviewedImportSha256,
    editorialSourceSha256: editorialSource.sha256,
    proposalSourceSha256: proposalSource.sha256,
    relationDiffSha256: relationDiffSource.sha256,
    machineVerification,
    generationPassId: editorial?.provenance?.pass_id,
    semanticSummary: semantic,
    semanticCoverage,
    semanticFindings: editorialResult.semantic_findings,
  });
  if (auditTiming && audit && auditTiming.session_id !== audit.session_id) {
    fail('audit timing session does not match the independent audit', 'AUDIT_PROVENANCE_ERROR');
  }
  if (importBytes && sha256(importBytes) !== reviewedImportSha256) {
    fail('reviewed import digest could not be recomputed', 'CANONICAL_SOURCE_MISMATCH');
  }

  const relationNoiseRate = relationSummary.noise_rate_of_candidates
    ?? relationSummary.noise_rate_of_before;
  const editorSecondsPerProcessedStart = editorialTimingResult.editor_seconds === null
    ? null
    : editorialTimingResult.editor_seconds / processedStartCount;
  const metrics = {
    policy: agentGenerated ? M5_11_AGENT_REVIEW_MODE : 'human-reviewed',
    candidate_pool_count: catalog.length,
    imported_start_count: importedRecords.length,
    reserve_count: decisions.held + decisions.rejected + decisions.deferred,
    final_start_count: finalSummary.start_count,
    canonical_collision_count: collisionSummary.canonical_collision_count,
    candidate_collision_count: collisionSummary.candidate_collision_count,
    placeholder_gloss_count: placeholderGlossCount,
    schema_integrity_blocker_count: 0,
    relation_target_blocker_count: 0,
    correction_rate_of_selected: decisions.corrected / processedStartCount,
    relation_noise_rate_of_candidates: relationNoiseRate,
    editor_seconds_per_selected_start: editorSecondsPerProcessedStart,
    editor_seconds_per_processed_start: editorSecondsPerProcessedStart,
    editor_time_status: agentGenerated ? 'not-required' : 'measured',
    timing_status: agentGenerated
      ? 'not-required'
      : editorialTimingResult.status === 'complete' && auditTimingResult.status === 'complete'
        ? 'complete'
        : 'incomplete',
    unmeasured_timing_pass_count: agentGenerated
      ? 0
      : editorialTimingResult.unmeasured_pass_count + auditTimingResult.unmeasured_pass_count,
    audit_status: auditResult.status,
    audit_independent: auditResult.independent,
    open_audit_blocker_count: auditResult.open_blocker_count,
    editorial_review_complete: verificationResult.editorial_review_complete,
    automated_editorial_review_complete: verificationResult.automated_editorial_review_complete,
    agent_generated_provenance: verificationResult.agent_generated_provenance,
    generation_verification_separated: verificationResult.generation_verification_separated,
    human_editorial_review_complete: verificationResult.human_editorial_review_complete,
    canonical_integrity: verificationResult.canonical_integrity,
    deterministic_sqlite: verificationResult.deterministic_sqlite,
    search_product_regression: verificationResult.search_product_regression,
    semantic_review_complete: agentGenerated ? semantic.complete : null,
    shared_lexical_production: agentGenerated ? sharedProduction?.production?.pipeline_version === 'lexical-production-v1' : null,
    semantic_quality_blocker_count: agentGenerated ? semantic.broad_gloss_count : 0,
    semantic_selection_rank_valid: agentGenerated ? semantic.selection_rank_valid : null,
    semantic_axis_coverage_complete: agentGenerated ? semanticCoverage.axis_coverage_complete : null,
    semantic_expression_coverage_complete: agentGenerated
      ? semanticCoverage.expression_coverage_complete
      : null,
    semantic_relation_coverage_complete: agentGenerated
      ? semanticCoverage.relation_coverage_complete
      : null,
    semantic_split_record_count: agentGenerated ? semantic.split_record_count : null,
    semantic_split_sense_count: agentGenerated ? semantic.split_sense_count : null,
    semantic_relation_candidate_count: agentGenerated ? semantic.relation_candidate_count : null,
    semantic_no_relation_rationale_count: agentGenerated ? semantic.no_relation_rationale_count : null,
  };
  const exactNetStartIncrease = finalSummary.start_count - baseSummary.start_count === expectedImportedCount;
  const gate = agentGenerated
    ? evaluateM511AgentGate({
      metrics,
      plan,
      exactNetStartIncrease,
      expectedImportedCount,
      expectedCumulativeStartCount,
      expectedCandidatePoolCount,
      expectedReserveCount: candidateBuffer,
    })
    : evaluateExpansionGate(metrics, plan);
  if (!agentGenerated) {
    gate.quality_passes.exact_net_start_increase = exactNetStartIncrease;
    gate.gate_status = Object.values(gate.quality_passes).every(Boolean) ? 'pass' : 'fail';
    gate.decision = gate.gate_status === 'pass' ? 'APPROVE BOUNDED' : plan.gate.failure_decision;
  }

  const gateEvidence = {
    schema_version: '1',
    evidence_version: agentGenerated
      ? M5_11_AGENT_GATE_EVIDENCE_VERSION
      : 'm5-11-gate-evidence-v1',
    batch_id: M5_11_BATCH_ID,
    policy: agentGenerated ? M5_11_AGENT_REVIEW_MODE : 'human-reviewed',
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
    ...(semantic ? { semantic, semantic_coverage: semanticCoverage } : {}),
    ...(sharedProduction ? {
      lexical_production: {
        pipeline_version: sharedProduction.production.pipeline_version,
        candidate_count: sharedProduction.production.candidate_count,
        selected_count: sharedProduction.production.selected_count,
        review_count: sharedProduction.production.review_count,
        production_state: admittedProductionState,
        semantic_audit: sharedProduction.production.admission.semantic_audit,
      },
    } : {}),
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
    semantic_audit: semanticAudit,
    production_state: admittedProductionState,
    metrics,
    gate,
    gate_evidence: gateEvidence,
    sources: {
      proposal: proposalSource,
      editorial: editorialSource,
      relation_diff: relationDiffSource,
      verification: verificationSource,
      reviewed_import: reviewedImportSource,
      semantic_audit: semanticAuditSource,
      ...(editorialTimingSource ? { editorial_timing: editorialTimingSource } : {}),
      ...(auditSource ? { audit: auditSource } : {}),
      ...(auditTimingSource ? { audit_timing: auditTimingSource } : {}),
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
  semanticAuditPath,
  reviewedImportPath,
  catalog = M5_11_CATALOG,
  baseCanonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-base-canonical'),
  currentCanonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/canonical'),
  baseInventoryPath = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-base-inventory.json'),
  currentInventoryPath,
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
    relationDiffPath,
    verificationPath,
    semanticAuditPath,
    reviewedImportPath,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) fail(`${key} is required`, 'MISSING_INPUT');
  }
  const [proposalSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource, relationDiffSource, verificationSource, semanticAuditSource, reviewedImportSource] = await Promise.all([
    readJsonSource(proposalPath, 'M5-11 frozen proposal'),
    readJsonSource(editorialDecisionPath, 'M5-11 editorial decisions'),
    editorialTimingPath
      ? readJsonSource(editorialTimingPath, 'M5-11 editorial timing')
      : null,
    auditPath
      ? readJsonSource(auditPath, 'M5-11 independent audit')
      : null,
    auditTimingPath
      ? readJsonSource(auditTimingPath, 'M5-11 audit timing')
      : null,
    readJsonSource(relationDiffPath, 'M5-11 relation diff'),
    readJsonSource(verificationPath, 'M5-11 verification'),
    readJsonSource(semanticAuditPath, 'M5-11 prospective semantic audit'),
    readReviewedImportSource(reviewedImportPath),
  ]);
  const automatedPolicy = isM511AgentGeneratedArtifact(editorialSource.value);
  if (!automatedPolicy && (!editorialTimingSource || !auditSource || !auditTimingSource)) {
    fail('legacy M5-11 admission requires editorial and audit timing artifacts', 'MISSING_INPUT');
  }
  if ((auditSource && !auditTimingSource) || (!auditSource && auditTimingSource)) {
    fail('audit and audit timing must be supplied together', 'MISSING_INPUT');
  }
  const authorizationSource = await readJsonSource(
    authorizationPath,
    'M5-11 authorization',
    { external: false },
  );
  let currentInventoryBytes;
  let currentSeedBytes;
  if (requirePrePromotionSnapshot) {
    [currentInventoryBytes, currentSeedBytes] = await Promise.all([
      currentInventoryPath
        ? readFile(currentInventoryPath)
        : buildTargetInventory({
          canonicalDirectory: currentCanonicalDirectory,
          seedPath: currentSeedPath,
        }).then(serializeTargetInventory),
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
  const productionEvidence = createM511ProductionEvidence({
    batchId: M5_11_BATCH_ID,
    baseRecords: previewBaseRecords,
    importedRecords: editorialPreview.importedRecords,
    proposalSource,
    editorialSource,
    semanticAuditSource,
    admissionSource: authorizationSource,
    materializeState: !automatedPolicy,
  });
  const sharedProduction = automatedPolicy
    ? validateM511SharedProduction({
      editorialResult: editorialPreview,
      catalog,
      baseRecords: previewBaseRecords,
      importedRecords: editorialPreview.importedRecords,
      proposalSource,
      editorialSource,
      expectedImportedCount,
      checkPilotCompleteness,
      semanticAudit: semanticAuditSource.value,
      productionStageEvidence: productionEvidence.stageEvidence,
    })
    : null;
  const admittedProductionState = sharedProduction?.production.production_state ?? productionEvidence.state;
  const admittedProductionSources = sharedProduction?.production.production_state_sources
    ?? productionEvidence.sources;
  const admittedProductionPayloads = sharedProduction?.production.production_payloads
    ?? productionEvidence.payloads;
  validateImportedRecords(
    editorialPreview.importedRecords,
    previewBaseRecords,
    expectedImportedCount,
    checkPilotCompleteness,
    {
      semanticAudit: semanticAuditSource.value,
      productionState: admittedProductionState,
      productionStateSources: admittedProductionSources,
      productionPayloads: admittedProductionPayloads,
    },
  );
  const previewFinalSummary = canonicalSummary([
    ...previewBaseRecords,
    ...editorialPreview.importedRecords,
  ]);
  const machineVerification = await runM511ProspectiveVerification({
    baseCanonicalDirectory,
    importedRecords: editorialPreview.importedRecords,
    semanticAudit: semanticAuditSource.value,
    productionState: admittedProductionState,
    productionStateSources: admittedProductionSources,
    productionPayloads: admittedProductionPayloads,
    expectedFinalSummary: previewFinalSummary,
    checkPilotCompleteness,
    semanticSummary: editorialPreview.semantic,
    semanticCoverage: editorialPreview.semantic
      ? evaluateM511SemanticCoverage({
        semantic: editorialPreview.semantic,
        catalog,
        expectedImportedCount,
      })
      : null,
    semanticFindings: editorialPreview.semantic_findings,
  });
  const result = deriveM511AdmissionGate({
    catalog,
    proposal: proposalSource.value,
    editorial: editorialSource.value,
    editorialSource,
    proposalSource,
    editorialTiming: editorialTimingSource?.value,
    editorialTimingSource,
    audit: auditSource?.value,
    auditSource,
    auditTiming: auditTimingSource?.value,
    auditTimingSource,
    relationDiff: relationDiffSource.value,
    relationDiffSource,
    verification: verificationSource.value,
    verificationSource,
    semanticAudit: semanticAuditSource.value,
    semanticAuditSource,
    reviewedImportSource,
    productionState: admittedProductionState,
    productionStateSources: admittedProductionSources,
    authorizationSource,
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

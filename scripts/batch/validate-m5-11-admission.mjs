import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateExpansionGate,
  hashCanonicalDirectory,
} from './validate-m5-8-process.mjs';
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

const require = createRequire(import.meta.url);
const DEFAULT_PLAN = require('../../data/batches/m5-8-expansion-plan.json');

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

function validateTimingPass(pass, expectedIds, catalogIdSet, label, { audit = false } = {}) {
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
  if (audit) {
    requireFiniteNumber(pass.audit_seconds, `${label}.audit_seconds`);
  } else {
    requireFiniteNumber(pass.editor_seconds, `${label}.editor_seconds`);
  }
  const started = isoTimestamp(pass.started_at, `${label}.started_at`);
  const completed = isoTimestamp(pass.completed_at, `${label}.completed_at`);
  if (completed < started) fail(`${label}.completed_at precedes started_at`, 'TIMING_CHRONOLOGY_ERROR');
  requireString(pass.recording_source, `${label}.recording_source`);
  return pass;
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
  for (const [index, pass] of passes.entries()) {
    const validated = validateTimingPass(
      pass,
      expectedPasses,
      catalogIdSet,
      `${label}.passes[${index}]`,
      { audit: timingKind === 'post-freeze-audit' },
    );
    passById.set(validated.id, validated);
    if (timingKind === 'editorial') editorSeconds += validated.editor_seconds;
    else auditSeconds += validated.audit_seconds;
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
  if (checks.length === 0 || checks.some(({ status }) => status !== 'pass')) {
    fail(`${label}.checks must all be explicit passes`, 'VERIFICATION_GATE_ERROR');
  }
  return {
    editorial_review_complete: verification.editorial_review_complete,
    human_editorial_review_complete: verification.human_editorial_review_complete,
    canonical_integrity: verification.canonical_integrity,
    deterministic_sqlite: verification.deterministic_sqlite,
    search_product_regression: verification.search_product_regression,
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

function validateRelationEvidence(relationDiff, importedRecords, batchId) {
  validateRelationDiff(relationDiff);
  if (relationDiff.batch_id !== batchId) fail('relation diff batch_id drifted', 'RELATION_SOURCE_MISMATCH');
  const finalRelationTuples = new Set();
  for (const record of importedRecords) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) {
        finalRelationTuples.add(relationTupleKey(sense.id, relation));
      }
    }
  }
  for (const event of relationDiff.events) {
    if (event.operation === 'add' || event.operation === 'retype' || event.operation === 'retarget') {
      if (!finalRelationTuples.has(relationTupleKey(event.source_sense, event.after))) {
        fail(`relation diff event ${event.event_id} is absent from the reviewed canonical records`, 'RELATION_AFTER_NOT_CANONICAL');
      }
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
  const relationSummary = validateRelationEvidence(relationDiff, importedRecords, M5_11_BATCH_ID);
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

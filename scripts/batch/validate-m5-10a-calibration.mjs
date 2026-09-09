import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  REPOSITORY_DIRECTORY,
  M5_10A_SENSE_BOUNDARY_IDS,
} from './validate-batch.mjs';
import {
  CALIBRATION_TIMING_PASS_IDS,
  verifyCalibrationTimingRecording,
} from './timing.mjs';
import {
  M5_10A_CALIBRATION_CASE_COUNT,
  M5_10A_RELATION_GENERATION_REVISION,
  classifyRelationRequest,
  generateRelationCandidates,
} from './relation-generation.mjs';
import {
  hashCanonicalDirectory,
  validateExpansionPlan,
} from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const FIXTURE_SCHEMA = require('../../schema/m5-10a-relation-calibration-fixture.schema.json');
const ARTIFACT_SCHEMA = require('../../schema/m5-10a-relation-calibration.schema.json');
const TIMING_SCHEMA = require('../../schema/m5-10a-relation-calibration-timing.schema.json');
const AUDIT_SCHEMA = require('../../schema/m5-10a-relation-calibration-audit.schema.json');
const schemaOptions = {
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
};
const fixtureSchemaValidator = new Ajv2020(schemaOptions).compile(FIXTURE_SCHEMA);
const artifactSchemaValidator = new Ajv2020(schemaOptions).compile(ARTIFACT_SCHEMA);
const timingSchemaValidator = new Ajv2020(schemaOptions).compile(TIMING_SCHEMA);
const auditSchemaValidator = new Ajv2020(schemaOptions).compile(AUDIT_SCHEMA);

export const DEFAULT_CALIBRATION_FIXTURE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../tests/fixtures/m5-10a-relation-generation-calibration.json',
);
export const DEFAULT_CALIBRATION_ARTIFACT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-relation-calibration.json',
);
export const DEFAULT_CALIBRATION_TIMING_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-relation-calibration-timing.json',
);
export const DEFAULT_CALIBRATION_AUDIT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-relation-calibration-audit.json',
);
export const DEFAULT_CALIBRATION_PLAN_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-8-expansion-plan.json',
);

const EXPECTED_CANONICAL_SNAPSHOT = Object.freeze({
  record_count: 620,
  start_count: 578,
  reference_only_count: 42,
  sense_count: 743,
  relation_count: 467,
  expression_count: 39,
});

const EXPECTED_CALIBRATION_CASE_IDS = Object.freeze(
  Array.from({ length: M5_10A_CALIBRATION_CASE_COUNT }, (_, index) => (
    `m5-10a-cal-${String(index + 1).padStart(3, '0')}`
  )),
);

// Wave A and the first calibration draft used these sense ranges/cases. A
// replacement calibration must not silently recycle either set.
const LEGACY_WAVE_A_RECORD_MIN = 529;
const LEGACY_CALIBRATION_SOURCE_SENSES = new Set([
  'w529-s1', 'w530-s1', 'w531-s1', 'w532-s1', 'w534-s1',
  'w301-s1', 'w302-s1', 'w303-s1', 'w304-s1', 'w305-s1',
  'w306-s1', 'w307-s1', 'w308-s1', 'w309-s1',
]);

export class M5A10ACalibrationValidationError extends Error {
  constructor(message, code = 'M5A10A_CALIBRATION_VALIDATION_ERROR') {
    super(message);
    this.name = 'M5A10ACalibrationValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5A10A_CALIBRATION_VALIDATION_ERROR') {
  throw new M5A10ACalibrationValidationError(message, code);
}

function assertCondition(condition, message, code = 'M5A10A_CALIBRATION_VALIDATION_ERROR') {
  if (!condition) fail(message, code);
}

function assertEqual(actual, expected, message, code = 'CALIBRATION_SOURCE_BINDING_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function schemaErrorPath(error, root) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') pathParts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') pathParts.push(error.params.additionalProperty);
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    root,
  );
}

function validateSchema(value, validator, root, label) {
  if (validator(value)) return;
  const error = validator.errors?.[0];
  fail(
    error
      ? `${label} schema validation failed at ${schemaErrorPath(error, root)} ${error.message}`
      : `${label} schema validation failed`,
    'CALIBRATION_SCHEMA_ERROR',
  );
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_CALIBRATION_SOURCE');
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_CALIBRATION_JSON');
    throw error;
  }
}

function resolveRepositoryPath(sourcePath, label) {
  assertCondition(
    typeof sourcePath === 'string' && sourcePath.trim().length > 0,
    `${label} must be a non-empty path`,
    'CALIBRATION_SOURCE_PATH_MISMATCH',
  );
  const resolved = path.resolve(REPOSITORY_DIRECTORY, sourcePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  assertCondition(
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
    `${label} must remain inside the repository`,
    'CALIBRATION_SOURCE_PATH_MISMATCH',
  );
  return resolved;
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
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

function senseIndex(canonicalRecords) {
  const result = new Map();
  for (const { record } of canonicalRecords) {
    for (const sense of record.senses) result.set(sense.id, { record, sense });
  }
  return result;
}

function recordNumber(id) {
  const match = /^w(\d+)-s\d+$/u.exec(id);
  return match ? Number(match[1]) : undefined;
}

function relationTuple(sourceSense, relation) {
  return `${sourceSense}\u0000${relation.target_sense}\u0000${relation.type}`;
}

function canonicalRelationTuples(canonicalRecords) {
  const tuples = new Set();
  for (const { record } of canonicalRecords) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) tuples.add(relationTuple(sense.id, relation));
    }
  }
  return tuples;
}

function normalizeEvidence(text, caseRecord, boundaryId) {
  return text
    .normalize('NFC')
    .replaceAll(caseRecord.case_id, '{case}')
    .replaceAll(caseRecord.source_sense, '{source}')
    .replaceAll(boundaryId, '{boundary}')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function validateCalibrationFixtureEvidence(fixture, canonicalRecords) {
  assertEqual(
    fixture.process_revision,
    M5_10A_RELATION_GENERATION_REVISION,
    'calibration fixture process revision drifted',
    'CALIBRATION_PROCESS_REVISION_MISMATCH',
  );
  assertEqual(
    fixture.cases.map(({ case_id: caseId }) => caseId),
    EXPECTED_CALIBRATION_CASE_IDS,
    'calibration case coverage drifted',
    'CALIBRATION_CASE_COVERAGE',
  );

  const bySense = senseIndex(canonicalRecords);
  const seenSources = new Set();
  const rationaleByBoundary = new Map();
  const sourceNoteByBoundary = new Map();
  const boundaryStatusCounts = Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((id) => [id, 0]));

  for (const caseRecord of fixture.cases) {
    const source = bySense.get(caseRecord.source_sense);
    assertCondition(source, `${caseRecord.case_id} source sense is missing from canonical data`, 'CALIBRATION_SOURCE_SENSE_MISSING');
    assertCondition(!seenSources.has(caseRecord.source_sense), `${caseRecord.case_id} reuses a source sense`, 'CALIBRATION_CASE_COVERAGE');
    seenSources.add(caseRecord.source_sense);

    const sourceNumber = recordNumber(caseRecord.source_sense);
    assertCondition(sourceNumber !== undefined && sourceNumber < LEGACY_WAVE_A_RECORD_MIN, `${caseRecord.case_id} recycles a Wave A source sense`, 'CALIBRATION_NONCANONICAL_SCOPE');
    assertCondition(!LEGACY_CALIBRATION_SOURCE_SENSES.has(caseRecord.source_sense), `${caseRecord.case_id} recycles an earlier calibration source`, 'CALIBRATION_NONCANONICAL_SCOPE');
    const observedUsesInCase = new Set();

    for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
      const evidence = caseRecord.preflight.boundary_checks[boundaryId];
      assertCondition(
        typeof evidence.observed_use === 'string' && evidence.observed_use.trim().length > 0
          && evidence.observed_use.trim().length >= 8,
        `${caseRecord.case_id}.${boundaryId} observed use is not record-specific`,
        'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH',
      );
      assertCondition(
        evidence.rationale.includes(caseRecord.case_id)
          && evidence.rationale.includes(boundaryId)
          && evidence.rationale.includes(caseRecord.source_sense)
          && evidence.rationale.includes(evidence.observed_use)
          && evidence.rationale.includes(source.sense.gloss),
        `${caseRecord.case_id}.${boundaryId} rationale is not an observed, record-specific note`,
        'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH',
      );
      assertCondition(
        evidence.source_note.includes(caseRecord.case_id)
          && evidence.source_note.includes(boundaryId)
          && evidence.source_note.includes(caseRecord.source_sense)
          && evidence.source_note.includes(evidence.observed_use)
          && evidence.source_note.includes(source.sense.gloss),
        `${caseRecord.case_id}.${boundaryId} source note is not an observed, record-specific note`,
        'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH',
      );

      const rationaleSignature = normalizeEvidence(evidence.rationale, caseRecord, boundaryId);
      const sourceNoteSignature = normalizeEvidence(evidence.source_note, caseRecord, boundaryId);
      const observedUseSignature = normalizeEvidence(evidence.observed_use, caseRecord, boundaryId);
      const observedUseKey = evidence.observed_use.normalize('NFC').replace(/\s+/gu, ' ').trim();
      assertCondition(!observedUsesInCase.has(observedUseKey), `${caseRecord.case_id} copies observed use across sense boundaries`, 'CALIBRATION_GENERIC_EVIDENCE');
      observedUsesInCase.add(observedUseKey);
      const priorRationale = rationaleByBoundary.get(boundaryId);
      const priorSourceNote = sourceNoteByBoundary.get(boundaryId);
      const priorObservedUse = sourceNoteByBoundary.get(`${boundaryId}:observed-use`);
      assertCondition(priorRationale !== rationaleSignature, `${caseRecord.case_id}.${boundaryId} reuses regular boilerplate rationale`, 'CALIBRATION_GENERIC_EVIDENCE');
      assertCondition(priorSourceNote !== sourceNoteSignature, `${caseRecord.case_id}.${boundaryId} reuses regular boilerplate source note`, 'CALIBRATION_GENERIC_EVIDENCE');
      assertCondition(priorObservedUse !== observedUseSignature, `${caseRecord.case_id}.${boundaryId} reuses regular boilerplate observed use`, 'CALIBRATION_GENERIC_EVIDENCE');
      rationaleByBoundary.set(boundaryId, rationaleSignature);
      sourceNoteByBoundary.set(boundaryId, sourceNoteSignature);
      sourceNoteByBoundary.set(`${boundaryId}:observed-use`, observedUseSignature);

      if (evidence.status === 'checked') {
        boundaryStatusCounts[boundaryId] += 1;
        assertEqual(evidence.sense_ids, [caseRecord.source_sense], `${caseRecord.case_id}.${boundaryId} evidence sense IDs drifted`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
        assertEqual(evidence.observed_glosses, [source.sense.gloss], `${caseRecord.case_id}.${boundaryId} observed gloss drifted`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
        assertCondition(evidence.source_note.includes('meaning/use observation'), `${caseRecord.case_id}.${boundaryId} checked source note lacks a meaning/use observation`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
      } else {
        assertEqual(evidence.sense_ids, [], `${caseRecord.case_id}.${boundaryId} non-applicable evidence cites a sense`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
        assertEqual(evidence.observed_glosses, [], `${caseRecord.case_id}.${boundaryId} non-applicable evidence cites an observed gloss`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
        assertCondition(/not-applicable|no .* distinction/iu.test(evidence.rationale), `${caseRecord.case_id}.${boundaryId} non-applicable rationale lacks a reason`, 'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH');
      }
    }
    assertCondition(
      M5_10A_SENSE_BOUNDARY_IDS.some((boundaryId) => caseRecord.preflight.boundary_checks[boundaryId].status === 'checked'),
      `${caseRecord.case_id} has no checked sense boundary`,
      'CALIBRATION_PREFLIGHT_INCOMPLETE',
    );
  }

  assertCondition(Object.values(boundaryStatusCounts).every((count) => count > 0), 'calibration does not cover every sense boundary with an observation', 'CALIBRATION_PREFLIGHT_COVERAGE');
  return {
    status: 'complete',
    case_count: fixture.cases.length,
    evidence_case_count: fixture.cases.filter(({ preflight }) => preflight.status === 'complete').length,
    unresolved_boundary_count: 0,
    duplicate_evidence_count: 0,
    checked_boundary_counts: boundaryStatusCounts,
  };
}

function validateGeneratedResults(artifact, fixture, canonicalRecords) {
  const generated = generateRelationCandidates(fixture, canonicalRecords);
  const bySense = senseIndex(canonicalRecords);
  const canonicalTuples = canonicalRelationTuples(canonicalRecords);
  const expectedCaseIds = fixture.cases.map(({ case_id: caseId }) => caseId).sort();
  const generatedCaseIds = generated.generated_candidates.map(({ case_id: caseId }) => caseId).sort();
  assertEqual(
    artifact.raw_proposals,
    generated.generated_candidates,
    'calibration raw proposal output drifted',
    'CALIBRATION_GENERATION_OUTPUT_MISMATCH',
  );
  assertEqual(
    artifact.generation_suppressions,
    generated.suppressed_candidates,
    'calibration generation suppression output drifted',
    'CALIBRATION_GENERATION_OUTPUT_MISMATCH',
  );
  assertEqual(
    artifact.not_generated_cases,
    generated.not_generated_cases,
    'calibration no-candidate output drifted',
    'CALIBRATION_GENERATION_OUTPUT_MISMATCH',
  );
  assertEqual(
    artifact.calibration.generation,
    {
      request_count: generated.request_count,
      raw_proposal_count: generated.raw_proposal_count,
      generation_suppressed_count: generated.generation_suppressed_count,
      not_generated_count: generated.not_generated_count,
      not_generated_case_ids: generated.not_generated_cases.map(({ case_id: caseId }) => caseId),
      pre_screen_noise_count: generated.pre_screen_noise_count,
      noise_rate_of_raw_proposals: generated.noise_rate_of_raw_proposals,
      suppressed_category_counts: generated.suppressed_category_counts,
    },
    'calibration generation metrics drifted',
    'CALIBRATION_GENERATION_METRIC_MISMATCH',
  );
  assertEqual(
    generated.raw_proposal_count + generated.generation_suppressed_count + generated.not_generated_count,
    M5_10A_CALIBRATION_CASE_COUNT,
    'calibration generator did not account for every source-only request',
    'CALIBRATION_CASE_COVERAGE',
  );
  const notGeneratedCaseIds = generated.not_generated_cases.map(({ case_id: caseId }) => caseId).sort();
  assertEqual(
    [...generatedCaseIds, ...notGeneratedCaseIds].sort(),
    expectedCaseIds,
    'calibration request case coverage drifted',
    'CALIBRATION_CASE_COVERAGE',
  );
  assertEqual(generated.not_generated_count, generated.not_generated_cases.length, 'calibration no-candidate count drifted', 'CALIBRATION_GENERATION_METRIC_MISMATCH');
  assertEqual(generated.raw_proposal_count, generated.generated_candidates.length, 'calibration raw proposal denominator drifted', 'CALIBRATION_GENERATION_METRIC_MISMATCH');
  assertEqual(generated.generation_suppressed_count, 0, 'source-only calibration must not pre-screen away requests', 'CALIBRATION_GENERATION_METRIC_MISMATCH');
  assertEqual(
    Object.keys(generated.suppressed_category_counts).sort(),
    [],
    'source-only calibration unexpectedly emitted suppression categories',
    'CALIBRATION_GENERATION_METRIC_MISMATCH',
  );
  assertEqual(generated.pre_screen_noise_count, 0, 'corrected generator emitted a known noisy candidate', 'CALIBRATION_NOISE_GATE_FAILURE');
  const seenTuples = new Set();
  for (const candidate of generated.generated_candidates) {
    const source = bySense.get(candidate.source_sense);
    const target = bySense.get(candidate.relation.target_sense);
    assertCondition(source && target, `${candidate.case_id} generated a missing sense`, 'CALIBRATION_GENERATION_OUTPUT_MISMATCH');
    assertEqual(target.record.id, candidate.relation.target, `${candidate.case_id} target record drifted`, 'CALIBRATION_GENERATION_OUTPUT_MISMATCH');
    assertEqual(candidate.direction, { from: candidate.source_sense, to: candidate.relation.target_sense }, `${candidate.case_id} direction drifted`, 'CALIBRATION_GENERATION_OUTPUT_MISMATCH');
    const sourceNumber = recordNumber(candidate.source_sense);
    const targetNumber = recordNumber(candidate.relation.target_sense);
    assertCondition(sourceNumber !== undefined && sourceNumber < LEGACY_WAVE_A_RECORD_MIN, `${candidate.case_id} generated a Wave A source`, 'CALIBRATION_NONCANONICAL_SCOPE');
    assertCondition(targetNumber === undefined || targetNumber < LEGACY_WAVE_A_RECORD_MIN, `${candidate.case_id} generated a Wave A target`, 'CALIBRATION_NONCANONICAL_SCOPE');
    const tuple = relationTuple(candidate.source_sense, candidate.relation);
    assertCondition(!canonicalTuples.has(tuple), `${candidate.case_id} generated a canonical relation tuple`, 'CALIBRATION_CANONICAL_RELATION_REUSE');
    assertCondition(!seenTuples.has(tuple), `${candidate.case_id} repeats a generated relation tuple`, 'CALIBRATION_CASE_COVERAGE');
    assertEqual(classifyRelationRequest(candidate, canonicalRecords), undefined, `${candidate.case_id} violates its generated relation-type contract`, 'CALIBRATION_GENERATION_OUTPUT_MISMATCH');
    seenTuples.add(tuple);
  }
  return generated;
}

async function validateTiming(calibration, timingSourcePath, timingSourceDigest) {
  const timingSource = await readJsonSource(timingSourcePath, 'M5-10A relation calibration timing recording');
  validateSchema(timingSource.value, timingSchemaValidator, 'timing-source', 'M5-10A relation calibration timing');
  assertEqual(timingSource.sha256, timingSourceDigest, 'calibration timing source digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  let recorderSummary;
  try {
    recorderSummary = verifyCalibrationTimingRecording(timingSource.value);
  } catch (error) {
    fail(error.message, error.code ?? 'CALIBRATION_TIMING_GATE_FAILURE');
  }
  assertEqual(recorderSummary.pass_count, CALIBRATION_TIMING_PASS_IDS.length, 'calibration timing pass coverage drifted', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertEqual(
    calibration.timing,
    {
      status: recorderSummary.status,
      timing_source: 'data/batches/m5-10a-relation-calibration-timing.json',
      timing_source_sha256: timingSourceDigest,
      processed_start_count: recorderSummary.processed_start_count,
      editor_seconds: recorderSummary.editor_seconds,
      editor_seconds_per_processed_start: recorderSummary.editor_seconds_per_processed_start,
      unmeasured_pass_count: recorderSummary.unmeasured_pass_count,
      machine_validation_excluded_from_editor_seconds: true,
      final_audit_pass_session_id: recorderSummary.final_audit_pass_session_id,
      final_audit_case_count: recorderSummary.final_audit_work_evidence.case_count,
      final_audit_case_ids: recorderSummary.final_audit_work_evidence.case_ids,
      final_audit_raw_proposal_sha256: recorderSummary.final_audit_work_evidence.raw_proposal_sha256,
    },
    'calibration timing summary drifted from timing-recorder session evidence',
    'CALIBRATION_TIMING_GATE_FAILURE',
  );
  assertEqual(recorderSummary.processed_start_count, M5_10A_CALIBRATION_CASE_COUNT, 'calibration timing denominator drifted', 'CALIBRATION_TIMING_GATE_FAILURE');
  return {
    ...recorderSummary,
    final_audit_pass_session_id: recorderSummary.final_audit_pass_session_id,
    final_audit_case_count: recorderSummary.final_audit_work_evidence.case_count,
    final_audit_case_ids: recorderSummary.final_audit_work_evidence.case_ids,
    final_audit_raw_proposal_sha256: recorderSummary.final_audit_work_evidence.raw_proposal_sha256,
  };
}

function isUuidV4(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function rawProposalDigest(artifact) {
  return sha256Bytes(JSON.stringify(artifact.raw_proposals));
}

export function deriveCalibrationAuditMetrics(caseReviews, rawProposalCount) {
  assertCondition(Array.isArray(caseReviews), 'calibration audit case reviews are missing', 'CALIBRATION_AUDIT_GATE_FAILURE');
  const rawReviews = caseReviews.filter(({ outcome }) => outcome === 'raw-proposal');
  assertEqual(rawReviews.length, rawProposalCount, 'calibration audit raw-proposal denominator drifted', 'CALIBRATION_AUDIT_GATE_FAILURE');
  let admittedCount = 0;
  let rejectedCount = 0;
  let correctionCount = 0;
  let confirmedNoiseCount = 0;
  for (const review of rawReviews) {
    if (review.decision === 'admit') {
      admittedCount += 1;
    } else if (review.decision === 'reject') {
      rejectedCount += 1;
    } else if (review.decision === 'correct') {
      admittedCount += 1;
    } else {
      fail(`${review.case_id ?? 'unknown case'} has an invalid audit decision`, 'CALIBRATION_AUDIT_GATE_FAILURE');
    }
    if (review.correction === 'corrected') correctionCount += 1;
    if (review.noise_assessment === 'noise') confirmedNoiseCount += 1;
  }
  return {
    reviewed_raw_proposal_count: rawProposalCount,
    human_admitted_count: admittedCount,
    human_rejected_count: rejectedCount,
    correction_count: correctionCount,
    correction_rate: rawProposalCount === 0 ? 0 : correctionCount / rawProposalCount,
    confirmed_noise_count: confirmedNoiseCount,
    noise_rate_of_raw_proposals: rawProposalCount === 0 ? 0 : confirmedNoiseCount / rawProposalCount,
  };
}

export function validateCalibrationAuditInput({
  audit,
  auditSourceSha256,
  fixture,
  generated,
  timing,
  expectedRawProposalSha256,
} = {}) {
  validateSchema(audit, auditSchemaValidator, 'audit-input', 'M5-10A relation calibration audit');
  assertEqual(audit.process_revision, M5_10A_RELATION_GENERATION_REVISION, 'calibration audit process revision drifted', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.generator_id, M5_10A_RELATION_GENERATION_REVISION, 'calibration audit generator provenance drifted', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.initial_review_id, 'm5-10a-initial-review', 'calibration audit initial review provenance drifted', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.independent, true, 'calibration audit is not independent', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(audit.generator_id !== audit.auditor_id, 'calibration auditor must differ from the generator identity', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(audit.initial_review_id !== audit.auditor_id, 'calibration auditor must differ from the initial review identity', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(typeof audit.auditor_id === 'string' && audit.auditor_id.trim().length > 0, 'calibration audit auditor identity is missing', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(Number.isFinite(Date.parse(audit.audited_at)), 'calibration audit timestamp is invalid', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(isUuidV4(audit.audit_session_id), 'calibration audit session must be a UUIDv4', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertEqual(audit.audit_session_id, timing.final_audit_pass_session_id, 'calibration audit session is not the timed final-audit session', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertEqual(audit.overall_timing_session_id, timing.session_id, 'calibration audit is not bound to the timing recording', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(audit.audit_session_id !== audit.overall_timing_session_id, 'calibration audit session must be separate from the overall timing session', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertEqual(audit.raw_proposal_sha256, expectedRawProposalSha256, 'calibration audit raw-proposal digest drifted', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertCondition(typeof auditSourceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(auditSourceSha256), 'calibration audit source digest is missing', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  const findingIds = audit.findings.map(({ id }) => id);
  assertEqual(new Set(findingIds).size, findingIds.length, 'calibration audit findings repeat', 'CALIBRATION_AUDIT_GATE_FAILURE');
  const openBlockerCount = audit.findings.filter(({ status }) => status === 'open').length;
  assertEqual(audit.open_blocker_count, openBlockerCount, 'calibration audit blocker count drifted from findings', 'CALIBRATION_AUDIT_GATE_FAILURE');
  const finalAuditEvidence = timing.final_audit_case_ids
    ? {
      case_ids: timing.final_audit_case_ids,
      case_count: timing.final_audit_case_count,
      raw_proposal_sha256: timing.final_audit_raw_proposal_sha256,
    }
    : timing.final_audit_work_evidence;
  assertEqual(finalAuditEvidence?.case_ids, fixture.cases.map(({ case_id: caseId }) => caseId), 'final-audit timing case coverage drifted', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertEqual(finalAuditEvidence?.case_count, fixture.cases.length, 'final-audit timing case count drifted', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');
  assertEqual(finalAuditEvidence?.raw_proposal_sha256, expectedRawProposalSha256, 'final-audit timing raw-proposal digest drifted', 'CALIBRATION_AUDIT_PROVENANCE_FAILURE');

  const expectedCaseIds = fixture.cases.map(({ case_id: caseId }) => caseId);
  assertEqual(audit.case_reviews.map(({ case_id: caseId }) => caseId), expectedCaseIds, 'calibration audit case coverage drifted', 'CALIBRATION_AUDIT_GATE_FAILURE');
  const generatedById = new Map(generated.generated_candidates.map((candidate) => [candidate.case_id, candidate]));
  const notGeneratedById = new Map(generated.not_generated_cases.map((item) => [item.case_id, item]));
  const caseReviews = [];

  for (const review of audit.case_reviews) {
    assertCondition(review.evidence.includes(review.case_id), `${review.case_id} audit evidence is not record-specific`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertCondition(review.evidence.includes(review.source_sense), `${review.case_id} audit evidence does not identify the source sense`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    const candidate = generatedById.get(review.case_id);
    if (candidate) {
      assertEqual(review.source_sense, candidate.source_sense, `${review.case_id} audit source sense drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      assertEqual(review.target_sense, candidate.relation.target_sense, `${review.case_id} audit target sense drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      assertEqual(review.relation_type, candidate.relation.type, `${review.case_id} audit relation type drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      assertEqual(review.direction, candidate.direction, `${review.case_id} audit direction drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      assertEqual(review.outcome, 'raw-proposal', `${review.case_id} audit outcome drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      assertCondition(review.evidence.includes(review.target_sense), `${review.case_id} audit evidence does not identify the target sense`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      if (review.decision === 'admit') {
        assertEqual(review.noise_assessment, 'clean', `${review.case_id} admitted proposal must be marked clean`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
        assertEqual(review.correction, 'none', `${review.case_id} admitted proposal cannot claim a correction`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      } else if (review.decision === 'reject') {
        assertEqual(review.noise_assessment, 'noise', `${review.case_id} rejected proposal must be marked noise`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
        assertEqual(review.correction, 'none', `${review.case_id} rejected proposal cannot claim a correction`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      } else {
        assertEqual(review.decision, 'correct', `${review.case_id} has an invalid audit decision`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
        assertEqual(review.correction, 'corrected', `${review.case_id} corrected proposal must record correction`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
      }
      caseReviews.push({
        case_id: review.case_id,
        source_sense: candidate.source_sense,
        target_sense: candidate.relation.target_sense,
        relation_type: candidate.relation.type,
        direction: candidate.direction,
        outcome: 'raw-proposal',
        decision: review.decision,
        admission: review.decision === 'reject' ? 'rejected' : 'admitted',
        noise_assessment: review.noise_assessment,
        correction: review.correction,
        note: review.evidence,
      });
      continue;
    }

    const notGenerated = notGeneratedById.get(review.case_id);
    assertCondition(notGenerated, `${review.case_id} is missing from generator no-candidate output`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertEqual(review.source_sense, notGenerated.source_sense, `${review.case_id} no-candidate source sense drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertEqual(review.outcome, 'no-valid-candidate', `${review.case_id} no-candidate outcome drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertEqual(review.decision, 'not-applicable', `${review.case_id} no-candidate decision drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertEqual(review.noise_assessment, 'not-applicable', `${review.case_id} no-candidate noise assessment drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertEqual(review.correction, 'none', `${review.case_id} no-candidate correction drifted`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    assertCondition(!Object.hasOwn(review, 'target_sense') && !Object.hasOwn(review, 'relation_type') && !Object.hasOwn(review, 'direction'), `${review.case_id} no-candidate audit contains proposal fields`, 'CALIBRATION_AUDIT_EVIDENCE_MISMATCH');
    caseReviews.push({
      case_id: review.case_id,
      source_sense: review.source_sense,
      outcome: 'no-valid-candidate',
      decision: 'not-applicable',
      admission: 'not-applicable',
      noise_assessment: 'not-applicable',
      correction: 'none',
      note: review.evidence,
    });
  }

  const derivedMetrics = deriveCalibrationAuditMetrics(caseReviews, generated.raw_proposal_count);
  return {
    status: 'complete',
    independent: audit.independent,
    generator_id: audit.generator_id,
    initial_review_id: audit.initial_review_id,
    reviewed_case_count: fixture.cases.length,
    ...derivedMetrics,
    open_blocker_count: openBlockerCount,
    auditor_id: audit.auditor_id,
    audited_at: audit.audited_at,
    audit_session_id: audit.audit_session_id,
    audit_input_sha256: auditSourceSha256,
    raw_proposal_sha256: audit.raw_proposal_sha256,
    case_reviews: caseReviews,
    findings: audit.findings,
  };
}

function validateAudit(audit, auditInput, auditSourceSha256, fixture, generated, artifact, timing) {
  const expected = validateCalibrationAuditInput({
    audit: auditInput,
    auditSourceSha256,
    fixture,
    generated,
    timing,
    expectedRawProposalSha256: rawProposalDigest(artifact),
  });
  assertEqual(audit, expected, 'calibration audit result drifted from independent audit input', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.open_blocker_count, 0, 'calibration audit has an open blocker', 'CALIBRATION_AUDIT_GATE_FAILURE');
  return expected;
}

export function evaluateCalibrationGate({ generated, timing, audit, limits } = {}) {
  const failures = [];
  if (generated.pre_screen_noise_count !== 0) failures.push('generator pre-screened a request');
  if (generated.noise_rate_of_raw_proposals > limits.relation_noise_rate_max) failures.push('audited relation noise exceeds the fixed limit');
  if (timing.editor_seconds_per_processed_start > limits.editor_seconds_per_processed_start_max) failures.push('editor time exceeds the fixed limit');
  if (audit.correction_rate > limits.correction_rate_max) failures.push('audit correction rate exceeds the fixed limit');
  if (timing.unmeasured_pass_count > limits.unmeasured_timing_passes_max) failures.push('timing contains an unmeasured pass');
  if (audit.open_blocker_count > limits.open_audit_blockers_max) failures.push('audit contains an open blocker');
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
  };
}

function validateFixedGate(artifact, plan, preflight, generated, timing, audit) {
  const limits = {
    relation_noise_rate_max: plan.gate.relation_noise_rate_max,
    editor_seconds_per_processed_start_max: plan.gate.editor_seconds_per_selected_start_max,
    correction_rate_max: plan.gate.correction_rate_max,
    unmeasured_timing_passes_max: plan.gate.unmeasured_timing_passes_max,
    open_audit_blockers_max: plan.gate.open_audit_blockers_max,
  };
  assertEqual(artifact.calibration.fixed_gate, { status: 'passed', ...limits }, 'calibration fixed gate definition drifted', 'CALIBRATION_GATE_DEFINITION_MISMATCH');
  assertEqual(artifact.canonical_mutation, false, 'calibration must not mutate canonical data', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(preflight.case_count, M5_10A_CALIBRATION_CASE_COUNT, 'calibration preflight case count drifted', 'CALIBRATION_PREFLIGHT_GATE_FAILURE');
  assertEqual(preflight.evidence_case_count, M5_10A_CALIBRATION_CASE_COUNT, 'calibration preflight evidence coverage drifted', 'CALIBRATION_PREFLIGHT_GATE_FAILURE');
  assertEqual(preflight.unresolved_boundary_count, 0, 'calibration preflight has unresolved boundaries', 'CALIBRATION_PREFLIGHT_GATE_FAILURE');
  assertEqual(preflight.duplicate_evidence_count, 0, 'calibration preflight has duplicate evidence', 'CALIBRATION_GENERIC_EVIDENCE');
  assertEqual(audit.noise_rate_of_raw_proposals, audit.reviewed_raw_proposal_count === 0 ? 0 : audit.confirmed_noise_count / audit.reviewed_raw_proposal_count, 'calibration audit noise rate drifted', 'CALIBRATION_NOISE_GATE_FAILURE');
  assertEqual(generated.noise_rate_of_raw_proposals, 0, 'source-only generator must not pre-screen requests', 'CALIBRATION_NOISE_GATE_FAILURE');
  const gate = evaluateCalibrationGate({ generated: { ...generated, noise_rate_of_raw_proposals: audit.noise_rate_of_raw_proposals }, timing, audit, limits });
  assertEqual(gate.status, 'passed', `calibration fixed gate failed: ${gate.failures.join('; ')}`, 'CALIBRATION_GATE_FAILURE');
}

export async function validateM5A10ACalibration({
  artifactPath = DEFAULT_CALIBRATION_ARTIFACT_PATH,
} = {}) {
  const artifactSource = await readJsonSource(path.resolve(artifactPath), 'M5-10A relation calibration artifact');
  validateSchema(artifactSource.value, artifactSchemaValidator, 'calibration', 'M5-10A relation calibration');
  const artifact = artifactSource.value;
  assertEqual(artifact.process_revision, M5_10A_RELATION_GENERATION_REVISION, 'calibration process revision drifted', 'CALIBRATION_PROCESS_REVISION_MISMATCH');

  const fixturePath = resolveRepositoryPath(artifact.source.fixture, 'calibration.source.fixture');
  const canonicalDirectory = resolveRepositoryPath(artifact.source.canonical_directory, 'calibration.source.canonical_directory');
  const planPath = resolveRepositoryPath(artifact.source.expansion_plan, 'calibration.source.expansion_plan');
  const timingPath = resolveRepositoryPath(artifact.source.relation_calibration_timing, 'calibration.source.relation_calibration_timing');
  const auditPath = resolveRepositoryPath(artifact.source.relation_calibration_audit, 'calibration.source.relation_calibration_audit');
  assertEqual(fixturePath, DEFAULT_CALIBRATION_FIXTURE_PATH, 'calibration fixture path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(canonicalDirectory, path.resolve(REPOSITORY_DIRECTORY, 'data/canonical'), 'calibration canonical path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(planPath, DEFAULT_CALIBRATION_PLAN_PATH, 'calibration plan path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(timingPath, DEFAULT_CALIBRATION_TIMING_PATH, 'calibration timing path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(auditPath, DEFAULT_CALIBRATION_AUDIT_PATH, 'calibration audit path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');

  const [fixtureSource, planSource, auditSource] = await Promise.all([
    readJsonSource(fixturePath, 'M5-10A relation calibration fixture'),
    readJsonSource(planPath, 'M5-8 expansion plan'),
    readJsonSource(auditPath, 'M5-10A relation calibration audit'),
  ]);
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const canonicalDigest = await hashCanonicalDirectory(canonicalDirectory);
  assertEqual(fixtureSource.sha256, artifact.source.fixture_sha256, 'calibration fixture digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  assertEqual(canonicalDigest, artifact.source.canonical_directory_sha256, 'calibration canonical digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  assertEqual(planSource.sha256, artifact.source.expansion_plan_sha256, 'calibration expansion plan digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  assertEqual(auditSource.sha256, artifact.source.relation_calibration_audit_sha256, 'calibration audit source digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');

  validateSchema(fixtureSource.value, fixtureSchemaValidator, 'fixture', 'M5-10A relation calibration fixture');
  validateSchema(auditSource.value, auditSchemaValidator, 'audit-input', 'M5-10A relation calibration audit');
  validateExpansionPlan(planSource.value);
  const canonicalSnapshot = canonicalSummary(canonical.records);
  assertEqual(canonicalSnapshot, EXPECTED_CANONICAL_SNAPSHOT, 'calibration canonical snapshot changed', 'CALIBRATION_CANONICAL_SCOPE_CHANGED');
  assertEqual(artifact.canonical_snapshot, canonicalSnapshot, 'calibration artifact canonical snapshot drifted', 'CALIBRATION_CANONICAL_SCOPE_CHANGED');

  const preflight = validateCalibrationFixtureEvidence(fixtureSource.value, canonical.records);
  assertEqual(
    artifact.calibration.preflight,
    preflight,
    'calibration preflight result drifted from the source evidence',
    'CALIBRATION_PREFLIGHT_GATE_FAILURE',
  );
  const generated = validateGeneratedResults(artifact, fixtureSource.value, canonical.records);
  const timing = await validateTiming(
    artifact.calibration,
    timingPath,
    artifact.source.relation_calibration_timing_sha256,
  );
  const audit = validateAudit(artifact.calibration.audit, auditSource.value, auditSource.sha256, fixtureSource.value, generated, artifact, timing);
  validateFixedGate(artifact, planSource.value, preflight, generated, timing, audit);

  return {
    artifact_id: artifact.artifact_id,
    process_revision: artifact.process_revision,
    canonical_snapshot: canonicalSnapshot,
    case_count: fixtureSource.value.cases.length,
    request_count: generated.request_count,
    raw_proposal_count: generated.raw_proposal_count,
    generation_suppressed_count: generated.generation_suppressed_count,
    not_generated_count: generated.not_generated_count,
    not_generated_case_ids: generated.not_generated_cases.map(({ case_id: caseId }) => caseId),
    generated_candidate_count: generated.raw_proposal_count,
    suppressed_candidate_count: generated.generation_suppressed_count,
    pre_screen_noise_count: generated.pre_screen_noise_count,
    noise_rate_of_raw_proposals: generated.noise_rate_of_raw_proposals,
    audited_noise_count: audit.confirmed_noise_count,
    audited_noise_rate_of_raw_proposals: audit.noise_rate_of_raw_proposals,
    editor_seconds_per_processed_start: timing.editor_seconds_per_processed_start,
    unmeasured_pass_count: timing.unmeasured_pass_count,
    correction_rate: audit.correction_rate,
    preflight,
    audit,
    fixed_gate: artifact.calibration.fixed_gate,
    source_digests: {
      artifact: artifactSource.sha256,
      fixture: fixtureSource.sha256,
      canonical_directory: canonicalDigest,
      expansion_plan: planSource.sha256,
      relation_calibration_timing: artifact.source.relation_calibration_timing_sha256,
      relation_calibration_audit: artifact.source.relation_calibration_audit_sha256,
    },
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const result = await validateM5A10ACalibration({ artifactPath: args.artifact ?? DEFAULT_CALIBRATION_ARTIFACT_PATH });
  if (args.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Validated ${result.process_revision}: ${result.request_count} unlabelled request(s), ${result.raw_proposal_count} raw proposal(s), ${result.generation_suppressed_count} upstream suppression(s), and ${result.audited_noise_rate_of_raw_proposals * 100}% audited raw-proposal noise.`,
    );
  }
  return result;
}

const isMainModule =
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

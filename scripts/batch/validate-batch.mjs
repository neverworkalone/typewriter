import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { auditCanonicalLexicalQuality } from '../validate/lexical-quality.mjs';
import { validateLexicalAddition } from './lexical-admission.mjs';
import {
  productionSourceBytes,
  validateLexicalProductionState,
} from './lexical-production-state.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
  validateTargetInventory,
} from '../validate/target-inventory.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const require = createRequire(import.meta.url);
const BATCH_MANIFEST_SCHEMA = require('../../schema/batch-manifest.schema.json');

const manifestSchemaValidator = new Ajv2020({
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
}).compile(BATCH_MANIFEST_SCHEMA);

const ROLES = Object.freeze(['start', 'reference-only']);
const DECISIONS = Object.freeze(['included', 'held', 'rejected', 'corrected']);
const PROPOSAL_DECISIONS = Object.freeze(['included', 'corrected']);
const MEASUREMENT_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);
const OPTIONAL_MEASUREMENT_PASS_IDS = Object.freeze([
  'post-review-audit',
  'post-review-fixes',
]);
const STRICT_TIMING_CONTRACT_VERSIONS = Object.freeze([
  'm5-9a-v1',
  'm5-10a-v1',
  'm5-10b-v3',
]);

export const M5_10A_PROCESS_REVISION = 'm5-10a-process-correction-v1';
export const M5_10A_SENSE_BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
const PREFLIGHT_BOUNDARY_STATUSES = Object.freeze(['checked', 'not-applicable', 'not-reviewed']);

export class BatchValidationError extends Error {
  constructor(message, code = 'BATCH_VALIDATION_ERROR') {
    super(message);
    this.name = 'BatchValidationError';
    this.code = code;
  }
}

function fail(message, code = 'BATCH_VALIDATION_ERROR') {
  throw new BatchValidationError(message, code);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }

  if (value !== value.trim()) {
    fail(`${label} must not have leading or trailing whitespace`, 'UNTRIMMED_VALUE');
  }

  if (value.normalize('NFC') !== value) {
    fail(`${label} must be NFC-normalized`, 'NON_NFC_VALUE');
  }
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`${label} must not contain duplicates`, 'DUPLICATE_VALUE');
  }
}

function requireIsoDate(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, 'INVALID_TIMESTAMP');
  }
  if (!Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a valid timestamp`, 'INVALID_TIMESTAMP');
  }
}

export function timingPassCycle(pass) {
  return pass.cycle ?? 1;
}

export function timingPassKey(pass) {
  return Object.hasOwn(pass, 'cycle') ? `${pass.id}#${pass.cycle}` : pass.id;
}

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertExternalStagingPath(stagedRecordsPath, allowRepositoryStaging = false) {
  if (isInside(REPOSITORY_DIRECTORY, stagedRecordsPath) && !allowRepositoryStaging) {
    fail(
      `staged canonical input must remain outside the repository: ${stagedRecordsPath}`,
      'STAGED_INPUT_INSIDE_REPOSITORY',
    );
  }
}

function assertCanonicalImportOutputPath(outputPath, canonicalDirectory) {
  if (isInside(REPOSITORY_DIRECTORY, outputPath)) {
    fail(
      `import artifact must remain outside the repository: ${outputPath}`,
      'IMPORT_OUTPUT_INSIDE_REPOSITORY',
    );
  }

  if (isInside(canonicalDirectory, outputPath)) {
    fail(
      `import artifact must remain outside canonical input: ${outputPath}`,
      'IMPORT_OUTPUT_INSIDE_CANONICAL',
    );
  }
}

function validateManifestRecord(record, index) {
  const prefix = `manifest.records[${index}]`;
  requireString(record.decision_note, `${prefix}.decision_note`);

  if (Object.hasOwn(record, 'inventory_id')) {
    requireString(record.inventory_id, `${prefix}.inventory_id`);
  }
  if (Object.hasOwn(record, 'canonical_id')) {
    requireString(record.canonical_id, `${prefix}.canonical_id`);
  }
  if (Object.hasOwn(record, 'proposal_canonical_id')) {
    requireString(record.proposal_canonical_id, `${prefix}.proposal_canonical_id`);
    if (!/^w[0-9]{3,}$/u.test(record.proposal_canonical_id)) {
      fail(`${prefix}.proposal_canonical_id must be a start canonical ID`, 'INVALID_PROPOSAL_ID');
    }
  }
  if (Object.hasOwn(record, 'proposal_decision')) {
    if (!PROPOSAL_DECISIONS.includes(record.proposal_decision)) {
      fail(
        `${prefix}.proposal_decision must be one of ${PROPOSAL_DECISIONS.join(', ')}`,
        'INVALID_PROPOSAL_DECISION',
      );
    }
  }
  if (Object.hasOwn(record, 'proposal_corrected_fields')) {
    requireUnique(record.proposal_corrected_fields, `${prefix}.proposal_corrected_fields`);
    record.proposal_corrected_fields.forEach((field, fieldIndex) => {
      requireString(field, `${prefix}.proposal_corrected_fields[${fieldIndex}]`);
    });
  }
  if (Object.hasOwn(record, 'corrected_fields')) {
    requireUnique(record.corrected_fields, `${prefix}.corrected_fields`);
    record.corrected_fields.forEach((field, fieldIndex) => {
      requireString(field, `${prefix}.corrected_fields[${fieldIndex}]`);
    });
  }
  if (Object.hasOwn(record, 'related_to')) {
    requireUnique(record.related_to, `${prefix}.related_to`);
    record.related_to.forEach((relatedId, relatedIndex) => {
      requireString(relatedId, `${prefix}.related_to[${relatedIndex}]`);
    });
  }

  if (record.decision === 'proposed') {
    if (!Object.hasOwn(record, 'proposal_canonical_id') || !Object.hasOwn(record, 'proposal_decision')) {
      fail(`${prefix} proposed record must carry proposal identity and decision`, 'INVALID_PROPOSAL_RECORD');
    }
    if (Object.hasOwn(record, 'canonical_id') || Object.hasOwn(record, 'corrected_fields')) {
      fail(`${prefix} proposed record must not carry importable canonical fields`, 'INVALID_PROPOSAL_RECORD');
    }
    if (record.proposal_decision === 'corrected'
      && (!Object.hasOwn(record, 'proposal_corrected_fields') || record.proposal_corrected_fields.length === 0)) {
      fail(`${prefix} corrected proposal must identify its proposed corrections`, 'INVALID_PROPOSAL_RECORD');
    }
    if (record.proposal_decision === 'included' && Object.hasOwn(record, 'proposal_corrected_fields')) {
      fail(`${prefix} included proposal must not carry proposal_corrected_fields`, 'INVALID_PROPOSAL_RECORD');
    }
  } else if (Object.hasOwn(record, 'proposal_canonical_id')
    || Object.hasOwn(record, 'proposal_decision')
    || Object.hasOwn(record, 'proposal_corrected_fields')) {
    fail(`${prefix} proposal fields are only valid for a proposed record`, 'INVALID_PROPOSAL_RECORD');
  }
}

function schemaErrorPath(error) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') {
    pathParts.push(error.params.missingProperty);
  }
  if (error.keyword === 'additionalProperties') {
    pathParts.push(error.params.additionalProperty);
  }
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    'manifest',
  );
}

function schemaErrorCode(error) {
  if (error.keyword === 'additionalProperties') {
    return 'UNKNOWN_FIELD';
  }
  if (error.keyword === 'required') {
    return 'MISSING_FIELD';
  }
  if (error.keyword === 'format') {
    return 'INVALID_TIMESTAMP';
  }
  if (error.keyword === 'enum' || error.keyword === 'const') {
    return 'INVALID_ENUM';
  }
  return 'SCHEMA_ERROR';
}

function validateManifestSchema(manifest) {
  if (manifestSchemaValidator(manifest)) {
    return;
  }

  const error = manifestSchemaValidator.errors?.[0];
  const detail = error
    ? `${schemaErrorPath(error)} ${error.message}`
    : 'manifest does not match the batch manifest schema';
  fail(`batch manifest schema validation failed: ${detail}`, error ? schemaErrorCode(error) : 'SCHEMA_ERROR');
}

function validateTimingDuration(pass, label, strict, measurementKind) {
  const hasWallClock = Object.hasOwn(pass, 'wall_clock_seconds');
  const hasEditorSeconds = Object.hasOwn(pass, 'editor_seconds');
  const hasProducerSeconds = Object.hasOwn(pass, 'producer_seconds');
  const hasStartedAt = Object.hasOwn(pass, 'started_at');
  const hasCompletedAt = Object.hasOwn(pass, 'completed_at');
  const hasSessionId = Object.hasOwn(pass, 'session_id');
  const hasRecordingSource = Object.hasOwn(pass, 'recording_source');

  if (pass.status === 'unmeasured') {
    if (hasStartedAt || hasCompletedAt || hasWallClock || hasEditorSeconds || hasProducerSeconds
      || hasSessionId || hasRecordingSource) {
      fail(
        `${label} is unmeasured but contains a timing measurement; do not estimate or backfill it`,
        'UNMEASURED_TIMING_VALUE',
      );
    }
    return;
  }

  if (strict && OPTIONAL_MEASUREMENT_PASS_IDS.includes(pass.id)
    && (!hasSessionId || !hasRecordingSource)) {
    fail(
      `${label} follow-up measurement must be recorded by the timing recorder`,
      'TIMING_PROVENANCE_REQUIRED',
    );
  }

  if (pass.status === 'in-progress') {
    if (!hasSessionId || !hasRecordingSource) {
      fail(
        `${label} must be recorded by the timing recorder and carry a session ID`,
        'TIMING_PROVENANCE_REQUIRED',
      );
    }
    if (!hasStartedAt) {
      fail(`${label} in-progress session must record started_at`, 'MISSING_TIMING_TIMESTAMP');
    }
    if (hasCompletedAt || hasWallClock || hasEditorSeconds || hasProducerSeconds) {
      fail(
        `${label} in-progress session cannot contain stop or duration values`,
        'IN_PROGRESS_TIMING_VALUE',
      );
    }
    return;
  }

  if (!hasStartedAt || !hasCompletedAt) {
    fail(
      `${label} must record started_at and completed_at for a measured pass`,
      'MISSING_TIMING_TIMESTAMP',
    );
  }
  if (!hasWallClock) {
    fail(`${label} must record wall_clock_seconds for a measured pass`, 'INCOMPLETE_TIMING');
  }
  const elapsedSeconds = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || Math.abs(pass.wall_clock_seconds - elapsedSeconds) > 1e-6) {
    fail(
      `${label}.wall_clock_seconds must equal completed_at - started_at`,
      'TIMING_DURATION_DRIFT',
    );
  }
  if (measurementKind === 'producer-throughput') {
    if (hasEditorSeconds) {
      fail(`${label} producer-throughput measurement must not claim editor_seconds`, 'EDITOR_TIME_MISATTRIBUTED');
    }
    if (pass.status === 'complete' && !hasProducerSeconds) {
      fail(`${label} is complete but lacks producer_seconds`, 'INCOMPLETE_TIMING');
    }
    if (hasProducerSeconds && Math.abs(pass.producer_seconds - elapsedSeconds) > 1e-6) {
      fail(
        `${label}.producer_seconds must equal completed_at - started_at`,
        'TIMING_DURATION_DRIFT',
      );
    }
  } else if (pass.status === 'complete' && !hasEditorSeconds) {
    fail(`${label} is complete but lacks editor_seconds`, 'INCOMPLETE_TIMING');
  }
}

export function validateTimingMeasurement(
  measurement,
  {
    strict = STRICT_TIMING_CONTRACT_VERSIONS.includes(measurement?.timing?.contract_version),
  } = {},
) {
  if (!measurement) return;

  const measurementKind = measurement.timing.measurement_kind ?? 'editorial-time';
  if (!['editorial-time', 'producer-throughput'].includes(measurementKind)) {
    fail(`manifest.measurement.timing.measurement_kind is invalid: ${measurementKind}`, 'INVALID_TIMING_MEASUREMENT_KIND');
  }
  if (measurement.timing.contract_version === 'm5-10b-v3' && measurementKind !== 'producer-throughput') {
    fail('m5-10b-v3 timing must declare producer-throughput measurement_kind', 'TIMING_MEASUREMENT_KIND_MISMATCH');
  }
  if (measurementKind === 'producer-throughput' && measurement.timing.contract_version !== 'm5-10b-v3') {
    fail('producer-throughput timing must use contract m5-10b-v3', 'TIMING_MEASUREMENT_KIND_MISMATCH');
  }
  if (measurementKind === 'producer-throughput'
    && measurement.timing.producer_seconds_per_selected_start_max !== 1) {
    fail('producer-throughput timing must declare the fixed producer throughput limit', 'TIMING_MEASUREMENT_KIND_MISMATCH');
  }
  const passes = measurement.timing.passes;
  const requiredPassIds = passes
    .filter((pass) => MEASUREMENT_PASS_IDS.includes(pass.id))
    .map((pass) => pass.id);
  requireUnique(requiredPassIds, 'manifest.measurement.timing.passes.id');
  const missingPasses = MEASUREMENT_PASS_IDS.filter((id) => !requiredPassIds.includes(id));
  if (missingPasses.length > 0) {
    fail(
      `manifest.measurement.timing is missing pass(es): ${missingPasses.join(', ')}`,
      'MISSING_TIMING_PASS',
    );
  }
  const optionalPassesById = new Map(
    OPTIONAL_MEASUREMENT_PASS_IDS.map((id) => [id, []]),
  );
  const passKeys = new Set();
  for (const pass of passes) {
    const isOptional = OPTIONAL_MEASUREMENT_PASS_IDS.includes(pass.id);
    if (!isOptional && Object.hasOwn(pass, 'cycle')) {
      fail(
        `manifest.measurement.timing.${pass.id} cannot declare a feedback cycle`,
        'INVALID_TIMING_CYCLE',
      );
    }
    if (!isOptional && Object.hasOwn(pass, 'feedback_received_at')) {
      fail(
        `manifest.measurement.timing.${pass.id} cannot declare feedback_received_at`,
        'INVALID_TIMING_CYCLE',
      );
    }
    const key = timingPassKey(pass);
    if (passKeys.has(key)) {
      fail(`manifest.measurement.timing contains duplicate pass ${key}`, 'DUPLICATE_TIMING_PASS');
    }
    passKeys.add(key);
    if (isOptional) optionalPassesById.get(pass.id).push(pass);

    const label = `manifest.measurement.timing.${key}`;
    if (Object.hasOwn(pass, 'feedback_received_at')) requireIsoDate(pass.feedback_received_at, `${label}.feedback_received_at`);
    if (Object.hasOwn(pass, 'started_at')) requireIsoDate(pass.started_at, `${label}.started_at`);
    if (Object.hasOwn(pass, 'completed_at')) requireIsoDate(pass.completed_at, `${label}.completed_at`);
    if (Object.hasOwn(pass, 'note')) requireString(pass.note, `${label}.note`);
    const hasStartedAt = Object.hasOwn(pass, 'started_at');
    const hasCompletedAt = Object.hasOwn(pass, 'completed_at');
    if (pass.status === 'in-progress' && !hasStartedAt) {
      fail(`${label} in-progress pass must provide started_at`, 'INCOMPLETE_TIMING_TIMESTAMP');
    }
    if (pass.status === 'in-progress' && hasCompletedAt) {
      fail(`${label} in-progress pass cannot provide completed_at`, 'IN_PROGRESS_TIMING_VALUE');
    }
    if (pass.status !== 'in-progress' && hasStartedAt !== hasCompletedAt) {
      fail(`${label} must provide both started_at and completed_at when timestamps are recorded`, 'INCOMPLETE_TIMING_TIMESTAMP');
    }
    if (hasStartedAt && Date.parse(pass.completed_at) < Date.parse(pass.started_at)) {
      fail(`${label} completed_at must not precede started_at`, 'TIMING_ORDER');
    }
    if (Object.hasOwn(pass, 'feedback_received_at')
      && hasStartedAt
      && Date.parse(pass.started_at) < Date.parse(pass.feedback_received_at)) {
      fail(`${label} started_at must not precede feedback_received_at`, 'TIMING_BEFORE_FEEDBACK');
    }
    const completeDuration = measurementKind === 'producer-throughput'
      ? Number.isFinite(pass.wall_clock_seconds) && Number.isFinite(pass.producer_seconds)
      : Number.isFinite(pass.wall_clock_seconds) && Number.isFinite(pass.editor_seconds);
    if (pass.status === 'complete' && !completeDuration) {
      fail(
        `${label} is complete but lacks its required duration measurements`,
        'INCOMPLETE_TIMING',
      );
    }
    if (pass.status === 'partial' && !Number.isFinite(pass.wall_clock_seconds)) {
      fail(
        `${label} is partial but lacks wall-clock seconds`,
        'INCOMPLETE_TIMING',
      );
    }
    if (strict) validateTimingDuration(pass, label, strict, measurementKind);
  }
  const optionalCycles = new Set();
  for (const [id, group] of optionalPassesById) {
    if (group.length === 0) continue;
    if (strict && group.some((pass) => !Object.hasOwn(pass, 'cycle'))) {
      fail(
        `new timing contract requires a cycle number for every ${id} follow-up pass`,
        'TIMING_CYCLE_REQUIRED',
      );
    }
    if (group.length > 1 && group.some((pass) => !Object.hasOwn(pass, 'cycle'))) {
      fail(
        `repeated ${id} timing passes must declare cycle numbers`,
        'TIMING_CYCLE_REQUIRED',
      );
    }
    for (const pass of group) optionalCycles.add(timingPassCycle(pass));
  }
  if (optionalCycles.size > 0) {
    const maxCycle = Math.max(...optionalCycles);
    for (let cycle = 1; cycle <= maxCycle; cycle += 1) {
      if (!optionalCycles.has(cycle)) {
        fail(`timing is missing feedback cycle ${cycle}`, 'MISSING_TIMING_CYCLE');
      }
      for (const id of OPTIONAL_MEASUREMENT_PASS_IDS) {
        const group = optionalPassesById.get(id);
        if (!group.some((pass) => timingPassCycle(pass) === cycle)) {
          fail(`timing feedback cycle ${cycle} is missing ${id}`, 'INCOMPLETE_TIMING_CYCLE');
        }
      }
    }

    for (let cycle = 1; cycle <= maxCycle; cycle += 1) {
      const auditPass = optionalPassesById.get('post-review-audit')
        .find((pass) => timingPassCycle(pass) === cycle);
      const fixesPass = optionalPassesById.get('post-review-fixes')
        .find((pass) => timingPassCycle(pass) === cycle);
      const feedbackTimes = [auditPass, fixesPass]
        .filter((pass) => Object.hasOwn(pass, 'feedback_received_at'))
        .map((pass) => pass.feedback_received_at);
      if (strict && feedbackTimes.length !== 2) {
        fail(
          `timing feedback cycle ${cycle} must bind both follow-up passes to feedback_received_at`,
          'INCOMPLETE_TIMING_CYCLE',
        );
      }
      if (feedbackTimes.length === 1) {
        fail(`timing feedback cycle ${cycle} must bind both follow-up passes to feedback_received_at`, 'INCOMPLETE_TIMING_CYCLE');
      }
      if (feedbackTimes.length === 2 && feedbackTimes[0] !== feedbackTimes[1]) {
        fail(`timing feedback cycle ${cycle} has inconsistent feedback_received_at values`, 'TIMING_FEEDBACK_MISMATCH');
      }
      if (Object.hasOwn(auditPass, 'completed_at') && Object.hasOwn(fixesPass, 'started_at')
        && Date.parse(fixesPass.started_at) < Date.parse(auditPass.completed_at)) {
        fail(`timing feedback cycle ${cycle} fixes must follow the audit pass`, 'TIMING_ORDER');
      }
    }
  }
  if (measurement.timing.status === 'complete'
    && passes.some((pass) => pass.status !== 'complete')) {
    fail('manifest.measurement.timing is declared complete with an unmeasured pass', 'INCOMPLETE_TIMING');
  }

  const initialReview = passes.find((pass) => pass.id === 'initial-review');
  if (strict && initialReview?.completed_at) {
    for (const pass of passes) {
      if (!OPTIONAL_MEASUREMENT_PASS_IDS.includes(pass.id) || !pass.feedback_received_at) continue;
      if (Date.parse(pass.feedback_received_at) < Date.parse(initialReview.completed_at)) {
        fail(
          `${timingPassKey(pass)} feedback_received_at precedes initial-review completion`,
          'FEEDBACK_BEFORE_REVIEW',
        );
      }
    }
  }

  const findingIds = measurement.audit.findings.map((finding) => finding.id);
  requireUnique(findingIds, 'manifest.measurement.audit.findings.id');
  for (const finding of measurement.audit.findings) {
    requireString(finding.id, `manifest.measurement.audit.findings.${finding.id}.id`);
    requireString(finding.note, `manifest.measurement.audit.findings.${finding.id}.note`);
  }
}

function validateSenseReview(review, manifest) {
  if (!review) return;

  requireString(review.note, 'manifest.sense_review.note');
  requireUnique(review.split_canonical_ids, 'manifest.sense_review.split_canonical_ids');
  validateSensePreflight(review.preflight, manifest);
  if (review.status !== 'complete') return;

  const importableStarts = manifest.records.filter(
    (record) => record.source === 'inventory'
      && record.role === 'start'
      && (record.decision === 'included' || record.decision === 'corrected'),
  );
  const correctedSenseIds = importableStarts
    .filter((record) => record.corrected_fields?.includes('senses'))
    .map((record) => record.canonical_id)
    .sort();
  const declaredSplitIds = [...review.split_canonical_ids].sort();
  if (review.reviewed_start_count !== importableStarts.length) {
    fail(
      `manifest.sense_review.reviewed_start_count must equal importable starts (${importableStarts.length})`,
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
  }
  if (review.split_record_count !== declaredSplitIds.length) {
    fail(
      'manifest.sense_review.split_record_count must equal split_canonical_ids length',
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
  }
  if (review.scoped_single_sense_count + review.split_record_count !== review.reviewed_start_count) {
    fail(
      'manifest.sense_review counts must account for every reviewed start',
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
  }
  const correctedSenseIdSet = new Set(correctedSenseIds);
  if (declaredSplitIds.some((canonicalId) => !correctedSenseIdSet.has(canonicalId))) {
    fail(
      'manifest.sense_review.split_canonical_ids must be corrected sense records',
      'SENSE_REVIEW_CORRECTION_MISMATCH',
    );
  }

}

function assertJsonEqual(actual, expected, message, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function expectedPreflightStatus(decision) {
  if (decision === 'included' || decision === 'corrected') return 'complete';
  return decision;
}

export function validateSensePreflight(preflight, manifest) {
  if (!preflight) return;

  assertJsonEqual(
    preflight.process_revision,
    M5_10A_PROCESS_REVISION,
    'manifest.sense_review.preflight process revision drifted',
    'PREFLIGHT_PROCESS_REVISION_MISMATCH',
  );
  assertJsonEqual(
    preflight.boundary_ids,
    M5_10A_SENSE_BOUNDARY_IDS,
    'manifest.sense_review.preflight boundary IDs drifted',
    'PREFLIGHT_BOUNDARY_DEFINITION_MISMATCH',
  );

  const selectedStarts = manifest.records.filter(
    (record) => record.source === 'inventory' && record.role === 'start',
  );
  const selectedByInventoryId = new Map(
    selectedStarts.map((record) => [record.inventory_id, record]),
  );
  const checkpointIds = preflight.record_checkpoints.map(({ inventory_id: inventoryId }) => inventoryId);
  requireUnique(checkpointIds, 'manifest.sense_review.preflight.record_checkpoints.inventory_id');
  assertJsonEqual(
    checkpointIds.sort(),
    selectedStarts.map(({ inventory_id: inventoryId }) => inventoryId).sort(),
    'manifest.sense_review.preflight must cover every selected start exactly once',
    'PREFLIGHT_COVERAGE_MISMATCH',
  );

  const rationaleOwners = new Map();
  for (const [index, checkpoint] of preflight.record_checkpoints.entries()) {
    const label = `manifest.sense_review.preflight.record_checkpoints[${index}]`;
    const manifestRecord = selectedByInventoryId.get(checkpoint.inventory_id);
    if (!manifestRecord) {
      fail(`${label} references an unselected inventory target`, 'PREFLIGHT_COVERAGE_MISMATCH');
    }
    const expectedStatus = manifest.review.status === 'complete'
      ? expectedPreflightStatus(manifestRecord.decision)
      : 'not-reviewed';
    assertJsonEqual(
      checkpoint.status,
      expectedStatus,
      `${label}.status does not match the manifest review state and decision`,
      'PREFLIGHT_DECISION_MISMATCH',
    );
    if (checkpoint.status === 'complete') {
      assertJsonEqual(
        checkpoint.canonical_id,
        manifestRecord.canonical_id,
        `${label}.canonical_id does not match the manifest record`,
        'PREFLIGHT_CANONICAL_MISMATCH',
      );
      if (checkpoint.lemma_pos !== 'checked') {
        fail(`${label}.lemma_pos must be checked for a complete checkpoint`, 'PREFLIGHT_INCOMPLETE');
      }
      if (checkpoint.observed_sense_count < 1 || checkpoint.observed_pos.length < 1) {
        fail(`${label} complete checkpoint must record observed sense and POS values`, 'PREFLIGHT_INCOMPLETE');
      }
    } else if (Object.hasOwn(checkpoint, 'canonical_id')) {
      fail(`${label} non-importable checkpoint must not carry canonical_id`, 'PREFLIGHT_CANONICAL_MISMATCH');
    }

    let checkedBoundaryCount = 0;
    const missingBoundaryIds = M5_10A_SENSE_BOUNDARY_IDS.filter(
      (boundaryId) => checkpoint.boundary_checks[boundaryId].status === 'not-reviewed',
    );
    assertJsonEqual(
      [...checkpoint.missing_boundary_ids].sort(),
      [...missingBoundaryIds].sort(),
      `${label}.missing_boundary_ids does not describe the boundary checks`,
      'PREFLIGHT_BOUNDARY_MISMATCH',
    );
    for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
      const evidence = checkpoint.boundary_checks[boundaryId];
      if (!PREFLIGHT_BOUNDARY_STATUSES.includes(evidence.status)) {
        fail(`${label}.boundary_checks.${boundaryId} has an invalid status`, 'PREFLIGHT_BOUNDARY_MISMATCH');
      }
      requireString(
        evidence.rationale,
        `${label}.boundary_checks.${boundaryId}.rationale`,
      );
      if (!evidence.rationale.includes(checkpoint.inventory_id)) {
        fail(
          `${label}.boundary_checks.${boundaryId}.rationale must identify the inventory record`,
          'PREFLIGHT_EVIDENCE_MISMATCH',
        );
      }
      const evidenceOwner = rationaleOwners.get(evidence.rationale);
      if (evidenceOwner && evidenceOwner !== checkpoint.inventory_id) {
        fail(
          `${label}.boundary_checks.${boundaryId}.rationale is reused across records`,
          'PREFLIGHT_GENERIC_EVIDENCE',
        );
      }
      rationaleOwners.set(evidence.rationale, checkpoint.inventory_id);
      if (evidence.status === 'checked') {
        checkedBoundaryCount += 1;
        if (evidence.sense_ids.length < 1) {
          fail(
            `${label}.boundary_checks.${boundaryId} checked evidence must cite at least one sense`,
            'PREFLIGHT_EVIDENCE_MISMATCH',
          );
        }
        if (checkpoint.status === 'complete' && evidence.sense_ids.some(
          (senseId) => !senseId.startsWith(`${checkpoint.canonical_id}-s`),
        )) {
          fail(
            `${label}.boundary_checks.${boundaryId} cites a sense outside its canonical record`,
            'PREFLIGHT_EVIDENCE_MISMATCH',
          );
        }
        if (evidence.sense_ids.some((senseId) => !evidence.rationale.includes(senseId))) {
          fail(
            `${label}.boundary_checks.${boundaryId}.rationale must cite every checked sense`,
            'PREFLIGHT_EVIDENCE_MISMATCH',
          );
        }
      } else if (evidence.status === 'not-applicable') {
        if (evidence.sense_ids.length > 0) {
          fail(
            `${label}.boundary_checks.${boundaryId} not-applicable evidence must not cite senses`,
            'PREFLIGHT_EVIDENCE_MISMATCH',
          );
        }
      } else if (evidence.sense_ids.length > 0) {
        fail(
          `${label}.boundary_checks.${boundaryId} non-checked evidence must not cite senses`,
          'PREFLIGHT_EVIDENCE_MISMATCH',
        );
      }
    }
    if (checkpoint.status === 'complete' && checkedBoundaryCount === 0) {
      fail(`${label} must contain reviewed sense boundaries`, 'PREFLIGHT_INCOMPLETE');
    }
    if (checkpoint.status === 'complete' && missingBoundaryIds.length > 0) {
      fail(`${label} cannot be complete while a sense boundary is not reviewed`, 'PREFLIGHT_INCOMPLETE');
    }
  }
}

export function validateSensePreflightRecords(manifest, recordInfos) {
  const preflight = manifest.sense_review?.preflight;
  if (!preflight) return;

  const recordsById = new Map(
    recordInfos.map(({ record }) => [record.id, record]),
  );
  const manifestByCanonicalId = new Map(
    manifest.records
      .filter((record) => Object.hasOwn(record, 'canonical_id'))
      .map((record) => [record.canonical_id, record]),
  );
  const checkpointsByInventoryId = new Map(
    preflight.record_checkpoints.map((checkpoint) => [checkpoint.inventory_id, checkpoint]),
  );
  for (const checkpoint of preflight.record_checkpoints) {
    if (checkpoint.status !== 'complete') continue;
    const record = recordsById.get(checkpoint.canonical_id);
    if (!record) {
      fail(
        `preflight checkpoint ${checkpoint.inventory_id} canonical record is missing from staged records`,
        'PREFLIGHT_CANONICAL_MISMATCH',
      );
    }
    assertJsonEqual(
      checkpoint.observed_sense_count,
      record.senses.length,
      `preflight checkpoint ${checkpoint.inventory_id} sense count drifted`,
      'PREFLIGHT_CANONICAL_MISMATCH',
    );
    assertJsonEqual(
      checkpoint.observed_pos,
      record.senses.map(({ pos }) => pos),
      `preflight checkpoint ${checkpoint.inventory_id} POS values drifted`,
      'PREFLIGHT_CANONICAL_MISMATCH',
    );
    const recordSenseIds = new Set(record.senses.map(({ id }) => id));
    for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
      const evidence = checkpoint.boundary_checks[boundaryId];
      if (evidence.status !== 'checked') continue;
      for (const senseId of evidence.sense_ids) {
        if (!recordSenseIds.has(senseId)) {
          fail(
            `preflight checkpoint ${checkpoint.inventory_id} ${boundaryId} cites a missing sense`,
            'PREFLIGHT_CANONICAL_MISMATCH',
          );
        }
        if (!evidence.rationale.includes(senseId)) {
          fail(
            `preflight checkpoint ${checkpoint.inventory_id} ${boundaryId} evidence does not explain its sense`,
            'PREFLIGHT_EVIDENCE_MISMATCH',
          );
        }
      }
    }
  }

  for (const { record } of recordInfos) {
    if (record.role !== 'start' || !record.senses.some(({ relations }) => (relations?.length ?? 0) > 0)) continue;
    const manifestRecord = manifestByCanonicalId.get(record.id);
    const checkpoint = manifestRecord
      ? checkpointsByInventoryId.get(manifestRecord.inventory_id)
      : undefined;
    if (!checkpoint || checkpoint.status !== 'complete' || checkpoint.missing_boundary_ids.length > 0) {
      fail(
        `relation-bearing record ${record.id} lacks a complete sense preflight checkpoint`,
        'PREFLIGHT_RELATION_GATE',
      );
    }
    for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
      const evidence = checkpoint.boundary_checks[boundaryId];
      if (evidence.status === 'not-reviewed') {
        fail(
          `relation-bearing record ${record.id} lacks evidence for ${boundaryId}`,
          'PREFLIGHT_RELATION_GATE',
        );
      }
    }
  }
}

export function validateBatchManifest(manifest) {
  validateManifestSchema(manifest);

  requireString(manifest.batch_id, 'manifest.batch_id');
  requireString(manifest.inventory_revision, 'manifest.inventory_revision');

  for (const key of ['model_id', 'tool_version', 'prompt_version']) {
    requireString(manifest.generator[key], `manifest.generator.${key}`);
  }
  if (Object.hasOwn(manifest.generator, 'draft_sha256')) {
    requireString(manifest.generator.draft_sha256, 'manifest.generator.draft_sha256');
  }

  requireIsoDate(manifest.generated_at, 'manifest.generated_at');

  requireString(manifest.review.reviewer, 'manifest.review.reviewer');
  if (Object.hasOwn(manifest.review, 'completed_at')) {
    requireIsoDate(manifest.review.completed_at, 'manifest.review.completed_at');
  }
  validateTimingMeasurement(manifest.measurement);
  validateSenseReview(manifest.sense_review, manifest);

  const inventoryIds = new Set();
  const canonicalIds = new Set();
  manifest.records.forEach((record, index) => {
    validateManifestRecord(record, index);
    if (record.source === 'inventory') {
      if (inventoryIds.has(record.inventory_id)) {
        fail(`manifest.records contains duplicate inventory_id ${record.inventory_id}`, 'DUPLICATE_INVENTORY_ID');
      }
      inventoryIds.add(record.inventory_id);
    }
    if (Object.hasOwn(record, 'canonical_id')) {
      if (canonicalIds.has(record.canonical_id)) {
        fail(`manifest.records contains duplicate canonical_id ${record.canonical_id}`, 'DUPLICATE_CANONICAL_ID');
      }
      canonicalIds.add(record.canonical_id);
    }
  });

  if (manifest.review.status !== 'complete') {
    const importable = manifest.records.find(
      (record) => record.decision === 'included' || record.decision === 'corrected',
    );
    if (importable) {
      fail(
        `incomplete manifest cannot contain importable decision for ${importable.inventory_id ?? importable.canonical_id}`,
        'UNVERIFIED_IMPORTABLE_DECISION',
      );
    }
  }
  if (manifest.review.status === 'complete') {
    const proposal = manifest.records.find((record) => record.decision === 'proposed');
    if (proposal) {
      fail(
        `complete manifest cannot contain proposed decision for ${proposal.inventory_id ?? proposal.proposal_canonical_id}`,
        'PROPOSAL_REVIEW_INCOMPLETE',
      );
    }
    if (manifest.batch_id.startsWith('m5-10-wave-a2-')
      && !Object.hasOwn(manifest.review, 'reviewed_staging_sha256')) {
      fail(
        'complete Wave A2 manifest must bind the reviewed staging digest',
        'REVIEWED_STAGING_DIGEST_REQUIRED',
      );
    }
  }

  return manifest;
}

async function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`invalid batch manifest JSON: ${error.message}`, 'INVALID_JSON');
    }
    if (error.code === 'ENOENT') {
      fail(`batch manifest does not exist: ${manifestPath}`, 'MISSING_MANIFEST');
    }
    throw error;
  }
  return validateBatchManifest(manifest);
}

function numericId(id, prefix) {
  if (!id.startsWith(prefix)) {
    return 0;
  }
  return Number(id.slice(1));
}

function nextIds(existingRecords, role, count) {
  const prefix = role === 'start' ? 'w' : 'r';
  const highest = existingRecords.reduce(
    (max, recordInfo) => Math.max(max, numericId(recordInfo.record.id, prefix)),
    0,
  );
  return Array.from({ length: count }, (_, index) => (
    `${prefix}${String(highest + index + 1).padStart(3, '0')}`
  ));
}

function validateDeterministicSenseIds(recordInfos) {
  for (const recordInfo of recordInfos) {
    const { record } = recordInfo;
    record.senses.forEach((sense, index) => {
      const expected = `${record.id}-s${index + 1}`;
      if (sense.id !== expected) {
        fail(
          `record ${record.id} must use deterministic sense ID ${expected} (received ${sense.id})`,
          'NON_DETERMINISTIC_SENSE_ID',
        );
      }
    });
  }
}

function validateNoDuplicateLexicalKeys(recordInfos) {
  const audit = auditCanonicalLexicalQuality(recordInfos, {
    scope: 'batch prospective lexical audit',
    throwOnError: false,
  });
  const duplicateFinding = audit.blocking_findings.find(({ code }) => [
    'LEXICAL_DUPLICATE_LEMMA',
    'LEXICAL_DUPLICATE_SEARCH_FORM',
  ].includes(code));
  if (duplicateFinding) {
    const code = duplicateFinding.code === 'LEXICAL_DUPLICATE_LEMMA'
      ? 'DUPLICATE_LEMMA'
      : 'DUPLICATE_SEARCH_FORM';
    fail(duplicateFinding.message, code);
  }
}

function validateReferenceClosure(manifestRecords, stagedRecordInfos, canonicalRecordInfos) {
  const allCanonicalIds = new Set(
    [...canonicalRecordInfos, ...stagedRecordInfos].map(({ record }) => record.id),
  );
  const stagedById = new Map(stagedRecordInfos.map((recordInfo) => [recordInfo.record.id, recordInfo]));

  for (const manifestRecord of manifestRecords.filter(
    (record) => record.source === 'reference-closure' && (record.decision === 'included' || record.decision === 'corrected'),
  )) {
    const canonicalId = manifestRecord.canonical_id;
    for (const relatedId of manifestRecord.related_to) {
      if (!allCanonicalIds.has(relatedId)) {
        fail(
          `reference closure ${canonicalId} refers to missing canonical ${relatedId}`,
          'MISSING_RELATED_RECORD',
        );
      }
    }

    const referencingSources = [...stagedById.values()]
      .filter(({ record }) => record.senses.some((sense) => (
        sense.relations ?? []
      ).some((relation) => relation.target === canonicalId)))
      .map(({ record }) => record.id);
    if (referencingSources.length === 0) {
      fail(
        `reference closure ${canonicalId} is not referenced by a staged record`,
        'ORPHAN_REFERENCE_CLOSURE',
      );
    }
    for (const relatedId of manifestRecord.related_to) {
      if (!referencingSources.includes(relatedId)) {
        fail(
          `reference closure ${canonicalId} is not referenced from related record ${relatedId}`,
          'REFERENCE_CLOSURE_MISMATCH',
        );
      }
    }
  }
}

function validateDeterministicCanonicalIds(manifestRecords, stagedRecordInfos, canonicalRecordInfos) {
  const importedById = new Map(stagedRecordInfos.map((recordInfo) => [recordInfo.record.id, recordInfo]));
  const approvedRecords = manifestRecords.filter(
    (record) => record.decision === 'included' || record.decision === 'corrected',
  );

  const existingIds = new Set(canonicalRecordInfos.map(({ record }) => record.id));
  for (const recordInfo of stagedRecordInfos) {
    if (existingIds.has(recordInfo.record.id)) {
      fail(`staged record ${recordInfo.record.id} already exists in canonical`, 'CANONICAL_ID_COLLISION');
    }
  }

  for (const role of ROLES) {
    const roleRecords = approvedRecords.filter((record) => record.role === role);
    const expectedIds = nextIds(canonicalRecordInfos, role, roleRecords.length);
    roleRecords.forEach((manifestRecord, index) => {
      const expectedId = expectedIds[index];
      if (manifestRecord.canonical_id !== expectedId) {
        fail(
          `manifest record ${manifestRecord.canonical_id} is not the deterministic next ${role} ID ${expectedId}`,
          'NON_DETERMINISTIC_CANONICAL_ID',
        );
      }
      const stagedRecordInfo = importedById.get(manifestRecord.canonical_id);
      if (!stagedRecordInfo) {
        fail(
          `approved canonical ${manifestRecord.canonical_id} has no staged record`,
          'MISSING_STAGED_RECORD',
        );
      }
    });
  }
}

function inventoryEntryMap(inventory) {
  return new Map(inventory.entries.map((entry) => [entry.inventory_id, entry]));
}

function validateInventoryTargets(manifestRecords, inventory) {
  const entriesById = inventoryEntryMap(inventory);
  for (const manifestRecord of manifestRecords.filter((record) => record.source === 'inventory')) {
    const target = entriesById.get(manifestRecord.inventory_id);
    if (!target) {
      fail(
        `batch target ${manifestRecord.inventory_id} does not exist in target inventory`,
        'MISSING_INVENTORY_TARGET',
      );
    }
    if (target.source !== 'editorial' || !['candidate', 'held'].includes(target.status)) {
      fail(
        `batch target ${manifestRecord.inventory_id} must be a candidate or held editorial row`,
        'INVALID_INVENTORY_TARGET',
      );
    }
    if (manifestRecord.role !== target.planned_role) {
      fail(
        `batch target ${manifestRecord.inventory_id} role does not match inventory planned_role`,
        'INVENTORY_ROLE_DRIFT',
      );
    }
  }
}

function validateStagedMapping(manifestRecords, stagedRecordInfos) {
  const approved = manifestRecords.filter(
    (record) => record.decision === 'included' || record.decision === 'corrected',
  );
  const approvedByCanonicalId = new Map(approved.map((record) => [record.canonical_id, record]));
  const stagedById = new Map();

  for (const recordInfo of stagedRecordInfos) {
    const { record } = recordInfo;
    if (stagedById.has(record.id)) {
      fail(`staged records contain duplicate canonical_id ${record.id}`, 'DUPLICATE_CANONICAL_ID');
    }
    stagedById.set(record.id, recordInfo);
    const manifestRecord = approvedByCanonicalId.get(record.id);
    if (!manifestRecord) {
      fail(`staged record ${record.id} is not approved by the batch manifest`, 'STAGED_RECORD_NOT_APPROVED');
    }
    if (record.role !== manifestRecord.role) {
      fail(`staged record ${record.id} role does not match the batch manifest`, 'STAGED_ROLE_MISMATCH');
    }
  }

  for (const manifestRecord of approved) {
    if (!stagedById.has(manifestRecord.canonical_id)) {
      fail(
        `approved canonical ${manifestRecord.canonical_id} is missing from staged records`,
        'MISSING_STAGED_RECORD',
      );
    }
  }

  return stagedById;
}

export async function validateBatch({
  manifestPath,
  stagedRecordsPath,
  semanticAuditPath,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  allowRepositoryStaging = false,
  productionStateSources: productionStateSourceOverrides = {},
} = {}) {
  if (!manifestPath) {
    fail('manifestPath is required', 'MISSING_MANIFEST_PATH');
  }
  if (!stagedRecordsPath) {
    fail('stagedRecordsPath is required', 'MISSING_STAGED_PATH');
  }
  if (!semanticAuditPath) {
    fail('semanticAuditPath is required; admission cannot generate semantic decisions', 'MISSING_SEMANTIC_AUDIT_PATH');
  }
  assertExternalStagingPath(stagedRecordsPath, allowRepositoryStaging);
  assertExternalStagingPath(semanticAuditPath, allowRepositoryStaging);

  const manifest = await readManifest(manifestPath);
  if (manifest.review.status !== 'complete') {
    fail('batch review must be complete before canonical import', 'REVIEW_NOT_COMPLETE');
  }
  if (manifest.production_state === undefined) {
    fail(
      'active batch admission requires the complete shared production_state; legacy manifests must be migrated before reuse',
      'MISSING_PRODUCTION_STATE',
    );
  }

  let semanticAuditBytes;
  let semanticAudit;
  try {
    semanticAuditBytes = await readFile(semanticAuditPath);
    semanticAudit = JSON.parse(semanticAuditBytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`semantic audit artifact does not exist: ${semanticAuditPath}`, 'MISSING_SEMANTIC_AUDIT');
    }
    if (error instanceof SyntaxError) {
      fail(`semantic audit artifact is not valid JSON: ${semanticAuditPath}`, 'INVALID_SEMANTIC_AUDIT');
    }
    throw error;
  }
  const semanticAuditDigest = createHash('sha256').update(semanticAuditBytes).digest('hex');
  if (manifest.review.semantic_audit_sha256 !== semanticAuditDigest) {
    fail('semantic audit artifact digest does not match the complete batch manifest', 'SEMANTIC_AUDIT_DIGEST_MISMATCH');
  }

  await validateTargetInventory({ inventoryPath, canonicalDirectory });
  const { inventory } = await readTargetInventory(inventoryPath);
  if (manifest.inventory_id !== inventory.inventory_id) {
    fail('batch manifest inventory_id does not match target inventory', 'INVENTORY_ID_DRIFT');
  }
  if (manifest.inventory_revision !== inventory.revision) {
    fail(
      `batch manifest inventory_revision ${manifest.inventory_revision} does not match ${inventory.revision}`,
      'INVENTORY_REVISION_DRIFT',
    );
  }
  validateInventoryTargets(manifest.records, inventory);

  const canonicalResult = await readCanonicalRecords(canonicalDirectory);
  let stagedResult;
  let stagedBytes;
  try {
    stagedBytes = await readFile(stagedRecordsPath);
    stagedResult = await readCanonicalRecords(stagedRecordsPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`staged canonical input does not exist: ${stagedRecordsPath}`, 'MISSING_STAGED_INPUT');
    }
    throw error;
  }

  if (Object.hasOwn(manifest.review, 'reviewed_staging_sha256')) {
    const stagedDigest = createHash('sha256').update(stagedBytes).digest('hex');
    if (stagedDigest !== manifest.review.reviewed_staging_sha256) {
      fail(
        'reviewed staging input digest does not match the complete manifest',
        'REVIEWED_STAGING_DIGEST_MISMATCH',
      );
    }
  }

  validateStagedMapping(manifest.records, stagedResult.records);
  validateSensePreflightRecords(manifest, stagedResult.records);
  validateDeterministicCanonicalIds(manifest.records, stagedResult.records, canonicalResult.records);
  validateDeterministicSenseIds(stagedResult.records);
  validateNoDuplicateLexicalKeys([...canonicalResult.records, ...stagedResult.records]);
  validateReferenceClosure(manifest.records, stagedResult.records, canonicalResult.records);

  const prospectiveRecords = [...canonicalResult.records, ...stagedResult.records];
  const productionStateSources = {
    candidate_intake: stagedBytes,
    semantic_review: semanticAuditBytes,
    selection: stagedBytes,
    prospective_canonical: productionSourceBytes(prospectiveRecords.map(({ record }) => record)),
    audit: semanticAuditBytes,
    admission: stagedBytes,
    ...productionStateSourceOverrides,
  };
  try {
    validateLexicalProductionState(manifest.production_state, {
      batchId: manifest.batch_id,
      sourceBytesByStage: productionStateSources,
    });
  } catch (error) {
    fail(`shared production_state validation failed: ${error.message}`, error.code);
  }
  const manifestRecordByCanonicalId = new Map(
    manifest.records
      .filter(({ canonical_id: canonicalId }) => canonicalId)
      .map((manifestRecord) => [manifestRecord.canonical_id, manifestRecord]),
  );
  const reviewedRecords = stagedResult.records.map((recordInfo) => ({
    ...recordInfo,
    decision: manifestRecordByCanonicalId.get(recordInfo.record.id)?.decision,
  }));
  validateLexicalAddition({
    batchId: manifest.batch_id,
    baseRecords: canonicalResult.records,
    reviewedRecords,
    prospectiveRecords,
    semanticAudit,
    productionState: manifest.production_state,
    productionStateSources,
    checkPilotCompleteness: false,
    candidateLabel: `${manifest.batch_id} candidate records`,
    reviewedLabel: `${manifest.batch_id} reviewed records`,
    prospectiveLabel: `${manifest.batch_id} prospective canonical records`,
  });

  const counts = Object.fromEntries(DECISIONS.map((decision) => [
    decision,
    manifest.records.filter((record) => record.decision === decision).length,
  ]));
  const deferredCount = manifest.records.filter((record) => record.decision === 'deferred').length;
  if (deferredCount > 0) counts.deferred = deferredCount;
  const referenceClosureCount = manifest.records.filter(
    (record) => record.source === 'reference-closure' && (record.decision === 'included' || record.decision === 'corrected'),
  ).length;

  return {
    manifest,
    manifestPath,
    stagedRecordsPath,
    inventoryPath,
    canonicalDirectory,
    canonicalRecordCount: canonicalResult.records.length,
    stagedRecordCount: stagedResult.records.length,
    targetCount: manifest.records.filter((record) => record.source === 'inventory').length,
    referenceClosureCount,
    counts,
    stagedRecords: stagedResult.records,
  };
}

export function assertImportArtifactPath(outputPath, canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY) {
  if (!outputPath) {
    fail('outputPath is required', 'MISSING_OUTPUT_PATH');
  }
  assertCanonicalImportOutputPath(outputPath, canonicalDirectory);
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
  const summary = await validateBatch({
    manifestPath: args.manifest,
    stagedRecordsPath: args['staged-records'],
    semanticAuditPath: args['semantic-audit'],
    inventoryPath: args.inventory,
    canonicalDirectory: args['canonical-dir'],
  });

  if (args.json === 'true') {
    console.log(JSON.stringify({
      batchId: summary.manifest.batch_id,
      canonicalRecordCount: summary.canonicalRecordCount,
      stagedRecordCount: summary.stagedRecordCount,
      targetCount: summary.targetCount,
      referenceClosureCount: summary.referenceClosureCount,
      decisions: summary.counts,
    }, null, 2));
    return summary;
  }

  console.log(
    `Validated batch ${summary.manifest.batch_id}: ${summary.stagedRecordCount} reviewed canonical record(s), ${summary.targetCount} inventory target(s), ${summary.referenceClosureCount} reference closure record(s).`,
  );
  return summary;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

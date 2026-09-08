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
  M5_10A_ALLOWED_GENERATION_BASIS,
  M5_10A_CALIBRATION_CASE_COUNT,
  M5_10A_RELATION_FAILURE_CATEGORIES,
  M5_10A_RELATION_GENERATION_REVISION,
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

export const DEFAULT_CALIBRATION_FIXTURE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../tests/fixtures/m5-10a-relation-generation-calibration.json',
);
export const DEFAULT_CALIBRATION_ARTIFACT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-relation-calibration.json',
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

const EXPECTED_SUPPRESSED_CASES = Object.freeze({
  'm5-10a-cal-016': 'incidental-co-occurrence',
  'm5-10a-cal-017': 'generic-result-or-reaction',
  'm5-10a-cal-018': 'arbitrary-modifier-or-place',
  'm5-10a-cal-019': 'broad-common-category',
  'm5-10a-cal-020': 'sense-target-type-error',
});

const REQUIRED_TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
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

function validateFixtureEvidence(fixture, canonicalRecords) {
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

  const senseById = new Map();
  for (const { record } of canonicalRecords) {
    for (const sense of record.senses) senseById.set(sense.id, { record, sense });
  }
  const rationaleSignatures = new Set();
  const boundaryStatusCounts = Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((id) => [id, 0]));
  for (const caseRecord of fixture.cases) {
    assertCondition(
      senseById.has(caseRecord.source_sense),
      `${caseRecord.case_id} source sense is missing from canonical data`,
      'CALIBRATION_SOURCE_SENSE_MISSING',
    );
    const expectedSuppression = EXPECTED_SUPPRESSED_CASES[caseRecord.case_id];
    if (expectedSuppression) {
      assertEqual(caseRecord.expected_action, 'suppress', `${caseRecord.case_id} must remain a suppression case`, 'CALIBRATION_CASE_DRIFT');
      assertEqual(caseRecord.expected_suppression_category, expectedSuppression, `${caseRecord.case_id} suppression category drifted`, 'CALIBRATION_CASE_DRIFT');
      assertCondition(
        caseRecord.generation_basis === expectedSuppression || expectedSuppression === 'sense-target-type-error',
        `${caseRecord.case_id} does not exercise its fixed failure category`,
        'CALIBRATION_CASE_DRIFT',
      );
    } else {
      assertEqual(caseRecord.expected_action, 'emit', `${caseRecord.case_id} must remain an emitted calibration case`, 'CALIBRATION_CASE_DRIFT');
      assertEqual(caseRecord.generation_basis, M5_10A_ALLOWED_GENERATION_BASIS, `${caseRecord.case_id} must use the allowed generation basis`, 'CALIBRATION_CASE_DRIFT');
    }

    for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
      const evidence = caseRecord.preflight.boundary_checks[boundaryId];
      assertCondition(
        evidence.status === 'checked',
        `${caseRecord.case_id}.${boundaryId} must contain checked evidence`,
        'CALIBRATION_PREFLIGHT_INCOMPLETE',
      );
      assertCondition(
        evidence.rationale.includes(caseRecord.case_id)
          && evidence.rationale.includes(boundaryId)
          && evidence.rationale.includes(caseRecord.source_sense),
        `${caseRecord.case_id}.${boundaryId} evidence is not record-specific`,
        'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH',
      );
      assertEqual(
        evidence.sense_ids,
        [caseRecord.source_sense],
        `${caseRecord.case_id}.${boundaryId} evidence sense IDs drifted`,
        'CALIBRATION_PREFLIGHT_EVIDENCE_MISMATCH',
      );
      const signature = `${boundaryId}:${evidence.rationale}`;
      assertCondition(!rationaleSignatures.has(signature), `${caseRecord.case_id}.${boundaryId} reuses evidence`, 'CALIBRATION_GENERIC_EVIDENCE');
      rationaleSignatures.add(signature);
      boundaryStatusCounts[boundaryId] += 1;
    }
  }
  return {
    case_count: fixture.cases.length,
    evidence_case_count: fixture.cases.filter(({ preflight }) => preflight.status === 'complete').length,
    unresolved_boundary_count: Object.values(boundaryStatusCounts).reduce((count, value) => count + (fixture.cases.length - value), 0),
    duplicate_evidence_count: fixture.cases.length * M5_10A_SENSE_BOUNDARY_IDS.length - rationaleSignatures.size,
  };
}

function validateGeneratedResults(artifact, fixture, canonicalRecords) {
  const generated = generateRelationCandidates(fixture, canonicalRecords);
  assertEqual(
    artifact.generated_candidates,
    generated.generated_candidates,
    'calibration generated candidate output drifted',
    'CALIBRATION_GENERATION_OUTPUT_MISMATCH',
  );
  assertEqual(
    artifact.suppressed_candidates,
    generated.suppressed_candidates,
    'calibration suppression output drifted',
    'CALIBRATION_GENERATION_OUTPUT_MISMATCH',
  );
  assertEqual(
    artifact.calibration.generation,
    {
      generated_candidate_count: generated.generated_candidate_count,
      suppressed_candidate_count: generated.suppressed_candidate_count,
      pre_screen_noise_count: generated.pre_screen_noise_count,
      noise_rate_of_emitted_candidates: generated.noise_rate_of_emitted_candidates,
      suppressed_category_counts: generated.suppressed_category_counts,
    },
    'calibration generation metrics drifted',
    'CALIBRATION_GENERATION_METRIC_MISMATCH',
  );
  assertEqual(
    generated.generated_candidate_count + generated.suppressed_candidate_count,
    M5_10A_CALIBRATION_CASE_COUNT,
    'calibration generator did not account for every case',
    'CALIBRATION_CASE_COVERAGE',
  );
  assertEqual(
    generated.pre_screen_noise_count,
    0,
    'corrected generator emitted a known noisy candidate',
    'CALIBRATION_NOISE_GATE_FAILURE',
  );
  return generated;
}

function validateTiming(calibration) {
  const timing = calibration.timing;
  assertEqual(timing.status, 'complete', 'calibration timing is not complete', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertEqual(timing.processed_start_count, M5_10A_CALIBRATION_CASE_COUNT, 'calibration timing denominator drifted', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertEqual(timing.machine_validation_excluded_from_editor_seconds, true, 'machine validation entered editor time', 'CALIBRATION_TIMING_BOUNDARY');
  const passIds = timing.passes.map(({ id }) => id);
  assertEqual(passIds, REQUIRED_TIMING_PASS_IDS, 'calibration timing pass coverage drifted', 'CALIBRATION_TIMING_GATE_FAILURE');
  let editorSeconds = 0;
  let unmeasuredPassCount = 0;
  for (const [index, pass] of timing.passes.entries()) {
    const label = `calibration.timing.passes[${index}]`;
    if (pass.status !== 'complete') {
      unmeasuredPassCount += 1;
      continue;
    }
    const elapsedSeconds = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
    assertCondition(Number.isFinite(elapsedSeconds), `${label} timestamps are invalid`, 'CALIBRATION_TIMING_GATE_FAILURE');
    assertEqual(pass.wall_clock_seconds, elapsedSeconds, `${label} wall-clock duration drifted`, 'CALIBRATION_TIMING_DURATION_DRIFT');
    editorSeconds += pass.editor_seconds;
  }
  assertEqual(unmeasuredPassCount, timing.unmeasured_pass_count, 'calibration unmeasured timing count drifted', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertEqual(editorSeconds, timing.editor_seconds, 'calibration editor seconds drifted from pass timings', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertEqual(
    timing.editor_seconds_per_processed_start,
    editorSeconds / timing.processed_start_count,
    'calibration editor seconds per start drifted',
    'CALIBRATION_TIMING_GATE_FAILURE',
  );
  return {
    status: timing.status,
    processed_start_count: timing.processed_start_count,
    editor_seconds: editorSeconds,
    editor_seconds_per_processed_start: timing.editor_seconds_per_processed_start,
    unmeasured_pass_count: unmeasuredPassCount,
  };
}

function validateAudit(audit) {
  assertEqual(audit.status, 'complete', 'calibration audit is not complete', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.independent, true, 'calibration audit is not independent', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertEqual(audit.open_blocker_count, 0, 'calibration audit has an open blocker', 'CALIBRATION_AUDIT_GATE_FAILURE');
  const findingIds = audit.findings.map(({ id }) => id);
  assertEqual(new Set(findingIds).size, findingIds.length, 'calibration audit findings repeat', 'CALIBRATION_AUDIT_GATE_FAILURE');
  assertCondition(audit.findings.every(({ status }) => status === 'closed'), 'calibration audit has an open finding', 'CALIBRATION_AUDIT_GATE_FAILURE');
}

function validateFixedGate(artifact, plan, preflight, generated, timing) {
  const limits = {
    relation_noise_rate_max: plan.gate.relation_noise_rate_max,
    editor_seconds_per_processed_start_max: plan.gate.editor_seconds_per_selected_start_max,
    unmeasured_timing_passes_max: plan.gate.unmeasured_timing_passes_max,
    open_audit_blockers_max: plan.gate.open_audit_blockers_max,
  };
  assertEqual(artifact.calibration.fixed_gate, { status: 'passed', ...limits }, 'calibration fixed gate definition drifted', 'CALIBRATION_GATE_DEFINITION_MISMATCH');
  assertEqual(artifact.canonical_mutation, false, 'calibration must not mutate canonical data', 'CALIBRATION_CANONICAL_MUTATION');
  assertEqual(preflight, {
    case_count: M5_10A_CALIBRATION_CASE_COUNT,
    evidence_case_count: M5_10A_CALIBRATION_CASE_COUNT,
    unresolved_boundary_count: 0,
    duplicate_evidence_count: 0,
  }, 'calibration preflight gate drifted', 'CALIBRATION_PREFLIGHT_GATE_FAILURE');
  assertCondition(generated.noise_rate_of_emitted_candidates <= limits.relation_noise_rate_max, 'calibration relation noise exceeds fixed gate', 'CALIBRATION_NOISE_GATE_FAILURE');
  assertCondition(timing.editor_seconds_per_processed_start <= limits.editor_seconds_per_processed_start_max, 'calibration editor time exceeds fixed gate', 'CALIBRATION_TIMING_GATE_FAILURE');
  assertCondition(timing.unmeasured_pass_count <= limits.unmeasured_timing_passes_max, 'calibration contains an unmeasured pass', 'CALIBRATION_TIMING_GATE_FAILURE');
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
  assertEqual(fixturePath, DEFAULT_CALIBRATION_FIXTURE_PATH, 'calibration fixture path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(canonicalDirectory, path.resolve(REPOSITORY_DIRECTORY, 'data/canonical'), 'calibration canonical path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');
  assertEqual(planPath, DEFAULT_CALIBRATION_PLAN_PATH, 'calibration plan path drifted', 'CALIBRATION_SOURCE_PATH_MISMATCH');

  const [fixtureSource, planSource] = await Promise.all([
    readJsonSource(fixturePath, 'M5-10A relation calibration fixture'),
    readJsonSource(planPath, 'M5-8 expansion plan'),
  ]);
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const canonicalDigest = await hashCanonicalDirectory(canonicalDirectory);
  assertEqual(fixtureSource.sha256, artifact.source.fixture_sha256, 'calibration fixture digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  assertEqual(canonicalDigest, artifact.source.canonical_directory_sha256, 'calibration canonical digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');
  assertEqual(planSource.sha256, artifact.source.expansion_plan_sha256, 'calibration expansion plan digest drifted', 'CALIBRATION_SOURCE_DIGEST_MISMATCH');

  validateSchema(fixtureSource.value, fixtureSchemaValidator, 'fixture', 'M5-10A relation calibration fixture');
  validateExpansionPlan(planSource.value);
  const canonicalSnapshot = canonicalSummary(canonical.records);
  assertEqual(canonicalSnapshot, EXPECTED_CANONICAL_SNAPSHOT, 'calibration canonical snapshot changed', 'CALIBRATION_CANONICAL_SCOPE_CHANGED');
  assertEqual(artifact.canonical_snapshot, canonicalSnapshot, 'calibration artifact canonical snapshot drifted', 'CALIBRATION_CANONICAL_SCOPE_CHANGED');

  const preflight = validateFixtureEvidence(fixtureSource.value, canonical.records);
  const generated = validateGeneratedResults(artifact, fixtureSource.value, canonical.records);
  const timing = validateTiming(artifact.calibration);
  validateAudit(artifact.calibration.audit);
  validateFixedGate(artifact, planSource.value, preflight, generated, timing);

  return {
    artifact_id: artifact.artifact_id,
    process_revision: artifact.process_revision,
    canonical_snapshot: canonicalSnapshot,
    case_count: fixtureSource.value.cases.length,
    generated_candidate_count: generated.generated_candidate_count,
    suppressed_candidate_count: generated.suppressed_candidate_count,
    pre_screen_noise_count: generated.pre_screen_noise_count,
    noise_rate_of_emitted_candidates: generated.noise_rate_of_emitted_candidates,
    editor_seconds_per_processed_start: timing.editor_seconds_per_processed_start,
    unmeasured_pass_count: timing.unmeasured_pass_count,
    preflight,
    audit: {
      status: artifact.calibration.audit.status,
      independent: artifact.calibration.audit.independent,
      open_blocker_count: artifact.calibration.audit.open_blocker_count,
    },
    fixed_gate: artifact.calibration.fixed_gate,
    source_digests: {
      artifact: artifactSource.sha256,
      fixture: fixtureSource.sha256,
      canonical_directory: canonicalDigest,
      expansion_plan: planSource.sha256,
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
      `Validated ${result.process_revision}: ${result.case_count} noncanonical calibration case(s), ${result.generated_candidate_count} emitted candidate(s), ${result.suppressed_candidate_count} suppressed noisy candidate(s), and ${result.noise_rate_of_emitted_candidates * 100}% emitted noise.`,
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

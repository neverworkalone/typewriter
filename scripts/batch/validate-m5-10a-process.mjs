import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
  REPOSITORY_DIRECTORY,
  validateBatchManifest,
} from './validate-batch.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import { validateRelationScreen } from './relation-screen.mjs';
import { validateWaveARelationScreen } from './validate-wave-a-relation-screen.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  hashCanonicalDirectory,
  validateExpansionPlan,
  validateExpansionStage,
} from './validate-m5-8-process.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PROCESS_SCHEMA = require('../../schema/m5-10a-process-correction.schema.json');
const VERIFICATION_SCHEMA = require('../../schema/m5-10a-process-verification.schema.json');
const processSchemaValidator = new Ajv2020({ allErrors: true }).compile(PROCESS_SCHEMA);
const verificationSchemaValidator = new Ajv2020({ allErrors: true }).compile(VERIFICATION_SCHEMA);

export const DEFAULT_PROCESS_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-process-correction.json',
);
export const DEFAULT_VERIFICATION_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-process-verification.json',
);
export const DEFAULT_WAVE_A_STAGE_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-9a-wave-a-plus-50.json',
);
export const DEFAULT_PLAN_PATH = path.resolve(
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

const EXPECTED_RELATION_REGRESSION = Object.freeze({
  proposal_count: 25,
  pre_screened_count: 25,
  pre_screen_pass_count: 13,
  pre_screen_rejected_count: 12,
  human_admission_denominator: 13,
  human_admission_reviewed_count: 13,
  human_admitted_count: 13,
  human_rejected_count: 0,
  final_relation_count: 13,
  failure_category_counts: {
    'arbitrary-modifier-or-place': 3,
    'broad-common-category': 2,
    'generic-result-or-reaction': 7,
  },
});

const EXPECTED_RELATION_DENOMINATOR = Object.freeze(
  Object.fromEntries(
    Object.entries(EXPECTED_RELATION_REGRESSION).filter(([key]) => key !== 'failure_category_counts'),
  ),
);

export class M5AProcessValidationError extends Error {
  constructor(message, code = 'M5A_PROCESS_VALIDATION_ERROR') {
    super(message);
    this.name = 'M5AProcessValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5A_PROCESS_VALIDATION_ERROR') {
  throw new M5AProcessValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function assertCondition(condition, message, code = 'M5A_PROCESS_VALIDATION_ERROR') {
  if (!condition) fail(message, code);
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
    'SCHEMA_ERROR',
  );
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function resolveRepositoryPath(sourcePath, label) {
  assertCondition(
    typeof sourcePath === 'string' && sourcePath.trim().length > 0,
    `${label} must be a non-empty path`,
    'SOURCE_PATH_MISMATCH',
  );
  const resolved = path.resolve(REPOSITORY_DIRECTORY, sourcePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  assertCondition(
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
    `${label} must remain inside the repository`,
    'SOURCE_PATH_MISMATCH',
  );
  return resolved;
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_SOURCE_JSON');
    throw error;
  }
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

function validateSourceDigest(process, key, source) {
  assertEqual(
    source.sha256,
    process.source[`${key}_sha256`],
    `${key} source digest drifted`,
    'SOURCE_DIGEST_MISMATCH',
  );
}

function validateBoundaryFixture(fixture, canonicalRecords, process) {
  assertCondition(fixture && typeof fixture === 'object', 'sense regression fixture must be an object', 'INVALID_FIXTURE');
  assertEqual(
    fixture.canonical_artifact,
    'data/canonical/m5-10-wave-a.jsonl',
    'sense regression fixture canonical artifact drifted',
    'FIXTURE_SOURCE_MISMATCH',
  );
  assertCondition(Array.isArray(fixture.sense_cases), 'sense regression fixture must contain sense_cases', 'INVALID_FIXTURE');

  const regressionConfig = process.sense_preflight.regression_fixture;
  assertEqual(
    fixture.sense_cases.length,
    regressionConfig.sense_case_count,
    'sense regression fixture case count drifted',
    'SENSE_FIXTURE_COVERAGE',
  );
  const expectedCaseIds = [...regressionConfig.required_case_ids].sort();
  const actualCaseIds = fixture.sense_cases.map(({ canonical_id: canonicalId }) => canonicalId).sort();
  assertEqual(actualCaseIds, expectedCaseIds, 'sense regression fixture case coverage drifted', 'SENSE_FIXTURE_COVERAGE');

  const canonicalById = new Map(canonicalRecords.map(({ record }) => [record.id, record]));
  const boundaryCoverage = Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => [boundaryId, 0]));
  const caseIds = new Set();
  for (const [index, regressionCase] of fixture.sense_cases.entries()) {
    const label = `sense_cases[${index}]`;
    assertCondition(!caseIds.has(regressionCase.case_id), `${label} repeats case_id`, 'DUPLICATE_FIXTURE_CASE');
    caseIds.add(regressionCase.case_id);
    assertCondition(Array.isArray(regressionCase.required_boundary_ids), `${label} must record required boundary IDs`, 'MISSING_BOUNDARY_COVERAGE');
    assertCondition(regressionCase.required_boundary_ids.length > 0, `${label} must record at least one required boundary`, 'MISSING_BOUNDARY_COVERAGE');
    const boundaryIds = new Set(regressionCase.required_boundary_ids);
    for (const boundaryId of boundaryIds) {
      assertCondition(M5_10A_SENSE_BOUNDARY_IDS.includes(boundaryId), `${label} references unknown boundary ${boundaryId}`, 'UNKNOWN_BOUNDARY');
      boundaryCoverage[boundaryId] += 1;
    }
    const record = canonicalById.get(regressionCase.canonical_id);
    assertCondition(record, `${regressionCase.case_id} canonical record is missing`, 'MISSING_CANONICAL_RECORD');
    assertEqual(
      record.senses.length,
      regressionCase.expected_sense_count,
      `${regressionCase.case_id} sense count drifted`,
      'SENSE_REGRESSION',
    );
    assertEqual(
      record.senses.map(({ pos }) => pos),
      regressionCase.expected_pos,
      `${regressionCase.case_id} POS drifted`,
      'SENSE_REGRESSION',
    );
    assertEqual(
      record.senses.map(({ gloss }) => gloss),
      regressionCase.expected_glosses,
      `${regressionCase.case_id} glosses drifted`,
      'SENSE_REGRESSION',
    );
  }
  assertEqual(
    boundaryCoverage,
    regressionConfig.required_boundary_coverage,
    'sense regression boundary coverage drifted',
    'BOUNDARY_COVERAGE_MISMATCH',
  );

  return {
    sense_case_count: fixture.sense_cases.length,
    required_boundary_coverage: boundaryCoverage,
    case_ids: actualCaseIds,
  };
}

function validateBoundaryDefinitions(process) {
  assertEqual(
    process.sense_preflight.boundaries.map(({ id }) => id),
    M5_10A_SENSE_BOUNDARY_IDS,
    'sense preflight boundary definitions drifted',
    'PREFLIGHT_BOUNDARY_DEFINITION_MISMATCH',
  );
}

function validateRelationRegression(process, relationScreen, relationDiff, sourcePaths) {
  const summary = validateRelationScreen(
    relationScreen,
    relationDiff,
    {
      relationDiffPath: sourcePaths.relation_diff,
      relationDiffSha256: sourcePaths.relation_diff_sha256,
    },
  );
  assertEqual(
    summary,
    {
      artifact_id: relationScreen.artifact_id,
      process_revision: relationScreen.process_revision,
      ...EXPECTED_RELATION_REGRESSION,
    },
    'relation pre-screen denominator or categories drifted',
    'RELATION_REGRESSION_DRIFT',
  );
  assertEqual(
    process.relation_pre_screen.denominator,
    EXPECTED_RELATION_DENOMINATOR,
    'process relation denominator drifted',
    'RELATION_REGRESSION_DRIFT',
  );
  assertEqual(
    process.relation_pre_screen.failure_category_counts,
    EXPECTED_RELATION_REGRESSION.failure_category_counts,
    'process relation failure categories drifted',
    'RELATION_REGRESSION_DRIFT',
  );
  return summary;
}

function validateTimingBoundary(process, waveAManifest, waveAMetrics) {
  assertEqual(
    process.timing_boundary.contract_version,
    'm5-10a-v1',
    'M5-10A timing contract version drifted',
    'TIMING_CONTRACT_MISMATCH',
  );
  assertEqual(
    waveAManifest.measurement.timing.status,
    'complete',
    'historical Wave A timing is not complete',
    'INCOMPLETE_TIMING',
  );
  const passes = waveAManifest.measurement.timing.passes;
  assertCondition(passes.every((pass) => pass.status === 'complete'), 'historical Wave A contains an unmeasured timing pass', 'INCOMPLETE_TIMING');
  assertEqual(
    waveAMetrics.derived.timing.unmeasured_passes,
    [],
    'historical Wave A metrics contain an unmeasured timing pass',
    'INCOMPLETE_TIMING',
  );
  assertEqual(
    process.timing_boundary.machine_validation.editor_seconds_included,
    false,
    'machine validation must not be counted as editor seconds',
    'TIMING_BOUNDARY_MISMATCH',
  );
  return {
    contract_version: process.timing_boundary.contract_version,
    pass_count: passes.length,
    unmeasured_pass_count: waveAMetrics.derived.timing.unmeasured_passes.length,
    editor_seconds: waveAMetrics.derived.timing.total_editor_seconds,
  };
}

function validateAudit(process) {
  assertEqual(process.audit.status, 'complete', 'process audit is not complete', 'AUDIT_INCOMPLETE');
  assertEqual(process.audit.independent, true, 'process audit is not independent', 'AUDIT_NOT_INDEPENDENT');
  assertEqual(process.audit.open_blocker_count, 0, 'process audit has an open blocker', 'OPEN_AUDIT_BLOCKER');
  const findingIds = process.audit.findings.map(({ id }) => id);
  assertEqual(
    new Set(findingIds).size,
    findingIds.length,
    'process audit findings contain duplicate IDs',
    'DUPLICATE_AUDIT_FINDING',
  );
  assertCondition(
    process.audit.findings.every(({ status }) => status === 'closed'),
    'process audit contains an open finding',
    'OPEN_AUDIT_FINDING',
  );
}

function validateVerification(verification, canonicalSnapshot) {
  validateSchema(
    verification,
    verificationSchemaValidator,
    'verification',
    'M5-10A process verification',
  );
  assertEqual(
    verification.canonical_snapshot,
    canonicalSnapshot,
    'process verification canonical snapshot drifted',
    'VERIFICATION_SNAPSHOT_MISMATCH',
  );
  assertCondition(
    Object.values(verification.checks).every((check) => {
      if (check && typeof check === 'object' && check.status) return check.status === 'passed';
      return Object.values(check).every((nested) => nested.status === 'passed');
    }),
    'process verification contains a failed machine check',
    'MACHINE_VALIDATION_FAILURE',
  );
  for (const packageCheck of [
    verification.checks.package.non_minified,
    verification.checks.package.minified,
  ]) {
    assertEqual(
      packageCheck.dictionary_snapshot,
      canonicalSnapshot,
      'package dictionary snapshot drifted',
      'PACKAGE_SNAPSHOT_MISMATCH',
    );
  }
  return {
    canonical_integrity: verification.checks.canonical_integrity.status === 'passed',
    deterministic_sqlite: verification.checks.deterministic_sqlite.status === 'passed',
    search_product_regression: verification.checks.search_product_regression.status === 'passed',
    package: verification.checks.package.status === 'passed',
  };
}

export async function validateM5AProcess({
  processPath = DEFAULT_PROCESS_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  stagePath = DEFAULT_WAVE_A_STAGE_PATH,
  planPath = DEFAULT_PLAN_PATH,
} = {}) {
  const resolvedProcessPath = path.resolve(processPath);
  const processSource = await readJsonSource(resolvedProcessPath, 'M5-10A process correction artifact');
  validateSchema(processSource.value, processSchemaValidator, 'process', 'M5-10A process correction');
  const process = processSource.value;
  assertEqual(process.process_revision, M5_10A_PROCESS_REVISION, 'process revision drifted', 'PROCESS_REVISION_MISMATCH');
  validateBoundaryDefinitions(process);

  const sourcePaths = Object.fromEntries(
    Object.entries(process.source).filter(([key]) => !key.endsWith('_sha256')).map(([key, value]) => [
      key,
      resolveRepositoryPath(value, `process.source.${key}`),
    ]),
  );
  assertEqual(
    sourcePaths.failed_stage_report,
    path.resolve(stagePath),
    'requested failed-stage source does not match the process artifact',
    'SOURCE_PATH_MISMATCH',
  );
  assertEqual(
    path.resolve(planPath),
    DEFAULT_PLAN_PATH,
    'requested expansion plan does not match the fixed process contract',
    'SOURCE_PATH_MISMATCH',
  );
  const sourceEntries = await Promise.all(
    Object.entries(sourcePaths).map(async ([key, filePath]) => {
      if (key === 'canonical_directory') {
        return [key, { sha256: await hashCanonicalDirectory(filePath) }];
      }
      return [key, await readJsonSource(filePath, `process source ${key}`)];
    }),
  );
  const loadedSources = Object.fromEntries(sourceEntries);
  for (const [key, source] of Object.entries(loadedSources)) {
    validateSourceDigest(process, key, source);
  }

  const canonical = await readCanonicalRecords(sourcePaths.canonical_directory);
  const canonicalSnapshot = canonicalSummary(canonical.records);
  assertEqual(
    canonicalSnapshot,
    EXPECTED_CANONICAL_SNAPSHOT,
    'canonical start scope changed during #107',
    'CANONICAL_SCOPE_CHANGED',
  );
  assertEqual(
    process.canonical_scope.snapshot,
    canonicalSnapshot,
    'process canonical scope drifted',
    'CANONICAL_SCOPE_CHANGED',
  );

  const planSource = await readJsonSource(path.resolve(planPath), 'M5-8 expansion plan');
  const actualPlan = planSource.value;
  validateExpansionPlan(actualPlan);
  const stage = loadedSources.failed_stage_report.value;
  const stageResult = await validateExpansionStage(stage, actualPlan);
  assertEqual(stageResult.gate_status, 'fail', 'historical Wave A unexpectedly passed', 'HISTORICAL_GATE_CHANGED');
  assertEqual(stage.decision, 'HOLD PROCESS', 'historical Wave A decision changed', 'HISTORICAL_GATE_CHANGED');
  assertEqual(stage.next_stage_authorized, false, 'historical Wave A authorizes a next stage', 'HISTORICAL_GATE_CHANGED');
  assertEqual(stage.actual.canonical_snapshot, canonicalSnapshot, 'historical Wave A snapshot drifted', 'CANONICAL_SCOPE_CHANGED');

  const waveAManifest = loadedSources.wave_a_manifest.value;
  const waveAMetrics = loadedSources.wave_a_metrics.value;
  validateBatchManifest(waveAManifest);
  assertEqual(waveAMetrics.batch_id, waveAManifest.batch_id, 'Wave A metrics batch ID drifted', 'SOURCE_BINDING_MISMATCH');
  const fixture = loadedSources.sense_regression_fixture.value;
  const senseRegression = validateBoundaryFixture(fixture, canonical.records, process);
  assertEqual(
    waveAManifest.sense_review.split_record_count,
    process.sense_preflight.regression_fixture.required_split_count,
    'Wave A split count drifted from the process regression fixture',
    'SENSE_FIXTURE_COVERAGE',
  );
  assertEqual(
    [...waveAManifest.sense_review.split_canonical_ids].sort(),
    senseRegression.case_ids,
    'Wave A split IDs drifted from the process regression fixture',
    'SENSE_FIXTURE_COVERAGE',
  );

  const relationDiff = loadedSources.relation_regression_screen
    ? loadedSources.relation_regression_screen.value
    : undefined;
  const relationDiffSource = await readJsonSource(
    resolveRepositoryPath(process.relation_pre_screen.source.relation_diff, 'relation pre-screen relation diff'),
    'relation pre-screen relation diff',
  );
  validateRelationDiff(relationDiffSource.value);
  const relationSummary = validateRelationRegression(
    process,
    relationDiff,
    relationDiffSource.value,
    {
      relation_diff: process.relation_pre_screen.source.relation_diff,
      relation_diff_sha256: relationDiffSource.sha256,
    },
  );
  assertEqual(
    relationDiffSource.sha256,
    process.relation_pre_screen.source.relation_diff_sha256,
    'relation pre-screen relation diff digest drifted',
    'SOURCE_DIGEST_MISMATCH',
  );

  const waveARelationCheck = await validateWaveARelationScreen({
    screenPath: sourcePaths.wave_a_relation_screen,
    relationDiffPath: sourcePaths.wave_a_relation_diff,
  });
  assertEqual(
    {
      proposal_count: waveARelationCheck.proposal_count,
      pre_screen_pass_count: waveARelationCheck.pre_screen_pass_count,
      pre_screen_rejected_count: waveARelationCheck.pre_screen_rejected_count,
      human_admission_denominator: waveARelationCheck.human_admission_denominator,
      human_admitted_count: waveARelationCheck.human_admitted_count,
      final_relation_count: waveARelationCheck.final_relation_count,
    },
    {
      proposal_count: 8,
      pre_screen_pass_count: 5,
      pre_screen_rejected_count: 3,
      human_admission_denominator: 5,
      human_admitted_count: 5,
      final_relation_count: 5,
    },
    'Wave A relation screen summary drifted',
    'WAVE_A_RELATION_SCOPE_CHANGED',
  );

  const timing = validateTimingBoundary(process, waveAManifest, waveAMetrics);
  validateAudit(process);

  const verificationPathFromProcess = resolveRepositoryPath(
    process.verification.artifact,
    'process.verification.artifact',
  );
  assertEqual(
    verificationPathFromProcess,
    path.resolve(verificationPath),
    'requested verification source does not match the process artifact',
    'SOURCE_PATH_MISMATCH',
  );
  const verificationSource = await readJsonSource(verificationPathFromProcess, 'M5-10A process verification artifact');
  assertEqual(
    verificationSource.sha256,
    process.verification.sha256,
    'process verification digest drifted',
    'SOURCE_DIGEST_MISMATCH',
  );
  const verification = validateVerification(verificationSource.value, canonicalSnapshot);

  return {
    artifact_id: process.artifact_id,
    process_revision: process.process_revision,
    canonical_snapshot: canonicalSnapshot,
    sense_preflight: {
      boundary_ids: [...process.sense_preflight.boundary_ids],
      regression_case_count: senseRegression.sense_case_count,
      required_boundary_coverage: senseRegression.required_boundary_coverage,
    },
    relation_pre_screen: relationSummary,
    wave_a: {
      stage_id: stage.stage_id,
      gate_status: stage.gate_status,
      decision: stage.decision,
      next_stage_authorized: stage.next_stage_authorized,
      relation_screen: waveARelationCheck,
    },
    timing,
    verification,
    source_digests: {
      process_correction: processSource.sha256,
      verification: verificationSource.sha256,
      canonical_directory: loadedSources.canonical_directory.sha256,
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
  const result = await validateM5AProcess({
    processPath: args.process ?? DEFAULT_PROCESS_PATH,
    verificationPath: args.verification ?? DEFAULT_VERIFICATION_PATH,
    stagePath: args.stage ?? DEFAULT_WAVE_A_STAGE_PATH,
    planPath: args.plan ?? DEFAULT_PLAN_PATH,
  });
  if (args.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Validated ${result.process_revision}: ${result.sense_preflight.regression_case_count} sense regression case(s), ${result.relation_pre_screen.pre_screen_rejected_count} relation pre-screen rejection(s), canonical ${result.canonical_snapshot.start_count} start(s), and Wave A2-only scope.`,
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

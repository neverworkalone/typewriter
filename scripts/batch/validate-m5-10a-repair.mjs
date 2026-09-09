import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  DEFAULT_PROCESS_PATH,
  validateM5AProcess,
} from './validate-m5-10a-process.mjs';
import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const AUTHORIZATION_SCHEMA = require('../../schema/m5-10a-repair-authorization.schema.json');
const authorizationSchemaValidator = new Ajv2020({ allErrors: true }).compile(AUTHORIZATION_SCHEMA);

export const DEFAULT_AUTHORIZATION_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-repair-authorization.json',
);

const EXPECTED_CANONICAL_SNAPSHOT = Object.freeze({
  record_count: 620,
  start_count: 578,
  reference_only_count: 42,
  sense_count: 743,
  relation_count: 467,
  expression_count: 39,
});

const EXPECTED_RELATION_REGRESSION_KEYS = Object.freeze([
  'proposal_count',
  'pre_screened_count',
  'pre_screen_pass_count',
  'pre_screen_rejected_count',
  'human_admission_denominator',
  'human_admission_reviewed_count',
  'human_admitted_count',
  'human_rejected_count',
  'final_relation_count',
]);

export class M5ARepairValidationError extends Error {
  constructor(message, code = 'M5A_REPAIR_VALIDATION_ERROR') {
    super(message);
    this.name = 'M5ARepairValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5A_REPAIR_VALIDATION_ERROR') {
  throw new M5ARepairValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function assertCondition(condition, message, code = 'M5A_REPAIR_VALIDATION_ERROR') {
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

function validateSchema(value) {
  if (authorizationSchemaValidator(value)) return;
  const error = authorizationSchemaValidator.errors?.[0];
  fail(
    error
      ? `M5-10A repair authorization schema validation failed at ${schemaErrorPath(error, 'authorization')} ${error.message}`
      : 'M5-10A repair authorization schema validation failed',
    'SCHEMA_ERROR',
  );
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
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

function resolveRepositoryPath(sourcePath, label) {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    fail(`${label} must be a non-empty path`, 'SOURCE_PATH_MISMATCH');
  }
  const resolved = path.resolve(REPOSITORY_DIRECTORY, sourcePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain inside the repository`, 'SOURCE_PATH_MISMATCH');
  }
  return resolved;
}

function validateAudit(authorization) {
  assertEqual(authorization.audit.status, 'complete', 'repair audit is not complete', 'AUDIT_INCOMPLETE');
  assertEqual(authorization.audit.independent, true, 'repair audit is not independent', 'AUDIT_NOT_INDEPENDENT');
  assertEqual(authorization.audit.open_blocker_count, 0, 'repair audit has an open blocker', 'OPEN_AUDIT_BLOCKER');
  const findingIds = authorization.audit.findings.map(({ id }) => id);
  assertEqual(new Set(findingIds).size, findingIds.length, 'repair audit findings contain duplicate IDs', 'DUPLICATE_AUDIT_FINDING');
  assertCondition(
    authorization.audit.findings.every(({ status }) => status === 'closed'),
    'repair audit contains an open finding',
    'OPEN_AUDIT_FINDING',
  );
}

function validateScope(authorization, processResult) {
  assertEqual(
    authorization.process_revision,
    'm5-10a-process-correction-v1',
    'repair authorization process revision drifted',
    'PROCESS_REVISION_MISMATCH',
  );
  assertEqual(
    authorization.canonical_snapshot,
    EXPECTED_CANONICAL_SNAPSHOT,
    'repair authorization canonical snapshot changed',
    'CANONICAL_SCOPE_CHANGED',
  );
  assertEqual(
    authorization.canonical_snapshot,
    processResult.canonical_snapshot,
    'repair authorization canonical snapshot does not match process correction',
    'CANONICAL_SCOPE_CHANGED',
  );
  assertEqual(
    authorization.authorization,
    {
      target_issue: 96,
      target_wave: 'wave-a2-plus-50-validation',
      base_start_count: 578,
      net_start_increase: 50,
      cumulative_start_target: 628,
      max_net_start_increase: 50,
      candidate_buffer_policy: 'declare-before-selection',
      canonical_mutation: false,
      wave_a2_authorized: true,
      wave_b_net_start_increase: 150,
      wave_b_authorized: false,
      requires_wave_a2_pass_before_wave_b: true,
    },
    'repair authorization scope drifted',
    'AUTHORIZATION_SCOPE_MISMATCH',
  );
  assertEqual(
    authorization.decision,
    'AUTHORIZE ONLY WAVE A2',
    'repair authorization decision drifted',
    'AUTHORIZATION_DECISION_MISMATCH',
  );
}

function validateFailedStage(authorization, stage, processResult) {
  assertEqual(stage.stage_id, authorization.failed_stage.stage_id, 'failed stage ID drifted', 'FAILED_STAGE_MISMATCH');
  assertEqual(stage.gate_status, 'fail', 'repair authorization must point to a failed stage', 'FAILED_STAGE_GATE_MISMATCH');
  assertEqual(stage.decision, 'HOLD PROCESS', 'repair authorization must preserve HOLD PROCESS', 'FAILED_STAGE_DECISION_MISMATCH');
  assertEqual(stage.next_stage_authorized, false, 'failed stage must not authorize a next stage', 'FAILED_STAGE_AUTHORIZATION_MISMATCH');
  assertEqual(stage.actual?.canonical_snapshot, authorization.failed_stage.canonical_snapshot, 'failed stage snapshot drifted', 'FAILED_STAGE_SNAPSHOT_MISMATCH');
  assertEqual(stage.actual?.canonical_snapshot, processResult.canonical_snapshot, 'failed stage snapshot does not match process correction', 'CANONICAL_SCOPE_CHANGED');
  assertEqual(
    authorization.failed_stage.failure_metrics,
    {
      relation_noise_candidate_count: stage.metrics.relation_noise_candidate_count,
      relation_noise_rate_of_candidates: stage.metrics.relation_noise_rate_of_candidates,
      editor_seconds_per_processed_start: stage.metrics.editor_seconds_per_selected_start,
    },
    'failed stage gate metrics drifted',
    'FAILED_STAGE_METRIC_MISMATCH',
  );
}

function validateRelationRegression(authorization, processResult) {
  const expected = Object.fromEntries(
    EXPECTED_RELATION_REGRESSION_KEYS.map((key) => [key, processResult.relation_pre_screen[key]]),
  );
  assertEqual(
    Object.fromEntries(EXPECTED_RELATION_REGRESSION_KEYS.map((key) => [key, authorization.relation_regression[key]])),
    expected,
    'repair authorization relation denominator drifted',
    'RELATION_REGRESSION_DRIFT',
  );
  assertEqual(
    authorization.relation_regression.failure_category_counts,
    processResult.relation_pre_screen.failure_category_counts,
    'repair authorization relation failure categories drifted',
    'RELATION_REGRESSION_DRIFT',
  );
}

function validateCandidateGeneration(authorization, processResult) {
  assertEqual(
    authorization.candidate_generation,
    processResult.candidate_generation,
    'repair authorization candidate-generation gate drifted',
    'CALIBRATION_GATE_MISMATCH',
  );
  assertEqual(
    authorization.candidate_generation.fixed_gate_status,
    'passed',
    'repair authorization cannot derive from a failed calibration gate',
    'CALIBRATION_GATE_FAILURE',
  );
}

function validateTimingContract(authorization, process) {
  assertEqual(
    authorization.timing_contract,
    {
      contract_version: process.timing_boundary.contract_version,
      required_passes: process.timing_boundary.required_passes,
      follow_up_passes: process.timing_boundary.follow_up_passes,
      duration_source: process.timing_boundary.duration_source,
      feedback_timestamp_source: process.timing_boundary.feedback_timestamp_source,
      unmeasured_result: process.timing_boundary.unmeasured_result,
      machine_validation_excluded_from_editor_seconds: process.timing_boundary.machine_validation.editor_seconds_included === false,
    },
    'repair authorization timing contract drifted',
    'TIMING_CONTRACT_MISMATCH',
  );
}

export async function validateM5ARepair({
  authorizationPath = DEFAULT_AUTHORIZATION_PATH,
  processPath = DEFAULT_PROCESS_PATH,
} = {}) {
  const resolvedAuthorizationPath = path.resolve(authorizationPath);
  const authorizationSource = await readJsonSource(
    resolvedAuthorizationPath,
    'M5-10A repair authorization artifact',
  );
  validateSchema(authorizationSource.value);
  const authorization = authorizationSource.value;
  validateAudit(authorization);

  const processPathFromAuthorization = resolveRepositoryPath(
    authorization.source.process_correction,
    'authorization.source.process_correction',
  );
  assertEqual(
    processPathFromAuthorization,
    path.resolve(processPath),
    'repair authorization process path does not match the requested source',
    'SOURCE_PATH_MISMATCH',
  );
  assertEqual(
    authorization.source.failed_stage_report,
    'data/batches/m5-9a-wave-a-plus-50.json',
    'repair authorization failed-stage path drifted',
    'SOURCE_PATH_MISMATCH',
  );
  const failedStagePath = resolveRepositoryPath(
    authorization.source.failed_stage_report,
    'authorization.source.failed_stage_report',
  );
  const failedStageSource = await readJsonSource(failedStagePath, 'failed Wave A stage report');
  assertEqual(
    failedStageSource.sha256,
    authorization.source.failed_stage_report_sha256,
    'failed stage source digest does not match repair authorization',
    'SOURCE_DIGEST_MISMATCH',
  );
  const processResult = await validateM5AProcess({ processPath });
  const processSource = await readJsonSource(path.resolve(processPath), 'M5-10A process correction artifact');
  assertEqual(
    processSource.sha256,
    authorization.source.process_correction_sha256,
    'process correction digest does not match repair authorization',
    'SOURCE_DIGEST_MISMATCH',
  );
  assertEqual(
    processResult.process_revision,
    authorization.process_revision,
    'process revision does not match repair authorization',
    'PROCESS_REVISION_MISMATCH',
  );

  validateFailedStage(authorization, failedStageSource.value, processResult);
  validateScope(authorization, processResult);
  validateRelationRegression(authorization, processResult);
  validateCandidateGeneration(authorization, processResult);
  validateTimingContract(authorization, processSource.value);

  return {
    authorization_id: authorization.authorization_id,
    process_revision: authorization.process_revision,
    failed_stage: {
      stage_id: authorization.failed_stage.stage_id,
      gate_status: authorization.failed_stage.gate_status,
      decision: authorization.failed_stage.decision,
    },
    canonical_snapshot: authorization.canonical_snapshot,
    relation_regression: authorization.relation_regression,
    candidate_generation: authorization.candidate_generation,
    authorization: authorization.authorization,
    source_digests: {
      authorization: authorizationSource.sha256,
      process_correction: processSource.sha256,
      failed_stage_report: failedStageSource.sha256,
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
  const result = await validateM5ARepair({
    authorizationPath: args.authorization ?? DEFAULT_AUTHORIZATION_PATH,
    processPath: args.process ?? DEFAULT_PROCESS_PATH,
  });
  if (args.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Validated ${result.authorization_id}: canonical scope remains ${result.canonical_snapshot.start_count} start(s); only Wave A2 +50 is authorized and Wave B +150 remains blocked.`,
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

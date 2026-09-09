import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';
import { validateRelationScreen } from './relation-screen.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPAIR_AUTHORIZATION_SCHEMA = require('../../schema/m5-9-repair-authorization.schema.json');
const M5_10A_REPAIR_AUTHORIZATION_SCHEMA = require('../../schema/m5-10a-repair-authorization.schema.json');
const repairAuthorizationSchemaValidator = new Ajv2020({ allErrors: true }).compile(REPAIR_AUTHORIZATION_SCHEMA);
const m5A10RepairAuthorizationSchemaValidator = new Ajv2020({ allErrors: true }).compile(M5_10A_REPAIR_AUTHORIZATION_SCHEMA);

export const DEFAULT_REPAIR_AUTHORIZATION_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-9a-repair-authorization.json',
);

export const DEFAULT_FAILED_STAGE_PATH = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-8-stage-01-plus-100.json',
);

export class RepairAuthorizationValidationError extends Error {
  constructor(message, code = 'REPAIR_AUTHORIZATION_VALIDATION_ERROR') {
    super(message);
    this.name = 'RepairAuthorizationValidationError';
    this.code = code;
  }
}

function fail(message, code = 'REPAIR_AUTHORIZATION_VALIDATION_ERROR') {
  throw new RepairAuthorizationValidationError(message, code);
}

function schemaErrorPath(error) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') pathParts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') pathParts.push(error.params.additionalProperty);
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    'repairAuthorization',
  );
}

function validateSchema(authorization) {
  if (repairAuthorizationSchemaValidator(authorization)) return;
  const error = repairAuthorizationSchemaValidator.errors?.[0];
  fail(
    error
      ? `repair authorization schema validation failed at ${schemaErrorPath(error)} ${error.message}`
      : 'repair authorization schema validation failed',
    'SCHEMA_ERROR',
  );
}

function validateM5A10ASchema(authorization) {
  if (m5A10RepairAuthorizationSchemaValidator(authorization)) return;
  const error = m5A10RepairAuthorizationSchemaValidator.errors?.[0];
  fail(
    error
      ? `M5-10A repair authorization schema validation failed at ${schemaErrorPath(error)} ${error.message}`
      : 'M5-10A repair authorization schema validation failed',
    'SCHEMA_ERROR',
  );
}

function assertEqual(actual, expected, message, code = 'SOURCE_BINDING_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function resolveRepositoryPath(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    fail(`${label} must be a non-empty path`, 'SOURCE_PATH_MISMATCH');
  }
  return path.resolve(REPOSITORY_DIRECTORY, relativePath);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function readJsonFile(filePath, label) {
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

const EXPECTED_CANONICAL_SNAPSHOT = Object.freeze({
  record_count: 570,
  start_count: 528,
  reference_only_count: 42,
  sense_count: 670,
  relation_count: 462,
  expression_count: 37,
});

const EXPECTED_FAILED_STAGE_SNAPSHOT = Object.freeze({
  ...EXPECTED_CANONICAL_SNAPSHOT,
});

function validateFailedStage(authorization, failedStage) {
  if (!failedStage || typeof failedStage !== 'object') {
    fail('failed stage report must be loaded before repair authorization validation', 'MISSING_FAILED_STAGE');
  }
  assertEqual(failedStage.stage_id, authorization.failed_stage.stage_id, 'failed stage ID drifted', 'FAILED_STAGE_MISMATCH');
  assertEqual(failedStage.gate_status, 'fail', 'repair authorization must point to a failed stage', 'FAILED_STAGE_GATE_MISMATCH');
  assertEqual(failedStage.decision, 'HOLD PROCESS', 'repair authorization must preserve HOLD PROCESS', 'FAILED_STAGE_DECISION_MISMATCH');
  assertEqual(
    failedStage.next_stage_authorized,
    false,
    'failed stage must not authorize its next stage',
    'FAILED_STAGE_AUTHORIZATION_MISMATCH',
  );
  assertEqual(
    failedStage.actual?.canonical_snapshot,
    authorization.failed_stage.canonical_snapshot,
    'failed stage snapshot drifted in repair authorization',
    'FAILED_STAGE_SNAPSHOT_MISMATCH',
  );
  assertEqual(
    authorization.failed_stage.canonical_snapshot,
    EXPECTED_FAILED_STAGE_SNAPSHOT,
    'repair authorization must preserve the M5-9 failed-stage snapshot',
    'CANONICAL_SNAPSHOT_MISMATCH',
  );
}

function validateM5A10AFailedStage(authorization, failedStage) {
  if (!failedStage || typeof failedStage !== 'object') {
    fail('failed stage report must be loaded before repair authorization validation', 'MISSING_FAILED_STAGE');
  }
  assertEqual(failedStage.stage_id, authorization.failed_stage.stage_id, 'failed stage ID drifted', 'FAILED_STAGE_MISMATCH');
  assertEqual(failedStage.gate_status, 'fail', 'repair authorization must point to a failed stage', 'FAILED_STAGE_GATE_MISMATCH');
  assertEqual(failedStage.decision, 'HOLD PROCESS', 'repair authorization must preserve HOLD PROCESS', 'FAILED_STAGE_DECISION_MISMATCH');
  assertEqual(
    failedStage.next_stage_authorized,
    false,
    'failed stage must not authorize its next stage',
    'FAILED_STAGE_AUTHORIZATION_MISMATCH',
  );
  assertEqual(
    failedStage.actual?.canonical_snapshot,
    authorization.failed_stage.canonical_snapshot,
    'failed stage snapshot drifted in M5-10A repair authorization',
    'FAILED_STAGE_SNAPSHOT_MISMATCH',
  );
  assertEqual(
    authorization.failed_stage.canonical_snapshot,
    authorization.canonical_snapshot,
    'M5-10A repair authorization snapshots are inconsistent',
    'CANONICAL_SNAPSHOT_MISMATCH',
  );
}

function validateRelationRegression(authorization, relationSummary) {
  if (!relationSummary || typeof relationSummary !== 'object') {
    fail('relation screen summary is required', 'MISSING_RELATION_REGRESSION');
  }
  const expected = authorization.relation_regression;
  for (const key of [
    'proposal_count',
    'pre_screened_count',
    'pre_screen_pass_count',
    'pre_screen_rejected_count',
    'human_admission_denominator',
    'human_admission_reviewed_count',
    'human_admitted_count',
    'human_rejected_count',
    'final_relation_count',
  ]) {
    assertEqual(relationSummary[key], expected[key], `relation regression ${key} drifted`, 'RELATION_REGRESSION_DRIFT');
  }
  assertEqual(
    relationSummary.failure_category_counts,
    expected.failure_category_counts,
    'relation regression failure categories drifted',
    'RELATION_REGRESSION_DRIFT',
  );
}

function validateAudit(authorization) {
  const findingIds = authorization.audit.findings.map(({ id }) => id);
  if (new Set(findingIds).size !== findingIds.length) {
    fail('repair authorization audit findings contain duplicate IDs', 'DUPLICATE_AUDIT_FINDING');
  }
  if (authorization.audit.findings.some(({ status }) => status !== 'closed')) {
    fail('repair authorization cannot contain an open audit finding', 'OPEN_AUDIT_FINDING');
  }
  assertEqual(authorization.audit.status, 'complete', 'repair audit is not complete', 'AUDIT_INCOMPLETE');
  assertEqual(authorization.audit.independent, true, 'repair audit is not independent', 'AUDIT_NOT_INDEPENDENT');
  assertEqual(authorization.audit.open_blocker_count, 0, 'repair audit has an open blocker', 'OPEN_AUDIT_BLOCKER');
}

function validateAuthorizationScope(authorization) {
  assertEqual(
    authorization.process_revision,
    'm5-9a-relation-admission-v1',
    'repair authorization process revision drifted',
    'PROCESS_REVISION_MISMATCH',
  );
  assertEqual(
    authorization.canonical_snapshot,
    EXPECTED_CANONICAL_SNAPSHOT,
    'repair authorization canonical snapshot changed',
    'CANONICAL_SNAPSHOT_MISMATCH',
  );
  assertEqual(
    authorization.authorization,
    {
      target_issue: 96,
      target_wave: 'wave-a-plus-50-validation',
      base_start_count: 528,
      net_start_increase: 50,
      cumulative_start_target: 578,
      max_net_start_increase: 50,
      canonical_mutation: false,
      bulk_250_authorized: false,
      wave_b_authorized: false,
    },
    'repair authorization scope drifted',
    'AUTHORIZATION_SCOPE_MISMATCH',
  );
  assertEqual(
    authorization.decision,
    'AUTHORIZE FIRST 50-START VALIDATION WAVE',
    'repair authorization decision drifted',
    'AUTHORIZATION_DECISION_MISMATCH',
  );
}

export function validateRepairAuthorization(
  authorization,
  {
    failedStage,
    failedStagePath,
    failedStageSha256,
    relationScreen,
    relationScreenPath,
    relationScreenSha256,
    relationSummary,
  } = {},
) {
  validateSchema(authorization);
  validateAuthorizationScope(authorization);
  validateAudit(authorization);

  const expectedFailedStagePath = resolveRepositoryPath(
    authorization.source.failed_stage_report,
    'repairAuthorization.source.failed_stage_report',
  );
  const expectedRelationScreenPath = resolveRepositoryPath(
    authorization.source.relation_screen,
    'repairAuthorization.source.relation_screen',
  );
  if (failedStagePath !== undefined) {
    assertEqual(
      path.resolve(failedStagePath),
      expectedFailedStagePath,
      'failed stage source path does not match repair authorization',
      'SOURCE_PATH_MISMATCH',
    );
  }
  if (failedStageSha256 !== undefined) {
    assertEqual(
      failedStageSha256,
      authorization.source.failed_stage_report_sha256,
      'failed stage source digest does not match repair authorization',
      'SOURCE_DIGEST_MISMATCH',
    );
  }
  if (relationScreenPath !== undefined) {
    assertEqual(
      path.resolve(relationScreenPath),
      expectedRelationScreenPath,
      'relation screen source path does not match repair authorization',
      'SOURCE_PATH_MISMATCH',
    );
  }
  if (relationScreenSha256 !== undefined) {
    assertEqual(
      relationScreenSha256,
      authorization.source.relation_screen_sha256,
      'relation screen source digest does not match repair authorization',
      'SOURCE_DIGEST_MISMATCH',
    );
  }

  validateFailedStage(authorization, failedStage);
  if (relationScreen !== undefined) {
    assertEqual(
      relationScreen.process_revision,
      authorization.process_revision,
      'relation screen process revision does not match repair authorization',
      'PROCESS_REVISION_MISMATCH',
    );
  }
  validateRelationRegression(authorization, relationSummary);

  return {
    authorization_id: authorization.authorization_id,
    process_revision: authorization.process_revision,
    failed_stage_id: authorization.failed_stage.stage_id,
    canonical_snapshot: { ...authorization.canonical_snapshot },
    relation_regression: { ...relationSummary },
    target_wave: authorization.authorization.target_wave,
    net_start_increase: authorization.authorization.net_start_increase,
    cumulative_start_target: authorization.authorization.cumulative_start_target,
    decision: authorization.decision,
  };
}

export async function loadAndValidateRepairAuthorization({
  authorizationPath,
  authorizationSha256,
  failedStage,
  failedStagePath,
  failedStageSha256,
} = {}) {
  if (!authorizationPath) fail('authorizationPath is required', 'MISSING_AUTHORIZATION_PATH');
  const authorizationSource = await readJsonFile(authorizationPath, 'repair authorization');
  if (authorizationSha256 !== undefined) {
    if (authorizationSource.sha256 !== authorizationSha256) {
      fail(
        `repair authorization digest ${authorizationSource.sha256} does not match ${authorizationSha256}`,
        'AUTHORIZATION_DIGEST_MISMATCH',
      );
    }
  }
  const authorization = authorizationSource.value;
  if (authorization.process_revision === 'm5-10a-process-correction-v1') {
    validateM5A10ASchema(authorization);
    const expectedFailedStagePath = resolveRepositoryPath(
      authorization.source.failed_stage_report,
      'M5-10A repairAuthorization.source.failed_stage_report',
    );
    if (failedStagePath !== undefined) {
      assertEqual(
        path.resolve(failedStagePath),
        expectedFailedStagePath,
        'M5-10A failed stage source path does not match repair authorization',
        'SOURCE_PATH_MISMATCH',
      );
    }
    if (failedStageSha256 !== undefined) {
      assertEqual(
        failedStageSha256,
        authorization.source.failed_stage_report_sha256,
        'M5-10A failed stage source digest does not match repair authorization',
        'SOURCE_DIGEST_MISMATCH',
      );
    }
    const processPath = resolveRepositoryPath(
      authorization.source.process_correction,
      'M5-10A repairAuthorization.source.process_correction',
    );
    const processSource = await readJsonFile(processPath, 'M5-10A process correction source');
    assertEqual(
      processSource.sha256,
      authorization.source.process_correction_sha256,
      'M5-10A process correction source digest does not match repair authorization',
      'SOURCE_DIGEST_MISMATCH',
    );
    validateM5A10AFailedStage(authorization, failedStage);
    return {
      authorization_id: authorization.authorization_id,
      process_revision: authorization.process_revision,
      failed_stage_id: authorization.failed_stage.stage_id,
      canonical_snapshot: { ...authorization.canonical_snapshot },
      relation_regression: { ...authorization.relation_regression },
      target_wave: authorization.authorization.target_wave,
      net_start_increase: authorization.authorization.net_start_increase,
      cumulative_start_target: authorization.authorization.cumulative_start_target,
      decision: authorization.decision,
    };
  }
  validateSchema(authorization);

  const relationScreenPath = resolveRepositoryPath(
    authorization.source.relation_screen,
    'repairAuthorization.source.relation_screen',
  );
  const relationDiffPath = resolveRepositoryPath(
    authorization.source.relation_screen === 'data/batches/m5-9a-relation-screen.json'
      ? 'data/batches/m5-9-expansion-relation-diff.json'
      : '',
    'relation screen source relation diff',
  );
  const [relationScreenSource, relationDiffSource] = await Promise.all([
    readJsonFile(relationScreenPath, 'relation screen artifact'),
    readJsonFile(relationDiffPath, 'relation diff artifact'),
  ]);
  if (relationScreenSource.sha256 !== authorization.source.relation_screen_sha256) {
    fail('relation screen digest does not match repair authorization', 'SOURCE_DIGEST_MISMATCH');
  }
  if (relationScreenSource.value.source.relation_diff !== 'data/batches/m5-9-expansion-relation-diff.json') {
    fail('relation screen is bound to an unexpected relation diff', 'SOURCE_PATH_MISMATCH');
  }
  if (relationDiffSource.sha256 !== relationScreenSource.value.source.relation_diff_sha256) {
    fail('relation diff digest does not match relation screen', 'SOURCE_DIGEST_MISMATCH');
  }
  const relationSummary = validateRelationScreen(relationScreenSource.value, relationDiffSource.value);
  const result = validateRepairAuthorization(authorization, {
    failedStage,
    failedStagePath,
    failedStageSha256,
    relationScreen: relationScreenSource.value,
    relationScreenPath,
    relationScreenSha256: relationScreenSource.sha256,
    relationSummary,
  });
  return {
    ...result,
    authorization,
    authorization_sha256: authorizationSource.sha256,
    relation_screen: relationScreenSource.value,
    relation_screen_sha256: relationScreenSource.sha256,
    relation_summary: relationSummary,
  };
}

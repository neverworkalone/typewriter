import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PLAN_PATH,
  validateExpansionPlan,
  validateExpansionStage,
} from './validate-m5-8-process.mjs';
import {
  DEFAULT_REPAIR_AUTHORIZATION_PATH,
  loadAndValidateRepairAuthorization,
  sha256File,
} from './repair-authorization.mjs';
import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';

export const DEFAULT_STAGE_PATH = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-8-stage-01-plus-100.json',
);

class M59RepairValidationError extends Error {
  constructor(message, code = 'M59_REPAIR_VALIDATION_ERROR') {
    super(message);
    this.name = 'M59RepairValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M59_REPAIR_VALIDATION_ERROR') {
  throw new M59RepairValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'REPAIR_SOURCE_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_SOURCE_ARTIFACT');
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_SOURCE_JSON');
    throw error;
  }
  return value;
}

export async function validateM59Repair({
  authorizationPath = DEFAULT_REPAIR_AUTHORIZATION_PATH,
  stagePath = DEFAULT_STAGE_PATH,
  planPath = DEFAULT_PLAN_PATH,
} = {}) {
  const [authorization, stage, plan] = await Promise.all([
    readJson(path.resolve(authorizationPath), 'repair authorization'),
    readJson(path.resolve(stagePath), 'failed stage report'),
    readJson(path.resolve(planPath), 'M5-8 expansion plan'),
  ]);

  validateExpansionPlan(plan);
  const stageResult = await validateExpansionStage(stage, plan);
  assertEqual(stageResult.gate_status, 'fail', 'failed stage unexpectedly passed', 'FAILED_STAGE_GATE_MISMATCH');
  assertEqual(stage.decision, 'HOLD PROCESS', 'failed stage decision was changed', 'FAILED_STAGE_DECISION_MISMATCH');
  assertEqual(stage.next_stage_authorized, false, 'failed stage authorizes a next stage', 'FAILED_STAGE_AUTHORIZATION_MISMATCH');

  const actualStagePath = path.resolve(stagePath);
  const stageSha256 = await sha256File(actualStagePath);
  const result = await loadAndValidateRepairAuthorization({
    authorizationPath: path.resolve(authorizationPath),
    failedStage: stage,
    failedStagePath: actualStagePath,
    failedStageSha256: stageSha256,
  });
  assertEqual(
    result.authorization.source.failed_stage_report,
    path.relative(REPOSITORY_DIRECTORY, actualStagePath),
    'repair authorization failed-stage path is not repository-bound',
    'SOURCE_PATH_MISMATCH',
  );
  return {
    authorization_id: result.authorization_id,
    process_revision: result.process_revision,
    failed_stage: {
      stage_id: result.failed_stage_id,
      gate_status: stage.gate_status,
      decision: stage.decision,
    },
    relation_regression: result.relation_regression,
    canonical_snapshot: result.canonical_snapshot,
    authorization: {
      target_issue: result.authorization.authorization.target_issue,
      target_wave: result.target_wave,
      net_start_increase: result.net_start_increase,
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
  const result = await validateM59Repair({
    authorizationPath: args.authorization
      ? path.resolve(args.authorization)
      : DEFAULT_REPAIR_AUTHORIZATION_PATH,
    stagePath: args.stage ? path.resolve(args.stage) : DEFAULT_STAGE_PATH,
    planPath: args.plan ? path.resolve(args.plan) : DEFAULT_PLAN_PATH,
  });
  if (args.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Validated ${result.authorization_id}: ${result.relation_regression.pre_screen_rejected_count} pre-screen rejection(s), ${result.relation_regression.human_admitted_count} admitted relation(s), and a first-50-start authorization with no canonical mutation.`,
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

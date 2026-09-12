import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AUTHORIZATION_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_FAILED_STAGE_PATH,
  DEFAULT_FOLLOW_UP_SOURCE_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_REPAIR_REVISION_PATH,
  DEFAULT_RECOVERY_PATH,
  DEFAULT_WORKLOAD_PATH,
  M5_10D_PROCESS_REVISION,
  assertM5DRecoveryAuthorizable,
  validateM5DRecovery,
} from './validate-m5-10d-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readSource(filePath) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes) };
}

function sourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(filePath);
  return relative;
}

async function requireMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite pre-existing authorization: ${filePath}`);
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) throw new Error(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function buildM5DAuthorization({
  recoveryPath = DEFAULT_RECOVERY_PATH,
  workloadPath = DEFAULT_WORKLOAD_PATH,
  followUpSourcePath = DEFAULT_FOLLOW_UP_SOURCE_PATH,
  failedStagePath = DEFAULT_FAILED_STAGE_PATH,
  repairRevisionPath = DEFAULT_REPAIR_REVISION_PATH,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  outputPath = DEFAULT_AUTHORIZATION_PATH,
  recoveryOptions = {},
} = {}) {
  const recoveryResult = await validateM5DRecovery({ artifactPath: recoveryPath, workloadPath, followUpSourcePath, failedStagePath, repairRevisionPath, inventoryPath, canonicalDirectory, ...recoveryOptions });
  assertM5DRecoveryAuthorizable(recoveryResult);
  const [recoverySource, workloadSource, failedStageSource, repairSource, inventorySource] = await Promise.all([
    readSource(recoveryPath),
    readSource(workloadPath),
    readSource(failedStagePath),
    readSource(repairRevisionPath),
    readSource(inventoryPath),
  ]);
  await requireMissing(outputPath);
  const failedStage = failedStageSource.value;
  const authorization = {
    schema_version: '1',
    authorization_id: 'm5-10d-m5-11-authorization-20260912',
    issue: 115,
    parent_issue: 7,
    target_issue: 97,
    process_revision: M5_10D_PROCESS_REVISION,
    decision: 'AUTHORIZE M5-11 +500 VALIDATION',
    canonical_mutation: false,
    source: {
      recovery_artifact: sourcePath(recoveryPath),
      recovery_artifact_sha256: recoverySource.sha256,
      workload: sourcePath(workloadPath),
      workload_sha256: workloadSource.sha256,
      canonical_directory: sourcePath(canonicalDirectory),
      canonical_directory_sha256: await hashCanonicalDirectory(canonicalDirectory),
      inventory: sourcePath(inventoryPath),
      inventory_sha256: inventorySource.sha256,
      repair_revision: sourcePath(repairRevisionPath),
      repair_revision_sha256: repairSource.sha256,
    },
    failed_stage: {
      path: sourcePath(failedStagePath),
      sha256: failedStageSource.sha256,
      gate_status: failedStage.gate_status,
      decision: failedStage.decision,
      next_stage_authorized: failedStage.next_stage_authorized,
      start_count: failedStage.actual.canonical_snapshot.start_count,
    },
    target: {
      base_start_count: 778,
      net_start_increase: 500,
      cumulative_start_target: 1278,
      candidate_data_created: false,
    },
    created_at: new Date().toISOString(),
    note: 'M5-10D passed its source-derived workload gate. This artifact authorizes only the separate M5-11 #97 +500 validation task; it creates no candidate or canonical data.',
  };
  const bytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`, 'utf8');
  await writeFile(outputPath, bytes);
  console.log(JSON.stringify({ output: sourcePath(outputPath), sha256: sha256(bytes), decision: authorization.decision }, null, 2));
  return authorization;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildM5DAuthorization({
    ...(args.recovery ? { recoveryPath: path.resolve(args.recovery) } : {}),
    ...(args.workload ? { workloadPath: path.resolve(args.workload) } : {}),
    ...(args['follow-up-source'] ? { followUpSourcePath: path.resolve(args['follow-up-source']) } : {}),
    ...(args['failed-stage'] ? { failedStagePath: path.resolve(args['failed-stage']) } : {}),
    ...(args['repair-revision'] ? { repairRevisionPath: path.resolve(args['repair-revision']) } : {}),
    ...(args.inventory ? { inventoryPath: path.resolve(args.inventory) } : {}),
    ...(args['canonical-dir'] ? { canonicalDirectory: path.resolve(args['canonical-dir']) } : {}),
    ...(args.output ? { outputPath: path.resolve(args.output) } : {}),
  }).catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

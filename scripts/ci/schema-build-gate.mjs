import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runM2Pipeline } from '../verify/m2-pipeline.mjs';
import { validateSharedDictionary } from './validate-shared-dictionary.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const FULL_DICTIONARY_PATH = path.join(REPOSITORY_DIRECTORY, 'artifacts/dictionary.sqlite');

function assertCleanHead() {
  const status = execFileSync('git', [
    'status', '--porcelain=v1', '--untracked-files=all',
  ], {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (status) {
    throw new Error('The SQL schema build gate requires an exact, clean PR HEAD checkout.');
  }
}

async function runPnpm(script) {
  const childEnvironment = { ...process.env };
  delete childEnvironment.TYPEWRITER_SHARED_DICTIONARY_PATH;
  delete childEnvironment.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
  delete childEnvironment.TYPEWRITER_PROCESS_METRICS_PATH;
  delete childEnvironment.TYPEWRITER_CI_PHASE;
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['run', script], {
      cwd: REPOSITORY_DIRECTORY,
      env: childEnvironment,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm run ${script} exited with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

export async function runSchemaBuildGate() {
  assertCleanHead();
  const startedAt = performance.now();

  const releaseBuildStartedAt = performance.now();
  await runPnpm('build');
  const releaseBuildMs = Math.round((performance.now() - releaseBuildStartedAt) * 100) / 100;

  const fullValidationStartedAt = performance.now();
  const fullValidation = await validateSharedDictionary({
    databasePath: FULL_DICTIONARY_PATH,
  });
  const fullValidationMs = Math.round((performance.now() - fullValidationStartedAt) * 100) / 100;

  const reproducibilityStartedAt = performance.now();
  const reproducibility = await runM2Pipeline({
    repositoryDirectory: REPOSITORY_DIRECTORY,
    allowDirty: false,
    databaseMode: 'reproducible',
  });
  if (reproducibility.databaseBuilds !== 2
    || reproducibility.databaseVerification !== 'full-lite-reproducible') {
    throw new Error('The SQL schema gate did not complete both independent Full/Lite reproducibility builds.');
  }
  const reproducibilityMs = Math.round((performance.now() - reproducibilityStartedAt) * 100) / 100;

  const productValidationStartedAt = performance.now();
  await runPnpm('validate:product-outputs');
  const productValidationMs = Math.round((performance.now() - productValidationStartedAt) * 100) / 100;

  const summary = {
    contract_version: 'sqlite-schema-build-gate-v1',
    exact_head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    schema_owner_paths: ['scripts/build/sqlite-schema.mjs'],
    release_full_build_count: 1,
    reproducibility_full_build_count: reproducibility.databaseBuilds,
    total_current_canonical_full_build_count: 1 + reproducibility.databaseBuilds,
    lite_extractions: 2,
    full_dictionary_validation: fullValidation,
    reproducibility: {
      source_revision: reproducibility.sourceRevision,
      worktree_state: reproducibility.worktreeState,
      database_verification: reproducibility.databaseVerification,
    },
    wall_clock_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    stage_ms: {
      release_build: releaseBuildMs,
      full_dictionary_validation: fullValidationMs,
      full_lite_reproducibility: reproducibilityMs,
      product_output_validation: productValidationMs,
    },
  };
  console.log('\n=== SQL schema-only Full/Lite build evidence ===');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runSchemaBuildGate().catch((error) => {
    console.error(`SQL schema build gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}

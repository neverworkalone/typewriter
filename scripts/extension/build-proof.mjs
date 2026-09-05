import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CANONICAL_DIRECTORY } from '../validate/canonical-jsonl.mjs';
import { buildDictionary } from '../build/dictionary.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const PROOF_SOURCE_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'extension/mv3-proof',
);
const SQLITE_WASM_PACKAGE_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'node_modules/@sqlite.org/sqlite-wasm/dist',
);

export const DEFAULT_PROOF_OUTPUT_DIRECTORY = path.resolve(
  'dist/mv3-proof',
);

export async function buildProofPackage({
  inputDirectory = DEFAULT_CANONICAL_DIRECTORY,
  outputDirectory = DEFAULT_PROOF_OUTPUT_DIRECTORY,
  repositoryDirectory = REPOSITORY_DIRECTORY,
  allowDirty = false,
} = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  await rm(resolvedOutputDirectory, { recursive: true, force: true });
  await mkdir(path.join(resolvedOutputDirectory, 'vendor'), { recursive: true });

  const generatedDatabase = path.join(
    resolvedOutputDirectory,
    'dictionary.sqlite',
  );
  const buildSummary = await buildDictionary({
    inputDirectory,
    outputPath: generatedDatabase,
    checkPilotCompleteness: true,
    repositoryDirectory,
    allowDirty,
  });

  for (const filename of [
    'manifest.json',
    'proof.html',
    'proof.js',
    'proof-contract.mjs',
    'sqlite-worker.mjs',
    'THIRD-PARTY-NOTICES.txt',
    'Apache-2.0.txt',
  ]) {
    await cp(
      path.join(PROOF_SOURCE_DIRECTORY, filename),
      path.join(resolvedOutputDirectory, filename),
    );
  }

  await cp(
    path.join(SQLITE_WASM_PACKAGE_DIRECTORY, 'index.mjs'),
    path.join(resolvedOutputDirectory, 'vendor/sqlite3.mjs'),
  );
  await cp(
    path.join(SQLITE_WASM_PACKAGE_DIRECTORY, 'sqlite3.wasm'),
    path.join(resolvedOutputDirectory, 'vendor/sqlite3.wasm'),
  );

  return {
    outputDirectory: resolvedOutputDirectory,
    databasePath: generatedDatabase,
    ...buildSummary,
  };
}

export async function main() {
  const summary = await buildProofPackage({
    allowDirty: process.argv.includes('--allow-dirty'),
  });
  console.log(
    `Built MV3 proof package at ${summary.outputDirectory} with ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

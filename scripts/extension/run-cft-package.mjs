import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCftProduct } from './run-cft-product.mjs';
import { validatePackage } from '../validate-package.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_PACKAGE_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'dist');

function option(name, fallback = undefined) {
  const prefix = '--' + name + '=';
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function requireOption(name) {
  const value = option(name);
  if (!value) {
    throw new Error(`--${name}=... is required.`);
  }
  return value;
}

export async function runCftPackage({
  chromePath = undefined,
  packageDirectory = DEFAULT_PACKAGE_DIRECTORY,
  zipPath,
  port = 9230,
  projectRoot = REPOSITORY_DIRECTORY,
} = {}) {
  if (!zipPath) throw new Error('A generated package ZIP is required.');

  const resolvedPackageDirectory = path.resolve(packageDirectory);
  const resolvedZipPath = path.resolve(zipPath);
  const validation = validatePackage({
    projectRoot: path.resolve(projectRoot),
    packageDir: resolvedPackageDirectory,
    zipPath: resolvedZipPath,
  });
  if (validation.errors.length > 0) {
    throw new Error(`Package validation failed:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`);
  }

  const extractedDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-package-cft-'));
  try {
    execFileSync('unzip', ['-q', resolvedZipPath, '-d', extractedDirectory]);

    const unpackedSummary = await runCftProduct({
      chromePath,
      extensionDirectory: resolvedPackageDirectory,
      port,
    });
    const zipSummary = await runCftProduct({
      chromePath,
      extensionDirectory: extractedDirectory,
      port: port + 1,
    });

    return {
      zipPath: resolvedZipPath,
      unpacked: unpackedSummary,
      zip: zipSummary,
    };
  } finally {
    await rm(extractedDirectory, { recursive: true, force: true });
  }
}

export async function main() {
  const summary = await runCftPackage({
    chromePath: option('chrome'),
    packageDirectory: option('extension', DEFAULT_PACKAGE_DIRECTORY),
    zipPath: requireOption('zip'),
    port: Number(option('port', '9230')),
    projectRoot: option('project-root', REPOSITORY_DIRECTORY),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

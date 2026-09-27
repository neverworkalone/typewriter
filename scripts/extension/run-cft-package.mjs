import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCftProduct } from './run-cft-product.mjs';
import { validatePackage } from '../validate-package.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_PACKAGE_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'dist');
const FAILURE_SCENARIOS = Object.freeze([
  { name: 'missing-database', errorCode: 'ASSET_LOAD_FAILED' },
  { name: 'corrupt-database', errorCode: 'DATABASE_METADATA_INVALID' },
  { name: 'unreadable-database', errorCode: 'ASSET_LOAD_FAILED' },
  { name: 'schema-mismatch', errorCode: 'DATABASE_SCHEMA_MISMATCH' },
  { name: 'dictionary-version-mismatch', errorCode: 'DICTIONARY_VERSION_MISMATCH' },
  { name: 'revision-mismatch', errorCode: 'DICTIONARY_REVISION_MISMATCH' },
  { name: 'incomplete-database', errorCode: 'DATABASE_METADATA_INVALID' },
]);

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

function incrementPatchVersion(version) {
  const components = String(version).split('.').map(Number);
  if (components.length < 2 || components.length > 3 || components.some((part) => !Number.isInteger(part))) {
    throw new Error(`Unsupported Chrome manifest version: ${JSON.stringify(version)}.`);
  }
  while (components.length < 3) components.push(0);
  components[2] += 1;
  return components.join('.');
}

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function prepareVersionedUpdatePackage(sourceDirectory, previousDirectory, destinationDirectory) {
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
  const previousManifest = JSON.parse(await readFile(path.join(previousDirectory, 'manifest.json'), 'utf8'));
  const updateManifestPath = path.join(destinationDirectory, 'manifest.json');
  const updateManifest = JSON.parse(await readFile(updateManifestPath, 'utf8'));
  if (compareVersions(updateManifest.version, previousManifest.version) <= 0) {
    updateManifest.version = incrementPatchVersion(previousManifest.version);
    await writeFile(updateManifestPath, `${JSON.stringify(updateManifest, null, 2)}\n`);
  }
  return updateManifest.version;
}

async function createFailureFixture(sourceDirectory, fixtureDirectory, name) {
  await cp(sourceDirectory, fixtureDirectory, { recursive: true });
  const databasePath = path.join(fixtureDirectory, 'dictionary.sqlite');
  if (name === 'missing-database') {
    await rm(databasePath);
    return;
  }
  if (name === 'corrupt-database') {
    await writeFile(databasePath, Buffer.from('not a SQLite database'));
    return;
  }
  if (name === 'unreadable-database') {
    await chmod(databasePath, 0);
    return;
  }

  const database = new DatabaseSync(databasePath);
  try {
    if (name === 'schema-mismatch') {
      database.exec('PRAGMA user_version = 3');
    } else if (name === 'dictionary-version-mismatch') {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'dictionary_version'")
        .run('future-version');
    } else if (name === 'revision-mismatch') {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'source_revision'")
        .run('0'.repeat(40));
    } else if (name === 'incomplete-database') {
      database.prepare(`
        DELETE FROM relations
        WHERE source_sense_id IN (SELECT id FROM senses WHERE record_id = 'w026')
          OR target_record_id = 'w026'
      `).run();
      database.prepare("DELETE FROM records WHERE id = 'w026'").run();
    } else {
      throw new Error(`Unknown failure fixture: ${name}.`);
    }
  } finally {
    database.close();
  }
}

export async function runCftPackage({
  chromePath = undefined,
  packageDirectory = DEFAULT_PACKAGE_DIRECTORY,
  zipPath,
  previousExtensionDirectory = undefined,
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

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'typewriter-package-cft-'));
  const extractedDirectory = path.join(temporaryRoot, 'zip');
  try {
    await mkdir(extractedDirectory, { recursive: true });
    execFileSync('unzip', ['-q', resolvedZipPath, '-d', extractedDirectory]);

    const unpackedSummary = await runCftProduct({
      chromePath,
      extensionDirectory: resolvedPackageDirectory,
      port,
    });
    let zipSummary;
    if (previousExtensionDirectory) {
      const previousSource = path.resolve(previousExtensionDirectory);
      const previousInstall = path.join(temporaryRoot, 'previous-install');
      const versionedUpdate = path.join(temporaryRoot, 'versioned-update');
      await cp(previousSource, previousInstall, { recursive: true });
      const simulatedManifestVersion = await prepareVersionedUpdatePackage(
        extractedDirectory,
        previousInstall,
        versionedUpdate,
      );
      zipSummary = await runCftProduct({
        chromePath,
        extensionDirectory: previousInstall,
        updateExtensionDirectory: versionedUpdate,
        port: port + 1,
      });
      zipSummary.simulatedManifestVersion = simulatedManifestVersion;
    } else {
      zipSummary = await runCftProduct({
        chromePath,
        extensionDirectory: extractedDirectory,
        port: port + 1,
      });
    }

    const failureSummaries = [];
    for (const [index, scenario] of FAILURE_SCENARIOS.entries()) {
      const fixtureDirectory = path.join(temporaryRoot, scenario.name);
      await createFailureFixture(resolvedPackageDirectory, fixtureDirectory, scenario.name);
      failureSummaries.push({
        scenario: scenario.name,
        ...(await runCftProduct({
          chromePath,
          extensionDirectory: fixtureDirectory,
          expectedLoadErrorCode: scenario.errorCode,
          port: port + index + 2,
        })),
      });
    }

    return {
      zipPath: resolvedZipPath,
      unpacked: unpackedSummary,
      zip: zipSummary,
      failures: failureSummaries,
    };
  } finally {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

export async function main() {
  const summary = await runCftPackage({
    chromePath: option('chrome'),
    packageDirectory: option('extension', DEFAULT_PACKAGE_DIRECTORY),
    zipPath: requireOption('zip'),
    previousExtensionDirectory: option('previous-extension'),
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

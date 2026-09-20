import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_CATEGORY_ORDER,
  REPOSITORY_DIRECTORY,
} from './registry.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const HISTORICAL_INPUT_SOURCES = Object.freeze({
  waveA2Reviewed: 'data/canonical/m5-10a-wave-a2.jsonl',
  waveA2SemanticAudit: 'data/validation/m5-10a-wave-a2-semantic-audit.json',
  waveBReviewed: 'data/canonical/m5-10-wave-b.jsonl',
  waveBSemanticAudit: 'data/validation/m5-10-wave-b-semantic-audit.json',
});

function formatCommand({ executable, args }) {
  return [executable, ...args]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

function runCommand({ executable, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPOSITORY_DIRECTORY,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${executable} exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
      ));
    });
  });
}

async function createTemporaryDirectory() {
  const requestedRoot = process.env.RUNNER_TEMP;
  const root = requestedRoot ? path.resolve(requestedRoot) : tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'typewriter-ci-'));
}

export async function materializeHistoricalInputs(tempDirectory) {
  const historicalInputs = {};
  for (const [name, relativeSource] of Object.entries(HISTORICAL_INPUT_SOURCES)) {
    const target = path.join(tempDirectory, path.basename(relativeSource));
    await copyFile(path.join(REPOSITORY_DIRECTORY, relativeSource), target);
    historicalInputs[name] = target;
    console.log(`Materialized ${relativeSource} -> ${target}`);
  }
  return historicalInputs;
}

async function contextForCategory(categoryName) {
  if (categoryName !== 'historical') {
    return { historicalInputs: undefined, temporaryDirectory: undefined };
  }

  const temporaryDirectory = await createTemporaryDirectory();
  const historicalInputs = await materializeHistoricalInputs(temporaryDirectory);
  return { historicalInputs, temporaryDirectory };
}

async function runCategory(categoryName) {
  const category = CI_CATEGORIES[categoryName];
  const context = await contextForCategory(categoryName);

  try {
    console.log(`\n=== ${category.label} [${categoryName}] ===`);
    let index = 0;
    while (index < category.checks.length) {
      const check = category.checks[index];
      const isNodeTestGroup = check.kind === 'node-test';
      const groupStart = index;
      const group = [];

      if (isNodeTestGroup) {
        while (index < category.checks.length && category.checks[index].kind === 'node-test') {
          group.push(category.checks[index]);
          index += 1;
        }
      } else {
        group.push(check);
        index += 1;
      }

      const command = group.length === 1
        ? group[0].command(context)
        : {
          executable: process.execPath,
          args: ['--test', ...group.flatMap(({ testFiles }) => testFiles)],
        };
      const groupEnd = index;
      const groupLabel = group.length === 1
        ? group[0].label
        : `Node test group (${group.length} checks)`;
      const checkRange = group.length === 1
        ? `${groupStart + 1}/${category.checks.length}`
        : `${groupStart + 1}-${groupEnd}/${category.checks.length}`;
      console.log(`\n--- ${checkRange}: ${groupLabel} ---`);
      if (group.length > 1) {
        for (const groupedCheck of group) {
          console.log(`  • ${groupedCheck.label}: ${groupedCheck.testFiles.join(', ')}`);
        }
      }
      console.log(`$ ${formatCommand(command)}`);
      await runCommand(command);
    }
    console.log(`\n=== ${categoryName} passed ===`);
  } finally {
    if (context.temporaryDirectory) {
      await rm(context.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function printUsage() {
  console.error('Usage: node scripts/ci/run-category.mjs <category|all>');
  console.error(`Categories: ${CI_CATEGORY_ORDER.join(', ')}`);
}

async function main() {
  const [requestedCategory] = process.argv.slice(2);
  if (requestedCategory === '--list') {
    for (const categoryName of CI_CATEGORY_ORDER) {
      console.log(`${categoryName}: ${CI_CATEGORIES[categoryName].label}`);
    }
    return;
  }

  if (!requestedCategory) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const categoryNames = requestedCategory === 'all'
    ? CI_CATEGORY_ORDER
    : [requestedCategory];
  if (categoryNames.some((categoryName) => !CI_CATEGORIES[categoryName])) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  for (const categoryName of categoryNames) {
    await runCategory(categoryName);
  }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`\nCI category failed: ${error.message}`);
    process.exitCode = 1;
  });
}

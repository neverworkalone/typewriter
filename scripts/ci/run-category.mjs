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
import { buildDictionary } from '../build/dictionary.mjs';
import {
  loadCanonicalContext,
  writeCanonicalContext,
} from '../validate/canonical-context.mjs';
import { auditCanonicalLexicalQuality } from '../validate/lexical-quality.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
} from '../validate/semantic-audit.mjs';

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

async function runCommand({ executable, args }, context = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = {
      ...process.env,
      ...(context.environment ?? {}),
    };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(executable, args, {
      cwd: REPOSITORY_DIRECTORY,
      env: childEnvironment,
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

export async function runChecks(
  checks,
  context,
  { execute = runCommand, log = console.log } = {},
) {
  for (const [index, check] of checks.entries()) {
    if (
      check.oncePerCanonicalSession
      && context?.completedChecks?.has(check.oncePerCanonicalSession)
    ) {
      log(`\n--- ${index + 1}/${checks.length}: ${check.label} (already run) ---`);
      continue;
    }
    const command = check.command(context);
    log(`\n--- ${index + 1}/${checks.length}: ${check.label} ---`);
    log(`$ ${formatCommand(command)}`);
    await execute(command, context);
    if (check.oncePerCanonicalSession && context?.completedChecks) {
      context.completedChecks.add(check.oncePerCanonicalSession);
    }
  }
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

async function createCanonicalSession() {
  const temporaryDirectory = await createTemporaryDirectory();
  const contextPath = path.join(temporaryDirectory, 'canonical-context.json');
  const canonicalContext = await loadCanonicalContext();
  const { artifact: semanticAudit, decisionSource } = await buildCanonicalSemanticAudit({
    canonicalContext,
  });
  canonicalContext.semanticAudit = semanticAudit;
  canonicalContext.semanticDecisionSource = decisionSource;
  canonicalContext.derived.topicEvidence = buildSemanticTopicEvidence(
    canonicalContext.records,
    semanticAudit,
  );
  canonicalContext.derived.lexicalQuality = auditCanonicalLexicalQuality(
    canonicalContext.records,
    {
      context: canonicalContext,
      topicEvidence: canonicalContext.derived.topicEvidence,
      scope: 'complete-canonical',
      throwOnError: false,
    },
  );
  await writeCanonicalContext(canonicalContext, contextPath);

  return {
    canonicalContext,
    completedChecks: new Set(),
    contextPath,
    temporaryDirectory,
    sharedDictionaryPath: undefined,
    environment: {
      TYPEWRITER_CANONICAL_CONTEXT_PATH: contextPath,
      TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY: canonicalContext.canonicalDirectory,
    },
  };
}

async function ensureSharedDictionary(session) {
  if (session.sharedDictionaryPath) {
    return session.sharedDictionaryPath;
  }

  const outputPath = path.join(session.temporaryDirectory, 'dictionary.sqlite');
  const summary = await buildDictionary({
    inputDirectory: session.canonicalContext.canonicalDirectory,
    outputPath,
    checkPilotCompleteness: true,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    allowDirty: process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
    canonicalContext: session.canonicalContext,
    semanticAudit: session.canonicalContext.semanticAudit,
  });
  session.sharedDictionaryPath = summary.outputPath;
  session.environment.TYPEWRITER_SHARED_DICTIONARY_PATH = summary.outputPath;
  await writeCanonicalContext(session.canonicalContext, session.contextPath);
  console.log(
    `Prepared shared SQLite artifact ${summary.outputPath} (build count ${session.canonicalContext.metrics.sqlite_build_count}).`,
  );
  return summary.outputPath;
}

async function contextForCategory(categoryName, sharedCanonicalSession) {
  const session = sharedCanonicalSession ?? await createCanonicalSession();
  const context = {
    ...session,
    historicalInputs: undefined,
    historicalTemporaryDirectory: undefined,
  };

  if (categoryName === 'historical') {
    context.historicalTemporaryDirectory = await createTemporaryDirectory();
    context.historicalInputs = await materializeHistoricalInputs(
      context.historicalTemporaryDirectory,
    );
  }

  return {
    context,
    ownsCanonicalSession: sharedCanonicalSession === undefined,
  };
}

async function runCategory(categoryName, sharedCanonicalSession) {
  const category = CI_CATEGORIES[categoryName];
  const {
    context,
    ownsCanonicalSession,
  } = await contextForCategory(categoryName, sharedCanonicalSession);

  try {
    if (categoryName === 'toolchain') {
      await ensureSharedDictionary(context);
    }
    console.log(`\n=== ${category.label} [${categoryName}] ===`);
    await runChecks(category.checks, context);
    console.log(`\n=== ${categoryName} passed ===`);
  } finally {
    if (context.historicalTemporaryDirectory) {
      await rm(context.historicalTemporaryDirectory, { recursive: true, force: true });
    }
    if (ownsCanonicalSession && context.temporaryDirectory) {
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

  const sharedCanonicalSession = await createCanonicalSession();
  try {
    for (const categoryName of categoryNames) {
      await runCategory(categoryName, sharedCanonicalSession);
    }
  } finally {
    await rm(sharedCanonicalSession.temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`\nCI category failed: ${error.message}`);
    process.exitCode = 1;
  });
}

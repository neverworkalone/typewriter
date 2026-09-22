import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_ALL_CATEGORY_ORDER,
  CI_LEVEL_CATEGORY_ORDER,
  REPOSITORY_DIRECTORY,
} from './registry.mjs';
import { buildDictionary } from '../build/dictionary.mjs';
import {
  contextSummary,
  loadCanonicalContext,
} from '../validate/canonical-context.mjs';
import { auditCanonicalLexicalQuality } from '../validate/lexical-quality.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
} from '../validate/semantic-audit.mjs';
import { normalizeCanonicalDirectory } from '../normalize/canonical.mjs';
import { runGlobalCanonicalAudit } from './global-canonical-audit.mjs';
import { validateSharedDictionary } from './validate-shared-dictionary.mjs';
import { runM2Pipeline } from '../verify/m2-pipeline.mjs';

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

function updateChildProcessMetrics(processMetrics) {
  if (!processMetrics?.path) {
    return;
  }

  let contents;
  try {
    contents = readFileSync(processMetrics.path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  let peakRssKb = 0;
  let processCount = 0;
  let sqliteBuildCount = 0;
  let currentRevisionSqliteBuildCount = 0;
  for (const line of contents.split('\n')) {
    if (!line) {
      continue;
    }
    const metrics = JSON.parse(line);
    if (metrics.type === 'sqlite-build') {
      const count = metrics.count ?? 1;
      sqliteBuildCount += count;
      if (metrics.canonical_revision === processMetrics.canonicalRevision) {
        currentRevisionSqliteBuildCount += count;
      }
      continue;
    }
    processCount += 1;
    peakRssKb = Math.max(peakRssKb, metrics.peak_rss_kb ?? 0);
  }
  processMetrics.childProcessCount = processCount;
  processMetrics.childPeakRssKb = peakRssKb;
  processMetrics.childSqliteBuildCount = sqliteBuildCount;
  processMetrics.childCurrentRevisionSqliteBuildCount = currentRevisionSqliteBuildCount;
}

function processMemorySummary(processMetrics) {
  const resourceUsage = process.resourceUsage?.();
  const parentPeakRssBytes = Number.isFinite(resourceUsage?.maxRSS)
    ? resourceUsage.maxRSS * 1024
    : process.memoryUsage().rss;
  const childPeakRssBytes = (processMetrics?.childPeakRssKb ?? 0) * 1024;
  const peakRssBytes = Math.max(parentPeakRssBytes, childPeakRssBytes);
  return {
    peak_rss_bytes: peakRssBytes,
    peak_rss_mb: Math.round((peakRssBytes / (1024 * 1024)) * 100) / 100,
    parent_peak_rss_mb: Math.round((parentPeakRssBytes / (1024 * 1024)) * 100) / 100,
    child_peak_rss_mb: Math.round((childPeakRssBytes / (1024 * 1024)) * 100) / 100,
    child_process_count: processMetrics?.childProcessCount ?? 0,
    child_sqlite_build_count: processMetrics?.childSqliteBuildCount ?? 0,
    child_current_revision_sqlite_build_count:
      processMetrics?.childCurrentRevisionSqliteBuildCount ?? 0,
  };
}

function printEvidence({
  contractVersion,
  level,
  categoryNames,
  startedAt,
  canonicalContext,
  processMetrics,
}) {
  const summary = contextSummary(canonicalContext);
  const parentSqliteBuildCount = summary.metrics.sqlite_build_count ?? 0;
  const childSqliteBuildCount = processMetrics?.childSqliteBuildCount ?? 0;
  const currentRevisionSqliteBuildCount = parentSqliteBuildCount
    + (processMetrics?.childCurrentRevisionSqliteBuildCount ?? 0);
  console.log(`\n=== ${level} evidence ===`);
  console.log(JSON.stringify({
    contract_version: contractVersion,
    level,
    category_order: categoryNames,
    wall_clock_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    canonical_revision: summary.canonical_revision,
    record_count: summary.recordCount,
    metrics: {
      ...summary.metrics,
      sqlite_build_count: currentRevisionSqliteBuildCount,
      current_revision_sqlite_build_count: currentRevisionSqliteBuildCount,
      child_sqlite_build_count: childSqliteBuildCount,
      all_sqlite_build_count: parentSqliteBuildCount + childSqliteBuildCount,
    },
    context_transport: {
      serialize_count: summary.metrics.canonical_context_serialize_count ?? 0,
      deserialize_count: summary.metrics.canonical_context_deserialize_count ?? 0,
      rehydrate_count: summary.metrics.canonical_context_rehydrate_count ?? 0,
    },
    process_memory: processMemorySummary(processMetrics),
  }, null, 2));
}

function isFastPrefix(categoryNames, completedCategoryCount) {
  return completedCategoryCount >= CI_LEVEL_CATEGORY_ORDER.fast.length
    && CI_LEVEL_CATEGORY_ORDER.fast.every(
      (categoryName, index) => categoryNames[index] === categoryName,
    );
}

async function runCommand({ executable, args }, context = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    if (context.processMetrics?.path) {
      childEnvironment.TYPEWRITER_PROCESS_METRICS_PATH = context.processMetrics.path;
      const metricsModule = path.join(REPOSITORY_DIRECTORY, 'scripts/ci/record-process-metrics.mjs');
      childEnvironment.NODE_OPTIONS = [
        childEnvironment.NODE_OPTIONS,
        `--import=${metricsModule}`,
      ].filter(Boolean).join(' ');
    }
    if (context.sharedDictionaryPath) {
      childEnvironment.TYPEWRITER_SHARED_DICTIONARY_PATH = context.sharedDictionaryPath;
      childEnvironment.TYPEWRITER_SEARCH_REGRESSION_DATABASE = context.sharedDictionaryPath;
    }
    const child = spawn(executable, args, {
      cwd: REPOSITORY_DIRECTORY,
      env: childEnvironment,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        updateChildProcessMetrics(context.processMetrics);
        resolve();
        return;
      }
      updateChildProcessMetrics(context.processMetrics);
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
    if (check.inProcess) {
      await runInProcessCheck(check.inProcess, context);
    } else {
      await execute(command, context);
    }
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
  const canonicalContext = await loadCanonicalContext({ contextPath: null });
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
  return {
    canonicalContext,
    completedChecks: new Set(),
    temporaryDirectory,
    processMetrics: {
      path: path.join(temporaryDirectory, 'child-process-metrics.jsonl'),
      childPeakRssKb: 0,
      childProcessCount: 0,
      canonicalRevision: canonicalContext.canonicalRevision,
      childSqliteBuildCount: 0,
      childCurrentRevisionSqliteBuildCount: 0,
    },
    sharedDictionaryPath: undefined,
    normalizedModel: undefined,
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
    normalizedModel: session.normalizedModel,
  });
  session.sharedDictionaryPath = summary.outputPath;
  console.log(
    `Prepared shared SQLite artifact ${summary.outputPath} (build count ${session.canonicalContext.metrics.sqlite_build_count}).`,
  );
  return summary.outputPath;
}

async function runInProcessCheck(name, context) {
  const canonicalContext = context.canonicalContext;
  if (name === 'canonical-jsonl') {
    console.log(
      `Validated ${canonicalContext.fileCount} canonical JSONL file(s) / ${canonicalContext.records.length} record(s) with schema.`,
    );
    return;
  }

  if (name === 'global-canonical-audit') {
    console.log(JSON.stringify(await runGlobalCanonicalAudit({ canonicalContext }), null, 2));
    return;
  }

  if (name === 'normalize-canonical') {
    context.normalizedModel = await normalizeCanonicalDirectory(
      canonicalContext.canonicalDirectory,
      {
        checkPilotCompleteness: true,
        canonicalContext,
        semanticAudit: canonicalContext.semanticAudit,
      },
    );
    const senseCount = context.normalizedModel.records.reduce(
      (count, record) => count + record.senses.length,
      0,
    );
    const relationCount = context.normalizedModel.records.reduce(
      (count, record) => count + record.senses.reduce(
        (senseCountForRecord, sense) => senseCountForRecord + sense.relations.length,
        0,
      ),
      0,
    );
    console.log(
      `Normalized ${context.normalizedModel.records.length} record(s) / ${senseCount} sense(s) / ${relationCount} relation(s) in memory (normalization v${context.normalizedModel.normalization_version}).`,
    );
    return;
  }

  if (name === 'shared-dictionary-build') {
    await ensureSharedDictionary(context);
    return;
  }

  if (name === 'shared-dictionary-validation') {
    console.log(JSON.stringify(await validateSharedDictionary({
      databasePath: context.sharedDictionaryPath,
      canonicalContext,
    }), null, 2));
    return;
  }

  if (name === 'm2-audit') {
    const summary = await runM2Pipeline({
      inputDirectory: canonicalContext.canonicalDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
      canonicalContext,
      databasePath: context.sharedDictionaryPath,
      model: context.normalizedModel,
    });
    console.log(
      `M2 audit passed: ${summary.fileCount} canonical file(s) / ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s), with ${summary.databaseBuilds} reproducible SQLite builds.`,
    );
    return;
  }

  if (name === 'deep-m2-reproducibility') {
    const summary = await runM2Pipeline({
      inputDirectory: canonicalContext.canonicalDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
      canonicalContext,
      model: context.normalizedModel,
    });
    console.log(
      `Deep current-revision reproducibility passed: ${summary.databaseBuilds} independent SQLite builds.`,
    );
    return;
  }

  throw new Error(`Unknown in-process CI check ${name}`);
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
    console.log(`\n=== ${category.label} [${categoryName}] ===`);
    await runChecks(category.checks, context);
    console.log(`\n=== ${categoryName} passed ===`);
  } finally {
    if (sharedCanonicalSession) {
      sharedCanonicalSession.sharedDictionaryPath = context.sharedDictionaryPath;
      sharedCanonicalSession.normalizedModel = context.normalizedModel;
    }
    if (context.historicalTemporaryDirectory) {
      await rm(context.historicalTemporaryDirectory, { recursive: true, force: true });
    }
    if (ownsCanonicalSession && context.temporaryDirectory) {
      await rm(context.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function printUsage() {
  console.error('Usage: node scripts/ci/run-category.mjs <level|category>');
  console.error(`Levels: ${Object.keys(CI_LEVEL_CATEGORY_ORDER).join(', ')}`);
  console.error(`Categories: ${CI_ALL_CATEGORY_ORDER.join(', ')}`);
}

async function main() {
  const [requestedCategory] = process.argv.slice(2);
  if (requestedCategory === '--list') {
    for (const [levelName, categoryNames] of Object.entries(CI_LEVEL_CATEGORY_ORDER)) {
      console.log(`${levelName}: ${categoryNames.join(', ')}`);
    }
    for (const categoryName of CI_ALL_CATEGORY_ORDER) {
      console.log(`${categoryName}: ${CI_CATEGORIES[categoryName].label}`);
    }
    return;
  }

  if (!requestedCategory) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const categoryNames = CI_LEVEL_CATEGORY_ORDER[requestedCategory]
    ?? [requestedCategory];
  if (categoryNames.some((categoryName) => !CI_CATEGORIES[categoryName])) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();
  const sharedCanonicalSession = await createCanonicalSession();
  try {
    let fastCheckpointPrinted = requestedCategory === 'fast';
    for (const [index, categoryName] of categoryNames.entries()) {
      await runCategory(categoryName, sharedCanonicalSession);
      if (!fastCheckpointPrinted && isFastPrefix(categoryNames, index + 1)) {
        printEvidence({
          contractVersion: 'ci-run-checkpoint-v1',
          level: 'fast',
          categoryNames: CI_LEVEL_CATEGORY_ORDER.fast,
          startedAt,
          canonicalContext: sharedCanonicalSession.canonicalContext,
          processMetrics: sharedCanonicalSession.processMetrics,
        });
        fastCheckpointPrinted = true;
      }
    }
    printEvidence({
      contractVersion: 'ci-run-evidence-v1',
      level: requestedCategory,
      categoryNames,
      startedAt,
      canonicalContext: sharedCanonicalSession.canonicalContext,
      processMetrics: sharedCanonicalSession.processMetrics,
    });
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

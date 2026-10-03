import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CI_CATEGORIES,
  CI_ALL_CATEGORY_ORDER,
  CI_DEEP_CATEGORY_ORDER,
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
import { validateM515 } from '../batch/validate-m5-15.mjs';
import { validateFrozenM6QualityAuditSnapshot } from '../validate/m6-4-quality-audit.mjs';
import {
  assertChildEvidenceAdvanced,
  assertNoChildCurrentRevisionBuild,
  assertSingleCurrentRevisionBuild,
  buildCountEvidence,
  CI_PHASE_ENV,
  DEEP_PHASE,
  NORMAL_PHASE,
  readBuildLedger,
  summarizeBuildLedger,
} from './sqlite-build-ledger.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CI_DEEP_PHASE_CATEGORIES = new Set(CI_DEEP_CATEGORY_ORDER);

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

function ledgerSummary(session) {
  return summarizeBuildLedger(readBuildLedger(session.processMetrics.path), {
    canonicalRevision: session.canonicalContext.canonicalRevision,
    parentPid: process.pid,
  });
}

function processMemorySummary(summary) {
  const resourceUsage = process.resourceUsage?.();
  const parentPeakRssBytes = Number.isFinite(resourceUsage?.maxRSS)
    ? resourceUsage.maxRSS * 1024
    : process.memoryUsage().rss;
  const childPeakRssBytes = (summary?.peak_rss_kb ?? 0) * 1024;
  const peakRssBytes = Math.max(parentPeakRssBytes, childPeakRssBytes);
  return {
    peak_rss_bytes: peakRssBytes,
    peak_rss_mb: Math.round((peakRssBytes / (1024 * 1024)) * 100) / 100,
    parent_peak_rss_mb: Math.round((parentPeakRssBytes / (1024 * 1024)) * 100) / 100,
    child_peak_rss_mb: Math.round((childPeakRssBytes / (1024 * 1024)) * 100) / 100,
    child_process_count: summary?.process_count ?? 0,
  };
}

// The normal-level invariant applies to every run whose categories include the
// whole fast prefix (fast, normal, all). Single-category and deep-only runs are
// diagnostic and are not normal merge gates.
function enforcesNormalBuildInvariant(requestedCategory) {
  return ['fast', 'normal', 'all'].includes(requestedCategory);
}

function assertNormalBuildInvariant(session, stage) {
  assertSingleCurrentRevisionBuild(ledgerSummary(session), {
    stage,
    parentContextBuildCount: session.canonicalContext.metrics.sqlite_build_count ?? 0,
  });
}

function printEvidence({
  contractVersion,
  level,
  categoryNames,
  startedAt,
  session,
}) {
  const summary = contextSummary(session.canonicalContext);
  const ledger = ledgerSummary(session);
  const { sqlite_build_count: sqliteBuildCount, ...contextMetrics } = summary.metrics;
  console.log(`\n=== ${level} evidence ===`);
  console.log(JSON.stringify({
    contract_version: contractVersion,
    level,
    category_order: categoryNames,
    wall_clock_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    canonical_revision: summary.canonical_revision,
    record_count: summary.recordCount,
    metrics: {
      ...contextMetrics,
      // The shared context only counts builds made through that one object, so it
      // is reported under an explicit name; the scoped, ledger-derived counters
      // below are authoritative and cover parent, child and deep builds.
      parent_context_sqlite_build_count: sqliteBuildCount ?? 0,
      ...buildCountEvidence(ledger),
    },
    context_transport: {
      serialize_count: summary.metrics.canonical_context_serialize_count ?? 0,
      deserialize_count: summary.metrics.canonical_context_deserialize_count ?? 0,
      rehydrate_count: summary.metrics.canonical_context_rehydrate_count ?? 0,
    },
    process_memory: processMemorySummary(ledger),
  }, null, 2));
}

function isFastPrefix(categoryNames, completedCategoryCount, fastOrder = CI_LEVEL_CATEGORY_ORDER.fast) {
  return completedCategoryCount >= fastOrder.length
    && fastOrder.every(
      (categoryName, index) => categoryNames[index] === categoryName,
    );
}

function measureLedger(context) {
  if (!context.processMetrics?.path) {
    return undefined;
  }
  return summarizeBuildLedger(readBuildLedger(context.processMetrics.path), {
    canonicalRevision: context.canonicalContext.canonicalRevision,
    parentPid: process.pid,
  });
}

async function runCommand({ executable, args }, context = {}, check = {}) {
  const commandLabel = check.label ?? formatCommand({ executable, args });
  const ledgerBefore = measureLedger(context);
  await new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    // Nested runners (e.g. the M5-12A prospective preflight) pass a context without
    // a phase; they inherit the phase of the process that is running them.
    childEnvironment[CI_PHASE_ENV] = context.phase ?? process.env[CI_PHASE_ENV] ?? NORMAL_PHASE;
    if (context.processMetrics?.path) {
      childEnvironment.TYPEWRITER_PROCESS_METRICS_PATH = context.processMetrics.path;
      const metricsModule = path.join(REPOSITORY_DIRECTORY, 'scripts/ci/record-process-metrics.mjs');
      childEnvironment.NODE_OPTIONS = [
        childEnvironment.NODE_OPTIONS,
        `--import=${metricsModule}`,
      ].filter(Boolean).join(' ');
    }
    if (context.sharedDictionaryPath && !check.independentCurrentRevisionBuilds) {
      childEnvironment.TYPEWRITER_SHARED_DICTIONARY_PATH = context.sharedDictionaryPath;
      childEnvironment.TYPEWRITER_SEARCH_REGRESSION_DATABASE = context.sharedDictionaryPath;
    } else if (check.independentCurrentRevisionBuilds) {
      // Deep/manual reproducibility proofs build independently by design.
      delete childEnvironment.TYPEWRITER_SHARED_DICTIONARY_PATH;
      delete childEnvironment.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
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
        resolve();
        return;
      }
      reject(new Error(
        `${executable} exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
      ));
    });
  });

  if (ledgerBefore) {
    // Fail closed: an unreadable ledger or a command that registered no child
    // process cannot be reported as "zero child builds".
    const ledgerAfter = measureLedger(context);
    assertChildEvidenceAdvanced(ledgerBefore, ledgerAfter, commandLabel);
    if ((context.phase ?? NORMAL_PHASE) === NORMAL_PHASE) {
      assertNoChildCurrentRevisionBuild(ledgerAfter, commandLabel);
    }
  }
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
      await execute(command, context, check);
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

async function prepareCurrentCanonicalContext() {
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
  return canonicalContext;
}

export async function createCanonicalSession({
  prepareContext = prepareCurrentCanonicalContext,
} = {}) {
  const temporaryDirectory = await createTemporaryDirectory();
  const canonicalContext = await prepareContext();
  const metricsPath = path.join(temporaryDirectory, 'child-process-metrics.jsonl');
  await writeFile(metricsPath, '', 'utf8');
  // The runner itself appends to the same ledger as its spawned commands so
  // parent and child builds are counted from one set of events.
  process.env.TYPEWRITER_PROCESS_METRICS_PATH = metricsPath;
  process.env[CI_PHASE_ENV] = NORMAL_PHASE;
  return {
    canonicalContext,
    completedChecks: new Set(),
    temporaryDirectory,
    phase: NORMAL_PHASE,
    processMetrics: { path: metricsPath },
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
    checkPilotCompleteness: session.checkPilotCompleteness ?? true,
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
  if (name === 'm6-4-frozen-snapshot') {
    console.log(JSON.stringify(await validateFrozenM6QualityAuditSnapshot(), null, 2));
    return;
  }

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

  if (name === 'surface-form-projection') {
    const projection = canonicalContext.derived.surfaceFormProjection;
    const projectionCache = canonicalContext.derived.surfaceFormProjectionCache;
    if (!projection || !projectionCache) {
      throw new Error('Global canonical validation did not derive a reusable surface-form projection.');
    }
    if (
      !projectionCache.requireExceptionTargets
      || !projectionCache.requireClassDispositions
      || !projectionCache.requireCollisionReview
    ) {
      throw new Error('The current-canonical surface-form projection was not derived in strict mode.');
    }
    if (canonicalContext.metrics.surface_form_projection_build_count !== 1) {
      throw new Error(
        'The current-canonical surface-form projection must be derived exactly once per CI session.',
      );
    }
    if (
      projection.coverage.complete_rule_decision_count
      !== projection.coverage.expected_rule_decision_count
    ) {
      throw new Error('The current-canonical surface-form projection has incomplete rule coverage.');
    }
    console.log(JSON.stringify({
      projection_build_count: canonicalContext.metrics.surface_form_projection_build_count,
      ...projection.coverage,
    }, null, 2));
    return;
  }

  if (name === 'surface-form-projection-reuse') {
    if (!canonicalContext.derived.surfaceFormProjection) {
      throw new Error('SQLite and M2 validation lost the shared surface-form projection.');
    }
    if (canonicalContext.metrics.surface_form_projection_build_count !== 1) {
      throw new Error(
        'SQLite build, SQLite validation, and M2 audit must reuse the single canonical projection.',
      );
    }
    console.log(JSON.stringify({
      projection_build_count: canonicalContext.metrics.surface_form_projection_build_count,
      generated_surface_form_count:
        canonicalContext.derived.surfaceFormProjection.coverage.generated_surface_form_count,
    }, null, 2));
    return;
  }

  if (name === 'm5-15-pre-admission') {
    console.log(JSON.stringify(await validateM515({ canonicalContext }), null, 2));
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

async function runCategory(categoryName, sharedCanonicalSession, categories = CI_CATEGORIES) {
  const category = categories[categoryName];
  const {
    context,
    ownsCanonicalSession,
  } = await contextForCategory(categoryName, sharedCanonicalSession);

  const phase = CI_DEEP_PHASE_CATEGORIES.has(categoryName) ? DEEP_PHASE : NORMAL_PHASE;
  context.phase = phase;
  process.env[CI_PHASE_ENV] = phase;
  try {
    console.log(`\n=== ${category.label} [${categoryName}] ===`);
    await runChecks(category.checks, context);
    console.log(`\n=== ${categoryName} passed ===`);
  } finally {
    process.env[CI_PHASE_ENV] = NORMAL_PHASE;
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

export async function runLevel(requestedCategory, {
  categories = CI_CATEGORIES,
  levels = CI_LEVEL_CATEGORY_ORDER,
  createSession = createCanonicalSession,
} = {}) {
  const categoryNames = levels[requestedCategory] ?? [requestedCategory];
  const enforceNormalInvariant = enforcesNormalBuildInvariant(requestedCategory);
  const startedAt = performance.now();
  const session = await createSession();
  try {
    let fastCheckpointPrinted = requestedCategory === 'fast';
    for (const [index, categoryName] of categoryNames.entries()) {
      await runCategory(categoryName, session, categories);
      const completed = index + 1;
      if (!fastCheckpointPrinted && isFastPrefix(categoryNames, completed, levels.fast)) {
        // Fast includes the one shared build; the normal continuation must
        // reuse it, so the invariant is already exact at this checkpoint.
        if (enforceNormalInvariant) {
          assertNormalBuildInvariant(session, 'fast checkpoint');
        }
        printEvidence({
          contractVersion: 'ci-run-checkpoint-v1',
          level: 'fast',
          categoryNames: levels.fast,
          startedAt,
          session,
        });
        fastCheckpointPrinted = true;
      }
      const nextIsDeep = CI_DEEP_PHASE_CATEGORIES.has(categoryNames[completed])
        && !CI_DEEP_PHASE_CATEGORIES.has(categoryName);
      if (enforceNormalInvariant && nextIsDeep) {
        // `all` must prove the normal phase on its own before deep phases may
        // add independent builds.
        assertNormalBuildInvariant(session, 'normal phase completion');
      }
    }
    if (enforceNormalInvariant) {
      assertNormalBuildInvariant(session, 'final exit');
    }
    printEvidence({
      contractVersion: 'ci-run-evidence-v1',
      level: requestedCategory,
      categoryNames,
      startedAt,
      session,
    });
  } finally {
    delete process.env.TYPEWRITER_PROCESS_METRICS_PATH;
    delete process.env[CI_PHASE_ENV];
    await rm(session.temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

export async function runCli(argv, options = {}) {
  const {
    categories = CI_CATEGORIES,
    levels = CI_LEVEL_CATEGORY_ORDER,
  } = options;
  const [requestedCategory] = argv;
  if (requestedCategory === '--list') {
    for (const [levelName, categoryNames] of Object.entries(levels)) {
      console.log(`${levelName}: ${categoryNames.join(', ')}`);
    }
    for (const categoryName of CI_ALL_CATEGORY_ORDER) {
      console.log(`${categoryName}: ${categories[categoryName].label}`);
    }
    return;
  }

  if (!requestedCategory) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const categoryNames = levels[requestedCategory] ?? [requestedCategory];
  if (categoryNames.some((categoryName) => !categories[categoryName])) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runLevel(requestedCategory, options);
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`\nCI category failed: ${error.message}`);
    process.exitCode = 1;
  });
}

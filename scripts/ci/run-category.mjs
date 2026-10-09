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
  CI_EXECUTION_TIERS,
  CI_LEVEL_EXECUTION_POLICY,
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
  assertBuildEventsMatchPhase,
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
  const events = readBuildLedger(context.processMetrics.path);
  return {
    events,
    summary: summarizeBuildLedger(events, {
      canonicalRevision: context.canonicalContext.canonicalRevision,
      parentPid: process.pid,
    }),
  };
}

async function runCommand({ executable, args }, context = {}, check = {}) {
  const commandLabel = check.label ?? formatCommand({ executable, args });
  const phase = context.phase ?? process.env[CI_PHASE_ENV] ?? NORMAL_PHASE;
  const ledgerBefore = measureLedger(context);
  await new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    // Nested runners (e.g. the M5-12A prospective preflight) pass a context without
    // a phase; they inherit the phase of the process that is running them.
    childEnvironment[CI_PHASE_ENV] = phase;
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
    assertBuildEventsMatchPhase(
      ledgerAfter.events.slice(ledgerBefore.events.length),
      phase,
      commandLabel,
    );
    assertChildEvidenceAdvanced(ledgerBefore.summary, ledgerAfter.summary, commandLabel);
    if (phase === NORMAL_PHASE) {
      assertNoChildCurrentRevisionBuild(ledgerAfter.summary, commandLabel);
    }
  }
}

export async function runChecks(
  checks,
  context,
  {
    execute = runCommand,
    log = console.log,
    executionPolicy,
  } = {},
) {
  const runnableChecks = executionPolicy
    ? selectChecksForPolicy(checks, executionPolicy)
    : checks;
  for (const [index, check] of runnableChecks.entries()) {
    const previousPhase = context?.phase;
    const previousProcessPhase = process.env[CI_PHASE_ENV];
    if (context && executionPolicy && check.tier) {
      const phase = check.tier === 'normal' || check.tier === 'candidate'
        ? NORMAL_PHASE
        : DEEP_PHASE;
      context.phase = phase;
      process.env[CI_PHASE_ENV] = phase;
    }
    const alreadyRun = Boolean(
      check.oncePerCanonicalSession
      && context?.completedChecks?.has(check.oncePerCanonicalSession)
    );
    try {
      if (alreadyRun) {
        log(`\n--- ${index + 1}/${runnableChecks.length}: ${check.label} (already run) ---`);
        continue;
      }
      const command = check.command(context);
      log(`\n--- ${index + 1}/${runnableChecks.length}: ${check.label} ---`);
      log(`$ ${formatCommand(command)}`);
      if (check.inProcess) {
        await runInProcessCheck(check.inProcess, context);
      } else {
        await execute(command, context, check);
      }
      if (check.oncePerCanonicalSession && context?.completedChecks) {
        context.completedChecks.add(check.oncePerCanonicalSession);
      }
    } finally {
      if (context && executionPolicy && check.tier) {
        if (previousPhase === undefined) delete context.phase;
        else context.phase = previousPhase;
        if (previousProcessPhase === undefined) delete process.env[CI_PHASE_ENV];
        else process.env[CI_PHASE_ENV] = previousProcessPhase;
      }
    }
  }
}

export function selectChecksForPolicy(checks, {
  tiers = CI_EXECUTION_TIERS,
  includeManual = false,
  changedPaths,
} = {}) {
  if (!Array.isArray(tiers) || tiers.some((tier) => !CI_EXECUTION_TIERS.includes(tier))) {
    throw new TypeError('CI execution policy contains an unknown tier.');
  }
  const changedPathsAreClassifiable = Array.isArray(changedPaths)
    && changedPaths.every((changedPath) => (
      typeof changedPath === 'string'
      && changedPath.length > 0
      && !changedPath.startsWith('/')
      && !changedPath.includes('\\')
      && !changedPath.split('/').some((part) => part === '' || part === '.' || part === '..')
    ));
  const classifiedChangedPaths = changedPathsAreClassifiable ? changedPaths : [];
  for (const check of checks) {
    if (!check.tier || !check.schedule || !check.owner || !check.protectedContract) {
      throw new TypeError(`CI check ${check.label ?? '<unlabeled>'} has incomplete registration metadata.`);
    }
    if (!CI_EXECUTION_TIERS.includes(check.tier)) {
      throw new TypeError(`CI check ${check.label} has unknown tier ${check.tier}.`);
    }
    if (!['always', 'affected', 'manual'].includes(check.schedule)) {
      throw new TypeError(`CI check ${check.label} has unknown schedule ${check.schedule}.`);
    }
  }
  const activeAffectedChecks = checks.filter((check) => (
    tiers.includes(check.tier) && check.schedule === 'affected'
  ));
  for (const check of activeAffectedChecks) {
    if (!Array.isArray(check.paths) || check.paths.length === 0) {
      throw new TypeError(`Affected check ${check.label} has no dependency paths.`);
    }
  }
  const changedPathIsMapped = (changedPath) => activeAffectedChecks.some((check) => (
    check.paths.some((dependencyPath) => (
      changedPath === dependencyPath
      || changedPath.startsWith(`${dependencyPath}/`)
    ))
  ));
  const failClosedAffectedSelection = activeAffectedChecks.length > 0
    && (!changedPathsAreClassifiable
      || classifiedChangedPaths.length === 0
      || classifiedChangedPaths.some((changedPath) => !changedPathIsMapped(changedPath)));

  return checks.filter((check) => {
    if (!tiers.includes(check.tier)) return false;
    if (check.schedule === 'always') return true;
    if (check.schedule === 'manual') return includeManual;
    if (failClosedAffectedSelection) return true;
    return classifiedChangedPaths.some((changedPath) => (
      check.paths.some((dependencyPath) => (
        changedPath === dependencyPath
        || changedPath.startsWith(`${dependencyPath}/`)
      ))
    ));
  });
}

export async function runCandidateLevel({
  categories = CI_CATEGORIES,
  levels = CI_LEVEL_CATEGORY_ORDER,
  executionPolicy = CI_LEVEL_EXECUTION_POLICY.candidates,
  changedPaths,
  execute = runCommand,
  log = console.log,
} = {}) {
  const categoryNames = levels.candidates ?? [];
  const checks = categoryNames.flatMap((categoryName) => categories[categoryName]?.checks ?? []);
  if (checks.length === 0) {
    throw new Error('Candidate-only CI has no registered candidate checks.');
  }

  const temporaryDirectory = await createTemporaryDirectory();
  const metricsPath = path.join(temporaryDirectory, 'child-process-metrics.jsonl');
  await writeFile(metricsPath, '', 'utf8');
  const session = {
    canonicalContext: {
      canonicalRevision: 'candidate-only-no-canonical-build',
      metrics: { sqlite_build_count: 0 },
    },
    completedChecks: new Set(),
    temporaryDirectory,
    phase: NORMAL_PHASE,
    processMetrics: { path: metricsPath },
    sharedDictionaryPath: undefined,
    normalizedModel: undefined,
  };
  const previousMetricsPath = process.env.TYPEWRITER_PROCESS_METRICS_PATH;
  const previousPhase = process.env[CI_PHASE_ENV];
  const previousSharedDictionaryPath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH;
  const previousSearchDatabasePath = process.env.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
  const startedAt = performance.now();
  process.env.TYPEWRITER_PROCESS_METRICS_PATH = metricsPath;
  process.env[CI_PHASE_ENV] = NORMAL_PHASE;
  delete process.env.TYPEWRITER_SHARED_DICTIONARY_PATH;
  delete process.env.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
  try {
    for (const categoryName of categoryNames) {
      const category = categories[categoryName];
      const runnable = selectChecksForPolicy(category.checks, {
        ...executionPolicy,
        changedPaths,
      });
      if (runnable.length === 0) continue;
      log(`\n=== ${category.label} [${categoryName}] ===`);
      await runChecks(runnable, session, {
        execute,
        log,
        executionPolicy: { ...executionPolicy, changedPaths },
      });
    }
    const sqliteBuildCount = readBuildLedger(metricsPath)
      .filter((event) => event.type === 'sqlite-build')
      .reduce((total, event) => total + event.count, 0);
    if (sqliteBuildCount !== 0) {
      throw new Error(`ci:candidates must not build SQLite; observed ${sqliteBuildCount} build(s).`);
    }
    log('\n=== candidate evidence ===');
    log(JSON.stringify({
      level: 'candidates',
      category_order: categoryNames,
      check_count: checks.length,
      wall_clock_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      current_revision_sqlite_build_count: sqliteBuildCount,
    }, null, 2));
  } finally {
    if (previousMetricsPath === undefined) delete process.env.TYPEWRITER_PROCESS_METRICS_PATH;
    else process.env.TYPEWRITER_PROCESS_METRICS_PATH = previousMetricsPath;
    if (previousPhase === undefined) delete process.env[CI_PHASE_ENV];
    else process.env[CI_PHASE_ENV] = previousPhase;
    if (previousSharedDictionaryPath === undefined) delete process.env.TYPEWRITER_SHARED_DICTIONARY_PATH;
    else process.env.TYPEWRITER_SHARED_DICTIONARY_PATH = previousSharedDictionaryPath;
    if (previousSearchDatabasePath === undefined) delete process.env.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
    else process.env.TYPEWRITER_SEARCH_REGRESSION_DATABASE = previousSearchDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
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

async function runCategory(
  categoryName,
  sharedCanonicalSession,
  categories = CI_CATEGORIES,
  executionPolicy,
  runnerOptions = {},
) {
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
    await runChecks(category.checks, context, { ...runnerOptions, executionPolicy });
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
  changedPaths,
  executionPolicy,
  execute,
  log,
} = {}) {
  const categoryNames = levels[requestedCategory] ?? [requestedCategory];
  const policy = executionPolicy
    ?? (categories === CI_CATEGORIES && levels === CI_LEVEL_CATEGORY_ORDER
      ? CI_LEVEL_EXECUTION_POLICY[requestedCategory]
      : undefined);
  if (requestedCategory === 'candidates') {
    await runCandidateLevel({
      categories,
      levels,
      executionPolicy: policy,
      changedPaths,
      execute,
      log,
    });
    return;
  }
  const runPolicy = policy ? { ...policy, changedPaths } : undefined;
  const enforceNormalInvariant = enforcesNormalBuildInvariant(requestedCategory);
  const splitNormalAndDeep = requestedCategory === 'all'
    && runPolicy?.tiers.includes('normal')
    && runPolicy.tiers.some((tier) => tier !== 'normal');
  const tierPasses = splitNormalAndDeep
    ? [
      { ...runPolicy, tiers: ['normal'] },
      { ...runPolicy, tiers: runPolicy.tiers.filter((tier) => tier !== 'normal') },
    ]
    : [runPolicy];
  const startedAt = performance.now();
  const session = await createSession();
  try {
    let fastCheckpointPrinted = !['normal', 'all'].includes(requestedCategory);
    const executedCategoryNames = [];
    for (const [passIndex, passPolicy] of tierPasses.entries()) {
      const passCategoryNames = passPolicy
        ? categoryNames.filter((categoryName) => (
          selectChecksForPolicy(categories[categoryName].checks, passPolicy).length > 0
        ))
        : categoryNames;
      for (const [index, categoryName] of passCategoryNames.entries()) {
        await runCategory(categoryName, session, categories, passPolicy, { execute, log });
        executedCategoryNames.push(categoryName);
        const completed = index + 1;
        if (!fastCheckpointPrinted && isFastPrefix(passCategoryNames, completed, levels.fast)) {
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
        const nextIsDeep = CI_DEEP_PHASE_CATEGORIES.has(passCategoryNames[completed])
          && !CI_DEEP_PHASE_CATEGORIES.has(categoryName);
        if (!splitNormalAndDeep && enforceNormalInvariant && nextIsDeep) {
          // Compatibility levels without tier metadata still prove Normal
          // before their explicitly ordered Deep categories.
          assertNormalBuildInvariant(session, 'normal phase completion');
        }
      }
      if (splitNormalAndDeep && passIndex === 0 && enforceNormalInvariant) {
        // All Normal checks finish before any Deep/Historical check is entered,
        // even when both tiers share one domain scope.
        assertNormalBuildInvariant(session, 'normal phase completion');
      }
    }
    if (enforceNormalInvariant) {
      assertNormalBuildInvariant(session, 'final exit');
    }
    printEvidence({
      contractVersion: 'ci-run-evidence-v1',
      level: requestedCategory,
      categoryNames: executedCategoryNames,
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

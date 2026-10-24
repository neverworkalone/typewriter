import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { runM2Pipeline } from '../verify/m2-pipeline.mjs';
import { classifyDeepGateDiff, routePrDeepGate } from './deep-gate.mjs';
import {
  assertBuildEventsMatchPhase,
  assertChildEvidenceAdvanced,
  assertNoCurrentRevisionBuild,
  buildCountEvidence,
  CI_PHASE_ENV,
  DEEP_PHASE,
  NORMAL_PHASE,
  readBuildLedger,
  summarizeBuildLedger,
} from './sqlite-build-ledger.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CI_DEEP_PHASE_CATEGORIES = new Set(CI_DEEP_CATEGORY_ORDER);

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

function assertDatabaseFreeInvariant(session, stage) {
  assertNoCurrentRevisionBuild(ledgerSummary(session), {
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
      // The context counter and process ledger independently establish that
      // automatic CI did not build the current Canonical revision.
      parent_context_sqlite_build_count: sqliteBuildCount ?? 0,
      ...buildCountEvidence(ledger),
    },
    sqlite_build_policy: {
      current_canonical_full_lite_builds_allowed: 0,
      current_canonical_full_lite_builds_observed:
        (ledger.current_revision_sqlite_build_count ?? 0)
        + (ledger.deep_current_revision_sqlite_build_count ?? 0),
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
    // Automatic CI must never inherit a cached production database. Fixture
    // database tests may still build their own small databases.
    delete childEnvironment.TYPEWRITER_SHARED_DICTIONARY_PATH;
    delete childEnvironment.TYPEWRITER_SEARCH_REGRESSION_DATABASE;
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
    assertNoCurrentRevisionBuild(ledgerAfter.summary, { stage: commandLabel });
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
      const phase = check.tier === 'normal'
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
  selectedDeepCheckIds,
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
  if (selectedDeepCheckIds !== undefined && (
    !Array.isArray(selectedDeepCheckIds)
    || selectedDeepCheckIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(selectedDeepCheckIds).size !== selectedDeepCheckIds.length
  )) {
    throw new TypeError('Selective Deep policy must provide unique check IDs.');
  }
  const selectedDeepCheckSet = selectedDeepCheckIds === undefined
    ? undefined
    : new Set(selectedDeepCheckIds);
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
      || (dependencyPath.endsWith('-')
        ? changedPath.startsWith(dependencyPath)
        : changedPath.startsWith(`${dependencyPath}/`))
    ))
  ));
  const failClosedAffectedSelection = activeAffectedChecks.length > 0
    && (!changedPathsAreClassifiable
      || classifiedChangedPaths.length === 0
      || classifiedChangedPaths.some((changedPath) => !changedPathIsMapped(changedPath)));

  return checks.filter((check) => {
    if (!tiers.includes(check.tier)) return false;
    if (
      check.tier === 'deep'
      && selectedDeepCheckSet
      && !selectedDeepCheckSet.has(`${check.owner}/${check.label}`)
    ) return false;
    if (check.schedule === 'always') return true;
    if (check.schedule === 'manual') return includeManual;
    if (failClosedAffectedSelection) return true;
    return classifiedChangedPaths.some((changedPath) => (
      check.paths.some((dependencyPath) => (
        changedPath === dependencyPath
        || (dependencyPath.endsWith('-')
          ? changedPath.startsWith(dependencyPath)
          : changedPath.startsWith(`${dependencyPath}/`))
      ))
    ));
  });
}

async function createTemporaryDirectory() {
  const requestedRoot = process.env.RUNNER_TEMP;
  const root = requestedRoot ? path.resolve(requestedRoot) : tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'typewriter-ci-'));
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
    normalizedModel: undefined,
  };
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
      throw new Error('Current-canonical checks lost the shared surface-form projection.');
    }
    if (canonicalContext.metrics.surface_form_projection_build_count !== 1) {
      throw new Error(
        'Current-canonical checks must reuse the single surface-form projection.',
      );
    }
    console.log(JSON.stringify({
      projection_build_count: canonicalContext.metrics.surface_form_projection_build_count,
      generated_surface_form_count:
        canonicalContext.derived.surfaceFormProjection.coverage.generated_surface_form_count,
    }, null, 2));
    return;
  }

  if (name === 'normalize-canonical') {
    context.normalizedModel = await normalizeCanonicalDirectory(
      canonicalContext.canonicalDirectory,
      {
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

  if (name === 'm2-data-audit') {
    const summary = await runM2Pipeline({
      inputDirectory: canonicalContext.canonicalDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
      canonicalContext,
      model: context.normalizedModel,
      databaseMode: 'data-only',
    });
    console.log(
      `Database-free M2 source/model audit passed: ${summary.fileCount} canonical file(s) / ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s). SQLite generation, database integrity and Full/Lite verification were not run.`,
    );
    return;
  }

  if (name === 'deep-data-projection-reproducibility') {
    const normalizeOptions = {
      canonicalContext,
      semanticAudit: canonicalContext.semanticAudit,
    };
    const first = await normalizeCanonicalDirectory(
      canonicalContext.canonicalDirectory,
      normalizeOptions,
    );
    const second = await normalizeCanonicalDirectory(
      canonicalContext.canonicalDirectory,
      normalizeOptions,
    );
    assert.deepStrictEqual(
      second,
      first,
      'canonical normalization must reproduce the same in-memory model',
    );
    console.log(JSON.stringify({
      canonical_revision: canonicalContext.canonicalRevision,
      normalization_version: first.normalization_version,
      normalized_record_count: first.records.length,
      normalized_model_sha256: createHash('sha256')
        .update(JSON.stringify(first))
        .digest('hex'),
      current_canonical_sqlite_build_count: 0,
      database_verification: 'not-run',
    }, null, 2));
    return;
  }

  throw new Error(`Unknown in-process CI check ${name}`);
}

async function contextForCategory(sharedCanonicalSession) {
  const session = sharedCanonicalSession ?? await createCanonicalSession();
  const context = {
    ...session,
  };

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
  } = await contextForCategory(sharedCanonicalSession);

  const phase = CI_DEEP_PHASE_CATEGORIES.has(categoryName) ? DEEP_PHASE : NORMAL_PHASE;
  context.phase = phase;
  process.env[CI_PHASE_ENV] = phase;
  try {
    console.log(`\n=== ${category.label} [${categoryName}] ===`);
    await runChecks(category.checks, context, { ...runnerOptions, executionPolicy });
    console.log(`\n=== ${categoryName} passed ===`);
  } finally {
    process.env[CI_PHASE_ENV] = NORMAL_PHASE;
    if (sharedCanonicalSession) sharedCanonicalSession.normalizedModel = context.normalizedModel;
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
  if (categoryNames.some((categoryName) => !categories[categoryName])) {
    throw new Error(`Unknown CI level or category: ${requestedCategory}`);
  }
  const policy = executionPolicy
    ?? (categories === CI_CATEGORIES && levels === CI_LEVEL_CATEGORY_ORDER
      ? CI_LEVEL_EXECUTION_POLICY[requestedCategory]
      : undefined);
  const runPolicy = policy ? {
    ...policy,
    changedPaths,
  } : undefined;
  const splitNormalAndDeep = ['all', 'pr'].includes(requestedCategory)
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
    let fastCheckpointPrinted = !['normal', 'all', 'pr'].includes(requestedCategory);
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
          assertDatabaseFreeInvariant(session, 'fast checkpoint');
          printEvidence({
            contractVersion: 'ci-run-checkpoint-v2',
            level: 'fast',
            categoryNames: levels.fast,
            startedAt,
            session,
          });
          fastCheckpointPrinted = true;
        }
        const nextIsDeep = CI_DEEP_PHASE_CATEGORIES.has(passCategoryNames[completed])
          && !CI_DEEP_PHASE_CATEGORIES.has(categoryName);
        if (!splitNormalAndDeep && nextIsDeep) {
          assertDatabaseFreeInvariant(session, 'normal phase completion');
        }
      }
      if (splitNormalAndDeep && passIndex === 0) {
        assertDatabaseFreeInvariant(session, 'normal phase completion');
      }
    }
    assertDatabaseFreeInvariant(session, 'final exit');
    printEvidence({
      contractVersion: 'ci-run-evidence-v2',
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

export async function runPrLevel({
  baseSha,
  headSha,
  classify = classifyDeepGateDiff,
  getCurrentHead = () => execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim(),
  categories = CI_CATEGORIES,
  levels = CI_LEVEL_CATEGORY_ORDER,
  createSession = createCanonicalSession,
  execute,
  log,
} = {}) {
  if (getCurrentHead() !== headSha) {
    throw new Error('ci:pr checkout HEAD does not match the requested exact PR HEAD.');
  }
  const classification = routePrDeepGate(classify(baseSha, headSha));
  if (classification.deepMode !== 'selective'
      || !Array.isArray(classification.selectedDeepChecks)
      || classification.selectedDeepChecks.length === 0) {
    throw new Error(`ci:pr requires a selectively classified Deep change; got ${classification.deepMode ?? 'unknown'} (${classification.reason ?? 'no reason'})`);
  }
  const availableChecks = categories === CI_CATEGORIES
    ? CI_ALL_CATEGORY_ORDER.flatMap((categoryName) => CI_CATEGORIES[categoryName].checks)
    : Object.values(categories).flatMap((category) => category.checks ?? []);
  const registeredDeepCheckIds = new Set(availableChecks
    .filter((check) => check.tier === 'deep')
    .map((check) => `${check.owner}/${check.label}`));
  if (classification.selectedDeepChecks.some((id) => !registeredDeepCheckIds.has(id))) {
    throw new Error('ci:pr received a selected Deep check that is not registered in this runner.');
  }
  return runLevel('pr', {
    categories,
    levels,
    createSession,
    executionPolicy: {
      ...CI_LEVEL_EXECUTION_POLICY.pr,
      selectedDeepCheckIds: classification.selectedDeepChecks,
    },
    changedPaths: classification.changedPaths,
    execute,
    log,
  });
}

export async function runCli(argv, options = {}) {
  const {
    categories = CI_CATEGORIES,
    levels = CI_LEVEL_CATEGORY_ORDER,
  } = options;
  const [requestedCategory, ...requestedArguments] = argv;
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

  if (requestedCategory === 'pr') {
    const args = requestedArguments.filter((argument) => argument !== '--');
    const values = new Map();
    for (let index = 0; index < args.length; index += 1) {
      const key = args[index];
      const value = args[index + 1];
      if (!['--base', '--head'].includes(key) || !value || values.has(key)) {
        throw new Error('ci:pr accepts exactly --base <sha> and --head <sha>.');
      }
      values.set(key, value);
      index += 1;
    }
    const baseSha = values.get('--base');
    const headSha = values.get('--head');
    if (!/^[0-9a-f]{40}$/u.test(baseSha ?? '') || !/^[0-9a-f]{40}$/u.test(headSha ?? '')) {
      throw new Error('ci:pr requires full lowercase 40-character base and head SHAs.');
    }
    await runPrLevel({ baseSha, headSha, ...options });
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

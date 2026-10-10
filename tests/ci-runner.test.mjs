import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { CI_CATEGORIES, registerCheck } from '../scripts/ci/registry.mjs';
import { materializeHistoricalInputs, runChecks, runCli, runLevel } from '../scripts/ci/run-category.mjs';
import { loadCanonicalContext } from '../scripts/validate/canonical-context.mjs';

test('runner stops at the first failed check regardless of check kind', async () => {
  const executed = [];
  const sentinel = { executed: false };
  const checks = [
    {
      label: 'synthetic success',
      command: () => ({ executable: 'synthetic', args: ['success'] }),
    },
    {
      label: 'synthetic failure',
      command: () => ({ executable: 'synthetic', args: ['failure'] }),
    },
    {
      kind: 'node-test',
      label: 'synthetic sentinel',
      command: () => {
        sentinel.executed = true;
        return { executable: 'synthetic', args: ['sentinel'] };
      },
    },
  ];

  await assert.rejects(
    runChecks(checks, {}, {
      log: () => {},
      execute: async ({ args }) => {
        executed.push(args[0]);
        if (args[0] === 'failure') {
          throw new Error('synthetic failure');
        }
      },
    }),
    /synthetic failure/,
  );

  assert.deepEqual(executed, ['success', 'failure']);
  assert.equal(sentinel.executed, false);
});

test('runner does not repeat a shared audit within one canonical session', async () => {
  const executed = [];
  const checks = [
    {
      label: 'shared audit',
      oncePerCanonicalSession: 'global-canonical-audit',
      command: () => ({ executable: 'synthetic', args: ['audit'] }),
    },
    {
      label: 'shared audit duplicate',
      oncePerCanonicalSession: 'global-canonical-audit',
      command: () => ({ executable: 'synthetic', args: ['audit-duplicate'] }),
    },
  ];

  await runChecks(checks, { completedChecks: new Set() }, {
    log: () => {},
    execute: async ({ args }) => executed.push(args[0]),
  });

  assert.deepEqual(executed, ['audit']);
});

test('runner applies tier and schedule policy while preserving one execution context', async () => {
  const checks = [
    registerCheck({
      label: 'normal invariant',
      command: () => ({ executable: 'synthetic', args: ['normal'] }),
    }, { owner: 'canonical', tier: 'normal' }),
    registerCheck({
      label: 'deep regression',
      command: () => ({ executable: 'synthetic', args: ['deep'] }),
    }, { owner: 'toolchain', tier: 'deep' }),
    registerCheck({
      label: 'manual replay',
      command: () => ({ executable: 'synthetic', args: ['manual'] }),
    }, { owner: 'batch', tier: 'historical', schedule: 'manual', historicalScopes: ['issue-219'] }),
  ];
  const seen = [];
  const context = { phase: 'normal' };
  const previousPhase = process.env.TYPEWRITER_CI_PHASE;
  try {
    process.env.TYPEWRITER_CI_PHASE = 'normal';
    await runChecks(checks, context, {
      executionPolicy: {
        tiers: ['normal', 'deep', 'historical'],
        includeManual: false,
        historicalScopes: ['issue-219'],
      },
      log: () => {},
      execute: async ({ args }) => {
        seen.push({ name: args[0], phase: context.phase, envPhase: process.env.TYPEWRITER_CI_PHASE });
      },
    });
    assert.deepEqual(seen, [
      { name: 'normal', phase: 'normal', envPhase: 'normal' },
      { name: 'deep', phase: 'deep', envPhase: 'deep' },
    ]);
    assert.equal(context.phase, 'normal', 'the runner restores the caller session phase');
    assert.equal(process.env.TYPEWRITER_CI_PHASE, 'normal');
  } finally {
    if (previousPhase === undefined) delete process.env.TYPEWRITER_CI_PHASE;
    else process.env.TYPEWRITER_CI_PHASE = previousPhase;
  }
});

test('candidate-only CI validates without creating a canonical session or SQLite build', async () => {
  const productionCandidateCommands = [];
  await runCli(['candidates'], {
    log: () => {},
    execute: async (command, context) => {
      productionCandidateCommands.push(command.args);
      assert.equal(context.canonicalContext.canonicalRevision, 'candidate-only-no-canonical-build');
      assert.equal(context.sharedDictionaryPath, undefined);
    },
  });
  assert.deepEqual(productionCandidateCommands, [
    ['scripts/factory/validate.mjs'],
    ['scripts/factory/freshness.mjs'],
  ]);

  const candidateCheck = registerCheck({
    label: 'Synthetic factory candidate validator',
    command: () => ({ executable: 'synthetic', args: ['factory-candidate-validation'] }),
  }, { owner: 'factory', tier: 'candidate' });
  const crossScopeCandidateCheck = registerCheck({
    label: 'Synthetic lexical candidate semantic validator',
    command: () => ({ executable: 'synthetic', args: ['lexical-candidate-validation'] }),
  }, { owner: 'lexical', tier: 'candidate' });
  const evidence = [];
  const options = {
    categories: {
      factory: { label: 'Candidate artifacts', checks: [candidateCheck] },
      lexical: { label: 'Lexical candidate contracts', checks: [crossScopeCandidateCheck] },
    },
    levels: { candidates: ['factory', 'lexical'] },
    executionPolicy: { tiers: ['candidate'], includeManual: false },
    createSession: () => { throw new Error('candidate-only CI must not load the canonical session'); },
    log: (value) => evidence.push(value),
  };
  const seen = [];
  await runCli(['candidates'], {
    ...options,
    execute: async ({ args }, context) => {
      seen.push(args[0]);
      assert.equal(context.canonicalContext.canonicalRevision, 'candidate-only-no-canonical-build');
      assert.equal(context.sharedDictionaryPath, undefined);
    },
  });
  assert.deepEqual(seen, ['factory-candidate-validation', 'lexical-candidate-validation']);
  const candidateEvidence = evidence
    .map((value) => { try { return JSON.parse(value); } catch { return null; } })
    .find((value) => value?.level === 'candidates');
  assert.deepEqual(candidateEvidence.category_order, ['factory', 'lexical']);
  assert.equal(candidateEvidence.check_count, 2);
  assert.equal(candidateEvidence.registered_candidate_check_count, 2);
  assert.equal(candidateEvidence.current_revision_sqlite_build_count, 0);

  await assert.rejects(
    runCli(['candidates'], {
      ...options,
      execute: async (_command, context) => {
        await appendFile(context.processMetrics.path, `${JSON.stringify({
          type: 'sqlite-build',
          pid: process.pid,
          count: 1,
          canonical_revision: context.canonicalContext.canonicalRevision,
          canonical_directory: '/synthetic/canonical',
          phase: 'normal',
        })}\n`);
      },
    }),
    /ci:candidates must not build SQLite/u,
  );
});

test('ci:historical requires one explicit scope and runs only that bounded manual replay', async () => {
  const issue219 = registerCheck({
    label: 'Synthetic Issue #219 historical replay',
    command: () => ({ executable: 'synthetic', args: ['issue-219-replay'] }),
  }, { owner: 'batch', tier: 'historical', historicalScopes: ['issue-219'] });
  const issue220 = registerCheck({
    label: 'Synthetic Issue #220 historical replay',
    command: () => ({ executable: 'synthetic', args: ['issue-220-replay'] }),
  }, { owner: 'deep', tier: 'historical', historicalScopes: ['issue-220'] });
  const normal = registerCheck({
    label: 'Synthetic current Normal check',
    command: () => ({ executable: 'synthetic', args: ['normal'] }),
  }, { owner: 'batch', tier: 'normal' });
  const categories = {
    batch: { label: 'Batch contracts', checks: [issue219, normal] },
    deep: { label: 'Deep contracts', checks: [issue220] },
  };
  const levels = {
    fast: ['batch'],
    normal: ['batch', 'deep'],
    all: ['batch', 'deep'],
    deep: ['batch', 'deep'],
    candidates: ['batch', 'deep'],
    historical: ['batch', 'deep'],
  };
  const sessionDirectories = [];
  const sessions = [];
  const createSession = async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-history-scope-'));
    sessionDirectories.push(temporaryDirectory);
    const metricsPath = path.join(temporaryDirectory, 'ledger.jsonl');
    await writeFile(metricsPath, '', 'utf8');
    const session = {
      canonicalContext: {
        contractVersion: 'synthetic-canonical-context-v1',
        canonicalDirectory: temporaryDirectory,
        canonicalRevision: 'synthetic-history-revision',
        fileCount: 0,
        statistics: {
          recordCount: 0,
          senseCount: 0,
          relationCount: 0,
          candidateCount: 0,
          startCount: 0,
          referenceOnlyCount: 0,
          expressionCount: 0,
          searchFormCount: 0,
        },
        metrics: { sqlite_build_count: 0 },
      },
      completedChecks: new Set(),
      temporaryDirectory,
      phase: 'normal',
      processMetrics: { path: metricsPath },
      sharedDictionaryPath: undefined,
      normalizedModel: undefined,
    };
    sessions.push(session);
    return session;
  };
  const baseOptions = {
    categories,
    levels,
    executionPolicy: { tiers: ['historical'], includeManual: true },
    createSession,
    log: () => {},
  };
  let missingScopeSessionCreated = false;
  await assert.rejects(
    runCli(['historical'], {
      ...baseOptions,
      createSession: async () => { missingScopeSessionCreated = true; throw new Error('unexpected session'); },
    }),
    /Usage: pnpm run ci:historical --scope/u,
  );
  await assert.rejects(
    runCli(['historical', '--scope', 'unknown-scope'], baseOptions),
    /Unknown historical scope/u,
  );
  await assert.rejects(
    runCli(['historical', '--scope', 'issue-219', '--scope', 'issue-220'], baseOptions),
    /Usage: pnpm run ci:historical --scope/u,
  );
  assert.equal(missingScopeSessionCreated, false, 'a missing scope fails before canonical context creation');

  const executed = [];
  const runOptions = {
    ...baseOptions,
    execute: async (command, context) => {
      executed.push(command.args[0]);
      assert.equal(context.phase, 'deep');
      assert.equal(context.sharedDictionaryPath, undefined);
      assert.equal((await readFile(context.processMetrics.path, 'utf8')).trim(), '');
    },
  };
  await runCli(['historical', '--scope=issue-219'], runOptions);
  assert.deepEqual(executed, ['issue-219-replay']);
  assert.equal(sessionDirectories.length, 1);
  assert.equal(sessions[0].canonicalContext.metrics.sqlite_build_count, 0);
  await runCli(['historical', '--', '--scope', 'issue-219'], runOptions);
  assert.deepEqual(executed, ['issue-219-replay', 'issue-219-replay']);
  assert.equal(sessionDirectories.length, 2);

  const inputDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-history-input-scope-'));
  try {
    const waveA2Inputs = await materializeHistoricalInputs(inputDirectory, ['m5-10a']);
    assert.deepEqual(Object.keys(waveA2Inputs).sort(), ['waveA2Reviewed', 'waveA2SemanticAudit']);
    const issue219Inputs = await materializeHistoricalInputs(inputDirectory, ['issue-219']);
    assert.deepEqual(issue219Inputs, {}, 'an Issue #219 replay does not copy unrelated M5 replay inputs');
  } finally {
    await rm(inputDirectory, { recursive: true, force: true });
  }
});

test('ci:all completes Normal before Deep checks in the same domain and preserves the one-build gate', async () => {
  const state = { normalComplete: false, order: [] };
  const deepCheck = registerCheck({
    label: 'synthetic independent Deep build',
    command: () => ({ executable: 'synthetic', args: ['deep-build'] }),
  }, { owner: 'canonical', tier: 'deep' });
  const normalCheck = registerCheck({
    label: 'synthetic current-revision Normal build',
    command: () => ({ executable: 'synthetic', args: ['normal-build'] }),
  }, { owner: 'canonical', tier: 'normal' });
  const historicalCheck = registerCheck({
    label: 'synthetic completed-batch replay',
    command: () => ({ executable: 'synthetic', args: ['historical-replay'] }),
  }, { owner: 'canonical', tier: 'historical', historicalScopes: ['issue-219'] });
  const checks = [deepCheck, normalCheck, historicalCheck];

  await assert.rejects(
    runChecks(checks, { phase: 'normal', completedChecks: new Set() }, {
      executionPolicy: {
        tiers: ['normal', 'historical', 'deep'],
        includeManual: false,
        historicalScopes: ['issue-219'],
      },
      log: () => {},
      execute: async ({ args }) => {
        if (args[0] === 'deep-build' && !state.normalComplete) {
          throw new Error('independent Deep build started before Normal completed');
        }
      },
    }),
    /before Normal completed/u,
    'the adversarial fixture must reject an early independent build',
  );

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-tier-order-'));
  try {
    const ledgerPath = path.join(temporaryDirectory, 'ledger.jsonl');
    await writeFile(ledgerPath, '', 'utf8');
    const revision = 'synthetic-current-revision';
    const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
    const createSession = async () => ({
      canonicalContext: {
        contractVersion: 'synthetic-context-v1',
        canonicalDirectory,
        canonicalRevision: revision,
        fileCount: 1,
        recordCount: 1,
        senseCount: 1,
        relationCount: 0,
        candidateCount: 1,
        startCount: 1,
        referenceOnlyCount: 0,
        expressionCount: 0,
        searchFormCount: 1,
        statistics: {},
        metrics: { sqlite_build_count: 0 },
      },
      completedChecks: new Set(),
      temporaryDirectory,
      processMetrics: { path: ledgerPath },
      phase: 'normal',
    });

    await runLevel('all', {
      categories: { canonical: { label: 'Mixed-tier canonical scope', checks } },
      levels: { fast: ['canonical'], all: ['canonical'] },
      executionPolicy: { tiers: ['normal', 'deep'], includeManual: false },
      createSession,
      log: () => {},
      execute: async ({ args }, context) => {
        if (args[0] === 'normal-build') {
          assert.equal(context.phase, 'normal');
          await appendFile(ledgerPath, `${JSON.stringify({
            type: 'sqlite-build',
            pid: process.pid,
            count: 1,
            canonical_revision: revision,
            canonical_directory: canonicalDirectory,
            phase: 'normal',
          })}\n`);
          context.canonicalContext.metrics.sqlite_build_count += 1;
          state.normalComplete = true;
          state.order.push('normal');
          return;
        }
        assert.equal(args[0], 'deep-build');
        assert.equal(state.normalComplete, true);
        assert.equal(context.phase, 'deep');
        const ledger = (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(ledger.filter((event) => event.phase === 'normal').length, 1);
        const deepPid = process.pid + 1;
        await appendFile(ledgerPath, `${JSON.stringify({
          type: 'process',
          pid: deepPid,
          peak_rss_kb: 0,
        })}\n`);
        await appendFile(ledgerPath, `${JSON.stringify({
          type: 'sqlite-build',
          pid: deepPid,
          count: 1,
          canonical_revision: revision,
          canonical_directory: canonicalDirectory,
          phase: 'deep',
        })}\n`);
        state.order.push('deep');
      },
    });

    assert.deepEqual(state.order, ['normal', 'deep']);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('ci:pr CLI recomputes exact-head impact and runs Normal before only the selected Deep check', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-pr-selection-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const ledgerPath = path.join(temporaryDirectory, 'ledger.jsonl');
  await writeFile(ledgerPath, '', 'utf8');
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const canonicalRevision = 'synthetic-pr-current-revision';
  const normalCheck = registerCheck({
    label: 'synthetic Normal completeness gate',
    command: () => ({ executable: 'synthetic', args: ['normal'] }),
  }, { owner: 'canonical', tier: 'normal' });
  const selectedDeep = CI_CATEGORIES.deep.checks.find(
    (check) => check.label === 'Run 100K/500K/1M release-shaped performance and scale benchmark',
  );
  const unrelatedDeep = CI_CATEGORIES.batch.checks.find(
    (check) => check.label === 'Test Issue #400/#446 relation enrichment pilot contract, backfill queue and canonical apply',
  );
  const categories = {
    canonical: { label: 'Synthetic canonical gates', checks: [normalCheck, selectedDeep, unrelatedDeep] },
  };
  const executed = [];

  await runCli(['pr', '--', '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)], {
    getCurrentHead: () => 'b'.repeat(40),
    classify: (base, head) => {
      assert.equal(base, 'a'.repeat(40));
      assert.equal(head, 'b'.repeat(40));
      return {
        deepMode: 'selective',
        reason: 'registered-deep-contract-dependency',
        selectedDeepChecks: [`${selectedDeep.owner}/${selectedDeep.label}`],
        changedPaths: ['tests/scale-benchmark.test.mjs'],
      };
    },
    categories,
    levels: { fast: ['canonical'], pr: ['canonical'] },
    createSession: async () => ({
      canonicalContext: {
        contractVersion: 'synthetic-context-v1',
        canonicalDirectory,
        canonicalRevision,
        fileCount: 1,
        recordCount: 1,
        senseCount: 1,
        relationCount: 0,
        candidateCount: 1,
        startCount: 1,
        referenceOnlyCount: 0,
        expressionCount: 0,
        searchFormCount: 1,
        statistics: {},
        metrics: { sqlite_build_count: 0 },
      },
      completedChecks: new Set(),
      temporaryDirectory,
      processMetrics: { path: ledgerPath },
      phase: 'normal',
    }),
    log: () => {},
    execute: async (command, context, check) => {
      executed.push(`${context.phase}:${check.label}`);
      if (check === normalCheck) {
        await appendFile(ledgerPath, `${JSON.stringify({
          type: 'sqlite-build',
          pid: process.pid,
          count: 1,
          canonical_revision: canonicalRevision,
          canonical_directory: canonicalDirectory,
          phase: 'normal',
        })}\n`);
        context.canonicalContext.metrics.sqlite_build_count += 1;
      }
      assert.ok(command.args.length > 0);
    },
  });

  assert.deepEqual(executed, [
    'normal:synthetic Normal completeness gate',
    `deep:${selectedDeep.label}`,
  ]);
  await assert.rejects(
    runCli(['pr', '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)], {
      getCurrentHead: () => 'c'.repeat(40),
    }),
    /checkout HEAD does not match/u,
  );
});

test('ci:deep searches every domain scope and runs only current-system Deep checks', async () => {
  const deepCheck = registerCheck({
    label: 'Deep check owned by canonical scope',
    command: () => ({ executable: 'synthetic', args: ['deep'] }),
  }, { owner: 'canonical', tier: 'deep' });
  const normalCheck = registerCheck({
    label: 'Normal check in the same scope',
    command: () => ({ executable: 'synthetic', args: ['normal'] }),
  }, { owner: 'canonical', tier: 'normal' });
  const historicalCheck = registerCheck({
    label: 'Historical check in the same scope',
    command: () => ({ executable: 'synthetic', args: ['historical'] }),
  }, { owner: 'canonical', tier: 'historical', historicalScopes: ['issue-219'] });
  const categories = {
    canonical: {
      label: 'Mixed-tier canonical scope',
      checks: [deepCheck, normalCheck, historicalCheck],
    },
  };
  const seen = [];

  await runLevel('deep', {
    categories,
    levels: {
      fast: ['canonical'],
      normal: ['canonical'],
      all: ['canonical'],
      deep: ['canonical'],
    },
    executionPolicy: { tiers: ['deep'], includeManual: false },
    createSession: async () => {
      const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-deep-only-'));
      const metricsPath = path.join(temporaryDirectory, 'ledger.jsonl');
      await writeFile(metricsPath, '', 'utf8');
      return {
        canonicalContext: {
          contractVersion: 'synthetic-context-v1',
          canonicalDirectory: path.join(temporaryDirectory, 'canonical'),
          canonicalRevision: 'synthetic-current-revision',
          fileCount: 1,
          recordCount: 1,
          senseCount: 1,
          relationCount: 0,
          candidateCount: 1,
          startCount: 1,
          referenceOnlyCount: 0,
          expressionCount: 0,
          searchFormCount: 1,
          statistics: {},
          metrics: { sqlite_build_count: 0 },
        },
        completedChecks: new Set(),
        temporaryDirectory,
        processMetrics: { path: metricsPath },
        phase: 'deep',
      };
    },
    execute: async ({ args }, context) => {
      seen.push(args[0]);
      assert.equal(context.phase, 'deep');
    },
  });

  assert.deepEqual(seen, ['deep']);
});

test('M5-15 consumes the existing canonical session without another canonical parse', async () => {
  const check = CI_CATEGORIES.batch.checks.find(
    (candidate) => candidate.inProcess === 'm5-15-pre-admission',
  );
  const canonicalContext = await loadCanonicalContext({ contextPath: null });
  const metricsBefore = { ...canonicalContext.metrics };

  await runChecks([check], {
    canonicalContext,
    completedChecks: new Set(),
  }, { log: () => {} });

  assert.deepEqual(canonicalContext.metrics, metricsBefore);
});

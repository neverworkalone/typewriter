import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { CI_CATEGORIES, registerCheck } from '../scripts/ci/registry.mjs';
import { runChecks, runCli, runLevel } from '../scripts/ci/run-category.mjs';
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
    }, { owner: 'batch', tier: 'historical', schedule: 'manual' }),
  ];
  const seen = [];
  const context = { phase: 'normal' };
  const previousPhase = process.env.TYPEWRITER_CI_PHASE;
  try {
    process.env.TYPEWRITER_CI_PHASE = 'normal';
    await runChecks(checks, context, {
      executionPolicy: { tiers: ['normal', 'deep', 'historical'], includeManual: false },
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
    label: 'Synthetic Stage 1 candidate validator',
    command: () => ({ executable: 'synthetic', args: ['candidate-validation'] }),
  }, { owner: 'factory', tier: 'candidate' });
  const options = {
    categories: { factory: { label: 'Candidate artifacts', checks: [candidateCheck] } },
    levels: { candidates: ['factory'] },
    executionPolicy: { tiers: ['candidate'], includeManual: false },
    createSession: () => { throw new Error('candidate-only CI must not load the canonical session'); },
    log: () => {},
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
  assert.deepEqual(seen, ['candidate-validation']);

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
  }, { owner: 'canonical', tier: 'historical' });
  const checks = [deepCheck, normalCheck, historicalCheck];

  await assert.rejects(
    runChecks(checks, { phase: 'normal', completedChecks: new Set() }, {
      executionPolicy: { tiers: ['normal', 'historical', 'deep'], includeManual: false },
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
  }, { owner: 'canonical', tier: 'historical' });
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

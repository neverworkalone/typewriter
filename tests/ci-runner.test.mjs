import assert from 'node:assert/strict';
import test from 'node:test';

import { CI_CATEGORIES, registerCheck } from '../scripts/ci/registry.mjs';
import { runChecks } from '../scripts/ci/run-category.mjs';
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { CI_CATEGORIES } from '../scripts/ci/registry.mjs';
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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CI_CATEGORIES, registerCheck } from '../scripts/ci/registry.mjs';
import { classifyDeepGateDiff } from '../scripts/ci/deep-gate.mjs';
import { runChecks, runCli, runLevel } from '../scripts/ci/run-category.mjs';
import { loadCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import { sampleCanonicalRecordLine, syntheticRelationPacket } from './helpers/synthetic-data.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function workflowStepRun(workflow, stepName, { changesOutcome, deepMode, runLevel, runDeep }) {
  const step = workflow.split(`      - name: ${stepName}\n`)[1]
    ?.split('\n      - name: ')[0];
  assert.ok(step, `workflow must define ${stepName}`);
  const condition = step.match(/^\s+if: \$\{\{ (.+) \}\}$/mu)?.[1];
  const run = step.match(/^\s+run: (.+)$/mu)?.[1];
  assert.ok(condition, `${stepName} must have an explicit gate condition`);
  assert.ok(run, `${stepName} must run a concrete command`);

  const selectiveCondition = "steps.changes.outcome == 'success' && steps.changes.outputs.deep_mode == 'selective'";
  const normalCondition = "steps.changes.outcome != 'success' || (steps.changes.outputs.run_level == 'normal' && steps.changes.outputs.deep_mode != 'selective')";
  if (stepName === 'Normal validation (fast checkpoint + continuation)') {
    assert.equal(condition, normalCondition);
    return changesOutcome !== 'success' || (runLevel === 'normal' && deepMode !== 'selective') ? run : undefined;
  }
  if (stepName === 'Selective Deep validation (Normal + affected current Deep)') {
    assert.equal(condition, selectiveCondition);
    return changesOutcome === 'success' && deepMode === 'selective' ? run : undefined;
  }
  assert.fail(`unexpected workflow gate step: ${stepName}`);
}

function workflowCommandArgv(command, { baseSha, headSha }) {
  const match = command.match(/^pnpm run (ci:[\w-]+)(?: (.*))?$/u);
  assert.ok(match, `workflow gate must invoke a registered pnpm CI command: ${command}`);
  const args = (match[2]?.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map((argument) => {
    const unquoted = argument.replace(/^(?:"([^"]*)"|'([^']*)')$/u, (_whole, doubleQuoted, singleQuoted) => (
      doubleQuoted ?? singleQuoted
    ));
    if (unquoted === '$BASE_SHA') return baseSha;
    if (unquoted === '$HEAD_SHA') return headSha;
    return unquoted;
  });
  return [match[1].slice('ci:'.length), ...args];
}

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
    }, { owner: 'relations', tier: 'normal', schedule: 'manual' }),
  ];
  const seen = [];
  const context = { phase: 'normal' };
  const previousPhase = process.env.TYPEWRITER_CI_PHASE;
  try {
    process.env.TYPEWRITER_CI_PHASE = 'normal';
    await runChecks(checks, context, {
      executionPolicy: {
        tiers: ['normal', 'deep'],
        includeManual: false,
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

test('the retired candidate CI level is not selectable', async () => {
  await assert.rejects(runLevel('candidates', {
    log: () => {},
    createSession: () => { throw new Error('unknown CI level must fail before creating a session'); },
  }), /Unknown CI level or category: candidates/u);
});

test('automatic CI child checks do not inherit a shared production database path', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-database-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'child-env.json');
  const keys = [
    'TYPEWRITER_SHARED_DICTIONARY_PATH',
    'TYPEWRITER_SEARCH_REGRESSION_DATABASE',
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = '/stale/current-canonical.sqlite';
    await runChecks([{
      label: 'inspect database handoff boundary',
      command: () => ({
        executable: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.env.TYPEWRITER_SHARED_DICTIONARY_PATH ?? null, process.env.TYPEWRITER_SEARCH_REGRESSION_DATABASE ?? null]))',
          outputPath,
        ],
      }),
    }], {}, { log: () => {} });
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), [null, null]);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('ci:all completes Normal before Deep checks in the same domain with zero current-canonical builds', async () => {
  const state = { normalComplete: false, order: [] };
  const deepCheck = registerCheck({
    label: 'synthetic Deep data projection',
    command: () => ({ executable: 'synthetic', args: ['deep-data'] }),
  }, { owner: 'canonical', tier: 'deep' });
  const normalCheck = registerCheck({
    label: 'synthetic Normal data audit',
    command: () => ({ executable: 'synthetic', args: ['normal-data'] }),
  }, { owner: 'canonical', tier: 'normal' });
  const checks = [deepCheck, normalCheck];

  await assert.rejects(
    runChecks(checks, { phase: 'normal', completedChecks: new Set() }, {
      executionPolicy: {
        tiers: ['normal', 'deep'],
        includeManual: false,
      },
      log: () => {},
      execute: async ({ args }) => {
        if (args[0] === 'deep-data' && !state.normalComplete) {
          throw new Error('Deep data validation started before Normal completed');
        }
      },
    }),
    /before Normal completed/u,
    'the adversarial fixture must reject a Deep check before Normal completes',
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
        if (args[0] === 'normal-data') {
          assert.equal(context.phase, 'normal');
          state.normalComplete = true;
          state.order.push('normal');
          return;
        }
        assert.equal(args[0], 'deep-data');
        assert.equal(state.normalComplete, true);
        assert.equal(context.phase, 'deep');
        const ledger = (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(ledger.filter((event) => event.type === 'sqlite-build').length, 0);
        state.order.push('deep');
      },
    });

    assert.deepEqual(state.order, ['normal', 'deep']);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('PR workflow routes an affected exact-head Deep gate into ci:pr and only its selected check', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-pr-selection-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const canonicalRevision = 'synthetic-pr-current-revision';
  const normalCheck = registerCheck({
    label: 'synthetic Normal completeness gate',
    command: () => ({ executable: 'synthetic', args: ['normal'] }),
  }, { owner: 'canonical', tier: 'normal' });
  const selectedDeepDefinition = CI_CATEGORIES.deep.checks.find(
    (check) => check.inProcess === 'deep-data-projection-reproducibility',
  );
  const selectedDeep = registerCheck({
    label: selectedDeepDefinition.label,
    command: () => ({ executable: 'synthetic', args: ['deep'] }),
  }, {
    owner: selectedDeepDefinition.owner,
    tier: 'deep',
    schedule: 'affected',
    paths: ['scripts/normalize'],
  });
  const unrelatedDeep = CI_CATEGORIES.relations.checks.find(
    (check) => check.label === 'Test Canonical relation backfill queue, apply, and correction paths',
  );
  const categories = {
    canonical: { label: 'Synthetic canonical gates', checks: [normalCheck, selectedDeep, unrelatedDeep] },
  };
  const executed = [];
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  for (const changedPath of ['scripts/normalize/canonical.mjs']) {
    const scenarioDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-pr-scenario-'));
    t.after(() => rm(scenarioDirectory, { recursive: true, force: true }));
    const ledgerPath = path.join(scenarioDirectory, 'ledger.jsonl');
    await writeFile(ledgerPath, '', 'utf8');
    executed.length = 0;
    const impact = classifyDeepGateDiff(baseSha, headSha, {
      runGit: (args) => {
        assert.equal(args[0], 'diff');
        assert.ok(args.includes('--name-only'));
        return Buffer.from(`${changedPath}\0`);
      },
    });
    assert.equal(impact.deepMode, 'selective', changedPath);
    const workflowRun = workflowStepRun(
      workflow,
      'Selective Deep validation (Normal + affected current Deep)',
      { changesOutcome: 'success', deepMode: impact.deepMode },
    );
    assert.equal(workflowStepRun(
      workflow,
      'Normal validation (fast checkpoint + continuation)',
      { changesOutcome: 'success', runLevel: 'normal', deepMode: impact.deepMode },
    ), undefined);
    const runnerArgv = workflowCommandArgv(workflowRun, { baseSha, headSha });
    assert.deepEqual(runnerArgv, ['pr', '--', '--base', baseSha, '--head', headSha]);

    await runCli(runnerArgv, {
      getCurrentHead: () => headSha,
      classify: (base, head) => {
        assert.equal(base, baseSha);
        assert.equal(head, headSha);
        return impact;
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
        temporaryDirectory: scenarioDirectory,
        processMetrics: { path: ledgerPath },
        phase: 'normal',
      }),
      log: () => {},
      execute: async (command, context, check) => {
        executed.push(`${context.phase}:${check.label}`);
        assert.equal(context.canonicalContext.metrics.sqlite_build_count, 0);
        assert.ok(command.args.length > 0);
      },
    });

    assert.deepEqual(executed, [
      'normal:synthetic Normal completeness gate',
      `deep:${selectedDeep.label}`,
    ], changedPath);
  }

  const canonicalPath = 'data/canonical/sample.jsonl';
  const originalRecord = JSON.parse(sampleCanonicalRecordLine());
  const changedRecord = { ...originalRecord, lemma: `${originalRecord.lemma}확인` };
  const packetPath = 'data/relation-backfill/R999999.json';
  const packet = syntheticRelationPacket('R999999');
  const relationRepairPaths = [
    canonicalPath,
    packetPath,
    'data/inventory/issue-210-recovery-inventory.json',
    'data/validation/canonical-semantic-decision-source.json',
    'data/validation/issue-512-relation-repair-report.json',
    'docs/relation-pilot-repair-issue-507.md',
  ];
  const relationRepairValues = new Map([
    [packetPath, packet],
    ['data/inventory/issue-210-recovery-inventory.json', { records: [] }],
    ['data/validation/canonical-semantic-decision-source.json', { contract_version: 'fixture' }],
    ['data/validation/issue-512-relation-repair-report.json', { outcome: 'fixture' }],
  ]);
  const relationRepairImpact = classifyDeepGateDiff(baseSha, headSha, {
    runGit: (args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) {
        return Buffer.from(`${relationRepairPaths.join('\0')}\0`);
      }
      if (args[0] === 'diff' && args.includes('--unified=0')) {
        return Buffer.from(`--- a/${canonicalPath}\n+++ b/${canonicalPath}\n@@ -1 +1 @@\n-${JSON.stringify(originalRecord)}\n+${JSON.stringify(changedRecord)}\n`);
      }
      if (args[0] === 'show') {
        const filePath = args[1].split(':').slice(1).join(':');
        if (!relationRepairValues.has(filePath)) throw new Error(`unexpected HEAD data path: ${filePath}`);
        return Buffer.from(JSON.stringify(relationRepairValues.get(filePath)));
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    },
  });
  const searchBarImpact = classifyDeepGateDiff(baseSha, headSha, {
    runGit: (args) => {
      assert.equal(args[0], 'diff');
      return Buffer.from('src/components/SearchBar.vue\0');
    },
  });
  for (const [changeLabel, impact] of [
    ['relation-only correction', relationRepairImpact],
    ['unrelated SearchBar UI', searchBarImpact],
  ]) {
    assert.equal(impact.deepMode, 'none', changeLabel);
    const normalRun = workflowStepRun(
      workflow,
      'Normal validation (fast checkpoint + continuation)',
      {
        changesOutcome: 'success',
        deepMode: impact.deepMode,
        runLevel: 'normal',
        runDeep: String(impact.runDeep),
      },
    );
    assert.equal(normalRun, 'pnpm run ci:normal', changeLabel);
    assert.equal(workflowStepRun(
      workflow,
      'Selective Deep validation (Normal + affected current Deep)',
      { changesOutcome: 'success', deepMode: impact.deepMode },
    ), undefined, changeLabel);
    assert.deepEqual(workflowCommandArgv(normalRun, { baseSha, headSha }), ['normal'], changeLabel);
  }

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
  const categories = {
    canonical: {
      label: 'Mixed-tier canonical scope',
      checks: [deepCheck, normalCheck],
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

test('PR workflow uses Normal for classifier fallback and never executes Full Deep', async () => {
  const workflow = await readFile(path.resolve(TEST_DIRECTORY, '../.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(workflow, /pnpm run ci:all|Full Deep validation/u);
  const name = 'Normal validation (fast checkpoint + continuation)';
  for (const [changesOutcome, runLevel, deepMode] of [
    ['success', 'normal', 'none'],
    ['failure', 'normal', undefined],
    ['failure', 'none', undefined],
  ]) {
    assert.equal(workflowStepRun(workflow, name, { changesOutcome, runLevel, deepMode }), 'pnpm run ci:normal');
  }
  assert.equal(workflowStepRun(workflow, name, {
    changesOutcome: 'success', runLevel: 'none', deepMode: 'none',
  }), undefined);
  assert.equal(workflowStepRun(workflow, name, {
    changesOutcome: 'success', runLevel: 'normal', deepMode: 'none',
  }), 'pnpm run ci:normal');
  assert.equal(workflowStepRun(workflow, name, {
    changesOutcome: 'success', runLevel: 'normal', deepMode: 'selective',
  }), undefined);
});

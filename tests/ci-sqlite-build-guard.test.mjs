import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBuildEventsMatchPhase,
  assertChildEvidenceAdvanced,
  assertNoCurrentRevisionBuild,
  BuildLedgerError,
  readBuildLedger,
  summarizeBuildLedger,
} from '../scripts/ci/sqlite-build-ledger.mjs';
import { CI_CATEGORIES, CI_NORMAL_CATEGORY_ORDER } from '../scripts/ci/registry.mjs';
import { runChecks } from '../scripts/ci/run-category.mjs';

const REVISION = 'a'.repeat(64);
const OTHER_REVISION = 'b'.repeat(64);
const PARENT = 100;
const CHILD = 200;
const RUNNER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/ci-build-guard/runner.mjs',
);

const build = (pid, revision, phase = 'normal', count = 1) => ({
  type: 'sqlite-build', pid, count, canonical_directory: '/canonical', canonical_revision: revision, phase,
});
const summarize = (events) => summarizeBuildLedger(events, {
  canonicalRevision: REVISION,
  parentPid: PARENT,
});
const gate = (events, parentContextBuildCount) => assertNoCurrentRevisionBuild(summarize(events), {
  stage: 'test',
  parentContextBuildCount,
});

test('guard accepts zero current-canonical builds and permits independent fixture database tests', () => {
  gate([]);
  gate([build(CHILD, OTHER_REVISION), build(CHILD + 1, OTHER_REVISION)]);
  const summary = summarize([build(CHILD, OTHER_REVISION), build(CHILD + 1, OTHER_REVISION)]);
  assert.equal(summary.other_revision_sqlite_build_count, 2);
  assert.equal(summary.all_sqlite_build_count, 2);
  assert.equal(summary.child_current_revision_sqlite_build_count, 0);
  assert.equal(summary.current_revision_sqlite_build_count, 0);
  assert.equal(summary.deep_current_revision_sqlite_build_count, 0);
});

test('guard rejects any current-canonical build in Normal or Deep', () => {
  assert.throws(() => gate([build(PARENT, REVISION)], 1), /current_canonical_full_lite_build_count=1/u);
  assert.throws(() => gate([build(PARENT, REVISION, 'normal', 2)], 2), /current_canonical_full_lite_build_count=2/u);
  assert.throws(
    () => gate([build(CHILD, REVISION)]),
    /current_canonical_full_lite_build_count=1/u,
  );
  assert.throws(
    () => gate([build(CHILD, REVISION, 'deep')]),
    /current_canonical_full_lite_build_count=1/u,
  );
});

test('ledger reports any Deep current-canonical build against the zero-build contract', () => {
  const summary = summarize([build(CHILD, REVISION, 'deep')]);
  assert.equal(summary.deep_current_revision_sqlite_build_count, 1);
  assert.equal(summary.current_revision_sqlite_build_count, 0);
  assert.throws(() => gate([build(CHILD, REVISION, 'deep')]), /current_canonical_full_lite_build_count=1/u);
});

test('guard fails when the build function counter and ledger disagree', () => {
  assert.throws(
    () => gate([], 1),
    /shared context counted 1 parent build/u,
  );
});

test('per-command guard rejects a current-revision build and a missing metrics hook', () => {
  assert.throws(
    () => assertNoCurrentRevisionBuild(summarize([build(CHILD, REVISION)]), { stage: 'cmd' }),
    /Automatic CI must not build Full or Lite SQLite for the exact current canonical revision \(cmd\)/u,
  );
  assertNoCurrentRevisionBuild(summarize([build(CHILD, OTHER_REVISION)]), { stage: 'cmd' });
  const before = summarize([{ type: 'process', pid: CHILD, peak_rss_kb: 1 }]);
  assert.throws(() => assertChildEvidenceAdvanced(before, before, 'cmd'), /hook was omitted/u);
});

test('malformed or unreadable ledgers fail closed instead of reporting zero builds', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-ledger-test-'));
  try {
    const ledgerPath = path.join(directory, 'ledger.jsonl');
    const cases = [
      ['not-json', /not valid JSON/u],
      [JSON.stringify({ type: 'sqlite-build', pid: 1, count: 1 }), /canonical directory|phase|revision/u],
      [JSON.stringify({ ...build(1, REVISION), phase: 'whatever' }), /unknown CI phase/u],
      [JSON.stringify({ ...build(1, REVISION), count: 0 }), /invalid build count/u],
      [JSON.stringify({ type: 'process', pid: 1 }), /peak RSS/u],
      [JSON.stringify({ type: 'mystery', pid: 1 }), /unknown event type/u],
    ];
    for (const [line, pattern] of cases) {
      await writeFile(ledgerPath, `${line}\n`, 'utf8');
      assert.throws(() => readBuildLedger(ledgerPath), (error) => (
        error instanceof BuildLedgerError && pattern.test(error.message)
      ), line);
    }
    assert.throws(
      () => readBuildLedger(path.join(directory, 'missing.jsonl')),
      /unreadable/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a nested runner without a phase inherits the phase of its process', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-phase-test-'));
  const previous = process.env.TYPEWRITER_CI_PHASE;
  try {
    for (const phase of ['deep', 'normal']) {
      const out = path.join(directory, `${phase}.txt`);
      process.env.TYPEWRITER_CI_PHASE = phase;
      await runChecks([{
        label: `report phase ${phase}`,
        command: () => ({
          executable: process.execPath,
          args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.env.TYPEWRITER_CI_PHASE)', out],
        }),
      }], {}, { log: () => {} });
      assert.equal(await readFile(out, 'utf8'), phase);
    }
  } finally {
    if (previous === undefined) delete process.env.TYPEWRITER_CI_PHASE;
    else process.env.TYPEWRITER_CI_PHASE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

function runFixture(scenario, level = 'normal') {
  const env = { ...process.env, TYPEWRITER_ALLOW_DIRTY: 'true' };
  for (const key of [
    'TYPEWRITER_PROCESS_METRICS_PATH',
    'TYPEWRITER_CI_PHASE',
    'TYPEWRITER_SHARED_DICTIONARY_PATH',
    'TYPEWRITER_SEARCH_REGRESSION_DATABASE',
    'NODE_TEST_CONTEXT',
  ]) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, [RUNNER, scenario, level], {
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
  const evidence = [...result.stdout.matchAll(/=== (\w+) evidence ===\n([\s\S]*?\n\})/gu)]
    .map((match) => ({ level: match[1], ...JSON.parse(match[2]) }));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, evidence };
}

test('real normal run: zero current-canonical builds passes and fixture database tests are counted separately', () => {
  const result = runFixture('zero-build');
  assert.equal(result.status, 0, result.stderr);
  const final = result.evidence.at(-1).metrics;
  assert.equal(final.parent_current_revision_sqlite_build_count, 0);
  assert.equal(final.child_current_revision_sqlite_build_count, 0);
  assert.equal(final.current_revision_sqlite_build_count, 0);
  assert.equal(final.deep_current_revision_sqlite_build_count, 0);
  assert.equal(final.automatic_ci_current_canonical_sqlite_build_count, 0);
  assert.equal(final.other_revision_sqlite_build_count, 1);
  assert.equal(final.all_sqlite_build_count, 1);
  assert.equal(result.evidence[0].level, 'fast', 'fast checkpoint records the zero-build contract');
  assert.equal(result.evidence[0].sqlite_build_policy.current_canonical_full_lite_builds_observed, 0);
});

const FAILURES = [
  ['current-normal', /current_canonical_full_lite_build_count=1/u],
  ['current-twice', /current_canonical_full_lite_build_count=2/u],
  ['current-without-normal-prior', /current_canonical_full_lite_build_count=1/u],
  ['hook-omitted', /no child process metrics were recorded/u],
  ['mislabeled-as-deep', /recorded as phase deep .* while the runner was in the normal phase/u],
  ['nested-normal', /current_canonical_full_lite_build_count=1/u],
  ['malformed-ledger', /not valid JSON/u],
  ['deleted-ledger', /ledger is unreadable/u],
];
for (const [scenario, pattern] of FAILURES) {
  test(`real normal run rejects a current-canonical database build or missing evidence: ${scenario}`, () => {
    const result = runFixture(scenario);
    assert.notEqual(result.status, 0, 'a violated zero-build invariant must fail automatic CI');
    assert.match(result.stderr, pattern);
  });
}

test('real all run: current-canonical Deep rebuilds fail the zero-build contract', () => {
  const result = runFixture('deep-independent', 'all');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current_canonical_full_lite_build_count=2/u);
});

test('real all run: a nested validator build in the Deep phase fails', () => {
  const result = runFixture('nested-deep', 'all');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current_canonical_full_lite_build_count=1/u);
});

test('phase of a build event must match the phase the runner executes', () => {
  const event = { type: 'sqlite-build', pid: 7, count: 1, canonical_directory: '/c', canonical_revision: REVISION };
  assertBuildEventsMatchPhase([{ ...event, phase: 'normal' }], 'normal', 'cmd');
  assertBuildEventsMatchPhase([{ ...event, phase: 'deep' }], 'deep', 'cmd');
  assertBuildEventsMatchPhase([{ type: 'process', pid: 7, peak_rss_kb: 1 }], 'normal', 'cmd');
  assert.throws(() => assertBuildEventsMatchPhase([{ ...event, phase: 'deep' }], 'normal', 'cmd'), /phase deep/u);
  assert.throws(() => assertBuildEventsMatchPhase([{ ...event, phase: 'normal' }], 'deep', 'cmd'), /phase normal/u);
});

test('registry: no automatic CI check opts out of the zero current-canonical build guard', () => {
  const independent = (categoryName) => CI_CATEGORIES[categoryName].checks
    .filter((check) => check.independentCurrentRevisionBuilds);
  for (const categoryName of CI_NORMAL_CATEGORY_ORDER) {
    assert.deepEqual(independent(categoryName), [], `${categoryName} must not build or reuse a current-canonical database`);
  }
});

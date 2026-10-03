import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertChildEvidenceAdvanced,
  assertNoChildCurrentRevisionBuild,
  assertSingleCurrentRevisionBuild,
  BuildLedgerError,
  readBuildLedger,
  summarizeBuildLedger,
} from '../scripts/ci/sqlite-build-ledger.mjs';
import {
  prepareCurrentRevisionDatabases,
  SharedDatabaseError,
} from '../scripts/ci/current-revision-database.mjs';
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
const gate = (events) => assertSingleCurrentRevisionBuild(summarize(events), { stage: 'test' });

test('guard passes one parent build; other-revision fixture builds do not count', () => {
  gate([build(PARENT, REVISION)]);
  gate([build(PARENT, REVISION), build(CHILD, OTHER_REVISION), build(CHILD, OTHER_REVISION)]);
  const summary = summarize([build(PARENT, REVISION), build(CHILD, OTHER_REVISION)]);
  assert.equal(summary.other_revision_sqlite_build_count, 1);
  assert.equal(summary.all_sqlite_build_count, 2);
  assert.equal(summary.child_current_revision_sqlite_build_count, 0);
});

test('guard fails zero, duplicate parent, and parent plus child current-revision builds', () => {
  assert.throws(() => gate([]), /parent_current_revision_sqlite_build_count=0/u);
  assert.throws(() => gate([build(CHILD, OTHER_REVISION)]), /expected 1/u);
  assert.throws(() => gate([build(PARENT, REVISION), build(PARENT, REVISION)]), /=2 \(expected 1\)/u);
  assert.throws(() => gate([build(PARENT, REVISION, 'normal', 2)]), /=2 \(expected 1\)/u);
  assert.throws(
    () => gate([build(PARENT, REVISION), build(CHILD, REVISION)]),
    /child_current_revision_sqlite_build_count=1/u,
  );
  assert.throws(
    () => gate([build(PARENT, REVISION), build(CHILD, REVISION), build(CHILD + 1, REVISION)]),
    /child_current_revision_sqlite_build_count=2/u,
  );
});

test('deep-phase builds are accounted separately and never relax the normal gate', () => {
  gate([build(PARENT, REVISION), build(CHILD, REVISION, 'deep'), build(CHILD + 1, REVISION, 'deep')]);
  const summary = summarize([build(PARENT, REVISION), build(CHILD, REVISION, 'deep')]);
  assert.equal(summary.deep_current_revision_sqlite_build_count, 1);
  assert.equal(summary.current_revision_sqlite_build_count, 1);
  assert.throws(() => gate([build(CHILD, REVISION, 'deep')]), /expected 1/u);
});

test('guard fails when the shared context and the ledger disagree on parent builds', () => {
  assert.throws(
    () => assertSingleCurrentRevisionBuild(summarize([build(PARENT, REVISION)]), {
      stage: 'test',
      parentContextBuildCount: 0,
    }),
    /shared context counted 0 parent build/u,
  );
});

test('per-command guard rejects a child current-revision build and a missing metrics hook', () => {
  assert.throws(
    () => assertNoChildCurrentRevisionBuild(summarize([build(CHILD, REVISION)]), 'cmd'),
    /cmd: a child process built the exact current canonical revision/u,
  );
  assertNoChildCurrentRevisionBuild(summarize([build(CHILD, OTHER_REVISION)]), 'cmd');
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

test('shared artifact reuse is bound to the revision the validator read from canonical bytes', async () => {
  await assert.rejects(
    prepareCurrentRevisionDatabases({
      canonicalRevision: REVISION,
      temporaryDirectory: '/unused',
      repositoryDirectory: '/unused',
      sharedDatabasePath: '/nonexistent/dictionary.sqlite',
    }),
    SharedDatabaseError,
  );
  await assert.rejects(
    prepareCurrentRevisionDatabases({
      canonicalRevision: '',
      temporaryDirectory: '/unused',
      repositoryDirectory: '/unused',
    }),
    /canonical revision is required/u,
  );
});

test('a shared artifact of another revision fails closed unless the run targets another canonical', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-shared-revision-test-'));
  try {
    const sharedPath = path.join(directory, 'shared.sqlite');
    const database = new DatabaseSync(sharedPath);
    database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    database.prepare('INSERT INTO metadata VALUES (?, ?)').run('canonical_revision', OTHER_REVISION);
    database.close();
    const common = {
      canonicalRevision: REVISION,
      temporaryDirectory: directory,
      repositoryDirectory: directory,
      sharedDatabasePath: sharedPath,
    };
    await assert.rejects(prepareCurrentRevisionDatabases(common), /does not match/u);
    const built = [];
    const result = await prepareCurrentRevisionDatabases({
      ...common,
      independentBuilds: 1,
      onRevisionMismatch: 'build',
      build: async ({ outputPath }) => { built.push(outputPath); },
    });
    assert.equal(result.reusedSharedArtifact, false);
    assert.equal(built.length, 1);
    const matching = new DatabaseSync(sharedPath);
    matching.prepare('UPDATE metadata SET value = ?').run(REVISION);
    matching.close();
    const reused = await prepareCurrentRevisionDatabases({
      ...common,
      onRevisionMismatch: 'build',
      build: async () => { throw new Error('must reuse the matching shared artifact'); },
    });
    assert.deepEqual(reused, { databasePaths: [sharedPath], reusedSharedArtifact: true });
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

test('real normal run: one shared build passes and other-revision fixture builds are allowed', () => {
  const result = runFixture('one-build');
  assert.equal(result.status, 0, result.stderr);
  const final = result.evidence.at(-1).metrics;
  assert.equal(final.parent_current_revision_sqlite_build_count, 1);
  assert.equal(final.child_current_revision_sqlite_build_count, 0);
  assert.equal(final.current_revision_sqlite_build_count, 1);
  assert.equal(final.other_revision_sqlite_build_count, 1);
  assert.equal(final.all_sqlite_build_count, 2);
  assert.equal(result.evidence[0].level, 'fast', 'fast checkpoint reports the shared build');
  assert.equal(result.evidence[0].metrics.current_revision_sqlite_build_count, 1);
});

const FAILURES = [
  ['zero-build', /parent_current_revision_sqlite_build_count=0/u],
  ['two-parent-builds', /parent_current_revision_sqlite_build_count=2/u],
  ['parent-and-child', /child process built the exact current canonical revision/u],
  ['two-child-builds', /2 child build\(s\)/u],
  ['child-without-parent', /child process built the exact current canonical revision/u],
  ['hook-omitted', /no child process metrics were recorded/u],
  ['malformed-ledger', /not valid JSON/u],
  ['deleted-ledger', /ledger is unreadable/u],
];
for (const [scenario, pattern] of FAILURES) {
  test(`real normal run exits nonzero even though every command succeeds: ${scenario}`, () => {
    const result = runFixture(scenario);
    assert.notEqual(result.status, 0, 'a violated one-build invariant must fail normal CI');
    assert.match(result.stderr, pattern);
  });
}

test('real all run: independent deep rebuilds are allowed and normal stays one-build', () => {
  const result = runFixture('deep-independent', 'all');
  assert.equal(result.status, 0, result.stderr);
  const final = result.evidence.at(-1).metrics;
  assert.equal(final.current_revision_sqlite_build_count, 1);
  assert.equal(final.child_current_revision_sqlite_build_count, 0);
  assert.equal(final.deep_current_revision_sqlite_build_count, 2);
  assert.equal(final.all_sqlite_build_count, 3);
});

test('registry: deep owns the independent two-build proofs and normal never does', () => {
  const independent = (categoryName) => CI_CATEGORIES[categoryName].checks
    .filter((check) => check.independentCurrentRevisionBuilds);
  assert.ok(independent('deep').length >= 4);
  for (const categoryName of CI_NORMAL_CATEGORY_ORDER) {
    assert.deepEqual(independent(categoryName), [], `${categoryName} must reuse the shared artifact`);
  }
});

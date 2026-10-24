import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import { classifySqliteSchemaDiff } from './sqlite-schema-change.mjs';

const createTableKeyword = ['CREATE', 'TABLE'].join(' ');

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

async function writeRepoFile(directory, filePath, contents) {
  const absolutePath = path.join(directory, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
}

async function makeRepository() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-schema-diff-'));
  git(directory, ['init', '-q', '--initial-branch=master']);
  git(directory, ['config', 'user.name', 'CI fixture']);
  git(directory, ['config', 'user.email', 'ci-fixture@example.invalid']);
  await writeRepoFile(
    directory,
    'scripts/build/sqlite-schema.mjs',
    `export const schema = \`${createTableKeyword} records (id TEXT PRIMARY KEY);\`;\n`,
  );
  await writeRepoFile(directory, 'scripts/ci/registry.mjs', 'export const checks = [];\n');
  await writeRepoFile(directory, 'src/popup.js', 'export const popup = true;\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-qm', 'base']);
  return { directory, baseSha: git(directory, ['rev-parse', 'HEAD']) };
}

async function classifyChange({ directory, baseSha }, files, removals = []) {
  git(directory, ['reset', '--hard', baseSha]);
  for (const filePath of removals) {
    await rm(path.join(directory, filePath), { force: true });
  }
  for (const [filePath, contents] of Object.entries(files)) {
    await writeRepoFile(directory, filePath, contents);
  }
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-qm', 'change']);
  const headSha = git(directory, ['rev-parse', 'HEAD']);
  return classifySqliteSchemaDiff(baseSha, headSha, { repositoryDirectory: directory });
}

test('exact PR diffs for Candidate, Relation, Canonical and product-code changes stay database-free', async () => {
  const fixture = await makeRepository();
  try {
    const cases = [
      ['Candidate-only', 'data/relation-candidates/001/001_01_a_codex.jsonl'],
      ['Relation-only', 'data/relations/relation-001.jsonl'],
      ['Canonical-only', 'data/canonical/stdict-0001.jsonl'],
      ['product-code-only', 'src/runtime/popup.js'],
      ['test-fixture-only', 'tests/build-dictionary.test.mjs'],
    ];
    for (const [label, filePath] of cases) {
      const contents = label === 'test-fixture-only'
        ? `const fixtureSql = '${createTableKeyword} test_fixture (id TEXT PRIMARY KEY);';\n`
        : '{"fixture":true}\n';
      const result = await classifyChange(fixture, { [filePath]: contents });
      assert.equal(result.schemaChanged, false, label);
      assert.deepEqual(result.changedSchemaOwnerPaths, [], label);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('SQL schema edits, mixed changes, deletions and exact registered paths select the schema gate', async () => {
  const fixture = await makeRepository();
  try {
    const schema = `export const schema = \`${createTableKeyword} records (id TEXT PRIMARY KEY, lemma TEXT);\`;\n`;
    const single = await classifyChange(fixture, {
      'scripts/build/sqlite-schema.mjs': schema,
    });
    assert.equal(single.schemaChanged, true);
    assert.deepEqual(single.changedSchemaOwnerPaths, ['scripts/build/sqlite-schema.mjs']);

    const mixed = await classifyChange(fixture, {
      'scripts/build/sqlite-schema.mjs': schema,
      'data/canonical/stdict-0001.jsonl': '{"fixture":true}\n',
      'src/runtime/popup.js': 'export const popup = false;\n',
    });
    assert.equal(mixed.schemaChanged, true);
    assert.equal(mixed.changedSchemaOwnerPaths.length, 1);

    const deleted = await classifyChange(
      fixture,
      {},
      ['scripts/build/sqlite-schema.mjs'],
    );
    assert.equal(deleted.schemaChanged, true, 'a deleted owner remains in the no-renames diff');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('an added or moved SQL schema definition without a registered owner fails closed', async () => {
  const fixture = await makeRepository();
  try {
    await assert.rejects(
      classifyChange(fixture, {
        'scripts/build/sqlite-extra.mjs': `export const sql = \`${createTableKeyword} extra (id TEXT);\`;\n`,
      }),
      /Unregistered SQL schema owner in HEAD: scripts\/build\/sqlite-extra\.mjs/u,
    );

    git(fixture.directory, ['reset', '--hard', fixture.baseSha]);
    git(fixture.directory, ['mv', 'scripts/build/sqlite-schema.mjs', 'scripts/build/sqlite-renamed.mjs']);
    git(fixture.directory, ['commit', '-qm', 'move schema owner']);
    const headSha = git(fixture.directory, ['rev-parse', 'HEAD']);
    assert.throws(
      () => classifySqliteSchemaDiff(fixture.baseSha, headSha, {
        repositoryDirectory: fixture.directory,
      }),
      /Unregistered SQL schema owner in HEAD: scripts\/build\/sqlite-renamed\.mjs/u,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('malformed diff revisions fail closed', async () => {
  const fixture = await makeRepository();
  try {
    assert.throws(
      () => classifySqliteSchemaDiff('master', fixture.baseSha, {
        repositoryDirectory: fixture.directory,
      }),
      /baseSha must be a full lowercase/u,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

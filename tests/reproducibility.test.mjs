import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { resolveBuildProvenance } from '../scripts/build/provenance.mjs';
import { readLogicalDatabaseSnapshot } from '../scripts/build/query.mjs';

const execFile = promisify(execFileCallback);
const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PILOT_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');

async function createOutputDirectory() {
  return mkdtemp(path.join(tmpdir(), 'typewriter-reproducibility-'));
}

test('two independent builds have the same logical snapshot and provenance', async () => {
  const outputDirectory = await createOutputDirectory();
  const firstPath = path.join(outputDirectory, 'first.sqlite');
  const secondPath = path.join(outputDirectory, 'second.sqlite');

  try {
    const first = await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath: firstPath,
      checkPilotCompleteness: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });
    const second = await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath: secondPath,
      checkPilotCompleteness: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });

    assert.match(first.metadata.source_revision, /^[0-9a-f]{40}$/);
    assert.equal(first.metadata.source_revision, second.metadata.source_revision);
    assert.equal(first.metadata.source_revision_source, 'git-head');
    assert.equal(first.metadata.source_revision_verified, 'true');
    assert.ok(['clean', 'dirty-allowed'].includes(first.metadata.worktree_state));
    assert.equal(first.metadata.build_tool_version, '1');
    assert.equal(first.metadata.node_version, process.version);
    assert.equal(first.metadata.sqlite_module, 'node:sqlite');
    assert.match(first.metadata.sqlite_version, /^\d+\.\d+\.\d+$/);
    assert.equal(first.metadata.record_count, '670');
    assert.equal(first.metadata.start_count, '628');
    assert.equal(first.metadata.reference_only_count, '42');
    assert.equal(first.metadata.candidate_count, '628');
    assert.equal(first.metadata.search_form_count, '746');
    assert.equal(first.metadata.sense_count, '810');
    assert.equal(first.metadata.relation_count, '473');
    assert.equal(first.metadata.expression_count, '43');
    assert.equal(first.metadata.worktree_state, second.metadata.worktree_state);
    assert.deepEqual(first.metadata, second.metadata);
    assert.equal(Object.hasOwn(first.metadata, 'build_timestamp'), false);
    assert.equal(Object.hasOwn(first.metadata, 'input_path'), false);
    assert.equal(Object.hasOwn(first.metadata, 'output_path'), false);

    const firstDatabase = new DatabaseSync(firstPath, { readOnly: true });
    const secondDatabase = new DatabaseSync(secondPath, { readOnly: true });
    try {
      assert.deepEqual(
        readLogicalDatabaseSnapshot(firstDatabase),
        readLogicalDatabaseSnapshot(secondDatabase),
      );
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('rejects dirty repositories unless explicitly allowed', async () => {
  const repositoryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-git-provenance-'),
  );

  try {
    await execFile('git', ['init', '-q', '-b', 'master'], {
      cwd: repositoryDirectory,
    });
    await execFile('git', ['config', 'user.name', 'Typewriter Test'], {
      cwd: repositoryDirectory,
    });
    await execFile('git', ['config', 'user.email', 'typewriter@example.test'], {
      cwd: repositoryDirectory,
    });
    await writeFile(path.join(repositoryDirectory, 'tracked.txt'), 'clean\n');
    await execFile('git', ['add', 'tracked.txt'], { cwd: repositoryDirectory });
    await execFile('git', ['commit', '-q', '-m', 'initial'], {
      cwd: repositoryDirectory,
    });
    await writeFile(path.join(repositoryDirectory, 'tracked.txt'), 'dirty\n');

    await assert.rejects(
      resolveBuildProvenance({ repositoryDirectory }),
      (error) => {
        assert.equal(error.code, 'DIRTY_WORKTREE');
        return true;
      },
    );

    const allowed = await resolveBuildProvenance({
      repositoryDirectory,
      allowDirty: true,
    });
    assert.equal(allowed.worktree_state, 'dirty-allowed');
    assert.equal(allowed.source_revision_source, 'git-head');
    assert.equal(allowed.source_revision_verified, 'true');
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('accepts current HEAD refs and rejects a different explicit commit', async () => {
  const repositoryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-git-revisions-'),
  );

  try {
    await execFile('git', ['init', '-q', '-b', 'master'], {
      cwd: repositoryDirectory,
    });
    await execFile('git', ['config', 'user.name', 'Typewriter Test'], {
      cwd: repositoryDirectory,
    });
    await execFile('git', ['config', 'user.email', 'typewriter@example.test'], {
      cwd: repositoryDirectory,
    });
    await writeFile(path.join(repositoryDirectory, 'tracked.txt'), 'first\n');
    await execFile('git', ['add', 'tracked.txt'], { cwd: repositoryDirectory });
    await execFile('git', ['commit', '-q', '-m', 'first'], {
      cwd: repositoryDirectory,
    });
    const firstRevision = (
      await execFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory })
    ).stdout.trim();

    await writeFile(path.join(repositoryDirectory, 'tracked.txt'), 'second\n');
    await execFile('git', ['add', 'tracked.txt'], { cwd: repositoryDirectory });
    await execFile('git', ['commit', '-q', '-m', 'second'], {
      cwd: repositoryDirectory,
    });
    const secondRevision = (
      await execFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory })
    ).stdout.trim();

    await assert.rejects(
      resolveBuildProvenance({
        repositoryDirectory,
        sourceRevision: firstRevision,
      }),
      (error) => {
        assert.equal(error.code, 'SOURCE_REVISION_MISMATCH');
        assert.match(error.message, /current Git HEAD/);
        return true;
      },
    );

    for (const revision of [
      'HEAD',
      'HEAD~0',
      secondRevision,
      secondRevision.slice(0, 8),
    ]) {
      const provenance = await resolveBuildProvenance({
        repositoryDirectory,
        sourceRevision: revision,
      });
      assert.equal(provenance.source_revision, secondRevision);
      assert.equal(provenance.source_revision_source, 'explicit-git');
      assert.equal(provenance.source_revision_verified, 'true');
      assert.equal(provenance.worktree_state, 'clean');
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('rejects invalid revisions and clearly marks Git-less injection', async () => {
  await assert.rejects(
    resolveBuildProvenance({
      repositoryDirectory: REPOSITORY_DIRECTORY,
      sourceRevision: 'not-a-commit',
      allowDirty: true,
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_SOURCE_REVISION');
      return true;
    },
  );

  const noGitDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-no-git-'),
  );
  try {
    await assert.rejects(
      resolveBuildProvenance({ repositoryDirectory: noGitDirectory }),
      (error) => {
        assert.equal(error.code, 'SOURCE_REVISION_UNAVAILABLE');
        return true;
      },
    );

    const injected = await resolveBuildProvenance({
      repositoryDirectory: noGitDirectory,
      sourceRevision: 'A'.repeat(40),
    });
    assert.equal(injected.source_revision, 'a'.repeat(40));
    assert.equal(injected.source_revision_source, 'explicit-unverified');
    assert.equal(injected.source_revision_verified, 'false');
    assert.equal(injected.worktree_state, 'unavailable');
  } finally {
    await rm(noGitDirectory, { recursive: true, force: true });
  }
});

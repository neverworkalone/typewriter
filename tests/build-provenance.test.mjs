import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveBuildProvenance } from '../scripts/build/provenance.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileCallback);
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
    await execFile('git', ['config', 'commit.gpgsign', 'false'], {
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
    await execFile('git', ['config', 'commit.gpgsign', 'false'], {
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

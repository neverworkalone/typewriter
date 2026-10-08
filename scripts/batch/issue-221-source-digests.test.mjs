import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertIssue221SourceDigestsRetained, ISSUE_221_SOURCE_TOOLS } from './issue-221-source-digests.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Issue #221 source bindings accept retained tool versions and reject unknown digests', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-221-source-digests-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repositoryRoot });
    execFileSync('git', [
      '-c', 'user.name=Typewriter Test',
      '-c', 'user.email=test@example.com',
      'config', 'core.autocrlf', 'false',
    ], { cwd: repositoryRoot });
    const tools = {};
    for (const { key, relativePath } of ISSUE_221_SOURCE_TOOLS) {
      const file = path.join(repositoryRoot, relativePath);
      const historicalBytes = Buffer.from(`historical ${key}\n`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, historicalBytes);
      tools[key] = sha256(historicalBytes);
    }
    execFileSync('git', ['add', ...ISSUE_221_SOURCE_TOOLS.map(({ relativePath }) => relativePath)], { cwd: repositoryRoot });
    execFileSync('git', [
      '-c', 'user.name=Typewriter Test',
      '-c', 'user.email=test@example.com',
      'commit', '-q', '-m', 'retain issue 221 source versions',
    ], { cwd: repositoryRoot });
    for (const { key, relativePath } of ISSUE_221_SOURCE_TOOLS) {
      await writeFile(path.join(repositoryRoot, relativePath), `current ${key}\n`);
    }

    assert.equal(await assertIssue221SourceDigestsRetained({ tools, repositoryRoot }), true);
    await assert.rejects(() => assertIssue221SourceDigestsRetained({
      tools: { ...tools, orchestrator_script_sha256: '0'.repeat(64) },
      repositoryRoot,
    }), /Issue #221 orchestrator source digest must match the current source or a source version retained in Git history/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

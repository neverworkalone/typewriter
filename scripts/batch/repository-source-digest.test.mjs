import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSourceDigestRetained } from './repository-source-digest.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('historical source digests remain verifiable after a tooling file changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-source-digest-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Typewriter Test', '-c', 'user.email=test@example.com', 'config', 'core.autocrlf', 'false'], { cwd: root });
    const relativePath = 'scripts/reference/extractor.py';
    const file = path.join(root, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    const historical = Buffer.from('historical source\n');
    await writeFile(file, historical);
    execFileSync('git', ['add', relativePath], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Typewriter Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'historical source'], { cwd: root });
    const expectedDigest = sha256(historical);
    await writeFile(file, 'shared-cache source\n');

    assert.equal(await assertSourceDigestRetained({ relativePath, expectedDigest, label: 'extractor', repositoryRoot: root }), true);
    await assert.rejects(() => assertSourceDigestRetained({
      relativePath,
      expectedDigest: '0'.repeat(64),
      label: 'extractor',
      repositoryRoot: root,
    }), /source version retained in Git history/u);
    assert.equal(await readFile(file, 'utf8'), 'shared-cache source\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

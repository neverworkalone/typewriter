import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { removeSourceIfUnchanged } from './migrate-local-reference.mjs';

const SCRIPT = fileURLToPath(new URL('./migrate-local-reference.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-reference-migration-'));
  const source = path.join(root, 'old-worktree', 'data', 'reference');
  const cache = path.join(root, 'home', '.cache', 'typewriter');
  await mkdir(source, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--source', source, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TYPEWRITER_CACHE_ROOT: cache },
  });
  return { root, source, cache, run };
}

test('migration plan is read-only and apply maps legacy areas while preserving file bytes', async () => {
  const { root, source, cache, run } = await fixture();
  try {
    const files = [
      ['corpus/source.json', '{"source":"fixture"}\n'],
      ['public-domain/poem/work.txt', 'synthetic poem\n'],
      ['indexes/index.sqlite', 'fixture database bytes'],
      ['production/issue-223/run-01/candidate-evidence.json', '{"contract":"fixture"}\n'],
      ['pilots/issue-201/pilot-inventory.json', '{"pilot":true}\n'],
      ['literature-evidence/C000003/C000003-0001.pack.json', '{"pack":true}\n'],
    ];
    for (const [relative, content] of files) {
      const file = path.join(source, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await mkdir(path.join(source, 'production', 'issue-222', '.venv', 'bin'), { recursive: true });
    await writeFile(path.join(source, 'production', 'issue-222', '.venv', 'bin', 'python'), 'runtime');

    const plan = run();
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /"files_to_copy": 6/u);
    assert.match(plan.stdout, /tooling environment; not reference data/u);
    await assert.rejects(() => readFile(path.join(cache, 'corpus', 'source.json')), { code: 'ENOENT' });

    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    const mappings = [
      ['corpus/source.json', 'corpus/source.json'],
      ['public-domain/poem/work.txt', 'literature/poem/work.txt'],
      ['indexes/index.sqlite', 'indexes/index.sqlite'],
      ['production/issue-223/run-01/candidate-evidence.json', 'runs/issue-223/run-01/candidate-evidence.json'],
      ['pilots/issue-201/pilot-inventory.json', 'runs/issue-201-pilot/pilot-inventory.json'],
      ['literature-evidence/C000003/C000003-0001.pack.json', 'evidence/C000003/C000003-0001/pack.json'],
    ];
    for (const [oldRelative, newRelative] of mappings) {
      assert.deepEqual(await readFile(path.join(cache, newRelative)), await readFile(path.join(source, oldRelative)));
    }
    await readFile(path.join(source, 'corpus/source.json'));
    await readFile(path.join(source, 'production', 'issue-222', '.venv', 'bin', 'python'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a conflicting destination stops the migration before any new file is copied', async () => {
  const { root, source, cache, run } = await fixture();
  try {
    await mkdir(path.join(source, 'indexes'), { recursive: true });
    await mkdir(path.join(source, 'corpus'), { recursive: true });
    await mkdir(path.join(cache, 'indexes'), { recursive: true });
    await writeFile(path.join(source, 'indexes', 'corpus.sqlite'), 'source version');
    await writeFile(path.join(cache, 'indexes', 'corpus.sqlite'), 'different destination version');
    await writeFile(path.join(source, 'corpus', 'new.json'), '{"new":true}\n');

    const result = run('--apply');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /destinations conflict/u);
    await assert.rejects(() => readFile(path.join(cache, 'corpus', 'new.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(source, 'indexes', 'corpus.sqlite')), Buffer.from('source version'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--move removes the legacy tree only after shared-cache bytes verify', async () => {
  const { root, source, cache, run } = await fixture();
  try {
    await mkdir(path.join(source, 'indexes'), { recursive: true });
    await writeFile(path.join(source, 'indexes', 'corpus.sqlite'), 'verified database bytes');
    const result = run('--move');
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => readFile(path.join(source, 'indexes', 'corpus.sqlite')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(cache, 'indexes', 'corpus.sqlite')), Buffer.from('verified database bytes'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--move verifies copies first and retains the source when a runtime environment was excluded', async () => {
  const { root, source, cache, run } = await fixture();
  try {
    await mkdir(path.join(source, 'corpus'), { recursive: true });
    await mkdir(path.join(source, 'runs', 'sample', '.venv'), { recursive: true });
    await writeFile(path.join(source, 'corpus', 'source.json'), 'source');
    await writeFile(path.join(source, 'runs', 'sample', '.venv', 'marker'), 'runtime');

    const result = run('--move');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source removal was skipped/u);
    assert.deepEqual(await readFile(path.join(cache, 'corpus', 'source.json')), Buffer.from('source'));
    await readFile(path.join(source, 'corpus', 'source.json'));
    await readFile(path.join(source, 'runs', 'sample', '.venv', 'marker'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--move retains a same-size source edit made after copying and initial verification', async () => {
  const { root, source, cache } = await fixture();
  try {
    const relativePath = 'corpus/source.json';
    const sourceFile = path.join(source, relativePath);
    const cacheFile = path.join(cache, 'corpus', 'source.json');
    const copiedBytes = Buffer.from('before');
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(sourceFile, copiedBytes);
    await writeFile(cacheFile, copiedBytes);

    await assert.rejects(() => removeSourceIfUnchanged(source, [{
      relativePath,
      size: copiedBytes.length,
      digest: sha256(copiedBytes),
    }], {
      afterIsolation: async (isolatedSource) => {
        await writeFile(path.join(isolatedSource, relativePath), 'during');
      },
    }), /source bytes changed during migration.*original source was restored/u);

    assert.deepEqual(await readFile(sourceFile), Buffer.from('during'));
    assert.deepEqual(await readFile(cacheFile), copiedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

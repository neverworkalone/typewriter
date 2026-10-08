import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_INDEX_PATH, DEFAULT_INPUT_DIRECTORY } from './reference/corpus-index.mjs';
import { EVIDENCE_OUTPUT_DIRECTORY } from './reference/literature-evidence.mjs';
import { DEFAULT_FULL_LITERATURE_INDEX_PATH, DEFAULT_LITERATURE_INPUT_DIRECTORY } from './reference/literature-index.mjs';
import {
  assertWithinDirectory,
  cacheAreaPath,
  mapLegacyReferencePath,
  resolveCacheArtifactPath,
  resolveLegacyReferencePath,
  resolveTypewriterCachePaths,
} from './typewriter-cache.mjs';

const temporaryRoots = [];
after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('two Git worktrees resolve the same machine cache root', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'typewriter-cache-home-'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'typewriter-cache-worktrees-'));
  const repository = path.join(temporary, 'repo');
  const first = path.join(temporary, 'worktree-a');
  const second = path.join(temporary, 'worktree-b');
  temporaryRoots.push(home, temporary);
  await mkdir(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['-c', 'user.name=Typewriter Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'fixture'], { cwd: repository });
  execFileSync('git', ['worktree', 'add', '--detach', '-q', first, 'HEAD'], { cwd: repository });
  execFileSync('git', ['worktree', 'add', '--detach', '-q', second, 'HEAD'], { cwd: repository });

  const previousDirectory = process.cwd();
  try {
    process.chdir(first);
    const fromFirst = resolveTypewriterCachePaths({ homeDirectory: home, env: {} });
    process.chdir(second);
    const fromSecond = resolveTypewriterCachePaths({ homeDirectory: home, env: {} });
    assert.equal(fromFirst.root, path.join(home, '.cache', 'typewriter'));
    assert.equal(fromFirst.root, fromSecond.root);
    assert.equal(fromFirst.indexes, fromSecond.indexes);
  } finally {
    process.chdir(previousDirectory);
  }
});

test('the root override is shared by every cache area', () => {
  const paths = resolveTypewriterCachePaths({
    homeDirectory: '/unused/home',
    env: { TYPEWRITER_CACHE_ROOT: '/tmp/typewriter-cache-override' },
  });
  assert.equal(paths.root, '/tmp/typewriter-cache-override');
  assert.equal(paths.corpus, '/tmp/typewriter-cache-override/corpus');
  assert.equal(paths.literature, '/tmp/typewriter-cache-override/literature');
  assert.throws(() => resolveTypewriterCachePaths({ env: { TYPEWRITER_CACHE_ROOT: 'relative-cache' } }), /absolute path/u);
});

test('corpus and literature consumers resolve their defaults from the shared cache module', () => {
  const paths = resolveTypewriterCachePaths();
  assert.equal(DEFAULT_INPUT_DIRECTORY, paths.corpus);
  assert.equal(DEFAULT_INDEX_PATH, path.join(paths.indexes, 'written-corpus-2025.sqlite'));
  assert.equal(DEFAULT_LITERATURE_INPUT_DIRECTORY, paths.literature);
  assert.equal(DEFAULT_FULL_LITERATURE_INDEX_PATH, path.join(paths.indexes, 'public-domain-literature.sqlite'));
  assert.equal(EVIDENCE_OUTPUT_DIRECTORY, paths.evidence);
});

test('path traversal outside a cache area is rejected', () => {
  const paths = resolveTypewriterCachePaths({ homeDirectory: '/tmp/typewriter-home', env: {} });
  assert.throws(() => cacheAreaPath('runs', '..', 'evidence', 'candidate.json'), /must be below/u);
  assert.throws(() => assertWithinDirectory(paths.root, path.join(paths.root, '..', 'outside', 'artifact')),
    /must be below/u);
  assert.throws(() => resolveCacheArtifactPath('../outside.json', { paths }), /must be inside/u);
  assert.throws(() => resolveCacheArtifactPath('/tmp/outside.json', { paths }), /must be inside/u);
});

test('a cache-area symlink cannot redirect an artifact outside the machine cache', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'typewriter-cache-symlink-home-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'typewriter-cache-symlink-outside-'));
  temporaryRoots.push(home, outside);
  const paths = resolveTypewriterCachePaths({ homeDirectory: home, env: {} });
  await mkdir(paths.runs, { recursive: true });
  await symlink(outside, path.join(paths.runs, 'escape'));
  assert.throws(() => resolveCacheArtifactPath('runs/escape/artifact.json', { paths, areas: ['runs'] }), /symlink/u);
});

test('legacy reference paths map into the shared cache areas', () => {
  assert.equal(mapLegacyReferencePath('data/reference/corpus/source.json'), path.join('corpus', 'source.json'));
  assert.equal(mapLegacyReferencePath('data/reference/public-domain/poem/a.txt'), path.join('literature', 'poem', 'a.txt'));
  assert.equal(mapLegacyReferencePath('data/reference/production/issue-223/corpus-batch-01/evidence.json'),
    path.join('runs', 'issue-223', 'corpus-batch-01', 'evidence.json'));
  assert.equal(mapLegacyReferencePath('data/reference/literature-evidence/C000003/a.pack.json'),
    path.join('evidence', 'C000003', 'legacy', 'a.pack.json'));
  assert.equal(mapLegacyReferencePath('data/reference/literature-evidence/C000003/C000003-0012.pack.json'),
    path.join('evidence', 'C000003', 'C000003-0012', 'pack.json'));
  assert.equal(mapLegacyReferencePath('data/reference/pilots/issue-201/pilot-inventory.json'),
    path.join('runs', 'issue-201-pilot', 'pilot-inventory.json'));
  assert.equal(resolveLegacyReferencePath('data/reference/indexes/corpus.sqlite', {
    paths: resolveTypewriterCachePaths({ homeDirectory: '/tmp/typewriter-home', env: {} }),
  }), path.join('/tmp/typewriter-home', '.cache', 'typewriter', 'indexes', 'corpus.sqlite'));
  assert.equal(resolveCacheArtifactPath('data/reference/production/issue-222/batch-01/evidence.json', {
    paths: resolveTypewriterCachePaths({ homeDirectory: '/tmp/typewriter-home', env: {} }),
    areas: ['runs'],
  }), path.join('/tmp/typewriter-home', '.cache', 'typewriter', 'runs', 'issue-222', 'batch-01', 'evidence.json'));
  assert.throws(() => mapLegacyReferencePath('data/reference/runs/../outside.json'), /traversal/u);
});

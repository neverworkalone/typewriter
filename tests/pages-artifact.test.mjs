import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PRODUCT_LEGAL_FILES } from '../scripts/validate/product-output-contract.mjs';
import { validatePagesArtifact } from '../scripts/validate/pages-artifact.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REVISION = 'a'.repeat(40);
const CANONICAL_REVISION = 'b'.repeat(64);

async function createArtifact(t, {
  sourceRevision = SOURCE_REVISION,
  canonicalRevision = CANONICAL_REVISION,
  basePath = '/typewriter/',
  aboutBasePath = basePath,
  worktreeState = 'clean',
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-pages-artifact-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryDirectory, 'site');
  await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'about'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'chunks'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'runtime/vendor'), { recursive: true });

  const jsAsset = 'assets/index-12345678.js';
  const cssAsset = 'assets/index-abcdefgh.css';
  const chunkAsset = 'chunks/style-87654321.js';
  await writeFile(
    path.join(outputDirectory, 'index.html'),
    '<link rel="icon" href="' + basePath + 'favicon.ico">'
      + '<link rel="stylesheet" href="' + basePath + cssAsset + '">'
      + '<link rel="modulepreload" href="' + basePath + chunkAsset + '">'
      + '<script type="module" src="' + basePath + jsAsset + '"></script>',
  );
  await writeFile(
    path.join(outputDirectory, 'about/index.html'),
    '<link rel="icon" href="' + aboutBasePath + 'favicon.ico">'
      + '<link rel="stylesheet" href="' + aboutBasePath + cssAsset + '">'
      + '<link rel="modulepreload" href="' + aboutBasePath + chunkAsset + '">'
      + '<script type="module" src="' + aboutBasePath + jsAsset + '"></script>',
  );
  await writeFile(path.join(outputDirectory, 'favicon.ico'), await readFile(path.join(REPOSITORY_DIRECTORY, 'public/favicon.ico')));
  await writeFile(path.join(outputDirectory, jsAsset), 'void 0;');
  await writeFile(path.join(outputDirectory, cssAsset), 'body{}');
  await writeFile(path.join(outputDirectory, chunkAsset), 'void 0;');

  for (const fileName of PRODUCT_LEGAL_FILES) {
    await writeFile(
      path.join(outputDirectory, fileName),
      await readFile(path.join(REPOSITORY_DIRECTORY, fileName)),
    );
  }
  for (const fileName of [
    'runtime/dictionary-worker.mjs',
    'runtime/protocol.js',
    'runtime/query-adapter.js',
    'runtime/search-query.js',
    'runtime/vendor/sqlite3.mjs',
    'runtime/vendor/sqlite3.wasm',
  ]) {
    await writeFile(path.join(outputDirectory, fileName), 'fixture');
  }

  const databasePath = path.join(outputDirectory, 'dictionary.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(
    'CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);',
  );
  const insert = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  const metadata = {
    source_revision: sourceRevision,
    source_revision_source: 'git-head',
    source_revision_verified: 'true',
    worktree_state: worktreeState,
    canonical_revision: canonicalRevision,
  };
  for (const [key, value] of Object.entries(metadata)) insert.run(key, value);
  database.close();

  return { outputDirectory };
}

test('accepts an exact allowlisted Pages artifact with current clean provenance', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  const result = await validatePagesArtifact({
    outputDirectory,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    expectedSourceRevision: SOURCE_REVISION,
    expectedCanonicalRevision: CANONICAL_REVISION,
  });
  assert.equal(result.sourceRevision, SOURCE_REVISION);
  assert.equal(result.canonicalRevision, CANONICAL_REVISION);
  assert.ok(result.fileCount >= 12);
});

test('rejects extension manifests and any other unapproved artifact files', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'manifest.json'), '{}');
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_FILE' },
  );
});

test('rejects shared chunks that do not match the hashed Vite output pattern', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'chunks/unapproved.js'), 'void 0;');
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_FILE' },
  );
});

test('rejects an artifact that uses the site root instead of the repository Pages base path', async (t) => {
  const { outputDirectory } = await createArtifact(t, { basePath: '/' });
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_BASE_PATH' },
  );
});

test('requires the product introduction entrypoint in the Pages artifact', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await rm(path.join(outputDirectory, 'about/index.html'));
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_REQUIRED_FILE' },
  );
});

test('validates the product introduction asset paths against the repository Pages base path', async (t) => {
  const { outputDirectory } = await createArtifact(t, { aboutBasePath: '/' });
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_BASE_PATH' },
  );
});

test('rejects a dictionary bound to a different Git source revision', async (t) => {
  const { outputDirectory } = await createArtifact(t, {
    sourceRevision: 'c'.repeat(40),
    canonicalRevision: 'd'.repeat(64),
  });
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_SOURCE_REVISION' },
  );
});

test('rejects symlinks in the Pages artifact tree', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await symlink(
    path.join(outputDirectory, 'favicon.ico'),
    path.join(outputDirectory, 'assets/alias.svg'),
  );
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_SYMLINK' },
  );
});

test('rejects a Pages artifact root that is a symbolic link', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  const linkedDirectory = outputDirectory + '-link';
  await symlink(outputDirectory, linkedDirectory, 'dir');
  t.after(() => rm(linkedDirectory, { recursive: true, force: true }));
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory: linkedDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_DIRECTORY' },
  );
});

test('rejects a dictionary whose source worktree was not clean', async (t) => {
  const { outputDirectory } = await createArtifact(t, { worktreeState: 'dirty-allowed' });
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_SOURCE_REVISION' },
  );
});

test('rejects a dictionary built from a different canonical revision', async (t) => {
  const { outputDirectory } = await createArtifact(t, {
    canonicalRevision: 'd'.repeat(64),
  });
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_CANONICAL_REVISION' },
  );
});

test('rejects hard links in the Pages artifact tree', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await link(
    path.join(outputDirectory, 'assets/index-12345678.js'),
    path.join(outputDirectory, 'assets/alias-87654321.js'),
  );
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_HARDLINK' },
  );
});

test('rejects a favicon that differs from the Chrome Extension brand asset', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'favicon.ico'), 'changed');
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_FAVICON' },
  );
});

test('rejects legal files that differ from the approved product sources', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, PRODUCT_LEGAL_FILES[0]), 'changed');
  await assert.rejects(
    validatePagesArtifact({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedSourceRevision: SOURCE_REVISION,
      expectedCanonicalRevision: CANONICAL_REVISION,
    }),
    { code: 'PAGES_ARTIFACT_LEGAL_FILE' },
  );
});

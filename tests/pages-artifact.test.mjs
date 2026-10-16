import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PRODUCT_LEGAL_FILES } from '../scripts/validate/product-output-contract.mjs';
import {
  PAGES_BUILD_INFO_SCHEMA,
  validatePagesArtifact,
} from '../scripts/validate/pages-artifact.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REVISION = 'a'.repeat(40);

async function createArtifact(t, {
  sourceRevision = SOURCE_REVISION,
  basePath = '/typewriter/',
  aboutBasePath = basePath,
  worktreeState = 'clean',
  aboutRedirect = '../#philosophy',
  script = 'void 0;',
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-pages-artifact-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryDirectory, 'site');
  await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'about'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'chunks'), { recursive: true });

  const jsAsset = 'assets/main-12345678.js';
  const cssAsset = 'assets/main-abcdefgh.css';
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
    '<meta http-equiv="refresh" content="0; url=' + aboutRedirect + '">'
      + '<link rel="icon" href="' + aboutBasePath + 'favicon.ico">',
  );
  await writeFile(
    path.join(outputDirectory, 'favicon.ico'),
    await readFile(path.join(REPOSITORY_DIRECTORY, 'public/favicon.ico')),
  );
  await writeFile(path.join(outputDirectory, jsAsset), script);
  await writeFile(path.join(outputDirectory, cssAsset), 'body{}');
  await writeFile(path.join(outputDirectory, chunkAsset), 'void 0;');
  for (const fileName of PRODUCT_LEGAL_FILES) {
    await writeFile(
      path.join(outputDirectory, fileName),
      await readFile(path.join(REPOSITORY_DIRECTORY, fileName)),
    );
  }
  await writeFile(
    path.join(outputDirectory, 'pages-build-info.json'),
    JSON.stringify({
      schema: PAGES_BUILD_INFO_SCHEMA,
      source_revision: sourceRevision,
      source_revision_source: 'git-head',
      source_revision_verified: 'true',
      worktree_state: worktreeState,
      base_path: '/typewriter/',
    }),
  );

  return { outputDirectory };
}

function validate(outputDirectory) {
  return validatePagesArtifact({
    outputDirectory,
    repositoryDirectory: REPOSITORY_DIRECTORY,
    expectedSourceRevision: SOURCE_REVISION,
  });
}

test('accepts an exact allowlisted static Pages artifact with clean provenance', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  const result = await validate(outputDirectory);
  assert.equal(result.sourceRevision, SOURCE_REVISION);
  assert.ok(result.fileCount >= 12);
  assert.ok(result.sizes.initialLoad.bytes > 0);
  assert.ok(result.sizes.total.bytes >= result.sizes.initialLoad.bytes);
});

for (const [name, relativePath, content] of [
  ['the SQLite dictionary', 'dictionary.sqlite', 'x'],
  ['a SQLite dictionary under any other name', 'assets/words.db', 'x'],
  ['SQLite WASM', 'assets/sqlite3.wasm', 'x'],
  ['the dictionary worker', 'runtime/dictionary-worker.mjs', 'x'],
  ['the runtime vendor directory', 'runtime/vendor/sqlite3.mjs', 'x'],
]) {
  test(`fails closed when the artifact contains ${name}`, async (t) => {
    const { outputDirectory } = await createArtifact(t);
    await mkdir(path.dirname(path.join(outputDirectory, relativePath)), { recursive: true });
    await writeFile(path.join(outputDirectory, relativePath), content);
    await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_DICTIONARY_RUNTIME' });
  });
}

test('rejects a JavaScript bundle that embeds the dictionary search runtime', async (t) => {
  const { outputDirectory } = await createArtifact(t, {
    script: 'fetch("dictionary.sqlite");',
  });
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_DICTIONARY_RUNTIME' });
});

test('accepts hashed landing images and rejects unhashed or unapproved image files', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'assets/hero-AbCd1234.jpg'), 'x');
  await writeFile(path.join(outputDirectory, 'assets/icon48-AbCd1234.png'), 'x');
  await validate(outputDirectory);

  await writeFile(path.join(outputDirectory, 'assets/hero.jpg'), 'x');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_FILE' });
  await rm(path.join(outputDirectory, 'assets/hero.jpg'));
  await writeFile(path.join(outputDirectory, 'assets/clip-AbCd1234.mp4'), 'x');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_FILE' });
});

test('rejects extension manifests and any other unapproved artifact files', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'manifest.json'), '{}');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_FILE' });
});

test('rejects shared chunks that do not match the hashed Vite output pattern', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'chunks/unapproved.js'), 'void 0;');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_FILE' });
});

test('rejects an artifact that uses the site root instead of the repository Pages base path', async (t) => {
  const { outputDirectory } = await createArtifact(t, { basePath: '/' });
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_BASE_PATH' });
});

test('requires the product introduction entrypoint in the Pages artifact', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await rm(path.join(outputDirectory, 'about/index.html'));
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_REQUIRED_FILE' });
});

test('validates the about page asset paths against the repository Pages base path', async (t) => {
  const { outputDirectory } = await createArtifact(t, { aboutBasePath: '/' });
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_BASE_PATH' });
});

test('requires the about page to redirect to the landing page', async (t) => {
  const { outputDirectory } = await createArtifact(t, { aboutRedirect: '../missing/' });
  await assert.rejects(validate(outputDirectory), {
    code: /^PAGES_ARTIFACT_(?:ABOUT_REDIRECT|HTML_REFERENCE)$/u,
  });
});

test('rejects a build bound to a different Git source revision', async (t) => {
  const { outputDirectory } = await createArtifact(t, { sourceRevision: 'c'.repeat(40) });
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_SOURCE_REVISION' });
});

test('rejects a build whose source worktree was not clean', async (t) => {
  const { outputDirectory } = await createArtifact(t, { worktreeState: 'dirty-allowed' });
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_SOURCE_REVISION' });
});

test('requires the build info file', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await rm(path.join(outputDirectory, 'pages-build-info.json'));
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_REQUIRED_FILE' });
});

test('rejects symlinks in the Pages artifact tree', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await symlink(
    path.join(outputDirectory, 'favicon.ico'),
    path.join(outputDirectory, 'assets/alias.svg'),
  );
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_SYMLINK' });
});

test('rejects a Pages artifact root that is a symbolic link', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  const linkedDirectory = outputDirectory + '-link';
  await symlink(outputDirectory, linkedDirectory, 'dir');
  t.after(() => rm(linkedDirectory, { recursive: true, force: true }));
  await assert.rejects(validate(linkedDirectory), { code: 'PAGES_ARTIFACT_DIRECTORY' });
});

test('rejects hard links in the Pages artifact tree', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await link(
    path.join(outputDirectory, 'assets/main-12345678.js'),
    path.join(outputDirectory, 'assets/alias-87654321.js'),
  );
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_HARDLINK' });
});

test('rejects a favicon that differs from the Chrome Extension brand asset', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, 'favicon.ico'), 'changed');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_FAVICON' });
});

test('rejects legal files that differ from the approved product sources', async (t) => {
  const { outputDirectory } = await createArtifact(t);
  await writeFile(path.join(outputDirectory, PRODUCT_LEGAL_FILES[0]), 'changed');
  await assert.rejects(validate(outputDirectory), { code: 'PAGES_ARTIFACT_LEGAL_FILE' });
});

test('rejects remote assets and missing referenced files in the landing HTML', async (t) => {
  const remote = await createArtifact(t);
  await writeFile(
    path.join(remote.outputDirectory, 'index.html'),
    '<link rel="icon" href="/typewriter/favicon.ico">'
      + '<script src="https://example.com/x.js"></script>',
  );
  await assert.rejects(validate(remote.outputDirectory), { code: 'PAGES_ARTIFACT_REMOTE_ASSET' });

  const missing = await createArtifact(t);
  await rm(path.join(missing.outputDirectory, 'chunks/style-87654321.js'));
  await assert.rejects(validate(missing.outputDirectory), { code: 'PAGES_ARTIFACT_HTML_REFERENCE' });
});

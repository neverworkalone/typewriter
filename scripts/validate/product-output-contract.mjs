import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PRODUCT_LEGAL_FILES = Object.freeze([
  'Apache-2.0.txt',
  'LICENSE.md',
  'DATA-LICENSE.md',
  'BRAND.md',
  'THIRD-PARTY-NOTICES.txt',
]);

export async function validateProductOutputContract({
  root = repositoryRoot,
  extensionOutput = path.resolve(
    process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(root, 'dist'),
  ),
  webOutput = path.resolve(
    process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(root, 'dist-web'),
  ),
} = {}) {
  const [extensionDatabase, webDatabase] = await Promise.all([
    readFile(path.join(extensionOutput, 'dictionary.sqlite')),
    readFile(path.join(webOutput, 'dictionary.sqlite')),
  ]);
  assert.deepEqual(
    extensionDatabase,
    webDatabase,
    'extension and web products must copy the same CI-built SQLite artifact',
  );

  for (const fileName of PRODUCT_LEGAL_FILES) {
    const [source, extensionCopy, webCopy] = await Promise.all([
      readFile(path.join(root, fileName)),
      readFile(path.join(extensionOutput, fileName)),
      readFile(path.join(webOutput, fileName)),
    ]);
    assert.deepEqual(extensionCopy, source, `dist/${fileName} must match its source`);
    assert.deepEqual(webCopy, source, `dist-web/${fileName} must match its source`);
  }

  const webAssets = path.join(webOutput, 'assets');
  const bundles = (await readdir(webAssets))
    .filter((fileName) => fileName.endsWith('.js'));
  assert.ok(bundles.length > 0, 'web JavaScript bundle must exist');
}

import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
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

export async function validateProductOutputContract(options = {}) {
  const root = options.root ?? repositoryRoot;
  const extensionOutput = path.resolve(options.extensionOutput
    ?? (path.resolve(root) === repositoryRoot
      ? process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(root, 'dist')
      : path.join(root, 'dist')));
  const webOutput = path.resolve(options.webOutput
    ?? (path.resolve(root) === repositoryRoot
      ? process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(root, 'dist-web')
      : path.join(root, 'dist-web')));
  // Only the extension carries the dictionary. The static Pages product must
  // never ship the database or search runtime.
  const extensionDatabase = await readFile(path.join(extensionOutput, 'dictionary.sqlite'));
  assert.ok(extensionDatabase.length > 0, 'extension must package dictionary.sqlite');
  for (const forbidden of ['dictionary.sqlite', 'runtime']) {
    await assert.rejects(
      access(path.join(webOutput, forbidden)),
      `dist-web must not contain ${forbidden}`,
    );
  }

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

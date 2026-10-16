import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PRODUCT_LEGAL_FILES,
  validateProductOutputContract,
} from '../scripts/validate/product-output-contract.mjs';

async function createValidProductOutputFixture(root) {
  const extensionOutput = path.join(root, 'dist');
  const webOutput = path.join(root, 'dist-web');
  const webAssets = path.join(webOutput, 'assets');
  await Promise.all([
    mkdir(extensionOutput, { recursive: true }),
    mkdir(webAssets, { recursive: true }),
  ]);

  const database = Buffer.from('shared SQLite fixture');
  await Promise.all([
    writeFile(path.join(extensionOutput, 'dictionary.sqlite'), database),
    writeFile(path.join(webAssets, 'index.js'), 'void 0;'),
    ...PRODUCT_LEGAL_FILES.flatMap((fileName) => {
      const source = Buffer.from(`source: ${fileName}`);
      return [
        writeFile(path.join(root, fileName), source),
        writeFile(path.join(extensionOutput, fileName), source),
        writeFile(path.join(webOutput, fileName), source),
      ];
    }),
  ]);
}

async function withProductOutputFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-product-output-'));
  try {
    await createValidProductOutputFixture(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('product output contract validator', () => {
  it('accepts an extension with a dictionary and a static web product with packaged legal files even without visible links', async () => {
    await withProductOutputFixture(async (root) => {
      await expect(validateProductOutputContract({ root })).resolves.toBeUndefined();
    });
  });

  it('rejects a web product that ships the dictionary database', async () => {
    await withProductOutputFixture(async (root) => {
      await writeFile(path.join(root, 'dist-web', 'dictionary.sqlite'), Buffer.from('x'));

      await expect(validateProductOutputContract({ root })).rejects.toThrow(
        'dist-web must not contain dictionary.sqlite',
      );
    });
  });

  it('rejects a web product that ships the search runtime', async () => {
    await withProductOutputFixture(async (root) => {
      await mkdir(path.join(root, 'dist-web', 'runtime'));

      await expect(validateProductOutputContract({ root })).rejects.toThrow(
        'dist-web must not contain runtime',
      );
    });
  });

  it('still requires the extension to package its dictionary', async () => {
    await withProductOutputFixture(async (root) => {
      await rm(path.join(root, 'dist', 'dictionary.sqlite'));

      await expect(validateProductOutputContract({ root })).rejects.toThrow();
    });
  });

  it('rejects a web legal file that differs from its repository source', async () => {
    await withProductOutputFixture(async (root) => {
      await writeFile(path.join(root, 'dist-web', PRODUCT_LEGAL_FILES[0]), 'changed');

      await expect(validateProductOutputContract({ root })).rejects.toThrow(
        `dist-web/${PRODUCT_LEGAL_FILES[0]} must match its source`,
      );
    });
  });

  it('still requires a built web JavaScript bundle', async () => {
    await withProductOutputFixture(async (root) => {
      await rm(path.join(root, 'dist-web', 'assets', 'index.js'));

      await expect(validateProductOutputContract({ root })).rejects.toThrow(
        'web JavaScript bundle must exist',
      );
    });
  });
});

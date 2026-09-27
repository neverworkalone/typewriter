import { cp, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { buildDictionary } from './dictionary.mjs';

const PRODUCT_LEGAL_FILES = Object.freeze([
  'Apache-2.0.txt',
  'LICENSE.md',
  'DATA-LICENSE.md',
  'BRAND.md',
  'THIRD-PARTY-NOTICES.txt',
]);

export function createProductRuntimeAssets({
  projectRoot,
  canonicalDirectory,
  outputDirectory,
  sharedDictionaryPath = null,
  allowDirty = process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
}) {
  const sqliteWasmDirectory = path.join(
    projectRoot,
    'node_modules/@sqlite.org/sqlite-wasm/dist',
  );

  async function copyRuntimeAssets() {
    const runtimeDirectory = path.join(outputDirectory, 'runtime');
    const vendorDirectory = path.join(runtimeDirectory, 'vendor');

    await mkdir(vendorDirectory, { recursive: true });
    await Promise.all([
      cp(
        path.join(projectRoot, 'src/runtime/dictionary-worker.mjs'),
        path.join(runtimeDirectory, 'dictionary-worker.mjs'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/dictionary-contract.js'),
        path.join(runtimeDirectory, 'dictionary-contract.js'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/dictionary-validation.js'),
        path.join(runtimeDirectory, 'dictionary-validation.js'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/protocol.js'),
        path.join(runtimeDirectory, 'protocol.js'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/query-adapter.js'),
        path.join(runtimeDirectory, 'query-adapter.js'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/search-query.js'),
        path.join(runtimeDirectory, 'search-query.js'),
      ),
      cp(
        path.join(projectRoot, 'src/runtime/sqlite-query.js'),
        path.join(runtimeDirectory, 'sqlite-query.js'),
      ),
      cp(
        path.join(sqliteWasmDirectory, 'index.mjs'),
        path.join(vendorDirectory, 'sqlite3.mjs'),
      ),
      cp(
        path.join(sqliteWasmDirectory, 'sqlite3.wasm'),
        path.join(vendorDirectory, 'sqlite3.wasm'),
      ),
      ...PRODUCT_LEGAL_FILES.map((fileName) => cp(
        path.join(projectRoot, fileName),
        path.join(outputDirectory, fileName),
      )),
    ]);

    const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
    if (sharedDictionaryPath) {
      const relativeSharedPath = path.relative(
        outputDirectory,
        path.resolve(sharedDictionaryPath),
      );
      if (
        relativeSharedPath === ''
        || (!relativeSharedPath.startsWith('..') && !path.isAbsolute(relativeSharedPath))
      ) {
        throw new Error(
          'TYPEWRITER_SHARED_DICTIONARY_PATH must be outside the Vite output directory',
        );
      }

      await cp(sharedDictionaryPath, outputPath);
      console.log(`Product dictionary reused from shared artifact: ${sharedDictionaryPath}`);
    } else {
      const summary = await buildDictionary({
        inputDirectory: canonicalDirectory,
        outputPath,
        checkPilotCompleteness: true,
        repositoryDirectory: projectRoot,
        allowDirty,
      });

      console.log(
        `Product dictionary built: ${summary.recordCount} records, `
          + `${summary.senseCount} senses, ${summary.relationCount} relations.`,
      );
    }

    const database = new DatabaseSync(outputPath, { readOnly: true });
    let sourceRevision;
    try {
      sourceRevision = database.prepare(
        "SELECT value FROM metadata WHERE key = 'source_revision'",
      ).get()?.value;
    } finally {
      database.close();
    }
    if (!/^[0-9a-f]{40}$/.test(sourceRevision || '')) {
      throw new Error('Product dictionary source revision is missing or invalid.');
    }
    await writeFile(
      path.join(runtimeDirectory, 'dictionary-build-info.js'),
      `export const EXPECTED_DICTIONARY_SOURCE_REVISION = ${JSON.stringify(sourceRevision)};\n`,
      { mode: 0o644 },
    );
  }

  return {
    name: 'typewriter-product-runtime-assets',
    apply: 'build',
    closeBundle: copyRuntimeAssets,
  };
}

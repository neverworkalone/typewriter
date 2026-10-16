import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('product dictionary runtime assets', () => {
  it('keeps the worker independent from Node-only query helpers', async () => {
    const [entrySources, hostSource, querySource, validationSource] = await Promise.all([
      Promise.all(['dictionary-worker.mjs', 'dictionary-background.mjs'].map(
        (name) => readFile(path.join(repositoryRoot, 'src/runtime', name), 'utf8'),
      )),
      readFile(path.join(repositoryRoot, 'src/runtime/dictionary-host.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/runtime/sqlite-query.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/runtime/dictionary-validation.js'), 'utf8'),
    ]);

    const workerSource = hostSource;
    for (const entrySource of entrySources) {
      expect(entrySource).toContain("import sqlite3InitModule from './vendor/sqlite3.mjs'");
      expect(entrySource).toContain("from './dictionary-build-info.js'");
      expect(entrySource).toContain("new URL('../dictionary.sqlite', self.location.href)");
      expect(entrySource).toContain("from './dictionary-host.js'");
    }
    expect(workerSource).not.toContain('node:sqlite');
    expect(workerSource).not.toContain('scripts/build/query');
    expect(workerSource).toContain("from './sqlite-query.js'");
    expect(workerSource).toContain("from './dictionary-validation.js'");
    expect(workerSource).toContain('validateRuntimeDictionary(database, {');
    expect(workerSource).not.toContain('validatePackagedDictionary');
    expect(validationSource).toContain('export function validatePackagedDictionary(database, options = {})');
    expect(validationSource).toContain('PRAGMA quick_check');
    expect(validationSource).toContain('PRAGMA foreign_key_check');
    expect(validationSource).toContain('source_revision_verified');
    expect(querySource).toContain("from './search-query.js'");
    expect(querySource).toContain('generated_surface_forms');
    expect(querySource).toContain('createSearchResponseFromRows');
    expect(workerSource).toContain('PRAGMA query_only = ON');
    expect(workerSource).toContain('writeBlocked');
    expect(workerSource).toContain('persistedWriteCount');
    expect(workerSource).toContain("databasePromise = loadDatabase()");
    expect(workerSource).toContain("case 'get-record'");
    expect(workerSource).toContain("case 'get-relations'");
    expect(workerSource).toContain("case 'metadata'");
  });

  it('builds the dictionary runtime only for the extension; the static web build has none', async () => {
    const [extensionConfig, webConfig, runtimePlugin] = await Promise.all([
      readFile(path.join(repositoryRoot, 'vite.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'vite.web.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/build/product-runtime-plugin.mjs'), 'utf8'),
    ]);

    expect(extensionConfig).toContain('createProductRuntimeAssets({');
    expect(webConfig).not.toContain('createProductRuntimeAssets');
    expect(webConfig).not.toContain('product-runtime-plugin');
    expect(webConfig).not.toContain('buildDictionary');
    expect(webConfig).toContain("?? '/typewriter/'");
    expect(webConfig).toContain("path.join(webRoot, 'public')");
    expect(runtimePlugin).toContain("src/runtime/dictionary-worker.mjs");
    expect(runtimePlugin).toContain("src/runtime/dictionary-background.mjs");
    expect(runtimePlugin).toContain("src/runtime/dictionary-host.js");
    expect(runtimePlugin).toContain("src/runtime/dictionary-contract.js");
    expect(runtimePlugin).toContain("src/runtime/dictionary-validation.js");
    expect(runtimePlugin).toContain("dictionary-build-info.js");
    expect(runtimePlugin).toContain("src/runtime/protocol.js");
    expect(runtimePlugin).toContain("src/runtime/query-adapter.js");
    expect(runtimePlugin).toContain("src/runtime/search-query.js");
    expect(runtimePlugin).toContain("src/runtime/sqlite-query.js");
    expect(runtimePlugin).toContain("src/runtime/dictionary-worker.mjs");
    expect(runtimePlugin).toContain("node_modules/@sqlite.org/sqlite-wasm/dist");
    expect(runtimePlugin).toContain("path.join(runtimeDirectory, 'dictionary-worker.mjs')");
    expect(runtimePlugin).toContain("path.join(vendorDirectory, 'sqlite3.wasm')");
    expect(runtimePlugin).toContain("'THIRD-PARTY-NOTICES.txt'");
    expect(runtimePlugin).toContain('PRODUCT_LEGAL_FILES.map');
    expect(runtimePlugin).toContain('buildDictionary({');
  });
});

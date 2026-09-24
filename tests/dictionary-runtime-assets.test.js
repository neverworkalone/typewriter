import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('product dictionary runtime assets', () => {
  it('keeps the worker independent from Node-only query helpers', async () => {
    const workerSource = await readFile(
      path.join(repositoryRoot, 'src/runtime/dictionary-worker.mjs'),
      'utf8',
    );

    expect(workerSource).not.toContain('node:sqlite');
    expect(workerSource).not.toContain('scripts/build/query');
    expect(workerSource).toContain("import sqlite3InitModule from './vendor/sqlite3.mjs'");
    expect(workerSource).toContain("from './search-query.js'");
    expect(workerSource).toContain("new URL('../dictionary.sqlite', self.location.href)");
    expect(workerSource).toContain('PRAGMA query_only = ON');
    expect(workerSource).toContain('writeBlocked');
    expect(workerSource).toContain('persistedWriteCount');
    expect(workerSource).toContain("databasePromise = loadDatabase()");
    expect(workerSource).toContain("case 'get-record'");
    expect(workerSource).toContain("case 'get-relations'");
    expect(workerSource).toContain("case 'metadata'");
  });

  it('builds the same runtime assets and dictionary for extension and web', async () => {
    const [extensionConfig, webConfig, runtimePlugin] = await Promise.all([
      readFile(path.join(repositoryRoot, 'vite.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'vite.web.config.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/build/product-runtime-plugin.mjs'), 'utf8'),
    ]);

    expect(extensionConfig).toContain('createProductRuntimeAssets({');
    expect(webConfig).toContain('createProductRuntimeAssets({');
    expect(webConfig).toContain("?? '/typewriter/'");
    expect(webConfig).toContain("path.join(webRoot, 'public')");
    expect(runtimePlugin).toContain("src/runtime/dictionary-worker.mjs");
    expect(runtimePlugin).toContain("src/runtime/protocol.js");
    expect(runtimePlugin).toContain("src/runtime/query-adapter.js");
    expect(runtimePlugin).toContain("src/runtime/search-query.js");
    expect(runtimePlugin).toContain("node_modules/@sqlite.org/sqlite-wasm/dist");
    expect(runtimePlugin).toContain("path.join(runtimeDirectory, 'dictionary-worker.mjs')");
    expect(runtimePlugin).toContain("path.join(vendorDirectory, 'sqlite3.wasm')");
    expect(runtimePlugin).toContain('buildDictionary({');
  });
});

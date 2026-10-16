import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createProductRuntimeAssets } from '../scripts/build/product-runtime-plugin.mjs';

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
    expect(workerSource).toContain("case 'get-meaning-record'");
    expect(workerSource).not.toContain("case 'get-record'");
    expect(workerSource).not.toContain("case 'get-relations'");
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

  describe('UI-only build (build:ui)', () => {
    async function withOutput(callback) {
      const root = await mkdtemp(path.join(tmpdir(), 'typewriter-ui-build-'));
      try {
        return await callback(path.join(root, 'dist'), root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    function plugin(outputDirectory, root, options = {}) {
      return createProductRuntimeAssets({
        projectRoot: repositoryRoot,
        canonicalDirectory: path.join(root, 'no-canonical'),
        outputDirectory,
        fullDictionaryPath: path.join(root, 'artifacts/dictionary.sqlite'),
        ...options,
      });
    }

    it('is wired as a Vite ui mode that keeps dist and leaves release builds unchanged', async () => {
      const [packageJson, config] = await Promise.all([
        readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
        readFile(path.join(repositoryRoot, 'vite.config.js'), 'utf8'),
      ]);
      expect(packageJson.scripts['build:ui']).toBe('vite build --mode ui');
      expect(packageJson.scripts.build).toBe('vite build');
      expect(config).toContain("mode === 'ui'");
      expect(config).toContain('emptyOutDir: !uiOnly');
      for (const script of ['package', 'build:dictionary', 'validate:release']) {
        expect(packageJson.scripts[script] ?? '').not.toContain('build:ui');
        expect(packageJson.scripts[script] ?? '').not.toContain('--mode ui');
      }
    });

    it('succeeds with no database anywhere and creates none', async () => {
      await withOutput(async (outputDirectory, root) => {
        const ui = plugin(outputDirectory, root, { uiOnly: true });
        await ui.closeBundle();
        const files = await readdir(outputDirectory, { recursive: true });
        expect(files).toContain(path.join('runtime', 'dictionary-worker.mjs'));
        expect(files).toContain(path.join('runtime', 'vendor', 'sqlite3.wasm'));
        expect(files.filter((file) => file.endsWith('.sqlite'))).toEqual([]);
        expect(files).not.toContain(path.join('runtime', 'dictionary-build-info.js'));
        await expect(readdir(path.join(root, 'artifacts'))).rejects.toThrow();
      });
    });

    it('preserves an existing database and revision file and drops only stale UI bundles', async () => {
      await withOutput(async (outputDirectory, root) => {
        await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
        await mkdir(path.join(outputDirectory, 'chunks'), { recursive: true });
        await mkdir(path.join(outputDirectory, 'runtime'), { recursive: true });
        await writeFile(path.join(outputDirectory, 'assets/popup-old.js'), 'old');
        await writeFile(path.join(outputDirectory, 'chunks/panel-old.js'), 'old');
        await writeFile(path.join(outputDirectory, 'dictionary.sqlite'), 'sentinel-db');
        const info = 'export const EXPECTED_DICTIONARY_SOURCE_REVISION = "keep";\n';
        await writeFile(path.join(outputDirectory, 'runtime/dictionary-build-info.js'), info);

        const ui = plugin(outputDirectory, root, { uiOnly: true });
        await ui.buildStart();
        await ui.closeBundle();

        expect(await readFile(path.join(outputDirectory, 'dictionary.sqlite'), 'utf8')).toBe('sentinel-db');
        expect(await readFile(path.join(outputDirectory, 'runtime/dictionary-build-info.js'), 'utf8')).toBe(info);
        const files = await readdir(outputDirectory, { recursive: true });
        expect(files).not.toContain(path.join('assets', 'popup-old.js'));
        expect(files).not.toContain(path.join('chunks', 'panel-old.js'));
      });
    });

    it('fails closed in the normal build: it still requires a verified Full database', async () => {
      await withOutput(async (outputDirectory, root) => {
        const normal = plugin(outputDirectory, root, {
          sharedDictionaryPath: path.join(root, 'missing-full.sqlite'),
        });
        expect(normal.buildStart).toBeUndefined();
        await expect(normal.closeBundle()).rejects.toThrow();
        const files = await readdir(outputDirectory, { recursive: true });
        expect(files.filter((file) => file.endsWith('dictionary.sqlite'))).toEqual([]);
      });
    });
  });
});

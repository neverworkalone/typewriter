import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { buildDictionary } from './scripts/build/dictionary.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const canonicalDirectory = path.resolve(
  process.env.TYPEWRITER_CANONICAL_DIRECTORY ?? path.join(projectRoot, 'data/canonical'),
);
const outputDirectory = path.resolve(
  process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(projectRoot, 'dist'),
);
const defaultOutputDirectory = path.join(projectRoot, 'dist');
const defaultDictionaryPath = path.join(projectRoot, 'dist/dictionary.sqlite');
const sharedDictionaryPath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH
  ? path.resolve(process.env.TYPEWRITER_SHARED_DICTIONARY_PATH)
  : null;
const sqliteWasmDirectory = path.join(
  projectRoot,
  'node_modules/@sqlite.org/sqlite-wasm/dist',
);
const shouldMinify = process.env.TYPEWRITER_BUILD_MINIFY !== 'false';

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
      path.join(sqliteWasmDirectory, 'index.mjs'),
      path.join(vendorDirectory, 'sqlite3.mjs'),
    ),
    cp(
      path.join(sqliteWasmDirectory, 'sqlite3.wasm'),
      path.join(vendorDirectory, 'sqlite3.wasm'),
    ),
  ]);

  const outputPath = outputDirectory === defaultOutputDirectory
    ? defaultDictionaryPath
    : path.join(outputDirectory, 'dictionary.sqlite');

  if (sharedDictionaryPath) {
    if (sharedDictionaryPath === path.resolve(outputPath)) {
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
      allowDirty: process.env.TYPEWRITER_ALLOW_DIRTY === 'true',
    });

    console.log(
      `Product dictionary built: ${summary.recordCount} records, `
        + `${summary.senseCount} senses, ${summary.relationCount} relations.`,
    );
  }
}

function productRuntimeAssets() {
  return {
    name: 'typewriter-product-runtime-assets',
    apply: 'build',
    closeBundle: copyRuntimeAssets,
  };
}

export default defineConfig({
  plugins: [vue(), productRuntimeAssets()],
  build: {
    outDir: outputDirectory,
    target: 'es2022',
    minify: shouldMinify ? 'esbuild' : false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: `${projectRoot}/popup.html`,
        options: `${projectRoot}/options.html`,
      },
      output: {
        format: 'es',
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

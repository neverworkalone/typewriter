import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { createProductRuntimeAssets } from './scripts/build/product-runtime-plugin.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = path.join(projectRoot, 'web');
const canonicalDirectory = path.resolve(
  process.env.TYPEWRITER_CANONICAL_DIRECTORY ?? path.join(projectRoot, 'data/canonical'),
);
const outputDirectory = path.resolve(
  process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(projectRoot, 'dist-web'),
);
const sharedDictionaryPath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH
  ? path.resolve(process.env.TYPEWRITER_SHARED_DICTIONARY_PATH)
  : null;
const base = process.env.TYPEWRITER_WEB_BASE_PATH ?? '/typewriter/';
const shouldMinify = process.env.TYPEWRITER_BUILD_MINIFY !== 'false';

if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error('TYPEWRITER_WEB_BASE_PATH must be an absolute path ending in /.');
}

export default defineConfig({
  root: webRoot,
  base,
  publicDir: path.join(webRoot, 'public'),
  plugins: [
    vue(),
    createProductRuntimeAssets({
      projectRoot,
      canonicalDirectory,
      outputDirectory,
      sharedDictionaryPath,
    }),
  ],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    target: 'es2022',
    minify: shouldMinify ? 'esbuild' : false,
    rollupOptions: {
      input: path.join(webRoot, 'index.html'),
      output: {
        format: 'es',
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

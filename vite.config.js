import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { createProductRuntimeAssets } from './scripts/build/product-runtime-plugin.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const canonicalDirectory = path.resolve(
  process.env.TYPEWRITER_CANONICAL_DIRECTORY ?? path.join(projectRoot, 'data/canonical'),
);
const outputDirectory = path.resolve(
  process.env.TYPEWRITER_BUILD_OUTPUT_DIRECTORY ?? path.join(projectRoot, 'dist'),
);
const sharedDictionaryPath = process.env.TYPEWRITER_SHARED_DICTIONARY_PATH
  ? path.resolve(process.env.TYPEWRITER_SHARED_DICTIONARY_PATH)
  : null;
const fullDictionaryPath = path.resolve(
  process.env.TYPEWRITER_FULL_DICTIONARY_PATH ?? path.join(projectRoot, 'artifacts/dictionary.sqlite'),
);
const shouldMinify = process.env.TYPEWRITER_BUILD_MINIFY !== 'false';

export default defineConfig({
  plugins: [
    vue(),
    createProductRuntimeAssets({
      projectRoot,
      canonicalDirectory,
      outputDirectory,
      sharedDictionaryPath,
      fullDictionaryPath,
    }),
  ],
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

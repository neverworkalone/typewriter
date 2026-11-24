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
const shouldMinify = process.env.TYPEWRITER_BUILD_MINIFY !== 'false';

// `vite build --mode ui` (pnpm run build:ui) is the DB-free UI development build.
export default defineConfig(({ mode }) => {
  const uiOnly = mode === 'ui';
  return {
    plugins: [
      vue(),
      createProductRuntimeAssets({
        projectRoot,
        canonicalDirectory,
        outputDirectory,
        uiOnly,
      }),
    ],
    build: {
      outDir: outputDirectory,
      target: 'es2022',
      minify: shouldMinify ? 'esbuild' : false,
      emptyOutDir: !uiOnly,
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
  };
});

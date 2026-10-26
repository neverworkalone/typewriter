import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { createWebStaticAssets } from './scripts/build/web-static-assets-plugin.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = path.join(projectRoot, 'site');
const outputDirectory = path.resolve(
  process.env.TYPEWRITER_WEB_BUILD_OUTPUT_DIRECTORY ?? path.join(projectRoot, 'dist-web'),
);
const base = process.env.TYPEWRITER_WEB_BASE_PATH ?? '/typewriter/';
const shouldMinify = process.env.TYPEWRITER_BUILD_MINIFY !== 'false';

if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error('TYPEWRITER_WEB_BASE_PATH must be an absolute path ending in /.');
}

// The Pages site is a static product landing page. It builds no SQLite
// dictionary and bundles no search runtime; the dictionary lives in the
// Chrome Extension build (vite.config.js).
export default defineConfig({
  root: siteRoot,
  base,
  publicDir: path.join(siteRoot, 'public'),
  plugins: [
    vue(),
    createWebStaticAssets({ projectRoot, basePath: base }),
  ],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    target: 'es2022',
    minify: shouldMinify ? 'esbuild' : false,
    rollupOptions: {
      input: {
        main: path.join(siteRoot, 'index.html'),
        about: path.join(siteRoot, 'about/index.html'),
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

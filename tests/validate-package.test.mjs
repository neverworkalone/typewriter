import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectManifestFiles,
  validatePackageDirectory,
  validatePackageZip,
} from '../scripts/validate-package.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('collects manifest entrypoints without treating wildcard resources as files', () => {
  const files = collectManifestFiles({
    icons: { 16: 'icon16.png' },
    options_ui: { page: 'options.html' },
    action: { default_popup: 'popup.html' },
    background: { service_worker: 'background.js' },
    web_accessible_resources: [{ resources: ['runtime/*', 'public.txt'] }],
  });

  assert.deepEqual(
    [...files].sort(),
    ['background.js', 'icon16.png', 'manifest.json', 'options.html', 'popup.html', 'public.txt'],
  );
});

test('rejects a product/package version mismatch', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-version-'));
  try {
    await writeFile(path.join(temporaryDirectory, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '0.3.0' }),
    );

    const result = validatePackageDirectory({
      packageDir: temporaryDirectory,
      projectRoot: temporaryDirectory,
    });

    assert.match(result.errors.join('\n'), /Product\/package version must match/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects remote code, permissions, exposed resources, source maps, and missing package assets', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-validator-'));
  try {
    await writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        version: '0.3.0',
        permissions: ['storage', 'tabs'],
        host_permissions: ['<all_urls>'],
        web_accessible_resources: [{ resources: ['dictionary.sqlite'], matches: ['<all_urls>'] }],
        action: { default_popup: 'popup.html' },
        options_ui: { page: 'options.html' },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
      }),
    );
    await writeFile(
      path.join(temporaryDirectory, 'popup.html'),
      '<script src="https://cdn.example.invalid/remote.js"></script>',
    );
    await chmod(path.join(temporaryDirectory, 'popup.html'), 0o600);
    await writeFile(path.join(temporaryDirectory, 'stale.js.map'), '{}');
    await mkdir(path.join(temporaryDirectory, 'assets'));
    await writeFile(path.join(temporaryDirectory, 'assets', 'unneeded.js'), 'export default true;');

    const result = validatePackageDirectory({
      packageDir: temporaryDirectory,
      projectRoot: REPOSITORY_DIRECTORY,
    });
    const errors = result.errors.join('\n');

    assert.match(errors, /Product permissions must be exactly/);
    assert.match(errors, /Host permissions are not allowed/);
    assert.match(errors, /web_accessible_resources must not expose/);
    assert.match(errors, /Remote code or CDN reference/);
    assert.match(errors, /regular 0644 file/);
    assert.match(errors, /Development or unnecessary files found/);
    assert.match(errors, /Unexpected files found in package: assets\/unneeded\.js/);
    assert.match(errors, /runtime\/vendor\/sqlite3\.wasm/);
    assert.match(errors, /dictionary\.sqlite/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects corrupt SQLite and WASM runtime fixtures', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-runtime-'));
  try {
    await writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        version: '0.3.0',
        permissions: ['storage'],
        action: { default_popup: 'popup.html' },
        options_ui: { page: 'options.html' },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
      }),
    );
    await writeFile(path.join(temporaryDirectory, 'popup.html'), '<main></main>');
    await writeFile(path.join(temporaryDirectory, 'options.html'), '<main></main>');
    await writeFile(path.join(temporaryDirectory, 'dictionary.sqlite'), 'not sqlite');
    await mkdir(path.join(temporaryDirectory, 'runtime/vendor'), { recursive: true });
    await writeFile(path.join(temporaryDirectory, 'runtime/vendor/sqlite3.wasm'), 'not wasm');

    const result = validatePackageDirectory({
      packageDir: temporaryDirectory,
      projectRoot: REPOSITORY_DIRECTORY,
    });
    const errors = result.errors.join('\n');

    assert.match(errors, /Packaged dictionary could not be read/);
    assert.match(errors, /sqlite3\.wasm is not a WebAssembly binary/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('compares ZIP contents with the validated unpacked package and filename', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-zip-'));
  const projectDirectory = path.join(temporaryDirectory, 'typewriter');
  const packageDirectory = path.join(projectDirectory, 'dist');
  const zipPath = path.join(projectDirectory, 'typewriter_0.3.0.zip');
  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'manifest.json'), '{}');
    await writeFile(path.join(packageDirectory, 'popup.html'), '<main></main>');
    execFileSync('zip', ['-q', zipPath, 'manifest.json'], { cwd: packageDirectory });

    const result = validatePackageZip({
      packageDir: packageDirectory,
      zipPath,
      packageFiles: ['manifest.json', 'popup.html'],
      manifestVersion: '0.3.0',
    });

    assert.match(result.errors.join('\n'), /ZIP is missing files from the unpacked build: popup\.html/);
    assert.equal(result.errors.some((error) => /ZIP name mismatch/.test(error)), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

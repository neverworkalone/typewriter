import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('derives dictionary metadata from the supplied canonical directory and rejects a stale package', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-canonical-metadata-'));
  const packageDirectory = path.join(temporaryDirectory, 'dist');
  const canonicalDirectory = path.join(temporaryDirectory, 'prospective-canonical');
  const canonicalFile = path.join(canonicalDirectory, 'fixture.jsonl');
  const databasePath = path.join(packageDirectory, 'dictionary.sqlite');
  try {
    await mkdir(canonicalDirectory, { recursive: true });
    await mkdir(path.join(packageDirectory, 'runtime/vendor'), { recursive: true });

    const records = [
      {
        record_type: 'entry',
        role: 'start',
        candidate_id: 'candidate-1',
        search_forms: ['alpha'],
        senses: [{ relations: [] }],
      },
      {
        record_type: 'entry',
        role: 'reference-only',
        candidate_id: null,
        search_forms: ['beta'],
        senses: [{ relations: [] }],
      },
      {
        record_type: 'expression',
        role: 'start',
        candidate_id: 'candidate-2',
        search_forms: ['gamma', 'gamma phrase'],
        senses: [{ relations: [{}] }],
      },
    ];
    const serializedRecords = records.map((record) => JSON.stringify(record)).join('\n');
    await writeFile(canonicalFile, `${serializedRecords}\n`);

    const manifest = {
      manifest_version: 3,
      version: '1.0',
      permissions: ['storage'],
      action: { default_popup: 'popup.html' },
      options_ui: { page: 'options.html' },
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      },
    };
    const packageFiles = new Map([
      ['manifest.json', JSON.stringify(manifest)],
      ['popup.html', '<main>fixture popup</main>'],
      ['options.html', '<main>fixture options</main>'],
      ['logo.png', 'fixture logo'],
      ['runtime/dictionary-worker.mjs', '// fixture worker\n'],
      ['runtime/protocol.js', '// fixture protocol\n'],
      ['runtime/query-adapter.js', '// fixture adapter\n'],
      ['runtime/search-query.js', '// fixture search\n'],
      ['runtime/vendor/sqlite3.mjs', '// fixture sqlite loader\n'],
      ['runtime/vendor/sqlite3.wasm', Buffer.from([0x00, 0x61, 0x73, 0x6d])],
      ['Apache-2.0.txt', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'],
      ['THIRD-PARTY-NOTICES.txt', '@sqlite.org/sqlite-wasm 3.53.0-build1\nApache-2.0.txt'],
    ]);
    for (const [relativePath, contents] of packageFiles) {
      const filePath = path.join(packageDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
      await chmod(filePath, 0o644);
    }

    const metadata = {
      dictionary_version: 'm2-pilot-1',
      schema_version: '1',
      normalization_version: '1',
      build_contract: 'canonical-jsonl -> normalized-v1 -> sqlite-v1',
      build_tool_version: '1',
      record_count: '3',
      start_count: '2',
      reference_only_count: '1',
      candidate_count: '2',
      search_form_count: '4',
      sense_count: '3',
      relation_count: '1',
      expression_count: '1',
      source_revision: execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: REPOSITORY_DIRECTORY,
        encoding: 'utf8',
      }).trim(),
      source_revision_source: 'git-head',
      source_revision_verified: 'true',
      worktree_state: 'clean',
      node_version: process.version,
      sqlite_version: '3.53.0',
    };
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); PRAGMA user_version = 1;');
    const insertMetadata = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, value);
    database.close();
    await chmod(databasePath, 0o644);

    const matchingPackage = validatePackageDirectory({
      packageDir: packageDirectory,
      projectRoot: REPOSITORY_DIRECTORY,
      canonicalDirectory,
    });
    assert.deepEqual(matchingPackage.errors, []);

    const additionalStart = {
      record_type: 'entry',
      role: 'start',
      candidate_id: 'candidate-3',
      search_forms: ['delta'],
      senses: [{ relations: [] }],
    };
    await writeFile(canonicalFile, `${serializedRecords}\n${JSON.stringify(additionalStart)}\n`);
    const stalePackage = validatePackageDirectory({
      packageDir: packageDirectory,
      projectRoot: REPOSITORY_DIRECTORY,
      canonicalDirectory,
    });
    assert.ok(stalePackage.errors.includes(
      'Dictionary metadata record_count must be "4", received "3".',
    ));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

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

test('allows independent product and package versions', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-package-version-'));
  try {
    await writeFile(path.join(temporaryDirectory, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    await writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        version: '1.0',
        permissions: ['storage'],
        action: { default_popup: 'popup.html' },
        options_ui: { page: 'options.html' },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
      }),
    );

    const result = validatePackageDirectory({
      packageDir: temporaryDirectory,
      projectRoot: temporaryDirectory,
    });

    assert.equal(result.errors.some((error) => /version/i.test(error)), false);
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

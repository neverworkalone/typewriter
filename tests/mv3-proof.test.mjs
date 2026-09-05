import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildProofPackage } from '../scripts/extension/build-proof.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('builds a self-contained MV3 proof package with packaged DB and WASM', async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'typewriter-mv3-proof-'),
  );
  const outputDirectory = path.join(temporaryDirectory, 'extension');

  try {
    const summary = await buildProofPackage({
      outputDirectory,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });

    assert.equal(summary.recordCount, 326);
    assert.equal(summary.senseCount, 386);
    assert.equal(summary.relationCount, 340);

    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, []);
    assert.deepEqual(manifest.host_permissions, []);
    assert.equal(
      manifest.content_security_policy.extension_pages,
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    );
    assert.deepEqual(manifest.web_accessible_resources, [
      {
        resources: ['dictionary.sqlite'],
        matches: ['<all_urls>'],
      },
    ]);

    for (const filename of [
      'dictionary.sqlite',
      'manifest.json',
      'proof.html',
      'proof.js',
      'sqlite-worker.mjs',
      'THIRD-PARTY-NOTICES.txt',
      'vendor/sqlite3.mjs',
      'vendor/sqlite3.wasm',
    ]) {
      const contents = await readFile(path.join(outputDirectory, filename));
      assert.ok(contents.length > 0, `${filename} should not be empty`);
    }

    const workerSource = await readFile(
      path.join(outputDirectory, 'sqlite-worker.mjs'),
      'utf8',
    );
    assert.doesNotMatch(workerSource, /https?:\/\//);
    assert.match(workerSource, /dictionary\.sqlite/);
    assert.match(workerSource, /SQLITE_DESERIALIZE_FREEONCLOSE/);

    const database = new DatabaseSync(summary.databasePath, { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM records').get().count,
        326,
      );
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM relations').get().count,
        340,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

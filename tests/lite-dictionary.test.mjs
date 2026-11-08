import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  assertDatabaseKind,
  extractLiteDictionary,
  readDatabaseKind,
  verifyLiteExtraction,
} from '../scripts/build/lite-dictionary.mjs';
import {
  findRecordsBySearchTerm,
  getMeaningRecord,
  readLogicalDatabaseSnapshot,
} from '../scripts/build/query.mjs';
import { validatePackagedDictionary, validateRuntimeDictionary } from '../src/runtime/dictionary-validation.js';
import { BUILD_ONLY_TABLES, PLAIN_LAYOUT } from '../src/runtime/dictionary-contract.js';
import {
  PACKED_FORMAT_VERSION,
  decodePackedRelations,
  decodePackedTextRelations,
  encodePackedRelations,
  encodePackedTextRelations,
  meaningId,
  meaningNumber,
} from '../src/runtime/packed-relations.js';
import { validateSharedDictionary } from '../scripts/ci/validate-shared-dictionary.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PILOT_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'tests/fixtures/canonical-sample');

/** Invariant: Lite is a verified, provenance-preserving projection of Full's product tables and nothing else. */
async function withFullAndLite(callback, optimization = PLAIN_LAYOUT) {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-lite-'));
  try {
    const fullPath = path.join(directory, 'full.sqlite');
    const litePath = path.join(directory, 'lite.sqlite');
    const summary = await buildDictionary({ inputDirectory: PILOT_DIRECTORY, outputPath: fullPath, allowDirty: true });
    await extractLiteDictionary({ fullPath, litePath, optimization });
    return await callback({ directory, fullPath, litePath, summary });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function withDatabase(databasePath, callback, options = { readOnly: true }) {
  const database = new DatabaseSync(databasePath, options);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

test('Full keeps the source layer and Lite drops it; kinds are identified and cross-checked', async () => {
  await withFullAndLite(({ fullPath, litePath }) => {
    withDatabase(fullPath, (full) => {
      assert.equal(readDatabaseKind(full), 'full');
      const tables = full.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
      for (const table of BUILD_ONLY_TABLES) assert.ok(tables.includes(table), `Full must keep ${table}`);
      assert.throws(() => assertDatabaseKind(full, 'lite'), /must be a lite dictionary/u);
    });
    withDatabase(litePath, (lite) => {
      assert.equal(readDatabaseKind(lite), 'lite');
      const tables = lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
      for (const table of BUILD_ONLY_TABLES) assert.ok(!tables.includes(table), `Lite must not ship ${table}`);
      assert.throws(() => assertDatabaseKind(lite, 'full'), /must be a full dictionary/u);
      assert.doesNotThrow(() => validatePackagedDictionary(lite));
    });
    // The package/runtime validator refuses Full; the CI shared-artifact validator refuses Lite.
    withDatabase(fullPath, (full) => assert.throws(() => validatePackagedDictionary(full), /Lite|build-only/u));
    // The extension startup path (validateRuntimeDictionary) refuses a real Full database and accepts the real Lite.
    withDatabase(fullPath, (full) => assert.throws(() => validateRuntimeDictionary(full), /Lite|build-only/u));
    withDatabase(litePath, (lite) => assert.doesNotThrow(() => validateRuntimeDictionary(lite)));
  });
});

test('Lite inherits Full provenance and every product table unchanged, except its own kind', async () => {
  await withFullAndLite(({ fullPath, litePath }) => {
    const full = withDatabase(fullPath, (database) => readLogicalDatabaseSnapshot(database));
    const lite = withDatabase(litePath, (database) => readLogicalDatabaseSnapshot(database));
    const withoutKind = (rows) => rows.filter(({ key }) => key !== 'database_kind' && !key.startsWith('lite_'));
    assert.deepEqual(withoutKind(lite.rows.metadata), withoutKind(full.rows.metadata));
    assert.equal(full.rows.metadata.find(({ key }) => key === 'database_kind').value, 'full');
    assert.equal(lite.rows.metadata.find(({ key }) => key === 'database_kind').value, 'lite');
    for (const key of ['source_revision', 'canonical_revision', 'worktree_state']) {
      assert.ok(lite.rows.metadata.some((row) => row.key === key), `${key} must be inherited`);
    }
    for (const table of Object.keys(lite.rows).filter((name) => name !== 'metadata')) {
      assert.deepEqual(lite.rows[table], full.rows[table], `${table} must be identical`);
    }
    assert.deepEqual(lite.indexes.map(({ name }) => name), full.indexes.map(({ name }) => name).filter((name) => lite.indexes.some((index) => index.name === name)));
  });
});

test('product queries return the same results on Full and on the extracted Lite', async () => {
  await withFullAndLite(({ fullPath, litePath }) => {
    withDatabase(fullPath, (full) => withDatabase(litePath, (lite) => {
      const records = full.prepare('SELECT id, lemma FROM records ORDER BY id').all();
      assert.ok(records.length > 0);
      for (const { id, lemma } of records) {
        assert.deepEqual(getMeaningRecord(lite, id), getMeaningRecord(full, id), `record ${id}`);
        assert.deepEqual(findRecordsBySearchTerm(lite, lemma), findRecordsBySearchTerm(full, lemma), `search ${lemma}`);
      }
    }));
  });
});

test('extraction is deterministic and is not a second canonical build', async () => {
  await withFullAndLite(async ({ directory, fullPath, litePath }) => {
    const again = path.join(directory, 'lite-again.sqlite');
    await extractLiteDictionary({ fullPath, litePath: again, optimization: PLAIN_LAYOUT });
    const rows = (databasePath) => withDatabase(databasePath, (database) => readLogicalDatabaseSnapshot(database));
    assert.deepEqual(rows(again), rows(litePath));
    assert.deepEqual((await readFile(again)).equals(await readFile(litePath)), true, 'same input and layout give identical bytes');
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.staging')).length, 0);
  });
});

test('extraction fails closed: no Lite for a non-Full input, a mislabeled input, or a corrupt Full', async () => {
  await withFullAndLite(async ({ directory, fullPath, litePath }) => {
    const target = path.join(directory, 'rejected.sqlite');

    // A Lite database is not a Full input.
    await assert.rejects(extractLiteDictionary({ fullPath: litePath, litePath: target }), /Full dictionary input/u);
    assert.equal(existsSync(target), false);

    // Same input and output path.
    await assert.rejects(extractLiteDictionary({ fullPath, litePath: fullPath }), /must differ/u);
    assert.ok(existsSync(fullPath), 'a refused extraction must not delete the Full input');

    // Kind label contradicting the tables, in both directions.
    const labelledLite = path.join(directory, 'full-labelled-lite.sqlite');
    await copyFile(fullPath, labelledLite);
    withDatabase(labelledLite, (db) => db.exec("UPDATE metadata SET value = 'lite' WHERE key = 'database_kind'"), {});
    await assert.rejects(extractLiteDictionary({ fullPath: labelledLite, litePath: target }), /not consistent/u);
    const unlabelled = path.join(directory, 'unlabelled.sqlite');
    await copyFile(fullPath, unlabelled);
    withDatabase(unlabelled, (db) => db.exec("DELETE FROM metadata WHERE key = 'database_kind'"), {});
    await assert.rejects(extractLiteDictionary({ fullPath: unlabelled, litePath: target }), /not consistent/u);

    // A Full that fails its foreign-key/integrity verification is refused, never silently projected.
    const tampered = path.join(directory, 'tampered.sqlite');
    await copyFile(fullPath, tampered);
    withDatabase(tampered, (db) => db.exec("PRAGMA foreign_keys = OFF; INSERT INTO search_forms (record_id, position, form) VALUES ('missing-record', 0, 'x')"), {});
    await assert.rejects(extractLiteDictionary({ fullPath: tampered, litePath: target }));
    assert.equal(existsSync(target), false, 'a failed extraction leaves no partial Lite');
  });
});

test('the CI shared artifact must be Full and a Lite database is rejected', async () => {
  await withFullAndLite(async ({ litePath }) => {
    await assert.rejects(validateSharedDictionary({ databasePath: litePath }), /full dictionary/u);
  });
});

test('Full builds in place: no staging file, and the Full output survives a Lite extraction', async () => {
  await withFullAndLite(async ({ directory, fullPath, summary }) => {
    assert.equal(summary.outputPath, fullPath);
    assert.equal(summary.metadata.database_kind, 'full');
    assert.equal(existsSync(`${fullPath}.staging`), false);
    assert.ok(existsSync(fullPath));
    assert.deepEqual((await readdir(directory)).sort(), ['full.sqlite', 'lite.sqlite']);
  });
});

test('Lite verification passes for a real extraction with different files and fails on tampering', async () => {
  await withFullAndLite(async ({ directory, fullPath, litePath }) => {
    const { createHash } = await import('node:crypto');
    const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
    assert.notEqual(await digest(fullPath), await digest(litePath), 'Full and Lite are different files');
    assert.ok(Object.keys(verifyLiteExtraction({ fullPath, litePath })).includes('meaning_relations'));

    for (const mutation of [
      "UPDATE records SET lemma = lemma || 'x' WHERE id = (SELECT MIN(id) FROM records)",
      "UPDATE metadata SET value = 'tampered' WHERE key = 'source_revision'",
      'DELETE FROM search_forms WHERE (record_id, position) = (SELECT record_id, position FROM search_forms ORDER BY record_id, position LIMIT 1)',
    ]) {
      const tampered = path.join(directory, 'tampered-lite.sqlite');
      await copyFile(litePath, tampered);
      withDatabase(tampered, (db) => db.exec(mutation), {});
      assert.throws(() => verifyLiteExtraction({ fullPath, litePath: tampered }), /not identical/u, mutation);
      await rm(tampered, { force: true });
    }
    // Swapped roles are refused by kind.
    assert.throws(() => verifyLiteExtraction({ fullPath: litePath, litePath: fullPath }), /must be a full/u);
  });
});

// Invariant (Issue #800): the shipped Lite database stores every keyed product table clustered on its primary key
// (no separate rowid table + autoindex) and is left compact. The small fixture copies without page slack, so the
// compactness assertions are a guard; the repack gain itself is measured on the real build (docs/lite-db-size-issue-800.md).
test('Lite product tables are WITHOUT ROWID and the file is repacked', async () => {
  const CLUSTERED_TABLES = [
    'records', 'search_forms', 'generated_surface_forms', 'meanings', 'meaning_members', 'meaning_relations',
  ];
  await withFullAndLite(({ litePath }) => {
    withDatabase(litePath, (lite) => {
      for (const table of CLUSTERED_TABLES) {
        const { sql } = lite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        assert.match(sql, /WITHOUT ROWID\s*$/u, `${table} must be WITHOUT ROWID`);
        assert.throws(() => lite.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get(), /no such column: rowid/u);
      }
      assert.equal(lite.prepare('PRAGMA freelist_count').get().freelist_count, 0);
      // Repacked: another VACUUM must not shrink the file, so the page count is already minimal.
      const pagesBefore = lite.prepare('PRAGMA page_count').get().page_count;
      lite.exec('VACUUM;');
      assert.equal(lite.prepare('PRAGMA page_count').get().page_count, pagesBefore);
      assert.doesNotThrow(() => validatePackagedDictionary(lite));
    }, {});
  });
});

// Issue #4761: the packed adjacency codec round-trips and refuses damaged or unsupported input.
test('packed relation codec round-trips every field and rejects truncated, invalid or unsupported data', () => {
  const links = [
    { position: 0, target: 1, type: 'near', relevance: 1, origin: 'typewriter-authored', note: '' },
    { position: 3, target: 536223, type: 'association', relevance: 9, origin: 'typewriter-authored-reverse', note: '' },
    { position: 4, target: 2 ** 40, type: 'mood', relevance: 5, origin: 'typewriter-authored', note: '' },
  ];
  assert.deepEqual(decodePackedRelations(encodePackedRelations(links)), links);
  const texts = [
    { position: 0, text: 1, type: 'scene', relevance: 4 },
    { position: 2, text: 53676, type: 'action', relevance: 9 },
  ];
  assert.deepEqual(decodePackedTextRelations(encodePackedTextRelations(texts)), texts);

  const blob = encodePackedRelations(links);
  assert.throws(() => decodePackedRelations(blob.slice(0, blob.length - 1)), /Truncated|Invalid/u);
  assert.throws(() => decodePackedRelations(blob.slice(0, 1)), /Truncated/u);
  assert.throws(() => decodePackedRelations(Uint8Array.from([PACKED_FORMAT_VERSION + 1, ...blob.slice(1)])), /version/u);
  assert.throws(() => decodePackedRelations(Uint8Array.from([PACKED_FORMAT_VERSION, 0, 0, 0xff])), /Invalid/u);
  assert.throws(() => decodePackedTextRelations(Uint8Array.from([PACKED_FORMAT_VERSION, 0, 1, 0x00])), /Invalid/u);

  const row = links[0];
  for (const bad of [
    { ...row, note: 'x' }, { ...row, type: 'direct' }, { ...row, type: 'antonym' }, { ...row, relevance: 0 },
    { ...row, relevance: 10 }, { ...row, relevance: null }, { ...row, origin: 'stdict-gloss-reference' }, { ...row, target: 0 },
  ]) assert.throws(() => encodePackedRelations([bad]), /Invalid|cannot be packed/u, JSON.stringify(bad));
  assert.throws(() => encodePackedRelations([]), /empty/u);
  assert.throws(() => encodePackedRelations([row, { ...row, target: 2 }]), /strictly increasing/u);
});

test('Meaning IDs map to integers only in canonical m<integer> form and fail otherwise', () => {
  assert.equal(meaningNumber('m001'), 1);
  assert.equal(meaningNumber('m536223'), 536223);
  assert.equal(meaningId(7), 'm007');
  for (const bad of ['m1', 'm0001', 'm000', 'x001', 'm', 'm00a', 'm001_a', `m${'9'.repeat(30)}`, 'M001']) {
    assert.throws(() => meaningNumber(bad), /canonical/u, bad);
  }
});

test('every Lite layout verifies against Full; a layout/table mismatch or damaged packed table fails closed', async () => {
  for (const idCompression of [false, true]) {
    for (const textCompression of [false, true]) {
      await withFullAndLite(({ directory, fullPath, litePath }) => {
        const digests = verifyLiteExtraction({ fullPath, litePath });
        assert.ok(['meaning_relations', 'meaning_text_relations'].every((key) => key in digests));
        withDatabase(litePath, (lite) => {
          assert.equal(lite.prepare("SELECT value FROM metadata WHERE key = 'lite_id_compression'").get().value, String(idCompression));
          assert.equal(lite.prepare("SELECT value FROM metadata WHERE key = 'lite_text_compression'").get().value, String(textCompression));
          assert.doesNotThrow(() => validatePackagedDictionary(lite));
        });
        const flipped = path.join(directory, 'flipped.sqlite');
        return copyFile(litePath, flipped).then(() => {
          withDatabase(flipped, (db) => db.exec("UPDATE metadata SET value = CASE value WHEN 'true' THEN 'false' ELSE 'true' END WHERE key = 'lite_id_compression'"), {});
          assert.throws(() => verifyLiteExtraction({ fullPath, litePath: flipped }), /storage layout/u);
          withDatabase(flipped, (lite) => assert.throws(() => validateRuntimeDictionary(lite), /storage layout/u));
        });
      }, { idCompression, textCompression });
    }
  }
});

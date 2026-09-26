import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  findRecordsBySearchTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
} from '../src/runtime/sqlite-query.js';
import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';

const FIXTURE_SQL = `
INSERT INTO records VALUES ('w001', 'entry', 'start', 'w001', '가다');
INSERT INTO search_forms VALUES ('w001', 0, '가다'), ('w001', 1, '가');
INSERT INTO senses VALUES ('w001-s1', 'w001', 0, 'verb', '합성 뜻');
INSERT INTO generated_surface_forms VALUES (
  '가는', 'w001', 'w001-s1', 'verb-present-adnominal-neun'
);
INSERT INTO records VALUES ('w002', 'entry', 'start', 'w002', '눈');
INSERT INTO search_forms VALUES ('w002', 0, '눈');
INSERT INTO senses VALUES
  ('w002-s1', 'w002', 0, 'noun', '첫 번째 뜻'),
  ('w002-s2', 'w002', 1, 'noun', '두 번째 뜻');
INSERT INTO records VALUES ('r003', 'entry', 'reference-only', NULL, '빛');
INSERT INTO senses VALUES ('r003-s1', 'r003', 0, 'noun', '밝음');
INSERT INTO relations VALUES ('w001-s1', 0, 'r003', 'r003-s1', 'near', '연결된 뜻');
INSERT INTO metadata VALUES ('dictionary_version', 'fixture-v1');
`;

function seedDatabase(database) {
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(SQLITE_SCHEMA_SQL);
  database.exec(FIXTURE_SQL);
}

test('the shared search adapter returns the same exact, form, surface, and ambiguous results on native and WASM SQLite', async () => {
  const native = new DatabaseSync(':memory:');
  const sqlite3 = await sqlite3InitModule();
  const wasm = new sqlite3.oo1.DB();

  try {
    seedDatabase(native);
    seedDatabase(wasm);

    for (const term of ['가다', '가', '가는', '눈']) {
      assert.deepEqual(
        findRecordsBySearchTerm(wasm, term),
        findRecordsBySearchTerm(native, term),
        `search result should match for ${term}`,
      );
    }

    assert.equal(findRecordsBySearchTerm(wasm, '가다').matches[0].match.field, 'lemma');
    assert.equal(findRecordsBySearchTerm(wasm, '가').matches[0].match.field, 'search-form');
    assert.equal(findRecordsBySearchTerm(wasm, '가는').matches[0].match.field, 'generated-surface-form');
    assert.equal(getRecord(wasm, 'w002').senses.length, 2);
    assert.equal(getRecord(native, 'w002').senses.length, 2);
    assert.deepEqual(getMetadata(wasm), getMetadata(native));
    assert.deepEqual(getSenseRelations(wasm, 'w001-s1'), getSenseRelations(native, 'w001-s1'));
    assert.deepEqual(getRecord(wasm, 'w001'), getRecord(native, 'w001'));
  } finally {
    wasm.close();
    native.close();
  }
});

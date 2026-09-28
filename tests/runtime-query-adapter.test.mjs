import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  DICTIONARY_COUNT_QUERIES,
  DICTIONARY_VERSION,
  SQLITE_SCHEMA_VERSION,
} from '../src/runtime/dictionary-contract.js';
import {
  findRecordsBySearchTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
} from '../src/runtime/sqlite-query.js';
import { measureSqliteWasmRuntime } from '../scripts/benchmark/sqlite-runtime.mjs';
import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';

const FIXTURE_SOURCE_REVISION = 'a'.repeat(40);

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
INSERT INTO search_forms VALUES ('r003', 0, '빛'), ('r003', 1, '빛나다');
INSERT INTO senses VALUES ('r003-s1', 'r003', 0, 'noun', '밝음');
INSERT INTO relations VALUES ('w001-s1', 0, 'r003', 'r003-s1', 'near', '연결된 뜻');
`;

function seedDatabase(database) {
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`);
  database.exec(SQLITE_SCHEMA_SQL);
  database.exec(FIXTURE_SQL);
  const metadata = {
    dictionary_version: DICTIONARY_VERSION,
    schema_version: String(SQLITE_SCHEMA_VERSION),
    source_revision: FIXTURE_SOURCE_REVISION,
    source_revision_source: 'git-head',
    source_revision_verified: 'true',
  };
  for (const [key, query] of Object.entries(DICTIONARY_COUNT_QUERIES)) {
    const value = typeof database.selectValue === 'function'
      ? database.selectValue(query)
      : Object.values(database.prepare(query).get())[0];
    metadata[key] = String(value);
  }
  const quoteSql = (value) => `'${String(value).replaceAll("'", "''")}'`;
  for (const [key, value] of Object.entries(metadata)) {
    database.exec(`INSERT INTO metadata (key, value) VALUES (${quoteSql(key)}, ${quoteSql(value)})`);
  }
}

function queryPlan(database, sql, parameters = []) {
  const explain = `EXPLAIN QUERY PLAN ${sql}`;
  if (typeof database.selectObjects === 'function') {
    return database.selectObjects(explain, parameters).map(({ detail }) => detail).join('\n');
  }
  return database.prepare(explain).all(...parameters).map(({ detail }) => detail).join('\n');
}

test('the shared search adapter returns the same exact, form, surface, and ambiguous results on native and WASM SQLite', async () => {
  const native = new DatabaseSync(':memory:');
  const sqlite3 = await sqlite3InitModule();
  const wasm = new sqlite3.oo1.DB();

  try {
    seedDatabase(native);
    seedDatabase(wasm);

    for (const term of ['가다', '가', '가는', '눈', '빛', '빛나다']) {
      assert.deepEqual(
        findRecordsBySearchTerm(wasm, term),
        findRecordsBySearchTerm(native, term),
        `search result should match for ${term}`,
      );
    }

    assert.equal(findRecordsBySearchTerm(wasm, '가다').matches[0].match.field, 'lemma');
    assert.equal(findRecordsBySearchTerm(wasm, '가').matches[0].match.field, 'search-form');
    assert.equal(findRecordsBySearchTerm(wasm, '가는').matches[0].match.field, 'generated-surface-form');
    assert.equal(findRecordsBySearchTerm(wasm, '빛').matches[0].id, 'r003');
    assert.equal(findRecordsBySearchTerm(wasm, '빛').matches[0].role, 'reference-only');
    assert.equal(findRecordsBySearchTerm(wasm, '빛나다').matches[0].id, 'r003');
    assert.equal(findRecordsBySearchTerm(wasm, '빛나다').matches[0].match.field, 'search-form');
    assert.equal(getRecord(wasm, 'w002').senses.length, 2);
    assert.equal(getRecord(native, 'w002').senses.length, 2);
    assert.deepEqual(getMetadata(wasm), getMetadata(native));
    assert.deepEqual(getSenseRelations(wasm, 'w001-s1'), getSenseRelations(native, 'w001-s1'));
    assert.deepEqual(getRecord(wasm, 'w001'), getRecord(native, 'w001'));

    for (const database of [native, wasm]) {
      const plan = queryPlan(database, `
        SELECT id, record_type, role, candidate_id, lemma,
               'lemma' AS match_field, lemma AS match_value, 0 AS match_priority
        FROM records
        WHERE lemma = ?
        UNION ALL
        SELECT records.id, records.record_type, records.role,
               records.candidate_id, records.lemma,
               'search-form' AS match_field, search_forms.form AS match_value,
               1 AS match_priority
        FROM records
        INNER JOIN search_forms ON search_forms.record_id = records.id
        WHERE search_forms.form = ?
        ORDER BY id, match_priority
      `, ['term', 'term']);
      assert.match(plan, /idx_records_lemma/u);
      assert.match(plan, /idx_search_forms_form/u);
      assert.doesNotMatch(plan, /SCAN (?:records|search_forms)/u);
    }
  } finally {
    wasm.close();
    native.close();
  }
});

test('SQLite WASM runtime benchmark closes the cold database before a single-instance warm reopen', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-sqlite-runtime-'));
  const databasePath = path.join(temporaryDirectory, 'fixture.sqlite');
  const fixtureDatabase = new DatabaseSync(databasePath);

  try {
    seedDatabase(fixtureDatabase);
    fixtureDatabase.close();

    const report = await measureSqliteWasmRuntime({
      databasePath,
      queryCases: [
        { category: 'exact-lemma', term: '가다', expected_field: 'lemma' },
        { category: 'search-form', term: '가', expected_field: 'search-form' },
        { category: 'generated-surface-form', term: '가는', expected_field: 'generated-surface-form' },
        {
          category: 'ambiguous-multi-sense',
          term: '눈',
          expected_field: 'lemma',
          record_id: 'w002',
          expected_sense_count: 2,
        },
      ],
      iterations: 5,
      expectedSourceRevision: FIXTURE_SOURCE_REVISION,
    });

    assert.equal(report.contract_version, 'sqlite-wasm-runtime-benchmark-v3');
    assert.match(report.startup.readiness_scope, /validatePackagedDictionary/u);
    assert.equal(
      report.startup.worker_ready_ms,
      Math.round((report.startup.raw_open_ms
        + report.startup.query_only_setup_ms
        + report.startup.packaged_dictionary_validation_ms
        + report.startup.read_only_probe_ms) * 100) / 100,
    );
    assert.ok(report.startup.warm_worker_ready_ms >= report.startup.warm_database_reopen_ms);
    assert.equal(report.database_lifecycle.max_live_databases, 1);
    assert.deepEqual(report.database_lifecycle.events, [
      'cold_open',
      'cold_close',
      'warm_open',
      'warm_close',
    ]);
    assert.ok(report.memory.cold_load.peak_rss_mb >= report.memory.cold_load.steady_state_rss_mb);
    assert.ok(report.memory.warm_reopen.after_open_rss_mb > 0);
    assert.ok(report.memory.process_max_rss_mb > 0);
  } finally {
    try {
      fixtureDatabase.close();
    } catch {
      // The successful setup closes the file before the WASM runtime reads it.
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

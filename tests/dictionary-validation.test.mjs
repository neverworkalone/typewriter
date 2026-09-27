import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  DICTIONARY_COUNT_QUERIES,
  DICTIONARY_VERSION,
  SQLITE_SCHEMA_VERSION,
} from '../src/runtime/dictionary-contract.js';
import {
  readForeignKeyViolations,
  validatePackagedDictionary,
} from '../src/runtime/dictionary-validation.js';
import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';

function createDictionary({ metadataOverrides = {}, userVersion = SQLITE_SCHEMA_VERSION } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA user_version = ${Number(userVersion)}; ${SQLITE_SCHEMA_SQL}`);
  const metadata = {
    dictionary_version: DICTIONARY_VERSION,
    schema_version: SQLITE_SCHEMA_VERSION,
    source_revision: 'a'.repeat(40),
    source_revision_source: 'git-head',
    source_revision_verified: 'true',
    ...Object.fromEntries(Object.keys(DICTIONARY_COUNT_QUERIES).map((key) => [key, '0'])),
    ...metadataOverrides,
  };
  const insert = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(metadata)) insert.run(key, value);
  return database;
}

test('validates current packaged schema, version, revision, integrity, and row counts', () => {
  const database = createDictionary();
  try {
    assert.deepEqual(validatePackagedDictionary(database), {
      dictionary_version: DICTIONARY_VERSION,
      schema_version: SQLITE_SCHEMA_VERSION,
      source_revision: 'a'.repeat(40),
      source_revision_source: 'git-head',
      source_revision_verified: 'true',
      ...Object.fromEntries(Object.keys(DICTIONARY_COUNT_QUERIES).map((key) => [key, '0'])),
    });
  } finally {
    database.close();
  }
});

test('rejects a schema metadata or SQLite user_version mismatch before queries run', () => {
  const metadataMismatch = createDictionary({ metadataOverrides: { schema_version: '3' } });
  const pragmaMismatch = createDictionary({ userVersion: '3' });
  try {
    assert.throws(() => validatePackagedDictionary(metadataMismatch), {
      code: 'DATABASE_SCHEMA_MISMATCH',
    });
    assert.throws(() => validatePackagedDictionary(pragmaMismatch), {
      code: 'DATABASE_SCHEMA_MISMATCH',
    });
  } finally {
    metadataMismatch.close();
    pragmaMismatch.close();
  }
});

test('rejects unsupported dictionary versions and unverified source revisions', () => {
  const versionMismatch = createDictionary({
    metadataOverrides: { dictionary_version: 'future-version' },
  });
  const invalidRevision = createDictionary({
    metadataOverrides: { source_revision: 'not-a-commit' },
  });
  try {
    assert.throws(() => validatePackagedDictionary(versionMismatch), {
      code: 'DICTIONARY_VERSION_MISMATCH',
    });
    assert.throws(() => validatePackagedDictionary(invalidRevision), {
      code: 'DATABASE_METADATA_INVALID',
    });
  } finally {
    versionMismatch.close();
    invalidRevision.close();
  }
});

test('rejects a dictionary that belongs to a different extension source revision', () => {
  const database = createDictionary();
  try {
    assert.throws(() => validatePackagedDictionary(database, {
      expectedSourceRevision: 'b'.repeat(40),
    }), {
      code: 'DICTIONARY_REVISION_MISMATCH',
    });
  } finally {
    database.close();
  }
});

test('rejects truncated dictionary contents and missing tables against packaged counts', () => {
  const missingRow = createDictionary();
  const missingTable = createDictionary();
  try {
    missingRow.exec("INSERT INTO records (id, record_type, role, candidate_id, lemma) VALUES ('w001', 'entry', 'start', 'w001', '가다')");
    assert.throws(() => validatePackagedDictionary(missingRow), {
      code: 'DATABASE_METADATA_INVALID',
    });

    missingTable.exec('DROP TABLE generated_surface_forms');
    assert.throws(() => validatePackagedDictionary(missingTable), {
      code: 'DATABASE_METADATA_INVALID',
    });
  } finally {
    missingRow.close();
    missingTable.close();
  }
});

test('rejects dangling foreign keys even when quick_check and every row count still match', () => {
  const database = createDictionary({
    metadataOverrides: {
      record_count: '1',
      start_count: '1',
      search_form_count: '1',
    },
  });
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare(`
      INSERT INTO records (id, record_type, role, candidate_id, lemma)
      VALUES ('w001', 'entry', 'start', NULL, '가다')
    `).run();
    database.prepare(`
      INSERT INTO search_forms (record_id, position, form)
      VALUES ('w001', 0, '가다')
    `).run();
    database.prepare(`
      UPDATE search_forms SET record_id = '__missing_record__'
      WHERE record_id = 'w001' AND position = 0
    `).run();

    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    for (const [key, sql] of Object.entries(DICTIONARY_COUNT_QUERIES)) {
      const actual = String(Object.values(database.prepare(sql).get())[0]);
      const expected = database.prepare('SELECT value FROM metadata WHERE key = ?').get(key).value;
      assert.equal(actual, expected);
    }
    assert.equal(readForeignKeyViolations(database).length, 1);
    assert.throws(() => validatePackagedDictionary(database), {
      code: 'DATABASE_INTEGRITY_FAILED',
    });
  } finally {
    database.close();
  }
});

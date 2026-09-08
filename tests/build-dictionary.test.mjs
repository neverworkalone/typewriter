import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { BuildError, buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
} from '../scripts/build/query.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PILOT_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');

async function createOutputDirectory() {
  return mkdtemp(path.join(tmpdir(), 'typewriter-build-'));
}

function countRows(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('builds a read-only SQLite dictionary with representative lookups', async () => {
  const outputDirectory = await createOutputDirectory();
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    const summary = await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });

    assert.equal(summary.recordCount, 620);
    assert.equal(summary.searchFormCount, 696);
    assert.equal(summary.senseCount, 743);
    assert.equal(summary.relationCount, 467);
    assert.equal(summary.metadata.schema_version, '1');
    assert.equal(summary.metadata.normalization_version, '1');

    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(countRows(database, 'records'), 620);
      assert.equal(countRows(database, 'search_forms'), 696);
      assert.equal(countRows(database, 'senses'), 743);
      assert.equal(countRows(database, 'relations'), 467);
      assert.deepEqual(getMetadata(database), summary.metadata);

      assert.deepEqual(findRecordsByExactTerm(database, '담담'), [
        {
          id: 'w026',
          record_type: 'entry',
          role: 'start',
          candidate_id: 'w026',
          lemma: '담담하다',
        },
      ]);
      assert.deepEqual(
        findRecordsByExactTerm(database, '마음이 놓이다').map(({ id, lemma }) => ({
          id,
          lemma,
        })),
        [{ id: 'w288', lemma: '마음이 놓이다' }],
      );

      const polysemousRecord = getRecord(database, 'w237');
      assert.equal(polysemousRecord.senses.length, 4);
      assert.equal(polysemousRecord.senses[0].id, 'w237-s1');
      assert.equal(polysemousRecord.senses[0].relations[0].target, 'r014');

      const expression = getRecord(database, 'w288');
      assert.equal(expression.record_type, 'expression');
      assert.equal(expression.role, 'start');
      assert.equal(expression.senses[0].pos, 'expression');

      const reference = getRecord(database, 'r001');
      assert.equal(reference.role, 'reference-only');
      assert.equal(reference.candidate_id, null);

      const directRelations = getSenseRelations(database, 'w026-s1');
      assert.equal(directRelations[0].target, 'r008');
      assert.equal(directRelations[0].target_sense, 'r008-s1');
      assert.equal(directRelations[0].target_lemma, '덤덤하다');
      assert.equal(directRelations[0].type, 'direct');
      assert.match(directRelations[0].note, /직접 바꿔/);
      assert.deepEqual(getSenseRelations(database, 'r008-s1'), []);

      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all()
        .map(({ name }) => name);
      assert.deepEqual(indexes.filter((name) => name.startsWith('idx_')), [
        'idx_records_lemma',
        'idx_relations_source_position',
        'idx_relations_target',
        'idx_search_forms_form',
        'idx_senses_record_position',
      ]);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

      assert.throws(
        () =>
          database.exec(
            "INSERT INTO records (id, record_type, role, lemma) VALUES ('w999', 'entry', 'start', '쓰기 금지')",
          ),
        /readonly|read-only/i,
      );
    } finally {
      database.close();
    }

    const reopened = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(countRows(reopened, 'records'), 620);
      assert.equal(getRecord(reopened, 'w999'), null);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('rebuilds from an empty output and protects canonical input', async () => {
  const outputDirectory = await createOutputDirectory();
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
  const canonicalPath = path.join(PILOT_DIRECTORY, 'pilot.jsonl');

  try {
    const before = await readFile(canonicalPath);
    await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });

    const staleDatabase = new DatabaseSync(outputPath);
    staleDatabase.exec('CREATE TABLE stale_build_state (value TEXT NOT NULL);');
    staleDatabase.close();

    await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    assert.deepEqual(await readFile(canonicalPath), before);

    const freshDatabase = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(
        freshDatabase
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stale_build_state'",
          )
          .get(),
        undefined,
      );
      assert.equal(countRows(freshDatabase, 'records'), 620);
    } finally {
      freshDatabase.close();
    }

    await assert.rejects(
      buildDictionary({
        inputDirectory: PILOT_DIRECTORY,
        outputPath: path.join(PILOT_DIRECTORY, 'not-generated.sqlite'),
        allowDirty: true,
      }),
      (error) => {
        assert.ok(error instanceof BuildError);
        assert.equal(error.code, 'OUTPUT_INSIDE_CANONICAL');
        return true;
      },
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

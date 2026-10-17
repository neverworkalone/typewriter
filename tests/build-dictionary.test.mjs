import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { BuildError, buildDictionary } from '../scripts/build/dictionary.mjs';
import { extractLiteDictionary } from '../scripts/build/lite-dictionary.mjs';
import { SQLITE_SCHEMA_VERSION } from '../src/runtime/dictionary-contract.js';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getMetadata,
  getMeaningRecord,
} from '../scripts/build/query.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PILOT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/canonical-sample',
);

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
      allowDirty: true,
    });

    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.metadata.database_kind, 'full');
    assert.equal(existsSync(`${outputPath}.staging`), false);
    assert.equal(summary.recordCount, 6);
    assert.equal(summary.searchFormCount, 7);
    assert.equal(summary.senseCount, 7);
    assert.equal(summary.relationCount, 3);
    assert.match(summary.metadata.canonical_revision, /^[0-9a-f]{64}$/);
    assert.equal(summary.metadata.schema_version, SQLITE_SCHEMA_VERSION);
    assert.equal(summary.metadata.normalization_version, '1');
    assert.equal(summary.metadata.generated_surface_form_count, String(summary.generatedSurfaceFormCount));

    // The Full database keeps the STDICT source senses/relations/provenance next to the product tables.
    const full = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(countRows(full, 'senses'), 7);
      assert.equal(countRows(full, 'relations'), 3);
      assert.deepEqual(
        full.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name),
        [
          'generated_surface_forms', 'meaning_members', 'meaning_relation_sources', 'meaning_relations', 'meanings',
          'metadata', 'records', 'relations', 'search_forms', 'sense_adjudications', 'senses',
        ],
      );
      const relation = full.prepare(
        "SELECT target_record_id, target_sense_id, type, note FROM relations WHERE source_sense_id = 'w001-s1'",
      ).get();
      assert.equal(relation.target_record_id, 'r001');
      assert.equal(relation.target_sense_id, 'r001-s1');
      assert.equal(relation.type, 'direct');
      assert.match(relation.note, /바꿔 쓸/);
    } finally {
      full.close();
    }

    // The Lite product database is extracted from the verified Full database and ships no source layer.
    const litePath = path.join(outputDirectory, 'lite.sqlite');
    await extractLiteDictionary({ fullPath: outputPath, litePath });
    const database = new DatabaseSync(litePath, { readOnly: true });
    try {
      assert.equal(countRows(database, 'records'), 6);
      assert.equal(countRows(database, 'search_forms'), 7);
      assert.deepEqual(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name),
        [
          'generated_surface_forms', 'meaning_members', 'meaning_relations', 'meanings',
          'metadata', 'records', 'search_forms', 'sense_adjudications',
        ],
      );
      assert.equal(countRows(database, 'generated_surface_forms'), summary.generatedSurfaceFormCount);
      assert.deepEqual(getMetadata(database), { ...summary.metadata, database_kind: 'lite' });

      assert.deepEqual(findRecordsByExactTerm(database, '기쁨'), [
        {
          id: 'w001',
          record_type: 'entry',
          role: 'start',
          candidate_id: 'w001',
          lemma: '기쁨',
        },
      ]);
      assert.deepEqual(
        findRecordsByExactTerm(database, '마음이 놓이다').map(({ id, lemma }) => ({
          id,
          lemma,
        })),
        [{ id: 'w003', lemma: '마음이 놓이다' }],
      );
      assert.deepEqual(findRecordsByExactTerm(database, '환희'), []);
      assert.equal(getMeaningRecord(database, 'w999'), null);

      const expression = getMeaningRecord(database, 'w003');
      assert.equal(expression.record_type, 'expression');
      assert.equal(expression.role, 'start');
      assert.equal(expression.view, 'meaning');

      const reference = getMeaningRecord(database, 'r001');
      assert.equal(reference.role, 'reference-only');
      assert.equal(reference.candidate_id, null);

      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all()
        .map(({ name }) => name);
      assert.deepEqual(indexes.filter((name) => name.startsWith('idx_')), [
        'idx_generated_surface_forms_form',
        'idx_meaning_members_record',
        'idx_meaning_relations_target',
        'idx_meanings_lemma',
        'idx_meanings_record',
        'idx_records_lemma',
        'idx_search_forms_form',
        'idx_sense_adjudications_record',
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
      assert.equal(countRows(reopened, 'records'), 6);
      assert.equal(getMeaningRecord(reopened, 'w999'), null);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('builds a large synthetic noun corpus without binding it to the current surface review', async () => {
  const outputDirectory = await createOutputDirectory();
  const canonicalDirectory = path.join(outputDirectory, 'canonical');
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    await mkdir(canonicalDirectory);
    const records = Array.from({ length: 5_001 }, (_, index) => {
      const id = `r${String(index + 1).padStart(6, '0')}`;
      const lemma = `synthetic-${String(index + 1).padStart(6, '0')}`;
      return {
        id,
        record_type: 'entry',
        role: 'reference-only',
        lemma,
        search_forms: [lemma],
        senses: [{
          id: `${id}-s1`,
          pos: 'noun',
          gloss: `synthetic benchmark record ${index + 1}`,
          relations: [],
        }],
      };
    });
    await writeFile(
      path.join(canonicalDirectory, 'records.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const summary = await buildDictionary({
      inputDirectory: canonicalDirectory,
      outputPath,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
    });

    assert.equal(summary.recordCount, records.length);
    assert.equal(summary.generatedSurfaceFormCount, 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('preserves adverb POS in the canonical-to-SQLite build', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-adverb-build-'));
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const outputPath = path.join(temporaryDirectory, 'dictionary.sqlite');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'adverb.jsonl'), `${JSON.stringify({
    id: 'w990',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w990',
    lemma: '불현듯',
    search_forms: ['불현듯'],
    senses: [{ id: 'w990-s1', pos: 'adverb', gloss: '생각이 뜻밖의 순간에 갑자기 떠오르는 모양.' }],
  })}\n`);

  try {
    await buildDictionary({
      inputDirectory: canonicalDirectory,
      outputPath,
      allowDirty: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
    });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT pos FROM senses WHERE id = ?').get('w990-s1').pos, 'adverb');
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rebuilds from an empty output and protects canonical input', async () => {
  const outputDirectory = await createOutputDirectory();
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
  const canonicalPath = path.join(PILOT_DIRECTORY, 'sample.jsonl');

  try {
    const before = await readFile(canonicalPath);
    await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath,
      allowDirty: true,
    });

    const staleDatabase = new DatabaseSync(outputPath);
    staleDatabase.exec('CREATE TABLE stale_build_state (value TEXT NOT NULL);');
    staleDatabase.close();

    await buildDictionary({
      inputDirectory: PILOT_DIRECTORY,
      outputPath,
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
      assert.equal(countRows(freshDatabase, 'records'), 6);
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

test('builds the meaning layer and projected meaning relations with provenance', async () => {
  const outputDirectory = await createOutputDirectory();
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
  const meaningsDirectory = path.join(outputDirectory, 'meanings');
  const adjudicationDirectory = path.join(outputDirectory, 'adjudication');

  try {
    const { writeMeanings, writeAdjudications } = await import('../scripts/meaning/contract.mjs');
    // The fixture's reference-only record uses an r-prefixed id; the meaning layer needs canonical w-ids.
    const canonicalDirectory = path.join(outputDirectory, 'canonical');
    await mkdir(canonicalDirectory);
    for (const name of (await readdir(PILOT_DIRECTORY)).filter((item) => item.endsWith('.jsonl'))) {
      const text = (await readFile(path.join(PILOT_DIRECTORY, name), 'utf8')).replaceAll('r001', 'w006');
      await writeFile(path.join(canonicalDirectory, name), text);
    }
    const canonical = (await readdir(canonicalDirectory)).filter((name) => name.endsWith('.jsonl'));
    const meanings = [];
    for (const name of canonical) {
      for (const line of (await readFile(path.join(canonicalDirectory, name), 'utf8')).split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line);
        record.senses.forEach((sense, index) => {
          const number = record.id.slice(1);
          meanings.push({
            id: record.senses.length === 1 ? `m${number}` : `m${number}_${index + 1}`,
            lemma: record.lemma,
            gloss: sense.gloss,
            sense_ids: [sense.id],
          });
        });
      }
    }
    writeMeanings(meaningsDirectory, meanings);
    writeAdjudications(adjudicationDirectory, []);

    const summary = await buildDictionary({
      inputDirectory: canonicalDirectory,
      outputPath,
      allowDirty: true,
      meaningsDirectory,
      adjudicationDirectory,
    });
    assert.equal(summary.meaningCount, 7);
    assert.equal(summary.meaningRelationCount, 3);
    assert.equal(summary.metadata.meaning_relation_count, '3');
    assert.equal(summary.metadata.meaning_projection_source_relation_count, '3');

    const litePath = path.join(path.dirname(outputPath), 'lite.sqlite');
    await extractLiteDictionary({ fullPath: outputPath, litePath });
    const database = new DatabaseSync(litePath, { readOnly: true });
    try {
      assert.equal(countRows(database, 'meanings'), 7);
      assert.equal(countRows(database, 'meaning_members'), 7);
      assert.equal(countRows(database, 'meaning_relations'), 3);
      assert.deepEqual(
        database.prepare("SELECT name FROM sqlite_master WHERE name IN ('senses', 'relations', 'meaning_relation_sources')").all(),
        [],
      );
      assert.deepEqual(
        database.prepare('SELECT id FROM meanings ORDER BY id').all().map((row) => ({ ...row })).slice(0, 1),
        [{ id: 'm001' }],
      );
      assert.deepEqual(database.prepare("SELECT sense_id, record_id FROM meaning_members WHERE meaning_id = 'm001'").all().map((row) => ({ ...row })),
        [{ sense_id: 'w001-s1', record_id: 'w001' }]);
      const { getMeaningRelations, getMeaningsByLemma } = await import('../src/runtime/sqlite-query.js');
      assert.deepEqual(getMeaningsByLemma(database, '기쁨').map((m) => [m.id, m.sense_ids]), [['m001', ['w001-s1']]]);
      const relations = getMeaningRelations(database, 'm001');
      assert.ok(relations.length > 0);
      for (const relation of relations) {
        assert.equal(relation.origin, 'stdict-sense-projection');
        assert.equal(relation.sources, undefined);
      }
      // The only ordering metadata is the source homograph number; the record owner is derived from the ID.
      const stored = database.prepare('SELECT id, record_id, homograph_no FROM meanings').all().map((row) => ({ ...row }));
      assert.ok(stored.every(({ id, record_id: recordId }) => recordId === `w${id.slice(1).split('_')[0]}`));
      assert.ok(stored.every(({ homograph_no: no }) => no === null || (Number.isInteger(no) && no >= 1 && no <= 99)));
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }

    await rm(path.join(meaningsDirectory, 'c01_001.jsonl'), { force: true });
    await assert.rejects(
      buildDictionary({
        inputDirectory: canonicalDirectory,
        outputPath: path.join(outputDirectory, 'broken.sqlite'),
        allowDirty: true,
        meaningsDirectory: path.join(outputDirectory, 'missing-meanings'),
        adjudicationDirectory,
      }),
      (error) => error.code === 'INVALID_MEANING_DATA',
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

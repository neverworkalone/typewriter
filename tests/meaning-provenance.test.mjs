import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { writeAdjudications, writeMeanings } from '../scripts/meaning/contract.mjs';
import { MEANING_INTEGRITY_QUERIES } from '../src/runtime/dictionary-contract.js';
import { validatePackagedDictionary } from '../src/runtime/dictionary-validation.js';

const record = (n, lemma, senses) => ({
  id: `w00${n}`, record_type: 'entry', role: 'start', candidate_id: `w00${n}`, lemma, search_forms: [lemma],
  senses: senses.map(([gloss, relations], index) => ({
    id: `w00${n}-s${index + 1}`, pos: 'noun', gloss, ...(relations ? { relations } : {}),
  })),
});
const direct = (target_sense) => ({ target: target_sense.split('-')[0], target_sense, type: 'direct', note: '표준국어대사전 동의어' });

// w001-s1/s2 merge into one meaning; both reach w002-s1 (one deduplicated meaning relation, two sources) and s2 reaches w003-s1.
const RECORDS = [
  record(1, '가나', [['첫째 뜻풀이.', [direct('w002-s1')]], ['둘째 뜻풀이.', [direct('w002-s1'), direct('w003-s1')]]]),
  record(2, '다라', [['다라의 뜻풀이.']]),
  record(3, '마바', [['마바의 뜻풀이.']]),
];
const MEANINGS = [
  { id: 'm001', lemma: '가나', gloss: '가나의 뜻풀이.', sense_ids: ['w001-s1', 'w001-s2'] },
  { id: 'm002', lemma: '다라', gloss: '다라의 뜻풀이.', sense_ids: ['w002-s1'] },
  { id: 'm003', lemma: '마바', gloss: '마바의 뜻풀이.', sense_ids: ['w003-s1'] },
];

async function buildFixture(directory) {
  const canonicalDirectory = path.join(directory, 'canonical');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${RECORDS.map((item) => JSON.stringify(item)).join('\n')}\n`);
  writeMeanings(path.join(directory, 'meanings'), MEANINGS);
  writeAdjudications(path.join(directory, 'adjudication'), []);
  const outputPath = path.join(directory, 'dictionary.sqlite');
  await buildDictionary({
    inputDirectory: canonicalDirectory,
    outputPath,
    allowDirty: true,
    meaningsDirectory: path.join(directory, 'meanings'),
    adjudicationDirectory: path.join(directory, 'adjudication'),
  });
  return outputPath;
}

function violations(databasePath, mutate = () => {}) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    mutate(database);
    return Object.fromEntries(Object.entries(MEANING_INTEGRITY_QUERIES)
      .map(([name, sql]) => [name, Number(Object.values(database.prepare(sql).get())[0])])
      .filter(([, count]) => count !== 0));
  } finally {
    database.close();
  }
}

test('meaning relation provenance: valid mapping passes; deleted, mis-bound and missing provenance fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-provenance-'));
  try {
    const good = await buildFixture(directory);
    const database = new DatabaseSync(good, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relations').get().c, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relation_sources').get().c, 3);
    database.close();
    assert.deepEqual(violations(good), {});

    const copy = (name) => path.join(directory, name);
    await copyFile(good, copy('deleted.sqlite'));
    assert.deepEqual(
      violations(copy('deleted.sqlite'), (db) => db.exec(
        "DELETE FROM meaning_relation_sources WHERE source_sense_id = 'w001-s2' AND source_position = 1",
      )),
      { meaning_relation_without_provenance: 1, projectable_relation_without_provenance: 1 },
    );

    // Same row count, but two provenance rows point at each other's (existing) original relation.
    await copyFile(good, copy('misbound.sqlite'));
    const misbound = violations(copy('misbound.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relation_sources SET source_position = 100 WHERE source_sense_id = 'w001-s2' AND source_position = 0;
        UPDATE meaning_relation_sources SET source_position = 0 WHERE source_sense_id = 'w001-s2' AND source_position = 1;
        UPDATE meaning_relation_sources SET source_position = 1 WHERE source_sense_id = 'w001-s2' AND source_position = 100;
      `);
    });
    assert.ok(misbound.meaning_relation_source_mismatch > 0, JSON.stringify(misbound));

    await copyFile(good, copy('flag.sqlite'));
    assert.ok(violations(copy('flag.sqlite'), (db) => db.exec(
      'UPDATE meaning_relation_sources SET target_redirected = 1',
    )).meaning_relation_source_mismatch > 0);

    const tampered = new DatabaseSync(copy('deleted.sqlite'));
    try {
      assert.throws(() => validatePackagedDictionary(tampered), (error) => error.code !== undefined);
    } finally {
      tampered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

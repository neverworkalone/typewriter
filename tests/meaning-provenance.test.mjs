import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { extractLiteDictionary } from '../scripts/build/lite-dictionary.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { writeAdjudications, writeMeanings } from '../scripts/meaning/contract.mjs';
import { MEANING_INTEGRITY_QUERIES } from '../src/runtime/dictionary-contract.js';
import { MEANING_SOURCE_INTEGRITY_QUERIES } from '../scripts/build/meaning-source-checks.mjs';
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
  record(1, '가나', [['첫째 뜻풀이.', [{ ...direct('w002-s1'), type: 'near', note: '첫째 근거', relevance: 2 }]], ['둘째 뜻풀이.', [{ ...direct('w002-s1'), type: 'near', note: '둘째 근거', relevance: 4 }, direct('w003-s1')]]]),
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
  // The source-derived checks run on the Full database; the Lite product database is extracted from it.
  const litePath = path.join(directory, 'lite.sqlite');
  await extractLiteDictionary({ fullPath: outputPath, litePath });
  return { deployed: litePath, full: outputPath };
}

// Authored relations arrive through the build, which recomputes the ranking; a hand-edit must do the same.
const RERANK_SQL = `
  UPDATE meanings SET
    lexical_relation_count = (SELECT COUNT(DISTINCT target_meaning_id) FROM meaning_relations
      WHERE source_meaning_id = meanings.id AND type IN ('direct', 'antonym')),
    exploratory_relation_count = (SELECT COUNT(DISTINCT target_meaning_id) FROM meaning_relations
      WHERE source_meaning_id = meanings.id AND type NOT IN ('direct', 'antonym'));
  UPDATE meanings SET display_rank = display_rank + 1000;
  UPDATE meanings SET display_rank = (
    SELECT COUNT(*) FROM meanings AS other
    WHERE other.lexical_relation_count > meanings.lexical_relation_count
       OR (other.lexical_relation_count = meanings.lexical_relation_count
           AND (other.exploratory_relation_count > meanings.exploratory_relation_count
             OR (other.exploratory_relation_count = meanings.exploratory_relation_count AND other.id <= meanings.id)))
  );`;

function violations(databasePath, mutate = () => {}) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    mutate(database);
    return Object.fromEntries(Object.entries({ ...MEANING_INTEGRITY_QUERIES, ...MEANING_SOURCE_INTEGRITY_QUERIES })
      .map(([name, sql]) => [name, Number(Object.values(database.prepare(sql).get())[0])])
      .filter(([, count]) => count !== 0));
  } finally {
    database.close();
  }
}

test('meaning relation provenance: valid mapping passes; deleted, mis-bound and missing provenance fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-provenance-'));
  try {
    const { deployed, full: good } = await buildFixture(directory);
    const database = new DatabaseSync(good, { readOnly: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relations').get().c, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM meaning_relation_sources').get().c, 3);
    database.close();
    const shipped = new DatabaseSync(deployed, { readOnly: true });
    assert.equal(shipped.prepare('SELECT COUNT(*) AS c FROM meaning_relations').get().c, 2);
    assert.deepEqual(
      shipped.prepare("SELECT name FROM sqlite_master WHERE name IN ('senses', 'relations', 'meaning_relation_sources')").all(),
      [],
    );
    shipped.close();
    const shippedChecked = new DatabaseSync(deployed, { readOnly: true });
    // Source-derived checks need the Full tables; the shipped database runs only its self-contained checks.
    assert.doesNotThrow(() => validatePackagedDictionary(shippedChecked, { expectedSourceRevision: undefined }));
    shippedChecked.close();
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

    // Typewriter-authored relation without STDICT provenance is valid; an unknown origin is rejected by the schema.
    await copyFile(good, copy('authored.sqlite'));
    assert.deepEqual(violations(copy('authored.sqlite'), (db) => db.exec(
      "INSERT INTO meaning_relations (source_meaning_id, position, target_meaning_id, type, note, relevance, origin) "
      + "VALUES ('m002', 0, 'm003', 'near', '작성한 연관', 3, 'typewriter-authored')",
    ) || db.exec(RERANK_SQL)), {});
    await copyFile(good, copy('stale-rank.sqlite'));
    assert.deepEqual(violations(copy('stale-rank.sqlite'), (db) => db.exec(
      "INSERT INTO meaning_relations (source_meaning_id, position, target_meaning_id, type, note, relevance, origin) "
      + "VALUES ('m002', 0, 'm003', 'near', '작성한 연관', 3, 'typewriter-authored')",
    )), { meaning_relation_count_mismatch: 1 });
    await copyFile(good, copy('swapped-rank.sqlite'));
    assert.deepEqual(violations(copy('swapped-rank.sqlite'), (db) => db.exec(`
      UPDATE meanings SET display_rank = 100 WHERE id = 'm001';
      UPDATE meanings SET display_rank = 1 WHERE id = 'm002';
      UPDATE meanings SET display_rank = 2 WHERE id = 'm001';
    `)), { meaning_rank_order_violation: 1 });
    await copyFile(good, copy('gap-rank.sqlite'));
    assert.deepEqual(violations(copy('gap-rank.sqlite'), (db) => db.exec(
      "UPDATE meanings SET display_rank = 9 WHERE id = 'm003'",
    )), { meaning_rank_not_dense: 1 });
    await copyFile(good, copy('origin.sqlite'));
    assert.throws(() => violations(copy('origin.sqlite'), (db) => db.exec(
      "UPDATE meaning_relations SET origin = 'other' WHERE source_meaning_id = 'm001' AND position = 0",
    )), /CHECK/);

    // Relabelling a projected relation as authored does not bypass the source checks.
    await copyFile(good, copy('relabel.sqlite'));
    assert.ok(violations(copy('relabel.sqlite'), (db) => db.exec(
      "UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE source_meaning_id = 'm001' AND position = 0",
    )).meaning_relation_provenance_on_non_projection > 0);
    await copyFile(good, copy('relabel-clean.sqlite'));
    assert.ok(violations(copy('relabel-clean.sqlite'), (db) => db.exec(`
      DELETE FROM meaning_relation_sources WHERE source_meaning_id = 'm001' AND relation_position = 0;
      UPDATE meaning_relations SET origin = 'typewriter-authored' WHERE source_meaning_id = 'm001' AND position = 0;
    `)).projectable_relation_without_provenance > 0);

    // Displayed note/relevance must equal the first contributing source relation (here w001-s1's, not w001-s2's).
        const stored = new DatabaseSync(good, { readOnly: true });
    const row = stored.prepare("SELECT note, relevance FROM meaning_relations WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'").get();
    stored.close();
    assert.deepEqual({ ...row }, { note: '첫째 근거', relevance: 2 });
    for (const [name, sql] of [
      ['note', "UPDATE meaning_relations SET note = '허위 원본 근거' WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
      ['relevance', "UPDATE meaning_relations SET relevance = 9 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
      ['priority', "UPDATE meaning_relations SET note = '둘째 근거', relevance = 4 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002'"],
    ]) {
      await copyFile(good, copy(`${name}.sqlite`));
      assert.ok(violations(copy(`${name}.sqlite`), (db) => db.exec(sql)).meaning_relation_content_mismatch > 0, name);
    }
    // Reordering the provenance ordinals and the displayed values together must not bypass the canonical-first rule.
    await copyFile(good, copy('reordered.sqlite'));
    const reordered = violations(copy('reordered.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relation_sources SET position = 100 WHERE source_sense_id = 'w001-s1' AND source_position = 0;
        UPDATE meaning_relation_sources SET position = 0 WHERE source_sense_id = 'w001-s2' AND source_position = 0;
        UPDATE meaning_relation_sources SET position = 1 WHERE source_sense_id = 'w001-s1' AND source_position = 0;
        UPDATE meaning_relations SET note = '둘째 근거', relevance = 4 WHERE source_meaning_id = 'm001' AND target_meaning_id = 'm002';
      `);
    });
    assert.deepEqual(reordered, { meaning_relation_source_order_violation: 1 });

    // Swapping the positions of two projected relations (and their provenance links) changes the product order only.
    await copyFile(good, copy('swapped.sqlite'));
    const swapped = violations(copy('swapped.sqlite'), (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        UPDATE meaning_relations SET position = 100 WHERE source_meaning_id = 'm001' AND position = 0;
        UPDATE meaning_relation_sources SET relation_position = 100 WHERE source_meaning_id = 'm001' AND relation_position = 0;
        UPDATE meaning_relations SET position = 0 WHERE source_meaning_id = 'm001' AND position = 1;
        UPDATE meaning_relation_sources SET relation_position = 0 WHERE source_meaning_id = 'm001' AND relation_position = 1;
        UPDATE meaning_relations SET position = 1 WHERE source_meaning_id = 'm001' AND position = 100;
        UPDATE meaning_relation_sources SET relation_position = 1 WHERE source_meaning_id = 'm001' AND relation_position = 100;
      `);
    });
    assert.deepEqual(swapped, { meaning_relation_position_order_violation: 1 });

    // An authored relation owns its own note/relevance and is not compared with STDICT.
    await copyFile(good, copy('authored-content.sqlite'));
    assert.deepEqual(violations(copy('authored-content.sqlite'), (db) => db.exec(
      "INSERT INTO meaning_relations (source_meaning_id, position, target_meaning_id, type, note, relevance, origin) "
      + "VALUES ('m002', 0, 'm001', 'mood', '자체 근거', 9, 'typewriter-authored')",
    ) || db.exec(RERANK_SQL)), {});

    await copyFile(good, copy('flag.sqlite'));
    assert.ok(violations(copy('flag.sqlite'), (db) => db.exec(
      'UPDATE meaning_relation_sources SET target_redirected = 1',
    )).meaning_relation_source_mismatch > 0);

    await copyFile(deployed, copy('shipped-tampered.sqlite'));
    const tampered = new DatabaseSync(copy('shipped-tampered.sqlite'));
    try {
      tampered.exec("DELETE FROM meaning_relations WHERE source_meaning_id = 'm001' AND position = 0");
      assert.throws(() => validatePackagedDictionary(tampered), (error) => error.code !== undefined);
    } finally {
      tampered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

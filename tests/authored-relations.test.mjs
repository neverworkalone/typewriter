import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { extractLiteDictionary } from '../scripts/build/lite-dictionary.mjs';
import { projectRelation } from '../src/domain/projection.js';
import { getMeaningRecord } from '../src/runtime/sqlite-query.js';
import { validatePackagedDictionary } from '../src/runtime/dictionary-validation.js';

const record = (n, lemma, senses) => ({
  id: `w00${n}`, record_type: 'entry', role: 'start', candidate_id: `w00${n}`, lemma, search_forms: [lemma],
  senses: senses.map(([gloss, relations], index) => ({
    id: `w00${n}-s${index + 1}`, pos: 'noun', gloss, ...(relations ? { relations } : {}),
  })),
});
const RECORDS = [
  record(1, '가나', [['가나의 뜻.', [{ target: 'w002', target_sense: 'w002-s1', type: 'direct', note: '표준국어대사전 동의어' }]]]),
  record(2, '다라', [['다라의 뜻.']]),
  record(3, '마바', [['마바의 뜻.']]),
  record(4, '사아', [['사아의 첫째 뜻.'], ['사아의 둘째 뜻.']]),
];
const idRow = (over = {}) => ({
  source_record_id: 'w001', source_sense_id: 'w001-s1', target_record_id: 'w003', target_sense_id: 'w003-s1',
  type: 'near', relevance: 2, reverse_type: 'mood', reverse_relevance: 6, ...over,
});
const textRow = (over = {}) => ({ source_record_id: 'w001', source_sense_id: 'w001-s1', text: '새 말', type: 'scene', relevance: 4, ...over });

async function build(rows, { extra = [] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-authored-'));
  const canonical = path.join(directory, 'canonical');
  const relations = path.join(directory, 'relations');
  await mkdir(canonical);
  await mkdir(relations);
  await writeFile(path.join(canonical, 'part.jsonl'), `${RECORDS.map((item) => JSON.stringify(item)).join('\n')}\n`);
  await writeFile(path.join(relations, 'relation-001.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  for (const [name, list] of extra) await writeFile(path.join(relations, name), list.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const full = path.join(directory, 'dictionary.sqlite');
  try {
    await buildDictionary({ inputDirectory: canonical, outputPath: full, relationsDirectory: relations, allowDirty: true, recordMeanings: true });
    const lite = path.join(directory, 'lite.sqlite');
    await extractLiteDictionary({ fullPath: full, litePath: lite });
    return { directory, full, lite };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('an authored ID relation becomes two navigable rows with their own type/tier; text-only stays plain text', async () => {
  const built = await build([idRow(), textRow()]);
  try {
    const lite = new DatabaseSync(built.lite, { readOnly: true });
    const rows = lite.prepare("SELECT source_meaning_id, target_meaning_id, type, relevance, origin, note FROM meaning_relations WHERE origin LIKE 'typewriter-authored%' ORDER BY source_meaning_id").all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { source_meaning_id: 'm001', target_meaning_id: 'm003', type: 'near', relevance: 2, origin: 'typewriter-authored', note: '' },
      { source_meaning_id: 'm003', target_meaning_id: 'm001', type: 'mood', relevance: 6, origin: 'typewriter-authored-reverse', note: '' },
    ]);
    assert.deepEqual(lite.prepare('SELECT source_meaning_id, text, type, relevance FROM meaning_text_relations').all().map((row) => ({ ...row })), [
      { source_meaning_id: 'm001', text: '새 말', type: 'scene', relevance: 4 },
    ]);
    // STDICT direct (and its derived reverse) are untouched.
    assert.equal(lite.prepare("SELECT COUNT(*) AS c FROM meaning_relations WHERE type = 'direct'").get().c, 2);

    // Forward and reverse use the same runtime query path; text-only is listed without a target and has no reverse.
    const forward = getMeaningRecord(lite, 'w001').senses[0].relations;
    const reverse = getMeaningRecord(lite, 'w003').senses[0].relations;
    assert.ok(forward.some((r) => r.target === 'w003' && r.type === 'near' && r.relevance === 2));
    assert.ok(reverse.some((r) => r.target === 'w001' && r.type === 'mood' && r.relevance === 6));
    const text = forward.find((r) => r.target === null);
    assert.equal(text.target_lemma, '새 말');
    assert.equal(projectRelation(text, 'm001', text.position).action, null);
    assert.equal(projectRelation(forward.find((r) => r.target === 'w003'), 'm001', 0).action.targetRecordId, 'w003');
    assert.equal(getMeaningRecord(lite, 'w002').senses[0].relations.some((r) => r.target_lemma === '새 말'), false);
    assert.doesNotThrow(() => validatePackagedDictionary(lite, { expectedSourceRevision: undefined }));
    lite.close();

    const full = new DatabaseSync(built.full, { readOnly: true });
    assert.equal(full.prepare('SELECT COUNT(*) AS c FROM meaning_relation_authored_sources').get().c, 2);
    full.close();
  } finally {
    await rm(built.directory, { recursive: true, force: true });
  }
});

test('the same approved Relations reproduce the same relation rows', async () => {
  const rows = [textRow(), idRow(), idRow({ source_sense_id: 'w004-s2', source_record_id: 'w004', target_record_id: 'w002', target_sense_id: 'w002-s1', type: 'sensory', relevance: 3 })];
  const dump = async () => {
    const built = await build(rows);
    try {
      const db = new DatabaseSync(built.lite, { readOnly: true });
      const value = JSON.stringify([
        db.prepare('SELECT * FROM meaning_relations ORDER BY source_meaning_id, position').all(),
        db.prepare('SELECT * FROM meaning_text_relations ORDER BY source_meaning_id, position').all(),
      ]);
      db.close();
      return value;
    } finally {
      await rm(built.directory, { recursive: true, force: true });
    }
  };
  assert.equal(await dump(), await dump());
});

test('a second sense of the same meaning reaching the same pair/type keeps the best tier once', async () => {
  const built = await build([
    idRow({ relevance: 5 }),
    idRow({ source_record_id: 'w004', source_sense_id: 'w004-s1', target_record_id: 'w003', target_sense_id: 'w003-s1', relevance: 2 }),
    idRow({ source_record_id: 'w004', source_sense_id: 'w004-s2', target_record_id: 'w003', target_sense_id: 'w003-s1', relevance: 1 }),
  ]);
  try {
    const db = new DatabaseSync(built.lite, { readOnly: true });
    const rows = db.prepare("SELECT relevance FROM meaning_relations WHERE source_meaning_id = 'm004' AND origin = 'typewriter-authored'").all();
    assert.deepEqual(rows.map((row) => row.relevance), [1]);
    db.close();
  } finally {
    await rm(built.directory, { recursive: true, force: true });
  }
});

test('invalid approved Relations fail the build (no row is silently dropped)', async () => {
  const cases = [
    [[idRow({ type: 'direct' })], /type "direct"/],
    [[idRow({ type: 'antonym', reverse_type: 'near' })], /type "antonym"/],
    [[idRow({ relevance: 10 })], /relevance/],
    [[idRow({ reverse_relevance: 0 })], /reverse_relevance/],
    [[idRow({ target_sense_id: 'w999-s1' })], /not a sense/],
    [[idRow({ target_record_id: 'w004', target_sense_id: 'w003-s1' })], /not a sense of w004/],
    [[{ ...textRow(), reverse_type: 'near', reverse_relevance: 3 }], /exactly/],
    [[textRow(), textRow()], /duplicate text/],
    [[idRow(), idRow({ source_record_id: 'w003', source_sense_id: 'w003-s1', target_record_id: 'w001', target_sense_id: 'w001-s1' })], /reverse-duplicate/],
    [[idRow({ target_record_id: 'w002', target_sense_id: 'w002-s1', type: 'near' })], null],
  ];
  for (const [rows, pattern] of cases) {
    if (pattern === null) {
      // near is a different type than the STDICT direct for the same pair: allowed.
      const built = await build(rows);
      await rm(built.directory, { recursive: true, force: true });
      continue;
    }
    await assert.rejects(() => build(rows), pattern, JSON.stringify(rows));
  }
  await assert.rejects(() => build([idRow()], { extra: [['relation-002.jsonl', [idRow()]]] }), /duplicate/);
});

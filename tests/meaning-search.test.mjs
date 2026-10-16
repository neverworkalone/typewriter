import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { writeAdjudications, writeMeanings } from '../scripts/meaning/contract.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import { projectSearchResults } from '../src/domain/projection.js';
import { expandExactSearchCandidates } from '../src/domain/exact-search-candidates.js';
import { findRecordsBySearchTerm, getMeaningRecord } from '../src/runtime/sqlite-query.js';

const wid = (n) => `w${String(n).padStart(3, '0')}`;
const rel = (n, type) => ({ target: wid(n), target_sense: `${wid(n)}-s1`, type, note: '근거' });
const GLOSSES = {
  이동0: '위치를 옮김.', 떠남0: '있던 곳을 벗어남.', 쓸쓸함0: '외롭고 적적한 느낌.',
  가다0: '어떤 장소로 이동하다.', 가다1: '어떤 상태나 시간이 지나가다.', 가다2: '목적지에 도착하러 떠나다.',
  가다3: '기계나 물건이 제대로 작동하다.', 가다4: '값이나 무게 따위가 나가다.',
  오르다0: '높은 데로 옮겨 가다.', 오르다1: '위쪽으로 이동하다.',
  파0: '한글 자모의 열넷째 글자.',
  나무0: '줄기가 단단한 여러해살이 식물.', 나무1: '집을 짓거나 가구를 만드는 재료.',
};
const record = (n, lemma, senses) => ({
  id: wid(n), record_type: 'entry', role: 'start', candidate_id: wid(n), lemma, search_forms: [lemma],
  senses: senses.map((relations, index) => ({
    id: `${wid(n)}-s${index + 1}`, pos: 'verb', gloss: GLOSSES[`${lemma}${index}`] ?? '뜻풀이', ...(relations.length > 0 ? { relations } : {}),
  })),
});

// `가다` (w010, five meanings); targets w002..w004; `나무` (w012) has no relations at all.
const RECORDS = [
  record(2, '이동', [[]]),
  record(3, '떠남', [[]]),
  record(4, '쓸쓸함', [[]]),
  record(10, '가다', [
    [rel(2, 'direct')],
    [rel(3, 'near'), rel(4, 'mood')],
    [rel(2, 'direct'), rel(3, 'antonym'), rel(2, 'near')],
    [],
    [],
  ]),
  record(12, '나무', [[], []]),
  record(13, '파', [[]]),
  record(16, '오르다', [[], []]),
];
const DROPPED = new Set(['w013-s1']);
const DUPLICATES = { 'w016-s2': 'w016-s1' };
const MEANINGS = RECORDS.flatMap((item) => item.senses.filter((sense) => !DROPPED.has(sense.id) && !(sense.id in DUPLICATES)).map((sense, index) => ({
  id: item.senses.length === 1 ? `m${item.id.slice(1)}` : `m${item.id.slice(1)}_${index + 1}`,
  lemma: item.lemma,
  gloss: sense.gloss,
  sense_ids: [sense.id],
})));

async function buildFixture(directory) {
  const canonicalDirectory = path.join(directory, 'canonical');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${RECORDS.map((item) => JSON.stringify(item)).join('\n')}\n`);
  writeMeanings(path.join(directory, 'meanings'), MEANINGS);
  writeAdjudications(path.join(directory, 'adjudication'), [
    ...[...DROPPED].map((sense_id) => ({ sense_id, lemma: '파', decision: 'drop', reason: 'out_of_scope' })),
    ...Object.entries(DUPLICATES).map(([sense_id, duplicate_of]) => ({ sense_id, lemma: '오르다', decision: 'drop', reason: 'duplicate', duplicate_of })),
  ]);
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

function getMeaningsRecordFor(database, term) {
  return findRecordsBySearchTerm(database, term).matches.map(({ id }) => getMeaningRecord(database, id));
}

function search(database, term) {
  const response = findRecordsBySearchTerm(database, term);
  const records = response.matches.map(({ id }) => getMeaningRecord(database, id));
  return projectSearchResults(records, response.matches);
}

test('meaning search: candidates are meanings, ranked by stored counts, at most 3 by default', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-meaning-search-'));
  try {
    const database = new DatabaseSync(await buildFixture(directory), { readOnly: true });
    try {
      const stored = database.prepare(
        'SELECT id, lexical_relation_count AS l, exploratory_relation_count AS e FROM meanings WHERE lemma = ? ORDER BY display_rank',
      ).all('가다').map((row) => ({ ...row }));
      // 유의어+반의어 DESC, then 말의 결+연상 DESC, then ID; duplicate targets count once (m10_3: w002 direct + near).
      assert.deepEqual(stored, [
        { id: 'm010_3', l: 2, e: 1 },
        { id: 'm010_1', l: 1, e: 0 },
        { id: 'm010_2', l: 0, e: 2 },
        { id: 'm010_4', l: 0, e: 0 },
        { id: 'm010_5', l: 0, e: 0 },
      ]);

      // One result for the lemma whose candidates are its meanings.
      const [result, ...rest] = search(database, '가다');
      assert.equal(rest.length, 0);
      assert.deepEqual(result.senses.map(({ id }) => id), stored.map(({ id }) => id));
      assert.deepEqual(result.primarySenseIds, ['m010_3', 'm010_1', 'm010_2']);
      assert.deepEqual(result.moreSenseIds, ['m010_4', 'm010_5']);
      const candidates = expandExactSearchCandidates([result]);
      assert.deepEqual(candidates.filter(({ isMore }) => !isMore).map(({ senseId }) => senseId), result.primarySenseIds);
      assert.equal(candidates.length, 5);

      // Relation targets open the target meaning (its ID-base record + meaning ID), not a raw sense.
      const top = result.senses[0];
      assert.deepEqual(top.relations.map(({ targetId, targetSenseId }) => [targetId, targetSenseId]).sort(), [
        ['w002', 'm002'], ['w002', 'm002'], ['w003', 'm003'],
      ]);

      // Without any relation, one meaning (lowest ID) is still shown and the rest wait behind 더보기.
      const [plain] = search(database, '나무');
      assert.deepEqual(plain.primarySenseIds, ['m012_1']);
      assert.deepEqual(plain.moreSenseIds, ['m012_2']);

      // A record whose every sense is out_of_scope has no meaning: no candidate and no empty card.
      assert.deepEqual(search(database, '파'), []);
      const runtime = {
        search: async (term) => findRecordsBySearchTerm(database, term),
        getRecord: async () => { throw new Error('raw record not expected'); },
        getMeaningRecord: async (id) => getMeaningRecord(database, id),
      };
      const dropped = await new SearchSession({ runtime }).searchExact('파');
      assert.equal(dropped.status, 'empty');
      assert.deepEqual(dropped.results, []);
      const kept = await new SearchSession({ runtime }).searchExact('가다');
      assert.equal(kept.status, 'ready');
      assert.equal(kept.results.length, 1);

      // A duplicate sense resolves to the surviving meaning, so a surface match on it still finds the meaning
      // (and a link to the raw sense opens it).
      const [oreuda] = getMeaningsRecordFor(database, '오르다');
      assert.deepEqual(oreuda.senses.map(({ id, sense_ids: ids }) => [id, ids]), [['m016_1', ['w016-s1', 'w016-s2']]]);
      const viaDuplicate = projectSearchResults([oreuda], [{ id: oreuda.id, match: { kind: 'generated-surface-form', senseIds: ['w016-s2'] } }]);
      assert.deepEqual(viaDuplicate[0].senses.map(({ id }) => id), ['m016_1']);

      // A single-meaning lemma has no more list.
      const [single] = search(database, '이동');
      assert.deepEqual([single.primarySenseIds, single.moreSenseIds], [['m002'], []]);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('meaning record: a duplicate sense whose survivor is in another record still resolves to that meaning', () => {
  // Canonical fixtures cannot hold two records of one lemma, so the cross-record `duplicate_of` the meaning
  // contract allows is exercised on a minimal hand-built database.
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec(`
      INSERT INTO records (id, record_type, role, lemma) VALUES ('w001', 'entry', 'start', '가'), ('w002', 'entry', 'start', '가');
      INSERT INTO meanings (id, lemma, gloss, pos, record_id, lexical_relation_count, exploratory_relation_count, display_rank)
        VALUES ('m001', '가', '첫째 뜻풀이.', 'noun', 'w001', 0, 0, 1);
      INSERT INTO meaning_members (meaning_id, position, sense_id, record_id) VALUES ('m001', 0, 'w001-s1', 'w001');
      INSERT INTO sense_adjudications (sense_id, reason, record_id, duplicate_of_sense_id) VALUES ('w002-s1', 'duplicate', 'w002', 'w001-s1');
    `);
    const record = getMeaningRecord(database, 'w002');
    assert.deepEqual(record.senses.map(({ id, sense_ids: ids }) => [id, ids]), [['m001', ['w001-s1', 'w002-s1']]]);
    const [projected] = projectSearchResults([record], [{ id: 'w002', match: { kind: 'generated-surface-form', senseIds: ['w002-s1'] } }]);
    assert.deepEqual(projected.senses.map(({ id }) => id), ['m001']);
  } finally {
    database.close();
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import { projectSearchResults } from '../src/domain/projection.js';
import { expandExactSearchCandidates } from '../src/domain/exact-search-candidates.js';
import { findRecordsBySearchTerm, getMeaningRecord } from '../src/runtime/sqlite-query.js';

const wid = (n) => `w${String(n).padStart(3, '0')}`;
const rel = (n, type) => ({ target: wid(n), target_sense: `${wid(n)}-s1`, type, note: '근거' });
const record = (n, lemma, glosses) => ({
  id: wid(n), record_type: 'entry', role: 'start', candidate_id: wid(n), lemma, search_forms: [lemma], source: 'stdict',
  senses: glosses.map(([gloss, relations = []], index) => ({
    id: `${wid(n)}-s${index + 1}`, pos: 'verb', gloss, ...(relations.length > 0 ? { relations } : {}),
  })),
});

// Candidates are records: `가다` has four homonym records (w010 polysemous, w011, w014, w015); the default list shows the
// related ones (at most 3) and the rest wait behind 더보기; `나무` is one record with two senses (one candidate, two definitions).
const RECORDS = [
  record(2, '이동', [['위치를 옮김.']]),
  record(3, '떠남', [['있던 곳을 벗어남.']]),
  record(4, '쓸쓸함', [['외롭고 적적한 느낌.']]),
  record(10, '가다', [
    ['어떤 장소로 이동하다.', [rel(2, 'direct')]],
    ['어떤 상태나 시간이 지나가다.', [rel(3, 'near'), rel(4, 'mood')]],
    ['목적지에 도착하러 떠나다.', [rel(2, 'direct'), rel(3, 'antonym'), rel(2, 'near')]],
  ]),
  record(11, '가다', [['기계나 물건이 제대로 작동하다.', [rel(3, 'mood')]]]),
  record(14, '가다', [['값이나 무게 따위가 나가다.']]),
  record(15, '가다', [['금이나 줄이 생기다.']]),
  record(12, '나무', [['줄기가 단단한 여러해살이 식물.'], ['집을 짓거나 가구를 만드는 재료.']]),
];

async function buildFixture(directory) {
  const canonicalDirectory = path.join(directory, 'canonical');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${RECORDS.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const outputPath = path.join(directory, 'dictionary.sqlite');
  await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true, recordMeanings: true });
  return outputPath;
}

function search(database, term) {
  const response = findRecordsBySearchTerm(database, term);
  const records = response.matches.map(({ id }) => getMeaningRecord(database, id));
  return projectSearchResults(records, response.matches);
}

test('meaning search: candidates are records, ranked by stored counts, at most 3 by default', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-meaning-search-'));
  try {
    const database = new DatabaseSync(await buildFixture(directory), { readOnly: true });
    try {
      const stored = database.prepare(
        'SELECT id, lexical_relation_count AS l, exploratory_relation_count AS e FROM meanings WHERE lemma = ? ORDER BY display_rank',
      ).all('가다').map((row) => ({ ...row }));
      // 유의어+반의어 DESC, then 말의 결+연상 DESC, then ID; distinct targets per group (m010: lexical w002, w003; exploratory w002, w003, w004).
      assert.deepEqual(stored, [
        { id: 'm010', l: 2, e: 3 },
        { id: 'm011', l: 0, e: 1 },
        { id: 'm014', l: 0, e: 0 },
        { id: 'm015', l: 0, e: 0 },
      ]);

      // One result for the lemma whose candidates are its records, each holding all of its definitions.
      const [result, ...rest] = search(database, '가다');
      assert.equal(rest.length, 0);
      assert.deepEqual(result.senses.map(({ id }) => id), stored.map(({ id }) => id));
      assert.deepEqual(result.primarySenseIds, ['m010', 'm011']);
      assert.deepEqual(result.moreSenseIds, ['m014', 'm015']);
      const candidates = expandExactSearchCandidates([result]);
      assert.deepEqual(candidates.filter(({ isMore }) => !isMore).map(({ senseId }) => senseId), result.primarySenseIds);
      assert.equal(candidates.length, 4);

      // Relation targets open the target record's meaning, not a raw sense.
      const top = result.senses[0];
      assert.deepEqual(top.relations.map(({ targetId, targetSenseId }) => [targetId, targetSenseId]).sort(), [
        ['w002', 'm002'], ['w002', 'm002'], ['w003', 'm003'], ['w003', 'm003'], ['w004', 'm004'],
      ]);

      // A polysemous record is one candidate: both senses are definitions of it, nothing waits behind 더보기.
      const [plain] = search(database, '나무');
      assert.deepEqual([plain.primarySenseIds, plain.moreSenseIds], [['m012'], []]);
      const [namu] = getMeaningsRecordFor(database, '나무');
      assert.deepEqual(namu.senses.map(({ id, sense_ids: ids }) => [id, ids]), [['m012', ['w012-s1', 'w012-s2']]]);

      // A single-record lemma has no more list.
      const [single] = search(database, '이동');
      assert.deepEqual([single.primarySenseIds, single.moreSenseIds], [['m002'], []]);

      const runtime = {
        search: async (term) => findRecordsBySearchTerm(database, term),
        getRecord: async () => { throw new Error('raw record not expected'); },
        getMeaningRecord: async (id) => getMeaningRecord(database, id),
      };
      const kept = await new SearchSession({ runtime }).searchExact('가다');
      assert.equal(kept.status, 'ready');
      assert.equal(kept.results.length, 1);
      const missing = await new SearchSession({ runtime }).searchExact('없는말');
      assert.equal(missing.status, 'empty');
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function getMeaningsRecordFor(database, term) {
  return findRecordsBySearchTerm(database, term).matches.map(({ id }) => getMeaningRecord(database, id));
}

test('meaning record: a duplicate sense whose survivor is in another record still resolves to that meaning', () => {
  // Canonical fixtures cannot hold two records of one lemma, so the cross-record `duplicate_of` the meaning
  // contract allows is exercised on a minimal hand-built database.
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec(`
      INSERT INTO records (id, record_type, role, lemma) VALUES ('w001', 'entry', 'start', '가'), ('w002', 'entry', 'start', '가');
      INSERT INTO meanings (id, lemma, gloss, record_id, lexical_relation_count, exploratory_relation_count, display_rank)
        VALUES ('m001', '가', '첫째 뜻풀이.', 'w001', 0, 0, 1);
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

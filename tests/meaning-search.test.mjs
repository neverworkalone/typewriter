import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { writeAdjudications, writeMeanings } from '../scripts/meaning/contract.mjs';
import { projectSearchResults } from '../src/domain/projection.js';
import { expandExactSearchCandidates } from '../src/domain/exact-search-candidates.js';
import { findRecordsBySearchTerm, getMeaningRecord } from '../src/runtime/sqlite-query.js';

const wid = (n) => `w${String(n).padStart(3, '0')}`;
const rel = (n, type) => ({ target: wid(n), target_sense: `${wid(n)}-s1`, type, note: '근거' });
const GLOSSES = {
  이동0: '위치를 옮김.', 떠남0: '있던 곳을 벗어남.', 쓸쓸함0: '외롭고 적적한 느낌.',
  가다0: '어떤 장소로 이동하다.', 가다1: '어떤 상태나 시간이 지나가다.', 가다2: '목적지에 도착하러 떠나다.',
  가다3: '기계나 물건이 제대로 작동하다.', 가다4: '값이나 무게 따위가 나가다.',
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
];
const MEANINGS = RECORDS.flatMap((item) => item.senses.map((sense, index) => ({
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

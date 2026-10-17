import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { MEANING_GLOSS_SEPARATOR, projectRecordMeanings, splitMeaningGloss } from '../scripts/meaning/canonical-record.mjs';
import { projectSearchResults } from '../src/domain/projection.js';
import { expandExactSearchCandidates } from '../src/domain/exact-search-candidates.js';
import { findRecordsBySearchTerm, getMeaningRecord } from '../src/runtime/sqlite-query.js';

// Issue #820: Canonical-only DB. One STDICT record = one search candidate (meaning) holding all of its senses.

const sense = (recordId, index, gloss, relations = []) => ({
  id: `${recordId}-s${index}`, pos: 'adverb', gloss, ...(relations.length > 0 ? { relations } : {}),
});
const entry = (id, lemma, senses, homographNo) => ({
  id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
  ...(homographNo === undefined ? {} : { homograph_no: homographNo }), senses, source: 'stdict',
});

// 가랑가랑 shape: three independent records with 4 / 2 / 1 senses; 배: two records; 눈: one record with a self relation.
const FIXTURE = [
  entry('w1582', '가랑가랑', [sense('w1582', 1, '가르랑의 준말.'), sense('w1582', 2, '숨이 가늘게 남은 소리.')], 2),
  entry('w384774', '가랑가랑', [
    sense('w384774', 1, '액체가 가득한 모양.'), sense('w384774', 2, '눈물이 고인 모양.'),
    sense('w384774', 3, '국물이 많은 모양.'), sense('w384774', 4, '배 속이 찬 느낌.'),
  ], 3),
  entry('w385040', '가랑가랑', [sense('w385040', 1, '쇠붙이가 끌리는 소리.')], 1),
  // 배: STDICT order (homograph_no) differs from the ID order; one record carries no number and sorts last.
  entry('w100', '배', [sense('w100', 1, '배나무의 열매.')], 2),
  entry('w101', '배', [sense('w101', 1, '물에 떠다니는 탈것.'), sense('w101', 2, '몸의 한 부분.')], 1),
  entry('w102', '배', [sense('w102', 1, '곱절로 늘린 수.')], 4),
  entry('w103', '배', [sense('w103', 1, '같은 조상에서 나뉜 줄기.')], 3),
  entry('w104', '배', [sense('w104', 1, '무리나 떼를 뜻하는 말.')]),
  entry('w200', '글썽글썽', [
    sense('w200', 1, '눈물이 고인 모양.', [
      { target: 'w384774', target_sense: 'w384774-s2', type: 'direct', note: '근거' },
    ]),
    sense('w200', 2, '눈에 물기가 어림.', [
      { target: 'w384774', target_sense: 'w384774-s1', type: 'direct', note: '같은 대상, 다른 sense' },
      { target: 'w385040', target_sense: 'w385040-s1', type: 'near', note: '다른 대상' },
    ]),
  ]),
];

async function buildFixture(directory) {
  const canonicalDirectory = path.join(directory, 'canonical');
  await mkdir(canonicalDirectory);
  await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${FIXTURE.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const outputPath = path.join(directory, 'dictionary.sqlite');
  // No meanings/adjudication directory exists anywhere: the layer must come from canonical alone.
  await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true, recordMeanings: true });
  return outputPath;
}

function search(database, term) {
  const response = findRecordsBySearchTerm(database, term);
  const records = response.matches.map(({ id }) => getMeaningRecord(database, id));
  return projectSearchResults(records, response.matches);
}

test('projectRecordMeanings: table over valid and invalid record shapes', () => {
  const cases = [
    { name: 'single sense', record: entry('w7', 'ㄱ', [sense('w7', 1, '가.')]), id: 'm7', gloss: '가.', senseIds: ['w7-s1'] },
    { name: 'several senses stay one meaning', record: entry('w0097', 'a', [sense('w0097', 1, '가.'), sense('w0097', 2, '나.'), sense('w0097', 3, '다.')]), id: 'm0097', gloss: '가.\n나.\n다.', senseIds: ['w0097-s1', 'w0097-s2', 'w0097-s3'] },
    { name: 'non-contiguous sense numbers keep canonical order', record: entry('w9', 'a', [sense('w9', 3, '셋.'), sense('w9', 1, '하나.')]), id: 'm9', gloss: '셋.\n하나.', senseIds: ['w9-s3', 'w9-s1'] },
  ];
  for (const { name, record, id, gloss, senseIds } of cases) {
    const [meaning, ...rest] = projectRecordMeanings([record]);
    assert.equal(rest.length, 0, name);
    assert.deepEqual(meaning, { id, lemma: record.lemma, gloss, sense_ids: senseIds }, name);
    assert.deepEqual(splitMeaningGloss(meaning.gloss), record.senses.map((item) => item.gloss), name);
  }
  assert.deepEqual(projectRecordMeanings([entry('w1', 'a', [])]), [], 'a record without senses has no meaning');
  for (const gloss of ['', `줄${MEANING_GLOSS_SEPARATOR}바꿈`]) {
    assert.throws(() => projectRecordMeanings([entry('w1', 'a', [sense('w1', 1, gloss)])]), /single-line/u, JSON.stringify(gloss));
  }
  assert.throws(() => projectRecordMeanings([entry('r1', 'a', [sense('r1', 1, '가.')])]), /canonical entry id/u);
});

test('whole canonical corpus: every sense belongs to exactly one record meaning, in source order', async () => {
  const directory = path.resolve('data/canonical');
  const records = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(path.join(directory, file), 'utf8')).split('\n')) if (line) records.push(JSON.parse(line));
  }
  const meanings = projectRecordMeanings(records);
  const withSenses = records.filter((item) => item.senses.length > 0);
  assert.equal(meanings.length, withSenses.length, 'one candidate per record');
  assert.equal(new Set(meanings.map(({ id }) => id)).size, meanings.length, 'ids are unique');
  const owner = new Map();
  const byRecord = new Map(withSenses.map((item) => [item.id, item]));
  let violations = 0;
  meanings.forEach((meaning, index) => {
    const source = withSenses[index];
    if (meaning.id !== `m${source.id.slice(1)}` || meaning.lemma !== source.lemma) violations += 1;
    if (meaning.sense_ids.join() !== source.senses.map(({ id }) => id).join()) violations += 1;
    if (meaning.gloss !== source.senses.map(({ gloss }) => gloss).join(MEANING_GLOSS_SEPARATOR)) violations += 1;
    for (const senseId of meaning.sense_ids) {
      if (owner.has(senseId) || byRecord.get(`w${meaning.id.slice(1)}`) !== source) violations += 1;
      owner.set(senseId, meaning.id);
    }
  });
  assert.equal(violations, 0, 'no omitted, duplicated, merged-across-record or split sense');
  assert.equal(owner.size, withSenses.reduce((count, item) => count + item.senses.length, 0));
  // Homonym candidates of a lemma equal its record count, never its sense count.
  const recordsByLemma = Map.groupBy(withSenses, ({ lemma }) => lemma);
  const meaningsByLemma = Map.groupBy(meanings, ({ lemma }) => lemma);
  for (const [lemma, group] of recordsByLemma) assert.equal(meaningsByLemma.get(lemma).length, group.length, lemma);
  // The issue's example, when present in the corpus: 3 candidates carrying 4 / 2 / 1 definitions.
  const gara = meaningsByLemma.get('가랑가랑');
  if (gara) assert.deepEqual(gara.map(({ gloss }) => splitMeaningGloss(gloss).length).sort(), [1, 2, 4]);
});

test('canonical-only build: candidates per record, all definitions inside one item, relations projected per record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-record-meanings-'));
  try {
    const database = new DatabaseSync(await buildFixture(directory), { readOnly: true });
    try {
      const [gara, ...rest] = search(database, '가랑가랑');
      assert.equal(rest.length, 0);
      // STDICT homograph order (m385040 = 01, m1582 = 02, m384774 = 03), not ID order and not definition count.
      assert.deepEqual(gara.senses.map(({ id }) => id), ['m385040', 'm1582', 'm384774']);
      const definitions = Object.fromEntries(gara.senses.map((item) => [item.id, item.groups[0].items.map(({ text }) => text)]));
      assert.deepEqual(definitions.m384774, ['액체가 가득한 모양.', '눈물이 고인 모양.', '국물이 많은 모양.', '배 속이 찬 느낌.']);
      assert.equal(definitions.m1582.length, 2);
      assert.equal(definitions.m385040.length, 1);
      // Candidate picker: one entry per record (never per sense); all three fit the default view.
      const candidates = expandExactSearchCandidates([gara]);
      assert.equal(candidates.length, 3);
      // All three records fit the default view (first three candidates, no relation involved).
      assert.deepEqual([gara.primarySenseIds, gara.moreSenseIds], [['m385040', 'm1582', 'm384774'], []]);

      // 배: five separate candidates in STDICT order (unnumbered last); the multi-sense record is still one candidate.
      // Three are shown first; the other two are all reachable behind 더보기.
      const [bae] = search(database, '배');
      assert.deepEqual(bae.senses.map(({ id }) => id), ['m101', 'm100', 'm103', 'm102', 'm104']);
      assert.deepEqual([bae.primarySenseIds, bae.moreSenseIds], [['m101', 'm100', 'm103'], ['m102', 'm104']]);
      assert.equal(database.prepare("SELECT homograph_no AS n FROM meanings WHERE id = 'm104'").get().n, null);

      // Relations: both senses of w200 point at w384774 -> one deduplicated meaning relation with both contributors;
      // canonical forbids a record linking to itself, so no self relation arises; targets open the exact record meaning.
      const [source] = search(database, '글썽글썽');
      assert.deepEqual(source.senses[0].relations.map(({ targetId, targetSenseId, canonicalType }) => [targetId, targetSenseId, canonicalType]).sort(), [
        ['w384774', 'm384774', 'direct'], ['w385040', 'm385040', 'near'],
      ]);
      const provenance = database.prepare(
        'SELECT source_sense_id FROM meaning_relation_sources WHERE source_meaning_id = ? ORDER BY relation_position, position',
      ).all('m200').map((row) => row.source_sense_id);
      assert.deepEqual(provenance, ['w200-s1', 'w200-s2', 'w200-s2']);
      assert.equal(Number(database.prepare("SELECT value FROM metadata WHERE key = 'meaning_projection_skipped_self_count'").get().value), 0);
      assert.equal(Number(database.prepare("SELECT value FROM metadata WHERE key = 'meaning_projection_deduplicated_count'").get().value), 1);
      assert.equal(Number(database.prepare('SELECT COUNT(*) AS c FROM sense_adjudications').get().c), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  actualRelationProvenance,
  expectedRelationProvenance,
  parseMeaningId,
  projectMeaningRelations,
  projectRecordMeanings,
  recordMeaningId,
} from '../scripts/build/record-meanings.mjs';
import { homographLemmaIndex, productGloss } from '../scripts/build/gloss-homograph-reference.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { RECORD_MEANING_COVERAGE_QUERIES } from '../scripts/build/meaning-source-checks.mjs';

const rel = (target_sense, type = 'direct', note = 'n') => ({ target: target_sense.split('-')[0], target_sense, type, note });
const rec = (id, lemma, senses) => ({
  id,
  lemma,
  senses: senses.map(([sid, relations = [], gloss]) => ({ id: sid, gloss: gloss === undefined ? `${sid} 뜻풀이` : gloss, relations })),
});

test('record meaning ids: valid record ids map to m-ids, anything else is rejected', () => {
  assert.equal(recordMeaningId('w0097'), 'm0097');
  assert.deepEqual(parseMeaningId('m0097'), { entryId: 'w0097' });
  for (const bad of ['m0097', 'r001', 'w', 'w12a', '']) assert.throws(() => recordMeaningId(bad), TypeError, bad);
  // Legacy split ids (`m0097_2`) no longer exist in the canonical-only product.
  for (const bad of ['m0097_2', 'w0097', 'm', '']) assert.equal(parseMeaningId(bad), null, bad);
});

test('projection table: one record = one meaning holding all senses in order; valid-but-unusual shapes pass', () => {
  const cases = [
    ['single sense', [rec('w1', 'a', [['w1-s1']])], [['m1', ['w1-s1']]]],
    ['polysemy keeps every sense in one meaning', [rec('w2', 'a', [['w2-s1'], ['w2-s2'], ['w2-s3']])], [['m2', ['w2-s1', 'w2-s2', 'w2-s3']]]],
    ['homonym records of one lemma stay separate', [rec('w3', 'a', [['w3-s1']]), rec('w4', 'a', [['w4-s1'], ['w4-s2']])], [['m3', ['w3-s1']], ['m4', ['w4-s1', 'w4-s2']]]],
    ['non-contiguous ids', [rec('w9', 'b', [['w9-s1']]), rec('w100', 'b', [['w100-s1']])], [['m9', ['w9-s1']], ['m100', ['w100-s1']]]],
    ['record without senses has no meaning', [rec('w5', 'c', [])], []],
  ];
  for (const [name, records, expected] of cases) {
    const meanings = projectRecordMeanings(records);
    assert.deepEqual(meanings.map((m) => [m.id, m.sense_ids]), expected, name);
    for (const meaning of meanings) {
      const record = records.find((item) => recordMeaningId(item.id) === meaning.id);
      assert.equal(meaning.gloss, record.senses.map((sense) => sense.gloss).join('\n'), `${name}: gloss order`);
    }
  }
});

test('projection fail-closed controls: empty, multi-line or missing source gloss is rejected', () => {
  for (const gloss of ['', 'a\nb', null, 7]) {
    assert.throws(() => projectRecordMeanings([rec('w1', 'a', [['w1-s1', [], gloss]])]), /single-line/u, String(gloss));
  }
});

test('relation projection: dedup, provenance, self and unresolved skips, and the independent oracle agrees', () => {
  const records = [
    rec('w1', 'a', [['w1-s1', [rel('w2-s1'), rel('w2-s2'), rel('w2-s1', 'antonym'), rel('w1-s2'), rel('w9-s1')]], ['w1-s2', [rel('w3-s1', 'near')]]]),
    rec('w2', 'b', [['w2-s1'], ['w2-s2']]),
    rec('w3', 'c', [['w3-s1', [rel('w1-s1')]]]),
  ];
  const meanings = projectRecordMeanings(records);
  const { relations, stats } = projectMeaningRelations({ records, meanings });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.type, r.position]), [
    ['m1', 'm2', 'direct', 0],
    ['m1', 'm2', 'antonym', 1],
    ['m1', 'm3', 'near', 2],
    ['m3', 'm1', 'direct', 0],
  ]);
  assert.deepEqual(relations[0].sources.map((s) => [s.source_sense_id, s.source_position]), [['w1-s1', 0], ['w1-s1', 1]]);
  assert.deepEqual(stats, {
    source_relation_count: 7, projected_relation_count: 4, redirected_relation_count: 0,
    skipped_out_of_scope_count: 0, skipped_unresolved_count: 1, skipped_self_count: 1, deduplicated_count: 1,
  });
  assert.deepEqual(actualRelationProvenance(relations), expectedRelationProvenance(records, meanings));
  // A wrong attribution is detected by the oracle (fail control).
  const tampered = relations.map((r) => ({ ...r, sources: r.sources.slice(1) }));
  assert.notDeepEqual(actualRelationProvenance(tampered), expectedRelationProvenance(records, meanings));
});

test('removed legacy build options are rejected, never silently ignored', async () => {
  for (const option of ['meaningsDirectory', 'adjudicationDirectory']) {
    await assert.rejects(
      buildDictionary({ outputPath: '/nonexistent/never-built.sqlite', [option]: 'data/meanings' }),
      (error) => error.code === 'REMOVED_OPTION',
      option,
    );
  }
});

test('recordMeanings option table: only undefined|boolean; official canonical input rejects every disabling value', async () => {
  const output = path.join(tmpdir(), 'typewriter-never-built.sqlite');
  for (const value of [false, 0, null, '', 'false', NaN]) {
    await assert.rejects(
      buildDictionary({ outputPath: output, recordMeanings: value }),
      (error) => ['RECORD_MEANINGS_REQUIRED', 'INVALID_OPTION'].includes(error.code),
      String(value),
    );
  }
  for (const value of [1, 'true', {}, []]) {
    await assert.rejects(buildDictionary({ outputPath: output, recordMeanings: value }), (error) => error.code === 'INVALID_OPTION', String(value));
  }
});

const entry = (id, lemma, glosses) => ({
  id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma], source: 'stdict',
  senses: glosses.map((gloss, index) => ({ id: `${id}-s${index + 1}`, pos: 'noun', gloss })),
});

function coverageViolations(database) {
  return Object.fromEntries(Object.entries(RECORD_MEANING_COVERAGE_QUERIES)
    .map(([name, sql]) => [name, Number(Object.values(database.prepare(sql).get())[0])])
    .filter(([, count]) => count !== 0));
}

test('record meaning coverage queries: complete layer passes; empty, partial and mis-attributed layers fail', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-coverage-'));
  try {
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory);
    const records = [entry('w001', '가', ['하나.', '둘.']), entry('w002', '가', ['셋.']), entry('w003', '나', ['넷.'])];
    await writeFile(path.join(canonicalDirectory, 'part.jsonl'), `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
    const mutations = [
      ['valid layer', () => {}, {}],
      ['empty layer', (db) => db.exec('DELETE FROM meaning_relation_sources; DELETE FROM meaning_relations; DELETE FROM meaning_members; DELETE FROM meanings;'),
        { sense_without_exactly_one_own_record_member: 4, record_with_senses_without_meaning: 3 }],
      ['one sense missing from its meaning', (db) => db.exec("DELETE FROM meaning_members WHERE sense_id = 'w001-s2'"),
        { sense_without_exactly_one_own_record_member: 1 }],
      ['sense attributed to another record meaning', (db) => db.exec("UPDATE meaning_members SET meaning_id = 'm002', record_id = 'w002' WHERE sense_id = 'w001-s2'"),
        { sense_without_exactly_one_own_record_member: 1, meaning_not_of_one_record: 0 }],
      ['record without meaning', (db) => db.exec("DELETE FROM meaning_members WHERE meaning_id = 'm003'; DELETE FROM meanings WHERE id = 'm003'"),
        { sense_without_exactly_one_own_record_member: 1, record_with_senses_without_meaning: 1 }],
    ];
    for (const [name, mutate, expected] of mutations) {
      const outputPath = path.join(directory, `${name.replaceAll(' ', '-')}.sqlite`);
      await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true, recordMeanings: true });
      const database = new DatabaseSync(outputPath);
      try {
        database.exec('PRAGMA foreign_keys = OFF');
        mutate(database);
        const actual = coverageViolations(database);
        if (Object.keys(expected).length === 0) assert.deepEqual(actual, {}, name);
        else for (const key of Object.keys(expected)) assert.ok(actual[key] > 0 || expected[key] === 0, `${name}: ${key} ${JSON.stringify(actual)}`);
        if (Object.keys(expected).length > 0) assert.notDeepEqual(actual, {}, name);
      } finally {
        database.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const lemmas = homographLemmaIndex([
  ['슬슬', 2], ['이', 1], ['본가', 1], ['주다', 1], ['깨다', 1], ['까치발', 2], ['감잡이', 2], ['들', 8], ['지구', 8], ['리넨', 1], ['단독', null],
].map(([lemma, homograph_no]) => ({ lemma, homograph_no })));
const counters = () => ({ stripped: 0, unconfirmed: 0 });

test('homograph reference numbers are removed from references only (Issue #797)', () => {
  const cases = [
    ['quoted reference', '모양. ‘슬슬02’보다 센 느낌을 준다.', '모양. ‘슬슬’보다 센 느낌을 준다.'],
    ['quoted single-syllable headword', '‘이01’를 이르는 말.', '‘이’를 이르는 말.'],
    ['sense number kept', '‘본가01「3」’의 높임.', '‘본가「3」’의 높임.'],
    ['roman and bracket groups kept', '‘주다01[Ⅰ]「1」’의 / ‘깨다01[1]’의', '‘주다[Ⅰ]「1」’의 / ‘깨다[1]’의'],
    ['hanja suffix kept', '‘리넨01(linen)’을', '‘리넨(linen)’을'],
    ['affix headword', '명사에 ‘-들08’이 붙어', '명사에 ‘-들’이 붙어'],
    ['several quoted references', '‘슬슬02’과 ‘이01’', '‘슬슬’과 ‘이’'],
    ['arrow reference', '→ 까치발02.', '→ 까치발.'],
    ['arrow reference with sense number', '→ 감잡이02「2」.', '→ 감잡이「2」.'],
    ['arrow reference with group and hanja', '→ 지구08(地球).', '→ 지구(地球).'],
    // valid-but-unusual / fail-closed controls: nothing here is a reference
    ['year and unit numbers stay', '숙종34년(1708)에 영하102℃, 8분의12 박자', '숙종34년(1708)에 영하102℃, 8분의12 박자'],
    ['ordinals stay', '제10대 왕, 제427조', '제10대 왕, 제427조'],
    ['quoted non-headword stays', '‘제10대’를 이르는 말.', '‘제10대’를 이르는 말.'],
    ['unquoted numbered word stays', '입원01과 퇴원01을 아울러', '입원01과 퇴원01을 아울러'],
    ['latin and digit mixes stay', '‘M16’ 소총 (M16)', '‘M16’ 소총 (M16)'],
    ['three-digit stays', '‘슬슬102’', '‘슬슬102’'],
    ['arrow not at gloss start stays', '뜻. → 까치발02.', '뜻. → 까치발02.'],
    ['unknown headword stays', '‘없는말02’을', '‘없는말02’을'],
    ['known lemma, unknown number stays', '‘슬슬99’과 ‘슬슬00’과 ‘슬슬01’', '‘슬슬99’과 ‘슬슬00’과 ‘슬슬01’'],
    ['lemma without homograph evidence stays', '‘단독01’을', '‘단독01’을'],
    ['number followed by other text stays', '‘슬슬02형’과 ‘슬슬02 형’', '‘슬슬02형’과 ‘슬슬02 형’'],
    ['arrow with unknown number or suffix stays', '→ 까치발99.', '→ 까치발99.'],
    ['arrow number followed by text stays', '→ 까치발02형.', '→ 까치발02형.'],
    ['mixed: only the confirmed number goes', '‘슬슬02’ ‘슬슬03’', '‘슬슬’ ‘슬슬03’'],
    ['arrow without number', '→ 할머니_.', '→ 할머니_.'],
  ];
  for (const [name, source, expected] of cases) assert.equal(productGloss(source, lemmas), expected, name);
});

test('counters report stripped and unconfirmed references', () => {
  const c = counters();
  productGloss('‘슬슬02’ ‘슬슬99’ ‘없는말02’', lemmas, c);
  assert.deepEqual(c, { stripped: 1, unconfirmed: 2 });
});

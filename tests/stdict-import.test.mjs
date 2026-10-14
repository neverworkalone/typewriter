import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { findRecordsBySearchTerm, getRecord, getSenseRelations } from '../scripts/build/query.mjs';
import {
  addToSenseIndex,
  cleanDefinition,
  convertItem,
  createSenseIndex,
  finalizeSenseIndex,
  flattenSenses,
  inventoryStdictSource,
  readStdictItems,
  mapPos,
  recordIdFor,
  STDICT_NOTES,
  serializeRecord,
  surfaceForms,
} from '../scripts/stdict/convert.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import { assignShards, buildShards, loadStdictSource, provenanceManifest } from '../scripts/stdict/build-shard.mjs';
import { classifySense } from '../scripts/stdict/policy.mjs';
import { readCanonicalRecords, validateCanonicalRecord } from '../scripts/validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../scripts/validate/dataset-integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARD = path.join(ROOT, 'data/canonical/stdict-0001.jsonl');
const PROVENANCE = path.join(ROOT, 'data/provenance/stdict-0001.json');
const SOURCE = path.join(process.env.HOME ?? '', '.cache/typewriter/dict/stdict');

function item(targetCode, word, unit, senses, pos = '명사') {
  return {
    target_code: targetCode,
    word_info: {
      word,
      word_unit: unit,
      pos_info: [{
        pos,
        comm_pattern_info: [{
          sense_info: senses.map(([senseCode, definition, links = []]) => ({
            sense_code: senseCode,
            definition,
            lexical_info: links.map(([type, target]) => ({ unit: '의미', type, link_target_code: String(target) })),
          })),
        }],
      }],
    },
  };
}

// Source sense codes deliberately overlap other entries' target codes: a link
// must bind by sense_code, never by target_code.
const FIXTURE = [
  item(100, '각본01', '단어', [[900, '연극의 바탕이 되는 글.', [['동의어', 901], ['반대말', 902], ['비슷한말', 901]]]]),
  item(101, '각본02', '단어', [[901, '일의 순서를 정한 계획.']]),
  item(102, '불필요', '단어', [[902, '필요하지 아니함.', [['반대말', 900], ['동의어', 903], ['동의어', 99999], ['동의어', 102], ['동의어', 902]]]], '명사'),
  item(103, '각설이^타령', '구', [[903, '각설이가 부르는 노래.']], '구'),
  item(104, '-간16', '단어', [[904, '‘동안’의 뜻을 더하는 접미사.']], '접사'),
  item(105, '별-천지', '단어', [[905, '특별히 좋은 세상.']]),
  item(106, '이', '단어', [[906, '뜻이 아직 분류되지 않은 낱말.']], '품사 없음'),
];

function fixtureContext(selected) {
  const index = createSenseIndex();
  for (const source of FIXTURE) addToSenseIndex(index, source);
  return { index, isSelected: (code) => selected.has(code) };
}

test('surface forms strip homograph numbers and boundary markers consistently', () => {
  assert.deepEqual(surfaceForms('각본01', '단어'), { lemma: '각본', search_forms: ['각본'] });
  assert.deepEqual(surfaceForms('별-천지', '단어'), { lemma: '별천지', search_forms: ['별천지'] });
  assert.deepEqual(surfaceForms('시민^단체', '단어'), { lemma: '시민단체', search_forms: ['시민단체', '시민 단체'] });
  assert.deepEqual(surfaceForms('각설이^타령', '구'), { lemma: '각설이 타령', search_forms: ['각설이 타령', '각설이타령'] });
  assert.deepEqual(surfaceForms('-간16', '단어'), { lemma: '-간', search_forms: ['-간', '간'] });
  assert.deepEqual(surfaceForms('간(에) 바람 들다', '관용구').lemma, '간(에) 바람 들다');
});

test('definitions are cleaned of embedded markup without hiding what was removed', () => {
  assert.deepEqual(cleanDefinition('‘<sense_no>3837</sense_no>거리’ 또는 ‘<each_sense_no>22875,54856</each_sense_no>지역’의 뜻.'), {
    text: '‘거리’ 또는 ‘지역’의 뜻.', markup: ['sense_no', 'each_sense_no'], unknownMarkup: false,
  });
  assert.equal(cleanDefinition("비타민 B<sub style='font-size:11px;'>12</sub>와 10<sup style='font-size:11px;'>36</sup>").text, '비타민 B₁₂와 10³⁶');
  assert.equal(cleanDefinition('<I>ab=ac</I>는 <I>a</I>가 0이 아닐 경우').text, 'ab=ac는 a가 0이 아닐 경우');
  assert.equal(cleanDefinition('상형은 ‘<equ>&#x2636;</equ>’으로').text, '상형은 ‘☶’으로');
  assert.equal(cleanDefinition('끝말  <img src=\'x.png\'>  이다.').text, '끝말 이다.');
  assert.equal(cleanDefinition('작품에 <거미의 향연>, <Y의 비극> 따위가 있다.').text, '작품에 <거미의 향연>, <Y의 비극> 따위가 있다.', 'angle-bracket titles are not markup');
  assert.equal(cleanDefinition('뜻<blink>풀이</blink>').unknownMarkup, true, 'an unknown tag is surfaced, never silently kept');
  const held = convertItem(item(900, '이상', '단어', [[1, '뜻<blink>풀이</blink>']]), fixtureContext(new Set([900])));
  assert.deepEqual(held.report.unknownMarkup, ['w900-s1']);
});

test('record ids satisfy the canonical id pattern for every target_code', () => {
  assert.equal(recordIdFor(4), 'w004');
  assert.equal(recordIdFor(99), 'w099');
  assert.equal(recordIdFor(445), 'w445');
  assert.equal(recordIdFor(536223), 'w536223');
  for (const code of [1, 99, 100, 536223]) {
    const { record } = convertItem(item(code, '단어', '단어', [[code * 10, '아무 뜻풀이.']]), fixtureContext(new Set([code])));
    validateCanonicalRecord(record);
  }
});

test('malformed source markup is cleaned from the text, a literal less-than is kept', () => {
  assert.equal(cleanDefinition("3×2<sup style='font-size:11px;'><I>n</sup></I>(<I>n</I>=0)<sub style='font-size:11px;'></sub>을").text, '3×2ⁿ(n=0)을');
  assert.equal(cleanDefinition('<I>‘(x－1)(x+1)<0’ </I>따위를 이른다.').text, '‘(x－1)(x+1)<0’ 따위를 이른다.');
  assert.equal(cleanDefinition('<I>‘(x－1)(x+1)<0’ </I>따위').unknownMarkup, false);
});

test('part-of-speech mapping never silently drops a class', () => {
  const mapped = Object.fromEntries(
    ['명사', '의존 명사', '대명사', '수사', '동사', '보조 동사', '형용사', '보조 형용사', '부사', '관형사', '감탄사', '조사', '어미', '접사', undefined]
      .map((pos) => [pos, mapPos(pos, '단어')]),
  );
  assert.equal(mapped['의존 명사'], 'noun');
  assert.equal(mapped['보조 동사'], 'verb');
  assert.equal(mapped['접사'], 'affix');
  assert.equal(mapped.undefined, 'unclassified');
  assert.equal(mapPos('품사 없음', '단어'), 'unclassified');
  assert.equal(mapPos('미지원품사', '단어'), null, 'an explicit POS the contract does not know is never reclassified');
  assert.equal(mapPos('명사', '미지원단위'), null, 'an unknown word unit is not guessed');
  for (const unit of ['구', '속담', '관용구']) assert.equal(mapPos('구', unit), 'expression');
});

test('official relations bind by sense_code and report every non-converted status', () => {
  const { record, report } = convertItem(FIXTURE[0], fixtureContext(new Set([100, 101, 102])));
  assert.equal(record.id, 'w100');
  assert.equal(record.candidate_id, 'w100');
  assert.equal(record.source, 'stdict');
  assert.deepEqual(record.senses[0].relations.map(({ target_sense, type }) => [target_sense, type]), [
    ['w101-s1', 'direct'],
    ['w102-s1', 'antonym'],
  ]);
  for (const relation of record.senses[0].relations) assert.equal(Object.hasOwn(relation, 'relevance'), false);
  assert.deepEqual(report.relations.map(({ source_type, status }) => `${source_type}:${status}`), [
    '동의어:converted', '반대말:converted',
  ]);

  const second = convertItem(FIXTURE[2], fixtureContext(new Set([102, 100])));
  assert.deepEqual(second.report.relations.map(({ status }) => status), [
    'converted', 'out-of-sample', 'broken', 'target-code-only', 'self',
  ]);
  assert.deepEqual(second.record.senses[0].relations.map(({ target_sense }) => target_sense), ['w100-s1']);
  assert.equal(convertItem(FIXTURE[1], fixtureContext(new Set([101]))).record.senses[0].relations, undefined);
});

test('converted fixture passes the schema, dataset gate, SQLite build and homograph/relation navigation', async () => {
  const selected = new Set(FIXTURE.map(({ target_code: code }) => code));
  const context = fixtureContext(selected);
  finalizeSenseIndex(context.index);
  const converted = FIXTURE.map((source) => convertItem(source, context).record);
  assert.equal(converted[4], null, 'an affix-only entry is not a record');
  const records = converted.filter(Boolean);
  for (const record of records) validateCanonicalRecord(record);
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-stdict-'));
  try {
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory);
    await writeFile(path.join(canonicalDirectory, 'stdict-0001.jsonl'), `${records.map(serializeRecord).join('\n')}\n`);
    const canonical = await readCanonicalRecords(canonicalDirectory, { useSharedContext: false });
    validateDatasetRecords(canonical.records, { lexicalQuality: { blocking_finding_count: 0 } });
    const outputPath = path.join(directory, 'dictionary.sqlite');
    const summary = await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true });
    assert.equal(summary.recordCount, FIXTURE.length - 1);
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const homographs = findRecordsBySearchTerm(database, '각본').matches.map(({ id }) => id).sort();
      assert.deepEqual(homographs, ['w100', 'w101']);
      assert.deepEqual(findRecordsBySearchTerm(database, '각설이 타령').matches.map(({ id }) => id), ['w103']);
      assert.deepEqual(findRecordsBySearchTerm(database, '간').matches, [], 'the affix meaning is not searchable');
      const record = getRecord(database, 'w100');
      const [direct] = record.senses[0].relations;
      assert.equal(direct.target, 'w101');
      assert.equal(direct.target_lemma, '각본');
      assert.equal(getRecord(database, direct.target).lemma, '각본');
      assert.equal(getRecord(database, 'w106').senses[0].pos, 'unclassified');
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('committed STDICT shard keeps its identity, policy and provenance contract', async () => {
  const text = await readFile(SHARD, 'utf8');
  const lines = text.split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 1000);
  const provenance = JSON.parse(await readFile(PROVENANCE, 'utf8'));
  assert.equal(provenance.contract, 'stdict-shard-provenance-v2');
  assert.equal(provenance.shard_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(provenance.record_count, 1000);
  assert.equal(provenance.held_count, 0);
  const records = lines.map((line) => JSON.parse(line));
  const ids = new Set(records.map(({ id }) => id));
  assert.equal(ids.size, 1000);
  assert.deepEqual(records.map(({ id }) => Number(id.slice(1))), records.map(({ id }) => Number(id.slice(1))).sort((a, b) => a - b));
  provenance.records.forEach((row, position) => {
    const record = records[position];
    assert.equal(record.id, `w${String(row.target_code).padStart(3, '0')}`);
    assert.equal(record.id, row.id);
    // Suffixes index the original sense_codes; a policy-excluded sense leaves a gap, never a renumbering.
    const suffixes = record.senses.map((sense) => Number(sense.id.slice(`${record.id}-s`.length)));
    assert.ok(suffixes.every((suffix, at) => suffix >= 1 && suffix <= row.sense_codes.length && (at === 0 || suffix > suffixes[at - 1])));
  });
  for (const record of records) {
    for (const sense of record.senses) {
      assert.ok(!['particle', 'ending', 'affix'].includes(sense.pos), `${sense.id} is a grammatical element`);
      for (const relation of sense.relations ?? []) {
        assert.ok(['direct', 'antonym'].includes(relation.type));
        assert.equal(Object.hasOwn(relation, 'relevance'), false);
        assert.ok(ids.has(relation.target), `${sense.id} targets an in-shard record`);
        assert.ok(relation.target_sense.startsWith(`${relation.target}-s`));
      }
    }
  }
});

test('shard and provenance regenerate byte-identically from the source download', { skip: await access(SOURCE).then(() => false, () => 'STDICT source download is not available') }, async () => {
  const source = await loadStdictSource({ sourceDirectory: SOURCE });
  const [first] = await buildShards({ source, through: 1 });
  assert.equal(first.shard, await readFile(SHARD, 'utf8'));
  assert.equal(`${JSON.stringify(provenanceManifest(first, { source }), null, 1)}\n`, await readFile(PROVENANCE, 'utf8'));
});

test('licensed-source records are exempt from authored editorial heuristics but not structure', async () => {
  const { auditCanonicalLexicalQuality } = await import('../scripts/validate/lexical-quality.mjs');
  const { reviewableRecordInfos } = await import('../scripts/validate/licensed-source.mjs');
  const homographs = [
    { id: 'w100', lemma: '각본', gloss: '준말.' },
    { id: 'w101', lemma: '각본', gloss: '글.' },
  ].map(({ id, lemma, gloss }) => ({
    id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss }],
  }));
  const infos = (records, marked) => records.map((record, index) => ({
    record: marked ? { ...record, source: 'stdict' } : record, filePath: '/data/canonical/x.jsonl', lineNumber: index + 1,
  }));
  const audit = (records, marked) => auditCanonicalLexicalQuality(infos(records, marked), { throwOnError: false });
  assert.equal(audit(homographs, true).blocking_finding_count, 0);
  assert.ok(audit(homographs, false).blocking_finding_count > 0, 'authored records keep every heuristic');
  const brokenPos = structuredClone(homographs);
  brokenPos[0].record_type = 'expression';
  assert.ok(audit(brokenPos, true).blocking_finding_count > 0, 'structure is still enforced');
  const authored = { ...homographs[0], id: 'w200', candidate_id: 'w200', senses: [{ id: 'w200-s1', pos: 'noun', gloss: '준말.' }] };
  const mixed = [...infos(homographs, true), ...infos([authored], false)];
  assert.deepEqual(reviewableRecordInfos(mixed).map(({ record }) => record.id), ['w200']);
  assert.deepEqual(reviewableRecordInfos(mixed.map(({ record }) => record)).map(({ id }) => id), ['w200'], 'plain records are classified the same way');
  const plain = infos(homographs, false);
  assert.equal(reviewableRecordInfos(plain), plain, 'identity is preserved when nothing is exempt');
});

test('an unsupported explicit POS is reported so the entry is held, never converted to unclassified', () => {
  const { report } = convertItem(item(910, '새말', '단어', [[1, '뜻풀이.']], '미지원품사'), fixtureContext(new Set([910])));
  assert.deepEqual(report.unsupportedPos, [{ sense: 'w910-s1', pos: '미지원품사', word_unit: '단어' }]);
  assert.deepEqual(convertItem(item(911, '새말', '단어', [[1, '뜻풀이.']], '품사 없음'), fixtureContext(new Set([911]))).report.unsupportedPos, []);
});

// A filtered shard keeps original source-order sense ids (`-s1`, `-s3`), never renumbered. #678 filters; this
// proves every consumer of the canonical sense id treats the suffix as an opaque id, not as a position.
test('sparse source-order sense ids survive schema, dataset gate, SQLite, search and relation navigation', async () => {
  const sparse = {
    id: 'w123', record_type: 'entry', role: 'start', candidate_id: 'w123', lemma: '먹다', search_forms: ['먹다'], source: 'stdict',
    senses: [
      { id: 'w123-s1', pos: 'noun', gloss: '첫째 뜻풀이.' },
      { id: 'w123-s3', pos: 'verb', gloss: '셋째 뜻풀이.', relations: [{ target: 'w124', target_sense: 'w124-s1', type: 'direct', note: STDICT_NOTES.direct }] },
    ],
  };
  const pointing = {
    id: 'w124', record_type: 'entry', role: 'start', candidate_id: 'w124', lemma: '새말', search_forms: ['새말'], source: 'stdict',
    senses: [{ id: 'w124-s1', pos: 'noun', gloss: '다른 뜻풀이.', relations: [
      { target: 'w123', target_sense: 'w123-s3', type: 'direct', note: STDICT_NOTES.direct },
      { target: 'w123', target_sense: 'w123-s1', type: 'antonym', note: STDICT_NOTES.antonym },
    ] }],
  };
  const records = [sparse, pointing];
  for (const record of records) validateCanonicalRecord(record);
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-sparse-'));
  try {
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory);
    const write = (list) => writeFile(path.join(canonicalDirectory, 'stdict-0001.jsonl'), `${list.map(serializeRecord).join('\n')}\n`);
    await write(records);
    const canonical = await readCanonicalRecords(canonicalDirectory, { useSharedContext: false });
    validateDatasetRecords(canonical.records, { lexicalQuality: { blocking_finding_count: 0 } });
    const outputPath = path.join(directory, 'dictionary.sqlite');
    await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const record = getRecord(database, 'w123');
      assert.deepEqual(record.senses.map(({ id, pos }) => [id, pos]), [['w123-s1', 'noun'], ['w123-s3', 'verb']], 'ids are kept, order is display order');
      assert.deepEqual(database.prepare('SELECT id, position FROM senses WHERE record_id = ? ORDER BY position').all('w123').map((row) => [row.id, row.position]), [['w123-s1', 0], ['w123-s3', 1]], 'display positions stay contiguous');
      assert.equal(database.prepare('SELECT 1 FROM senses WHERE id = ?').get('w123-s2'), undefined, 's2 is never created or rebound');
      const relations = getSenseRelations(database, 'w124-s1');
      assert.deepEqual(relations.map(({ type, target_sense: sense, target_pos: pos, target_gloss: gloss }) => [type, sense, pos, gloss]), [
        ['direct', 'w123-s3', 'verb', '셋째 뜻풀이.'],
        ['antonym', 'w123-s1', 'noun', '첫째 뜻풀이.'],
      ], 'a relation resolves to the sense with that id, not the sense at that position');
      assert.deepEqual(getSenseRelations(database, 'w123-s3').map(({ target_sense: sense }) => sense), ['w124-s1']);
      const generated = database.prepare('SELECT form, sense_id FROM generated_surface_forms WHERE record_id = ? ORDER BY form, sense_id').all('w123');
      assert.ok(generated.some(({ form }) => form === '먹는'), 'the verb sense generates forms');
      assert.ok(generated.every(({ sense_id: id }) => id === 'w123-s3'), 'generated forms bind to the surviving verb sense id');
      assert.ok(findRecordsBySearchTerm(database, '먹는').matches.some(({ id }) => id === 'w123'));
    } finally {
      database.close();
    }
    // A relation to a filtered-out sense is an orphan, not a silent rebinding to another sense.
    const orphan = structuredClone(pointing);
    orphan.senses[0].relations[0].target_sense = 'w123-s2';
    await write([sparse, orphan]);
    const reread = await readCanonicalRecords(canonicalDirectory, { useSharedContext: false });
    assert.throws(() => validateDatasetRecords(reread.records, { lexicalQuality: { blocking_finding_count: 0 } }), /w123-s2/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('official links and the sense_code crosswalk bind by original source position, not by surviving index', () => {
  const triple = item(123, '먹다', '단어', [[7001, '첫째.'], [7002, '둘째.'], [7003, '셋째.']]);
  const pointing = item(124, '새말', '단어', [[7100, '다른 뜻.', [['동의어', 7003], ['반대말', 7001]]]]);
  const index = createSenseIndex();
  for (const source of [triple, pointing]) addToSenseIndex(index, source);
  const context = { index, isSelected: () => true };
  const { record } = convertItem(pointing, context);
  assert.deepEqual(record.senses[0].relations.map(({ target_sense: sense }) => sense), ['w123-s3', 'w123-s1']);
  // Provenance keeps every original sense_code in source order; the suffix of a surviving id indexes into it, so
  // after sense 2 is filtered `w123-s3` still maps to 7003, and the filtered array index (1) is never used.
  const original = flattenSenses(triple).map(({ sense }) => Number(sense.sense_code));
  const surviving = convertItem(triple, context).record.senses.filter(({ id }) => id !== 'w123-s2');
  assert.deepEqual(surviving.map(({ id }) => original[Number(id.match(/-s(\d+)$/u)[1]) - 1]), [7001, 7003]);
});

// Search aliases (`search_forms`) are many-to-many paths into complete records. Synthetic words only: this tests
// search semantics through the real producer -> SQLite -> consumer route, not any approved STDICT root link.
const state0 = (database) => { const r = getRecord(database, 'w300'); return [r.lemma, r.senses[0].id, r.senses[0].pos]; };

test('search aliases coexist with exact lemmas, shared targets, same-record matches and generated forms', async () => {
  const word = (id, lemma, pos, searchForms = [lemma]) => ({
    id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: searchForms, source: 'stdict',
    senses: [{ id: `${id}-s1`, pos, gloss: `${lemma}의 뜻풀이.` }],
  });
  const records = [
    word('w201', '나직하다', 'adjective', ['나직하다', '나직']),
    word('w202', '나직나직하다', 'adjective', ['나직나직하다', '나직']),
    word('w300', '나직', 'noun'),
    word('w400', '시민단체', 'noun', ['시민단체', '시민 단체']),
    word('w410', '먹다', 'verb'),
    word('w411', '먹는', 'noun'),
    word('w420', '보다', 'verb', ['보다', '본']),
  ];
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-alias-'));
  try {
    const canonicalDirectory = path.join(directory, 'canonical');
    await mkdir(canonicalDirectory);
    await writeFile(path.join(canonicalDirectory, 'stdict-0001.jsonl'), `${records.map(serializeRecord).join('\n')}\n`);
    const outputPath = path.join(directory, 'dictionary.sqlite');
    await buildDictionary({ inputDirectory: canonicalDirectory, outputPath, allowDirty: true });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const shape = (term) => findRecordsBySearchTerm(database, term).matches
        .map(({ id, match }) => [id, match.kind, match.field]);

      // 1 + 2: the exact lemma ranks first without suppressing either alias target; alias targets keep a stable order.
      assert.deepEqual(shape('나직'), [
        ['w300', 'exact-lemma', 'lemma'],
        ['w201', 'exact-search-form', 'search-form'],
        ['w202', 'exact-search-form', 'search-form'],
      ]);
      assert.deepEqual(shape('나직'), shape('나직'), 'order is deterministic');
      assert.deepEqual(shape('나직하다'), [['w201', 'exact-lemma', 'lemma']], 'unrelated exact matches are untouched');

      // 3: one record matched as lemma and as alias appears once, with the best match type.
      assert.deepEqual(shape('시민단체'), [['w400', 'exact-lemma', 'lemma']]);
      assert.deepEqual(shape('시민 단체'), [['w400', 'exact-search-form', 'search-form']]);

      // 3: a generated form never hides an exact lemma, and an alias that is also generated is one search-form match.
      assert.deepEqual(shape('먹는'), [['w411', 'exact-lemma', 'lemma'], ['w410', 'generated-surface-form', 'generated-surface-form']]);
      assert.deepEqual(shape('본'), [['w420', 'exact-search-form', 'search-form']]);

      // 5: aliases are not records or senses, and identity/gloss survive the response.
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM records').get().n, records.length);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM senses').get().n, records.length);
      const alias = getRecord(database, 'w201');
      assert.deepEqual([alias.lemma, alias.senses[0].id, alias.senses[0].pos, alias.senses[0].gloss], ['나직하다', 'w201-s1', 'adjective', '나직하다의 뜻풀이.']);
      assert.deepEqual(state0(database), ['나직', 'w300-s1', 'noun'], 'the exact-lemma record keeps its own identity');

      // 4: the runtime consumer keeps every candidate and selects the first (exact lemma) one.
      const session = new SearchSession({
        runtime: {
          search: async (term) => findRecordsBySearchTerm(database, term),
          getRecord: async (id) => getRecord(database, id),
        },
      });
      const state = await session.searchExact('나직');
      assert.deepEqual(state.results.map(({ id }) => id), ['w300', 'w201', 'w202']);
      assert.equal(state.selectedRecordId, 'w300');
      assert.deepEqual(state.results.map(({ match }) => match.kind), ['exact-lemma', 'exact-search-form', 'exact-search-form']);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Inclusion policy (Issue #678): decided per source sense, never per target_code or by string shape alone.
const polity = (word, sourcePos, definition = '뜻풀이.', wordUnit = '단어') => classifySense({ word, wordUnit, sourcePos, definition });

test('the inclusion policy excludes grammatical elements and roots by sense, keeping independent words', () => {
  for (const [pos, reason] of [['조사', 'particle'], ['어미', 'ending'], ['접사', 'affix']]) {
    assert.deepEqual(polity('-가', pos), { include: false, reason });
  }
  // Independent words and expressions stay, including a word whose spelling merely contains `-님` or `-다`.
  for (const pos of ['명사', '의존 명사', '대명사', '수사', '동사', '보조 동사', '형용사', '보조 형용사', '부사', '관형사', '감탄사']) {
    assert.equal(polity('스님', pos).include, true, pos);
  }
  for (const unit of ['구', '속담', '관용구']) assert.equal(polity('각설이^타령', '구', '노래.', unit).include, true);
  assert.deepEqual(polity('선생님', '명사'), { include: true });
  // A POS-less sense is a root, a bound form, or an independent unclassified expression.
  assert.deepEqual(polity('나직', '품사 없음', '‘나직하다’의 어근.'), { include: false, reason: 'root', rootTarget: '나직하다' });
  assert.deepEqual(polity('가03', undefined, '‘가하다01「2」’의 어근.'), { include: false, reason: 'root', rootTarget: '가하다01' });
  assert.deepEqual(polity('-라면서', '품사 없음', '‘-라고 하면서’가 줄어든 말.'), { include: false, reason: 'bound-form' });
  assert.deepEqual(polity('어쨌건', '품사 없음', '‘어찌하였건’이 줄어든 말.'), { include: true });
  assert.deepEqual(polity('그러-면', '품사 없음', '‘그리하면’이 줄어든 말.'), { include: true });
  // Unsupported explicit POS and unknown markup are held, not reclassified.
  assert.equal(polity('새말', '미지원품사').hold, 'unsupported-pos');
  assert.equal(polity('새말', '명사', '뜻<blink>풀이</blink>').hold, 'unknown-markup');
});

test('filtering keeps original sense numbers and only drops entries with no admitted sense', () => {
  const mixed = {
    target_code: 700,
    word_info: {
      word: '가나',
      word_unit: '단어',
      pos_info: [
        { pos: '명사', comm_pattern_info: [{ sense_info: [{ sense_code: 7001, definition: '첫째.' }] }] },
        { pos: '접사', comm_pattern_info: [{ sense_info: [{ sense_code: 7002, definition: '더하는 말.' }] }] },
        { pos: '동사', comm_pattern_info: [{ sense_info: [{ sense_code: 7003, definition: '셋째.' }] }] },
      ],
    },
  };
  const only = item(701, '-나', '단어', [[7011, '더하는 말.'], [7012, '다른 말.']], '접사');
  const index = createSenseIndex();
  for (const source of [mixed, only]) addToSenseIndex(index, source);
  finalizeSenseIndex(index);
  const { record, report } = convertItem(mixed, { index, isSelected: () => true });
  assert.deepEqual(record.senses.map(({ id, pos }) => [id, pos]), [['w700-s1', 'noun'], ['w700-s3', 'verb']]);
  assert.deepEqual(report.excluded, [{ sense: 'w700-s2', reason: 'affix' }]);
  assert.equal(convertItem(only, { index, isSelected: () => true }).record, null);
});

test('a root becomes a search alias of its one complete word and is never a record or a guess', () => {
  const root = (code, word, definition, sourceCode) => item(code, word, '단어', [[sourceCode, definition]], '품사 없음');
  const source = [
    item(800, '나직-하다', '단어', [[8001, '소리가 낮다.']], '형용사'),
    root(801, '나직', '‘나직하다’의 어근.', 8011),
    item(802, '마땅-하다01', '단어', [[8021, '알맞다.']], '형용사'),
    item(803, '마땅-하다02', '단어', [[8031, '옳다.']], '형용사'),
    root(804, '마땅', '‘마땅하다’의 어근.', 8041),
    root(805, '허공', '‘허공하다’의 어근.', 8051),
    root(806, '굳', '‘굳하다’의 어근.', 8061),
    item(807, '굳-하다', '단어', [[8071, '더하는 말.']], '접사'),
  ];
  const index = createSenseIndex();
  for (const entry of source) addToSenseIndex(index, entry);
  finalizeSenseIndex(index);
  assert.deepEqual(index.rootReport.map(({ target_code: code, status }) => [code, status]), [
    [801, 'resolved'], [804, 'no-target'], [805, 'no-target'], [806, 'target-excluded'],
  ]);
  const convert = (code) => convertItem(source.find(({ target_code: target }) => target === code), { index, isSelected: () => true });
  assert.deepEqual(convert(800).record.search_forms, ['나직하다', '나직']);
  assert.deepEqual(convert(802).record.search_forms, ['마땅하다'], 'an ambiguous root is not linked to either homograph');
  assert.equal(convert(801).record, null, 'the root itself is no record');
});

test('a relation to a policy-excluded target is a decided absence, not a pending or broken link', () => {
  const source = [
    item(900, '가', '단어', [[9001, '뜻.', [['동의어', 9011], ['동의어', 9021]]]]),
    item(901, '-나', '단어', [[9011, '뜻.']], '접사'),
    item(902, '다', '단어', [[9021, '뜻.']]),
  ];
  const index = createSenseIndex();
  for (const entry of source) addToSenseIndex(index, entry);
  finalizeSenseIndex(index);
  const status = (loaded) => convertItem(source[0], { index, isSelected: (code) => loaded.has(code) }).report.relations.map((row) => row.status);
  assert.deepEqual(status(new Set([900, 901, 902])), ['policy-excluded', 'converted']);
  assert.deepEqual(status(new Set([900])), ['policy-excluded', 'out-of-sample']);
});

test('shard assignment keeps admitted pilot records, refills the first shard, and never moves a loaded record', () => {
  const shards = assignShards({ eligibleCodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pilotCodes: [9, 7, 99], shardSize: 4 });
  assert.deepEqual(shards, [[1, 2, 7, 9], [3, 4, 5, 6], [8, 10]], 'pilot 99 is no longer eligible; its place is refilled');
  const grown = assignShards({ eligibleCodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], pilotCodes: [9, 7, 99], shardSize: 4 });
  assert.deepEqual(grown.slice(0, 2), shards.slice(0, 2).map((codes, at) => (at === 0 ? codes : codes)), 'earlier shards keep their members when the tail grows');
  assert.deepEqual(assignShards({ eligibleCodes: [3, 1, 2], pilotCodes: [], shardSize: 2 }), [[1, 2], [3]]);
});

test('crossed subscript and superscript markup is converted without losing text', () => {
  assert.equal(cleanDefinition("화학식은 NO<sub style='font-size:11px;'>2<sup style='font-size:11px;'></sub>+</sup>.").text, '화학식은 NO₂⁺.');
  assert.equal(cleanDefinition("화학식은 NO<sub style='font-size:11px;'>2<sup style='font-size:11px;'></sub>+</sup>.").unknownMarkup, false);
});

test('the source reader accepts only the inventoried file set, bytes and entry counts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-stdict-source-'));
  try {
    const entries = (...codes) => codes.map((code) => item(code, '단어', '단어', [[code * 10, '뜻풀이.']]));
    const write = (name, list, total = 3) => writeFile(path.join(directory, name), JSON.stringify({ channel: { total, item: list } }));
    await write('d_1.json', entries(1, 2));
    await write('d_2.json', entries(3));
    const inventory = await inventoryStdictSource(directory);
    assert.deepEqual([inventory.file_count, inventory.entry_count, inventory.channel_total], [2, 3, 3]);
    const read = async (expected = inventory) => {
      const seen = [];
      const files = await readStdictItems(directory, (entry) => seen.push(entry.target_code), { inventory: expected });
      return { files, seen };
    };
    assert.deepEqual(await read(), { files: ['d_1.json', 'd_2.json'], seen: [1, 2, 3] });

    await assert.rejects(() => readStdictItems(directory, () => {}), /requires its trusted file inventory/u);
    // A file the inventory names but the download lacks, or a file it does not name.
    await assert.rejects(() => read({ ...inventory, file_count: 3, files: [...inventory.files, { name: 'd_3.json', sha256: '0', entries: 1 }] }), /missing: d_3\.json/u);
    await assert.rejects(() => read({ ...inventory, file_count: 1, files: inventory.files.slice(0, 1), entry_count: 2 }), /unexpected: d_2\.json/u);
    // An altered or truncated file, and a wrong entry total.
    await assert.rejects(() => read({ ...inventory, files: [{ ...inventory.files[0], sha256: 'f'.repeat(64) }, inventory.files[1]] }), /d_1\.json differs from the inventory/u);
    await assert.rejects(() => read({ ...inventory, entry_count: 4 }), /expects 2 \/ 4/u);
    await write('d_2.json', entries(3, 4));
    await assert.rejects(() => read(), /d_2\.json differs from the inventory/u);
    const regenerated = await inventoryStdictSource(directory);
    await assert.rejects(() => read({ ...regenerated, files: [regenerated.files[0], { ...regenerated.files[1], entries: 1 }] }), /has 2 entries; the inventory expects 1/u);
    assert.deepEqual((await read(regenerated)).seen, [1, 2, 3, 4]);
    await rm(path.join(directory, 'd_2.json'));
    await assert.rejects(() => read(regenerated), /missing: d_2\.json/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the committed source inventory names the 88 STDICT files and their 436,587 entries', async () => {
  const inventory = JSON.parse(await readFile(path.join(ROOT, 'data/provenance/stdict-source-inventory.json'), 'utf8'));
  assert.equal(inventory.contract, 'stdict-source-inventory-v1');
  assert.deepEqual([inventory.file_count, inventory.entry_count, inventory.files.length], [88, 436587, 88]);
  assert.equal(inventory.files.reduce((sum, file) => sum + file.entries, 0), inventory.entry_count);
  assert.equal(new Set(inventory.files.map(({ name }) => name)).size, 88);
});

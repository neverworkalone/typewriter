import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { findRecordsBySearchTerm, getRecord } from '../scripts/build/query.mjs';
import {
  addToSenseIndex,
  cleanDefinition,
  convertItem,
  createSenseIndex,
  mapPos,
  recordIdFor,
  serializeRecord,
  surfaceForms,
} from '../scripts/stdict/convert.mjs';
import { SearchSession } from '../src/domain/search-session.js';
import { buildPilot } from '../scripts/stdict/build-shard.mjs';
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
  const records = FIXTURE.map((source) => convertItem(source, context).record);
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
    assert.equal(summary.recordCount, FIXTURE.length);
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const homographs = findRecordsBySearchTerm(database, '각본').matches.map(({ id }) => id).sort();
      assert.deepEqual(homographs, ['w100', 'w101']);
      assert.deepEqual(findRecordsBySearchTerm(database, '각설이 타령').matches.map(({ id }) => id), ['w103']);
      assert.deepEqual(findRecordsBySearchTerm(database, '간').matches.map(({ id }) => id), ['w104']);
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

test('committed STDICT pilot shard keeps its identity and provenance contract', async () => {
  const text = await readFile(SHARD, 'utf8');
  const lines = text.split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 1000);
  const provenance = JSON.parse(await readFile(PROVENANCE, 'utf8'));
  assert.equal(provenance.shard_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(provenance.record_count, 1000);
  assert.equal(provenance.held_count, 0);
  const records = lines.map((line) => JSON.parse(line));
  const ids = new Set(records.map(({ id }) => id));
  assert.equal(ids.size, 1000);
  assert.deepEqual(records.map(({ id }) => Number(id.slice(1))), records.map(({ id }) => Number(id.slice(1))).sort((a, b) => a - b));
  provenance.records.forEach((row, position) => {
    const record = records[position];
    assert.equal(record.id, `w${row.target_code}`);
    assert.equal(record.id, row.id);
    assert.equal(record.senses.length, row.sense_codes.length);
    record.senses.forEach((sense, senseIndex) => assert.equal(sense.id, `${record.id}-s${senseIndex + 1}`));
  });
  for (const record of records) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) {
        assert.ok(['direct', 'antonym'].includes(relation.type));
        assert.equal(Object.hasOwn(relation, 'relevance'), false);
        assert.ok(ids.has(relation.target), `${sense.id} targets an in-shard record`);
        assert.ok(relation.target_sense.startsWith(`${relation.target}-s`));
      }
    }
  }
  const classes = new Set(provenance.records.length && Object.keys(provenance.summary.by_stratum));
  for (const required of ['verb', 'adjective', 'adverb', 'noun', 'phrase', 'proverb', 'idiom', 'multi-pos',
    'homograph-group', 'particle', 'ending', 'affix', 'pos-less-word', 'synonym-pair', 'antonym-pair']) {
    assert.ok(classes.has(required), `pilot covers ${required}`);
  }
});

test('pilot selection regenerates byte-identically from the source download', { skip: await access(SOURCE).then(() => false, () => 'STDICT source download is not available') }, async () => {
  const result = await buildPilot({ sourceDirectory: SOURCE });
  assert.equal(result.shard, await readFile(SHARD, 'utf8'));
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

// Search aliases (`search_forms`) are many-to-many paths into complete records. Synthetic words only: this tests
// search semantics through the real producer -> SQLite -> consumer route, not any approved STDICT root link.
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
      assert.equal(getRecord(database, 'w201').senses[0].gloss, '나직하다의 뜻풀이.');

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

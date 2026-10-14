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
  convertItem,
  createSenseIndex,
  mapPos,
  serializeRecord,
  surfaceForms,
} from '../scripts/stdict/convert.mjs';
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

test('part-of-speech mapping never silently drops a class', () => {
  const mapped = Object.fromEntries(
    ['명사', '의존 명사', '대명사', '수사', '동사', '보조 동사', '형용사', '보조 형용사', '부사', '관형사', '감탄사', '조사', '어미', '접사', undefined]
      .map((pos) => [pos, mapPos(pos, '단어')]),
  );
  assert.equal(mapped['의존 명사'], 'noun');
  assert.equal(mapped['보조 동사'], 'verb');
  assert.equal(mapped['접사'], 'affix');
  assert.equal(mapped.undefined, 'unclassified');
  for (const unit of ['구', '속담', '관용구']) assert.equal(mapPos('구', unit), 'expression');
});

test('official relations bind by sense_code and report every non-converted status', () => {
  const { record, report } = convertItem(FIXTURE[0], fixtureContext(new Set([100, 101, 102])));
  assert.equal(record.id, 'w100');
  assert.equal(record.candidate_id, 'w100');
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

test('licensed-source shards are exempt from authored editorial heuristics but not structure', async () => {
  const { auditCanonicalLexicalQuality } = await import('../scripts/validate/lexical-quality.mjs');
  const { reviewableRecordInfos } = await import('../scripts/validate/licensed-source.mjs');
  const homographs = [
    { id: 'w100', lemma: '각본', gloss: '준말.' },
    { id: 'w101', lemma: '각본', gloss: '글.' },
  ].map(({ id, lemma, gloss }) => ({
    id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
    senses: [{ id: `${id}-s1`, pos: 'noun', gloss }],
  }));
  const infos = (file, records = homographs) => records.map((record, index) => ({
    record, filePath: path.join('/data/canonical', file), lineNumber: index + 1,
  }));
  const audit = (file, records) => auditCanonicalLexicalQuality(infos(file, records), { throwOnError: false });
  assert.equal(audit('stdict-0007.jsonl').blocking_finding_count, 0);
  assert.ok(audit('authored-0001.jsonl').blocking_finding_count > 0, 'authored shards keep every heuristic');
  const brokenPos = structuredClone(homographs);
  brokenPos[0].record_type = 'expression';
  assert.ok(audit('stdict-0007.jsonl', brokenPos).blocking_finding_count > 0, 'structure is still enforced');
  const mixed = [...infos('stdict-0007.jsonl'), ...infos('authored-0001.jsonl', [{ ...homographs[0], id: 'w200', candidate_id: 'w200', senses: [{ id: 'w200-s1', pos: 'noun', gloss: '준말.' }] }])];
  assert.deepEqual(reviewableRecordInfos(mixed).map(({ record }) => record.id), ['w200']);
  const plain = infos('authored-0001.jsonl');
  assert.equal(reviewableRecordInfos(plain), plain, 'identity is preserved when nothing is exempt');
});

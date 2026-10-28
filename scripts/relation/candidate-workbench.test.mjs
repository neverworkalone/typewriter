import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCandidateWorkbenchStdoutWriter,
  inspectCanonicalRecord,
  mergeCandidateBatch,
  patchCandidateSenses,
  prepareCandidateBatch,
  readCandidateChunkCompact,
  readCandidateChunkPage,
  readCandidateStatus,
  saveCandidateChunk,
  serializeWorkbenchOutput,
} from './candidate-workbench.mjs';

async function setup(t, method = 'b') {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const scratchDirectory = path.join(repositoryDirectory, `.warroom-scratch/001_01_${method}_codex`);
  await mkdir(path.join(repositoryDirectory, 'data/canonical'), { recursive: true });
  const canonicalRows = Array.from({ length: 500 }, (_, index) => ({
    id: `w${String(index + 1).padStart(3, '0')}`,
    lemma: `표제어 ${index + 1}`,
    senses: index === 0
      ? [
          { id: 'w001-s1', pos: 'noun', gloss: '첫 번째 뜻.' },
          { id: 'w001-s2', pos: 'noun', gloss: '두 번째 뜻.', semantic_note: '전체 원문 필드 보존' },
        ]
      : [{ id: `w${String(index + 1).padStart(3, '0')}-s1`, pos: 'noun', gloss: `뜻 ${index + 1}.` }],
    source: 'stdict',
  }));
  await writeFile(path.join(repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { repositoryDirectory, scratchDirectory, canonicalRows, method };
}

const prepare = (context, chunkSize = 25) => prepareCandidateBatch({
  shard: '001', batch: '01', method: context.method, model: 'codex',
  scratchDirectory: context.scratchDirectory, chunkSize, repositoryDirectory: context.repositoryDirectory,
});

function rowsFor(canonicalRows, start, end, bySense = {}) {
  return canonicalRows.slice(start, end).map((record) => ({
    record_id: record.id,
    senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: bySense[sense.id] ?? [] })),
  }));
}

async function writeInput(context, rows, name) {
  const inputPath = path.join(context.scratchDirectory, name);
  await mkdir(context.scratchDirectory, { recursive: true });
  await writeFile(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return inputPath;
}

async function saveChunk(context, number, bySense = {}) {
  const start = (number - 1) * 25;
  const inputPath = await writeInput(context, rowsFor(context.canonicalRows, start, start + 25, bySense), `in-${number}.jsonl`);
  return saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: number, inputPath, repositoryDirectory: context.repositoryDirectory });
}

const saveAll = async (context, bySenseByChunk = {}) => {
  for (let number = 1; number <= 20; number += 1) await saveChunk(context, number, bySenseByChunk[number]);
};

const readLines = async (file) => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

for (const method of ['a', 'b']) {
  test(`${method.toUpperCase()}: prepare, save, local patch and merge need no receipts`, async (t) => {
    const context = await setup(t, method);
    const prepared = await prepare(context);
    assert.equal(prepared.recordCount, 500);
    assert.equal(prepared.senseCount, 501);
    assert.equal(prepared.chunks.length, 20);
    assert.ok(prepared.chunks.every((chunk) => chunk.saved === false));

    await saveAll(context, { 1: { 'w001-s1': ['별빛', '은하수'], 'w002-s1': ['산들바람'] } });
    await patchCandidateSenses({
      scratchDirectory: context.scratchDirectory,
      inputPath: await writeInput(context, [
        { record_id: 'w001', sense_id: 'w001-s1', remove: ['은하수'], add: ['달무리'] },
        { record_id: 'w002', sense_id: 'w002-s1', add: ['소슬바람'] },
      ], 'patch.jsonl'),
      repositoryDirectory: context.repositoryDirectory,
    });

    const outPath = path.join(context.scratchDirectory, 'merged.jsonl');
    const merged = await mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory });
    assert.deepEqual(merged.validation, { recordCount: 500, senseCount: 501, candidateCount: 4, emptySenseCount: 499 });
    const output = await readLines(outPath);
    assert.deepEqual(output.slice(0, 2).map((row) => row.record_id), ['w001', 'w002']);
    assert.deepEqual(output[0].senses[0].candidates, ['별빛', '달무리']);
    assert.deepEqual(output[0].senses[1].candidates, []);
    assert.deepEqual(output[1].senses[0].candidates, ['산들바람', '소슬바람']);
  });
}

test('read-chunk shows each record once with all senses and its saved candidates', async (t) => {
  const context = await setup(t);
  await prepare(context);
  const before = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, repositoryDirectory: context.repositoryDirectory });
  assert.equal(before.total, 25);
  assert.equal(before.saved, false);
  assert.deepEqual(before.items[0], {
    id: 'w001',
    lemma: '표제어 1',
    senses: [
      { id: 'w001-s1', pos: 'noun', gloss: '첫 번째 뜻.' },
      { id: 'w001-s2', pos: 'noun', gloss: '두 번째 뜻.' },
    ],
  });
  assert.equal(before.returned, 25);
  assert.equal(before.has_more, false);

  await saveChunk(context, 1, { 'w001-s2': ['밤하늘'] });
  const after = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, limit: 1, repositoryDirectory: context.repositoryDirectory });
  assert.equal(after.saved, true);
  assert.equal(after.next_offset, 1);
  assert.deepEqual(after.items[0].senses.map((sense) => sense.candidates), [[], ['밤하늘']]);
  assert.equal(after.items[0].senses[1].semantic_note, undefined);
});

test('a 50-record chunk reads in one page and keeps homograph and distinct search forms', async (t) => {
  const context = await setup(t);
  Object.assign(context.canonicalRows[1], { homograph_no: 2, search_forms: ['표제어 2', '표제어2'], relations: [{ type: 'direct' }] });
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context, 50);
  const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, repositoryDirectory: context.repositoryDirectory });
  assert.equal(page.returned, 50);
  assert.equal(page.has_more, false);
  assert.deepEqual(page.items[1], { id: 'w002', lemma: '표제어 2', homograph_no: 2, search_forms: ['표제어 2', '표제어2'], senses: [{ id: 'w002-s1', pos: 'noun', gloss: '뜻 2.' }] });
});

test('an oversized record is split by sense without losing any sense, and caps stay hard', async (t) => {
  const context = await setup(t);
  context.canonicalRows[0].senses = Array.from({ length: 12 }, (_, index) => ({ id: `w001-s${index + 1}`, pos: 'noun', gloss: '길다. '.repeat(400) }));
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context);
  const ids = [];
  for (let offset = 0, more = true; more;) {
    const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, offset, repositoryDirectory: context.repositoryDirectory });
    ids.push(...page.items.filter((item) => item.id === 'w001').flatMap((item) => item.senses.map((sense) => sense.id)));
    more = page.has_more;
    offset = page.next_offset;
  }
  assert.deepEqual(ids, context.canonicalRows[0].senses.map((sense) => sense.id));
  assert.throws(() => serializeWorkbenchOutput({ text: 'x'.repeat(40000) }), /safety cap exceeded/u);
  const write = createCandidateWorkbenchStdoutWriter({ maxBytes: 100, maxChars: 100, write() {} });
  write({ a: 1 });
  assert.throws(() => write({ b: 'y'.repeat(100) }), /safety cap exceeded/u);
});

test('save-chunk rejects wrong IDs and bad candidates without touching saved data', async (t) => {
  const context = await setup(t);
  await prepare(context);
  await saveChunk(context, 1, { 'w001-s1': ['별빛'] });
  const good = rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['달빛'] });
  const cases = [
    ['missing record', good.slice(1), /missing record_id\(s\): w001/u],
    ['extra record', [...good, ...rowsFor(context.canonicalRows, 25, 26)], /outside chunk 001/u],
    ['duplicate record', [...good, good[0]], /repeats record_id w001/u],
    ['missing sense', good.map((row, index) => (index === 0 ? { ...row, senses: row.senses.slice(0, 1) } : row)), /sense_id mismatch for record_id w001/u],
    ['cross-mapped sense', good.map((row, index) => (index === 1 ? { ...row, senses: [{ sense_id: 'w001-s1', candidates: [] }] } : row)), /sense_id mismatch for record_id w002/u],
    ['untrimmed candidate', rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': [' 달빛'] }), /non-empty trimmed string/u],
    ['exact source lemma', rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['표제어 1'] }), /repeats source lemma/u],
    ['source lemma with parenthetical', rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['표제어 1(標題語)'] }), /repeats source lemma/u],
    ['duplicate candidate', rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['달빛', '달빛'] }), /duplicates candidate/u],
  ];
  for (const [name, rows, expected] of cases) {
    const inputPath = await writeInput(context, rows, 'bad.jsonl');
    await assert.rejects(saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory }), expected, name);
  }
  await assert.rejects(saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 21, inputPath: await writeInput(context, good, 'good.jsonl'), repositoryDirectory: context.repositoryDirectory }), /outside this batch/u);
  const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, limit: 1, repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(page.items[0].senses[0].candidates, ['별빛']);
});

test('save-chunk rejects exact source lemma self-repeats that the final validator would reject at merge', async (t) => {
  const context = await setup(t);
  context.canonicalRows[0].lemma = '단 수';
  context.canonicalRows[0].search_forms = ['단 수', '단수', '단수가', '단순'];
  context.canonicalRows[1].lemma = '단순';
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context);
  const save = async (bySense) => saveCandidateChunk({
    scratchDirectory: context.scratchDirectory,
    chunk: 1,
    inputPath: await writeInput(context, rowsFor(context.canonicalRows, 0, 25, bySense), 'repeat.jsonl'),
    repositoryDirectory: context.repositoryDirectory,
  });
  for (const [name, candidate, expected] of [
    ['exact lemma', '단 수', /repeats source lemma/u],
    ['whitespace variant', '단  수', /repeats source lemma/u],
    ['parenthetical annotation', '단 수(單數)', /repeats source lemma/u],
    ['spacing-stripped search form', '단수', /orthographic search form/u],
  ]) {
    await assert.rejects(save({ 'w001-s1': ['별빛', candidate] }), expected, name);
  }
  // Valid-but-unusual: a compound containing the lemma, a longer search form, and another entry's lemma stay allowed.
  const saved = await save({ 'w001-s1': ['단 수 조절', '단수가', '단순', '별빛'] });
  assert.equal(saved.candidateCount, 4);
});

test('save-chunk reports every source-lemma self-repeat of a chunk at once, keeps saved data, and still allows valid forms', async (t) => {
  const context = await setup(t);
  context.canonicalRows[0].lemma = '들소';
  context.canonicalRows[1].lemma = '뒷밭';
  context.canonicalRows[1].search_forms = ['뒷밭', '뒷 밭'];
  context.canonicalRows[2].lemma = '드레싱';
  context.canonicalRows[3].lemma = '건축';
  context.canonicalRows[4].lemma = '건축가';
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context);
  await saveChunk(context, 1, { 'w004-s1': ['보존'] });
  const savedPath = path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl');
  const before = await readFile(savedPath, 'utf8');
  const save = async (bySense) => saveCandidateChunk({
    scratchDirectory: context.scratchDirectory,
    chunk: 1,
    inputPath: await writeInput(context, rowsFor(context.canonicalRows, 0, 25, bySense), 'repeat.jsonl'),
    repositoryDirectory: context.repositoryDirectory,
  });
  // Exact, parenthetical and search-form repeats in three different senses: one save names all three, and only them.
  await assert.rejects(save({ 'w001-s1': ['들소'], 'w002-s1': ['뒷 밭'], 'w003-s1': ['드레싱(dressing)'], 'w004-s1': ['건축가'] }), (error) => {
    const summary = error.message.split('\n').at(-1);
    assert.deepEqual([...summary.matchAll(/sense_id (\S+?)(?:;|$)/gu)].map((match) => match[1]).sort(), ['w001-s1', 'w002-s1', 'w003-s1']);
    assert.match(summary, /source lemma repeat in 3 sense\(s\)/u);
    return true;
  });
  assert.equal(await readFile(savedPath, 'utf8'), before);
  // A structural defect is still a plain fail-closed error, not a self-repeat report.
  await assert.rejects(save({ 'w001-s1': ['들소', ' 별빛'] }), /non-empty trimmed string/u);
  // Valid-but-unusual: an independent compound and another Canonical lemma are accepted.
  assert.equal((await save({ 'w004-s1': ['건축가', '건축 도면'] })).candidateCount, 2);
});

test('compact save removes every definite self-repeat and reports every affected alias', async (t) => {
  const context = await setup(t);
  for (const [index, record] of context.canonicalRows.slice(0, 50).entries()) {
    const extra = index < 36 ? 2 : 1;
    record.senses = Array.from({ length: extra + 1 }, (_, sense) => ({ id: `${record.id}-s${sense + 1}`, pos: 'noun', gloss: `뜻 ${index + 1}-${sense + 1}.` }));
  }
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context, 50);
  const lines = ['chunk 001'];
  let alias = 0;
  for (const record of context.canonicalRows.slice(0, 50)) for (const _ of record.senses) lines.push(`S${(alias += 1)}\t${record.lemma}`);
  assert.equal(alias, 136);
  const inputPath = path.join(context.scratchDirectory, 'answer.tsv');
  await mkdir(context.scratchDirectory, { recursive: true });
  await writeFile(inputPath, `${lines.join('\n')}\n`);
  const result = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, format: 'compact', repositoryDirectory: context.repositoryDirectory });
  assert.equal(result.candidateCount, 0);
  assert.equal(result.autoRemoved.count, 136);
  assert.deepEqual(result.autoRemoved.items.map((item) => item.alias), Array.from({ length: 136 }, (_, i) => `S${i + 1}`));
  assert.ok(result.autoRemoved.items.every((item) => item.reason === 'source lemma repeat'));
  const saved = await readFile(path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl'), 'utf8');
  assert.ok(saved.split('\n').filter(Boolean).every((line) => JSON.parse(line).senses.every((sense) => sense.candidates.length === 0)));
});

test('patch rejects unknown IDs and absent removals, and writes nothing on failure', async (t) => {
  const context = await setup(t);
  await prepare(context);
  const patch = (rows) => patchCandidateSenses({ scratchDirectory: context.scratchDirectory, inputPath: rows, repositoryDirectory: context.repositoryDirectory });
  await assert.rejects(patch(await writeInput(context, [{ record_id: 'w001', sense_id: 'w001-s1', add: ['별빛'] }], 'p.jsonl')), /has not been saved/u);
  await saveChunk(context, 1, { 'w001-s1': ['별빛'] });
  await assert.rejects(patch(await writeInput(context, [{ record_id: 'w999', sense_id: 'x', add: ['a'] }], 'p.jsonl')), /not in this batch/u);
  await assert.rejects(patch(await writeInput(context, [{ record_id: 'w001', sense_id: 'w002-s1', add: ['a'] }], 'p.jsonl')), /unknown record_id w001 \/ sense_id w002-s1/u);
  await assert.rejects(patch(await writeInput(context, [
    { record_id: 'w002', sense_id: 'w002-s1', add: ['산들바람'] },
    { record_id: 'w001', sense_id: 'w001-s1', remove: ['없는말'] },
  ], 'p.jsonl')), /is not present/u);
  await assert.rejects(patch(await writeInput(context, [{ record_id: 'w001', sense_id: 'w001-s1', add: ['별빛'] }], 'p.jsonl')), /duplicates candidate/u);
  for (const bad of [{ add: '달빛' }, { remove: '별빛' }, { add: [1] }, { remove: [null] }, { add: {} }]) {
    await assert.rejects(patch(await writeInput(context, [{ record_id: 'w001', sense_id: 'w001-s1', ...bad }], 'p.jsonl')), /must be an array of strings/u);
  }
  const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(page.items.map((item) => item.senses.flatMap((sense) => sense.candidates)).flat(), ['별빛']);
});

test('resume reuses the checkpoint and saved chunks; merge needs every chunk and the unchanged source', async (t) => {
  const context = await setup(t);
  await prepare(context);
  await saveChunk(context, 1, { 'w001-s1': ['별빛'] });
  const resumed = await prepare(context);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.chunks.filter((chunk) => chunk.saved).map((chunk) => chunk.number), [1]);
  await assert.rejects(prepare(context, 50), /checkpoint uses 25-record chunks/u);
  assert.deepEqual((await readCandidateStatus({ scratchDirectory: context.scratchDirectory, repositoryDirectory: context.repositoryDirectory })).unsavedChunks, Array.from({ length: 19 }, (_, index) => index + 2));

  const outPath = path.join(context.scratchDirectory, 'merged.jsonl');
  await assert.rejects(mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory }), /not saved for chunk\(s\) 002, 003/u);
  for (let number = 2; number <= 20; number += 1) await saveChunk(context, number);
  context.canonicalRows[3].senses[0].gloss = '바뀐 뜻.';
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await assert.rejects(mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory }), /Canonical batch changed since prepare/u);
  await assert.rejects(readFile(outPath, 'utf8'), { code: 'ENOENT' });
});

test('partial final-shard batch keeps its 83-record boundary and merges', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-tail-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const scratchDirectory = path.join(repositoryDirectory, '.warroom-scratch/428_02_b_codex');
  await mkdir(path.join(repositoryDirectory, 'data/canonical'), { recursive: true });
  const rows = Array.from({ length: 583 }, (_, index) => ({
    id: `tail-${index + 1}`, lemma: `꼬리 표제어 ${index + 1}`,
    senses: [{ id: `tail-${index + 1}-s1`, pos: 'noun', gloss: `꼬리 뜻 ${index + 1}.` }], source: 'stdict',
  }));
  await writeFile(path.join(repositoryDirectory, 'data/canonical/stdict-0428.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const prepared = await prepareCandidateBatch({ shard: '428', batch: '02', method: 'b', model: 'codex', scratchDirectory, repositoryDirectory });
  assert.equal(prepared.recordCount, 83);
  assert.equal(prepared.chunks.length, 4);
  assert.equal(prepared.chunks.at(-1).firstRecord, 576);
  assert.equal(prepared.chunks.at(-1).lastRecord, 583);
  for (const chunk of prepared.chunks) {
    const batchRows = rows.slice(500).slice((chunk.number - 1) * 25, chunk.number * 25);
    const input = path.join(scratchDirectory, `in-${chunk.number}.jsonl`);
    const candidates = batchRows.map((row) => ({ record_id: row.id, senses: [{ sense_id: row.senses[0].id, candidates: row.id === 'tail-576' ? ['별빛'] : [] }] }));
    await writeFile(input, `${candidates.map((row) => JSON.stringify(row)).join('\n')}\n`);
    await saveCandidateChunk({ scratchDirectory, chunk: chunk.number, inputPath: input, repositoryDirectory });
  }
  const outPath = path.join(scratchDirectory, 'tail.jsonl');
  const merged = await mergeCandidateBatch({ scratchDirectory, outPath, repositoryDirectory });
  assert.deepEqual(merged.validation, { recordCount: 83, senseCount: 83, candidateCount: 1, emptySenseCount: 82 });
  const output = await readLines(outPath);
  assert.equal(output[0].record_id, 'tail-501');
  assert.deepEqual(output[75].senses[0].candidates, ['별빛']);
});

test('merge runs the Candidate v1 validator and leaves no partial output; inspect returns the full record', async (t) => {
  const context = await setup(t);
  await prepare(context);
  await saveAll(context);
  await patchCandidateSenses({
    scratchDirectory: context.scratchDirectory,
    inputPath: await writeInput(context, [{ record_id: 'w001', sense_id: 'w001-s1', add: ['표제어 1'] }], 'patch.jsonl'),
    repositoryDirectory: context.repositoryDirectory,
  });
  const outPath = path.join(context.scratchDirectory, 'must-not-exist.jsonl');
  await assert.rejects(mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory }), /candidate repeats source lemma "표제어 1"/u);
  await assert.rejects(readFile(outPath, 'utf8'), { code: 'ENOENT' });
  const inspected = await inspectCanonicalRecord({ shard: '001', recordId: 'w001', repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(inspected.record.senses, context.canonicalRows[0].senses);
});

// ---- compact I/O (#2035 PR A) ----

const compactLines = (text) => text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));

/** Flatten the default JSON read view into the same per-sense tuples the compact view carries. */
async function jsonSenseTuples(context, chunk) {
  const tuples = [];
  let offset = 0;
  for (;;) {
    const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk, offset, repositoryDirectory: context.repositoryDirectory });
    for (const item of page.items) {
      for (const sense of item.senses) {
        const forms = item.search_forms ? item.search_forms.join(',') : '';
        tuples.push([sense.id, `${item.lemma}${item.homograph_no === undefined ? '' : ` [${item.homograph_no}]`}`, sense.pos, forms, sense.gloss]);
      }
    }
    if (!page.has_more) return tuples;
    offset = page.next_offset;
  }
}

test('compact read-chunk carries exactly the JSON view data, for real shard 001/01 at 25 and 50 records', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-real-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  await mkdir(path.join(repositoryDirectory, 'data/canonical'), { recursive: true });
  await copyFile(new URL('../../data/canonical/stdict-0001.jsonl', import.meta.url), path.join(repositoryDirectory, 'data/canonical/stdict-0001.jsonl'));
  for (const chunkSize of [25, 50]) {
    const context = { repositoryDirectory, scratchDirectory: path.join(repositoryDirectory, `.warroom-scratch/real-${chunkSize}`), method: 'a' };
    const prepared = await prepare(context, chunkSize);
    assert.equal(prepared.chunks.length, 500 / chunkSize);
    for (const chunk of prepared.chunks) {
      const outPath = path.join(context.scratchDirectory, `view-${chunk.number}.txt`);
      const result = await readCandidateChunkCompact({ scratchDirectory: context.scratchDirectory, chunk: chunk.number, outPath, repositoryDirectory });
      const text = await readFile(outPath, 'utf8');
      assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'));
      assert.equal(result.senseCount, chunk.senseCount);
      const rows = compactLines(text);
      assert.equal(rows.length, chunk.senseCount);
      assert.deepEqual(rows.map((row) => row[0]), Array.from({ length: chunk.senseCount }, (_, index) => `S${index + 1}`));
      assert.deepEqual(rows.map((row) => row.slice(1)), await jsonSenseTuples(context, chunk.number));
    }
  }
});

test('compact read-chunk keeps long glosses whole, rejects tab/newline fields, writes only inside scratch, and honours stdout caps', async (t) => {
  const context = await setup(t);
  const longGloss = '아주 긴 뜻풀이. '.repeat(5000);
  context.canonicalRows[0].senses[0].gloss = longGloss.trim();
  context.canonicalRows[0].homograph_no = 3;
  context.canonicalRows[0].search_forms = ['표제어 1', '표제어일'];
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context, 50);
  const args = { scratchDirectory: context.scratchDirectory, chunk: 1, repositoryDirectory: context.repositoryDirectory };
  await assert.rejects(readCandidateChunkCompact(args), /exceeds the stdout caps.*--out/u);
  await assert.rejects(readCandidateChunkCompact({ ...args, outPath: path.join(context.repositoryDirectory, 'elsewhere.txt') }), /out must be inside/u);
  const outPath = path.join(context.scratchDirectory, 'view.txt');
  const result = await readCandidateChunkCompact({ ...args, outPath });
  const first = compactLines(await readFile(outPath, 'utf8'))[0];
  assert.deepEqual(first, ['S1', 'w001-s1', '표제어 1 [3]', 'noun', '표제어 1,표제어일', longGloss.trim()]);
  assert.ok(result.chars > 32 * 1024);

  const small = await setup(t);
  small.canonicalRows[2].senses[0].gloss = '탭\t포함';
  await writeFile(path.join(small.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${small.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(small, 25);
  await assert.rejects(readCandidateChunkCompact({ scratchDirectory: small.scratchDirectory, chunk: 1, repositoryDirectory: small.repositoryDirectory }), /cannot carry a tab or line break/u);
  const page = await readCandidateChunkPage({ scratchDirectory: small.scratchDirectory, chunk: 1, repositoryDirectory: small.repositoryDirectory });
  assert.equal(page.items[2].senses[0].gloss, '탭\t포함');
});

test('compact read-chunk shows saved candidates and the 83-record tail splits 50+33', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-compact-tail-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const scratchDirectory = path.join(repositoryDirectory, '.warroom-scratch/428_02_a_codex');
  await mkdir(path.join(repositoryDirectory, 'data/canonical'), { recursive: true });
  const rows = Array.from({ length: 583 }, (_, index) => ({
    id: `tail-${index + 1}`, lemma: `꼬리 ${index + 1}`,
    senses: [{ id: `tail-${index + 1}-s1`, pos: 'noun', gloss: `꼬리 뜻 ${index + 1}.` }], source: 'stdict',
  }));
  await writeFile(path.join(repositoryDirectory, 'data/canonical/stdict-0428.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const prepared = await prepareCandidateBatch({ shard: '428', batch: '02', method: 'a', model: 'codex', scratchDirectory, chunkSize: 50, repositoryDirectory });
  assert.deepEqual(prepared.chunks.map((chunk) => chunk.recordCount), [50, 33]);
  const answer = path.join(scratchDirectory, 'answer.tsv');
  await writeFile(answer, `chunk 002\n${Array.from({ length: 33 }, (_, index) => (index === 0 ? 'S1\t별빛\t달무리' : `S${index + 1}`)).join('\n')}\n`);
  await saveCandidateChunk({ scratchDirectory, chunk: 2, inputPath: answer, format: 'compact', repositoryDirectory });
  const view = await readCandidateChunkCompact({ scratchDirectory, chunk: 2, repositoryDirectory });
  const lines = compactLines(view.text);
  assert.equal(view.senseCount, 33);
  assert.equal(lines.filter((line) => line[0].startsWith('S')).length, 33);
  assert.deepEqual(lines.find((line) => line[0] === 'C'), ['C', 'S1', '별빛', '달무리']);
});

async function compactChunkSetup(t, senseCountCheck = true) {
  const context = await setup(t);
  await prepare(context, 25);
  const senseCount = context.canonicalRows.slice(0, 25).reduce((count, row) => count + row.senses.length, 0);
  if (senseCountCheck) assert.equal(senseCount, 26);
  const answer = async (body, name = 'answer.tsv') => {
    const inputPath = path.join(context.scratchDirectory, name);
    await mkdir(context.scratchDirectory, { recursive: true });
    await writeFile(inputPath, body);
    return inputPath;
  };
  const save = async (body, chunk = 1) => saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk, inputPath: await answer(body), format: 'compact', repositoryDirectory: context.repositoryDirectory });
  const body = (overrides = {}) => `chunk 001\n${Array.from({ length: 26 }, (_, index) => overrides[index + 1] ?? `S${index + 1}`).join('\n')}\n`;
  return { context, save, body, answer };
}

test('compact save-chunk expands aliases to the JSON save and removes only exact normalized duplicates', async (t) => {
  const { context, save, body } = await compactChunkSetup(t);
  const result = await save(body({ 2: 'S2\t밤 하늘\t밤  하늘\t별빛', 3: 'S3\t달무리' }));
  assert.equal(result.duplicatesRemoved, 1);
  assert.deepEqual([result.recordCount, result.senseCount, result.candidateCount], [25, 26, 3]);
  const saved = (await readFile(path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(saved[0].senses, [{ sense_id: 'w001-s1', candidates: [] }, { sense_id: 'w001-s2', candidates: ['밤 하늘', '별빛'] }]);
  assert.deepEqual(saved[1], { record_id: 'w002', senses: [{ sense_id: 'w002-s1', candidates: ['달무리'] }] });

  const jsonRows = rowsFor(context.canonicalRows, 0, 25, { 'w001-s2': ['밤 하늘', '별빛'], 'w002-s1': ['달무리'] });
  const jsonContext = await setup(t);
  await prepare(jsonContext, 25);
  const inputPath = await writeInput(jsonContext, jsonRows, 'in.jsonl');
  await saveCandidateChunk({ scratchDirectory: jsonContext.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: jsonContext.repositoryDirectory });
  assert.equal(await readFile(path.join(jsonContext.scratchDirectory, 'candidates/chunk-001.jsonl'), 'utf8'), await readFile(path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl'), 'utf8'));
});

test('the default JSON save still rejects a normalized duplicate that compact removes', async (t) => {
  const context = await setup(t);
  await prepare(context, 25);
  const inputPath = await writeInput(context, rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['밤 하늘', '밤  하늘'] }), 'dup.jsonl');
  await assert.rejects(saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory }), /duplicates candidate/u);
});

test('compact save-chunk fails closed on grammar and alias defects and writes nothing', async (t) => {
  const { context, save, body } = await compactChunkSetup(t);
  const savedPath = path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl');
  const cases = [
    ['wrong chunk number', body().replace('chunk 001', 'chunk 002'), /must start with "chunk 001"/u],
    ['unpadded chunk number', body().replace('chunk 001', 'chunk 1'), /must start with "chunk 001"/u],
    ['missing header', body().replace('chunk 001\n', ''), /must start with "chunk 001"/u],
    ['missing alias', body().replace('\nS26\n', '\n'), /missing alias\(es\): S26/u],
    ['duplicate alias', `${body()}S1\t별빛\n`, /repeats alias S1/u],
    ['unknown alias past the end', `${body()}S27\n`, /alias S27 is outside/u],
    ['alias of another chunk', body({ 5: 'S51\t별빛' }), /alias S51 is outside/u],
    ['zero alias', body({ 5: 'S0\t별빛' }), /S<n> alias/u],
    ['leading-zero alias', body({ 5: 'S05\t별빛' }), /S<n> alias/u],
    ['lowercase alias', body({ 5: 's5\t별빛' }), /S<n> alias/u],
    ['space instead of tab', body({ 5: 'S5 별빛' }), /S<n> alias/u],
    ['blank line', body({ 5: 'S5\n' }), /S<n> alias/u],
    ['untrimmed candidate', body({ 5: 'S5\t 별빛' }), /non-empty trimmed string/u],
    ['carriage return', body().replace(/\n/gu, '\r\n'), /line breaks only/u],
  ];
  for (const [name, text, pattern] of cases) {
    await assert.rejects(save(text), pattern, name);
    await assert.rejects(readFile(savedPath, 'utf8'), { code: 'ENOENT' }, `${name} must not write a chunk`);
  }
  await assert.rejects(save(body(), 99), /outside this batch/u);
});

test('compact save treats empty fields as no candidates and removes only invalid values from the same answer', async (t) => {
  const context = await setup(t);
  await prepare(context, 50);
  const view = await readCandidateChunkCompact({ scratchDirectory: context.scratchDirectory, chunk: 1, repositoryDirectory: context.repositoryDirectory });
  const senseLines = view.text.split('\n').filter((line) => /^S[1-9]\d*\t/u.test(line));
  const aliases = senseLines.map((line) => line.split('\t', 1)[0]);
  const lemmaByAlias = new Map(senseLines.map((line) => { const [alias, , lemma] = line.split('\t'); return [alias, lemma]; }));
  const selfRepeatAliases = new Set(['S4', 'S13', 'S37', 'S46']);
  const lines = ['chunk 001', ...aliases.map((alias) => alias === 'S15' ? 'S15\t' : alias === 'S33' ? 'S33\t' : alias === 'S2' ? 'S2\t夜\t夜\t\t光' : selfRepeatAliases.has(alias) ? `${alias}\t${lemmaByAlias.get(alias)}` : alias)];
  const inputPath = path.join(context.scratchDirectory, 'blank-fields.tsv');
  await mkdir(context.scratchDirectory, { recursive: true });
  await writeFile(inputPath, `${lines.join('\n')}\n`);
  const result = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, format: 'compact', repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual([result.recordCount, result.senseCount, result.candidateCount], [50, 51, 2]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.autoRemoved.count, 8);
  assert.deepEqual(result.autoRemoved.items.filter((item) => item.alias === 'S15' || item.alias === 'S33').map((item) => [item.alias, item.candidate]), [['S15', ''], ['S33', '']]);
  assert.deepEqual(result.autoRemoved.items.filter((item) => item.alias === 'S2').map((item) => item.reason), ['normalized duplicate', 'empty candidate field']);
  assert.deepEqual(result.autoRemoved.items.filter((item) => selfRepeatAliases.has(item.alias)).map((item) => [item.alias, item.candidate, item.reason]),
    [...selfRepeatAliases].map((alias) => [alias, lemmaByAlias.get(alias), 'source lemma repeat']));
  const saved = (await readFile(path.join(context.scratchDirectory, 'candidates/chunk-001.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const candidates = new Map(saved.flatMap((row) => row.senses.map((sense) => [sense.sense_id, sense.candidates])));
  assert.deepEqual(candidates.get(view.text.split('\n').find((line) => line.startsWith('S15\t')).split('\t')[1]), []);
  assert.deepEqual(candidates.get(view.text.split('\n').find((line) => line.startsWith('S33\t')).split('\t')[1]), []);
  assert.deepEqual(candidates.get(view.text.split('\n').find((line) => line.startsWith('S2\t')).split('\t')[1]), ['夜', '光']);
  for (const alias of selfRepeatAliases) {
    assert.deepEqual(candidates.get(view.text.split('\n').find((line) => line.startsWith(`${alias}\t`)).split('\t')[1]), []);
  }
  for (let number = 2; number <= 10; number += 1) {
    const start = (number - 1) * 50;
    const input = await writeInput(context, rowsFor(context.canonicalRows, start, start + 50), `empty-${number}.jsonl`);
    await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: number, inputPath: input, repositoryDirectory: context.repositoryDirectory });
  }
  const merged = await mergeCandidateBatch({
    scratchDirectory: context.scratchDirectory,
    outPath: path.join(context.scratchDirectory, 'merged.jsonl'),
    repositoryDirectory: context.repositoryDirectory,
  });
  assert.deepEqual(merged.validation, { recordCount: 500, senseCount: 501, candidateCount: 2, emptySenseCount: 500 });
});

test('compact save-chunk allows an independent compound of the source lemma and a separate Canonical lemma', async (t) => {
  const context = await setup(t);
  context.canonicalRows[3].lemma = '건축';
  context.canonicalRows[4].lemma = '건축가';
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context, 25);
  const inputPath = path.join(context.scratchDirectory, 'answer.tsv');
  const lines = ['chunk 001', ...Array.from({ length: 26 }, (_, index) => (index === 3 ? 'S4\t건축가\t건축 도면' : `S${index + 1}`))];
  await mkdir(context.scratchDirectory, { recursive: true });
  await writeFile(inputPath, `${lines.join('\n')}\n`);
  const result = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, format: 'compact', repositoryDirectory: context.repositoryDirectory });
  assert.equal(result.candidateCount, 2);
});

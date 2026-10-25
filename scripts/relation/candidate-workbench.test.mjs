import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCandidateWorkbenchStdoutWriter,
  inspectCanonicalRecord,
  mergeCandidateBatch,
  patchCandidateSenses,
  prepareCandidateBatch,
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
  assert.deepEqual(before.items[0].canonical_record.senses, context.canonicalRows[0].senses);

  await saveChunk(context, 1, { 'w001-s2': ['밤하늘'] });
  const after = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, limit: 1, repositoryDirectory: context.repositoryDirectory });
  assert.equal(after.saved, true);
  assert.equal(after.next_offset, 1);
  assert.deepEqual(after.items[0].canonical_record.senses.map((sense) => sense.candidates), [[], ['밤하늘']]);
  assert.equal(after.items[0].canonical_record.senses[1].semantic_note, '전체 원문 필드 보존');
});

test('an oversized record is split by sense without losing any sense, and caps stay hard', async (t) => {
  const context = await setup(t);
  context.canonicalRows[0].senses = Array.from({ length: 12 }, (_, index) => ({ id: `w001-s${index + 1}`, pos: 'noun', gloss: '길다. '.repeat(400) }));
  await writeFile(path.join(context.repositoryDirectory, 'data/canonical/stdict-0001.jsonl'), `${context.canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await prepare(context);
  const ids = [];
  for (let offset = 0, more = true; more;) {
    const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, offset, repositoryDirectory: context.repositoryDirectory });
    ids.push(...page.items.filter((item) => item.record_id === 'w001').flatMap((item) => item.canonical_record.senses.map((sense) => sense.id)));
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
    ['duplicate candidate', rowsFor(context.canonicalRows, 0, 25, { 'w001-s1': ['달빛', '달빛'] }), /duplicates candidate/u],
  ];
  for (const [name, rows, expected] of cases) {
    const inputPath = await writeInput(context, rows, 'bad.jsonl');
    await assert.rejects(saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory }), expected, name);
  }
  await assert.rejects(saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 21, inputPath: await writeInput(context, good, 'good.jsonl'), repositoryDirectory: context.repositoryDirectory }), /outside this batch/u);
  const page = await readCandidateChunkPage({ scratchDirectory: context.scratchDirectory, chunk: 1, limit: 1, repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(page.items[0].canonical_record.senses[0].candidates, ['별빛']);
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
  assert.deepEqual(page.items.map((item) => item.canonical_record.senses.flatMap((sense) => sense.candidates)).flat(), ['별빛']);
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
  await saveAll(context, { 1: { 'w001-s1': ['표제어 1'] } });
  const outPath = path.join(context.scratchDirectory, 'must-not-exist.jsonl');
  await assert.rejects(mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory }), /candidate repeats source lemma "표제어 1"/u);
  await assert.rejects(readFile(outPath, 'utf8'), { code: 'ENOENT' });
  const inspected = await inspectCanonicalRecord({ shard: '001', recordId: 'w001', repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(inspected.record.senses, context.canonicalRows[0].senses);
});

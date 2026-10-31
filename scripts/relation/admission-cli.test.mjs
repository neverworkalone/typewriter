import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from './admission-cli.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const relationJsonl = (rows) => serializeRelationJsonl(rows);
const dropJsonl = (rows) => serializeDropJsonl(rows);
const readRelationRows = async (file) => parseRelationJsonl(await readFile(file, 'utf8'), path.basename(file));
const readDropRows = async (file) => parseDropJsonl(await readFile(file, 'utf8'), path.basename(file));
const sortJsonKeys = (value) => Array.isArray(value) ? value.map(sortJsonKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]))
    : value;

async function repository(t, { relations = [], drops = [], malformedBackups = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [
    { id: 'w1', lemma: '가나', senses: [{ id: 'w1-s1', pos: 'noun', gloss: '뜻1' }] },
    { id: 'w2', lemma: '다라', senses: [{ id: 'w2-s1', pos: 'noun', gloss: '뜻2' }] },
    { id: 'w3', lemma: '유일', senses: [{ id: 'w3-s1', pos: 'noun', gloss: '뜻3' }] },
  ];
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await mkdir(path.join(root, 'data/relation-candidates/001'), { recursive: true });
  await mkdir(path.join(root, 'data/relations'), { recursive: true });
  await mkdir(path.join(root, 'data/relation-drops'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  await writeFile(path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl'), jsonl([
    { record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates: ['유일', '새 말', '버릴말', '텍스트'] }] },
    { record_id: 'w2', senses: [{ sense_id: 'w2-s1', candidates: [] }] },
    { record_id: 'w3', senses: [{ sense_id: 'w3-s1', candidates: [] }] },
  ]));
  if (relations.length > 0) await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl(relations));
  if (drops.length > 0) await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), dropJsonl(drops));
  if (malformedBackups) {
    await writeFile(path.join(root, 'data/relations/relation-001-backup.jsonl'), '{historical Relation backup');
    await writeFile(path.join(root, 'data/relation-drops/drop-001-backup.jsonl'), '{historical Drop backup');
  }
  return root;
}

const quiet = async (callback) => {
  const log = console.log;
  console.log = () => {};
  try { return await callback(); } finally { console.log = log; }
};
const texts = (payload) => payload.items.flatMap((item) => item.candidates.map((candidate) => candidate.text)).sort();

async function completeOptionalForTest(root, checkpoint) {
  const checkpointPath = path.join(root, checkpoint);
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  if (saved.optional_review_complete === true) return;
  const view = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--optional'], { root }));
  if (view.links.length === 0) {
    await quiet(() => run(['complete-optional', '--checkpoint', checkpoint], { root }));
    return;
  }
  const input = '.warroom-scratch/test-optional-decisions.txt';
  await mkdir(path.dirname(path.join(root, input)), { recursive: true });
  await writeFile(path.join(root, input), `links @${view.digest}\n${view.links.map((_, index) => `c${index + 1} skip`).join('\n')}\n`);
  await quiet(() => run(['save-optional', '--checkpoint', checkpoint, '--in', input], { root }));
}

async function mergeForTest(root, checkpoint) {
  await completeOptionalForTest(root, checkpoint);
  return quiet(() => run(['merge', '--checkpoint', checkpoint], { root }));
}

async function sixCandidateRepository(t) {
  const root = await repository(t);
  const records = (await readFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const sourceCandidates = ['첫 이미지', '저녁 산책', '먼 바다', '푸른 기척', '잔잔한 빛', '오래된 노래'];
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    const isOwner = producer === 'a_codex';
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record) => ({
      record_id: record.id,
      senses: record.senses.map((sense) => ({ sense_id: sense.id,
        candidates: isOwner && record.id === 'w1' ? sourceCandidates : [] })),
    }))));
  }
  return { root, sourceCandidates };
}

async function saveAllPrimaryAsDrops(root, checkpoint) {
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const decisions = chunk.items.flatMap((item) => item.candidates.map((candidate) => ({
    source_sense_id: item.sense_id, candidate: candidate.text, disposition: 'drop', reason: '출발 의미와 무관',
  })));
  const input = '.warroom-scratch/primary-decisions.json';
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root }));
}

async function prepareSixPart(t, { emptyRelation = false } = {}) {
  const { root, sourceCandidates } = await sixCandidateRepository(t);
  if (emptyRelation) await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), '');
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  // These fixture-based tests predate #2309; omit the marker to exercise legacy asymmetric checkpoint behavior.
  delete prepared.type_tier_policy;
  await writeFile(path.join(root, checkpoint), `${JSON.stringify(prepared)}\n`);
  assert.equal(prepared.complete, true);
  return { root, checkpoint, sourceCandidates };
}

async function fileState(file) {
  try {
    return { exists: true, bytes: await readFile(file), mtimeMs: (await stat(file)).mtimeMs };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { exists: false, bytes: null, mtimeMs: null };
  }
}

test('CLI entrypoint prepares a Part without an injected repository root', async (t) => {
  const scratchDirectory = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const root = await mkdtemp(path.join(scratchDirectory, 'admission-cli-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const relationScriptDirectory = path.join(root, 'scripts/relation');
  const buildScriptDirectory = path.join(root, 'scripts/build');
  const runtimeDirectory = path.join(root, 'src/runtime');
  for (const directory of [
    relationScriptDirectory,
    buildScriptDirectory,
    runtimeDirectory,
    path.join(root, 'data/canonical'),
    path.join(root, 'data/relation-candidates/001'),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  for (const file of ['admission-cli.mjs', 'admission.mjs', 'candidate-contract.mjs', 'persisted-jsonl.mjs']) {
    await copyFile(path.join(REPOSITORY_DIRECTORY, 'scripts/relation', file), path.join(relationScriptDirectory, file));
  }
  await copyFile(
    path.join(REPOSITORY_DIRECTORY, 'scripts/build/gloss-arrow-reference.mjs'),
    path.join(buildScriptDirectory, 'gloss-arrow-reference.mjs'),
  );
  await copyFile(
    path.join(REPOSITORY_DIRECTORY, 'src/runtime/dictionary-contract.js'),
    path.join(runtimeDirectory, 'dictionary-contract.js'),
  );

  const records = Array.from({ length: 500 }, (_, index) => ({
    id: `w${index + 1}`,
    lemma: `표제${index + 1}`,
    senses: [{ id: `w${index + 1}-s1`, pos: 'noun', gloss: `뜻${index + 1}` }],
  }));
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record, index) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' && index === 200 ? ['독립후보'] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-03.json';
  const result = spawnSync(process.execPath, [
    path.join(relationScriptDirectory, 'admission-cli.mjs'),
    'prepare', '--shard', '001', '--batch', '01', '--part', '03', '--checkpoint', checkpoint,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /fileURLToPath is not defined/u);
  const prepared = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  assert.deepEqual(texts(prepared), ['독립후보']);
});

test('prepare re-run offers only undecided candidates: this shard\'s own approved relations and Drops count as decided', async (t) => {
  const none = await repository(t);
  const first = await quiet(() => run(['prepare', '--shard', '001', '--allow-partial'], { root: none }));
  assert.deepEqual(texts(first), ['버릴말', '새 말', '유일', '텍스트']);

  const decided = await repository(t, {
    relations: [
      { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w3', target_sense_id: 'w3-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2 },
      { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '텍스트', type: 'scene', relevance: 4 },
    ],
    drops: [{ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '버릴말', reason: '무관' }],
  });
  const again = await quiet(() => run(['prepare', '--shard', '001', '--allow-partial'], { root: decided }));
  assert.deepEqual(texts(again), ['새 말']);
  assert.equal(again.stats.skipped_existing, 2);
  assert.equal(again.stats.skipped_dropped, 1);
});

test('Stage 2 loaders ignore malformed historical Relation and Drop backups', async (t) => {
  const root = await repository(t, { malformedBackups: true });
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--allow-partial'], { root }));
  assert.deepEqual(texts(prepared), ['버릴말', '새 말', '유일', '텍스트']);
});

test('Part merge refuses a checkpoint prepared with incomplete Stage 1 inputs', async (t) => {
  const root = await repository(t);
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01', '--allow-partial'], { root }));
  assert.equal(prepared.complete, false);
  await assert.rejects(
    () => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })),
    /Stage 1 inputs are incomplete for this Part/,
  );
});

test('Stage 2 loaders reject verbose persisted Relation and Drop fields without rewriting the files', async (t) => {
  const root = await repository(t);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const oldRelation = `${JSON.stringify({
    source_record_id: 'w1', source_sense_id: 'w1-s1', text: '새 말', type: 'scene', relevance: 4,
  })}\n`;
  await writeFile(relationPath, oldRelation);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--allow-partial'], { root })), /obsolete Relation JSONL field/u);
  assert.equal(await readFile(relationPath, 'utf8'), oldRelation);

  await rm(relationPath);
  const oldDrop = `${JSON.stringify({
    source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '버릴말', reason: '무관',
  })}\n`;
  await writeFile(dropPath, oldDrop);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--allow-partial'], { root })), /obsolete Drop JSONL field/u);
  assert.equal(await readFile(dropPath, 'utf8'), oldDrop);
});

test('--batch scopes prepare/verify to one 500-record batch: its own producers, records and rows', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 501 }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const batchRows = (rows, extra = {}) => rows.map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: extra[record.id] ?? [] }] }));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(batchRows(records.slice(0, 500), name === 'a_codex' ? { w1: ['새 말'] } : {})));
  }
  const args = (command, ...more) => [command, '--shard', '001', '--batch', '01', ...more];

  // Batch 02 has no producers yet: shard-wide runs refuse, the batch-01 run is complete.
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001'], { root })), /incomplete/);
  const prepared = await quiet(() => run(args('prepare'), { root }));
  assert.equal(prepared.complete, true);
  assert.deepEqual(texts(prepared), ['새 말']);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--batch', '02'], { root })), /incomplete/);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--batch', '03'], { root })), /--batch must be 01 or 02/);

  // A conflicting (two C producers) or unparseable batch-02 file never blocks batch 01, but a shard-wide run still refuses it.
  await writeFile(path.join(root, 'data/relation-candidates/001/001_02_c_codex.jsonl'), '{not json');
  await writeFile(path.join(root, 'data/relation-candidates/001/001_02_c_claude.jsonl'), '');
  assert.deepEqual(texts(await quiet(() => run(args('prepare'), { root }))), ['새 말']);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001'], { root })), /more than one C producer/);
  await rm(path.join(root, 'data/relation-candidates/001/001_02_c_codex.jsonl'));
  await rm(path.join(root, 'data/relation-candidates/001/001_02_c_claude.jsonl'));

  // Nothing authored yet: the candidate is unaccounted. A row for it makes batch 01 valid; a batch-02 row is not this run's concern.
  await assert.rejects(() => quiet(() => run(args('verify'), { root })), /has no relation, drop or existing/);
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '새 말', type: 'scene', relevance: 4 },
    { source_record_id: 'w501', source_sense_id: 'w501-s1', text: '이월 말', type: 'scene', relevance: 4 },
  ]));
  const counts = await quiet(() => run(args('verify'), { root }));
  assert.equal(counts.relation, 1);
  assert.equal(counts.missing, 0);
});

test('--part selects 100-record Stage 2 scopes, reports scoped stats, and keeps full batch validation/accounting', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 1000 }, (_, i) => ({
    id: `w${i + 1}`,
    lemma: `표제${i + 1}`,
    senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }],
  }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));

  const candidatesById = new Map();
  for (let first = 1; first <= 1000; first += 100) {
    candidatesById.set(`w${first}`, [`후보${first}`]);
    candidatesById.set(`w${first + 99}`, [`후보${first + 99}`]);
  }
  candidatesById.set('w1', ['표제101', '후보1']);
  candidatesById.set('w101', ['표제1', '후보101']);

  for (const batch of ['01', '02']) {
    const offset = (Number(batch) - 1) * 500;
    const batchRecords = records.slice(offset, offset + 500);
    for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
      const candidateRows = batchRecords.map((record) => {
        let candidates = producer === 'a_codex' ? candidatesById.get(record.id) ?? [] : [];
        if (batch === '01' && producer === 'a_claude' && record.id === 'w1') candidates = ['후보1'];
        return { record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates }] };
      });
      await writeFile(path.join(root, `data/relation-candidates/001/001_${batch}_${producer}.jsonl`), jsonl(candidateRows));
    }
  }

  for (const batch of ['01', '02']) {
    const batchOffset = (Number(batch) - 1) * 500;
    for (let part = 1; part <= 5; part += 1) {
      const first = batchOffset + (part - 1) * 100 + 1;
      const last = Math.min(first + 99, records.length);
      const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', batch, '--part', String(part).padStart(2, '0')], { root }));
      assert.equal(prepared.complete, true);
      assert.equal(prepared.batch, batch);
      assert.equal(prepared.part, String(part).padStart(2, '0'));
      assert.deepEqual(prepared.items.map((item) => item.record_id), [`w${first}`, `w${last}`]);
      assert.deepEqual(texts(prepared), [...(candidatesById.get(`w${first}`) ?? []), ...(candidatesById.get(`w${last}`) ?? [])].sort());
      const duplicates = batch === '01' && part === 1 ? 1 : 0;
      const raw = (candidatesById.get(`w${first}`)?.length ?? 0) + (candidatesById.get(`w${last}`)?.length ?? 0) + duplicates;
      assert.equal(prepared.stats.raw, raw);
      assert.equal(prepared.stats.unique, raw - duplicates);
      assert.equal(prepared.stats.merged_duplicates, duplicates);
    }
  }

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '후보1', type: 'scene', relevance: 4 },
    { source_record_id: 'w101', source_sense_id: 'w101-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 },
    { source_record_id: 'w200', source_sense_id: 'w200-s1', text: '후보200', type: 'scene', relevance: 4 },
  ]));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), dropJsonl([
    { source_record_id: 'w100', source_sense_id: 'w100-s1', candidate: '후보100', reason: '출발 의미와 무관' },
    { source_record_id: 'w101', source_sense_id: 'w101-s1', candidate: '후보101', reason: '출발 의미와 무관' },
  ]));

  await assert.rejects(
    () => quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root })),
    /checkpoint is incomplete or not merged/,
    'a Stage 2 Part cannot be verified after bypassing per-candidate decisions',
  );

  const initialRelations = [
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '후보1', type: 'scene', relevance: 4 },
    { source_record_id: 'w101', source_sense_id: 'w101-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 },
    { source_record_id: 'w200', source_sense_id: 'w200-s1', text: '후보200', type: 'scene', relevance: 4 },
  ];
  const laterRelations = [];
  for (const recordId of ['w201', 'w300', 'w301', 'w400', 'w401', 'w500', 'w501', 'w600', 'w601', 'w700', 'w701', 'w800', 'w801', 'w900', 'w901', 'w1000']) {
    laterRelations.push({ source_record_id: recordId, source_sense_id: `${recordId}-s1`, text: `후보${recordId.slice(1)}`, type: 'scene', relevance: 4 });
  }
  const reverseConflict = {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w101', target_sense_id: 'w101-s1',
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([...initialRelations, reverseConflict, ...laterRelations]));
  await assert.rejects(
    () => quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root })),
    /reverse-duplicate ID relation/,
    'Part verification keeps shard-wide reverse-duplicate checks',
  );
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([...initialRelations, ...laterRelations]));

  const wholeBatch = await quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  assert.deepEqual([wholeBatch.unique, wholeBatch.relation, wholeBatch.drop, wholeBatch.reverse_covered, wholeBatch.missing], [12, 9, 2, 1, 0]);
  const wholeShard = await quiet(() => run(['verify', '--shard', '001'], { root }));
  assert.deepEqual([wholeShard.unique, wholeShard.relation, wholeShard.drop, wholeShard.reverse_covered, wholeShard.missing], [22, 19, 2, 1, 0]);
});

test('--part requires a batch, rejects out-of-range parts, and allows the final 83-record Stage 1 batch only as Part 01', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-final-part-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 583 }, (_, i) => ({
    id: `w${i + 1}`,
    lemma: `표제${i + 1}`,
    senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }],
  }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const finalBatchRows = records.slice(500).map((record) => ({
    record_id: record.id,
    senses: [{ sense_id: record.senses[0].id, candidates: record.id === 'w583' ? ['끝배치후보'] : [] }],
  }));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_02_${producer}.jsonl`), jsonl(finalBatchRows));
  }

  const finalPart = await quiet(() => run(['prepare', '--shard', '001', '--batch', '02', '--part', '01'], { root }));
  assert.equal(finalPart.complete, true);
  assert.deepEqual(finalPart.items.map((item) => item.record_id), ['w583']);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--batch', '02', '--part', '02'], { root })), /batch 02 has no records for part 02/);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--part', '01'], { root })), /--part requires --batch/);
  await assert.rejects(() => quiet(() => run(['verify', '--shard', '001', '--batch', '02', '--part', '06'], { root })), /--part must be 01, 02, 03, 04 or 05/);
  await assert.rejects(() => quiet(() => run(['prepare', '--shard', '001', '--batch', '02', '--part', '01', '--out', 'part.json'], { root })), /use --checkpoint instead of --out/);
});

test('an exact ID row owned by the other batch answers this batch\'s reverse candidate despite homographs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-xbatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 502 }, (_, i) => ({
    id: `w${i + 1}`,
    lemma: i === 500 || i === 501 ? '표제501' : `표제${i + 1}`,
    senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }],
  }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.slice(0, 500).map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: name === 'a_codex' && record.id === 'w1' ? ['표제501'] : [] }] }))));
  }
  // The valid ID link is owned by batch 02 (w501 -> w1); its reverse is batch 01's candidate.
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([
    { source_record_id: 'w501', source_sense_id: 'w501-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2 },
  ]));
  const args = (command) => [command, '--shard', '001', '--batch', '01'];
  const prepared = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(prepared), []);
  assert.equal(prepared.stats.skipped_existing, 1);
  const counts = await quiet(() => run(args('verify'), { root }));
  assert.equal(counts.missing, 0);
  assert.equal(counts.reverse_covered, 1);
});

test('a batch with no candidates and no authored rows is complete once verify succeeds', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 3 }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: [] }] }))));
  }
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.drop, counts.missing], [0, 0, 0, 0]);
});

test('a reverse candidate cannot also be a Drop or a text-only row, but may target a different sense', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 501 }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }, ...(i === 500 ? [{ id: 'w501-s2', pos: 'noun', gloss: '다른 뜻' }] : [])] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) await mkdir(path.join(root, dir), { recursive: true });
  records[0].senses[0].gloss = '뜻1은 무관 말과 짝지어 쓴다';
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.slice(0, 500).map((record) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: name === 'a_codex' && record.id === 'w1' ? ['표제501', '다른 말', '무관 말'] : [] }],
    }))));
  }
  const idRow = { source_record_id: 'w501', source_sense_id: 'w501-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2 };
  const otherSenseRow = { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w501', target_sense_id: 'w501-s2', type: 'scene', relevance: 4, reverse_type: 'scene', reverse_relevance: 4 };
  const other = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '다른 말', type: 'scene', relevance: 4 };
  const named = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '무관 말', type: 'scene', relevance: 5 };
  const dropOf = (candidate) => ({ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate, reason: '무관' });
  const verify = async (relations, drops) => {
    await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl(relations));
    await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), drops.length ? dropJsonl(drops) : '');
    return quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([idRow]));
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01'], { root }));
  assert.ok(!texts(prepared).includes('표제501'), 'an existing reverse link accounts for the candidate without requiring another target-sense link');
  // Positive control: the reverse answers 표제501; 다른 말 is authored once.
  assert.equal((await verify([idRow, other, named], [])).reverse_covered, 1);
  // The same candidate also dropped or also authored text-only is a double disposition.
  await assert.rejects(() => verify([idRow, other, named], [dropOf('표제501')]), /reverse of a stored ID pair .* cannot also be a drop/);
  await assert.rejects(() => verify([idRow, other, named, { ...other, text: '표제501' }], []), /cannot also be a text-only relation/);
  // The same spelling may have a separate ID relation to another sense; only the actual sense pair is duplicate.
  assert.equal((await verify([idRow, otherSenseRow, other, named], [])).missing, 0);
  await assert.rejects(() => verify([idRow, { ...otherSenseRow, target_sense_id: 'w501-s1' }, other, named], []), /duplicate or reverse-duplicate ID relation/);
  // A different candidate of the same sense may still be dropped normally.
  assert.equal((await verify([idRow, named], [dropOf('다른 말')])).drop, 1);
  // A candidate the source gloss itself names is evidence of relevance, so it cannot be dropped as unrelated.
  await assert.rejects(() => verify([idRow, other], [dropOf('무관 말')]), /named by the gloss of w1-s1 and cannot be dropped/);
});

test('verify CLI rejects direct plural mentions in current shard-002 glosses but allows compound substrings', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-plural-gloss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [
    { id: 'w828', lemma: '가로 자리표', senses: [{ id: 'w828-s1', pos: 'expression', gloss: '좌표를 구성하는 수들 가운데에서 가로 방향으로 어떤 점의 위치를 지시하는 좌표.' }] },
    { id: 'w933', lemma: '가대기', senses: [{ id: 'w933-s1', pos: 'noun', gloss: '창고나 부두 따위에서, 인부들이 쌀가마니 따위의 무거운 짐을 갈고리로 찍어 당겨서 어깨에 메고 나르는 일. 또는 그 짐.' }] },
    { id: 'w999', lemma: '나무', senses: [{ id: 'w999-s1', pos: 'noun', gloss: '들판과 떡갈나무가 보인다.' }] },
  ];
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relation-drops']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  await writeFile(path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl'), jsonl([
    { record_id: 'w828', senses: [{ sense_id: 'w828-s1', candidates: ['수'] }] },
    { record_id: 'w933', senses: [{ sense_id: 'w933-s1', candidates: ['인부'] }] },
    { record_id: 'w999', senses: [{ sense_id: 'w999-s1', candidates: ['들', '떡'] }] },
  ]));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), dropJsonl([
    { source_record_id: 'w828', source_sense_id: 'w828-s1', candidate: '수', reason: '무관' },
    { source_record_id: 'w933', source_sense_id: 'w933-s1', candidate: '인부', reason: '무관' },
    { source_record_id: 'w999', source_sense_id: 'w999-s1', candidate: '들', reason: '무관' },
    { source_record_id: 'w999', source_sense_id: 'w999-s1', candidate: '떡', reason: '무관' },
  ]));

  await assert.rejects(() => quiet(() => run(['verify', '--shard', '001', '--allow-partial'], { root })), (error) => {
    assert.match(error.message, /"수" is named by the gloss of w828-s1/);
    assert.match(error.message, /"인부" is named by the gloss of w933-s1/);
    assert.doesNotMatch(error.message, /"들" is named by the gloss of w999-s1/);
    assert.doesNotMatch(error.message, /"떡" is named by the gloss of w999-s1/);
    return true;
  });
});

test('an existing ID relation accounts for a candidate even when another target sense is unlinked', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-search-form-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [
    { id: 'w1', lemma: '가감 저항기', search_forms: ['가감 저항기', '가감저항기'], senses: [{ id: 'w1-s1', pos: 'expression', gloss: '저항값을 변화하게 한다. 미끄럼 저항기가 있다.' }] },
    { id: 'w2', lemma: '미끄럼 저항기', search_forms: ['미끄럼 저항기', '미끄럼저항기'], senses: [
      { id: 'w2-s1', pos: 'expression', gloss: '저항을 조절하는 기기.' },
      { id: 'w2-s2', pos: 'expression', gloss: '별도 sense.' },
    ] },
  ];
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl([
      { record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates: producer === 'a_codex' ? ['미끄럼저항기'] : [] }] },
      { record_id: 'w2', senses: [{ sense_id: 'w2-s1', candidates: [] }, { sense_id: 'w2-s2', candidates: [] }] },
    ]));
  }
  const link = (targetSense) => ({
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: targetSense,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  });
  const args = (command) => [command, '--shard', '001', '--allow-partial'];
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([link('w2-s1')]));

  const partiallyLinked = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(partiallyLinked), [], 'an existing ID relation already accounts for the source candidate');
  assert.equal(partiallyLinked.stats.skipped_existing, 1);
  assert.equal((await quiet(() => run(args('verify'), { root }))).missing, 0, 'the ID relation answers its orthographic alias');

  const partCheckpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const partPrepared = await quiet(() => run([
    'prepare', '--shard', '001', '--batch', '01', '--part', '01',
  ], { root }));
  assert.deepEqual(texts(partPrepared), ['미끄럼저항기']);
  assert.equal(partPrepared.stats.to_edit, 0, 'pre-accounted target candidates do not require a new decision');
  assert.deepEqual(partPrepared.items[0].candidates[0].decision, { disposition: 'existing' });
  assert.deepEqual(partPrepared.items[0].candidates[0].unlinked_target_sense_ids, ['w2-s2']);
  const complete = await quiet(() => run(['read-chunk', '--checkpoint', partCheckpoint], { root }));
  assert.equal(complete.complete, true, 'the Part completes without an additional ID link');
  assert.deepEqual(complete.optional_links, [{
    source_sense_id: 'w1-s1', candidate: '미끄럼저항기', existing_target_sense_ids: ['w2-s1'], unlinked_target_sense_ids: ['w2-s2'],
  }]);
  await mergeForTest(root, partCheckpoint);
  const accountedPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(accountedPart.missing, 0);
  await rm(path.join(root, partCheckpoint));
  await Promise.all(['.premerge-relations.jsonl', '.premerge-drops.jsonl'].map((suffix) =>
    rm(path.join(root, '.warroom-scratch/relation-admission-001-01-01' + suffix), { force: true })));

  await quiet(() => run([
    'prepare', '--shard', '001', '--batch', '01', '--part', '01',
  ], { root }));
  const optional = await quiet(() => run([
    'read-chunk', '--checkpoint', partCheckpoint, '--source-sense-id', 'w1-s1', '--candidate', '미끄럼저항기',
  ], { root }));
  assert.deepEqual(optional.items[0].candidates[0].unlinked_target_sense_ids, ['w2-s2']);
  const additionalLink = {
    source_sense_id: 'w1-s1', candidate: '미끄럼저항기', disposition: 'relation', target_resolution: 'exact',
    target_record_id: 'w2', target_sense_id: 'w2-s2', type: 'scene', relevance: 4,
  };
  const optionalInput = '.warroom-scratch/optional-link.json';
  const duplicateLink = { ...additionalLink, target_sense_id: 'w2-s1' };
  await writeFile(path.join(root, optionalInput), JSON.stringify({ chunk_id: optional.chunk_id, decisions: [duplicateLink] }));
  await assert.rejects(
    () => quiet(() => run(['save-chunk', '--checkpoint', partCheckpoint, '--in', optionalInput], { root })),
    /optional link must choose a not-yet-linked target sense/u,
  );
  await writeFile(path.join(root, optionalInput), JSON.stringify({ chunk_id: optional.chunk_id, decisions: [additionalLink] }));
  await quiet(() => run(['save-chunk', '--checkpoint', partCheckpoint, '--in', optionalInput], { root }));
  await mergeForTest(root, partCheckpoint);
  const linkedPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(linkedPart.missing, 0, 'a separately chosen relation to the other target sense is retained');
  assert.equal(linkedPart.relation, 2);

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), '');
  const newDecisionNeeded = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(newDecisionNeeded), ['미끄럼저항기'], 'without an existing link, the full target sense context remains available for a new relation decision');

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([link('w2-s1'), link('w2-s2')]));
  const fullyLinked = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(fullyLinked), [], 'a unique target with all senses linked is existing coverage');
  assert.equal(fullyLinked.stats.skipped_existing, 1);

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), '');
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), dropJsonl([
    { source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '미끄럼저항기', reason: '출발 의미와 무관' },
  ]));
  await assert.rejects(() => quiet(() => run(args('verify'), { root })), /"미끄럼저항기" is named by the gloss of w1-s1 and cannot be dropped as unrelated/);
});

async function chunkRepository(t, base = tmpdir()) {
  const root = await mkdtemp(path.join(base, 'typewriter-admission-chunks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 504 }, (_, index) => ({
    id: `w${index + 1}`,
    lemma: `표제${index + 1}`,
    senses: [{ id: `w${index + 1}-s1`, pos: 'noun', gloss: `뜻${index + 1}` }],
  }));
  records[0] = { id: 'w1', lemma: '출발어', senses: [{ id: 'w1-s1', pos: 'noun', gloss: '출발 의미' }] };
  records[500] = { id: 'w501', lemma: '유일표적', senses: [
    { id: 'w501-s1', pos: 'noun', gloss: '후보의 정확한 뜻' },
    { id: 'w501-s2', pos: 'noun', gloss: '표기가 같은 다른 뜻' },
  ] };
  records[501] = { id: 'w502', lemma: '겹표기', senses: [{ id: 'w502-s1', pos: 'noun', gloss: '동음이의어 첫 뜻' }] };
  records[502] = { id: 'w503', lemma: '겹표기', senses: [{ id: 'w503-s1', pos: 'verb', gloss: '동음이의어 둘째 뜻' }] };
  records[503] = { id: 'w504', lemma: '역방향표적', senses: [{ id: 'w504-s1', pos: 'noun', gloss: '이미 연결된 뜻' }] };
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const candidateRows = (batchRecords, producer) => batchRecords.map((record) => ({
    record_id: record.id,
    senses: [{
      sense_id: record.senses[0].id,
      candidates: producer !== 'a_codex' ? [] : record.id === 'w1'
        ? ['유일표적', '겹표기', '낯선말', '버릴말', '역방향표적']
        : record.id === 'w2' ? ['두번째표현']
          : record.id === 'w101' ? ['오직텍스트']
          : record.id === 'w201' ? ['유일표적']
            : record.id === 'w301' ? ['이전Drop'] : [],
    }],
  }));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(candidateRows(records.slice(0, 500), producer)));
  }
  const priorRelation = {
    source_record_id: 'w201', source_sense_id: 'w201-s1', target_record_id: 'w501', target_sense_id: 'w501-s1',
    type: 'association', relevance: 7, reverse_type: 'association', reverse_relevance: 7,
  };
  const priorDrop = { source_record_id: 'w301', source_sense_id: 'w301-s1', candidate: '이전Drop', reason: '다른 sense에서만 맞는 표현' };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([priorRelation]));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), dropJsonl([priorDrop]));
  await writeFile(path.join(root, 'data/relations/relation-002.jsonl'), relationJsonl([{
    source_record_id: 'w504', source_sense_id: 'w504-s1', target_record_id: 'w1', target_sense_id: 'w1-s1',
    type: 'scene', relevance: 2, reverse_type: 'scene', reverse_relevance: 2,
  }]));
  return { root, priorRelation, priorDrop };
}

test('Stage 2 blocks missing source glosses during preparation and when resuming an old checkpoint', async (t) => {
  const scratchRoot = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchRoot, { recursive: true });

  const broken = await chunkRepository(t, scratchRoot);
  const canonicalPath = path.join(broken.root, 'data/canonical/stdict-0001.jsonl');
  const canonicalRows = (await readFile(canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const originalSource = canonicalRows[0];
  for (const gloss of ['→ .', '', '→ 다른 표제어.', '→ 다른 표제어[Ⅱ].']) {
    canonicalRows[0] = { ...originalSource, senses: originalSource.senses.map((sense) => ({ ...sense, gloss })) };
    await writeFile(canonicalPath, jsonl(canonicalRows));
    await assert.rejects(
      () => quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root: broken.root })),
      /Stage 2 source sense w1-s1 has no usable meaning gloss/u,
    );
    await assert.rejects(readFile(path.join(broken.root, '.warroom-scratch/relation-admission-001-01-01.json')), { code: 'ENOENT' });
  }

  // A reference-only gloss whose target is proven (here `유일표적`, one record) carries the target's meaning (Issue #2031).
  canonicalRows[0] = { ...originalSource, senses: originalSource.senses.map((sense) => ({ ...sense, gloss: '→ 유일표적.' })) };
  await writeFile(canonicalPath, jsonl(canonicalRows));
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root: broken.root }));
  const referenced = await quiet(() => run(['read-chunk', '--checkpoint', '.warroom-scratch/relation-admission-001-01-01.json', '--format', 'compact'], { root: broken.root }));
  assert.match(referenced.text, /S\tw1-s1\tw1\t출발어\tnoun\t→ 유일표적\. ⇒ 후보의 정확한 뜻 \/ 표기가 같은 다른 뜻\t/u);

  // A proven target that itself has only arrow glosses (valid, target-less or malformed) gives no meaning: still blocked.
  for (const targetGloss of ['→ .', '→ 다른말.', '→']) {
    const rows = (await readFile(canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const target = rows.find((row) => row.id === 'w501');
    target.senses = target.senses.map((sense) => ({ ...sense, gloss: targetGloss }));
    await writeFile(canonicalPath, jsonl(rows));
    await rm(path.join(broken.root, '.warroom-scratch/relation-admission-001-01-01.json'), { force: true });
    await assert.rejects(
      () => quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root: broken.root })),
      /Stage 2 source sense w1-s1 has no usable meaning gloss/u,
      targetGloss,
    );
  }

  const legacy = await chunkRepository(t, scratchRoot);
  const checkpointPath = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root: legacy.root }));
  const readable = await quiet(() => run(['read-chunk', '--checkpoint', checkpointPath, '--format', 'compact'], { root: legacy.root }));
  assert.match(readable.text, /S\tw1-s1\tw1\t출발어\tnoun\t출발 의미\t/u, 'a source gloss with a meaning still reaches the chunk');
  const absoluteCheckpoint = path.join(legacy.root, checkpointPath);
  const checkpoint = JSON.parse(await readFile(absoluteCheckpoint, 'utf8'));
  for (const gloss of ['→ .', '→ 다른 표제어[Ⅱ].']) {
    checkpoint.items[0].gloss = gloss;
    await writeFile(absoluteCheckpoint, `${JSON.stringify(checkpoint)}\n`);
    await assert.rejects(
      () => quiet(() => run(['read-chunk', '--checkpoint', checkpointPath, '--format', 'compact'], { root: legacy.root })),
      /Stage 2 source sense w1-s1 has no usable meaning gloss/u,
    );
  }
});

test('Stage 2 chunks bind exact senses, resume safely, and preserve text-only Parts and prior rows', async (t) => {
  const { root, priorRelation, priorDrop } = await chunkRepository(t);
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(prepared.stats.to_edit, 5, 'the already approved reverse ID candidate is absorbed');
  const resumed = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(resumed.items.length, prepared.items.length, 'prepare resumes the checkpoint instead of replacing it');
  assert.deepEqual(resumed.items[0].approved_peers, [{
    target_lemma: '역방향표적', target_sense_id: 'w504-s1', target_pos: 'noun', target_gloss: '이미 연결된 뜻', type: 'scene', relevance: 2,
  }], 'approved reverse peers use the stored source type and relevance');

  const first = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '2'], { root }));
  const retry = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '2'], { root }));
  assert.equal(retry.chunk_id, first.chunk_id, 'an unsaved chunk is returned unchanged after interruption');
  assert.deepEqual(first.items[0].candidates[0].same_spelling_targets, [{
    record_id: 'w501', lemma: '유일표적', senses: [
      { sense_id: 'w501-s1', pos: 'noun', gloss: '후보의 정확한 뜻' },
      { sense_id: 'w501-s2', pos: 'noun', gloss: '표기가 같은 다른 뜻' },
    ],
  }]);
  assert.deepEqual(first.items[0].candidates[1].same_spelling_targets.map((target) => target.senses[0].sense_id), ['w502-s1', 'w503-s1']);

  const input = '.warroom-scratch/001_01_01.decisions.json';
  const exact = {
    source_sense_id: 'w1-s1', candidate: '유일표적', disposition: 'relation', target_resolution: 'exact',
    target_record_id: 'w501', target_sense_id: 'w501-s1',
    type: 'near', relevance: 1,
  };
  const ambiguousText = {
    source_sense_id: 'w1-s1', candidate: '겹표기', disposition: 'relation', target_resolution: 'no_exact_match',
    checked_target_sense_ids: ['w502-s1'], type: 'association', relevance: 7,
  };
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: first.chunk_id, decisions: [exact] }));
  await assert.rejects(() => quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root })), /missing decisions/);
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: first.chunk_id, decisions: [exact, exact] }));
  await assert.rejects(() => quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root })), /repeats decision/);
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: first.chunk_id, decisions: [exact, ambiguousText] }));
  await assert.rejects(() => quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root })), /check every same-spelling target sense/);
  await assert.rejects(() => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })), /save the active chunk .* first/);

  ambiguousText.checked_target_sense_ids.push('w503-s1');
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: first.chunk_id, decisions: [exact, ambiguousText] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root }));
  const continued = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '3'], { root }));
  assert.deepEqual(continued.continuation, [
    {
      source_sense_id: 'w1-s1', candidate_start: 2, candidate_end: 4, candidate_total: 4,
      continues_from_previous: true, continues_in_next: false,
    },
    {
      source_sense_id: 'w2-s1', candidate_start: 0, candidate_end: 1, candidate_total: 1,
      continues_from_previous: false, continues_in_next: false,
    },
  ], 'large senses resume exactly while a following complete sense stays intact in the same chunk');
  const noTargetText = {
    source_sense_id: 'w1-s1', candidate: '낯선말', disposition: 'relation', type: 'sensory', relevance: 5,
  };
  const drop = { source_sense_id: 'w1-s1', candidate: '버릴말', disposition: 'drop', reason: '출발 sense와 무관한 임시 표기' };
  const secondSenseText = {
    source_sense_id: 'w2-s1', candidate: '두번째표현', disposition: 'relation', type: 'scene', relevance: 4,
  };
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: continued.chunk_id, decisions: [noTargetText, drop, secondSenseText] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root }));
  assert.equal((await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }))).complete, true);
  const merged = await mergeForTest(root, checkpoint);
  assert.deepEqual([merged.relations_added, merged.drops_added], [4, 1]);
  assert.deepEqual(await mergeForTest(root, checkpoint), {
    merged: true, relations_added: 0, drops_added: 0, already_merged: true, checkpoint: path.join(root, checkpoint),
  }, 'a repeated merge is idempotent');
  assert.ok((await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8')).includes(relationJsonl([priorRelation]).trim()));
  const mixedRelations = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  const newlyAuthored = mixedRelations.find((row) => row.candidate_forms?.includes('유일표적'));
  assert.deepEqual([newlyAuthored.type, newlyAuthored.relevance, newlyAuthored.reverse_type, newlyAuthored.reverse_relevance],
    ['near', 1, 'near', 1], 'a new relation mirrors its source judgment');
  assert.deepEqual(mixedRelations.find((row) => row.source_sense_id === priorRelation.source_sense_id), priorRelation);
  assert.ok((await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8')).includes(dropJsonl([priorDrop]).trim()));
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.drop, counts.skipped_existing, counts.missing], [6, 4, 1, 1, 0]);

  // War Room rechecks completion on a clean latest-master checkout, where the local edit checkpoint is absent.
  await rm(path.join(root, checkpoint));
  const masterCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(masterCounts.missing, 0);

  const textOnlyCheckpoint = '.warroom-scratch/relation-admission-001-01-02.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
  const textOnlyChunk = await quiet(() => run(['read-chunk', '--checkpoint', textOnlyCheckpoint], { root }));
  assert.equal(textOnlyChunk.items.flatMap((item) => item.candidates).length, 1);
  assert.deepEqual(textOnlyChunk.items[0].candidates[0].same_spelling_targets, []);
  const textOnlyDecision = {
    source_sense_id: 'w101-s1', candidate: '오직텍스트', disposition: 'relation', type: 'scene', relevance: 4,
  };
  const textOnlyInput = '.warroom-scratch/001_01_02.decisions.json';
  await writeFile(path.join(root, textOnlyInput), JSON.stringify({ chunk_id: textOnlyChunk.chunk_id, decisions: [textOnlyDecision] }));
  await quiet(() => run(['save-chunk', '--checkpoint', textOnlyCheckpoint, '--in', textOnlyInput], { root }));
  await mergeForTest(root, textOnlyCheckpoint);
  const textOnlyCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
  assert.deepEqual([textOnlyCounts.unique, textOnlyCounts.relation, textOnlyCounts.drop, textOnlyCounts.missing], [1, 1, 0, 0], 'a fully text-only Part remains valid when no exact Canonical target exists');
});

test('merge coalesces consistent source-mirror reciprocal ID decisions into one bidirectional row', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-reciprocal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 500 }, (_, index) => {
    const pair = [
      { id: 'w109230', lemma: '마지' },
      { id: 'w111040', lemma: '말기름' },
      { id: 'w109231', lemma: '마지' },
      { id: 'w109232', lemma: '마지' },
      { id: 'w14296', lemma: '거성' },
      { id: 'w153363', lemma: '불가입성' },
      { id: 'w14297', lemma: '거성' },
      { id: 'w14298', lemma: '거성' },
      { id: 'w200002', lemma: '다른출발' },
      { id: 'w200003', lemma: '다른표적' },
    ][index];
    const id = pair?.id ?? `w${200000 + index}`;
    return {
      id,
      lemma: pair?.lemma ?? `표제${index}`,
      senses: [{ id: `${id}-s1`, pos: 'noun', gloss: index < 4 ? '같은 전체 뜻풀이.' : `뜻${index}` }],
    };
  });
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const producers = ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'];
  const candidates = new Map([
    ['w109230', ['말기름']],
    ['w111040', ['마지']],
    ['w14296', ['불가입성']],
    ['w153363', ['거성']],
    ['w200002', ['다른표적']],
    ['w200003', ['다른출발']],
  ]);
  for (const producer of producers) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' ? candidates.get(record.id) ?? [] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  assert.equal(chunk.items.flatMap((item) => item.candidates).length, 6);
  const decisions = [
    { source_sense_id: 'w109230-s1', candidate: '말기름', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w111040', target_sense_id: 'w111040-s1', type: 'near', relevance: 1 },
    { source_sense_id: 'w111040-s1', candidate: '마지', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w109230', target_sense_id: 'w109230-s1', type: 'near', relevance: 1 },
    { source_sense_id: 'w14296-s1', candidate: '불가입성', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w153363', target_sense_id: 'w153363-s1', type: 'near', relevance: 1 },
    { source_sense_id: 'w153363-s1', candidate: '거성', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w14296', target_sense_id: 'w14296-s1', type: 'near', relevance: 1 },
    { source_sense_id: 'w200002-s1', candidate: '다른표적', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w200003', target_sense_id: 'w200003-s1', type: 'near', relevance: 2 },
    { source_sense_id: 'w200003-s1', candidate: '다른출발', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w200002', target_sense_id: 'w200002-s1', type: 'near', relevance: 2 },
  ];
  const decisionsFile = '.warroom-scratch/reciprocal-decisions.json';
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.deepEqual([merged.relations_added, merged.drops_added], [3, 0]);
  const relations = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  assert.deepEqual(relations, [
    { source_record_id: 'w109230', source_sense_id: 'w109230-s1', target_record_id: 'w111040', target_sense_id: 'w111040-s1', type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 1, candidate_assignment_version: 1, candidate_forms: ['말기름'], reverse_candidate_forms: ['마지'] },
    { source_record_id: 'w14296', source_sense_id: 'w14296-s1', target_record_id: 'w153363', target_sense_id: 'w153363-s1', type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 1, candidate_assignment_version: 1, candidate_forms: ['불가입성'], reverse_candidate_forms: ['거성'] },
    { source_record_id: 'w200002', source_sense_id: 'w200002-s1', target_record_id: 'w200003', target_sense_id: 'w200003-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2, candidate_assignment_version: 1, candidate_forms: ['다른표적'], reverse_candidate_forms: ['다른출발'] },
  ], 'one row mirrors each source judgment across both search directions');
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.reverse_covered, counts.missing], [6, 3, 3, 0]);
  assert.deepEqual(await mergeForTest(root, checkpoint), {
    merged: true, relations_added: 0, drops_added: 0, already_merged: true, checkpoint: path.join(root, checkpoint),
  }, 'merging the same checkpoint again remains idempotent');
  const checkpointPath = path.join(root, checkpoint);
  const conflictingCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const reverseDecision = conflictingCheckpoint.items
    .flatMap((item) => item.candidates)
    .find((candidate) => candidate.decision.source_sense_id === 'w111040-s1').decision;
  reverseDecision.type = 'mood';
  reverseDecision.relevance = 5;
  reverseDecision.reverse_type = 'mood';
  reverseDecision.reverse_relevance = 5;
  await writeFile(checkpointPath, `${JSON.stringify(conflictingCheckpoint)}\n`);
  const approvedBeforeConflict = await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8');
  await assert.rejects(
    () => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })),
    /cannot merge duplicate or reverse-duplicate ID relation/u,
    'reciprocal source judgments that disagree still require resolution instead of silently choosing one',
  );
  assert.equal(await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8'), approvedBeforeConflict);
});

for (const includeTargetAlias of [false, true]) {
  test(`legacy reciprocal merge keeps inferred forms source-bound${includeTargetAlias ? ' with an extra target spelling' : ''}`, async (t) => {
    const scratch = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, 'admission-legacy-reciprocal-'));
    t.after(() => rm(root, { recursive: true, force: true }));

    const records = Array.from({ length: 1000 }, (_, index) => {
      if (index === 0) return { id: 'w1', lemma: '생명 보험 회사', senses: [{ id: 'w1-s1', pos: 'noun', gloss: '생명 보험을 판매하는 회사.' }] };
      if (index === 100) return {
        id: 'w2', lemma: '생명 보험',
        ...(includeTargetAlias ? { search_forms: ['생명보험'] } : {}),
        senses: [{ id: 'w2-s1', pos: 'noun', gloss: '사람의 생명에 대하여 보험금을 지급하는 보험.' }],
      };
      const id = `wfixture${index}`;
      return { id, lemma: `표제${index}`, senses: [{ id: `${id}-s1`, pos: 'noun', gloss: `뜻${index}` }] };
    });
    for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
    const producers = ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'];
    for (const batch of ['01', '02']) {
      const batchRecords = records.slice((Number(batch) - 1) * 500, Number(batch) * 500);
      for (const producer of producers) {
        await writeFile(path.join(root, `data/relation-candidates/001/001_${batch}_${producer}.jsonl`), jsonl(batchRecords.map((record) => ({
          record_id: record.id,
          senses: [{
            sense_id: record.senses[0].id,
            candidates: batch === '01' && producer === 'a_codex'
              ? record.id === 'w1' ? ['생명 보험', '독립어'] : record.id === 'w2' ? ['생명 보험 회사'] : []
              : [],
          }],
        }))));
      }
    }

    // This Part was prepared independently before the earlier Part's legacy row appeared.
    const checkpoint = '.warroom-scratch/relation-admission-001-01-02.json';
    await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
    const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
    assert.deepEqual(chunk.items.flatMap((item) => item.candidates.map((candidate) => candidate.text)), ['생명 보험 회사']);
    const decisionsFile = '.warroom-scratch/legacy-reciprocal-decisions.json';
    await writeFile(path.join(root, decisionsFile), JSON.stringify({
      chunk_id: chunk.chunk_id,
      decisions: [{
        source_sense_id: 'w2-s1', candidate: '생명 보험 회사', disposition: 'relation',
        target_resolution: 'exact', target_record_id: 'w1', target_sense_id: 'w1-s1',
        type: 'near', relevance: 3,
      }],
    }));
    await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

    const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
    const legacyRow = {
      source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: 'w2-s1',
      type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
    };
    await writeFile(relationPath, relationJsonl([legacyRow]));
    const merged = await mergeForTest(root, checkpoint);
    assert.equal(merged.merged, true);
    const rows = await readRelationRows(relationPath);
    assert.equal(rows.length, 1, 'reciprocal decisions retain one bidirectional ID row');
    assert.equal(rows[0].candidate_assignment_version, 0, 'the original forward direction remains legacy-inferred');
    assert.deepEqual(rows[0].candidate_forms, includeTargetAlias ? ['생명 보험', '생명보험'] : ['생명 보험']);
    assert.deepEqual(rows[0].reverse_candidate_forms, ['생명 보험 회사'], 'the newly selected reciprocal spelling is persisted exactly');

    const partCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
    assert.deepEqual([partCounts.unique, partCounts.reverse_covered, partCounts.missing], [1, 1, 0]);
    await rm(path.join(root, checkpoint));

    const resumedPrepare = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01'], { root }));
    assert.deepEqual(texts(resumedPrepare), ['독립어'], 'prepare skips the previously approved candidate and retains an independent one');

    // Resolve the still-independent fixture candidate so full Batch/Shard accounting can run on the same inputs.
    rows.push({
      source_record_id: 'w1', source_sense_id: 'w1-s1', text: '독립어', type: 'association', relevance: 5,
    });
    await writeFile(relationPath, relationJsonl(rows));
    const batchCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
    assert.deepEqual([batchCounts.unique, batchCounts.relation, batchCounts.reverse_covered, batchCounts.missing], [3, 2, 1, 0]);
    const shardCounts = await quiet(() => run(['verify', '--shard', '001'], { root }));
    assert.deepEqual([shardCounts.unique, shardCounts.relation, shardCounts.reverse_covered, shardCounts.missing], [3, 2, 1, 0]);
  });
}

test('merge coalesces orthographic aliases for one target sense and keeps the canonical headword judgment', async (t) => {
  const scratchDirectory = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const root = await mkdtemp(path.join(scratchDirectory, 'admission-orthographic-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 500 }, (_, index) => {
    if (index === 0) return { id: 'w1', lemma: '생명 보험 회사', senses: [{ id: 'w1-s1', pos: 'noun', gloss: '생명 보험을 판매하는 회사.' }] };
    if (index === 1) return { id: 'w2', lemma: '생명 보험', search_forms: ['생명보험'], senses: [{ id: 'w2-s1', pos: 'noun', gloss: '사람의 생명에 대하여 보험금을 지급하는 보험.' }] };
    return { id: `w${index + 1}`, lemma: `표제${index + 1}`, senses: [{ id: `w${index + 1}-s1`, pos: 'noun', gloss: `뜻${index + 1}` }] };
  });
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record, index) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' && index === 0 ? ['생명보험', '생명 보험'] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  assert.deepEqual(chunk.items[0].candidates.map((candidate) => candidate.text), ['생명보험', '생명 보험']);
  const decisionsFile = '.warroom-scratch/decisions.json';
  await writeFile(path.join(root, decisionsFile), JSON.stringify({
    chunk_id: chunk.chunk_id,
    decisions: [
      { source_sense_id: 'w1-s1', candidate: '생명보험', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w2', target_sense_id: 'w2-s1', type: 'near', relevance: 7 },
      { source_sense_id: 'w1-s1', candidate: '생명 보험', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w2', target_sense_id: 'w2-s1', type: 'near', relevance: 2 },
    ],
  }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.equal(merged.relations_added, 1, 'one canonical ID row represents both candidate spellings');
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const checkpointPath = path.join(root, checkpoint);
  const relationBytes = await readFile(relationPath);
  const relations = parseRelationJsonl(relationBytes.toString('utf8'), path.basename(relationPath));
  assert.deepEqual(relations, [{
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: 'w2-s1',
    type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2,
    candidate_assignment_version: 1, candidate_forms: ['생명보험', '생명 보험'], reverse_candidate_forms: ['생명 보험 회사'],
  }], 'the canonical target headword spelling supplies the retained sense-pair judgment');

  const repeated = await mergeForTest(root, checkpoint);
  assert.equal(repeated.relations_added, 0, 're-merging the same checkpoint is idempotent');
  assert.deepEqual(await readFile(relationPath), relationBytes, 'an idempotent retry leaves the Relation file byte-identical');

  const interruptedCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  interruptedCheckpoint.merged = false;
  await writeFile(checkpointPath, `${JSON.stringify(interruptedCheckpoint)}\n`);
  const recovered = await mergeForTest(root, checkpoint);
  assert.equal(recovered.relations_added, 1, 'recovery rematerializes the same single Relation row from the trusted premerge state');
  assert.deepEqual(await readFile(relationPath), relationBytes, 'partial-save recovery preserves the Relation file byte-for-byte');
  const verified = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(verified.missing, 0, 'the single ID row accounts for both orthographic candidate forms');

  const conflictingCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const conflictingDecision = conflictingCheckpoint.items[0].candidates.find((candidate) => candidate.text === '생명 보험').decision;
  conflictingDecision.type = 'scene';
  conflictingDecision.reverse_type = 'scene';
  await writeFile(checkpointPath, `${JSON.stringify(conflictingCheckpoint)}\n`);
  await assert.rejects(
    () => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })),
    /Relation output matches neither its trusted premerge snapshot nor the deterministic Part result/u,
    'a changed merged checkpoint is rejected before it can rewrite the approved Relation row',
  );
  assert.deepEqual(await readFile(relationPath), relationBytes, 'a conflicting retry cannot rewrite the approved Relation row');
});

test('merge coalesces one sense pair reached by distinct candidates using the strongest relevance per direction', async (t) => {
  const scratchDirectory = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const root = await mkdtemp(path.join(scratchDirectory, 'admission-pair-relevance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 500 }, (_, index) => {
    if (index === 0) return {
      id: 'w228756', lemma: '엉벙',
      senses: [{ id: 'w228756-s1', pos: 'noun', gloss: '쓸데없는 것들을 너절하게 벌이어 놓은 모양.' }],
    };
    if (index === 1) return {
      id: 'w459957', lemma: '어수선하다', search_forms: ['어수선'],
      senses: [{ id: 'w459957-s1', pos: 'adjective', gloss: '어수선한 상태에 있다.' }],
    };
    return {
      id: `w${index + 1}`, lemma: `표제${index + 1}`,
      senses: [{ id: `w${index + 1}-s1`, pos: 'noun', gloss: `뜻${index + 1}` }],
    };
  });
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record, index) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' && index === 0 ? ['어수선', '어수선하다'] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  assert.deepEqual(chunk.items[0].candidates.map((candidate) => candidate.text), ['어수선', '어수선하다']);
  const decisionsFile = '.warroom-scratch/decisions.json';
  await writeFile(path.join(root, decisionsFile), JSON.stringify({
    chunk_id: chunk.chunk_id,
    decisions: [
      { source_sense_id: 'w228756-s1', candidate: '어수선', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w459957', target_sense_id: 'w459957-s1', type: 'near', relevance: 4 },
      { source_sense_id: 'w228756-s1', candidate: '어수선하다', disposition: 'relation', target_resolution: 'exact', target_record_id: 'w459957', target_sense_id: 'w459957-s1', type: 'near', relevance: 3 },
    ],
  }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.equal(merged.relations_added, 1);
  const relations = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  assert.deepEqual(relations, [{
    source_record_id: 'w228756', source_sense_id: 'w228756-s1',
    target_record_id: 'w459957', target_sense_id: 'w459957-s1',
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
    candidate_assignment_version: 1, candidate_forms: ['어수선', '어수선하다'], reverse_candidate_forms: ['엉벙'],
  }]);
  const verified = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([verified.unique, verified.relation, verified.missing], [2, 1, 0]);
});

test('compact chunks are a lossless view and compact decisions expand into the same validated decisions', async (t) => {
  const { root } = await chunkRepository(t);
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const view = '.warroom-scratch/active-chunk.txt';
  const input = '.warroom-scratch/decisions.txt';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const legacyCheckpoint = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  delete legacyCheckpoint.type_tier_policy;
  await writeFile(path.join(root, checkpoint), `${JSON.stringify(legacyCheckpoint)}\n`);
  const compact = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '2', '--format', 'compact', '--out', view], { root }));
  const json = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  assert.equal(json.chunk_id, compact.chunk_id, 'both formats render the same pending chunk');
  const text = await readFile(path.join(root, view), 'utf8');
  assert.equal(text, compact.text);
  const lines = text.split('\n');
  for (const item of json.items) {
    assert.ok(lines.some((line) => line.startsWith(`S\t${item.sense_id}\t${item.record_id}\t${item.lemma}\t${item.pos}\t${item.gloss}\t`)), `source ${item.sense_id} keeps its full gloss`);
    for (const candidate of item.candidates) {
      for (const target of candidate.same_spelling_targets) for (const sense of target.senses) {
        assert.equal(lines.filter((line) => line.endsWith(`\t${sense.sense_id}\t${target.record_id}\t${target.lemma}\t${sense.pos}\t${sense.gloss}`)).length, 1, `target ${sense.sense_id} appears exactly once with its full gloss`);
      }
    }
  }
  assert.ok(lines.includes('c1\t유일표적\ta_codex\tT1,T2'));
  assert.ok(lines.includes('c2\t겹표기\ta_codex\tT3,T4'));
  assert.ok(lines.includes('P\tscene\t2\tw504-s1 역방향표적 noun 이미 연결된 뜻'), 'approved reverse peers use the stored source type and relevance');

  const save = async (body) => {
    await writeFile(path.join(root, input), body);
    return quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input, '--format', 'compact'], { root }));
  };
  const head = `chunk ${compact.chunk_id}`;
  for (const [body, error] of [
    ['chunk 001-01-01-999\nc1 R near 1 T1 mood 6\nc2 R association 7 none T3,T4', /must start with/],
    [`${head}\nc9 R near 1 T1 mood 6`, /names no candidate/],
    [`${head}\nc1 R near 1 T9 mood 6\nc2 R association 7 none T3,T4`, /unknown target alias T9/],
    [`${head}\nc1 R near 1 T3 mood 6\nc2 R association 7 none T3,T4`, /exact target must be one of/],
    [`${head}\nc1 R near 1 T1 mood 6\nc2 R association 7 none T3`, /check every same-spelling target sense/],
    [`${head}\nc1 R near 1 T1 mood 6\nc2 R association 7`, /omit target-resolution fields|target_resolution must be/],
    [`${head}\nc1 R near 10 T1 mood 6\nc2 R association 7 none T3,T4`, /single digit/],
    [`${head}\nc1 R near 1 T1 mood 0\nc2 R association 7 none T3,T4`, /single digit/],
    [`${head}\nc1 R near 1 T1\nc2 R association 7 none T3,T4`, /2, 4 or 5 fields/],
    [`${head}\nc1 R closeness 1 T1 mood 6\nc2 R association 7 none T3,T4`, /type must be one of/],
    [`${head}\nc1 X near 1 T1 mood 6\nc2 R association 7 none T3,T4`, /R or D/],
    [`${head}\nc1 D\nc2 R association 7 none T3,T4`, /Drop needs a reason/],
    [`${head}\nc1 R near 1 T1 mood 6`, /missing decisions/],
    [`${head}\nc1 R near 1 T1 mood 6\nc1 R near 1 T1 mood 6\nc2 R association 7 none T3,T4`, /repeats decision/],
  ]) await assert.rejects(() => save(body), error, body);

  const before = await readFile(path.join(root, checkpoint));
  const reported = await save(`${head}\nc1 R near 10 T1 mood 6\nc2 R association 7 none T3`).then(() => null, (error) => error.message);
  assert.match(reported, /not saved, checkpoint unchanged: 2 problem\(s\)/);
  assert.match(reported, /^c1 유일표적: c1: tier must be a single digit/m, 'a grammar error names its alias and candidate');
  assert.match(reported, /^c2 겹표기: .*check every same-spelling target sense.*none T3,T4/m, 'a validation error gives the allowed rows');
  const missingAndBad = await save(`${head}\nc2 R bogus 7 none T3,T4`).then(() => null, (error) => error.message);
  assert.match(missingAndBad, /^c1 유일표적: .*missing decisions/m, 'an omitted candidate is reported with the bad row');
  assert.match(missingAndBad, /^c2 겹표기: .*type must be one of/m);
  assert.deepEqual(await readFile(path.join(root, checkpoint)), before, 'a failed save leaves the checkpoint byte-identical');

  await save(`# comments and blank lines are ignored\n${head}\n\nc1 R near 1 T1 near 1\nc2 R association 7 none T4,T3\n`);
  const saved = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  assert.deepEqual(saved.items[0].candidates.slice(0, 2).map((candidate) => candidate.decision), [
    {
      source_sense_id: 'w1-s1', candidate: '유일표적', disposition: 'relation', type: 'near', relevance: 1,
      target_resolution: 'exact', target_record_id: 'w501', target_sense_id: 'w501-s1', reverse_type: 'near', reverse_relevance: 1,
    },
    {
      source_sense_id: 'w1-s1', candidate: '겹표기', disposition: 'relation', type: 'association', relevance: 7,
      target_resolution: 'no_exact_match', checked_target_sense_ids: ['w503-s1', 'w502-s1'],
    },
  ], 'compact lines become the same decision objects the JSON format stores');

  const next = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '3', '--format', 'compact'], { root }));
  const nextLines = next.text.split('\n');
  assert.ok(nextLines.includes('S\tw1-s1\tw1\t출발어\tnoun\t출발 의미\tcandidates 3-4/4'));
  assert.ok(nextLines.includes('Q\t유일표적\trelation\tnear\t1\tw501-s1\tnear\t1'), 'a continuation shows the same sense\'s saved decisions');
  assert.ok(nextLines.includes('Q\t겹표기\trelation\tassociation\t7\ttext-only'));
  assert.ok(nextLines.includes('c1\t낯선말\ta_codex\t-'));
  assert.ok(!nextLines.some((line) => line.startsWith('T1\t')), 'aliases restart for each chunk');
  await save(`chunk ${next.chunk_id}\nc1 R sensory 5\nc2 D 출발 sense와 무관한 임시 표기\nc3 R scene 4`);
  const finished = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--format', 'compact'], { root }));
  assert.equal(finished.complete, true);
  assert.deepEqual(await mergeForTest(root, checkpoint), {
    merged: true, relations_added: 4, drops_added: 1, checkpoint: path.join(root, checkpoint),
  });
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.drop, counts.skipped_existing, counts.missing], [6, 4, 1, 1, 0]);

  await assert.rejects(() => run(['read-chunk', '--checkpoint', checkpoint, '--format', 'compact', '--source-sense-id', 'w1-s1', '--candidate', '유일표적'], { root }), /primary chunks only/);
  await assert.rejects(() => run(['verify', '--shard', '001', '--format', 'compact'], { root }), /only valid for inspect\/read-chunk\/save-chunk/);
  await assert.rejects(() => run(['read-chunk', '--checkpoint', checkpoint, '--format', 'yaml'], { root }), /json or compact/);
});

test('new Part mirrors source Type/Tier through compact, JSON revision, inspect and amend boundaries', async (t) => {
  const root = await repository(t);
  const records = (await readFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const producer of ['a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record) => ({
      record_id: record.id, senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: [] })),
    }))));
  }
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const input = '.warroom-scratch/source-mirror-decisions.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const prepared = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  assert.equal(prepared.type_tier_policy, 'source-mirror-v1');

  const compact = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--format', 'compact'], { root }));
  assert.match(compact.text, /c<n> R <type> <tier> T<k>.*derived by the CLI/u);
  const compactBody = `chunk ${compact.chunk_id}\nc1 R near 2 T1\nc2 D 무관\nc3 D 무관\nc4 D 무관\n`;
  const beforeRejectedCompact = await readFile(path.join(root, checkpoint));
  await writeFile(path.join(root, input), compactBody.replace('c1 R near 2 T1', 'c1 R near 2 T1 mood 5'));
  await assert.rejects(() => quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input, '--format', 'compact'], { root })),
    /exact relations use only T<k>/u);
  assert.deepEqual(await readFile(path.join(root, checkpoint)), beforeRejectedCompact);

  await writeFile(path.join(root, input), compactBody);
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input, '--format', 'compact'], { root }));
  let saved = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  let selected = saved.items[0].candidates.find((candidate) => candidate.text === '유일');
  assert.deepEqual([selected.decision.type, selected.decision.relevance,
    selected.decision.reverse_type, selected.decision.reverse_relevance], ['near', 2, 'near', 2]);

  const inspectBeforeRevision = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'compact'], { root }));
  assert.match(inspectBeforeRevision.text, /# current c1: R near 2 T1\n/u);
  assert.doesNotMatch(inspectBeforeRevision.text, /# current c1: R near 2 T1 .*\d/u);
  const revision = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint,
    '--source-sense-id', 'w1-s1', '--candidate', '유일'], { root }));
  assert.deepEqual(revision.items[0].candidates[0].previous_decision, {
    source_sense_id: 'w1-s1', candidate: '유일', disposition: 'relation', type: 'near', relevance: 2,
    target_resolution: 'exact', target_record_id: 'w3', target_sense_id: 'w3-s1',
  });

  const revisionDecision = { source_sense_id: 'w1-s1', candidate: '유일', disposition: 'relation', type: 'mood', relevance: 5,
    target_resolution: 'exact', target_record_id: 'w3', target_sense_id: 'w3-s1' };
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: revision.chunk_id,
    decisions: [{ ...revisionDecision, reverse_type: 'near', reverse_relevance: 2 }] }));
  await assert.rejects(() => quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root })),
    /must omit reverse_type and reverse_relevance/u);
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: revision.chunk_id, decisions: [revisionDecision] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root }));
  saved = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  selected = saved.items[0].candidates.find((candidate) => candidate.text === '유일');
  assert.deepEqual([selected.decision.type, selected.decision.relevance,
    selected.decision.reverse_type, selected.decision.reverse_relevance], ['mood', 5, 'mood', 5]);

  await completeOptionalForTest(root, checkpoint);
  await quiet(() => run(['merge', '--checkpoint', checkpoint], { root }));
  const inspect = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1'], { root }));
  const amendPath = '.warroom-scratch/source-mirror-amend.txt';
  await writeFile(path.join(root, amendPath), `amend w1-s1 @${inspect.digest}\nc1 R scene 4 T1\n`);
  await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendPath], { root }));
  const [relation] = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  assert.deepEqual([relation.type, relation.relevance, relation.reverse_type, relation.reverse_relevance], ['scene', 4, 'scene', 4]);
});

test('marker-free checkpoints retain legacy decisions but block asymmetric output at the compact-schema boundary', async (t) => {
  const root = await repository(t);
  const records = (await readFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const producer of ['a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record) => ({
      record_id: record.id, senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: [] })),
    }))));
  }
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const input = '.warroom-scratch/legacy-decisions.txt';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const legacy = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  delete legacy.type_tier_policy;
  await writeFile(path.join(root, checkpoint), `${JSON.stringify(legacy)}\n`);
  const compact = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--format', 'compact'], { root }));
  assert.match(compact.text, /T<k> <reverse_type> <reverse_tier>/u);
  await writeFile(path.join(root, input), `chunk ${compact.chunk_id}\nc1 R near 2 T1 mood 5\nc2 D 무관\nc3 D 무관\nc4 D 무관\n`);
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input, '--format', 'compact'], { root }));
  const savedBeforeRestart = await readFile(path.join(root, checkpoint));
  const resumed = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(resumed.type_tier_policy, undefined);
  assert.deepEqual(await readFile(path.join(root, checkpoint)), savedBeforeRestart);
  const current = JSON.parse(savedBeforeRestart).items[0].candidates.find((candidate) => candidate.text === '유일').decision;
  assert.deepEqual([current.type, current.relevance, current.reverse_type, current.reverse_relevance], ['near', 2, 'mood', 5]);

  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const before = await Promise.all([fileState(relationPath), fileState(dropPath)]);
  await assert.rejects(() => mergeForTest(root, checkpoint), /reverse_type and reverse_relevance must match/u);
  assert.deepEqual(await Promise.all([fileState(relationPath), fileState(dropPath)]), before,
    'legacy asymmetric decisions are not silently projected or written');
});

test('merge validates final Part accounting before writing and supports a local decision revision', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-merge-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 500 }, (_, index) => ({
    id: `w${index + 1}`,
    lemma: index === 0 ? '출발표현' : `표제${index + 1}`,
    senses: [{
      id: `w${index + 1}-s1`,
      pos: 'noun',
      gloss: index === 0 ? '가로에 어떤 점의 위치를 표시하는 설명.' : `뜻${index + 1}`,
    }],
  }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const producers = ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'];
  for (const producer of producers) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record, index) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' && index === 0 ? ['가로', '무관후보'] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const decisionsFile = '.warroom-scratch/decisions.json';
  const badDrop = { source_sense_id: 'w1-s1', candidate: '가로', disposition: 'drop', reason: '무관 후보' };
  const validDrop = { source_sense_id: 'w1-s1', candidate: '무관후보', disposition: 'drop', reason: '출발 의미와 무관' };
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: chunk.chunk_id, decisions: [badDrop, validDrop] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  await completeOptionalForTest(root, checkpoint);
  await assert.rejects(
    () => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })),
    /"가로" is named by the gloss of w1-s1 and cannot be dropped as unrelated/u,
  );
  await assert.rejects(() => readFile(path.join(root, 'data/relations/relation-001.jsonl')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(root, 'data/relation-drops/drop-001.jsonl')), { code: 'ENOENT' });

  const revision = await quiet(() => run([
    'read-chunk', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--candidate', '가로',
  ], { root }));
  assert.deepEqual(texts(revision), ['가로']);
  assert.deepEqual(revision.items[0].candidates[0].previous_decision, badDrop);
  const corrected = { source_sense_id: 'w1-s1', candidate: '가로', disposition: 'relation', type: 'association', relevance: 4 };
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: revision.chunk_id, decisions: [corrected] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.deepEqual([merged.relations_added, merged.drops_added], [1, 1]);
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.drop, counts.missing], [2, 1, 1, 0]);
  const relations = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  const drops = await readDropRows(path.join(root, 'data/relation-drops/drop-001.jsonl'));
  assert.deepEqual(relations.map((row) => row.text), ['가로']);
  assert.deepEqual(drops.map((row) => row.candidate), ['무관후보'], 'the earlier valid decision remains intact when the rejected Drop is revised');
});

test('merge accounts an ID relation against only its selected candidate spelling', async (t) => {
  const scratch = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'admission-form-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const records = [
    { id: 'w249019', lemma: '완만히', search_forms: ['완만히'], senses: [{ id: 'w249019-s1', pos: 'adverb', gloss: '태도가 온순하고 부드럽게.' }] },
    { id: 'w462682', lemma: '온순하다', search_forms: ['온순하다', '온순'], senses: [{ id: 'w462682-s1', pos: 'adjective', gloss: '성질이나 마음씨가 온화하고 양순하다.' }] },
    { id: 'w245707', lemma: '온순하다', search_forms: ['온순하다', '온순'], senses: [{ id: 'w245707-s1', pos: 'adjective', gloss: '온화하고 단순하다.' }] },
    ...Array.from({ length: 997 }, (_, index) => ({
      id: `wfixture${index + 1}`,
      lemma: `표제${index + 1}`,
      senses: [{ id: `wfixture${index + 1}-s1`, pos: 'noun', gloss: `뜻${index + 1}` }],
    })),
  ];
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  const producers = ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'];
  for (const batch of ['01', '02']) {
    const batchRecords = records.slice((Number(batch) - 1) * 500, Number(batch) * 500);
    for (const producer of producers) {
      await writeFile(path.join(root, `data/relation-candidates/001/001_${batch}_${producer}.jsonl`), jsonl(batchRecords.map((record) => ({
        record_id: record.id,
        senses: [{ sense_id: record.senses[0].id, candidates: batch === '01' && producer === 'a_codex' && record.id === 'w249019' ? ['온순', '온순하다'] : [] }],
      }))));
    }
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const decisionsFile = '.warroom-scratch/decisions.json';
  const decisions = [
    {
      source_sense_id: 'w249019-s1', candidate: '온순', disposition: 'relation', type: 'near', relevance: 3,
      target_resolution: 'exact', target_record_id: 'w462682', target_sense_id: 'w462682-s1',
    },
    {
      source_sense_id: 'w249019-s1', candidate: '온순하다', disposition: 'relation', type: 'association', relevance: 5,
      target_resolution: 'no_exact_match', checked_target_sense_ids: ['w245707-s1', 'w462682-s1'],
    },
  ];
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.deepEqual([merged.relations_added, merged.drops_added], [2, 0]);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const relations = await readRelationRows(relationPath);
  const idRelation = relations.find((row) => row.target_record_id === 'w462682');
  assert.deepEqual(idRelation.candidate_forms, ['온순'], 'the selected spelling is persisted with the ID row');
  assert.deepEqual(idRelation.reverse_candidate_forms, ['완만히']);
  await rm(path.join(root, checkpoint));
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.missing], [2, 2, 0]);
  const batchCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  assert.deepEqual([batchCounts.unique, batchCounts.relation, batchCounts.missing], [2, 2, 0], 'batch verification reads candidate assignment from Relation JSONL');
  const shardCounts = await quiet(() => run(['verify', '--shard', '001'], { root }));
  assert.deepEqual([shardCounts.unique, shardCounts.relation, shardCounts.missing], [2, 2, 0], 'shard verification also reads persistent candidate assignment');
  assert.equal(relations.some((row) => row.target_record_id === 'w462682'), true, 'the selected alias candidate keeps its exact ID target');
  assert.equal(relations.some((row) => row.text === '온순하다'), true, 'the other spelling remains an independent text-only candidate');

  await writeFile(relationPath, relationJsonl([idRelation]));
  const resumedPrepare = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01'], { root }));
  assert.deepEqual(texts(resumedPrepare), ['온순하다'], 'an existing ID row does not own its target record’s other spelling during prepare');

  const compactWithoutCandidateForms = JSON.parse(relationJsonl([idRelation]));
  delete compactWithoutCandidateForms.fm;
  await writeFile(relationPath, `${JSON.stringify(compactWithoutCandidateForms)}\n`);
  await assert.rejects(
    () => quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root })),
    /must have exactly .*candidate_forms/u,
    'a new assigned row with a missing candidate_forms field is rejected instead of treated as legacy',
  );
});

test('merge coalesces distinct candidate forms that share one identical sense-pair judgment', async (t) => {
  const scratchDirectory = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const root = await mkdtemp(path.join(scratchDirectory, 'admission-sense-pair-forms-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 500 }, (_, index) => {
    if (index === 0) return {
      id: 'w226347', lemma: '억지투정',
      senses: [{ id: 'w226347-s1', pos: 'noun', gloss: '주로 윗사람에게 불만이 있어 떼를 쓰는 짓.' }],
    };
    if (index === 1) return {
      id: 'w334626', lemma: '칭얼거리다', search_forms: ['칭얼거리다', '칭얼'],
      senses: [{ id: 'w334626-s1', pos: 'verb', gloss: '몸이 불편하거나 마음에 못마땅하여 짜증을 내며 자꾸 중얼거리거나 보채다.' }],
    };
    return {
      id: `wfixture${index}`,
      lemma: `표제${index}`,
      senses: [{ id: `wfixture${index}-s1`, pos: 'noun', gloss: `뜻${index}` }],
    };
  });
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`), jsonl(records.map((record, index) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: producer === 'a_codex' && index === 0 ? ['칭얼거리다', '칭얼'] : [] }],
    }))));
  }

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  assert.deepEqual(chunk.items[0].candidates.map((candidate) => candidate.text), ['칭얼거리다', '칭얼']);
  assert.ok(chunk.items[0].candidates.every((candidate) => candidate.same_spelling_targets.some(
    (target) => target.record_id === 'w334626' && target.senses.some((sense) => sense.sense_id === 'w334626-s1'),
  )));

  const decisionsFile = '.warroom-scratch/decisions.json';
  const sharedJudgment = {
    source_sense_id: 'w226347-s1', disposition: 'relation', target_resolution: 'exact',
    target_record_id: 'w334626', target_sense_id: 'w334626-s1', type: 'action', relevance: 5,
  };
  const decisions = ['칭얼거리다', '칭얼'].map((candidate) => ({ ...sharedJudgment, candidate }));
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));

  const merged = await mergeForTest(root, checkpoint);
  assert.deepEqual([merged.relations_added, merged.drops_added], [1, 0]);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const relationBytes = await readFile(relationPath);
  const relations = parseRelationJsonl(relationBytes.toString('utf8'), path.basename(relationPath));
  assert.deepEqual(relations, [{
    source_record_id: 'w226347', source_sense_id: 'w226347-s1',
    target_record_id: 'w334626', target_sense_id: 'w334626-s1',
    type: 'action', relevance: 5, reverse_type: 'action', reverse_relevance: 5,
    candidate_assignment_version: 1, candidate_forms: ['칭얼거리다', '칭얼'], reverse_candidate_forms: ['억지투정'],
  }]);
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.missing], [2, 1, 0]);

  const conflictingCheckpoint = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  const conflictingDecision = conflictingCheckpoint.items[0].candidates.find((candidate) => candidate.text === '칭얼').decision;
  conflictingDecision.type = 'mood';
  conflictingDecision.reverse_type = 'mood';
  await writeFile(path.join(root, checkpoint), `${JSON.stringify(conflictingCheckpoint)}\n`);
  await assert.rejects(
    () => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })),
    /cannot merge duplicate or reverse-duplicate ID relation/u,
    'distinct candidate forms with conflicting judgments must not be silently collapsed',
  );
  assert.deepEqual(await readFile(relationPath), relationBytes, 'a conflicting retry leaves the accepted relation unchanged');
});

test('preflight repair accepts Supervisor sorted-state round-trip and remains stale-safe and idempotent', async (t) => {
  const { root } = await sixCandidateRepository(t);
  const canonicalPath = path.join(root, 'data/canonical/stdict-0001.jsonl');
  const canonical = (await readFile(canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  canonical[0].senses[0].gloss = '버릴말.';
  canonical[1].search_forms = ['유일', '유일하다'];
  await writeFile(canonicalPath, jsonl(canonical));
  const candidatesPath = path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl');
  const candidateRows = (await readFile(candidatesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  candidateRows[0].senses[0].candidates = ['유일', '유일하다', '버릴말'];
  await writeFile(candidatesPath, jsonl(candidateRows));

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const target = chunk.items[0].candidates.find((candidate) => candidate.text === '유일').same_spelling_targets
    .find((entry) => entry.record_id === 'w2');
  assert.equal(target.record_id, 'w2');
  const decisions = [
    { source_sense_id: 'w1-s1', candidate: '유일', disposition: 'relation', type: 'near', relevance: 3,
      target_resolution: 'exact', target_record_id: 'w2', target_sense_id: 'w2-s1' },
    { source_sense_id: 'w1-s1', candidate: '유일하다', disposition: 'relation', type: 'mood', relevance: 4,
      target_resolution: 'exact', target_record_id: 'w2', target_sense_id: 'w2-s1' },
    { source_sense_id: 'w1-s1', candidate: '버릴말', disposition: 'drop', reason: '무관' },
  ];
  const decisionsPath = '.warroom-scratch/preflight-decisions.json';
  await writeFile(path.join(root, decisionsPath), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsPath], { root }));
  await completeOptionalForTest(root, checkpoint);
  await quiet(() => run(['prepare-merge', '--checkpoint', checkpoint, '--json'], { root }));

  const watched = [
    path.join(root, checkpoint),
    path.join(root, 'data/relations/relation-001.jsonl'),
    path.join(root, 'data/relation-drops/drop-001.jsonl'),
    path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-relations.jsonl'),
    path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-drops.jsonl'),
  ];
  const before = await Promise.all(watched.map(fileState));
  const first = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json'], { root }));
  const repeated = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json'], { root }));
  assert.equal(first.ok, false);
  assert.equal(first.repairable, true);
  assert.deepEqual(first.coverage, {
    merge_conflicts: 'complete', drop_gloss: 'complete',
    materialization: 'deferred-until-conflicts-are-fixed', accounting: 'deferred-until-conflicts-are-fixed',
  });
  assert.equal(first.total, 2, 'the pair conflict and independent Drop/gloss failure are grouped separately');
  assert.equal(first.candidate_total, 3);
  assert.deepEqual(first.unclassified, []);
  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.deepEqual(await Promise.all(watched.map(fileState)), before, 'preflight does not change bytes or mtimes');
  const pageOne = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json', '--limit', '1'], { root }));
  const pageTwo = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json', '--limit', '1', '--offset', '1'], { root }));
  assert.equal(pageOne.total, 2);
  assert.equal(pageOne.next_offset, 1);
  assert.equal(pageTwo.next_offset, null);
  assert.deepEqual([...pageOne.problems, ...pageTwo.problems], first.problems, 'bounded pages preserve complete stable coverage');

  const pair = first.problems.find((problem) => problem.candidate_keys.length === 2);
  assert.ok(pair);
  const secondCandidate = pair.candidates.find((candidate) => candidate.candidate === '유일하다');
  const supervisorState = JSON.parse(JSON.stringify(sortJsonKeys({ current: { groups: [{ candidates: pair.candidates }] } })));
  const persistedCandidate = supervisorState.current.groups[0].candidates
    .find((candidate) => candidate.candidate === secondCandidate.candidate);
  const aligned = { ...persistedCandidate.decision, type: 'near' };
  const repair = { version: 1, fingerprint: first.fingerprint, supervisor_nonce: 'e'.repeat(64), decisions: [{
    source_sense_id: secondCandidate.source_sense_id,
    candidate: secondCandidate.candidate,
    expected_decision: persistedCandidate.decision,
    expected_additional_relations: null,
    decision: aligned,
    additional_relations: null,
  }] };
  const repairPath = '.warroom-scratch/repair.json';
  await writeFile(path.join(root, repairPath), JSON.stringify({ ...repair, decisions: [{
    ...repair.decisions[0], expected_decision: { ...persistedCandidate.decision, type: 'association' },
  }] }));
  await assert.rejects(() => quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root })),
    /stale repair target/u, 'a changed decision value remains stale after Supervisor state round-trip');
  await writeFile(path.join(root, repairPath), JSON.stringify(repair));
  const saved = await quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root }));
  assert.equal(saved.repaired, 1);
  const afterSave = await fileState(watched[0]);
  const replay = await quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root }));
  assert.equal(replay.already_applied, true);
  assert.equal(replay.request_id, saved.request_id);
  assert.equal(replay.supervisor_nonce, repair.supervisor_nonce);
  assert.deepEqual(await fileState(watched[0]), afterSave, 'receipt-backed replay does not write the checkpoint again');
  await writeFile(path.join(root, repairPath), JSON.stringify({ ...repair, supervisor_nonce: 'f'.repeat(64) }));
  await assert.rejects(() => quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root })),
    /bound to another Supervisor apply intent/);

  const afterPair = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json'], { root }));
  assert.equal(afterPair.repairable, true);
  assert.equal(afterPair.total, 1);
  assert.equal(afterPair.problems[0].candidates[0].candidate, '버릴말');
  const drop = afterPair.problems[0].candidates[0];
  const repairedDrop = { source_sense_id: drop.source_sense_id, candidate: drop.candidate,
    disposition: 'relation', type: 'association', relevance: 4 };
  await writeFile(path.join(root, repairPath), JSON.stringify({ version: 1, fingerprint: afterPair.fingerprint,
    supervisor_nonce: 'a'.repeat(64), decisions: [{
    source_sense_id: drop.source_sense_id, candidate: drop.candidate,
    expected_decision: drop.decision, expected_additional_relations: null,
    decision: repairedDrop, additional_relations: null,
  }] }));
  await quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root }));
  const clear = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json'], { root }));
  assert.equal(clear.ok, true);
  assert.equal(clear.total, 0);
  assert.deepEqual(clear.unclassified, []);
});

test('repair rejects a changed optional relation after the presented state was captured', async (t) => {
  const { root } = await sixCandidateRepository(t);
  const canonicalPath = path.join(root, 'data/canonical/stdict-0001.jsonl');
  const canonical = (await readFile(canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  canonical[2].senses.push({ id: 'w3-s2', pos: 'noun', gloss: '표기가 같은 두 번째 뜻' });
  await writeFile(canonicalPath, jsonl(canonical));
  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    const candidatePath = path.join(root, 'data/relation-candidates/001/001_01_' + producer + '.jsonl');
    const rows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map(JSON.parse);
    rows.find((row) => row.record_id === 'w3').senses.push({ sense_id: 'w3-s2', candidates: [] });
    if (producer === 'a_codex') rows.find((row) => row.record_id === 'w1').senses[0].candidates.push('유일');
    await writeFile(candidatePath, jsonl(rows));
  }
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([{
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w3', target_sense_id: 'w3-s1',
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  }]));

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  await saveAllPrimaryAsDrops(root, checkpoint);
  await completeOptionalForTest(root, checkpoint);
  await quiet(() => run(['prepare-merge', '--checkpoint', checkpoint, '--json'], { root }));
  const report = await quiet(() => run(['preflight', '--checkpoint', checkpoint, '--json'], { root }));
  const checkpointPath = path.join(root, checkpoint);
  const current = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const candidate = current.items.find((item) => item.sense_id === 'w1-s1').candidates.find((entry) => entry.text === '유일');
  assert.equal(candidate.already_accounted, true);
  assert.deepEqual(candidate.additional_relations, []);

  const changedRelation = {
    source_sense_id: 'w1-s1', candidate: '유일', disposition: 'relation', type: 'scene', relevance: 4,
    target_resolution: 'exact', target_record_id: 'w3', target_sense_id: 'w3-s2',
    reverse_type: 'scene', reverse_relevance: 4,
  };
  candidate.additional_relations.push(changedRelation);
  const optionalState = current.items.flatMap((item) => item.candidates
    .filter((entry) => entry.already_accounted === true)
    .map((entry) => ({
      source_sense_id: item.sense_id,
      candidate: entry.text,
      existing_target_sense_ids: entry.existing_target_sense_ids,
      unlinked_target_sense_ids: entry.unlinked_target_sense_ids,
      additional_relations: entry.additional_relations,
    })));
  current.optional_review_state_sha256 = createHash('sha256')
    .update(JSON.stringify(current.type_tier_policy
      ? { type_tier_policy: current.type_tier_policy, candidates: optionalState }
      : optionalState))
    .digest('hex');
  await writeFile(checkpointPath, JSON.stringify(current) + '\n');

  const repairPath = '.warroom-scratch/stale-optional-repair.json';
  await writeFile(path.join(root, repairPath), JSON.stringify({
    version: 1, fingerprint: report.fingerprint, supervisor_nonce: 'b'.repeat(64),
    decisions: [{
      source_sense_id: 'w1-s1', candidate: '유일', expected_decision: candidate.decision,
      expected_additional_relations: [], decision: null, additional_relations: [],
    }],
  }));
  await assert.rejects(() => quiet(() => run(['repair', '--checkpoint', checkpoint, '--in', repairPath, '--json'], { root })),
    /stale repair target: w1-s1\/유일/u);
});

// #2154: `verify --json` makes a deterministic Batch/Shard rows/accounting failure machine-classifiable (exit 2); every
// other failure stays an ordinary exit 1 and the output without --json is unchanged.
async function spawnedVerifyRepository(t, { candidates = () => [], relations = [], count = 3 } = {}) {
  const scratch = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'admission-verify-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [from, to] of [
    ['scripts/relation/admission-cli.mjs'], ['scripts/relation/admission.mjs'], ['scripts/relation/candidate-contract.mjs'], ['scripts/relation/persisted-jsonl.mjs'],
    ['scripts/build/gloss-arrow-reference.mjs'], ['src/runtime/dictionary-contract.js'],
  ]) {
    await mkdir(path.dirname(path.join(root, from)), { recursive: true });
    await copyFile(path.join(REPOSITORY_DIRECTORY, from), path.join(root, to ?? from));
  }
  const records = Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.map((record, i) => ({
      record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: name === 'a_codex' ? candidates(i) : [] }] }))));
  }
  if (relations.length > 0) await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl(relations));
  return root;
}
const spawnVerify = (root, ...extra) => spawnSync(process.execPath, [path.join(root, 'scripts/relation/admission-cli.mjs'), 'verify', '--shard', '001', '--batch', '01', ...extra], { cwd: root, encoding: 'utf8' });

test('verify --json: accounting failure is one JSON line with the complete error list and exit 2', async (t) => {
  const root = await spawnedVerifyRepository(t, { count: 60, candidates: (i) => [`후보${i + 1}`] });
  const json = spawnVerify(root, '--json');
  assert.equal(json.status, 2, json.stderr);
  assert.equal(json.stderr, '');
  assert.equal(json.stdout.trim().split('\n').length, 1);
  const out = JSON.parse(json.stdout);
  assert.deepEqual([out.version, out.ok, out.family, out.total, out.errors.length], [1, false, 'accounting', 60, 60]);
  assert.ok(out.errors.every((error) => typeof error === 'string' && error.includes('has no relation')));
  const plain = spawnVerify(root);   // unchanged: exit 1, message capped at 50
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /Relation Admission accounting failed:/u);
  assert.match(plain.stderr, /\.\.\. 10 more/u);
  assert.equal(plain.stderr.split('\n- ').length - 1, 51);
});

test('verify --json: invalid relation rows are family rows (exit 2); success is ok:true with counts (exit 0)', async (t) => {
  const bad = await spawnedVerifyRepository(t, { relations: [{ source_record_id: 'w1', source_sense_id: 'w1-s1', text: '표제1', type: 'near', relevance: 1 }] });
  const rows = spawnVerify(bad, '--json');
  assert.equal(rows.status, 2, rows.stderr);
  assert.equal(JSON.parse(rows.stdout).family, 'rows');
  const good = await spawnedVerifyRepository(t);
  const ok = spawnVerify(good, '--json');
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.version, out.ok, out.counts.missing], [1, true, 0]);
  assert.equal(JSON.parse(spawnVerify(good, '--json').stdout).ok, true);
  assert.match(spawnVerify(good).stdout, /^Relation Admission accounting valid for shard 001 batch 01:/u);
});

test('verify --json: unclassified failures stay exit 1 (missing input, usage, unmerged Part checkpoint)', async (t) => {
  const root = await spawnedVerifyRepository(t);
  const usage = spawnVerify(root, '--json', '--bogus');
  assert.equal(usage.status, 1);
  assert.equal(usage.stdout, '');
  const missing = spawnSync(process.execPath, [path.join(root, 'scripts/relation/admission-cli.mjs'), 'verify', '--shard', '002', '--batch', '01', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/relation/admission-cli.mjs'), 'prepare', '--shard', '001', '--batch', '01', '--part', '01'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const part = spawnSync(process.execPath, [path.join(root, 'scripts/relation/admission-cli.mjs'), 'verify', '--shard', '001', '--batch', '01', '--part', '01', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(part.status, 1);
  assert.equal(part.stdout, '');
  assert.match(part.stderr, /not merged|incomplete/u);
  const wrongCommand = spawnSync(process.execPath, [path.join(root, 'scripts/relation/admission-cli.mjs'), 'prepare', '--shard', '001', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(wrongCommand.status, 1);
});

test('inspect and optional reads preserve checkpoint/output/snapshot bytes and mtimes and page without omissions', async (t) => {
  const { root, checkpoint, sourceCandidates } = await prepareSixPart(t, { emptyRelation: true });
  await saveAllPrimaryAsDrops(root, checkpoint);
  const checkpointPath = path.join(root, checkpoint);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const relationSnapshot = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-relations.jsonl');
  const dropSnapshot = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-drops.jsonl');
  const first = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', '1',
  ], { root }));
  const collected = [...first.items.map((item) => item.candidate)];
  for (let page = 2; page <= first.total_pages; page += 1) {
    const next = await quiet(() => run([
      'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', String(page),
    ], { root }));
    assert.equal(next.digest, first.digest);
    assert.equal(next.total_pages, first.total_pages);
    collected.push(...next.items.map((item) => item.candidate));
  }
  assert.deepEqual(collected, sourceCandidates, 'all candidates arrive across bounded inspect pages');
  assert.equal(first.page, 1);
  const compact = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'compact', '--page-size', '2',
  ], { root }));
  assert.match(compact.text, /^inspect w1-s1 @[a-f0-9]{64}/u);
  assert.match(compact.text, /# current c1: D 출발 의미와 무관/u);
  const optional = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--optional', '--page-size', '1'], { root }));
  assert.equal(optional.links.length, 0);
  assert.equal(optional.optional_review_complete, false);

  const before = await Promise.all([checkpointPath, relationPath, dropPath, relationSnapshot, dropSnapshot].map(fileState));
  const repeated = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', '1',
  ], { root }));
  assert.equal(repeated.digest, first.digest, 'an unchanged scope has a stable digest');
  assert.deepEqual(await Promise.all([checkpointPath, relationPath, dropPath, relationSnapshot, dropSnapshot].map(fileState)), before,
    'inspect and optional read do not touch the checkpoint, Relation/Drop outputs or snapshots');

  const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
  cp.items[0].candidates[0].decision.reason = '다른 유효한 수정 이유';
  await writeFile(checkpointPath, `${JSON.stringify(cp)}\n`);
  const changed = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', '1',
  ], { root }));
  assert.notEqual(changed.digest, first.digest, 'a changed saved decision changes the inspect digest');

  await quiet(() => run(['complete-optional', '--checkpoint', checkpoint], { root }));
  const completeBytes = await readFile(checkpointPath);
  const completeTime = (await stat(checkpointPath)).mtimeMs;
  await quiet(() => run(['complete-optional', '--checkpoint', checkpoint], { root }));
  assert.deepEqual(await readFile(checkpointPath), completeBytes, 'zero optional links has one idempotent deterministic completion marker');
  assert.equal((await stat(checkpointPath)).mtimeMs, completeTime);
  const completedInspect = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', '1',
  ], { root }));
  assert.notEqual(completedInspect.digest, changed.digest, 'optional completion evidence is bound into the inspect digest');
  await mergeForTest(root, checkpoint);
  const mergedBefore = await Promise.all([checkpointPath, relationPath, dropPath, relationSnapshot, dropSnapshot].map(fileState));
  const mergedInspect = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'json', '--page-size', '2', '--page', '1',
  ], { root }));
  assert.equal(mergedInspect.digest, completedInspect.digest, 'merge does not change the inspection scope digest');
  assert.deepEqual(await Promise.all([checkpointPath, relationPath, dropPath, relationSnapshot, dropSnapshot].map(fileState)), mergedBefore,
    'inspect remains read-only after merge, including trusted snapshots');
});

test('selected inspect preserves whole-sense digest and aliases while bounding Q summaries', async (t) => {
  const { root } = await sixCandidateRepository(t);
  const candidatePath = path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl');
  const producerRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const longCandidates = Array.from({ length: 6 }, (_, index) => `후보${index + 1}-${'별'.repeat(5_000)}`);
  producerRows.find((row) => row.record_id === 'w1').senses[0].candidates = longCandidates;
  producerRows.find((row) => row.record_id === 'w2').senses[0].candidates = ['대체 후보'];
  await writeFile(candidatePath, jsonl(producerRows));
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([{
    source_record_id: 'w2', source_sense_id: 'w2-s1', target_record_id: 'w1', target_sense_id: 'w1-s1',
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  }]));
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const rows = chunk.items.flatMap((item) => item.candidates.map((candidate) => ({ sense: item.sense_id, text: candidate.text })));
  const decisions = rows.map((_, index) => index === 0 ? `c${index + 1} D unrelated` : `c${index + 1} R near 3`);
  const decisionsPath = '.warroom-scratch/review-fix-decisions.txt';
  await writeFile(path.join(root, decisionsPath), `chunk ${chunk.chunk_id}\n${decisions.join('\n')}\n`);
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsPath, '--format', 'compact'], { root }));

  const full = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1,w2-s1', '--format', 'compact', '--page-size', '1',
  ], { root }));
  const fullW1 = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--format', 'compact', '--page-size', '1',
  ], { root }));
  const selectedPair = { source_sense_id: 'w1-s1', candidate: longCandidates[4] };
  const selectionPath = '.warroom-scratch/s2-fix-select.json';
  await writeFile(path.join(root, selectionPath), JSON.stringify({ candidates: [selectedPair] }));
  const first = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1,w2-s1', '--select', selectionPath,
    '--format', 'compact', '--page-size', '1', '--page', '1',
  ], { root }));
  assert.equal(first.digest, full.digest, 'selection does not change the all-candidate digest');
  assert.match(first.text, /\nc5\t/u, 'candidate aliases remain based on the full source Sense');
  const fullAlias = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1,w2-s1', '--format', 'compact', '--page-size', '1', '--page', '5',
  ], { root }));
  assert.match(fullAlias.text, /\nc5\t/u, 'the same alias is used by an unfiltered inspect');
  assert.match(first.text, /\nP\tnear\t3\tw2-s1/u, 'approved P context remains on the selected Sense');
  assert.ok(first.total_pages > 2, 'Q summary rows are split into bounded pages after the detail pages');
  const pages = [first.text];
  for (let page = 2; page <= first.total_pages; page += 1) {
    const next = await quiet(() => run([
      'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1,w2-s1', '--select', selectionPath,
      '--format', 'compact', '--page-size', '1', '--page', String(page),
    ], { root }));
    assert.equal(next.digest, first.digest);
    assert.equal(next.total_pages, first.total_pages);
    assert.ok(Buffer.byteLength(next.text, 'utf8') <= 36_000);
    pages.push(next.text);
  }
  const allText = pages.join('');
  assert.match(allText, /\nS\tw2-s1\tw2\t다라\tnoun\t뜻2\n/u, 'an unfiltered requested Sense is rendered in full');
  assert.match(allText, /\nc7\t대체 후보\t/u, 'a Sense without selected pairs uses the full-Sense fallback');
  assert.match(allText, /\nQ\tc1\t/u);
  assert.match(allText, /\tD\n/u, 'Q retains Drop status');
  assert.match(allText, /\tnear\/3\t말의 결\n/u, 'Q retains current Type/Tier and UI group');
  for (const candidate of longCandidates.filter((_, index) => index !== 4)) {
    assert.equal(allText.split(candidate).length - 1, 1, 'each long Q candidate appears on exactly one bounded page');
  }

  await writeFile(path.join(root, selectionPath), JSON.stringify({ candidates: [selectedPair, selectedPair] }));
  await assert.rejects(() => quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--select', selectionPath, '--format', 'compact',
  ], { root })), /repeats/u);
  await writeFile(path.join(root, selectionPath), JSON.stringify({ candidates: [{ ...selectedPair, candidate: 'missing candidate' }] }));
  await assert.rejects(() => quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--select', selectionPath, '--format', 'compact',
  ], { root })), /no selected candidate/u);
  await writeFile(path.join(root, selectionPath), JSON.stringify({ candidates: [{ source_sense_id: 'w2-s1', candidate: '대체 후보' }] }));
  await assert.rejects(() => quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--select', selectionPath, '--format', 'compact',
  ], { root })), /outside --source-sense-id/u);
  await assert.rejects(() => quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--select', selectionPath,
    '--candidate', '대체 후보', '--format', 'compact',
  ], { root })), /cannot be used together/u);

  const legacyFilter = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--candidate', longCandidates[4], '--format', 'compact',
  ], { root }));
  assert.match(legacyFilter.text, /\nc5\t/u, 'the existing --candidate filter retains its full-sense alias');
  assert.equal(legacyFilter.digest, fullW1.digest, 'the existing --candidate filter keeps its prior digest contract');
});

test('inspect --select keeps detailed current rows for a full-sense review target', async (t) => {
  const { root, sourceCandidates } = await sixCandidateRepository(t);
  const candidatePath = path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl');
  const producerRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map(JSON.parse);
  producerRows.find((row) => row.record_id === 'w2').senses[0].candidates = ['peer candidate'];
  await writeFile(candidatePath, jsonl(producerRows));

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  await saveAllPrimaryAsDrops(root, checkpoint);
  const selectionPath = '.warroom-scratch/s2-fix-select.json';
  await writeFile(path.join(root, selectionPath), JSON.stringify({ candidates: [
    { source_sense_id: 'w1-s1', candidate: sourceCandidates[0] },
  ] }));

  const inspect = await quiet(() => run([
    'inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1,w2-s1',
    '--select', selectionPath, '--format', 'compact',
  ], { root }));

  assert.ok(sourceCandidates.length > 1);
  const peerDetail = inspect.text.match(/\n(c\d+)\tpeer candidate\t[^\n]*\n# current \1: D /u);
  assert.ok(peerDetail, 'the prose-full Sense keeps its c<n> detail alias and current Drop decision');
  assert.doesNotMatch(inspect.text, /\nQ\tc\d+\tpeer candidate\t/u,
    'a prose-full Sense is not reduced to a Q summary when another Sense has selected candidates');
});

test('premerge preparation resumes only from matching source hashes and distinguishes empty files from absence', async (t) => {
  const { root } = await prepareSixPart(t, { emptyRelation: true });
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const relationSnapshot = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-relations.jsonl');
  const dropSnapshot = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-drops.jsonl');
  await saveAllPrimaryAsDrops(root, checkpoint);
  await writeFile(dropPath, '');
  const cpPath = path.join(root, checkpoint);
  const cp = JSON.parse(await readFile(cpPath, 'utf8'));
  cp.premerge = {
    status: 'preparing', identity: '001/01/01',
    relations: { exists: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    drops: { exists: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  };
  await writeFile(cpPath, `${JSON.stringify(cp)}\n`);
  await writeFile(relationSnapshot, ''); // Simulate an interruption after the first valid snapshot.
  await mergeForTest(root, checkpoint);
  const merged = JSON.parse(await readFile(cpPath, 'utf8'));
  assert.equal(merged.premerge.status, 'ready');
  assert.deepEqual(merged.premerge.relations, { exists: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.deepEqual(merged.premerge.drops, merged.premerge.relations);
  assert.deepEqual(await readFile(relationSnapshot), Buffer.alloc(0));
  assert.deepEqual(await readFile(dropSnapshot), Buffer.alloc(0));
  assert.notDeepEqual(await readFile(dropPath), Buffer.alloc(0), 'the empty premerge Drop file becomes the Part output');

  const absent = await prepareSixPart(t, { emptyRelation: true });
  await saveAllPrimaryAsDrops(absent.root, absent.checkpoint);
  await mergeForTest(absent.root, absent.checkpoint);
  const absentCp = JSON.parse(await readFile(path.join(absent.root, absent.checkpoint), 'utf8'));
  assert.deepEqual(absentCp.premerge.relations, { exists: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.deepEqual(absentCp.premerge.drops, { exists: false, sha256: null }, 'an absent Drop is recorded separately from an empty one');
  await assert.rejects(readFile(path.join(absent.root, '.warroom-scratch/relation-admission-001-01-01.premerge-drops.jsonl')), { code: 'ENOENT' });
});

test('a trusted premerge snapshot in the prior verbose schema is preserved and refused at the Part boundary', async (t) => {
  const { root, checkpoint } = await prepareSixPart(t);
  await saveAllPrimaryAsDrops(root, checkpoint);
  await completeOptionalForTest(root, checkpoint);
  const checkpointPath = path.join(root, checkpoint);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const snapshotPath = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-relations.jsonl');
  const legacyBytes = Buffer.from(`${JSON.stringify({
    source_record_id: 'w1', source_sense_id: 'w1-s1', text: '기존말', type: 'scene', relevance: 4,
  })}\n`);
  await writeFile(relationPath, legacyBytes);
  await writeFile(snapshotPath, legacyBytes);
  const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
  cp.premerge = {
    status: 'ready', identity: '001/01/01',
    relations: { exists: true, sha256: createHash('sha256').update(legacyBytes).digest('hex') },
    drops: { exists: false, sha256: null },
  };
  await writeFile(checkpointPath, `${JSON.stringify(cp)}\n`);
  const watched = [checkpointPath, relationPath, snapshotPath];
  const before = await Promise.all(watched.map(fileState));

  await assert.rejects(() => mergeForTest(root, checkpoint), /obsolete Relation JSONL field/u);
  assert.deepEqual(await Promise.all(watched.map(fileState)), before,
    'the previous-format snapshot and exact source bytes remain trusted and unchanged');
});

test('save-optional accepts multiple exact target links per candidate and rejects incomplete/duplicate rows atomically', async (t) => {
  const { root } = await chunkRepository(t);
  const canonicalPath = path.join(root, 'data/canonical/stdict-0001.jsonl');
  const canonical = (await readFile(canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  canonical.find((record) => record.id === 'w501').senses.push({ id: 'w501-s3', pos: 'noun', gloss: '표기가 같은 세 번째 뜻' });
  await writeFile(canonicalPath, jsonl(canonical));
  const prior = (await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl')))[0];
  const firstExisting = {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w501', target_sense_id: 'w501-s1',
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), relationJsonl([prior, firstExisting]));
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  await saveAllPrimaryAsDrops(root, checkpoint);
  const view = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--optional'], { root }));
  assert.equal(view.links.length, 1, 'one candidate may have multiple unlinked target senses');
  const compact = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--optional', '--format', 'compact'], { root }));
  assert.match(compact.text, /T2\tw501-s2/u);
  assert.match(compact.text, /T3\tw501-s3/u);
  const input = '.warroom-scratch/optional-input.txt';
  const before = await readFile(path.join(root, checkpoint));
  const duplicate = `links @${view.digest}\nc1 R near 3 T2\nc1 R mood 4 T2\n`;
  await writeFile(path.join(root, input), duplicate);
  await assert.rejects(
    () => quiet(() => run(['save-optional', '--checkpoint', checkpoint, '--in', input], { root })),
    /optional links not saved[\s\S]*repeats target/u,
  );
  assert.deepEqual(await readFile(path.join(root, checkpoint)), before, 'one duplicate target rejects all optional decisions');
  await writeFile(path.join(root, input), `links @${view.digest}\nc1 R near 3 T2\nc1 R mood 4 T3\n`);
  const saved = await quiet(() => run(['save-optional', '--checkpoint', checkpoint, '--in', input], { root }));
  assert.deepEqual([saved.optional_review_complete, saved.optional_links_saved, saved.optional_candidates], [true, 2, 1]);
  const checkpointData = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  const added = checkpointData.items.find((item) => item.sense_id === 'w1-s1').candidates.find((candidate) => candidate.text === '유일표적');
  assert.deepEqual(added.additional_relations.map((relation) => relation.target_sense_id), ['w501-s2', 'w501-s3']);
  assert.ok(added.additional_relations.every((relation) => relation.reverse_type === relation.type
    && relation.reverse_relevance === relation.relevance), 'the CLI mirrors each optional source judgment');
  await mergeForTest(root, checkpoint);
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01', '--checkpoint', checkpoint], { root }));
  assert.equal(counts.missing, 0);
  const relations = await readRelationRows(path.join(root, 'data/relations/relation-001.jsonl'));
  assert.equal(relations.filter((row) => row.source_sense_id === 'w1-s1' && row.target_record_id === 'w501').length, 3);
});

test('cancel-revision only clears the exact active revision and leaves its decision and cursor intact', async (t) => {
  const { root } = await sixCandidateRepository(t);
  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  const first = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint, '--max-candidates', '1'], { root }));
  const input = '.warroom-scratch/one-decision.json';
  await writeFile(path.join(root, input), JSON.stringify({ chunk_id: first.chunk_id, decisions: [
    { source_sense_id: 'w1-s1', candidate: first.items[0].candidates[0].text, disposition: 'drop', reason: '초기 판정' },
  ] }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', input], { root }));
  const saved = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  const revision = await quiet(() => run([
    'read-chunk', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1', '--candidate', first.items[0].candidates[0].text,
  ], { root }));
  assert.equal(revision.revision, true);
  await assert.rejects(
    () => quiet(() => run(['cancel-revision', '--checkpoint', checkpoint, '--chunk-id', `${revision.chunk_id}-wrong`], { root })),
    /must exactly match/u,
  );
  await quiet(() => run(['cancel-revision', '--checkpoint', checkpoint, '--chunk-id', revision.chunk_id], { root }));
  const canceled = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  assert.equal(canceled.pending_chunk, null);
  assert.equal(canceled.next_chunk_number, saved.next_chunk_number);
  assert.deepEqual(canceled.items[0].candidates[0].decision, saved.items[0].candidates[0].decision);
  const primary = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  await assert.rejects(
    () => quiet(() => run(['cancel-revision', '--checkpoint', checkpoint, '--chunk-id', primary.chunk_id], { root })),
    /must exactly match an active unmerged revision/u,
  );
});

test('six Drop-to-Relation amendments equal a from-scratch merge and verify with the checkpoint', async (t) => {
  const amended = await prepareSixPart(t, { emptyRelation: true });
  const { root, checkpoint } = amended;
  await saveAllPrimaryAsDrops(root, checkpoint);
  await mergeForTest(root, checkpoint);
  const premerge = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8')).premerge;
  assert.equal(premerge.identity, '001/01/01');
  assert.deepEqual(premerge.relations, { exists: true, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.deepEqual(premerge.drops, { exists: false, sha256: null });
  const inspect = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1'], { root }));
  const amendInput = '.warroom-scratch/amend-six.txt';
  const rows = amended.sourceCandidates.map((_, index) => `c${index + 1} R scene 4`);
  const amendText = `amend w1-s1 @${inspect.digest}\n${rows.join('\n')}\n`;
  await writeFile(path.join(root, amendInput), amendText);
  const amendedResult = await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendInput], { root }));
  assert.equal(amendedResult.amended, true);
  const cp = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  assert.equal(cp.amend_revision, 1);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const amendedRelations = await readFile(relationPath);
  await assert.rejects(readFile(dropPath), { code: 'ENOENT' });
  const verified = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01', '--checkpoint', checkpoint], { root }));
  assert.equal(verified.missing, 0);
  const repeated = await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendInput], { root }));
  assert.equal(repeated.already_applied, true);
  assert.deepEqual(await readFile(relationPath), amendedRelations, 'a repeated request does not duplicate Relation output');

  const fresh = await prepareSixPart(t, { emptyRelation: true });
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', fresh.checkpoint], { root: fresh.root }));
  const freshRows = chunk.items.flatMap((item) => item.candidates.map((candidate) => ({
    source_sense_id: item.sense_id, candidate: candidate.text, disposition: 'relation', type: 'scene', relevance: 4,
  })));
  const freshInput = '.warroom-scratch/primary-relations.json';
  await writeFile(path.join(fresh.root, freshInput), JSON.stringify({ chunk_id: chunk.chunk_id, decisions: freshRows }));
  await quiet(() => run(['save-chunk', '--checkpoint', fresh.checkpoint, '--in', freshInput], { root: fresh.root }));
  await mergeForTest(fresh.root, fresh.checkpoint);
  assert.deepEqual(await readFile(path.join(fresh.root, 'data/relations/relation-001.jsonl')), amendedRelations);
  await assert.rejects(readFile(path.join(fresh.root, 'data/relation-drops/drop-001.jsonl')), { code: 'ENOENT' });
});

test('amend rewrites Drop reasons and same-count Drop-to-Relation swaps from the trusted snapshot', async (t) => {
  const { root, checkpoint, sourceCandidates } = await prepareSixPart(t, { emptyRelation: true });
  const chunk = await quiet(() => run(['read-chunk', '--checkpoint', checkpoint], { root }));
  const decisions = sourceCandidates.map((candidate, index) => index < 3
    ? { source_sense_id: 'w1-s1', candidate, disposition: 'drop', reason: '초기 Drop 사유' }
    : { source_sense_id: 'w1-s1', candidate, disposition: 'relation', type: 'scene', relevance: 4 });
  const decisionsFile = '.warroom-scratch/mixed-initial-decisions.json';
  await writeFile(path.join(root, decisionsFile), JSON.stringify({ chunk_id: chunk.chunk_id, decisions }));
  await quiet(() => run(['save-chunk', '--checkpoint', checkpoint, '--in', decisionsFile], { root }));
  await mergeForTest(root, checkpoint);

  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const initialDrops = await readDropRows(dropPath);
  assert.equal(initialDrops.length, 3);
  const inspect = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1'], { root }));
  const amendFile = '.warroom-scratch/amend-drop-reason-and-swap.txt';
  const amendText = `amend w1-s1 @${inspect.digest}\nc1 D 수정된 Drop 사유\nc2 R scene 6\nc4 D Relation에서 변경된 Drop\n`;
  await writeFile(path.join(root, amendFile), amendText);
  await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendFile], { root }));

  const amendedBytes = await readFile(dropPath);
  const amendedDrops = parseDropJsonl(amendedBytes.toString('utf8'), path.basename(dropPath));
  assert.equal(amendedDrops.length, initialDrops.length, 'the total Drop count stays unchanged');
  assert.deepEqual(amendedDrops.map(({ candidate }) => candidate), [sourceCandidates[0], sourceCandidates[2], sourceCandidates[3]]);
  assert.equal(amendedDrops[0].reason, '수정된 Drop 사유');
  assert.equal(amendedDrops[2].reason, 'Relation에서 변경된 Drop');
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01', '--checkpoint', checkpoint], { root }));
  assert.equal(counts.missing, 0);
  const repeated = await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendFile], { root }));
  assert.equal(repeated.already_applied, true);
  assert.deepEqual(await readFile(dropPath), amendedBytes, 'an idempotent retry preserves the amended Drop bytes');
});

test('amend rejects stale scope, invalid batches, drift and a changed snapshot without partial writes', async (t) => {
  const { root, checkpoint } = await prepareSixPart(t, { emptyRelation: true });
  await saveAllPrimaryAsDrops(root, checkpoint);
  await mergeForTest(root, checkpoint);
  const checkpointPath = path.join(root, checkpoint);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const snapshotPath = path.join(root, '.warroom-scratch/relation-admission-001-01-01.premerge-relations.jsonl');
  const inspect = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1'], { root }));
  const valid = '.warroom-scratch/amend-valid.txt';
  const validText = `amend w1-s1 @${inspect.digest}\nc1 R scene 4\n`;
  await writeFile(path.join(root, valid), validText);
  const stale = '.warroom-scratch/amend-stale.txt';
  const staleDigest = `${inspect.digest[0] === '0' ? '1' : '0'}${inspect.digest.slice(1)}`;
  await writeFile(path.join(root, stale), validText.replace(inspect.digest, staleDigest));
  const invalid = '.warroom-scratch/amend-invalid.txt';
  await writeFile(path.join(root, invalid), `amend w1-s1 @${inspect.digest}\nc1 R scene 4\nc2 D \nc999 D outside\n`);
  const before = await Promise.all([checkpointPath, relationPath, dropPath].map(fileState));
  await assert.rejects(() => quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', stale], { root })), /stale inspect digest/u);
  await assert.rejects(() => quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', invalid], { root })), /invalid amend input: 2 problem/u);
  assert.deepEqual(await Promise.all([checkpointPath, relationPath, dropPath].map(fileState)), before);

  const originalRelations = await readFile(relationPath);
  await writeFile(relationPath, Buffer.concat([originalRelations, Buffer.from('\n')]));
  const drifted = await Promise.all([checkpointPath, relationPath, dropPath].map(fileState));
  await assert.rejects(() => quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', valid], { root })), /materialize\(premerge, checkpoint\)/u);
  assert.deepEqual(await Promise.all([checkpointPath, relationPath, dropPath].map(fileState)), drifted);
  await writeFile(relationPath, originalRelations);

  await writeFile(snapshotPath, 'tampered snapshot\n');
  const tamperedBefore = await Promise.all([checkpointPath, relationPath, dropPath].map(fileState));
  await assert.rejects(() => quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', valid], { root })), /snapshot hash does not match/u);
  assert.deepEqual(await Promise.all([checkpointPath, relationPath, dropPath].map(fileState)), tamperedBefore);
  assert.deepEqual(await readFile(snapshotPath, 'utf8'), 'tampered snapshot\n');
});

test('amend resumes each of its four allowed file states and refuses a different request mid-recovery', async (t) => {
  const { root, checkpoint, sourceCandidates } = await prepareSixPart(t, { emptyRelation: true });
  await saveAllPrimaryAsDrops(root, checkpoint);
  await mergeForTest(root, checkpoint);
  const inspect = await quiet(() => run(['inspect', '--checkpoint', checkpoint, '--source-sense-id', 'w1-s1'], { root }));
  const amendInput = '.warroom-scratch/amend-recovery.txt';
  const amendText = `amend w1-s1 @${inspect.digest}\n${sourceCandidates.map((_, index) => `c${index + 1} R scene 4`).join('\n')}\n`;
  await writeFile(path.join(root, amendInput), amendText);
  await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendInput], { root }));

  const checkpointPath = path.join(root, checkpoint);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const oldCheckpoint = await readFile(checkpointPath);
  const newCheckpoint = await readFile(checkpointPath);
  const newRelations = await readFile(relationPath);
  const newDrops = await fileState(dropPath);
  const journal = JSON.parse(await readFile(path.join(root, '.warroom-scratch/relation-admission-001-01-01.amend-state.json'), 'utf8'));
  const decodedOldCheckpoint = Buffer.from(journal.old_checkpoint_b64, 'base64');
  const oldCheckpointObject = JSON.parse(decodedOldCheckpoint.toString('utf8'));
  assert.equal(oldCheckpointObject.amend_revision || 0, 0);
  const oldStates = {
    checkpoint: decodedOldCheckpoint,
    relations: Buffer.alloc(0),
    drops: Buffer.from(JSON.stringify({
      source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: sourceCandidates[0],
      reason: '출발 의미와 무관',
    }) + '\n'),
  };
  // Use the journal's deterministic old materialization to preserve exact old JSONL bytes for every candidate.
  const oldDropFile = JSON.parse(await readFile(path.join(root, checkpoint), 'utf8'));
  const oldDecisionInput = '.warroom-scratch/recovery-old-decisions.json';
  const oldChunk = {
    chunk_id: '001-01-01-001',
    decisions: sourceCandidates.map((candidate) => ({ source_sense_id: 'w1-s1', candidate, disposition: 'drop', reason: '출발 의미와 무관' })),
  };
  // Recreate the pre-amend merged Drop bytes from its saved decisions without invoking a new production path.
  const oldRoot = await prepareSixPart(t, { emptyRelation: true });
  const oldActive = await quiet(() => run(['read-chunk', '--checkpoint', oldRoot.checkpoint], { root: oldRoot.root }));
  oldChunk.chunk_id = oldActive.chunk_id;
  await writeFile(path.join(oldRoot.root, oldDecisionInput), JSON.stringify(oldChunk));
  await quiet(() => run(['save-chunk', '--checkpoint', oldRoot.checkpoint, '--in', oldDecisionInput], { root: oldRoot.root }));
  await mergeForTest(oldRoot.root, oldRoot.checkpoint);
  const oldDrops = await readFile(path.join(oldRoot.root, 'data/relation-drops/drop-001.jsonl'));
  assert.ok(oldDropFile.merged);

  const restore = async (file, state) => {
    if (state === null) await rm(file, { force: true });
    else await writeFile(file, state);
  };
  const states = [
    { relation: oldStates.relations, drops: oldDrops, checkpoint: decodedOldCheckpoint },
    { relation: newRelations, drops: oldDrops, checkpoint: decodedOldCheckpoint },
    { relation: newRelations, drops: null, checkpoint: decodedOldCheckpoint },
    { relation: newRelations, drops: null, checkpoint: newCheckpoint },
  ];
  for (const [index, state] of states.entries()) {
    await restore(relationPath, state.relation);
    await restore(dropPath, state.drops);
    await restore(checkpointPath, state.checkpoint);
    if (index === 1) {
      const different = '.warroom-scratch/amend-different.txt';
      await writeFile(path.join(root, different), amendText.replace('c1 R scene 4', 'c1 R mood 4'));
      const before = await Promise.all([fileState(relationPath), fileState(dropPath), fileState(checkpointPath)]);
      await assert.rejects(() => quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', different], { root })),
        /another amend is incomplete/u);
      assert.deepEqual(await Promise.all([fileState(relationPath), fileState(dropPath), fileState(checkpointPath)]), before);
    }
    const recovered = await quiet(() => run(['amend', '--checkpoint', checkpoint, '--in', amendInput], { root }));
    assert.equal(recovered.amended, true, `recovery state ${index + 1} completes`);
    assert.deepEqual(await readFile(relationPath), newRelations);
    assert.deepEqual(await fileState(dropPath), newDrops);
    assert.deepEqual(await readFile(checkpointPath), newCheckpoint);
  }
});

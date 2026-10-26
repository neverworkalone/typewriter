import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from './admission-cli.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

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
  if (relations.length > 0) await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl(relations));
  if (drops.length > 0) await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl(drops));
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

test('CLI entrypoint prepares a Part without an injected repository root', async (t) => {
  const scratchDirectory = path.join(REPOSITORY_DIRECTORY, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const root = await mkdtemp(path.join(scratchDirectory, 'admission-cli-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const relationScriptDirectory = path.join(root, 'scripts/relation');
  for (const directory of [relationScriptDirectory, path.join(root, 'data/canonical'), path.join(root, 'data/relation-candidates/001')]) {
    await mkdir(directory, { recursive: true });
  }
  for (const file of ['admission-cli.mjs', 'admission.mjs', 'candidate-contract.mjs']) {
    await copyFile(path.join(REPOSITORY_DIRECTORY, 'scripts/relation', file), path.join(relationScriptDirectory, file));
  }

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
      { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w3', target_sense_id: 'w3-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 3 },
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
    /cannot merge a checkpoint prepared with incomplete Stage 1 inputs/,
  );
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
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([
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

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '후보1', type: 'scene', relevance: 4 },
    { source_record_id: 'w101', source_sense_id: 'w101-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 },
    { source_record_id: 'w200', source_sense_id: 'w200-s1', text: '후보200', type: 'scene', relevance: 4 },
  ]));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl([
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
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([...initialRelations, reverseConflict, ...laterRelations]));
  await assert.rejects(
    () => quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root })),
    /reverse-duplicate ID relation/,
    'Part verification keeps shard-wide reverse-duplicate checks',
  );
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([...initialRelations, ...laterRelations]));

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

test('an ID row owned by the other batch also answers this batch\'s reverse candidate in both prepare and verify', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-xbatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 501 }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.slice(0, 500).map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: name === 'a_codex' && record.id === 'w1' ? ['표제501'] : [] }] }))));
  }
  // The valid ID link is owned by batch 02 (w501 -> w1); its reverse is batch 01's candidate.
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([
    { source_record_id: 'w501', source_sense_id: 'w501-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 3 },
  ]));
  const args = (command) => [command, '--shard', '001', '--batch', '01'];
  const prepared = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(prepared), []);
  assert.equal(prepared.stats.skipped_existing, 1);
  const counts = await quiet(() => run(args('verify'), { root }));
  assert.equal(counts.missing, 0);
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
  const idRow = { source_record_id: 'w501', source_sense_id: 'w501-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 3 };
  const otherSenseRow = { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w501', target_sense_id: 'w501-s2', type: 'scene', relevance: 4, reverse_type: 'scene', reverse_relevance: 4 };
  const other = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '다른 말', type: 'scene', relevance: 4 };
  const named = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '무관 말', type: 'scene', relevance: 5 };
  const dropOf = (candidate) => ({ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate, reason: '무관' });
  const verify = async (relations, drops) => {
    await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl(relations));
    await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), drops.length ? jsonl(drops) : '');
    return quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([idRow]));
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
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl([
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
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([link('w2-s1')]));

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
  await quiet(() => run(['merge', '--checkpoint', partCheckpoint], { root }));
  const accountedPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(accountedPart.missing, 0);
  await rm(path.join(root, partCheckpoint));

  await quiet(() => run([
    'prepare', '--shard', '001', '--batch', '01', '--part', '01',
  ], { root }));
  const optional = await quiet(() => run([
    'read-chunk', '--checkpoint', partCheckpoint, '--source-sense-id', 'w1-s1', '--candidate', '미끄럼저항기',
  ], { root }));
  assert.deepEqual(optional.items[0].candidates[0].unlinked_target_sense_ids, ['w2-s2']);
  const additionalLink = {
    source_sense_id: 'w1-s1', candidate: '미끄럼저항기', disposition: 'relation', target_resolution: 'exact',
    target_record_id: 'w2', target_sense_id: 'w2-s2', type: 'scene', relevance: 4, reverse_type: 'near', reverse_relevance: 5,
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
  await quiet(() => run(['merge', '--checkpoint', partCheckpoint], { root }));
  const linkedPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(linkedPart.missing, 0, 'a separately chosen relation to the other target sense is retained');
  assert.equal(linkedPart.relation, 2);

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), '');
  const newDecisionNeeded = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(newDecisionNeeded), ['미끄럼저항기'], 'without an existing link, the full target sense context remains available for a new relation decision');

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([link('w2-s1'), link('w2-s2')]));
  const fullyLinked = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(fullyLinked), [], 'a unique target with all senses linked is existing coverage');
  assert.equal(fullyLinked.stats.skipped_existing, 1);

  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), '');
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl([
    { source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '미끄럼저항기', reason: '출발 의미와 무관' },
  ]));
  await assert.rejects(() => quiet(() => run(args('verify'), { root })), /"미끄럼저항기" is named by the gloss of w1-s1 and cannot be dropped as unrelated/);
});

test('Stage 2 chunks bind exact senses, resume safely, and preserve text-only Parts and prior rows', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-chunks-'));
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
    type: 'association', relevance: 7, reverse_type: 'mood', reverse_relevance: 4,
  };
  const priorDrop = { source_record_id: 'w301', source_sense_id: 'w301-s1', candidate: '이전Drop', reason: '다른 sense에서만 맞는 표현' };
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([priorRelation]));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl([priorDrop]));
  await writeFile(path.join(root, 'data/relations/relation-002.jsonl'), jsonl([{
    source_record_id: 'w504', source_sense_id: 'w504-s1', target_record_id: 'w1', target_sense_id: 'w1-s1',
    type: 'scene', relevance: 2, reverse_type: 'mood', reverse_relevance: 5,
  }]));

  const checkpoint = '.warroom-scratch/relation-admission-001-01-01.json';
  const prepared = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(prepared.stats.to_edit, 5, 'the already approved reverse ID candidate is absorbed');
  const resumed = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.equal(resumed.items.length, prepared.items.length, 'prepare resumes the checkpoint instead of replacing it');
  assert.deepEqual(resumed.items[0].approved_peers, [{
    target_lemma: '역방향표적', target_sense_id: 'w504-s1', target_pos: 'noun', target_gloss: '이미 연결된 뜻', type: 'mood', relevance: 5,
  }], 'same-source reverse peers retain their own type and relevance');

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
    type: 'near', relevance: 1, reverse_type: 'mood', reverse_relevance: 6,
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
  await assert.rejects(() => quiet(() => run(['merge', '--checkpoint', checkpoint], { root })), /before merging/);

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
  const merged = await quiet(() => run(['merge', '--checkpoint', checkpoint], { root }));
  assert.deepEqual([merged.relations_added, merged.drops_added], [4, 1]);
  assert.deepEqual(await quiet(() => run(['merge', '--checkpoint', checkpoint], { root })), {
    merged: true, relations_added: 0, drops_added: 0, checkpoint: path.join(root, checkpoint),
  }, 'a repeated merge is idempotent');
  assert.ok((await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8')).includes(JSON.stringify(priorRelation)));
  assert.ok((await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8')).includes(JSON.stringify(priorDrop)));
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
  await quiet(() => run(['merge', '--checkpoint', textOnlyCheckpoint], { root }));
  const textOnlyCounts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
  assert.deepEqual([textOnlyCounts.unique, textOnlyCounts.relation, textOnlyCounts.drop, textOnlyCounts.missing], [1, 1, 0, 0], 'a fully text-only Part remains valid when no exact Canonical target exists');
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

  const merged = await quiet(() => run(['merge', '--checkpoint', checkpoint], { root }));
  assert.deepEqual([merged.relations_added, merged.drops_added], [1, 1]);
  const counts = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual([counts.unique, counts.relation, counts.drop, counts.missing], [2, 1, 1, 0]);
  const relations = (await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const drops = (await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(relations.map((row) => row.text), ['가로']);
  assert.deepEqual(drops.map((row) => row.candidate), ['무관후보'], 'the earlier valid decision remains intact when the rejected Drop is revised');
});

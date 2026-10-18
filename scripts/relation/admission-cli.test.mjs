import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from './admission-cli.mjs';

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

async function repository(t, { relations = [], drops = [] } = {}) {
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
  return root;
}

const quiet = async (callback) => {
  const log = console.log;
  console.log = () => {};
  try { return await callback(); } finally { console.log = log; }
};
const texts = (payload) => payload.items.flatMap((item) => item.candidates.map((candidate) => candidate.text)).sort();

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

test('a candidate answered by the reverse of a stored ID pair cannot also be a Drop or a text-only row', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-admission-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = Array.from({ length: 501 }, (_, i) => ({ id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }] }));
  for (const dir of ['data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(records));
  for (const name of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    await writeFile(path.join(root, `data/relation-candidates/001/001_01_${name}.jsonl`), jsonl(records.slice(0, 500).map((record) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: name === 'a_codex' && record.id === 'w1' ? ['표제501', '다른 말'] : [] }],
    }))));
  }
  const idRow = { source_record_id: 'w501', source_sense_id: 'w501-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 3 };
  const other = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '다른 말', type: 'scene', relevance: 4 };
  const dropOf = (candidate) => ({ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate, reason: '무관' });
  const verify = async (relations, drops) => {
    await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl(relations));
    await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), drops.length ? jsonl(drops) : '');
    return quiet(() => run(['verify', '--shard', '001', '--batch', '01'], { root }));
  };
  // Positive control: the reverse answers 표제501; 다른 말 is authored once.
  assert.equal((await verify([idRow, other], [])).reverse_covered, 1);
  // The same candidate also dropped or also authored text-only is a double disposition.
  await assert.rejects(() => verify([idRow, other], [dropOf('표제501')]), /reverse of a stored ID pair .* cannot also be a drop/);
  await assert.rejects(() => verify([idRow, other, { ...other, text: '표제501' }], []), /cannot also be a text-only relation/);
  // A different candidate of the same sense may still be dropped normally.
  assert.equal((await verify([idRow], [dropOf('다른 말')])).drop, 1);
});

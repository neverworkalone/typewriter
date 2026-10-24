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

  const firstPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual(
    [firstPart.raw, firstPart.unique, firstPart.merged_duplicates, firstPart.relation, firstPart.drop, firstPart.reverse_covered, firstPart.missing],
    [4, 3, 1, 1, 1, 1, 0],
    'Part 01 completes without requiring unrelated candidates in Parts 02–05 to be accounted',
  );
  const secondPart = await quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '02'], { root }));
  assert.deepEqual(
    [secondPart.raw, secondPart.unique, secondPart.merged_duplicates, secondPart.relation, secondPart.drop, secondPart.missing],
    [3, 3, 0, 2, 1, 0],
  );
  const preparedAgain = await quiet(() => run(['prepare', '--shard', '001', '--batch', '01', '--part', '01'], { root }));
  assert.deepEqual(preparedAgain.items, [], 'an approved ID pair, text-only Relation and Drop remain decided on re-run');
  assert.deepEqual(
    [preparedAgain.stats.raw, preparedAgain.stats.unique, preparedAgain.stats.merged_duplicates, preparedAgain.stats.skipped_existing, preparedAgain.stats.skipped_dropped],
    [4, 3, 1, 2, 1],
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
    () => quiet(() => run(['verify', '--shard', '001', '--batch', '01', '--part', '03'], { root })),
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
  assert.ok(texts(prepared).includes('표제501'), 'an existing link to sense 1 must leave the candidate available for sense 2');
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

test('verify and prepare resolve Canonical orthographic search forms without closing partially linked targets', async (t) => {
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
  await writeFile(path.join(root, 'data/relation-candidates/001/001_01_a_codex.jsonl'), jsonl([
    { record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates: ['미끄럼저항기'] }] },
    { record_id: 'w2', senses: [{ sense_id: 'w2-s1', candidates: [] }, { sense_id: 'w2-s2', candidates: [] }] },
  ]));
  const link = (targetSense) => ({
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: targetSense,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  });
  const args = (command) => [command, '--shard', '001', '--allow-partial'];
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([link('w2-s1')]));

  const partiallyLinked = await quiet(() => run(args('prepare'), { root }));
  assert.deepEqual(texts(partiallyLinked), ['미끄럼저항기'], 'the target stays editable until every sense is linked');
  assert.equal((await quiet(() => run(args('verify'), { root }))).missing, 0, 'the ID relation answers its orthographic alias');

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

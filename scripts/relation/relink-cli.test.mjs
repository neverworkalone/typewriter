import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseCorrections, relink } from './relink-cli.mjs';

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const sense = (id, gloss = `뜻:${id}.`) => ({ id, pos: 'noun', gloss });
const filler = (prefix, count) => Array.from({ length: count }, (_, index) => {
  const serial = String(index + 1).padStart(6, '0');
  return { id: `${prefix}${serial}`, lemma: `표제${prefix}${serial}`, search_forms: [`표제${prefix}${serial}`], senses: [sense(`${prefix}${serial}-s1`)] };
});

// Persisted ID rows of shard 001 (compact schema). R1..R7 are the base set every case starts from.
const R1 = { id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'near', rv: 5, ver: 1, fm: ['반짝'], rfm: ['차분하다'] };
const R2 = { id: 'w1', sid: 'w1-s1', tid: 'w3', tsid: 'w3-s1', tp: 'scene', rv: 4, ver: 1, fm: ['물결'], rfm: ['차분하다'] };
const R3 = { id: 'w1', sid: 'w1-s1', tid: 'w4', tsid: 'w4-s1', tp: 'association', rv: 3, ver: 1, fm: ['물빛 놀이', '물빛놀이'], rfm: [] };
const R4 = { id: 'w1', sid: 'w1-s1', tt: '어렴풋이', tp: 'mood', rv: 3 };
const R5 = { id: 'w1', sid: 'w1-s1', tid: 'w2000', tsid: 'w2000-s1', tp: 'sensory', rv: 6, ver: 1, fm: ['별빛'], rfm: ['차분하다'] };
const R6 = { id: 'w10', sid: 'w10-s1', tid: 'w2', tsid: 'w2-s1', tp: 'mood', rv: 2, ver: 1, fm: ['반짝'], rfm: ['고요'] };
const R7 = { id: 'w5', sid: 'w5-s1', tid: 'w1', tsid: 'w1-s1', tp: 'action', rv: 2, ver: 1, fm: ['차분하다'], rfm: [] };
const BASE = [R1, R2, R3, R4, R5, R6, R7];
const DROP = { id: 'w2', sid: 'w2-s2', cd: '차분하다', by: 'x' };
const CANDIDATES = {
  'w1-s1': ['반짝', '물결', '물빛 놀이', '물빛놀이', '어렴풋이', '별빛'],
  'w10-s1': ['반짝'],
  'w2-s2': ['차분하다'],
  'w3-s1': ['차분하다'],
  'w5-s1': ['차분하다'],
  'w2000-s1': ['차분하다'],
};

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-relation-relink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = [
    { id: 'w1', lemma: '차분하다', search_forms: ['차분하다'], senses: [sense('w1-s1')] },
    { id: 'w2', lemma: '반짝', search_forms: ['반짝'], senses: [sense('w2-s1'), sense('w2-s2')] },
    { id: 'w3', lemma: '물결', search_forms: ['물결'], senses: [sense('w3-s1')] },
    { id: 'w4', lemma: '물빛 놀이', search_forms: ['물빛 놀이', '물빛놀이'], senses: [sense('w4-s1')] },
    { id: 'w5', lemma: '반짝', search_forms: ['반짝'], senses: [sense('w5-s1')] },
    { id: 'w10', lemma: '고요', search_forms: ['고요'], senses: [sense('w10-s1')] },
  ];
  const shards = { '001': [...local, ...filler('x', 1000 - local.length)],
    '002': [{ id: 'w2000', lemma: '별빛', search_forms: ['별빛'], senses: [sense('w2000-s1')] }, ...filler('y', 499)] };
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relation-candidates/002', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [shard, records] of Object.entries(shards)) {
    await writeFile(path.join(root, `data/canonical/stdict-0${shard}.jsonl`), jsonl(records));
    const batches = shard === '001' ? ['01', '02'] : ['01'];
    for (const batch of batches) {
      const batchRows = records.slice((Number(batch) - 1) * 500, Number(batch) * 500);
      const producers = shard === '001' ? ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'] : ['a_codex'];
      for (const producer of producers) {
        const rows = batchRows.map((record) => ({ record_id: record.id, senses: record.senses.map((item) => ({
          sense_id: item.id, candidates: producer === 'a_codex' ? CANDIDATES[item.id] ?? [] : [] })) }));
        await writeFile(path.join(root, `data/relation-candidates/${shard}/${shard}_${batch}_${producer}.jsonl`), jsonl(rows));
      }
    }
  }
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl(BASE));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), jsonl([DROP]));
  return root;
}

const snapshot = async (root) => {
  const files = {};
  for (const directory of ['data/relations', 'data/relation-drops']) {
    for (const name of await readdir(path.join(root, directory))) files[`${directory}/${name}`] = await readFile(path.join(root, directory, name), 'utf8');
  }
  return files;
};
const input = (...corrections) => JSON.stringify({ shard: '001', corrections: corrections.map(([expected, to]) => ({ expected, to })) });
const toId = (row, tid, tsid) => [row, { tid, tsid }];
const textOnly = (row) => [row, { text_only: true }];
const readRelations = async (root) => (await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8')).split('\n').filter(Boolean);
const rowsOf = (lines) => lines.map((line) => JSON.parse(line));

// Each case: input, then either `after` (the exact persisted rows expected) or `reject` (error pattern).
const CASES = [
  { name: 'ID -> another sense of the same record: fm kept, rfm recomputed against the Drop on the new target',
    input: input(toId(R1, 'w2', 'w2-s2')),
    after: [{ ...R1, tsid: 'w2-s2', rfm: [] }, R2, R3, R4, R5, R6, R7] },
  { name: 'ID -> text-only, single fm',
    input: input(textOnly(R1)),
    after: [{ id: 'w1', sid: 'w1-s1', tt: '반짝', tp: 'near', rv: 5 }, R2, R3, R4, R5, R6, R7] },
  { name: 'ID -> text-only, multiple fm: every candidate becomes a text row, reverse projection dropped',
    input: input(textOnly(R3)),
    after: [R1, R2, { id: 'w1', sid: 'w1-s1', tt: '물빛 놀이', tp: 'association', rv: 3 },
      { id: 'w1', sid: 'w1-s1', tt: '물빛놀이', tp: 'association', rv: 3 }, R4, R5, R6, R7] },
  { name: 'several corrections are recomputed together',
    input: input(toId(R1, 'w2', 'w2-s2'), toId(R6, 'w2', 'w2-s2'), textOnly(R3)),
    after: [{ ...R1, tsid: 'w2-s2', rfm: [] }, R2, { id: 'w1', sid: 'w1-s1', tt: '물빛 놀이', tp: 'association', rv: 3 },
      { id: 'w1', sid: 'w1-s1', tt: '물빛놀이', tp: 'association', rv: 3 }, R4, R5, { ...R6, tsid: 'w2-s2', rfm: ['고요'] }, R7] },
  { name: 'stale expected row: tier', input: input(toId({ ...R1, rv: 4 }, 'w2', 'w2-s2')), reject: /does not match any persisted row/u },
  { name: 'stale expected row: rfm', input: input(toId({ ...R1, rfm: [] }, 'w2', 'w2-s2')), reject: /does not match any persisted row/u },
  { name: 'expected row is text-only', input: input(textOnly(R4)), reject: /complete persisted ID Relation row/u },
  { name: 'expected row lacks fm/ver (legacy)', input: input(toId({ id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'near', rv: 5 }, 'w2', 'w2-s2')),
    reject: /complete persisted ID Relation row/u },
  { name: 'new target sense does not exist', input: input(toId(R1, 'w2', 'w2-s9')), reject: /not a Canonical sense of w2/u },
  { name: 'new target sense belongs to another record', input: input(toId(R1, 'w3', 'w2-s2')), reject: /not a Canonical sense of w3/u },
  { name: 'new target does not match the candidate spelling', input: input(toId(R1, 'w10', 'w10-s1')), reject: /does not resolve to w10/u },
  { name: 'new target equals the current target', input: input(toId(R1, 'w2', 'w2-s1')), reject: /equals the current target/u },
  { name: 'reverse-duplicate of a surviving ID pair', input: input(toId(R1, 'w5', 'w5-s1')), reject: /reverse-duplicate/u },
  { name: 'same row corrected twice', input: input(toId(R1, 'w2', 'w2-s2'), textOnly(R1)), reject: /repeats an expected row/u },
  { name: 'old target loses candidate coverage in the same shard', input: input(textOnly(R2)), reject: /w3-s1.*차분하다/u },
  { name: 'old target loses candidate coverage in another shard', input: input(textOnly(R5)), reject: /shard 002.*w2000-s1/u },
];

for (const item of CASES) {
  test(`relink: ${item.name}`, async (t) => {
    const root = await repository(t);
    const before = await snapshot(root);
    const run = async (dryRun) => relink(parseCorrections(item.input), { root, dryRun });
    if (item.reject) {
      await assert.rejects(run(true), item.reject);
      await assert.rejects(run(false), item.reject);
      assert.deepEqual(await snapshot(root), before, 'a rejected run must leave every file unchanged');
      return;
    }
    const dry = await run(true);
    assert.deepEqual(await snapshot(root), before, '--dry-run must not write');
    const lines = await readRelations(root);
    const applied = await run(false);
    assert.deepEqual({ ...dry, status: null }, { ...applied, status: null }, 'dry-run reports the same result as apply');
    const after = await readRelations(root);
    assert.deepEqual(rowsOf(after), item.after);
    const unchanged = new Set(item.after.map((row) => JSON.stringify(row)));
    for (const line of lines) if (after.includes(line)) assert.ok(unchanged.has(JSON.stringify(JSON.parse(line))), 'unchanged rows keep their original text');
    assert.deepEqual((await snapshot(root))['data/relation-drops/drop-001.jsonl'], before['data/relation-drops/drop-001.jsonl']);
  });
}

test('relink: input grammar rejects extra keys and bad shards', () => {
  for (const bad of [
    '{"shard":"001"}', '{"shard":"1","corrections":[]}', '{"shard":"001","corrections":[]}',
    JSON.stringify({ shard: '001', corrections: [{ expected: R1, to: { tid: 'w2', tsid: 'w2-s2', extra: 1 } }] }),
    JSON.stringify({ shard: '001', corrections: [{ expected: R1, to: { text_only: false } }] }),
  ]) assert.throws(() => parseCorrections(bad), /Relink rejected|shard/u);
});

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chunkSenseGroups, run } from './edit-cli.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const quiet = async (callback) => {
  const log = console.log;
  const write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = () => true;
  try { return await callback(); } finally { console.log = log; process.stdout.write = write; }
};

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function stageCandidates(record) {
  if (record.id === 'w1') return { 'w1-s1': ['반짝', '물결', '어렴풋이', '유영'] };
  if (record.id === 'w2') return { 'w2-s1': ['차분하다'] };
  if (record.id === 'w3') return { 'w3-s2': ['차분하다'] };
  return {};
}

async function repository(t, { crossShardTarget = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-relation-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { id: 'w1', lemma: '차분하다', senses: [{ id: 'w1-s1', pos: 'verb', gloss: '마음이 가라앉아 조용하다.' }] };
  const deletedTarget = { id: 'w2', lemma: '반짝', senses: [
    { id: 'w2-s1', pos: 'noun', gloss: '작고 강한 빛이 잠깐 빛나다.' },
    { id: 'w2-s2', pos: 'noun', gloss: '눈에 띄게 두드러지는 모양.' },
  ] };
  const repairTarget = { id: 'w3', lemma: '물결', senses: [
    { id: 'w3-s1', pos: 'noun', gloss: '물이 이루는 잔물결.' },
    { id: 'w3-s2', pos: 'noun', gloss: '바다에서 물이 높아졌다 낮아지는 모양.' },
  ] };
  const keptTarget = { id: 'w4', lemma: '유영', senses: [{ id: 'w4-s1', pos: 'noun', gloss: '물속에서 헤엄침.' }] };
  const owned = crossShardTarget ? [source, repairTarget, keptTarget] : [source, deletedTarget, repairTarget, keptTarget];
  const fillers = Array.from({ length: 1000 - owned.length }, (_, index) => {
    const serial = String(index + 5).padStart(4, '0');
    return { id: `w${serial}`, lemma: `표제${serial}`, senses: [{ id: `w${serial}-s1`, pos: 'noun', gloss: `뜻${serial}.` }] };
  });
  const canonical = [...owned, ...fillers];
  const external = crossShardTarget ? [deletedTarget] : [];
  for (const directory of [
    'data/canonical', 'data/relation-candidates/001', 'data/relations', 'data/relation-drops',
  ]) await mkdir(path.join(root, directory), { recursive: true });
  if (external.length) await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await writeFile(path.join(root, 'data/canonical/stdict-0001.jsonl'), jsonl(canonical));
  if (external.length) await writeFile(path.join(root, 'data/canonical/stdict-0002.jsonl'), jsonl(external));

  const relations = [
    { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: 'w2-s1',
      type: 'sensory', relevance: 7, reverse_type: 'sensory', reverse_relevance: 7,
      candidate_assignment_version: 1, candidate_forms: ['반짝'], reverse_candidate_forms: ['차분하다'] },
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '물결', type: 'scene', relevance: 4 },
    { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '어렴풋이', type: 'mood', relevance: 3 },
    { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w4', target_sense_id: 'w4-s1',
      type: 'association', relevance: 5, reverse_type: 'association', reverse_relevance: 5,
      candidate_assignment_version: 1, candidate_forms: ['유영'], reverse_candidate_forms: [] },
  ];
  const drops = [{ source_record_id: 'w3', source_sense_id: 'w3-s2', candidate: '차분하다', reason: 'edit' }];
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), serializeRelationJsonl(relations));
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), serializeDropJsonl(drops));

  const producers = ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'];
  for (const batch of ['01', '02']) {
    const offset = (Number(batch) - 1) * 500;
    const batchRows = canonical.slice(offset, offset + 500);
    for (const producer of producers) {
      const assigned = producer === 'a_codex';
      const rows = batchRows.map((record) => ({
        record_id: record.id,
        senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: assigned ? stageCandidates(record)[sense.id] ?? [] : [] })),
      }));
      await writeFile(path.join(root, `data/relation-candidates/001/001_${batch}_${producer}.jsonl`), jsonl(rows));
    }
  }

  git(root, 'init', '-q', '--initial-branch=master');
  git(root, 'config', 'user.name', 'Typewriter Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Stage 2 baseline');
  return root;
}

async function save(root, text) {
  const input = path.join(root, '.warroom-scratch', 'decisions.txt');
  await mkdir(path.dirname(input), { recursive: true });
  await writeFile(input, text, 'utf8');
  return quiet(() => run(['save-chunk', '--shard', '001', '--in', input], { root }));
}

async function addSecondSenseTextRelation(root) {
  const canonicalPath = path.join(root, 'data/canonical/stdict-0001.jsonl');
  const canonicalRows = (await readFile(canonicalPath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const source = canonicalRows.find((record) => record.id === 'w1');
  source.senses.push({ id: 'w1-s2', pos: 'verb', gloss: '첫째 뜻과 구별되는 둘째 뜻.' });
  await writeFile(canonicalPath, jsonl(canonicalRows));

  for (const producer of ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex']) {
    const candidatePath = path.join(root, `data/relation-candidates/001/001_01_${producer}.jsonl`);
    const candidateRows = (await readFile(candidatePath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    const candidateSource = candidateRows.find((record) => record.record_id === 'w1');
    candidateSource.senses.push({ sense_id: 'w1-s2', candidates: producer === 'a_codex' ? ['물결'] : [] });
    await writeFile(candidatePath, jsonl(candidateRows));
  }

  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const relations = parseRelationJsonl(await readFile(relationPath, 'utf8'));
  relations.push({ source_record_id: 'w1', source_sense_id: 'w1-s2', text: '물결', type: 'scene', relevance: 4 });
  await writeFile(relationPath, serializeRelationJsonl(relations));
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Add a second source Sense for stale edit regression');
}

async function swapRelationRows(root, left, right, message) {
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const relations = parseRelationJsonl(await readFile(relationPath, 'utf8'));
  [relations[left - 1], relations[right - 1]] = [relations[right - 1], relations[left - 1]];
  await writeFile(relationPath, serializeRelationJsonl(relations));
  git(root, 'add', 'data/relations/relation-001.jsonl');
  git(root, 'commit', '-qm', message);
}

test('Sense grouping targets 350–500 Relation rows without splitting any source Sense', () => {
  const groups = [200, 200, 100, 70].map((size, index) => ({ sense: String(index), relations: Array(size).fill(index) }));
  const chunks = chunkSenseGroups(groups);
  assert.deepEqual(chunks.map((chunk) => chunk.reduce((sum, group) => sum + group.relations.length, 0)), [500, 70]);
  assert.deepEqual(chunks.map((chunk) => chunk.map((group) => group.sense)), [['0', '1', '2'], ['3']]);
});

test('prepare, compact read, exact Link Repair, local orphan Drops, apply, and Git-diff report compose', async (t) => {
  const root = await repository(t);
  const prepared = await quiet(() => run(['prepare', '--shard', '001'], { root }));
  assert.deepEqual(prepared, { shard: '001', chunk_count: 1, relation_count: 4, resumed: false });
  const checkpointPath = path.join(root, '.warroom-scratch/relation-edit-001.json');
  const checkpointBefore = await readFile(checkpointPath, 'utf8');
  const checkpoint = JSON.parse(checkpointBefore);
  assert.deepEqual(Object.keys(checkpoint).sort(), ['chunk_total', 'completed_chunks', 'decisions', 'shard', 'version']);

  const view = await quiet(() => run(['read-chunk', '--shard', '001'], { root }));
  assert.equal(view.relation_count, 4);
  assert.equal(view.senses.length, 1);
  assert.equal(view.senses[0].source.gloss, '마음이 가라앉아 조용하다.');
  assert.equal(view.senses[0].relations[0].target_gloss, '작고 강한 빛이 잠깐 빛나다.');
  const repair = view.senses[0].relations.find((row) => row.text === '물결');
  assert.deepEqual(repair.targets.map((target) => target.alias), ['T1', 'T2']);
  assert.deepEqual(repair.targets.map((target) => target.gloss), ['물이 이루는 잔물결.', '바다에서 물이 높아졌다 낮아지는 모양.']);
  assert.equal(view.senses[0].relations.find((row) => row.text === '어렴풋이').targets.length, 0);

  await assert.rejects(save(root, 'chunk 001\nL 2 T99\n'), /not an exact Canonical target/u);
  assert.equal(await readFile(checkpointPath, 'utf8'), checkpointBefore, 'a rejected alias does not complete or alter a chunk');
  const saved = await save(root, 'chunk 001\nD 1\nL 2 T2\n');
  assert.deepEqual({ dropped: saved.dropped, repaired: saved.repaired, kept: saved.kept }, { dropped: 1, repaired: 1, kept: 2 });
  assert.deepEqual((await quiet(() => run(['read-chunk', '--shard', '001'], { root }))).complete, true);

  const beforeRelationBytes = await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8');
  const beforeDropBytes = await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8');
  const result = await quiet(() => run(['apply', '--shard', '001'], { root }));
  assert.equal(result.status, 'applied');
  const relationText = await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8');
  const outputRelations = parseRelationJsonl(relationText);
  assert.equal(outputRelations.length, 3);
  assert.deepEqual(outputRelations[0], {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w3', target_sense_id: 'w3-s2',
    type: 'scene', relevance: 4, reverse_type: 'scene', reverse_relevance: 4,
    candidate_assignment_version: 1, candidate_forms: ['물결'], reverse_candidate_forms: [],
  });
  assert.ok(relationText.includes(JSON.stringify(JSON.parse(beforeRelationBytes.split('\n')[3]))),
    'an unchanged Relation row keeps its original compact JSON text');
  const outputDrops = parseDropJsonl(await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8'));
  assert.deepEqual(outputDrops.map((row) => [row.source_sense_id, row.candidate, row.reason]), [
    ['w3-s2', '차분하다', 'edit'], ['w1-s1', '반짝', 'edit'], ['w2-s1', '차분하다', 'edit'],
  ]);
  assert.equal(beforeDropBytes.split('\n').filter(Boolean).length, 1);

  const reapplied = await quiet(() => run(['apply', '--shard', '001'], { root }));
  assert.equal(reapplied.status, 'already-applied');
  assert.equal(await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8'), relationText);
  assert.equal(parseDropJsonl(await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8')).length, 3);

  const report = await quiet(() => run(['report', '--shard', '001'], { root }));
  assert.equal(report.deleted_relations.length, 1);
  assert.equal(report.deleted_relations[0].target.sense_id, 'w2-s1');
  assert.equal(report.deleted_relations[0].type, 'sensory');
  assert.equal(report.deleted_relations[0].tier, 7);
  assert.equal(report.link_repairs.length, 1);
  assert.equal(report.link_repairs[0].before.text, '물결');
  assert.equal(report.link_repairs[0].after.target.sense_id, 'w3-s2');
  assert.equal(report.link_repairs[0].after.type, 'scene');
  assert.equal(report.added_drops.length, 2);
  assert.notEqual(beforeRelationBytes, relationText);
});

test('deleting an ID Relation from shard 001 never writes a foreign shard Drop', async (t) => {
  const root = await repository(t, { crossShardTarget: true });
  await quiet(() => run(['prepare', '--shard', '001'], { root }));
  await save(root, 'chunk 001\nD 1\n');
  await quiet(() => run(['apply', '--shard', '001'], { root }));
  const drops = parseDropJsonl(await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8'));
  assert.ok(drops.some((row) => row.source_sense_id === 'w1-s1' && row.candidate === '반짝' && row.reason === 'edit'));
  assert.equal(drops.some((row) => row.source_sense_id === 'w2-s1'), false);
  await assert.rejects(access(path.join(root, 'data/relation-drops/drop-002.jsonl')), { code: 'ENOENT' });
});

test('deleting a text-only Relation creates only its local orphan Drop', async (t) => {
  const root = await repository(t);
  await quiet(() => run(['prepare', '--shard', '001'], { root }));
  await save(root, 'chunk 001\nD 3\n');
  const result = await quiet(() => run(['apply', '--shard', '001'], { root }));
  assert.equal(result.removed, 1);
  const relations = parseRelationJsonl(await readFile(path.join(root, 'data/relations/relation-001.jsonl'), 'utf8'));
  assert.equal(relations.some((row) => row.text === '어렴풋이'), false);
  const drops = parseDropJsonl(await readFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), 'utf8'));
  assert.ok(drops.some((row) => row.source_sense_id === 'w1-s1' && row.candidate === '어렴풋이' && row.reason === 'edit'));
});

test('invalid saved Link Repair fails before either Relation or Drop file changes', async (t) => {
  const root = await repository(t);
  await quiet(() => run(['prepare', '--shard', '001'], { root }));
  await save(root, 'chunk 001\nL 2 T2\n');
  const checkpointPath = path.join(root, '.warroom-scratch/relation-edit-001.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.decisions[0].target_record_id = 'w9999';
  checkpoint.decisions[0].target_sense_id = 'w9999-s1';
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  const relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  const dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  const relationBefore = await readFile(relationPath, 'utf8');
  const dropBefore = await readFile(dropPath, 'utf8');
  await assert.rejects(quiet(() => run(['apply', '--shard', '001'], { root })), /does not target an exact same-spelling Canonical sense/u);
  assert.equal(await readFile(relationPath, 'utf8'), relationBefore);
  assert.equal(await readFile(dropPath, 'utf8'), dropBefore);
});

test('apply refuses Drop and Link Repair decisions after their prepared Relation rows change', async (t) => {
  const root = await repository(t);
  await addSecondSenseTextRelation(root);
  await quiet(() => run(['prepare', '--shard', '001'], { root }));
  await save(root, 'chunk 001\nD 1\n');

  await swapRelationRows(root, 1, 4, 'Reorder ID Relations after a saved Drop');
  let relationPath = path.join(root, 'data/relations/relation-001.jsonl');
  let dropPath = path.join(root, 'data/relation-drops/drop-001.jsonl');
  let relationBefore = await readFile(relationPath, 'utf8');
  let dropBefore = await readFile(dropPath, 'utf8');
  await assert.rejects(quiet(() => run(['apply', '--shard', '001'], { root })), /no longer matches its prepared Relation input/u);
  assert.equal(await readFile(relationPath, 'utf8'), relationBefore);
  assert.equal(await readFile(dropPath, 'utf8'), dropBefore);

  await rm(path.join(root, '.warroom-scratch'), { recursive: true, force: true });
  await quiet(() => run(['prepare', '--shard', '001'], { root }));
  await save(root, 'chunk 001\nL 2 T2\n');
  await swapRelationRows(root, 2, 5, 'Move a Link Repair candidate to a different source Sense');
  relationBefore = await readFile(relationPath, 'utf8');
  dropBefore = await readFile(dropPath, 'utf8');
  await assert.rejects(quiet(() => run(['apply', '--shard', '001'], { root })), /no longer matches its prepared Relation input/u);
  assert.equal(await readFile(relationPath, 'utf8'), relationBefore);
  assert.equal(await readFile(dropPath, 'utf8'), dropBefore);
});

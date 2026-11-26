import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseDropExclusionJsonl, parseDropJsonl, parseRelationJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';
import { RefineInputError } from './refine/core.mjs';
import { run } from './s4-cli.mjs';

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const quiet = async (callback) => {
  const write = process.stdout.write;
  const log = console.log;
  process.stdout.write = () => true;
  console.log = () => {};
  try { return await callback(); } finally { process.stdout.write = write; console.log = log; }
};
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const sense = (id, pos, gloss) => ({ id, pos, gloss });
const filler = (prefix, from, count) => Array.from({ length: count }, (_, index) => {
  const id = `w${prefix}${String(from + index).padStart(4, '0')}`;
  return { id, lemma: `표제${id}`, search_forms: [`표제${id}`], senses: [sense(`${id}-s1`, 'noun', `뜻:${id}.`)] };
});
const idRow = (source, target, type, relevance, extra = {}) => ({
  source_record_id: source.split('-')[0], source_sense_id: source, target_record_id: target.split('-')[0], target_sense_id: target,
  type, relevance, reverse_type: type, reverse_relevance: relevance, ...extra,
});

// Shard 001: 고요 (two Senses), 물결, 흐르다, an idiom 물 뿌린 듯이 and 쓸쓸하다 with no Relation; shard 002: 별빛, 반짝이다.
const FAR = 'w10990-s1';   // a shard 001 filler in a later chunk, linked from 고요 s1
const EXCLUDED = 'w10994-s1';
const selection = (id) => id === 'w5-s1' ? 's' : id === EXCLUDED ? 'e' : 'p';
const RELATIONS_001 = [
  idRow('w1-s1', 'w3-s1', 'scene', 4, { candidate_assignment_version: 1, candidate_forms: ['물결'], reverse_candidate_forms: [] }),
  idRow('w1-s1', 'w2000-s1', 'mood', 3, { candidate_assignment_version: 1, candidate_forms: ['별빛'], reverse_candidate_forms: ['고요'] }),
  idRow('w1-s1', FAR, 'near', 5, { polish: true }),
  idRow('w4-s1', 'w5-s1', 'action', 5, { polish: true }),
  { source_record_id: 'w5', source_sense_id: 'w5-s1', text: '옛말', type: 'association', relevance: 6, polish: true },
];
const RELATIONS_002 = [idRow('w2001-s1', 'w1-s2', 'sensory', 5, { polish: true })];

async function repository(t, { select = selection } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-s4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const own = [
    { id: 'w1', lemma: '고요', search_forms: ['고요'], senses: [sense('w1-s1', 'noun', '조용하고 잠잠한 상태.'), sense('w1-s2', 'noun', '바람이 없는 상태.')] },
    { id: 'w3', lemma: '물결', search_forms: ['물결'], senses: [sense('w3-s1', 'noun', '물이 움직여 오르내리는 모양.')] },
    { id: 'w4', lemma: '흐르다', search_forms: ['흐르다'], senses: [sense('w4-s1', 'verb', '물이 낮은 곳으로 내려가다.')] },
    { id: 'w5', lemma: '물 뿌린 듯이', search_forms: ['물 뿌린 듯이'], senses: [sense('w5-s1', 'expression', '매우 조용한 모양.')] },
    { id: 'w6', lemma: '쓸쓸하다', search_forms: ['쓸쓸하다'], senses: [sense('w6-s1', 'adjective', '외롭고 적적하다.')] },
  ];
  const shards = {
    '001': [...own, ...filler(1, 0, 1000 - own.length)],
    '002': [{ id: 'w2000', lemma: '별빛', search_forms: ['별빛'], senses: [sense('w2000-s1', 'noun', '별의 빛.')] },
      { id: 'w2001', lemma: '반짝이다', search_forms: ['반짝이다'], senses: [sense('w2001-s1', 'verb', '빛이 잠깐 나타나다.')] },
      ...filler(2, 0, 498)],
  };
  const candidates = { 'w1-s1': ['물결', '별빛'], 'w2000-s1': ['고요'] };
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relation-candidates/002', 'data/relations', 'data/relation-drops', 'data/relation-selection']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [shard, records] of Object.entries(shards)) {
    await writeFile(path.join(root, `data/canonical/stdict-0${shard}.jsonl`), jsonl(records));
    await writeFile(path.join(root, `data/relation-selection/selection-${shard}.jsonl`), jsonl(records.flatMap((record) =>
      record.senses.map((item) => ({ id: item.id, d: select(item.id) })))));
    const producers = shard === '001' ? ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'] : ['a_codex'];
    for (const batch of shard === '001' ? ['01', '02'] : ['01']) {
      const rows = records.slice((Number(batch) - 1) * 500, Number(batch) * 500);
      for (const producer of producers) {
        await writeFile(path.join(root, `data/relation-candidates/${shard}/${shard}_${batch}_${producer}.jsonl`), jsonl(rows.map((record) => ({
          record_id: record.id,
          senses: record.senses.map((item) => ({ sense_id: item.id, candidates: producer === 'a_codex' ? candidates[item.id] ?? [] : [] })),
        }))));
      }
    }
  }
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), serializeRelationJsonl(RELATIONS_001));
  await writeFile(path.join(root, 'data/relations/relation-002.jsonl'), serializeRelationJsonl(RELATIONS_002));
  git(root, 'init', '-q', '--initial-branch=master');
  git(root, 'config', 'user.name', 'Typewriter Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Stage 3 baseline');
  return root;
}

const cli = (root, ...argv) => quiet(() => run(argv, { root }));
const read = (root, relative) => readFile(path.join(root, relative), 'utf8').catch(() => '');
const relations = async (root, shard) => parseRelationJsonl(await read(root, `data/relations/relation-${shard}.jsonl`));
const find = (view, senseId, label) => {
  const item = view.senses.find((entry) => entry.sense_id === senseId);
  return { sense: item.n, relation: item.relations.find((relation) => (relation.lemma ?? relation.text) === label)?.n };
};

async function save(root, chunk, lines) {
  const view = await cli(root, 'read-chunk', '--shard', '001', '--chunk', chunk);
  const file = path.join(root, '.warroom-scratch', `answer-${chunk}.txt`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${[`chunk ${chunk}`, ...lines(view)].join('\n')}\n`);
  return cli(root, 'save-chunk', '--shard', '001', '--chunk', chunk, '--in', file, '--expect-view-sha256', view.view_sha256);
}

async function saveNone(root, from, total) {
  for (let number = from; number <= total; number += 1) await save(root, String(number).padStart(3, '0'), () => ['none']);
}

test('Stage 4 shows selected Polish Senses in both directions and applies Add/Drop/Set across shards through Polish', async (t) => {
  const root = await repository(t);
  const prepared = await cli(root, 'prepare', '--shard', '001');
  assert.ok(prepared.chunk_count >= 2);

  const first = await cli(root, 'read-chunk', '--shard', '001', '--chunk', '001');
  const lines = first.prompt_view.split('\n');
  assert.match(lines[0], new RegExp(`^chunk 001/${String(prepared.chunk_count).padStart(3, '0')} senses \\d+ relations \\d+$`));
  assert.ok(lines.includes('W\t고요') && lines.includes('S5\tadjective\t외롭고 적적하다.'), 'selected Senses include one without Relations');
  assert.ok(!first.senses.some((entry) => entry.sense_id === 'w5-s1' || entry.sense_id === EXCLUDED));
  assert.ok(!lines.includes('W\t물 뿌린 듯이'));
  assert.ok(lines.some((line) => /^R\d+\t반짝이다\tverb\t/u.test(line)), 'the reverse row stored in shard 002 is shown');
  assert.ok(!first.prompt_view.includes('w2001'), 'no IDs in the model view');
  const lookup = await cli(root, 'lookup', '--text', '반짝이다');
  assert.match(lookup, /^Q\t반짝이다\nw2001-s1\t반짝이다\tverb\t/u);

  const saved = await save(root, '001', (view) => {
    const star = find(view, 'w1-s1', '별빛');
    const wave = find(view, 'w1-s1', '물결');
    const shine = find(view, 'w1-s2', '반짝이다');
    const flow = find(view, 'w4-s1', '물 뿌린 듯이');
    return [
      `D ${star.relation} ${shine.relation}`,                    // a forward cross-shard row and a reverse-only row
      `C ${wave.relation} mood 2`,
      `A ${find(view, 'w6-s1', '').sense} "적적함" mood 3`,        // a Sense without any Relation
      `A ${star.sense} w2001-s1 action 4`,
      `C ${flow.relation} action 7`,                              // the same row reviewed under 흐르다: kept
      `A ${star.sense} w1-s2 near 2`,                             // own record: discarded
      'D 9999',
    ];
  });
  assert.equal(saved.skipped, 0);
  assert.equal(saved.discarded.length, 2);
  await saveNone(root, 2, prepared.chunk_count);

  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.senses.skipped, 1);
  assert.equal(applied.senses.excluded, 1);
  assert.deepEqual(applied.selection, { p: 999, s: 1, e: 1 });
  assert.deepEqual(applied.affected_shards, ['001', '002']);
  assert.deepEqual(applied.changed_files, ['data/relation-drops/drop-001.jsonl', 'data/relation-drops/drop-002.jsonl',
    'data/relations/relation-001.jsonl', 'data/relations/relation-002.jsonl']);
  const own = await relations(root, '001');
  assert.equal(own.find((row) => row.target_sense_id === 'w3-s1').type, 'mood');
  assert.ok(!own.some((row) => row.target_sense_id === 'w2000-s1'));
  assert.equal(own.find((row) => row.target_sense_id === 'w5-s1').relevance, 7);
  assert.ok(own.some((row) => row.text === '적적함' && row.polish === true));
  assert.ok(own.some((row) => row.target_sense_id === 'w2001-s1' && row.polish === true && !('candidate_forms' in row)));
  assert.deepEqual(await relations(root, '002'), [], 'the reverse-only Drop edits the owning shard file');
  // Orphaned Candidates get `z` in their own shards, Polish exclusions `p` where the rows were stored.
  assert.deepEqual(parseDropJsonl(await read(root, 'data/relation-drops/drop-001.jsonl')).map((row) => [row.candidate, row.reason]), [['별빛', 'z']]);
  assert.deepEqual(parseDropJsonl(await read(root, 'data/relation-drops/drop-002.jsonl')).map((row) => [row.candidate, row.reason]), [['고요', 'z']]);
  assert.equal(parseDropExclusionJsonl(await read(root, 'data/relation-drops/drop-002.jsonl')).length, 1);

  // The PR is its own state: decisions recover the edits, an unchanged amend reproduces the bytes, a K undoes one.
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', '[S4/Sol] 001');
  const listed = await cli(root, 'decisions', '--shard', '001', '--base', base, '--senses', 'w1-s2');
  assert.deepEqual(listed.counts, { add: 2, drop: 2, set: 2 });
  assert.deepEqual(listed.rows.map((row) => row.op), ['drop']);
  const delta = path.join(root, '.warroom-scratch', 'delta.txt');
  await writeFile(delta, 'amend\nK w6-s1 "없는말"\n');
  assert.equal((await cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta)).status, 'already-applied');
  await writeFile(delta, 'amend\nK w1-s1 w3-s1\n');
  const amended = await cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta);
  assert.equal(amended.status, 'applied');
  assert.equal((await relations(root, '001')).find((row) => row.target_sense_id === 'w3-s1').type, 'scene');
  assert.deepEqual(Object.keys(amended.outputs).sort(), applied.changed_files);
  // An amend may not reach a relation without an end in the produced shard.
  await writeFile(delta, 'amend\nA w2000-s1 w2001-s1 near 3\n');
  await assert.rejects(cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta), RefineInputError);
});

test('#9928 conflicting chunk decisions resolve by key, whole decisions, independent of save order; a re-run apply is a no-op', async (t) => {
  const root = await repository(t);
  const prepared = await cli(root, 'prepare', '--shard', '001');
  let farChunk = null;
  for (let number = 2; number <= prepared.chunk_count && !farChunk; number += 1) {
    const view = await cli(root, 'read-chunk', '--shard', '001', '--chunk', String(number).padStart(3, '0'));
    if (view.senses.some((entry) => entry.sense_id === FAR)) farChunk = view.chunk;
  }
  assert.ok(farChunk, 'the far filler is in a later chunk');
  // The later chunk is saved first: it rebinds and drops 고요→FAR while reviewing FAR (not the stored source).
  await save(root, farChunk, (view) => {
    const row = find(view, FAR, '고요');
    return [`B ${row.relation} "새말"`];
  });
  await save(root, '001', (view) => [`C ${find(view, 'w1-s1', `표제w10990`).relation} mood 2`]);
  for (let number = 2; number <= prepared.chunk_count; number += 1) {
    const chunk = String(number).padStart(3, '0');
    if (chunk !== farChunk) await save(root, chunk, () => ['none']);
  }
  const scratch = path.join(root, '.warroom-scratch');
  const backup = path.join(root, '..', `${path.basename(root)}-scratch`);
  t.after(() => rm(backup, { recursive: true, force: true }));
  await cp(scratch, backup, { recursive: true });

  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.conflicts.length, 1);
  assert.equal(applied.conflicts[0].action, 'rebind');
  const own = await relations(root, '001');
  assert.equal(own.find((row) => row.target_sense_id === FAR).type, 'mood', 'the stored source Sense\'s decision wins');
  assert.ok(!own.some((row) => row.text === '새말'), 'the losing rebind applies neither half');

  // An interrupted finalization re-runs the same checkpoint: the same bytes are already there.
  await rm(scratch, { recursive: true, force: true });
  await cp(backup, scratch, { recursive: true });
  assert.equal((await cli(root, 'apply', '--shard', '001')).status, 'already-applied');
});

test('selected Polish Senses can complete with no change, but skip and all-invalid answers cannot complete them', async (t) => {
  const root = await repository(t);
  const prepared = await cli(root, 'prepare', '--shard', '001');
  await assert.rejects(save(root, '001', () => ['D 9999', 'A 1 w999999-s1 near 3']), /no valid judgment/u);
  await assert.rejects(save(root, '001', () => ['skip 1']), /fixed selection decisions/u);
  await assert.rejects(save(root, '001', (view) => ['skip 1', `D ${find(view, 'w1-s1', '별빛').relation}`]), RefineInputError);
  await saveNone(root, 1, prepared.chunk_count);
  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.status, 'no-change');
  assert.deepEqual(applied.changed_files, []);
  assert.equal(git(root, 'status', '--porcelain', '--', 'data'), '');
});

test('#10047 a record Policy Skip covers only its selected Polish Senses and counts apart from fixed selection', async (t) => {
  const root = await repository(t, { select: (id) => id === 'w1-s2' ? 's' : selection(id) });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  const whole = await cli(root, 'read-chunk', '--shard', '001', '--chunk', '001');
  const record = await cli(root, 'read-chunk', '--shard', '001', '--chunk', '001', '--record', 'w1');
  assert.equal(record.view_sha256, whole.view_sha256, 'a record run binds to the whole chunk digest');
  assert.deepEqual(record.senses.map((entry) => [entry.n, entry.sense_id]),
    whole.senses.filter((entry) => entry.record_id === 'w1').map((entry) => [entry.n, entry.sense_id]));
  assert.match(record.prompt_view, new RegExp(`^chunk 001/\\d{3} senses 1 relations ${record.relation_count}\\n`, 'u'));
  await assert.rejects(cli(root, 'read-chunk', '--shard', '001', '--chunk', '001', '--record', 'w999'), /no record w999/u);

  // An invalid Policy Skip refuses the whole save; nothing is counted twice.
  await assert.rejects(save(root, '001', () => ['P w999']), /unknown record w999/u);
  await assert.rejects(save(root, '001', (view) => ['P w1', `D ${find(view, 'w1-s1', '별빛').relation}`]), /also has an edit/u);
  await assert.rejects(save(root, '001', () => ['P w1 w1']), /twice/u);
  const saved = await save(root, '001', (view) => ['P w1', `C ${find(view, 'w3-s1', '고요').relation} mood 2`]);
  assert.equal(saved.policy_skipped, 1);
  assert.equal(saved.skipped, 0);
  await saveNone(root, 2, prepared.chunk_count);
  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.senses.policy_skipped, 1);
  assert.equal(applied.senses.skipped, 2);
  assert.equal(applied.senses.polished, applied.selection.p - 1);
  // Another Sense's edit of the Policy Skip record's relation follows the common contract; its other rows stay.
  const own = await relations(root, '001');
  assert.equal(own.find((row) => row.target_sense_id === 'w3-s1').type, 'mood');
  assert.ok(own.some((row) => row.target_sense_id === 'w2000-s1') && own.some((row) => row.target_sense_id === FAR));
});

test('a shard without Polish Senses has no AI chunks and uses the existing no-change path', async (t) => {
  const root = await repository(t, { select: (id) => id === EXCLUDED ? 'e' : 's' });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  assert.equal(prepared.chunk_count, 0);
  assert.deepEqual(await cli(root, 'read-chunk', '--shard', '001'), { shard: '001', complete: true, remaining_chunks: 0 });
  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.status, 'no-change');
  assert.deepEqual(applied.selection, { p: 0, s: 1000, e: 1 });
  assert.equal(applied.senses.polished, 0);
  assert.deepEqual(applied.changed_files, []);
  assert.equal(git(root, 'status', '--porcelain', '--', 'data'), '');
});

test('missing or invalid fixed selection refuses preparation without an AI selection fallback', async (t) => {
  const root = await repository(t);
  const file = path.join(root, 'data/relation-selection/selection-001.jsonl');
  const original = await readFile(file, 'utf8');
  await rm(file);
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Missing selection');
  await assert.rejects(cli(root, 'prepare', '--shard', '001'), /requires selection-001\.jsonl/u);
  await writeFile(file, original.replace('"d":"p"', '"d":"invalid"'));
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Invalid selection');
  await assert.rejects(cli(root, 'prepare', '--shard', '001'), /invalid selection-001\.jsonl/u);
});

test('#10174 an excluded Sense of another shard is checked against its own shard selection in save, apply and amend', async (t) => {
  // 반짝이다 (shard 002) is `e`, a shard 002 filler is `s`; shard 001 selection does not list either.
  const OTHER_S = 'w20005-s1';
  const root = await repository(t, { select: (id) => id === 'w2001-s1' ? 'e' : id === OTHER_S ? 's' : selection(id) });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  const saved = await save(root, '001', (view) => {
    const star = find(view, 'w1-s1', '별빛');
    return [
      `A ${star.sense} w2001-s1 action 4`,                  // other-shard e: discarded
      `B ${star.relation} w2001-s1 mood 3`,                 // rebind onto other-shard e: discarded
      `A ${star.sense} ${OTHER_S} near 4`,                  // other-shard s: a valid counterpart
      `A ${star.sense} "고요한 밤" scene 5`,                  // text-only Add needs no selection lookup
    ];
  });
  assert.deepEqual(saved.discarded.map((line) => line.replace(/^.*: /u, '')), ['target Sense is excluded', 'target Sense is excluded']);
  await saveNone(root, 2, prepared.chunk_count);

  // A submitted Add to the other-shard e is refused by apply itself, not only by save.
  const scratch = path.join(root, '.warroom-scratch');
  const [name] = (await readdir(scratch)).filter((file) => file.endsWith('.json') && file.includes('001'));
  const checkpoint = JSON.parse(await readFile(path.join(scratch, name), 'utf8'));
  const tampered = structuredClone(checkpoint);
  tampered.decisions.flatMap((decision) => decision.ops).find((op) => op.target_sense_id === OTHER_S).target_sense_id = 'w2001-s1';
  await writeFile(path.join(scratch, name), JSON.stringify(tampered));
  await assert.rejects(cli(root, 'apply', '--shard', '001'), /may not add a Relation to an excluded Sense/u);
  await writeFile(path.join(scratch, name), JSON.stringify(checkpoint));

  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.status, 'applied');
  const own = await relations(root, '001');
  assert.ok(own.some((row) => row.source_sense_id === 'w1-s1' && row.target_sense_id === OTHER_S));
  assert.ok(own.some((row) => row.source_sense_id === 'w1-s1' && row.text === '고요한 밤'));
  assert.ok(!own.some((row) => row.target_sense_id === 'w2001-s1' && row.source_sense_id === 'w1-s1'));

  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', '[S4/Sol] 001');
  const delta = path.join(scratch, 'delta.txt');
  await writeFile(delta, 'amend\nA w1-s1 w2001-s1 near 3\n');
  await assert.rejects(cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta), /may not add a Relation to an excluded Sense/u);
  await writeFile(delta, `amend\nA w1-s2 ${OTHER_S} near 3\n`);
  assert.equal((await cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta)).status, 'applied');
});

test('#10174 M moves only to a sibling Sense that is not excluded', async (t) => {
  const root = await repository(t, { select: (id) => id === 'w1-s2' ? 'e' : selection(id) });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  await assert.rejects(save(root, '001', (view) => [`M ${find(view, 'w1-s1', '별빛').relation} w1-s2`]), /no valid judgment/u);
  const saved = await save(root, '001', (view) => [`M ${find(view, 'w1-s1', '별빛').relation} w1-s2`, `C ${find(view, 'w1-s1', '물결').relation} mood 2`]);
  assert.deepEqual(saved.discarded.map((line) => line.replace(/^.*: /u, '')), ['destination Sense is excluded']);
  await saveNone(root, 2, prepared.chunk_count);
});

test('#10174 a missing or invalid selection of a referenced other shard stops the answer', async (t) => {
  const root = await repository(t);
  await cli(root, 'prepare', '--shard', '001');
  const answer = (view) => [`A ${find(view, 'w1-s1', '별빛').sense} w2001-s1 action 4`];
  const file = path.join(root, 'data/relation-selection/selection-002.jsonl');
  const original = await readFile(file, 'utf8');
  await rm(file);
  await assert.rejects(save(root, '001', answer), (error) => error instanceof RefineInputError && /requires selection-002\.jsonl/u.test(error.message));
  await writeFile(file, original.replace('"d":"p"', '"d":"x"'));
  await assert.rejects(save(root, '001', answer), (error) => error instanceof RefineInputError && /invalid selection-002\.jsonl/u.test(error.message));
});

test('a selected Relation can move to an unselected sibling Sense without authorizing independent Skip edits', async (t) => {
  const root = await repository(t, { select: (id) => id === 'w1-s2' ? 's' : selection(id) });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  const first = await cli(root, 'read-chunk', '--shard', '001', '--chunk', '001');
  assert.ok(!first.senses.some((entry) => entry.sense_id === 'w1-s2'));
  await save(root, '001', (view) => [`M ${find(view, 'w1-s1', '별빛').relation} w1-s2`]);
  await saveNone(root, 2, prepared.chunk_count);
  const applied = await cli(root, 'apply', '--shard', '001');
  assert.equal(applied.status, 'applied');
  const own = await relations(root, '001');
  assert.ok(!own.some((row) => row.source_sense_id === 'w1-s1' && row.target_sense_id === 'w2000-s1'));
  assert.ok(own.some((row) => row.source_sense_id === 'w1-s2' && row.target_sense_id === 'w2000-s1'));
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Move selected relation');
  const delta = path.join(root, '.warroom-scratch', 'delta.txt');
  await writeFile(delta, 'amend\nK w6-s1 "없는말"\n');
  assert.equal((await cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta)).status, 'already-applied');
  await writeFile(delta, 'amend\nA w5-s1 "독립편집" near 3\n');
  await assert.rejects(cli(root, 'amend', '--shard', '001', '--base', base, '--in', delta), /neither end is a selected Polish Sense/u);
});

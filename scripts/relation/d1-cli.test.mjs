import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRelationJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';
import { run } from './d1-cli.mjs';
import { run as runS4 } from './s4-cli.mjs';

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
const filler = (prefix, count) => Array.from({ length: count }, (_, index) => {
  const id = `w${prefix}${String(index).padStart(4, '0')}`;
  return { id, lemma: `표제${id}`, search_forms: [`표제${id}`], senses: [sense(`${id}-s1`, 'noun', `뜻:${id}.`)] };
});
const idRow = (source, target, type, relevance) => ({ source_record_id: source.split('-')[0], source_sense_id: source,
  target_record_id: target.split('-')[0], target_sense_id: target, type, relevance, reverse_type: type, reverse_relevance: relevance, polish: true });
const textRow = (source, text) => ({ source_record_id: source.split('-')[0], source_sense_id: source, text, type: 'association', relevance: 5, polish: true });

// Shard 001: 고요 (two `s` Senses), 물결 (`p`), 흐르다 and 몰리브데넘 (`s`), 쓸쓸하다 (`s`, no Relation), 아득하다 (`s`,
// a Relation stored only in 002's file). Shard 002: 별빛 (`s`) and 반짝이다 (`p`).
const OWN = [
  { id: 'w1', lemma: '고요', search_forms: ['고요'], senses: [sense('w1-s1', 'noun', '조용하고 잠잠한 상태.'), sense('w1-s2', 'noun', '바람이 없는 상태.')] },
  { id: 'w3', lemma: '물결', search_forms: ['물결'], senses: [sense('w3-s1', 'noun', '물이 움직여 오르내리는 모양.')] },
  { id: 'w4', lemma: '흐르다', search_forms: ['흐르다'], senses: [sense('w4-s1', 'verb', '물이 낮은 곳으로 내려가다.')] },
  { id: 'w5', lemma: '몰리브데넘', search_forms: ['몰리브데넘'], homograph_no: 1, senses: [sense('w5-s1', 'noun', '크로뮴족 원소의 하나.')] },
  { id: 'w6', lemma: '쓸쓸하다', search_forms: ['쓸쓸하다'], senses: [sense('w6-s1', 'adjective', '외롭고 적적하다.')] },
  { id: 'w7', lemma: '아득하다', search_forms: ['아득하다'], senses: [sense('w7-s1', 'adjective', '보기에 매우 멀다.')] },
];
const SKIP = new Set(['w1-s1', 'w1-s2', 'w4-s1', 'w5-s1', 'w6-s1', 'w7-s1', 'w2000-s1']);
const A = idRow('w1-s1', 'w3-s1', 'scene', 4);
const B = idRow('w1-s1', 'w2000-s1', 'mood', 3);
const C = idRow('w4-s1', 'w5-s1', 'association', 5);
const T = textRow('w5-s1', '금속');
const E = idRow('w3-s1', 'w1-s2', 'near', 2);
const F = idRow('w2001-s1', 'w5-s1', 'association', 6);
const G = idRow('w2001-s1', 'w2000-s1', 'sensory', 5);
const X = idRow('w2001-s1', 'w7-s1', 'mood', 4);

async function repository(t, { select = (id) => (SKIP.has(id) ? 's' : 'p'), extra001 = [], relations001 = [A, B, C, T, E] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-d1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shards = {
    '001': [...OWN, ...extra001, ...filler(1, 1000 - OWN.length - extra001.length)],
    '002': [{ id: 'w2000', lemma: '별빛', search_forms: ['별빛'], senses: [sense('w2000-s1', 'noun', '별의 빛.')] },
      { id: 'w2001', lemma: '반짝이다', search_forms: ['반짝이다'], senses: [sense('w2001-s1', 'verb', '빛이 잠깐 나타나다.')] }, ...filler(2, 498)],
  };
  // #10171: D1 is Relation-only, so there is no Candidate or Drop directory at all.
  for (const directory of ['data/canonical', 'data/relations', 'data/relation-selection']) await mkdir(path.join(root, directory), { recursive: true });
  for (const [shard, records] of Object.entries(shards)) {
    await writeFile(path.join(root, `data/canonical/stdict-0${shard}.jsonl`), jsonl(records));
    await writeFile(path.join(root, `data/relation-selection/selection-${shard}.jsonl`), jsonl(records.flatMap((record) =>
      record.senses.map((item) => ({ id: item.id, d: select(item.id) })))));
  }
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), serializeRelationJsonl(relations001));
  await writeFile(path.join(root, 'data/relations/relation-002.jsonl'), serializeRelationJsonl([F, G, X]));
  git(root, 'init', '-q', '--initial-branch=master');
  git(root, 'config', 'user.name', 'Typewriter Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'Stage 3 baseline');
  return root;
}

const cli = (root, ...argv) => quiet(() => run(argv, { root }));
const read = (root, relative) => readFile(path.join(root, relative), 'utf8').catch(() => '');
const shard = (root, name) => read(root, `data/relations/relation-${name}.jsonl`);
const keys = (text) => parseRelationJsonl(text).map((row) => `${row.source_sense_id}>${row.target_sense_id ?? row.text}`);

async function answer(root, chunk, lines) {
  const view = await cli(root, 'read-chunk', '--shard', '001', '--chunk', chunk);
  const file = path.join(root, '.warroom-scratch', `answer-${chunk}.txt`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${[`chunk ${chunk}`, ...(typeof lines === 'function' ? lines(view) : lines)].join('\n')}\n`);
  return { view, save: () => cli(root, 'save-chunk', '--shard', '001', '--chunk', chunk, '--in', file, '--expect-view-sha256', view.view_sha256) };
}
const numberOf = (view, id) => view.senses.find((entry) => entry.sense_id === id).n;
const delta = async (root, lines) => {
  const file = path.join(root, '.warroom-scratch', 'amend.txt');
  await writeFile(file, `${['amend', ...lines].join('\n')}\n`);
  return file;
};

async function produce(root, verdicts) {
  await cli(root, 'prepare', '--shard', '001');
  const { save } = await answer(root, '001', (view) => verdicts(view));
  await save();
  const applied = await cli(root, 'apply', '--shard', '001');
  const report = await cli(root, 'report', '--shard', '001');
  git(root, 'switch', '-qc', 'd1-001');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'D1 001');
  return { applied, report };
}

test('#10330 D1 judges Skip Senses by gloss only and drops only its own file\'s Relations of a D Sense, at either end', async (t) => {
  const root = await repository(t);
  const prepared = await cli(root, 'prepare', '--shard', '001');
  assert.equal(prepared.chunk_count, 1);
  const { view } = await answer(root, '001', []);
  // Only `s` Senses a Relation of 001's own file touches are judged: 쓸쓸하다 has none, 아득하다 only one stored in 002,
  // 물결 is `p`. No Relation reaches the model.
  assert.deepEqual(view.senses.map((entry) => entry.sense_id), ['w1-s1', 'w1-s2', 'w4-s1', 'w5-s1']);
  assert.equal(view.prompt_view, ['chunk 001/001 senses 4', 'W\t고요\t-', 'S1\tnoun\t조용하고 잠잠한 상태.', 'S2\tnoun\t바람이 없는 상태.',
    'W\t흐르다\t-', 'S3\tverb\t물이 낮은 곳으로 내려가다.', 'W\t몰리브데넘\t1', 'S4\tnoun\t크로뮴족 원소의 하나.'].join('\n'));

  const base = git(root, 'rev-parse', 'HEAD');
  const { applied, report } = await produce(root, (shown) => [`D ${numberOf(shown, 'w5-s1')} 4`, `D ${numberOf(shown, 'w4-s1')} 1`,
    `N ${numberOf(shown, 'w1-s1')}`, `D ${numberOf(shown, 'w1-s2')} 3`]);
  // 흐르다↔몰리브데넘 (both ends D) goes once, the text row of 몰리브데넘 (source D) and 물결→고요 s2 (only the target D) go.
  // 002's rows toward 몰리브데넘 and 아득하다 stay: they are 002's to refine. Only 001's Relation file changes.
  assert.equal(applied.status, 'applied');
  assert.equal(applied.removed_relations, 3);
  assert.deepEqual(applied.changed_files, ['data/relations/relation-001.jsonl']);
  assert.deepEqual(applied.senses, { skip_senses: 6, judged: 4, no_relations: 2, dropped: 3, not_target: 1, held: 0, policy_skipped: 0, by_category: { 1: 1, 3: 1, 4: 1 } });
  assert.deepEqual(git(root, 'diff', '--name-only', base, 'HEAD').split('\n'), applied.changed_files);
  assert.equal(await shard(root, '001'), serializeRelationJsonl([A, B]));
  assert.equal(await shard(root, '002'), serializeRelationJsonl([F, G, X]));
  assert.deepEqual([report.removed_relations, report.other_edits, report.diff.files, report.diff.deletions], [3, 0, 1, 3]);
  assert.deepEqual(report.decisions.map((entry) => [entry.sense, entry.verdict, entry.category]),
    [['w1-s1', 'N', null], ['w1-s2', 'D', 3], ['w4-s1', 'D', 1], ['w5-s1', 'D', 4]]);

  // The other shard's remaining rows toward a D Sense are not a finding.
  const verified = await cli(root, 'verify', '--shard', '001', '--base', base);
  assert.deepEqual([verified.ok, verified.d_senses, verified.removed_relations, verified.changed_files], [true, 3, 3, 1]);
  // verify fails on a missed own-file Relation of a D Sense, a drop of an unrelated one (고요 s1↔별빛), another file's
  // change (002's drop toward 몰리브데넘 and a retype) — all reported at once.
  const head = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), serializeRelationJsonl([A, C]));
  await writeFile(path.join(root, 'data/relations/relation-002.jsonl'), serializeRelationJsonl([{ ...G, type: 'mood', reverse_type: 'mood' }, X]));
  git(root, 'commit', '-qam', 'wrong D1');
  await assert.rejects(cli(root, 'verify', '--shard', '001', '--base', base), (error) => {
    assert.equal(error.family, 'd1-scope');
    assert.deepEqual([...error.errors].sort(), [
      'data/relations/relation-002.jsonl: a D1 PR changes data/relations/relation-001.jsonl only',
      'i|w1-s1|w2000-s1: dropped, but neither end is a D Sense',
      'i|w2000-s1|w2001-s1: a D1 PR only drops Relations (set)',
      'i|w4-s1|w5-s1: touches a D Sense but is not dropped',
    ]);
    return true;
  });
  // decisions and amend refuse a PR that changes another shard's file, and amend writes nothing.
  await assert.rejects(cli(root, 'decisions', '--shard', '001', '--base', base), /outside shard 001/u);
  const checkpoint = await read(root, '.warroom-scratch/relation-d1-001.json');
  await assert.rejects(cli(root, 'amend', '--shard', '001', '--base', base, '--in', await delta(root, ['N w1-s2'])), /outside shard 001/u);
  assert.equal(await read(root, '.warroom-scratch/relation-d1-001.json'), checkpoint);
  assert.equal(git(root, 'status', '--porcelain', '--', 'data'), '');
  git(root, 'reset', '-q', '--hard', head);
  // A later Stage 4 of the same shard prepares on the remaining Relations; no Candidate accounting stops it.
  const s4 = await quiet(() => runS4(['prepare', '--shard', '001'], { root }));
  assert.ok(s4.chunk_count >= 1);
});

test('#10171 a D1 answer must give every shown Sense exactly one valid verdict; nothing is filled in', async (t) => {
  const root = await repository(t);
  await cli(root, 'prepare', '--shard', '001');
  const checkpoint = () => read(root, '.warroom-scratch/relation-d1-001.json');
  const before = await checkpoint();
  for (const [lines, pattern] of [
    [['D 1 4', 'N 2 3'], /no verdict for Sense 4/u],
    [['D 1 4', 'N 1 2 3 4'], /more than once/u],
    [['D 1 4', 'D 1 5', 'N 2 3 4'], /more than once/u],
    [['N 1 2 3 4 5'], /unknown Sense 5/u],
    [['D 1 12', 'N 2 3 4'], /D must be/u],
    [['K 1', 'N 2 3 4'], /unknown line/u],
    [['none'], /unknown line/u],
  ]) {
    const { save } = await answer(root, '001', lines);
    await assert.rejects(save(), pattern);
    assert.equal(await checkpoint(), before);
  }
  // A Policy Skip covers its record's shown Senses; the rest still need verdicts.
  const { save } = await answer(root, '001', ['P w1', 'N 3', 'H 4']);
  assert.deepEqual((await save()).policy_skipped, 2);
});

test('#10171 D1 keeps its judgments through apply, report, decisions and amend; a restore keeps the amended state', async (t) => {
  const root = await repository(t);
  const base = git(root, 'rev-parse', 'HEAD');
  await produce(root, (view) => [`D ${numberOf(view, 'w5-s1')} 4`, `D ${numberOf(view, 'w4-s1')} 1`, `N ${numberOf(view, 'w1-s1')} ${numberOf(view, 'w1-s2')}`]);
  const listed = await cli(root, 'decisions', '--shard', '001', '--base', base, '--senses', 'w5-s1');
  assert.deepEqual(listed.decisions.map((entry) => [entry.sense, entry.verdict, entry.category, entry.lemma]),
    [['w1-s1', 'N', null, '고요'], ['w1-s2', 'N', null, '고요'], ['w4-s1', 'D', 1, '흐르다'], ['w5-s1', 'D', 4, '몰리브데넘']]);
  assert.deepEqual(listed.rows.map((row) => [row.source_sense_id, row.target_sense_id ?? row.text, row.status]),
    [['w4-s1', 'w5-s1', 'drop'], ['w5-s1', '금속', 'drop']]);

  // Withdrawing 몰리브데넘's D restores its own rows byte for byte; 흐르다↔몰리브데넘 stays dropped while 흐르다 is D.
  const withdrawn = await cli(root, 'amend', '--shard', '001', '--base', base, '--in', await delta(root, ['N w5-s1']));
  assert.equal(withdrawn.status, 'applied');
  assert.equal(await shard(root, '001'), serializeRelationJsonl([A, B, T, E]));
  assert.equal(await shard(root, '002'), serializeRelationJsonl([F, G, X]));
  assert.equal((await cli(root, 'amend', '--shard', '001', '--base', base, '--in', await delta(root, ['N w5-s1']))).status, 'already-applied');
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'amend 1');
  // A new D drops more.
  await cli(root, 'amend', '--shard', '001', '--base', base, '--in', await delta(root, ['D w1-s1 2']));
  assert.deepEqual(keys(await shard(root, '001')), ['w5-s1>금속', 'w3-s1>w1-s2']);
  git(root, 'add', 'data');
  git(root, 'commit', '-qm', 'amend');

  // A category-only amend changes the kept checkpoint and no data file.
  const data = await shard(root, '001');
  const recategorized = await cli(root, 'amend', '--shard', '001', '--base', base, '--in', await delta(root, ['D w4-s1 9']));
  assert.equal(recategorized.status, 'applied');
  assert.equal(await shard(root, '001'), data);
  assert.equal(git(root, 'status', '--porcelain', '--', 'data'), '');

  // A new worktree restored with the latest checkpoint and the original views keeps the amended category.
  const copy = path.join(root, '.restored');
  git(root, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  await cp(path.join(root, '.warroom-scratch'), path.join(copy, '.warroom-scratch'), { recursive: true });
  const restored = await cli(copy, 'decisions', '--shard', '001', '--base', base);
  // verify can read the judgments of another worktree (the batch worktree) from a clean checkout.
  const clean = path.join(root, '.clean');
  git(root, 'worktree', 'add', '-q', '--detach', clean, 'HEAD');
  assert.equal((await cli(clean, 'verify', '--shard', '001', '--base', base, '--judgments', copy)).ok, true);
  await assert.rejects(cli(clean, 'verify', '--shard', '001', '--base', base), /not prepared/u);
  assert.deepEqual(restored.decisions.map((entry) => [entry.sense, entry.verdict, entry.category]),
    [['w1-s1', 'D', 2], ['w1-s2', 'N', null], ['w4-s1', 'D', 9], ['w5-s1', 'N', null]]);
  // A view re-rendered from the current data is not the view the answers were bound to: the restore fails closed.
  const viewFile = path.join(copy, '.warroom-scratch/relation-d1-001/chunk-001.json');
  const rendered = JSON.parse(await readFile(viewFile, 'utf8'));
  await writeFile(viewFile, `${JSON.stringify({ ...rendered, senses: rendered.senses.slice(1) })}\n`);
  await assert.rejects(cli(copy, 'decisions', '--shard', '001', '--base', base), /not bound|no prepared view/u);

  // An amend that cannot be installed leaves both the data files and the checkpoint as they were.
  await delta(root, ['N w1-s1']);
  const checkpoint = await read(root, '.warroom-scratch/relation-d1-001.json');
  await chmod(path.join(root, '.warroom-scratch'), 0o555);
  try {
    await assert.rejects(cli(root, 'amend', '--shard', '001', '--base', base, '--in', path.join(root, '.warroom-scratch/amend.txt')));
  } finally {
    await chmod(path.join(root, '.warroom-scratch'), 0o755);
  }
  assert.equal(await read(root, '.warroom-scratch/relation-d1-001.json'), checkpoint);
  assert.equal(await shard(root, '001'), data);
  assert.deepEqual((await readdir(path.join(root, 'data/relations'))).filter((name) => /\.(?:tmp|bak)$/u.test(name)), []);
});

test('#10171 D1 chunks hold about 100 Sense judgments without splitting a record; no judged Relation is no change', async (t) => {
  const many = Array.from({ length: 250 }, (_, index) => {
    const id = `w9${String(index).padStart(4, '0')}`;
    return { id, lemma: `낱말${id}`, search_forms: [`낱말${id}`], senses: [sense(`${id}-s1`, 'noun', `뜻 ${id}.`), sense(`${id}-s2`, 'noun', `둘째 ${id}.`)].slice(0, index % 7 === 0 ? 2 : 1) };
  });
  const ids = new Set(many.flatMap((record) => record.senses.map((item) => item.id)));
  const root = await repository(t, { extra001: many, select: (id) => (ids.has(id) ? 's' : 'p'),
    relations001: [...ids].map((id) => textRow(id, `연상${id}`)) });
  const prepared = await cli(root, 'prepare', '--shard', '001');
  const sizes = [];
  for (let number = 1; number <= prepared.chunk_count; number += 1) {
    const view = await cli(root, 'read-chunk', '--shard', '001', '--chunk', String(number).padStart(3, '0'));
    sizes.push(view.sense_count);
    const records = view.senses.map((entry) => entry.record_id);
    assert.ok(records.every((record) => many.find((item) => item.id === record).senses.length === records.filter((other) => other === record).length));
  }
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), ids.size);
  assert.ok(sizes.slice(0, -1).every((size) => size >= 90 && size <= 100), JSON.stringify(sizes));

  // 쓸쓸하다 has no Relation and 아득하다 only one stored in 002 (#10330): nothing for 001 to judge or change.
  const empty = await repository(t, { select: (id) => (['w6-s1', 'w7-s1'].includes(id) ? 's' : 'p') });
  assert.equal((await cli(empty, 'prepare', '--shard', '001')).chunk_count, 0);
  const applied = await cli(empty, 'apply', '--shard', '001');
  assert.deepEqual([applied.status, applied.removed_relations, applied.senses.no_relations], ['no-change', 0, 2]);
  assert.equal(git(empty, 'status', '--porcelain', '--', 'data'), '');
});

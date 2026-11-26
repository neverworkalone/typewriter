import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareShard, loadShard, loadTouchingExclusions, verifyAccounting } from './admission.mjs';
import { apply, PolishInputError, show } from './polish-cli.mjs';
import { parseDropJsonl, parseRelationJsonl } from './persisted-jsonl.mjs';

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const sense = (id, pos = 'noun') => ({ id, pos, gloss: `뜻:${id}.` });
const filler = (prefix, count) => Array.from({ length: count }, (_, index) => {
  const serial = String(index + 1).padStart(6, '0');
  return { id: `${prefix}${serial}`, lemma: `표제${prefix}${serial}`, search_forms: [`표제${prefix}${serial}`], senses: [sense(`${prefix}${serial}-s1`)] };
});

// Shard 001 owns 고요 (w1) and 물결 (w3); shard 002 owns 별빛 (w2000). Stage 1 Candidates name each other across shards.
const CANDIDATES = { 'w1-s1': ['물결', '별빛'], 'w2000-s1': ['고요'], 'w3-s1': [] };
const R_WAVE = { id: 'w1', sid: 'w1-s1', tid: 'w3', tsid: 'w3-s1', tp: 'scene', rv: 4, ver: 1, fm: ['물결'], rfm: [] };
const R_STAR = { id: 'w1', sid: 'w1-s1', tid: 'w2000', tsid: 'w2000-s1', tp: 'mood', rv: 3, ver: 1, fm: ['별빛'], rfm: ['고요'] };

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-polish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shards = {
    '001': [{ id: 'w1', lemma: '고요', search_forms: ['고요'], senses: [sense('w1-s1')] },
      { id: 'w3', lemma: '물결', search_forms: ['물결'], senses: [sense('w3-s1')] },
      { id: 'w4', lemma: '흐르다', search_forms: ['흐르다'], senses: [sense('w4-s1', 'verb')] }, ...filler('x', 497)],
    '002': [{ id: 'w2000', lemma: '별빛', search_forms: ['별빛'], senses: [sense('w2000-s1')] }, ...filler('y', 499)],
  };
  for (const directory of ['data/canonical', 'data/relation-candidates/001', 'data/relation-candidates/002', 'data/relations', 'data/relation-drops']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [shard, records] of Object.entries(shards)) {
    await writeFile(path.join(root, `data/canonical/stdict-0${shard}.jsonl`), jsonl(records));
    const rows = records.map((record) => ({ record_id: record.id, senses: record.senses.map((item) => ({ sense_id: item.id, candidates: CANDIDATES[item.id] ?? [] })) }));
    await writeFile(path.join(root, `data/relation-candidates/${shard}/${shard}_01_a_codex.jsonl`), jsonl(rows));
  }
  await writeFile(path.join(root, 'data/relations/relation-001.jsonl'), jsonl([R_WAVE, R_STAR]));
  return root;
}

const read = async (root, relative) => readFile(path.join(root, relative), 'utf8').catch(() => '');
const accounting = async (root, shard) => {
  const loaded = await loadShard(shard, root);
  const own = parseRelationJsonl(await read(root, `data/relations/relation-${shard}.jsonl`));
  const others = shard === '001' ? [] : parseRelationJsonl(await read(root, 'data/relations/relation-001.jsonl'));
  return verifyAccounting({ canonicalRows: loaded.canonicalRows, candidateFiles: loaded.candidateFiles, relationRows: own,
    dropRows: parseDropJsonl(await read(root, `data/relation-drops/drop-${shard}.jsonl`)), otherRelationRows: others, index: loaded.index });
};

test('#8784 Polish Drop/Add keeps both shards\' Candidate accounting, records and clears `p`, and repeats as a no-op', async (t) => {
  const root = await repository(t);
  assert.equal((await accounting(root, '001')).missing, 0);
  assert.equal((await accounting(root, '002')).missing, 0);

  // Dropping 고요↔별빛 orphans the forward Candidate in 001 and the reverse Candidate in 002; each shard gets its own `z`.
  const drop = { edits: [{ op: 'drop', source_sense_id: 'w2000-s1', target_sense_id: 'w1-s1', reason: '연결이 약함' }] };
  const dropped = await apply(drop, { root });
  assert.equal(dropped.status, 'applied');
  assert.deepEqual(dropped.z_added.map(({ stored, candidate }) => [stored, candidate]).sort(),
    [['data/relation-drops/drop-001.jsonl', '별빛'], ['data/relation-drops/drop-002.jsonl', '고요']]);
  assert.equal(await read(root, 'data/relation-drops/drop-001.jsonl'),
    '{"id":"w1","sid":"w1-s1","tid":"w2000","tsid":"w2000-s1","by":"p"}\n{"id":"w1","sid":"w1-s1","cd":"별빛","by":"z"}\n');
  assert.equal(await read(root, 'data/relation-drops/drop-002.jsonl'), '{"id":"w2000","sid":"w2000-s1","cd":"고요","by":"z"}\n');
  assert.equal((await accounting(root, '001')).missing, 0);
  assert.equal((await accounting(root, '002')).missing, 0);
  assert.equal((await apply(drop, { root })).status, 'no-op');

  // The `p` context (stored in 001) reaches a not-yet-decided 002 Candidate of the same exact pair as soft context only.
  const loaded = await loadShard('002', root);
  const exclusions = await loadTouchingExclusions(root, { senseIds: new Set(['w2000-s1']) });
  const prepared = prepareShard({ canonicalRows: loaded.canonicalRows, candidateFiles: loaded.candidateFiles, exclusionRows: exclusions, index: loaded.index });
  assert.deepEqual(prepared.items.map((item) => item.candidates), [[{ text: '고요', producers: ['a_codex'], same_spelling_records: ['w1'], polish_excluded: { target_sense_ids: ['w1-s1'] } }]]);

  // A Candidate-free Polish Add plus re-approval of the excluded pair: `p` and both covered `z` Drops disappear.
  const add = { edits: [
    { op: 'add', source_sense_id: 'w1-s1', target_sense_id: 'w2000-s1', type: 'sensory', relevance: 2, reason: '밤의 정적' },
    { op: 'add', source_sense_id: 'w1-s1', target_sense_id: 'w4-s1', type: 'action', relevance: 5, reason: '후보 없음' },
    { op: 'add', source_sense_id: 'w1-s1', text: '잠든 마을', type: 'scene', relevance: 4, reason: '장면' },
  ] };
  const added = await apply(add, { root });
  assert.deepEqual(added.drops_removed.map(({ stored, candidate }) => [stored.replace(/:\d+$/u, ''), candidate]).sort(),
    [['data/relation-drops/drop-001.jsonl', '별빛'], ['data/relation-drops/drop-002.jsonl', '고요']]);
  assert.equal(added.edits[0].cleared_exclusions.length, 1);
  assert.equal(await read(root, 'data/relation-drops/drop-001.jsonl'), '');
  assert.equal(await read(root, 'data/relation-drops/drop-002.jsonl'), '');
  assert.match(await read(root, 'data/relations/relation-001.jsonl'), /"tsid":"w4-s1","tp":"action","rv":5,"by":"p"\}\n\{"id":"w1","sid":"w1-s1","tt":"잠든 마을","tp":"scene","rv":4,"by":"p"\}\n$/u);
  assert.equal((await accounting(root, '001')).missing, 0);
  assert.equal((await accounting(root, '002')).missing, 0);
  assert.equal((await apply(add, { root })).status, 'no-op');

  // Set keeps the row's provenance; an unsupported edit is refused before anything is written.
  const set = await apply({ edits: [{ op: 'set', source_sense_id: 'w1-s1', target_sense_id: 'w3-s1', type: 'sensory', relevance: 2, reason: '물빛' }] }, { root });
  assert.deepEqual(set.edits[0].after, { type: 'sensory', relevance: 2 });
  assert.match(await read(root, 'data/relations/relation-001.jsonl'), /^\{"id":"w1","sid":"w1-s1","tid":"w3","tsid":"w3-s1","tp":"sensory","rv":2,"ver":1,"fm":\["물결"\],"rfm":\[\]\}\n/u);
  await assert.rejects(apply({ edits: [{ op: 'add', source_sense_id: 'w1-s1', target_sense_id: 'w3-s1', type: 'action', relevance: 2, reason: 'x' }] }, { root }), PolishInputError);

  const shown = await show({ word: '고요', record: null, sense: null }, root);
  assert.deepEqual(shown.senses[0].relations.map((link) => [link.counterpart?.lemma ?? link.text, link.type, link.by]),
    [['물결', 'sensory', 'ver:1'], ['별빛', 'sensory', 'p'], ['흐르다', 'action', 'p'], ['잠든 마을', 'scene', 'p']]);
});

// #8784 PR-2: a PR's approved-data delta is replayed onto newer approved data by relation key, never by line or file.
test('#8784 replay merges concurrent Polish/batch deltas by relation key; the latest value wins a shared key', async (t) => {
  const root = await repository(t);
  const { execFileSync } = await import('node:child_process');
  const { replay } = await import('./replay-cli.mjs');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'master');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const commitEdits = async (edits) => { await mkdir(path.join(root, 'data/relation-drops'), { recursive: true }); await apply({ edits }, { root }); git('add', '-A'); git('commit', '-qm', 'edit'); return git('rev-parse', 'HEAD'); };

  // ours: drop 고요↔물결 and the cross-shard 고요↔별빛; theirs (latest master): the same 고요↔물결 drop, a retype of
  // 고요↔별빛 and a text Relation that answers the Candidate 물결.
  git('switch', '-qc', 'batch');
  const ours = await commitEdits([
    { op: 'drop', source_sense_id: 'w1-s1', target_sense_id: 'w3-s1', reason: '약함' },
    { op: 'drop', source_sense_id: 'w1-s1', target_sense_id: 'w2000-s1', reason: '배치' },
  ]);
  git('switch', '-q', 'master');
  const theirs = await commitEdits([
    { op: 'drop', source_sense_id: 'w1-s1', target_sense_id: 'w3-s1', reason: '약함' },
    { op: 'set', source_sense_id: 'w1-s1', target_sense_id: 'w2000-s1', type: 'scene', relevance: 2, reason: 'Polish' },
    { op: 'add', source_sense_id: 'w1-s1', text: '물결', type: 'sensory', relevance: 3, reason: 'Polish' },
  ]);
  git('switch', '-q', 'batch');
  assert.throws(() => git('merge', '-q', '--no-edit', theirs), /conflict|CONFLICT|Command failed/u);

  const result = await replay({ base, ours, theirs }, root);
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
  // The shared key keeps the latest Type/Tier, so the Drop's `p` and both shards' `z` are left out with it; the latest
  // text Relation now answers 물결, so that replayed `z` is left out too.
  assert.deepEqual(byPath['data/relations/relation-001.jsonl'].conflicts, ['R|i|w1-s1|w2000-s1']);
  assert.deepEqual(byPath['data/relation-drops/drop-001.jsonl'].conflicts.sort(),
    ['D|w1-s1|물결', 'D|w1-s1|별빛', 'P|i|w1-s1|w2000-s1']);
  assert.deepEqual(byPath['data/relation-drops/drop-002.jsonl'].conflicts, ['D|w2000-s1|고요']);
  assert.equal(await read(root, 'data/relation-drops/drop-002.jsonl'), '');
  const relations = parseRelationJsonl(await read(root, 'data/relations/relation-001.jsonl'));
  assert.deepEqual(relations.map((row) => [row.target_sense_id ?? row.text, row.type, row.relevance]),
    [['w2000-s1', 'scene', 2], ['물결', 'sensory', 3]]);
  assert.equal(await read(root, 'data/relation-drops/drop-001.jsonl'), '{"id":"w1","sid":"w1-s1","tid":"w3","tsid":"w3-s1","by":"p"}\n');
  assert.equal((await accounting(root, '001')).missing, 0);
  assert.equal((await accounting(root, '002')).missing, 0);
  git('add', '-A');
  git('commit', '-qm', 'replay');
  assert.deepEqual((await replay({ base: theirs, ours: 'HEAD', theirs }, root)).files, []);
});

// #9929: the Relation-only mode (Stage 4 onward) reads and writes Relation files only, and replays them the same way.
test('#9929 Relation-only Polish apply and replay read no Candidate or Drop file and write Relation files only', async (t) => {
  const root = await repository(t);
  await rm(path.join(root, 'data/relation-candidates'), { recursive: true, force: true });
  await rm(path.join(root, 'data/relation-drops'), { recursive: true, force: true });
  const { execFileSync } = await import('node:child_process');
  const { replay, ReplayInputError } = await import('./replay-cli.mjs');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const changed = (from, to) => git('diff', '--name-only', from, to).split('\n').filter(Boolean);
  git('init', '-q', '-b', 'master');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const commitEdits = async (edits) => {
    const result = await apply({ edits }, { root, relationsOnly: true });
    git('add', '-A');
    git('commit', '-qm', 'edit');
    return { result, sha: git('rev-parse', 'HEAD') };
  };

  // A Drop has no `p` and orphans no `z`; an Add has nothing to settle. Only Relation files change.
  git('switch', '-qc', 'stage4');
  const { result: dropped, sha: ours } = await commitEdits([
    { op: 'drop', source_sense_id: 'w1-s1', target_sense_id: 'w3-s1', reason: 'S4' },
    { op: 'drop', source_sense_id: 'w2000-s1', target_sense_id: 'w1-s1', reason: 'S4' },
    { op: 'add', source_sense_id: 'w1-s1', target_sense_id: 'w4-s1', type: 'action', relevance: 5, reason: 'S4' },
  ]);
  assert.equal(dropped.status, 'applied');
  assert.ok(!('z_added' in dropped) && !('drops_removed' in dropped));
  assert.ok(dropped.edits.every((edit) => !('exclusion' in edit) && !('cleared_exclusions' in edit)));
  assert.deepEqual(changed(base, ours), ['data/relations/relation-001.jsonl']);
  // An existing relation is still refused, so the shared row validator keeps reverse duplicates out.
  await assert.rejects(apply({ edits: [{ op: 'add', source_sense_id: 'w4-s1', target_sense_id: 'w1-s1', type: 'near', relevance: 2, reason: 'x' }] },
    { root, relationsOnly: true, dryRun: true }), PolishInputError);

  // The latest data retypes 고요↔별빛 and, independently, adds a Drop file: the replay keeps both.
  git('switch', '-q', 'master');
  await commitEdits([{ op: 'set', source_sense_id: 'w1-s1', target_sense_id: 'w2000-s1', type: 'scene', relevance: 2, reason: 'Polish' }]);
  await mkdir(path.join(root, 'data/relation-drops'), { recursive: true });
  await writeFile(path.join(root, 'data/relation-drops/drop-002.jsonl'), '{"id":"w2000","sid":"w2000-s1","cd":"고요","by":"x"}\n');
  git('add', '-A');
  git('commit', '-qm', 'theirs');
  const theirs = git('rev-parse', 'HEAD');
  git('switch', '-q', 'stage4');
  assert.throws(() => git('merge', '-q', '--no-edit', theirs), /conflict|CONFLICT|Command failed/u);
  const result = await replay({ base, ours, theirs, relationsOnly: true }, root);
  assert.deepEqual(result.files.map((file) => [file.path, file.conflicts]), [['data/relations/relation-001.jsonl', ['R|i|w1-s1|w2000-s1']]]);
  // The shared key keeps the latest retype; the PR's other edits are replayed.
  assert.deepEqual(parseRelationJsonl(await read(root, 'data/relations/relation-001.jsonl')).map((row) => [row.target_sense_id, row.type, row.relevance]),
    [['w2000-s1', 'scene', 2], ['w4-s1', 'action', 5]]);
  assert.equal(await read(root, 'data/relation-drops/drop-002.jsonl'), '{"id":"w2000","sid":"w2000-s1","cd":"고요","by":"x"}\n');
  git('merge', '--abort');

  // A PR-side Drop change, or a named Drop path, is a scope error before anything is written.
  const before = await read(root, 'data/relations/relation-001.jsonl');
  await mkdir(path.join(root, 'data/relation-drops'), { recursive: true });
  await writeFile(path.join(root, 'data/relation-drops/drop-001.jsonl'), '{"id":"w1","sid":"w1-s1","cd":"물결","by":"x"}\n');
  git('add', '-A');
  git('commit', '-qm', 'drop side effect');
  const withDrop = git('rev-parse', 'HEAD');
  await assert.rejects(replay({ base, ours: withDrop, theirs, relationsOnly: true }, root), ReplayInputError);
  await assert.rejects(replay({ base, ours, theirs, relationsOnly: true, paths: ['data/relation-drops/drop-002.jsonl'] }, root), ReplayInputError);
  assert.equal(await read(root, 'data/relations/relation-001.jsonl'), before);
});

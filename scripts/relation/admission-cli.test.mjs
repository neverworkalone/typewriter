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

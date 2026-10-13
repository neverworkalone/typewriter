import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// Editorial calibration controls from docs/relation-editorial-policy.md, checked
// against the committed canonical relations. `direct` needs the same kind of
// thing in a close-alternative usage; scope or facet differences alone do not
// demote it, but an action vs its agent/person, a result vs its actor, or
// actions of different body parts are not close alternatives.
const POSITIVE_DIRECT = [
  ['레슨', '수업'],
  ['꼭대기', '산꼭대기'],
  ['꼭대기', '산봉우리'],
  ['대걸레', '걸레'],
];
const NOT_DIRECT = [
  ['상상력', '상상하다'],
  ['목격자', '목격'],
  ['경비', '경비원'],
  ['발을 뻗다', '손을 뻗다'],
  ['발을 뻗다', '손을 뻗치다'],
  ['발을 뻗다', '팔을 뻗다'],
];

async function relationPairs() {
  const records = [];
  for (const name of (await readdir('data/canonical')).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean)) {
      records.push(JSON.parse(line));
    }
  }
  const lemmaOf = new Map(records.flatMap((record) => record.senses.map((sense) => [sense.id, record.lemma])));
  const pairs = new Map();
  for (const record of records) {
    for (const sense of record.senses) {
      for (const relation of sense.relations ?? []) {
        const key = `${record.lemma}>${lemmaOf.get(relation.target_sense)}`;
        if (!pairs.has(key)) pairs.set(key, new Set());
        pairs.get(key).add(relation.type);
      }
    }
  }
  return pairs;
}

test('direct relations keep scope-only positives and never join a different kind of thing or body part', async () => {
  const pairs = await relationPairs();
  for (const [source, target] of POSITIVE_DIRECT) {
    assert.ok(pairs.get(`${source}>${target}`)?.has('direct'), `${source} → ${target} is a positive direct control`);
  }
  for (const [source, target] of NOT_DIRECT) {
    assert.ok(!pairs.get(`${source}>${target}`)?.has('direct'), `${source} → ${target} is a negative control and must stay exploratory`);
  }
});

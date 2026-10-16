import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readJsonl = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const sourceSenses = [
  ...readJsonl('data/canonical/stdict-0076.jsonl'),
  ...readJsonl('data/canonical/stdict-0326.jsonl'),
].filter((record) => record.lemma === '뛰다').flatMap((record) => record.senses);
const expectedSenseIds = [
  'w99271-s1',
  'w99383-s1', 'w99383-s2', 'w99383-s3', 'w99383-s4', 'w99383-s5', 'w99383-s6',
  'w414830-s1', 'w414830-s2', 'w414830-s3', 'w414830-s4', 'w414830-s5', 'w414830-s6', 'w414830-s7', 'w414830-s8',
];
const missingSourceUses = (gloss) => sourceSenses
  .filter((sense) => !gloss.includes(sense.gloss.replace(/[.。]$/u, '')))
  .map((sense) => sense.id);
const previousGloss = '몸이나 물체가 빠르게 달리고 솟구치며, 순서·차례를 건너뛰거나 활동·일이 바쁘게 이어지고 맥박·값·기세가 크게 움직이다.';
const previousFindings = ['w99383-s2', 'w99383-s3', 'w414830-s7', 'w414830-s8'];
const meaning = readJsonl('data/meanings/c05_003.jsonl').find((row) => row.id === 'm99271');
const repartition = JSON.parse(readFileSync('scripts/meaning/issue-764-c05.json', 'utf8'))
  .repartitions.find((row) => row.lemma === '뛰다');
const group = repartition?.groups.find((row) => row.senses.includes('w99271-s1'));

test('C05 뛰다 preserves all 15 source glosses and catches the prior 4-use omission', () => {
  assert.deepEqual(sourceSenses.map((sense) => sense.id).sort(), [...expectedSenseIds].sort());
  assert.deepEqual(meaning.sense_ids, expectedSenseIds);
  assert.deepEqual(group.senses, expectedSenseIds);
  assert.equal(group.gloss, meaning.gloss);
  const previousMissing = missingSourceUses(previousGloss);
  assert.ok(previousFindings.every((senseId) => previousMissing.includes(senseId)), 'the previous compact gloss fails on each cited source use');
  assert.deepEqual(missingSourceUses(meaning.gloss), [], 'the current representative gloss must preserve each source use');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { census, indicators, loadCensus, sidecar } from './postmortem-census.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const annotations = JSON.parse(fs.readFileSync(path.join(dir, 'issue-764-c02-postmortem.json'), 'utf8'));

const fixture = () => {
  const senses = new Map([
    ['w1-s1', { entry: 'w1', lemma: 'a', pos: 'verb', gloss: "‘x’의 피동사." }],
    ['w2-s1', { entry: 'w2', lemma: 'a', pos: 'verb', gloss: "‘x’의 사동사." }],
    ['w3-s1', { entry: 'w3', lemma: 'b', pos: 'noun', gloss: '→ p.' }],
    ['w4-s1', { entry: 'w4', lemma: 'b', pos: 'noun', gloss: '→ q.' }],
    ['w5-s1', { entry: 'w5', lemma: 'c', pos: 'noun', gloss: '→ p.' }],
    ['w6-s1', { entry: 'w6', lemma: 'c', pos: 'noun', gloss: '→ p.' }],
  ]);
  const meanings = [
    { id: 'm1', lemma: 'a', gloss: 'g', sense_ids: ['w1-s1', 'w2-s1'] },
    { id: 'm2', lemma: 'b', gloss: 'g', sense_ids: ['w3-s1', 'w4-s1'] },
    { id: 'm3', lemma: 'c', gloss: 'g', sense_ids: ['w5-s1', 'w6-s1'] },
  ];
  return { meanings, senses };
};

test('indicators flag opposite voice and differing reference targets only', () => {
  const found = indicators(fixture());
  assert.deepEqual(found.voiceConflict, ['m1']);
  assert.deepEqual(found.multiTargetReference, ['m2']);
});

test('C02 covers every canonical sense of the initial exactly once', () => {
  const ctx = loadCensus('c02');
  const c = census('c02', ctx);
  assert.equal(c.sensesWithoutMeaningOrAdjudication, 0);
  assert.equal(c.sensesOwnedByMoreThanOneMeaning, 0);
  assert.equal(c.meaningSensesMissingFromCanonical, 0);
  assert.equal(c.canonicalSensesOfInitial, c.meaningSenses + 0);
});

test('every structurally detected voice conflict is annotated as confirmed', () => {
  const ctx = loadCensus('c02');
  const confirmed = new Set(
    sidecar('c02', annotations, ctx)
      .filter((r) => r.status === 'over_merge_confirmed')
      .flatMap((r) => r.meanings),
  );
  for (const id of indicators(ctx).voiceConflict) assert.ok(confirmed.has(id), `${id} unannotated`);
});

test('sidecar never reports an unread lemma as reviewed and fails closed on bad targets', () => {
  const ctx = loadCensus('c02');
  for (const row of sidecar('c02', annotations, ctx)) {
    if (row.scope === 'single') assert.equal(row.status === 'unreviewed' || row.classes.length > 0, true, row.lemma);
    else assert.notEqual(row.status, 'unreviewed', row.lemma);
  }
  assert.throws(() => sidecar('c02', { annotations: [{ class: 'x', status: 'suspect_hold', meaning_ids: ['m0'] }] }, ctx), /unknown Meaning/);
  assert.throws(() => sidecar('c02', { annotations: [{ class: 'x', status: 'suspect_hold', lemmas: ['없는말'] }] }, ctx), /unknown lemma/);
});

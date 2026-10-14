import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { DIRECT_BOUNDARY_CLASSES, DIRECT_BOUNDARY_INSTRUCTION } from '../scripts/relation/direct-boundary.mjs';
import { packetPayload } from '../scripts/relation/backfill-queue.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';

// Positive/negative editorial controls for the `direct`/`antonym` boundary (docs/relation-editorial-policy.md).
// Each case binds the exact source and target sense by id, POS and gloss digest, so a control stops applying (and
// fails here) when its bound sense is edited instead of silently matching a lemma string. The check is a regression
// of the recorded editorial decisions and of the shared hand-off that carries the boundary; it does not judge
// unseen Korean pairs.
const FIXTURE = JSON.parse(await readFile('data/validation/relation-editorial-controls.json', 'utf8'));

export function controlErrors(cases, senseIndex) {
  const errors = [];
  for (const { class: cls, verdict, source, target, forbidden_types: forbidden } of cases) {
    const label = `${source.sense_id} → ${target.sense_id}`;
    const bound = [source, target].map((ref) => ({ ref, found: senseIndex.get(ref.sense_id) }));
    for (const { ref, found } of bound) {
      if (!found) { errors.push(`${label}: bound sense ${ref.sense_id} is missing`); continue; }
      if (found.sense.pos !== ref.pos || sha256Json(found.sense.gloss) !== ref.gloss_sha256) errors.push(`${label}: bound sense ${ref.sense_id} changed pos or gloss`);
    }
    const from = senseIndex.get(source.sense_id)?.sense;
    if (!from) continue;
    const types = (from.relations ?? []).filter((relation) => relation.target_sense === target.sense_id).map((relation) => relation.type);
    if (!DIRECT_BOUNDARY_CLASSES.some((entry) => entry.id === cls && entry.verdict === verdict)) errors.push(`${label}: unknown boundary class ${cls}/${verdict}`);
    if (verdict === 'direct' && !types.includes('direct')) errors.push(`${label}: ${cls} control must stay direct`);
    if (verdict === 'not-direct') {
      for (const type of forbidden ?? ['direct']) if (types.includes(type)) errors.push(`${label}: ${cls} control must not be ${type}`);
    }
  }
  return errors;
}

async function senseIndex() {
  const index = new Map();
  for (const name of (await readdir('data/canonical')).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of (await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      for (const sense of record.senses) index.set(sense.id, { record, sense });
    }
  }
  return index;
}

test('the committed controls hold for the bound canonical senses and cover every boundary class', async () => {
  assert.deepEqual(controlErrors(FIXTURE.cases, await senseIndex()), []);
  for (const { id, verdict } of DIRECT_BOUNDARY_CLASSES) {
    assert.ok(FIXTURE.cases.some((entry) => entry.class === id && entry.verdict === verdict), `class ${id} needs a bound control`);
  }
});

test('old fails, new passes: a wrongly typed control or a stale bound sense is rejected', () => {
  const gloss = '시험용 뜻풀이.';
  const sense = (id, relations = []) => ({ id, pos: 'noun', gloss, relations });
  const ref = (id) => ({ sense_id: id, lemma: id, pos: 'noun', gloss_sha256: sha256Json(gloss) });
  const build = (type) => new Map([
    ['x-s1', { sense: sense('x-s1', type ? [{ target_sense: 'y-s1', type }] : []) }],
    ['y-s1', { sense: sense('y-s1') }],
  ]);
  const negative = [{ class: 'action-vs-agent', verdict: 'not-direct', source: ref('x-s1'), target: ref('y-s1') }];
  const positive = [{ class: 'scope-only', verdict: 'direct', source: ref('x-s1'), target: ref('y-s1') }];
  assert.match(controlErrors(negative, build('direct'))[0], /must not be direct/u);
  assert.deepEqual(controlErrors(negative, build('near')), []);
  assert.match(controlErrors(positive, build('near'))[0], /must stay direct/u);
  assert.deepEqual(controlErrors(positive, build('direct')), []);
  const stale = build('near');
  stale.get('y-s1').sense.gloss = '바뀐 뜻풀이.';
  assert.match(controlErrors(negative, stale)[0], /changed pos or gloss/u);
});

test('the shared Stage D packet and the policy carry the boundary, and the policy names every class', async () => {
  const policy = await readFile('docs/relation-editorial-policy.md', 'utf8');
  for (const { id } of DIRECT_BOUNDARY_CLASSES) assert.ok(policy.includes(`\`${id}\``), `policy must name class ${id}`);
  assert.equal(packetPayload('rev', [], []).editorial_boundary, DIRECT_BOUNDARY_INSTRUCTION, 'Stage D packet must carry the boundary');
  assert.ok(DIRECT_BOUNDARY_INSTRUCTION.includes('docs/relation-editorial-policy.md'));
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const spec = JSON.parse(readFileSync(new URL('./edits-716-c04.json', import.meta.url), 'utf8'));
const merged = (...ids) => spec.merges.some((merge) => ids.every((id) => merge.senses.includes(id)));

// Different referents (act vs product/person/unit, language vs word, ...) must stay separate (Issue #716 review).
const separate = [
  ['w80876-s1', 'w80876-s2'], ['w94735-s1', 'w94735-s2'], ['w94736-s1', 'w94736-s2'], ['w97315-s1', 'w97315-s2'],
  ['w416371-s1', 'w416371-s2'], ['w417971-s1', 'w417971-s2'], ['w83491-s1', 'w83491-s2'], ['w413183-s1', 'w413183-s2'],
  ['w72567-s1', 'w72567-s2'], ['w410070-s1', 'w410070-s2'], ['w75320-s1', 'w75320-s2'], ['w74782-s1', 'w74782-s2'],
  ['w74058-s1', 'w74058-s2'], ['w413929-s1', 'w413929-s3'], ['w77438-s1', 'w77438-s2'], ['w77269-s1', 'w77269-s2'],
  ['w78784-s1', 'w78784-s2'], ['w78475-s1', 'w78475-s2'], ['w411509-s1', 'w411509-s2'], ['w78210-s1', 'w78210-s2'],
  ['w79029-s1', 'w79029-s2'], ['w414100-s1', 'w414100-s2'], ['w411772-s1', 'w411772-s2'], ['w411580-s1', 'w411580-s2'],
  ['w411551-s1', 'w411551-s2'], ['w80230-s1', 'w80230-s3'], ['w411442-s1', 'w411442-s2'], ['w81184-s1', 'w81184-s2'],
  ['w81739-s1', 'w81739-s2'], ['w82834-s1', 'w82834-s2'], ['w83336-s1', 'w83336-s2'], ['w413147-s1', 'w413147-s2'],
  ['w85417-s1', 'w85417-s2'], ['w85895-s1', 'w85895-s2'], ['w87869-s1', 'w87869-s2'], ['w92163-s1', 'w92163-s2'],
  ['w93216-s1', 'w93216-s2'], ['w417030-s1', 'w417030-s2'], ['w93728-s1', 'w93728-s2'],
  ['w74409-s1', 'w74409-s2'], ['w85745-s1', 'w85745-s2'], ['w94732-s1', 'w94732-s2'],
  ['w78274-s1', 'w78274-s2'], ['w75690-s1', 'w75690-s2'], ['w76830-s2', 'w76830-s3'], ['w78257-s3', 'w78257-s4'], ['w411002-s1', 'w411002-s2'], ['w415470-s1', 'w415470-s2'], ['w84898-s1', 'w84898-s2'], ['w412543-s1', 'w412543-s2'], ['w417915-s1', 'w417915-s2'], ['w95259-s1', 'w95259-s2'], ['w93138-s1', 'w93138-s2'],
];

test('c04 spec keeps different-referent senses as separate meanings', () => {
  for (const ids of separate) assert.equal(merged(...ids), false, `${ids.join(' + ')} must stay separate`);
});

test('c04 spec merges a general sense with its concrete use and records exact-gloss duplicates as drops', () => {
  assert.equal(merged('w78123-s1', 'w78124-s3'), true);
  const dropped = new Map(spec.drops.map((drop) => [drop.sense_id, drop.duplicate_of]));
  assert.equal(dropped.get('w78124-s1'), 'w78123-s1');
  assert.equal(dropped.get('w414227-s1'), 'w79003-s2');
  assert.equal(dropped.get('w414230-s1'), 'w414229-s1');
  assert.equal(dropped.get('w411651-s2'), 'w79210-s1');
});

test('c04 spec merges every sense at most once', () => {
  const seen = new Set();
  for (const merge of spec.merges) for (const id of merge.senses) { assert.equal(seen.has(id), false, id); seen.add(id); }
});

// The committed meaning rows must also keep these senses apart (the spec alone is not the shipped data).
test('committed c04 meanings keep different-referent senses in separate rows', () => {
  const directory = new URL('../../data/meanings/', import.meta.url);
  const rows = readdirSync(directory).filter((name) => name.startsWith('c04_'))
    .flatMap((name) => readFileSync(new URL(name, directory), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
  for (const ids of separate) {
    const together = rows.some((row) => ids.every((id) => row.sense_ids.includes(id)));
    assert.equal(together, false, `${ids.join(' + ')} must be separate rows`);
  }
});

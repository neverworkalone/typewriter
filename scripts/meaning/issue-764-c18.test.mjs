import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const meaningDir = path.join(root, 'data/meanings');
const rows = readdirSync(meaningDir).filter((file) => /^c18_\d+\.jsonl$/u.test(file)).sort()
  .flatMap((file) => readFileSync(path.join(meaningDir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
const rowBySense = new Map();
for (const row of rows) {
  for (const id of row.sense_ids) {
    assert.equal(rowBySense.has(id), false, `${id} must belong to exactly one Meaning`);
    rowBySense.set(id, row);
  }
}
const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/issue-764-c18.json'), 'utf8'));
const sameMeaning = (ids) => ids.every((id) => rowBySense.has(id)) && new Set(ids.map((id) => rowBySense.get(id).id)).size === 1;
const known = (ids) => ids.every((id) => rowBySense.has(id));
const separateMeanings = (a, b) => rowBySense.has(a) && rowBySense.has(b) && rowBySense.get(a).id !== rowBySense.get(b).id;

test('C18 repartition spec groups exactly match final rows and preserve each source gloss', () => {
  const canonicalSense = new Map();
  for (const file of readdirSync(path.join(root, 'data/canonical')).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(root, 'data/canonical', file), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      for (const sense of entry.senses ?? []) canonicalSense.set(sense.id, { lemma: entry.lemma, gloss: sense.gloss });
    }
  }

  const seenLemmas = new Set();
  for (const edit of spec.repartitions) {
    assert.equal(seenLemmas.has(edit.lemma), false, `${edit.lemma}: only one repartition entry is allowed`);
    seenLemmas.add(edit.lemma);
    const before = edit.before.flatMap((row) => row.sense_ids).sort();
    const groups = edit.groups.flatMap((group) => group.senses).sort();
    assert.deepEqual(groups, before, `${edit.lemma}: every before sense must appear once`);
    assert.equal(new Set(groups).size, groups.length, `${edit.lemma}: source senses must not be assigned twice`);

    for (const group of edit.groups) {
      const actual = rowBySense.get(group.senses[0]);
      assert.ok(actual, `${edit.lemma}: ${group.senses[0]} must have a final Meaning`);
      assert.deepEqual([...actual.sense_ids].sort(), [...group.senses].sort(), `${edit.lemma}: group differs from the final row`);
      assert.equal(actual.gloss, group.gloss, `${edit.lemma}: gloss differs from the final row`);
      for (const id of group.senses) {
        const source = canonicalSense.get(id);
        assert.ok(source, `${edit.lemma}: ${id} must exist in canonical data`);
        assert.equal(source.lemma, edit.lemma, `${edit.lemma}: ${id} must belong to the same lemma`);
        assert.ok(actual.gloss.includes(source.gloss), `${edit.lemma}: ${id} source gloss must be retained`);
      }
    }
  }
});

test('C18 complete canonical sense coverage and residual audit match the data', () => {
  const expected = new Set();
  for (const file of readdirSync(path.join(root, 'data/canonical')).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(root, 'data/canonical', file), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (initialCodeOf(entry.lemma) !== 'c18') continue;
      for (const sense of entry.senses ?? []) expected.add(sense.id);
    }
  }
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows
    .filter((item) => initialCodeOf(item.lemma) === 'c18');
  const adjudicated = new Set(adjudications.map((item) => item.sense_id));
  for (const id of rowBySense.keys()) assert.equal(adjudicated.has(id), false, `${id} cannot be both a Meaning and adjudicated`);
  assert.deepEqual([...new Set([...rowBySense.keys(), ...adjudicated])].sort(), [...expected].sort(), 'every C18 canonical sense must have one Meaning or explicit adjudication');
  assert.deepEqual(adjudications.map(({ sense_id, duplicate_of }) => [sense_id, duplicate_of]).sort(), [
    ['w365419-s1', 'w365418-s1'],
    ['w498155-s1', 'w498126-s6'],
  ], 'the existing duplicate adjudications remain unchanged');

  const byLemma = Object.groupBy(rows, (row) => row.lemma);
  const residualLemmas = Object.entries(byLemma).filter(([, meanings]) => meanings.length > 1).map(([lemma]) => lemma).sort((a, b) => a.localeCompare(b, 'ko'));
  const residual = readFileSync(path.join(root, 'scripts/meaning/issue-764-c18-residual-audit.md'), 'utf8');
  const residualHeadings = [...residual.matchAll(/^## (.+) \((\d+) Meanings\)$/gmu)].map((match) => match[1]);
  assert.deepEqual(residualHeadings, residualLemmas, 'residual audit must list every multi-Meaning lemma once');
  for (const lemma of residualLemmas) {
    for (const row of byLemma[lemma]) {
      assert.ok(residual.includes(`**${row.id}**`), `${lemma}: ${row.id} must be listed`);
      for (const id of row.sense_ids) assert.ok(residual.includes(`\`${id}\``), `${lemma}: ${id} must be listed`);
    }
  }

  const audit = readFileSync(path.join(root, 'scripts/meaning/issue-764-c18-audit.md'), 'utf8');
  assert.ok(audit.includes('| C18 Meaning rows | 15,434 | 14,758 |'), 'C18 row counts');
  assert.ok(audit.includes('| Lemmas with several Meanings | 2,096 | 1,824 |'), 'multi-Meaning counts');
  assert.ok(audit.includes('| Rows in the 383 repartitioned lemmas | 1,303 | 627 |'), 'repartition counts');
  assert.equal(spec.repartitions.length, 383, 'audit scope');
});

const mustMerge = [
  ['프로그램 plan, broadcast, and computer uses', ['w498449-s1', 'w498449-s2', 'w498449-s3']],
  ['파도 physical, social, and psychological waves', ['w499093-s1', 'w499093-s2', 'w499093-s3']],
  ['파닥 bird, fish, and fabric movement', ['w351681-s1', 'w351681-s2', 'w351681-s3']],
  ['피어나다 literal and figurative emergence', ['w502666-s1', 'w502666-s2', 'w502666-s3', 'w502666-s4', 'w502666-s5', 'w502666-s6', 'w502666-s7', 'w502666-s8']],
  ['풍차 windmill and pinwheel', ['w360733-s1', 'w360733-s2']],
  ['표식 marker and its 표지03 redirect', ['w357192-s1', 'w499421-s1']],
  ['피로 ordinary and material fatigue', ['w500065-s1', 'w500065-s2']],
];
for (const [name, ids] of mustMerge) {
  test(`C18 polysemy control: ${name} is one Meaning`, () => assert.ok(sameMeaning(ids), name));
}

const mustSplit = [
  ['파랑 waves and blue color', 'w352885-s1', 'w499529-s1'],
  ['표식 marker and fossil exemplar', 'w357192-s1', 'w357193-s1'],
  ['풍차 clothing and windmill', 'w360410-s1', 'w360733-s1'],
  ['풍차 windmill and 풍구 redirect', 'w360733-s1', 'w360733-s3'],
  ['피로 publicity and capture', 'w362464-s1', 'w362467-s1'],
  ['피로 fatigue and pyrogallol', 'w500065-s1', 'w362468-s1'],
];
for (const [name, a, b] of mustSplit) {
  test(`C18 independent-identity control: ${name} stays separate`, () => assert.ok(separateMeanings(a, b), name));
}

test('C18 controls fail on unknown source ids instead of passing vacuously', () => {
  assert.equal(sameMeaning(['w000000-s1', 'w000000-s2']), false);
  assert.equal(known(['w000000-s1']), false);
  for (const [name, ids] of mustMerge) assert.ok(known(ids), `${name}: control sense ids must exist`);
  for (const [name, a, b] of mustSplit) assert.ok(known([a, b]), `${name}: control sense ids must exist`);
});

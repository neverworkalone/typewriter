import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications } from './contract.mjs';
import { readCanonicalEntries } from './initial.mjs';
import { projectMeaningRelations } from './project.mjs';

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
  assert.ok(audit.includes('| C18 Meaning rows | 15,434 | 14,774 |'), 'C18 row counts');
  assert.ok(audit.includes('| Lemmas with several Meanings | 2,096 | 1,834 |'), 'multi-Meaning counts');
  assert.ok(audit.includes('| Rows in the 385 repartitioned lemmas | 1,309 | 649 |'), 'repartition counts');
  assert.equal(spec.repartitions.length, 385, 'audit scope');
});

const mustMerge = [
  ['파가 house demolition and its Go use', ['w354930-s1', 'w354930-s2']],
  ['파가하다 house demolition and its Go use', ['w354931-s1', 'w354931-s2']],
  ['프로그램 plan, broadcast, and computer uses', ['w498449-s1', 'w498449-s2', 'w498449-s3']],
  ['파도 physical, social, and psychological waves', ['w499093-s1', 'w499093-s2', 'w499093-s3']],
  ['파닥 bird, fish, and fabric movement', ['w351681-s1', 'w351681-s2', 'w351681-s3']],
  ['피어나다 literal and figurative emergence', ['w502666-s1', 'w502666-s2', 'w502666-s3', 'w502666-s4', 'w502666-s5', 'w502666-s6', 'w502666-s7', 'w502666-s8']],
  ['풍차 windmill and pinwheel', ['w360733-s1', 'w360733-s2']],
  ['표식 marker and its 표지03 redirect', ['w357192-s1', 'w499421-s1']],
  ['피로 ordinary and material fatigue', ['w500065-s1', 'w500065-s2']],
  ['피모 skin and coat uses', ['w360751-s1', 'w365720-s1']],
  ['피복 physical and topological covering', ['w361935-s1', 'w503877-s1']],
  ['필로 writing path, logic, and brush uses', ['w365421-s1', 'w365421-s2', 'w365421-s3']],
  ['필부 ordinary woman senses', ['w366639-s1', 'w366639-s2']],
  ['필부 ordinary man senses', ['w500029-s1', 'w500029-s2']],
  ['표표 floating and fluttering uses', ['w355581-s1', 'w355581-s2', 'w495805-s1', 'w495805-s2', 'w495805-s3']],
  ['파선 wave-line and wavefront uses', ['w354331-s1', 'w354331-s2']],
  ['폐장 lung-and-gut literal and figurative uses', ['w503469-s1', 'w503469-s2']],
  ['폐기 discard and repeal uses of 廢棄', ['w499273-s1', 'w499273-s2']],
];
for (const [name, ids] of mustMerge) {
  test(`C18 polysemy control: ${name} is one Meaning`, () => assert.ok(sameMeaning(ids), name));
}

const mustSplit = [
  ['폐기 exhaust gas and disposal/repeal', 'w359259-s1', 'w499273-s1'],
  ['피복 clothing and covering', 'w361934-s1', 'w361935-s1'],
  ['피복선 insulated wire and copper-clad ship', 'w362196-s1', 'w503879-s1'],
  ['포 cannon and janggi 包 piece', 'w359616-s1', 'w497814-s1'],
  ['필로 writing fatigue and writing path', 'w365420-s1', 'w365421-s1'],
  ['필부 woman and man', 'w366639-s1', 'w500029-s1'],
  ['편벽하다 biased and flatter', 'w351999-s1', 'w499211-s1'],
  ['편사 self-interest and favoritism', 'w351493-s1', 'w351740-s1'],
  ['폐사 humble company and humble home', 'w356876-s1', 'w498405-s1'],
  ['폐장 lung and lung-gut compound', 'w358286-s1', 'w503469-s1'],
  ['포루 artillery tower and covered battlement', 'w357980-s1', 'w357981-s1'],
  ['표표하다 floating and conspicuous appearance', 'w355581-s1', 'w500487-s1'],
  ['파다하다 multitude and widespread rumor', 'w351416-s1', 'w351419-s1'],
  ['파락 shake off and ruin', 'w495832-s1', 'w517316-s1'],
  ['파락하다 shake away and collapse', 'w351807-s1', 'w517317-s1'],
  ['파상설 snow surface and wave theory', 'w347197-s1', 'w495476-s1'],
  ['파선 wave line and cycloid', 'w354331-s1', 'w495453-s1'],
  ['표풍 drifting in wind and cyclone', 'w355588-s1', 'w355590-s1'],
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

test('C18 폐기 source relation provenance stays bound to the exhaust sense after the homonym split', () => {
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows;
  const allMeanings = readdirSync(path.join(root, 'data/meanings')).filter((file) => file.endsWith('.jsonl')).sort()
    .flatMap((file) => readFileSync(path.join(root, 'data/meanings', file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const relevantRecords = readCanonicalEntries(path.join(root, 'data/canonical'))
    .filter((record) => ['w359259', 'w499273', 'w430558'].includes(record.id));
  const { relations } = projectMeaningRelations({
    records: relevantRecords,
    meanings: allMeanings,
    adjudications,
  });
  const exhaust = rowBySense.get('w359259-s1');
  const discarded = rowBySense.get('w499273-s1');
  const target = allMeanings.find((row) => row.sense_ids.includes('w430558-s2'));
  const relation = relations.find((item) => item.source_meaning_id === exhaust.id
    && item.target_meaning_id === target.id && item.type === 'direct');

  assert.ok(relation, 'the source-bound direct link from 폐기(廢氣) to 배기 must be projected');
  assert.deepEqual(relation.sources.map((source) => source.source_sense_id), ['w359259-s1']);
  assert.equal(relations.some((item) => item.source_meaning_id === discarded.id), false,
    'the 폐기(廢棄) meaning must not inherit the 폐기(廢氣) relation');
});

test('C18 피복선 wire synonyms stay on the wire Meaning and do not leak to the ship Meaning', () => {
  const adjudications = readAdjudications(path.join(root, 'data/adjudication')).rows;
  const allMeanings = readdirSync(path.join(root, 'data/meanings')).filter((file) => file.endsWith('.jsonl')).sort()
    .flatMap((file) => readFileSync(path.join(root, 'data/meanings', file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const relevantRecords = readCanonicalEntries(path.join(root, 'data/canonical'))
    .filter((record) => ['w362196', 'w503879', 'w277609', 'w287249', 'w292217'].includes(record.id));
  const { relations } = projectMeaningRelations({
    records: relevantRecords,
    meanings: allMeanings,
    adjudications,
  });
  const wire = rowBySense.get('w362196-s1');
  const ship = rowBySense.get('w503879-s1');
  const targetSenseIds = ['w277609-s1', 'w287249-s1', 'w292217-s1'];

  assert.notEqual(wire.id, ship.id, 'the insulated wire and copper-clad ship must remain independent Meanings');
  for (const targetSenseId of targetSenseIds) {
    const target = allMeanings.find((row) => row.sense_ids.includes(targetSenseId));
    const relation = relations.find((item) => item.source_meaning_id === wire.id
      && item.target_meaning_id === target.id && item.type === 'direct');
    assert.ok(relation, `the wire direct link to ${targetSenseId} must be projected`);
    assert.deepEqual(relation.sources.map((source) => source.source_sense_id), ['w362196-s1']);
  }
  assert.equal(relations.some((item) => item.source_meaning_id === ship.id), false,
    'the 被覆船 Meaning must not inherit the 被覆線 direct relations');
});

test('C18 controls fail on unknown source ids instead of passing vacuously', () => {
  assert.equal(sameMeaning(['w000000-s1', 'w000000-s2']), false);
  assert.equal(known(['w000000-s1']), false);
  for (const [name, ids] of mustMerge) assert.ok(known(ids), `${name}: control sense ids must exist`);
  for (const [name, a, b] of mustSplit) assert.ok(known([a, b]), `${name}: control sense ids must exist`);
});

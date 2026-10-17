import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyEdits } from './apply-edits.mjs';
import { validateMeaningDataset } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The CLI copies live under a temporary repository root, so the runtime relation vocabulary contract.mjs imports
// must be copied with them (no symlinks, matching the repository layout).
const copyRuntimeContract = (tempRoot) => {
  const runtimeDir = path.join(tempRoot, 'src/runtime');
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(root, 'src/runtime/meaning-ranking.js'), path.join(runtimeDir, 'meaning-ranking.js'));
};
const senses = (entry, count) => Array.from({ length: count }, (_, i) => `${entry}-s${i + 1}`);
const initial = (entry, lemma, count) => senses(entry, count).map((id, i) => ({
  id: count === 1 ? entry.replace('w', 'm') : `${entry.replace('w', 'm')}_${i + 1}`, lemma, gloss: `${lemma} 뜻 ${i + 1}`, sense_ids: [id],
}));
const allSenses = (...groups) => new Map(groups.flat().map((id) => [id, { lemma: id.startsWith('w2') ? '전락하다' : '가다' }]));

test('merge keeps the lowest member id, lists all sense_ids and covers every sense once', () => {
  const meanings = [...initial('w10', '가다', 4), ...initial('w11', '가다', 1)];
  const spec = { merges: [{ senses: ['w10-s3', 'w10-s1'], gloss: '합친 뜻' }] };
  const next = applyEdits({ meanings, adjudications: [] }, spec);
  assert.deepEqual(next.meanings.find((row) => row.id === 'm10_1'), { id: 'm10_1', lemma: '가다', gloss: '합친 뜻', sense_ids: ['w10-s1', 'w10-s3'] });
  assert.equal(next.meanings.some((row) => row.id === 'm10_3'), false);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: allSenses(senses('w10', 4), senses('w11', 1)), complete: true }), []);
});

test('repartition can split and coalesce prior meanings against an exact snapshot', () => {
  const meanings = [
    { id: 'm50_1', lemma: '나무', gloss: '이전 합침', sense_ids: ['w50-s1', 'w50-s2'] },
    { id: 'm51', lemma: '나무', gloss: '다른 뜻', sense_ids: ['w51-s1'] },
  ];
  const initialMeaningIds = new Map([
    ['w50-s1', 'm50_1'], ['w50-s2', 'm50_2'], ['w51-s1', 'm51'],
  ]);
  const next = applyEdits({ meanings, adjudications: [], initialMeaningIds }, {
    repartitions: [{
      lemma: '나무',
      before: meanings.map(({ id, gloss, sense_ids }) => ({ id, gloss, sense_ids })),
      groups: [
        { senses: ['w50-s1'], gloss: '첫 뜻' },
        { senses: ['w50-s2', 'w51-s1'], gloss: '새로 묶은 뜻' },
      ],
    }],
  });
  assert.deepEqual(next.meanings, [
    { id: 'm50_1', lemma: '나무', gloss: '첫 뜻', sense_ids: ['w50-s1'] },
    { id: 'm50_2', lemma: '나무', gloss: '새로 묶은 뜻', sense_ids: ['w50-s2', 'w51-s1'] },
  ]);
});

test('repartition rejects stale snapshots and incomplete sense coverage', () => {
  const meanings = [{ id: 'm50_1', lemma: '나무', gloss: '이전 합침', sense_ids: ['w50-s1', 'w50-s2'] }];
  const initialMeaningIds = new Map([['w50-s1', 'm50_1'], ['w50-s2', 'm50_2']]);
  const edit = {
    lemma: '나무',
    before: [{ id: 'm50_2', gloss: '이전 합침', sense_ids: ['w50-s1', 'w50-s2'] }],
    groups: [{ senses: ['w50-s1'], gloss: '첫 뜻' }],
  };
  assert.throws(() => applyEdits({ meanings, adjudications: [], initialMeaningIds }, { repartitions: [edit] }), /before snapshot/u);
  edit.before = meanings.map(({ id, gloss, sense_ids }) => ({ id, gloss, sense_ids }));
  assert.throws(() => applyEdits({ meanings, adjudications: [], initialMeaningIds }, { repartitions: [edit] }), /missing from final groups/u);
});

test('CLI writes newly restored initial meaning ids into the lemma shard in canonical order', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'meaning-repartition-'));
  const scriptDir = path.join(tempRoot, 'scripts/meaning');
  const canonicalDir = path.join(tempRoot, 'data/canonical');
  const meaningsDir = path.join(tempRoot, 'data/meanings');
  const adjudicationDir = path.join(tempRoot, 'data/adjudication');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(meaningsDir, { recursive: true });
  mkdirSync(adjudicationDir, { recursive: true });
  for (const name of ['apply-edits.mjs', 'contract.mjs', 'initial.mjs']) {
    copyFileSync(path.join(root, 'scripts/meaning', name), path.join(scriptDir, name));
  }
  copyRuntimeContract(tempRoot);
  writeFileSync(path.join(canonicalDir, 'stdict-0001.jsonl'), [
    { id: 'w50', lemma: '싸다', senses: [
      { id: 'w50-s1', pos: 'verb', gloss: '첫 원뜻' },
      { id: 'w50-s2', pos: 'verb', gloss: '둘째 원뜻' },
    ] },
    { id: 'w51', lemma: '싸다', senses: [{ id: 'w51-s1', pos: 'verb', gloss: '다른 원뜻' }] },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const meanings = [
    { id: 'm50_1', lemma: '싸다', gloss: '이전 합침', sense_ids: ['w50-s1', 'w50-s2'] },
    { id: 'm51', lemma: '싸다', gloss: '다른 원뜻', sense_ids: ['w51-s1'] },
  ];
  writeFileSync(path.join(meaningsDir, 'c11_001.jsonl'), meanings.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const specPath = path.join(tempRoot, 'edits.json');
  writeFileSync(specPath, JSON.stringify({ repartitions: [{
    lemma: '싸다',
    before: meanings.map(({ id, gloss, sense_ids }) => ({ id, gloss, sense_ids })),
    groups: [
      { senses: ['w50-s1'], gloss: '첫 뜻' },
      { senses: ['w50-s2', 'w51-s1'], gloss: '함께 묶은 뜻' },
    ],
  }] }));

  const result = spawnSync(process.execPath, [realpathSync(path.join(scriptDir, 'apply-edits.mjs')), specPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readFileSync(path.join(meaningsDir, 'c11_001.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse), [
    { id: 'm50_1', lemma: '싸다', gloss: '첫 뜻', sense_ids: ['w50-s1'] },
    { id: 'm50_2', lemma: '싸다', gloss: '함께 묶은 뜻', sense_ids: ['w50-s2', 'w51-s1'] },
  ]);
});

test('single-sense gloss edits preserve the canonical binding and pass complete dataset validation', () => {
  const entry = readFileSync(path.join(root, 'data/canonical/stdict-0161.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.id === 'w212148');
  const referencedEntry = readFileSync(path.join(root, 'data/canonical/stdict-0359.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.id === 'w455663');
  const sense = entry.senses[0];
  const directGloss = referencedEntry.senses[0].gloss;
  const meanings = [{ id: 'm212148', lemma: entry.lemma, gloss: sense.gloss, sense_ids: [sense.id] }];
  const next = applyEdits({ meanings, adjudications: [] }, {
    glosses: [{ sense_id: sense.id, gloss: directGloss }],
  });
  assert.deepEqual(next.meanings, [{ id: 'm212148', lemma: entry.lemma, gloss: directGloss, sense_ids: [sense.id] }]);
  assert.deepEqual(validateMeaningDataset({
    ...next,
    senses: new Map([[sense.id, { lemma: entry.lemma }]]),
    complete: true,
  }), []);
});

test('drop records a duplicate verdict across records and keeps the target meaning', () => {
  const meanings = [...initial('w20', '전락하다', 2), ...initial('w21', '전락하다', 1)];
  const next = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w21-s1', duplicate_of: 'w20-s1' }] });
  assert.deepEqual(next.adjudications, [{ sense_id: 'w21-s1', lemma: '전락하다', decision: 'drop', reason: 'duplicate', duplicate_of: 'w20-s1' }]);
  assert.equal(next.meanings.some((row) => row.sense_ids.includes('w21-s1')), false);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: allSenses(senses('w20', 2), senses('w21', 1)), complete: true }), []);
});

test('out_of_scope drops omit duplicate_of and remove meanings without a redirect', () => {
  const meanings = [...initial('w20', 'ㅏ', 2), ...initial('w21', 'apple', 1)];
  const next = applyEdits({ meanings, adjudications: [] }, {
    drops: [{ sense_id: 'w20-s1', reason: 'out_of_scope' }],
  });
  assert.deepEqual(next.adjudications, [{ sense_id: 'w20-s1', lemma: 'ㅏ', decision: 'drop', reason: 'out_of_scope' }]);
  assert.equal(next.meanings.some((row) => row.sense_ids.includes('w20-s1')), false);
  assert.deepEqual(validateMeaningDataset({
    ...next,
    senses: new Map([
      ['w20-s1', { lemma: 'ㅏ' }],
      ['w20-s2', { lemma: 'ㅏ' }],
      ['w21-s1', { lemma: 'apple' }],
    ]),
    complete: true,
  }), []);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    drops: [{ sense_id: 'w20-s1', reason: 'out_of_scope', duplicate_of: 'w20-s2' }],
  }), /duplicate_of must be absent/u);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    drops: [{ sense_id: 'w20-s1', reason: 'duplicate' }],
  }), /duplicate_of must be a canonical sense id/u);
});

test('apply-edits removes a shard when all its meanings are dropped', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'meaning-apply-edits-'));
  const scriptDir = path.join(tempRoot, 'scripts/meaning');
  const meaningsDir = path.join(tempRoot, 'data/meanings');
  const adjudicationDir = path.join(tempRoot, 'data/adjudication');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(meaningsDir, { recursive: true });
  mkdirSync(adjudicationDir, { recursive: true });
  for (const name of ['apply-edits.mjs', 'contract.mjs', 'initial.mjs']) {
    copyFileSync(path.join(root, 'scripts/meaning', name), path.join(scriptDir, name));
  }
  copyRuntimeContract(tempRoot);
  writeFileSync(path.join(meaningsDir, 'c20_001.jsonl'), [
    { id: 'm20_1', lemma: 'ㅏ', gloss: '글자', sense_ids: ['w20-s1'] },
    { id: 'm21_1', lemma: 'ㅏ', gloss: '소리', sense_ids: ['w21-s1'] },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const specPath = path.join(tempRoot, 'edits.json');
  writeFileSync(specPath, JSON.stringify({ drops: [
    { sense_id: 'w20-s1', reason: 'out_of_scope' },
    { sense_id: 'w21-s1', reason: 'out_of_scope' },
  ] }));

  const result = spawnSync(process.execPath, [realpathSync(path.join(scriptDir, 'apply-edits.mjs')), specPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readdirSync(meaningsDir), [], result.stdout);
  assert.deepEqual(readFileSync(path.join(adjudicationDir, 'c20_001.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse), [
    { sense_id: 'w20-s1', lemma: 'ㅏ', decision: 'drop', reason: 'out_of_scope' },
    { sense_id: 'w21-s1', lemma: 'ㅏ', decision: 'drop', reason: 'out_of_scope' },
  ]);
  assert.equal(existsSync(path.join(meaningsDir, 'c20_001.jsonl')), false);
});

test('invalid edits are rejected whole: cross-record merge, re-edit, single-sense merge, dropped duplicate_of, unknown sense', () => {
  const meanings = [...initial('w30', '사전', 2), ...initial('w31', '사전', 1)];
  const reject = (spec, pattern) => assert.throws(() => applyEdits({ meanings, adjudications: [] }, spec), pattern);
  reject({ merges: [{ senses: ['w30-s1'], gloss: 'x' }] }, /at least two/u);
  reject({ glosses: [{ sense_id: 'w30-s99', gloss: 'x' }] }, /no meaning/u);
  reject({ glosses: [{ sense_id: 'w30-s1', gloss: 'x' }, { sense_id: 'w30-s1', gloss: 'y' }] }, /more than once/u);
  reject({ glosses: [{ sense_id: 'w30-s1', gloss: 'x' }], merges: [{ senses: ['w30-s1', 'w30-s2'], gloss: 'y' }] }, /more than once/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s5'], gloss: 'x' }] }, /no meaning/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s2'], gloss: 'x' }, { senses: ['w30-s2', 'w30-s1'], gloss: 'y' }] }, /more than once/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s2'], gloss: ' ' }] }, /gloss/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w31-s1' }] }, /differ/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s1' }, { sense_id: 'w30-s1', duplicate_of: 'w30-s2' }] }, /itself dropped|more than once/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w99-s1' }] }, /no meaning/u);
  // Same record as the dropped sense: a missing target must be rejected exactly like another record's.
  reject({ drops: [{ sense_id: 'w30-s1', duplicate_of: 'w30-s99' }] }, /no meaning/u);
  reject({ drops: [{ sense_id: 'w30-s1', duplicate_of: 'w30-s2' }, { sense_id: 'w30-s2', duplicate_of: 'w31-s1' }] }, /itself dropped/u);
  reject({ merges: [{ senses: ['w30-s1', 'w31-s1'], gloss: 'x' }, { senses: ['w31-s1', 'w30-s2'], gloss: 'y' }] }, /more than once/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s1', reason: 'obsolete' }] }, /reason/u);
});

test('an already merged meaning cannot be merged again', () => {
  const meanings = initial('w40', '보다', 3);
  const once = applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w40-s1', 'w40-s2'], gloss: '둘' }] });
  assert.throws(() => applyEdits(once, { merges: [{ senses: ['w40-s1', 'w40-s3'], gloss: '셋' }] }), /already merged/u);
});

test('valid DROPs pass within one record and across records', () => {
  const meanings = [...initial('w30', '사전', 3), ...initial('w31', '사전', 1)];
  const sameRecord = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w30-s2', duplicate_of: 'w30-s1' }] });
  assert.equal(sameRecord.adjudications.length, 1);
  const crossRecord = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s3' }] });
  assert.equal(crossRecord.adjudications[0].duplicate_of, 'w30-s3');
});

test('senses of different records of the SAME lemma merge under the first sense id; other lemmas are rejected', () => {
  const meanings = [...initial('w50', '강피밥', 1), ...initial('w51', '강피밥', 1), ...initial('w52', '다른말', 1)];
  const next = applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w51-s1', 'w50-s1'], gloss: '합친 뜻' }] });
  assert.deepEqual(next.meanings.find((row) => row.id === 'm50'), { id: 'm50', lemma: '강피밥', gloss: '합친 뜻', sense_ids: ['w50-s1', 'w51-s1'] });
  assert.equal(next.meanings.some((row) => row.id === 'm51'), false);
  const known = new Map([['w50-s1', { lemma: '강피밥' }], ['w51-s1', { lemma: '강피밥' }], ['w52-s1', { lemma: '다른말' }]]);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: known, complete: true }), []);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w50-s1', 'w52-s1'], gloss: 'x' }] }), /different lemmas/u);
});

test('equal record numbers with different zero-padding yield one id regardless of input order, accepted by the validator', () => {
  const meanings = [...initial('w0097', '가', 1), ...initial('w00097', '가', 1)];
  const known = new Map([['w0097-s1', { lemma: '가' }], ['w00097-s1', { lemma: '가' }]]);
  const results = [['w0097-s1', 'w00097-s1'], ['w00097-s1', 'w0097-s1']].map((order) => {
    const next = applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: order, gloss: '합친 뜻' }] });
    assert.deepEqual(validateMeaningDataset({ ...next, senses: known, complete: true }), []);
    return next.meanings;
  });
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0][0].id, 'm00097');
});

test('pilot spec (#715) uses valid sense ids, unique members and never edits away a duplicate_of target', () => {
  const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/pilot-715.json'), 'utf8'));
  const seen = new Set();
  for (const merge of spec.merges) {
    assert.ok(merge.senses.length >= 2, 'merge of fewer than two senses');
    assert.equal(merge.gloss, merge.gloss.trim());
    for (const id of merge.senses) {
      assert.match(id, /^w\d+-s[1-9]\d*$/u);
      assert.equal(seen.has(id), false, `${id} used twice`);
      seen.add(id);
    }
  }
  for (const drop of spec.drops) {
    assert.equal(seen.has(drop.sense_id), false);
    assert.equal(seen.has(drop.duplicate_of), false, 'duplicate_of must not be edited away');
  }
});

test('relation edits append durable authored relations to the final meaning and re-apply as a no-op (Issue #797)', () => {
  const meanings = [...initial('w10', '가다', 1), ...initial('w11', '오다', 1)];
  const spec = { relations: [{ source_meaning_id: 'm10', add: [{ type: 'direct', target: 'm11', note: '표준국어대사전 참조 표제어' }] }] };
  const applied = applyEdits({ meanings, adjudications: [] }, spec);
  assert.deepEqual(applied.meanings[0].relations, [{ type: 'direct', target: 'm11', note: '표준국어대사전 참조 표제어' }]);
  // The authored field trails the row, so the stored shard stays byte-stable when the same spec is reapplied.
  assert.deepEqual(Object.keys(applied.meanings[0]), ['id', 'lemma', 'gloss', 'sense_ids', 'relations']);
  const rerun = applyEdits(applied, spec);
  assert.deepEqual(rerun.meanings, applied.meanings);
  // A missing note or a bad type is rejected before anything is written.
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10', add: [{ type: 'direct', target: 'm11' }] }],
  }), /note must be a trimmed non-empty string/u);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10', add: [{ type: 'made-up', target: 'm11', note: 'n' }] }],
  }), /type must be one of/u);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10', add: [{ type: 'direct', target: 'm999', note: 'n' }] }],
  }), /authored relation target m999 has no meaning/u);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10', add: [{ type: 'direct', target: 'm10', note: 'n' }] }],
  }), /target must differ/u);
});

test('a relation edit re-points an authored relation whose target meaning id moved (Issue #797)', () => {
  const meanings = [...initial('w10', '가다', 1), ...initial('w11', '오다', 1), ...initial('w12', '가다', 1)];
  const first = applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10', add: [{ type: 'direct', target: 'm11', note: '표준국어대사전 참조 표제어' }] }],
  });
  assert.deepEqual(first.meanings[0].relations, [{ type: 'direct', target: 'm11', note: '표준국어대사전 참조 표제어' }]);
  // Another scope re-partitioned the referenced meaning, so its id moved (m11 -> m12): the relation is re-pointed.
  const retarget = {
    relations: [{
      source_meaning_id: 'm10',
      remove: [{ type: 'direct', target: 'm11' }],
      add: [{ type: 'direct', target: 'm12', note: '표준국어대사전 참조 표제어' }],
    }],
  };
  const moved = applyEdits(first, retarget);
  assert.deepEqual(moved.meanings[0].relations, [{ type: 'direct', target: 'm12', note: '표준국어대사전 참조 표제어' }]);
  // Re-applying stays a no-op even though the removed relation is already gone.
  assert.deepEqual(applyEdits(moved, retarget).meanings, moved.meanings);
  // An explicit remove-only edit drops the relation and returns the row to its untouched shape.
  const removeOnly = { relations: [{ source_meaning_id: 'm10', remove: [{ type: 'direct', target: 'm12' }] }] };
  const removed = applyEdits(moved, removeOnly);
  assert.equal('relations' in removed.meanings[0], false);
  assert.deepEqual(applyEdits(removed, removeOnly).meanings, removed.meanings);
  assert.throws(() => applyEdits(first, { relations: [{ source_meaning_id: 'm10' }] }), /needs a non-empty add or remove array/u);
  assert.throws(() => applyEdits(first, { relations: [{ source_meaning_id: 'm10', remove: [{ target: 'm11' }] }] }), /needs a type and a target/u);
});

test('an edit that would silently drop authored relations is rejected (Issue #797)', () => {
  const meanings = [...initial('w10', '가다', 2), ...initial('w11', '오다', 1)];
  const withRelation = applyEdits({ meanings, adjudications: [] }, {
    relations: [{ source_meaning_id: 'm10_1', add: [{ type: 'direct', target: 'm11', note: 'n' }] }],
  });
  assert.throws(() => applyEdits(withRelation, { merges: [{ senses: ['w10-s1', 'w10-s2'], gloss: '합침' }] }), /would drop the authored relations of m10_1/u);
  assert.throws(() => applyEdits(withRelation, { drops: [{ sense_id: 'w10-s1', reason: 'out_of_scope' }] }), /would drop the authored relations of m10_1/u);
  assert.throws(() => applyEdits(
    { ...withRelation, initialMeaningIds: new Map([['w10-s1', 'm10_1'], ['w10-s2', 'm10_2']]) },
    { repartitions: [{ lemma: '가다', before: [{ id: 'm10_1', gloss: '가다 뜻 1', sense_ids: ['w10-s1'] }, { id: 'm10_2', gloss: '가다 뜻 2', sense_ids: ['w10-s2'] }], groups: [{ senses: ['w10-s1', 'w10-s2'], gloss: '합침' }] }] },
  ), /would drop the authored relations of m10_1/u);
});

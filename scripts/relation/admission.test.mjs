import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalIndex,
  candidateInventory,
  normalizeCandidate,
  prepareShard,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';

const canonical = (count = 500) => Array.from({ length: count }, (_, i) => ({
  id: `w${i + 1}`, lemma: `표제${i + 1}`, senses: [{ id: `w${i + 1}-s1`, pos: 'noun', gloss: `뜻${i + 1}` }],
}));
const rows = canonical();
rows.push({ id: 'w900', lemma: '동철', senses: [{ id: 'w900-s1', pos: 'noun', gloss: 'a' }] });
rows.push({ id: 'w901', lemma: '동철', senses: [{ id: 'w901-s1', pos: 'verb', gloss: 'b' }] });
rows.push({ id: 'w902', lemma: '유일', senses: [{ id: 'w902-s1', pos: 'noun', gloss: 'c' }] });
const index = buildCanonicalIndex(rows);
const shardRows = rows.slice(0, 500);
const shardSenseIds = new Set(shardRows.map((row) => row.senses[0].id));

const file = (name, byId) => ({
  name,
  rows: shardRows.map((row) => ({ record_id: row.id, senses: [{ sense_id: row.senses[0].id, candidates: byId[row.id] ?? [] }] })),
});
const files = [
  file('001_01_a_codex.jsonl', { w1: ['유일', '새  말', '동철'], w2: ['버릴말'] }),
  file('001_01_b_claude.jsonl', { w1: ['새 말', '표제1x'] }),
];

test('normalizeCandidate only trims and collapses whitespace; no fuzzy merge', () => {
  assert.equal(normalizeCandidate('  새   말 '), '새 말');
  assert.notEqual(normalizeCandidate('새말'), normalizeCandidate('새 말'));
});

test('inventory reports every missing required producer and keeps optional files', () => {
  const names = ['001_01_a_codex.jsonl', '001_01_a_deepseek.jsonl', '001_01_c_codex.jsonl'];
  const inventory = candidateInventory(names);
  assert.ok(inventory.missing.includes('01/b_claude'));
  assert.ok(!inventory.missing.includes('01/c'));
  assert.ok(inventory.missing.includes('02/a_codex'));
  assert.ok(inventory.files.includes('001_01_a_deepseek.jsonl'));
});

test('prepare merges exact duplicates, keeps homograph ambiguity visible and skips candidates an existing relation answers', () => {
  const approved = [
    { source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 },
  ];
  const { items, stats } = prepareShard({ canonicalRows: shardRows, candidateFiles: files, approvedRelationRows: approved, index });
  const w1 = items.find((item) => item.sense_id === 'w1-s1');
  assert.deepEqual(w1.candidates.map((c) => c.text), ['새 말', '동철', '표제1x']);
  assert.deepEqual(w1.candidates[0].producers, ['a_codex', 'b_claude']);
  assert.deepEqual(w1.candidates[1].same_spelling_records, ['w900', 'w901']);
  assert.equal(stats.skipped_existing, 1);
  assert.equal(stats.merged_duplicates, 1);
});

test('an existing ID relation also answers the reverse direction, but an ambiguous homograph spelling is never assumed covered', () => {
  const approved = [{ source_record_id: 'w900', source_sense_id: 'w900-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 }];
  const { items } = prepareShard({ canonicalRows: shardRows, candidateFiles: files, approvedRelationRows: approved, index });
  assert.ok(items.find((item) => item.sense_id === 'w1-s1').candidates.some((c) => c.text === '동철'));
});

const base = { source_record_id: 'w1', source_sense_id: 'w1-s1' };
const validate = (relationRows, dropRows = [], otherRelationRows = []) => validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows });
const idRow = { ...base, target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 3, reverse_type: 'mood', reverse_relevance: 5 };
const textRow = { ...base, text: '새 말', type: 'scene', relevance: 4 };

test('relation rows: valid ID (different reverse tier) and text-only rows pass', () => {
  assert.deepEqual(validate([idRow, textRow]), { relationCount: 2, dropCount: 0 });
});

test('relation rows reject the whole invalid set', () => {
  const cases = [
    [{ ...idRow, type: 'direct' }, /type "direct"/],
    [{ ...idRow, relevance: 0 }, /relevance must be an integer 1..9/],
    [{ ...idRow, relevance: 10 }, /relevance/],
    [{ ...idRow, relevance: 2.5 }, /relevance/],
    [{ ...idRow, reverse_relevance: 12 }, /reverse_relevance/],
    [{ ...idRow, reverse_type: 'antonym' }, /reverse_type/],
    [{ ...idRow, target_sense_id: 'w900-s1' }, /not a sense of w902/],
    [{ ...idRow, target_record_id: 'w1', target_sense_id: 'w1-s1' }, /own record/],
    [{ ...idRow, source_sense_id: 'w999-s1' }, /not a sense/],
    [{ ...idRow, source_record_id: 'w2' }, /not a sense of w2/],
    [{ ...idRow, extra: 1 }, /exactly/],
    [{ ...textRow, reverse_type: 'near' }, /exactly/],
    [{ ...textRow, text: '표제1' }, /source lemma/],
    [{ ...textRow, text: ' 새 말' }, /normalized/],
    [{ ...base, source_record_id: 'w902', source_sense_id: 'w902-s1', text: 'x', type: 'near', relevance: 1 }, /outside this shard/],
  ];
  for (const [row, pattern] of cases) assert.throws(() => validate([row]), pattern, JSON.stringify(row));
});

test('duplicates are rejected within the shard, in reverse and against other shards', () => {
  assert.throws(() => validate([idRow, idRow]), /duplicate/);
  assert.throws(() => validate([idRow], [], [{ source_record_id: 'w902', source_sense_id: 'w902-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 }]), /reverse-duplicate/);
  assert.throws(() => validate([textRow, textRow]), /duplicate text/);
  assert.throws(() => validate([textRow], [], [textRow]), /other shard/);
});

test('drop rows need real reasons and unique candidates', () => {
  const drop = { ...base, candidate: '버릴말', reason: '출발 의미와 무관' };
  assert.equal(validate([], [drop]).dropCount, 1);
  assert.throws(() => validate([], [{ ...drop, reason: ' ' }]), /reason/);
  assert.throws(() => validate([], [drop, drop]), /duplicate drop/);
  assert.throws(() => validate([], [{ ...drop, extra: 1 }]), /exactly/);
});

test('accounting: every unique candidate is exactly one of relation, drop or existing; omissions and double use fail', () => {
  const answer = (relationRows, dropRows, other = []) => verifyAccounting({ canonicalRows: shardRows, candidateFiles: files, relationRows, dropRows, otherRelationRows: other, index });
  const full = {
    relations: [
      { ...base, target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 2 },
      { ...base, text: '새 말', type: 'scene', relevance: 4 },
      { ...base, text: '표제1x', type: 'scene', relevance: 4 },
      { ...base, target_record_id: 'w900', target_sense_id: 'w900-s1', type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2 },
    ],
    drops: [{ source_record_id: 'w2', source_sense_id: 'w2-s1', candidate: '버릴말', reason: '무관' }],
  };
  const counts = answer(full.relations, full.drops);
  assert.equal(counts.missing, 0);
  assert.equal(counts.merged_duplicates, 1);
  assert.throws(() => answer(full.relations.slice(1), full.drops), /has no relation, drop or existing/);
  assert.throws(() => answer(full.relations, []), /has no relation, drop or existing/);
  assert.throws(() => answer(full.relations, [...full.drops, { ...full.drops[0], candidate: '새 말', source_record_id: 'w1', source_sense_id: 'w1-s1' }]), /already a text-only relation/);
  assert.throws(() => answer([...full.relations, { ...base, text: '없던말', type: 'near', relevance: 1 }], full.drops), /not a Stage 1 candidate/);
  const existing = [{ source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 }];
  assert.equal(answer(full.relations.slice(1), full.drops, existing).skipped_existing, 1);
  assert.throws(() => answer(full.relations, full.drops, existing), /already answered by an approved Relation/);
});

test('a decomposed spelling of the source lemma is rejected, never silently skipped as a merge', () => {
  const lemma = '가'.normalize('NFC');
  const local = [{ id: 'w1', lemma, senses: [{ id: 'w1-s1', pos: 'noun', gloss: 'g' }] }];
  const localIndex = buildCanonicalIndex(local);
  const decomposedFile = { name: '001_01_a_codex.jsonl', rows: [{ record_id: 'w1', senses: [{ sense_id: 'w1-s1', candidates: [lemma.normalize('NFD')] }] }] };
  assert.throws(() => prepareShard({ canonicalRows: local, candidateFiles: [decomposedFile], index: localIndex }), /repeats source lemma/);
  assert.throws(() => verifyAccounting({ canonicalRows: local, candidateFiles: [decomposedFile], relationRows: [], dropRows: [], otherRelationRows: [], index: localIndex }), /repeats source lemma/);
  assert.throws(() => validateRelationRows({ relationRows: [{ source_record_id: 'w1', source_sense_id: 'w1-s1', text: lemma, type: 'near', relevance: 1 }], index: localIndex, shardSenseIds: new Set(['w1-s1']) }), /source lemma/);
});

test('inventory allows exactly one C and one D model per batch and rejects a second one', () => {
  const full = ['01', '02'].flatMap((batch) => ['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c_codex', 'd_codex'].map((key) => {
    const [method, model] = key.split('_');
    return `001_${batch}_${method}_${model}.jsonl`;
  }));
  assert.deepEqual(candidateInventory(full).missing, []);
  assert.deepEqual(candidateInventory([...full, '001_01_a_deepseek.jsonl']).missing, []);
  assert.throws(() => candidateInventory([...full, '001_01_c_claude.jsonl']), /more than one C producer/);
  assert.throws(() => candidateInventory([...full, '001_02_d_deepseek.jsonl']), /more than one D producer/);
  // The same model name in the other batch is a different slot.
  assert.doesNotThrow(() => candidateInventory(full.map((name) => name.replace('_c_codex', '_c_claude').replace('001_02_c_claude', '001_02_c_codex'))));
});

test('a stored ID pair also answers the reverse Stage 1 candidate when the source spelling is unique; an ambiguous spelling still needs its own disposition', () => {
  const local = [
    { id: 'w1', lemma: '하나', senses: [{ id: 'w1-s1', pos: 'noun', gloss: 'a' }] },
    { id: 'w2', lemma: '둘', senses: [{ id: 'w2-s1', pos: 'noun', gloss: 'b' }] },
    { id: 'w3', lemma: '동철', senses: [{ id: 'w3-s1', pos: 'noun', gloss: 'c' }] },
    { id: 'w4', lemma: '동철', senses: [{ id: 'w4-s1', pos: 'noun', gloss: 'd' }] },
    { id: 'w5', lemma: '다섯', senses: [{ id: 'w5-s1', pos: 'noun', gloss: 'e' }] },
  ];
  const localIndex = buildCanonicalIndex(local);
  const files = (byId) => [{ name: '001_01_a_codex.jsonl', rows: local.map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: byId[record.id] ?? [] }] })) }];
  const verify = (candidates, relationRows) => verifyAccounting({ canonicalRows: local, candidateFiles: files(candidates), relationRows, dropRows: [], otherRelationRows: [], index: localIndex });
  const pair = (source, target) => ({ source_record_id: source[0], source_sense_id: source[1], target_record_id: target[0], target_sense_id: target[1], type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 3 });
  // 하나 <-> 둘 listed each other; one stored row (source 둘, unique spelling) answers both candidates.
  assert.equal(verify({ w1: ['둘'], w2: ['하나'] }, [pair(['w2', 'w2-s1'], ['w1', 'w1-s1'])]).reverse_covered, 1);
  // Source spelling 동철 names two records: the reverse candidate is not silently covered.
  assert.throws(() => verify({ w5: ['동철'], w3: ['다섯'] }, [pair(['w3', 'w3-s1'], ['w5', 'w5-s1'])]), /has no relation, drop or existing/);
});

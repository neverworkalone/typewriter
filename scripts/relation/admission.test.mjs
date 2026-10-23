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

test('Stage 2 retains an orthographic search form that is another Canonical lemma', () => {
  const canonicalRows = canonical(1000);
  const source = {
    id: 'w122481', lemma: '무릎 치기', search_forms: ['무릎 치기', '무릎치기'],
    senses: [{ id: 'w122481-s1', pos: 'expression', gloss: '상대편의 무릎 뒤쪽을 치면서 끌어당겨 넘기는 씨름 기술.' }],
  };
  const target = {
    id: 'w427808', lemma: '무릎치기', search_forms: ['무릎치기'],
    senses: [{ id: 'w427808-s1', pos: 'noun', gloss: '무릎까지 내려오는 짧은 바지.' }],
  };
  canonicalRows[500] = source;
  const file = {
    name: '090_02_b_codex.jsonl',
    rows: canonicalRows.slice(500).map((record, indexInBatch) => ({
      record_id: record.id,
      senses: [{ sense_id: record.senses[0].id, candidates: indexInBatch === 0 ? ['무릎치기'] : [] }],
    })),
  };
  const scopeRows = canonicalRows.slice(500);

  assert.throws(
    () => prepareShard({ canonicalRows, candidateFiles: [file], index: buildCanonicalIndex(canonicalRows), scopeRows }),
    /repeats source lemma "무릎 치기" in orthographic search form "무릎치기"/u,
  );

  const indexWithIndependentLemma = buildCanonicalIndex([...canonicalRows, target]);
  const { items } = prepareShard({ canonicalRows, candidateFiles: [file], index: indexWithIndependentLemma, scopeRows });
  assert.deepEqual(
    items.find((item) => item.sense_id === 'w122481-s1').candidates.map((candidate) => candidate.text),
    ['무릎치기'],
  );
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

test('accounting treats complete gloss words as mentions, not substrings inside other words', () => {
  const verifyDrop = (gloss, candidate) => {
    const canonicalRows = canonical();
    canonicalRows[0].senses[0].gloss = gloss;
    const candidateFile = {
      name: '001_01_a_codex.jsonl',
      rows: canonicalRows.map((record) => ({
        record_id: record.id,
        senses: [{ sense_id: record.senses[0].id, candidates: record.id === 'w1' ? [candidate] : [] }],
      })),
    };
    const localIndex = buildCanonicalIndex(canonicalRows);
    return verifyAccounting({
      canonicalRows,
      candidateFiles: [candidateFile],
      relationRows: [],
      dropRows: [{ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate, reason: '무관' }],
      otherRelationRows: [],
      index: localIndex,
    });
  };

  assert.equal(verifyDrop('떡갈나무에 잎이 넓다.', '떡').drop, 1, 'a shared syllable inside a different compound is not a gloss mention');
  assert.throws(() => verifyDrop('가로에 사는 민족.', '가로'), /named by the gloss/, 'a candidate followed by a grammatical particle is a complete gloss word');
  assert.equal(verifyDrop('소년이 나타났다.', '소').drop, 1, 'a year unit is not stripped from inside a different word');
  assert.throws(() => verifyDrop('1971년에 서울이 내려다보인다.', '1971'), /named by the gloss/, 'a numeric year followed by a particle is a complete gloss mention');
  assert.throws(() => verifyDrop('좌표를 구성하는 수들 가운데에서 가로 방향으로 어떤 점의 위치를 지시하는 좌표.', '수'), /named by the gloss/, 'the current shard-002 gloss names 수 in its plural form 수들');
  assert.throws(() => verifyDrop('창고나 부두 따위에서, 인부들이 쌀가마니 따위의 무거운 짐을 갈고리로 찍어 당겨서 어깨에 메고 나르는 일. 또는 그 짐.', '인부'), /named by the gloss/, 'the current shard-002 gloss names 인부 in its plural form 인부들이');
  assert.equal(verifyDrop('들판과 떡갈나무가 보인다.', '들').drop, 1, 'a plural marker inside a different compound is not a gloss mention');
  assert.equal(verifyDrop('가로에 사는 민족.', '가로수').drop, 1, 'a longer candidate is not a mention of its prefix');
  assert.throws(() => verifyDrop('떡갈나무에 잎이 넓다.', '떡갈나무'), /named by the gloss/, 'a complete candidate phrase remains protected from Drop');
});

test('accounting allows an approved reverse candidate for a different target sense, but rejects the same sense pair twice', () => {
  const local = [
    { id: 'w398821', lemma: '근근이', senses: [{ id: 'w398821-s1', pos: 'adverb', gloss: '어렵사리 겨우.' }] },
    { id: 'w183', lemma: '가까스로', senses: [
      { id: 'w183-s1', pos: 'adverb', gloss: '애를 써서 매우 힘들게.' },
      { id: 'w183-s2', pos: 'adverb', gloss: '겨우 빠듯하게.' },
    ] },
  ];
  const localIndex = buildCanonicalIndex(local);
  const candidateFile = {
    name: '001_01_a_codex.jsonl',
    rows: [
      { record_id: 'w398821', senses: [{ sense_id: 'w398821-s1', candidates: ['가까스로'] }] },
      { record_id: 'w183', senses: [
        { sense_id: 'w183-s1', candidates: [] },
        { sense_id: 'w183-s2', candidates: ['근근이'] },
      ] },
    ],
  };
  const pair = (sourceSense, targetSense) => ({
    source_record_id: sourceSense.split('-s')[0],
    source_sense_id: sourceSense,
    target_record_id: targetSense.split('-s')[0],
    target_sense_id: targetSense,
    type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 2,
  });
  const verify = (relationRows, otherRelationRows) => verifyAccounting({
    canonicalRows: local,
    candidateFiles: [candidateFile],
    relationRows,
    dropRows: [],
    otherRelationRows,
    index: localIndex,
  });

  // The two rows both surface “가까스로” from w398821-s1, but bind to different senses of w183.
  assert.equal(verify([pair('w398821-s1', 'w183-s1')], [pair('w183-s2', 'w398821-s1')]).missing, 0);
  assert.throws(
    () => verify([pair('w398821-s1', 'w183-s1')], [pair('w183-s1', 'w398821-s1')]),
    /already answered by an approved Relation/,
  );
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

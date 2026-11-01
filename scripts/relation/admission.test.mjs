import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availableReverseCandidateForms,
  buildCanonicalIndex,
  candidateInventory,
  createReverseCandidateFormLookup,
  mergeCandidates,
  normalizeCandidate,
  orphanedCandidateDrops,
  prepareShard,
  relationCandidateKeys,
  sameSpellingTargets,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';

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

test('persisted Relation and Drop JSONL use one compact schema while preserving candidate-assignment states', () => {
  const legacy = {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: 'w2-s1',
    type: 'scene', relevance: 4, reverse_type: 'scene', reverse_relevance: 4,
  };
  const versionZero = { ...legacy, candidate_assignment_version: 0, candidate_forms: ['표적 표기'], reverse_candidate_forms: [] };
  const versionOne = { ...legacy, candidate_assignment_version: 1, candidate_forms: ['표적 표기'], reverse_candidate_forms: ['출발 표기'] };
  const text = { source_record_id: 'w1', source_sense_id: 'w1-s1', text: '새 말', type: 'scene', relevance: 4 };
  const drop = { source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '버릴말', reason: '출발 의미와 무관' };

  const persisted = serializeRelationJsonl([legacy, versionZero, versionOne, text]);
  const stored = persisted.trim().split('\n').map(JSON.parse);
  assert.deepEqual(stored, [
    { id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'scene', rv: 4 },
    { id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'scene', rv: 4, ver: 0, fm: ['표적 표기'], rfm: [] },
    { id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'scene', rv: 4, ver: 1, fm: ['표적 표기'], rfm: ['출발 표기'] },
    { id: 'w1', sid: 'w1-s1', tt: '새 말', tp: 'scene', rv: 4 },
  ]);
  const decoded = parseRelationJsonl(persisted);
  assert.deepEqual(decoded, [legacy, versionZero, versionOne, text]);
  assert.deepEqual(parseDropJsonl(serializeDropJsonl([drop])), [drop]);
});

test('persisted readers reject the previous verbose Relation and Drop contracts', () => {
  assert.throws(() => parseRelationJsonl(JSON.stringify({
    source_record_id: 'w1', source_sense_id: 'w1-s1', text: '새 말', type: 'scene', relevance: 4,
  })), /obsolete Relation JSONL field/u);
  assert.throws(() => parseRelationJsonl(JSON.stringify({
    id: 'w1', sid: 'w1-s1', tid: 'w2', tsid: 'w2-s1', tp: 'scene', rv: 4, reverse_type: 'mood', reverse_relevance: 5,
  })), /obsolete Relation JSONL field/u);
  assert.throws(() => parseDropJsonl(JSON.stringify({
    source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '버릴말', reason: '무관',
  })), /obsolete Drop JSONL field/u);
  assert.throws(() => serializeRelationJsonl([{
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w2', target_sense_id: 'w2-s1',
    type: 'scene', relevance: 4, reverse_type: 'mood', reverse_relevance: 5,
  }]), /legacy reverse judgments/u);
});

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

test('shared relation candidate attribution preserves assigned and legacy forward/reverse forms', () => {
  const candidates = mergeCandidates(shardRows, [file('001_01_a_codex.jsonl', { w1: ['유일', '표제1x'] })], {
    canonicalLemmaForms: new Set(rows.map((row) => normalizeCandidate(row.lemma))),
  }).merged;
  const legacy = {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w902', target_sense_id: 'w902-s1',
    type: 'near', relevance: 3,
  };
  assert.deepEqual(relationCandidateKeys(legacy, candidates, index), {
    forward: [{ senseId: 'w1-s1', candidate: '유일', kind: 'id', direction: 'forward', targetSenseId: 'w902-s1' }],
    reverse: [{ senseId: 'w902-s1', candidate: '표제1', kind: 'id', direction: 'reverse', targetSenseId: 'w1-s1' }],
    reverseAliases: [],
    deferredForward: [],
  });

  const assigned = { ...legacy, candidate_assignment_version: 1, candidate_forms: ['표적 표기'], reverse_candidate_forms: ['출발 표기'] };
  assert.deepEqual(relationCandidateKeys(assigned, candidates, index), {
    forward: [{ senseId: 'w1-s1', candidate: '표적 표기', kind: 'id', direction: 'forward', targetSenseId: 'w902-s1' }],
    reverse: [{ senseId: 'w902-s1', candidate: '출발 표기', kind: 'id', direction: 'reverse', targetSenseId: 'w1-s1' }],
    reverseAliases: [],
    deferredForward: [],
  });
});

test('new ID rows leave already decided reverse Candidate forms unclaimed', () => {
  const source = { ...rows[0], lemma: '표제 1', search_forms: ['표제 1', '표제1', '표제-1'] };
  const reverseIndex = buildCanonicalIndex(rows.map((row) => row.id === source.id ? source : row));
  const target = rows.find((row) => row.id === 'w902');
  const alreadyClaimed = {
    source_record_id: 'w900', source_sense_id: 'w900-s1',
    target_record_id: target.id, target_sense_id: target.senses[0].id,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
    candidate_assignment_version: 1, candidate_forms: ['동철'], reverse_candidate_forms: ['표제 1'],
  };
  const drop = { source_record_id: target.id, source_sense_id: target.senses[0].id, candidate: '표제1', reason: 'edit' };
  const lookup = createReverseCandidateFormLookup({ relationRows: [alreadyClaimed], dropRows: [drop], index: reverseIndex });
  assert.deepEqual(lookup.available(source, target.senses[0].id), ['표제-1'],
    'the existing reverse Relation and edit Drop each own only their decided orthographic spelling');

  const earlierNewRelation = {
    source_record_id: source.id, source_sense_id: source.senses[0].id,
    target_record_id: target.id, target_sense_id: target.senses[0].id,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
    candidate_assignment_version: 1, candidate_forms: ['유일'], reverse_candidate_forms: ['표제-1'],
  };
  lookup.addRelation(earlierNewRelation);
  assert.deepEqual(lookup.available(source, target.senses[0].id), [],
    'an earlier new Relation also blocks only its assigned form');
  assert.deepEqual(availableReverseCandidateForms(source, target.senses[0].id, {
    relationRows: [], dropRows: [], index: reverseIndex,
  }), ['표제 1', '표제1', '표제-1'], 'undecided orthographic spellings remain available');
});

test('Stage 3 deletion reconciliation emits only locally owned orphan Stage 1 candidates', () => {
  const localRows = [...shardRows];
  const indexWithDuplicate = buildCanonicalIndex([...rows, {
    id: 'w903', lemma: '유일', senses: [{ id: 'w903-s1', pos: 'noun', gloss: '다른 뜻' }],
  }]);
  const candidateFiles = [file('001_01_a_codex.jsonl', { w1: ['유일', '동철'] })];
  const removedForward = {
    source_record_id: 'w1', source_sense_id: 'w1-s1', target_record_id: 'w902', target_sense_id: 'w902-s1',
    type: 'near', relevance: 3, candidate_assignment_version: 1, candidate_forms: ['유일'], reverse_candidate_forms: [],
  };
  const removedReverse = {
    source_record_id: 'w900', source_sense_id: 'w900-s1', target_record_id: 'w1', target_sense_id: 'w1-s1',
    type: 'near', relevance: 3, candidate_assignment_version: 1, candidate_forms: ['동철'], reverse_candidate_forms: ['동철'],
  };
  const orphaned = orphanedCandidateDrops({
    canonicalRows: localRows,
    candidateFiles,
    scopeRows: [localRows[0]],
    removedRelationRows: [removedForward, removedReverse],
    relationRows: [],
    dropRows: [],
    index: indexWithDuplicate,
  });
  assert.deepEqual(orphaned, [
    { source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '유일', reason: 'z' },
    { source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '동철', reason: 'z' },
  ]);

  const retained = orphanedCandidateDrops({
    canonicalRows: localRows,
    candidateFiles,
    scopeRows: [localRows[0]],
    removedRelationRows: [removedForward, removedReverse],
    relationRows: [{ ...removedForward, target_record_id: 'w903', target_sense_id: 'w903-s1' }],
    dropRows: [],
    index: indexWithDuplicate,
  });
  assert.deepEqual(retained, [{ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: '동철', reason: 'z' }],
    'a surviving relation for the same candidate prevents a Drop');

  const notPrepared = orphanedCandidateDrops({
    canonicalRows: localRows,
    candidateFiles: [file('001_01_a_codex.jsonl', { w1: ['다른후보'] })],
    scopeRows: [localRows[0]],
    removedRelationRows: [removedForward, removedReverse],
    relationRows: [],
    dropRows: [],
    index: indexWithDuplicate,
  });
  assert.deepEqual(notPrepared, [], 'a deleted relation cannot create a Drop for a Candidate absent from the local Stage 1 input');
});

test('Stage 2 does not require a source gloss for candidates already covered by an approved Relation or Drop', () => {
  const text = '이미결정된후보';
  for (const disposition of ['relation', 'drop']) {
    const canonicalRows = canonical();
    canonicalRows[0] = {
      ...canonicalRows[0],
      senses: [{ ...canonicalRows[0].senses[0], gloss: '→ 다른 표제어[Ⅱ].' }],
    };
    const sourceIndex = buildCanonicalIndex(canonicalRows);
    const covered = disposition === 'relation'
      ? [{ source_record_id: 'w1', source_sense_id: 'w1-s1', text, type: 'near', relevance: 3 }]
      : [];
    const dropped = disposition === 'drop'
      ? [{ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate: text, reason: '이미 결정됨' }]
      : [];

    const { items, stats } = prepareShard({
      canonicalRows,
      candidateFiles: [file('001_01_a_codex.jsonl', { w1: [text] })],
      approvedRelationRows: covered,
      dropRows: dropped,
      index: sourceIndex,
      scopeRows: canonicalRows,
    });
    assert.deepEqual(items, [], `${disposition}-accounted candidates do not need a new source gloss`);
    assert.equal(stats[disposition === 'relation' ? 'skipped_existing' : 'skipped_dropped'], 1);
  }
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

test('Stage 2 resolves curated lexical search forms alongside an unrelated exact lemma', () => {
  const source = {
    id: 'w1', lemma: '야나치다',
    senses: [{ id: 'w1-s1', pos: 'adjective', gloss: '영락없고 매몰하다.' }],
  };
  const exactLemma = {
    id: 'w2', lemma: '매정', search_forms: ['매정'],
    senses: [{ id: 'w2-s1', pos: 'noun', gloss: '정자를 난자에 결합시키는 일.' }],
  };
  const searchFormAlias = {
    id: 'w3', lemma: '매정하다', search_forms: ['매정하다', '매정'],
    senses: [
      { id: 'w3-s1', pos: 'adjective', gloss: '몹시 쌀쌀맞다.' },
      { id: 'w3-s2', pos: 'adjective', gloss: '얄미울 정도로 쌀쌀맞고 인정이 없다.' },
    ],
  };
  const secondExactLemma = {
    id: 'w4', lemma: '매정', search_forms: ['매정'],
    senses: [{ id: 'w4-s1', pos: 'noun', gloss: '정자를 난자에 결합시키는 다른 일.' }],
  };
  const secondSearchFormAlias = {
    id: 'w5', lemma: '매정스럽다', search_forms: ['매정스럽다', '매정'],
    senses: [{ id: 'w5-s1', pos: 'adjective', gloss: '매정한 성질이 있다.' }],
  };
  const canonicalRows = [source];
  const candidateFiles = [{
    name: '001_01_a_codex.jsonl',
    rows: [{ record_id: source.id, senses: [{ sense_id: 'w1-s1', candidates: ['매정'] }] }],
  }];
  // The aliases precede both exact-lemma records in Canonical order.
  const index = buildCanonicalIndex([source, searchFormAlias, exactLemma, secondSearchFormAlias, secondExactLemma]);

  assert.deepEqual(
    sameSpellingTargets(index, '매정').map((target) => [target.record_id, target.senses.map((sense) => sense.sense_id)]),
    [['w2', ['w2-s1']], ['w4', ['w4-s1']], ['w3', ['w3-s1', 'w3-s2']], ['w5', ['w5-s1']]],
    'exact-lemma and alias groups each keep Canonical order, with exact lemmas first',
  );
  const prepared = prepareShard({ canonicalRows, candidateFiles, index, scopeRows: canonicalRows });
  assert.deepEqual(prepared.items[0].candidates[0].same_spelling_records, ['w2', 'w4', 'w3', 'w5']);

  const relation = {
    source_record_id: source.id, source_sense_id: 'w1-s1',
    target_record_id: searchFormAlias.id, target_sense_id: 'w3-s2',
    type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2,
  };
  const covered = prepareShard({
    canonicalRows, candidateFiles, approvedRelationRows: [relation], index, scopeRows: canonicalRows,
  });
  assert.deepEqual(covered.items, [], 'a stored ID relation also covers its curated search-form candidate');
  assert.equal(covered.stats.skipped_existing, 1);

  const verified = verifyAccounting({
    canonicalRows,
    candidateFiles,
    relationRows: [relation],
    dropRows: [], otherRelationRows: [], index, scopeRows: canonicalRows,
  });
  assert.equal(verified.missing, 0, 'an ID link to the curated search-form target accounts for its candidate spelling');
});

test('an exact Canonical lemma wins over a colliding orthographic form for existing ID coverage', () => {
  const source = {
    id: 'w122481', lemma: '무릎 치기', search_forms: ['무릎 치기', '무릎치기'],
    senses: [{ id: 'w122481-s1', pos: 'expression', gloss: '상대편의 무릎 뒤쪽을 치면서 끌어당겨 넘기는 씨름 기술.' }],
  };
  const target = {
    id: 'w427808', lemma: '무릎치기', search_forms: ['무릎치기'],
    senses: [
      { id: 'w427808-s1', pos: 'noun', gloss: '무릎까지 내려오는 짧은 바지.' },
      { id: 'w427808-s2', pos: 'noun', gloss: '옛 웃옷.' },
    ],
  };
  const unrelatedSource = { id: 'w990000', lemma: '바지 관련어', senses: [{ id: 'w990000-s1', pos: 'noun', gloss: '뜻.' }] };
  const index = buildCanonicalIndex([source, target, unrelatedSource]);
  const candidateFile = (record, text) => ({
    name: '090_01_a_codex.jsonl',
    rows: [{ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: [text] }] }],
  });
  const crossShardLink = (targetSense) => ({
    source_record_id: target.id, source_sense_id: targetSense,
    target_record_id: source.id, target_sense_id: source.senses[0].id,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  });
  const sourceCandidates = candidateFile(source, '무릎치기');
  const prepare = (approvedRelationRows) => prepareShard({
    canonicalRows: [source], candidateFiles: [sourceCandidates], approvedRelationRows, index, scopeRows: [source],
  });
  const verify = (approvedRelationRows) => verifyAccounting({
    canonicalRows: [source], candidateFiles: [sourceCandidates], relationRows: [], dropRows: [],
    otherRelationRows: approvedRelationRows, index, scopeRows: [source],
  });

  const firstSenseOnly = [crossShardLink('w427808-s1')];
  assert.deepEqual(prepare(firstSenseOnly).items, [], 'an existing ID relation accounts for the candidate without requiring a link to every target sense');
  assert.equal(prepare(firstSenseOnly).stats.skipped_existing, 1);
  assert.equal(verify(firstSenseOnly).missing, 0, 'a valid other-shard reverse ID pair accounts for the candidate');

  assert.deepEqual(prepare([]).items[0].candidates.map((candidate) => candidate.text), ['무릎치기'], 'a new candidate still needs a target-sense decision');
  const everyTargetSense = [...firstSenseOnly, crossShardLink('w427808-s2')];
  assert.deepEqual(prepare(everyTargetSense).items, [], 'additional approved target-sense links remain existing coverage');
  assert.equal(prepare(everyTargetSense).stats.skipped_existing, 1);
  assert.equal(verify(everyTargetSense).skipped_existing, 1);

  const unrelatedCandidateFile = candidateFile(unrelatedSource, '무릎치기');
  const aliasOnlyRelation = {
    source_record_id: unrelatedSource.id, source_sense_id: unrelatedSource.senses[0].id,
    target_record_id: source.id, target_sense_id: source.senses[0].id,
    type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3,
  };
  const aliasPrepare = prepareShard({
    canonicalRows: [unrelatedSource], candidateFiles: [unrelatedCandidateFile],
    approvedRelationRows: [aliasOnlyRelation], index, scopeRows: [unrelatedSource],
  });
  assert.deepEqual(aliasPrepare.items[0].candidates[0].same_spelling_records, [target.id]);
  assert.deepEqual(aliasPrepare.items[0].candidates.map((candidate) => candidate.text), ['무릎치기']);
  assert.throws(() => verifyAccounting({
    canonicalRows: [unrelatedSource], candidateFiles: [unrelatedCandidateFile],
    relationRows: [aliasOnlyRelation], dropRows: [], otherRelationRows: [], index, scopeRows: [unrelatedSource],
  }), /is not a Stage 1 candidate/u, 'a relation to the colliding search-form record cannot claim the exact lemma candidate');
});

test('an exact existing ID relation answers its reverse candidate despite homographic spelling', () => {
  const approved = [{ source_record_id: 'w900', source_sense_id: 'w900-s1', target_record_id: 'w1', target_sense_id: 'w1-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 }];
  const { items } = prepareShard({ canonicalRows: shardRows, candidateFiles: files, approvedRelationRows: approved, index });
  assert.equal(items.some((item) => item.sense_id === 'w1-s1' && item.candidates.some((c) => c.text === '동철')), false);
});

const base = { source_record_id: 'w1', source_sense_id: 'w1-s1' };
const validate = (relationRows, dropRows = [], otherRelationRows = []) => validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows });
const idRow = { ...base, target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 3, reverse_type: 'near', reverse_relevance: 3 };
const textRow = { ...base, text: '새 말', type: 'scene', relevance: 4 };

test('relation rows: symmetric ID and text-only rows pass', () => {
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
    [{ ...idRow, reverse_type: 'mood' }, /must match type and relevance/],
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
  assert.equal(validate([], [{ ...drop, reason: 'editorial: historical reason' }]).dropCount, 1,
    'historical persisted Drop reasons remain free-form and are not migrated');
  assert.throws(() => validate([], [drop, drop]), /duplicate drop/);
  assert.throws(() => validate([], [{ ...drop, extra: 1 }]), /exactly/);
});

test('accounting: every unique candidate is exactly one of relation, drop or existing; omissions and double use fail', () => {
  const answer = (relationRows, dropRows, other = []) => verifyAccounting({ canonicalRows: shardRows, candidateFiles: files, relationRows, dropRows, otherRelationRows: other, index });
  const full = {
    relations: [
      { ...base, target_record_id: 'w902', target_sense_id: 'w902-s1', type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 1 },
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
  const verifyDrop = (gloss, candidate, reason = '무관') => {
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
      dropRows: [{ source_record_id: 'w1', source_sense_id: 'w1-s1', candidate, reason }],
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
  assert.equal(verifyDrop('가로에 사는 민족.', '가로', 'e').drop, 1,
    'a Drop for a connected candidate with no independent expression value may account for a gloss-named candidate');
  assert.throws(() => verifyDrop('가로에 사는 민족.', '가로', 'x'), /named by the gloss/,
    'an unrelated Drop code remains blocked for the same gloss-named candidate');
  assert.throws(() => verifyDrop('가로에 사는 민족.', '가로', '출발 의미와 무관'), /named by the gloss/,
    'an unrelated Drop remains blocked for the same gloss-named candidate');
  assert.throws(() => verifyDrop('가로에 사는 민족.', '가로', 'editorial: historical reason'), /named by the gloss/,
    'the old free-form editorial wording no longer receives the e exception');
  assert.equal(verifyDrop('가로에 사는 민족.', '가로', 'z').drop, 1,
    'the current Stage 3 reconciliation code remains exempt from the unrelated Drop check');
  assert.equal(verifyDrop('가로에 사는 민족.', '가로', 'edit').drop, 1,
    'historical Stage 3 edit rows remain readable while their replacement code is z');
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
    type: 'near', relevance: 1, reverse_type: 'near', reverse_relevance: 1,
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

test('a stored exact ID pair answers the reverse candidate when its spelling also names homographs', () => {
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
  const pair = (source, target) => ({ source_record_id: source[0], source_sense_id: source[1], target_record_id: target[0], target_sense_id: target[1], type: 'near', relevance: 2, reverse_type: 'near', reverse_relevance: 2 });
  // 하나 <-> 둘 listed each other; one stored row (source 둘, unique spelling) answers both candidates.
  assert.equal(verify({ w1: ['둘'], w2: ['하나'] }, [pair(['w2', 'w2-s1'], ['w1', 'w1-s1'])]).reverse_covered, 1);
  // Exact source ID w3 is one of the records named by 동철, so its stored pair covers w5's reverse candidate.
  assert.equal(verify({ w5: ['동철'], w3: ['다섯'] }, [pair(['w3', 'w3-s1'], ['w5', 'w5-s1'])]).reverse_covered, 1);
});

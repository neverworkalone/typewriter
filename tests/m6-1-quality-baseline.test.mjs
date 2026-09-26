import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateRelationGapQuotas,
  assertBaselineReportMatches,
  assertBaselineSnapshotMatches,
  assertSearchReachabilityPass,
  deriveM6QualityBaselineMetrics,
  evaluateSearchReachability,
  makeAmbiguousQuerySamplingUnit,
  makeRelationGapSamplingUnit,
  makeRelationSamplingUnit,
  makeWriterTaskSamplingUnit,
  M6_1_QUALITY_GATES,
  renderBaselineReport,
  selectBaselineExactMatches,
  selectStableHashSample,
  summarizeWriterFacingCandidatePopulation,
} from '../scripts/validate/m6-1-quality-baseline.mjs';
import { expandExactSearchCandidates } from '../src/domain/exact-search-candidates.js';

const relation = (target, target_sense, type = 'direct') => ({
  target,
  target_sense,
  type,
  note: 'Typewriter-authored test relation.',
});

const record = ({
  id,
  record_type = 'entry',
  role = 'start',
  lemma,
  search_forms = [lemma],
  senses,
}) => ({ id, record_type, role, lemma, search_forms, senses });

const fixture = {
  schema_version: 2,
  corpus_id: 'm6-baseline-test',
  cases: [
    {
      id: 'baseline-exact',
      query: '길',
      input_class: 'exact-lemma',
      evaluation: 'baseline',
      expected: { status: 'ready', result_ids: ['w001'], selected_record_id: null },
      actual: { status: 'ready', result_ids: ['w001'], selected_record_id: null },
      selection: null,
      assertions: [],
      problem: 'none',
      policy: 'Exact lookup fixture.',
    },
    {
      id: 'pending-morphology',
      query: '길었다',
      input_class: 'unsupported',
      evaluation: 'pending',
      expected: { status: 'unsupported', result_ids: [], selected_record_id: null },
      actual: { status: 'no-match', result_ids: [], selected_record_id: null },
      selection: null,
      assertions: [],
      problem: 'unsupported',
      policy: 'Pending morphology policy fixture.',
    },
  ],
};

test('M6-1 metrics keep roles, senses, POS, relations, and search forms separate', () => {
  const records = [
    record({
      id: 'w001',
      lemma: '길',
      senses: [
        { id: 'w001-s1', pos: 'noun', gloss: '길의 한 뜻', relations: [relation('r001', 'r001-s1')] },
        { id: 'w001-s2', pos: 'noun', gloss: '길의 다른 뜻' },
      ],
    }),
    record({
      id: 'w002',
      lemma: '잇다',
      search_forms: ['잇다', '공유'],
      senses: [{
        id: 'w002-s1',
        pos: 'verb',
        gloss: '잇다의 뜻',
        relations: [relation('w001', 'w001-s1', 'action')],
      }],
    }),
    record({
      id: 'w003',
      record_type: 'expression',
      lemma: '이미지',
      search_forms: ['자리', '공유'],
      senses: [{ id: 'w003-s1', pos: 'expression', gloss: '표현의 뜻' }],
    }),
    record({
      id: 'r001',
      role: 'reference-only',
      lemma: '참조',
      senses: [{
        id: 'r001-s1',
        pos: 'noun',
        gloss: '참조의 뜻',
        relations: [relation('w001', 'w001-s1')],
      }],
    }),
  ];
  const writerFacingCandidatePopulation = summarizeWriterFacingCandidatePopulation(records, [
    { key: '길', normalized_query: '길', status: 'ready', matches: [{ id: 'w001', role: 'start' }] },
    { key: '잇다', normalized_query: '잇다', status: 'ready', matches: [{ id: 'w002', role: 'start' }] },
    { key: '공유', normalized_query: '공유', status: 'ready', matches: [
      { id: 'w002', role: 'start' },
      { id: 'w003', role: 'start' },
    ] },
    { key: '자리', normalized_query: '자리', status: 'ready', matches: [{ id: 'w003', role: 'start' }] },
    { key: '이미지', normalized_query: '이미지', status: 'ready', matches: [{ id: 'w003', role: 'start' }] },
  ]);

  const metrics = deriveM6QualityBaselineMetrics({
    records,
    canonicalRevision: 'canonical-digest',
    canonicalFileCount: 1,
    regressionCorpus: fixture,
    regressionSha256: 'fixture-digest',
    reachability: { key_count: 4, matched_key_count: 4 },
    writerFacingCandidatePopulation,
  });

  assert.deepEqual(metrics.canonical.record_type_counts_by_role, {
    start: { entry: 2, expression: 1 },
    'reference-only': { entry: 1 },
  });
  assert.equal(metrics.canonical.total_sense_count, 5);
  assert.equal(metrics.canonical.reference_only_sense_count, 1);
  assert.deepEqual(metrics.canonical.single_sense_record_count_by_role, {
    start: 2,
    'reference-only': 1,
  });
  assert.deepEqual(metrics.canonical.polysemous_record_count_by_role, {
    start: 1,
    'reference-only': 0,
  });
  assert.deepEqual(metrics.canonical.pos_by_role.start.sense_count, {
    expression: 1,
    noun: 2,
    verb: 1,
  });
  assert.deepEqual(metrics.canonical.pos_by_role['reference-only'].sense_count, {
    noun: 1,
  });
  assert.equal(metrics.relations.directed_tuple_count, 3);
  assert.deepEqual(metrics.relations.source_to_target_role_counts, {
    'reference-only->start': 1,
    'start->reference-only': 1,
    'start->start': 1,
  });
  assert.equal(metrics.relations.tuples_with_matching_reverse_same_type, 2);
  assert.equal(metrics.relations.start_coverage.relation_bearing_count, 2);
  assert.equal(metrics.relations.start_coverage.relation_empty_count, 1);
  assert.equal(metrics.search.start_search_form_value_count, 5);
  assert.equal(metrics.search.starts_with_lemma_in_search_forms, 2);
  assert.equal(metrics.search.starts_with_non_lemma_search_form, 2);
  assert.equal(metrics.search.cross_record_search_form_collision_group_count, 1);
  assert.equal(metrics.search.cross_record_exact_key_collision_group_count, 1);
  assert.equal(metrics.search.writer_facing_candidate_population.ambiguous_query_count, 2);
  assert.deepEqual(metrics.search.writer_facing_candidate_population.ambiguous_query_counts_by_kind, {
    'single-polysemous-start-record': 1,
    'multiple-start-records': 1,
  });
  assert.equal(metrics.search.regression_corpus.baseline_case_count, 1);
  assert.deepEqual(metrics.search.regression_corpus.pending_case_ids, ['pending-morphology']);
  assert.deepEqual(metrics.search.regression_corpus.expected_actual_mismatch_case_ids, ['pending-morphology']);
});

test('M6-1 gate contract keeps prospective editorial thresholds explicit', () => {
  assert.equal(M6_1_QUALITY_GATES.contract_version, 'm6-1-quality-gates-v2');
  assert.equal(M6_1_QUALITY_GATES.sampling.writer_tasks.task_count, 100);
  assert.equal(M6_1_QUALITY_GATES.dimensions.find(({ id }) => id === 'direct-substitutability').threshold.accepted_rate, 0.95);
  assert.equal(M6_1_QUALITY_GATES.dimensions.find(({ id }) => id === 'relation-usefulness-and-type-honesty').threshold.accepted_rate_per_type, 0.8);
});

test('M6-1 reachability evaluator covers missing, unexpected, and reference-only results', () => {
  const expected = [{ key: '길', expected_ids: ['w001'] }];
  const passing = evaluateSearchReachability(expected, [{
    key: '길',
    status: 'ready',
    matches: [{ id: 'w001', role: 'start' }],
  }]);
  assert.deepEqual(passing, {
    key_count: 1,
    matched_key_count: 1,
    missing_expected_result_count: 0,
    unexpected_result_count: 0,
    unexpected_key_count: 0,
    reference_only_leak_count: 0,
    unsupported_key_count: 0,
    mismatched_key_count: 0,
    mismatched_keys: [],
  });
  assert.doesNotThrow(() => assertSearchReachabilityPass(passing));

  const missing = evaluateSearchReachability(expected, []);
  assert.equal(missing.missing_expected_result_count, 1);
  assert.throws(() => assertSearchReachabilityPass(missing), /all expected records must be returned/);

  const unexpected = evaluateSearchReachability(expected, [{
    key: '길',
    status: 'ready',
    matches: [
      { id: 'w001', role: 'start' },
      { id: 'w999', role: 'start' },
    ],
  }]);
  assert.equal(unexpected.unexpected_result_count, 1);
  assert.throws(() => assertSearchReachabilityPass(unexpected), /unexpected records/);

  const leakedReference = evaluateSearchReachability(expected, [{
    key: '길',
    status: 'ready',
    matches: [
      { id: 'w001', role: 'start' },
      { id: 'r001', role: 'reference-only' },
    ],
  }]);
  assert.equal(leakedReference.reference_only_leak_count, 1);
  assert.throws(() => assertSearchReachabilityPass(leakedReference), /reference-only records/);

  const unexpectedKey = evaluateSearchReachability(expected, [
    { key: '길', status: 'ready', matches: [{ id: 'w001', role: 'start' }] },
    { key: '숨은키', status: 'ready', matches: [{ id: 'w002', role: 'start' }] },
  ]);
  assert.equal(unexpectedKey.unexpected_key_count, 1);
  assert.throws(() => assertSearchReachabilityPass(unexpectedKey), /unregistered exact keys/);
});

test('M6-1 exact-key baseline excludes separately reviewed generated-form candidates', () => {
  assert.deepEqual(selectBaselineExactMatches([
    {
      id: 'w2969',
      role: 'start',
      match: { kind: 'exact-lemma', field: 'lemma' },
    },
    {
      id: 'w1081',
      role: 'start',
      match: { kind: 'generated-surface-form', field: 'surface-form' },
    },
    {
      id: 'w9999',
      role: 'reference-only',
      match: { kind: 'exact-search-form', field: 'search-form' },
    },
  ]), [
    { id: 'w2969', role: 'start' },
    { id: 'w9999', role: 'reference-only' },
  ]);
});

test('M6-1 snapshot equality rejects any derived metric drift', () => {
  const baseline = { metrics: { canonical: { start_count: 5000 } } };
  assert.doesNotThrow(() => assertBaselineSnapshotMatches(baseline, structuredClone(baseline)));
  assert.throws(() => assertBaselineSnapshotMatches(
    baseline,
    { metrics: { canonical: { start_count: 5001 } } },
  ), /differs from the current canonical data/);
});

test('M6-1 sampling identities and stable-hash selection are frozen', () => {
  assert.deepEqual(makeRelationSamplingUnit({
    source_record_id: 'w001',
    source_sense_id: 'w001-s1',
    target_record_id: 'w002',
    target_sense_id: 'w002-s1',
    type: 'near',
  }), {
    stratum: '["relation","near"]',
    stable_unit_id: '["w001","w001-s1","w002","w002-s1","near"]',
  });
  assert.deepEqual(makeRelationGapSamplingUnit({
    id: 'w003',
    role: 'start',
    record_type: 'entry',
    senses: [{ pos: 'noun', relations: [] }, { pos: 'verb', relations: [] }],
  }), { stratum: '["entry","noun"]', stable_unit_id: 'w003' });
  assert.deepEqual(makeAmbiguousQuerySamplingUnit('é', 2), {
    stratum: 'exact-writer-facing-candidate-query',
    stable_unit_id: 'é',
  });
  assert.throws(() => makeAmbiguousQuerySamplingUnit('é', 2));
  assert.deepEqual(makeWriterTaskSamplingUnit('sense_choice', 'task-007'), {
    stratum: 'sense_choice',
    stable_unit_id: 'task-007',
  });

  const sample = selectStableHashSample(
    ['a', 'b', 'c', 'd', '가', '나'].map((stable_unit_id) => ({ stratum: 'fixture', stable_unit_id })),
    { limit: 3, seed: 'm6-1-quality-benchmark-v1' },
  );
  assert.deepEqual(sample.map(({ stable_unit_id }) => stable_unit_id), ['나', 'a', 'b']);
  const candidates = ['a', 'b', 'c', 'd', '가', '나']
    .map((stable_unit_id) => ({ stratum: 'fixture', stable_unit_id }));
  assert.deepEqual(
    selectStableHashSample([...candidates].reverse(), { limit: 3, seed: 'm6-1-quality-benchmark-v1' }),
    sample,
  );
});

test('one polysemous exact result is an ambiguous writer-facing ranking case', () => {
  const polysemousRecord = record({
    id: 'w010',
    lemma: 'é',
    senses: [
      { id: 'w010-s1', pos: 'noun', gloss: '첫 뜻' },
      { id: 'w010-s2', pos: 'noun', gloss: '둘째 뜻' },
    ],
  });
  const candidates = expandExactSearchCandidates([polysemousRecord]);
  assert.deepEqual(candidates.map(({ key, recordId, senseId, isSenseChoice }) => ({
    key,
    recordId,
    senseId,
    isSenseChoice,
  })), [
    { key: 'w010:w010-s1', recordId: 'w010', senseId: 'w010-s1', isSenseChoice: true },
    { key: 'w010:w010-s2', recordId: 'w010', senseId: 'w010-s2', isSenseChoice: true },
  ]);

  const population = summarizeWriterFacingCandidatePopulation([polysemousRecord], [
    {
      key: 'é',
      normalized_query: 'é',
      status: 'ready',
      matches: [{ id: 'w010', role: 'start' }],
    },
    {
      key: 'é',
      normalized_query: 'é',
      status: 'ready',
      matches: [{ id: 'w010', role: 'start' }],
    },
  ]);
  assert.deepEqual(population, {
    exact_query_count: 1,
    candidate_options_per_exact_query: { '2': 1 },
    ambiguous_query_count: 1,
    ambiguous_query_candidate_option_count: 2,
    ambiguous_query_counts_by_kind: { 'single-polysemous-start-record': 1 },
    maximum_candidate_options: 2,
  });
  assert.deepEqual(makeAmbiguousQuerySamplingUnit('é', 2), {
    stratum: 'exact-writer-facing-candidate-query',
    stable_unit_id: 'é',
  });
  assert.throws(() => makeAmbiguousQuerySamplingUnit('é', 1));
});

test('M6-1 relation-gap allocation freezes Hamilton remainders and UTF-8 tie-breaks', () => {
  assert.deepEqual(allocateRelationGapQuotas({
    '["entry","noun"]': 11,
    '["entry","verb"]': 11,
  }, 21), {
    '["entry","noun"]': 11,
    '["entry","verb"]': 10,
  });
  const unicodeBmpStratum = '\uE000';
  const unicodeAstralStratum = '😀';
  assert.deepEqual(allocateRelationGapQuotas({
    [unicodeAstralStratum]: 11,
    [unicodeBmpStratum]: 11,
  }, 21), {
    [unicodeBmpStratum]: 11,
    [unicodeAstralStratum]: 10,
  });
  assert.deepEqual(allocateRelationGapQuotas({
    '["entry","noun"]': 100,
    '["entry","verb"]': 50,
    '["expression","expression"]': 50,
  }, 80), {
    '["entry","noun"]': 36,
    '["entry","verb"]': 22,
    '["expression","expression"]': 22,
  });
});

test('M6-1 report checker detects stale generated content', () => {
  const records = [record({
    id: 'w001',
    lemma: '길',
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '길의 뜻', relations: [] }],
  })];
  const reachability = {
    key_count: 1,
    matched_key_count: 1,
    missing_expected_result_count: 0,
    unexpected_result_count: 0,
    unexpected_key_count: 0,
    reference_only_leak_count: 0,
    unsupported_key_count: 0,
    mismatched_key_count: 0,
    mismatched_keys: [],
  };
  const metrics = deriveM6QualityBaselineMetrics({
    records,
    canonicalRevision: 'canonical-digest',
    canonicalFileCount: 1,
    regressionCorpus: fixture,
    regressionSha256: 'fixture-digest',
    reachability,
    writerFacingCandidatePopulation: summarizeWriterFacingCandidatePopulation(records, [{
      key: '길',
      normalized_query: '길',
      status: 'ready',
      matches: [{ id: 'w001', role: 'start' }],
    }]),
  });
  const snapshot = {
    source: { repository_commit: 'commit', canonical_revision: 'canonical-digest' },
    metrics,
    quality_gates: M6_1_QUALITY_GATES,
    inherited_m5_risks: [],
  };
  const template = '# Report\n\n{{M6_1_GENERATED_SNAPSHOT}}\n';
  const generated = renderBaselineReport(template, snapshot);
  assert.doesNotThrow(() => assertBaselineReportMatches(template, generated, snapshot));
  assert.throws(() => assertBaselineReportMatches(
    template,
    generated.replace('| Canonical records | 1 |', '| Canonical records | 2 |'),
    snapshot,
  ), /differs from its machine-readable baseline/);
});

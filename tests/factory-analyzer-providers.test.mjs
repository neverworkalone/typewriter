import assert from 'node:assert/strict';
import test from 'node:test';

import { RESOLUTION_POLICY, createKiwiProvider, providerIdentityDigest } from '../scripts/factory/analyzer-providers.mjs';
import { expectedAnalyzerDigest, validateCandidateBatch } from '../scripts/factory/contract.mjs';
import { PROVIDER_REGISTRY, parseArguments, runStage1 } from '../scripts/factory/produce-candidates.mjs';
import { Stage1Error, produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';

const KIWI_METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3, proposal_contract: 'derivation-root-v1' };
const HEX = 'a'.repeat(64);
const path = (lemma, pos, form = lemma) => [{ lemma, pos, form }];

// Synthetic provider: surface → ranked paths, or a raw result override. Records every call.
function fakeProvider(id, table, { n_best = true, metadata = KIWI_METADATA, version = '1.0.0' } = {}) {
  const calls = [];
  return {
    calls,
    id,
    identity: { provider_id: id, implementation: `fake-${id}`, version, model: 'm1', config: {} },
    capabilities: { n_best, derivation: false },
    assertMetadata: () => {},
    analyze: async (requests) => {
      calls.push(requests.map((request) => request.text));
      return {
        metadata,
        results: requests.map(({ id: rid, text }) => {
          const entry = table[text];
          if (typeof entry === 'function') return entry(rid, text);
          return { id: rid, input_digest: analysisInputDigest(text), reason: '', ...(entry ? { status: 'ok', analyses: entry } : { status: 'unsupported', analyses: [] }) };
        }),
      };
    },
  };
}
const kiwi = (table, over) => ({ ...createKiwiProvider({ analyze: fakeProvider('kiwi', table, over).analyze }), calls: [] });
const bestOnlyKiwi = (table) => ({ ...spyKiwi(table), capabilities: { n_best: false, derivation: true } });
const spyKiwi = (table) => {
  const inner = fakeProvider('kiwi', table);
  return { ...createKiwiProvider({ analyze: inner.analyze }), calls: inner.calls };
};

const hit = (document, paragraph, surface) => ({ source_path: 'c/x', corpus_id: 'c', document_id: document, document_ordinal: 1, paragraph_id: paragraph,
  paragraph_ordinal: 1, source_category: 'written', source_year: 2025, matched_surface_form: surface });
const cand = (lemma, pos, hits, extra = {}) => ({ proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [...new Set(hits.map((h) => h.matched_surface_form))].map((surface) => ({ surface })), evidence: { representative_hits: hits }, ...extra });
const evidence = (candidates) => ({ contract_version: 'm9-corpus-candidate-evidence-v1', index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
  extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' }, candidates });
const produce = (candidates, providers, over = {}) => produceCandidateBatch({
  evidence: evidence(candidates), providers, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000001', taskId: 'T000001', ...over,
});
const rowOf = (result, lemma) => result.rows.find((row) => row.input === lemma);
// Holds are per observation in the lemma-centered contract; these are the lemma's distinct ones.
const holdsOf = (result, lemma) => [...new Set(rowOf(result, lemma).observations.flatMap((observation) => observation.holds))].sort();
const unresolvedOf = (result) => result.manifest.unresolved_observations.map((entry) => [entry.surface, entry.holds]);
const FILLER = cand('걸음', 'noun', [hit('dz', 'pz', '걸음')]);
const fillerTable = { 걸음: [path('걸음', 'noun')] };

const GOOD = path('짠하다', 'adjective');

test('default order is exactly [kiwi]: manifest keeps the pre-provider shape and key order', async () => {
  const result = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [kiwi({ 짠한: [GOOD] })]);
  assert.equal(result.manifest.contract, 'lexical-factory-candidate-manifest-v2');
  assert.ok(!('analyzer_providers' in result.manifest) && !('resolution_policy' in result.manifest), 'the default order adds no provider fields');
  assert.deepEqual(result.summary.providerOrder, ['kiwi']);
  assert.equal(result.manifest.analyzer_digest, expectedAnalyzerDigest(result.manifest));
  // The legacy `analyzer` argument is the same default order.
  const legacy = await produceCandidateBatch({ evidence: evidence([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])]),
    analyzer: fakeProvider('kiwi', { 짠한: [GOOD] }).analyze, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000001', taskId: 'T000001' });
  assert.equal(legacy.candidatesText, result.candidatesText);
  assert.deepEqual(legacy.manifest, result.manifest);
});

test('Provider A resolves a candidate: provider B is never called', async () => {
  const first = spyKiwi({ 짠한: [GOOD] });
  const second = fakeProvider('fakeb', { 짠한: [GOOD] });
  const result = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [first, second]);
  assert.deepEqual(holdsOf(result, '짠하다'), []);
  assert.equal(second.calls.length, 0);
  assert.equal(result.manifest.analyzer_providers.length, 2);
});

test('Provider A unresolved: B is invoked for that candidate only and its reading settles it', async () => {
  const first = spyKiwi({ 짠한: [GOOD] });
  const second = fakeProvider('fakeb', { 낯선: [path('낯설다', 'adjective')] });
  const result = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])], [first, second]);
  assert.deepEqual(first.calls, [['낯선', '짠한']]);
  assert.deepEqual(second.calls, [['낯선']], 'B only receives the surface A could not settle');
  assert.deepEqual(holdsOf(result, '낯설다'), []);
  assert.deepEqual(result.attemptLog.filter((entry) => entry.provider_id === 'fakeb').map((entry) => [entry.state, entry.fallback]), [['resolved', false]]);
  assert.ok(result.attemptLog.every((entry) => /^[0-9a-f]{64}$/u.test(entry.input_digest) && !('surface' in entry)), 'attempt log is text-free');
  assert.deepEqual(result.summary.providerAttempts, { kiwi: { attempts: 2, resolved: 1, fell_through: 1 }, fakeb: { attempts: 1, resolved: 1, fell_through: 0 } });
});

test('B still uncertain keeps the per-row hold; every provider hold is retained', async () => {
  const second = fakeProvider('fakeb', { 낯선: (id) => ({ id, input_digest: analysisInputDigest('낯선'), status: 'error', analyses: [] }) });
  const result = await produce([cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')]), FILLER], [spyKiwi(fillerTable), second]);
  assert.deepEqual(result.rows.map((row) => row.input), ['걸음'], 'no provider settled 낯선: it is not a headword');
  assert.deepEqual(unresolvedOf(result), [['낯선', ['analysis_error', 'analysis_unsupported']]]);
});

test('an upstream hard hold is never cleared by a later provider', async () => {
  const result = await produce([
    cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')], { ambiguity_status: 'held_pos', coverage_status: 'covered_elsewhere' }),
    cand('걸음', 'noun', [])], [spyKiwi({ 짠한: [GOOD] }), fakeProvider('fakeb', { 짠한: [GOOD], 걸음: [path('걸음', 'noun')] })]);
  assert.deepEqual(holdsOf(result, '짠하다'), ['analysis_ambiguous', 'coverage_collision']);
  assert.ok(holdsOf(result, '걸음').includes('no_evidence'));
});

test('a lemma/POS mismatch is final: a fallback provider is not asked to override it', async () => {
  const second = fakeProvider('fakeb', { 걸어: [path('걷다', 'verb')] });
  const result = await produce([cand('걷다', 'verb', [hit('d1', 'p1', '걸어')])], [spyKiwi({ 걸어: [path('걸다', 'verb')] }), second]);
  assert.deepEqual(holdsOf(result, '걸다'), ['lemma_mismatch']);
  assert.equal(second.calls.length, 0);
});

test('best-only provider output is never automatically certain', async () => {
  const bestOnly = (table) => fakeProvider('fakea', table, { n_best: false });
  const alone = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), FILLER], [bestOnly({ ...fillerTable, 짠한: [GOOD] }), spyKiwi({ ...fillerTable })]);
  assert.deepEqual(unresolvedOf(alone), [['짠한', ['analysis_unsupported']]], 'best-only + unsupported is never certain and stays unresolved');
  const agree = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [bestOnly({ 짠한: [GOOD] }), bestOnlyKiwi({ 짠한: [GOOD] })]);
  assert.deepEqual(holdsOf(agree, '짠하다'), ['analysis_ambiguous'], 'two single-best readers do not prove a rival absent');
  const confirmed = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [bestOnly({ 짠한: [GOOD] }), spyKiwi({ 짠한: [GOOD] })]);
  assert.deepEqual(holdsOf(confirmed, '짠하다'), [], 'an N-best reader confirming the same lemma/POS settles it');
});

test('disagreement between a best-only reading and a later provider keeps a mismatch hold', async () => {
  // No extractor POS hint, so the two clean readings can genuinely differ.
  const result = await produce([cand('짠하다', null, [hit('d1', 'p1', '짠한')])],
    [fakeProvider('fakea', { 짠한: [GOOD] }, { n_best: false }), spyKiwi({ 짠한: [path('짠하다', 'verb')] })]);
  const [row] = result.rows;
  assert.deepEqual([row.input, row.pos_hypotheses, holdsOf(result, '짠하다')], ['짠하다', ['adjective'], ['analysis_ambiguous', 'analysis_mismatch']]);
});

test('malformed, stale and missing provider results become explicit holds', async () => {
  const stale = (id) => ({ id, input_digest: HEX, status: 'ok', analyses: [GOOD] });
  const malformed = (id, text) => ({ id, input_digest: analysisInputDigest(text), status: 'ok', analyses: [[{ lemma: '짠하다', pos: 'particle', form: '짠하' }]] });
  const missing = () => null;
  const cases = [[stale, 'analysis_stale'], [malformed, 'analysis_error'], [missing, 'analysis_missing']];
  for (const [factory, hold] of cases) {
    const result = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), FILLER], [kiwi({ ...fillerTable, 짠한: factory })]);
    assert.deepEqual(unresolvedOf(result), [['짠한', [hold]]]);
    assert.deepEqual(result.rows.map((row) => row.input), ['걸음']);
  }
  // A malformed result from the first provider may still be settled by the next.
  const settled = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [kiwi({ 짠한: malformed }), fakeProvider('fakeb', { 짠한: [GOOD] })]);
  assert.deepEqual(holdsOf(settled, '짠하다'), []);
});

test('duplicate result ids never produce a certain result, whatever the order', async () => {
  const good = (id, text) => ({ id, input_digest: analysisInputDigest(text), status: 'ok', analyses: [GOOD] });
  const bad = (id, text) => ({ id, input_digest: analysisInputDigest(text), status: 'error', analyses: [] });
  const rival = (id, text) => ({ id, input_digest: analysisInputDigest(text), status: 'ok', analyses: [path('짠', 'noun')] });
  for (const pair of [[good, bad], [bad, good], [good, rival], [rival, good], [good, good]]) {
    const dup = { ...spyKiwi({}), analyze: async (requests) => ({ metadata: KIWI_METADATA,
      results: requests.flatMap(({ id, text }) => pair.map((make) => make(id, text))) }) };
    const dupWithFiller = { ...dup, analyze: async (requests) => ({ metadata: KIWI_METADATA,
      results: requests.flatMap(({ id, text }) => (text === '걸음' ? [{ id, input_digest: analysisInputDigest(text), status: 'ok', analyses: [path('걸음', 'noun')] }] : pair.map((make) => make(id, text)))) }) };
    const first = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), FILLER], [dupWithFiller]);
    assert.deepEqual(unresolvedOf(first), [['짠한', ['analysis_error']]]);
    const second = fakeProvider('fakeb', { 짠한: [GOOD] });
    const settled = await produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [dup, second]);
    assert.deepEqual(holdsOf(settled, '짠하다'), [], 'only a later well-formed provider may settle it');
    assert.equal(second.calls.length, 1);
  }
});

test('an unavailable provider or incompatible metadata fails the run closed', async () => {
  const down = { ...fakeProvider('fakeb', {}), analyze: async () => { throw new Error('not installed'); } };
  await assert.rejects(() => produce([cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])], [spyKiwi({}), down]), /fakeb failed closed: not installed/);
  const wrong = { ...fakeProvider('fakeb', { 낯선: [path('낯설다', 'adjective')] }), assertMetadata: () => { throw new Error('version drift'); } };
  await assert.rejects(() => produce([cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])], [spyKiwi({}), wrong]), /version drift/);
  await assert.rejects(() => produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [fakeProvider('fakeb', { 짠한: [GOOD] })]), /include the pinned kiwi/);
  await assert.rejects(() => produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [spyKiwi({}), spyKiwi({})]), /duplicate analyzer provider/);
  await assert.rejects(() => produce([cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')])], [spyKiwi({}), { id: 'bad' }]), /invalid analyzer provider|must be an object/);
  const noContract = fakeProvider('fakeb', { 낯선: [path('낯설다', 'adjective')] }, { metadata: { ...KIWI_METADATA, proposal_contract: 'other' } });
  await assert.rejects(() => produce([cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])], [spyKiwi({}), noContract]), Stage1Error);
});

test('ordered replay is deterministic; provider, model, order and policy change the analyzer digest', async () => {
  const candidates = [cand('짠하다', 'adjective', [hit('d1', 'p1', '짠한')]), cand('낯설다', 'adjective', [hit('d2', 'p1', '낯선')])];
  const run = (providers) => produce(candidates, providers);
  const make = (version = '1.0.0') => [spyKiwi({ 짠한: [GOOD] }), fakeProvider('fakeb', { 낯선: [path('낯설다', 'adjective')] }, { version })];
  const a = await run(make());
  const b = await run(make());
  assert.equal(a.candidatesText, b.candidatesText);
  assert.deepEqual(a.manifest, b.manifest);
  const upgraded = await run(make('2.0.0'));
  const reordered = await run(make().reverse());
  const kiwiOnly = await run([spyKiwi({ 짠한: [GOOD], 낯선: [path('낯설다', 'adjective')] })]);
  const digests = new Set([a, upgraded, reordered, kiwiOnly].map((result) => result.manifest.analyzer_digest));
  assert.equal(digests.size, 4);
  assert.equal(providerIdentityDigest(make('1.0.0')[1].identity) === providerIdentityDigest(make('2.0.0')[1].identity), false);
  assert.deepEqual(validateCandidateBatch({ manifest: a.manifest, candidatesText: a.candidatesText }), []);
  // The validator rejects a tampered provider list, a downgraded policy and a provider-only digest forgery.
  const bad = (patch) => validateCandidateBatch({ manifest: { ...a.manifest, ...patch }, candidatesText: a.candidatesText }).join('\n');
  assert.match(bad({ analyzer_providers: a.manifest.analyzer_providers.slice(0, 1) }), /at least two/);
  assert.match(bad({ resolution_policy: 'provider-resolution-v0' }), new RegExp(RESOLUTION_POLICY));
  assert.match(bad({ analyzer_providers: [...a.manifest.analyzer_providers].reverse() }), /analyzer_digest must bind/);
  assert.match(bad({ analyzer_providers: a.manifest.analyzer_providers.filter((p) => p.provider_id !== 'kiwi').concat(a.manifest.analyzer_providers.filter((p) => p.provider_id !== 'kiwi')) }), /repeat|pinned kiwi/);
});

test('CLI provider selection defaults to kiwi and fails closed on unknown, repeated or unwritable choices', async () => {
  const base = ['--evidence', 'data/reference/x/e.json', '--task-id', 'T000001'];
  assert.deepEqual(parseArguments(base).providers, ['kiwi']);
  assert.deepEqual(parseArguments([...base, '--providers', 'kiwi']).providers, ['kiwi']);
  assert.throws(() => parseArguments([...base, '--providers', 'kiwi,khaiii']), /unknown analyzer provider\(s\) khaiii/);
  assert.throws(() => parseArguments([...base, '--providers', 'kiwi,kiwi']), /repeat/);
  assert.deepEqual(Object.keys(PROVIDER_REGISTRY), ['kiwi']);
  await assert.rejects(() => runStage1([...base, '--attempt-log', 'data/candidates/log.jsonl'], { permission: async () => {}, root: '/nonexistent' }), Stage1Error);
});

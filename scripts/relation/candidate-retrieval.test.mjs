import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import {
  buildRelationIndex, retrieveRelationCandidates, validateRelationCandidateArtifact,
} from './candidate-retrieval.mjs';

const entry = (id, lemma, pos, gloss, relations = []) => ({
  id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
  senses: [{ id: `${id}-s1`, pos, gloss, ...(relations.length ? { relations } : {}) }],
});
const synthetic = {
  canonicalRevision: 'a'.repeat(64),
  records: [
    entry('w1', '반향', 'noun', '벽에 부딪힌 소리가 되돌아와 겹쳐 들리는 현상.', [{ target: 'w2', target_sense: 'w2-s1', type: 'near', note: 'n', relevance: 3 }]),
    entry('w2', '메아리', 'noun', '산이나 벽에 부딪혀 되돌아오는 소리.'),
    entry('w3', '울림', 'noun', '소리가 퍼지며 되돌아와 오래 남는 떨림.', [{ target: 'w2', target_sense: 'w2-s1', type: 'near', note: 'n', relevance: 2 }]),
    entry('w4', '고요', 'noun', '아무 소리도 없이 잠잠한 상태.'),
    entry('w5', '냉감', 'noun', '피부에 차갑게 닿아 서늘하게 느껴지는 감각.'),
  ],
};

test('canonical source: deterministic, bounded, candidates only, preserves identities', () => {
  const index = buildRelationIndex(synthetic);
  const source = { kind: 'canonical', sense_id: 'w3-s1', pos: 'noun', gloss: synthetic.records[2].senses[0].gloss };
  const a = retrieveRelationCandidates(index, [source]);
  const b = retrieveRelationCandidates(buildRelationIndex(synthetic), [source]);
  assert.deepEqual(a, b);
  assert.equal(a.canonical_snapshot_digest, 'a'.repeat(64));
  assert.deepEqual(validateRelationCandidateArtifact(a, index), []);
  const ids = a.sources[0].candidates.map((c) => c.target.sense_id);
  assert.ok(ids.includes('w1-s1'), 'incoming relation / gloss overlap surfaces w1');
  assert.ok(!ids.includes('w3-s1') && !ids.includes('w2-s1'), 'self and already-related targets are excluded');
  assert.equal(a.sources[0].already_related_excluded, 1);
  assert.ok(a.sources[0].candidates.every((c) => c.target.pos === 'noun' && !('score' in c)));
  assert.equal(retrieveRelationCandidates(index, [source], { config: { max_candidates: 1 } }).sources[0].candidates.length, 1);
});

test('canonical source gloss/pos are bound to the snapshot', () => {
  const index = buildRelationIndex(synthetic);
  const bare = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1' }]);
  const full = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1', pos: 'noun', gloss: synthetic.records[2].senses[0].gloss }]);
  assert.deepEqual(bare, full);
  assert.throws(() => retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1', pos: 'noun', gloss: '다른 stale gloss 냉감' }]), /differs from the canonical snapshot/u);
  assert.throws(() => retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1', pos: 'verb' }]), /differs/u);
});

test('same-batch provisional targets use provisional identities and no canonical ids', () => {
  const index = buildRelationIndex(synthetic);
  const out = retrieveRelationCandidates(index, [
    { kind: 'canonical', sense_id: 'w4-s1', pos: 'noun', gloss: synthetic.records[3].senses[0].gloss },
    { kind: 'provisional', batch_id: 'B', candidate_id: 'C9', sense_key: 's1', lemma: '정적', pos: 'noun', gloss: '아무 소리도 없이 잠잠하게 가라앉은 상태.' },
  ]);
  const hit = out.sources[0].candidates.find((c) => c.target.kind === 'provisional');
  assert.equal(hit.target.provisional_id, 'provisional:B/C9/s1');
  assert.ok(!('sense_id' in hit.target) && !('record_id' in hit.target));
  assert.equal(out.sources[1].source.kind, 'provisional');
  assert.deepEqual(validateRelationCandidateArtifact(out, index), []);
});

test('explicit hints are signals only; unresolved hints add nothing', () => {
  const index = buildRelationIndex(synthetic);
  const base = { kind: 'provisional', batch_id: 'B', candidate_id: 'C1', sense_key: 's1', lemma: '잔향', pos: 'noun', gloss: '소리가 사라진 뒤 남는 울림.' };
  const out = retrieveRelationCandidates(index, [{ ...base, hints: [{ lemma: '고요' }, { lemma: '없는말' }] }]);
  const quiet = out.sources[0].candidates.find((c) => c.target.sense_id === 'w4-s1');
  assert.deepEqual(quiet.signals.includes('explicit_hint'), true);
  assert.equal(out.sources[0].candidates.some((c) => c.target.sense_id === 'w5-s1'), false);
});

test('literature: digests only, no-hit is not negative evidence', () => {
  const index = buildRelationIndex(synthetic);
  const source = { kind: 'canonical', sense_id: 'w5-s1', pos: 'noun', gloss: synthetic.records[4].senses[0].gloss };
  const none = retrieveRelationCandidates(index, [source]);
  assert.equal(none.sources[0].literature.no_hit_is_negative_evidence, false);
  assert.equal(none.sources[0].literature.status, 'not_provided');
  const withLit = retrieveRelationCandidates(index, [source], { literature: { 'w5-s1': [{ location_digest: 'd'.repeat(64), text: '그는 깊은 고요 속에서 냉감을 느꼈다.' }] } });
  const hit = withLit.sources[0].candidates.find((c) => c.target.sense_id === 'w4-s1');
  assert.deepEqual(hit.signals, ['literature_cooccurrence']);
  assert.deepEqual(hit.literature_location_digests, ['d'.repeat(64)]);
  assert.ok(!JSON.stringify(withLit).includes('깊은'), 'no literary text in artifact');
  const empty = retrieveRelationCandidates(index, [source], { literature: { 'w5-s1': [{ location_digest: 'e'.repeat(64), text: '무관한 문장' }] } });
  assert.equal(empty.sources[0].literature.status, 'attempted');
  assert.deepEqual(empty.sources[0].candidates.map((c) => c.target.sense_id), none.sources[0].candidates.map((c) => c.target.sense_id));
});

test('validator rejects editorial fields and stale snapshots', () => {
  const index = buildRelationIndex(synthetic);
  const artifact = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1' }]);
  artifact.sources[0].candidates[0]?.signals && (artifact.sources[0].candidates[0].type = 'near');
  assert.ok(validateRelationCandidateArtifact(artifact, index).some((e) => e.includes('editorial field')));
  const stale = { ...retrieveRelationCandidates(index, []), canonical_snapshot_digest: 'b'.repeat(64) };
  assert.ok(validateRelationCandidateArtifact(stale, index).some((e) => e.includes('differs')));
});

test('validator is fail-closed on tampered producer output', () => {
  const index = buildRelationIndex(synthetic);
  const make = () => retrieveRelationCandidates(index, [
    { kind: 'provisional', batch_id: 'B', candidate_id: 'C8', sense_key: 's1', lemma: '잠잠', pos: 'noun', gloss: '아무 소리도 없이 잠잠한 상태.', hints: [{ lemma: '메아리' }, { lemma: '정적' }] },
    { kind: 'provisional', batch_id: 'B', candidate_id: 'C9', sense_key: 's1', lemma: '정적', pos: 'noun', gloss: '아무 소리도 없이 잠잠하게 가라앉은 상태.' },
  ]);
  assert.deepEqual(validateRelationCandidateArtifact(make(), index, { expectedSourceIds: ['provisional:B/C8/s1', 'provisional:B/C9/s1'] }), []);
  const cases = {
    'target reduced to pos': (a) => { a.sources[0].candidates[0].target = { pos: 'noun' }; },
    'target kind missing': (a) => { delete a.sources[0].candidates[0].target.kind; },
    'canonical record_id removed': (a) => { const c = a.sources[0].candidates.find((x) => x.target.kind === 'canonical'); delete c.target.record_id; },
    'provisional ids removed': (a) => { const c = a.sources[0].candidates.find((x) => x.target.kind === 'provisional'); delete c.target.provisional_id; delete c.target.candidate_id; },
    'provisional target not a source': (a) => { a.sources.pop(); },
    'sources deleted': (a) => { delete a.sources; },
    'editorial field in target': (a) => { a.sources[0].candidates[0].target.relevance = 5; },
    'editorial field on candidate': (a) => { a.sources[0].candidates[0].relevance = 5; },
    'source identity removed': (a) => { a.sources[0].source = {}; },
    'duplicate target': (a) => { a.sources[0].candidates.push({ ...a.sources[0].candidates[0], rank: a.sources[0].candidates.length + 1 }); },
    'provisional target pos changed': (a) => { a.sources[0].candidates.find((x) => x.target.kind === 'provisional').target.pos = 'verb'; },
    'bad literature digest': (a) => { a.sources[0].candidates[0].literature_location_digests = ['x']; },
    'pool above declared max': (a) => { a.config.max_candidates = 0; },
    'unbounded config': (a) => { a.config.max_candidates = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const artifact = make();
    mutate(artifact);
    assert.notDeepEqual(validateRelationCandidateArtifact(artifact, index), [], name);
  }
  assert.ok(validateRelationCandidateArtifact(make(), index, { expectedSourceIds: ['provisional:B/C8/s1'] }).some((e) => e.includes('unexpected source')));
  assert.ok(validateRelationCandidateArtifact(make(), index, { expectedSourceIds: ['provisional:B/C8/s1', 'provisional:B/C9/s1', 'w1-s1'] }).some((e) => e.includes('missing expected source')));
  assert.equal(validateRelationCandidateArtifact(null).length, 1);
});

test('retrieval settings are validated and recorded', () => {
  const index = buildRelationIndex(synthetic);
  const source = [{ kind: 'canonical', sense_id: 'w3-s1' }];
  for (const bad of [Infinity, -1, 0, 1.5, '5', NaN, 100000]) {
    assert.throws(() => retrieveRelationCandidates(index, source, { config: { max_candidates: bad } }), /max_candidates/u);
  }
  assert.throws(() => retrieveRelationCandidates(index, source, { config: { max_literature_digests: 0 } }), /max_literature_digests/u);
  assert.throws(() => retrieveRelationCandidates(index, source, { config: { min_gloss_cosine: 2 } }), /min_gloss_cosine/u);
  assert.throws(() => buildRelationIndex(synthetic, { stop_bigram_df_ratio: 0 }), /stop_bigram_df_ratio/u);
  assert.throws(() => retrieveRelationCandidates(index, source, { config: { unknown: 1 } }), /unknown retrieval setting/u);
  const out = retrieveRelationCandidates(index, source, { config: { max_literature_digests: 1, max_candidates: 3 } });
  assert.equal(out.config.max_literature_digests, 1);
  assert.equal(out.config.max_candidates, 3);
  assert.deepEqual(validateRelationCandidateArtifact(out, index), []);
});

test('provisional identities are batch-scoped', () => {
  const index = buildRelationIndex(synthetic);
  const prov = (batch_id, candidate_id, lemma, extra = {}) => ({ kind: 'provisional', batch_id, candidate_id, sense_key: 's1', lemma, pos: 'noun', gloss: '아무 소리도 없이 잠잠한 상태.', ...extra });
  assert.throws(() => retrieveRelationCandidates(index, [prov(undefined, 'C1', '잠잠')]), /non-empty batch_id/u);
  assert.throws(() => retrieveRelationCandidates(index, [prov('', 'C1', '잠잠')]), /non-empty batch_id/u);
  assert.throws(() => retrieveRelationCandidates(index, [prov('B/1', 'C1', '잠잠')]), /non-empty batch_id/u);
  assert.throws(() => retrieveRelationCandidates(index, [prov('B1', 'C1', '잠잠', { hints: [{ lemma: '동의' }] }), prov('B2', 'C2', '동의')]), /single batch/u);
  const ok = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w4-s1' }, prov('B1', 'C1', '잠잠'), prov('B1', 'C2', '정적')]);
  assert.deepEqual(validateRelationCandidateArtifact(ok, index), []);
  const forged = structuredClone(ok);
  forged.sources[1].candidates[0].target = { kind: 'provisional', provisional_id: 'provisional:B2/C2/s1', candidate_id: 'C2', pos: 'noun' };
  forged.sources.push({ ...structuredClone(forged.sources[2]), source: { kind: 'provisional', provisional_id: 'provisional:B2/C2/s1', candidate_id: 'C2', pos: 'noun' } });
  assert.ok(validateRelationCandidateArtifact(forged, index).some((e) => e.includes('more than one batch')));
  const unbatched = structuredClone(ok);
  unbatched.sources[1].source.provisional_id = 'provisional:/C1/s1';
  assert.ok(validateRelationCandidateArtifact(unbatched, index).length > 0);
});

test('provisional pos must be a supported part of speech', () => {
  const index = buildRelationIndex(synthetic);
  const prov = (pos) => ({ kind: 'provisional', batch_id: 'B', candidate_id: 'C1', sense_key: 's1', lemma: '잠잠', pos, gloss: '아무 소리도 없이 잠잠한 상태.' });
  for (const bad of [42, 'gerund', '', undefined, null]) assert.throws(() => retrieveRelationCandidates(index, [prov(bad)]), /supported pos/u);
  const ok = retrieveRelationCandidates(index, [prov('noun'), { ...prov('noun'), candidate_id: 'C2', lemma: '정적' }]);
  assert.deepEqual(validateRelationCandidateArtifact(ok, index), []);
  for (const bad of [42, 'gerund']) {
    const forged = structuredClone(ok);
    for (const entry of forged.sources) {
      if (entry.source.kind === 'provisional') entry.source.pos = bad;
      for (const c of entry.candidates) if (c.target.kind === 'provisional') c.target.pos = bad;
    }
    assert.notDeepEqual(validateRelationCandidateArtifact(forged, index), [], String(bad));
  }
  const canonical = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w3-s1' }]);
  canonical.sources[0].source.pos = 'gerund';
  assert.notDeepEqual(validateRelationCandidateArtifact(canonical), []);
});

test('index-time settings cannot be overridden at retrieval time', () => {
  const index = buildRelationIndex(synthetic, { stop_bigram_df_ratio: 0.5 });
  const source = [{ kind: 'canonical', sense_id: 'w3-s1' }];
  assert.throws(() => retrieveRelationCandidates(index, source, { config: { stop_bigram_df_ratio: 0.0001 } }), /fixed when the index is built/u);
  const out = retrieveRelationCandidates(index, source, { config: { stop_bigram_df_ratio: 0.5 } });
  assert.equal(out.config.stop_bigram_df_ratio, 0.5);
  assert.deepEqual(validateRelationCandidateArtifact(out, index), []);
  out.config.stop_bigram_df_ratio = 0.0001;
  assert.ok(validateRelationCandidateArtifact(out, index).some((e) => e.includes('index build setting')));
  assert.ok(validateRelationCandidateArtifact(out, buildRelationIndex(synthetic, { stop_bigram_df_ratio: 0.0001 })).length === 0);
});

test('index settings are immutable after the index is built', () => {
  const index = buildRelationIndex(synthetic, { stop_bigram_df_ratio: 0.5 });
  assert.throws(() => { index.settings.stop_bigram_df_ratio = 0.0001; }, TypeError);
  assert.throws(() => { index.settings = {}; }, TypeError);
  assert.throws(() => { index.canonical_snapshot_digest = 'f'.repeat(64); }, TypeError);
  assert.equal(index.settings.stop_bigram_df_ratio, 0.5);
});

test('literature hits always keep at least one location digest', () => {
  const index = buildRelationIndex(synthetic);
  const lit = { 'w5-s1': [{ location_digest: 'd'.repeat(64), text: '깊은 고요 속' }] };
  const out = retrieveRelationCandidates(index, [{ kind: 'canonical', sense_id: 'w5-s1' }], { literature: lit });
  const hit = out.sources[0].candidates.find((c) => c.signals.includes('literature_cooccurrence'));
  assert.ok(hit.literature_location_digests.length >= 1);
  hit.literature_location_digests = [];
  assert.ok(validateRelationCandidateArtifact(out, index).length > 0);
  delete hit.literature_location_digests;
  assert.ok(validateRelationCandidateArtifact(out, index).length > 0);
});

test('revision-less digest covers lemma, pos, search forms and relations', () => {
  const make = (mutate) => {
    const records = structuredClone(synthetic.records);
    mutate(records);
    return buildRelationIndex({ records });
  };
  const base = make(() => {});
  assert.equal(base.canonical_snapshot_digest, make(() => {}).canonical_snapshot_digest);
  const variants = [
    (r) => { r[3].lemma = '정적'; },
    (r) => { r[3].senses[0].pos = 'adjective'; },
    (r) => { r[3].search_forms = ['고요', '고요함']; },
    (r) => { r[3].senses[0].relations = [{ target: 'w2', target_sense: 'w2-s1', type: 'near', note: 'n', relevance: 1 }]; },
  ];
  const artifact = retrieveRelationCandidates(base, [{ kind: 'canonical', sense_id: 'w3-s1' }]);
  for (const mutate of variants) {
    const changed = make(mutate);
    assert.notEqual(changed.canonical_snapshot_digest, base.canonical_snapshot_digest);
    assert.ok(validateRelationCandidateArtifact(artifact, changed).some((e) => e.includes('differs')));
  }
});

test('real canonical replay: deterministic, bounded cost, no mutation, no relations created', async () => {
  const context = await loadCanonicalContext();
  const canonical = { canonicalRevision: context.canonicalRevision, records: context.records };
  const before = JSON.stringify(canonical.records.length);
  const t0 = performance.now();
  const index = buildRelationIndex(canonical);
  const buildMs = performance.now() - t0;
  const withRelations = index.senses.filter((s) => s.relations.length > 0).slice(0, 40);
  const sample = withRelations.map((s) => ({ kind: 'canonical', sense_id: s.sense_id, pos: s.pos, gloss: s.gloss }));
  assert.ok(sample.length > 0);
  const t1 = performance.now();
  const first = retrieveRelationCandidates(index, sample);
  const perSourceMs = (performance.now() - t1) / sample.length;
  const second = retrieveRelationCandidates(buildRelationIndex(canonical), sample);
  assert.deepEqual(first, second);
  assert.deepEqual(validateRelationCandidateArtifact(first, index), []);
  assert.equal(JSON.stringify(canonical.records.length), before);
  for (const result of first.sources) {
    assert.ok(result.candidates.length <= 200);
    const own = index.bySenseId.get(result.source.sense_id);
    const existing = new Set(own.relations.map((r) => r.target_sense));
    assert.ok(result.candidates.every((c) => !existing.has(c.target.sense_id) && c.target.sense_id !== own.sense_id));
  }
  const text = '그는 깊은 고요 속에서 오래된 소리의 울림과 서늘한 감각을 떠올렸다. '.repeat(18);
  const literature = Object.fromEntries(sample.map((s) => [s.sense_id, Array.from({ length: 8 }, (_, i) => ({ location_digest: String(i).repeat(64).slice(0, 64), text }))]));
  const t2 = performance.now();
  const withLit = retrieveRelationCandidates(index, sample, { literature });
  const litPerSourceMs = (performance.now() - t2) / sample.length;
  assert.deepEqual(validateRelationCandidateArtifact(withLit, index), []);
  assert.ok(litPerSourceMs < 1000, `literature per-source ${litPerSourceMs}ms`);
  assert.ok(buildMs < 10_000, `index build ${buildMs}ms`);
  assert.ok(perSourceMs < 500, `per-source ${perSourceMs}ms`);
  console.log(`# replay: ${index.senses.length} senses, build ${Math.round(buildMs)}ms, ${perSourceMs.toFixed(1)}ms/source, median pool ${[...first.sources.map((s) => s.candidates_total)].sort((a, b) => a - b)[Math.floor(sample.length / 2)]}`);
});

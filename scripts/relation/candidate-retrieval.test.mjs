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
  assert.ok(buildMs < 10_000, `index build ${buildMs}ms`);
  assert.ok(perSourceMs < 500, `per-source ${perSourceMs}ms`);
  console.log(`# replay: ${index.senses.length} senses, build ${Math.round(buildMs)}ms, ${perSourceMs.toFixed(1)}ms/source, median pool ${[...first.sources.map((s) => s.candidates_total)].sort((a, b) => a - b)[Math.floor(sample.length / 2)]}`);
});

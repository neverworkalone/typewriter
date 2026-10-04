import assert from 'node:assert/strict';

import { createKiwiProvider } from '../../scripts/factory/analyzer-providers.mjs';
import { assertPinnedKhaiii, createKhaiiiAnalyzer, createKhaiiiProvider, pinnedMetadata } from '../../scripts/factory/khaiii-provider.mjs';
import { produceCandidateBatch } from '../../scripts/factory/stage1.mjs';
import { analysisInputDigest } from '../../scripts/intake/pipeline.mjs';

// Shared synthetic fixtures and the real-runtime smoke body for the Khaiii provider tests.
export const HEX = 'a'.repeat(64);
export const KIWI_METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3, proposal_contract: 'derivation-root-v1' };
export const item = (lemma, pos, form = lemma.replace(/다$/u, '')) => ({ lemma, pos, form });

// Synthetic table → service-shaped result. Records the surfaces each provider was asked about.
export function stub(table, metadata) {
  const calls = [];
  return { calls, analyze: async (requests) => {
    calls.push(requests.map((request) => request.text));
    return { metadata, results: requests.map(({ id, text }) => {
      const entry = table[text];
      if (typeof entry === 'function') return entry(id, text);
      return { id, input_digest: analysisInputDigest(text), reason: '', ...(entry ? { status: 'ok', analyses: entry } : { status: 'unsupported', analyses: [] }) };
    }) };
  } };
}
export const kiwi = (table) => { const inner = stub(table, KIWI_METADATA); return { ...createKiwiProvider({ analyze: inner.analyze }), calls: inner.calls }; };
export const khaiii = (table, runtime = 'native') => { const inner = stub(table, pinnedMetadata(runtime)); return { ...createKhaiiiProvider({ analyze: inner.analyze, runtime }), calls: inner.calls }; };

export const hit = (document, surface) => ({ source_path: 'c/x', corpus_id: 'c', document_id: document, document_ordinal: 1, paragraph_id: 'p1',
  paragraph_ordinal: 1, source_category: 'written', source_year: 2025, matched_surface_form: surface });
export const cand = (lemma, pos, surface, document = 'd1') => ({ proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [{ surface }], evidence: { representative_hits: [hit(document, surface)] } });
export const produce = (candidates, providers) => produceCandidateBatch({
  evidence: { contract_version: 'm9-corpus-candidate-evidence-v1', index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
    extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' }, candidates },
  providers, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000001', taskId: 'T000001',
});
export const rowOf = (result, lemma) => result.rows.find((row) => row.input === lemma);
export const unresolvedOf = (result) => result.manifest.unresolved_observations.map((entry) => [entry.surface, entry.holds]);
export const FILLER = cand('걸음', 'noun', '걸음', 'dz');
export const fillerTable = { 걸음: [[item('걸음', 'noun')]] };
export const holdsOf = (result, lemma) => [...new Set(rowOf(result, lemma).observations.flatMap((observation) => observation.holds))].sort();


// Real pinned runtime smoke; the caller decides whether the runtime exists (skip) and passes its options.
export async function realSmoke(runtime, options) {
  const analyze = createKhaiiiAnalyzer({ runtime, ...options });
  const surfaces = ['먹었다', '아름다웠던', '망각했다', '행복한', '조용히', '서울에', 'ㅁㅁㅁ', '두 단어', '   '];
  const { metadata, results } = await analyze(surfaces.map((text) => ({ id: text, text })));
  assertPinnedKhaiii(metadata, runtime);
  assert.equal(metadata.runtime, runtime);
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const lemmas = (id) => byId[id].analyses[0].map((entry) => `${entry.lemma}/${entry.pos}`);
  assert.deepEqual(lemmas('먹었다'), ['먹다/verb']);
  assert.deepEqual(lemmas('아름다웠던'), ['아름답다/adjective']);
  assert.deepEqual(lemmas('망각했다'), ['망각하다/verb']);
  assert.deepEqual(lemmas('행복한'), ['행복하다/adjective']);
  assert.deepEqual(lemmas('조용히'), ['조용히/adverb']);
  assert.equal(byId['먹었다'].analyses.length, 1, 'best path only');
  for (const id of ['서울에', 'ㅁㅁㅁ', '두 단어', '   ']) assert.equal(byId[id].status, 'unsupported', id);
  assert.ok(results.every((result) => result.analyses.flat().every((entry) => !('derived_from' in entry) && !('derived_from_index' in entry))));
  // End to end through the shared policy: Khaiii alone never clears; invalid/missing input stays held.
  const result = await produce([FILLER, cand('먹다', 'verb', '먹었다')], [kiwi(fillerTable), createKhaiiiProvider({ analyze, runtime })]);
  assert.equal(rowOf(result, '먹다'), undefined);
  assert.deepEqual(unresolvedOf(result), [['먹었다', ['analysis_unsupported']]]);
  return results;
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CANDIDATE_LIMIT,
  buildTextFreeCandidateEvidence,
  excludedLemmasForArtifact,
  parseArguments,
} from './run-corpus-lemma-pilot.mjs';

test('corpus production defaults to 200 and supports bounded batches through 500', () => {
  assert.equal(DEFAULT_CANDIDATE_LIMIT, 200);
  assert.equal(parseArguments([]).candidateLimit, 200);
  assert.equal(parseArguments(['--candidate-limit', '200']).candidateLimit, 200);
  assert.equal(parseArguments(['--candidate-limit', '500']).candidateLimit, 500);
  assert.throws(() => parseArguments(['--candidate-limit', '501']), /1 to 500/u);
});

test('text-free candidate evidence keeps morphology and bounded provenance without paragraph text', () => {
  const inventory = {
    publication_state: 'local_reference_only_pending_owner_publication_confirmation',
    permission_record_sha256: 'a'.repeat(64),
    index: { input_manifest_sha256: 'b'.repeat(64), logical_rows_sha256: 'c'.repeat(64) },
    typewriter_surface: { canonical_revision: 'revision' },
    extractor: { name: 'Kiwi', kiwipiepy_version: '0.24.0' },
    selection: { candidate_limit: 1, exclusion_source_artifacts: [] },
    yield: { selected_count: 0 },
    evidence_collection: { per_candidate_paragraph_limit: 3 },
    orchestration: {
      batch_id: 'm9-c-test',
      requested_candidate_limit: 1,
      exclusion_manifest_sha256: 'd'.repeat(64),
      node_version: 'v24.19.0',
      node_sqlite_version: '3.53.3',
      orchestrator_script_sha256: 'e'.repeat(64),
      canonical_build: { record_count: 1 },
      candidate_selection_sha256: 'f'.repeat(64),
      python_extractor_summary: { candidate_selection_path: '/local/path' },
    },
    candidates: [{
      proposed_lemma: '바라다',
      proposed_pos: 'verb',
      analyzer_pos: 'VV',
      kiwi_morpheme_occurrences_in_sample: 4,
      oov_morpheme_occurrences_in_sample: 0,
      paragraph_hits_in_sample: 3,
      distinct_documents_in_sample: 2,
      distinct_sources_in_sample: 2,
      max_source_morpheme_occurrences_in_sample: 3,
      source_concentration_ratio_in_sample: 0.75,
      pos_interpretation_count_in_sample: 1,
      ambiguous_observed_surface_count_in_sample: 0,
      ambiguity_status: 'single_observed_analysis_unverified',
      analyzer_confidence: 'not_calibrated',
      coverage_status: 'uncovered',
      typewriter_surface_matches: [],
      observed_surface_forms: [{ surface: '바라며', kiwi_morpheme_occurrences_in_sample: 2 }],
      observed_morpheme_spans: [{ surface: '바라', interpretation_count_in_sample: 1 }],
      coverage_normalized_key: '바라다',
      evidence: {
        evidence_type: 'literal_text_match_count_and_bounded_paragraph_hits',
        literal_match_query: '바라며',
        literal_match_count: 20,
        count_method: 'COUNT(*)',
        search_mode: 'fts5-trigram-literal-confirmed',
        representative_hits_limit: 3,
        representative_hits: [{
          source_path: 'source.json',
          corpus_id: 'corpus-1',
          document_id: 'document-1',
          document_ordinal: 1,
          paragraph_id: 'paragraph-1',
          paragraph_ordinal: 2,
          source_category: 'literature',
          source_year: '2025',
          context: 'RAW CORPUS CONTENT',
        }],
      },
    }],
    created_at_utc: 'volatile timestamp',
  };

  const safe = buildTextFreeCandidateEvidence(inventory);
  const serialized = JSON.stringify(safe);
  assert.equal(safe.candidates[0].observed_morpheme_spans[0].surface, '바라');
  assert.equal(safe.candidates[0].evidence.representative_hit_count, 1);
  assert.deepEqual(safe.candidates[0].evidence.representative_hits[0], {
    source_path: 'source.json',
    corpus_id: 'corpus-1',
    document_id: 'document-1',
    document_ordinal: 1,
    paragraph_id: 'paragraph-1',
    paragraph_ordinal: 2,
    source_category: 'literature',
    source_year: '2025',
  });
  assert.equal(serialized.includes('RAW CORPUS CONTENT'), false);
  assert.equal(serialized.includes('candidate_selection_path'), false);
  assert.equal(serialized.includes('created_at_utc'), false);
});

test('reviewed corpus decisions and target seed rows can exclude earlier lemma ownership', () => {
  assert.deepEqual(excludedLemmasForArtifact({
    contract_version: 'm9-corpus-candidate-review-v1',
    decisions: [
      { morphology_proposal: { lemma: '바라다' } },
      { morphology_proposal: { lemma: '흐르다' } },
    ],
  }, 'review.json'), ['바라다', '흐르다']);
  assert.deepEqual(excludedLemmasForArtifact({
    targets: [{ lemma: '바라다' }, { lemma: '지내다' }],
  }, 'seed.json'), ['바라다', '지내다']);
  assert.throws(() => excludedLemmasForArtifact({ targets: [{ status: 'held' }] }, 'bad-seed.json'), /trimmed NFC lemmas/u);
});

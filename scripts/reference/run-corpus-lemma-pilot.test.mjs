import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CANDIDATE_LIMIT,
  buildExclusionManifest,
  buildTextFreeCandidateEvidence,
  collectRepresentativeSurfaceHits,
  excludedLemmasForArtifact,
  parseArguments,
  resolveExclusionSourcePath,
} from './run-corpus-lemma-pilot.mjs';
import { observationsFromCorpusEvidence } from '../factory/stage1.mjs';
import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

test('corpus production defaults to 200 and supports bounded batches through 500', () => {
  assert.equal(DEFAULT_CANDIDATE_LIMIT, 200);
  assert.equal(parseArguments([]).candidateLimit, 200);
  assert.equal(parseArguments(['--candidate-limit', '200']).candidateLimit, 200);
  assert.equal(parseArguments(['--candidate-limit', '500']).candidateLimit, 500);
  assert.throws(() => parseArguments(['--candidate-limit', '501']), /1 to 500/u);
});

test('cached morphology reuse stays in the shared cache and uses a separate run output', () => {
  const options = parseArguments([
    '--reuse-analysis-from', 'data/reference/production/issue-223/source',
    '--output-directory', 'data/reference/production/issue-223/next',
  ]);
  const runs = resolveTypewriterCachePaths().runs;
  assert.equal(options.reuseAnalysisFrom, `${runs}/issue-223/source`);
  assert.equal(options.outputDirectory, `${runs}/issue-223/next`);
  assert.throws(() => parseArguments([
    '--reuse-analysis-from', 'data/reference/production/issue-223/source',
    '--output-directory', 'data/reference/production/issue-223/source',
  ]), /must differ/u);
  assert.throws(() => parseArguments([
    '--reuse-analysis-from', '../../outside-cache',
  ]), /must be inside/u);
  assert.equal(parseArguments([]).outputDirectory, `${runs}/issue-201-pilot`);
});

test('shared-cache exclusion inputs preserve source bindings and union prior proposals and candidates', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'typewriter-cache-exclusions-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repositoryDirectory = path.join(temporaryRoot, 'repository');
  const cachePaths = resolveTypewriterCachePaths({
    env: { TYPEWRITER_CACHE_ROOT: path.join(temporaryRoot, 'cache') },
    homeDirectory: temporaryRoot,
  });
  const options = { repositoryDirectory, cachePaths };
  const selectionPath = path.join(cachePaths.runs, 'prior', 'candidate-selection.json');
  const candidateJsonlPath = path.join(repositoryDirectory, 'data/candidates/C000030/candidates.jsonl');
  const priorManifestPath = path.join(cachePaths.runs, 'prior', 'reviewed-lemma-exclusions.json');
  const evidencePath = path.join(cachePaths.evidence, 'batch', 'decisions.json');
  await mkdir(path.dirname(selectionPath), { recursive: true });
  await mkdir(path.dirname(candidateJsonlPath), { recursive: true });
  await mkdir(path.dirname(evidencePath), { recursive: true });
  const selection = {
    selection: { contract_version: 'm9-corpus-candidate-selection-v1' },
    candidates: [
      { proposed_lemma: '강물', proposed_pos: 'noun', coverage_normalized_key: '강물' },
      { proposed_lemma: '나무', proposed_pos: 'noun', coverage_normalized_key: '나무' },
      { proposed_lemma: '강물', proposed_pos: 'noun', coverage_normalized_key: '강물' },
    ],
  };
  await writeFile(selectionPath, JSON.stringify(selection));
  await writeFile(candidateJsonlPath, `${JSON.stringify({ input: '나무' })}\n${JSON.stringify({ input: '바람' })}\n`);
  const decisions = { candidate_records: [{ lemma: '별빛' }] };
  await writeFile(evidencePath, JSON.stringify(decisions));

  const priorManifest = await buildExclusionManifest([selectionPath], options);
  await writeFile(priorManifestPath, JSON.stringify(priorManifest));
  const args = parseArguments([
    '--exclude-lemma-source', 'runs/prior/candidate-selection.json',
    '--exclude-lemma-source', 'data/candidates/C000030/candidates.jsonl',
    '--exclude-lemma-source', priorManifestPath,
    '--exclude-lemma-source', 'evidence/batch/decisions.json',
  ], options);
  const manifest = await buildExclusionManifest(args.exclusionLemmaSources, options);

  assert.deepEqual(manifest.lemmas, ['강물', '나무', '바람', '별빛']);
  assert.deepEqual(manifest.source_artifacts.map((source) => source.path), [
    'data/candidates/C000030/candidates.jsonl',
    'evidence/batch/decisions.json',
    'runs/prior/candidate-selection.json',
    'runs/prior/reviewed-lemma-exclusions.json',
  ]);
  const sourcesByPath = Object.fromEntries(manifest.source_artifacts.map((source) => [source.path, source.sha256]));
  assert.equal(sourcesByPath['data/candidates/C000030/candidates.jsonl'], createHash('sha256').update(await readFile(candidateJsonlPath)).digest('hex'));
  assert.equal(sourcesByPath['runs/prior/candidate-selection.json'], createHash('sha256').update(await readFile(selectionPath)).digest('hex'));
  assert.equal(sourcesByPath['evidence/batch/decisions.json'], createHash('sha256').update(await readFile(evidencePath)).digest('hex'));
  const payload = {
    lemmas: manifest.lemmas,
    schema_version: manifest.schema_version,
    source_artifacts: manifest.source_artifacts,
  };
  assert.equal(manifest.exclusion_sha256, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));

  const tamperedManifestPath = path.join(cachePaths.runs, 'prior', 'tampered-exclusions.json');
  await writeFile(tamperedManifestPath, JSON.stringify({ ...priorManifest, lemmas: [...priorManifest.lemmas, '변조'] }));
  await assert.rejects(buildExclusionManifest([tamperedManifestPath], options), /digest does not match/u);

  const unboundPayload = { ...priorManifest, source_artifacts: [] };
  const unboundDigestPayload = {
    lemmas: unboundPayload.lemmas,
    schema_version: unboundPayload.schema_version,
    source_artifacts: unboundPayload.source_artifacts,
  };
  unboundPayload.exclusion_sha256 = createHash('sha256').update(JSON.stringify(unboundDigestPayload)).digest('hex');
  const unboundManifestPath = path.join(cachePaths.runs, 'prior', 'unbound-exclusions.json');
  await writeFile(unboundManifestPath, JSON.stringify(unboundPayload));
  await assert.rejects(buildExclusionManifest([unboundManifestPath], options), /must bind at least one source artifact/u);

  const malformedSelectionPath = path.join(cachePaths.runs, 'prior', 'malformed-candidate-selection.json');
  await writeFile(malformedSelectionPath, JSON.stringify({
    selection: { contract_version: 'm9-corpus-candidate-selection-v1' },
    candidates: [{ proposed_lemma: '올바른', proposed_pos: 'noun' }, { lemma: '잘못된' }],
  }));
  await assert.rejects(buildExclusionManifest([malformedSelectionPath], options), /trimmed NFC lemmas/u);
  assert.throws(() => resolveExclusionSourcePath('runs/../outside.json', options), /traversal segments/u);

  const outsidePath = path.join(temporaryRoot, 'outside.json');
  const cacheEscapePath = path.join(cachePaths.runs, 'escape.json');
  const repositoryEscapePath = path.join(repositoryDirectory, 'data/candidates/C000030/escape.json');
  await writeFile(outsidePath, JSON.stringify({ candidate_records: [{ lemma: '밖' }] }));
  await symlink(outsidePath, cacheEscapePath);
  await symlink(outsidePath, repositoryEscapePath);
  assert.throws(() => resolveExclusionSourcePath('runs/escape.json', options), /resolves outside/u);
  assert.throws(() => resolveExclusionSourcePath('data/candidates/C000030/escape.json', options), /resolves outside/u);
});

test('text-free candidate evidence keeps morphology and bounded provenance without paragraph text', () => {
  const inventory = {
    publication_state: 'local_reference_only_pending_owner_publication_confirmation',
    permission_record_sha256: 'a'.repeat(64),
    index: { input_manifest_sha256: 'b'.repeat(64), logical_rows_sha256: 'c'.repeat(64) },
    typewriter_surface: { canonical_revision: 'revision' },
    extractor: { name: 'Kiwi', kiwipiepy_version: '0.24.0' },
    selection: { candidate_limit: 1, exclusion_source_artifacts: [] },
    analysis_cache: {
      mode: 'reused-candidate-analysis',
      database_sha256: 'a'.repeat(64),
    },
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
  assert.equal(safe.analysis_cache.mode, 'reused-candidate-analysis');
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

test('representative evidence uses exact analyzed eojeol forms and rejects substring contexts', () => {
  const candidate = {
    observed_morpheme_spans: [{ surface: '간부' }],
    observed_surface_forms: [
      { surface: '간부', kiwi_morpheme_occurrences_in_sample: 100 },
      { surface: '간부들이', kiwi_morpheme_occurrences_in_sample: 80 },
      { surface: '간부가', kiwi_morpheme_occurrences_in_sample: 50 },
    ],
  };
  const calls = [];
  const { hits, omittedUnsupportedSurfaceFormCount } = collectRepresentativeSurfaceHits(candidate, (query, limit) => {
    calls.push({ query, limit });
    const forms = {
      '간부들이': [
        { paragraph_id: 'substring', form: '뜻밖의 순간부터 이야기가 달라졌다.' },
        { paragraph_id: 'partial-token', form: '새 간부들이란 표현을 썼다.' },
        { paragraph_id: 'hit-1', form: '학생회 간부들이 협의했다.' },
      ],
      '간부가': [{ paragraph_id: 'hit-2', form: '회의 간부가 준비를 마쳤다.' }],
      간부: [
        { paragraph_id: 'substring-2', form: '뜻밖의 순간부터 이야기가 달라졌다.' },
        { paragraph_id: 'partial-token-2', form: '새 간부들이란 표현을 썼다.' },
        { paragraph_id: 'hit-3', form: '회의 간부 역시 답했다.' },
      ],
    };
    return (forms[query] ?? []).map((hit) => ({
      source_path: 'source.json',
      corpus_id: 'corpus-1',
      document_id: 'document-1',
      document_ordinal: 0,
      paragraph_id: hit.paragraph_id,
      paragraph_ordinal: 0,
      category: 'literature',
      year: '2025',
      ...hit,
    }));
  });

  assert.deepEqual(calls, [
    { query: '간부', limit: 100 },
    { query: '간부가', limit: 100 },
    { query: '간부들이', limit: 100 },
  ]);
  assert.deepEqual(hits.map(({ paragraph_id }) => paragraph_id), ['hit-3', 'hit-2', 'hit-1']);
  assert.deepEqual(hits.map(({ matched_surface_form }) => matched_surface_form), [
    '간부',
    '간부가',
    '간부들이',
  ]);
  assert.deepEqual(hits.map(({ matched_morpheme_span_surface }) => matched_morpheme_span_surface), [
    '간부',
    '간부',
    '간부',
  ]);
  assert.equal(omittedUnsupportedSurfaceFormCount, 0);
});

test('representative evidence rejects analyzed morphemes at the end of a larger eojeol', () => {
  const candidate = {
    observed_morpheme_spans: [{ surface: '스키' }],
    observed_surface_forms: [
      { surface: '브론스키는', kiwi_morpheme_occurrences_in_sample: 100 },
      { surface: '스키를', kiwi_morpheme_occurrences_in_sample: 30 },
      { surface: '스키', kiwi_morpheme_occurrences_in_sample: 10 },
    ],
  };
  const calls = [];
  const { hits, omittedUnsupportedSurfaceFormCount } = collectRepresentativeSurfaceHits(candidate, (query, limit) => {
    calls.push({ query, limit });
    const forms = {
      스키: [
        { paragraph_id: 'surname', form: '브론스키는 귀족이었다.' },
        { paragraph_id: 'ski', form: '스키 종목을 좋아한다.' },
      ],
      스키를: [{ paragraph_id: 'ski-particle', form: '스키를 배우기 시작했다.' }],
    };
    return (forms[query] ?? []).map((hit) => ({
      source_path: 'source.json',
      corpus_id: 'corpus-1',
      document_id: hit.paragraph_id,
      document_ordinal: 0,
      paragraph_ordinal: 0,
      category: 'literature',
      year: '2025',
      ...hit,
    }));
  });

  assert.deepEqual(calls, [
    { query: '스키', limit: 100 },
    { query: '스키를', limit: 100 },
  ]);
  assert.deepEqual(hits.map(({ paragraph_id }) => paragraph_id), ['ski', 'ski-particle']);
  assert.ok(hits.every(({ matched_morpheme_span_surface }) => matched_morpheme_span_surface === '스키'));
  assert.equal(omittedUnsupportedSurfaceFormCount, 0);
});

test('unsupported symbol and Mark corpus surface forms are omitted before Stage 1 evidence and counted', () => {
  const candidate = {
    proposed_lemma: '야옹',
    observed_morpheme_spans: [{ surface: '야옹' }],
    observed_surface_forms: [
      { surface: '야옹~', kiwi_morpheme_occurrences_in_sample: 20 },
      { surface: '야옹', kiwi_morpheme_occurrences_in_sample: 4 },
    ],
  };
  const calls = [];
  const result = collectRepresentativeSurfaceHits(candidate, (query, limit) => {
    calls.push({ query, limit });
    return query === '야옹' ? [{
      source_path: 'source.json',
      corpus_id: 'corpus-1',
      document_id: 'document-1',
      document_ordinal: 0,
      paragraph_id: 'valid-hit',
      paragraph_ordinal: 0,
      category: 'literature',
      year: '2025',
      form: '야옹 소리가 들렸다.',
    }] : [];
  });
  assert.deepEqual(calls, [{ query: '야옹', limit: 100 }]);
  assert.deepEqual(result.hits.map(({ matched_surface_form }) => matched_surface_form), ['야옹']);
  assert.equal(result.omittedUnsupportedSurfaceFormCount, 1);

  const keycapForm = `문구점1${String.fromCodePoint(0xfe0f, 0x20e3)}`;
  const combiningMarkForm = `문구점${String.fromCodePoint(0x0301)}`;
  const unsupportedForms = [keycapForm, combiningMarkForm, '문구점>'];
  const unsupportedOnly = collectRepresentativeSurfaceHits({
    ...candidate,
    proposed_lemma: '문구점',
    observed_morpheme_spans: [{ surface: '문구점' }],
    observed_surface_forms: unsupportedForms.map((surface) => ({
      surface,
      kiwi_morpheme_occurrences_in_sample: 2,
    })),
  }, () => {
    throw new Error('unsupported symbol/Mark forms must not reach corpus lookup');
  });
  assert.deepEqual(unsupportedOnly.hits, []);
  assert.equal(unsupportedOnly.omittedUnsupportedSurfaceFormCount, 3);

  const inventory = {
    publication_state: 'local_reference_only_pending_owner_publication_confirmation',
    permission_record_sha256: 'a'.repeat(64),
    index: { input_manifest_sha256: 'b'.repeat(64), logical_rows_sha256: 'c'.repeat(64) },
    typewriter_surface: {},
    extractor: {
      extractor_version: '2',
      kiwipiepy_version: '0.24.0',
      kiwipiepy_model_version: '0.24.0',
    },
    selection: {},
    yield: {},
    analysis_cache: {},
    evidence_collection: {
      omitted_unsupported_surface_form_count: unsupportedOnly.omittedUnsupportedSurfaceFormCount,
    },
    orchestration: {
      batch_id: 'stage1-surface-test',
      requested_candidate_limit: 1,
      exclusion_manifest_sha256: 'd'.repeat(64),
      node_version: 'v24.19.0',
      node_sqlite_version: '3.53.3',
      orchestrator_script_sha256: 'e'.repeat(64),
      canonical_build: {},
      candidate_selection_sha256: 'f'.repeat(64),
    },
    candidates: [{
      proposed_lemma: '문구점',
      proposed_pos: 'noun',
      observed_surface_forms: [{ surface: keycapForm }],
      observed_morpheme_spans: [{ surface: '문구점' }],
      evidence: {
        evidence_type: 'candidate_morpheme_rooted_eojeol_contexts_and_literal_text_match_count',
        literal_match_query: keycapForm,
        literal_match_count: 1,
        count_method: 'countCorpusMatches SQL COUNT(*) aggregate',
        search_mode: 'literal-scan',
        representative_hits_limit: 3,
        representative_hits: unsupportedOnly.hits,
      },
    }],
  };
  const textFreeEvidence = buildTextFreeCandidateEvidence(inventory);
  assert.equal(textFreeEvidence.evidence_collection.omitted_unsupported_surface_form_count, 3);
  const stage1 = observationsFromCorpusEvidence(textFreeEvidence);
  assert.deepEqual(stage1.observations, [{
    hint: { input: '문구점', pos: 'noun' },
    holds: ['no_evidence'],
    surface: '문구점',
    ref: { kind: 'corpus-surface', ref: '문구점' },
  }]);

  for (const surface of ['문구점 을', `문구점${String.fromCharCode(7)}`, '가'.repeat(25)]) {
    const malformedInventory = structuredClone(inventory);
    malformedInventory.candidates[0].observed_surface_forms = [{ surface: '문구점' }];
    malformedInventory.candidates[0].evidence.representative_hits = [{
      source_path: 'source.json',
      corpus_id: 'corpus-1',
      document_id: 'document-1',
      document_ordinal: 0,
      paragraph_id: 'malformed-hit',
      paragraph_ordinal: 0,
      source_category: 'literature',
      source_year: '2025',
      matched_surface_form: surface,
      matched_morpheme_span_surface: '문구점',
    }];
    const malformedEvidence = buildTextFreeCandidateEvidence(malformedInventory);
    assert.throws(() => observationsFromCorpusEvidence(malformedEvidence), /single bounded word form/);
  }
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

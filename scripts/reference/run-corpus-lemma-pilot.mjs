import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import { isSurfaceToken } from '../factory/lemma-contract.mjs';
import { assertWithinDirectory, isWithinDirectory, resolveCacheArtifactPath, resolveTypewriterCachePaths } from '../typewriter-cache.mjs';
import { resolveManagedPython } from '../python/env.mjs';
import {
  assertCorpusPermission,
  createCorpusIndexReader,
  DEFAULT_INDEX_PATH,
  REPOSITORY_DIRECTORY,
} from './corpus-index.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_EXTRACTOR_PATH = path.join(SCRIPT_DIRECTORY, 'corpus_lemma_pilot.py');
const PYTHON_CACHED_SELECTOR_PATH = path.join(SCRIPT_DIRECTORY, 'select-corpus-candidates-from-analysis.py');
const CACHE_PATHS = resolveTypewriterCachePaths();
const DEFAULT_PILOT_DIRECTORY = path.join(CACHE_PATHS.runs, 'issue-201-pilot');
const ROW_RESULT_LIMIT = 3;
const OBSERVED_SURFACE_SEARCH_LIMIT = 100;
const MAX_OBSERVED_SURFACE_QUERIES = 5;
export const DEFAULT_CANDIDATE_LIMIT = 200;
export const MAX_CANDIDATE_LIMIT = 500;

export function parseArguments(argumentsList, { repositoryDirectory = REPOSITORY_DIRECTORY, cachePaths = CACHE_PATHS } = {}) {
  const options = {
    python: process.env.TYPEWRITER_PYTHON || null,
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
    outputDirectory: null,
    reuseAnalysisFrom: null,
    exclusionLemmaSources: [],
    includeCanonicalLemmas: false,
    batchId: 'issue-201-pilot',
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--python') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--python requires an executable path.');
      }
      options.python = value;
      index += 1;
      continue;
    }
    if (argument === '--candidate-limit') {
      const value = Number(argumentsList[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CANDIDATE_LIMIT) {
        throw new Error(`--candidate-limit must be an integer from 1 to ${MAX_CANDIDATE_LIMIT}.`);
      }
      options.candidateLimit = value;
      index += 1;
      continue;
    }
    if (argument === '--output-directory') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--output-directory requires a path.');
      options.outputDirectory = value;
      index += 1;
      continue;
    }
    if (argument === '--reuse-analysis-from') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--reuse-analysis-from requires a prior shared-cache run directory.');
      }
      options.reuseAnalysisFrom = value;
      index += 1;
      continue;
    }
    if (argument === '--include-canonical-lemmas') {
      options.includeCanonicalLemmas = true;
      continue;
    }
    if (argument === '--exclude-decision-source' || argument === '--exclude-lemma-source') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a repository or shared-cache decision or candidate artifact path.`);
      }
      options.exclusionLemmaSources.push(resolveExclusionSourcePath(value, { repositoryDirectory, cachePaths }));
      index += 1;
      continue;
    }
    if (argument === '--batch-id') {
      const value = argumentsList[index + 1];
      if (!value || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
        throw new Error('--batch-id must be lowercase hyphenated and at most 64 characters.');
      }
      options.batchId = value;
      index += 1;
      continue;
    }
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    throw new Error('Unknown argument: ' + argument);
  }
  options.outputDirectory = options.outputDirectory
    ? resolveCacheArtifactPath(options.outputDirectory, { paths: cachePaths, areas: ['runs'], label: '--output-directory' })
    : path.join(cachePaths.runs, options.batchId);
  assertWithinDirectory(cachePaths.runs, options.outputDirectory, { label: 'Corpus candidate output directory' });
  if (options.reuseAnalysisFrom) {
    options.reuseAnalysisFrom = resolveCacheArtifactPath(options.reuseAnalysisFrom, {
      paths: cachePaths,
      areas: ['runs'],
      label: '--reuse-analysis-from',
    });
    if (options.reuseAnalysisFrom === options.outputDirectory) {
      throw new Error('Cached candidate analysis source and output directories must differ.');
    }
  }
  return options;
}

function hashFileContents(value) {
  return createHash('sha256').update(value).digest('hex');
}

function expandHomeDirectory(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (value.startsWith('~')) throw new Error('Exclusion source path has an unsupported home-directory prefix.');
  return value;
}

export function resolveExclusionSourcePath(value, {
  repositoryDirectory = REPOSITORY_DIRECTORY,
  cachePaths = CACHE_PATHS,
} = {}) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Exclusion source path must be non-empty.');
  if (value.split(/[\\/]+/u).includes('..')) {
    throw new Error('Exclusion source path must not contain traversal segments.');
  }
  const expanded = expandHomeDirectory(value);
  const normalized = expanded.replaceAll('\\', '/');
  const cacheRelative = normalized.startsWith('runs/')
    || normalized.startsWith('evidence/')
    || normalized.startsWith('data/reference/');

  if (cacheRelative || (path.isAbsolute(expanded) && isWithinDirectory(cachePaths.root, expanded))) {
    return resolveCacheArtifactPath(expanded, {
      paths: cachePaths,
      areas: ['runs', 'evidence'],
      label: 'Exclusion source',
    });
  }

  const sourcePath = path.resolve(repositoryDirectory, expanded);
  if (!isWithinDirectory(repositoryDirectory, sourcePath) || sourcePath === path.resolve(repositoryDirectory)) {
    throw new Error('Exclusion source must be inside the repository or the shared runs/evidence cache.');
  }
  return assertWithinDirectory(repositoryDirectory, sourcePath, { label: 'Exclusion source' });
}

function relativeExclusionSourcePath(sourcePath, { repositoryDirectory, cachePaths }) {
  if (isWithinDirectory(cachePaths.root, sourcePath)) {
    return path.relative(cachePaths.root, sourcePath).split(path.sep).join('/');
  }
  const relativePath = path.relative(repositoryDirectory, sourcePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Exclusion source must be inside the repository or the shared runs/evidence cache.');
  }
  return relativePath.split(path.sep).join('/');
}

function verifiedExclusionManifestLemmas(artifact, relativePath) {
  const { schema_version: schema, lemmas, source_artifacts: sources, exclusion_sha256: digest } = artifact;
  if (schema !== 'm9-reviewed-lemma-exclusions-v1' || !Array.isArray(lemmas) || !Array.isArray(sources)) {
    throw new Error(`Unsupported or incomplete prior exclusion manifest: ${relativePath}`);
  }
  if (lemmas.length === 0 || lemmas.some((lemma) => (
    typeof lemma !== 'string'
    || lemma.length === 0
    || lemma !== lemma.trim()
    || lemma.normalize('NFC') !== lemma
  ))) {
    throw new Error(`Prior exclusion manifest must contain trimmed NFC lemmas: ${relativePath}`);
  }
  if (sources.length === 0) {
    throw new Error(`Prior exclusion manifest with lemmas must bind at least one source artifact: ${relativePath}`);
  }
  const sortedLemmas = [...new Set(lemmas)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sortedLemmas.length !== lemmas.length || sortedLemmas.some((lemma, index) => lemma !== lemmas[index])) {
    throw new Error(`Prior exclusion manifest lemmas must be unique and deterministically sorted: ${relativePath}`);
  }
  if (sources.some((source) => !source || typeof source.path !== 'string' || !source.path
    || !/^[0-9a-f]{64}$/u.test(String(source.sha256 ?? '')))) {
    throw new Error(`Prior exclusion manifest sources must bind paths and SHA-256 digests: ${relativePath}`);
  }
  const payload = { lemmas, schema_version: schema, source_artifacts: sources };
  if (digest !== hashFileContents(JSON.stringify(payload))) {
    throw new Error(`Prior exclusion manifest digest does not match its contents: ${relativePath}`);
  }
  return lemmas;
}

export function excludedLemmasForArtifact(artifact, relativePath) {
  let sourceLemmas;
  if ((artifact.contract_version === 'issue-204-pilot-review-v1'
    || artifact.contract_version === 'm9-corpus-candidate-review-v1')
    && Array.isArray(artifact.decisions)) {
    sourceLemmas = artifact.decisions.map((row) => row?.morphology_proposal?.lemma);
  } else if (Array.isArray(artifact.candidate_records)) {
    sourceLemmas = artifact.candidate_records.map((row) => row?.lemma);
  } else if (Array.isArray(artifact.targets)) {
    sourceLemmas = artifact.targets.map((row) => row?.lemma);
  } else if (artifact.selection?.contract_version === 'm9-corpus-candidate-selection-v1'
    && Array.isArray(artifact.candidates)) {
    sourceLemmas = artifact.candidates.map((row) => row?.lemma);
  } else if (artifact.schema_version === 'm9-reviewed-lemma-exclusions-v1') {
    sourceLemmas = verifiedExclusionManifestLemmas(artifact, relativePath);
  } else {
    throw new Error(`Unsupported exclusion decision contract: ${relativePath}`);
  }
  if (sourceLemmas.length === 0 || sourceLemmas.some((lemma) => (
    typeof lemma !== 'string'
    || lemma.length === 0
    || lemma !== lemma.trim()
    || lemma.normalize('NFC') !== lemma
  ))) {
    throw new Error(`Exclusion decisions must contain reviewed trimmed NFC lemmas: ${relativePath}`);
  }
  return sourceLemmas;
}

export async function buildExclusionManifest(sourcePaths, {
  repositoryDirectory = REPOSITORY_DIRECTORY,
  cachePaths = CACHE_PATHS,
} = {}) {
  const sourceArtifacts = [];
  const lemmas = new Set();
  for (const sourcePath of sourcePaths) {
    const relativePath = relativeExclusionSourcePath(sourcePath, { repositoryDirectory, cachePaths });
    const sourceBytes = await readFile(sourcePath);
    let artifact;
    if (path.basename(relativePath) === 'candidates.jsonl') {
      try {
        const rows = sourceBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        artifact = { candidate_records: rows.map((row) => ({ lemma: row?.input })) };
      } catch (error) {
        throw new Error(`Could not parse candidate JSONL exclusion source ${relativePath}: ${error.message}`);
      }
    } else {
      try {
        artifact = JSON.parse(sourceBytes.toString('utf8'));
      } catch (error) {
        throw new Error(`Could not parse exclusion source ${relativePath}: ${error.message}`);
      }
    }
    const sourceLemmas = excludedLemmasForArtifact(artifact, relativePath);
    for (const lemma of sourceLemmas) lemmas.add(lemma);
    sourceArtifacts.push({
      path: relativePath.split(path.sep).join('/'),
      sha256: hashFileContents(sourceBytes),
    });
  }
  sourceArtifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const payload = {
    lemmas: [...lemmas].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    schema_version: 'm9-reviewed-lemma-exclusions-v1',
    source_artifacts: sourceArtifacts,
  };
  return {
    ...payload,
    exclusion_sha256: hashFileContents(Buffer.from(JSON.stringify(payload), 'utf8')),
  };
}

function runPythonExtractor({
  python,
  dictionaryPath,
  stagingDatabasePath,
  candidateSelectionPath,
  candidateLimit,
  exclusionManifestPath,
  includeCanonicalLemmas,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        PYTHON_EXTRACTOR_PATH,
        '--dictionary', dictionaryPath,
        '--staging-db', stagingDatabasePath,
        '--candidate-json', candidateSelectionPath,
        '--candidate-limit', String(candidateLimit),
        '--exclusion-manifest', exclusionManifestPath,
        ...(includeCanonicalLemmas ? ['--include-canonical-lemmas'] : []),
      ],
      {
        cwd: REPOSITORY_DIRECTORY,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let outputTooLarge = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 100_000) outputTooLarge = true;
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Local lemma candidate extraction failed with exit code ' + code + '.'));
        return;
      }
      if (outputTooLarge) {
        reject(new Error('Local lemma candidate extractor wrote unexpected large standard output.'));
        return;
      }
      try {
        const finalLine = stdout.trim().split(/\r?\n/u).at(-1);
        resolve(JSON.parse(finalLine));
      } catch (error) {
        reject(new Error('Could not read the local candidate extraction summary: ' + error.message));
      }
    });
  });
}

function runPythonCachedSelector({
  python,
  analysisDirectory,
  dictionaryPath,
  stagingDatabasePath,
  candidateSelectionPath,
  candidateLimit,
  exclusionManifestPath,
  includeCanonicalLemmas,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        PYTHON_CACHED_SELECTOR_PATH,
        '--analysis-db', path.join(analysisDirectory, 'candidate-analysis.sqlite'),
        '--analysis-selection', path.join(analysisDirectory, 'candidate-selection.json'),
        '--dictionary', dictionaryPath,
        '--index', DEFAULT_INDEX_PATH,
        '--staging-db', stagingDatabasePath,
        '--candidate-json', candidateSelectionPath,
        '--candidate-limit', String(candidateLimit),
        '--exclusion-manifest', exclusionManifestPath,
        ...(includeCanonicalLemmas ? ['--include-canonical-lemmas'] : []),
      ],
      {
        cwd: REPOSITORY_DIRECTORY,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let outputTooLarge = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 100_000) outputTooLarge = true;
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Cached local lemma candidate selection failed with exit code ' + code + '.'));
        return;
      }
      if (outputTooLarge) {
        reject(new Error('Cached candidate selector wrote unexpected large standard output.'));
        return;
      }
      try {
        const finalLine = stdout.trim().split(/\r?\n/u).at(-1);
        resolve(JSON.parse(finalLine));
      } catch (error) {
        reject(new Error('Could not read the cached candidate selection summary: ' + error.message));
      }
    });
  });
}

async function sha256Path(filePath) {
  return hashFileContents(await readFile(filePath));
}

export async function recordAnalysisCache({ selection, stagingDatabasePath, mode }) {
  const extractorScriptSha256 = await sha256Path(PYTHON_EXTRACTOR_PATH);
  if (mode === 'full-corpus-scan') {
    selection.analysis_cache = {
      mode,
      database_path: path.relative(CACHE_PATHS.root, stagingDatabasePath).split(path.sep).join('/'),
      database_sha256: await sha256Path(stagingDatabasePath),
      analysis_elapsed_seconds: selection.elapsed_seconds,
      extractor_script_sha256: extractorScriptSha256,
    };
  } else {
    const cache = selection.analysis_cache;
    if (!cache || cache.mode !== 'reused-candidate-analysis') {
      throw new Error('Cached candidate selector did not return reuse provenance.');
    }
    selection.analysis_cache = {
      ...cache,
      database_path: path.relative(CACHE_PATHS.root, stagingDatabasePath).split(path.sep).join('/'),
      database_sha256: await sha256Path(stagingDatabasePath),
      extractor_script_sha256: extractorScriptSha256,
    };
  }
  await writeFile(
    path.join(path.dirname(stagingDatabasePath), 'candidate-selection.json'),
    JSON.stringify(selection, null, 2) + '\n',
    'utf8',
  );
  return selection.analysis_cache;
}

function searchModeFor(query) {
  return [...query].length >= 3 ? 'fts5-trigram-literal-confirmed' : 'literal-scan';
}

function evidenceHit(hit, matchedSurfaceForm) {
  return {
    source_path: hit.source_path,
    corpus_id: hit.corpus_id,
    document_id: hit.document_id,
    document_ordinal: hit.document_ordinal,
    paragraph_id: hit.paragraph_id,
    paragraph_ordinal: hit.paragraph_ordinal,
    source_category: hit.category,
    source_year: hit.year,
    matched_surface_form: matchedSurfaceForm,
    matched_morpheme_span_surface: hit.matched_morpheme_span_surface,
    context: hit.form,
  };
}

function safeEvidenceHit(hit) {
  return {
    source_path: hit.source_path,
    corpus_id: hit.corpus_id,
    document_id: hit.document_id,
    document_ordinal: hit.document_ordinal,
    paragraph_id: hit.paragraph_id,
    paragraph_ordinal: hit.paragraph_ordinal,
    source_category: hit.source_category,
    source_year: hit.source_year,
    ...(typeof hit.matched_surface_form === 'string'
      ? { matched_surface_form: hit.matched_surface_form }
      : {}),
    ...(typeof hit.matched_morpheme_span_surface === 'string'
      ? { matched_morpheme_span_surface: hit.matched_morpheme_span_surface }
      : {}),
  };
}

function stripEdgePunctuation(token) {
  return token.replace(/^\p{P}+|\p{P}+$/gu, '');
}

function contextHasExactObservedSurface(context, surface) {
  return context.split(/\s+/u).some((token) => stripEdgePunctuation(token) === surface);
}

export function collectRepresentativeSurfaceHits(candidate, search) {
  if (typeof search !== 'function') {
    throw new Error('A bounded corpus search function is required for observed-surface evidence.');
  }
  const roots = [...new Set((candidate.observed_morpheme_spans ?? [])
    .map(({ surface }) => surface)
    .filter((surface) => typeof surface === 'string' && surface.trim() !== ''))];
  const surfaceRoot = (surface) => roots
    .filter((root) => surface.startsWith(root))
    .sort((left, right) => [...right].length - [...left].length
      || (left < right ? -1 : left > right ? 1 : 0))[0];
  const omittedUnsupportedSurfaceForms = new Set();
  const surfaces = [...(candidate.observed_surface_forms ?? [])]
    .filter(({ surface }) => typeof surface === 'string' && surface.trim() !== '')
    .map((form) => ({ ...form, matched_morpheme_span_surface: surfaceRoot(form.surface) }))
    .filter(({ matched_morpheme_span_surface }) => matched_morpheme_span_surface !== undefined)
    .filter(({ surface }) => {
      const boundedEojeol = [...surface].length <= 24 && !/[\s\p{C}]/u.test(surface);
      if (!isSurfaceToken(surface) && boundedEojeol && /[\p{S}\p{M}]/u.test(surface)) {
        omittedUnsupportedSurfaceForms.add(surface);
        return false;
      }
      return true;
    })
    .sort((left, right) => (
      ([...left.surface].length - [...left.matched_morpheme_span_surface].length)
        - ([...right.surface].length - [...right.matched_morpheme_span_surface].length)
      || [...right.matched_morpheme_span_surface].length - [...left.matched_morpheme_span_surface].length
      || (right.kiwi_morpheme_occurrences_in_sample ?? 0)
        - (left.kiwi_morpheme_occurrences_in_sample ?? 0)
      || (left.surface < right.surface ? -1 : left.surface > right.surface ? 1 : 0)
    ))
    .slice(0, MAX_OBSERVED_SURFACE_QUERIES);
  const hits = [];
  const seenParagraphIds = new Set();

  for (const { surface, matched_morpheme_span_surface } of surfaces) {
    for (const hit of search(surface, OBSERVED_SURFACE_SEARCH_LIMIT)) {
      if (!contextHasExactObservedSurface(hit.form, surface)
        || !surface.startsWith(matched_morpheme_span_surface)
        || seenParagraphIds.has(hit.paragraph_id)) {
        continue;
      }
      seenParagraphIds.add(hit.paragraph_id);
      hits.push(evidenceHit({ ...hit, matched_morpheme_span_surface }, surface));
      break;
    }
    if (hits.length === ROW_RESULT_LIMIT) {
      return {
        hits,
        omittedUnsupportedSurfaceFormCount: omittedUnsupportedSurfaceForms.size,
      };
    }
  }
  return {
    hits,
    omittedUnsupportedSurfaceFormCount: omittedUnsupportedSurfaceForms.size,
  };
}

export function buildTextFreeCandidateEvidence(inventory) {
  return {
    schema_version: '1',
    contract_version: 'm9-corpus-candidate-evidence-v1',
    publication_state: inventory.publication_state,
    permission_record_sha256: inventory.permission_record_sha256,
    index: structuredClone(inventory.index),
    typewriter_surface: structuredClone(inventory.typewriter_surface),
    extractor: structuredClone(inventory.extractor),
    selection: structuredClone(inventory.selection),
    yield: structuredClone(inventory.yield),
    analysis_cache: structuredClone(inventory.analysis_cache),
    evidence_collection: structuredClone(inventory.evidence_collection),
    orchestration: {
      batch_id: inventory.orchestration.batch_id,
      requested_candidate_limit: inventory.orchestration.requested_candidate_limit,
      exclusion_manifest_sha256: inventory.orchestration.exclusion_manifest_sha256,
      node_version: inventory.orchestration.node_version,
      node_sqlite_version: inventory.orchestration.node_sqlite_version,
      orchestrator_script_sha256: inventory.orchestration.orchestrator_script_sha256,
      canonical_build: structuredClone(inventory.orchestration.canonical_build),
      candidate_selection_sha256: inventory.orchestration.candidate_selection_sha256,
    },
    candidates: inventory.candidates.map((candidate) => ({
      proposed_lemma: candidate.proposed_lemma,
      proposed_pos: candidate.proposed_pos,
      analyzer_pos: candidate.analyzer_pos,
      kiwi_morpheme_occurrences_in_sample: candidate.kiwi_morpheme_occurrences_in_sample,
      oov_morpheme_occurrences_in_sample: candidate.oov_morpheme_occurrences_in_sample,
      paragraph_hits_in_sample: candidate.paragraph_hits_in_sample,
      distinct_documents_in_sample: candidate.distinct_documents_in_sample,
      distinct_sources_in_sample: candidate.distinct_sources_in_sample,
      max_source_morpheme_occurrences_in_sample: candidate.max_source_morpheme_occurrences_in_sample,
      source_concentration_ratio_in_sample: candidate.source_concentration_ratio_in_sample,
      pos_interpretation_count_in_sample: candidate.pos_interpretation_count_in_sample,
      ambiguous_observed_surface_count_in_sample: candidate.ambiguous_observed_surface_count_in_sample,
      ambiguity_status: candidate.ambiguity_status,
      analyzer_confidence: candidate.analyzer_confidence,
      coverage_status: candidate.coverage_status,
      typewriter_surface_matches: structuredClone(candidate.typewriter_surface_matches),
      observed_surface_forms: structuredClone(candidate.observed_surface_forms),
      observed_morpheme_spans: structuredClone(candidate.observed_morpheme_spans),
      coverage_normalized_key: candidate.coverage_normalized_key,
      evidence: {
        evidence_type: candidate.evidence.evidence_type,
        literal_match_query: candidate.evidence.literal_match_query,
        literal_match_count: candidate.evidence.literal_match_count,
        count_method: candidate.evidence.count_method,
        search_mode: candidate.evidence.search_mode,
        ...(candidate.evidence.representative_context_match_method
          ? { representative_context_match_method: candidate.evidence.representative_context_match_method }
          : {}),
        ...(candidate.evidence.representative_surface_search_limit !== undefined
          ? { representative_surface_search_limit: candidate.evidence.representative_surface_search_limit }
          : {}),
        representative_hits_limit: candidate.evidence.representative_hits_limit,
        representative_hit_count: candidate.evidence.representative_hits.length,
        representative_hits: candidate.evidence.representative_hits.map(safeEvidenceHit),
      },
    })),
  };
}

// The batch bound counts distinct lemmas: with `--include-canonical-lemmas` a lemma may carry one
// candidate row per observed POS; otherwise there is exactly one row per lemma.
const distinctLemmaCount = (candidates) => new Set((candidates ?? []).map((candidate) => candidate.coverage_normalized_key)).size;

async function addBoundedCorpusEvidence(selection, candidateLimit) {
  const candidates = selection.candidates;
  if (!Array.isArray(candidates) || distinctLemmaCount(candidates) > candidateLimit) {
    throw new Error('Candidate extraction exceeded its requested bounded candidate limit.');
  }

  const candidatesWithEvidence = [];
  let totalLiteralParagraphMatches = 0;
  let literalFallbackQueryCount = 0;
  let observedSurfaceLiteralFallbackQueryCount = 0;
  let observedSurfaceQueryCount = 0;
  let observedSurfaceParagraphRowsSearched = 0;
  let omittedUnsupportedSurfaceFormCount = 0;
  const corpusReader = createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH });
  const lookupTiming = new Map();
  const timedLookup = (operation, query, run) => {
    const length = [...query].length;
    const bucket = `${operation}:${length >= 3 ? '3+' : length}-char:${searchModeFor(query)}`;
    const startedAt = performance.now();
    const result = run();
    const entry = lookupTiming.get(bucket) ?? { operation, query_length: length >= 3 ? '3+' : length, search_mode: searchModeFor(query), queries: 0, milliseconds: 0 };
    entry.queries += 1;
    entry.milliseconds += performance.now() - startedAt;
    lookupTiming.set(bucket, entry);
    return result;
  };
  try {
    for (const [index, candidate] of candidates.entries()) {
      const literalMatchQuery = candidate.observed_surface_forms?.[0]?.surface;
      if (typeof literalMatchQuery !== 'string' || literalMatchQuery.length === 0) {
        throw new Error('Candidate evidence query is missing for one extracted lemma.');
      }

      const matchCount = timedLookup('count', literalMatchQuery, () => corpusReader.count(literalMatchQuery));
      const representativeEvidence = collectRepresentativeSurfaceHits(
        candidate,
        (surface, limit) => {
          observedSurfaceQueryCount += 1;
          if (searchModeFor(surface) === 'literal-scan') observedSurfaceLiteralFallbackQueryCount += 1;
          const matches = timedLookup('search', surface, () => corpusReader.search(surface, limit));
          observedSurfaceParagraphRowsSearched += matches.length;
          return matches;
        },
      );
      const representativeHits = representativeEvidence.hits;
      omittedUnsupportedSurfaceFormCount += representativeEvidence.omittedUnsupportedSurfaceFormCount;
      const searchMode = searchModeFor(literalMatchQuery);
      if (searchMode === 'literal-scan') literalFallbackQueryCount += 1;
      totalLiteralParagraphMatches += matchCount;
      candidatesWithEvidence.push({
        ...candidate,
        evidence: {
          evidence_type: 'candidate_morpheme_rooted_eojeol_contexts_and_literal_text_match_count',
          literal_match_query: literalMatchQuery,
          literal_match_count: matchCount,
          count_method: 'countCorpusMatches SQL COUNT(*) aggregate',
          search_mode: searchMode,
          representative_context_match_method: 'exact observed eojeol beginning with its analyzed candidate morpheme span',
          representative_surface_search_limit: OBSERVED_SURFACE_SEARCH_LIMIT,
          representative_hits_limit: ROW_RESULT_LIMIT,
          representative_hits: representativeHits,
        },
      });

      if ((index + 1) % 10 === 0) {
        process.stdout.write(
          JSON.stringify({
            evidence_candidates_completed: index + 1,
            evidence_candidates_total: candidates.length,
          }) + '\n',
        );
      }
    }
  } finally {
    corpusReader.close();
  }

  return {
    ...selection,
    evidence_collection: {
      count_path: 'countCorpusMatches SQL aggregate; never fetches matching paragraph rows',
      paragraph_path: 'searchCorpusIndex SQL-bounds observed-surface lookups; only exact whole-eojeol forms are retained',
      per_candidate_paragraph_limit: ROW_RESULT_LIMIT,
      candidate_count_with_evidence: candidatesWithEvidence.length,
      omitted_unsupported_surface_form_count: omittedUnsupportedSurfaceFormCount,
      literal_fallback_query_count: literalFallbackQueryCount,
      observed_surface_literal_fallback_query_count: observedSurfaceLiteralFallbackQueryCount,
      sum_of_per_candidate_literal_paragraph_counts: totalLiteralParagraphMatches,
      sum_note: 'Queries overlap; this is not a distinct corpus paragraph count.',
      representative_context_match_method: 'exact whitespace-delimited observed eojeol surface form from the morphology sample',
      representative_surface_search_limit: OBSERVED_SURFACE_SEARCH_LIMIT,
      maximum_observed_surface_queries_per_candidate: MAX_OBSERVED_SURFACE_QUERIES,
      observed_surface_query_count: observedSurfaceQueryCount,
      lookup_timing_by_path: [...lookupTiming.values()]
        .map((entry) => ({ ...entry, milliseconds: Math.round(entry.milliseconds * 1000) / 1000 }))
        .sort((left, right) => String(left.operation + left.query_length).localeCompare(String(right.operation + right.query_length))),
      lookup_timing_note: 'Wall-clock per lookup path in this discovery run; 2-character counts use the short-count sidecar when it is bound to the index.',
      observed_surface_paragraph_rows_searched: observedSurfaceParagraphRowsSearched,
      maximum_total_paragraph_rows_materialized:
        candidates.length * MAX_OBSERVED_SURFACE_QUERIES * OBSERVED_SURFACE_SEARCH_LIMIT,
    },
    candidates: candidatesWithEvidence,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/reference/run-corpus-lemma-pilot.mjs [--python <venv-python>]\n'
        + 'Runs local/manual bounded candidate production using the shared Typewriter Python environment by default. Options: --candidate-limit 1-500 (default 200), '
        + '--batch-id <id>, --output-directory ~/.cache/typewriter/runs/<run-id>, repeated '
        + '--exclude-lemma-source <repository-json-or-jsonl-or-shared-cache-artifact>, --reuse-analysis-from <prior cache run directory>. '
        + 'Requires the shared full-corpus index '
        + 'and kiwipiepy==0.24.0 installed in the selected Python environment.',
    );
    return;
  }

  await assertCorpusPermission();
  const python = options.python || resolveManagedPython();
  const outputDirectory = options.outputDirectory;
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory);
  const stagingDatabasePath = path.join(outputDirectory, 'candidate-analysis.sqlite');
  const candidateSelectionPath = path.join(outputDirectory, 'candidate-selection.json');
  const inventoryPath = path.join(
    outputDirectory,
    outputDirectory === DEFAULT_PILOT_DIRECTORY ? 'pilot-inventory.json' : 'candidate-inventory.json',
  );
  const textFreeEvidencePath = path.join(outputDirectory, 'candidate-evidence.json');
  const exclusionManifestPath = path.join(outputDirectory, 'reviewed-lemma-exclusions.json');
  const exclusionManifest = await buildExclusionManifest(options.exclusionLemmaSources);
  await writeFile(exclusionManifestPath, JSON.stringify(exclusionManifest, null, 2) + '\n', 'utf8');

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'typewriter-corpus-candidate-dictionary-'),
  );
  const dictionaryPath = path.join(temporaryDirectory, 'dictionary.sqlite');
  try {
    const dictionary = await buildDictionary({
      outputPath: dictionaryPath,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    process.stdout.write(
      JSON.stringify({
        phase: 'canonical_surface_built',
        record_count: dictionary.recordCount,
        search_form_count: dictionary.searchFormCount,
        generated_surface_form_count: dictionary.generatedSurfaceFormCount,
      }) + '\n',
    );

    const extractorSummary = options.reuseAnalysisFrom
      ? await runPythonCachedSelector({
        python,
        analysisDirectory: options.reuseAnalysisFrom,
        dictionaryPath,
        stagingDatabasePath,
        candidateSelectionPath,
        candidateLimit: options.candidateLimit,
        exclusionManifestPath,
        includeCanonicalLemmas: options.includeCanonicalLemmas,
      })
      : await runPythonExtractor({
        python,
        dictionaryPath,
        stagingDatabasePath,
        candidateSelectionPath,
        candidateLimit: options.candidateLimit,
        exclusionManifestPath,
        includeCanonicalLemmas: options.includeCanonicalLemmas,
      });
    const selection = JSON.parse(await readFile(candidateSelectionPath, 'utf8'));
    if (distinctLemmaCount(selection.candidates) > options.candidateLimit
      || selection.selection?.selected_candidate_count !== selection.candidates.length) {
      throw new Error('Candidate extraction exceeded or misreported the requested batch bound.');
    }
    const analysisCache = await recordAnalysisCache({
      selection,
      stagingDatabasePath,
      mode: options.reuseAnalysisFrom ? 'reused-candidate-analysis' : 'full-corpus-scan',
    });
    const selectionBytes = await readFile(candidateSelectionPath);
    const evidenceInventory = await addBoundedCorpusEvidence(selection, options.candidateLimit);
    evidenceInventory.orchestration = {
      batch_id: options.batchId,
      requested_candidate_limit: options.candidateLimit,
      exclusion_manifest_sha256: exclusionManifest.exclusion_sha256,
      node_version: process.version,
      node_sqlite_version: process.versions.sqlite,
      orchestrator_script_sha256: hashFileContents(await readFile(fileURLToPath(import.meta.url))),
      python_extractor_summary: extractorSummary,
      analysis_cache: analysisCache,
      canonical_build: {
        dictionary_version: dictionary.metadata.dictionary_version,
        canonical_revision: dictionary.metadata.canonical_revision,
        record_count: dictionary.recordCount,
        search_form_count: dictionary.searchFormCount,
        generated_surface_form_count: dictionary.generatedSurfaceFormCount,
      },
      candidate_selection_sha256: hashFileContents(selectionBytes),
      publication_state: 'local_reference_only_pending_owner_publication_confirmation',
    };

    const temporaryInventoryPath = inventoryPath + '.tmp';
    await writeFile(
      temporaryInventoryPath,
      JSON.stringify(evidenceInventory, null, 2) + '\n',
      'utf8',
    );
    await rename(temporaryInventoryPath, inventoryPath);

    const textFreeEvidence = buildTextFreeCandidateEvidence(evidenceInventory);
    const textFreeBytes = Buffer.from(JSON.stringify(textFreeEvidence, null, 2) + '\n', 'utf8');
    const temporaryTextFreePath = textFreeEvidencePath + '.tmp';
    await writeFile(temporaryTextFreePath, textFreeBytes);
    await rename(temporaryTextFreePath, textFreeEvidencePath);

    process.stdout.write(
      JSON.stringify({
        phase: 'corpus_candidate_inventory_ready',
        batch_id: options.batchId,
        inventory_path: inventoryPath,
        text_free_candidate_evidence_path: textFreeEvidencePath,
        text_free_candidate_evidence_sha256: hashFileContents(textFreeBytes),
        requested_candidate_limit: options.candidateLimit,
        candidate_inventory_count: selection.candidates.length,
        excluded_candidate_lemma_count: exclusionManifest.lemmas.length,
        exclusion_manifest_sha256: exclusionManifest.exclusion_sha256,
        held_candidates: selection.candidates.filter(
          (candidate) => candidate.decision_state === 'held',
        ).length,
        candidates_with_bounded_evidence: evidenceInventory.evidence_collection.candidate_count_with_evidence,
        literal_fallback_query_count: evidenceInventory.evidence_collection.literal_fallback_query_count,
        sum_of_per_candidate_literal_paragraph_counts: evidenceInventory.evidence_collection.sum_of_per_candidate_literal_paragraph_counts,
        corpus_paragraphs_in_output: evidenceInventory.candidates.reduce(
          (count, candidate) => count + candidate.evidence.representative_hits.length,
          0,
        ),
        publication_state: evidenceInventory.orchestration.publication_state,
      }) + '\n',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? error.code + ': ' + error.message : error.message);
    process.exitCode = 1;
  });
}

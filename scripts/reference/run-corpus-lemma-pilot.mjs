import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import {
  assertCorpusPermission,
  createCorpusIndexReader,
  DEFAULT_INDEX_PATH,
  REPOSITORY_DIRECTORY,
} from './corpus-index.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_EXTRACTOR_PATH = path.join(SCRIPT_DIRECTORY, 'corpus_lemma_pilot.py');
const PYTHON_CACHED_SELECTOR_PATH = path.join(SCRIPT_DIRECTORY, 'select-corpus-candidates-from-analysis.py');
const LOCAL_PILOT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/pilots/issue-201',
);
const REFERENCE_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/reference');
const ROW_RESULT_LIMIT = 3;
export const DEFAULT_CANDIDATE_LIMIT = 200;
export const MAX_CANDIDATE_LIMIT = 500;

export function parseArguments(argumentsList) {
  const options = {
    python: process.env.TYPEWRITER_PYTHON || 'python3',
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
    outputDirectory: LOCAL_PILOT_DIRECTORY,
    reuseAnalysisFrom: null,
    exclusionLemmaSources: [],
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
      options.outputDirectory = path.resolve(REPOSITORY_DIRECTORY, value);
      index += 1;
      continue;
    }
    if (argument === '--reuse-analysis-from') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--reuse-analysis-from requires a prior data/reference output directory.');
      }
      options.reuseAnalysisFrom = path.resolve(REPOSITORY_DIRECTORY, value);
      index += 1;
      continue;
    }
    if (argument === '--exclude-decision-source' || argument === '--exclude-lemma-source') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a tracked decision or candidate artifact path.`);
      }
      options.exclusionLemmaSources.push(path.resolve(REPOSITORY_DIRECTORY, value));
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
  const relativeOutputDirectory = path.relative(REFERENCE_DIRECTORY, options.outputDirectory);
  if (!relativeOutputDirectory
    || relativeOutputDirectory.startsWith('..')
    || path.isAbsolute(relativeOutputDirectory)) {
    throw new Error('Corpus candidate outputs must remain under ignored data/reference/.');
  }
  if (options.reuseAnalysisFrom) {
    const relativeSourceDirectory = path.relative(REFERENCE_DIRECTORY, options.reuseAnalysisFrom);
    if (!relativeSourceDirectory
      || relativeSourceDirectory.startsWith('..')
      || path.isAbsolute(relativeSourceDirectory)) {
      throw new Error('Cached candidate analysis must remain under ignored data/reference/.');
    }
    if (options.reuseAnalysisFrom === options.outputDirectory) {
      throw new Error('Cached candidate analysis source and output directories must differ.');
    }
  }
  return options;
}

function hashFileContents(value) {
  return createHash('sha256').update(value).digest('hex');
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

async function buildExclusionManifest(sourcePaths) {
  const sourceArtifacts = [];
  const lemmas = new Set();
  for (const sourcePath of sourcePaths) {
    const relativePath = path.relative(REPOSITORY_DIRECTORY, sourcePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Exclusion decision sources must be repository files.');
    }
    const sourceBytes = await readFile(sourcePath);
    let artifact;
    try {
      artifact = JSON.parse(sourceBytes.toString('utf8'));
    } catch (error) {
      throw new Error(`Could not parse exclusion source ${relativePath}: ${error.message}`);
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

async function recordAnalysisCache({ selection, stagingDatabasePath, mode }) {
  const extractorScriptSha256 = await sha256Path(PYTHON_EXTRACTOR_PATH);
  if (mode === 'full-corpus-scan') {
    selection.analysis_cache = {
      mode,
      database_path: path.relative(REPOSITORY_DIRECTORY, stagingDatabasePath).split(path.sep).join('/'),
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
      database_path: path.relative(REPOSITORY_DIRECTORY, stagingDatabasePath).split(path.sep).join('/'),
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

function evidenceHit(hit) {
  return {
    source_path: hit.source_path,
    corpus_id: hit.corpus_id,
    document_id: hit.document_id,
    document_ordinal: hit.document_ordinal,
    paragraph_id: hit.paragraph_id,
    paragraph_ordinal: hit.paragraph_ordinal,
    source_category: hit.category,
    source_year: hit.year,
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
        representative_hits_limit: candidate.evidence.representative_hits_limit,
        representative_hit_count: candidate.evidence.representative_hits.length,
        representative_hits: candidate.evidence.representative_hits.map(safeEvidenceHit),
      },
    })),
  };
}

async function addBoundedCorpusEvidence(selection, candidateLimit) {
  const candidates = selection.candidates;
  if (!Array.isArray(candidates) || candidates.length > candidateLimit) {
    throw new Error('Candidate extraction exceeded its requested bounded candidate limit.');
  }

  const candidatesWithEvidence = [];
  let totalLiteralParagraphMatches = 0;
  let literalFallbackQueryCount = 0;
  const corpusReader = createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH });
  try {
    for (const [index, candidate] of candidates.entries()) {
      const literalMatchQuery = candidate.observed_surface_forms?.[0]?.surface;
      if (typeof literalMatchQuery !== 'string' || literalMatchQuery.length === 0) {
        throw new Error('Candidate evidence query is missing for one extracted lemma.');
      }

      const { matchCount, matches } = corpusReader.evidence(literalMatchQuery, ROW_RESULT_LIMIT);
      const searchMode = searchModeFor(literalMatchQuery);
      if (searchMode === 'literal-scan') literalFallbackQueryCount += 1;
      totalLiteralParagraphMatches += matchCount;
      candidatesWithEvidence.push({
        ...candidate,
        evidence: {
          evidence_type: 'literal_text_match_count_and_bounded_paragraph_hits',
          literal_match_query: literalMatchQuery,
          literal_match_count: matchCount,
          count_method: 'countCorpusMatches SQL COUNT(*) aggregate',
          search_mode: searchMode,
          representative_hits_limit: ROW_RESULT_LIMIT,
          representative_hits: matches.map(evidenceHit),
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
      paragraph_path: 'searchCorpusIndex bounded in SQL before rows reach JavaScript',
      per_candidate_paragraph_limit: ROW_RESULT_LIMIT,
      maximum_total_paragraph_rows_materialized: candidates.length * ROW_RESULT_LIMIT,
      candidate_count_with_evidence: candidatesWithEvidence.length,
      literal_fallback_query_count: literalFallbackQueryCount,
      sum_of_per_candidate_literal_paragraph_counts: totalLiteralParagraphMatches,
      sum_note: 'Queries overlap; this is not a distinct corpus paragraph count.',
    },
    candidates: candidatesWithEvidence,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/reference/run-corpus-lemma-pilot.mjs --python <venv-python>\n'
        + 'Runs local/manual bounded candidate production. Options: --candidate-limit 1-500 (default 200), '
        + '--batch-id <id>, --output-directory data/reference/<path>, repeated '
        + '--exclude-lemma-source <tracked-json>, --reuse-analysis-from <prior data/reference output directory>. '
        + 'Requires the ignored full-corpus index '
        + 'and kiwipiepy==0.24.0 installed in the selected Python environment.',
    );
    return;
  }

  await assertCorpusPermission();
  const outputDirectory = options.outputDirectory;
  await mkdir(outputDirectory, { recursive: true });
  const stagingDatabasePath = path.join(outputDirectory, 'candidate-analysis.sqlite');
  const candidateSelectionPath = path.join(outputDirectory, 'candidate-selection.json');
  const inventoryPath = path.join(
    outputDirectory,
    outputDirectory === LOCAL_PILOT_DIRECTORY ? 'pilot-inventory.json' : 'candidate-inventory.json',
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
        python: options.python,
        analysisDirectory: options.reuseAnalysisFrom,
        dictionaryPath,
        stagingDatabasePath,
        candidateSelectionPath,
        candidateLimit: options.candidateLimit,
        exclusionManifestPath,
      })
      : await runPythonExtractor({
        python: options.python,
        dictionaryPath,
        stagingDatabasePath,
        candidateSelectionPath,
        candidateLimit: options.candidateLimit,
        exclusionManifestPath,
      });
    const selection = JSON.parse(await readFile(candidateSelectionPath, 'utf8'));
    if (selection.candidates.length > options.candidateLimit
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

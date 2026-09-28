import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import {
  assertCorpusPermission,
  countCorpusMatches,
  DEFAULT_INDEX_PATH,
  REPOSITORY_DIRECTORY,
  searchCorpusIndex,
} from './corpus-index.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_EXTRACTOR_PATH = path.join(SCRIPT_DIRECTORY, 'corpus_lemma_pilot.py');
const LOCAL_PILOT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/pilots/issue-201',
);
const STAGING_DATABASE_PATH = path.join(
  LOCAL_PILOT_DIRECTORY,
  'candidate-analysis.sqlite',
);
const CANDIDATE_SELECTION_PATH = path.join(
  LOCAL_PILOT_DIRECTORY,
  'candidate-selection.json',
);
const INVENTORY_PATH = path.join(LOCAL_PILOT_DIRECTORY, 'pilot-inventory.json');
const ROW_RESULT_LIMIT = 3;
const EXPECTED_PILOT_SIZE = 100;

function parseArguments(argumentsList) {
  const options = {
    python: process.env.TYPEWRITER_PYTHON || 'python3',
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
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    throw new Error('Unknown argument: ' + argument);
  }
  return options;
}

function hashFileContents(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runPythonExtractor({ python, dictionaryPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        PYTHON_EXTRACTOR_PATH,
        '--dictionary', dictionaryPath,
        '--staging-db', STAGING_DATABASE_PATH,
        '--candidate-json', CANDIDATE_SELECTION_PATH,
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

async function addBoundedCorpusEvidence(selection) {
  const candidates = selection.candidates;
  if (!Array.isArray(candidates) || candidates.length !== EXPECTED_PILOT_SIZE) {
    throw new Error(
      'Candidate extraction must produce exactly ' + EXPECTED_PILOT_SIZE + ' uncovered candidates.',
    );
  }

  const candidatesWithEvidence = [];
  let totalLiteralParagraphMatches = 0;
  let literalFallbackQueryCount = 0;
  for (const [index, candidate] of candidates.entries()) {
    const literalMatchQuery = candidate.observed_surface_forms?.[0]?.surface;
    if (typeof literalMatchQuery !== 'string' || literalMatchQuery.length === 0) {
      throw new Error('Candidate evidence query is missing for one extracted lemma.');
    }

    const matchCount = countCorpusMatches({
      databasePath: DEFAULT_INDEX_PATH,
      query: literalMatchQuery,
    });
    const matches = searchCorpusIndex({
      databasePath: DEFAULT_INDEX_PATH,
      query: literalMatchQuery,
      limit: ROW_RESULT_LIMIT,
    });
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
        + 'Runs the local/manual 100-candidate pilot. Requires the ignored full-corpus index '
        + 'and kiwipiepy==0.24.0 installed in the selected Python environment.',
    );
    return;
  }

  await assertCorpusPermission();
  await mkdir(LOCAL_PILOT_DIRECTORY, { recursive: true });

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'typewriter-issue-201-dictionary-'),
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

    const extractorSummary = await runPythonExtractor({
      python: options.python,
      dictionaryPath,
    });
    const selection = JSON.parse(await readFile(CANDIDATE_SELECTION_PATH, 'utf8'));
    if (selection.candidates.length !== EXPECTED_PILOT_SIZE) {
      throw new Error('The extraction summary and local candidate selection do not match.');
    }
    const selectionBytes = await readFile(CANDIDATE_SELECTION_PATH);
    const evidenceInventory = await addBoundedCorpusEvidence(selection);
    evidenceInventory.orchestration = {
      node_version: process.version,
      node_sqlite_version: process.versions.sqlite,
      orchestrator_script_sha256: hashFileContents(await readFile(fileURLToPath(import.meta.url))),
      python_extractor_summary: extractorSummary,
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

    const temporaryInventoryPath = INVENTORY_PATH + '.tmp';
    await writeFile(
      temporaryInventoryPath,
      JSON.stringify(evidenceInventory, null, 2) + '\n',
      'utf8',
    );
    await rename(temporaryInventoryPath, INVENTORY_PATH);

    process.stdout.write(
      JSON.stringify({
        phase: 'pilot_inventory_ready',
        inventory_path: INVENTORY_PATH,
        candidate_inventory_count: EXPECTED_PILOT_SIZE,
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

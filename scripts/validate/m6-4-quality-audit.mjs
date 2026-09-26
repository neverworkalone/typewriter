import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import { findRecordsBySearchTerm } from '../build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
  RELATION_TYPES,
} from './canonical-jsonl.mjs';
import { createCanonicalContext } from './canonical-context.mjs';
import {
  allocateRelationGapQuotas,
  assertSearchReachabilityPass,
  evaluateSearchReachability,
  makeAmbiguousQuerySamplingUnit,
  makeRelationGapSamplingUnit,
  makeRelationSamplingUnit,
  M6_1_QUALITY_GATES,
  selectBaselineExactMatches,
  selectRelationGapSample,
  selectStableHashSample,
  summarizeWriterFacingCandidatePopulation,
} from './m6-1-quality-baseline.mjs';
import { expandExactSearchCandidates } from '../../src/domain/exact-search-candidates.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const OUTPUT_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/m6-4-quality-audit-sample.json');
const BASELINE_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/m6-1-quality-baseline.json');
const REVIEW_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/m6-3-surface-form-review.json',
);
const RUNTIME_PATHS = [
  'scripts/validate/m6-1-quality-baseline.mjs',
  'scripts/validate/m6-4-quality-audit.mjs',
  'scripts/build/query.mjs',
  'src/runtime/search-query.js',
  'src/domain/exact-search-candidates.js',
  'scripts/inflection/surface-form-projection.mjs',
];
const DEFAULT_MODE = 'check';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function samplingHash(unit) {
  return sha256(Buffer.from(
    `${M6_1_QUALITY_GATES.sampling.stable_seed}\u0000${unit.stratum}\u0000${unit.stable_unit_id}`,
    'utf8',
  ));
}

function unwrapRecords(records) {
  return records.map((recordInfo) => recordInfo.record ?? recordInfo);
}

function relationSampling(records) {
  const rowsByType = new Map(RELATION_TYPES.map((type) => [type, []]));
  for (const source of records) {
    for (const sense of source.senses) {
      for (const relation of sense.relations ?? []) {
        const row = {
          source_record_id: source.id,
          source_sense_id: sense.id,
          target_record_id: relation.target,
          target_sense_id: relation.target_sense ?? null,
          type: relation.type,
        };
        assert.ok(rowsByType.has(relation.type), `unregistered relation type ${relation.type}`);
        const unit = makeRelationSamplingUnit(row);
        rowsByType.get(relation.type).push({ ...row, ...unit });
      }
    }
  }

  return Object.fromEntries([...rowsByType.entries()]
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([type, rows]) => {
      const limit = type === 'direct' ? 60 : 20;
      const selected = selectStableHashSample(rows, { limit });
      const byIdentity = new Map(rows.map((row) => [row.stable_unit_id, row]));
      const cases = selected.map((unit) => ({
        ...byIdentity.get(unit.stable_unit_id),
        selection_hash: samplingHash(unit),
      }));
      return [type, {
        population_count: rows.length,
        selected_count: cases.length,
        census: cases.length === rows.length,
        cases,
      }];
    }));
}

function relationGapSampling(records) {
  const gaps = records.filter(({ role, senses }) => (
    role === 'start' && senses.every((sense) => (sense.relations ?? []).length === 0)
  ));
  const populationByStratum = new Map();
  for (const record of gaps) {
    const unit = makeRelationGapSamplingUnit(record);
    populationByStratum.set(unit.stratum, (populationByStratum.get(unit.stratum) ?? 0) + 1);
  }
  const populationCounts = Object.fromEntries(populationByStratum);
  const quotas = allocateRelationGapQuotas(populationCounts, 80);
  const selectedUnits = selectRelationGapSample(gaps, 80);
  const recordsById = new Map(gaps.map((record) => [record.id, record]));
  const cases = selectedUnits.map((unit) => {
    const record = recordsById.get(unit.record_id);
    assert.ok(record, `selected relation gap ${unit.record_id} is missing`);
    return {
      record_id: record.id,
      record_type: record.record_type,
      first_sense_pos: record.senses[0].pos,
      stratum: unit.stratum,
      selection_hash: samplingHash(unit),
    };
  });
  const strata = Object.entries(populationCounts)
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([stratum, population_count]) => ({
      stratum,
      population_count,
      quota: quotas[stratum],
      selected_count: cases.filter((item) => item.stratum === stratum).length,
    }));

  return {
    population_count: gaps.length,
    selected_count: cases.length,
    allocation: 'm6-1 Hamilton largest-remainder with a minimum quota of 10 per stratum, capped by stratum population',
    strata,
    cases,
  };
}

function buildExactQueryRows(database, records) {
  const starts = records.filter(({ role }) => role === 'start');
  const expectedByKey = new Map();
  for (const record of starts) {
    for (const key of new Set([record.lemma, ...record.search_forms])) {
      const expectedIds = expectedByKey.get(key) ?? new Set();
      expectedIds.add(record.id);
      expectedByKey.set(key, expectedIds);
    }
  }
  const expectedRows = [...expectedByKey.entries()].map(([key, expectedIds]) => ({
    key,
    expected_ids: [...expectedIds].sort(),
  }));
  const actualRows = expectedRows.map(({ key }) => {
    const response = findRecordsBySearchTerm(database, key);
    return {
      key,
      normalized_query: response.normalizedQuery,
      status: response.status,
      matches: selectBaselineExactMatches(response.matches),
    };
  });
  const reachability = evaluateSearchReachability(expectedRows, actualRows);
  assertSearchReachabilityPass(reachability);
  return { actualRows, reachability };
}

function ambiguousQuerySampling(records, actualRows, baselinePopulation) {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const eligible = [];
  for (const row of actualRows) {
    if (row.status !== 'ready') continue;
    const matchedRecords = row.matches.map(({ id }) => {
      const record = recordsById.get(id);
      assert.ok(record, `exact query ${JSON.stringify(row.key)} returned unknown start ${id}`);
      return record;
    });
    const candidates = expandExactSearchCandidates(matchedRecords).map(({ recordId, senseId }) => ({
      record_id: recordId,
      sense_id: senseId,
    }));
    if (candidates.length < 2) continue;
    eligible.push({
      unit: makeAmbiguousQuerySamplingUnit(row.normalized_query, candidates.length),
      candidates,
    });
  }
  assert.equal(eligible.length, baselinePopulation.ambiguous_query_count);
  const selected = selectStableHashSample(eligible.map(({ unit }) => unit), { limit: 40 });
  const eligibleByQuery = new Map(eligible.map((item) => [item.unit.stable_unit_id, item]));
  return {
    population_count: eligible.length,
    selected_count: selected.length,
    candidates_per_query: 'runtime exact-lemma and exact-search-form candidates expanded using canonical sense order',
    cases: selected.map((unit) => ({
      query: unit.stable_unit_id,
      stable_unit_id: unit.stable_unit_id,
      stratum: unit.stratum,
      selection_hash: samplingHash(unit),
      candidates: eligibleByQuery.get(unit.stable_unit_id).candidates,
    })),
  };
}

function writerTaskPlan() {
  const intents = M6_1_QUALITY_GATES.sampling.writer_tasks.task_intents;
  return {
    required_participants: 10,
    required_tasks: 100,
    participant_patterns: [
      {
        pattern: 'A',
        participant_slots: ['P01', 'P02', 'P03', 'P04', 'P05'],
        tasks_per_participant: {
          direct_replacement: 3,
          sense_choice: 2,
          expression_exploration: 2,
          relation_exploration: 2,
          no_data_or_policy_boundary: 1,
        },
      },
      {
        pattern: 'B',
        participant_slots: ['P06', 'P07', 'P08', 'P09', 'P10'],
        tasks_per_participant: {
          direct_replacement: 3,
          sense_choice: 2,
          expression_exploration: 1,
          relation_exploration: 3,
          no_data_or_policy_boundary: 1,
        },
      },
    ],
    expected_intent_counts: intents,
    recruited_participants: 0,
    filled_task_slots: 0,
    completed_outcomes: 0,
    status: 'HOLD: participant results were not supplied; no replacement tasks were invented',
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function currentFileHashes() {
  return Object.fromEntries(await Promise.all(RUNTIME_PATHS.map(async (relativePath) => [
    relativePath,
    sha256(await readFile(path.join(REPOSITORY_DIRECTORY, relativePath))),
  ])));
}

async function buildManifest({ issueStartCommit }) {
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY, {
    useSharedContext: false,
  });
  const baseline = await readJson(BASELINE_PATH);
  assert.equal(canonical.canonicalRevision, baseline.source.canonical_revision,
    'M6-4 keeps the M6-1 issue-start canonical revision fixed');
  assert.equal(canonical.fileCount, baseline.source.canonical_file_count);
  assert.equal(baseline.quality_gates.contract_version, M6_1_QUALITY_GATES.contract_version);
  const records = unwrapRecords(canonical.records);
  const canonicalContext = createCanonicalContext(canonical, {
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
  });
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m6-4-audit-'));
  const databasePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  let database;
  try {
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath: databasePath,
      checkPilotCompleteness: true,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      allowDirty: true,
      canonicalContext,
    });
    database = new DatabaseSync(databasePath, { readOnly: true });
    const { actualRows, reachability } = buildExactQueryRows(database, records);
    const candidatePopulation = summarizeWriterFacingCandidatePopulation(records, actualRows);
    assert.deepStrictEqual(
      candidatePopulation,
      baseline.metrics.search.writer_facing_candidate_population,
      'M6-1 exact candidate population remains frozen after generated-form projection is separated',
    );
    const relations = relationSampling(records);
    const relationGaps = relationGapSampling(records);
    const ambiguousQueries = ambiguousQuerySampling(
      records,
      actualRows,
      baseline.metrics.search.writer_facing_candidate_population,
    );
    const reviewCaseCount = Object.values(relations)
      .reduce((sum, sample) => sum + sample.selected_count, 0)
      + relationGaps.selected_count
      + ambiguousQueries.selected_count;
    const reviewManifestBytes = await readFile(REVIEW_MANIFEST_PATH);
    return {
      schema_version: 1,
      audit_id: 'm6-4-writer-facing-quality-audit-v1',
      issue: 176,
      decision: 'HOLD',
      source: {
        issue_start_commit: issueStartCommit,
        baseline_id: baseline.baseline_id,
        baseline_contract_version: baseline.quality_gates.contract_version,
        canonical_revision: canonical.canonicalRevision,
        canonical_file_count: canonical.fileCount,
        m4_regression_fixture_sha256: baseline.metrics.search.regression_corpus.fixture_sha256,
        m6_3_surface_form_review_sha256: sha256(reviewManifestBytes),
        runtime_file_sha256: await currentFileHashes(),
      },
      frozen_sampling: {
        stable_seed: M6_1_QUALITY_GATES.sampling.stable_seed,
        stable_hash: M6_1_QUALITY_GATES.sampling.stable_hash,
        relation_tuples: relations,
        relation_gaps: relationGaps,
        ambiguous_queries: ambiguousQueries,
        writer_task_plan: writerTaskPlan(),
      },
      review_status: {
        selected_canonical_case_count: reviewCaseCount,
        independent_judgments_required_per_case: 2,
        independent_judgments_recorded: 0,
        adjudication_complete: false,
        writer_task_results_required: 100,
        writer_task_results_recorded: 0,
      },
      deterministic_checks: {
        exact_key_reachability: reachability,
        candidate_population: candidatePopulation,
      },
    };
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseMode(argv) {
  if (argv.length === 0) return DEFAULT_MODE;
  if (argv.length === 1 && ['--check', '--write'].includes(argv[0])) {
    return argv[0].slice(2);
  }
  throw new Error('Usage: node scripts/validate/m6-4-quality-audit.mjs [--check|--write]');
}

async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const existing = await readJson(OUTPUT_PATH).catch((error) => {
    if (mode === 'write' && error.code === 'ENOENT') return undefined;
    throw error;
  });
  const issueStartCommit = existing?.source?.issue_start_commit
    ?? execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: 'utf8',
    }).trim();
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'utf8',
  }).trim();
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', issueStartCommit, currentCommit], {
      cwd: REPOSITORY_DIRECTORY,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('Current HEAD must descend from the M6-4 issue-start commit.');
  }
  const manifest = await buildManifest({ issueStartCommit });
  if (mode === 'write') {
    if (existing) {
      assert.equal(existing.source.canonical_revision, manifest.source.canonical_revision,
        'preserve the M6-4 issue-start sample when later canonical revisions exist');
    }
    await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`Wrote M6-4 sample manifest for ${manifest.source.canonical_revision}.`);
    return;
  }
  assert.deepStrictEqual(existing, manifest,
    'M6-4 sample manifest differs from the fixed M6-1 contract or bound source');
  console.log(
    `M6-4 sample manifest matches ${manifest.source.canonical_revision}: `
    + `${manifest.review_status.selected_canonical_case_count} canonical cases selected; `
    + `${manifest.review_status.independent_judgments_recorded}/`
    + `${manifest.review_status.selected_canonical_case_count * 2} judgments recorded.`,
  );
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

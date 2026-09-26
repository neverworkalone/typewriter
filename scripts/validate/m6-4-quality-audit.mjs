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
  evaluateSearchReachability,
  makeAmbiguousQuerySamplingUnit,
  makeRelationGapSamplingUnit,
  makeRelationSamplingUnit,
  M6_1_QUALITY_GATES,
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
  'scripts/build/query.mjs',
  'src/runtime/search-query.js',
  'src/domain/exact-search-candidates.js',
  'scripts/inflection/surface-form-projection.mjs',
];
const DEFAULT_MODE = 'check';
const FROZEN_SAMPLE_MANIFEST_SHA256 = 'a15aae2cccdd61e4bbe070800614f9e2f0e71d8d541e6002eddaf0d875589dbd';
export const M6_4_FROZEN_SOURCE_IDENTITY = Object.freeze({
  issue_start_commit: '4226a97f162b1f4a7401a74893c3d28018d33385',
  baseline_id: 'm6-1-5k-quality-baseline-v1',
  baseline_contract_version: 'm6-1-quality-gates-v2',
  m6_1_baseline_sha256: '4eb83fd3d19c8ff0b522300430e4107f002850907161f2bdcd97ba3872195209',
  canonical_revision: '8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9',
  canonical_file_count: 13,
  m4_regression_fixture_sha256: 'e2ce9f4ee8812dbb532d4cb78ee725b417f138070ccf013ee78c647c08296598',
  m6_3_surface_form_review_sha256: '380e67ce30af6376906bca75f4c703da565dad59c27e094ec049629e861b5e22',
  runtime_file_sha256: Object.freeze({
    'scripts/validate/m6-1-quality-baseline.mjs': 'c66b1d9c0f9570514bd10fd9db73c9d53ed79b70a53d4ca53d9392c4b0b27eaa',
    'scripts/build/query.mjs': 'fab784bb887e265764f8231e6c7b05240ba2173b591a77f93b2c7663e5fc785b',
    'src/runtime/search-query.js': '66480e70fbc9f636675cb93ebc59163e88792675d55d011c1da5ff141864a655',
    'src/domain/exact-search-candidates.js': '7b9f4563f724cacfe8c14b5fa5553f6d9ef5bae144c605518f157d2e589c77e0',
    'scripts/inflection/surface-form-projection.mjs': 'ac45f89c529b91de01396c2468863ca82ab91738ea803fb4e49ad02808d893ed',
  }),
});

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

export function determineM6QualityAuditVerificationMode({
  currentCanonicalRevision,
  frozenCanonicalRevision,
  currentRuntimeFileSha256,
  frozenRuntimeFileSha256,
  currentBaselineSha256,
  frozenBaselineSha256,
  currentM6_3ReviewSha256,
  frozenM6_3ReviewSha256,
}) {
  const sameRuntime = JSON.stringify(currentRuntimeFileSha256) === JSON.stringify(frozenRuntimeFileSha256);
  return currentCanonicalRevision === frozenCanonicalRevision
    && sameRuntime
    && currentBaselineSha256 === frozenBaselineSha256
    && currentM6_3ReviewSha256 === frozenM6_3ReviewSha256
    ? 'rebuild-current-sample'
    : 'verify-frozen-historical-sample';
}

export function assertM6QualityAuditManifestMatches(committed, recomputed) {
  assert.deepStrictEqual(
    committed,
    recomputed,
    'M6-4 sample manifest differs from its fixed contract or bound source',
  );
}

export function assertM6QualityAuditHistoricalSnapshot({
  manifest,
  manifestBytes,
  expectedManifestSha256 = FROZEN_SAMPLE_MANIFEST_SHA256,
  frozenSourceIdentity = M6_4_FROZEN_SOURCE_IDENTITY,
}) {
  assert.equal(sha256(manifestBytes), expectedManifestSha256,
    'M6-4 historical sample bytes changed from the reviewed issue-start snapshot');
  assert.equal(manifest.audit_id, 'm6-4-writer-facing-quality-audit-v1');
  assert.equal(manifest.issue, 176);
  assert.equal(manifest.decision, 'HOLD');
  assert.deepStrictEqual(manifest.source, frozenSourceIdentity,
    'M6-4 sample source identity differs from its pinned issue-start source');
}

export async function validateFrozenM6QualityAuditSnapshot({
  repositoryDirectory = REPOSITORY_DIRECTORY,
} = {}) {
  const samplePath = path.join(repositoryDirectory, 'docs/m6-4-quality-audit-sample.json');
  const manifestBytes = await readFile(samplePath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertM6QualityAuditHistoricalSnapshot({
    manifest,
    manifestBytes,
  });
  return {
    audit_id: manifest.audit_id,
    canonical_revision: manifest.source.canonical_revision,
    selected_canonical_case_count: manifest.review_status.selected_canonical_case_count,
    decision: manifest.decision,
  };
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
      matches: response.matches.map(({ id, role }) => ({ id, role })),
    };
  });
  const reachability = evaluateSearchReachability(expectedRows, actualRows);
  return { actualRows, reachability };
}

function ambiguousQuerySampling(records, actualRows, candidatePopulation) {
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
  assert.equal(eligible.length, candidatePopulation.ambiguous_query_count);
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

async function buildManifest({ issueStartCommit, canonical, baseline, baselineSha256, runtimeFileSha256 }) {
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
    const relations = relationSampling(records);
    const relationGaps = relationGapSampling(records);
    const ambiguousQueries = ambiguousQuerySampling(
      records,
      actualRows,
      candidatePopulation,
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
        m6_1_baseline_sha256: baselineSha256,
        canonical_revision: canonical.canonicalRevision,
        canonical_file_count: canonical.fileCount,
        m4_regression_fixture_sha256: baseline.metrics.search.regression_corpus.fixture_sha256,
        m6_3_surface_form_review_sha256: sha256(reviewManifestBytes),
        runtime_file_sha256: runtimeFileSha256,
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
  const manifestBytes = await readFile(OUTPUT_PATH).catch((error) => {
    if (mode === 'write' && error.code === 'ENOENT') return undefined;
    throw error;
  });
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
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY, {
    useSharedContext: false,
  });
  const baseline = await readJson(BASELINE_PATH);
  const baselineSha256 = sha256(await readFile(BASELINE_PATH));
  const runtimeFileSha256 = await currentFileHashes();
  const m6_3ReviewSha256 = sha256(await readFile(REVIEW_MANIFEST_PATH));

  if (mode === 'check') {
    const verificationMode = determineM6QualityAuditVerificationMode({
      currentCanonicalRevision: canonical.canonicalRevision,
      frozenCanonicalRevision: existing.source.canonical_revision,
      currentRuntimeFileSha256: runtimeFileSha256,
      frozenRuntimeFileSha256: existing.source.runtime_file_sha256,
      currentBaselineSha256: baselineSha256,
      frozenBaselineSha256: existing.source.m6_1_baseline_sha256,
      currentM6_3ReviewSha256: m6_3ReviewSha256,
      frozenM6_3ReviewSha256: existing.source.m6_3_surface_form_review_sha256,
    });
    if (verificationMode === 'verify-frozen-historical-sample') {
      assertM6QualityAuditHistoricalSnapshot({
        manifest: existing,
        manifestBytes,
      });
      console.log(
        `M6-4 historical sample remains fixed at ${existing.source.canonical_revision}; `
        + `current canonical ${canonical.canonicalRevision} is outside this issue-start audit.`,
      );
      return;
    }
  }

  const manifest = await buildManifest({
    issueStartCommit,
    canonical,
    baseline,
    baselineSha256,
    runtimeFileSha256,
  });
  if (mode === 'write') {
    if (existing) {
      assert.equal(existing.source.canonical_revision, manifest.source.canonical_revision,
        'preserve the M6-4 issue-start sample when later canonical revisions exist');
    }
    await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`Wrote M6-4 sample manifest for ${manifest.source.canonical_revision}.`);
    return;
  }
  assertM6QualityAuditManifestMatches(existing, manifest);
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

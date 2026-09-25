import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import {
  findRecordsBySearchTerm,
} from '../build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import { createCanonicalContext } from './canonical-context.mjs';
import {
  assertValidSearchRegressionCorpus,
  readSearchRegressionCorpus,
} from './search-regressions.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_OUTPUT_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'docs/m6-1-quality-baseline.json',
);
const DEFAULT_REGRESSION_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/search-regressions/m4-baseline.json',
);

export const M6_1_QUALITY_GATES = Object.freeze({
  contract_version: 'm6-1-quality-gates-v1',
  policy: 'Freeze these thresholds before collecting M6 quality evidence. A changed threshold requires a new contract version and must be recorded before the next sample is reviewed.',
  overall_decision: {
    pass: 'Every applicable dimension passes and every required sample is complete.',
    hold: 'Any dimension fails, required evidence is missing, or a reviewer disagreement remains unadjudicated.',
    not_applicable: 'Use only when the current product and the proposed change expose no cases for that dimension. A missing sample is HOLD, not N/A.',
    combine: 'Do not average dimensions or let a strong result in one dimension offset a failure in another.',
  },
  review_protocol: {
    independent_reviewers_per_canonical_case: 2,
    disagreement: 'A designated editorial decision owner adjudicates disagreements before the case is counted.',
    retained_evidence: 'Keep case IDs, structured outcomes, and source digests. Do not commit writer sentences, raw query context, or external source text.',
  },
  sampling: {
    stable_seed: 'm6-1-quality-benchmark-v1',
    hash: 'Sort candidates by SHA-256(seed + NUL + stratum + NUL + stable_unit_id), then take the first allocated rows.',
    relation_direct: {
      unit: 'directed relation tuple',
      sample_size: 'min(60, current direct-tuple count); census when the current count is 60 or less.',
      current_population: 22,
    },
    relation_other_types: {
      unit: 'directed relation tuple, sampled separately for each non-direct relation type',
      per_type_sample_size: 'min(20, current tuple count for that type); census when a type has fewer than 20 tuples.',
      minimum_types_reported: 'Report all eight canonical relation types separately; a type with zero tuples is coverage evidence, not a pass on correctness.',
    },
    relation_gaps: {
      unit: 'start record with no outgoing relation on any sense',
      sample_size: 'min(80, current relation-empty start count)',
      strata: 'record_type × first-sense POS; first sense follows canonical order.',
      allocation: 'Allocate 10 per non-empty stratum or census that stratum when it has fewer than 10. Allocate remaining slots proportionally to each stratum remaining population using largest remainders; break ties by the lexical stratum key.',
    },
    writer_tasks: {
      task_count: 100,
      participants: 10,
      tasks_per_participant: 10,
      task_intents: {
        direct_replacement: 30,
        sense_choice: 20,
        expression_exploration: 15,
        relation_exploration: 25,
        no_data_or_policy_boundary: 10,
      },
      source: 'Writer-authored needs and Typewriter-authored prompts; do not retain the writers’ original sentences in Git.',
    },
    ranking: {
      unit: 'ambiguous query returning at least two start records',
      sample_size: 'min(40, available ambiguous query count)',
      minimum_for_a_ranking_change: 20,
      current_population: 0,
    },
  },
  dimensions: [
    {
      id: 'canonical-integrity',
      baseline_status: 'PASS',
      baseline: 'M5-15 global semantic audit covers every current record and sense with zero open blocking findings.',
      pass: 'All canonical/schema/integrity/semantic-audit checks pass; every changed record and sense is covered; zero blocking findings.',
      threshold: { covered_records: 1, covered_senses: 1, blocking_findings: 0 },
      sample: 'Exhaustive validators and semantic audit.',
    },
    {
      id: 'direct-substitutability',
      baseline_status: 'NOT_MEASURED',
      baseline: 'Current direct relations are counted, but the full 5K direct-relation set has no new independent review result.',
      pass: 'At least 95% of sampled direct tuples are judged substitutable in the recorded sense and direction; zero critical POS or sense-boundary errors.',
      threshold: { accepted_rate: 0.95, critical_errors: 0 },
      sample: 'Stable-hash sample up to 60 directed tuples; current population of 22 is a census.',
    },
    {
      id: 'relation-usefulness-and-type-honesty',
      baseline_status: 'NOT_MEASURED',
      baseline: 'Current relation density and type counts are measured; correctness and usefulness are not inferred from counts.',
      pass: 'For every non-empty relation type, at least 80% of its sample is both writer-useful and correctly typed, sense-bound, and directed; zero critical POS or sense-boundary errors.',
      threshold: { accepted_rate_per_type: 0.8, critical_errors: 0 },
      sample: 'Up to 20 stable-hash directed tuples per non-direct type; report each type separately. Keep direct relations under their stricter gate.',
    },
    {
      id: 'relation-coverage-and-gaps',
      baseline_status: 'MEASURED_NO_DENSITY_GATE',
      baseline: 'Relation-bearing and relation-empty starts are measured separately; no target density is authorized.',
      pass: 'Review every selected gap and disposition it. At least 80% of writer tasks whose stated need is relation exploration reach one relevant result; record remaining high-demand gaps explicitly.',
      threshold: { reviewed_gap_sample: 1, relation_exploration_task_success: 0.8 },
      sample: 'Up to 80 relation-empty starts, stratified by record type and first-sense POS, plus the relation-exploration writer tasks.',
    },
    {
      id: 'search-reachability-and-boundaries',
      baseline_status: 'PASS',
      baseline: 'The current exact runtime and M4 cases are exercised; the baseline also exhaustively checks every current canonical exact key.',
      pass: '100% of start lemmas and curated search forms resolve to their expected start IDs; zero unexpected results, missing results, or reference-only leaks; all non-pending M4 cases retain their expected results and policy boundaries.',
      threshold: { exact_key_reachability: 1, unexpected_results: 0, missing_results: 0, reference_only_leaks: 0 },
      sample: 'Exhaustive unique start keys plus the shared M4 regression corpus. Pending cases remain pending until an explicit policy decision.',
    },
    {
      id: 'ranking-and-order-usefulness',
      baseline_status: 'NOT_APPLICABLE',
      baseline: 'Exact keys currently have no cross-record collisions, so writer usefulness of a multi-result order is not measured.',
      pass: 'For a ranking change, at least 80% of the top results match the adjudicated writer choice across at least 20 ambiguous tasks; preserve deterministic tie-breaking and exact-match tiers.',
      threshold: { writer_preferred_top_result: 0.8, minimum_ambiguous_tasks: 20 },
      sample: 'Stable-hash sample up to 40 ambiguous queries. N/A while no multi-result case is exposed; a ranking change with fewer than 20 cases is HOLD.',
    },
    {
      id: 'writer-task-usefulness',
      baseline_status: 'NOT_MEASURED',
      baseline: 'No current 5K writer-task success rate was measured.',
      pass: 'At least 80 of 100 tasks produce a result the writer says they would use or deliberately adapt; every intent and any POS/record-type slice with at least 10 tasks scores at least 70%; zero critical misleading-result cases.',
      threshold: { overall_success_rate: 0.8, minimum_slice_success_rate: 0.7, critical_misleading_results: 0 },
      sample: '100 tasks from 10 writers, ten tasks each, with the fixed intent counts above.',
    },
  ],
});

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

function relationTupleKey({ sourceRecordId, sourceSenseId, targetRecordId, targetSenseId, type }) {
  return JSON.stringify([sourceRecordId, sourceSenseId, targetRecordId, targetSenseId ?? null, type]);
}

function equalArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function summarizeRegressionCorpus(corpus, corpusSha256) {
  assertValidSearchRegressionCorpus(corpus);
  const baselineCases = corpus.cases.filter(({ evaluation }) => evaluation === 'baseline');
  const pendingCases = corpus.cases.filter(({ evaluation }) => evaluation === 'pending');
  const mismatches = corpus.cases.filter(({ expected, actual }) => (
    expected.status !== actual.status
    || !equalArray(expected.result_ids, actual.result_ids)
    || expected.selected_record_id !== actual.selected_record_id
  ));

  return {
    fixture_id: corpus.corpus_id,
    schema_version: corpus.schema_version,
    fixture_sha256: corpusSha256,
    case_count: corpus.cases.length,
    evaluation_counts: countBy(corpus.cases.map(({ evaluation }) => evaluation)),
    input_class_counts: countBy(corpus.cases.map(({ input_class }) => input_class)),
    problem_counts: countBy(corpus.cases.map(({ problem }) => problem)),
    actual_status_counts: countBy(corpus.cases.map(({ actual }) => actual.status)),
    baseline_case_count: baselineCases.length,
    baseline_cases_matching_recorded_expectations: baselineCases.filter(({ expected, actual }) => (
      expected.status === actual.status
      && equalArray(expected.result_ids, actual.result_ids)
      && expected.selected_record_id === actual.selected_record_id
    )).length,
    pending_case_ids: pendingCases.map(({ id }) => id).sort(),
    expected_actual_mismatch_case_ids: mismatches.map(({ id }) => id).sort(),
    baseline_multi_result_case_count: baselineCases.filter(({ actual }) => actual.result_ids.length > 1).length,
  };
}

export function deriveM6QualityBaselineMetrics({
  records,
  canonicalRevision,
  canonicalFileCount,
  regressionCorpus,
  regressionSha256,
  reachability,
}) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const starts = records.filter(({ role }) => role === 'start');
  const references = records.filter(({ role }) => role === 'reference-only');
  const recordTypeCountsByRole = Object.fromEntries(
    ['start', 'reference-only'].map((role) => [
      role,
      countBy(records.filter((record) => record.role === role).map(({ record_type }) => record_type)),
    ]),
  );

  const startSenseCounts = starts.map(({ senses }) => senses.length);
  const startSenses = starts.flatMap(({ senses }) => senses);
  const recordsByRole = Object.fromEntries(['start', 'reference-only'].map((role) => [
    role,
    records.filter((record) => record.role === role),
  ]));
  const posByRole = Object.fromEntries(Object.entries(recordsByRole).map(([role, roleRecords]) => {
    const senses = roleRecords.flatMap(({ senses: recordSenses }) => recordSenses);
    const posValues = [...new Set(senses.map(({ pos }) => pos))].sort();
    return [role, {
      sense_count: countBy(senses.map(({ pos }) => pos)),
      records_with_pos: Object.fromEntries(posValues.map((pos) => [
        pos,
        roleRecords.filter(({ senses: recordSenses }) => recordSenses.some((sense) => sense.pos === pos)).length,
      ])),
    }];
  }));

  const relationRows = [];
  for (const source of records) {
    for (const sense of source.senses) {
      for (const relation of sense.relations ?? []) {
        const target = byId.get(relation.target);
        if (!target) {
          throw new Error(`Relation from ${sense.id} has missing target record ${relation.target}`);
        }
        relationRows.push({
          source,
          sense,
          relation,
          target,
          key: relationTupleKey({
            sourceRecordId: source.id,
            sourceSenseId: sense.id,
            targetRecordId: relation.target,
            targetSenseId: relation.target_sense,
            type: relation.type,
          }),
        });
      }
    }
  }
  const relationKeys = new Set(relationRows.map(({ key }) => key));
  const tuplesWithMatchingReverse = relationRows.filter(({ source, sense, relation }) => (
    relation.target_sense !== undefined
    && relationKeys.has(relationTupleKey({
      sourceRecordId: relation.target,
      sourceSenseId: relation.target_sense,
      targetRecordId: source.id,
      targetSenseId: sense.id,
      type: relation.type,
    }))
  )).length;
  const relationsByTypeAndTargetRole = {};
  for (const { relation, target } of relationRows) {
    const counts = relationsByTypeAndTargetRole[relation.type] ?? {};
    counts[target.role] = (counts[target.role] ?? 0) + 1;
    relationsByTypeAndTargetRole[relation.type] = counts;
  }

  const startsWithRelations = starts.filter(({ senses }) => (
    senses.some((sense) => (sense.relations ?? []).length > 0)
  ));
  const startsWithoutRelations = starts.filter(({ senses }) => (
    senses.every((sense) => (sense.relations ?? []).length === 0)
  ));

  const allStartKeys = new Map();
  const startSearchFormValues = [];
  const formsByRecord = new Map();
  for (const record of starts) {
    const recordForms = [...record.search_forms];
    formsByRecord.set(record.id, recordForms);
    startSearchFormValues.push(...recordForms);
    for (const value of new Set([record.lemma, ...recordForms])) {
      const ids = allStartKeys.get(value) ?? new Set();
      ids.add(record.id);
      allStartKeys.set(value, ids);
    }
  }
  const searchFormValueOwners = new Map();
  for (const record of starts) {
    for (const value of formsByRecord.get(record.id)) {
      const ids = searchFormValueOwners.get(value) ?? new Set();
      ids.add(record.id);
      searchFormValueOwners.set(value, ids);
    }
  }

  const regressionMetrics = summarizeRegressionCorpus(
    regressionCorpus,
    regressionSha256,
  );

  return {
    canonical: {
      revision: canonicalRevision,
      file_count: canonicalFileCount,
      record_count: records.length,
      start_count: starts.length,
      reference_only_count: references.length,
      total_sense_count: records.reduce((count, { senses }) => count + senses.length, 0),
      record_type_counts_by_role: recordTypeCountsByRole,
      start_sense_count: startSenses.length,
      reference_only_sense_count: references.reduce((count, { senses }) => count + senses.length, 0),
      expression_record_count: records.filter(({ record_type }) => record_type === 'expression').length,
      records_by_sense_count_and_role: Object.fromEntries(Object.entries(recordsByRole).map(([role, roleRecords]) => [
        role,
        countBy(roleRecords.map(({ senses }) => String(senses.length))),
      ])),
      single_sense_record_count_by_role: Object.fromEntries(Object.entries(recordsByRole).map(([role, roleRecords]) => [
        role,
        roleRecords.filter(({ senses }) => senses.length === 1).length,
      ])),
      polysemous_record_count_by_role: Object.fromEntries(Object.entries(recordsByRole).map(([role, roleRecords]) => [
        role,
        roleRecords.filter(({ senses }) => senses.length > 1).length,
      ])),
      maximum_senses_per_start: Math.max(0, ...startSenseCounts),
      pos_by_role: posByRole,
    },
    relations: {
      directed_tuple_count: relationRows.length,
      source_role_counts: countBy(relationRows.map(({ source }) => source.role)),
      target_role_counts: countBy(relationRows.map(({ target }) => target.role)),
      source_to_target_role_counts: countBy(relationRows.map(({ source, target }) => `${source.role}->${target.role}`)),
      directed_tuples_by_type: countBy(relationRows.map(({ relation }) => relation.type)),
      directed_tuples_by_type_and_target_role: Object.fromEntries(
        Object.entries(relationsByTypeAndTargetRole)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([type, counts]) => [type, Object.fromEntries(
            Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          )]),
      ),
      directed_tuples_by_source_pos: countBy(relationRows.map(({ sense }) => sense.pos)),
      tuples_with_matching_reverse_same_type: tuplesWithMatchingReverse,
      start_coverage: {
        relation_bearing_count: startsWithRelations.length,
        relation_empty_count: startsWithoutRelations.length,
        relation_bearing_by_record_type: countBy(startsWithRelations.map(({ record_type }) => record_type)),
        relation_empty_by_record_type: countBy(startsWithoutRelations.map(({ record_type }) => record_type)),
      },
    },
    search: {
      start_search_form_value_count: startSearchFormValues.length,
      distinct_start_search_form_value_count: new Set(startSearchFormValues).size,
      starts_with_lemma_in_search_forms: starts.filter(({ lemma, search_forms: forms }) => forms.includes(lemma)).length,
      starts_with_non_lemma_search_form: starts.filter(({ lemma, search_forms: forms }) => (
        forms.some((form) => form !== lemma)
      )).length,
      non_lemma_search_form_value_count: starts.reduce((count, { lemma, search_forms: forms }) => (
        count + forms.filter((form) => form !== lemma).length
      ), 0),
      cross_record_search_form_collision_group_count: [...searchFormValueOwners.values()]
        .filter((ids) => ids.size > 1).length,
      exact_key_count: allStartKeys.size,
      cross_record_exact_key_collision_group_count: [...allStartKeys.values()]
        .filter((ids) => ids.size > 1).length,
      multi_result_exact_key_count: [...allStartKeys.values()]
        .filter((ids) => ids.size > 1).length,
      exhaustive_runtime_reachability: reachability,
      regression_corpus: regressionMetrics,
    },
  };
}

async function measureRuntimeReachability({ records, canonical, repositoryDirectory }) {
  const expectedByKey = new Map();
  for (const record of records.filter(({ role }) => role === 'start')) {
    for (const key of new Set([record.lemma, ...record.search_forms])) {
      const ids = expectedByKey.get(key) ?? new Set();
      ids.add(record.id);
      expectedByKey.set(key, ids);
    }
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m6-1-search-'));
  const databasePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  let database;
  try {
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath: databasePath,
      checkPilotCompleteness: true,
      repositoryDirectory,
      allowDirty: true,
      canonicalContext: canonical,
    });
    database = new DatabaseSync(databasePath, { readOnly: true });
    const mismatches = [];
    let matchedKeyCount = 0;
    let missingExpectedCount = 0;
    let unexpectedResultCount = 0;
    let referenceOnlyLeakCount = 0;
    let unsupportedKeyCount = 0;

    for (const [key, expectedIdsSet] of expectedByKey.entries()) {
      const expectedIds = [...expectedIdsSet].sort();
      const response = findRecordsBySearchTerm(database, key);
      const actualIds = response.matches.map(({ id }) => id);
      const unexpected = actualIds.filter((id) => !expectedIdsSet.has(id));
      const missing = expectedIds.filter((id) => !actualIds.includes(id));
      const roleLeaks = response.matches.filter(({ role }) => role !== 'start');
      if (response.status === 'ready' && actualIds.length > 0) matchedKeyCount += 1;
      if (response.status === 'unsupported') unsupportedKeyCount += 1;
      missingExpectedCount += missing.length;
      unexpectedResultCount += unexpected.length;
      referenceOnlyLeakCount += roleLeaks.length;

      if (response.status !== 'ready' || !equalArray(actualIds, expectedIds)) {
        mismatches.push({
          key,
          expected_ids: expectedIds,
          actual_ids: actualIds,
          actual_status: response.status,
        });
      }
    }

    return {
      key_count: expectedByKey.size,
      matched_key_count: matchedKeyCount,
      missing_expected_result_count: missingExpectedCount,
      unexpected_result_count: unexpectedResultCount,
      reference_only_leak_count: referenceOnlyLeakCount,
      unsupported_key_count: unsupportedKeyCount,
      mismatched_key_count: mismatches.length,
      mismatched_keys: mismatches.slice(0, 20),
    };
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readBaselineInputs() {
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY, {
    useSharedContext: false,
  });
  const records = canonical.records.map(({ record }) => record);
  const canonicalContext = createCanonicalContext(canonical, {
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
  });
  const regressionBytes = await readFile(DEFAULT_REGRESSION_PATH);
  const regressionCorpus = await readSearchRegressionCorpus(DEFAULT_REGRESSION_PATH);
  const reachability = await measureRuntimeReachability({
    records,
    canonical: canonicalContext,
    repositoryDirectory: REPOSITORY_DIRECTORY,
  });
  const regressionSha256 = createHash('sha256').update(regressionBytes).digest('hex');

  return {
    canonical,
    records,
    regressionCorpus,
    regressionSha256,
    reachability,
  };
}

function parseMode(argv) {
  if (argv.length === 0) return 'check';
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  if (argv.length === 1 && argv[0] === '--write') return 'write';
  throw new Error('Usage: node scripts/validate/m6-1-quality-baseline.mjs [--check|--write]');
}

async function buildSnapshot({ sourceCommit, inputs }) {
  const metrics = deriveM6QualityBaselineMetrics({
    records: inputs.records,
    canonicalRevision: inputs.canonical.canonicalRevision,
    canonicalFileCount: inputs.canonical.fileCount,
    regressionCorpus: inputs.regressionCorpus,
    regressionSha256: inputs.regressionSha256,
    reachability: inputs.reachability,
  });

  return {
    schema_version: 1,
    baseline_id: 'm6-1-5k-quality-baseline-v1',
    source: {
      issue: 173,
      repository_commit: sourceCommit,
      canonical_directory: 'data/canonical',
      canonical_revision: inputs.canonical.canonicalRevision,
      canonical_file_count: inputs.canonical.fileCount,
    },
    metrics,
    quality_gates: M6_1_QUALITY_GATES,
    inherited_m5_risks: [
      {
        id: 'relation-candidate-noise-is-stage-specific',
        source: 'docs/m5-16-final-audit-report.md',
        disposition: 'Keep each M5 proposal denominator with its stage. The stage-specific candidate noise rates do not measure the correctness of all 487 current canonical tuples.',
      },
      {
        id: 'editor-time-is-incomplete',
        source: 'docs/m5-16-final-audit-report.md',
        measured_editor_seconds_lower_bound: 6199.055,
        disposition: 'This is a partial lower bound, not total M5 editor time; do not treat agent-gated stages as zero human time.',
      },
      {
        id: 'm5-10k-and-morphology-not-authorized',
        source: 'https://github.com/neverworkalone/typewriter/issues/173',
        disposition: 'M6-1 authorizes M6-2 planning/implementation only. It authorizes no 10K expansion, morphology, bulk relation generation, or ranking architecture.',
      },
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const inputs = await readBaselineInputs();
  const existing = mode === 'check'
    ? JSON.parse(await readFile(DEFAULT_OUTPUT_PATH, 'utf8'))
    : undefined;
  const sourceCommit = existing?.source?.repository_commit
    ?? execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: 'utf8',
    }).trim();
  const snapshot = await buildSnapshot({ sourceCommit, inputs });

  if (mode === 'write') {
    await writeFile(DEFAULT_OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${path.relative(REPOSITORY_DIRECTORY, DEFAULT_OUTPUT_PATH)} from ${snapshot.source.canonical_revision}.`);
    return snapshot;
  }

  assert.deepEqual(existing, snapshot, 'M6-1 baseline differs from the current canonical data, search regression corpus, or gate contract');
  const reachability = snapshot.metrics.search.exhaustive_runtime_reachability;
  assert.equal(reachability.mismatched_key_count, 0, 'canonical search keys must all resolve to their expected start records');
  console.log(
    `M6-1 baseline matches ${snapshot.source.canonical_revision}: `
    + `${snapshot.metrics.canonical.start_count} starts, `
    + `${reachability.matched_key_count}/${reachability.key_count} exact keys reachable.`,
  );
  return snapshot;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

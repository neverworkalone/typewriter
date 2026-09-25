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
import { expandExactSearchCandidates } from '../../src/domain/exact-search-candidates.js';
import { normalizeSearchInput } from '../../src/runtime/search-query.js';
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
const DEFAULT_REPORT_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'docs/m6-1-quality-baseline.md',
);
const DEFAULT_REPORT_TEMPLATE_PATH = path.join(
  SCRIPT_DIRECTORY,
  'm6-1-quality-baseline.template.md',
);
const DEFAULT_REGRESSION_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/search-regressions/m4-baseline.json',
);

export const M6_1_QUALITY_GATES = Object.freeze({
  contract_version: 'm6-1-quality-gates-v2',
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
    stable_hash: {
      input: 'seed + U+0000 + stratum + U+0000 + stable_unit_id',
      encoding: 'UTF-8 bytes of the exact strings',
      digest: 'lowercase SHA-256 hexadecimal',
      order: 'digest ascending; ties compare stable_unit_id UTF-8 bytes ascending',
      normalization: 'none; do not trim, NFC-normalize, or locale-sort sample identifiers',
    },
    candidate_identity: {
      relation_tuple: {
        stratum: 'JSON.stringify(["relation", type])',
        stable_unit_id: 'JSON.stringify([source_record_id, source_sense_id, target_record_id, target_sense_id ?? null, type])',
        eligibility: 'one canonical directed relation tuple',
      },
      relation_gap_record: {
        stratum: 'JSON.stringify([record_type, first_sense.pos])',
        stable_unit_id: 'canonical record.id',
        eligibility: 'start record with no outgoing relation on any sense',
      },
      ambiguous_query: {
        stratum: 'exact-writer-facing-candidate-query',
        stable_unit_id: 'exact runtime-normalized query string, preserving its codepoints',
        eligibility: 'runtime exact-query result expands to at least two ordered (start record, sense) candidate options in interactive DictionaryPanel exact mode',
      },
      writer_task: {
        stratum: 'task_intent',
        stable_unit_id: 'opaque_task_id assigned before outcome collection; never derived from writer text',
        eligibility: 'preassigned writer task in one of the fixed intent slots',
      },
    },
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
      allocation: 'Set each initial quota to min(10, stratum population). Allocate remaining slots to remaining capacities with the Hamilton largest-remainder method: floor each exact proportional quota, then give leftover slots by descending fractional remainder, breaking ties by stratum UTF-8 byte order. If a stratum reaches capacity, repeat over the remaining capacities.',
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
      participant_allocation: 'Assign five participants to pattern A and five to pattern B before collection. Pattern A per participant: 3 direct replacement, 2 sense choice, 2 expression exploration, 2 relation exploration, 1 no-data/policy boundary. Pattern B: 3 direct replacement, 2 sense choice, 1 expression exploration, 3 relation exploration, 1 no-data/policy boundary.',
      selection: 'Fill the assigned slots before reviewing outcomes. If a slot is unfilled, HOLD; do not replace a result after seeing its outcome.',
    },
    ranking: {
      unit: 'exact query whose ordered writer-facing candidate list has at least two record/sense options',
      candidate_expansion: 'One candidate per start record when it has zero or one sense; one candidate per sense when a start record has multiple senses. Preserve runtime record order and canonical sense order, matching DictionaryPanel exact-mode candidateOptions.',
      population_metric: 'metrics.search.writer_facing_candidate_population.ambiguous_query_count',
      sample_size: 'min(40, writer-facing ambiguous exact-query count)',
      minimum_for_a_ranking_change: 20,
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
      baseline_status: 'NOT_MEASURED',
      baseline: 'The current exact-search UI exposes ordered record/sense candidate choices, including sense choices within one polysemous record; writer preference for that order has not been measured.',
      pass: 'For a ranking or sense-order change, at least 80% of the top writer-facing candidates match the adjudicated writer choice across at least 20 ambiguous exact-query tasks; preserve deterministic record and sense ordering.',
      threshold: { writer_preferred_top_candidate: 0.8, minimum_ambiguous_tasks: 20 },
      sample: 'Stable-hash sample up to 40 exact queries with at least two writer-facing (record, sense) candidates. N/A only when no such case is exposed; a ranking change with fewer than 20 cases is HOLD.',
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

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function makeRelationSamplingUnit({
  source_record_id,
  source_sense_id,
  target_record_id,
  target_sense_id,
  type,
}) {
  assert.equal(typeof source_record_id, 'string');
  assert.equal(typeof source_sense_id, 'string');
  assert.equal(typeof target_record_id, 'string');
  assert.equal(typeof type, 'string');
  assert.ok(target_sense_id === null || target_sense_id === undefined || typeof target_sense_id === 'string');
  return {
    stratum: JSON.stringify(['relation', type]),
    stable_unit_id: JSON.stringify([
      source_record_id,
      source_sense_id,
      target_record_id,
      target_sense_id ?? null,
      type,
    ]),
  };
}

export function makeRelationGapSamplingUnit(record) {
  assert.equal(typeof record?.id, 'string');
  assert.equal(record.role, 'start');
  assert.equal(typeof record?.record_type, 'string');
  assert.equal(typeof record?.senses?.[0]?.pos, 'string');
  assert.ok(record.senses.every((sense) => (sense.relations ?? []).length === 0));
  return {
    stratum: JSON.stringify([record.record_type, record.senses[0].pos]),
    stable_unit_id: record.id,
  };
}

export function makeAmbiguousQuerySamplingUnit(normalizedExactQuery, candidateCount) {
  assert.equal(typeof normalizedExactQuery, 'string');
  assert.ok(normalizedExactQuery.length > 0);
  assert.ok(Number.isInteger(candidateCount) && candidateCount >= 2);
  const normalizedInput = normalizeSearchInput(normalizedExactQuery);
  assert.equal(normalizedInput.unsupportedReason, null);
  assert.equal(normalizedInput.normalizedQuery, normalizedExactQuery);
  return {
    stratum: 'exact-writer-facing-candidate-query',
    stable_unit_id: normalizedExactQuery,
  };
}

export function summarizeWriterFacingCandidatePopulation(records, queryRows) {
  assert.ok(Array.isArray(records));
  assert.ok(Array.isArray(queryRows));
  const startRecordsById = new Map(records
    .filter(({ role }) => role === 'start')
    .map((record) => [record.id, record]));
  const exactQueries = new Map();

  for (const row of queryRows) {
    if (row.status !== 'ready') continue;
    assert.equal(typeof row.normalized_query, 'string');
    assert.ok(row.normalized_query.length > 0);
    const matchedRecords = (row.matches ?? [])
      .filter(({ role }) => role === 'start')
      .map(({ id }) => {
        const record = startRecordsById.get(id);
        assert.ok(record, `runtime exact query ${JSON.stringify(row.normalized_query)} returned an unknown start ${id}`);
        return record;
      });
    const candidates = expandExactSearchCandidates(matchedRecords);
    const candidateSignature = candidates.map(({ recordId, senseId }) => [recordId, senseId]);
    const existing = exactQueries.get(row.normalized_query);
    if (existing) {
      assert.deepEqual(
        existing.candidate_signature,
        candidateSignature,
        `normalized exact query ${JSON.stringify(row.normalized_query)} must resolve to one ordered candidate list`,
      );
      continue;
    }
    exactQueries.set(row.normalized_query, {
      candidate_count: candidates.length,
      candidate_signature: candidateSignature,
      matched_record_count: matchedRecords.length,
      query_kind: matchedRecords.length > 1
        ? 'multiple-start-records'
        : candidates.length > 1
          ? 'single-polysemous-start-record'
          : 'single-candidate',
    });
  }

  const querySummaries = [...exactQueries.values()];
  const ambiguousQueries = [...exactQueries.entries()]
    .filter(([, { candidate_count }]) => candidate_count > 1)
    .map(([normalized_query, summary]) => ({
      ...summary,
      ...makeAmbiguousQuerySamplingUnit(normalized_query, summary.candidate_count),
    }));
  return {
    exact_query_count: querySummaries.length,
    candidate_options_per_exact_query: countBy(querySummaries.map(({ candidate_count }) => String(candidate_count))),
    ambiguous_query_count: ambiguousQueries.length,
    ambiguous_query_candidate_option_count: ambiguousQueries.reduce((sum, { candidate_count }) => sum + candidate_count, 0),
    ambiguous_query_counts_by_kind: countBy(ambiguousQueries.map(({ query_kind }) => query_kind)),
    maximum_candidate_options: Math.max(0, ...querySummaries.map(({ candidate_count }) => candidate_count)),
  };
}

export function makeWriterTaskSamplingUnit(taskIntent, opaqueTaskId) {
  assert.equal(typeof taskIntent, 'string');
  assert.equal(typeof opaqueTaskId, 'string');
  assert.ok(Object.hasOwn(M6_1_QUALITY_GATES.sampling.writer_tasks.task_intents, taskIntent));
  assert.ok(opaqueTaskId.length > 0);
  return {
    stratum: taskIntent,
    stable_unit_id: opaqueTaskId,
  };
}

export function selectStableHashSample(units, { limit, seed = M6_1_QUALITY_GATES.sampling.stable_seed }) {
  assert.ok(Array.isArray(units));
  assert.ok(Number.isInteger(limit) && limit >= 0);
  assert.equal(typeof seed, 'string');
  const seen = new Set();
  const ranked = units.map((unit) => {
    assert.equal(typeof unit?.stratum, 'string');
    assert.equal(typeof unit?.stable_unit_id, 'string');
    const uniqueKey = JSON.stringify([unit.stratum, unit.stable_unit_id]);
    assert.ok(!seen.has(uniqueKey), `duplicate sample unit ${uniqueKey}`);
    seen.add(uniqueKey);
    const hash = createHash('sha256')
      .update(`${seed}\u0000${unit.stratum}\u0000${unit.stable_unit_id}`, 'utf8')
      .digest('hex');
    return { unit, hash };
  });
  ranked.sort((left, right) => (
    left.hash < right.hash ? -1
      : left.hash > right.hash ? 1
        : compareUtf8(left.unit.stable_unit_id, right.unit.stable_unit_id)
  ));
  return ranked.slice(0, Math.min(limit, ranked.length)).map(({ unit }) => unit);
}

export function allocateRelationGapQuotas(stratumCounts, requestedSampleSize, { minimumPerStratum = 10 } = {}) {
  assert.ok(stratumCounts && typeof stratumCounts === 'object' && !Array.isArray(stratumCounts));
  assert.ok(Number.isInteger(requestedSampleSize) && requestedSampleSize >= 0);
  assert.ok(Number.isInteger(minimumPerStratum) && minimumPerStratum >= 0);
  const entries = Object.entries(stratumCounts).sort(([left], [right]) => compareUtf8(left, right));
  for (const [stratum, count] of entries) {
    assert.equal(typeof stratum, 'string');
    assert.ok(Number.isInteger(count) && count >= 0);
  }
  const totalPopulation = entries.reduce((total, [, count]) => total + count, 0);
  const target = Math.min(requestedSampleSize, totalPopulation);
  const quotas = Object.fromEntries(entries.map(([stratum, count]) => [
    stratum,
    Math.min(minimumPerStratum, count),
  ]));
  let allocated = Object.values(quotas).reduce((total, count) => total + count, 0);
  if (allocated > target) {
    throw new RangeError('minimum per-stratum allocation exceeds the requested sample size');
  }

  let remainingSlots = target - allocated;
  const capacities = entries.map(([stratum, count]) => ({
    stratum,
    capacity: count - quotas[stratum],
  })).filter(({ capacity }) => capacity > 0);
  const remainingCapacity = capacities.reduce((total, { capacity }) => total + capacity, 0);
  if (remainingSlots === 0 || remainingCapacity === 0) return quotas;

  const remainders = [];
  for (const { stratum, capacity } of capacities) {
    const numerator = remainingSlots * capacity;
    const floor = Math.floor(numerator / remainingCapacity);
    quotas[stratum] += floor;
    allocated += floor;
    remainders.push({ stratum, remainder: numerator % remainingCapacity, capacity });
  }
  remainingSlots = target - allocated;
  remainders.sort((left, right) => (
    right.remainder - left.remainder || compareUtf8(left.stratum, right.stratum)
  ));
  for (const candidate of remainders) {
    if (remainingSlots === 0) break;
    if (quotas[candidate.stratum] >= stratumCounts[candidate.stratum]) continue;
    quotas[candidate.stratum] += 1;
    remainingSlots -= 1;
  }
  assert.equal(remainingSlots, 0, 'largest-remainder allocation must use the full sample');
  return quotas;
}

export function selectRelationGapSample(records, sampleSize = 80) {
  const grouped = new Map();
  for (const record of records) {
    const unit = { ...makeRelationGapSamplingUnit(record), record_id: record.id };
    const units = grouped.get(unit.stratum) ?? [];
    units.push(unit);
    grouped.set(unit.stratum, units);
  }
  const counts = Object.fromEntries([...grouped.entries()].map(([stratum, units]) => [stratum, units.length]));
  const quotas = allocateRelationGapQuotas(counts, sampleSize);
  return Object.entries(quotas)
    .sort(([left], [right]) => compareUtf8(left, right))
    .flatMap(([stratum, limit]) => selectStableHashSample(grouped.get(stratum) ?? [], { limit }));
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

export function evaluateSearchReachability(expectedRows, actualRows) {
  assert.ok(Array.isArray(expectedRows));
  assert.ok(Array.isArray(actualRows));
  const expectedByKey = new Map(expectedRows.map((row) => [row.key, row]));
  const actualByKey = new Map(actualRows.map((row) => [row.key, row]));
  assert.equal(expectedByKey.size, expectedRows.length, 'expected exact keys must be unique');
  assert.equal(actualByKey.size, actualRows.length, 'actual exact keys must be unique');

  const mismatches = [];
  let matchedKeyCount = 0;
  let missingExpectedCount = 0;
  let unexpectedResultCount = 0;
  let referenceOnlyLeakCount = 0;
  let unsupportedKeyCount = 0;

  for (const expectedRow of expectedRows) {
    const actualRow = actualByKey.get(expectedRow.key);
    const status = actualRow?.status ?? 'missing';
    const matches = actualRow?.matches ?? [];
    const expectedIds = expectedRow.expected_ids;
    const actualIds = matches.map(({ id }) => id);
    const expectedIdSet = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !actualIds.includes(id));
    const unexpected = actualIds.filter((id) => !expectedIdSet.has(id));
    const roleLeaks = matches.filter(({ role }) => role !== 'start');

    if (status === 'ready' && actualIds.length > 0) matchedKeyCount += 1;
    if (status === 'unsupported') unsupportedKeyCount += 1;
    missingExpectedCount += missing.length;
    unexpectedResultCount += unexpected.length;
    referenceOnlyLeakCount += roleLeaks.length;

    if (status !== 'ready' || !equalArray(actualIds, expectedIds)) {
      mismatches.push({
        key: expectedRow.key,
        expected_ids: expectedIds,
        actual_ids: actualIds,
        actual_status: status,
      });
    }
  }

  const unexpectedKeyCount = actualRows.filter(({ key }) => !expectedByKey.has(key)).length;
  for (const { key, status, matches = [] } of actualRows) {
    if (!expectedByKey.has(key)) {
      mismatches.push({
        key,
        expected_ids: [],
        actual_ids: matches.map(({ id }) => id),
        actual_status: status,
      });
    }
  }

  return {
    key_count: expectedByKey.size,
    matched_key_count: matchedKeyCount,
    missing_expected_result_count: missingExpectedCount,
    unexpected_result_count: unexpectedResultCount,
    unexpected_key_count: unexpectedKeyCount,
    reference_only_leak_count: referenceOnlyLeakCount,
    unsupported_key_count: unsupportedKeyCount,
    mismatched_key_count: mismatches.length,
    mismatched_keys: mismatches.slice(0, 20),
  };
}

export function assertSearchReachabilityPass(reachability) {
  assert.equal(reachability.missing_expected_result_count, 0, 'all expected records must be returned');
  assert.equal(reachability.reference_only_leak_count, 0, 'free search must not expose reference-only records');
  assert.equal(reachability.unexpected_result_count, 0, 'queries must not return unexpected records');
  assert.equal(reachability.unexpected_key_count, 0, 'the runtime must not expose unregistered exact keys');
  assert.equal(reachability.unsupported_key_count, 0, 'canonical start keys must not be classified as unsupported');
  assert.equal(reachability.matched_key_count, reachability.key_count, 'every expected exact key must be reachable');
  assert.equal(reachability.mismatched_key_count, 0, 'all exact-key status and ordering must match the canonical mapping');
}

export function assertBaselineSnapshotMatches(existing, computed) {
  assert.deepStrictEqual(
    existing,
    computed,
    'M6-1 baseline differs from the current canonical data, search regression corpus, or gate contract',
  );
}

export function deriveM6QualityBaselineMetrics({
  records,
  canonicalRevision,
  canonicalFileCount,
  regressionCorpus,
  regressionSha256,
  reachability,
  writerFacingCandidatePopulation,
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
      writer_facing_candidate_population: writerFacingCandidatePopulation,
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

    return {
      reachability: evaluateSearchReachability(expectedRows, actualRows),
      writerFacingCandidatePopulation: summarizeWriterFacingCandidatePopulation(records, actualRows),
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
  const runtimeMeasurements = await measureRuntimeReachability({
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
    reachability: runtimeMeasurements.reachability,
    writerFacingCandidatePopulation: runtimeMeasurements.writerFacingCandidatePopulation,
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
    writerFacingCandidatePopulation: inputs.writerFacingCandidatePopulation,
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
        focused_editorial_sample_case_count: 9,
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

function escapeTableValue(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(escapeTableValue).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeTableValue).join(' | ')} |`),
  ].join('\n');
}

const compactJson = (value) => JSON.stringify(value ?? {});
const percent = (value, total) => total === 0 ? 'N/A' : `${((value / total) * 100).toFixed(2)}%`;
const formatCount = (value) => typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : value;

export function renderBaselineSnapshotMarkdown(snapshot) {
  const { metrics, source, quality_gates: gates, inherited_m5_risks: risks } = snapshot;
  const canonical = metrics.canonical;
  const relations = metrics.relations;
  const search = metrics.search;
  const reachability = search.exhaustive_runtime_reachability;
  const regression = search.regression_corpus;
  const writerCandidates = search.writer_facing_candidate_population;
  const roles = Object.keys(canonical.record_type_counts_by_role);
  const posTypes = [...new Set(Object.values(canonical.pos_by_role)
    .flatMap(({ sense_count }) => Object.keys(sense_count)))].sort();
  const relationRecordTypes = [...new Set([
    ...Object.keys(relations.start_coverage.relation_bearing_by_record_type),
    ...Object.keys(relations.start_coverage.relation_empty_by_record_type),
  ])].sort();
  const relationCoverageRows = relationRecordTypes.map((type) => [
    type,
    relations.start_coverage.relation_bearing_by_record_type[type] ?? 0,
    relations.start_coverage.relation_empty_by_record_type[type] ?? 0,
    (relations.start_coverage.relation_bearing_by_record_type[type] ?? 0)
      + (relations.start_coverage.relation_empty_by_record_type[type] ?? 0),
  ]);
  relationCoverageRows.push([
    'Total',
    `${formatCount(relations.start_coverage.relation_bearing_count)} (${percent(relations.start_coverage.relation_bearing_count, canonical.start_count)})`,
    `${formatCount(relations.start_coverage.relation_empty_count)} (${percent(relations.start_coverage.relation_empty_count, canonical.start_count)})`,
    formatCount(canonical.start_count),
  ]);
  const relationTypes = Object.keys(relations.directed_tuples_by_type);
  const dimensions = gates.dimensions.map((dimension) => [
    dimension.id,
    dimension.baseline_status,
    dimension.sample,
    dimension.pass,
    compactJson(dimension.threshold),
  ]);
  const samplingFamilies = Object.entries(gates.sampling.candidate_identity).map(([name, identity]) => [
    name,
    identity.stratum,
    identity.stable_unit_id,
    identity.eligibility,
  ]);
  const writerIntents = Object.entries(gates.sampling.writer_tasks.task_intents);
  const recordSenseProfiles = (role) => Object.entries(
    canonical.records_by_sense_count_and_role[role] ?? {},
  ).map(([senseCount, recordCount]) => `${senseCount} sense(s): ${formatCount(recordCount)}`).join('; ');
  const writerTasks = gates.sampling.writer_tasks;

  return [
    '### Snapshot identity',
    '',
    markdownTable(['Field', 'Value'], [
      ['Issue-start repository commit', source.repository_commit],
      ['Canonical content digest', source.canonical_revision],
      ['Canonical JSONL files', formatCount(canonical.file_count)],
      ['M4 regression fixture SHA-256', regression.fixture_sha256],
    ]),
    '',
    '### Canonical inventory',
    '',
    markdownTable(['Measure', 'Count'], [
      ['Canonical records', formatCount(canonical.record_count)],
      ['Search starts', formatCount(canonical.start_count)],
      ['Reference-only records', formatCount(canonical.reference_only_count)],
      ['All senses', formatCount(canonical.total_sense_count)],
      ['Start senses', formatCount(canonical.start_sense_count)],
      ['Reference-only senses', formatCount(canonical.reference_only_sense_count)],
      ['Expression records', formatCount(canonical.expression_record_count)],
      ['Directed relation tuples', formatCount(relations.directed_tuple_count)],
    ]),
    '',
    markdownTable(['Role', 'Record type', 'Count'], Object.entries(canonical.record_type_counts_by_role)
      .flatMap(([role, typeCounts]) => Object.entries(typeCounts)
        .map(([type, count]) => [role, type, formatCount(count)]))),
    '',
    markdownTable(['Role', 'Records by sense count', 'Single-sense', 'Polysemous'], roles.map((role) => [
      role,
      recordSenseProfiles(role),
      formatCount(canonical.single_sense_record_count_by_role[role]),
      formatCount(canonical.polysemous_record_count_by_role[role]),
    ])),
    '',
    'POS sense counts and records containing that POS by role. Record counts can overlap.',
    '',
    markdownTable(['POS', ...roles.flatMap((role) => [`${role} senses`, `${role} records`])], posTypes.map((pos) => [
      `${pos[0].toUpperCase()}${pos.slice(1)}`,
      ...roles.flatMap((role) => [
        formatCount(canonical.pos_by_role[role]?.sense_count[pos] ?? 0),
        formatCount(canonical.pos_by_role[role]?.records_with_pos[pos] ?? 0),
      ]),
    ])),
    '',
    '### Relation coverage, type, and direction',
    '',
    markdownTable(['Start record type', 'Relation-bearing', 'Relation-empty', 'Total'], relationCoverageRows
      .map((row) => [row[0], ...row.slice(1).map(formatCount)])),
    '',
    markdownTable(['Relation type', 'Directed tuples', 'Target roles'], relationTypes.map((type) => [
      type,
      formatCount(relations.directed_tuples_by_type[type]),
      Object.entries(relations.directed_tuples_by_type_and_target_role[type])
        .map(([role, count]) => `${role}: ${formatCount(count)}`).join(', '),
    ])),
    '',
    markdownTable(['Direction measure', 'Counts'], [
      ['Source roles', Object.entries(relations.source_role_counts)
        .map(([role, count]) => `${role}: ${formatCount(count)}`).join(', ')],
      ['Target roles', Object.entries(relations.target_role_counts)
        .map(([role, count]) => `${role}: ${formatCount(count)}`).join(', ')],
      ['Source role → target role', Object.entries(relations.source_to_target_role_counts)
        .map(([rolesValue, count]) => `${rolesValue}: ${formatCount(count)}`).join(', ')],
      ['Source POS', compactJson(relations.directed_tuples_by_source_pos)],
      ['Tuples with a same-type, same-sense reverse', formatCount(relations.tuples_with_matching_reverse_same_type)],
    ]),
    '',
    'Coverage and correctness are separate. No relation-density target or reverse-edge requirement is inferred from these counts.',
    '',
    '### Search reachability and regression evidence',
    '',
    markdownTable(['Search-form measure', 'Count'], [
      ['Start form values', formatCount(search.start_search_form_value_count)],
      ['Distinct start form values', formatCount(search.distinct_start_search_form_value_count)],
      ['Starts containing their lemma as a form', formatCount(search.starts_with_lemma_in_search_forms)],
      ['Starts with an alternate form', formatCount(search.starts_with_non_lemma_search_form)],
      ['Alternate form values', formatCount(search.non_lemma_search_form_value_count)],
      ['Cross-record form collision groups', formatCount(search.cross_record_search_form_collision_group_count)],
      ['Distinct exact start keys', formatCount(search.exact_key_count)],
      ['Cross-record exact-key collision groups', formatCount(search.cross_record_exact_key_collision_group_count)],
      ['Multi-result exact keys', formatCount(search.multi_result_exact_key_count)],
      ['Writer-facing exact-query population', formatCount(writerCandidates.exact_query_count)],
      ['Exact queries with at least two record/sense candidates', formatCount(writerCandidates.ambiguous_query_count)],
      ['Ambiguous queries with multiple start records', formatCount(writerCandidates.ambiguous_query_counts_by_kind['multiple-start-records'] ?? 0)],
      ['Ambiguous queries with multiple senses in one record only', formatCount(writerCandidates.ambiguous_query_counts_by_kind['single-polysemous-start-record'] ?? 0)],
      ['Candidate options across ambiguous queries', formatCount(writerCandidates.ambiguous_query_candidate_option_count)],
      ['Writer-facing options per exact query', compactJson(writerCandidates.candidate_options_per_exact_query)],
    ]),
    '',
    markdownTable(['Exhaustive runtime key check', 'Count'], [
      ['Keys queried', formatCount(reachability.key_count)],
      ['Expected keys reachable', formatCount(reachability.matched_key_count)],
      ['Missing expected results', formatCount(reachability.missing_expected_result_count)],
      ['Unexpected results', formatCount(reachability.unexpected_result_count)],
      ['Unexpected keys', formatCount(reachability.unexpected_key_count)],
      ['Reference-only leaks', formatCount(reachability.reference_only_leak_count)],
      ['Unsupported canonical keys', formatCount(reachability.unsupported_key_count)],
      ['Mismatched keys', formatCount(reachability.mismatched_key_count)],
    ]),
    '',
    `M4 corpus ${regression.fixture_id} (schema ${regression.schema_version}, ${regression.case_count} cases):`,
    '',
    markdownTable(['Input class', 'Cases'], Object.entries(regression.input_class_counts)),
    '',
    markdownTable(['Evaluation', 'Cases'], Object.entries(regression.evaluation_counts)),
    '',
    markdownTable(['Recorded actual status', 'Cases'], Object.entries(regression.actual_status_counts)),
    '',
    markdownTable(['Regression disposition', 'Value'], [
      ['Baseline cases matching recorded expectations', `${regression.baseline_cases_matching_recorded_expectations}/${regression.baseline_case_count}`],
      ['Pending case IDs', regression.pending_case_ids.join(', ') || 'none'],
      ['Expected/actual mismatch IDs retained as pending', regression.expected_actual_mismatch_case_ids.join(', ') || 'none'],
    ]),
    '',
    '### Frozen benchmark and quality gates',
    '',
    markdownTable(['Sampling rule', 'Contract'], [
      ['Stable seed', gates.sampling.stable_seed],
      ['Stable hash', Object.entries(gates.sampling.stable_hash)
        .map(([field, value]) => `${field}: ${value}`).join('; ')],
      ['Direct relation sample', `${gates.sampling.relation_direct.sample_size} Current population: ${formatCount(gates.sampling.relation_direct.current_population)}.`],
      ['Other relation samples', `${gates.sampling.relation_other_types.per_type_sample_size} ${gates.sampling.relation_other_types.minimum_types_reported}`],
      ['Relation-gap sample', `${gates.sampling.relation_gaps.sample_size}. Strata: ${gates.sampling.relation_gaps.strata} Allocation: ${gates.sampling.relation_gaps.allocation}`],
      ['Ambiguous-query sample', `${gates.sampling.ranking.sample_size}; at least ${gates.sampling.ranking.minimum_for_a_ranking_change} cases are required to evaluate a ranking change.`],
      ['Ranking candidate population', `${gates.sampling.ranking.unit}. ${gates.sampling.ranking.candidate_expansion} Population metric: ${gates.sampling.ranking.population_metric}.`],
      ['Writer-task sample', `${formatCount(writerTasks.task_count)} tasks from ${formatCount(writerTasks.participants)} writers, ${formatCount(writerTasks.tasks_per_participant)} tasks each. ${writerTasks.selection}`],
      ['Writer-task participant allocation', writerTasks.participant_allocation],
      ['Writer-task source', writerTasks.source],
    ]),
    '',
    markdownTable(['Sample family', 'Stratum', 'Stable unit ID', 'Eligible population'], samplingFamilies),
    '',
    markdownTable(['Writer-task intent', 'Tasks'], writerIntents),
    '',
    `Each canonical review case receives ${formatCount(gates.review_protocol.independent_reviewers_per_canonical_case)} independent judgments. ${gates.review_protocol.disagreement} ${gates.review_protocol.retained_evidence}`,
    '',
    markdownTable(['Quality dimension', 'Baseline status', 'Sample', 'PASS condition', 'Machine threshold'], dimensions.map((row) => [
      ...row.slice(0, 4),
      row[4],
    ])),
    '',
    markdownTable(['Overall decision', 'Semantics'], Object.entries(gates.overall_decision)),
    '',
    '### M5 inherited risks and scope',
    '',
    markdownTable(['Risk', 'Source', 'Recorded measure', 'Disposition'], risks.map((risk) => [
      risk.id,
      risk.source,
      risk.measured_editor_seconds_lower_bound ?? risk.focused_editorial_sample_case_count ?? '—',
      risk.disposition,
    ])),
  ].join('\n');
}

export function renderBaselineReport(template, snapshot) {
  const marker = '{{M6_1_GENERATED_SNAPSHOT}}';
  assert.equal(template.split(marker).length - 1, 1, 'baseline report template must contain one generated snapshot marker');
  return template.replace(marker, renderBaselineSnapshotMarkdown(snapshot)).replace(/\s*$/u, '\n');
}

export function assertBaselineReportMatches(template, existingReport, snapshot) {
  assert.equal(
    existingReport,
    renderBaselineReport(template, snapshot),
    'M6-1 Markdown report differs from its machine-readable baseline snapshot or report template',
  );
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const inputs = await readBaselineInputs();
  const existing = await readFile(DEFAULT_OUTPUT_PATH, 'utf8')
    .then((source) => JSON.parse(source))
    .catch((error) => {
      if (mode === 'write' && error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (mode === 'write' && existing
    && existing.source?.canonical_revision !== inputs.canonical.canonicalRevision) {
    throw new Error('M6-1 source canonical revision changed; preserve this snapshot and create a new version.');
  }
  const sourceCommit = existing?.source?.repository_commit
    ?? execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: 'utf8',
    }).trim();
  const snapshot = await buildSnapshot({ sourceCommit, inputs });

  if (mode === 'write') {
    await writeFile(DEFAULT_OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const template = await readFile(DEFAULT_REPORT_TEMPLATE_PATH, 'utf8');
    const report = renderBaselineReport(template, snapshot);
    await writeFile(DEFAULT_REPORT_PATH, report, 'utf8');
    console.log(`Wrote baseline JSON and report for ${snapshot.source.canonical_revision}.`);
    return snapshot;
  }

  assertBaselineSnapshotMatches(existing, snapshot);
  const reachability = snapshot.metrics.search.exhaustive_runtime_reachability;
  assertSearchReachabilityPass(reachability);
  const template = await readFile(DEFAULT_REPORT_TEMPLATE_PATH, 'utf8');
  const report = await readFile(DEFAULT_REPORT_PATH, 'utf8');
  assertBaselineReportMatches(template, report, snapshot);
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

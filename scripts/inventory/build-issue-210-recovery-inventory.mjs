import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../build/dictionary.mjs';
import { findRecordsBySearchTerm } from '../build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { createCanonicalContext } from '../validate/canonical-context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY_PATH = path.join(ROOT, 'data/inventory/issue-210-recovery-inventory.json');
const REPORT_PATH = path.join(ROOT, 'docs/issue-210-historical-exclusion-report.md');
const EXPECTED_ISSUE_204_REJECTS = [
  '없다', '사람', '많다', '만들다', '동안', '내다', '필요', '처음', '다음', '지금',
  '친구', '그때', '오늘', '여자', '이해', '인간', '남자', '준비', '중요', '넣다',
  '가능', '마지막', '아버지', '아래', '조금',
];
const ALLOWED_REVIEW_STATES = new Set([
  'admit-candidate',
  'recovered',
  'hold',
  'not-a-lexical-unit',
  'duplicate',
  'invalid-lemma',
  'wrong-pos',
  'needs-sense-split',
  'search-surface-collision',
  'unsupported-scope',
]);
const SOURCE_PATHS = [
  'package.json',
  'AGENTS.md',
  'config/artifact-policy.json',
  'scripts/inventory/build-issue-210-recovery-inventory.mjs',
  'docs/pilot-scope.md',
  'data/canonical/pilot.jsonl',
  'docs/m3-handoff.md',
  'docs/m4-handoff.md',
  'docs/editorial-model.md',
  'docs/m5-target-inventory.md',
  'docs/m5-16-final-audit-report.md',
  'docs/issue-208-searchable-start-retrospective.md',
  'docs/issue-211-bounded-lexical-recovery.md',
  'docs/issue-219-m9-a-recovery.md',
  'docs/issue-220-m9-b-checkpoint.md',
  'docs/m9-corpus-production.md',
  'docs/m9-bounded-lexical-batches.md',
  'docs/external-material-review-customs-terminology.md',
  'docs/m6-1-searchable-lexical-baseline.md',
  'docs/m6-1-searchable-lexical-baseline.json',
  'docs/m6-1-quality-baseline.json',
  'data/inventory/m5-target-seed.json',
  'data/inventory/m5-target-promotions.jsonl',
  'data/validation/canonical-semantic-decision-source.json',
  'data/validation/m6-2-inflection-exceptions.json',
  'data/validation/m6-3-surface-form-review.json',
  'data/batches/issue-204-pilot-decisions.json',
  'data/batches/issue-204-semantic-decisions.json',
  'data/batches/issue-211-lexical-unit-source.json',
  'data/batches/issue-211-semantic-decisions.json',
  'data/batches/issue-219-m9-a-base-seed.json',
  'data/batches/issue-219-m9-a-base-issue-210-recovery-inventory.json',
  'data/batches/issue-219-m9-a-recovery-selection.json',
  'data/batches/issue-219-m9-a-lexical-unit-source.json',
  'data/batches/issue-219-m9-a-semantic-decisions.json',
  'data/canonical/issue-219-m9-a-recovery.jsonl',
  'data/validation/issue-219-m9-lexical-batch-report.json',
  'data/batches/issue-220-m9-b-selection.json',
  'data/batches/issue-220-m9-b-base-seed.json',
  'data/batches/issue-220-m9-b-base-issue-210-recovery-inventory.json',
  'data/batches/issue-220-m9-b-batch-01-lexical-unit-source.json',
  'data/batches/issue-220-m9-b-batch-01-semantic-decisions.json',
  'data/batches/issue-220-m9-b-batch-02-lexical-unit-source.json',
  'data/batches/issue-220-m9-b-batch-02-semantic-decisions.json',
  'data/batches/issue-221-corpus-candidate-review.json',
  'data/batches/issue-221-corpus-semantic-decisions.json',
  'data/batches/issue-222-m9-d-corpus-batch-01-candidate-review.json',
  'data/batches/issue-222-m9-d-corpus-batch-01-semantic-decisions.json',
  'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json',
  'data/batches/issue-222-m9-d-historical-base-m5-target-seed.json',
  'data/batches/issue-222-m9-d-historical-candidate-source.json',
  'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
  'data/canonical/issue-221-corpus-production.jsonl',
  'data/canonical/issue-222-m9-d-corpus-batch-01.jsonl',
  'data/canonical/issue-222-m9-d-historical-batch-01.jsonl',
  'data/canonical/issue-220-m9-b-batch-01.jsonl',
  'data/canonical/issue-220-m9-b-batch-02.jsonl',
  'data/validation/issue-220-m9-b-checkpoint-report.json',
  'schema/issue-220-m9-b-checkpoint-report.schema.json',
  'scripts/batch/authored-semantic-decision-source.mjs',
  'data/batches/m5-3-calibration.json',
  'data/batches/m5-5-recalibration.json',
  'data/batches/m5-7-recalibration.json',
  'data/batches/m5-7-preimport-inventory.json',
  'data/batches/m5-9-expansion.json',
  'data/batches/m5-9-preimport-inventory.json',
  'data/batches/m5-10-wave-a.json',
  'data/batches/m5-10-wave-b.json',
  'data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json',
  'data/batches/m5-10a-wave-a2-preimport-inventory.json',
  'data/batches/m5-10c-editorial-decisions-20260910.json',
  'data/batches/m5-10c-editorial-work-held-rejected-20260910.jsonl',
  'data/batches/m5-10d-editorial-decisions-20260912.json',
  'data/batches/m5-10d-editorial-judgment-held-rejected-20260912.jsonl',
  'data/batches/m5-11-review.json',
  'data/batches/m5-11-admission.json',
  'data/batches/m5-12-base-inventory.json',
  'data/batches/m5-12-review.json',
  'data/batches/m5-12a-semantic-decisions.json',
  'data/batches/m5-12a-admission.json',
  'data/batches/m5-13-review.json',
  'data/batches/m5-13-lexical-unit-source.json',
  'data/batches/m5-13-semantic-decisions.json',
  'data/batches/m5-13-admission.json',
  'data/batches/m5-14-review.json',
  'data/batches/m5-14-semantic-decisions.json',
  'data/batches/m5-14-admission.json',
  'data/batches/m5-15-review.json',
  'data/batches/m5-15-semantic-decisions.json',
  'data/batches/m5-15-admission.json',
  'scripts/batch/validate-issue-211.mjs',
  'scripts/batch/validate-issue-219.mjs',
  'scripts/batch/validate-issue-220.mjs',
  'scripts/batch/validate-issue-221.mjs',
  'scripts/batch/validate-issue-222.mjs',
  'scripts/batch/lexical-production.mjs',
  'scripts/batch/lexical-selection.mjs',
  'scripts/batch/m5-13-candidate-source.mjs',
  'scripts/batch/m5-13-decision-source.mjs',
  'scripts/validate/semantic-decision-row.mjs',
  'scripts/validate/semantic-audit.mjs',
  'scripts/reference/corpus_lemma_pilot.py',
  'scripts/reference/run-corpus-lemma-pilot.mjs',
  'scripts/reference/test-corpus-lemma-pilot.py',
  'scripts/reference/run-corpus-lemma-pilot.test.mjs',
  'scripts/reference/corpus-candidate-review.test.mjs',
  'scripts/reference/validate-corpus-candidate-review.mjs',
  'scripts/validate/corpus-candidate-review.mjs',
  'schema/m9-lexical-batch-report.schema.json',
  'tests/issue-219-content-digest.test.mjs',
  'tests/issue-219-search.test.mjs',
  'tests/lexical-production-candidates.test.mjs',
  'scripts/ci/registry.mjs',
  'tests/issue-211-search.test.mjs',
  'tests/searchable-start-contract.test.mjs',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (relativePath) => JSON.parse(
  await readFile(path.join(ROOT, relativePath), 'utf8'),
);
const readJsonl = async (relativePath) => (await readFile(path.join(ROOT, relativePath), 'utf8'))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const countBy = (rows, key) => rows.reduce((counts, row) => {
  const value = typeof key === 'function' ? key(row) : row[key];
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});
const stableUnique = (values) => [...new Set(values)];

async function buildSourceManifest() {
  const batchNames = (await readdir(path.join(ROOT, 'data/batches')))
    .filter((name) => /^issue-222-m9-d-corpus-batch-\d+-(candidate-review|semantic-decisions)\.json$/u.test(name))
    .sort();
  const issue222CorpusSourcePaths = batchNames.map((name) => `data/batches/${name}`);
  const canonicalNames = (await readdir(path.join(ROOT, 'data/canonical')))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const historicalCanonicalDirectories = [
    'data/batches/issue-219-m9-a-base-canonical',
    'data/batches/issue-220-m9-b-base-canonical',
  ];
  const historicalCanonicalPaths = [];
  for (const directory of historicalCanonicalDirectories) {
    const names = (await readdir(path.join(ROOT, directory)))
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    historicalCanonicalPaths.push(...names.map((name) => `${directory}/${name}`));
  }
  const paths = stableUnique([
    ...SOURCE_PATHS,
    ...issue222CorpusSourcePaths,
    ...canonicalNames.map((name) => `data/canonical/${name}`),
    ...historicalCanonicalPaths,
  ]).sort();
  return Promise.all(paths.map(async (relativePath) => {
    const bytes = await readFile(path.join(ROOT, relativePath));
    return { path: relativePath, sha256: sha256(bytes), byte_count: bytes.byteLength };
  }));
}

function makeHistoryEvent({ issueNumber = null, batchId = null, artifactPath, disposition, rationale }) {
  return {
    source_issue: issueNumber,
    source_batch: batchId,
    source_artifact: artifactPath,
    historical_disposition: disposition,
    historical_rationale: rationale,
  };
}

function findCanonicalMatches(database, recordsById, query) {
  const response = findRecordsBySearchTerm(database, query);
  const matches = response.matches.map(({ id, role, lemma, record_type: recordType, match }) => ({
    record_id: id,
    lemma,
    record_type: recordType,
    historical_role: role,
    match_kind: match?.kind ?? null,
    match_field: match?.field ?? null,
    match_value: match?.value ?? null,
    current_pos: stableUnique((recordsById.get(id)?.senses ?? []).map(({ pos }) => pos)).sort(),
  }));
  return {
    query,
    status: response.status,
    normalized_query: response.normalizedQuery,
    matches,
  };
}

function candidateSearchCoverage(database, recordsById, candidate) {
  const queries = stableUnique([candidate.lemma, ...(candidate.search_forms ?? [])]);
  const results = queries.map((query) => findCanonicalMatches(database, recordsById, query));
  const lemmaQuery = results.find(({ query }) => query === candidate.lemma);
  const lemmaOwners = recordsById.size
    ? [...recordsById.values()].filter(({ lemma }) => lemma === candidate.lemma)
    : [];
  const lemmaMatchIds = stableUnique(lemmaOwners.map(({ id }) => id)).sort();
  const allMatchIds = stableUnique(results.flatMap(({ matches }) => matches.map(({ record_id: id }) => id))).sort();
  const lemmaIsOnlyAForm = (lemmaQuery?.matches ?? []).length > 0 && lemmaMatchIds.length === 0;
  return {
    status: lemmaMatchIds.length > 0
      ? 'canonical-lemma-present'
      : lemmaIsOnlyAForm
        ? 'search-surface-collision'
        : 'no-canonical-lemma-match',
    exact_lemma_match_ids: lemmaMatchIds,
    all_query_match_ids: allMatchIds,
    queries: results,
  };
}

function semanticSourceInfo(inventoryId, semanticMaps) {
  for (const source of [...semanticMaps].reverse()) {
    const decision = source.decisions.get(inventoryId);
    if (decision) return { source, decision };
  }
  return null;
}

function issue204DispositionState(decision) {
  switch (decision.editorial_judgment.disposition) {
    case 'reject': return 'admit-candidate';
    case 'hold': return 'hold';
    case 'needs-sense-split': return 'needs-sense-split';
    case 'search-surface-collision': return 'search-surface-collision';
    case 'already-covered': return 'duplicate';
    case 'invalid-lemma': return 'invalid-lemma';
    case 'wrong-pos': return 'wrong-pos';
    default: throw new Error(`Unexpected Issue #204 disposition: ${decision.editorial_judgment.disposition}`);
  }
}

function classifyTarget(target, issue204, semantic, priorRejections) {
  if (semantic?.source.issueNumber === 222 && semantic.source.sourceClass === 'historical-recovery-inventory') {
    if (semantic.decision.decision === 'included' || semantic.decision.decision === 'corrected') {
      return {
        reviewState: 'recovered',
        rationaleConflict: 'no',
        followUp: 'Issue #222 re-reviewed this bounded historical candidate against the frozen Issue #210 inventory and exact M5 seed row, then admitted its current identity and authored meaning through ordinary shared production. Keep the earlier inventory disposition as history only.',
      };
    }
    if (semantic.decision.decision === 'held') {
      return {
        reviewState: semantic.decision.hold_basis === 'unresolved-sense' ? 'needs-sense-split' : 'hold',
        rationaleConflict: 'no',
        followUp: 'Issue #222 retained this historical candidate on hold after current source-bound review; reopen only when the candidate-specific identity or sense evidence is complete.',
      };
    }
    if (semantic.decision.decision === 'rejected') {
      return {
        reviewState: 'not-a-lexical-unit',
        rationaleConflict: 'no',
        followUp: 'Issue #222 rejected this candidate through current source-bound lexical review. Historical fit remains provenance only.',
      };
    }
    throw new Error(`Unexpected Issue #222 historical disposition for ${target.inventory_id}`);
  }

  if (semantic?.source.issueNumber === 220) {
    if (semantic.decision.decision === 'included' || semantic.decision.decision === 'corrected') {
      return {
        reviewState: 'recovered',
        rationaleConflict: 'no',
        followUp: 'Issue #220 independently re-reviewed the historical lexical unit and admitted it through ordinary shared production. Its exact canonical lemma is directly searchable; preserve the prior reserve decision only as history.',
      };
    }
    if (semantic.decision.decision === 'held'
      && semantic.decision.hold_basis === 'unresolved-lexical-unit') {
      return {
        reviewState: 'hold',
        rationaleConflict: 'no',
        followUp: 'Issue #220 keeps the exact source form held because its lexical-unit or morphological boundary needs candidate-specific evidence. Reopen only when that evidence is available.',
      };
    }
    if (semantic.decision.decision === 'held'
      && semantic.decision.hold_basis === 'unresolved-sense') {
      return {
        reviewState: 'needs-sense-split',
        rationaleConflict: 'no',
        followUp: 'Issue #220 found distinct sentence frames and writer routes inside the one-sense candidate. Keep it held until a source-bound multi-sense record resolves that boundary.',
      };
    }
    if (semantic.decision.decision === 'rejected'
      && semantic.decision.rejection_basis === 'not-a-lexical-unit') {
      return {
        reviewState: 'not-a-lexical-unit',
        rationaleConflict: 'no',
        followUp: 'Issue #220 reviewed this exact candidate as a compositional phrase rather than an admitted lexical unit. Reopen only if evidence establishes a fixed whole-form use.',
      };
    }
    throw new Error(`Unexpected Issue #220 disposition for ${target.inventory_id}`);
  }

  if (semantic?.source.issueNumber === 219) {
    if (semantic.decision.decision === 'included' || semantic.decision.decision === 'corrected') {
      return {
        reviewState: 'recovered',
        rationaleConflict: 'no',
        followUp: 'Issue #219 completed a candidate-specific expression fixedness review and ordinary shared admission. The exact fixed expression is searchable by its canonical lemma.',
      };
    }
    if (semantic.decision.decision === 'held'
      && semantic.decision.hold_basis === 'unresolved-lexical-unit') {
      return {
        reviewState: 'hold',
        rationaleConflict: 'no',
        followUp: 'Issue #219 keeps this exact expression on hold because no candidate-specific fixedness evidence is currently usable under the unresolved source terms. Keep it out of canonical admission until usable evidence is recorded.',
      };
    }
    if (semantic.decision.decision === 'rejected'
      && semantic.decision.rejection_basis === 'not-a-lexical-unit') {
      return {
        reviewState: 'not-a-lexical-unit',
        rationaleConflict: 'no',
        followUp: 'Issue #219 reviewed this exact phrase as a compositional scene description and rejected it as a lexical unit. Reopen only if evidence establishes a fixed whole-phrase use.',
      };
    }
    throw new Error(`Unexpected Issue #219 disposition for ${target.inventory_id}`);
  }

  if (semantic?.source.issueNumber === 211) {
    const historicalPolicyReject = issue204?.editorial_judgment.disposition === 'reject';
    if (semantic.decision.decision === 'included' || semantic.decision.decision === 'corrected') {
      return {
        reviewState: 'recovered',
        rationaleConflict: historicalPolicyReject ? 'yes' : 'no',
        followUp: 'Issue #211 completed a fresh source-bound review and ordinary shared admission. The canonical lemma is searchable under its exact identity; retain the earlier disposition as history and do not recreate this candidate.',
      };
    }
    if (semantic.decision.decision === 'held'
      && semantic.decision.hold_basis === 'unresolved-sense') {
      return {
        reviewState: 'needs-sense-split',
        rationaleConflict: historicalPolicyReject ? 'yes' : 'no',
        followUp: 'Issue #211 held this candidate because the proposed gloss collapses distinct uses. Source-bound sense boundaries must be resolved before admission.',
      };
    }
    throw new Error(`Unexpected Issue #211 disposition for ${target.inventory_id}`);
  }

  if (issue204) {
    const reviewState = issue204DispositionState(issue204);
    return {
      reviewState,
      rationaleConflict: issue204.editorial_judgment.disposition === 'reject' ? 'yes' : 'no',
      followUp: issue204.editorial_judgment.disposition === 'reject'
        ? 'Create a fresh source-bound lexical record and resolve lemma, POS, sense, duplicate, and search-collision checks in a bounded batch. The pilot supplied a lemma/POS proposal, not an admitted canonical body.'
        : issue204.editorial_judgment.disposition === 'needs-sense-split'
          ? 'Resolve the documented sense boundary before any admission decision; preserve each usable sense as a separate reviewed unit.'
          : issue204.editorial_judgment.disposition === 'search-surface-collision'
            ? 'Resolve the competing canonical search owner and intended lookup behavior before creating another record.'
            : 'Resolve the source-specific lexical or morphology blocker recorded in the Issue #204 rationale before re-review.',
    };
  }

  if (target.status === 'duplicate') {
    return {
      reviewState: 'duplicate',
      rationaleConflict: 'no',
      followUp: 'Keep the existing canonical sense as the owner; reopen only if evidence establishes a distinct lexical sense rather than a duplicate record.',
    };
  }
  if (target.status === 'inflected-form') {
    return {
      reviewState: 'invalid-lemma',
      rationaleConflict: 'no',
      followUp: `Use the cited base lemma (${target.related_canonical_id ?? 'see source artifact'}) as the lexical identity; do not admit this inflected surface as a separate entry.`,
    };
  }
  if (target.status === 'candidate') {
    return {
      reviewState: 'admit-candidate',
      rationaleConflict: 'no',
      followUp: 'Complete the normal source-bound lemma, POS, sense, and identity review; the historical candidate marker does not authorize admission.',
    };
  }
  if (target.status === 'deferred') {
    if (semantic?.decision.gloss_judgment === 'needs-context') {
      return {
        reviewState: 'hold',
        rationaleConflict: 'no',
        followUp: 'Resolve the missing context and lexical boundary from an authorized, source-bound example before reconsidering admission.',
      };
    }
    return {
      reviewState: 'admit-candidate',
      rationaleConflict: 'no',
      followUp: semantic?.decision.gloss_judgment === 'fit'
        ? 'Revisit only in a bounded batch under the current lexical-validity contract; prior fit and reserve status are evidence, not admission authorization.'
        : 'Recover an authored candidate body and complete normal lexical review in a bounded batch; the old capacity note alone is not admission evidence.',
    };
  }
  if (target.status === 'held') {
    const rationale = semantic?.decision.decision_rationale ?? target.decision_note ?? '';
    const hasPolicyConflictHistory = priorRejections.some(({ decision }) => (
      /writer-facing 증분|독립적인 검색 효용/u.test(decision.decision_note ?? '')
    ));
    return {
      reviewState: 'hold',
      rationaleConflict: hasPolicyConflictHistory
        ? 'mixed'
        : 'no',
      followUp: priorRejections.length > 0
        ? 'A later M5 snapshot keeps this row on hold. Resolve its recorded lemma, sense, or fixed-expression boundary before any bounded re-review; preserve the earlier rejection event as history.'
        : /needs-context|context|경계|분리|용법|뜻/u.test(rationale)
          ? 'Resolve the named context, lemma/POS, or sense-boundary issue with the corresponding source-bound editorial evidence before re-review.'
          : 'Recover the candidate-specific hold reason from its cited source artifact and resolve lexical validity before re-review.',
    };
  }
  if (target.status === 'rejected') {
    if (semantic?.decision.decision === 'rejected') {
      return {
        reviewState: 'hold',
        rationaleConflict: 'unclear',
        followUp: 'The durable rationale names review dimensions but does not preserve a candidate-specific lexical blocker. Establish whether the proposed multiword entry is a fixed lexical unit or a compositional phrase, then record evidence before re-review.',
      };
    }
    return {
      reviewState: 'hold',
      rationaleConflict: 'unclear',
      followUp: 'The recorded “insufficient admission priority” reason does not establish lexical invalidity or a confirmed policy-only rejection. Recover candidate-specific evidence before changing the disposition.',
    };
  }
  throw new Error(`Unexpected M5 seed status ${target.status} for ${target.inventory_id}`);
}

async function buildCurrentCoverage({
  database,
  canonicalRecords,
  seedTargets,
  referenceRows,
  referenceHistoryById,
  referenceHistoryBatch,
}) {
  const recordsById = new Map(canonicalRecords.map((record) => [record.id, record]));
  const expectedByKey = new Map();
  for (const record of canonicalRecords) {
    for (const key of stableUnique([record.lemma, ...(record.search_forms ?? [])])) {
      const owners = expectedByKey.get(key) ?? new Set();
      owners.add(record.id);
      expectedByKey.set(key, owners);
    }
  }

  const missingKeys = [];
  const unexpectedKeys = [];
  const directlySearchableIds = new Set();
  for (const [key, expectedOwners] of expectedByKey) {
    const response = findRecordsBySearchTerm(database, key);
    const exactMatches = response.matches.filter(({ match }) => match?.kind !== 'generated-surface-form');
    const actualOwners = new Set(exactMatches.map(({ id }) => id));
    for (const owner of expectedOwners) {
      if (!actualOwners.has(owner)) missingKeys.push({ key, expected_record_id: owner });
      else if (key === recordsById.get(owner)?.lemma) directlySearchableIds.add(owner);
    }
    for (const owner of actualOwners) {
      if (!expectedOwners.has(owner)) unexpectedKeys.push({ key, unexpected_record_id: owner });
    }
  }

  const inventoryCandidates = seedTargets
    .filter((target) => target.status !== 'promoted')
    .map((target) => ({
      ...target,
      current_canonical_coverage: candidateSearchCoverage(database, recordsById, target),
    }));
  const coveredReferences = referenceRows.map((record) => {
    const history = referenceHistoryById.get(record.id);
    return {
      id: record.id,
      lemma: record.lemma,
      record_type: record.record_type,
      historical_role_disposition: {
        current_role: record.role,
        prior_status: history?.status ?? null,
        planned_role: history?.planned_role ?? null,
      },
      historical_rationale: history?.decision_note ?? null,
      source_issue_batch_artifact: {
        issue: null,
        batch: referenceHistoryBatch,
        artifact: 'data/batches/m5-7-preimport-inventory.json',
      },
      pos: stableUnique(record.senses.map(({ pos }) => pos)).sort(),
      search_forms: record.search_forms,
      current_canonical_coverage: candidateSearchCoverage(database, recordsById, record),
    };
  });
  const directSearchNonSearchableRecords = canonicalRecords
    .filter((record) => !directlySearchableIds.has(record.id))
    .map(({ id, lemma, role, record_type: recordType }) => ({
      id,
      lemma,
      historical_role: role,
      record_type: recordType,
    }));

  return {
    recordsById,
    inventoryCandidates,
    referenceOnlyRecords: coveredReferences,
    searchMetrics: {
      canonical_record_count: canonicalRecords.length,
      directly_searchable_record_count: directlySearchableIds.size,
      current_non_searchable_lexical_record_count: directSearchNonSearchableRecords.length,
      current_non_searchable_lexical_records: directSearchNonSearchableRecords,
      exact_search_key_count: expectedByKey.size,
      missing_expected_key_owners: missingKeys,
      unexpected_key_owners: unexpectedKeys,
      cross_record_key_collision_count: [...expectedByKey.values()].filter((ids) => ids.size > 1).length,
      historical_role_counts: countBy(canonicalRecords, ({ role }) => role),
      role_and_record_type_counts: countBy(canonicalRecords, ({ role, record_type: recordType }) => `${role}/${recordType}`),
    },
  };
}

async function buildInventory() {
  const seed = await readJson('data/inventory/m5-target-seed.json');
  const issue204 = await readJson('data/batches/issue-204-pilot-decisions.json');
  const issue211CandidateSource = await readJson('data/batches/issue-211-lexical-unit-source.json');
  const issue211SemanticSource = await readJson('data/batches/issue-211-semantic-decisions.json');
  const issue219SemanticSource = await readJson('data/batches/issue-219-m9-a-semantic-decisions.json');
  const issue220SemanticSources = await Promise.all([
    readJson('data/batches/issue-220-m9-b-batch-01-semantic-decisions.json'),
    readJson('data/batches/issue-220-m9-b-batch-02-semantic-decisions.json'),
  ]);
  const issue220BaseInventory = await readJson('data/batches/issue-220-m9-b-base-issue-210-recovery-inventory.json');
  const issue221CandidateReview = await readJson('data/batches/issue-221-corpus-candidate-review.json');
  const issue221SemanticSource = await readJson('data/batches/issue-221-corpus-semantic-decisions.json');
  const issue222CorpusReviewNames = (await readdir(path.join(ROOT, 'data/batches')))
    .filter((name) => /^issue-222-m9-d-corpus-batch-\d+-candidate-review\.json$/u.test(name))
    .sort();
  const issue222CorpusCandidateReviews = await Promise.all(issue222CorpusReviewNames.map((name) => readJson(`data/batches/${name}`)));
  const issue222CorpusSemanticSources = await Promise.all(issue222CorpusReviewNames.map((name) => {
    const semanticName = name.replace(/-candidate-review\.json$/u, '-semantic-decisions.json');
    return readJson(`data/batches/${semanticName}`);
  }));
  const issue222CandidateReview = {
    issue: 222,
    parent_issue: 218,
    contract_version: 'm9-corpus-candidate-review-v1',
    decisions: issue222CorpusCandidateReviews.flatMap(({ decisions }) => decisions),
    decision_counts: issue222CorpusCandidateReviews.reduce((counts, review) => {
      for (const key of ['admit', 'hold', 'reject']) counts[key] += review.decision_counts[key];
      return counts;
    }, { admit: 0, hold: 0, reject: 0 }),
  };
  const issue222HistoricalCandidateSource = await readJson('data/batches/issue-222-m9-d-historical-candidate-source.json');
  const issue222HistoricalSemanticSource = await readJson('data/batches/issue-222-m9-d-historical-semantic-decisions.json');
  const issue222HistoricalBaseInventory = await readJson('data/batches/issue-222-m9-d-historical-base-recovery-inventory.json');
  const m5Three = await readJson('data/batches/m5-3-calibration.json');
  const m5Seven = await readJson('data/batches/m5-7-recalibration.json');
  const m5SevenPreimport = await readJson('data/batches/m5-7-preimport-inventory.json');
  const m5TenAPreimport = await readJson('data/batches/m5-10a-wave-a2-preimport-inventory.json');
  const m5TenADecisions = await readJson('data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json');
  const promotions = await readJsonl('data/inventory/m5-target-promotions.jsonl');
  const canonicalSource = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY, { useSharedContext: false });
  const canonical = createCanonicalContext(canonicalSource);
  const canonicalRecords = canonical.records.map(({ record }) => record);
  const referenceRows = canonicalRecords.filter(({ role }) => role === 'reference-only');
  const canonicalById = new Map(canonicalRecords.map((record) => [record.id, record]));
  const referenceHistoryById = new Map(m5SevenPreimport.entries
    .filter(({ source }) => source === 'canonical')
    .map((entry) => [entry.canonical_id, entry]));
  const seedByInventoryId = new Map(seed.targets.map((target) => [target.inventory_id, target]));
  const issue204ByInventoryId = new Map(issue204.decisions.map((decision) => [decision.inventory_id, decision]));
  const semanticSpecs = [
    ['data/batches/m5-12a-semantic-decisions.json', 138],
    ['data/batches/m5-13-semantic-decisions.json', 99],
    ['data/batches/m5-14-semantic-decisions.json', 100],
    ['data/batches/m5-15-semantic-decisions.json', 101],
  ];
  const semanticMaps = await Promise.all(semanticSpecs.map(async ([artifactPath, issueNumber]) => {
    const artifact = await readJson(artifactPath);
    return {
      artifactPath,
      issueNumber,
      batchId: artifact.batch_id,
      decisions: new Map((artifact.decisions ?? []).map((decision) => [decision.inventory_id, decision])),
    };
  }));
  const issue211CandidatesById = new Map(issue211SemanticSource.candidate_records.map((record) => [record.id, record]));
  const issue211UnitsByLemma = new Map(issue211CandidateSource.units.map((unit) => [unit.lemma, unit]));
  const issue211Decisions = new Map();
  for (const decision of issue211SemanticSource.decisions) {
    const candidate = issue211CandidatesById.get(decision.candidate_record_id);
    const unit = issue211UnitsByLemma.get(candidate?.lemma);
    assert.ok(candidate && unit, `Issue #211 crosswalk is missing ${decision.candidate_record_id}`);
    issue211Decisions.set(decision.inventory_id, decision);
    issue211Decisions.set(unit.prior_inventory_id, decision);
  }
  semanticMaps.push({
    artifactPath: 'data/batches/issue-211-semantic-decisions.json',
    issueNumber: 211,
    batchId: issue211SemanticSource.batch_id,
    decisions: issue211Decisions,
  });
  semanticMaps.push({
    artifactPath: 'data/batches/issue-219-m9-a-semantic-decisions.json',
    issueNumber: 219,
    batchId: issue219SemanticSource.batch_id,
    decisions: new Map(issue219SemanticSource.decisions.map((decision) => [decision.inventory_id, decision])),
  });
  semanticMaps.push({
    artifactPath: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
    issueNumber: 222,
    sourceClass: 'historical-recovery-inventory',
    batchId: issue222HistoricalSemanticSource.batch_id,
    decisions: new Map(issue222HistoricalSemanticSource.decisions.map((decision) => [decision.inventory_id, decision])),
  });
  for (const [index, artifact] of issue220SemanticSources.entries()) {
    semanticMaps.push({
      artifactPath: `data/batches/issue-220-m9-b-batch-${String(index + 1).padStart(2, '0')}-semantic-decisions.json`,
      issueNumber: 220,
      batchId: artifact.batch_id,
      decisions: new Map(artifact.decisions.map((decision) => [decision.inventory_id, decision])),
    });
  }
  const priorRejectionSpecs = [
    'data/batches/m5-5-recalibration.json',
    'data/batches/m5-7-recalibration.json',
    'data/batches/m5-9-expansion.json',
    'data/batches/m5-10-wave-a.json',
    'data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json',
    'data/batches/m5-12-base-inventory.json',
  ];
  const priorRejectionsById = new Map();
  for (const artifactPath of priorRejectionSpecs) {
    const artifact = artifactPath === 'data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json'
      ? m5TenADecisions
      : await readJson(artifactPath);
    const rows = artifact.records ?? artifact.entries ?? [];
    for (const decision of rows.filter((row) => (row.decision ?? row.status) === 'rejected')) {
      const events = priorRejectionsById.get(decision.inventory_id) ?? [];
      events.push({
        artifactPath,
        batchId: artifact.batch_id ?? artifact.revision,
        decision,
      });
      priorRejectionsById.set(decision.inventory_id, events);
    }
  }
  const seedStatuses = countBy(seed.targets, ({ status }) => status);
  const promotionIds = stableUnique(promotions.map(({ canonical_id: id }) => id));
  const promotedSeedRows = seed.targets.filter(({ status }) => status === 'promoted');
  const issue204Rejected = issue204.decisions.filter(
    ({ editorial_judgment: judgment }) => judgment.disposition === 'reject',
  );
  const issue204Admitted = issue204.decisions.filter(
    ({ editorial_judgment: judgment }) => judgment.disposition === 'admit',
  );
  const issue219Counts = issue219SemanticSource.review.decision_counts;
  const issue219InventoryIds = new Set(issue219SemanticSource.decisions.map(({ inventory_id: id }) => id));
  const issue219SeedIds = seed.targets.filter(({ inventory_id: id }) => issue219InventoryIds.has(id))
    .map(({ inventory_id: id }) => id);
  const expectedIssue219SeedIds = issue219SemanticSource.decisions
    .filter(({ decision }) => decision === 'held' || decision === 'rejected')
    .map(({ inventory_id: id }) => id);
  const issue219PromotionRows = promotions.filter(({ batch_id: id }) => id === issue219SemanticSource.batch_id);
  const issue220Decisions = issue220SemanticSources.flatMap(({ decisions }) => decisions);
  const issue220DecisionCounts = issue220Decisions.reduce((counts, { decision }) => {
    counts[decision] = (counts[decision] ?? 0) + 1;
    return counts;
  }, {});
  const issue220InventoryIds = new Set(issue220Decisions.map(({ inventory_id: id }) => id));
  const issue220SeedIds = seed.targets.filter(({ inventory_id: id }) => issue220InventoryIds.has(id))
    .map(({ inventory_id: id }) => id);
  const expectedIssue220SeedIds = issue220Decisions
    .filter(({ decision }) => decision === 'held' || decision === 'rejected')
    .map(({ inventory_id: id }) => id);
  const issue220PromotionRows = promotions.filter(({ batch_id: id }) => issue220SemanticSources.some((source) => source.batch_id === id));
  const issue221Decisions = issue221SemanticSource.decisions;
  const issue221AdmittedReviewRows = issue221CandidateReview.decisions
    .filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
  const issue221PromotionRows = promotions.filter(({ batch_id: id }) => id === issue221SemanticSource.batch_id);
  const issue222Decisions = issue222CorpusSemanticSources.flatMap(({ decisions }) => decisions);
  const issue222AdmittedReviewRows = issue222CorpusCandidateReviews.flatMap(({ decisions }) => decisions
    .filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit'));
  const issue222CorpusBatchIds = new Set(issue222CorpusSemanticSources.map(({ batch_id: id }) => id));
  const issue222CorpusPromotionRows = promotions.filter(({ batch_id: id }) => issue222CorpusBatchIds.has(id));
  const issue222HistoricalDecisions = issue222HistoricalSemanticSource.decisions;
  const issue222HistoricalPromotionDecisionCounts = issue222HistoricalDecisions.reduce((counts, { decision }) => {
    counts[decision] = (counts[decision] ?? 0) + 1;
    return counts;
  }, {});
  const issue222PromotionRows = issue222CorpusPromotionRows;
  const issue204RejectLemmas = issue204Rejected.map(({ morphology_proposal: proposal }) => proposal.lemma);

  assert.deepEqual(issue204RejectLemmas, EXPECTED_ISSUE_204_REJECTS, 'Issue #204 mandatory reject list changed');
  assert.deepEqual(issue219SeedIds, expectedIssue219SeedIds, 'Issue #219 held and rejected decisions must remain in the current seed');
  assert.equal(issue219PromotionRows.length, issue219Counts.included + issue219Counts.corrected, 'Issue #219 admissions must match the promotion ledger');
  assert.equal(issue220Decisions.length, 40, 'Issue #220 must preserve both complete 20-row decision batches');
  assert.deepEqual(
    [...issue220SeedIds].sort((left, right) => Number(left.slice(3)) - Number(right.slice(3))),
    [...expectedIssue220SeedIds].sort((left, right) => Number(left.slice(3)) - Number(right.slice(3))),
    'Issue #220 held rows remain visible while admitted rows leave seed ownership',
  );
  assert.equal(issue220PromotionRows.length, issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0), 'Issue #220 admissions must match the promotion ledger');
  assert.equal(issue221CandidateReview.decisions.length, 20, 'Issue #221 must preserve its complete bounded candidate review');
  assert.equal(issue221CandidateReview.decision_counts.admit, issue221AdmittedReviewRows.length);
  assert.equal(issue221Decisions.length, issue221AdmittedReviewRows.length, 'Issue #221 semantic decisions must cover every admitted corpus candidate');
  assert.ok(issue221Decisions.every(({ decision }) => decision === 'included'), 'Issue #221 corpus admissions must remain source-bound inclusions');
  assert.deepEqual(
    issue221Decisions.map(({ inventory_id: id, candidate_record_id: canonicalId }) => `${id}:${canonicalId}`).sort(),
    issue221AdmittedReviewRows.map(({ inventory_id: id, editorial_judgment: judgment }) => `${id}:${judgment.candidate_record_id}`).sort(),
    'Issue #221 semantic decisions must match the admitted rows in the corpus review',
  );
  assert.equal(issue221PromotionRows.length, issue221Decisions.length, 'Issue #221 admissions must match the promotion ledger');
  assert.deepEqual(
    issue221PromotionRows.map(({ inventory_id: id, canonical_id: canonicalId, decision }) => `${id}:${canonicalId}:${decision}`).sort(),
    issue221Decisions.map(({ inventory_id: id, candidate_record_id: canonicalId, decision }) => `${id}:${canonicalId}:${decision}`).sort(),
    'Issue #221 promotion rows must preserve the exact semantic decision identities',
  );
  assert.ok(issue221PromotionRows.every(({ decision_source_id: sourceId, decision_source_sha256: sourceDigest }) => (
    sourceId === issue221SemanticSource.source_id && sourceDigest === issue221SemanticSource.artifact_sha256
  )), 'Issue #221 promotion rows must bind the current authored semantic source');
  assert.ok(issue222CorpusCandidateReviews.length > 0, 'Issue #222 corpus review batches must remain discoverable');
  assert.equal(issue222CorpusCandidateReviews.length, issue222CorpusSemanticSources.length);
  for (const [index, candidateReview] of issue222CorpusCandidateReviews.entries()) {
    const semanticSource = issue222CorpusSemanticSources[index];
    const admittedRows = candidateReview.decisions.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
    const decisions = semanticSource.decisions;
    const batchPromotionRows = promotions.filter(({ batch_id: id }) => id === semanticSource.batch_id);
    assert.equal(candidateReview.issue, 222);
    assert.equal(candidateReview.parent_issue, 218);
    assert.equal(candidateReview.contract_version, 'm9-corpus-candidate-review-v1');
    assert.equal(candidateReview.decisions.length, candidateReview.selection.selected_candidate_count);
    assert.equal(semanticSource.batch_id, candidateReview.batch_id);
    assert.equal(decisions.length, admittedRows.length, `Issue #222 ${candidateReview.batch_id} semantic decisions must cover every admitted corpus candidate`);
    assert.ok(decisions.every(({ decision }) => decision === 'included'), 'Issue #222 corpus admissions must remain source-bound inclusions');
    assert.deepEqual(
      decisions.map(({ inventory_id: id, candidate_record_id: canonicalId }) => `${id}:${canonicalId}`).sort(),
      admittedRows.map(({ inventory_id: id, editorial_judgment: judgment }) => `${id}:${judgment.candidate_record_id}`).sort(),
      `Issue #222 ${candidateReview.batch_id} semantic decisions must match admitted review rows`,
    );
    assert.equal(batchPromotionRows.length, decisions.length, `Issue #222 ${candidateReview.batch_id} admissions must match the promotion ledger`);
    assert.deepEqual(
      batchPromotionRows.map(({ inventory_id: id, canonical_id: canonicalId, decision }) => `${id}:${canonicalId}:${decision}`).sort(),
      decisions.map(({ inventory_id: id, candidate_record_id: canonicalId, decision }) => `${id}:${canonicalId}:${decision}`).sort(),
      `Issue #222 ${candidateReview.batch_id} promotion rows must preserve semantic decision identities`,
    );
    assert.ok(batchPromotionRows.every(({ decision_source_id: sourceId, decision_source_sha256: sourceDigest }) => (
      sourceId === semanticSource.source_id && sourceDigest === semanticSource.artifact_sha256
    )), `Issue #222 ${candidateReview.batch_id} promotions must bind its current semantic source`);
  }
  assert.equal(issue222Decisions.length, issue222AdmittedReviewRows.length, 'Issue #222 semantic decisions must cover every admitted corpus candidate');
  assert.equal(issue222HistoricalCandidateSource.issue, 222);
  assert.equal(issue222HistoricalCandidateSource.source_class, 'historical-recovery-inventory');
  assert.equal(issue222HistoricalCandidateSource.candidates.length, 20);
  assert.equal(issue222HistoricalDecisions.length, issue222HistoricalCandidateSource.candidates.length);
  assert.ok(issue222HistoricalDecisions
    .filter(({ decision }) => decision === 'included' || decision === 'corrected')
    .every(({ candidate_record_id: canonicalId, inventory_id: inventoryId }) => {
      const seedRow = seedByInventoryId.get(inventoryId);
      return seedRow?.status === 'promoted' && seedRow.canonical_id === canonicalId;
    }), 'Issue #222 historical admissions must be embedded in the current M5 seed without duplicate ledger rows');
  const issue223PromotionRows = promotions.filter(({ batch_id: id }) => id.startsWith('issue-223-m9-e-corpus-batch-'));
  assert.equal(issue223PromotionRows.length, 1206, 'Issue #223 B01-B04 canonical imports must match the promotion ledger');
  assert.equal(promotions.some(({ batch_id: id }) => id === 'issue-223-m9-e-corpus-batch-05-20261001'), false,
    'Issue #223 B05 review-only decisions must stay outside the promotion ledger');
  assert.equal(seedStatuses.promoted, 998, 'M5 promoted seed row count changed');
  assert.equal(
    promotions.length,
    3756 + issue219PromotionRows.length + issue220PromotionRows.length + issue221PromotionRows.length + issue222PromotionRows.length + issue223PromotionRows.length,
    'Issue #219/#220/#221/#222/#223 promotion ledger row count changed',
  );
  assert.equal(issue204.decisions.length, 100, 'Issue #204 decision overlay row count changed');
  assert.equal(issue204Admitted.length, 10, 'Issue #204 admitted row count changed');
  assert.equal(issue204.decisions.filter(({ inventory_id: id }) => seedByInventoryId.has(id)).length, 90, 'Issue #204/M5 target overlay row count changed');
  assert.equal(referenceRows.length, 42, 'Current reference-only population changed');
  assert.ok(referenceRows.every(({ id }) => referenceHistoryById.has(id)), 'A current reference-only record has no M5-7 historical role note');
  assert.ok(issue204.decisions.every((decision) => (
    seedByInventoryId.has(decision.inventory_id)
    || (decision.editorial_judgment.disposition === 'admit'
      && decision.editorial_judgment.canonical_record_ids.every((id) => canonicalById.has(id)))
  )), 'Issue #204 overlay row is absent from M5 target inventory or current canonical data');
  assert.ok(promotedSeedRows.every(({ canonical_id: id }) => canonicalById.has(id)), 'Promoted seed row is missing from current canonical data');
  assert.ok(promotionIds.every((id) => canonicalById.has(id)), 'Promotion ledger includes a record absent from current canonical data');

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-210-'));
  const databasePath = path.join(temporaryDirectory, 'dictionary.sqlite');
  let database;
  try {
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath: databasePath,
      checkPilotCompleteness: true,
      repositoryDirectory: ROOT,
      allowDirty: true,
      canonicalContext: canonical,
    });
    database = new DatabaseSync(databasePath, { readOnly: true });
    const coverage = await buildCurrentCoverage({
      database,
      canonicalRecords,
      seedTargets: seed.targets,
      referenceRows,
      referenceHistoryById,
      referenceHistoryBatch: m5SevenPreimport.revision,
    });
    const { recordsById, inventoryCandidates, referenceOnlyRecords, searchMetrics } = coverage;
    assert.equal(inventoryCandidates.length, seed.targets.length - promotedSeedRows.length, 'M5 non-promoted inventory rows match the seed');
    assert.equal(searchMetrics.current_non_searchable_lexical_record_count, 0, 'Current canonical searchable coverage regressed');
    assert.deepEqual(searchMetrics.missing_expected_key_owners, [], 'A canonical lemma/search form no longer resolves directly');
    assert.deepEqual(searchMetrics.unexpected_key_owners, [], 'A direct exact key resolves outside its canonical owners');
    assert.equal(searchMetrics.cross_record_key_collision_count, 0, 'Canonical exact key collision count changed');
    assert.ok(referenceOnlyRecords.every(({ id, current_canonical_coverage: item }) => (
      item.exact_lemma_match_ids.includes(id)
    )), 'A current reference-only record is not reachable by its canonical lemma');

    const entries = inventoryCandidates.map((target) => {
      const issueDecision = issue204ByInventoryId.get(target.inventory_id);
      const semantic = semanticSourceInfo(target.inventory_id, semanticMaps);
      const priorRejections = priorRejectionsById.get(target.inventory_id) ?? [];
      const classification = classifyTarget(target, issueDecision, semantic, priorRejections);
      const history = [makeHistoryEvent({
        issueNumber: null,
        batchId: seed.revision,
        artifactPath: 'data/inventory/m5-target-seed.json',
        disposition: target.status,
        rationale: target.decision_note,
      })];
      if (semantic) {
        const { source, decision } = semantic;
        history.push(makeHistoryEvent({
          issueNumber: source.issueNumber,
          batchId: source.batchId,
          artifactPath: source.artifactPath,
          disposition: `${decision.decision}${decision.gloss_judgment ? `/${decision.gloss_judgment}` : ''}`,
          rationale: decision.decision_rationale,
        }));
      }
      if (issueDecision) {
        history.push(makeHistoryEvent({
          issueNumber: 204,
          batchId: issue204.batch_id,
          artifactPath: 'data/batches/issue-204-pilot-decisions.json',
          disposition: issueDecision.editorial_judgment.disposition,
          rationale: issueDecision.editorial_judgment.rationale,
        }));
      }
      for (const priorRejection of priorRejections) {
        history.push(makeHistoryEvent({
          issueNumber: null,
          batchId: priorRejection.batchId,
          artifactPath: priorRejection.artifactPath,
          disposition: priorRejection.decision.decision ?? priorRejection.decision.status,
          rationale: priorRejection.decision.decision_note ?? priorRejection.decision.decision_rationale ?? null,
        }));
      }
      if (priorRejections.some(({ artifactPath }) => artifactPath === 'data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json')) {
        const laterSnapshot = m5TenAPreimport.entries.find(({ inventory_id: id }) => id === target.inventory_id);
        if (laterSnapshot) {
          history.push(makeHistoryEvent({
            issueNumber: null,
            batchId: m5TenAPreimport.revision,
            artifactPath: 'data/batches/m5-10a-wave-a2-preimport-inventory.json',
            disposition: laterSnapshot.status,
            rationale: laterSnapshot.decision_note,
          }));
        }
      }
      const sourceRefs = stableUnique(history.map(({ source_artifact: artifactPath }) => artifactPath));
      assert.ok(ALLOWED_REVIEW_STATES.has(classification.reviewState), `Invalid review state for ${target.inventory_id}`);
      return {
        source_issue_batch_artifacts: sourceRefs.map((artifactPath) => {
          const event = history.find(({ source_artifact: candidatePath }) => candidatePath === artifactPath);
          return {
            issue: event.source_issue,
            batch: event.source_batch,
            artifact: artifactPath,
          };
        }),
        source_inventory_id: target.inventory_id,
        lemma: target.lemma,
        proposed_pos: target.pos,
        record_type: target.record_type,
        search_forms: target.search_forms,
        historical_role_disposition: {
          planned_role: target.planned_role,
          disposition: target.status,
          related_canonical_id: target.related_canonical_id ?? null,
        },
        historical_rationale: target.decision_note,
        historical_decision_events: history,
        current_canonical_search_coverage: target.current_canonical_coverage,
        historical_rationale_conflicts_with_new_invariant: classification.rationaleConflict,
        new_review_state: classification.reviewState,
        follow_up_reason_and_evidence: classification.followUp,
      };
    });

    const issue220RecoveredRows = issue220Decisions
      .filter(({ decision }) => decision === 'included' || decision === 'corrected')
      .map((decision) => {
        const source = semanticMaps.find((item) => item.issueNumber === 220
          && item.decisions.has(decision.inventory_id));
        const batchNumber = issue220SemanticSources.findIndex(({ batch_id: batchId }) => batchId === source?.batchId) + 1;
        const candidateSourcePath = `data/batches/issue-220-m9-b-batch-${String(batchNumber).padStart(2, '0')}-lexical-unit-source.json`;
        const semanticSourcePath = source?.artifactPath;
        const prior = issue220BaseInventory.recovery_candidates.find(({ source_inventory_id: id }) => id === decision.inventory_id);
        const promotion = issue220PromotionRows.find(({ inventory_id: id }) => id === decision.inventory_id);
        const record = promotion ? canonicalById.get(promotion.canonical_id) : null;
        assert.ok(source && prior && promotion && record, `Issue #220 recovered history is incomplete for ${decision.inventory_id}`);
        const history = [
          ...prior.historical_decision_events,
          makeHistoryEvent({
            issueNumber: 220,
            batchId: source.batchId,
            artifactPath: semanticSourcePath,
            disposition: decision.decision,
            rationale: decision.decision_rationale,
          }),
        ];
        const sourceArtifacts = [
          ...prior.source_issue_batch_artifacts,
          { issue: 220, batch: source.batchId, artifact: candidateSourcePath },
          { issue: 220, batch: source.batchId, artifact: semanticSourcePath },
          { issue: 220, batch: 'm9-b-recovery-selection-v1', artifact: 'data/batches/issue-220-m9-b-selection.json' },
        ];
        const seenArtifacts = new Set();
        return {
          ...prior,
          source_issue_batch_artifacts: sourceArtifacts.filter(({ artifact }) => {
            if (seenArtifacts.has(artifact)) return false;
            seenArtifacts.add(artifact);
            return true;
          }),
          historical_decision_events: history,
          current_canonical_id: record.id,
          current_canonical_search_coverage: candidateSearchCoverage(database, recordsById, record),
          historical_rationale_conflicts_with_new_invariant: 'no',
          new_review_state: 'recovered',
          follow_up_reason_and_evidence: 'Issue #220 independently re-reviewed the historical source row and admitted this candidate through the ordinary shared lexical producer, semantic audit, and admission ledger. Its exact canonical lemma resolves to the same record ID; retain prior M5 fit and reserve decisions as history only.',
        };
      });
    assert.equal(issue220RecoveredRows.length, issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0));
    assert.ok(issue220RecoveredRows.every(({ current_canonical_id: id, current_canonical_search_coverage: coverage }) => (
      id && coverage.exact_lemma_match_ids.includes(id)
    )), 'Every Issue #220 recovered record must resolve under its exact canonical lemma');
    entries.push(...issue220RecoveredRows);
    const issue222HistoricalRecoveredRows = issue222HistoricalSemanticSource.decisions
      .filter(({ decision }) => decision === 'included' || decision === 'corrected')
      .map((decision) => {
        const prior = issue222HistoricalBaseInventory.recovery_candidates.find(({ source_inventory_id: id }) => id === decision.inventory_id);
        const candidate = issue222HistoricalCandidateSource.candidates.find(({ inventory_id: id }) => id === decision.inventory_id);
        const currentSeedRow = seedByInventoryId.get(decision.inventory_id);
        const record = currentSeedRow ? canonicalById.get(currentSeedRow.canonical_id) : null;
        assert.ok(prior && candidate && currentSeedRow?.status === 'promoted' && record, `Issue #222 historical recovery is incomplete for ${decision.inventory_id}`);
        assert.equal(record.id, decision.candidate_record_id, `Issue #222 historical canonical ID changed for ${decision.inventory_id}`);
        const history = [
          ...prior.historical_decision_events,
          makeHistoryEvent({
            issueNumber: 222,
            batchId: issue222HistoricalSemanticSource.batch_id,
            artifactPath: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json',
            disposition: decision.decision,
            rationale: decision.decision_rationale,
          }),
        ];
        const sourceArtifacts = [
          ...prior.source_issue_batch_artifacts,
          { issue: 222, batch: issue222HistoricalSemanticSource.batch_id, artifact: 'data/batches/issue-222-m9-d-historical-base-recovery-inventory.json' },
          { issue: 222, batch: issue222HistoricalSemanticSource.batch_id, artifact: 'data/batches/issue-222-m9-d-historical-base-m5-target-seed.json' },
          { issue: 222, batch: issue222HistoricalSemanticSource.batch_id, artifact: 'data/batches/issue-222-m9-d-historical-candidate-source.json' },
          { issue: 222, batch: issue222HistoricalSemanticSource.batch_id, artifact: 'data/batches/issue-222-m9-d-historical-semantic-decisions.json' },
          { issue: 222, batch: issue222HistoricalSemanticSource.batch_id, artifact: 'data/canonical/issue-222-m9-d-historical-batch-01.jsonl' },
        ];
        const seenArtifacts = new Set();
        return {
          ...prior,
          source_issue_batch_artifacts: sourceArtifacts.filter(({ artifact }) => {
            if (seenArtifacts.has(artifact)) return false;
            seenArtifacts.add(artifact);
            return true;
          }),
          historical_decision_events: history,
          current_canonical_id: record.id,
          current_canonical_search_coverage: candidateSearchCoverage(database, recordsById, record),
          historical_rationale_conflicts_with_new_invariant: 'no',
          new_review_state: 'recovered',
          follow_up_reason_and_evidence: 'Issue #222 re-reviewed this bounded historical candidate against the frozen Issue #210 inventory and exact M5 seed row, then admitted its current identity and authored meaning through ordinary shared production. Keep the earlier inventory disposition as history only.',
        };
      });
    assert.equal(issue222HistoricalRecoveredRows.length, issue222HistoricalPromotionDecisionCounts.included + (issue222HistoricalPromotionDecisionCounts.corrected ?? 0));
    assert.ok(issue222HistoricalRecoveredRows.every(({ current_canonical_id: id, current_canonical_search_coverage: coverage }) => (
      id && coverage.exact_lemma_match_ids.includes(id)
    )), 'Every Issue #222 historical record must resolve under its exact canonical lemma');
    entries.push(...issue222HistoricalRecoveredRows);
    entries.sort((left, right) => Number(left.source_inventory_id.slice(3)) - Number(right.source_inventory_id.slice(3)));

    const resolvedIds = ['m5-019', 'm5-034', 'm5-053', 'm5-060'];
    const resolvedPolicyCases = resolvedIds.map((inventoryId) => {
      const oldDecision = m5Three.records.find(({ inventory_id: id }) => id === inventoryId);
      const correction = m5Seven.records.find(({ inventory_id: id }) => id === inventoryId);
      const seedRow = seedByInventoryId.get(inventoryId);
      assert.ok(oldDecision && correction && seedRow?.status === 'promoted', `Missing resolved policy history for ${inventoryId}`);
      const record = canonicalById.get(seedRow.canonical_id);
      assert.ok(record, `Resolved policy case ${inventoryId} has no current canonical record`);
      return {
        source_inventory_id: inventoryId,
        lemma: record.lemma,
        current_canonical_id: record.id,
        proposed_pos: stableUnique(record.senses.map(({ pos }) => pos)).sort(),
        historical_role_disposition: { old_role: oldDecision.role, old_disposition: oldDecision.decision },
        historical_rationale: oldDecision.decision_note,
        historical_decision_events: [
          makeHistoryEvent({
            batchId: m5Three.batch_id,
            artifactPath: 'data/batches/m5-3-calibration.json',
            disposition: oldDecision.decision,
            rationale: oldDecision.decision_note,
          }),
          makeHistoryEvent({
            batchId: m5Seven.batch_id,
            artifactPath: 'data/batches/m5-7-recalibration.json',
            disposition: correction.decision,
            rationale: correction.decision_note,
          }),
        ],
        current_canonical_search_coverage: candidateSearchCoverage(database, recordsById, record),
        historical_rationale_conflicts_with_new_invariant: 'yes',
        resolution: 'already-recovered-and-searchable',
        follow_up_reason_and_evidence: 'M5-7 corrected and included this record; the current canonical lemma and search forms resolve to the same record ID. Do not recreate or count it as an outstanding batch candidate.',
      };
    });
    assert.ok(resolvedPolicyCases.every(({ current_canonical_id: id, current_canonical_search_coverage: item }) => (
      item.all_query_match_ids.includes(id)
    )), 'A corrected historical policy case is not directly searchable now');

    const alreadyAdmittedIssue204 = issue204.decisions
      .filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit')
      .map((decision) => {
        const { morphology_proposal: proposal, editorial_judgment: judgment } = decision;
        const canonicalIds = judgment.canonical_record_ids;
        assert.ok(canonicalIds.length > 0 && canonicalIds.every((id) => canonicalById.has(id)), `Admitted Issue #204 row ${decision.inventory_id} has no current canonical record`);
        return {
          source_inventory_id: decision.inventory_id,
          candidate_ordinal: decision.candidate_ordinal,
          lemma: proposal.lemma,
          proposed_pos: [proposal.pos],
          historical_role_disposition: { source_issue: 204, disposition: judgment.disposition },
          historical_rationale: judgment.rationale,
          current_canonical_ids: canonicalIds,
          source_issue_batch_artifacts: [
            { issue: 204, batch: issue204.batch_id, artifact: 'data/batches/issue-204-pilot-decisions.json' },
            { issue: 204, batch: 'issue-204 authored semantic review', artifact: 'data/batches/issue-204-semantic-decisions.json' },
          ],
          current_canonical_search_coverage: candidateSearchCoverage(database, recordsById, {
            lemma: proposal.lemma,
            search_forms: [proposal.lemma],
          }),
          resolution: 'already-admitted-and-searchable',
          follow_up_reason_and_evidence: 'Issue #204 already admitted this candidate and names the current canonical record ID. It is tracked for accounting and search parity, not counted as an outstanding recovery candidate.',
        };
      });
    assert.equal(alreadyAdmittedIssue204.length, 10);
    assert.ok(alreadyAdmittedIssue204.every(({ current_canonical_ids: ids, current_canonical_search_coverage: current }) => (
      ids.every((id) => current.all_query_match_ids.includes(id))
    )), 'An Issue #204 admitted record is not reachable by its proposed lemma');

    const sourceManifest = await buildSourceManifest();
    const sourceHashByPath = new Map(sourceManifest.map(({ path: sourcePath, sha256: digest }) => [sourcePath, digest]));
    const sourceRefs = entries.flatMap(({ source_issue_batch_artifacts: refs }) => refs);
    const absentSourceRefs = stableUnique(sourceRefs.map(({ artifact }) => artifact))
      .filter((artifact) => !sourceHashByPath.has(artifact));
    assert.deepEqual(absentSourceRefs, [], 'An inventory row references an unhashed source artifact');

    const reviewStateCounts = countBy(entries, ({ new_review_state: reviewState }) => reviewState);
    const policyOpen = entries.filter(({ source_inventory_id: id, new_review_state: state }) => (
      state === 'admit-candidate' && issue204ByInventoryId.get(id)?.editorial_judgment.disposition === 'reject'
    ));
    const oldUsefulnessRejects = ['m5-360', 'm5-361']
      .map((id) => priorRejectionsById.get(id)?.find(({ artifactPath }) => (
        artifactPath === 'data/batches/m5-10a-wave-a2-editorial-decisions-20260909.json'
      ))?.decision);
    assert.ok(oldUsefulnessRejects.every((decision) => decision?.decision === 'rejected'), 'M5-10A2 policy conflict trace changed');
    const rejectedThenHeldIds = [...priorRejectionsById.keys()]
      .filter((id) => seedByInventoryId.get(id)?.status === 'held');
    assert.equal(rejectedThenHeldIds.length, 11, 'Earlier M5 rejection-to-hold history count changed');
    const issue204MandatoryEntries = entries.filter(({ source_inventory_id: id }) => (
      issue204ByInventoryId.get(id)?.editorial_judgment.disposition === 'reject'
    ));
    const issue204MandatoryLemmas = issue204MandatoryEntries.map(({ lemma }) => lemma);
    assert.equal(entries.length, seed.targets.length - promotedSeedRows.length + issue220RecoveredRows.length + issue222HistoricalRecoveredRows.length);
    assert.equal(policyOpen.length, 0);
    assert.deepEqual(issue204MandatoryLemmas, EXPECTED_ISSUE_204_REJECTS);
    assert.equal(reviewStateCounts['admit-candidate'], 228);
    assert.equal(reviewStateCounts.hold, 251);
    assert.equal(reviewStateCounts['needs-sense-split'], 28);
    assert.equal(reviewStateCounts.recovered, 62);
    assert.equal(reviewStateCounts.duplicate, 2);
    assert.equal(reviewStateCounts['search-surface-collision'], 1);
    assert.equal(reviewStateCounts['invalid-lemma'], 2);
    assert.equal(reviewStateCounts['not-a-lexical-unit'], 10);
    assert.equal(issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0), 18);
    assert.equal(issue220DecisionCounts.held, 22);
    assert.equal(issue220DecisionCounts.rejected ?? 0, 0);
    assert.ok(['m5-360', 'm5-361'].every((id) => (
      entries.find(({ source_inventory_id: entryId }) => entryId === id)?.historical_rationale_conflicts_with_new_invariant === 'mixed'
    )), 'M5-10A2 usefulness conflicts must remain visible alongside the later holds');

    const explicitSensePosContextCases = entries.filter(({ source_inventory_id: id, new_review_state: state }) => {
      const issueDecision = issue204ByInventoryId.get(id);
      const semantic = semanticSourceInfo(id, semanticMaps);
      return state === 'needs-sense-split'
        || issueDecision?.editorial_judgment.disposition === 'hold'
        || semantic?.decision.gloss_judgment === 'needs-context';
    }).length;
    const unsupportedLexicalCategoryCount = entries.filter(({ proposed_pos: pos, record_type: recordType }) => (
      pos.some((value) => !['noun', 'adjective', 'verb', 'adverb', 'expression'].includes(value))
      || !['entry', 'expression'].includes(recordType)
    )).length;
    assert.equal(explicitSensePosContextCases, 204);
    assert.equal(unsupportedLexicalCategoryCount, 0);
    const remainingCapacityReserveCount = entries.filter(({ historical_decision_events: events, new_review_state: state }) => (
      state === 'admit-candidate'
      && events.some((event) => event.historical_rationale?.includes('selection=reserve'))
    )).length;
    const remainingLegacyAndOpenCandidateCount = (reviewStateCounts['admit-candidate'] ?? 0) - remainingCapacityReserveCount;
    const potentiallyRecoverableHistoricalRows = (reviewStateCounts['admit-candidate'] ?? 0)
      + (reviewStateCounts.hold ?? 0)
      + (reviewStateCounts['needs-sense-split'] ?? 0);
    const historicalRecoveryCeiling = searchMetrics.canonical_record_count + potentiallyRecoverableHistoricalRows;
    assert.equal(potentiallyRecoverableHistoricalRows, 507, 'Remaining historical Issue #210 recovery pool changed');

    const mandatoryIssue204Rejects = entries
      .filter(({ source_inventory_id: id }) => (
        issue204ByInventoryId.get(id)?.editorial_judgment.disposition === 'reject'
      ))
      .map((entry) => {
        const decision = issue204ByInventoryId.get(entry.source_inventory_id);
        return {
          candidate_ordinal: decision.candidate_ordinal,
          source_inventory_id: entry.source_inventory_id,
          lemma: entry.lemma,
          proposed_pos: entry.proposed_pos,
          historical_rationale: decision.editorial_judgment.rationale,
          current_canonical_coverage: entry.current_canonical_search_coverage,
          historical_rationale_conflicts_with_new_invariant: entry.historical_rationale_conflicts_with_new_invariant,
          new_review_state: entry.new_review_state,
          follow_up_reason_and_evidence: entry.follow_up_reason_and_evidence,
        };
      })
      .sort((left, right) => left.candidate_ordinal - right.candidate_ordinal);
    assert.equal(mandatoryIssue204Rejects.length, EXPECTED_ISSUE_204_REJECTS.length);

    const inventory = {
      schema_version: 1,
      inventory_id: 'issue-210-historical-exclusion-recovery-v1',
      generated_from: {
        policy_source: 'Issue #207; Issues #208 and #209 are complete prerequisites.',
        searchable_lexical_invariant: 'Every valid lexical entry within Typewriter supported lexical scope may serve as a searchable start.',
        current_canonical_revision: canonical.canonicalRevision ?? null,
        source_manifest: sourceManifest,
      },
      audit_scope: {
        m1_m4: 'Reviewed the durable M1 pilot selection, canonical pilot records, M3/M4 handoffs, and current reference-only population. These artifacts do not contain a complete durable candidate rejection/defer ledger; no missing ephemeral output or external material was reconstructed.',
        m5: `Screened all ${(seed.targets.length + issue220RecoveredRows.length).toLocaleString('en-US')} M5 target rows, including Issue #220 recoveries; joined preserved M5-12A through M5-15 semantic decisions, M5-10A2 rejections, M5-3/M5-7 correction history, and source-bound Issue #211/#219/#220 recovery outcomes. Issue #219 reviewed ${issue219SemanticSource.review.reviewed_candidate_count} expressions; Issue #220 reviewed ${issue220Decisions.length} historical reserves, admitting ${issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0)} and holding ${issue220DecisionCounts.held}.`,
        m6: 'Bound current search coverage to the M6-1 searchable baseline and a fresh exact-key runtime query over the current canonical JSONL.',
        issue_204: `Joined all 100 Issue #204 pilot decisions. Ninety decision rows overlay the M5 target inventory; the ten admitted rows are tracked separately against their current canonical IDs. Issue #211 crosswalks all 25 former rejects to 24 recovered records and one held sense split. Issue #219 reviewed ${issue219SemanticSource.review.reviewed_candidate_count} previously capacity-deferred M5-15 expressions; Issue #220 then reviewed ${issue220Decisions.length} M5-13 reserve candidates and admitted ${issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0)} through current shared admission.`,
        issue_221: `Issue #221 separately reviewed ${issue221CandidateReview.decisions.length} bounded corpus-derived proposals: ${issue221AdmittedReviewRows.length} passed ordinary source-bound lexical admission and entered the promotion ledger, while ${issue221CandidateReview.decision_counts.hold} remain held. These corpus records are not added to the historical M5 recovery candidate pool; publication remains pending owner confirmation.`,
        issue_222: `Issue #222 reviewed ${issue222CandidateReview.decisions.length} bounded corpus-derived proposals and ${issue222HistoricalCandidateSource.candidates.length} candidates from the frozen historical recovery inventory. Corpus review admitted ${issue222AdmittedReviewRows.length}, held ${issue222CandidateReview.decision_counts.hold}, and rejected ${issue222CandidateReview.decision_counts.reject}; historical review admitted ${issue222HistoricalPromotionDecisionCounts.included + (issue222HistoricalPromotionDecisionCounts.corrected ?? 0)} through ordinary shared admission. The 28 admitted records increase directly searchable canonical coverage to ${searchMetrics.directly_searchable_record_count.toLocaleString('en-US')}; corpus source text remains local-reference-only pending owner publication confirmation. The separate M9-D scale checkpoint tracks the remaining gap to approximately 7,500 records.`,
        source_material_boundary: 'Uses tracked Typewriter decision artifacts and text-free Issue #221/#222 provenance only. It does not reconstruct ephemeral LLM output or include raw external/corpus source material.',
      },
      summary: {
        m5_target_rows_screened: seed.targets.length + issue220RecoveredRows.length,
        m5_target_status_counts: seedStatuses,
        m5_promoted_seed_rows_present_in_canonical: promotedSeedRows.length,
        m5_promotion_ledger_events_audited: promotions.length,
        issue_204_decisions_audited: issue204.decisions.length,
        issue_219_decisions_audited: issue219SemanticSource.review.reviewed_candidate_count,
        issue_219_admitted_count: issue219Counts.included + issue219Counts.corrected,
        issue_219_held_count: issue219Counts.held,
        issue_219_rejected_count: issue219Counts.rejected,
        issue_220_decisions_audited: issue220Decisions.length,
        issue_220_admitted_count: issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0),
        issue_220_held_count: issue220DecisionCounts.held,
        issue_220_rejected_count: issue220DecisionCounts.rejected ?? 0,
        issue_220_priority_reserve_remaining: remainingCapacityReserveCount,
        issue_220_historical_candidate_pool_count: issue220BaseInventory.recovery_candidates.length,
        issue_221_candidates_reviewed: issue221CandidateReview.decisions.length,
        issue_221_admitted_count: issue221AdmittedReviewRows.length,
        issue_221_held_count: issue221CandidateReview.decision_counts.hold,
        issue_221_rejected_count: issue221CandidateReview.decision_counts.reject,
        issue_221_promotion_events_audited: issue221PromotionRows.length,
        issue_222_candidates_reviewed: issue222CandidateReview.decisions.length + issue222HistoricalCandidateSource.candidates.length,
        issue_222_admitted_count: issue222AdmittedReviewRows.length + issue222HistoricalPromotionDecisionCounts.included + (issue222HistoricalPromotionDecisionCounts.corrected ?? 0),
        issue_222_corpus_candidates_reviewed: issue222CandidateReview.decisions.length,
        issue_222_corpus_admitted_count: issue222AdmittedReviewRows.length,
        issue_222_held_count: issue222CandidateReview.decision_counts.hold,
        issue_222_rejected_count: issue222CandidateReview.decision_counts.reject,
        issue_222_historical_candidates_reviewed: issue222HistoricalCandidateSource.candidates.length,
        issue_222_historical_admitted_count: issue222HistoricalPromotionDecisionCounts.included + (issue222HistoricalPromotionDecisionCounts.corrected ?? 0),
        issue_222_historical_held_count: issue222HistoricalPromotionDecisionCounts.held ?? 0,
        issue_222_historical_rejected_count: issue222HistoricalPromotionDecisionCounts.rejected ?? 0,
        issue_222_promotion_events_audited: issue222PromotionRows.length,
        historical_recovery_ceiling_count: historicalRecoveryCeiling,
        historical_recovery_shortfall_to_6000: Math.max(0, 6000 - historicalRecoveryCeiling),
        issue_204_decisions_overlaid_on_m5_targets: issue204.decisions.filter(({ inventory_id: id }) => seedByInventoryId.has(id)).length,
        already_admitted_issue_204_count: alreadyAdmittedIssue204.length,
        recovery_candidate_count: entries.length,
        current_reference_only_record_count: referenceOnlyRecords.length,
        resolved_historical_policy_case_count: resolvedPolicyCases.length,
        issue_204_mandatory_reject_count: issue204MandatoryEntries.length,
        historical_policy_rejection_events: issue204MandatoryEntries.length + oldUsefulnessRejects.length + resolvedPolicyCases.length,
        m5_10a_usefulness_rejections_later_held: oldUsefulnessRejects.length,
        historical_rejection_to_hold_transitions: rejectedThenHeldIds.length,
        confirmed_active_usefulness_or_generality_exclusions: policyOpen.length,
        current_non_searchable_lexical_record_count: searchMetrics.current_non_searchable_lexical_record_count,
        directly_searchable_canonical_record_count: searchMetrics.directly_searchable_record_count,
        exact_search_key_count: searchMetrics.exact_search_key_count,
        true_duplicate_count: reviewStateCounts.duplicate ?? 0,
        invalid_lemma_count: reviewStateCounts['invalid-lemma'] ?? 0,
        non_lexical_proposal_count_confirmed: reviewStateCounts['not-a-lexical-unit'] ?? 0,
        unresolved_sense_pos_or_context_case_count: explicitSensePosContextCases,
        additional_rationale_or_lexical_unit_holds: (reviewStateCounts.hold ?? 0) - (explicitSensePosContextCases - (reviewStateCounts['needs-sense-split'] ?? 0)),
        search_collision_count: reviewStateCounts['search-surface-collision'] ?? 0,
        unsupported_scope_candidate_count: reviewStateCounts['unsupported-scope'] ?? 0,
        unsupported_lexical_category_count: unsupportedLexicalCategoryCount,
        review_state_counts: reviewStateCounts,
        reference_only_by_record_type: countBy(referenceOnlyRecords, ({ record_type: type }) => type),
        reference_only_by_pos: referenceOnlyRecords.reduce((counts, row) => {
          for (const pos of row.pos) counts[pos] = (counts[pos] ?? 0) + 1;
          return counts;
        }, {}),
        all_candidate_search_coverage_checked: entries.every(({ current_canonical_search_coverage: item }) => Array.isArray(item.queries) && item.queries.length > 0),
        all_reference_only_lemmas_reachable: referenceOnlyRecords.every(({ id, current_canonical_coverage: item }) => item.exact_lemma_match_ids.includes(id)),
      },
      search_coverage: searchMetrics,
      recovery_candidates: entries,
      current_reference_only_records: referenceOnlyRecords,
      resolved_historical_policy_cases: resolvedPolicyCases,
      already_admitted_issue_204_records: alreadyAdmittedIssue204,
      mandatory_issue_204_rejects: mandatoryIssue204Rejects,
      recommended_bounded_recovery_order: [
        {
          sequence: 1,
          group: 'Issue #204 mandatory rejects',
          count: 1,
          batching: 'Issue #211 completed the source-bound 25-candidate re-review: 24 admitted and one held.',
          gate: 'Resolve the remaining 내다 sense split with source-bound evidence; preserve the old Issue #204 rejection and #211 hold as history.',
        },
        {
          sequence: 2,
          group: 'Previously included M5-13/14/15 reserve candidates deferred only by capacity',
          count: remainingCapacityReserveCount,
          batching: 'Issue #219 calibrated a 20-record first batch; review later batches in bounded groups sized from observed defects and workload.',
          gate: `Treat historical fit as useful provenance, then re-run current lexical identity and sense checks; do not admit by quota. Issues #219 and #220 reviewed ${issue219SemanticSource.review.reviewed_candidate_count + issue220Decisions.length} rows; #220 admitted ${issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0)} and held ${issue220DecisionCounts.held} for unresolved lexical-unit evidence.`,
        },
        {
          sequence: 3,
          group: 'Legacy capacity-deferred and open M5 candidate rows',
          count: remainingLegacyAndOpenCandidateCount,
          batching: 'Separate source recovery from 10–20 record review batches.',
          gate: 'Recover missing authored candidate content for 35 legacy deferred rows; route 19 open candidates through normal review.',
        },
        {
          sequence: 4,
          group: 'Held or otherwise unresolved rows',
          count: (reviewStateCounts.hold ?? 0) + (reviewStateCounts['needs-sense-split'] ?? 0),
          batching: 'Resolve blockers individually, then place only cleared records into later bounded batches.',
          gate: 'Keep the 203 explicit sense/POS/context/lexical-unit cases and 75 additional rationale holds visible until their evidence is complete.',
        },
        {
          sequence: 5,
          group: 'Already represented, invalid surface, or collision cases',
          count: (reviewStateCounts.duplicate ?? 0) + (reviewStateCounts['invalid-lemma'] ?? 0) + (reviewStateCounts['search-surface-collision'] ?? 0),
          batching: 'No recovery batch until the identity condition changes.',
          gate: 'Preserve the 2 true duplicates, 2 inflected-form proposals, and 1 search collision as separate outcomes.',
        },
      ],
      canonical_mutation: `Issue #219 admitted ${issue219Counts.included + issue219Counts.corrected} M5-15 reserves; Issue #220 admitted ${issue220DecisionCounts.included + (issue220DecisionCounts.corrected ?? 0)} M5-13 reserves; Issues #221 and #222 admitted ${issue221AdmittedReviewRows.length + issue222AdmittedReviewRows.length} corpus-derived records through ordinary shared lexical production and admission. Corpus source material remains local-reference-only pending owner publication confirmation.`,
    };
    const report = renderReport(inventory);
    return { inventory, report };
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function renderReport(inventory) {
  const s = inventory.summary;
  const recordTypeCounts = inventory.search_coverage.role_and_record_type_counts;
  const stateRows = Object.entries(s.review_state_counts)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([state, count]) => `| \`${state}\` | ${count} |`)
    .join('\n');
  const refRows = inventory.current_reference_only_records
    .map(({ id, lemma, record_type: type, pos }) => `| ${id} | ${lemma} | ${type} | ${pos.join(', ')} |`)
    .join('\n');
  const mandatoryRejectRows = inventory.mandatory_issue_204_rejects
    .map(({ candidate_ordinal: ordinal, lemma, proposed_pos: pos, current_canonical_coverage: coverage, new_review_state: state }) => (
      `| ${ordinal} | ${lemma} | ${pos.join(', ')} | ${coverage.status} | \`${state}\` |`
    ))
    .join('\n');
  const batchRows = inventory.recommended_bounded_recovery_order
    .map((item) => `| ${item.sequence} | ${item.group} | ${item.count} | ${item.batching} | ${item.gate} |`)
    .join('\n');
  const sourceRows = inventory.generated_from.source_manifest
    .map(({ path: sourcePath, sha256: digest }) => `| \`${sourcePath}\` | \`${digest}\` |`)
    .join('\n');

  return `# Issue #210 — Historical exclusion recovery inventory\n\n\
Generated from the machine inventory at \`data/inventory/issue-210-recovery-inventory.json\`. The generator builds a temporary SQLite database and checks current canonical search coverage without changing canonical records.\n\n\
## Scope and policy\n\n\
The current invariant from Issues #207–#209 is: every valid lexical entry within Typewriter's supported scope may serve as a searchable start. Historical roles and decisions remain recorded as history; they do not determine current search eligibility. This report inventories current unresolved candidates and records Issues #219/#220's separately validated dispositions for bounded reserve slices. Issue #221's corpus-derived admissions are audited separately and do not enter the historical M5 recovery pool. Relation counts are not admission quotas.\n\n\
The audit screened all ${s.m5_target_rows_screened.toLocaleString('en-US')} M5 target rows, joined all ${s.issue_204_decisions_audited} Issue #204 decisions (${s.issue_204_decisions_overlaid_on_m5_targets} map to M5 rows; ${s.already_admitted_issue_204_count} admitted rows are tracked separately), audited ${s.m5_promotion_ledger_events_audited.toLocaleString('en-US')} promotion ledger events, traced ${s.resolved_historical_policy_case_count} corrected M5-3 policy cases, and checked all current reference-only records. The M1–M4 pilot tables and handoffs do not preserve a complete standalone rejected/deferred candidate ledger. No unavailable ephemeral drafts or external raw material were reconstructed.\n\n\
## Counts\n\n\
Issue #219 result: ${s.issue_219_decisions_audited} reviewed; ${s.issue_219_admitted_count} admitted, ${s.issue_219_held_count} held, and ${s.issue_219_rejected_count} rejected as compositional phrases. Issue #220 result: ${s.issue_220_decisions_audited} reviewed; ${s.issue_220_admitted_count} recovered, ${s.issue_220_held_count} held, and ${s.issue_220_rejected_count} rejected. Issue #221 result: ${s.issue_221_candidates_reviewed} bounded corpus candidates reviewed; ${s.issue_221_admitted_count} admitted, ${s.issue_221_held_count} held, and ${s.issue_221_rejected_count} rejected. Its ${s.issue_221_promotion_events_audited} source-bound promotion events are included in the ledger audit.\n\n\
| Measure | Count |\n| --- | ---: |\n| Recovery candidate records classified | ${s.recovery_candidate_count} |\n| Issue #204 records already admitted and searchable | ${s.already_admitted_issue_204_count} |\n| Current canonical records | ${s.directly_searchable_canonical_record_count.toLocaleString('en-US')} |\n| Current non-searchable lexical records | ${s.current_non_searchable_lexical_record_count} |\n| Current reference-only records, now searchable | ${s.current_reference_only_record_count} |\n| Confirmed active usefulness/generality exclusions (#204) | ${s.confirmed_active_usefulness_or_generality_exclusions} |\n| Historical policy-rejection events, including later holds/corrections | ${s.historical_policy_rejection_events} |\n| True duplicate proposals | ${s.true_duplicate_count} |\n| Invalid inflected-form proposals | ${s.invalid_lemma_count} |\n| Confirmed non-lexical proposals | ${s.non_lexical_proposal_count_confirmed} |\n| Search-surface collisions | ${s.search_collision_count} |\n| Explicit unresolved sense/POS/context cases | ${s.unresolved_sense_pos_or_context_case_count} |\n| Additional rationale or lexical-unit holds | ${s.additional_rationale_or_lexical_unit_holds} |\n| Unsupported lexical categories | ${s.unsupported_lexical_category_count} |\n| Exact canonical search keys checked | ${s.exact_search_key_count.toLocaleString('en-US')} |\n\n\
The 31 historical policy-rejection events include 25 Issue #204 rejects re-reviewed in Issue #211 (24 recovered and searchable, one held for an unresolved sense boundary), two M5-10A2 rejections that later became holds for lexical boundaries, and four M5-3 rejections later corrected and included in M5-7. No Issue #204 row remains an active usefulness/generality exclusion. The two M5-10A2 holds retain their blockers, and the four corrected cases are already searchable. M5's seven “insufficient admission priority” rejections and 20 generic M5-12A rejects remain on hold because their durable rationale does not establish a specific usefulness-only reason or lexical invalidity. The inventory also preserves 11 earlier M5 reject-to-hold transitions; two are the mixed utility cases counted above, while the others retain identity, sense, phrase, or context blockers.\n\n\
All ${s.directly_searchable_canonical_record_count.toLocaleString('en-US')} current canonical records resolve directly. Their ${s.exact_search_key_count.toLocaleString('en-US')} canonical lemma/search-form keys have no missing owner, unexpected owner, or cross-record collision. This includes ${s.current_reference_only_record_count} historical reference-only records (${recordTypeCounts['reference-only/entry'] ?? 0} entries and ${recordTypeCounts['reference-only/expression'] ?? 0} expression); all their current lemmas resolve by the same canonical ID.\n\n\
## New review states\n\n\
| State | Count |\n| --- | ---: |\n${stateRows}\n\n\
\`admit-candidate\` means eligible for fresh bounded review, not admitted. It includes ${s.issue_220_priority_reserve_remaining} remaining M5-13/14/15 capacity reserves, 35 older capacity-deferred rows whose authored candidate body must be recovered, and 19 open M5 candidates. Issue #219 reviewed ${s.issue_219_decisions_audited} of the original 254 reserves; Issue #220 separately reviewed 40 M5-13 reserves and recorded ${s.issue_220_admitted_count} recoveries plus ${s.issue_220_held_count} unresolved lexical-unit holds. Issue #211 recovered 24 of the 25 mandatory Issue #204 candidates; the remaining candidate is held for a source-bound sense split. Holds preserve unresolved identity, context, sense, lexical-unit, or historical-rationale questions. The 20 generic M5-12A rejects are not called non-lexical: their candidate-specific lexical-unit status is unresolved. No proposed POS or record type falls outside the current supported category set.\n\n\
## Mandatory Issue #204 rejects\n\nThe full historical rationale and follow-up are retained in the JSON inventory.\n\n| #204 ordinal | Lemma | Proposed POS | Current canonical coverage | New review state |\n| ---: | --- | --- | --- | --- |\n${mandatoryRejectRows}\n\n## Recommended bounded recovery order\n\n\
| Order | Candidate group | Count | Batch size | Gate |\n| ---: | --- | ---: | --- | --- |\n${batchRows}\n\n\
## Current reference-only records\n\n\
| ID | Lemma | Record type | POS |\n| --- | --- | --- | --- |\n${refRows}\n\n\
## Source manifest\n\n\
Every path below is hashed in the machine inventory. The inventory preserves each row's prior disposition/rationale, later decision events where available, current query results, new state, and follow-up.\n\n\
| Artifact | SHA-256 |\n| --- | --- |\n${sourceRows}\n\n\
## Known limits\n\n\
- M1–M4 provide a 300-item pilot selection table, canonical pilot records, and historical M3/M4 handoffs, but not a complete durable list of every rejected or deferred candidate. The inventory does not infer omitted lemmas from those missing lists.\n- Historical M5 decision notes such as “insufficient admission priority” are preserved as ambiguous evidence. They remain on hold until candidate-specific lexical grounds can be recovered.\n- Issue #211 re-reviewed all 25 Issue #204 rejects through the shared semantic and admission contracts. Twenty-four now have admitted canonical bodies; one remains held because its current single-sense gloss collapses distinct uses.\n- Issue #220 reviewed two bounded M5-13 reserve batches. The complete Issue #210 historical pool cannot reach 6,000 records even if every remaining candidate/hold/sense-split row is resolved: its calculated ceiling is ${s.historical_recovery_ceiling_count}, short by ${s.historical_recovery_shortfall_to_6000}. Issue #221's corpus admissions are part of today's canonical baseline but remain outside that historical pool. Further expansion requires the next approved source workflow, not reconstruction from absent historical material.\n- Current search coverage describes canonical lookup only; it does not claim editorial quality, writer satisfaction, or relation completeness.\n\n\
## Reproduction\n\n\
\`npm run inventory:issue-210\` checks the committed JSON and Markdown against current canonical data and source digests. Use \`npm run inventory:issue-210:write\` to regenerate both outputs after an authorized source change.\n`;
}

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
  if (!mode || (process.argv.includes('--write') && process.argv.includes('--check'))) {
    throw new Error('Usage: node scripts/inventory/build-issue-210-recovery-inventory.mjs --check|--write');
  }
  const { inventory, report } = await buildInventory();
  const serializedInventory = `${JSON.stringify(inventory, null, 2)}\n`;
  if (mode === 'write') {
    await writeFile(INVENTORY_PATH, serializedInventory);
    await writeFile(REPORT_PATH, report);
    console.log(`Wrote ${path.relative(ROOT, INVENTORY_PATH)} and ${path.relative(ROOT, REPORT_PATH)} (${inventory.recovery_candidates.length} recovery candidates).`);
    return;
  }
  const [currentInventory, currentReport] = await Promise.all([
    readFile(INVENTORY_PATH, 'utf8'),
    readFile(REPORT_PATH, 'utf8'),
  ]);
  assert.equal(currentInventory, serializedInventory, 'Issue #210 JSON inventory is stale; run npm run inventory:issue-210:write');
  assert.equal(currentReport, report, 'Issue #210 summary report is stale; run npm run inventory:issue-210:write');
  console.log(`Issue #210 inventory is current: ${inventory.recovery_candidates.length} recovery candidates; ${inventory.summary.current_non_searchable_lexical_record_count} non-searchable canonical records.`);
}

await main();

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
  'duplicate',
  'invalid-lemma',
  'wrong-pos',
  'needs-sense-split',
  'search-surface-collision',
  'unsupported-scope',
]);
const SOURCE_PATHS = [
  'package.json',
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
  'docs/m9-bounded-lexical-batches.md',
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
  'scripts/batch/lexical-production.mjs',
  'schema/m9-lexical-batch-report.schema.json',
  'tests/issue-219-search.test.mjs',
  'tests/lexical-production-candidates.test.mjs',
  'scripts/ci/registry.mjs',
  'tests/issue-211-search.test.mjs',
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
  const canonicalNames = (await readdir(path.join(ROOT, 'data/canonical')))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const historicalCanonicalNames = (await readdir(path.join(ROOT, 'data/batches/issue-219-m9-a-base-canonical')))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const paths = stableUnique([
    ...SOURCE_PATHS,
    ...canonicalNames.map((name) => `data/canonical/${name}`),
    ...historicalCanonicalNames.map((name) => `data/batches/issue-219-m9-a-base-canonical/${name}`),
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
  for (const source of semanticMaps) {
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
  const issue204RejectLemmas = issue204Rejected.map(({ morphology_proposal: proposal }) => proposal.lemma);

  assert.deepEqual(issue204RejectLemmas, EXPECTED_ISSUE_204_REJECTS, 'Issue #204 mandatory reject list changed');
  assert.equal(seed.targets.length, 1542, 'M9 current M5 seed row count changed');
  assert.equal(seedStatuses.promoted, 978, 'M5 promoted seed row count changed');
  assert.equal(promotions.length, 3776, 'M5 promotion ledger row count changed');
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
    assert.equal(inventoryCandidates.length, 564, 'M5 non-promoted inventory count changed');
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
    assert.equal(entries.length, 564);
    assert.equal(policyOpen.length, 0);
    assert.deepEqual(issue204MandatoryLemmas, EXPECTED_ISSUE_204_REJECTS);
    assert.equal(reviewStateCounts['admit-candidate'], 288);
    assert.equal(reviewStateCounts.hold, 220);
    assert.equal(reviewStateCounts['needs-sense-split'], 27);
    assert.equal(reviewStateCounts.recovered, 24);
    assert.equal(reviewStateCounts.duplicate, 2);
    assert.equal(reviewStateCounts['search-surface-collision'], 1);
    assert.equal(reviewStateCounts['invalid-lemma'], 2);
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
    assert.equal(explicitSensePosContextCases, 172);
    assert.equal(unsupportedLexicalCategoryCount, 0);

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
        m5: 'Screened the 1,542 remaining M5 seed rows; joined preserved M5-12A through M5-15 semantic decisions, M5-10A2 rejections, M5-3/M5-7 correction history, and source-bound Issue #211/#219 recovery outcomes. The 20 #219 promotions are tracked in the promotion ledger and frozen baseline.',
        m6: 'Bound current search coverage to the M6-1 searchable baseline and a fresh exact-key runtime query over the current canonical JSONL.',
        issue_204: 'Joined all 100 Issue #204 pilot decisions. Ninety decision rows overlay the M5 target inventory; the ten admitted rows are tracked separately against their current canonical IDs. Issue #211 crosswalks all 25 former rejects to 24 recovered records and one held sense split. Issue #219 admitted 20 previously capacity-deferred M5-15 candidates after fresh source-bound review.',
        source_material_boundary: 'Uses tracked Typewriter decision artifacts only. It does not reconstruct ephemeral LLM output or include raw external/corpus source material.',
      },
      summary: {
        m5_target_rows_screened: seed.targets.length,
        m5_target_status_counts: seedStatuses,
        m5_promoted_seed_rows_present_in_canonical: promotedSeedRows.length,
        m5_promotion_ledger_events_audited: promotions.length,
        issue_204_decisions_audited: issue204.decisions.length,
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
        non_lexical_proposal_count_confirmed: 0,
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
          count: 234,
          batching: 'Issue #219 calibrated a 20-record first batch; review later batches in bounded groups sized from observed defects and workload.',
          gate: 'Treat historical fit as useful provenance, then re-run current lexical identity and sense checks; do not admit by quota. Twenty of the original 254 are now admitted and searchable.',
        },
        {
          sequence: 3,
          group: 'Legacy capacity-deferred and open M5 candidate rows',
          count: 54,
          batching: 'Separate source recovery from 10–20 record review batches.',
          gate: 'Recover missing authored candidate content for 35 legacy deferred rows; route 19 open candidates through normal review.',
        },
        {
          sequence: 4,
          group: 'Held or otherwise unresolved rows',
          count: (reviewStateCounts.hold ?? 0) + (reviewStateCounts['needs-sense-split'] ?? 0),
          batching: 'Resolve blockers individually, then place only cleared records into later bounded batches.',
          gate: 'Keep the 172 explicit sense/POS/context cases and 75 other rationale or lexical-unit holds visible until their evidence is complete.',
        },
        {
          sequence: 5,
          group: 'Already represented, invalid surface, or collision cases',
          count: (reviewStateCounts.duplicate ?? 0) + (reviewStateCounts['invalid-lemma'] ?? 0) + (reviewStateCounts['search-surface-collision'] ?? 0),
          batching: 'No recovery batch until the identity condition changes.',
          gate: 'Preserve the 2 true duplicates, 2 inflected-form proposals, and 1 search collision as separate outcomes.',
        },
      ],
      canonical_mutation: 'Issue #219 admitted 20 previously capacity-deferred M5-15 candidates through ordinary shared lexical production and admission.',
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
The current invariant from Issues #207–#209 is: every valid lexical entry within Typewriter's supported scope may serve as a searchable start. Historical roles and decisions remain recorded as history; they do not determine current search eligibility. This report inventories current unresolved candidates and records Issue #219's separately validated admission of a bounded reserve slice. Relation counts are not admission quotas.\n\n\
The audit screened all ${s.m5_target_rows_screened.toLocaleString('en-US')} M5 target rows, joined all ${s.issue_204_decisions_audited} Issue #204 decisions (${s.issue_204_decisions_overlaid_on_m5_targets} map to M5 rows; ${s.already_admitted_issue_204_count} admitted rows are tracked separately), audited ${s.m5_promotion_ledger_events_audited.toLocaleString('en-US')} promotion ledger events, traced ${s.resolved_historical_policy_case_count} corrected M5-3 policy cases, and checked all current reference-only records. The M1–M4 pilot tables and handoffs do not preserve a complete standalone rejected/deferred candidate ledger. No unavailable ephemeral drafts or external raw material were reconstructed.\n\n\
## Counts\n\n\
| Measure | Count |\n| --- | ---: |\n| Recovery candidate records classified | ${s.recovery_candidate_count} |\n| Issue #204 records already admitted and searchable | ${s.already_admitted_issue_204_count} |\n| Current canonical records | ${s.directly_searchable_canonical_record_count.toLocaleString('en-US')} |\n| Current non-searchable lexical records | ${s.current_non_searchable_lexical_record_count} |\n| Current reference-only records, now searchable | ${s.current_reference_only_record_count} |\n| Confirmed active usefulness/generality exclusions (#204) | ${s.confirmed_active_usefulness_or_generality_exclusions} |\n| Historical policy-rejection events, including later holds/corrections | ${s.historical_policy_rejection_events} |\n| True duplicate proposals | ${s.true_duplicate_count} |\n| Invalid inflected-form proposals | ${s.invalid_lemma_count} |\n| Confirmed non-lexical proposals | ${s.non_lexical_proposal_count_confirmed} |\n| Search-surface collisions | ${s.search_collision_count} |\n| Explicit unresolved sense/POS/context cases | ${s.unresolved_sense_pos_or_context_case_count} |\n| Additional rationale or lexical-unit holds | ${s.additional_rationale_or_lexical_unit_holds} |\n| Unsupported lexical categories | ${s.unsupported_lexical_category_count} |\n| Exact canonical search keys checked | ${s.exact_search_key_count.toLocaleString('en-US')} |\n\n\
The 31 historical policy-rejection events include 25 Issue #204 rejects re-reviewed in Issue #211 (24 recovered and searchable, one held for an unresolved sense boundary), two M5-10A2 rejections that later became holds for lexical boundaries, and four M5-3 rejections later corrected and included in M5-7. No Issue #204 row remains an active usefulness/generality exclusion. The two M5-10A2 holds retain their blockers, and the four corrected cases are already searchable. M5's seven “insufficient admission priority” rejections and 20 generic M5-12A rejects remain on hold because their durable rationale does not establish a specific usefulness-only reason or lexical invalidity. The inventory also preserves 11 earlier M5 reject-to-hold transitions; two are the mixed utility cases counted above, while the others retain identity, sense, phrase, or context blockers.\n\n\
All ${s.directly_searchable_canonical_record_count.toLocaleString('en-US')} current canonical records resolve directly. Their ${s.exact_search_key_count.toLocaleString('en-US')} canonical lemma/search-form keys have no missing owner, unexpected owner, or cross-record collision. This includes ${s.current_reference_only_record_count} historical reference-only records (${recordTypeCounts['reference-only/entry'] ?? 0} entries and ${recordTypeCounts['reference-only/expression'] ?? 0} expression); all their current lemmas resolve by the same canonical ID.\n\n\
## New review states\n\n\
| State | Count |\n| --- | ---: |\n${stateRows}\n\n\
\`admit-candidate\` means eligible for fresh bounded review, not admitted. It includes 234 remaining source-reviewed capacity reserves, 35 older capacity-deferred rows whose authored candidate body must be recovered, and 19 open M5 candidates. Issue #219 freshly reviewed and admitted 20 of the original 254 M5-13/14/15 capacity reserves. Issue #211 recovered 24 of the 25 mandatory Issue #204 candidates; the remaining candidate is held for a source-bound sense split. Holds preserve unresolved identity, context, sense, lexical-unit, or historical-rationale questions. The 20 generic M5-12A rejects are not called non-lexical: their candidate-specific lexical-unit status is unresolved. No proposed POS or record type falls outside the current supported category set.\n\n\
## Mandatory Issue #204 rejects\n\nThe full historical rationale and follow-up are retained in the JSON inventory.\n\n| #204 ordinal | Lemma | Proposed POS | Current canonical coverage | New review state |\n| ---: | --- | --- | --- | --- |\n${mandatoryRejectRows}\n\n## Recommended bounded recovery order\n\n\
| Order | Candidate group | Count | Batch size | Gate |\n| ---: | --- | ---: | --- | --- |\n${batchRows}\n\n\
## Current reference-only records\n\n\
| ID | Lemma | Record type | POS |\n| --- | --- | --- | --- |\n${refRows}\n\n\
## Source manifest\n\n\
Every path below is hashed in the machine inventory. The inventory preserves each row's prior disposition/rationale, later decision events where available, current query results, new state, and follow-up.\n\n\
| Artifact | SHA-256 |\n| --- | --- |\n${sourceRows}\n\n\
## Known limits\n\n\
- M1–M4 provide a 300-item pilot selection table, canonical pilot records, and historical M3/M4 handoffs, but not a complete durable list of every rejected or deferred candidate. The inventory does not infer omitted lemmas from those missing lists.\n- Historical M5 decision notes such as “insufficient admission priority” are preserved as ambiguous evidence. They remain on hold until candidate-specific lexical grounds can be recovered.\n- Issue #211 re-reviewed all 25 Issue #204 rejects through the shared semantic and admission contracts. Twenty-four now have admitted canonical bodies; one remains held because its current single-sense gloss collapses distinct uses.\n- Current search coverage describes canonical lookup only; it does not claim editorial quality, writer satisfaction, or relation completeness.\n\n\
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

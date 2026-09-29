import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Ajv from 'ajv';

import { buildDictionary } from '../build/dictionary.mjs';
import { readLogicalDatabaseSnapshot } from '../build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  readSemanticDecisionSourceArtifact,
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  DEFAULT_PROMOTION_PATH,
  DEFAULT_SEED_PATH,
} from '../inventory/generate-target-inventory.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import {
  authoredSemanticDecisionRowDigest,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';
import { materializeLexicalUnitCandidates, validateLexicalProduction } from './lexical-production.mjs';
import { productionValueSha256 } from './lexical-production-state.mjs';
import {
  productionReviewRows,
  productionStageEvidence,
  projectDecisionSourceToCanonical,
  validateExactSearch,
} from './validate-issue-211.mjs';
import {
  M5_15_CANDIDATE_IDENTITIES,
  M5_15_CANDIDATE_SOURCE,
  M5_15_CANDIDATE_SOURCE_BYTES,
  buildM515CandidateRecords,
} from './m5-15-candidate-source.mjs';
import { validateM515DecisionSource } from './m5-15-decision-source.mjs';
import { selectionOutcomeById } from './lexical-selection.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const SELECTION_PATH = path.join(ROOT, 'data/batches/issue-219-m9-a-recovery-selection.json');
const CANDIDATE_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-219-m9-a-lexical-unit-source.json');
const SEMANTIC_SOURCE_PATH = path.join(ROOT, 'data/batches/issue-219-m9-a-semantic-decisions.json');
const IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-219-m9-a-recovery.jsonl');
const BASE_CANONICAL_DIRECTORY = path.join(ROOT, 'data/batches/issue-219-m9-a-base-canonical');
const BASE_SEED_PATH = path.join(ROOT, 'data/batches/issue-219-m9-a-base-seed.json');
const BASE_ISSUE_210_PATH = path.join(ROOT, 'data/batches/issue-219-m9-a-base-issue-210-recovery-inventory.json');
const CURRENT_ROOT_SOURCE_PATH = path.join(ROOT, 'data/validation/canonical-semantic-decision-source.json');
const REPORT_PATH = path.join(ROOT, 'docs/issue-219-m9-a-recovery.md');
const MACHINE_REPORT_PATH = path.join(ROOT, 'data/validation/issue-219-m9-lexical-batch-report.json');
const REPORT_SCHEMA_PATH = path.join(ROOT, 'schema/m9-lexical-batch-report.schema.json');
const BATCH_ID = 'm9-a-issue-219-first-recovery-20260929';
const VERIFICATION_PASS_ID = 'issue-219-separate-semantic-verification-20260929-r1';
const BASELINE_INVENTORY_SHA256 = 'fcaa572119d307a1efc0f15782b8d77a0585f4e9786e735ce42623dd4710e539';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const jsonlBytes = (records) => Buffer.from(records.length === 0
  ? ''
  : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
const recordOf = (recordInfo) => recordInfo?.record ?? recordInfo;

function readJsonl(bytes, label) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

function semanticDecisionConfig(candidateSource, semanticSource) {
  return {
    label: 'Issue #219',
    errorPrefix: 'ISSUE_219',
    sourcePath: 'data/batches/issue-219-m9-a-semantic-decisions.json',
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateSource.source_id,
    batchId: semanticSource.batch_id,
    issue: 219,
    parentIssue: 218,
    generationPassId: candidateSource.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId: 'issue-219-agent-correction-20260929-r1',
    semanticReviewVersion: semanticSource.provenance.generator_version,
    selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
    selectionCount: 20,
    importCount: 20,
    reserveCount: 0,
  };
}

export function validateIssue219SemanticDecisionSource({
  candidateSource,
  semanticSource,
  semanticSourceBytes,
  identities,
  candidateRecords,
} = {}) {
  return validateAuthoredSemanticDecisionSource({
    source: semanticSource,
    sourceBytes: semanticSourceBytes,
    identities,
    candidateRecords,
    config: semanticDecisionConfig(candidateSource, semanticSource),
  });
}

function assertSelectionSource(selection, baseIssue210, m515SourceBytes, m515DecisionBytes, m515Decision, m515Records) {
  assert.equal(selection.schema_version, '1');
  assert.equal(selection.contract_version, 'm9-recovery-batch-selection-v1');
  assert.equal(selection.issue, 219);
  assert.equal(selection.parent_issue, 218);
  assert.equal(selection.baseline.issue_210_inventory_sha256, BASELINE_INVENTORY_SHA256);
  assert.equal(sha256Bytes(jsonBytes(baseIssue210)), BASELINE_INVENTORY_SHA256, 'pinned #210 baseline inventory digest');
  assert.equal(sha256Bytes(m515SourceBytes), selection.prior_source_bindings.candidate_source.file_sha256);
  assert.equal(M5_15_CANDIDATE_SOURCE.artifact_sha256, selection.prior_source_bindings.candidate_source.artifact_sha256);
  assert.equal(sha256Bytes(m515DecisionBytes), selection.prior_source_bindings.semantic_decisions.file_sha256);
  assert.equal(m515Decision.source.artifact_sha256, selection.prior_source_bindings.semantic_decisions.artifact_sha256);
  assert.equal(selection.policy.eligible_reserve_count, 254);
  assert.equal(selection.selected_count, 20);
  assert.equal(selection.policy.cohort, 'M5-15 axis C capacity reserves');
  assert.equal(selection.policy.cohort_count, 32);

  const reserveOutcomes = selectionOutcomeById(m515Decision.selection);
  const identityByCandidateId = new Map(M5_15_CANDIDATE_IDENTITIES.map((identity) => [identity.candidate_record_id, identity]));
  const recordById = new Map(m515Records.map((record) => [record.id, record]));
  const unitsBySourceUnitId = new Map(M5_15_CANDIDATE_SOURCE.units.map((unit) => [unit.source_unit_id, unit]));
  const expectedCohort = M5_15_CANDIDATE_IDENTITIES
    .filter((identity) => identity.axis === 'C' && reserveOutcomes.get(identity.candidate_record_id) === 'reserve')
    .sort((left, right) => Number(left.inventory_id.slice(3)) - Number(right.inventory_id.slice(3)));
  assert.equal(expectedCohort.length, 32, 'M5-15 axis C reserve cohort size');
  const selected = selection.selected_candidates;
  assert.equal(selected.length, 20);
  assert.deepEqual(selected.map(({ source_inventory_id: id }) => id), expectedCohort.slice(0, 20).map(({ inventory_id: id }) => id));

  const issue210Rows = new Map(baseIssue210.recovery_candidates.map((row) => [row.source_inventory_id, row]));
  const eligibleHistoricalReserves = baseIssue210.recovery_candidates.filter((row) => (
    row.historical_decision_events?.some((event) => event.historical_rationale?.includes('selection=reserve'))
  ));
  assert.equal(eligibleHistoricalReserves.length, 254, 'all M5-13/14/15 capacity reserves in pinned #210 inventory');
  for (const [index, item] of selected.entries()) {
    const identity = expectedCohort[index];
    const priorDecision = m515Decision.rows.find(({ candidate_record_id: id }) => id === identity.candidate_record_id);
    const priorRecord = recordById.get(identity.candidate_record_id);
    const sourceUnit = unitsBySourceUnitId.get(identity.source_basis.source_unit_id);
    const issue210Row = issue210Rows.get(identity.inventory_id);
    assert.ok(priorDecision && priorRecord && sourceUnit && issue210Row, `${identity.inventory_id} prior source evidence exists`);
    assert.equal(priorDecision.decision, 'included');
    assert.equal(priorDecision.gloss_judgment, 'fit');
    assert.equal(priorDecision.selection_axis, 'C');
    assert.equal(reserveOutcomes.get(identity.candidate_record_id), 'reserve');
    assert.equal(priorDecision.candidate_record_sha256, sha256Json(priorRecord));
    assert.equal(item.source_inventory_row_sha256, productionValueSha256(item.source_inventory_row));
    assert.deepEqual(item.source_inventory_row, issue210Row, `${identity.inventory_id} exact frozen #210 row`);
    assert.equal(item.source_inventory_row.new_review_state, 'admit-candidate');
    assert.equal(item.source_inventory_row.current_canonical_search_coverage.status, 'no-canonical-lemma-match');
    assert.deepEqual(item.current_source_unit, sourceUnit);
    assert.equal(item.historical_candidate_record_id, identity.candidate_record_id);
    assert.equal(item.historical_source_unit_id, identity.source_basis.source_unit_id);
    assert.equal(item.historical_decision.candidate_record_sha256, priorDecision.candidate_record_sha256);
    assert.equal(item.historical_decision.selection_outcome, 'reserve');
    assert.deepEqual(item.admitted_identity, {
      inventory_id: identity.inventory_id,
      candidate_record_id: identity.candidate_record_id,
      lemma: identity.lemma,
    });
  }
}

function renderReport(report) {
  const rows = report.candidates.map((candidate) => (
    `| ${candidate.selection_order} | ${candidate.inventory_id} | ${candidate.canonical_id} | ${candidate.lemma} | ${candidate.pos} | ${candidate.decision} | ${candidate.relation_count} | ${candidate.search_result_ids.join(', ')} |`
  )).join('\n');
  return [
    '# Issue #219 — M9-A bounded recovery',
    '',
    '## Contract and first batch',
    '',
    'M9 recovery selects historical candidates from a pinned source inventory, but every admitted record receives a new source-bound Issue #219 semantic decision and passes the ordinary shared lexical producer, semantic audit, and admission path. Historical fit and capacity-reserve status select candidates for review; they do not authorize canonical admission.',
    '',
    'The recovery contract prioritizes high-confidence capacity-deferred source candidates, then source-recoverable legacy deferred candidates and open M5 candidates. Holds and known collisions stay outside a batch until their specific evidence is resolved. Every row records inventory and canonical identity, lemma, POS, source unit, decision, relation outcome, base search ownership, and final exact search result. There is no commonness, usefulness, vividness, or relation quota.',
    '',
    'The first slice is the first 20 numeric identities in the 32-row M5-15 axis C reserve cohort, selected from the exact Issue #210 baseline. All 20 were included/fit and deferred only by M5-15 capacity, remained `admit-candidate`, and had no canonical lemma or search match in the baseline. They were separately reviewed under #219 before admission.',
    '',
    '## Outcome',
    '',
    '| Measure | Result |',
    '| --- | ---: |',
    `| Reviewed | ${report.outcomes.reviewed_count} |`,
    `| Admitted | ${report.outcomes.admitted_count} |`,
    `| Held / rejected / corrected | ${report.outcomes.held_count} / ${report.outcomes.rejected_count} / ${report.outcomes.corrected_count} |`,
    `| Duplicate / search collision | ${report.outcomes.duplicate_count} / ${report.outcomes.search_collision_count} |`,
    `| New senses / relations / expressions | ${report.outcomes.new_sense_count} / ${report.outcomes.new_relation_count} / ${report.outcomes.new_expression_count} |`,
    `| Admitted with zero relations | ${report.outcomes.zero_relation_admission_count} |`,
    `| Observed defect classes | ${report.outcomes.defect_classes.join(', ') || 'none'} |`,
    `| Review duration | ${report.outcomes.review_duration} |`,
    '',
    'Every candidate kept one supported expression sense with its Typewriter-authored gloss. The shared selector admitted all 20 after independent current review. No relation was added because the evidence did not support a separately authored relation; zero relations do not block search admission.',
    '',
    '## Candidate and search results',
    '',
    '| Order | Inventory | Canonical | Lemma | POS | Decision | Relations | Exact search result IDs |',
    '| ---: | --- | --- | --- | --- | --- | ---: | --- |',
    rows,
    '',
    'The frozen baseline dictionary produced no exact canonical or generated-surface result for any candidate. The current dictionary returns each lemma as exactly its own `ready` exact-lemma result. The 20 records are canonical starts and remain relation-empty.',
    '',
    '## Batch-size calibration',
    '',
    'Use 20 records as the initial M9 review batch size: this coherent 20-record slice completed with no identity, POS, sense, duplicate, search-collision, or relation-evidence defects and passed the shared admission contract. Review duration was not measured, so this is a successful-slice calibration, not a throughput estimate. Reassess the size from later defect and workload observations; the size is not a quota.',
    '',
    `The batch added ${report.outcomes.admitted_count} searchable starts and brought the canonical start count from ${report.baseline.canonical_start_count} to ${report.current.canonical_start_count}. This issue does not target 6,000 starts or corpus expansion.`,
    '',
    '## Reproduction and boundaries',
    '',
    'Run `npm run batch:issue-219:check` to validate the pinned #210/#219 inputs, M5-15 reserve selection, candidate and semantic source bindings, ordinary lexical admission, target promotion ledger, exact product search, deterministic SQLite output, machine report schema, and current semantic audit. Run `npm run batch:issue-219:report` after an authorized report input change to refresh both reports.',
    '',
    'The snapshot copies under `data/batches/issue-219-m9-a-base-*` preserve the pre-admission canonical set, seed, and Issue #210 inventory needed for historical replay. They contain Typewriter-authored project data and do not include corpus text or external dictionary material.',
    '',
  ].join('\n');
}

async function validateReportSchema(report) {
  const schema = JSON.parse(await readFile(REPORT_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, `Issue #219 machine report schema: ${ajv.errorsText(validate.errors)}`);
}

async function validateDeterministicCurrentBuild() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-219-determinism-'));
  const snapshots = [];
  try {
    for (const name of ['first', 'second']) {
      const outputPath = path.join(temporaryDirectory, `${name}.sqlite`);
      await buildDictionary({
        inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
        outputPath,
        allowDirty: true,
        repositoryDirectory: ROOT,
      });
      const database = new DatabaseSync(outputPath, { readOnly: true });
      try {
        snapshots.push(readLogicalDatabaseSnapshot(database));
      } finally {
        database.close();
      }
    }
    assert.deepEqual(snapshots[1], snapshots[0], 'repeated current canonical SQLite builds have equal logical contents');
    return snapshots[0];
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function logicalDatabaseContentSnapshot(snapshot) {
  const buildProvenanceKeys = new Set([
    'source_revision',
    'source_revision_source',
    'source_revision_verified',
    'worktree_state',
  ]);
  return {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      metadata: snapshot.rows.metadata.filter(({ key }) => !buildProvenanceKeys.has(key)),
    },
  };
}

export async function validateIssue219({ writeReport = false } = {}) {
  const [selectionBytes, candidateSourceBytes, semanticSourceBytes, importBytes, baseSeedBytes, baseInventoryBytes,
    m515DecisionBytes, currentSeedBytes] = await Promise.all([
    readFile(SELECTION_PATH),
    readFile(CANDIDATE_SOURCE_PATH),
    readFile(SEMANTIC_SOURCE_PATH),
    readFile(IMPORT_PATH),
    readFile(BASE_SEED_PATH),
    readFile(BASE_ISSUE_210_PATH),
    readFile(path.join(ROOT, 'data/batches/m5-15-semantic-decisions.json')),
    readFile(DEFAULT_SEED_PATH),
  ]);
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  const candidateSource = JSON.parse(candidateSourceBytes.toString('utf8'));
  const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
  const baseSeed = JSON.parse(baseSeedBytes.toString('utf8'));
  const baseIssue210 = JSON.parse(baseInventoryBytes.toString('utf8'));
  const currentSeed = JSON.parse(currentSeedBytes.toString('utf8'));
  const m515SourceBytes = M5_15_CANDIDATE_SOURCE_BYTES;
  const m515Decision = validateM515DecisionSource({
    source: JSON.parse(m515DecisionBytes.toString('utf8')),
    sourceBytes: m515DecisionBytes,
    candidateRecords: buildM515CandidateRecords(),
  });
  const m515Records = buildM515CandidateRecords();
  assertSelectionSource(selection, baseIssue210, m515SourceBytes, m515DecisionBytes, m515Decision, m515Records);

  assert.equal(sha256Bytes(baseInventoryBytes), BASELINE_INVENTORY_SHA256, 'frozen Issue #210 inventory bytes');
  assert.equal(sha256Bytes(baseSeedBytes), selection.baseline.seed_sha256, 'frozen Issue #219 base seed bytes');
  assert.equal(sha256Bytes(baseSeedBytes), candidateSource.base_seed_sha256, 'candidate source base seed binding');
  assert.equal(candidateSource.base_canonical_records_sha256, selection.baseline.canonical_records_sha256);
  assert.equal(candidateSource.candidate_count, 20);
  assert.equal(candidateSource.units.length, 20);
  assert.equal(candidateSource.source_id, semanticSource.candidate_source.source_id);
  assert.equal(candidateSource.generation_pass_id, semanticSource.provenance.generation_pass_id);
  assert.equal(semanticSource.source_id, 'issue-219-authored-semantic-decisions-20260929-r1');

  const historicalCanonical = await readCanonicalRecords(BASE_CANONICAL_DIRECTORY);
  assert.equal(canonicalRecordsSha256(historicalCanonical.records), selection.baseline.canonical_records_sha256, 'frozen pre-admission canonical digest');
  const currentCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const historicalById = new Map(historicalCanonical.records.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  const currentById = new Map(currentCanonical.records.map((recordInfo) => [recordOf(recordInfo).id, recordOf(recordInfo)]));
  for (const [id, record] of historicalById) {
    assert.deepEqual(currentById.get(id), record, `${id} frozen baseline record remains unchanged`);
  }

  const selectedInventoryIds = selection.selected_candidates.map(({ source_inventory_id: id }) => id);
  const materialized = materializeLexicalUnitCandidates({
    batchId: semanticSource.batch_id,
    source: candidateSource,
    sourceBytes: candidateSourceBytes,
    firstInventoryNumber: Number(selectedInventoryIds[0].slice(3)),
    firstCanonicalNumber: Number(selection.selected_candidates[0].admitted_identity.candidate_record_id.slice(1)),
    baseRecords: historicalCanonical.records,
    baseSeedTargets: baseSeed.targets,
    reopenedSeedTargetIds: selectedInventoryIds,
  });
  assert.deepEqual(materialized.identities.map(({ inventory_id: id }) => id), selectedInventoryIds);
  assert.deepEqual(materialized.identities.map(({ candidate_record_id: id }) => id), selection.selected_candidates.map(({ admitted_identity: identity }) => identity.candidate_record_id));
  assert.deepEqual(materialized.identities.map(({ lemma }) => lemma), selection.selected_candidates.map(({ admitted_identity: identity }) => identity.lemma));

  const importRecords = readJsonl(importBytes, 'Issue #219 canonical import');
  assert.deepEqual(importRecords, materialized.candidateRecords, 'Issue #219 canonical import equals shared producer output');
  assert.deepEqual(semanticSource.candidate_records, materialized.candidateRecords, 'semantic candidates equal shared producer output');
  assert.equal(semanticSource.candidate_records_sha256, sha256Json(materialized.candidateRecords));
  assert.deepEqual(semanticSource.decisions.map(({ candidate_record_id: id, decision }) => ({ id, decision })), importRecords.map(({ id }) => ({ id, decision: 'included' })));
  const semanticDecisionSource = validateIssue219SemanticDecisionSource({
    candidateSource,
    semanticSource,
    semanticSourceBytes,
    identities: materialized.identities,
    candidateRecords: materialized.candidateRecords,
  });
  assert.deepEqual(semanticDecisionSource.counts, {
    included: 20,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 0,
  });
  assert.equal(semanticDecisionSource.selection.selected.length, 20);
  assert.equal(semanticDecisionSource.selection.reserve.length, 0);

  const currentRootDecisionSource = await readSemanticDecisionSourceArtifact(CURRENT_ROOT_SOURCE_PATH);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(currentRootDecisionSource.source.canonical_records_sha256, currentDigest, 'current root semantic decision source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  buildSemanticAuditFromDecisionSource(currentCanonical.records, currentRootDecisionSource, {
    artifactId: 'issue-219-current-complete-canonical-semantic-audit',
    batchDecisionSources,
  });

  const prospectiveRecords = [...historicalCanonical.records, ...importRecords];
  const projectedDecisionSource = projectDecisionSourceToCanonical(currentRootDecisionSource, prospectiveRecords);
  const semanticAudit = buildSemanticAuditFromDecisionSource(prospectiveRecords, projectedDecisionSource, {
    artifactId: 'issue-219-prospective-canonical-semantic-audit',
    baseRecords: historicalCanonical.records,
    batchDecisionSources,
  });
  const reviewRows = productionReviewRows(materialized.identities, materialized.candidateRecords, semanticDecisionSource, {
    semanticReviewSourcePath: 'data/batches/issue-219-m9-a-semantic-decisions.json',
    verificationPassId: VERIFICATION_PASS_ID,
  });
  const production = validateLexicalProduction({
    batchId: semanticSource.batch_id,
    candidateRecords: materialized.candidateRecords,
    reviews: reviewRows,
    baseRecords: historicalCanonical.records,
    prospectiveRecords,
    semanticAudit,
    stageEvidence: productionStageEvidence({
      candidateSourceBytes,
      semanticSourceBytes,
      prospectiveRecords,
      semanticAudit,
      issue: 219,
      batchId: semanticSource.batch_id,
      generationPassId: candidateSource.generation_pass_id,
      verificationPassId: VERIFICATION_PASS_ID,
      candidateSourcePath: 'data/batches/issue-219-m9-a-lexical-unit-source.json',
      semanticSourcePath: 'data/batches/issue-219-m9-a-semantic-decisions.json',
    }),
    catalogCount: 20,
    expectedSelectedCount: 20,
    candidateLabel: 'Issue #219 shared production candidates',
    reviewedLabel: 'Issue #219 source-bound candidate decisions',
    prospectiveLabel: 'Issue #219 complete prospective canonical records',
  });
  assert.equal(production.admission?.audit?.blocking_finding_count, 0, 'ordinary shared lexical admission blockers');
  assert.equal(production.admission?.semantic_audit?.coverage_complete, true, 'complete prospective semantic audit coverage');

  const currentImportIds = new Set(importRecords.map(({ id }) => id));
  assert.equal(currentImportIds.size, 20);
  for (const record of importRecords) assert.deepEqual(currentById.get(record.id), record, `${record.id} live canonical admission`);
  const selectedIds = new Set(selectedInventoryIds);
  assert.equal(currentSeed.targets.filter(({ inventory_id: id }) => selectedIds.has(id)).length, 0,
    'promoted M9 rows move from deferred seed ownership into the promotion ledger');
  const ledgerText = await readFile(DEFAULT_PROMOTION_PATH, 'utf8');
  const ledgerRows = ledgerText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const issue219LedgerRows = ledgerRows.filter(({ batch_id: batchId }) => batchId === BATCH_ID);
  assert.equal(issue219LedgerRows.length, 20);
  const decisionSourceDigest = sha256Bytes(semanticSourceBytes);
  for (const row of issue219LedgerRows) {
    const identity = materialized.identities.find(({ inventory_id: id }) => id === row.inventory_id);
    const record = importRecords.find(({ id }) => id === row.canonical_id);
    const decision = semanticSource.decisions.find(({ candidate_record_id: id }) => id === row.canonical_id);
    assert.ok(identity && record && decision, `${row.inventory_id} promotion binding`);
    assert.equal(row.decision, 'included');
    assert.equal(row.decision_source_id, semanticSource.source_id);
    assert.equal(row.decision_source_sha256, semanticSource.artifact_sha256);
    assert.equal(row.record_sha256, sha256Json(record));
    assert.equal(row.decision_row_sha256, authoredSemanticDecisionRowDigest(decision));
    assert.equal(row.canonical_id, identity.candidate_record_id);
  }

  const inventoryValidation = await validateTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: DEFAULT_SEED_PATH,
    promotionPath: DEFAULT_PROMOTION_PATH,
    checkPilotCompleteness: true,
  });
  const searchResults = await validateExactSearch({
    baseRecords: historicalCanonical.records,
    admittedRecords: importRecords,
    units: candidateSource.units,
    batchLabel: 'Issue #219',
    temporaryPrefix: 'typewriter-issue-219-search-',
    workflowLemmas: [],
  });
  const logicalDatabase = await validateDeterministicCurrentBuild();

  const candidateRows = materialized.identities.map((identity) => {
    const record = importRecords.find(({ id }) => id === identity.candidate_record_id);
    const decision = semanticSource.decisions.find(({ candidate_record_id: id }) => id === record.id);
    return {
      selection_order: identity.catalog_index + 1,
      inventory_id: identity.inventory_id,
      canonical_id: identity.candidate_record_id,
      lemma: identity.lemma,
      pos: identity.pos,
      record_type: identity.record_type,
      source_unit_id: identity.source_basis.source_unit_id,
      decision: decision.decision,
      relation_count: record.senses.reduce((count, sense) => count + (sense.relations?.length ?? 0), 0),
      baseline_exact_result_ids: searchResults[record.lemma].baseline_result_ids,
      search_result_ids: searchResults[record.lemma].result_ids,
    };
  });
  const outcomes = {
    reviewed_count: 20,
    admitted_count: importRecords.length,
    held_count: semanticDecisionSource.counts.held,
    rejected_count: semanticDecisionSource.counts.rejected,
    corrected_count: semanticDecisionSource.counts.corrected,
    duplicate_count: 0,
    search_collision_count: 0,
    new_sense_count: importRecords.reduce((count, record) => count + record.senses.length, 0),
    new_relation_count: importRecords.reduce((count, record) => count + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0), 0),
    new_expression_count: importRecords.filter(({ record_type: type }) => type === 'expression').length,
    zero_relation_admission_count: importRecords.filter((record) => record.senses.every((sense) => (sense.relations ?? []).length === 0)).length,
    defect_classes: [],
    review_duration: 'NOT_MEASURED',
  };
  assert.equal(outcomes.new_relation_count, 0);
  assert.equal(outcomes.zero_relation_admission_count, 20);
  assert.equal(outcomes.admitted_count, 20);

  const report = {
    schema_version: 1,
    report_id: 'issue-219-m9-lexical-batch-report-v1',
    issue: 219,
    parent_issue: 218,
    batch_id: BATCH_ID,
    baseline: {
      canonical_commit: selection.baseline.canonical_commit,
      issue_210_inventory_sha256: BASELINE_INVENTORY_SHA256,
      canonical_sha256: selection.baseline.canonical_records_sha256,
      seed_sha256: selection.baseline.seed_sha256,
      canonical_start_count: historicalCanonical.records.filter((recordInfo) => recordOf(recordInfo).role === 'start').length,
    },
    selection: {
      policy_id: selection.policy.id,
      eligible_capacity_reserve_count: selection.policy.eligible_reserve_count,
      cohort: selection.policy.cohort,
      cohort_count: selection.policy.cohort_count,
      selection_order: selection.policy.selected_order,
      candidate_source_sha256: sha256Bytes(candidateSourceBytes),
      semantic_source_sha256: decisionSourceDigest,
    },
    outcomes,
    candidates: candidateRows,
    current: {
      canonical_sha256: currentDigest,
      canonical_start_count: currentCanonical.records.filter((recordInfo) => recordOf(recordInfo).role === 'start').length,
      inventory_validation: inventoryValidation.status ?? 'pass',
      production_admission: 'pass',
      semantic_audit: 'pass',
      deterministic_sqlite: 'pass',
      logical_database_record_count: logicalDatabase.rows.records.length,
      logical_database_digest: sha256Json(logicalDatabaseContentSnapshot(logicalDatabase)),
    },
  };
  await validateReportSchema(report);
  const renderedReport = renderReport(report);
  if (writeReport) {
    await Promise.all([
      writeFile(REPORT_PATH, renderedReport, 'utf8'),
      writeFile(MACHINE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    ]);
  } else {
    const [storedReport, storedMachineReport] = await Promise.all([
      readFile(REPORT_PATH, 'utf8'),
      readFile(MACHINE_REPORT_PATH, 'utf8'),
    ]);
    assert.equal(storedReport, renderedReport, 'Issue #219 Markdown report is stale; run npm run batch:issue-219:report');
    assert.equal(storedMachineReport, `${JSON.stringify(report, null, 2)}\n`, 'Issue #219 machine report is stale; run npm run batch:issue-219:report');
  }

  return {
    reviewed_count: outcomes.reviewed_count,
    admitted_start_count: outcomes.admitted_count,
    held_count: outcomes.held_count,
    rejected_count: outcomes.rejected_count,
    corrected_count: outcomes.corrected_count,
    relation_count: outcomes.new_relation_count,
    zero_relation_admission_count: outcomes.zero_relation_admission_count,
    batch_size_calibration: 20,
    review_duration: outcomes.review_duration,
    production_admission: report.current.production_admission,
    inventory_validation: report.current.inventory_validation,
    canonical_start_count: report.current.canonical_start_count,
    search_results: Object.fromEntries(importRecords.map(({ lemma }) => [lemma, searchResults[lemma]])),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  validateIssue219({ writeReport: process.argv.includes('--write-report') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

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
import { EXACT_SEARCH_ROWS_SQL } from '../../src/runtime/sqlite-query.js';
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
  M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';
import {
  materializeLexicalUnitCandidates,
  validateLexicalProduction,
} from './lexical-production.mjs';
import { productionValueSha256 } from './lexical-production-state.mjs';
import {
  productionReviewRows,
  productionStageEvidence,
  projectDecisionSourceToCanonical,
  validateExactSearch,
} from './validate-issue-211.mjs';
import {
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CANDIDATE_SOURCE,
  buildM513CandidateRecords,
} from './m5-13-candidate-source.mjs';
import { validateM513DecisionSource } from './m5-13-decision-source.mjs';
import { selectionOutcomeById } from './lexical-selection.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const SELECTION_PATH = path.join(ROOT, 'data/batches/issue-220-m9-b-selection.json');
const BASE_CANONICAL_DIRECTORY = path.join(ROOT, 'data/batches/issue-220-m9-b-base-canonical');
const BASE_SEED_PATH = path.join(ROOT, 'data/batches/issue-220-m9-b-base-seed.json');
const BASE_INVENTORY_PATH = path.join(ROOT, 'data/batches/issue-220-m9-b-base-issue-210-recovery-inventory.json');
const CURRENT_ROOT_SOURCE_PATH = path.join(ROOT, 'data/validation/canonical-semantic-decision-source.json');
const REPORT_PATH = path.join(ROOT, 'docs/issue-220-m9-b-checkpoint.md');
const MACHINE_REPORT_PATH = path.join(ROOT, 'data/validation/issue-220-m9-b-checkpoint-report.json');
const REPORT_SCHEMA_PATH = path.join(ROOT, 'schema/issue-220-m9-b-checkpoint-report.schema.json');
const CURRENT_INVENTORY_PATH = path.join(ROOT, 'data/inventory/issue-210-recovery-inventory.json');
const M5_13_SOURCE_PATH = path.join(ROOT, 'data/batches/m5-13-lexical-unit-source.json');
const M5_13_DECISION_PATH = path.join(ROOT, 'data/batches/m5-13-semantic-decisions.json');
const BATCHES = Object.freeze([
  {
    number: 1,
    candidatePath: path.join(ROOT, 'data/batches/issue-220-m9-b-batch-01-lexical-unit-source.json'),
    candidateRelativePath: 'data/batches/issue-220-m9-b-batch-01-lexical-unit-source.json',
    semanticPath: path.join(ROOT, 'data/batches/issue-220-m9-b-batch-01-semantic-decisions.json'),
    semanticRelativePath: 'data/batches/issue-220-m9-b-batch-01-semantic-decisions.json',
    importPath: path.join(ROOT, 'data/canonical/issue-220-m9-b-batch-01.jsonl'),
    importRelativePath: 'data/canonical/issue-220-m9-b-batch-01.jsonl',
  },
  {
    number: 2,
    candidatePath: path.join(ROOT, 'data/batches/issue-220-m9-b-batch-02-lexical-unit-source.json'),
    candidateRelativePath: 'data/batches/issue-220-m9-b-batch-02-lexical-unit-source.json',
    semanticPath: path.join(ROOT, 'data/batches/issue-220-m9-b-batch-02-semantic-decisions.json'),
    semanticRelativePath: 'data/batches/issue-220-m9-b-batch-02-semantic-decisions.json',
    importPath: path.join(ROOT, 'data/canonical/issue-220-m9-b-batch-02.jsonl'),
    importRelativePath: 'data/canonical/issue-220-m9-b-batch-02.jsonl',
  },
]);
const BASELINE_INVENTORY_SHA256 = '5dbe54ee92b5f8548e41208a46e73f5b68c3fb1d1562afefd5a39f85d9670dde';
const BASELINE_CANONICAL_SHA256 = '93f4939c782b7d766774deb89c012f14d88609782570f46a184f3f53efe9686e';
const NORMAL_CI_RESULT = 'pending';
const REMAINING_RECOVERY_DISPOSITIONS = Object.freeze([
  'admit-candidate',
  'duplicate',
  'hold',
  'invalid-lemma',
  'needs-sense-split',
  'not-a-lexical-unit',
  'search-surface-collision',
  'unsupported-scope',
  'wrong-pos',
]);
const ISSUE_220_SYSTEM_FIXES = Object.freeze([
  {
    area: 'single-sense writer-boundary admission',
    batches: [1, 2],
    files: ['scripts/validate/lexical-quality.mjs', 'scripts/batch/authored-semantic-decision-source.mjs'],
    summary: 'The shared source-bound gate requires exact-gloss frame spans and compares sentence frames together with writer routes; unresolved splits stay held until a multi-sense candidate is authored.',
  },
  {
    area: 'historical candidate materialization',
    batches: [1, 2],
    files: ['scripts/batch/lexical-production.mjs'],
    summary: 'The common producer accepts explicit historical inventory identities and retains source positions when a pinned source pool is split into bounded review batches.',
  },
  {
    area: 'authored semantic evidence projection',
    batches: [1],
    files: ['scripts/batch/validate-issue-211.mjs'],
    summary: 'The common producer projects authored topic_analysis and topic_analyses into the shared semantic evidence for the exact reviewed span, including w5399.',
  },
  {
    area: 'surface-form decision coverage',
    batches: [2],
    files: ['data/validation/m6-3-surface-form-review.json'],
    summary: 'Added sense-bound M6-3 decisions for the two admitted verb senses whose regular inflection or open-vowel past projection needed explicit review; the shared projection remains fail-closed.',
  },
]);
const LOGICAL_CONTENT_EXCLUDED_METADATA_KEYS = new Set([
  'source_revision',
  'source_revision_source',
  'source_revision_verified',
  'worktree_state',
  'node_version',
  'sqlite_module',
  'sqlite_version',
]);

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
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

function semanticDecisionConfig(candidateSource, semanticSource, batch) {
  return {
    label: `Issue #220 batch ${batch.number}`,
    errorPrefix: 'ISSUE_220',
    sourcePath: batch.semanticRelativePath,
    sourceId: semanticSource.source_id,
    candidateSourceId: candidateSource.source_id,
    batchId: semanticSource.batch_id,
    issue: 220,
    parentIssue: 218,
    generationPassId: candidateSource.generation_pass_id,
    verificationPassId: semanticSource.provenance.verification_pass_id,
    correctionPassId: `issue-220-agent-correction-20260929-batch-${String(batch.number).padStart(2, '0')}`,
    semanticReviewVersion: semanticSource.provenance.generator_version,
    selectionPolicy: 'shared-authored-axis-coverage-selection-v6',
    selectionCount: candidateSource.candidate_count,
    importCountFromDecisions: true,
    noAdmissionQuota: true,
    reserveCount: 0,
    requireSingleSenseBoundaryReview: true,
    expressionLexicalUnitReviewContractVersion: M9_EXPRESSION_LEXICAL_UNIT_REVIEW_CONTRACT_VERSION,
  };
}

export function validateIssue220SemanticDecisionSource({
  candidateSource,
  semanticSource,
  semanticSourceBytes,
  identities,
  candidateRecords,
  batch,
} = {}) {
  return validateAuthoredSemanticDecisionSource({
    source: semanticSource,
    sourceBytes: semanticSourceBytes,
    identities,
    candidateRecords,
    config: semanticDecisionConfig(candidateSource, semanticSource, batch),
  });
}

function assertPinnedSelection({
  selection,
  baseInventory,
  baseInventoryBytes,
  baseSeedBytes,
  baseRecords,
  m513SourceBytes,
  m513DecisionBytes,
}) {
  assert.equal(selection.schema_version, '1');
  assert.equal(selection.contract_version, 'm9-recovery-batch-selection-v2');
  assert.equal(selection.issue, 220);
  assert.equal(selection.parent_issue, 218);
  assert.equal(selection.selected_count, 40);
  assert.equal(selection.baseline.issue_210_inventory_sha256, BASELINE_INVENTORY_SHA256);
  assert.equal(sha256Bytes(baseInventoryBytes), BASELINE_INVENTORY_SHA256, 'frozen Issue #210 inventory digest');
  assert.equal(sha256Bytes(m513SourceBytes), selection.prior_source_bindings.candidate_source.file_sha256);
  assert.equal(M5_13_CANDIDATE_SOURCE.artifact_sha256, selection.prior_source_bindings.candidate_source.artifact_sha256);
  assert.equal(sha256Bytes(m513DecisionBytes), selection.prior_source_bindings.semantic_decisions.file_sha256);
  assert.equal(selection.policy.id, 'm9-historical-capacity-reserve-prefix-v1');
  assert.equal(selection.policy.eligible_reserve_count, 54);
  assert.equal(selection.policy.selected_count, 40);
  assert.equal(selection.policy.batch_size, 20);
  assert.equal(selection.selected_candidates.length, 40);
  assert.equal(baseRecords.length, selection.baseline.canonical_record_count);
  assert.equal(baseRecords.filter((info) => recordOf(info).role === 'start').length, selection.baseline.canonical_start_count);
  assert.equal(canonicalRecordsSha256(baseRecords), BASELINE_CANONICAL_SHA256);
  assert.equal(canonicalRecordsSha256(baseRecords), selection.baseline.canonical_records_sha256);
  assert.equal(sha256Bytes(baseSeedBytes), selection.baseline.seed_sha256);

  const m513Records = buildM513CandidateRecords();
  const priorDecision = validateM513DecisionSource({
    source: JSON.parse(m513DecisionBytes.toString('utf8')),
    sourceBytes: m513DecisionBytes,
    candidateRecords: m513Records,
  });
  const outcomes = selectionOutcomeById(priorDecision.selection);
  const identityByCandidateId = new Map(M5_13_CANDIDATE_IDENTITIES.map((identity) => [identity.candidate_record_id, identity]));
  const oldRecordById = new Map(m513Records.map((record) => [record.id, record]));
  const sourceUnitById = new Map(M5_13_CANDIDATE_SOURCE.units.map((unit) => [unit.source_unit_id, unit]));
  const inventoryById = new Map(baseInventory.recovery_candidates.map((row) => [row.source_inventory_id, row]));
  const expectedReserves = M5_13_CANDIDATE_IDENTITIES
    .filter(({ candidate_record_id: id }) => outcomes.get(id) === 'reserve')
    .sort((left, right) => Number(left.inventory_id.slice(3)) - Number(right.inventory_id.slice(3)));
  assert.equal(expectedReserves.length, 54, 'M5-13 fit reserve population');
  const selectedExpected = expectedReserves.slice(0, 40);
  const selectedInventoryIds = selection.selected_candidates.map(({ source_inventory_id: id }) => id);
  assert.deepEqual(selectedInventoryIds, selectedExpected.map(({ inventory_id: id }) => id), 'selected rows are the first 40 numeric M5-13 reserves');

  for (const [index, item] of selection.selected_candidates.entries()) {
    const identity = selectedExpected[index];
    const previousDecision = priorDecision.rows.find(({ candidate_record_id: id }) => id === identity.candidate_record_id);
    const previousRecord = oldRecordById.get(identity.candidate_record_id);
    const sourceUnit = sourceUnitById.get(identity.source_basis.source_unit_id);
    const inventoryRow = inventoryById.get(identity.inventory_id);
    assert.ok(previousDecision && previousRecord && sourceUnit && inventoryRow, `${identity.inventory_id} pinned lineage exists`);
    assert.equal(previousDecision.decision, 'included');
    assert.equal(previousDecision.gloss_judgment, 'fit');
    assert.equal(outcomes.get(identity.candidate_record_id), 'reserve');
    assert.equal(previousDecision.candidate_record_sha256, sha256Json(previousRecord));
    assert.equal(item.historical_candidate_record_sha256, previousDecision.candidate_record_sha256);
    assert.equal(item.historical_decision_row_sha256, authoredSemanticDecisionRowDigest(previousDecision));
    assert.deepEqual(item.source_inventory_row, inventoryRow, `${identity.inventory_id} frozen inventory row`);
    assert.equal(item.source_inventory_row_sha256, productionValueSha256(inventoryRow));
    assert.equal(item.source_inventory_row.new_review_state, 'admit-candidate');
    assert.equal(item.source_inventory_row.current_canonical_search_coverage.status, 'no-canonical-lemma-match');
    assert.deepEqual(item.current_source_unit, sourceUnit);
    assert.equal(item.historical_candidate_record_id, identity.candidate_record_id);
    assert.equal(item.historical_source_unit_id, identity.source_basis.source_unit_id);
    assert.equal(item.historical_selection_outcome, 'reserve');
    assert.deepEqual(item.admitted_identity, {
      inventory_id: identity.inventory_id,
      historical_candidate_record_id: identity.candidate_record_id,
      candidate_record_id: `w${5383 + index + 1}`,
      lemma: identity.lemma,
    });
    assert.equal(item.batch_number, index < 20 ? 1 : 2);
    assert.equal(item.order, index + 1);
  }
  return selectedExpected;
}

function assertCandidateSourceBindsSelection(
  candidateSource,
  selectedRows,
  expectedHistoricalIdentities,
  selection,
  baseSeedBytes,
  baseInventoryBytes,
  baseCanonicalRecords,
) {
  assert.equal(candidateSource.contract_version, 'lexical-candidate-source-v2');
  assert.equal(candidateSource.kind, 'typewriter-authored-lexical-unit-source');
  assert.equal(candidateSource.authoring_mode, 'historical-typewriter-authored-source-slice');
  assert.match(candidateSource.batch_id, /^m9-b-issue-220-historical-batch-(01|02)-20260929$/u);
  assert.equal(candidateSource.candidate_count, 20);
  assert.equal(candidateSource.units.length, 20);
  assert.equal(candidateSource.base_canonical_records_sha256, selection.baseline.canonical_records_sha256);
  assert.equal(candidateSource.base_seed_sha256, sha256Bytes(baseSeedBytes));
  assert.equal(candidateSource.base_issue_210_inventory_sha256, sha256Bytes(baseInventoryBytes));
  assert.equal(canonicalRecordsSha256(baseCanonicalRecords), candidateSource.base_canonical_records_sha256);
  assert.equal(candidateSource.pool_sha256, productionValueSha256(candidateSource.units));
  for (const [index, row] of selectedRows.entries()) {
    const unit = candidateSource.units[index];
    assert.equal(unit.source_unit_id, row.historical_source_unit_id);
    assert.equal(unit.inventory_id, row.admitted_identity.inventory_id);
    assert.equal(unit.candidate_record_id, row.admitted_identity.candidate_record_id);
    assert.equal(unit.historical_candidate_record_id, row.historical_candidate_record_id);
    assert.equal(unit.historical_candidate_record_sha256, row.historical_candidate_record_sha256);
    assert.equal(unit.historical_decision_row_sha256, row.historical_decision_row_sha256);
    assert.equal(unit.historical_selection_outcome, 'reserve');
    assert.equal(unit.source_inventory_row_sha256, row.source_inventory_row_sha256);
    for (const key of ['lemma', 'axis', 'flags', 'record_type', 'pos', 'source_kind', 'writer_use', 'writer_gloss']) {
      assert.deepEqual(unit[key], row.current_source_unit[key], `${unit.source_unit_id} preserves source field ${key}`);
    }
    const historicalIdentity = expectedHistoricalIdentities[index];
    assert.equal(historicalIdentity.inventory_id, row.source_inventory_id);
    assert.deepEqual(unit.source_position, historicalIdentity.source_basis.source_position);
  }
}

function logicalDatabaseContentSnapshot(snapshot) {
  return {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      metadata: snapshot.rows.metadata.filter(({ key }) => !LOGICAL_CONTENT_EXCLUDED_METADATA_KEYS.has(key)),
    },
  };
}

async function validateDeterministicBuild(currentRecords) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-220-determinism-'));
  const snapshots = [];
  let searchableLemmaCount = 0;
  let searchCoverage;
  let surfaceFormRegressions;
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
        const snapshot = readLogicalDatabaseSnapshot(database);
        if (name === 'first') {
          const { findRecordsByExactTerm, findRecordsBySearchTerm } = await import('../build/query.mjs');
          const directQuery = database.prepare(EXACT_SEARCH_ROWS_SQL);
          const expectedOwnersByForm = new Map();
          const nonSearchableRecords = [];
          for (const info of currentRecords) {
            const record = recordOf(info);
            const matches = findRecordsByExactTerm(database, record.lemma).map(({ id }) => id);
            assert.ok(matches.includes(record.id), `${record.id} lemma ${record.lemma} is directly searchable`);
            const directLemmaIds = new Set(directQuery.all(record.lemma, record.lemma).map(({ id }) => id));
            if (!directLemmaIds.has(record.id)) {
              nonSearchableRecords.push({
                record_id: record.id,
                lemma: record.lemma,
                reason: 'No exact canonical lemma or search-form row resolves to the owning record.',
              });
            }
            for (const form of new Set(record.search_forms ?? [])) {
              const owners = expectedOwnersByForm.get(form) ?? new Set();
              owners.add(record.id);
              expectedOwnersByForm.set(form, owners);
            }
            searchableLemmaCount += 1;
          }
          let expectedFormOwnerKeyCount = 0;
          let coveredFormOwnerKeyCount = 0;
          let missingFormOwnerKeyCount = 0;
          let unexpectedFormOwnerKeyCount = 0;
          let crossRecordCollisionKeyCount = 0;
          for (const [form, expectedOwners] of expectedOwnersByForm) {
            expectedFormOwnerKeyCount += expectedOwners.size;
            if (expectedOwners.size > 1) crossRecordCollisionKeyCount += 1;
            const actualOwners = new Set(directQuery.all(form, form).map(({ id }) => id));
            for (const owner of expectedOwners) {
              if (actualOwners.has(owner)) coveredFormOwnerKeyCount += 1;
              else missingFormOwnerKeyCount += 1;
            }
            for (const owner of actualOwners) {
              if (!expectedOwners.has(owner)) unexpectedFormOwnerKeyCount += 1;
            }
          }
          assert.deepEqual(nonSearchableRecords, [], 'every canonical record has a directly searchable exact lemma');
          assert.equal(missingFormOwnerKeyCount, 0, 'every canonical search-form owner is directly indexed');
          assert.equal(unexpectedFormOwnerKeyCount, 0, 'exact canonical forms do not resolve to unexpected direct owners');
          assert.equal(crossRecordCollisionKeyCount, 0, 'canonical search forms have no cross-record collisions');
          searchCoverage = {
            expected_lemma_count: currentRecords.length,
            covered_lemma_count: searchableLemmaCount,
            non_searchable_record_count: nonSearchableRecords.length,
            non_searchable_records: nonSearchableRecords,
            distinct_search_form_count: expectedOwnersByForm.size,
            expected_form_owner_key_count: expectedFormOwnerKeyCount,
            covered_form_owner_key_count: coveredFormOwnerKeyCount,
            missing_form_owner_key_count: missingFormOwnerKeyCount,
            unexpected_form_owner_key_count: unexpectedFormOwnerKeyCount,
            cross_record_collision_key_count: crossRecordCollisionKeyCount,
          };
          const regressionCases = [
            {
              record_id: 'w5418',
              lemma: '되새기다',
              included_forms: ['되새기는', '되새긴', '되새길'],
              excluded_forms: ['되새겼다'],
            },
            {
              record_id: 'w5423',
              lemma: '떠나보내다',
              included_forms: ['떠나보내는', '떠나보낸', '떠나보낼'],
              excluded_forms: ['떠나보냈다'],
            },
          ];
          for (const regression of regressionCases) {
            for (const form of regression.included_forms) {
              const matches = findRecordsBySearchTerm(database, form).matches;
              assert.ok(matches.some(({ id, match }) => (
                id === regression.record_id && match.kind === 'generated-surface-form'
              )), `${regression.lemma} includes reviewed generated form ${form}`);
            }
            for (const form of regression.excluded_forms) {
              const matches = findRecordsBySearchTerm(database, form).matches;
              assert.ok(!matches.some(({ id }) => id === regression.record_id), `${regression.lemma} excludes unsupported generated form ${form}`);
            }
          }
          surfaceFormRegressions = regressionCases.map((regression) => ({
            ...regression,
            result: 'pass',
          }));
        }
        snapshots.push(snapshot);
      } finally {
        database.close();
      }
    }
    assert.deepEqual(snapshots[1], snapshots[0], 'repeated current canonical builds have equal logical contents');
    return { snapshot: snapshots[0], searchableLemmaCount, searchCoverage, surfaceFormRegressions };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function defectFindingsFor(candidates) {
  const unresolved = candidates.filter(({ decision, candidate_record_id: id }) => (
    decision === 'held' && id !== 'w5398'
  ));
  const projectionGap = candidates.filter(({ candidate_record_id: id }) => id === 'w5399');
  const singleSenseUnderSplits = candidates.filter(({ candidate_record_id: id }) => id === 'w5398');
  const surfaceDispositionGaps = candidates.filter(({ candidate_record_id: id, decision }) => (
    ['w5418', 'w5423'].includes(id) && decision === 'included'
  ));
  assert.equal(unresolved.length, 21);
  assert.equal(projectionGap.length, 1);
  assert.equal(projectionGap[0].batch_number, 1);
  assert.equal(singleSenseUnderSplits.length, 1);
  assert.deepEqual(singleSenseUnderSplits.map(({ candidate_record_id: id }) => id), ['w5398']);
  assert.deepEqual(singleSenseUnderSplits.map(({ batch_number: batch }) => batch), [1]);
  assert.equal(surfaceDispositionGaps.length, 2);
  assert.ok(surfaceDispositionGaps.every(({ batch_number: batch }) => batch === 2));
  return [
    {
      defect_class: 'Historical lexical-unit fixedness is not established by the retained source',
      occurrence_count: unresolved.length,
      affected_batches: [...new Set(unresolved.map(({ batch_number: batch }) => batch))],
      affected_candidate_ids: unresolved.map(({ candidate_record_id: id }) => id),
      disposition: 'Held by the shared source-bound lexical-unit contract; no row-specific admission exception was added.',
    },
    {
      defect_class: 'Authored topic-span analysis was omitted from the shared production evidence projection',
      occurrence_count: projectionGap.length,
      affected_batches: [1],
      affected_candidate_ids: projectionGap.map(({ candidate_record_id: id }) => id),
      disposition: 'Fixed in the shared projection so authored topic_analysis and topic_analyses reach the exact-span semantic audit.',
    },
    {
      defect_class: 'A fresh one-sense gloss combined distinct sentence frames and writer routes',
      occurrence_count: singleSenseUnderSplits.length,
      affected_batches: [1],
      affected_candidate_ids: singleSenseUnderSplits.map(({ candidate_record_id: id }) => id),
      disposition: 'Kept the candidate held until separately reviewed senses are authored; the shared frame-and-route gate requires a genuine writer-route difference, not a different argument frame alone.',
    },
    {
      defect_class: 'Two admitted verb senses needed explicit M6-3 surface-form decisions',
      occurrence_count: surfaceDispositionGaps.length,
      affected_batches: [2],
      affected_candidate_ids: surfaceDispositionGaps.map(({ candidate_record_id: id }) => id),
      disposition: 'Added sense-bound authored classifications/exclusions to the shared M6-3 review source; the common projection gate remains fail-closed.',
    },
  ];
}

function renderReport(report) {
  const recoveryCeiling = report.historical_pool.recovery_ceiling;
  const recoveryCeilingVsTarget = recoveryCeiling >= report.historical_pool.target_count
    ? `${(recoveryCeiling - report.historical_pool.target_count).toLocaleString('en-US')} above 6,000`
    : `${(report.historical_pool.target_count - recoveryCeiling).toLocaleString('en-US')} short of 6,000`;
  const candidateRows = report.candidates.map((candidate) => (
    `| ${candidate.selection_order} | ${candidate.batch_number} | ${candidate.inventory_id} | ${candidate.lemma} | ${candidate.decision} | ${candidate.lexical_unit_status} | ${candidate.canonical_id ?? '—'} |`
  )).join('\n');
  return [
    '# Issue #220 — M9-B historical recovery checkpoint',
    '',
    '## Scope and selection',
    '',
    'This checkpoint re-opened the first 40 numeric M5-13 Typewriter-authored fit reserves from the pinned Issue #210 historical inventory. The earlier M5 fit/reserve result sets lineage and review order only. Every row received a fresh Issue #220 decision and passed the shared source-bound producer, semantic audit, admission, and exact-search boundary before an admitted record entered canonical data.',
    '',
    'The two independent review slices contain 20 rows each. There was no admission or relation quota. A held row remains in the target inventory with its unresolved lexical-unit or sense-boundary basis; it is not counted as a canonical recovery.',
    '',
    '## Outcome',
    '',
    '| Measure | Result |',
    '| --- | ---: |',
    `| Reviewed | ${report.outcomes.reviewed_count} |`,
    `| Admitted and searchable | ${report.outcomes.admitted_count} |`,
    `| Held for unresolved lexical or sense boundaries | ${report.outcomes.held_count} |`,
    `| Rejected | ${report.outcomes.rejected_count} |`,
    `| Duplicates | ${report.outcomes.duplicate_count} |`,
    `| Search collisions | ${report.outcomes.collision_count} |`,
    `| Corrected | ${report.outcomes.corrected_count} (${(report.outcomes.correction_rate * 100).toFixed(1)}% of reviewed) |`,
    `| Relations added | ${report.outcomes.relation_count} |`,
    `| Admitted with zero relations | ${report.outcomes.zero_relation_admission_count} |`,
    '',
    '| Batch | Reviewed | Admitted | Held | Rejected | Duplicate | Collision | Corrected |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.batches.map((batch) => `| ${batch.number} | ${batch.reviewed_count} | ${batch.admitted_count} | ${batch.held_count} | ${batch.rejected_count} | ${batch.duplicate_count} | ${batch.collision_count} | ${batch.corrected_count} |`),
    '',
    '## Candidate dispositions',
    '',
    '| Order | Batch | Inventory | Lemma | Decision | Lexical-unit status | Canonical ID |',
    '| ---: | ---: | --- | --- | --- | --- | --- |',
    candidateRows,
    '',
    '## Historical checkpoint',
    '',
    `The pinned Issue #210 candidate inventory contains ${report.historical_pool.candidate_count} classified rows. After the 18 M9-B admissions and 20 later M9-D historical recoveries, ${report.historical_pool.potentially_recoverable_after_count} historical rows remain potentially recoverable. Added to the current ${report.current.canonical_record_count.toLocaleString('en-US')} canonical records, they yield a bounded source-pool ceiling of ${report.historical_pool.recovery_ceiling.toLocaleString('en-US')}, ${recoveryCeilingVsTarget}. This is a source-pool limit, not a reason to admit held rows or reconstruct absent candidates.`,
    '',
    '| Remaining Issue #210 disposition | Count |',
    '| --- | ---: |',
    ...report.historical_pool.remaining_counts_by_disposition.map(({ disposition, count }) => `| ${disposition} | ${count} |`),
    `| Recovered in the current inventory | ${report.historical_pool.recovered_count} |`,
    '',
    `Current canonical totals: ${report.current.canonical_record_count.toLocaleString('en-US')} records (${report.current.canonical_start_count.toLocaleString('en-US')} starts and ${report.current.reference_only_count} reference-only records), ${report.current.sense_count.toLocaleString('en-US')} senses, ${report.current.relation_count.toLocaleString('en-US')} relations, and ${report.current.canonical_search_form_count.toLocaleString('en-US')} canonical search-form rows. Relation-empty searchable records: ${report.current.relation_empty_searchable_record_count.toLocaleString('en-US')}.`,
    '',
    '| Record type | Records |',
    '| --- | ---: |',
    ...Object.entries(report.current.record_type_counts).map(([type, count]) => `| ${type} | ${count} |`),
    '',
    'Sense POS distribution:',
    '',
    '| POS | Senses |',
    '| --- | ---: |',
    ...Object.entries(report.current.sense_pos_counts).map(([pos, count]) => `| ${pos} | ${count} |`),
    '',
    `Direct exact lemma coverage: ${report.current.exact_search_coverage.covered_lemma_count}/${report.current.exact_search_coverage.expected_lemma_count}; non-searchable records: ${report.current.exact_search_coverage.non_searchable_record_count}. Exact search-form owner keys: ${report.current.exact_search_coverage.covered_form_owner_key_count}/${report.current.exact_search_coverage.expected_form_owner_key_count}; missing owners: ${report.current.exact_search_coverage.missing_form_owner_key_count}; unexpected owners: ${report.current.exact_search_coverage.unexpected_form_owner_key_count}; cross-record collision keys: ${report.current.exact_search_coverage.cross_record_collision_key_count}.`,
    '',
    '| Surface-form regression | Included forms | Excluded forms | Result |',
    '| --- | --- | --- | --- |',
    ...report.current.surface_form_regressions.map((regression) => `| ${regression.lemma} (${regression.record_id}) | ${regression.included_forms.join(', ')} | ${regression.excluded_forms.join(', ')} | ${regression.result} |`),
    '',
    '## Defect tracking and shared fixes',
    '',
    '| Defect class | Count | Batches | Affected candidate IDs | Resolution |',
    '| --- | ---: | --- | --- | --- |',
    ...report.defect_findings.map((finding) => `| ${finding.defect_class} | ${finding.occurrence_count} | ${finding.affected_batches.join(', ')} | ${finding.affected_candidate_ids.join(', ')} | ${finding.disposition} |`),
    '',
    '| Shared fix area | Batches | Files | Fix |',
    '| --- | --- | --- | --- |',
    ...report.system_fixes.map((fix) => `| ${fix.area} | ${fix.batches.join(', ')} | ${fix.files.join(', ')} | ${fix.summary} |`),
    '',
    `Normal CI: \`${report.normal_ci.command}\` — ${report.normal_ci.result} for canonical digest \`${report.normal_ci.canonical_sha256}\`.`,
    `Extension/Web parity is covered by the normal CI product builds and output-contract validation: ${report.normal_ci.result}.`,
    '',
    '## Reproduction',
    '',
    'Run `npm run batch:issue-220:check` to verify the frozen selection and input digests, both 20-row source-bound reviews, ordinary shared production and semantic audit, promotion/seed/canonical parity, direct search, deterministic SQLite output, and this report. Run `npm run batch:issue-220:report` after an authorized input change to regenerate this Markdown and the machine checkpoint.',
    '',
    'The frozen pre-recovery canonical, seed, and Issue #210 inventory snapshots are project-authored data. No external dictionary or corpus material was added.',
    '',
  ].join('\n');
}

async function validateReportSchema(report) {
  const schema = JSON.parse(await readFile(REPORT_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, `Issue #220 checkpoint report schema: ${ajv.errorsText(validate.errors)}`);
}

export async function validateIssue220({ writeReport = false } = {}) {
  const [selectionBytes, baseSeedBytes, baseInventoryBytes, currentInventoryBytes, m513SourceBytes, m513DecisionBytes] = await Promise.all([
    readFile(SELECTION_PATH),
    readFile(BASE_SEED_PATH),
    readFile(BASE_INVENTORY_PATH),
    readFile(CURRENT_INVENTORY_PATH),
    readFile(M5_13_SOURCE_PATH),
    readFile(M5_13_DECISION_PATH),
  ]);
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  const baseSeed = JSON.parse(baseSeedBytes.toString('utf8'));
  const baseInventory = JSON.parse(baseInventoryBytes.toString('utf8'));
  const currentInventory = JSON.parse(currentInventoryBytes.toString('utf8'));
  assert.equal(sha256Bytes(baseInventoryBytes), BASELINE_INVENTORY_SHA256, 'frozen Issue #210 inventory bytes');
  assert.equal(sha256Bytes(baseSeedBytes), selection.baseline.seed_sha256, 'frozen Issue #220 seed bytes');

  const historicalCanonical = await readCanonicalRecords(BASE_CANONICAL_DIRECTORY);
  const currentCanonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const historicalRecords = historicalCanonical.records.map(recordOf);
  const currentRecords = currentCanonical.records.map(recordOf);
  const selectedExpected = assertPinnedSelection({
    selection,
    baseInventory,
    baseInventoryBytes,
    baseSeedBytes,
    baseRecords: historicalCanonical.records,
    m513SourceBytes,
    m513DecisionBytes,
  });
  const currentById = new Map(currentRecords.map((record) => [record.id, record]));
  const historicalIds = new Set(historicalRecords.map((record) => record.id));
  for (const record of historicalRecords) {
    assert.deepEqual(currentById.get(record.id), record, `${record.id} frozen Issue #220 baseline remains unchanged`);
  }

  const batchResults = [];
  for (const batch of BATCHES) {
    const selectedRows = selection.selected_candidates
      .filter(({ batch_number: number }) => number === batch.number);
    assert.equal(selectedRows.length, 20, `Issue #220 batch ${batch.number} selection size`);
    const [candidateSourceBytes, semanticSourceBytes, importBytes] = await Promise.all([
      readFile(batch.candidatePath),
      readFile(batch.semanticPath),
      readFile(batch.importPath),
    ]);
    const candidateSource = JSON.parse(candidateSourceBytes.toString('utf8'));
    const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
    assert.equal(candidateSource.batch_id, `m9-b-issue-220-historical-batch-${String(batch.number).padStart(2, '0')}-20260929`);
    assert.equal(candidateSource.source_id, semanticSource.candidate_source.source_id);
    assertCandidateSourceBindsSelection(
      candidateSource,
      selectedRows,
      selectedExpected.slice((batch.number - 1) * 20, batch.number * 20),
      selection,
      baseSeedBytes,
      baseInventoryBytes,
      historicalCanonical.records,
    );
    const inventoryIds = selectedRows.map(({ source_inventory_id: id }) => id);
    const materialized = materializeLexicalUnitCandidates({
      batchId: semanticSource.batch_id,
      source: candidateSource,
      sourceBytes: candidateSourceBytes,
      firstInventoryNumber: 1,
      firstCanonicalNumber: 1,
      baseRecords: historicalCanonical.records,
      baseSeedTargets: baseSeed.targets,
      reopenedSeedTargetIds: inventoryIds,
    });
    assert.deepEqual(materialized.identities.map(({ inventory_id: id }) => id), inventoryIds);
    assert.deepEqual(materialized.identities.map(({ candidate_record_id: id }) => id), selectedRows.map(({ admitted_identity: identity }) => identity.candidate_record_id));
    assert.deepEqual(materialized.identities.map(({ lemma }) => lemma), selectedRows.map(({ admitted_identity: identity }) => identity.lemma));
    assert.deepEqual(semanticSource.candidate_records, materialized.candidateRecords, `Issue #220 batch ${batch.number} candidate records equal shared producer output`);
    assert.equal(semanticSource.candidate_records_sha256, sha256Json(materialized.candidateRecords));
    const semanticDecisionSource = validateIssue220SemanticDecisionSource({
      candidateSource,
      semanticSource,
      semanticSourceBytes,
      identities: materialized.identities,
      candidateRecords: materialized.candidateRecords,
      batch,
    });
    assert.equal(semanticDecisionSource.rows.length, 20);
    assert.equal(semanticDecisionSource.counts.included, batch.number === 1 ? 13 : 5);
    assert.equal(semanticDecisionSource.counts.held, batch.number === 1 ? 7 : 15);
    assert.equal(semanticDecisionSource.counts.rejected, 0);
    assert.equal(semanticDecisionSource.selection.reserve.length, 0);
    assert.equal(semanticDecisionSource.selection.selected.length, semanticDecisionSource.counts.included);

    const selectedCandidateIds = new Set(semanticDecisionSource.selection.selected.map(({ candidate_record_id: id }) => id));
    const expectedImportRecords = materialized.candidateRecords.filter(({ id }) => selectedCandidateIds.has(id));
    const importRecords = readJsonl(importBytes, `Issue #220 batch ${batch.number} canonical import`);
    assert.deepEqual(importRecords, expectedImportRecords, `Issue #220 batch ${batch.number} import contains only source-bound admissions`);
    assert.ok(importRecords.every((record) => record.senses.every((sense) => (sense.relations ?? []).length === 0)), 'Issue #220 does not fabricate relations');
    batchResults.push({
      ...batch,
      candidateSource,
      candidateSourceBytes,
      semanticSource,
      semanticSourceBytes,
      semanticDecisionSource,
      materialized,
      importRecords,
      decisionSha256: sha256Bytes(semanticSourceBytes),
      candidateSha256: sha256Bytes(candidateSourceBytes),
    });
  }

  const allImports = batchResults.flatMap(({ importRecords }) => importRecords);
  assert.equal(allImports.length, 18);
  const importedIds = new Set(allImports.map(({ id }) => id));
  assert.equal(importedIds.size, allImports.length);
  const currentAdditions = currentRecords.filter(({ id }) => !historicalIds.has(id));
  const currentIssue220Additions = currentAdditions
    .filter(({ id }) => importedIds.has(id))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    currentIssue220Additions,
    [...allImports].sort((left, right) => left.id.localeCompare(right.id)),
    'current canonical data preserves both complete Issue #220 admitted imports alongside later batches',
  );
  for (const record of allImports) assert.deepEqual(currentById.get(record.id), record, `${record.id} live canonical admission`);

  const currentRootDecisionSource = await readSemanticDecisionSourceArtifact(CURRENT_ROOT_SOURCE_PATH);
  const currentDigest = canonicalRecordsSha256(currentCanonical.records);
  assert.equal(currentRootDecisionSource.source.canonical_records_sha256, currentDigest, 'current root semantic-decision source digest');
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  buildSemanticAuditFromDecisionSource(currentCanonical.records, currentRootDecisionSource, {
    artifactId: 'issue-220-current-complete-canonical-semantic-audit',
    batchDecisionSources,
  });
  const prospectiveRecords = [...historicalCanonical.records, ...allImports];
  const projectedDecisionSource = projectDecisionSourceToCanonical(currentRootDecisionSource, prospectiveRecords);
  const fullProspectiveAudit = buildSemanticAuditFromDecisionSource(prospectiveRecords, projectedDecisionSource, {
    artifactId: 'issue-220-prospective-canonical-semantic-audit',
    baseRecords: historicalCanonical.records,
    batchDecisionSources,
  });
  assert.equal(fullProspectiveAudit.review.records.length, prospectiveRecords.length, 'combined prospective semantic audit covers every canonical record');
  const productionResults = [];
  for (const batch of batchResults) {
    const batchProspectiveRecords = [...historicalCanonical.records, ...batch.importRecords];
    const batchProjectedDecisionSource = projectDecisionSourceToCanonical(currentRootDecisionSource, batchProspectiveRecords);
    const batchSemanticAudit = buildSemanticAuditFromDecisionSource(batchProspectiveRecords, batchProjectedDecisionSource, {
      artifactId: `issue-220-batch-${batch.number}-prospective-semantic-audit`,
      baseRecords: historicalCanonical.records,
      batchDecisionSources,
    });
    const reviews = productionReviewRows(
      batch.materialized.identities,
      batch.materialized.candidateRecords,
      batch.semanticDecisionSource,
      {
        semanticReviewSourcePath: batch.semanticRelativePath,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
      },
    );
    const production = validateLexicalProduction({
      batchId: batch.semanticSource.batch_id,
      candidateRecords: batch.materialized.candidateRecords,
      reviews,
      baseRecords: historicalCanonical.records,
      prospectiveRecords: batchProspectiveRecords,
      semanticAudit: batchSemanticAudit,
      stageEvidence: productionStageEvidence({
        candidateSourceBytes: batch.candidateSourceBytes,
        semanticSourceBytes: batch.semanticSourceBytes,
        prospectiveRecords: batchProspectiveRecords,
        semanticAudit: batchSemanticAudit,
        issue: 220,
        batchId: batch.semanticSource.batch_id,
        generationPassId: batch.candidateSource.generation_pass_id,
        verificationPassId: batch.semanticSource.provenance.verification_pass_id,
        candidateSourcePath: batch.candidateRelativePath,
        semanticSourcePath: batch.semanticRelativePath,
      }),
      catalogCount: 20,
      expectedSelectedCount: batch.importRecords.length,
      candidateLabel: `Issue #220 batch ${batch.number} shared production candidates`,
      reviewedLabel: `Issue #220 batch ${batch.number} source-bound decisions`,
      prospectiveLabel: `Issue #220 batch ${batch.number} prospective canonical records`,
    });
    assert.equal(production.admission?.audit?.blocking_finding_count, 0, `batch ${batch.number} ordinary shared lexical admission blockers`);
    assert.equal(production.admission?.semantic_audit?.coverage_complete, true, `batch ${batch.number} complete prospective semantic audit coverage`);
    productionResults.push(production);
  }

  const promotionText = await readFile(DEFAULT_PROMOTION_PATH, 'utf8');
  const promotionRows = promotionText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const issue220BatchIds = new Set(batchResults.map(({ semanticSource }) => semanticSource.batch_id));
  const issue220Promotions = promotionRows.filter(({ batch_id: id }) => issue220BatchIds.has(id));
  assert.equal(issue220Promotions.length, allImports.length, 'Issue #220 admissions match the promotion ledger');
  for (const row of issue220Promotions) {
    const batch = batchResults.find(({ semanticSource }) => semanticSource.batch_id === row.batch_id);
    const identity = batch.materialized.identities.find(({ inventory_id: id }) => id === row.inventory_id);
    const record = batch.importRecords.find(({ id }) => id === row.canonical_id);
    const decision = batch.semanticSource.decisions.find(({ candidate_record_id: id }) => id === row.canonical_id);
    assert.ok(identity && record && decision, `${row.inventory_id} promotion binding`);
    assert.equal(row.decision, 'included');
    assert.equal(row.decision_source_id, batch.semanticSource.source_id);
    assert.equal(row.decision_source_sha256, batch.semanticSource.artifact_sha256);
    assert.equal(row.record_sha256, sha256Json(record));
    assert.equal(row.decision_row_sha256, authoredSemanticDecisionRowDigest(decision));
    assert.equal(row.canonical_id, identity.candidate_record_id);
  }

  const currentSeed = JSON.parse(await readFile(DEFAULT_SEED_PATH, 'utf8'));
  const issue220InventoryIds = selection.selected_candidates.map(({ source_inventory_id: id }) => id);
  const currentTargetsById = new Map(currentSeed.targets.map((target) => [target.inventory_id, target]));
  const allDecisions = batchResults.flatMap(({ semanticSource }) => semanticSource.decisions);
  for (const decision of allDecisions) {
    const target = currentTargetsById.get(decision.inventory_id);
    if (decision.decision === 'included' || decision.decision === 'corrected') {
      assert.equal(target, undefined, `${decision.inventory_id} admitted rows leave seed ownership`);
    } else {
      assert.equal(target?.status, decision.decision, `${decision.inventory_id} held decision remains in the target seed`);
      assert.equal(target?.planned_role, 'start', `${decision.inventory_id} held lexical entries retain their intended searchable-start role`);
    }
  }
  const issue220SeedTargets = currentSeed.targets.filter(({ inventory_id: id }) => issue220InventoryIds.includes(id));
  assert.equal(issue220SeedTargets.length, 22);
  assert.ok(issue220SeedTargets.every(({ status }) => status === 'held'));

  const inventoryValidation = await validateTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: DEFAULT_SEED_PATH,
    promotionPath: DEFAULT_PROMOTION_PATH,
    checkPilotCompleteness: true,
  });
  const allUnits = batchResults.flatMap(({ candidateSource }) => candidateSource.units);
  const exactSearchResults = await validateExactSearch({
    baseRecords: historicalCanonical.records,
    admittedRecords: allImports,
    units: allUnits,
    batchLabel: 'Issue #220',
    temporaryPrefix: 'typewriter-issue-220-search-',
    workflowLemmas: [],
  });
  const {
    snapshot: logicalDatabase,
    searchableLemmaCount,
    searchCoverage,
    surfaceFormRegressions,
  } = await validateDeterministicBuild(currentCanonical.records);
  assert.equal(searchableLemmaCount, currentRecords.length, 'every current canonical lemma is directly searchable');

  const candidates = batchResults.flatMap((batch) => batch.materialized.identities.map((identity) => {
    const row = batch.semanticSource.decisions.find(({ candidate_record_id: id }) => id === identity.candidate_record_id);
    const record = batch.importRecords.find(({ id }) => id === identity.candidate_record_id);
    const candidate = batch.semanticSource.candidate_records.find(({ id }) => id === identity.candidate_record_id);
    const searchResult = exactSearchResults[identity.lemma];
    return {
      selection_order: selection.selected_candidates.findIndex(({ source_inventory_id: id }) => id === identity.inventory_id) + 1,
      batch_number: batch.number,
      inventory_id: identity.inventory_id,
      candidate_record_id: identity.candidate_record_id,
      canonical_id: record ? identity.candidate_record_id : null,
      lemma: identity.lemma,
      pos: identity.pos,
      record_type: identity.record_type,
      source_unit_id: identity.source_basis.source_unit_id,
      prior_selection_outcome: 'reserve',
      decision: row.decision,
      lexical_unit_status: row.decision === 'held' ? 'unresolved' : 'supported',
      relation_count: (record ?? candidate).senses.reduce((count, sense) => count + (sense.relations?.length ?? 0), 0),
      baseline_exact_result_ids: searchResult?.baseline_result_ids ?? [],
      search_result_ids: searchResult?.result_ids ?? [],
    };
  }));
  const counts = allDecisions.reduce((result, { decision }) => {
    result[decision] = (result[decision] ?? 0) + 1;
    return result;
  }, {});
  const baselineRecoverable = baseInventory.recovery_candidates.filter(({ new_review_state: state }) => (
    ['admit-candidate', 'hold', 'needs-sense-split'].includes(state)
  )).length;
  const admittedCount = counts.included + (counts.corrected ?? 0);
  const recoveryDispositionCounts = countBy(currentInventory.recovery_candidates, ({ new_review_state: state }) => state);
  const laterIssue222HistoricalRecoveries = currentInventory.recovery_candidates.filter(({ historical_decision_events: events, new_review_state: state }) => (
    state === 'recovered'
    && events.some(({ source_issue: issue, source_artifact: artifact, historical_disposition: disposition }) => (
      issue === 222
      && artifact === 'data/batches/issue-222-m9-d-historical-semantic-decisions.json'
      && ['included', 'corrected'].includes(disposition)
    ))
  )).length;
  const remainingRecoveryCounts = REMAINING_RECOVERY_DISPOSITIONS.map((disposition) => ({
    disposition,
    count: recoveryDispositionCounts[disposition] ?? 0,
  }));
  const recoveredCount = recoveryDispositionCounts.recovered ?? 0;
  assert.equal(currentInventory.recovery_candidates.length, baseInventory.recovery_candidates.length);
  assert.equal(
    remainingRecoveryCounts.reduce((total, { count }) => total + count, 0) + recoveredCount,
    currentInventory.recovery_candidates.length,
    'remaining and recovered dispositions partition the current historical pool',
  );
  const currentRecoverable = ['admit-candidate', 'hold', 'needs-sense-split']
    .reduce((total, disposition) => total + (recoveryDispositionCounts[disposition] ?? 0), 0);
  const recoveryCeiling = currentRecords.length + currentRecoverable;
  const duplicateCount = candidates.filter(({ baseline_exact_result_ids: ids }) => ids.length > 0).length;
  const collisionCount = candidates.filter(({ canonical_id: ownId, search_result_ids: ids }) => (
    ownId && ids.some((id) => id !== ownId)
  )).length;
  const correctedCount = counts.corrected ?? 0;
  const correctionRate = allDecisions.length === 0 ? 0 : correctedCount / allDecisions.length;
  const recordTypeCounts = countBy(currentRecords, ({ record_type: type }) => type);
  const sensePosCounts = countBy(currentRecords.flatMap(({ senses = [] }) => senses), ({ pos }) => pos);
  const relationEmptySearchableRecordCount = currentRecords.filter(({ senses = [] }) => (
    senses.every((sense) => (sense.relations ?? []).length === 0)
  )).length;
  const shortfallToTarget = Math.max(0, 6000 - recoveryCeiling);
  assert.equal(currentRecoverable, baselineRecoverable - admittedCount - laterIssue222HistoricalRecoveries, 'remaining disposition counts match Issue #220 and subsequent Issue #222 recovery outcomes');
  assert.equal(recoveredCount, 42 + laterIssue222HistoricalRecoveries, 'Issue #210 inventory includes prior, M9-B, and subsequent M9-D recoveries');
  assert.equal(baselineRecoverable, 545, 'pinned historical potential count');
  assert.equal(laterIssue222HistoricalRecoveries, 20, 'Issue #222 historical recovery count');
  assert.equal(currentRecoverable, 507, 'remaining potentially recoverable historical records');
  assert.equal(recoveryCeiling, currentRecords.length + currentRecoverable, 'current canonical plus remaining historical source pool');
  assert.equal(shortfallToTarget, Math.max(0, 6000 - currentRecords.length - currentRecoverable));

  const report = {
    schema_version: 1,
    report_id: 'issue-220-m9-b-checkpoint-report-v1',
    issue: 220,
    parent_issue: 218,
    selection_id: selection.policy.id,
    baseline: {
      canonical_commit: selection.baseline.canonical_commit,
      canonical_sha256: selection.baseline.canonical_records_sha256,
      canonical_record_count: historicalRecords.length,
      canonical_start_count: historicalRecords.filter(({ role }) => role === 'start').length,
      issue_210_inventory_sha256: BASELINE_INVENTORY_SHA256,
      seed_sha256: selection.baseline.seed_sha256,
      canonical_search_form_count: historicalRecords.reduce((count, record) => count + (record.search_forms?.length ?? 0), 0),
    },
    selection: {
      eligible_capacity_reserve_count: selection.policy.eligible_reserve_count,
      selected_count: selection.selected_candidates.length,
      batch_size: selection.policy.batch_size,
      ordering: selection.policy.selected_order,
      candidate_sources_sha256: batchResults.map(({ candidateSha256 }) => candidateSha256),
      semantic_sources_sha256: batchResults.map(({ decisionSha256 }) => decisionSha256),
    },
    outcomes: {
      reviewed_count: allDecisions.length,
      admitted_count: admittedCount,
      held_count: counts.held ?? 0,
      rejected_count: counts.rejected ?? 0,
      duplicate_count: duplicateCount,
      collision_count: collisionCount,
      corrected_count: correctedCount,
      correction_rate: correctionRate,
      relation_count: allImports.reduce((count, record) => count + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0), 0),
      zero_relation_admission_count: allImports.filter((record) => record.senses.every((sense) => (sense.relations ?? []).length === 0)).length,
    },
    batches: batchResults.map((batch) => ({
      number: batch.number,
      batch_id: batch.semanticSource.batch_id,
      reviewed_count: batch.semanticSource.decisions.length,
      admitted_count: batch.semanticDecisionSource.counts.included + batch.semanticDecisionSource.counts.corrected,
      held_count: batch.semanticDecisionSource.counts.held,
      rejected_count: batch.semanticDecisionSource.counts.rejected,
      duplicate_count: candidates.filter(({ batch_number: number, baseline_exact_result_ids: ids }) => (
        number === batch.number && ids.length > 0
      )).length,
      collision_count: candidates.filter(({ batch_number: number, canonical_id: ownId, search_result_ids: ids }) => (
        number === batch.number && ownId && ids.some((id) => id !== ownId)
      )).length,
      corrected_count: batch.semanticDecisionSource.counts.corrected ?? 0,
    })),
    candidates,
    historical_pool: {
      candidate_count: baseInventory.recovery_candidates.length,
      potentially_recoverable_before_count: baselineRecoverable,
      potentially_recoverable_after_count: currentRecoverable,
      recovery_ceiling: recoveryCeiling,
      target_count: 6000,
      shortfall_to_6000: shortfallToTarget,
      recovered_count: recoveredCount,
      remaining_counts_by_disposition: remainingRecoveryCounts,
    },
    current: {
      canonical_sha256: currentDigest,
      canonical_record_count: currentRecords.length,
      canonical_start_count: currentRecords.filter(({ role }) => role === 'start').length,
      reference_only_count: currentRecords.filter(({ role }) => role === 'reference-only').length,
      sense_count: logicalDatabase.rows.senses.length,
      relation_count: logicalDatabase.rows.relations.length,
      canonical_search_form_count: logicalDatabase.rows.search_forms.length,
      searchable_lemma_count: searchableLemmaCount,
      record_type_counts: recordTypeCounts,
      sense_pos_counts: sensePosCounts,
      relation_empty_searchable_record_count: relationEmptySearchableRecordCount,
      exact_search_coverage: searchCoverage,
      surface_form_regressions: surfaceFormRegressions,
      inventory_validation: inventoryValidation.status ?? 'pass',
      production_admission: productionResults.every(({ admission }) => admission?.audit?.blocking_finding_count === 0) ? 'pass' : 'fail',
      semantic_audit: productionResults.every(({ admission }) => admission?.semantic_audit?.coverage_complete === true) ? 'pass' : 'fail',
      deterministic_sqlite: 'pass',
      logical_database_digest: sha256Json(logicalDatabaseContentSnapshot(logicalDatabase)),
    },
    defect_findings: defectFindingsFor(candidates),
    system_fixes: ISSUE_220_SYSTEM_FIXES,
    normal_ci: {
      command: 'npm run ci:normal',
      result: NORMAL_CI_RESULT,
      canonical_sha256: currentDigest,
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
    assert.equal(storedReport, renderedReport, 'Issue #220 Markdown checkpoint is stale; run npm run batch:issue-220:report');
    assert.equal(storedMachineReport, `${JSON.stringify(report, null, 2)}\n`, 'Issue #220 machine checkpoint is stale; run npm run batch:issue-220:report');
  }

  return {
    reviewed_count: report.outcomes.reviewed_count,
    admitted_count: report.outcomes.admitted_count,
    held_count: report.outcomes.held_count,
    rejected_count: report.outcomes.rejected_count,
    historical_recovery_ceiling: recoveryCeiling,
    shortfall_to_6000: shortfallToTarget,
    canonical_record_count: report.current.canonical_record_count,
    canonical_start_count: report.current.canonical_start_count,
    searchable_lemma_count: report.current.searchable_lemma_count,
    production_admission: report.current.production_admission,
    inventory_validation: report.current.inventory_validation,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  validateIssue220({ writeReport: process.argv.includes('--write-report') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

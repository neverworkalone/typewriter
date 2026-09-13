import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import { createMetricsArtifact, assertMetricsMatch } from './derive-metrics.mjs';
import { validateBatch } from './validate-batch.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import { M5_11_CATALOG } from './m5-11-catalog.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = DEFAULT_CANONICAL_DIRECTORY;
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-11-base-canonical');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-base-inventory.json');
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-11-expansion.jsonl');
const PREIMPORT_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-preimport-inventory.json');
const CURRENT_INVENTORY_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-inventory.json');

const MANIFEST_PATH = path.join(BATCH_DIRECTORY, 'm5-11-expansion.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-11-review.json');
const RELATION_DIFF_PATH = path.join(BATCH_DIRECTORY, 'm5-11-relation-diff.json');
const METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-11-metrics.json');
const TIMING_PATH = path.join(BATCH_DIRECTORY, 'm5-11-timing.json');
const AUDIT_PATH = path.join(BATCH_DIRECTORY, 'm5-11-audit.json');
const VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-11-verification.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-11-stage.json');
const AUTHORIZATION_PATH = path.join(
  BATCH_DIRECTORY,
  'm5-10d-m5-11-authorization-20260912.json',
);
const SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');

const BATCH_ID = 'm5-11-expansion-20260913';
const BOUNDARY_IDS = Object.freeze([
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
]);
const TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);
const BASE_SUMMARY = Object.freeze({
  record_count: 820,
  start_count: 778,
  reference_only_count: 42,
  sense_count: 966,
  relation_count: 473,
  expression_count: 63,
});
const FINAL_SUMMARY = Object.freeze({
  record_count: 1320,
  start_count: 1278,
  reference_only_count: 42,
  sense_count: 1466,
  relation_count: 473,
  expression_count: 63,
});

export class M511ValidationError extends Error {
  constructor(message, code = 'M5_11_VALIDATION_ERROR') {
    super(message);
    this.name = 'M511ValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_VALIDATION_ERROR') {
  throw new M511ValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'MISMATCH') {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function assertCondition(condition, message, code = 'INVALID_ARTIFACT') {
  if (!condition) fail(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function resolveRepositoryPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(REPOSITORY_DIRECTORY, filePath);
}

async function readJson(filePath, label = filePath) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist`, 'MISSING_ARTIFACT');
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
}

async function validateFileReference(reference, label, { parseJson = true } = {}) {
  assertCondition(reference && typeof reference.path === 'string', `${label}.path is required`);
  assertCondition(reference && typeof reference.sha256 === 'string', `${label}.sha256 is required`);
  const filePath = resolveRepositoryPath(reference.path);
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${reference.path}`, 'MISSING_ARTIFACT');
    throw error;
  }
  assertEqual(sha256(bytes), reference.sha256, `${label}.sha256`, 'DIGEST_MISMATCH');
  return {
    path: filePath,
    bytes,
    value: parseJson ? JSON.parse(bytes.toString('utf8')) : undefined,
  };
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce(
      (count, record) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function expectedIds(prefix, first, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(first + index).padStart(3, '0')}`,
  );
}

function selectedInventoryIds() {
  return expectedIds('m5-', 535, 550);
}

function importedCanonicalIds() {
  return expectedIds('w', 779, 500);
}

function assertExactKeys(actual, expected, label) {
  assertEqual(Object.keys(actual).sort(), [...expected].sort(), label, 'KEY_SET_MISMATCH');
}

async function validateSourceBindings(stage) {
  const source = stage.source;
  const fileKeys = [
    'manifest',
    'review',
    'relation_diff',
    'metrics',
    'timing',
    'audit',
    'verification',
    'canonical_import',
    'previous_stage_authorization',
  ];
  for (const key of fileKeys) {
    await validateFileReference({
      path: source[key],
      sha256: source[`${key}_sha256`],
    }, `stage.source.${key}`, { parseJson: key !== 'canonical_import' });
  }

  const canonicalDirectoryDigest = await hashCanonicalDirectory(
    resolveRepositoryPath(source.canonical_directory),
  );
  assertEqual(
    canonicalDirectoryDigest,
    source.canonical_directory_sha256,
    'stage.source.canonical_directory_sha256',
    'DIGEST_MISMATCH',
  );

  const authorization = await validateFileReference(stage.authorization, 'stage.authorization');
  assertEqual(
    source.previous_stage_authorization,
    stage.authorization.path,
    'previous authorization path binding',
  );
  assertEqual(
    source.previous_stage_authorization_sha256,
    stage.authorization.sha256,
    'previous authorization digest binding',
  );

  const baseDigest = await hashCanonicalDirectory(BASE_CANONICAL_DIRECTORY);
  assertEqual(baseDigest, stage.input.canonical_directory_sha256, 'stage.input canonical digest', 'DIGEST_MISMATCH');
  assertEqual(
    baseDigest,
    authorization.value.source.canonical_directory_sha256,
    'authorization canonical digest must bind the preserved base snapshot',
    'AUTHORIZATION_CHAIN_MISMATCH',
  );

  assertEqual(authorization.value.decision, 'AUTHORIZE M5-11 +500 VALIDATION', 'authorization decision');
  assertEqual(authorization.value.target_issue, 97, 'authorization target issue');
  assertEqual(authorization.value.parent_issue, 7, 'authorization parent issue');
  assertEqual(authorization.value.canonical_mutation, false, 'authorization canonical mutation flag');
  assertEqual(authorization.value.target, {
    base_start_count: 778,
    net_start_increase: 500,
    cumulative_start_target: 1278,
    candidate_data_created: false,
  }, 'authorization target');

  const baseInventory = await validateFileReference({
    path: stage.input.base_inventory_path,
    sha256: stage.input.base_inventory_sha256,
  }, 'stage.input.base_inventory');
  assertEqual(baseInventory.value.revision, 'm5-11', 'base inventory revision');
  assertEqual(baseInventory.value.canonical_snapshot, {
    record_count: 820,
    start_count: 778,
    reference_only_count: 42,
  }, 'base inventory canonical snapshot');

  return { authorization: authorization.value, baseInventory: baseInventory.value };
}

function validateManifestAndPreflight(manifest, review, importRecords) {
  assertEqual(manifest.schema_version, '1', 'manifest schema version');
  assertEqual(manifest.batch_id, BATCH_ID, 'manifest batch id');
  assertEqual(manifest.inventory_revision, 'm5-11', 'manifest inventory revision');
  assertEqual(manifest.records.length, 550, 'manifest selected count');
  assertEqual(manifest.review.status, 'complete', 'manifest review status');
  assertEqual(manifest.sense_review.status, 'complete', 'manifest sense review status');
  assertEqual(manifest.sense_review.reviewed_start_count, 500, 'manifest reviewed starts');
  assertEqual(manifest.sense_review.scoped_single_sense_count, 500, 'manifest single-sense scope');
  assertEqual(manifest.sense_review.split_record_count, 0, 'manifest split record count');
  assertEqual(manifest.sense_review.split_canonical_ids, [], 'manifest split IDs');

  const selectedIds = selectedInventoryIds();
  const canonicalIds = importedCanonicalIds();
  const decisions = { included: 0, corrected: 0, held: 0, rejected: 0, deferred: 0 };
  const seenInventoryIds = new Set();
  const seenCanonicalIds = new Set();
  for (const [index, record] of manifest.records.entries()) {
    const expectedInventoryId = selectedIds[index];
    assertEqual(record.inventory_id, expectedInventoryId, `manifest record ${index} inventory_id`);
    assertEqual(record.source, 'inventory', `manifest record ${index} source`);
    assertEqual(record.role, 'start', `manifest record ${index} role`);
    assertCondition(!seenInventoryIds.has(record.inventory_id), 'manifest inventory IDs must be unique');
    seenInventoryIds.add(record.inventory_id);
    decisions[record.decision] = (decisions[record.decision] ?? 0) + 1;
    const importable = index < 500;
    if (importable) {
      assertCondition(record.decision === 'included', `imported record ${record.inventory_id} must be included`);
      assertEqual(record.canonical_id, canonicalIds[index], `manifest record ${index} canonical_id`);
      assertCondition(!Object.hasOwn(record, 'corrected_fields'), 'included records must not claim corrections');
      assertCondition(!seenCanonicalIds.has(record.canonical_id), 'manifest canonical IDs must be unique');
      seenCanonicalIds.add(record.canonical_id);
    } else {
      assertEqual(record.decision, 'deferred', `reserve record ${record.inventory_id} decision`);
      assertCondition(!Object.hasOwn(record, 'canonical_id'), 'deferred records must not have canonical IDs');
    }
  }
  assertEqual(decisions, {
    included: 500,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 50,
  }, 'manifest decisions');

  const checkpoints = manifest.sense_review.preflight.record_checkpoints;
  assertEqual(checkpoints.length, 550, 'sense preflight checkpoint count');
  for (const [index, checkpoint] of checkpoints.entries()) {
    assertEqual(checkpoint.inventory_id, selectedIds[index], `preflight ${index} inventory_id`);
    const importable = index < 500;
    const canonicalId = canonicalIds[index];
    if (importable) {
      const senseId = `${canonicalId}-s1`;
      assertEqual(checkpoint.canonical_id, canonicalId, `preflight ${index} canonical_id`);
      assertEqual(checkpoint.status, 'complete', `preflight ${index} status`);
      assertEqual(checkpoint.lemma_pos, 'checked', `preflight ${index} lemma/POS status`);
      assertEqual(checkpoint.observed_sense_count, 1, `preflight ${index} sense count`);
      assertEqual(checkpoint.observed_pos, [importRecords[index].record.senses[0].pos], `preflight ${index} POS`);
      assertEqual(checkpoint.missing_boundary_ids, [], `preflight ${index} missing boundaries`);
      assertExactKeys(checkpoint.boundary_checks, BOUNDARY_IDS, `preflight ${index} boundary keys`);
      for (const boundaryId of BOUNDARY_IDS) {
        assertEqual(checkpoint.boundary_checks[boundaryId].status, 'checked', `preflight ${index} ${boundaryId} status`);
        assertEqual(checkpoint.boundary_checks[boundaryId].sense_ids, [senseId], `preflight ${index} ${boundaryId} sense IDs`);
      }
    } else {
      assertEqual(checkpoint.status, 'deferred', `preflight ${index} status`);
      assertEqual(checkpoint.lemma_pos, 'not-reviewed', `preflight ${index} lemma/POS status`);
      assertEqual(checkpoint.observed_sense_count, 0, `preflight ${index} sense count`);
      assertEqual(checkpoint.observed_pos, [], `preflight ${index} POS`);
      assertEqual(checkpoint.missing_boundary_ids, [...BOUNDARY_IDS], `preflight ${index} missing boundaries`);
      assertExactKeys(checkpoint.boundary_checks, BOUNDARY_IDS, `preflight ${index} boundary keys`);
      for (const boundaryId of BOUNDARY_IDS) {
        assertEqual(checkpoint.boundary_checks[boundaryId].status, 'not-reviewed', `preflight ${index} ${boundaryId} status`);
        assertEqual(checkpoint.boundary_checks[boundaryId].sense_ids, [], `preflight ${index} ${boundaryId} sense IDs`);
      }
    }
  }

  assertEqual(review.issue, 97, 'review issue');
  assertEqual(review.batch_id, BATCH_ID, 'review batch id');
  assertEqual(review.candidate_pool.declared_count, 550, 'review declared candidate count');
  assertEqual(review.candidate_pool.selected_start_count, 550, 'review selected count');
  assertEqual(review.candidate_pool.import_target, 500, 'review import target');
  assertEqual(review.candidate_pool.reserve_count, 50, 'review reserve count');
  assertEqual(review.sense_review.boundary_checkpoint_count, 3000, 'review boundary checkpoint count');
  assertEqual(review.sense_review.relation_candidate_count, 0, 'review relation candidate count');
  assertEqual(review.decisions, {
    included: 500,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 50,
    processed_start_count: 500,
  }, 'review decisions');
  assertEqual(review.editorial_review_complete, true, 'machine editorial review status');
  assertEqual(review.human_editorial_review_complete, false, 'human editorial review status');
}

function validateCanonicalImport(importRecords, finalRecords) {
  assertEqual(canonicalSummary(importRecords), {
    record_count: 500,
    start_count: 500,
    reference_only_count: 0,
    sense_count: 500,
    relation_count: 0,
    expression_count: 0,
  }, 'canonical import summary');

  const finalById = new Map(finalRecords.map(({ record }) => [record.id, record]));
  const expectedIdsForImport = importedCanonicalIds();
  for (const [index, recordInfo] of importRecords.entries()) {
    const record = recordInfo.record;
    const expectedId = expectedIdsForImport[index];
    assertEqual(record.id, expectedId, `canonical import ${index} ID`);
    assertEqual(record.role, 'start', `canonical import ${index} role`);
    assertEqual(record.candidate_id, expectedId, `canonical import ${index} candidate_id`);
    assertEqual(record.senses.length, 1, `canonical import ${index} sense count`);
    assertEqual(record.senses[0].id, `${expectedId}-s1`, `canonical import ${index} sense ID`);
    assertEqual(record.senses[0].relations ?? [], [], `canonical import ${index} relation list`);
    assertCondition(finalById.has(record.id), `canonical import ${record.id} missing from final canonical`);
    assertEqual(finalById.get(record.id), record, `canonical import ${record.id} final binding`);
  }
}

function validateInventorySelection(preimportInventory, currentInventory) {
  const selectedIds = selectedInventoryIds();
  const preById = new Map(preimportInventory.entries.map((entry) => [entry.inventory_id, entry]));
  const currentById = new Map(currentInventory.entries.map((entry) => [entry.inventory_id, entry]));
  for (const [index, inventoryId] of selectedIds.entries()) {
    const preEntry = preById.get(inventoryId);
    const currentEntry = currentById.get(inventoryId);
    assertCondition(preEntry, `pre-import inventory is missing ${inventoryId}`);
    assertCondition(currentEntry, `final inventory is missing ${inventoryId}`);
    assertEqual(preEntry.status, 'candidate', `${inventoryId} pre-import status`);
    assertEqual(preEntry.source, 'editorial', `${inventoryId} pre-import source`);
    assertCondition(!Object.hasOwn(preEntry, 'canonical_id'), `${inventoryId} pre-import canonical binding`);
    if (index < 500) {
      assertEqual(currentEntry.status, 'current', `${inventoryId} final status`);
      assertEqual(currentEntry.source, 'canonical', `${inventoryId} final source`);
      assertEqual(currentEntry.canonical_id, `w${String(779 + index).padStart(3, '0')}`, `${inventoryId} final canonical ID`);
    } else {
      assertEqual(currentEntry.status, 'candidate', `${inventoryId} deferred final status`);
      assertEqual(currentEntry.source, 'editorial', `${inventoryId} deferred final source`);
      assertCondition(!Object.hasOwn(currentEntry, 'canonical_id'), `${inventoryId} deferred canonical binding`);
    }
  }
}

async function validateDeterministicSqlite() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-11-check-'));
  const firstPath = path.join(temporaryDirectory, 'first.sqlite');
  const secondPath = path.join(temporaryDirectory, 'second.sqlite');
  try {
    await buildDictionary({
      inputDirectory: CURRENT_CANONICAL_DIRECTORY,
      outputPath: firstPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    await buildDictionary({
      inputDirectory: CURRENT_CANONICAL_DIRECTORY,
      outputPath: secondPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    const firstBytes = await readFile(firstPath);
    const secondBytes = await readFile(secondPath);
    assertEqual(sha256(firstBytes), sha256(secondBytes), 'SQLite byte reproducibility', 'SQLITE_NONDETERMINISTIC');

    const database = new DatabaseSync(firstPath);
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get();
      assertEqual(integrity.integrity_check, 'ok', 'SQLite integrity_check');
      assertEqual(database.prepare('PRAGMA foreign_key_check').all(), [], 'SQLite foreign_key_check');
      const metadata = Object.fromEntries(
        database.prepare('SELECT key, value FROM metadata').all().map(({ key, value }) => [key, value]),
      );
      assertEqual(metadata.record_count, '1320', 'SQLite record_count metadata');
      assertEqual(metadata.start_count, '1278', 'SQLite start_count metadata');
      assertEqual(metadata.reference_only_count, '42', 'SQLite reference_only_count metadata');
      assertEqual(metadata.sense_count, '1466', 'SQLite sense_count metadata');
      assertEqual(metadata.relation_count, '473', 'SQLite relation_count metadata');
      assertEqual(metadata.expression_count, '63', 'SQLite expression_count metadata');
    } finally {
      database.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateGate(stage, metrics, timing, audit, verification) {
  const correctionRate = metrics.derived.decisions.correction_rate_of_selected;
  const relationNoiseRate = metrics.derived.relation_diff.noise_rate_of_before;
  const editorTime = timing.editor_seconds_per_processed_start;
  const checks = {
    exact_start_target: stage.actual.canonical_snapshot.start_count === 1278
      && stage.actual.imported_start_count === 500,
    correction_rate: correctionRate <= 0.5,
    relation_noise_rate: relationNoiseRate <= 0.25 && relationNoiseRate < (51 / 139),
    editor_time: Number.isFinite(editorTime) && editorTime <= 12,
    timing_complete: timing.status === 'complete' && timing.unmeasured_pass_count === 0,
    audit: audit.status === 'complete' && audit.independent === true && audit.open_blocker_count === 0,
    human_editorial_review: verification.human_editorial_review_complete === true,
    canonical_integrity: verification.canonical_integrity === true,
    deterministic_sqlite: verification.deterministic_sqlite === true,
    search_product_regression: verification.search_product_regression === true,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  assertEqual(stage.gate_status, failedChecks.length > 0 ? 'fail' : 'pass', 'stage gate status');
  assertEqual(stage.decision, failedChecks.length > 0 ? 'HOLD PROCESS' : 'APPROVE BOUNDED', 'stage gate decision');
  assertEqual(stage.ready_to_create, failedChecks.length === 0, 'stage ready_to_create');
  assertEqual(stage.next_stage_created, false, 'next stage must not be created');
  assertEqual(stage.next_stage_authorized, false, 'next stage must not be authorized');
  assertEqual(failedChecks, ['editor_time', 'timing_complete', 'human_editorial_review'], 'fixed-gate failures');
  return { checks, failedChecks };
}

export async function validateM511() {
  const stage = await readJson(STAGE_PATH, 'M5-11 stage');
  const manifest = await readJson(MANIFEST_PATH, 'M5-11 manifest');
  const review = await readJson(REVIEW_PATH, 'M5-11 review');
  const relationDiff = await readJson(RELATION_DIFF_PATH, 'M5-11 relation diff');
  const metrics = await readJson(METRICS_PATH, 'M5-11 metrics');
  const timing = await readJson(TIMING_PATH, 'M5-11 timing');
  const audit = await readJson(AUDIT_PATH, 'M5-11 audit');
  const verification = await readJson(VERIFICATION_PATH, 'M5-11 verification');
  const preimportInventory = await readJson(PREIMPORT_INVENTORY_PATH, 'M5-11 pre-import inventory');
  const currentInventory = await readJson(CURRENT_INVENTORY_PATH, 'M5 target inventory');
  const seed = await readJson(SEED_PATH, 'M5 target seed');

  assertEqual(stage.schema_version, '1', 'stage schema version');
  assertEqual(stage.stage_id, 'm5-11-plus-500', 'stage ID');
  assertEqual(stage.issue, 97, 'stage issue');
  assertEqual(stage.parent_issue, 7, 'stage parent issue');
  assertEqual(stage.input.inventory_revision, 'm5-11', 'stage input inventory revision');
  assertEqual(stage.input.canonical_snapshot, BASE_SUMMARY, 'stage base canonical snapshot');
  assertEqual(stage.target, {
    net_start_increase: 500,
    cumulative_start_target: 1278,
    candidate_buffer: 50,
    selected_start_count: 550,
  }, 'stage target');
  assertEqual(stage.decisions, {
    included_start_count: 500,
    corrected_start_count: 0,
    held_start_count: 0,
    rejected_start_count: 0,
    deferred_start_count: 50,
    processed_start_count: 500,
  }, 'stage decisions');
  assertEqual(stage.actual.canonical_snapshot, FINAL_SUMMARY, 'stage final canonical snapshot');
  assertEqual(stage.actual.imported_start_count, 500, 'stage imported start count');

  const { authorization } = await validateSourceBindings(stage);
  const { records: baseRecords } = await readCanonicalRecords(BASE_CANONICAL_DIRECTORY);
  const { records: importRecords } = await readCanonicalRecords(CANONICAL_IMPORT_PATH);
  const { records: finalRecords } = await readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY);
  assertEqual(canonicalSummary(baseRecords), BASE_SUMMARY, 'base canonical summary');
  assertEqual(canonicalSummary(finalRecords), FINAL_SUMMARY, 'final canonical summary');
  validateCanonicalImport(importRecords, finalRecords);

  const batchValidation = await validateBatch({
    manifestPath: MANIFEST_PATH,
    stagedRecordsPath: CANONICAL_IMPORT_PATH,
    inventoryPath: PREIMPORT_INVENTORY_PATH,
    canonicalDirectory: BASE_CANONICAL_DIRECTORY,
    allowRepositoryStaging: true,
  });
  assertEqual(batchValidation.canonicalRecordCount, 820, 'batch base canonical count');
  assertEqual(batchValidation.stagedRecordCount, 500, 'batch staged record count');
  assertEqual(batchValidation.targetCount, 550, 'batch target count');
  assertEqual(batchValidation.counts, {
    included: 500,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 50,
  }, 'batch decision counts');

  validateManifestAndPreflight(manifest, review, importRecords);
  validateRelationDiff(relationDiff);
  assertEqual(relationDiff.batch_id, BATCH_ID, 'relation diff batch id');
  assertEqual(relationDiff.before_count, 0, 'relation diff before count');
  assertEqual(relationDiff.after_count, 0, 'relation diff after count');
  assertEqual(relationDiff.events, [], 'relation diff events');
  assertEqual(metrics.batch_id, BATCH_ID, 'metrics batch id');
  const derivedMetrics = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: finalRecords,
    source: metrics.source,
  });
  assertMetricsMatch(derivedMetrics, metrics);
  assertEqual(metrics.derived.canonical_import, {
    imported_start_count: 500,
    imported_reference_only_count: 0,
    imported_record_count: 500,
    imported_sense_count: 500,
    imported_relation_count: 0,
    imported_expression_count: 0,
    relation_type_counts: {},
  }, 'canonical import metrics');

  assertEqual(timing.batch_id, BATCH_ID, 'timing batch id');
  assertEqual(timing.status, 'incomplete', 'timing status');
  assertEqual(timing.processed_start_count, 500, 'timing denominator');
  assertEqual(Object.keys(timing.passes).sort(), [...TIMING_PASS_IDS].sort(), 'timing pass IDs');
  assertEqual(timing.unmeasured_pass_count, 5, 'timing unmeasured pass count');
  assertEqual(timing.total_wall_clock_seconds, null, 'timing wall clock');
  assertEqual(timing.total_editor_seconds, null, 'timing editor seconds');
  assertEqual(timing.editor_seconds_per_processed_start, null, 'timing per-start cost');
  for (const passId of TIMING_PASS_IDS) assertEqual(timing.passes[passId].status, 'unmeasured', `${passId} timing status`);

  assertEqual(audit.batch_id, BATCH_ID, 'audit batch id');
  assertEqual(audit.status, 'complete', 'audit status');
  assertEqual(audit.independent, true, 'audit independence');
  assertEqual(audit.open_blocker_count, 0, 'audit open blockers');
  assertEqual(audit.reviewed_canonical_ids, { first: 'w779', last: 'w1278', count: 500 }, 'audit canonical scope');
  assertEqual(audit.relation_scope, {
    before_count: 0,
    after_count: 0,
    candidate_count: 0,
    admitted_count: 0,
    noise_count: 0,
  }, 'audit relation scope');

  assertEqual(verification.schema_version, '1', 'verification schema version');
  assertEqual(verification.editorial_review_complete, true, 'verification machine review');
  assertEqual(verification.human_editorial_review_complete, false, 'verification human review');
  assertEqual(verification.canonical_integrity, true, 'verification canonical integrity');
  assertEqual(verification.deterministic_sqlite, true, 'verification deterministic SQLite');
  assertEqual(verification.search_product_regression, true, 'verification search regression');

  assertEqual(preimportInventory.revision, 'm5-11', 'pre-import inventory revision');
  assertEqual(currentInventory.revision, 'm5-12', 'final inventory revision');
  assertEqual(seed.revision, 'm5-12', 'final seed revision');
  validateInventorySelection(preimportInventory, currentInventory);
  await validateTargetInventory({
    inventoryPath: CURRENT_INVENTORY_PATH,
    canonicalDirectory: CURRENT_CANONICAL_DIRECTORY,
    checkPilotCompleteness: true,
  });

  const gate = validateGate(stage, metrics, timing, audit, verification);
  await validateDeterministicSqlite();

  return {
    batch_id: BATCH_ID,
    canonical: FINAL_SUMMARY,
    decisions: stage.decisions,
    relation_diff: {
      before_count: relationDiff.before_count,
      after_count: relationDiff.after_count,
      event_count: relationDiff.events.length,
    },
    gate_status: stage.gate_status,
    gate_failures: gate.failedChecks,
    authorization: authorization.decision,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateM511()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

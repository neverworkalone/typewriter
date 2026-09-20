import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_12_CATALOG } from './m5-12-catalog.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-12-base-canonical');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-12-base-inventory.json');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-12-review.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-12-stage.json');
const CATALOG_PATH = path.join(SCRIPT_DIRECTORY, 'm5-12-catalog.mjs');
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-12-expansion.jsonl');

export const M5_12_BATCH_ID = 'm5-12-expansion-20260920';
export const M5_12_BASE_SUMMARY = Object.freeze({
  record_count: 1320,
  start_count: 1278,
  reference_only_count: 42,
  sense_count: 1579,
  relation_count: 487,
  expression_count: 73,
});
export const M5_12_BASE_CANONICAL_SHA256 =
  '122af925cac03ac2782346a534a44602d713986c34924d8a439786a4591cb3e3';
export const M5_12_BASE_INVENTORY_SHA256 =
  'f2a7c36547ca4db4b3dd2bc2b3b5f8962e991aa900b42ffce34533b84e57bc67';
export const M5_12_BASE_SEED_SHA256 =
  '1b93e772f400ad81e6b7f0a91efdad8972516395d0445554689224c0cb65b3db';
export const M5_12_CATALOG_SHA256 =
  '5ba48712e2f5e800f23d05186d8c4e8883ac150d942b2a43a0dfaa500723a838';
export const M5_12_REVIEW_SHA256 =
  'cf3f4ae938c039b9bf4ad57bd03b7c05349b1dd2c84edfbe18c1733450ef921e';
export const M5_12_TARGET = Object.freeze({
  net_start_increase: 722,
  cumulative_start_target: 2000,
  candidate_buffer: 80,
  selected_start_count: 802,
});

export class M512ValidationError extends Error {
  constructor(message, code = 'M5_12_VALIDATION_ERROR') {
    super(message);
    this.name = 'M512ValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_12_VALIDATION_ERROR') {
  throw new M512ValidationError(message, code);
}

function assertEqual(actual, expected, message, code = 'MISMATCH') {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function repositoryRelativePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
}

export function resolveRepositoryPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} is required`, 'PATH_INVALID');
  }
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} escapes the repository: ${value}`, 'PATH_ESCAPE');
  }
  return resolved;
}

async function readJson(filePath, label) {
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

async function readBoundFile(reference, label, { parseJson = true } = {}) {
  if (!reference || typeof reference.path !== 'string' || typeof reference.sha256 !== 'string') {
    fail(`${label} must contain path and sha256`, 'SOURCE_BINDING_MISMATCH');
  }
  const filePath = resolveRepositoryPath(reference.path, `${label}.path`);
  const bytes = await readFile(filePath);
  assertEqual(sha256(bytes), reference.sha256, `${label}.sha256`, 'DIGEST_MISMATCH');
  return {
    path: filePath,
    bytes,
    value: parseJson ? JSON.parse(bytes.toString('utf8')) : undefined,
  };
}

async function assertMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${label} must not exist before human-gated promotion`, 'UNAUTHORIZED_PROMOTION');
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce(
        (inner, sense) => inner + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function validateDecisionCounts(review, stage) {
  assertEqual(review.decisions, {
    included: 0,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 0,
    processed_start_count: 0,
    unreviewed_start_count: 802,
    imported_start_count: 0,
  }, 'pre-admission decision counts');
  assertEqual(stage.decisions, {
    included_start_count: 0,
    corrected_start_count: 0,
    held_start_count: 0,
    rejected_start_count: 0,
    deferred_start_count: 0,
    processed_start_count: 0,
    unreviewed_start_count: 802,
  }, 'pre-admission stage decision counts');
}

export async function validateM512({
  stagePath = STAGE_PATH,
  reviewPath = REVIEW_PATH,
  currentInventoryPath,
  currentSeedPath = CURRENT_SEED_PATH,
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  baseCanonicalDirectory = BASE_CANONICAL_DIRECTORY,
  baseInventoryPath = BASE_INVENTORY_PATH,
} = {}) {
  const stage = await readJson(stagePath, 'M5-12 stage');
  const review = await readJson(reviewPath, 'M5-12 review');
  const currentSeed = await readJson(currentSeedPath, 'current M5 seed');
  const currentInventory = currentInventoryPath
    ? await readJson(currentInventoryPath, 'current M5 inventory')
    : await buildTargetInventory({
      canonicalDirectory: currentCanonicalDirectory,
      seedPath: currentSeedPath,
    });
  const currentInventoryBytes = currentInventoryPath
    ? await readFile(currentInventoryPath)
    : serializeTargetInventory(currentInventory);
  const currentCanonical = await readCanonicalRecords(currentCanonicalDirectory);
  const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory);

  assertEqual(stage.stage_id, 'm5-12-plus-722', 'stage ID');
  assertEqual(stage.issue, 98, 'stage issue');
  assertEqual(stage.parent_issue, 7, 'parent issue');
  assertEqual(stage.status, 'pre-admission', 'stage status');
  assertEqual(stage.input.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'base canonical path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.canonical_directory_sha256, M5_12_BASE_CANONICAL_SHA256, 'base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(stage.input.base_inventory_path, repositoryRelativePath(baseInventoryPath), 'base inventory path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.base_inventory_sha256, M5_12_BASE_INVENTORY_SHA256, 'base inventory digest', 'DIGEST_MISMATCH');
  assertEqual(stage.input.inventory_revision, currentInventory.revision, 'inventory revision');
  assertEqual(await hashCanonicalDirectory(baseCanonicalDirectory), M5_12_BASE_CANONICAL_SHA256, 'retained base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(await hashCanonicalDirectory(currentCanonicalDirectory), M5_12_BASE_CANONICAL_SHA256, 'current canonical must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(canonicalSummary(baseCanonical.records), M5_12_BASE_SUMMARY, 'base canonical summary');
  assertEqual(canonicalSummary(currentCanonical.records), M5_12_BASE_SUMMARY, 'current canonical summary');
  await assertMissing(CANONICAL_IMPORT_PATH, 'M5-12 canonical import');

  const baseInventory = await readBoundFile({
    path: stage.input.base_inventory_path,
    sha256: stage.input.base_inventory_sha256,
  }, 'stage.input.base_inventory');
  assertEqual(baseInventory.value.revision, 'm5-11', 'base inventory revision');
  assertEqual(sha256(currentInventoryBytes), M5_12_BASE_INVENTORY_SHA256, 'current inventory must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(currentSeed.revision, 'm5-11', 'current seed revision');
  assertEqual(sha256(await readFile(currentSeedPath)), M5_12_BASE_SEED_SHA256, 'current seed must remain unchanged', 'UNAUTHORIZED_PROMOTION');

  const reviewSource = await readBoundFile({
    path: stage.source.review,
    sha256: stage.source.review_sha256,
  }, 'stage.source.review');
  assertEqual(stage.source.review, repositoryRelativePath(reviewPath), 'review path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(sha256(reviewSource.bytes), M5_12_REVIEW_SHA256, 'review digest', 'DIGEST_MISMATCH');
  assertEqual(review.issue, 98, 'review issue');
  assertEqual(review.batch_id, M5_12_BATCH_ID, 'review batch ID');
  assertEqual(review.status, 'pending-human-editorial-decision', 'review status');
  assertEqual(review.review_mode, 'human-required', 'review mode');
  assertEqual(review.editorial_review_complete, false, 'editorial review status');
  assertEqual(review.human_editorial_review_complete, false, 'human editorial review status');
  assertEqual(review.candidate_pool.declared_count, M5_12_TARGET.selected_start_count, 'candidate pool count');
  assertEqual(review.candidate_pool.import_target, M5_12_TARGET.net_start_increase, 'candidate import target');
  assertEqual(review.candidate_pool.reserve_count, M5_12_TARGET.candidate_buffer, 'candidate reserve count');
  assertEqual(review.candidate_pool.catalog_count, M5_12_CATALOG.length, 'catalog count');
  assertEqual(review.candidate_pool.catalog_sha256, M5_12_CATALOG_SHA256, 'catalog digest', 'DIGEST_MISMATCH');
  assertEqual(review.decision_artifact, null, 'decision artifact must be absent until human review');
  validateDecisionCounts(review, stage);

  assertEqual(stage.target, M5_12_TARGET, 'stage target');
  assertEqual(stage.actual.canonical_snapshot, M5_12_BASE_SUMMARY, 'stage actual canonical snapshot');
  assertEqual(stage.actual.imported_start_count, 0, 'stage imported count');
  assertEqual(stage.gate.gate_status, 'fail', 'stage gate status');
  assertEqual(stage.gate.decision, 'HOLD PROCESS', 'stage gate decision');
  assertEqual(stage.promotion, {
    canonical_mutation: false,
    seed_mutation: false,
    inventory_mutation: false,
    next_stage_created: false,
    next_stage_authorized: false,
  }, 'promotion guard');
  assertEqual(stage.pipeline.batch_local_quality_fork, false, 'shared lexical pipeline guard');
  assertEqual(stage.previous_stage.checkpoint_commit, '7e5893475929bc03f5397c011dce6796b9fed8d7', 'previous checkpoint commit');
  assertEqual(stage.source.catalog, repositoryRelativePath(CATALOG_PATH), 'catalog path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.catalog_count, M5_12_CATALOG.length, 'catalog count binding');
  assertEqual(stage.source.catalog_sha256, sha256Json(M5_12_CATALOG), 'catalog source digest', 'DIGEST_MISMATCH');
  assertEqual(stage.source.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'source canonical path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.canonical_directory_sha256, M5_12_BASE_CANONICAL_SHA256, 'source canonical digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.seed, repositoryRelativePath(currentSeedPath), 'seed path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.seed_sha256, M5_12_BASE_SEED_SHA256, 'seed digest binding', 'DIGEST_MISMATCH');

  return {
    batch_id: M5_12_BATCH_ID,
    canonical: M5_12_BASE_SUMMARY,
    target: M5_12_TARGET,
    decisions: review.decisions,
    gate_status: 'fail',
    gate_failures: [...stage.gate.failures],
    promotion: stage.promotion,
    human_editorial_review_complete: false,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateM512()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

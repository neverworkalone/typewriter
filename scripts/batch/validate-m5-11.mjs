import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { validateM5DAuthorization } from './validate-m5-10d-recovery.mjs';
import { M5_11_CATALOG } from './m5-11-catalog.mjs';
import { sha256Json } from './m5-11-editorial.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-11-base-canonical');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-base-inventory.json');
const CURRENT_INVENTORY_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-inventory.json');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-11-review.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-11-stage.json');
const AUTHORIZATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10d-m5-11-authorization-20260912.json');
const CATALOG_PATH = path.join(SCRIPT_DIRECTORY, 'm5-11-catalog.mjs');

const BASE_SUMMARY = Object.freeze({
  record_count: 820,
  start_count: 778,
  reference_only_count: 42,
  sense_count: 966,
  relation_count: 473,
  expression_count: 63,
});
const BASE_INVENTORY_SHA256 = '2d6ec1f03ce4c52bb16509354e501d2e1e10dc684bc068b995b9cead1f4eb947';
const BASE_SEED_SHA256 = 'bda4bec9be8e90fca1c16e6aa4979bbf242342534856b8bacc9b91dd276da0e9';
const BASE_CANONICAL_SHA256 = '14ab89dcb9e21626515d982ea172ea77144ea07ec816fc50a1b17e7fd0567473';
const BATCH_ID = 'm5-11-expansion-20260913';

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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function repositoryRelativePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
}

export function resolveRepositoryPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`, 'PATH_INVALID');
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
  return { path: filePath, bytes, value: parseJson ? JSON.parse(bytes.toString('utf8')) : undefined };
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
      (sum, record) => sum + record.senses.reduce((inner, sense) => inner + (sense.relations?.length ?? 0), 0),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

export async function validateM511({
  stagePath = STAGE_PATH,
  reviewPath = REVIEW_PATH,
  currentInventoryPath = CURRENT_INVENTORY_PATH,
  currentSeedPath = CURRENT_SEED_PATH,
  authorizationPath = AUTHORIZATION_PATH,
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  baseCanonicalDirectory = BASE_CANONICAL_DIRECTORY,
  baseInventoryPath = BASE_INVENTORY_PATH,
} = {}) {
  const stage = await readJson(stagePath, 'M5-11 stage');
  const review = await readJson(reviewPath, 'M5-11 review');
  const currentInventory = await readJson(currentInventoryPath, 'current M5 inventory');
  const currentSeed = await readJson(currentSeedPath, 'current M5 seed');
  const currentCanonical = await readCanonicalRecords(currentCanonicalDirectory);
  const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory);

  assertEqual(stage.stage_id, 'm5-11-plus-500', 'stage ID');
  assertEqual(stage.issue, 97, 'stage issue');
  assertEqual(stage.input.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'stage base canonical path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.canonical_directory_sha256, BASE_CANONICAL_SHA256, 'stage base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(stage.input.base_inventory_path, repositoryRelativePath(baseInventoryPath), 'stage base inventory path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.base_inventory_sha256, BASE_INVENTORY_SHA256, 'stage base inventory digest', 'DIGEST_MISMATCH');
  assertEqual(await hashCanonicalDirectory(baseCanonicalDirectory), BASE_CANONICAL_SHA256, 'retained base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(await hashCanonicalDirectory(currentCanonicalDirectory), BASE_CANONICAL_SHA256, 'current canonical must remain at the pre-import snapshot', 'UNAUTHORIZED_PROMOTION');
  assertEqual(canonicalSummary(baseCanonical.records), BASE_SUMMARY, 'retained base canonical summary');
  assertEqual(canonicalSummary(currentCanonical.records), BASE_SUMMARY, 'current canonical summary');
  await assertMissing(path.join(currentCanonicalDirectory, 'm5-11-expansion.jsonl'), 'M5-11 canonical import');

  const baseInventory = await readBoundFile({
    path: stage.input.base_inventory_path,
    sha256: stage.input.base_inventory_sha256,
  }, 'stage.input.base_inventory');
  assertEqual(baseInventory.value.revision, 'm5-11', 'base inventory revision');
  assertEqual(stage.input.inventory_revision, currentInventory.revision, 'stage inventory revision');
  assertEqual(sha256(await readFile(currentInventoryPath)), BASE_INVENTORY_SHA256, 'current inventory must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(stage.source.seed, repositoryRelativePath(currentSeedPath), 'seed path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.seed_sha256, BASE_SEED_SHA256, 'seed digest binding', 'DIGEST_MISMATCH');
  assertEqual(sha256(await readFile(currentSeedPath)), BASE_SEED_SHA256, 'current seed must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(currentInventory.revision, 'm5-11', 'current inventory revision');
  assertEqual(currentSeed.revision, 'm5-11', 'current seed revision');

  const authorizationSource = await readBoundFile(stage.authorization, 'stage.authorization');
  assertEqual(stage.authorization.path, repositoryRelativePath(authorizationPath), 'authorization path binding', 'SOURCE_PATH_MISMATCH');
  const authorizationResult = await validateM5DAuthorization({
    authorizationPath: authorizationSource.path,
    canonicalDirectory: baseCanonicalDirectory,
    inventoryPath: baseInventoryPath,
  });
  assertEqual(authorizationResult.authorization_sha256, stage.authorization.sha256, 'revalidated authorization digest', 'AUTHORIZATION_CHAIN_MISMATCH');
  assertEqual(authorizationResult.authorization.source.inventory_sha256, BASE_INVENTORY_SHA256, 'authorization inventory binding', 'AUTHORIZATION_CHAIN_MISMATCH');
  assertEqual(authorizationResult.authorization.source.canonical_directory_sha256, BASE_CANONICAL_SHA256, 'authorization canonical binding', 'AUTHORIZATION_CHAIN_MISMATCH');

  assertEqual(stage.source.review, repositoryRelativePath(reviewPath), 'review path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.catalog, repositoryRelativePath(CATALOG_PATH), 'catalog path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.catalog_count, M5_11_CATALOG.length, 'catalog count binding', 'SOURCE_BINDING_MISMATCH');
  assertEqual(stage.source.catalog_sha256, sha256Json(M5_11_CATALOG), 'catalog digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'source canonical path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.canonical_directory_sha256, BASE_CANONICAL_SHA256, 'source canonical digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.previous_stage_authorization, repositoryRelativePath(authorizationPath), 'previous authorization path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.previous_stage_authorization_sha256, stage.authorization.sha256, 'previous authorization digest binding', 'AUTHORIZATION_CHAIN_MISMATCH');
  const reviewBytes = await readFile(reviewPath);
  assertEqual(sha256(reviewBytes), stage.source.review_sha256, 'review artifact digest', 'DIGEST_MISMATCH');
  assertEqual(review.issue, 97, 'review issue');
  assertEqual(review.batch_id, BATCH_ID, 'review batch ID');
  assertEqual(review.status, 'pending-editorial-decision', 'review status');
  assertEqual(review.editorial_review_complete, false, 'machine editorial review must not manufacture a verdict');
  assertEqual(review.human_editorial_review_complete, false, 'human editorial review status');
  assertEqual(review.candidate_pool.declared_count, 550, 'candidate catalog count');
  assertEqual(review.candidate_pool.import_target, 500, 'candidate import target');
  assertEqual(review.candidate_pool.reserve_count, 50, 'candidate reserve count');
  assertEqual(review.candidate_pool.catalog_count, M5_11_CATALOG.length, 'candidate catalog count');
  assertEqual(review.candidate_pool.catalog_sha256, sha256Json(M5_11_CATALOG), 'candidate catalog digest', 'DIGEST_MISMATCH');
  assertEqual(review.decisions.unreviewed, 550, 'unreviewed candidate count');
  assertEqual(review.decision_artifact, null, 'decision artifact must be absent until separately supplied');

  assertEqual(stage.actual.canonical_snapshot, BASE_SUMMARY, 'stage actual canonical snapshot');
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

  return {
    batch_id: BATCH_ID,
    canonical: BASE_SUMMARY,
    decisions: review.decisions,
    gate_status: 'fail',
    gate_failures: [...stage.gate.failures],
    promotion: stage.promotion,
    authorization: authorizationResult.authorization.decision,
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

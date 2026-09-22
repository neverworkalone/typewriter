import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_13_CATALOG } from './m5-13-catalog.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const execFileAsync = promisify(execFile);
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-13-base-canonical');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-13-base-inventory.json');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-13-review.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-13-stage.json');
const CATALOG_PATH = path.join(SCRIPT_DIRECTORY, 'm5-13-catalog.mjs');
const PREDECESSOR_ADMISSION_PATH = path.join(BATCH_DIRECTORY, 'm5-12a-admission.json');
const PREDECESSOR_PROMOTION_PATH = path.join(BATCH_DIRECTORY, 'm5-12a-promotion.json');
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-13-expansion.jsonl');

export const M5_13_BATCH_ID = 'm5-13-expansion-20260922';
export const M5_13_BASE_SUMMARY = Object.freeze({
  record_count: 2042,
  start_count: 2000,
  reference_only_count: 42,
  sense_count: 2301,
  relation_count: 487,
  expression_count: 145,
});
export const M5_13_BASE_CANONICAL_SHA256 =
  '690592c89c578096fc65585f24489f1095fc16d495cc02dee4da94de057d38df';
export const M5_13_BASE_INVENTORY_SHA256 =
  '0d3058ecd005189ceb5f413d9e2422269d861af39ee7de00ddbb12abdbe95a66';
export const M5_13_BASE_SEED_SHA256 =
  '37ed9af967f6dfb41b5bf1cc0024c3aa34e41a1ebac0290ae95ae8a8af9f8000';
export const M5_13_CATALOG_SHA256 =
  '4345f110be4252fa62c85487ffd6541966f8af5e5160d3077da43de7896a3d6f';
export const M5_13_REVIEW_SHA256 =
  '2b3b038ced83f7d9f25bfe30402885c3f53ddf44d9c9f0ba7c756adb3924dd94';
export const M5_13_PREDECESSOR_ADMISSION_SHA256 =
  '33639ee2e0240703d0882fea6219d87ea0d912bc8453969e05e103faa780bba7';
export const M5_13_PREDECESSOR_PROMOTION_SHA256 =
  '5afde1c3da7236c6f254f62135de6e11d186a87fdd000dd48169e0d103f66fcc';
export const M5_13_CHECKPOINT_COMMIT =
  'a5d794a4e57070ad81285eb97ad0e0c68c9e1d3c';
export const M5_13_CHECKPOINT_PR_HEAD =
  '480198da9e8c1927b9c5702cd28188f66adca558';
export const M5_13_TARGET = Object.freeze({
  net_start_increase: 1000,
  cumulative_start_target: 3000,
  candidate_buffer: 100,
  selection_slot_count: 1100,
  candidate_identity_count: 0,
});

export class M513ValidationError extends Error {
  constructor(message, code = 'M5_13_VALIDATION_ERROR') {
    super(message);
    this.name = 'M513ValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_13_VALIDATION_ERROR') {
  throw new M513ValidationError(message, code);
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

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;

async function resolveGitRevision(expression, label) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', REPOSITORY_DIRECTORY, 'rev-parse', '--verify', expression],
      { encoding: 'utf8' },
    );
    const revision = stdout.trim();
    if (!FULL_GIT_SHA.test(revision)) {
      fail(`${label} did not resolve to a full Git SHA`, 'CHECKPOINT_PROVENANCE_MISMATCH');
    }
    return revision;
  } catch (error) {
    if (error instanceof M513ValidationError) throw error;
    fail(`${label} cannot be resolved from repository history`, 'CHECKPOINT_PROVENANCE_MISMATCH');
  }
}

async function resolveGitTreeForCommit(commit, label) {
  if (!FULL_GIT_SHA.test(commit)) {
    fail(`${label} must be a full commit SHA`, 'CHECKPOINT_PROVENANCE_MISMATCH');
  }
  const resolvedCommit = await resolveGitRevision(`${commit}^{commit}`, `${label} commit`);
  assertEqual(resolvedCommit, commit, `${label} commit resolution`, 'CHECKPOINT_PROVENANCE_MISMATCH');
  return resolveGitRevision(`${commit}^{tree}`, `${label} tree`);
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

const M5_13_AXES = new Set(['E', 'Q', 'S', 'C', 'A', 'O', 'X']);
const M5_13_CATALOG_KEYS = Object.freeze(['axis', 'catalog_index', 'flags', 'slot_id']);

export function validateM513Catalog(catalog = M5_13_CATALOG) {
  if (!Array.isArray(catalog) || catalog.length !== M5_13_TARGET.selection_slot_count) {
    fail(
      `M5-13 catalog must contain ${M5_13_TARGET.selection_slot_count} capacity slots`,
      'CATALOG_SHAPE_ERROR',
    );
  }
  const slotIds = new Set();
  for (const [index, entry] of catalog.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`M5-13 catalog row ${index} must be an object`, 'CATALOG_SHAPE_ERROR');
    }
    assertEqual(
      Object.keys(entry).sort(),
      M5_13_CATALOG_KEYS,
      `M5-13 catalog row ${index} keys`,
      'CATALOG_SHAPE_ERROR',
    );
    assertEqual(entry.catalog_index, index, `M5-13 catalog row ${index} index`, 'CATALOG_SHAPE_ERROR');
    if (!/^m5-13-slot-[0-9]{4}$/u.test(entry.slot_id)) {
      fail(`M5-13 catalog row ${index} must use a slot_id`, 'CATALOG_SHAPE_ERROR');
    }
    if (slotIds.has(entry.slot_id)) {
      fail(`M5-13 catalog has duplicate slot_id ${entry.slot_id}`, 'CATALOG_SHAPE_ERROR');
    }
    slotIds.add(entry.slot_id);
    if (!M5_13_AXES.has(entry.axis)) {
      fail(`M5-13 catalog row ${index} has an invalid axis`, 'CATALOG_SHAPE_ERROR');
    }
    if (!Array.isArray(entry.flags) || entry.flags.length === 0) {
      fail(`M5-13 catalog row ${index} must declare flags`, 'CATALOG_SHAPE_ERROR');
    }
  }
  return catalog;
}

function validateDecisionCounts(review, stage) {
  assertEqual(review.decisions, {
    included: 0,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 0,
    processed_start_count: 0,
    unreviewed_start_count: 0,
    unresolved_slot_count: 1100,
    imported_start_count: 0,
  }, 'pre-admission decision counts');
  assertEqual(stage.decisions, {
    included_start_count: 0,
    corrected_start_count: 0,
    held_start_count: 0,
    rejected_start_count: 0,
    deferred_start_count: 0,
    processed_start_count: 0,
    unreviewed_start_count: 0,
    unresolved_slot_count: 1100,
  }, 'pre-admission stage decision counts');
}

export async function validateM513({
  stagePath = STAGE_PATH,
  reviewPath = REVIEW_PATH,
  currentInventoryPath,
  currentSeedPath = CURRENT_SEED_PATH,
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  baseCanonicalDirectory = BASE_CANONICAL_DIRECTORY,
  baseInventoryPath = BASE_INVENTORY_PATH,
} = {}) {
  const stage = await readJson(stagePath, 'M5-13 stage');
  const review = await readJson(reviewPath, 'M5-13 review');
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

  validateM513Catalog();

  assertEqual(stage.stage_id, 'm5-13-plus-1000', 'stage ID');
  assertEqual(stage.issue, 99, 'stage issue');
  assertEqual(stage.parent_issue, 7, 'parent issue');
  assertEqual(stage.status, 'pre-admission', 'stage status');
  assertEqual(stage.input.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'base canonical path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.canonical_directory_sha256, M5_13_BASE_CANONICAL_SHA256, 'base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(stage.input.base_inventory_path, repositoryRelativePath(baseInventoryPath), 'base inventory path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.input.base_inventory_sha256, M5_13_BASE_INVENTORY_SHA256, 'base inventory digest', 'DIGEST_MISMATCH');
  assertEqual(stage.input.inventory_revision, currentInventory.revision, 'inventory revision');
  assertEqual(await hashCanonicalDirectory(baseCanonicalDirectory), M5_13_BASE_CANONICAL_SHA256, 'retained base canonical digest', 'DIGEST_MISMATCH');
  assertEqual(await hashCanonicalDirectory(currentCanonicalDirectory), M5_13_BASE_CANONICAL_SHA256, 'current canonical must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(canonicalSummary(baseCanonical.records), M5_13_BASE_SUMMARY, 'base canonical summary');
  assertEqual(canonicalSummary(currentCanonical.records), M5_13_BASE_SUMMARY, 'current canonical summary');
  await assertMissing(CANONICAL_IMPORT_PATH, 'M5-13 canonical import');

  const baseInventory = await readBoundFile({
    path: stage.input.base_inventory_path,
    sha256: stage.input.base_inventory_sha256,
  }, 'stage.input.base_inventory');
  assertEqual(baseInventory.value.revision, 'm5-12', 'base inventory revision');
  assertEqual(sha256(currentInventoryBytes), M5_13_BASE_INVENTORY_SHA256, 'current inventory must remain unchanged', 'UNAUTHORIZED_PROMOTION');
  assertEqual(currentSeed.revision, 'm5-12', 'current seed revision');
  assertEqual(sha256(await readFile(currentSeedPath)), M5_13_BASE_SEED_SHA256, 'current seed must remain unchanged', 'UNAUTHORIZED_PROMOTION');

  const predecessorAdmission = await readBoundFile({
    path: stage.source.predecessor_admission,
    sha256: stage.source.predecessor_admission_sha256,
  }, 'stage.source.predecessor_admission');
  assertEqual(stage.source.predecessor_admission, repositoryRelativePath(PREDECESSOR_ADMISSION_PATH), 'predecessor admission path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(sha256(predecessorAdmission.bytes), M5_13_PREDECESSOR_ADMISSION_SHA256, 'predecessor admission digest', 'DIGEST_MISMATCH');
  assertEqual(predecessorAdmission.value.issue, 138, 'predecessor admission issue');
  assertEqual(predecessorAdmission.value.gate.gate_status, 'pass', 'predecessor admission gate status', 'PREDECESSOR_GATE_MISMATCH');
  assertEqual(predecessorAdmission.value.gate.decision, 'APPROVE AUTOMATED BOUNDED', 'predecessor admission decision', 'PREDECESSOR_GATE_MISMATCH');
  assertEqual(predecessorAdmission.value.actual, M5_13_BASE_SUMMARY, 'predecessor output summary', 'PREDECESSOR_OUTPUT_MISMATCH');
  const predecessorPromotion = await readBoundFile({
    path: stage.source.predecessor_promotion,
    sha256: stage.source.predecessor_promotion_sha256,
  }, 'stage.source.predecessor_promotion');
  assertEqual(stage.source.predecessor_promotion, repositoryRelativePath(PREDECESSOR_PROMOTION_PATH), 'predecessor promotion path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(sha256(predecessorPromotion.bytes), M5_13_PREDECESSOR_PROMOTION_SHA256, 'predecessor promotion digest', 'DIGEST_MISMATCH');
  assertEqual(predecessorPromotion.value.issue, 138, 'predecessor promotion issue');
  assertEqual(predecessorPromotion.value.status, 'promoted', 'predecessor promotion status', 'PREDECESSOR_GATE_MISMATCH');
  assertEqual(predecessorPromotion.value.outputs.canonical_directory_sha256, M5_13_BASE_CANONICAL_SHA256, 'predecessor promoted canonical digest', 'PREDECESSOR_OUTPUT_MISMATCH');
  assertEqual(stage.predecessor_expansion.artifact, repositoryRelativePath(PREDECESSOR_ADMISSION_PATH), 'stage predecessor artifact path', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.predecessor_expansion.artifact_sha256, M5_13_PREDECESSOR_ADMISSION_SHA256, 'stage predecessor artifact digest', 'DIGEST_MISMATCH');
  assertEqual(stage.predecessor_expansion.gate_status, predecessorAdmission.value.gate.gate_status, 'stage predecessor gate status', 'PREDECESSOR_GATE_MISMATCH');
  assertEqual(stage.predecessor_expansion.decision, predecessorAdmission.value.gate.decision, 'stage predecessor decision', 'PREDECESSOR_GATE_MISMATCH');
  assertEqual(stage.predecessor_expansion.actual, predecessorAdmission.value.actual, 'stage predecessor output summary', 'PREDECESSOR_OUTPUT_MISMATCH');

  const reviewSource = await readBoundFile({
    path: stage.source.review,
    sha256: stage.source.review_sha256,
  }, 'stage.source.review');
  assertEqual(stage.source.review, repositoryRelativePath(reviewPath), 'review path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(sha256(reviewSource.bytes), M5_13_REVIEW_SHA256, 'review digest', 'DIGEST_MISMATCH');
  assertEqual(review.issue, 99, 'review issue');
  assertEqual(review.batch_id, M5_13_BATCH_ID, 'review batch ID');
  assertEqual(review.status, 'pending-human-editorial-decision', 'review status');
  assertEqual(review.review_mode, 'human-required', 'review mode');
  assertEqual(review.editorial_review_complete, false, 'editorial review status');
  assertEqual(review.human_editorial_review_complete, false, 'human editorial review status');
  assertEqual(review.candidate_pool.selection_slot_count, M5_13_TARGET.selection_slot_count, 'selection slot count');
  assertEqual(review.candidate_pool.candidate_identity_count, M5_13_TARGET.candidate_identity_count, 'candidate identity count');
  assertEqual(review.candidate_pool.import_target, M5_13_TARGET.net_start_increase, 'candidate import target');
  assertEqual(review.candidate_pool.reserve_count, M5_13_TARGET.candidate_buffer, 'candidate reserve count');
  assertEqual(review.candidate_pool.catalog_count, M5_13_CATALOG.length, 'catalog count');
  assertEqual(review.candidate_pool.catalog_sha256, M5_13_CATALOG_SHA256, 'catalog digest', 'DIGEST_MISMATCH');
  assertEqual(review.candidate_pool.selection_status, 'capacity-only', 'selection status');
  assertEqual(review.decision_artifact, null, 'decision artifact must be absent until human review');
  validateDecisionCounts(review, stage);

  assertEqual(stage.target, M5_13_TARGET, 'stage target');
  assertEqual(stage.actual.canonical_snapshot, M5_13_BASE_SUMMARY, 'stage actual canonical snapshot');
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
  assertEqual(stage.previous_stage.status, 'complete', 'previous checkpoint status');
  assertEqual(stage.previous_stage.checkpoint_commit, M5_13_CHECKPOINT_COMMIT, 'previous checkpoint commit');
  assertEqual(stage.previous_stage.checkpoint_pr_head, M5_13_CHECKPOINT_PR_HEAD, 'previous checkpoint PR head');
  const checkpointTree = await resolveGitTreeForCommit(
    stage.previous_stage.checkpoint_commit,
    'previous checkpoint',
  );
  assertEqual(
    stage.previous_stage.checkpoint_tree,
    checkpointTree,
    'previous checkpoint tree provenance',
    'CHECKPOINT_PROVENANCE_MISMATCH',
  );
  const checkpointPrHeadTree = await resolveGitTreeForCommit(
    stage.previous_stage.checkpoint_pr_head,
    'previous checkpoint PR head',
  );
  assertEqual(
    checkpointPrHeadTree,
    checkpointTree,
    'previous checkpoint PR head tree',
    'CHECKPOINT_PROVENANCE_MISMATCH',
  );
  assertEqual(stage.source.catalog, repositoryRelativePath(CATALOG_PATH), 'catalog path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.catalog_count, M5_13_CATALOG.length, 'catalog count binding');
  assertEqual(stage.source.catalog_sha256, sha256Json(M5_13_CATALOG), 'catalog source digest', 'DIGEST_MISMATCH');
  assertEqual(stage.source.predecessor_admission, repositoryRelativePath(PREDECESSOR_ADMISSION_PATH), 'predecessor admission source path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.predecessor_admission_sha256, M5_13_PREDECESSOR_ADMISSION_SHA256, 'predecessor admission source digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.predecessor_promotion, repositoryRelativePath(PREDECESSOR_PROMOTION_PATH), 'predecessor promotion source path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.predecessor_promotion_sha256, M5_13_PREDECESSOR_PROMOTION_SHA256, 'predecessor promotion source digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.canonical_directory, repositoryRelativePath(baseCanonicalDirectory), 'source canonical path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.canonical_directory_sha256, M5_13_BASE_CANONICAL_SHA256, 'source canonical digest binding', 'DIGEST_MISMATCH');
  assertEqual(stage.source.seed, repositoryRelativePath(currentSeedPath), 'seed path binding', 'SOURCE_PATH_MISMATCH');
  assertEqual(stage.source.seed_sha256, M5_13_BASE_SEED_SHA256, 'seed digest binding', 'DIGEST_MISMATCH');

  return {
    batch_id: M5_13_BATCH_ID,
    canonical: M5_13_BASE_SUMMARY,
    target: M5_13_TARGET,
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
  validateM513()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

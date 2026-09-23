import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  buildTargetInventory,
  readPromotionLedger,
  validatePromotionLedgerBindings,
} from '../inventory/generate-target-inventory.mjs';
import { parseJsonWithUniqueKeys } from '../validate/unique-json.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  M5_14_BASE_SUMMARY,
  M5_14_FINAL_SUMMARY,
  M5_14_TARGET,
} from './m5-14-pipeline.mjs';
import {
  M5_14_CANDIDATE_IDENTITIES,
  M5_14_CATALOG,
  M5_14_CANDIDATE_SOURCE,
  M5_14_CANDIDATE_SOURCE_BYTES,
  M5_14_CANDIDATE_SOURCE_ID,
  M5_14_IMPORT_COUNT,
  M5_14_RESERVE_COUNT,
  M5_14_SELECTION_COUNT,
  buildM514CandidateRecords,
} from './m5-14-candidate-source.mjs';
import {
  M5_14_SEMANTIC_DECISION_SOURCE_ID,
  M5_14_SEMANTIC_DECISION_SOURCE_PATH,
  candidateRecordsFromM514DecisionSource,
  readM514DecisionSource,
  validateM514DecisionSource,
} from './m5-14-decision-source.mjs';
import { selectionDispositionSummary } from './lexical-selection.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const CURRENT_PROMOTION_LEDGER_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-promotions.jsonl');
const REVIEW_PATH = path.join(BATCH_DIRECTORY, 'm5-14-review.json');
const STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-14-stage.json');
const ADMISSION_PATH = path.join(BATCH_DIRECTORY, 'm5-14-admission.json');
const PROMOTION_PATH = path.join(BATCH_DIRECTORY, 'm5-14-promotion.json');
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-14-expansion.jsonl');
const PREDECESSOR_STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-13-stage.json');

export const M5_14_BATCH_ID = 'm5-14-expansion-20260923';
export { M5_14_BASE_SUMMARY, M5_14_FINAL_SUMMARY, M5_14_TARGET };

export class M514ValidationError extends Error {
  constructor(message, code = 'M5_14_VALIDATION_ERROR') {
    super(message);
    this.name = 'M514ValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_14_VALIDATION_ERROR') {
  throw new M514ValidationError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(recordOf);
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

function assertEqual(actual, expected, label, code = 'M5_14_VALIDATION_MISMATCH') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
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
    return { bytes, value: parseJsonWithUniqueKeys(bytes, filePath) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
}

async function assertMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${label} must not exist before promotion`, 'UNEXPECTED_PROMOTION');
}

export function validateM514Catalog(catalog = M5_14_CATALOG) {
  if (!Array.isArray(catalog) || catalog.length !== M5_14_SELECTION_COUNT) {
    fail(`M5-14 catalog must contain ${M5_14_SELECTION_COUNT} capacity slots`, 'CATALOG_SHAPE_ERROR');
  }
  const slots = new Set();
  for (const [index, entry] of catalog.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['axis', 'catalog_index', 'flags', 'slot_id'])
      || entry.catalog_index !== index
      || !/^m5-14-slot-[0-9]{4}$/u.test(entry.slot_id)
      || !Array.isArray(entry.flags) || entry.flags.length === 0
      || !['E', 'Q', 'S', 'C', 'A', 'O', 'X'].includes(entry.axis)) {
      fail(`M5-14 catalog row ${index} is invalid`, 'CATALOG_SHAPE_ERROR');
    }
    if (slots.has(entry.slot_id)) fail(`M5-14 catalog has duplicate ${entry.slot_id}`, 'CATALOG_SHAPE_ERROR');
    slots.add(entry.slot_id);
  }
  return catalog;
}

function validateReviewArtifact(review, decisionSource, decisionSourceBytes) {
  if (!review || typeof review !== 'object') fail('M5-14 review artifact must be an object', 'REVIEW_SHAPE_ERROR');
  assertEqual(review.issue, 100, 'review issue');
  assertEqual(review.batch_id, M5_14_BATCH_ID, 'review batch ID');
  assertEqual(review.status, 'complete', 'review status');
  assertEqual(review.review_mode, 'agent-generated', 'review mode');
  assertEqual(review.editorial_review_complete, false, 'editorial review status');
  assertEqual(review.human_editorial_review_complete, false, 'human editorial review status');
  assertEqual(review.candidate_pool.selection_slot_count, M5_14_SELECTION_COUNT, 'selection capacity');
  assertEqual(review.candidate_pool.candidate_identity_count, M5_14_CANDIDATE_IDENTITIES.length, 'candidate identity count');
  assertEqual(review.candidate_pool.import_target, M5_14_IMPORT_COUNT, 'import target');
  assertEqual(review.candidate_pool.reserve_count, M5_14_RESERVE_COUNT, 'reserve capacity');
  assertEqual(review.candidate_pool.candidate_source_id, M5_14_CANDIDATE_SOURCE_ID, 'candidate source ID');
  assertEqual(review.candidate_pool.selection_status, 'source-bound-reviewed', 'selection status');
  const disposition = selectionDispositionSummary(decisionSource.rows, { selection: decisionSource.selection });
  assertEqual(review.decisions, {
    ...disposition.counts,
    processed_start_count: disposition.processed_start_count,
    unreviewed_start_count: 0,
    unresolved_slot_count: 0,
    imported_start_count: M5_14_IMPORT_COUNT,
  }, 'review decisions');
  assertEqual(review.decision_artifact.source_id, M5_14_SEMANTIC_DECISION_SOURCE_ID, 'decision source ID');
  assertEqual(review.decision_artifact.sha256, sha256(decisionSourceBytes), 'decision source digest');
  assertEqual(review.audit.status, 'complete', 'review audit status');
  assertEqual(review.audit.independent, true, 'review audit independence');
  return true;
}

function validateStageArtifact(stage, review, decisionSource, currentDirectory) {
  if (!stage || typeof stage !== 'object') fail('M5-14 stage artifact must be an object', 'STAGE_SHAPE_ERROR');
  assertEqual(stage.stage_id, 'm5-14-plus-1000', 'stage ID');
  assertEqual(stage.issue, 100, 'stage issue');
  assertEqual(stage.status, 'complete', 'stage status');
  assertEqual(stage.input.canonical_directory, path.relative(REPOSITORY_DIRECTORY, currentDirectory), 'stage canonical path');
  assertEqual(stage.target, M5_14_TARGET, 'stage target');
  assertEqual(stage.actual.canonical_snapshot, M5_14_FINAL_SUMMARY, 'prospective canonical summary');
  assertEqual(stage.actual.imported_start_count, M5_14_IMPORT_COUNT, 'stage imported count');
  const disposition = selectionDispositionSummary(decisionSource.rows, { selection: decisionSource.selection });
  assertEqual(stage.decisions, {
    included_start_count: disposition.counts.included,
    corrected_start_count: disposition.counts.corrected,
    held_start_count: disposition.counts.held,
    rejected_start_count: disposition.counts.rejected,
    deferred_start_count: disposition.counts.deferred,
    processed_start_count: disposition.processed_start_count,
    unreviewed_start_count: 0,
    unresolved_slot_count: 0,
  }, 'stage decisions');
  assertEqual(stage.gate.gate_status, 'pass', 'stage gate status');
  assertEqual(stage.gate.decision, 'APPROVE AUTOMATED BOUNDED', 'stage gate decision');
  assertEqual(stage.pipeline.batch_local_quality_fork, false, 'shared pipeline guard');
  assertEqual(stage.source.review, path.relative(REPOSITORY_DIRECTORY, REVIEW_PATH), 'stage review path');
  assertEqual(stage.source.review_sha256, sha256(Buffer.from(JSON.stringify(review, null, 2) + '\n')), 'stage review digest');
  assertEqual(stage.source.candidate_source, 'data/batches/m5-14-lexical-unit-source.json', 'candidate source path');
  assertEqual(stage.source.candidate_source_sha256, sha256(M5_14_CANDIDATE_SOURCE_BYTES), 'candidate source bytes digest');
  assertEqual(stage.source.candidate_source_artifact_sha256, M5_14_CANDIDATE_SOURCE.artifact_sha256, 'candidate source artifact digest');
  assertEqual(stage.source.semantic_decision_source, path.relative(REPOSITORY_DIRECTORY, M5_14_SEMANTIC_DECISION_SOURCE_PATH), 'semantic decision source path');
  assertEqual(stage.source.semantic_decision_source_sha256, decisionSource.sourceSha256, 'semantic decision source digest');
  assertEqual(stage.predecessor_expansion.issue, 99, 'predecessor issue');
  assertEqual(stage.source.predecessor_stage, 'data/batches/m5-13-stage.json', 'predecessor stage path');
  assertEqual(stage.source.predecessor_stage_sha256, sha256(readFileSync(PREDECESSOR_STAGE_PATH)), 'predecessor stage digest');
  assertEqual(stage.previous_stage.checkpoint_commit, '5b74cde6f89184d2db7acbf9f1c71ec9242a6609', 'predecessor checkpoint commit');
  return true;
}

async function validatePromotionState({ currentCanonical, currentDigest, currentSeedPath, promotionLedgerPath, admissionPath, promotionPath }) {
  const admission = (await readJson(admissionPath, 'M5-14 admission')).value;
  const promotionFile = await readJson(promotionPath, 'M5-14 promotion');
  const promotion = promotionFile.value;
  assertEqual(admission.gate.gate_status, 'pass', 'admission gate status');
  assertEqual(promotion.status, 'promoted', 'promotion status');
  assertEqual(promotion.outputs.canonical_directory_sha256, currentDigest, 'promoted canonical digest');
  assertEqual(promotion.admission_sha256, sha256(await readFile(admissionPath)), 'promotion admission digest');
  assertEqual((await readJson(currentSeedPath, 'current M5 seed')).value.revision, 'm5-14', 'promoted seed revision');
  const ledger = await readPromotionLedger(promotionLedgerPath);
  const decisionSource = (await readJson(path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-decision-source.json'), 'canonical semantic decision source')).value;
  validatePromotionLedgerBindings({
    entries: ledger,
    canonicalRecords: currentCanonical.records.map(recordOf),
    decisionSource,
  });
  return { admission, promotion };
}

export async function validateM514({
  reviewPath = REVIEW_PATH,
  stagePath = STAGE_PATH,
  currentInventoryPath,
  currentSeedPath = CURRENT_SEED_PATH,
  currentPromotionLedgerPath = CURRENT_PROMOTION_LEDGER_PATH,
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  canonicalContext,
} = {}) {
  const resolvedDirectory = path.resolve(canonicalContext?.canonicalDirectory ?? currentCanonicalDirectory);
  if (canonicalContext && path.resolve(canonicalContext.canonicalDirectory) !== resolvedDirectory) {
    fail('shared canonical context directory does not match the requested directory', 'SOURCE_PATH_MISMATCH');
  }
  const currentCanonical = canonicalContext ?? await readCanonicalRecords(resolvedDirectory);
  const currentDigest = await hashCanonicalDirectory(resolvedDirectory);
  const currentSummary = canonicalSummary(currentCanonical.records);
  const sourceFile = await readM514DecisionSource();
  const candidateRecords = buildM514CandidateRecords();
  const sourceCandidates = candidateRecordsFromM514DecisionSource(sourceFile.source);
  assertEqual(candidateRecords, sourceCandidates, 'live candidate producer binding', 'CANDIDATE_SOURCE_MISMATCH');
  const decisionSource = validateM514DecisionSource({
    source: sourceFile.source,
    sourceBytes: sourceFile.sourceBytes,
    candidateRecords,
  });
  validateM514Catalog();
  const reviewFile = await readJson(reviewPath, 'M5-14 review');
  const review = reviewFile.value;
  validateReviewArtifact(review, decisionSource, sourceFile.sourceBytes);
  const stageFile = await readJson(stagePath, 'M5-14 stage');
  validateStageArtifact(stageFile.value, review, decisionSource, resolvedDirectory);
  const disposition = selectionDispositionSummary(decisionSource.rows, { selection: decisionSource.selection });
  const inventory = currentInventoryPath
    ? (await readJson(currentInventoryPath, 'current M5 inventory')).value
    : await buildTargetInventory({ canonicalDirectory: resolvedDirectory, canonicalContext, seedPath: currentSeedPath });
  if (!inventory || typeof inventory.revision !== 'string') fail('current target inventory is invalid', 'INVENTORY_SHAPE_ERROR');
  const isBase = JSON.stringify(currentSummary) === JSON.stringify(M5_14_BASE_SUMMARY);
  const isFinal = JSON.stringify(currentSummary) === JSON.stringify(M5_14_FINAL_SUMMARY);
  if (!isBase && !isFinal) fail('current canonical summary is neither the M5-13 base nor the M5-14 prospective result', 'CANONICAL_SUMMARY_MISMATCH');
  let promotion;
  if (isBase) {
    await assertMissing(CANONICAL_IMPORT_PATH, 'M5-14 canonical import');
  } else {
    promotion = await validatePromotionState({
      currentCanonical,
      currentDigest,
      currentSeedPath,
      promotionLedgerPath: currentPromotionLedgerPath,
      admissionPath: ADMISSION_PATH,
      promotionPath: PROMOTION_PATH,
    });
  }
  return {
    batch_id: M5_14_BATCH_ID,
    current: currentSummary,
    current_canonical_directory_sha256: currentDigest,
    current_inventory_revision: inventory.revision,
    candidate_count: candidateRecords.length,
    decisions: disposition.counts,
    gate_status: stageFile.value.gate.gate_status,
    promoted: Boolean(promotion),
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateM514()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

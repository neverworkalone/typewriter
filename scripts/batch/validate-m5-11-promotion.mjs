import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_11_BATCH_ID } from './m5-11-editorial.mjs';
import {
  M5_11_BASE_CANONICAL_SHA256,
  M5_11_BASE_INVENTORY_SHA256,
  M5_11_BASE_SEED_SHA256,
  REPOSITORY_DIRECTORY,
} from './validate-m5-11.mjs';
import { validateM511Admission } from './validate-m5-11-admission.mjs';

const DEFAULT_MANIFEST_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-admission.json',
);
const DEFAULT_PROMOTION_EVIDENCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-11-promotion.json',
);
const DEFAULT_SEED_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-seed.json',
);
const DEFAULT_INVENTORY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/inventory/m5-target-inventory.json',
);

export class M511PromotionValidationError extends Error {
  constructor(message, code = 'M5_11_PROMOTION_VALIDATION_ERROR') {
    super(message);
    this.name = 'M511PromotionValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_PROMOTION_VALIDATION_ERROR') {
  throw new M511PromotionValidationError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalSummary(records) {
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

function repositoryPath(value, label) {
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain inside the repository: ${resolved}`, 'REPOSITORY_PATH_REQUIRED');
  }
  return resolved;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
}

function sourceRef(manifest, key) {
  const source = manifest.sources?.[key];
  if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string') {
    fail(`admission manifest is missing sources.${key}`, 'SOURCE_BINDING_MISMATCH');
  }
  return source;
}

function assertSource(result, manifest, key) {
  const expected = sourceRef(manifest, key);
  const actual = result.sources[key];
  if (!actual || actual.sha256 !== expected.sha256 || path.resolve(actual.path) !== path.resolve(expected.path)) {
    fail(`source ${key} drifted from the admission manifest`, 'SOURCE_BINDING_MISMATCH');
  }
}

function assertSummary(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${label} drifted`, 'CANONICAL_COUNT_MISMATCH');
  }
}

export async function validateM511Promotion({
  manifestPath = DEFAULT_MANIFEST_PATH,
  promotionEvidencePath = DEFAULT_PROMOTION_EVIDENCE_PATH,
  currentCanonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  currentSeedPath = DEFAULT_SEED_PATH,
  currentInventoryPath = DEFAULT_INVENTORY_PATH,
} = {}) {
  const resolvedManifestPath = repositoryPath(manifestPath, 'manifest path');
  const resolvedEvidencePath = repositoryPath(promotionEvidencePath, 'promotion evidence path');
  const resolvedCanonicalDirectory = repositoryPath(currentCanonicalDirectory, 'canonical directory');
  const resolvedSeedPath = repositoryPath(currentSeedPath, 'seed path');
  const resolvedInventoryPath = repositoryPath(currentInventoryPath, 'inventory path');
  const manifest = await readJson(resolvedManifestPath, 'M5-11 admission manifest');
  const evidence = await readJson(resolvedEvidencePath, 'M5-11 promotion evidence');

  if (manifest.schema_version !== '1' || manifest.issue !== 97 || manifest.batch_id !== M5_11_BATCH_ID) {
    fail('admission manifest is not bound to M5-11 issue #97', 'SCOPE_MISMATCH');
  }
  if (manifest.gate?.gate_status !== 'pass' || manifest.gate?.decision !== 'APPROVE BOUNDED') {
    fail('admission manifest does not contain a passing gate', 'GATE_REQUIRED');
  }
  if (evidence.schema_version !== '1' || evidence.issue !== 97 || evidence.batch_id !== M5_11_BATCH_ID) {
    fail('promotion evidence is not bound to M5-11 issue #97', 'SCOPE_MISMATCH');
  }
  if (evidence.promotion?.canonical_mutation !== true
    || evidence.promotion?.seed_mutation !== true
    || evidence.promotion?.inventory_mutation !== true) {
    fail('promotion evidence does not record all explicit mutations', 'PROMOTION_STATE_MISMATCH');
  }

  const inputPaths = {
    proposalPath: sourceRef(manifest, 'proposal').path,
    editorialDecisionPath: sourceRef(manifest, 'editorial').path,
    editorialTimingPath: sourceRef(manifest, 'editorial_timing').path,
    auditPath: sourceRef(manifest, 'audit').path,
    auditTimingPath: sourceRef(manifest, 'audit_timing').path,
    relationDiffPath: sourceRef(manifest, 'relation_diff').path,
    verificationPath: sourceRef(manifest, 'verification').path,
    reviewedImportPath: sourceRef(manifest, 'reviewed_import').path,
    authorizationPath: sourceRef(manifest, 'authorization').path,
    baseInventoryPath: sourceRef(manifest, 'base_inventory').path,
    currentCanonicalDirectory: resolvedCanonicalDirectory,
    currentSeedPath: resolvedSeedPath,
    currentInventoryPath: resolvedInventoryPath,
    expectedImportedCount: manifest.target.net_start_increase,
    expectedCumulativeStartCount: manifest.target.cumulative_start_target,
    candidateBuffer: manifest.target.candidate_buffer,
    requirePrePromotionSnapshot: false,
  };
  const result = await validateM511Admission(inputPaths);
  for (const key of [
    'proposal',
    'editorial',
    'editorial_timing',
    'audit',
    'audit_timing',
    'relation_diff',
    'verification',
    'reviewed_import',
    'authorization',
    'base_inventory',
  ]) {
    assertSource(result, manifest, key);
    const evidenceSource = evidence.sources?.[key];
    if (!evidenceSource
      || evidenceSource.sha256 !== result.sources[key].sha256
      || path.resolve(evidenceSource.path) !== path.resolve(result.sources[key].path)) {
      fail(`promotion evidence source ${key} drifted`, 'SOURCE_BINDING_MISMATCH');
    }
  }
  assertSummary(result.final_summary, manifest.actual, 'admission final summary');
  assertSummary(result.final_summary, evidence.actual, 'promotion final summary');
  assertSummary(result.base_summary, evidence.base.summary, 'promotion base summary');
  assertSummary(result.gate, manifest.gate, 'admission gate');
  assertSummary(result.gate, evidence.gate, 'promotion gate');
  if (evidence.base.canonical_directory_sha256 !== M5_11_BASE_CANONICAL_SHA256
    || evidence.base.inventory_sha256 !== M5_11_BASE_INVENTORY_SHA256
    || evidence.base.seed_sha256 !== M5_11_BASE_SEED_SHA256) {
    fail('promotion evidence base digest chain drifted', 'SOURCE_BINDING_MISMATCH');
  }

  const canonical = await readCanonicalRecords(resolvedCanonicalDirectory);
  validateDatasetRecords(canonical.records, { checkPilotCompleteness: true });
  const finalRecords = canonical.records.map(({ record }) => record);
  const finalSummary = canonicalSummary(finalRecords);
  assertSummary(finalSummary, result.final_summary, 'canonical promotion output');

  const importOutput = evidence.outputs?.canonical_import;
  if (!importOutput || typeof importOutput.path !== 'string' || typeof importOutput.sha256 !== 'string') {
    fail('promotion evidence is missing the canonical import output', 'OUTPUT_BINDING_MISMATCH');
  }
  const resolvedImportPath = repositoryPath(importOutput.path, 'canonical import output');
  const importBytes = await readFile(resolvedImportPath);
  if (sha256(importBytes) !== importOutput.sha256) {
    fail('canonical import output digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const imported = await readCanonicalRecords(resolvedImportPath);
  const importedRecords = imported.records.map(({ record }) => record);
  if (importedRecords.length !== result.imported_records.length) {
    fail('canonical import output count drifted', 'CANONICAL_COUNT_MISMATCH');
  }
  for (const [index, record] of importedRecords.entries()) {
    assertSummary(record, result.imported_records[index], `canonical import output row ${index}`);
  }
  const finalById = new Map(finalRecords.map((record) => [record.id, record]));
  for (const record of result.imported_records) {
    assertSummary(finalById.get(record.id), record, `promoted canonical ${record.id}`);
  }

  const canonicalDigest = await hashCanonicalDirectory(resolvedCanonicalDirectory);
  if (canonicalDigest !== evidence.outputs.canonical_directory_sha256) {
    fail('canonical directory digest drifted after promotion', 'OUTPUT_DIGEST_MISMATCH');
  }
  const seedBytes = await readFile(resolvedSeedPath);
  if (sha256(seedBytes) !== evidence.outputs.seed?.sha256) {
    fail('promoted seed digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const seed = JSON.parse(seedBytes.toString('utf8'));
  if (seed.targets.length !== evidence.outputs.seed?.target_count) {
    fail('promoted seed target count drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  const admittedSeedEntries = seed.targets.filter(({ inventory_id: inventoryId }) => {
    const number = Number(inventoryId.slice(3));
    return inventoryId.startsWith('m5-') && number >= 535 && number <= 1084;
  });
  if (admittedSeedEntries.length !== 550) {
    fail('promoted seed does not contain the complete 550-row M5-11 scope', 'OUTPUT_COUNT_MISMATCH');
  }
  const seedStatusCounts = Object.fromEntries(
    ['promoted', 'held', 'rejected', 'deferred'].map((status) => [
      status,
      admittedSeedEntries.filter((entry) => entry.status === status).length,
    ]),
  );
  if (seedStatusCounts.promoted !== 500
    || seedStatusCounts.held + seedStatusCounts.rejected + seedStatusCounts.deferred !== 50) {
    fail('promoted seed decision arithmetic drifted', 'OUTPUT_COUNT_MISMATCH');
  }
  const inventoryBytes = await readFile(resolvedInventoryPath);
  if (sha256(inventoryBytes) !== evidence.outputs.inventory?.sha256) {
    fail('promoted inventory digest drifted', 'OUTPUT_DIGEST_MISMATCH');
  }
  const inventory = await validateTargetInventory({
    inventoryPath: resolvedInventoryPath,
    canonicalDirectory: resolvedCanonicalDirectory,
    checkPilotCompleteness: true,
  });
  assertSummary({
    record_count: inventory.canonicalRecordCount,
    start_count: inventory.currentStartCount,
    reference_only_count: inventory.currentReferenceOnlyCount,
  }, {
    record_count: 1320,
    start_count: 1278,
    reference_only_count: 42,
  }, 'promoted inventory snapshot');
  if (inventory.inventoryEntryCount !== evidence.outputs.inventory?.entry_count
    || inventory.canonicalRecordCount !== evidence.outputs.inventory?.canonical_record_count) {
    fail('promoted inventory output counts drifted', 'OUTPUT_COUNT_MISMATCH');
  }

  return {
    batch_id: M5_11_BATCH_ID,
    gate: result.gate,
    summary: finalSummary,
    inventory,
    outputs: evidence.outputs,
    sources: evidence.sources,
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  validateM511Promotion({
    manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
    promotionEvidencePath: args.evidence ?? DEFAULT_PROMOTION_EVIDENCE_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

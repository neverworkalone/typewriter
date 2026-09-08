import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
  validateTargetInventory,
} from '../validate/target-inventory.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const require = createRequire(import.meta.url);
const BATCH_MANIFEST_SCHEMA = require('../../schema/batch-manifest.schema.json');

const manifestSchemaValidator = new Ajv2020({
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
}).compile(BATCH_MANIFEST_SCHEMA);

const ROLES = Object.freeze(['start', 'reference-only']);
const DECISIONS = Object.freeze(['included', 'held', 'rejected', 'corrected']);
const MEASUREMENT_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);

export class BatchValidationError extends Error {
  constructor(message, code = 'BATCH_VALIDATION_ERROR') {
    super(message);
    this.name = 'BatchValidationError';
    this.code = code;
  }
}

function fail(message, code = 'BATCH_VALIDATION_ERROR') {
  throw new BatchValidationError(message, code);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }

  if (value !== value.trim()) {
    fail(`${label} must not have leading or trailing whitespace`, 'UNTRIMMED_VALUE');
  }

  if (value.normalize('NFC') !== value) {
    fail(`${label} must be NFC-normalized`, 'NON_NFC_VALUE');
  }
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`${label} must not contain duplicates`, 'DUPLICATE_VALUE');
  }
}

function requireIsoDate(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`, 'INVALID_TIMESTAMP');
  }
  if (!Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a valid timestamp`, 'INVALID_TIMESTAMP');
  }
}

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertExternalStagingPath(stagedRecordsPath, allowRepositoryStaging) {
  if (isInside(REPOSITORY_DIRECTORY, stagedRecordsPath) && !allowRepositoryStaging) {
    fail(
      `staged canonical input must remain outside the repository: ${stagedRecordsPath}`,
      'STAGED_INPUT_INSIDE_REPOSITORY',
    );
  }
}

function assertCanonicalImportOutputPath(outputPath, canonicalDirectory) {
  if (isInside(REPOSITORY_DIRECTORY, outputPath)) {
    fail(
      `import artifact must remain outside the repository: ${outputPath}`,
      'IMPORT_OUTPUT_INSIDE_REPOSITORY',
    );
  }

  if (isInside(canonicalDirectory, outputPath)) {
    fail(
      `import artifact must remain outside canonical input: ${outputPath}`,
      'IMPORT_OUTPUT_INSIDE_CANONICAL',
    );
  }
}

function validateManifestRecord(record, index) {
  const prefix = `manifest.records[${index}]`;
  requireString(record.decision_note, `${prefix}.decision_note`);

  if (Object.hasOwn(record, 'inventory_id')) {
    requireString(record.inventory_id, `${prefix}.inventory_id`);
  }
  if (Object.hasOwn(record, 'canonical_id')) {
    requireString(record.canonical_id, `${prefix}.canonical_id`);
  }
  if (Object.hasOwn(record, 'corrected_fields')) {
    requireUnique(record.corrected_fields, `${prefix}.corrected_fields`);
    record.corrected_fields.forEach((field, fieldIndex) => {
      requireString(field, `${prefix}.corrected_fields[${fieldIndex}]`);
    });
  }
  if (Object.hasOwn(record, 'related_to')) {
    requireUnique(record.related_to, `${prefix}.related_to`);
    record.related_to.forEach((relatedId, relatedIndex) => {
      requireString(relatedId, `${prefix}.related_to[${relatedIndex}]`);
    });
  }
}

function schemaErrorPath(error) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') {
    pathParts.push(error.params.missingProperty);
  }
  if (error.keyword === 'additionalProperties') {
    pathParts.push(error.params.additionalProperty);
  }
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    'manifest',
  );
}

function schemaErrorCode(error) {
  if (error.keyword === 'additionalProperties') {
    return 'UNKNOWN_FIELD';
  }
  if (error.keyword === 'required') {
    return 'MISSING_FIELD';
  }
  if (error.keyword === 'format') {
    return 'INVALID_TIMESTAMP';
  }
  if (error.keyword === 'enum' || error.keyword === 'const') {
    return 'INVALID_ENUM';
  }
  return 'SCHEMA_ERROR';
}

function validateManifestSchema(manifest) {
  if (manifestSchemaValidator(manifest)) {
    return;
  }

  const error = manifestSchemaValidator.errors?.[0];
  const detail = error
    ? `${schemaErrorPath(error)} ${error.message}`
    : 'manifest does not match the batch manifest schema';
  fail(`batch manifest schema validation failed: ${detail}`, error ? schemaErrorCode(error) : 'SCHEMA_ERROR');
}

function validateMeasurement(measurement) {
  if (!measurement) return;

  const passIds = measurement.timing.passes.map((pass) => pass.id);
  requireUnique(passIds, 'manifest.measurement.timing.passes.id');
  const missingPasses = MEASUREMENT_PASS_IDS.filter((id) => !passIds.includes(id));
  if (missingPasses.length > 0) {
    fail(
      `manifest.measurement.timing is missing pass(es): ${missingPasses.join(', ')}`,
      'MISSING_TIMING_PASS',
    );
  }
  for (const pass of measurement.timing.passes) {
    if (Object.hasOwn(pass, 'started_at')) requireIsoDate(pass.started_at, `manifest.measurement.timing.${pass.id}.started_at`);
    if (Object.hasOwn(pass, 'completed_at')) requireIsoDate(pass.completed_at, `manifest.measurement.timing.${pass.id}.completed_at`);
    if (Object.hasOwn(pass, 'note')) requireString(pass.note, `manifest.measurement.timing.${pass.id}.note`);
    if (pass.status === 'complete' && (!Number.isFinite(pass.wall_clock_seconds) || !Number.isFinite(pass.editor_seconds))) {
      fail(
        `manifest.measurement.timing.${pass.id} is complete but lacks wall-clock and editor seconds`,
        'INCOMPLETE_TIMING',
      );
    }
    if (pass.status === 'partial' && !Number.isFinite(pass.wall_clock_seconds)) {
      fail(
        `manifest.measurement.timing.${pass.id} is partial but lacks wall-clock seconds`,
        'INCOMPLETE_TIMING',
      );
    }
  }
  if (measurement.timing.status === 'complete'
    && measurement.timing.passes.some((pass) => pass.status !== 'complete')) {
    fail('manifest.measurement.timing is declared complete with an unmeasured pass', 'INCOMPLETE_TIMING');
  }

  const findingIds = measurement.audit.findings.map((finding) => finding.id);
  requireUnique(findingIds, 'manifest.measurement.audit.findings.id');
  for (const finding of measurement.audit.findings) {
    requireString(finding.id, `manifest.measurement.audit.findings.${finding.id}.id`);
    requireString(finding.note, `manifest.measurement.audit.findings.${finding.id}.note`);
  }
}

export function validateBatchManifest(manifest) {
  validateManifestSchema(manifest);

  requireString(manifest.batch_id, 'manifest.batch_id');
  requireString(manifest.inventory_revision, 'manifest.inventory_revision');

  for (const key of ['model_id', 'tool_version', 'prompt_version']) {
    requireString(manifest.generator[key], `manifest.generator.${key}`);
  }
  if (Object.hasOwn(manifest.generator, 'draft_sha256')) {
    requireString(manifest.generator.draft_sha256, 'manifest.generator.draft_sha256');
  }

  requireIsoDate(manifest.generated_at, 'manifest.generated_at');

  requireString(manifest.review.reviewer, 'manifest.review.reviewer');
  if (Object.hasOwn(manifest.review, 'completed_at')) {
    requireIsoDate(manifest.review.completed_at, 'manifest.review.completed_at');
  }
  validateMeasurement(manifest.measurement);

  const inventoryIds = new Set();
  const canonicalIds = new Set();
  manifest.records.forEach((record, index) => {
    validateManifestRecord(record, index);
    if (record.source === 'inventory') {
      if (inventoryIds.has(record.inventory_id)) {
        fail(`manifest.records contains duplicate inventory_id ${record.inventory_id}`, 'DUPLICATE_INVENTORY_ID');
      }
      inventoryIds.add(record.inventory_id);
    }
    if (Object.hasOwn(record, 'canonical_id')) {
      if (canonicalIds.has(record.canonical_id)) {
        fail(`manifest.records contains duplicate canonical_id ${record.canonical_id}`, 'DUPLICATE_CANONICAL_ID');
      }
      canonicalIds.add(record.canonical_id);
    }
  });

  return manifest;
}

async function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`invalid batch manifest JSON: ${error.message}`, 'INVALID_JSON');
    }
    if (error.code === 'ENOENT') {
      fail(`batch manifest does not exist: ${manifestPath}`, 'MISSING_MANIFEST');
    }
    throw error;
  }
  return validateBatchManifest(manifest);
}

function numericId(id, prefix) {
  if (!id.startsWith(prefix)) {
    return 0;
  }
  return Number(id.slice(1));
}

function nextIds(existingRecords, role, count) {
  const prefix = role === 'start' ? 'w' : 'r';
  const highest = existingRecords.reduce(
    (max, recordInfo) => Math.max(max, numericId(recordInfo.record.id, prefix)),
    0,
  );
  return Array.from({ length: count }, (_, index) => (
    `${prefix}${String(highest + index + 1).padStart(3, '0')}`
  ));
}

function validateDeterministicSenseIds(recordInfos) {
  for (const recordInfo of recordInfos) {
    const { record } = recordInfo;
    record.senses.forEach((sense, index) => {
      const expected = `${record.id}-s${index + 1}`;
      if (sense.id !== expected) {
        fail(
          `record ${record.id} must use deterministic sense ID ${expected} (received ${sense.id})`,
          'NON_DETERMINISTIC_SENSE_ID',
        );
      }
    });
  }
}

function validateNoDuplicateLexicalKeys(recordInfos) {
  const fields = [
    ['lemma', (record) => [record.lemma], 'DUPLICATE_LEMMA'],
    ['search form', (record) => record.search_forms, 'DUPLICATE_SEARCH_FORM'],
  ];

  for (const [label, valuesForRecord, code] of fields) {
    const owners = new Map();
    for (const recordInfo of recordInfos) {
      for (const value of valuesForRecord(recordInfo.record)) {
        const normalizedValue = value.normalize('NFC');
        const recordIds = owners.get(normalizedValue) ?? [];
        recordIds.push(recordInfo.record.id);
        owners.set(normalizedValue, recordIds);
      }
    }
    for (const [value, recordIds] of owners) {
      if (recordIds.length > 1) {
        fail(`${label} ${value} is duplicated by ${recordIds.join(', ')}`, code);
      }
    }
  }
}

function validateReferenceClosure(manifestRecords, stagedRecordInfos, canonicalRecordInfos) {
  const allCanonicalIds = new Set(
    [...canonicalRecordInfos, ...stagedRecordInfos].map(({ record }) => record.id),
  );
  const stagedById = new Map(stagedRecordInfos.map((recordInfo) => [recordInfo.record.id, recordInfo]));

  for (const manifestRecord of manifestRecords.filter(
    (record) => record.source === 'reference-closure' && (record.decision === 'included' || record.decision === 'corrected'),
  )) {
    const canonicalId = manifestRecord.canonical_id;
    for (const relatedId of manifestRecord.related_to) {
      if (!allCanonicalIds.has(relatedId)) {
        fail(
          `reference closure ${canonicalId} refers to missing canonical ${relatedId}`,
          'MISSING_RELATED_RECORD',
        );
      }
    }

    const referencingSources = [...stagedById.values()]
      .filter(({ record }) => record.senses.some((sense) => (
        sense.relations ?? []
      ).some((relation) => relation.target === canonicalId)))
      .map(({ record }) => record.id);
    if (referencingSources.length === 0) {
      fail(
        `reference closure ${canonicalId} is not referenced by a staged record`,
        'ORPHAN_REFERENCE_CLOSURE',
      );
    }
    for (const relatedId of manifestRecord.related_to) {
      if (!referencingSources.includes(relatedId)) {
        fail(
          `reference closure ${canonicalId} is not referenced from related record ${relatedId}`,
          'REFERENCE_CLOSURE_MISMATCH',
        );
      }
    }
  }
}

function validateDeterministicCanonicalIds(manifestRecords, stagedRecordInfos, canonicalRecordInfos) {
  const importedById = new Map(stagedRecordInfos.map((recordInfo) => [recordInfo.record.id, recordInfo]));
  const approvedRecords = manifestRecords.filter(
    (record) => record.decision === 'included' || record.decision === 'corrected',
  );

  const existingIds = new Set(canonicalRecordInfos.map(({ record }) => record.id));
  for (const recordInfo of stagedRecordInfos) {
    if (existingIds.has(recordInfo.record.id)) {
      fail(`staged record ${recordInfo.record.id} already exists in canonical`, 'CANONICAL_ID_COLLISION');
    }
  }

  for (const role of ROLES) {
    const roleRecords = approvedRecords.filter((record) => record.role === role);
    const expectedIds = nextIds(canonicalRecordInfos, role, roleRecords.length);
    roleRecords.forEach((manifestRecord, index) => {
      const expectedId = expectedIds[index];
      if (manifestRecord.canonical_id !== expectedId) {
        fail(
          `manifest record ${manifestRecord.canonical_id} is not the deterministic next ${role} ID ${expectedId}`,
          'NON_DETERMINISTIC_CANONICAL_ID',
        );
      }
      const stagedRecordInfo = importedById.get(manifestRecord.canonical_id);
      if (!stagedRecordInfo) {
        fail(
          `approved canonical ${manifestRecord.canonical_id} has no staged record`,
          'MISSING_STAGED_RECORD',
        );
      }
    });
  }
}

function inventoryEntryMap(inventory) {
  return new Map(inventory.entries.map((entry) => [entry.inventory_id, entry]));
}

function validateInventoryTargets(manifestRecords, inventory) {
  const entriesById = inventoryEntryMap(inventory);
  for (const manifestRecord of manifestRecords.filter((record) => record.source === 'inventory')) {
    const target = entriesById.get(manifestRecord.inventory_id);
    if (!target) {
      fail(
        `batch target ${manifestRecord.inventory_id} does not exist in target inventory`,
        'MISSING_INVENTORY_TARGET',
      );
    }
    if (target.source !== 'editorial' || !['candidate', 'held'].includes(target.status)) {
      fail(
        `batch target ${manifestRecord.inventory_id} must be a candidate or held editorial row`,
        'INVALID_INVENTORY_TARGET',
      );
    }
    if (manifestRecord.role !== target.planned_role) {
      fail(
        `batch target ${manifestRecord.inventory_id} role does not match inventory planned_role`,
        'INVENTORY_ROLE_DRIFT',
      );
    }
  }
}

function validateStagedMapping(manifestRecords, stagedRecordInfos) {
  const approved = manifestRecords.filter(
    (record) => record.decision === 'included' || record.decision === 'corrected',
  );
  const approvedByCanonicalId = new Map(approved.map((record) => [record.canonical_id, record]));
  const stagedById = new Map();

  for (const recordInfo of stagedRecordInfos) {
    const { record } = recordInfo;
    if (stagedById.has(record.id)) {
      fail(`staged records contain duplicate canonical_id ${record.id}`, 'DUPLICATE_CANONICAL_ID');
    }
    stagedById.set(record.id, recordInfo);
    const manifestRecord = approvedByCanonicalId.get(record.id);
    if (!manifestRecord) {
      fail(`staged record ${record.id} is not approved by the batch manifest`, 'STAGED_RECORD_NOT_APPROVED');
    }
    if (record.role !== manifestRecord.role) {
      fail(`staged record ${record.id} role does not match the batch manifest`, 'STAGED_ROLE_MISMATCH');
    }
  }

  for (const manifestRecord of approved) {
    if (!stagedById.has(manifestRecord.canonical_id)) {
      fail(
        `approved canonical ${manifestRecord.canonical_id} is missing from staged records`,
        'MISSING_STAGED_RECORD',
      );
    }
  }

  return stagedById;
}

export async function validateBatch({
  manifestPath,
  stagedRecordsPath,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  allowRepositoryStaging = false,
} = {}) {
  if (!manifestPath) {
    fail('manifestPath is required', 'MISSING_MANIFEST_PATH');
  }
  if (!stagedRecordsPath) {
    fail('stagedRecordsPath is required', 'MISSING_STAGED_PATH');
  }
  assertExternalStagingPath(stagedRecordsPath, allowRepositoryStaging);

  const manifest = await readManifest(manifestPath);
  if (manifest.review.status !== 'complete') {
    fail('batch review must be complete before canonical import', 'REVIEW_NOT_COMPLETE');
  }

  await validateTargetInventory({ inventoryPath, canonicalDirectory });
  const { inventory } = await readTargetInventory(inventoryPath);
  if (manifest.inventory_id !== inventory.inventory_id) {
    fail('batch manifest inventory_id does not match target inventory', 'INVENTORY_ID_DRIFT');
  }
  if (manifest.inventory_revision !== inventory.revision) {
    fail(
      `batch manifest inventory_revision ${manifest.inventory_revision} does not match ${inventory.revision}`,
      'INVENTORY_REVISION_DRIFT',
    );
  }
  validateInventoryTargets(manifest.records, inventory);

  const canonicalResult = await readCanonicalRecords(canonicalDirectory);
  let stagedResult;
  try {
    stagedResult = await readCanonicalRecords(stagedRecordsPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`staged canonical input does not exist: ${stagedRecordsPath}`, 'MISSING_STAGED_INPUT');
    }
    throw error;
  }

  validateStagedMapping(manifest.records, stagedResult.records);
  validateDeterministicCanonicalIds(manifest.records, stagedResult.records, canonicalResult.records);
  validateDeterministicSenseIds(stagedResult.records);
  validateNoDuplicateLexicalKeys([...canonicalResult.records, ...stagedResult.records]);
  validateReferenceClosure(manifest.records, stagedResult.records, canonicalResult.records);

  validateDatasetRecords(
    [...canonicalResult.records, ...stagedResult.records],
    { checkPilotCompleteness: false },
  );

  const counts = Object.fromEntries(DECISIONS.map((decision) => [
    decision,
    manifest.records.filter((record) => record.decision === decision).length,
  ]));
  const deferredCount = manifest.records.filter((record) => record.decision === 'deferred').length;
  if (deferredCount > 0) counts.deferred = deferredCount;
  const referenceClosureCount = manifest.records.filter(
    (record) => record.source === 'reference-closure' && (record.decision === 'included' || record.decision === 'corrected'),
  ).length;

  return {
    manifest,
    manifestPath,
    stagedRecordsPath,
    inventoryPath,
    canonicalDirectory,
    canonicalRecordCount: canonicalResult.records.length,
    stagedRecordCount: stagedResult.records.length,
    targetCount: manifest.records.filter((record) => record.source === 'inventory').length,
    referenceClosureCount,
    counts,
    stagedRecords: stagedResult.records,
  };
}

export function assertImportArtifactPath(outputPath, canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY) {
  if (!outputPath) {
    fail('outputPath is required', 'MISSING_OUTPUT_PATH');
  }
  assertCanonicalImportOutputPath(outputPath, canonicalDirectory);
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const summary = await validateBatch({
    manifestPath: args.manifest,
    stagedRecordsPath: args['staged-records'],
    inventoryPath: args.inventory,
    canonicalDirectory: args['canonical-dir'],
  });

  if (args.json === 'true') {
    console.log(JSON.stringify({
      batchId: summary.manifest.batch_id,
      canonicalRecordCount: summary.canonicalRecordCount,
      stagedRecordCount: summary.stagedRecordCount,
      targetCount: summary.targetCount,
      referenceClosureCount: summary.referenceClosureCount,
      decisions: summary.counts,
    }, null, 2));
    return summary;
  }

  console.log(
    `Validated batch ${summary.manifest.batch_id}: ${summary.stagedRecordCount} reviewed canonical record(s), ${summary.targetCount} inventory target(s), ${summary.referenceClosureCount} reference closure record(s).`,
  );
  return summary;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

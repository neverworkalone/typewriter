import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  DEFAULT_SEED_PATH,
  buildTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import { validateDatasetRecords } from './dataset-integrity.mjs';
import {
  buildCanonicalSemanticAudit,
} from './semantic-audit.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INVENTORY_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/inventory/m5-target-inventory.json',
);

const REASON_CODES = Object.freeze(['E', 'Q', 'S', 'C', 'A', 'O', 'X']);
const PARTS_OF_SPEECH = Object.freeze(['noun', 'adjective', 'verb', 'expression']);
const RECORD_TYPES = Object.freeze(['entry', 'expression']);
const ROLES = Object.freeze(['start', 'reference-only']);
const SOURCES = Object.freeze(['canonical', 'editorial']);
const STATUSES = Object.freeze([
  'current',
  'candidate',
  'held',
  'rejected',
  'deferred',
  'duplicate',
  'inflected-form',
]);
const SENSE_PROFILES = Object.freeze([
  'single',
  'polysemy',
  'boundary',
  'expression',
]);
const FLAGS = Object.freeze([
  'polysemy',
  'pos-boundary',
  'direct-boundary',
  'mood-range',
  'sensory-transfer',
  'scene-expansion',
  'action-direction',
  'expression-unit',
  'reference-closure',
  'inflected-form',
]);

const CANONICAL_DERIVED_FLAGS = new Set([
  'polysemy',
  'expression-unit',
  'reference-closure',
]);

export class TargetInventoryError extends Error {
  constructor(message, code = 'TARGET_INVENTORY_ERROR') {
    super(message);
    this.name = 'TargetInventoryError';
    this.code = code;
  }
}

function fail(message, code = 'TARGET_INVENTORY_ERROR') {
  throw new TargetInventoryError(message, code);
}

function displayPath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'INVALID_SHAPE');
  }
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

function requireEnum(value, values, label) {
  if (!values.includes(value)) {
    fail(`${label} must be one of ${values.join(', ')} (received ${String(value)})`, 'INVALID_ENUM');
  }
}

function requireArray(value, label, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems) {
    fail(`${label} must be an array with at least ${minItems} item(s)`, 'INVALID_ARRAY');
  }
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`${label} must not contain duplicates`, 'DUPLICATE_VALUE');
  }
}

function requireExactArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${label} does not match canonical data (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
      'CANONICAL_DRIFT',
    );
  }
}

function unique(values) {
  return [...new Set(values)];
}

function senseProfile(record) {
  if (record.record_type === 'expression') {
    return 'expression';
  }

  const partsOfSpeech = unique(record.senses.map((sense) => sense.pos));
  if (record.senses.length > 1 && partsOfSpeech.length > 1) {
    return 'boundary';
  }
  if (record.senses.length > 1) {
    return 'polysemy';
  }
  return 'single';
}

function categoryForCanonicalId(id) {
  if (!id.startsWith('w')) {
    return undefined;
  }

  const number = Number(id.slice(1));
  const ranges = [
    [1, 30, 'E'],
    [31, 60, 'Q'],
    [61, 120, 'S'],
    [121, 180, 'C'],
    [181, 240, 'A'],
    [241, 270, 'O'],
    [271, 300, 'X'],
  ];
  return ranges.find(([first, last]) => number >= first && number <= last)?.[2];
}

function expectedCanonicalFlags(record) {
  const flags = [];
  if (record.record_type === 'expression') {
    flags.push('expression-unit');
  }
  if (record.senses.length > 1) {
    flags.push('polysemy');
  }
  if (record.role === 'reference-only') {
    flags.push('reference-closure');
  }
  return flags;
}

function validateEntryShape(entry, index) {
  const prefix = `entries[${index}]`;
  requireObject(entry, prefix);

  for (const key of [
    'inventory_id',
    'status',
    'record_type',
    'lemma',
    'sense_profile',
    'decision_note',
  ]) {
    if (!Object.hasOwn(entry, key)) {
      fail(`${prefix}.${key} is required`, 'MISSING_FIELD');
    }
  }

  requireString(entry.inventory_id, `${prefix}.inventory_id`);
  if (Object.hasOwn(entry, 'promoted_from')) {
    requireString(entry.promoted_from, `${prefix}.promoted_from`);
  }
  requireEnum(entry.source, SOURCES, `${prefix}.source`);
  requireEnum(entry.status, STATUSES, `${prefix}.status`);
  if (entry.planned_role !== null) {
    requireEnum(entry.planned_role, ROLES, `${prefix}.planned_role`);
  }
  requireEnum(entry.record_type, RECORD_TYPES, `${prefix}.record_type`);
  requireString(entry.lemma, `${prefix}.lemma`);

  requireArray(entry.search_forms, `${prefix}.search_forms`, { minItems: 1 });
  requireUnique(entry.search_forms, `${prefix}.search_forms`);
  entry.search_forms.forEach((form, formIndex) => {
    requireString(form, `${prefix}.search_forms[${formIndex}]`);
  });

  requireArray(entry.reason_codes, `${prefix}.reason_codes`);
  requireUnique(entry.reason_codes, `${prefix}.reason_codes`);
  entry.reason_codes.forEach((code) => requireEnum(code, REASON_CODES, `${prefix}.reason_codes`));

  requireArray(entry.pos, `${prefix}.pos`, { minItems: 1 });
  requireUnique(entry.pos, `${prefix}.pos`);
  entry.pos.forEach((pos) => requireEnum(pos, PARTS_OF_SPEECH, `${prefix}.pos`));

  requireEnum(entry.sense_profile, SENSE_PROFILES, `${prefix}.sense_profile`);
  requireArray(entry.flags, `${prefix}.flags`);
  requireUnique(entry.flags, `${prefix}.flags`);
  entry.flags.forEach((flag) => requireEnum(flag, FLAGS, `${prefix}.flags`));
  requireString(entry.decision_note, `${prefix}.decision_note`);

  if (entry.record_type === 'expression') {
    requireExactArray(entry.pos, ['expression'], `${prefix}.pos`);
    if (entry.sense_profile !== 'expression') {
      fail(`${prefix}.expression record must have sense_profile expression`, 'EXPRESSION_PROFILE');
    }
  } else if (entry.pos.includes('expression')) {
    fail(`${prefix}.entry record cannot have expression part of speech`, 'ENTRY_EXPRESSION_POS');
  }

  if (entry.planned_role === 'start' && entry.reason_codes.length === 0) {
    fail(`${prefix}.start entry must have at least one reason code`, 'MISSING_REASON_CODE');
  }

  if (entry.status === 'current' && entry.source !== 'canonical') {
    fail(`${prefix}.current entry must come from canonical`, 'CURRENT_SOURCE');
  }
  if (entry.source === 'canonical' && entry.status !== 'current') {
    fail(`${prefix}.canonical entry must have status current`, 'CANONICAL_STATUS');
  }
}

function canonicalSummary(records) {
  return {
    recordCount: records.length,
    startCount: records.filter(({ record }) => record.role === 'start').length,
    referenceOnlyCount: records.filter(({ record }) => record.role === 'reference-only').length,
  };
}

function countValues(entries, field) {
  const counts = {};
  for (const entry of entries) {
    const values = Array.isArray(entry[field]) ? entry[field] : [entry[field]];
    for (const value of values) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countStatuses(entries) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return counts;
}

function validateCanonicalEntry(entry, canonicalById, index) {
  const prefix = `entries[${index}]`;
  if (!Object.hasOwn(entry, 'canonical_id')) {
    fail(`${prefix}.canonical_id is required for canonical entry`, 'MISSING_CANONICAL_ID');
  }
  const canonicalInfo = canonicalById.get(entry.canonical_id);
  if (!canonicalInfo) {
    fail(`${prefix}.canonical_id ${entry.canonical_id} does not exist`, 'MISSING_CANONICAL_RECORD');
  }

  const { record } = canonicalInfo;
  const isPromoted = Object.hasOwn(entry, 'promoted_from');
  if (isPromoted) {
    if (entry.inventory_id !== entry.promoted_from) {
      fail(`${prefix}.inventory_id must preserve promoted_from`, 'PROMOTION_ID_DRIFT');
    }
    if (entry.inventory_id.startsWith('canonical-')) {
      fail(`${prefix}.promoted entry must retain its non-canonical inventory_id`, 'PROMOTION_ID_DRIFT');
    }
    if (record.role !== 'start' || entry.planned_role !== 'start') {
      fail(`${prefix}.promoted entry must map to a start canonical record`, 'PROMOTION_ROLE');
    }
    if (entry.record_type !== record.record_type || entry.lemma !== record.lemma) {
      fail(`${prefix}.promoted canonical identity does not match ${record.id}`, 'CANONICAL_DRIFT');
    }
    requireExactArray(entry.search_forms, record.search_forms, `${prefix}.search_forms`);
    if (entry.reason_codes.length === 0) {
      fail(`${prefix}.promoted start must preserve at least one reason code`, 'MISSING_REASON_CODE');
    }
    const expectedPos = unique(record.senses.map((sense) => sense.pos));
    requireExactArray(entry.pos, expectedPos, `${prefix}.pos`);
    if (entry.sense_profile !== senseProfile(record)) {
      fail(`${prefix}.sense_profile does not match canonical ${record.id}`, 'CANONICAL_DRIFT');
    }
    requireExactArray(
      entry.flags.filter((flag) => CANONICAL_DERIVED_FLAGS.has(flag)),
      expectedCanonicalFlags(record),
      `${prefix}.flags`,
    );
    return;
  }

  if (entry.inventory_id !== `canonical-${record.id}`) {
    fail(`${prefix}.inventory_id must be canonical-${record.id}`, 'CANONICAL_INVENTORY_ID');
  }
  if (entry.planned_role !== record.role) {
    fail(`${prefix}.planned_role must match canonical role ${record.role}`, 'CANONICAL_ROLE_DRIFT');
  }
  if (entry.record_type !== record.record_type) {
    fail(`${prefix}.record_type does not match canonical ${record.id}`, 'CANONICAL_DRIFT');
  }
  if (entry.lemma !== record.lemma) {
    fail(`${prefix}.lemma does not match canonical ${record.id}`, 'CANONICAL_DRIFT');
  }
  requireExactArray(entry.search_forms, record.search_forms, `${prefix}.search_forms`);

  const expectedPos = unique(record.senses.map((sense) => sense.pos));
  requireExactArray(entry.pos, expectedPos, `${prefix}.pos`);
  if (entry.sense_profile !== senseProfile(record)) {
    fail(`${prefix}.sense_profile does not match canonical ${record.id}`, 'CANONICAL_DRIFT');
  }
  requireExactArray(entry.flags, expectedCanonicalFlags(record), `${prefix}.flags`);

  const expectedReason = categoryForCanonicalId(record.id);
  const expectedReasonCodes = expectedReason && record.role === 'start' ? [expectedReason] : [];
  requireExactArray(entry.reason_codes, expectedReasonCodes, `${prefix}.reason_codes`);
}

function validateEditorialEntry(entry, canonicalById, index) {
  const prefix = `entries[${index}]`;
  if (Object.hasOwn(entry, 'promoted_from')) {
    fail(`${prefix}.editorial entry must not have promoted_from`, 'EDITORIAL_PROMOTION_ID');
  }
  if (Object.hasOwn(entry, 'canonical_id')) {
    fail(`${prefix}.editorial entry must not have canonical_id`, 'EDITORIAL_CANONICAL_ID');
  }

  if (entry.status === 'candidate' || entry.status === 'held') {
    if (entry.planned_role !== 'start') {
      fail(`${prefix}.${entry.status} entry must have planned_role start`, 'INVALID_PLANNED_ROLE');
    }
  } else if (entry.planned_role !== null) {
    fail(`${prefix}.${entry.status} entry must not count as a role`, 'INVALID_PLANNED_ROLE');
  }

  if (entry.status === 'duplicate' || entry.status === 'inflected-form') {
    if (!entry.related_canonical_id) {
      fail(`${prefix}.${entry.status} entry requires related_canonical_id`, 'MISSING_RELATED_RECORD');
    }
    const related = canonicalById.get(entry.related_canonical_id);
    if (!related) {
      fail(`${prefix}.related_canonical_id ${entry.related_canonical_id} does not exist`, 'MISSING_RELATED_RECORD');
    }
    if (entry.status === 'duplicate') {
      const relatedRecord = related.record;
      if (
        entry.lemma !== relatedRecord.lemma &&
        !entry.search_forms.some((form) => relatedRecord.search_forms.includes(form))
      ) {
        fail(`${prefix}.duplicate entry must share a lemma or search form with its related canonical`, 'DUPLICATE_TARGET_MISMATCH');
      }
    }
  } else if (Object.hasOwn(entry, 'related_canonical_id')) {
    fail(`${prefix}.${entry.status} entry must not have related_canonical_id`, 'UNEXPECTED_RELATED_RECORD');
  }
}

function validateActiveCollisions(entries) {
  const activeEntries = entries.filter(
    (entry) =>
      (entry.source === 'canonical' && entry.planned_role === 'start') ||
      (entry.source === 'editorial' && entry.status === 'candidate'),
  );
  const lemmas = new Map();
  const forms = new Map();

  for (const entry of activeEntries) {
    const lemma = entry.lemma.normalize('NFC');
    const lemmaOwners = lemmas.get(lemma) ?? [];
    lemmaOwners.push(entry.inventory_id);
    lemmas.set(lemma, lemmaOwners);

    for (const form of entry.search_forms) {
      const normalizedForm = form.normalize('NFC');
      const formOwners = forms.get(normalizedForm) ?? [];
      formOwners.push(entry.inventory_id);
      forms.set(normalizedForm, formOwners);
    }
  }

  for (const [lemma, owners] of lemmas) {
    if (owners.length > 1) {
      fail(`active start lemma ${lemma} is duplicated by ${owners.join(', ')}`, 'DUPLICATE_START_LEMMA');
    }
  }
  for (const [form, owners] of forms) {
    if (owners.length > 1) {
      fail(`active start search form ${form} is duplicated by ${owners.join(', ')}`, 'DUPLICATE_START_SEARCH_FORM');
    }
  }
}

export async function readTargetInventory(
  inventoryPath = DEFAULT_INVENTORY_PATH,
  {
    canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
    seedPath = DEFAULT_SEED_PATH,
    promotionPath,
  } = {},
) {
  if (path.resolve(inventoryPath) === path.resolve(DEFAULT_INVENTORY_PATH)) {
    return {
      inventory: await buildTargetInventory({
        canonicalDirectory,
        seedPath,
        ...(promotionPath ? { promotionPath } : {}),
      }),
      inventoryPath,
    };
  }
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TargetInventoryError(
        `${displayPath(inventoryPath)}: invalid JSON (${error.message})`,
        'INVALID_JSON',
      );
    }
    throw error;
  }
  return { inventory, inventoryPath };
}

export async function validateTargetInventory({
  inventoryPath = DEFAULT_INVENTORY_PATH,
  inventory: suppliedInventory,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  seedPath = DEFAULT_SEED_PATH,
  promotionPath,
  checkPilotCompleteness = true,
} = {}) {
  const inventory = suppliedInventory ?? (path.resolve(inventoryPath) === path.resolve(DEFAULT_INVENTORY_PATH)
    ? await buildTargetInventory({
      canonicalDirectory,
      seedPath,
      ...(promotionPath ? { promotionPath } : {}),
    })
    : (await readTargetInventory(inventoryPath)).inventory);
  requireObject(inventory, 'inventory');

  if (inventory.schema_version !== '1') {
    fail(`inventory.schema_version must be 1`, 'SCHEMA_VERSION');
  }
  if (inventory.inventory_id !== 'm5-core-5k') {
    fail(`inventory.inventory_id must be m5-core-5k`, 'INVENTORY_ID');
  }
  requireString(inventory.revision, 'inventory.revision');
  if (!/^m5-[1-9][0-9]*$/u.test(inventory.revision)) {
    fail(`inventory.revision must match m5-N`, 'REVISION_FORMAT');
  }
  if (inventory.count_unit !== 'search-start') {
    fail(`inventory.count_unit must be search-start`, 'COUNT_UNIT');
  }
  requireObject(inventory.canonical_scope, 'inventory.canonical_scope');
  requireString(inventory.canonical_scope.directory, 'inventory.canonical_scope.directory');
  requireExactArray(
    inventory.canonical_scope.roles,
    ['start', 'reference-only'],
    'inventory.canonical_scope.roles',
  );
  requireString(inventory.canonical_scope.source, 'inventory.canonical_scope.source');
  requireArray(inventory.generated_from, 'inventory.generated_from', { minItems: 2 });
  inventory.generated_from.forEach((source, index) => {
    requireString(source, `inventory.generated_from[${index}]`);
  });
  requireObject(inventory.canonical_snapshot, 'inventory.canonical_snapshot');
  for (const key of ['record_count', 'start_count', 'reference_only_count']) {
    if (!Number.isInteger(inventory.canonical_snapshot[key]) || inventory.canonical_snapshot[key] < 0) {
      fail(`inventory.canonical_snapshot.${key} must be a non-negative integer`, 'INVALID_SNAPSHOT');
    }
  }

  requireArray(inventory.entries, 'inventory.entries', { minItems: 1 });
  const seenInventoryIds = new Set();
  const canonicalIds = new Set();
  for (const [index, entry] of inventory.entries.entries()) {
    validateEntryShape(entry, index);
    if (seenInventoryIds.has(entry.inventory_id)) {
      fail(`duplicate inventory_id ${entry.inventory_id}`, 'DUPLICATE_INVENTORY_ID');
    }
    seenInventoryIds.add(entry.inventory_id);
    if (entry.source === 'canonical') {
      if (canonicalIds.has(entry.canonical_id)) {
        fail(`duplicate canonical_id ${entry.canonical_id}`, 'DUPLICATE_CANONICAL_ID');
      }
      canonicalIds.add(entry.canonical_id);
    }
  }

  const canonicalResult = await readCanonicalRecords(canonicalDirectory);
  const requireSemanticAudit = path.resolve(canonicalDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const semanticAudit = requireSemanticAudit
    ? (await buildCanonicalSemanticAudit({ canonicalDirectory })).artifact
    : undefined;
  validateDatasetRecords(canonicalResult.records, {
    checkPilotCompleteness,
    semanticAudit,
    requireSemanticAudit,
  });
  const canonicalById = new Map(
    canonicalResult.records.map((recordInfo) => [recordInfo.record.id, recordInfo]),
  );

  for (const [index, entry] of inventory.entries.entries()) {
    if (entry.source === 'canonical') {
      validateCanonicalEntry(entry, canonicalById, index);
    } else {
      validateEditorialEntry(entry, canonicalById, index);
    }
  }

  const missingCanonicalIds = [...canonicalById.keys()].filter(
    (id) => !canonicalIds.has(id),
  );
  if (missingCanonicalIds.length > 0) {
    fail(`inventory is missing canonical record(s): ${missingCanonicalIds.join(', ')}`, 'MISSING_CANONICAL_ENTRY');
  }
  if (canonicalIds.size !== canonicalById.size) {
    fail('inventory contains canonical entries not present in the canonical dataset', 'UNEXPECTED_CANONICAL_ENTRY');
  }

  validateActiveCollisions(inventory.entries);

  const canonical = canonicalSummary(canonicalResult.records);
  if (inventory.canonical_snapshot.record_count !== canonical.recordCount) {
    fail('canonical snapshot record_count is stale', 'STALE_SNAPSHOT');
  }
  if (inventory.canonical_snapshot.start_count !== canonical.startCount) {
    fail('canonical snapshot start_count is stale', 'STALE_SNAPSHOT');
  }
  if (inventory.canonical_snapshot.reference_only_count !== canonical.referenceOnlyCount) {
    fail('canonical snapshot reference_only_count is stale', 'STALE_SNAPSHOT');
  }

  const currentEntries = inventory.entries.filter((entry) => entry.status === 'current');
  const candidateEntries = inventory.entries.filter((entry) => entry.status === 'candidate');
  const activeStartEntries = inventory.entries.filter(
    (entry) =>
      (entry.status === 'current' || entry.status === 'candidate') &&
      entry.planned_role === 'start',
  );
  const countsByStatus = countStatuses(inventory.entries);

  return {
    inventoryPath,
    inventoryId: inventory.inventory_id,
    revision: inventory.revision,
    inventoryEntryCount: inventory.entries.length,
    canonicalRecordCount: canonical.recordCount,
    currentStartCount: canonical.startCount,
    currentReferenceOnlyCount: canonical.referenceOnlyCount,
    candidateStartCount: candidateEntries.filter((entry) => entry.planned_role === 'start').length,
    plannedStartCount: activeStartEntries.length,
    heldCount: countsByStatus.held,
    rejectedCount: countsByStatus.rejected,
    deferredCount: countsByStatus.deferred,
    duplicateCount: countsByStatus.duplicate,
    inflectedFormCount: countsByStatus['inflected-form'],
    statusCounts: countsByStatus,
    recordTypeCounts: countValues(activeStartEntries, 'record_type'),
    reasonCodeCounts: countValues(activeStartEntries, 'reason_codes'),
    posCounts: countValues(activeStartEntries, 'pos'),
    senseProfileCounts: countValues(activeStartEntries, 'sense_profile'),
    currentEntryCount: currentEntries.length,
  };
}

export async function main() {
  const summary = await validateTargetInventory();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `Validated target inventory ${summary.revision}: ${summary.currentStartCount} current start + ${summary.candidateStartCount} candidate start = ${summary.plannedStartCount} planned start; ${summary.currentReferenceOnlyCount} reference-only; ${summary.heldCount} held; ${summary.rejectedCount} rejected; ${summary.deferredCount} deferred; ${summary.duplicateCount} duplicate; ${summary.inflectedFormCount} inflected-form.`,
  );
  console.log(`Reason-code distribution: ${JSON.stringify(summary.reasonCodeCounts)}`);
  console.log(`POS distribution: ${JSON.stringify(summary.posCounts)}`);
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

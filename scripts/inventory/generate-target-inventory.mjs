import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/inventory/m5-target-seed.json',
);
export const DEFAULT_OUTPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/inventory/m5-target-inventory.json',
);

export function serializeTargetInventory(inventory) {
  return Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

const CATEGORY_RANGES = Object.freeze([
  [1, 30, 'E'],
  [31, 60, 'Q'],
  [61, 120, 'S'],
  [121, 180, 'C'],
  [181, 240, 'A'],
  [241, 270, 'O'],
  [271, 300, 'X'],
]);

const CANONICAL_DERIVED_FLAGS = new Set([
  'polysemy',
  'expression-unit',
  'reference-closure',
]);

export class TargetInventoryGenerationError extends Error {
  constructor(message, code = 'TARGET_INVENTORY_GENERATION_ERROR') {
    super(message);
    this.name = 'TargetInventoryGenerationError';
    this.code = code;
  }
}

function categoryForCanonicalId(id) {
  if (!id.startsWith('w')) {
    return undefined;
  }

  const number = Number(id.slice(1));
  return CATEGORY_RANGES.find(
    ([first, last]) => number >= first && number <= last,
  )?.[2];
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

function flagsForCanonicalRecord(record) {
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

function selectionFlagsForSeed(seedEntry) {
  return seedEntry.flags.filter((flag) => !CANONICAL_DERIVED_FLAGS.has(flag));
}

function canonicalEntry(recordInfo) {
  const { record } = recordInfo;
  const reasonCode = categoryForCanonicalId(record.id);

  if (record.role === 'start' && !reasonCode) {
    throw new TargetInventoryGenerationError(
      `canonical start ${record.id} needs a promoted inventory mapping before it can enter the target inventory`,
      'UNMAPPED_CANONICAL_START',
    );
  }

  return {
    inventory_id: `canonical-${record.id}`,
    source: 'canonical',
    canonical_id: record.id,
    status: 'current',
    planned_role: record.role,
    record_type: record.record_type,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    reason_codes: reasonCode ? [reasonCode] : [],
    pos: unique(record.senses.map((sense) => sense.pos)),
    sense_profile: senseProfile(record),
    flags: flagsForCanonicalRecord(record),
    decision_note:
      record.role === 'start'
        ? '기존 canonical start; 현재 편집 모델의 출발어로 유지한다.'
        : '관계 참조 완결을 위한 기존 reference-only; start로 세지 않는다.',
  };
}

function validateSeedPromotion(entry) {
  if (entry.status === 'proposed') {
    if (!Object.hasOwn(entry, 'proposal_canonical_id')) {
      throw new TargetInventoryGenerationError(
        `proposed seed ${entry.inventory_id} requires proposal_canonical_id`,
        'MISSING_PROPOSAL_CANONICAL_ID',
      );
    }
    if (!/^w[0-9]{3,}$/u.test(entry.proposal_canonical_id)) {
      throw new TargetInventoryGenerationError(
        `proposed seed ${entry.inventory_id} has invalid proposal_canonical_id ${entry.proposal_canonical_id}`,
        'INVALID_PROPOSAL_CANONICAL_ID',
      );
    }
    if (entry.planned_role !== 'start') {
      throw new TargetInventoryGenerationError(
        `proposed seed ${entry.inventory_id} must retain planned_role start`,
        'INVALID_PROPOSAL_ROLE',
      );
    }
    return;
  }
  if (entry.status !== 'promoted') {
    if (Object.hasOwn(entry, 'canonical_id')) {
      throw new TargetInventoryGenerationError(
        `seed ${entry.inventory_id} must not have canonical_id until status is promoted`,
        'INVALID_PROMOTION_STATE',
      );
    }
    return;
  }

  if (!Object.hasOwn(entry, 'canonical_id')) {
    throw new TargetInventoryGenerationError(
      `promoted seed ${entry.inventory_id} requires canonical_id`,
      'MISSING_PROMOTED_CANONICAL_ID',
    );
  }
  if (!/^w[0-9]{3,}$/u.test(entry.canonical_id)) {
    throw new TargetInventoryGenerationError(
      `promoted seed ${entry.inventory_id} has invalid canonical_id ${entry.canonical_id}`,
      'INVALID_PROMOTED_CANONICAL_ID',
    );
  }
  if (entry.planned_role !== 'start') {
    throw new TargetInventoryGenerationError(
      `promoted seed ${entry.inventory_id} must retain planned_role start`,
      'INVALID_PROMOTION_ROLE',
    );
  }
}

function proposedEditorialEntry(seedEntry) {
  const { proposal_canonical_id: ignoredProposalCanonicalId, ...entry } = seedEntry;
  return { ...entry, source: 'editorial', status: 'candidate' };
}

function promotedCanonicalEntry(recordInfo, seedEntry) {
  const { record } = recordInfo;

  return {
    inventory_id: seedEntry.inventory_id,
    source: 'canonical',
    canonical_id: record.id,
    promoted_from: seedEntry.inventory_id,
    status: 'current',
    planned_role: record.role,
    record_type: record.record_type,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    reason_codes: [...seedEntry.reason_codes],
    pos: unique(record.senses.map((sense) => sense.pos)),
    sense_profile: senseProfile(record),
    flags: [
      ...flagsForCanonicalRecord(record),
      ...selectionFlagsForSeed(seedEntry),
    ],
    decision_note: seedEntry.decision_note,
  };
}

export async function buildTargetInventory({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  seedPath = DEFAULT_SEED_PATH,
  generatedFromSeedPath = seedPath,
  generatedFromCanonicalDirectory = canonicalDirectory,
  canonicalScopeDirectory = canonicalDirectory,
} = {}) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));

  const promotions = seed.targets.filter((entry) => {
    validateSeedPromotion(entry);
    return entry.status === 'promoted';
  });
  const proposals = seed.targets.filter((entry) => entry.status === 'proposed');
  const promotionsByCanonicalId = new Map();
  for (const promotion of promotions) {
    if (promotionsByCanonicalId.has(promotion.canonical_id)) {
      throw new TargetInventoryGenerationError(
        `multiple promoted seeds target canonical ${promotion.canonical_id}`,
        'DUPLICATE_PROMOTED_CANONICAL_ID',
      );
    }
    promotionsByCanonicalId.set(promotion.canonical_id, promotion);
  }
  const canonicalById = new Map(
    canonical.records.map((recordInfo) => [recordInfo.record.id, recordInfo]),
  );
  const proposedCanonicalIds = new Set();
  for (const proposal of proposals) {
    if (proposedCanonicalIds.has(proposal.proposal_canonical_id)) {
      throw new TargetInventoryGenerationError(
        `multiple proposed seeds target canonical ${proposal.proposal_canonical_id}`,
        'DUPLICATE_PROPOSED_CANONICAL_ID',
      );
    }
    proposedCanonicalIds.add(proposal.proposal_canonical_id);
    if (canonicalById.has(proposal.proposal_canonical_id)) {
      throw new TargetInventoryGenerationError(
        `proposed seed ${proposal.inventory_id} targets an existing canonical ${proposal.proposal_canonical_id}; review it as promoted instead`,
        'PROPOSAL_CANONICAL_ALREADY_EXISTS',
      );
    }
  }

  for (const promotion of promotions) {
    if (!canonicalById.has(promotion.canonical_id)) {
      throw new TargetInventoryGenerationError(
        `promoted seed ${promotion.inventory_id} targets missing canonical ${promotion.canonical_id}`,
        'MISSING_PROMOTED_CANONICAL',
      );
    }
  }

  const currentEntries = canonical.records
    .map((recordInfo) => {
      const promotion = promotionsByCanonicalId.get(recordInfo.record.id);
      return promotion
        ? promotedCanonicalEntry(recordInfo, promotion)
        : canonicalEntry(recordInfo);
    })
    .sort((left, right) => left.canonical_id.localeCompare(right.canonical_id));

  const entries = [
    ...currentEntries,
    ...seed.targets
      .filter((entry) => entry.status !== 'promoted')
      .map((entry) => entry.status === 'proposed'
        ? proposedEditorialEntry(entry)
        : ({ source: 'editorial', ...entry })),
  ];
  const currentStartCount = currentEntries.filter(
    (entry) => entry.planned_role === 'start',
  ).length;
  const currentReferenceOnlyCount = currentEntries.filter(
    (entry) => entry.planned_role === 'reference-only',
  ).length;

  const inventory = {
    schema_version: seed.schema_version,
    inventory_id: seed.inventory_id,
    revision: seed.revision,
    count_unit: 'search-start',
    canonical_scope: {
      directory: path.relative(process.cwd(), canonicalScopeDirectory),
      roles: ['start', 'reference-only'],
      source: 'canonical JSONL; copied into this reviewable inventory snapshot',
    },
    generated_from: [
      path.relative(process.cwd(), generatedFromCanonicalDirectory),
      path.relative(process.cwd(), generatedFromSeedPath),
    ],
    canonical_snapshot: {
      record_count: currentEntries.length,
      start_count: currentStartCount,
      reference_only_count: currentReferenceOnlyCount,
    },
    entries,
  };

  return inventory;
}

/**
 * Materialize the generated inventory only when an explicit output path is
 * supplied. The current inventory is a deterministic view of canonical plus
 * seed data and is otherwise kept in memory.
 */
export async function generateTargetInventory(options = {}) {
  const inventory = await buildTargetInventory(options);
  if (options.outputPath) {
    await writeFile(options.outputPath, serializeTargetInventory(inventory), 'utf8');
  }
  return inventory;
}

export async function main() {
  const inventory = await generateTargetInventory();
  console.log(
    `Built ${inventory.entries.length} target inventory row(s) in memory from ${inventory.canonical_snapshot.record_count} canonical record(s) and ${inventory.entries.length - inventory.canonical_snapshot.record_count} non-canonical decision(s).`,
  );
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

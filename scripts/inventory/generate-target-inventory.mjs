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

const CATEGORY_RANGES = Object.freeze([
  [1, 30, 'E'],
  [31, 60, 'Q'],
  [61, 120, 'S'],
  [121, 180, 'C'],
  [181, 240, 'A'],
  [241, 270, 'O'],
  [271, 300, 'X'],
]);

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

function canonicalEntry(recordInfo) {
  const { record } = recordInfo;
  const reasonCode = categoryForCanonicalId(record.id);

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

export async function generateTargetInventory({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  seedPath = DEFAULT_SEED_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));

  const currentEntries = canonical.records
    .map(canonicalEntry)
    .sort((left, right) => left.canonical_id.localeCompare(right.canonical_id));

  const entries = [
    ...currentEntries,
    ...seed.targets.map((entry) => ({ source: 'editorial', ...entry })),
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
      directory: path.relative(process.cwd(), canonicalDirectory),
      roles: ['start', 'reference-only'],
      source: 'canonical JSONL; copied into this reviewable inventory snapshot',
    },
    generated_from: [
      path.relative(process.cwd(), canonicalDirectory),
      path.relative(process.cwd(), seedPath),
    ],
    canonical_snapshot: {
      record_count: currentEntries.length,
      start_count: currentStartCount,
      reference_only_count: currentReferenceOnlyCount,
    },
    entries,
  };

  await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

export async function main() {
  const inventory = await generateTargetInventory();
  console.log(
    `Generated ${inventory.entries.length} target inventory row(s) from ${inventory.canonical_snapshot.record_count} canonical record(s) and ${inventory.entries.length - inventory.canonical_snapshot.record_count} non-canonical decision(s).`,
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

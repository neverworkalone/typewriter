import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SEED_PATH,
  generateTargetInventory,
} from '../inventory/generate-target-inventory.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_BASE_CANONICAL_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-10-wave-b-base-canonical',
);
export const DEFAULT_OUTPUT_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-10-wave-b-preimport-inventory.json',
);
const WAVE_B_FIRST_INVENTORY_NUMBER = 365;
const WAVE_B_LAST_INVENTORY_NUMBER = 534;

function isWaveBInventoryId(inventoryId) {
  const match = /^m5-([0-9]+)$/u.exec(inventoryId);
  if (!match) return false;
  const number = Number(match[1]);
  return number >= WAVE_B_FIRST_INVENTORY_NUMBER
    && number <= WAVE_B_LAST_INVENTORY_NUMBER;
}

export async function buildWaveBPreimportInventory({
  canonicalDirectory = DEFAULT_BASE_CANONICAL_DIRECTORY,
  seedPath = DEFAULT_SEED_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  const preimportSeed = structuredClone(seed);
  for (const entry of preimportSeed.targets) {
    if (!isWaveBInventoryId(entry.inventory_id)) continue;
    entry.status = 'candidate';
    delete entry.canonical_id;
  }

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'typewriter-m5-10-wave-b-seed-'),
  );
  const temporarySeedPath = path.join(temporaryDirectory, 'seed.json');
  try {
    await writeFile(
      temporarySeedPath,
      `${JSON.stringify(preimportSeed, null, 2)}\n`,
      'utf8',
    );
    return await generateTargetInventory({
      canonicalDirectory,
      seedPath: temporarySeedPath,
      outputPath,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
  buildWaveBPreimportInventory({
    canonicalDirectory: args['canonical-dir'] ?? DEFAULT_BASE_CANONICAL_DIRECTORY,
    seedPath: args.seed ?? DEFAULT_SEED_PATH,
    outputPath: args.output ?? DEFAULT_OUTPUT_PATH,
  })
    .then((inventory) => {
      console.log(
        `Generated Wave B pre-import inventory with ${inventory.entries.length} row(s) from ${inventory.canonical_snapshot.record_count} base canonical record(s).`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

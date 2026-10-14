import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inventoryStdictSource } from './convert.mjs';

const DEFAULT_FILE = 'data/provenance/stdict-source-inventory.json';
/** Population decided in #671/#678: the complete STDICT download. */
export const EXPECTED_STDICT_POPULATION = Object.freeze({ file_count: 88, entry_count: 436587, sense_count: 509143 });

/**
 * Writes (or `--verify`s) the trusted inventory of the STDICT download: the exact file set with each file's sha256
 * and entry count. Shard generation and settlement refuse any source that differs from it, and the inventory itself is only
 * written for the complete 88-file / 436,587-entry / 509,143-sense download.
 */
async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const file = path.resolve(option('out', DEFAULT_FILE));
  const text = `${JSON.stringify(await inventoryStdictSource(option('source', path.join(os.homedir(), '.cache/typewriter/dict/stdict')), { expected: EXPECTED_STDICT_POPULATION }), null, 1)}\n`;
  if (args.includes('--verify')) {
    if (await readFile(file, 'utf8').catch(() => null) !== text) throw new Error('the STDICT source differs from the committed inventory');
    console.log('verified source inventory, byte-identical');
    return;
  }
  await writeFile(file, text);
  console.log(`wrote ${path.relative('.', file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

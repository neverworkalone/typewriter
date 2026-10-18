import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  assertShard,
  batchScope,
  candidateInventory,
  loadApprovedRelations,
  loadOptionalJsonl,
  loadShard,
  prepareShard,
  shardDropPath,
  shardRelationPath,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';

const USAGE = `usage:
  node scripts/relation/admission-cli.mjs prepare --shard 001 [--batch 01] [--out <file.json>] [--allow-partial]
  node scripts/relation/admission-cli.mjs verify  --shard 001 [--batch 01] [--allow-partial]`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, shard: null, batch: null, out: null, allowPartial: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--shard') options.shard = rest[++index];
    else if (flag === '--batch') options.batch = rest[++index];
    else if (flag === '--out') options.out = rest[++index];
    else if (flag === '--allow-partial') options.allowPartial = true;
    else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (!['prepare', 'verify'].includes(command)) throw new Error(USAGE);
  assertShard(options.shard);
  if (options.batch !== null && !['01', '02'].includes(options.batch)) throw new Error(`--batch must be 01 or 02\n${USAGE}`);
  return options;
}

function requireComplete(inventory, allowPartial) {
  if (inventory.missing.length === 0) return;
  const message = `shard Stage 1 inputs are incomplete; missing batch/producer: ${inventory.missing.join(', ')}`;
  if (!allowPartial) throw new Error(`${message}. Do not substitute other AI output; pass --allow-partial only for tooling checks.`);
  console.error(`PARTIAL: ${message}`);
}

export async function run(argv, { root } = {}) {
  const options = parseArgs(argv);
  const loaded = await loadShard(options.shard, root);
  const { canonicalRows, index } = loaded;
  // `--batch NN` works on one 500-record batch of the shard (its Candidate files and Canonical rows only).
  const scoped = options.batch ? batchScope(canonicalRows, loaded.candidateFiles, options.batch) : { scopeRows: canonicalRows, files: loaded.candidateFiles };
  const { scopeRows } = scoped;
  const candidateFiles = scoped.files;
  const inventory = options.batch ? candidateInventory(candidateFiles.map((file) => file.name), { batches: [options.batch] }) : loaded.inventory;
  requireComplete(inventory, options.allowPartial);
  const others = await loadApprovedRelations(root, { exceptShard: options.shard });

  if (options.command === 'prepare') {
    // A re-run must not re-offer what is already decided: this shard's own approved rows and real Drops count too.
    const own = await loadOptionalJsonl(shardRelationPath(options.shard, root));
    const ownDrops = await loadOptionalJsonl(shardDropPath(options.shard, root));
    const result = prepareShard({ canonicalRows, candidateFiles, approvedRelationRows: [...others, ...own], dropRows: ownDrops, index, scopeRows });
    const payload = { shard: options.shard, batch: options.batch, complete: inventory.missing.length === 0, missing: inventory.missing, stats: result.stats, items: result.items };
    if (options.out) {
      await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(payload)}\n`);
    }
    console.log(`Prepared shard ${options.shard}: ${JSON.stringify(result.stats)}${options.out ? ` -> ${options.out}` : ''}`);
    return payload;
  }

  const relationRows = await loadOptionalJsonl(shardRelationPath(options.shard, root));
  const dropRows = await loadOptionalJsonl(shardDropPath(options.shard, root));
  const shardSenseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows: others });
  const counts = verifyAccounting({ canonicalRows, candidateFiles, relationRows, dropRows, otherRelationRows: others, index, scopeRows });
  console.log(`Relation Admission accounting valid for shard ${options.shard}: ${JSON.stringify(counts)}`);
  return counts;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertImportArtifactPath,
  validateBatch,
} from './validate-batch.mjs';

export function compareCanonicalIds(left, right) {
  const leftPrefix = left[0];
  const rightPrefix = right[0];
  if (leftPrefix !== rightPrefix) {
    return leftPrefix.localeCompare(rightPrefix, 'en');
  }

  const numberDifference = Number(left.slice(1)) - Number(right.slice(1));
  return numberDifference || left.localeCompare(right, 'en');
}

export async function writeReviewedBatchImport({
  manifestPath,
  stagedRecordsPath,
  semanticAuditPath,
  outputPath,
  inventoryPath,
  canonicalDirectory,
  productionStateSources,
} = {}) {
  assertImportArtifactPath(outputPath, canonicalDirectory);
  const summary = await validateBatch({
    manifestPath,
    stagedRecordsPath,
    semanticAuditPath,
    inventoryPath,
    canonicalDirectory,
    productionStateSources,
  });

  const records = summary.stagedRecords
    .map(({ record }) => record)
    .sort((left, right) => compareCanonicalIds(left.id, right.id));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const output = records.length > 0
    ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    : '';
  await writeFile(
    outputPath,
    output,
    'utf8',
  );

  return {
    ...summary,
    outputPath,
    outputRecordCount: records.length,
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const summary = await writeReviewedBatchImport({
    manifestPath: args.manifest,
    stagedRecordsPath: args['staged-records'],
    semanticAuditPath: args['semantic-audit'],
    outputPath: args.output,
    inventoryPath: args.inventory,
    canonicalDirectory: args['canonical-dir'],
  });
  console.log(
    `Wrote ${summary.outputRecordCount} reviewed canonical record(s) to ${summary.outputPath}. Canonical input was not modified.`,
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

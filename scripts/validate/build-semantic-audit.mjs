import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  DEFAULT_SEMANTIC_AUDIT_PATH,
  buildSemanticAuditArtifact,
} from './semantic-audit.mjs';

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

export async function buildSemanticAudit({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  outputPath = DEFAULT_SEMANTIC_AUDIT_PATH,
} = {}) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const artifact = buildSemanticAuditArtifact(canonical.records);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return {
    outputPath,
    recordCount: artifact.record_count,
    senseCount: artifact.sense_count,
    canonicalRecordsSha256: artifact.source.canonical_records_sha256,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildSemanticAudit({
    canonicalDirectory: args.canonical ?? DEFAULT_CANONICAL_DIRECTORY,
    outputPath: args.output ?? DEFAULT_SEMANTIC_AUDIT_PATH,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

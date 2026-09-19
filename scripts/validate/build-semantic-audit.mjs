import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  assembleSemanticAuditArtifact,
  readSemanticDecisionSourceArtifact,
  validateSemanticAuditCoverage,
  validateSemanticDecisionSource,
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
  decisionSourcePath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  coveragePath,
  outputPath,
} = {}) {
  const temporaryRoot = !coveragePath || !outputPath
    ? await mkdtemp(path.join(os.tmpdir(), 'typewriter-semantic-audit-'))
    : undefined;
  const resolvedCoveragePath = coveragePath
    ?? path.join(temporaryRoot, 'canonical-semantic-coverage.json');
  const resolvedOutputPath = outputPath
    ?? path.join(temporaryRoot, 'canonical-semantic-audit.json');
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const decisionSource = await readSemanticDecisionSourceArtifact(decisionSourcePath);
  const semanticReview = validateSemanticDecisionSource(canonical.records, decisionSource, {
    baseRecords: canonical.records,
    label: 'semantic decision source',
  });
  const artifact = assembleSemanticAuditArtifact(canonical.records, semanticReview);
  validateSemanticAuditCoverage(canonical.records, artifact, {
    baseRecords: canonical.records,
  });
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await mkdir(path.dirname(resolvedCoveragePath), { recursive: true });
  await writeFile(resolvedCoveragePath, `${JSON.stringify(artifact.coverage, null, 2)}\n`, 'utf8');
  await writeFile(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return {
    decisionSourcePath,
    coveragePath: resolvedCoveragePath,
    outputPath: resolvedOutputPath,
    temporaryRoot,
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
    decisionSourcePath: args['decision-source'] ?? DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
    coveragePath: args.coverage,
    outputPath: args.output,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

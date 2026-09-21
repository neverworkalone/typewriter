import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  canonicalRecordsSha256,
  readAuthoredBatchDecisionSources,
  validateSemanticAuditCoverage,
  validateSemanticDecisionSource,
} from './semantic-audit.mjs';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Rebuild deterministic coverage and the audit envelope from a separately
 * authored decision source. This command deliberately has no fallback to a
 * previous review or a boundary-only artifact: a missing decision source is
 * a hard failure, so semantic pass evidence cannot be manufactured from the
 * current canonical state.
 */
async function rebuildOne({
  canonicalDirectory,
  decisionSource,
  auditOutputPath,
  reviewOutputPath,
  coverageOutputPath,
}) {
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const batchDecisionSources = await readAuthoredBatchDecisionSources();
  const review = validateSemanticDecisionSource(
    canonical.records,
    decisionSource,
    {
      baseRecords: canonical.records,
      label: 'semantic decision source',
      batchDecisionSources,
    },
  );
  const audit = assembleSemanticAuditArtifact(canonical.records, review, {
    artifactId: path.basename(auditOutputPath, '.json'),
  });
  validateSemanticAuditCoverage(canonical.records, audit, {
    baseRecords: canonical.records,
    label: 'rebuilt semantic audit',
  });
  await Promise.all([
    mkdir(path.dirname(auditOutputPath), { recursive: true }),
    mkdir(path.dirname(reviewOutputPath), { recursive: true }),
    mkdir(path.dirname(coverageOutputPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(reviewOutputPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8'),
    writeFile(coverageOutputPath, `${JSON.stringify(audit.coverage, null, 2)}\n`, 'utf8'),
    writeFile(auditOutputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8'),
  ]);
  return {
    canonicalDirectory,
    auditOutputPath,
    reviewOutputPath,
    coverageOutputPath,
    decisionSourceId: decisionSource.source_id,
    recordCount: audit.record_count,
    senseCount: audit.sense_count,
    canonicalRecordsSha256: canonicalRecordsSha256(canonical.records),
  };
}

export async function rebuildSemanticEvidence({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  decisionSourceInputPath = DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  reviewOutputPath,
  coverageOutputPath,
  auditOutputPath,
} = {}) {
  const decisionSource = await readJson(decisionSourceInputPath);
  const temporaryRoot = !reviewOutputPath || !coverageOutputPath || !auditOutputPath
    ? await mkdtemp(path.join(os.tmpdir(), 'typewriter-semantic-evidence-'))
    : undefined;
  const resolvedReviewOutputPath = reviewOutputPath
    ?? path.join(temporaryRoot, 'canonical-semantic-review.json');
  const resolvedCoverageOutputPath = coverageOutputPath
    ?? path.join(temporaryRoot, 'canonical-semantic-coverage.json');
  const resolvedAuditOutputPath = auditOutputPath
    ?? path.join(temporaryRoot, 'canonical-semantic-audit.json');
  return rebuildOne({
    canonicalDirectory,
    decisionSource,
    auditOutputPath: resolvedAuditOutputPath,
    reviewOutputPath: resolvedReviewOutputPath,
    coverageOutputPath: resolvedCoverageOutputPath,
  });
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
  rebuildSemanticEvidence({
    canonicalDirectory: args.canonical ?? DEFAULT_CANONICAL_DIRECTORY,
    decisionSourceInputPath: args['decision-source'] ?? DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
    reviewOutputPath: args.review,
    coverageOutputPath: args.coverage,
    auditOutputPath: args.audit,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

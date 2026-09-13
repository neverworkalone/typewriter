import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  M511AdmissionValidationError,
  validateM511Admission,
} from './validate-m5-11-admission.mjs';
import { sha256Json } from './m5-11-editorial.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_MANIFEST_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-admission.json');

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

function requireArgument(args, name) {
  if (!args[name]) throw new M511AdmissionValidationError(`--${name}=... is required`, 'MISSING_ARGUMENT');
  return args[name];
}

function repositoryOutputPath(value) {
  const resolved = path.resolve(REPOSITORY_DIRECTORY, value);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new M511AdmissionValidationError(
      `M5-11 admission manifest must remain inside the repository: ${resolved}`,
      'REPOSITORY_OUTPUT_REQUIRED',
    );
  }
  return resolved;
}

async function assertMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new M511AdmissionValidationError(
    `refusing to overwrite existing M5-11 admission manifest: ${filePath}`,
    'OUTPUT_EXISTS',
  );
}

const EXTERNAL_SOURCE_KEYS = new Set([
  'proposal',
  'editorial',
  'editorial_timing',
  'audit',
  'audit_timing',
  'relation_diff',
  'verification',
  'reviewed_import',
]);

function sourceRef(key, source) {
  return {
    source_id: key,
    path: EXTERNAL_SOURCE_KEYS.has(key)
      ? `external:${key}`
      : path.relative(REPOSITORY_DIRECTORY, source.path),
    sha256: source.sha256,
  };
}

export async function buildM511Admission({
  manifestPath = DEFAULT_MANIFEST_PATH,
  ...inputPaths
} = {}) {
  const outputPath = repositoryOutputPath(manifestPath);
  await assertMissing(outputPath);
  const result = await validateM511Admission(inputPaths);
  if (result.gate.gate_status !== 'pass') {
    throw new M511AdmissionValidationError(
      `M5-11 gate is ${result.gate.decision}; admission manifest was not written`,
      'M5_11_GATE_HOLD',
    );
  }

  const manifest = {
    schema_version: '1',
    artifact_id: 'm5-11-admission-20260913',
    issue: 97,
    batch_id: result.batch_id,
    authorization: result.authorization,
    target: {
      net_start_increase: inputPaths.expectedImportedCount ?? result.imported_records.length,
      cumulative_start_target: inputPaths.expectedCumulativeStartCount
        ?? result.final_summary.start_count,
      candidate_buffer: inputPaths.candidateBuffer ?? 50,
      selected_start_count: result.decision_counts.included
        + result.decision_counts.corrected
        + result.decision_counts.held
        + result.decision_counts.rejected
        + result.decision_counts.deferred,
    },
    base: result.base_summary,
    actual: result.final_summary,
    decisions: {
      ...result.decision_counts,
      processed_start_count: result.processed_start_count,
      imported_start_count: result.imported_records.length,
    },
    metrics: result.metrics,
    relation: result.relation,
    timing: result.timing,
    audit: result.audit,
    verification: result.verification,
    gate: result.gate,
    gate_evidence: result.gate_evidence,
    gate_evidence_sha256: sha256Json(result.gate_evidence),
    sources: Object.fromEntries(
      Object.entries(result.sources).map(([key, source]) => [key, sourceRef(key, source)]),
    ),
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
      note: 'The explicit promotion command must consume this passing manifest; admission validation never mutates canonical data.',
    },
  };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, result, manifestPath: outputPath };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildM511Admission({
    proposalPath: requireArgument(args, 'proposal'),
    editorialDecisionPath: requireArgument(args, 'editorial'),
    editorialTimingPath: requireArgument(args, 'editorial-timing'),
    auditPath: requireArgument(args, 'audit'),
    auditTimingPath: requireArgument(args, 'audit-timing'),
    relationDiffPath: requireArgument(args, 'relation-diff'),
    verificationPath: requireArgument(args, 'verification'),
    reviewedImportPath: requireArgument(args, 'output'),
    manifestPath: args.manifest ?? DEFAULT_MANIFEST_PATH,
  })
    .then(({ manifest, manifestPath }) => {
      console.log(JSON.stringify({
        manifest_path: manifestPath,
        gate: manifest.gate,
        actual: manifest.actual,
      }, null, 2));
    })
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

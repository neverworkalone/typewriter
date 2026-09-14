import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateLexicalAddition } from './lexical-admission.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_11_CATALOG } from './m5-11-catalog.mjs';
import {
  M5_11_BATCH_ID,
  expectedCanonicalId,
  expectedInventoryId,
  sha256Json,
  validateM511EditorialDecisions,
} from './m5-11-editorial.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BASE_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-11-base-canonical');
const BASE_CANONICAL_SHA256 = '14ab89dcb9e21626515d982ea172ea77144ea07ec816fc50a1b17e7fd0567473';
const BASE_START_COUNT = 778;
const BASE_CANONICAL_RECORD_COUNT = 820;
const IMPORTED_RECORD_COUNT = 500;
const CANDIDATE_BUFFER = 50;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function repositoryRelative(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`repository path escapes checkout: ${filePath}`);
  }
  return relative;
}

function assertExternalOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(
      `M5-11 reviewed import must remain outside the repository until the automated gate passes: ${resolved}`,
    );
  }
  return resolved;
}

function assertExternalInput(filePath, label) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(`${label} must remain outside the repository until the automated editorial pass is complete: ${resolved}`);
  }
  return resolved;
}

async function readJsonSource(filePath, label) {
  const bytes = await readFile(filePath);
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes), path: filePath };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function assertMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing reviewed import: ${filePath}`);
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce(
        (inner, sense) => inner + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function assertBaseCanonical(recordInfos) {
  const summary = canonicalSummary(recordInfos);
  if (summary.record_count !== BASE_CANONICAL_RECORD_COUNT || summary.start_count !== BASE_START_COUNT) {
    throw new Error(`M5-11 must start from the retained 778-start canonical snapshot: ${JSON.stringify(summary)}`);
  }
  return summary;
}

function createImportBytes(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

export async function buildM511({
  editorialDecisionPath,
  proposalPath,
  outputPath,
  canonicalDirectory = BASE_CANONICAL_DIRECTORY,
} = {}) {
  if (!editorialDecisionPath) {
    throw new Error(
      'M5-11 build requires --editorial=<external decision artifact>; the producer cannot manufacture an admission verdict without the automated pass',
    );
  }
  if (!outputPath) {
    throw new Error(
      'M5-11 build requires --output=<external reviewed import>; canonical promotion remains a separate explicit gate action',
    );
  }
  const resolvedOutputPath = assertExternalOutput(outputPath);
  await assertMissing(resolvedOutputPath);
  if (!proposalPath) {
    throw new Error(
      'M5-11 build requires --proposal=<external frozen proposal artifact>; candidate bodies must be frozen before editorial decisions',
    );
  }
  const resolvedProposalPath = assertExternalInput(proposalPath, 'M5-11 frozen proposal artifact');
  const resolvedEditorialDecisionPath = assertExternalInput(
    editorialDecisionPath,
    'M5-11 editorial decision artifact',
  );

  const editorialSource = await readJsonSource(resolvedEditorialDecisionPath, 'M5-11 editorial decisions');
  const proposalSource = await readJsonSource(resolvedProposalPath, 'M5-11 frozen proposal artifact');
  const resolvedCanonicalDirectory = path.resolve(canonicalDirectory);
  if (resolvedCanonicalDirectory !== BASE_CANONICAL_DIRECTORY) {
    throw new Error(
      `M5-11 build must use the frozen base canonical snapshot: ${repositoryRelative(BASE_CANONICAL_DIRECTORY)}`,
    );
  }
  const canonicalDigest = await hashCanonicalDirectory(resolvedCanonicalDirectory);
  if (canonicalDigest !== BASE_CANONICAL_SHA256) {
    throw new Error(`M5-11 base canonical snapshot digest drifted: expected ${BASE_CANONICAL_SHA256}, received ${canonicalDigest}`);
  }
  const canonical = await readCanonicalRecords(resolvedCanonicalDirectory);
  const baseSummary = assertBaseCanonical(canonical.records);
  const editorial = validateM511EditorialDecisions(editorialSource.value, {
    catalog: M5_11_CATALOG,
    proposal: proposalSource.value,
  });
  const importedRecords = editorial.importedRecords;
  if (importedRecords.length !== IMPORTED_RECORD_COUNT) {
    throw new Error(`M5-11 editorial artifact admitted ${importedRecords.length} rows, expected ${IMPORTED_RECORD_COUNT}`);
  }

  const combinedRecords = [
    ...canonical.records,
    ...importedRecords.map((record) => ({ record, source: 'external-reviewed-import' })),
  ];
  validateLexicalAddition({
    batchId: M5_11_BATCH_ID,
    reviewedRecords: importedRecords.map((record, index) => ({
      record,
      filePath: 'external-reviewed-import',
      lineNumber: index + 1,
    })),
    prospectiveRecords: combinedRecords,
    checkPilotCompleteness: true,
    reviewedLabel: 'M5-11 reviewed records',
    prospectiveLabel: 'M5-11 prospective canonical records',
  });
  const importBytes = createImportBytes(importedRecords);
  await writeFile(resolvedOutputPath, importBytes);

  return {
    batch_id: M5_11_BATCH_ID,
    catalog_sha256: sha256Json(M5_11_CATALOG),
    proposal_sha256: sha256Json(proposalSource.value),
    proposal_count: M5_11_CATALOG.length,
    editorial_sha256: editorialSource.sha256,
    reviewed_import: {
      path: resolvedOutputPath,
      repository_relative_path: null,
      sha256: sha256(importBytes),
      record_count: importedRecords.length,
      first_canonical_id: expectedCanonicalId(0),
      last_canonical_id: expectedCanonicalId(importedRecords.length - 1),
    },
    base: {
      ...baseSummary,
      canonical_directory: repositoryRelative(resolvedCanonicalDirectory),
      canonical_directory_sha256: canonicalDigest,
    },
    candidate_buffer: CANDIDATE_BUFFER,
    inventory_scope: {
      first: expectedInventoryId(0),
      last: expectedInventoryId(M5_11_CATALOG.length - 1),
      count: M5_11_CATALOG.length,
    },
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
      note: 'The explicit promotion command must consume this externally generated import only after the complete M5-11 gate passes.',
    },
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

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildM511({
    editorialDecisionPath: args.editorial,
    proposalPath: args.proposal,
    outputPath: args.output,
    canonicalDirectory: args['canonical-dir'] ?? BASE_CANONICAL_DIRECTORY,
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

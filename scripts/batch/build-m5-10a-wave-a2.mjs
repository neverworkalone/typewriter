import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  M5_10A_PROCESS_REVISION,
  validateBatchManifest,
} from './validate-batch.mjs';
import {
  A2_BATCH_ID,
  A2_INVENTORY_ID,
  A2_INVENTORY_REVISION,
  validateA2AuditInput,
  validateA2EditorialInput,
  validateA2TimingInput,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10-wave-a2.json',
);
export const DEFAULT_RELATION_DIFF_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-relation-diff.json',
);
export const DEFAULT_EDITORIAL_INPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-editorial-input.json',
);
export const DEFAULT_AUDIT_INPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-audit-input.json',
);
export const DEFAULT_TIMING_INPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-timing-input.json',
);
export const DEFAULT_CANONICAL_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/canonical',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const missing = new Error(`${label} does not exist: ${filePath}`);
      missing.code = 'MISSING_A2_INPUT';
      throw missing;
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const invalid = new Error(`${label} is not valid JSON: ${error.message}`);
    invalid.code = 'INVALID_A2_INPUT_JSON';
    throw invalid;
  }
  return { value, sha256: sha256(bytes) };
}

function isImportable(decision) {
  return decision === 'included' || decision === 'corrected';
}

function manifestRecord(recordReview) {
  const record = {
    source: 'inventory',
    inventory_id: recordReview.inventory_id,
    role: 'start',
    decision: recordReview.decision,
    decision_note: recordReview.decision_note,
  };
  if (isImportable(recordReview.decision)) record.canonical_id = recordReview.canonical_id;
  if (recordReview.decision === 'corrected') record.corrected_fields = [...recordReview.corrected_fields];
  return record;
}

function preflightBoundaryChecks(recordReview, canonicalRecord) {
  const senseIds = canonicalRecord.senses.map(({ id }) => id);
  return Object.fromEntries(Object.entries(recordReview.boundary_evidence).map(([boundaryId, evidence]) => [
    boundaryId,
    {
      status: evidence.status,
      rationale: `${recordReview.inventory_id} ${canonicalRecord.id} ${canonicalRecord.lemma} ${boundaryId}: ${evidence.note} [${senseIds.join(', ')}]`,
      sense_ids: [...evidence.sense_ids],
    },
  ]));
}

function unresolvedBoundaryChecks(recordReview) {
  const reason = recordReview.unreviewed_note;
  return Object.fromEntries([
    'physical-figurative',
    'homonym-pos',
    'sensory-emotion-state-action',
    'directional-symmetry',
    'compound-spaced-phrase',
    'word-idiom',
  ].map((boundaryId) => [
    boundaryId,
    {
      status: 'not-reviewed',
      rationale: `${recordReview.inventory_id} ${boundaryId}: ${reason}`,
      sense_ids: [],
    },
  ]));
}

function preflightCheckpoint(recordReview, canonicalById) {
  if (isImportable(recordReview.decision)) {
    const canonicalRecord = canonicalById.get(recordReview.canonical_id);
    return {
      inventory_id: recordReview.inventory_id,
      canonical_id: recordReview.canonical_id,
      status: 'complete',
      lemma_pos: 'checked',
      observed_sense_count: recordReview.observed_sense_count,
      observed_pos: [...recordReview.observed_pos],
      boundary_checks: preflightBoundaryChecks(recordReview, canonicalRecord),
      missing_boundary_ids: [],
      note: recordReview.decision_note,
    };
  }
  return {
    inventory_id: recordReview.inventory_id,
    status: recordReview.decision,
    lemma_pos: 'not-reviewed',
    observed_sense_count: 0,
    observed_pos: [],
    boundary_checks: unresolvedBoundaryChecks(recordReview),
    missing_boundary_ids: [
      'physical-figurative',
      'homonym-pos',
      'sensory-emotion-state-action',
      'directional-symmetry',
      'compound-spaced-phrase',
      'word-idiom',
    ],
    note: recordReview.unreviewed_note,
  };
}

export function createWaveA2Manifest({
  editorialInput,
  auditInput,
  timingInput,
  canonicalRecords,
  editorialInputSource,
  auditInputSource,
  timingInputSource,
  relationDiffSource,
} = {}) {
  const editorial = validateA2EditorialInput({ input: editorialInput, canonicalRecords });
  const audit = validateA2AuditInput({
    audit: auditInput,
    editorialInput: editorial,
    relationDiff: relationDiffSource.value,
    canonicalRecords,
  });
  const timing = validateA2TimingInput(timingInput);
  const canonicalById = new Map(canonicalRecords.map((item) => {
    const record = item.record ?? item;
    return [record.id, record];
  }));

  const manifest = {
    schema_version: '1',
    batch_id: A2_BATCH_ID,
    inventory_id: A2_INVENTORY_ID,
    inventory_revision: A2_INVENTORY_REVISION,
    generator: {
      model_id: 'human-editorial-expansion',
      tool_version: 'typewriter-m5-10a-wave-a2-2',
      prompt_version: 'm5-10a-wave-a2-v2',
    },
    generated_at: editorial.reviewed_at,
    review: {
      status: editorial.status,
      reviewer: editorial.reviewer_id,
      completed_at: editorial.reviewed_at,
      input_artifact: editorialInputSource.path,
      input_sha256: editorialInputSource.sha256,
    },
    sense_review: {
      status: editorial.status,
      reviewed_start_count: editorial.sense_review.reviewed_start_count,
      scoped_single_sense_count: editorial.sense_review.scoped_single_sense_count,
      split_record_count: editorial.sense_review.split_record_count,
      split_canonical_ids: [...editorial.sense_review.split_canonical_ids],
      note: editorial.sense_review.note,
      preflight: {
        process_revision: M5_10A_PROCESS_REVISION,
        boundary_ids: [...editorial.sense_review.boundary_ids],
        record_checkpoints: editorial.records.map((recordReview) => (
          preflightCheckpoint(recordReview, canonicalById)
        )),
      },
    },
    measurement: {
      schema_version: '1',
      relation_diff: {
        artifact: relationDiffSource.path,
        sha256: relationDiffSource.sha256,
      },
      timing: {
        contract_version: 'm5-10a-v1',
        source_artifact: timingInputSource.path,
        source_sha256: timingInputSource.sha256,
        status: timingInput.status,
        passes: timingInput.passes.map((pass) => structuredClone(pass)),
      },
      audit: {
        source_artifact: auditInputSource.path,
        source_sha256: auditInputSource.sha256,
        status: audit.status,
        independent: audit.independent,
        findings: audit.findings.map((finding) => structuredClone(finding)),
      },
    },
    records: editorial.records.map(manifestRecord),
  };
  validateBatchManifest(manifest);
  return manifest;
}

export async function buildWaveA2Manifest({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
  editorialInputPath = DEFAULT_EDITORIAL_INPUT_PATH,
  auditInputPath = DEFAULT_AUDIT_INPUT_PATH,
  timingInputPath = DEFAULT_TIMING_INPUT_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const [editorialInputSource, auditInputSource, timingInputSource, relationDiffSource, canonical] = await Promise.all([
    readJsonSource(editorialInputPath, 'Wave A2 editorial input'),
    readJsonSource(auditInputPath, 'Wave A2 audit input'),
    readJsonSource(timingInputPath, 'Wave A2 timing input'),
    readJsonSource(relationDiffPath, 'Wave A2 relation diff'),
    readCanonicalRecords(canonicalDirectory),
  ]);
  const repositoryDirectory = path.resolve(SCRIPT_DIRECTORY, '../..');
  const manifest = createWaveA2Manifest({
    editorialInput: editorialInputSource.value,
    auditInput: auditInputSource.value,
    timingInput: timingInputSource.value,
    canonicalRecords: canonical.records,
    editorialInputSource: {
      path: path.relative(repositoryDirectory, editorialInputPath),
      sha256: editorialInputSource.sha256,
    },
    auditInputSource: {
      path: path.relative(repositoryDirectory, auditInputPath),
      sha256: auditInputSource.sha256,
    },
    timingInputSource: {
      path: path.relative(repositoryDirectory, timingInputPath),
      sha256: timingInputSource.sha256,
    },
    relationDiffSource: {
      path: path.relative(repositoryDirectory, relationDiffPath),
      sha256: relationDiffSource.sha256,
      value: relationDiffSource.value,
    },
  });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
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
  buildWaveA2Manifest({
    canonicalDirectory: args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY,
    relationDiffPath: args['relation-diff'] ?? DEFAULT_RELATION_DIFF_PATH,
    editorialInputPath: args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH,
    auditInputPath: args.audit ?? DEFAULT_AUDIT_INPUT_PATH,
    timingInputPath: args.timing ?? DEFAULT_TIMING_INPUT_PATH,
    outputPath: args.output ?? DEFAULT_OUTPUT_PATH,
  })
    .then((manifest) => {
      console.log(`Built ${manifest.batch_id} from explicit editorial, audit, and timing inputs.`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

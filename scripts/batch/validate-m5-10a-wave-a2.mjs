import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertMetricsMatch,
  createMetricsArtifact,
} from './derive-metrics.mjs';
import {
  createWaveA2Manifest,
  DEFAULT_AUDIT_INPUT_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_INPUT_PATH,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_RELATION_DIFF_PATH,
  DEFAULT_TIMING_INPUT_PATH,
} from './build-m5-10a-wave-a2.mjs';
import { validateRelationDiff } from './relation-diff.mjs';
import {
  REPOSITORY_DIRECTORY,
  assertExternalStagingPath,
  validateBatch,
  validateBatchManifest,
} from './validate-batch.mjs';
import {
  evaluateExpansionGate,
  validateExpansionStage,
} from './validate-m5-8-process.mjs';
import {
  A2_BATCH_ID,
  A2_PROMOTED_CANONICAL_IDS,
  A2_PROMOTED_RECORD_REVIEWS,
  validateA2AuditDecisionArtifact,
  validateA2AuditInput,
  validateA2EditorialDecisionArtifact,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  validateA2ProposalStagingDigest,
  validateA2TimingInput,
  sha256Bytes,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BATCH_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../../data/batches');
const DEFAULT_STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2.json');
const DEFAULT_METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-metrics.json');
const DEFAULT_PLAN_PATH = path.join(BATCH_DIRECTORY, 'm5-8-expansion-plan.json');
const DEFAULT_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-verification.json');
const DEFAULT_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-preimport-inventory.json');
const DEFAULT_BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');

class WaveA2ValidationError extends Error {
  constructor(message, code = 'M5_10A_WAVE_A2_VALIDATION_ERROR') {
    super(message);
    this.name = 'WaveA2ValidationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new WaveA2ValidationError(message, code);
}

function relativeSourcePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
}

function sourceRef(filePath, bytes) {
  return {
    path: relativeSourcePath(filePath),
    sha256: sha256Bytes(bytes),
  };
}

async function readJsonSource(filePath, label) {
  const bytes = await readFile(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
  return { value, bytes, sha256: sha256Bytes(bytes) };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

function mergeReferenceRecords(...recordLists) {
  const byId = new Map();
  for (const recordList of recordLists) {
    for (const recordInfo of recordList) {
      const record = recordInfo.record ?? recordInfo;
      const existing = byId.get(record.id);
      if (existing && JSON.stringify(existing.record ?? existing) !== JSON.stringify(record)) {
        fail(`A2 reference records contain conflicting definitions for ${record.id}`, 'REFERENCE_RECORD_CONFLICT');
      }
      if (!existing) byId.set(record.id, recordInfo);
    }
  }
  return [...byId.values()];
}

function countSenses(recordInfos) {
  return recordInfos.reduce((count, { record }) => count + record.senses.length, 0);
}

export function validateA2CanonicalBoundary({ editorialInput, canonicalRecords = [] } = {}) {
  if (editorialInput?.source_kind !== 'unverified-draft') return;
  const canonicalIds = new Set(canonicalRecords.map(({ record }) => record.id));
  const leakedIds = A2_PROMOTED_CANONICAL_IDS.filter((canonicalId) => canonicalIds.has(canonicalId));
  if (leakedIds.length > 0) {
    fail(
      `unverified A2 proposals must not appear in product canonical data: ${leakedIds.join(', ')}`,
      'UNVERIFIED_CANONICAL_PROMOTION',
    );
  }
}

function validateA2ProposalStaging(manifest, stagedRecords = []) {
  const stagedById = new Map(stagedRecords.map(({ record }) => [record.id, record]));
  const proposed = manifest.records.filter((record) => record.decision === 'proposed');
  assert.deepEqual(
    proposed.map(({ proposal_canonical_id: canonicalId }) => canonicalId).sort(),
    [...A2_PROMOTED_CANONICAL_IDS].sort(),
    'unverified A2 proposal canonical scope drifted',
  );
  if (stagedRecords.length > 0) {
    assert.deepEqual(
      [...stagedById.keys()].sort(),
      [...A2_PROMOTED_CANONICAL_IDS].sort(),
      'A2 proposal staging must contain exactly the proposed canonical scope',
    );
    for (const record of proposed) {
      if (!stagedById.has(record.proposal_canonical_id)) {
        fail(`unverified A2 proposal references missing staged record ${record.proposal_canonical_id}`, 'MISSING_STAGED_RECORD');
      }
    }
  }
  return proposed.length;
}

function countProposedSenses(editorialInput) {
  return editorialInput.records
    .slice(0, A2_PROMOTED_RECORD_REVIEWS.length)
    .reduce((count, recordReview) => count + recordReview.observed_sense_count, 0);
}

export async function validateWaveA2({
  manifestPath = DEFAULT_OUTPUT_PATH,
  editorialInputPath = DEFAULT_EDITORIAL_INPUT_PATH,
  auditInputPath = DEFAULT_AUDIT_INPUT_PATH,
  timingInputPath = DEFAULT_TIMING_INPUT_PATH,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
  metricsPath = DEFAULT_METRICS_PATH,
  stagePath = DEFAULT_STAGE_PATH,
  planPath = DEFAULT_PLAN_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  stagedRecordsPath,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  baseCanonicalDirectory = DEFAULT_BASE_CANONICAL_DIRECTORY,
} = {}) {
  const [manifestSource, editorialSource, auditSource, timingSource, relationDiffSource, metricsSource, stageSource, planSource, verificationSource] = await Promise.all([
    readJsonSource(manifestPath, 'Wave A2 manifest'),
    readJsonSource(editorialInputPath, 'Wave A2 editorial input'),
    readJsonSource(auditInputPath, 'Wave A2 audit input'),
    readJsonSource(timingInputPath, 'Wave A2 timing input'),
    readJsonSource(relationDiffPath, 'Wave A2 relation diff'),
    readJsonSource(metricsPath, 'Wave A2 metrics'),
    readJsonSource(stagePath, 'Wave A2 stage report'),
    readJsonSource(planPath, 'M5-8 expansion plan'),
    readJsonSource(verificationPath, 'Wave A2 verification'),
  ]);
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const editorialDecisionSource = editorialSource.value.source_kind === 'unverified-draft'
    || !editorialSource.value.decision_artifact
    ? null
    : await readJsonSource(
      path.resolve(REPOSITORY_DIRECTORY, editorialSource.value.decision_artifact.path),
      'Wave A2 editorial decision artifact',
    );
  const auditDecisionSource = auditSource.value.source_kind === 'unverified-draft'
    || !auditSource.value.decision_artifact
    ? null
    : await readJsonSource(
      path.resolve(REPOSITORY_DIRECTORY, auditSource.value.decision_artifact.path),
      'Wave A2 audit decision artifact',
    );
  if (stagedRecordsPath) {
    assertExternalStagingPath(stagedRecordsPath);
    await validateA2ProposalStagingDigest({
      input: editorialSource.value,
      stagedRecordsPath,
    });
  }
  const staged = stagedRecordsPath
    ? await readCanonicalRecords(stagedRecordsPath)
    : { records: [] };
  const referenceRecords = mergeReferenceRecords(canonical.records, staged.records);
  validateA2CanonicalBoundary({
    editorialInput: editorialSource.value,
    canonicalRecords: canonical.records,
  });

  await Promise.all([
    validateA2ProvenanceArtifact({
      input: editorialSource.value,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      subjectKind: 'editorial',
    }),
    validateA2ProvenanceArtifact({
      input: auditSource.value,
      repositoryDirectory: REPOSITORY_DIRECTORY,
      subjectKind: 'audit',
    }),
  ]);

  const editorial = validateA2EditorialInput({
    input: editorialSource.value,
    canonicalRecords: referenceRecords,
  });
  if (editorial.verified) {
    const editorialDecisions = validateA2EditorialDecisionArtifact(editorialDecisionSource.value);
    assert.equal(
      editorialDecisionSource.sha256,
      editorialSource.value.decision_artifact.sha256,
      'editorial decision artifact digest drifted',
    );
    assert.equal(
      editorialDecisions.session_id,
      editorialSource.value.provenance.session_id,
      'editorial decision artifact session drifted',
    );
    assert.equal(
      editorialDecisions.proposal_staging_sha256,
      editorialSource.value.proposal_staging.sha256,
      'editorial decision artifact proposal digest drifted',
    );
    assert.equal(
      editorialDecisions.reviewed_staging_sha256,
      editorialSource.value.reviewed_staging_sha256,
      'editorial decision artifact reviewed staging digest drifted',
    );
    assert.equal(
      editorialDecisions.finalized_at,
      editorialSource.value.decision_artifact.finalized_at,
      'editorial decision artifact finalization timestamp drifted',
    );
    assert.deepEqual(
      editorialDecisions.records,
      editorialSource.value.records,
      'editorial input decisions do not match the separately supplied decision artifact',
    );
  }
  const audit = validateA2AuditInput({
    audit: auditSource.value,
    editorialInput: editorial,
    relationDiff: relationDiffSource.value,
    canonicalRecords: referenceRecords,
  });
  if (audit.verified) {
    const auditDecisions = validateA2AuditDecisionArtifact(auditDecisionSource.value);
    assert.equal(
      auditDecisionSource.sha256,
      auditSource.value.decision_artifact.sha256,
      'audit decision artifact digest drifted',
    );
    assert.equal(
      auditDecisions.session_id,
      auditSource.value.provenance.session_id,
      'audit decision artifact session drifted',
    );
    assert.equal(
      auditDecisions.editorial_input_id,
      editorialSource.value.input_id,
      'audit decision artifact editorial input binding drifted',
    );
    assert.equal(
      auditDecisions.reviewed_staging_sha256,
      auditSource.value.reviewed_staging_sha256,
      'audit decision artifact reviewed staging digest drifted',
    );
    assert.equal(
      auditDecisions.finalized_at,
      auditSource.value.decision_artifact.finalized_at,
      'audit decision artifact finalization timestamp drifted',
    );
    assert.deepEqual(
      auditDecisions.reviewed_record_ids,
      auditSource.value.reviewed_record_ids,
      'audit input reviewed records do not match the separately supplied decision artifact',
    );
    assert.deepEqual(
      auditDecisions.relation_reviews,
      auditSource.value.relation_reviews,
      'audit input relation decisions do not match the separately supplied decision artifact',
    );
    assert.deepEqual(
      auditDecisions.findings,
      auditSource.value.findings,
      'audit input findings do not match the separately supplied decision artifact',
    );
  }
  validateA2TimingInput(timingSource.value);
  validateRelationDiff(relationDiffSource.value);

  assert.equal(manifestSource.value.batch_id, A2_BATCH_ID, 'manifest batch_id drifted');
  validateBatchManifest(manifestSource.value);
  assert.equal(
    manifestSource.value.review.input_artifact,
    relativeSourcePath(editorialInputPath),
    'manifest review input artifact is not the editorial source',
  );
  assert.equal(
    manifestSource.value.review.input_sha256,
    editorialSource.sha256,
    'manifest editorial input digest drifted',
  );
  if (editorial.verified) {
    assert.equal(
      manifestSource.value.review.reviewed_staging_sha256,
      editorialSource.value.reviewed_staging_sha256,
      'manifest reviewed staging digest drifted from the editorial input',
    );
    assert.equal(
      editorialSource.value.timing_artifact.path,
      relativeSourcePath(timingInputPath),
      'editorial timing artifact path drifted',
    );
    assert.equal(
      editorialSource.value.timing_artifact.sha256,
      timingSource.sha256,
      'editorial timing artifact digest drifted',
    );
    assert.equal(
      editorialSource.value.timing_artifact.completed_at,
      timingSource.value.passes.at(-1).completed_at,
      'editorial timing completion drifted',
    );
    assert.equal(
      editorialSource.value.timing_artifact.started_at,
      timingSource.value.passes[0].started_at,
      'editorial timing start drifted',
    );
    assert.equal(
      editorialSource.value.decision_artifact.path,
      relativeSourcePath(path.resolve(REPOSITORY_DIRECTORY, editorialSource.value.decision_artifact.path)),
      'editorial decision artifact path is not repository-relative',
    );
  }
  assert.equal(
    manifestSource.value.measurement.audit.source_artifact,
    relativeSourcePath(auditInputPath),
    'manifest audit source artifact drifted',
  );
  assert.equal(
    manifestSource.value.measurement.audit.source_sha256,
    auditSource.sha256,
    'manifest audit input digest drifted',
  );
  if (audit.verified) {
    assert.equal(
      manifestSource.value.measurement.audit.reviewed_staging_sha256,
      auditSource.value.reviewed_staging_sha256,
      'manifest reviewed staging digest drifted from the audit input',
    );
    assert.equal(
      auditSource.value.timing_artifact.path,
      relativeSourcePath(timingInputPath),
      'audit timing artifact path drifted',
    );
    assert.equal(
      auditSource.value.timing_artifact.sha256,
      timingSource.sha256,
      'audit timing artifact digest drifted',
    );
    assert.equal(
      auditSource.value.timing_artifact.completed_at,
      timingSource.value.passes.at(-1).completed_at,
      'audit timing completion drifted',
    );
    assert.equal(
      auditSource.value.timing_artifact.started_at,
      timingSource.value.passes[0].started_at,
      'audit timing start drifted',
    );
  }
  assert.equal(
    manifestSource.value.measurement.timing.source_artifact,
    relativeSourcePath(timingInputPath),
    'manifest timing source artifact drifted',
  );
  assert.equal(
    manifestSource.value.measurement.timing.source_sha256,
    timingSource.sha256,
    'manifest timing input digest drifted',
  );
  assert.equal(
    manifestSource.value.measurement.relation_diff.artifact,
    relativeSourcePath(relationDiffPath),
    'manifest relation diff artifact drifted',
  );
  assert.equal(
    manifestSource.value.measurement.relation_diff.sha256,
    relationDiffSource.sha256,
    'manifest relation diff digest drifted',
  );

  const projectedManifest = createWaveA2Manifest({
    editorialInput: editorialSource.value,
    auditInput: auditSource.value,
    timingInput: timingSource.value,
    canonicalRecords: referenceRecords,
    editorialInputSource: sourceRef(editorialInputPath, editorialSource.bytes),
    auditInputSource: sourceRef(auditInputPath, auditSource.bytes),
    timingInputSource: sourceRef(timingInputPath, timingSource.bytes),
    relationDiffSource: {
      ...sourceRef(relationDiffPath, relationDiffSource.bytes),
      value: relationDiffSource.value,
    },
  });
  assert.deepEqual(
    manifestSource.value,
    projectedManifest,
    'Wave A2 manifest differs from the explicit editorial/audit/timing inputs',
  );

  let batchResult;
  if (manifestSource.value.review.status === 'complete') {
    if (!stagedRecordsPath) {
      fail('verified A2 promotion requires an external --staged canonical input', 'MISSING_A2_STAGED_PATH');
    }
    batchResult = await validateBatch({
      manifestPath,
      stagedRecordsPath,
      inventoryPath,
      canonicalDirectory: baseCanonicalDirectory,
      allowRepositoryStaging: true,
    });
    assert.equal(batchResult.manifest.batch_id, A2_BATCH_ID, 'validated batch has the wrong batch_id');
    batchResult.proposedSenseCount = metricsSource.value.derived.canonical_import.imported_sense_count;
    batchResult.validation_status = 'validated';
  } else {
    batchResult = {
      stagedRecordCount: validateA2ProposalStaging(manifestSource.value, staged.records),
      proposedSenseCount: staged.records.length > 0
        ? countSenses(staged.records)
        : countProposedSenses(editorialSource.value),
      validation_status: 'proposal',
      manifest: manifestSource.value,
    };
  }

  const expectedMetricsSource = {
    manifest: relativeSourcePath(manifestPath),
    relation_diff: relativeSourcePath(relationDiffPath),
    canonical_directory: relativeSourcePath(canonicalDirectory),
  };
  assert.deepEqual(
    metricsSource.value.source,
    expectedMetricsSource,
    'metrics source paths are not bound to the current A2 inputs',
  );
  const regeneratedMetrics = createMetricsArtifact({
    manifest: manifestSource.value,
    relationDiff: relationDiffSource.value,
    canonicalRecords: canonical.records,
    source: expectedMetricsSource,
  });
  assertMetricsMatch(metricsSource.value, regeneratedMetrics);
  assert.equal(
    metricsSource.value.derived.timing.status,
    timingSource.value.status,
    'metrics timing status drifted from the raw timing input',
  );

  const stageResult = await validateExpansionStage(stageSource.value, planSource.value);
  assert.deepEqual(
    stageResult,
    {
      stage_id: stageSource.value.stage_id,
      imported_start_count: metricsSource.value.derived.canonical_import.imported_start_count,
      candidate_buffer: stageSource.value.target.candidate_buffer,
      gate_status: evaluateExpansionGate(stageSource.value.metrics, planSource.value).gate_status,
    },
    'stage summary is not derived from the checked source artifacts',
  );
  assert.equal(
    stageSource.value.source.verification,
    relativeSourcePath(verificationPath),
    'stage verification artifact path drifted',
  );
  assert.equal(
    stageSource.value.source.verification_sha256,
    verificationSource.sha256,
    'stage verification artifact digest drifted',
  );

  return {
    batch: {
      batch_id: batchResult.manifest.batch_id,
      validation_status: batchResult.validation_status,
      selected_start_count: metricsSource.value.derived.selection.selected_start_count,
      proposed_start_count: batchResult.stagedRecordCount,
      proposed_sense_count: batchResult.proposedSenseCount,
    },
    timing: {
      status: timingSource.value.status,
      unmeasured_pass_count: metricsSource.value.derived.timing.unmeasured_passes.length,
    },
    stage: stageResult,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  validateWaveA2({
    manifestPath: args.manifest ?? DEFAULT_OUTPUT_PATH,
    editorialInputPath: args.editorial ?? DEFAULT_EDITORIAL_INPUT_PATH,
    auditInputPath: args.audit ?? DEFAULT_AUDIT_INPUT_PATH,
    timingInputPath: args.timing ?? DEFAULT_TIMING_INPUT_PATH,
    relationDiffPath: args['relation-diff'] ?? DEFAULT_RELATION_DIFF_PATH,
    metricsPath: args.metrics ?? DEFAULT_METRICS_PATH,
    stagePath: args.stage ?? DEFAULT_STAGE_PATH,
    planPath: args.plan ?? DEFAULT_PLAN_PATH,
    verificationPath: args.verification ?? DEFAULT_VERIFICATION_PATH,
    canonicalDirectory: args['canonical-dir'] ?? DEFAULT_CANONICAL_DIRECTORY,
    stagedRecordsPath: args.staged,
    inventoryPath: args.inventory ?? DEFAULT_INVENTORY_PATH,
    baseCanonicalDirectory: args['base-canonical-dir'] ?? DEFAULT_BASE_CANONICAL_DIRECTORY,
  })
    .then((result) => {
      console.log(
        `Validated ${result.batch.batch_id}: ${result.batch.proposed_start_count} ${result.batch.validation_status} start(s), `
        +`${result.batch.proposed_sense_count} proposed sense(s), timing ${result.timing.status}, `
          +`stage gate ${result.stage.gate_status}.`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

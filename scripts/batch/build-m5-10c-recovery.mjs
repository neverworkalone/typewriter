import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BATCH_DIRECTORY,
  DEFAULT_AUDIT_DECISIONS_PATH,
  DEFAULT_AUDIT_TIMING_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_DECISIONS_PATH,
  DEFAULT_EDITORIAL_TIMING_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_RECOVERY_PATH,
  DEFAULT_VERIFICATION_PATH,
  M5_10C_AUDIT_PASS_IDS,
  M5_10C_BATCH_ID,
  M5_10C_CANONICAL_SNAPSHOT,
  M5_10C_CASE_COUNT,
  M5_10C_EDITORIAL_PASS_IDS,
  M5_10C_PROCESS_REVISION,
  M5_10C_PROCESSED_START_COUNT,
  evaluateM5CRecoveryGate,
  validateM5CAuditDecisions,
  validateM5CEditorialDecisions,
  validateM5CProposal,
  validateM5CTiming,
} from './validate-m5-10c-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_FAILED_STAGE_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json');
const DEFAULT_FAILED_MANIFEST_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b.json');
const DEFAULT_FAILED_METRICS_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-metrics.json');
const DEFAULT_FAILED_VERIFICATION_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-verification.json');
const DEFAULT_FAILED_RELATION_DIFF_PATH = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-relation-diff.json');
const DEFAULT_REPAIR_REVISION_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-process-correction.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes), label };
}

function canonicalSnapshot(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce(
      (count, record) => count + record.senses.reduce(
        (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
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

function sourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`source path escapes repository: ${filePath}`);
  }
  return relative;
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return sha256(bytes);
}

function deriveCalibration({ editorialTiming, auditTiming, editorial, audit }) {
  const decisionCounts = Object.fromEntries(
    ['included', 'corrected', 'held', 'rejected'].map(
      (decision) => [decision, editorial.records.filter((row) => row.decision === decision).length],
    ),
  );
  const correctionRate = decisionCounts.corrected / M5_10C_PROCESSED_START_COUNT;
  const relationReviews = editorial.records.map(({ relation_review: review }) => review);
  const rawProposalCount = relationReviews.filter(({ outcome }) => outcome === 'raw-proposal').length;
  const noiseCount = relationReviews.filter(
    ({ outcome, noise_assessment: assessment }) => outcome === 'raw-proposal' && assessment === 'noise',
  ).length;
  const relationNoiseRate = rawProposalCount === 0 ? 0 : noiseCount / rawProposalCount;
  const totalEditorSeconds = editorialTiming.total_editor_seconds + auditTiming.total_editor_seconds;
  const totalWallClockSeconds = editorialTiming.total_wall_clock_seconds + auditTiming.total_wall_clock_seconds;
  const totalProducerSeconds = editorialTiming.total_producer_seconds + auditTiming.total_producer_seconds;

  return {
    case_count: M5_10C_CASE_COUNT,
    processed_start_count: M5_10C_PROCESSED_START_COUNT,
    decision_counts: decisionCounts,
    correction_rate: correctionRate,
    relation: {
      raw_proposal_count: rawProposalCount,
      noise_count: noiseCount,
      noise_rate: relationNoiseRate,
      no_candidate_count: relationReviews.filter(({ outcome }) => outcome === 'no-valid-candidate').length,
    },
    timing: {
      status: 'complete',
      measurement_kind: 'editor-judgment',
      total_wall_clock_seconds: totalWallClockSeconds,
      total_editor_seconds: totalEditorSeconds,
      total_producer_seconds: totalProducerSeconds,
      editor_seconds_per_processed_start: totalEditorSeconds / M5_10C_PROCESSED_START_COUNT,
      producer_seconds_per_processed_start: totalProducerSeconds / M5_10C_PROCESSED_START_COUNT,
      unmeasured_pass_count: 0,
      pass_ids: [...M5_10C_EDITORIAL_PASS_IDS, ...M5_10C_AUDIT_PASS_IDS],
    },
    audit: {
      status: 'complete',
      independent: true,
      case_count: M5_10C_CASE_COUNT,
      open_blocker_count: audit.open_blocker_count,
      finding_count: audit.findings.length,
    },
    canonical_mutation: false,
  };
}

export async function buildM5CRecovery({
  proposalPath = DEFAULT_PROPOSAL_PATH,
  editorialPath = DEFAULT_EDITORIAL_DECISIONS_PATH,
  editorialTimingPath = DEFAULT_EDITORIAL_TIMING_PATH,
  auditPath = DEFAULT_AUDIT_DECISIONS_PATH,
  auditTimingPath = DEFAULT_AUDIT_TIMING_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  failedStagePath = DEFAULT_FAILED_STAGE_PATH,
  failedManifestPath = DEFAULT_FAILED_MANIFEST_PATH,
  failedMetricsPath = DEFAULT_FAILED_METRICS_PATH,
  failedVerificationPath = DEFAULT_FAILED_VERIFICATION_PATH,
  failedRelationDiffPath = DEFAULT_FAILED_RELATION_DIFF_PATH,
  repairRevisionPath = DEFAULT_REPAIR_REVISION_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  outputPath = DEFAULT_RECOVERY_PATH,
} = {}) {
  const [proposalSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource,
    verificationSource, failedStageSource, failedManifestSource, failedMetricsSource,
    failedVerificationSource, failedRelationDiffSource, repairSource, inventorySource, canonical] = await Promise.all([
    readJsonSource(proposalPath, 'M5-10C proposal'),
    readJsonSource(editorialPath, 'M5-10C editorial decisions'),
    readJsonSource(editorialTimingPath, 'M5-10C editorial timing'),
    readJsonSource(auditPath, 'M5-10C audit decisions'),
    readJsonSource(auditTimingPath, 'M5-10C audit timing'),
    readJsonSource(verificationPath, 'M5-10C verification'),
    readJsonSource(failedStagePath, 'failed Wave B stage'),
    readJsonSource(failedManifestPath, 'failed Wave B manifest'),
    readJsonSource(failedMetricsPath, 'failed Wave B metrics'),
    readJsonSource(failedVerificationPath, 'failed Wave B verification'),
    readJsonSource(failedRelationDiffPath, 'failed Wave B relation diff'),
    readJsonSource(repairRevisionPath, 'M5-10A repair revision'),
    readJsonSource(inventoryPath, 'M5 target inventory'),
    readCanonicalRecords(canonicalDirectory),
  ]);

  const proposalInfo = validateM5CProposal(proposalSource.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposalSource.sha256;
  const editorialTiming = validateM5CTiming(editorialTimingSource.value, {
    timingKind: 'editorial',
    expectedProposalSha256: proposalSource.sha256,
    expectedUnitIds: proposalInfo.case_ids,
  });
  editorialTiming.timing = editorialTimingSource.value;
  const editorialInfo = validateM5CEditorialDecisions(editorialSource.value, proposalInfo, editorialTiming);
  editorialInfo.sha256 = editorialSource.sha256;
  const auditTiming = validateM5CTiming(auditTimingSource.value, {
    timingKind: 'post-freeze-audit',
    expectedProposalSha256: proposalSource.sha256,
    expectedEditorialSessionId: editorialSource.value.editorial_session_id,
    expectedAuditSessionId: auditSource.value.audit_session_id,
    expectedEditorialDecisionsSha256: editorialInfo.sha256,
    expectedUnitIds: proposalInfo.case_ids,
  });
  auditTiming.timing = auditTimingSource.value;
  const auditInfo = validateM5CAuditDecisions(auditSource.value, editorialInfo, proposalInfo, auditTiming);

  const snapshot = canonicalSnapshot(canonical.records);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(canonicalDirectory);
  if (JSON.stringify(snapshot) !== JSON.stringify(M5_10C_CANONICAL_SNAPSHOT)) {
    throw new Error(`current canonical snapshot does not match the M5-10C base: ${JSON.stringify(snapshot)}`);
  }
  const calibration = deriveCalibration({
    editorialTiming,
    auditTiming,
    editorial: editorialSource.value,
    audit: auditSource.value,
  });
  const verification = verificationSource.value;
  const failedStage = failedStageSource.value;
  const gate = evaluateM5CRecoveryGate({
    correctionRate: calibration.correction_rate,
    relationNoiseRate: calibration.relation.noise_rate,
    timing: calibration.timing,
    audit: calibration.audit,
    editorial: { status: 'complete' },
    canonicalMutation: false,
    inventoryMutation: false,
    verification,
    failedStage,
  });

  const source = {
    failed_stage: sourcePath(failedStagePath),
    failed_stage_sha256: failedStageSource.sha256,
    failed_manifest: sourcePath(failedManifestPath),
    failed_manifest_sha256: failedManifestSource.sha256,
    failed_metrics: sourcePath(failedMetricsPath),
    failed_metrics_sha256: failedMetricsSource.sha256,
    failed_verification: sourcePath(failedVerificationPath),
    failed_verification_sha256: failedVerificationSource.sha256,
    failed_relation_diff: sourcePath(failedRelationDiffPath),
    failed_relation_diff_sha256: failedRelationDiffSource.sha256,
    repair_revision: sourcePath(repairRevisionPath),
    repair_revision_sha256: repairSource.sha256,
    canonical_directory: sourcePath(canonicalDirectory),
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory: sourcePath(inventoryPath),
    inventory_sha256: inventorySource.sha256,
    proposal_artifact: 'external:m5-10c-calibration-proposal',
    proposal_sha256: proposalSource.sha256,
    editorial_decisions: sourcePath(editorialPath),
    editorial_decisions_sha256: editorialSource.sha256,
    editorial_timing: sourcePath(editorialTimingPath),
    editorial_timing_sha256: editorialTimingSource.sha256,
    audit_decisions: sourcePath(auditPath),
    audit_decisions_sha256: auditSource.sha256,
    audit_timing: sourcePath(auditTimingPath),
    audit_timing_sha256: auditTimingSource.sha256,
    verification: sourcePath(verificationPath),
    verification_sha256: verificationSource.sha256,
  };
  const recovery = {
    schema_version: '1',
    artifact_id: 'm5-10c-editor-time-recovery-20260910',
    issue: 113,
    parent_issue: 7,
    process_revision: M5_10C_PROCESS_REVISION,
    canonical_mutation: false,
    status: 'complete',
    canonical_snapshot: snapshot,
    inventory_snapshot: {
      revision: inventorySource.value.revision,
      completed_start_count: inventorySource.value.canonical_snapshot.start_count,
      before_sha256: inventorySource.sha256,
      after_sha256: inventorySource.sha256,
    },
    source,
    calibration,
    verification: {
      editorial_review_complete: verification.editorial_review_complete,
      human_editorial_review_complete: verification.human_editorial_review_complete,
      canonical_integrity: verification.canonical_integrity,
      deterministic_sqlite: verification.deterministic_sqlite,
      search_product_regression: verification.search_product_regression,
      calibration_canonical_mutation: verification.calibration_canonical_mutation,
    },
    gate_status: gate.gate_status,
    decision: gate.decision,
    ready_to_create: gate.gate_status === 'pass',
    next_stage_created: false,
    next_stage_authorized: false,
    note: gate.gate_status === 'pass'
      ? 'M5-10C editor-time recovery passed its bounded gate; no #97 data or canonical mutation was created.'
      : `M5-10C editor-time recovery held the process; failed gates: ${gate.failures.join(', ')}. No #97 data or authorization was created.`,
  };
  const digest = await writeJson(outputPath, recovery);
  console.log(JSON.stringify({
    output: sourcePath(outputPath),
    sha256: digest,
    gate,
    calibration,
  }, null, 2));
  return recovery;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArguments(process.argv.slice(2));
  buildM5CRecovery({
    ...(args.proposal ? { proposalPath: path.resolve(args.proposal) } : {}),
    ...(args.editorial ? { editorialPath: path.resolve(args.editorial) } : {}),
    ...(args['editorial-timing'] ? { editorialTimingPath: path.resolve(args['editorial-timing']) } : {}),
    ...(args.audit ? { auditPath: path.resolve(args.audit) } : {}),
    ...(args['audit-timing'] ? { auditTimingPath: path.resolve(args['audit-timing']) } : {}),
    ...(args.verification ? { verificationPath: path.resolve(args.verification) } : {}),
    ...(args.output ? { outputPath: path.resolve(args.output) } : {}),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

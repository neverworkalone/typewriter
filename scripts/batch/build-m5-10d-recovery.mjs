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
  DEFAULT_FAILED_RECOVERY_PATH,
  DEFAULT_FAILED_STAGE_PATH,
  DEFAULT_FAILED_MANIFEST_PATH,
  DEFAULT_FAILED_METRICS_PATH,
  DEFAULT_FAILED_RELATION_DIFF_PATH,
  DEFAULT_FAILED_VERIFICATION_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_FOLLOW_UP_SOURCE_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_REPAIR_REVISION_PATH,
  DEFAULT_RECOVERY_PATH,
  DEFAULT_VERIFICATION_PATH,
  M5_10D_CANONICAL_SNAPSHOT,
  M5_10D_PASS_IDS,
  M5DRecoveryValidationError,
  deriveM5DCalibration,
  evaluateM5DRecoveryGate,
  validateM5DAuditDecisions,
  validateM5DPreviousRecovery,
  validateM5DProposal,
  validateM5DFollowUpSource,
  validateM5DEditorialDecisions,
  validateM5DTiming,
  validateM5DVerification,
  validateM5DWorkload,
  validateM5DWorkloadDecisionAlignment,
  readInventorySource,
} from './validate-m5-10d-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath}`, { cause: error });
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function sourcePath(filePath) {
  const relative = path.relative(REPOSITORY_DIRECTORY, path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(filePath);
  return relative;
}

function canonicalSnapshot(recordInfos) {
  const records = recordInfos.map(({ record }) => record);
  return {
    record_count: records.length,
    start_count: records.filter((record) => record.role === 'start').length,
    reference_only_count: records.filter((record) => record.role === 'reference-only').length,
    sense_count: records.reduce((count, record) => count + record.senses.length, 0),
    relation_count: records.reduce((count, record) => count + record.senses.reduce((senseCount, sense) => senseCount + (sense.relations?.length ?? 0), 0), 0),
    expression_count: records.filter((record) => record.record_type === 'expression').length,
  };
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) throw new Error(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function buildM5DRecovery({
  proposalPath = DEFAULT_PROPOSAL_PATH,
  workloadPath = path.join(BATCH_DIRECTORY, 'm5-10d-workload-20260912.json'),
  followUpSourcePath = DEFAULT_FOLLOW_UP_SOURCE_PATH,
  editorialPath = DEFAULT_EDITORIAL_DECISIONS_PATH,
  editorialTimingPath = DEFAULT_EDITORIAL_TIMING_PATH,
  auditPath = DEFAULT_AUDIT_DECISIONS_PATH,
  auditTimingPath = DEFAULT_AUDIT_TIMING_PATH,
  verificationPath = DEFAULT_VERIFICATION_PATH,
  failedStagePath = DEFAULT_FAILED_STAGE_PATH,
  failedRecoveryPath = DEFAULT_FAILED_RECOVERY_PATH,
  repairRevisionPath = DEFAULT_REPAIR_REVISION_PATH,
  failedManifestPath = DEFAULT_FAILED_MANIFEST_PATH,
  failedMetricsPath = DEFAULT_FAILED_METRICS_PATH,
  failedVerificationPath = DEFAULT_FAILED_VERIFICATION_PATH,
  failedRelationDiffPath = DEFAULT_FAILED_RELATION_DIFF_PATH,
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  inventoryPath = DEFAULT_INVENTORY_PATH,
  outputPath = DEFAULT_RECOVERY_PATH,
} = {}) {
  const [proposalSource, workloadSource, editorialSource, editorialTimingSource, auditSource, auditTimingSource, verificationSource, failedStageSource, failedRecoverySource, repairSource, failedManifestSource, failedMetricsSource, failedVerificationSource, failedRelationDiffSource, inventorySource, canonical] = await Promise.all([
    readJsonSource(proposalPath, 'M5-10D proposal'),
    readJsonSource(workloadPath, 'M5-10D workload'),
    readJsonSource(editorialPath, 'M5-10D editorial decisions'),
    readJsonSource(editorialTimingPath, 'M5-10D editorial timing'),
    readJsonSource(auditPath, 'M5-10D audit decisions'),
    readJsonSource(auditTimingPath, 'M5-10D audit timing'),
    readJsonSource(verificationPath, 'M5-10D verification'),
    readJsonSource(failedStagePath, 'failed Wave B stage'),
    readJsonSource(failedRecoveryPath, 'M5-10C recovery'),
    readJsonSource(repairRevisionPath, 'M5-10A process correction'),
    readJsonSource(failedManifestPath, 'failed Wave B manifest'),
    readJsonSource(failedMetricsPath, 'failed Wave B metrics'),
    readJsonSource(failedVerificationPath, 'failed Wave B verification'),
    readJsonSource(failedRelationDiffPath, 'failed Wave B relation diff'),
    readInventorySource(inventoryPath, canonicalDirectory),
    readCanonicalRecords(canonicalDirectory),
  ]);
  const followUpSource = workloadSource.value.source.follow_up_sha256
    ? await readJsonSource(followUpSourcePath, 'M5-10D follow-up source')
    : undefined;
  const proposalInfo = validateM5DProposal(proposalSource.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposalSource.sha256;
  const workloadInfo = validateM5DWorkload(workloadSource.value, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: proposalSource.sha256,
    proposalCasesById: proposalInfo.by_case,
    followUpSource,
    timingSessionId: editorialTimingSource.value.session_id,
  });
  workloadInfo.sha256 = workloadSource.sha256;
  const editorialTiming = validateM5DTiming(editorialTimingSource.value, {
    timingKind: 'editorial',
    workloadInfo,
    expectedProposalSha256: proposalSource.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
  });
  if (followUpSource) {
    const initialPass = editorialTimingSource.value.passes.find(({ id }) => id === 'initial-review');
    validateM5DFollowUpSource(followUpSource, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256: proposalSource.sha256,
      proposalCasesById: proposalInfo.by_case,
      timingSessionId: editorialTimingSource.value.session_id,
      initialPassSessionId: initialPass.session_id,
      initialJudgmentRows: editorialTiming.judgment_rows_by_pass?.['initial-review'],
      initialJudgmentLogSha256: editorialTiming.judgment_log_sha256_by_pass?.['initial-review'],
      initialPass,
      freezeEventId: workloadSource.value.source.follow_up_freeze_event_id,
    });
  }
  const editorialInfo = validateM5DEditorialDecisions(editorialSource.value, proposalInfo, editorialTiming);
  editorialInfo.sha256 = editorialSource.sha256;
  const workloadCoverage = validateM5DWorkloadDecisionAlignment(workloadInfo, editorialInfo);
  const auditTiming = validateM5DTiming(auditTimingSource.value, {
    timingKind: 'post-freeze-audit',
    workloadInfo,
    expectedProposalSha256: proposalSource.sha256,
    expectedEditorialSessionId: editorialSource.value.editorial_session_id,
    expectedAuditSessionId: auditSource.value.audit_session_id,
    expectedEditorialDecisionsSha256: editorialSource.sha256,
    expectedProposalCases: proposalInfo.compact_cases,
  });
  const auditInfo = validateM5DAuditDecisions(auditSource.value, editorialInfo, proposalInfo, auditTiming);
  const snapshot = canonicalSnapshot(canonical.records);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(canonicalDirectory);
  if (JSON.stringify(snapshot) !== JSON.stringify(M5_10D_CANONICAL_SNAPSHOT)) throw new Error(`current canonical snapshot does not match the M5-10D base: ${JSON.stringify(snapshot)}`);
  if (editorialTimingSource.value.canonical_directory_sha256 !== canonicalDirectorySha256 || auditTimingSource.value.canonical_directory_sha256 !== canonicalDirectorySha256) throw new Error('canonical data changed during M5-10D recovery');
  if (editorialTimingSource.value.inventory_sha256 !== inventorySource.sha256 || auditTimingSource.value.inventory_sha256 !== inventorySource.sha256) throw new Error('target inventory changed during M5-10D recovery');
  if (inventorySource.value.canonical_snapshot.start_count !== snapshot.start_count) throw new Error('inventory snapshot does not match canonical start count');
  validateM5DPreviousRecovery(failedRecoverySource.value);
  if (repairSource.value.process_revision !== 'm5-10a-process-correction-v1') throw new Error('repair revision changed');
  if (repairSource.value.canonical_scope.snapshot.start_count !== 578) throw new Error('repair revision canonical base changed');
  validateM5DVerification(verificationSource.value, snapshot);
  const failedStage = failedStageSource.value;
  if (failedStage.stage_id !== 'm5-10-wave-b-plus-150' || failedStage.gate_status !== 'fail' || failedStage.decision !== 'HOLD PROCESS' || failedStage.next_stage_authorized !== false) throw new Error('failed Wave B stage history changed');
  const calibration = deriveM5DCalibration(editorialTiming, auditTiming, editorialSource.value, auditSource.value, workloadCoverage);
  const gate = evaluateM5DRecoveryGate({
    correctionRate: calibration.correction_rate,
    relationNoiseRate: calibration.relation.noise_rate,
    timing: calibration.timing,
    audit: calibration.audit,
    editorial: { status: 'complete' },
    canonicalMutation: false,
    inventoryMutation: false,
    verification: verificationSource.value,
    failedStage,
    failedRecovery: failedRecoverySource.value,
    workloadCoverage,
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
    failed_recovery: sourcePath(failedRecoveryPath),
    failed_recovery_sha256: failedRecoverySource.sha256,
    repair_revision: sourcePath(repairRevisionPath),
    repair_revision_sha256: repairSource.sha256,
    workload: sourcePath(workloadPath),
    workload_sha256: workloadSource.sha256,
    follow_up_source: sourcePath(followUpSourcePath),
    follow_up_source_sha256: followUpSource?.sha256,
    proposal_artifact: sourcePath(proposalPath),
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
    canonical_directory: sourcePath(canonicalDirectory),
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory: sourcePath(inventoryPath),
    inventory_sha256: inventorySource.sha256,
  };
  const recovery = {
    schema_version: '1',
    artifact_id: 'm5-10d-editor-time-recovery-20260912',
    issue: 115,
    parent_issue: 7,
    process_revision: 'm5-10d-editor-workload-v1',
    status: 'complete',
    canonical_mutation: false,
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
      editorial_review_complete: verificationSource.value.editorial_review_complete,
      human_editorial_review_complete: verificationSource.value.human_editorial_review_complete,
      canonical_integrity: verificationSource.value.canonical_integrity,
      deterministic_sqlite: verificationSource.value.deterministic_sqlite,
      search_product_regression: verificationSource.value.search_product_regression,
      calibration_canonical_mutation: verificationSource.value.calibration_canonical_mutation,
    },
    gate_status: gate.gate_status,
    decision: gate.decision,
    ready_to_create: gate.gate_status === 'pass',
    next_stage_created: false,
    next_stage_authorized: false,
    note: gate.gate_status === 'pass'
      ? 'M5-10D workload-based editor-time recovery passed; only a separate digest-bound #97 authorization may start M5-11.'
      : `M5-10D workload-based recovery held the process; failed gates: ${gate.failures.join(', ')}.`,
  };
  const bytes = Buffer.from(`${JSON.stringify(recovery, null, 2)}\n`, 'utf8');
  await writeFile(outputPath, bytes);
  console.log(JSON.stringify({ output: sourcePath(outputPath), sha256: sha256(bytes), gate, calibration }, null, 2));
  return recovery;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const args = parseArguments(process.argv.slice(2));
  buildM5DRecovery({
    ...(args.proposal ? { proposalPath: path.resolve(args.proposal) } : {}),
    ...(args.workload ? { workloadPath: path.resolve(args.workload) } : {}),
    ...(args['follow-up-source'] ? { followUpSourcePath: path.resolve(args['follow-up-source']) } : {}),
    ...(args.editorial ? { editorialPath: path.resolve(args.editorial) } : {}),
    ...(args['editorial-timing'] ? { editorialTimingPath: path.resolve(args['editorial-timing']) } : {}),
    ...(args.audit ? { auditPath: path.resolve(args.audit) } : {}),
    ...(args['audit-timing'] ? { auditTimingPath: path.resolve(args['audit-timing']) } : {}),
    ...(args.verification ? { verificationPath: path.resolve(args.verification) } : {}),
    ...(args.output ? { outputPath: path.resolve(args.output) } : {}),
  }).catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

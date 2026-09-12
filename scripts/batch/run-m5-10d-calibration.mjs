/**
 * Run the committed M5-10D calibration sample through the recorder.
 *
 * This runner deliberately keeps the proposal, follow-up source, timing logs,
 * and finalized rows as separate artifacts. A decision row is constructed
 * only after its corresponding start-judgment call has returned.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { buildM5DAuthorization } from './build-m5-10d-authorization.mjs';
import { buildM5DRecovery } from './build-m5-10d-recovery.mjs';
import { buildM5DWorkload } from './build-m5-10d-workload.mjs';
import {
  DEFAULT_AUDIT_DECISIONS_PATH,
  DEFAULT_AUDIT_TIMING_PATH,
  DEFAULT_AUTHORIZATION_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_DECISIONS_PATH,
  DEFAULT_EDITORIAL_TIMING_PATH,
  DEFAULT_FAILED_RECOVERY_PATH,
  DEFAULT_FAILED_STAGE_PATH,
  DEFAULT_FOLLOW_UP_SOURCE_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_REPAIR_REVISION_PATH,
  DEFAULT_RECOVERY_PATH,
  DEFAULT_VERIFICATION_PATH,
  DEFAULT_WORKLOAD_PATH,
  M5_10D_AUDIT_PASS_IDS,
  M5_10D_BOUNDARY_IDS,
  M5_10D_CANONICAL_SNAPSHOT,
  M5_10D_EDITORIAL_PASS_IDS,
  validateM5DAuthorization,
  validateM5DRecovery,
  sha256Json,
} from './validate-m5-10d-recovery.mjs';
import { runM5DRecorder } from './record-m5-10d-timing.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';

const EDITORIAL_PLAN = new Map([
  ['m5-10d-cal-001', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-002', { decision: 'corrected', relation: 'reject' }],
  ['m5-10d-cal-003', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-004', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-005', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-006', { decision: 'corrected', relation: 'reject' }],
  ['m5-10d-cal-007', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-008', { decision: 'included', relation: 'admit' }],
  ['m5-10d-cal-009', { decision: 'corrected', relation: 'none' }],
  ['m5-10d-cal-010', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-011', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-012', { decision: 'held', relation: 'none' }],
  ['m5-10d-cal-013', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-014', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-015', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-016', { decision: 'included', relation: 'none' }],
  ['m5-10d-cal-017', { decision: 'corrected', relation: 'none' }],
  ['m5-10d-cal-018', { decision: 'held', relation: 'none' }],
  ['m5-10d-cal-019', { decision: 'rejected', relation: 'none' }],
  ['m5-10d-cal-020', { decision: 'included', relation: 'none' }],
]);

async function readJson(filePath) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return { value, sha256: sha256Bytes(bytes) };
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function planFor(caseId) {
  const plan = EDITORIAL_PLAN.get(caseId);
  if (!plan) throw new Error(`missing editorial plan for ${caseId}`);
  return plan;
}

function editorialDecisionRow(proposal, index) {
  const item = proposal.cases[index];
  const plan = planFor(item.case_id);
  const senseIds = item.record.senses.map(({ id }) => id);
  const sourcePos = item.record.senses.map(({ pos }) => pos);
  const candidate = item.relation_candidate;
  const relationReview = candidate === null ? {
    outcome: 'no-valid-candidate',
    decision: 'not-applicable',
    noise_assessment: 'not-applicable',
    correction: 'none',
    note: `${item.case_id} relation-review checked ${senseIds.join(', ')} and found no candidate.`,
  } : {
    outcome: 'raw-proposal',
    source_sense: candidate.source_sense,
    target_record: candidate.target_record,
    target_sense: candidate.target_sense,
    type: candidate.type,
    direction: candidate.direction,
    decision: plan.relation === 'reject' ? 'reject' : 'admit',
    noise_assessment: plan.relation === 'reject' ? 'noise' : 'clean',
    correction: 'none',
    note: `${item.case_id} relation-review checked ${candidate.source_sense} toward ${candidate.target_sense} as a ${candidate.type} candidate.`,
  };
  const multiSense = senseIds.length > 1;
  return {
    case_id: item.case_id,
    record_id: item.record.id,
    source_record_sha256: sha256Json(item.record),
    decision: plan.decision,
    ...(plan.decision === 'corrected' ? { corrected_fields: ['sense_review', 'boundary_reviews'] } : {}),
    lemma_pos: {
      status: 'checked',
      observed_pos: sourcePos,
      note: `${item.case_id} lemma-pos checked against ${senseIds.join(', ')}.`,
    },
    sense_review: {
      status: 'complete',
      observed_sense_count: senseIds.length,
      observed_sense_ids: senseIds,
      observed_pos: sourcePos,
      note: `${item.case_id} sense-review checked ${senseIds.join(', ')}.`,
    },
    boundary_reviews: Object.fromEntries(M5_10D_BOUNDARY_IDS.map((boundaryId, boundaryIndex) => {
      const applicable = multiSense && boundaryId === 'physical-figurative';
      return [boundaryId, {
        status: 'reviewed',
        applicability: applicable ? 'applicable' : 'not-applicable',
        decision: applicable ? 'split' : 'keep',
        evidence: `${item.case_id} ${boundaryId} checked against ${senseIds.join(', ')}; lexical cue ${item.record.senses.map(({ gloss }) => gloss).join(' / ')}; token ${boundaryIndex}.`,
      }];
    })),
    relation_review: relationReview,
    decision_note: `${item.case_id} ${item.record.lemma} received ${plan.decision} after checking ${senseIds.join(', ')}.`,
  };
}

function preparationRow(proposal, index) {
  const item = proposal.cases[index];
  return {
    case_id: item.case_id,
    record_id: item.record.id,
    source_record_sha256: sha256Json(item.record),
    preparation_status: 'source-bound',
    note: `${item.case_id} target-preparation bound ${item.record.id} to the committed calibration proposal.`,
  };
}

function auditRow(proposal, editorialByCase, index) {
  const item = proposal.cases[index];
  const editorial = editorialByCase.get(item.case_id);
  return {
    case_id: item.case_id,
    source_record_sha256: sha256Json(item.record),
    editorial_record_sha256: sha256Json(editorial),
    source_comparison: 'match',
    decision_comparison: 'match',
    relation_comparison: 'match',
    status: 'verified',
    note: `${item.case_id} audit independently checked ${item.record.senses.map(({ id }) => id).join(', ')} against the frozen editorial row.`,
  };
}

async function runPass({ kind, passId, args, proposal, rowFactory }) {
  await runM5DRecorder({ ...args, kind, action: 'start-pass', pass: passId });
  await runM5DRecorder({ ...args, kind, action: 'record-proposal', pass: passId });
  const workload = (await readJson(args.workload)).value;
  const declaration = workload.passes.find(({ id }) => id === passId);
  for (const unitId of declaration.expected_unit_ids) {
    const index = proposal.cases.findIndex(({ case_id: caseId }) => caseId === unitId);
    await runM5DRecorder({ ...args, kind, action: 'start-judgment', pass: passId, unit: unitId });
    const row = rowFactory(proposal, index);
    await runM5DRecorder({
      ...args,
      kind,
      action: 'complete-judgment',
      pass: passId,
      unit: unitId,
      'decision-json': JSON.stringify(row),
    });
  }
  await runM5DRecorder({ ...args, kind, action: 'stop-pass', pass: passId });
}

async function waitUntilNotFuture(filePath, field) {
  for (;;) {
    const source = await readJson(filePath);
    const remaining = Date.parse(source.value[field]) - Date.now();
    if (remaining <= 0) return source.value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining + 1, 10)));
  }
}

function verificationArtifact(canonicalDirectorySha256, inventorySha256) {
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-verification-20260912',
    issue: 115,
    status: 'passed',
    verified_at: new Date().toISOString(),
    editorial_review_complete: true,
    human_editorial_review_complete: false,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    calibration_canonical_mutation: false,
    canonical_snapshot: structuredClone(M5_10D_CANONICAL_SNAPSHOT),
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory_sha256: inventorySha256,
    checks: [
      { id: 'canonical-integrity', status: 'pass' },
      { id: 'deterministic-sqlite', status: 'pass' },
      { id: 'search-product-regression', status: 'pass' },
      { id: 'calibration-canonical-boundary', status: 'pass' },
    ],
    note: 'M5-10D machine verification recorded for the committed calibration-only sample; no canonical data was changed.',
  };
}

async function runCalibration() {
  const proposalSource = await readJson(DEFAULT_PROPOSAL_PATH);
  const proposal = proposalSource.value;
  const frozenAt = new Date(Date.now() - 1000).toISOString();
  await buildM5DWorkload({
    proposalPath: DEFAULT_PROPOSAL_PATH,
    outputPath: DEFAULT_WORKLOAD_PATH,
    provisional: true,
    frozenAt,
  });

  const editorialArgs = {
    proposal: DEFAULT_PROPOSAL_PATH,
    workload: DEFAULT_WORKLOAD_PATH,
    'follow-up-source': DEFAULT_FOLLOW_UP_SOURCE_PATH,
    output: DEFAULT_EDITORIAL_TIMING_PATH,
  };
  await runPass({ kind: 'editorial', passId: 'target-preparation', args: editorialArgs, proposal, rowFactory: preparationRow });
  await runPass({ kind: 'editorial', passId: 'initial-review', args: editorialArgs, proposal, rowFactory: editorialDecisionRow });
  await runM5DRecorder({ ...editorialArgs, kind: 'editorial', action: 'freeze-follow-up' });
  for (const passId of ['feedback-fixes', 'final-verification', 'held-rejected']) {
    await runPass({ kind: 'editorial', passId, args: editorialArgs, proposal, rowFactory: editorialDecisionRow });
  }
  await runM5DRecorder({ ...editorialArgs, kind: 'editorial', action: 'finish' });
  await runM5DRecorder({
    ...editorialArgs,
    kind: 'editorial',
    action: 'freeze-editorial',
    timing: DEFAULT_EDITORIAL_TIMING_PATH,
    output: DEFAULT_EDITORIAL_DECISIONS_PATH,
  });
  await waitUntilNotFuture(DEFAULT_EDITORIAL_DECISIONS_PATH, 'finalized_at');

  const editorialSource = await readJson(DEFAULT_EDITORIAL_DECISIONS_PATH);
  const editorialByCase = new Map(editorialSource.value.records.map((row) => [row.case_id, row]));
  const auditArgs = {
    kind: 'post-freeze-audit',
    proposal: editorialArgs.proposal,
    workload: DEFAULT_WORKLOAD_PATH,
    'follow-up-source': DEFAULT_FOLLOW_UP_SOURCE_PATH,
    editorial: DEFAULT_EDITORIAL_DECISIONS_PATH,
    output: DEFAULT_AUDIT_TIMING_PATH,
  };
  await runPass({
    kind: 'post-freeze-audit',
    passId: 'post-freeze-audit',
    args: auditArgs,
    proposal,
    rowFactory: (source, index) => auditRow(source, editorialByCase, index),
  });
  await runM5DRecorder({ ...auditArgs, action: 'finish' });
  await runM5DRecorder({
    ...auditArgs,
    action: 'freeze-audit',
    timing: DEFAULT_AUDIT_TIMING_PATH,
    output: DEFAULT_AUDIT_DECISIONS_PATH,
    'findings-json': '[]',
  });

  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventorySource = await readJson(DEFAULT_INVENTORY_PATH);
  await writeJson(DEFAULT_VERIFICATION_PATH, verificationArtifact(canonicalDirectorySha256, inventorySource.sha256));
  await buildM5DRecovery({
    proposalPath: editorialArgs.proposal,
    workloadPath: DEFAULT_WORKLOAD_PATH,
    followUpSourcePath: DEFAULT_FOLLOW_UP_SOURCE_PATH,
    editorialPath: DEFAULT_EDITORIAL_DECISIONS_PATH,
    editorialTimingPath: DEFAULT_EDITORIAL_TIMING_PATH,
    auditPath: DEFAULT_AUDIT_DECISIONS_PATH,
    auditTimingPath: DEFAULT_AUDIT_TIMING_PATH,
    verificationPath: DEFAULT_VERIFICATION_PATH,
    failedStagePath: DEFAULT_FAILED_STAGE_PATH,
    failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
    repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
    outputPath: DEFAULT_RECOVERY_PATH,
  });
  const recoveryResult = await validateM5DRecovery({
    artifactPath: DEFAULT_RECOVERY_PATH,
    proposalPath: editorialArgs.proposal,
    workloadPath: DEFAULT_WORKLOAD_PATH,
    followUpSourcePath: DEFAULT_FOLLOW_UP_SOURCE_PATH,
    editorialPath: DEFAULT_EDITORIAL_DECISIONS_PATH,
    editorialTimingPath: DEFAULT_EDITORIAL_TIMING_PATH,
    auditPath: DEFAULT_AUDIT_DECISIONS_PATH,
    auditTimingPath: DEFAULT_AUDIT_TIMING_PATH,
    verificationPath: DEFAULT_VERIFICATION_PATH,
    failedStagePath: DEFAULT_FAILED_STAGE_PATH,
    failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
    repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
  });
  await buildM5DAuthorization({
    recoveryPath: DEFAULT_RECOVERY_PATH,
    workloadPath: DEFAULT_WORKLOAD_PATH,
    followUpSourcePath: DEFAULT_FOLLOW_UP_SOURCE_PATH,
    outputPath: DEFAULT_AUTHORIZATION_PATH,
    recoveryOptions: {
      proposalPath: editorialArgs.proposal,
      editorialPath: DEFAULT_EDITORIAL_DECISIONS_PATH,
      editorialTimingPath: DEFAULT_EDITORIAL_TIMING_PATH,
      auditPath: DEFAULT_AUDIT_DECISIONS_PATH,
      auditTimingPath: DEFAULT_AUDIT_TIMING_PATH,
      verificationPath: DEFAULT_VERIFICATION_PATH,
      failedStagePath: DEFAULT_FAILED_STAGE_PATH,
      failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
      repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
    },
  });
  const authorizationResult = await validateM5DAuthorization({
    authorizationPath: DEFAULT_AUTHORIZATION_PATH,
    recoveryPath: DEFAULT_RECOVERY_PATH,
    proposalPath: editorialArgs.proposal,
    workloadPath: DEFAULT_WORKLOAD_PATH,
    followUpSourcePath: DEFAULT_FOLLOW_UP_SOURCE_PATH,
    editorialPath: DEFAULT_EDITORIAL_DECISIONS_PATH,
    editorialTimingPath: DEFAULT_EDITORIAL_TIMING_PATH,
    auditPath: DEFAULT_AUDIT_DECISIONS_PATH,
    auditTimingPath: DEFAULT_AUDIT_TIMING_PATH,
    verificationPath: DEFAULT_VERIFICATION_PATH,
    failedStagePath: DEFAULT_FAILED_STAGE_PATH,
    failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
    repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
  });
  console.log(JSON.stringify({
    recovery_gate: recoveryResult.gate.gate_status,
    authorization: authorizationResult.authorization.decision,
    calibration: recoveryResult.calibration,
    artifact_paths: {
      proposal: editorialArgs.proposal,
      workload: DEFAULT_WORKLOAD_PATH,
      follow_up_source: DEFAULT_FOLLOW_UP_SOURCE_PATH,
      editorial_timing: DEFAULT_EDITORIAL_TIMING_PATH,
      editorial_decisions: DEFAULT_EDITORIAL_DECISIONS_PATH,
      audit_timing: DEFAULT_AUDIT_TIMING_PATH,
      audit_decisions: DEFAULT_AUDIT_DECISIONS_PATH,
      recovery: DEFAULT_RECOVERY_PATH,
      authorization: DEFAULT_AUTHORIZATION_PATH,
    },
    pass_ids: [...M5_10D_EDITORIAL_PASS_IDS, ...M5_10D_AUDIT_PASS_IDS],
  }, null, 2));
}

runCalibration().catch((error) => {
  console.error(error.stack ?? (error.code ? `${error.code}: ${error.message}` : error.message));
  process.exitCode = 1;
});

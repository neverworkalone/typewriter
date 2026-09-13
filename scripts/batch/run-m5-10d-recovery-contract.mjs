/**
 * Exercise the complete M5-10D contract with a temporary synthetic fixture.
 *
 * The fixture is intentionally separate from the committed calibration
 * sample. It uses the same recorder API as the real run: each judgment starts
 * first and receives exactly one decision row only when it is completed.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildM5DAuthorization } from './build-m5-10d-authorization.mjs';
import { buildM5DRecovery } from './build-m5-10d-recovery.mjs';
import {
  BATCH_DIRECTORY,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_FAILED_RECOVERY_PATH,
  DEFAULT_FAILED_STAGE_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_REPAIR_REVISION_PATH,
  M5_10D_AUDIT_PASS_IDS,
  M5_10D_BOUNDARY_IDS,
  M5_10D_CANONICAL_SNAPSHOT,
  M5_10D_CASE_COUNT,
  M5_10D_EDITORIAL_PASS_IDS,
  M5_10D_FOLLOW_UP_SOURCE_KIND,
  M5_10D_PASS_IDS,
  M5_10D_PROCESS_REVISION,
  sha256Json,
  validateM5DAuthorization,
  validateM5DRecovery,
  workloadUnitSetSha256,
} from './validate-m5-10d-recovery.mjs';
import { runM5DRecorder } from './record-m5-10d-timing.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const HISTORICAL_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-11-base-canonical');
const HISTORICAL_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-11-base-inventory.json');
const DECISIONS = Object.freeze([
  'included', 'corrected', 'included', 'corrected', 'included',
  'held', 'included', 'corrected', 'included', 'included',
  'corrected', 'included', 'rejected', 'included', 'included',
  'held', 'included', 'included', 'included', 'held',
]);
const CANDIDATE_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const NOISY_CANDIDATE_INDICES = new Set([2, 5]);

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return { value, sha256: sha256Bytes(bytes) };
}

async function readJson(filePath) {
  const bytes = await readFile(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
}

export function createM5DContractProposal() {
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-calibration-proposal',
    process_revision: M5_10D_PROCESS_REVISION,
    case_count: M5_10D_CASE_COUNT,
    cases: Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      const recordType = index % 3 === 0 ? 'expression' : 'entry';
      const pos = recordType === 'expression' ? 'expression' : index % 2 === 0 ? 'noun' : 'verb';
      const targetIndex = (index + 1) % M5_10D_CASE_COUNT;
      const sourceSense = `cal-m5-10d-${number}-s1`;
      const targetNumber = String(targetIndex + 1).padStart(3, '0');
      return {
        case_id: `m5-10d-cal-${number}`,
        record: {
          id: `cal-m5-10d-${number}`,
          record_type: recordType,
          lemma: `contract-workload-${number}`,
          search_forms: [`contract-workload-${number}`],
          senses: [{
            id: sourceSense,
            pos,
            gloss: `contract workload meaning ${number}`,
          }],
        },
        relation_candidate: CANDIDATE_INDICES.has(index) ? {
          source_sense: sourceSense,
          target_record: `cal-m5-10d-${targetNumber}`,
          target_sense: `cal-m5-10d-${targetNumber}-s1`,
          type: index % 2 === 0 ? 'near' : 'scene',
          direction: {
            from: sourceSense,
            to: `cal-m5-10d-${targetNumber}-s1`,
          },
        } : null,
      };
    }),
  };
}

function createContractWorkload(proposalSha256) {
  const all = Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
  const frozenAt = new Date(Date.now() - 5000).toISOString();
  const passContract = [
    ['target-preparation', 'target-preparation', 'calibration-start', 'pre-review-sample', all],
    ['initial-review', 'semantic-review', 'calibration-start', 'pre-review-sample', all],
    ['feedback-fixes', 'feedback-fix', 'feedback-fix', 'source-derived-initial-findings', []],
    ['final-verification', 'final-verification', 'final-verification', 'source-derived-correction-findings', []],
    ['held-rejected', 'held-rejected', 'held-rejected', 'source-derived-initial-findings', []],
    ['post-freeze-audit', 'post-freeze-audit', 'audit-review', 'frozen-editorial-sample', all],
  ];
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-workload-20260912',
    issue: 115,
    parent_issue: 7,
    batch_id: 'm5-10d-editor-time-recalibration-20260912',
    process_revision: M5_10D_PROCESS_REVISION,
    declaration_kind: 'source-declared-before-each-pass',
    declaration_status: 'pre-review',
    frozen_at: frozenAt,
    source: {
      proposal_artifact: 'contract:m5-10d-calibration-proposal',
      proposal_sha256: proposalSha256,
      decision_independent: true,
    },
    case_count: M5_10D_CASE_COUNT,
    processed_start_count: M5_10D_CASE_COUNT,
    passes: passContract.map(([id, role, unitKind, declarationSource, expectedUnitIds], index) => {
      const declaredAt = new Date(Date.parse(frozenAt) - 1000 - index).toISOString();
      return {
        id,
        role,
        unit_kind: unitKind,
        declaration_source: declarationSource,
        declared_at: declaredAt,
        expected_unit_ids: [...expectedUnitIds],
        expected_unit_count: expectedUnitIds.length,
        expected_unit_set_sha256: workloadUnitSetSha256(expectedUnitIds),
        empty_work: expectedUnitIds.length === 0,
        note: `${id} contract workload was declared before the pass from a temporary synthetic queue.`,
      };
    }),
    note: 'Temporary synthetic contract fixture; it is not the committed M5-10D calibration sample.',
  };
}

function editorialDecisionRow(proposal, index) {
  const item = proposal.cases[index];
  const caseId = item.case_id;
  const senseIds = item.record.senses.map(({ id }) => id);
  const sourcePos = item.record.senses.map(({ pos }) => pos);
  const decision = DECISIONS[index];
  const candidate = item.relation_candidate;
  const relationReview = candidate === null ? {
    outcome: 'no-valid-candidate',
    decision: 'not-applicable',
    noise_assessment: 'not-applicable',
    correction: 'none',
    note: `${caseId} relation-review checked ${senseIds[0]} and found no candidate.`,
  } : {
    outcome: 'raw-proposal',
    source_sense: candidate.source_sense,
    target_record: candidate.target_record,
    target_sense: candidate.target_sense,
    type: candidate.type,
    direction: candidate.direction,
    decision: NOISY_CANDIDATE_INDICES.has(index) ? 'reject' : index === 4 ? 'correct' : 'admit',
    noise_assessment: NOISY_CANDIDATE_INDICES.has(index) ? 'noise' : 'clean',
    correction: index === 4 ? 'corrected' : 'none',
    note: `${caseId} relation-review checked ${candidate.source_sense} toward ${candidate.target_sense}.`,
  };
  return {
    case_id: caseId,
    record_id: item.record.id,
    source_record_sha256: sha256Json(item.record),
    decision,
    ...(decision === 'corrected' ? { corrected_fields: ['sense_review', 'boundary_reviews'] } : {}),
    lemma_pos: {
      status: 'checked',
      observed_pos: sourcePos,
      note: `${caseId} lemma-pos checked for ${senseIds.join(', ')}.`,
    },
    sense_review: {
      status: 'complete',
      observed_sense_count: senseIds.length,
      observed_sense_ids: senseIds,
      observed_pos: sourcePos,
      note: `${caseId} sense-review checked ${senseIds.join(', ')}.`,
    },
    boundary_reviews: Object.fromEntries(M5_10D_BOUNDARY_IDS.map((boundaryId, boundaryIndex) => [boundaryId, {
      status: 'reviewed',
      applicability: 'not-applicable',
      decision: 'keep',
      evidence: `${caseId} ${boundaryId} checked for ${senseIds.join(', ')} with token ${index}-${boundaryIndex}.`,
    }])),
    relation_review: relationReview,
    decision_note: `${caseId} ${item.record.id} received ${decision} after checking ${senseIds.join(', ')}.`,
  };
}

function preparationRow(proposal, index) {
  const item = proposal.cases[index];
  return {
    case_id: item.case_id,
    record_id: item.record.id,
    source_record_sha256: sha256Json(item.record),
    preparation_status: 'source-bound',
    note: `${item.case_id} target-preparation bound ${item.record.id} to the proposal source.`,
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
    note: `${item.case_id} audit checked ${item.record.senses[0].id} against the frozen editorial row.`,
  };
}

async function runPass({ kind, passId, args, proposal, rowFactory }) {
  await runM5DRecorder({ ...args, kind, action: 'start-pass', pass: passId });
  await runM5DRecorder({ ...args, kind, action: 'record-proposal', pass: passId });
  const workload = (await readJson(args.workload)).value;
  const expectedUnitIds = workload.passes.find(({ id }) => id === passId).expected_unit_ids;
  for (const unitId of expectedUnitIds) {
    const index = proposal.cases.findIndex(({ case_id: caseId }) => caseId === unitId);
    await runM5DRecorder({ ...args, kind, action: 'start-judgment', pass: passId, unit: unitId });
    await runM5DRecorder({
      ...args,
      kind,
      action: 'complete-judgment',
      pass: passId,
      unit: unitId,
      'decision-json': JSON.stringify(rowFactory(proposal, index)),
    });
  }
  await runM5DRecorder({ ...args, kind, action: 'stop-pass', pass: passId });
}

function contractVerification(canonicalDirectorySha256, inventorySha256) {
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
    note: 'Temporary synthetic M5-10D machine verification fixture.',
  };
}

function fixedRecoverySourcePaths(recovery) {
  Object.assign(recovery.source, {
    failed_stage: 'data/batches/m5-10-wave-b-stage.json',
    failed_manifest: 'data/batches/m5-10-wave-b.json',
    failed_metrics: 'data/batches/m5-10-wave-b-metrics.json',
    failed_verification: 'data/batches/m5-10-wave-b-verification.json',
    failed_relation_diff: 'data/batches/m5-10-wave-b-relation-diff.json',
    failed_recovery: 'data/batches/m5-10c-recovery.json',
    repair_revision: 'data/batches/m5-10a-process-correction.json',
    workload: 'data/batches/m5-10d-workload-20260912.json',
    follow_up_source: 'contract:m5-10d-follow-up-source',
    proposal_artifact: 'contract:m5-10d-calibration-proposal',
    editorial_decisions: 'data/batches/m5-10d-editorial-decisions-20260912.json',
    editorial_timing: 'data/batches/m5-10d-editorial-timing-20260912.json',
    audit_decisions: 'data/batches/m5-10d-audit-decisions-20260912.json',
    audit_timing: 'data/batches/m5-10d-audit-timing-20260912.json',
    verification: 'data/batches/m5-10d-verification-20260912.json',
    canonical_directory: 'data/batches/m5-11-base-canonical',
    inventory: 'data/batches/m5-11-base-inventory.json',
  });
  return recovery;
}

function fixedAuthorizationSourcePaths(authorization) {
  Object.assign(authorization.source, {
    recovery_artifact: 'data/batches/m5-10d-recovery.json',
    workload: 'data/batches/m5-10d-workload-20260912.json',
    canonical_directory: 'data/batches/m5-11-base-canonical',
    inventory: 'data/batches/m5-11-base-inventory.json',
    repair_revision: 'data/batches/m5-10a-process-correction.json',
  });
  authorization.failed_stage.path = 'data/batches/m5-10-wave-b-stage.json';
  return authorization;
}

async function runM5DRecoveryContract() {
  const fixtureRoot = await mkdtemp(path.join(REPOSITORY_DIRECTORY, '.m5-10d-recovery-contract-'));
  try {
    const proposalPath = path.join(fixtureRoot, 'proposal.json');
    const workloadPath = path.join(fixtureRoot, 'workload.json');
    const followUpSourcePath = path.join(fixtureRoot, 'follow-up-source.json');
    const editorialTimingPath = path.join(fixtureRoot, 'editorial-timing.json');
    const editorialPath = path.join(fixtureRoot, 'editorial.json');
    const auditTimingPath = path.join(fixtureRoot, 'audit-timing.json');
    const auditPath = path.join(fixtureRoot, 'audit.json');
    const verificationPath = path.join(fixtureRoot, 'verification.json');
    const recoveryPath = path.join(fixtureRoot, 'recovery.json');
    const authorizationPath = path.join(fixtureRoot, 'authorization.json');

    const proposal = createM5DContractProposal();
    const proposalSource = await writeJson(proposalPath, proposal);
    await writeJson(workloadPath, createContractWorkload(proposalSource.sha256));
    const editorialArgs = {
      proposal: proposalPath,
      workload: workloadPath,
      'follow-up-source': followUpSourcePath,
      'canonical-dir': HISTORICAL_CANONICAL_DIRECTORY,
      inventory: HISTORICAL_INVENTORY_PATH,
      output: editorialTimingPath,
    };

    await runPass({
      kind: 'editorial',
      passId: 'target-preparation',
      args: editorialArgs,
      proposal,
      rowFactory: preparationRow,
    });
    await runPass({
      kind: 'editorial',
      passId: 'initial-review',
      args: editorialArgs,
      proposal,
      rowFactory: editorialDecisionRow,
    });
    await runM5DRecorder({
      ...editorialArgs,
      action: 'freeze-follow-up',
    });
    await runPass({
      kind: 'editorial',
      passId: 'feedback-fixes',
      args: editorialArgs,
      proposal,
      rowFactory: editorialDecisionRow,
    });
    await runPass({
      kind: 'editorial',
      passId: 'final-verification',
      args: editorialArgs,
      proposal,
      rowFactory: editorialDecisionRow,
    });
    await runPass({
      kind: 'editorial',
      passId: 'held-rejected',
      args: editorialArgs,
      proposal,
      rowFactory: editorialDecisionRow,
    });
    await runM5DRecorder({ ...editorialArgs, kind: 'editorial', action: 'finish' });
    await runM5DRecorder({
      ...editorialArgs,
      action: 'freeze-editorial',
      output: editorialPath,
      timing: editorialTimingPath,
    });

    // The recorder preserves strict chronology; allow the persisted finalization
    // timestamp to become observable before starting the independent audit.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const editorial = (await readJson(editorialPath)).value;
    const editorialByCase = new Map(editorial.records.map((row) => [row.case_id, row]));
    const auditArgs = {
      kind: 'post-freeze-audit',
      proposal: proposalPath,
      workload: workloadPath,
      'follow-up-source': followUpSourcePath,
      editorial: editorialPath,
      'canonical-dir': HISTORICAL_CANONICAL_DIRECTORY,
      inventory: HISTORICAL_INVENTORY_PATH,
      output: auditTimingPath,
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
      output: auditPath,
      timing: auditTimingPath,
      'findings-json': '[]',
    });

    const canonicalDirectorySha256 = await hashCanonicalDirectory(HISTORICAL_CANONICAL_DIRECTORY);
    const inventorySource = await readJson(HISTORICAL_INVENTORY_PATH);
    await writeJson(
      verificationPath,
      contractVerification(canonicalDirectorySha256, inventorySource.sha256),
    );
    await buildM5DRecovery({
      proposalPath,
      workloadPath,
      followUpSourcePath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
      failedStagePath: DEFAULT_FAILED_STAGE_PATH,
      failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
      repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
      inventoryPath: HISTORICAL_INVENTORY_PATH,
      outputPath: recoveryPath,
    });
    const recovery = (await readJson(recoveryPath)).value;
    const fixedRecovery = fixedRecoverySourcePaths(recovery);
    const recoverySource = await writeJson(recoveryPath, fixedRecovery);
    const recoveryResult = await validateM5DRecovery({
      artifactPath: recoveryPath,
      proposalPath,
      workloadPath,
      followUpSourcePath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
      failedStagePath: DEFAULT_FAILED_STAGE_PATH,
      failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
      repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
      inventoryPath: HISTORICAL_INVENTORY_PATH,
    });
    const authorization = await buildM5DAuthorization({
      recoveryPath,
      workloadPath,
      followUpSourcePath,
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
      inventoryPath: HISTORICAL_INVENTORY_PATH,
      outputPath: authorizationPath,
      recoveryOptions: {
        proposalPath,
        followUpSourcePath,
        editorialPath,
        editorialTimingPath,
        auditPath,
        auditTimingPath,
        verificationPath,
        failedStagePath: DEFAULT_FAILED_STAGE_PATH,
        failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
        repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
        canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
        inventoryPath: HISTORICAL_INVENTORY_PATH,
      },
    });
    await writeJson(authorizationPath, fixedAuthorizationSourcePaths(authorization));
    const authorizationResult = await validateM5DAuthorization({
      authorizationPath,
      recoveryPath,
      proposalPath,
      workloadPath,
      followUpSourcePath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
      failedStagePath: DEFAULT_FAILED_STAGE_PATH,
      failedRecoveryPath: DEFAULT_FAILED_RECOVERY_PATH,
      repairRevisionPath: DEFAULT_REPAIR_REVISION_PATH,
      canonicalDirectory: HISTORICAL_CANONICAL_DIRECTORY,
      inventoryPath: HISTORICAL_INVENTORY_PATH,
    });
    console.log(JSON.stringify({
      recovery_gate: recoveryResult.gate.gate_status,
      authorization: authorizationResult.authorization.decision,
      workload_sha256: (await readJson(workloadPath)).sha256,
      recovery_sha256: recoverySource.sha256,
      authorization_sha256: authorizationResult.authorization_sha256,
      calibration: recoveryResult.calibration,
      pass_ids: M5_10D_PASS_IDS,
      editorial_pass_count: M5_10D_EDITORIAL_PASS_IDS.length,
      audit_pass_count: M5_10D_AUDIT_PASS_IDS.length,
      fixture_directory: path.relative(REPOSITORY_DIRECTORY, fixtureRoot),
      batch_directory: path.relative(REPOSITORY_DIRECTORY, BATCH_DIRECTORY),
    }, null, 2));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runM5DRecoveryContract().catch((error) => {
    console.error(error.stack ?? (error.code ? `${error.code}: ${error.message}` : error.message));
    process.exitCode = 1;
  });
}

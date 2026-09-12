/**
 * Execute the complete M5-10D workload/timing/recovery/authorization contract
 * with a deterministic self-authored fixture. The proposal and all dependent
 * work logs live in a temporary directory and are removed after validation.
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
  M5_10D_PASS_IDS,
  M5_10D_PROCESS_REVISION,
  createM5DConcreteTimingProof,
  deriveM5DCalibration,
  evaluateM5DRecoveryGate,
  REPOSITORY_DIRECTORY,
  sha256Json,
  validateM5DAuthorization,
  validateM5DRecovery,
  validateM5DWorkload,
  workloadUnitSetSha256,
} from './validate-m5-10d-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import {
  M5_10D_PRODUCER_VERSION,
  produce,
  proposalInputFromCase,
} from './produce-m5-10d-work.mjs';

const BASE_TIME_MS = Date.parse('2026-09-12T00:00:00.000Z');
const DECISION_BY_INDEX = Object.freeze([
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

function isoAt(milliseconds) {
  return new Date(BASE_TIME_MS + milliseconds).toISOString();
}

function deterministicUuid(label) {
  const hex = createHash('sha256').update(label, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return { bytes, sha256: sha256Bytes(bytes) };
}

async function writeJsonl(filePath, rows) {
  const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length > 0 ? '\n' : ''}`, 'utf8');
  await writeFile(filePath, bytes);
  return { bytes, sha256: sha256Bytes(bytes) };
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
          direction: { from: sourceSense, to: `cal-m5-10d-${targetNumber}-s1` },
        } : null,
      };
    }),
  };
}

function createWorkload(proposalSha256) {
  const all = Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
  const corrections = ['m5-10d-cal-002', 'm5-10d-cal-004', 'm5-10d-cal-008', 'm5-10d-cal-011'];
  const heldRejected = ['m5-10d-cal-006', 'm5-10d-cal-013', 'm5-10d-cal-016', 'm5-10d-cal-020'];
  const passRows = [
    ['target-preparation', 'target-preparation', 'calibration-start', 'pre-review-sample', all],
    ['initial-review', 'semantic-review', 'calibration-start', 'pre-review-sample', all],
    ['feedback-fixes', 'feedback-fix', 'feedback-fix', 'predeclared-feedback-queue', corrections],
    ['final-verification', 'final-verification', 'final-verification', 'predeclared-verification-queue', corrections],
    ['held-rejected', 'held-rejected', 'held-rejected', 'predeclared-hold-rejection-queue', heldRejected],
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
    declaration_status: 'frozen',
    frozen_at: isoAt(1000),
    source: {
      proposal_artifact: 'external:m5-10d-calibration-proposal',
      proposal_sha256: proposalSha256,
      decision_independent: true,
    },
    case_count: M5_10D_CASE_COUNT,
    processed_start_count: M5_10D_CASE_COUNT,
    passes: passRows.map(([id, role, unitKind, declarationSource, expectedUnitIds], index) => ({
      id,
      role,
      unit_kind: unitKind,
      declaration_source: declarationSource,
      declared_at: isoAt(100 + index * 50),
      expected_unit_ids: expectedUnitIds,
      expected_unit_count: expectedUnitIds.length,
      expected_unit_set_sha256: workloadUnitSetSha256(expectedUnitIds),
      empty_work: expectedUnitIds.length === 0,
      note: `${id} workload was frozen before the pass from the source-declared calibration task queue ${index}.`,
    })),
    note: 'Deterministic self-authored M5-10D workload fixture; queue membership is declared independently before each pass and is never inferred from final decisions.',
  };
}

function createWorkRows(proposal, pass, sessionId, workloadPass) {
  return workloadPass.expected_unit_ids.map((unitId, index) => {
    const caseItem = proposal.cases.find(({ case_id: caseId }) => caseId === unitId);
    const input = proposalInputFromCase(caseItem);
    const inputPayloadSha256 = sha256Json(input);
    const producerStartedAt = isoAt(pass.startMs + 100 + index);
    const producerCompletedAt = isoAt(pass.startMs + 110 + index);
    const payload = produce({ unitId, unitKind: workloadPass.unit_kind, input });
    return {
      kind: 'work',
      pass_id: workloadPass.id,
      session_id: sessionId,
      pass_session_id: pass.passSessionId,
      unit_id: unitId,
      recorded_at: producerCompletedAt,
      input: { payload_sha256: inputPayloadSha256, payload: input },
      producer: {
        module: 'scripts/batch/produce-m5-10d-work.mjs',
        export: 'produce',
        version: M5_10D_PRODUCER_VERSION,
        input_payload_sha256: inputPayloadSha256,
        started_at: producerStartedAt,
        completed_at: producerCompletedAt,
        output_sha256: sha256Json(payload),
      },
      payload,
    };
  });
}

async function createTiming({ kind, proposal, workload, proposalSha256, workloadSha256, root, editorialSessionId, auditSessionId, editorialDecisionsSha256, editorialFinalizedAt, firstPassStartMs }) {
  const passIds = kind === 'editorial' ? M5_10D_EDITORIAL_PASS_IDS : M5_10D_AUDIT_PASS_IDS;
  const sessionId = deterministicUuid(`${kind}-timing-session`);
  const passes = [];
  for (const [index, id] of passIds.entries()) {
    const workloadPass = workload.passes.find(({ id: workloadId }) => workloadId === id);
    const startMs = firstPassStartMs + index * 5000;
    const elapsedMs = workloadPass.expected_unit_ids.length === 0 ? 2000 : 3000;
    const passSessionId = deterministicUuid(`${kind}-pass-${id}`);
    const rows = createWorkRows(proposal, { startMs, passSessionId }, sessionId, workloadPass);
    const workPath = path.join(root, `${kind}-${id}.jsonl`);
    const workSource = await writeJsonl(workPath, rows);
    const producerSeconds = rows.reduce((total, row) => total + (Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000, 0);
    const expectedUnitIds = workloadPass.expected_unit_ids;
    passes.push({
      id,
      status: 'complete',
      started_at: isoAt(startMs),
      completed_at: isoAt(startMs + elapsedMs),
      session_id: passSessionId,
      work_status: expectedUnitIds.length === 0 ? 'zero-work' : 'work',
      editor_seconds: expectedUnitIds.length === 0 ? 0 : elapsedMs / 1000,
      wall_clock_seconds: elapsedMs / 1000,
      producer_seconds: producerSeconds,
      work_evidence: {
        path: path.relative(REPOSITORY_DIRECTORY, workPath),
        sha256: workSource.sha256,
        expected_unit_ids: [...expectedUnitIds],
        actual_unit_ids: [...expectedUnitIds],
        unit_count: expectedUnitIds.length,
        expected_unit_set_sha256: workloadPass.expected_unit_set_sha256,
      },
    });
  }
  const startAt = firstPassStartMs - 1000;
  const finalStopMs = Math.max(...passes.map(({ completed_at: completedAt }) => Date.parse(completedAt) - BASE_TIME_MS));
  const timing = {
    schema_version: '1',
    artifact_id: `m5-10d-${kind === 'editorial' ? 'editorial' : 'audit'}-timing-20260912`,
    batch_id: 'm5-10d-editor-time-recalibration-20260912',
    timing_kind: kind === 'editorial' ? 'editorial' : 'post-freeze-audit',
    measurement_kind: 'editor-judgment',
    recorder_version: 'm5-10d-workload-timing-recorder-v1',
    recording_source: 'workload-timing-recorder-v1',
    recorder_command: 'node scripts/batch/record-m5-10d-timing.mjs',
    session_id: sessionId,
    started_at: isoAt(startAt),
    completed_at: isoAt(finalStopMs + 1000),
    status: 'complete',
    workload_artifact: path.relative(REPOSITORY_DIRECTORY, path.join(root, 'workload.json')),
    workload_sha256: workloadSha256,
    proposal_sha256: proposalSha256,
    ...(kind === 'editorial' ? {
      editorial_session_id: editorialSessionId,
    } : {
      editorial_session_id: editorialSessionId,
      audit_session_id: auditSessionId,
      editorial_decisions: path.relative(REPOSITORY_DIRECTORY, path.join(root, 'editorial.json')),
      editorial_decisions_sha256: editorialDecisionsSha256,
      editorial_finalized_at: editorialFinalizedAt,
    }),
    canonical_directory_sha256: await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY),
    inventory_sha256: sha256Bytes(await readFile(DEFAULT_INVENTORY_PATH)),
    passes,
    events: [],
    note: `Deterministic M5-10D ${kind} timing fixture with workload-derived pass scope.`,
  };
  timing.recording_proof_sha256 = createM5DConcreteTimingProof(timing);
  const timingName = kind === 'editorial' ? 'editorial-timing' : 'audit-timing';
  return { timing, source: await writeJson(path.join(root, `${timingName}.json`), timing) };
}

export function createM5DContractEditorial(proposal, proposalSha256, editorialTiming, editorialSessionId) {
  const finalStopMs = Math.max(...editorialTiming.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt) - BASE_TIME_MS));
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-editorial-decisions-20260912',
    batch_id: 'm5-10d-editor-time-recalibration-20260912',
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-record-by-record-editorial-draft',
    proposal_sha256: proposalSha256,
    editorial_session_id: editorialSessionId,
    timing_session_id: editorialTiming.session_id,
    draft_created_at: isoAt(7500),
    created_at: isoAt(finalStopMs + 1000),
    finalized_at: isoAt(finalStopMs + 1001),
    records: proposal.cases.map((caseItem, index) => {
      const caseId = caseItem.case_id;
      const senseIds = caseItem.record.senses.map(({ id }) => id);
      const sourcePos = caseItem.record.senses.map(({ pos }) => pos);
      const decision = DECISION_BY_INDEX[index];
      const candidate = caseItem.relation_candidate;
      const relationReview = candidate === null ? {
        outcome: 'no-valid-candidate',
        decision: 'not-applicable',
        noise_assessment: 'not-applicable',
        correction: 'none',
        note: `${caseId} relation-review has no candidate after checking ${senseIds[0]}.`,
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
        note: `${caseId} relation-review checked ${candidate.source_sense} toward ${candidate.target_sense} as a ${candidate.type} candidate.`,
      };
      return {
        case_id: caseId,
        record_id: caseItem.record.id,
        source_record_sha256: sha256Json(caseItem.record),
        decision,
        ...(decision === 'corrected' ? { corrected_fields: ['sense_review', 'boundary_reviews'] } : {}),
        lemma_pos: {
          status: 'checked',
          observed_pos: sourcePos,
          note: `${caseId} lemma-pos checked against ${senseIds.join(', ')}.`,
        },
        sense_review: {
          status: 'complete',
          observed_sense_count: senseIds.length,
          observed_sense_ids: senseIds,
          observed_pos: sourcePos,
          note: `${caseId} sense-review retained ${senseIds.join(', ')}.`,
        },
        boundary_reviews: Object.fromEntries(M5_10D_BOUNDARY_IDS.map((boundaryId, boundaryIndex) => [boundaryId, {
          status: 'reviewed',
          applicability: 'not-applicable',
          decision: 'keep',
          evidence: `${caseId} ${boundaryId} checked against ${senseIds.join(', ')} with evidence token ${index}-${boundaryIndex}.`,
        }])),
        relation_review: relationReview,
        decision_note: `${caseId} ${caseItem.record.id} received ${decision} after checking ${senseIds.join(', ')}.`,
      };
    }),
    note: 'Deterministic self-authored record-by-record M5-10D editorial fixture.',
  };
}

export function createM5DContractAudit(proposal, proposalSha256, editorial, editorialSha256, editorialTiming, auditTiming, editorialSessionId, auditSessionId) {
  const auditStopMs = Math.max(...auditTiming.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt) - BASE_TIME_MS));
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-audit-decisions-20260912',
    batch_id: 'm5-10d-editor-time-recalibration-20260912',
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-post-freeze-comparison',
    independent: true,
    proposal_sha256: proposalSha256,
    editorial_decisions_sha256: editorialSha256,
    editorial_session_id: editorialSessionId,
    audit_session_id: auditSessionId,
    timing_session_id: auditTiming.session_id,
    draft_created_at: isoAt(31500),
    created_at: isoAt(auditStopMs + 1000),
    finalized_at: isoAt(auditStopMs + 1001),
    status: 'complete',
    case_reviews: proposal.cases.map((caseItem) => ({
      case_id: caseItem.case_id,
      source_record_sha256: sha256Json(caseItem.record),
      editorial_record_sha256: sha256Json(editorial.records.find(({ case_id: caseId }) => caseId === caseItem.case_id)),
      source_comparison: 'match',
      decision_comparison: 'match',
      relation_comparison: 'match',
      status: 'verified',
      note: `${caseItem.case_id} audit independently checked the source and frozen decision row for ${caseItem.record.senses[0].id}.`,
    })),
    findings: [],
    open_blocker_count: 0,
    note: 'Deterministic self-authored independent post-freeze audit fixture.',
  };
}

export function createM5DContractVerification(canonicalDirectorySha256, inventorySha256) {
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-verification-20260912',
    issue: 115,
    status: 'passed',
    verified_at: isoAt(50000),
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
    note: 'Deterministic self-authored M5-10D machine verification fixture.',
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
    editorial_decisions: 'data/batches/m5-10d-editorial-decisions-20260912.json',
    editorial_timing: 'data/batches/m5-10d-editorial-timing-20260912.json',
    audit_decisions: 'data/batches/m5-10d-audit-decisions-20260912.json',
    audit_timing: 'data/batches/m5-10d-audit-timing-20260912.json',
    verification: 'data/batches/m5-10d-verification-20260912.json',
    canonical_directory: 'data/canonical',
    inventory: 'data/inventory/m5-target-inventory.json',
  });
  return recovery;
}

function fixedAuthorizationSourcePaths(authorization) {
  Object.assign(authorization.source, {
    recovery_artifact: 'data/batches/m5-10d-recovery.json',
    workload: 'data/batches/m5-10d-workload-20260912.json',
    canonical_directory: 'data/canonical',
    inventory: 'data/inventory/m5-target-inventory.json',
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
    const editorialTimingPath = path.join(fixtureRoot, 'editorial-timing.json');
    const editorialPath = path.join(fixtureRoot, 'editorial.json');
    const auditTimingPath = path.join(fixtureRoot, 'audit-timing.json');
    const auditPath = path.join(fixtureRoot, 'audit.json');
    const verificationPath = path.join(fixtureRoot, 'verification.json');
    const recoveryPath = path.join(fixtureRoot, 'recovery.json');
    const authorizationPath = path.join(fixtureRoot, 'authorization.json');
    const proposal = createM5DContractProposal();
    const proposalSource = await writeJson(proposalPath, proposal);
    const workload = createWorkload(proposalSource.sha256);
    const workloadSource = await writeJson(workloadPath, workload);
    const editorialSessionId = deterministicUuid('m5-10d-editorial-session');
    const auditSessionId = deterministicUuid('m5-10d-audit-session');
    const editorialTimingResult = await createTiming({
      kind: 'editorial',
      proposal,
      workload,
      proposalSha256: proposalSource.sha256,
      workloadSha256: workloadSource.sha256,
      root: fixtureRoot,
      editorialSessionId,
      firstPassStartMs: 2000,
    });
    const editorial = createM5DContractEditorial(proposal, proposalSource.sha256, editorialTimingResult.timing, editorialSessionId);
    const editorialSource = await writeJson(editorialPath, editorial);
    const auditTimingResult = await createTiming({
      kind: 'post-freeze-audit',
      proposal,
      workload,
      proposalSha256: proposalSource.sha256,
      workloadSha256: workloadSource.sha256,
      root: fixtureRoot,
      editorialSessionId,
      auditSessionId,
      editorialDecisionsSha256: editorialSource.sha256,
      editorialFinalizedAt: editorial.finalized_at,
      firstPassStartMs: 30000,
    });
    const audit = createM5DContractAudit(proposal, proposalSource.sha256, editorial, editorialSource.sha256, editorialTimingResult.timing, auditTimingResult.timing, editorialSessionId, auditSessionId);
    const auditSource = await writeJson(auditPath, audit);
    const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
    const inventorySha256 = sha256Bytes(await readFile(DEFAULT_INVENTORY_PATH));
    await writeJson(verificationPath, createM5DContractVerification(canonicalDirectorySha256, inventorySha256));
    await buildM5DRecovery({
      proposalPath,
      workloadPath,
      editorialPath,
      editorialTimingPath: path.join(fixtureRoot, 'editorial-timing.json'),
      auditPath,
      auditTimingPath: path.join(fixtureRoot, 'audit-timing.json'),
      verificationPath,
      outputPath: recoveryPath,
    });
    const recovery = JSON.parse((await readFile(recoveryPath)).toString('utf8'));
    const recoverySource = await writeJson(recoveryPath, fixedRecoverySourcePaths(recovery));
    const recoveryResult = await validateM5DRecovery({
      artifactPath: recoveryPath,
      proposalPath,
      workloadPath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
    });
    const authorization = await buildM5DAuthorization({
      recoveryPath,
      workloadPath,
      outputPath: authorizationPath,
      recoveryOptions: {
        proposalPath,
        editorialPath,
        editorialTimingPath,
        auditPath,
        auditTimingPath,
        verificationPath,
      },
    });
    await writeJson(authorizationPath, fixedAuthorizationSourcePaths(authorization));
    const authorizationResult = await validateM5DAuthorization({
      authorizationPath,
      recoveryPath,
      proposalPath,
      workloadPath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
    });
    console.log(JSON.stringify({
      recovery_gate: recoveryResult.gate.gate_status,
      authorization: authorizationResult.authorization.decision,
      workload_sha256: workloadSource.sha256,
      recovery_sha256: recoverySource.sha256,
      authorization_sha256: sha256Json(authorizationResult.authorization),
      pass_ids: M5_10D_PASS_IDS,
    }, null, 2));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runM5DRecoveryContract().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

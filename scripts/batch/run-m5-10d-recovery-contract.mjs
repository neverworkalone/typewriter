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
  M5_10D_FOLLOW_UP_SOURCE_KIND,
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

function createWorkload(proposalSha256, followUpSource) {
  const source = followUpSource.value ?? followUpSource;
  const all = Array.from({ length: M5_10D_CASE_COUNT }, (_, index) => `m5-10d-cal-${String(index + 1).padStart(3, '0')}`);
  const corrections = source.findings.filter(({ finding_kind: findingKind }) => findingKind === 'correction').map(({ case_id: caseId }) => caseId);
  const heldRejected = source.findings.filter(({ finding_kind: findingKind }) => findingKind === 'held' || findingKind === 'rejected').map(({ case_id: caseId }) => caseId);
  const passRows = [
    ['target-preparation', 'target-preparation', 'calibration-start', 'pre-review-sample', all],
    ['initial-review', 'semantic-review', 'calibration-start', 'pre-review-sample', all],
    ['feedback-fixes', 'feedback-fix', 'feedback-fix', 'source-derived-initial-findings', corrections],
    ['final-verification', 'final-verification', 'final-verification', 'source-derived-correction-findings', corrections],
    ['held-rejected', 'held-rejected', 'held-rejected', 'source-derived-initial-findings', heldRejected],
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
    frozen_at: isoAt(11000),
    source: {
      proposal_artifact: 'external:m5-10d-calibration-proposal',
      proposal_sha256: proposalSha256,
      decision_independent: true,
      follow_up_artifact: 'external:m5-10d-follow-up-source',
      follow_up_sha256: followUpSource.sha256,
      follow_up_source_kind: M5_10D_FOLLOW_UP_SOURCE_KIND,
      follow_up_timing_session_id: source.timing_session_id,
      follow_up_pass_id: source.source_pass_id,
      follow_up_freeze_event_id: source.freeze_event_id,
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
    note: 'Deterministic self-authored M5-10D workload fixture; follow-up queues are derived from a recorder-owned initial-review source artifact.',
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

async function createTiming({ kind, proposal, workload, proposalSha256, workloadSha256, root, editorialSessionId, auditSessionId, editorialDecisionsSha256, editorialFinalizedAt, judgmentArtifactPath, judgmentArtifactSha256, judgmentRecords, firstPassStartMs }) {
  const passIds = kind === 'editorial' ? M5_10D_EDITORIAL_PASS_IDS : M5_10D_AUDIT_PASS_IDS;
  const sessionId = deterministicUuid(`${kind}-timing-session`);
  const passes = [];
  const events = [];
  const artifactRecordsByCase = new Map((judgmentRecords ?? []).map((row) => [row.case_id, row]));
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
    const judgmentRows = expectedUnitIds.map((unitId, unitIndex) => {
      const caseItem = proposal.cases.find(({ case_id: caseId }) => caseId === unitId);
      const compact = proposalInputFromCase(caseItem);
      const decisionRow = artifactRecordsByCase.get(unitId);
      const judgmentStartedAt = isoAt(startMs + 1000 + unitIndex * 20);
      const judgmentCompletedAt = isoAt(startMs + 1050 + unitIndex * 20);
      const evidence = id === 'target-preparation' ? {
        path: path.relative(REPOSITORY_DIRECTORY, path.join(root, 'proposal.json')),
        decision_artifact_sha256: proposalSha256,
        decision_row_sha256: sha256Json(compact),
        decision_artifact_kind: 'proposal',
      } : {
        path: path.relative(REPOSITORY_DIRECTORY, judgmentArtifactPath),
        decision_artifact_sha256: judgmentArtifactSha256,
        decision_row_sha256: sha256Json(decisionRow),
        decision_artifact_kind: kind === 'editorial' ? 'editorial-draft' : 'audit-draft',
        authored_at: kind === 'editorial' ? isoAt(7500) : isoAt(31500),
      };
      const judgmentId = deterministicUuid(`${kind}-judgment-${id}-${unitId}`);
      const eventId = `m5-10d-judgment-${id}-${unitId}`;
      events.push({
        event_id: eventId,
        kind: 'judgment-completed',
        pass_id: id,
        session_id: sessionId,
        pass_session_id: passSessionId,
        unit_id: unitId,
        judgment_id: judgmentId,
        recorded_at: judgmentCompletedAt,
        completed_at: judgmentCompletedAt,
        decision_artifact_sha256: evidence.decision_artifact_sha256,
        decision_row_sha256: evidence.decision_row_sha256,
      });
      return {
        kind: 'judgment',
        pass_id: id,
        session_id: sessionId,
        pass_session_id: passSessionId,
        unit_id: unitId,
        judgment_id: judgmentId,
        started_at: judgmentStartedAt,
        completed_at: judgmentCompletedAt,
        recorded_at: judgmentCompletedAt,
        evidence,
      };
    });
    const judgmentPath = path.join(root, `${kind}-${id}-judgment.jsonl`);
    const judgmentSource = await writeJsonl(judgmentPath, judgmentRows);
    const judgmentSeconds = judgmentRows.reduce((total, row) => total + (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000, 0);
    passes.push({
      id,
      status: 'complete',
      started_at: isoAt(startMs),
      completed_at: isoAt(startMs + elapsedMs),
      session_id: passSessionId,
      workload_sha256: workloadSha256,
      work_status: expectedUnitIds.length === 0 ? 'zero-work' : 'work',
      judgment_seconds: judgmentSeconds,
      editor_seconds: judgmentSeconds,
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
      judgment_evidence: {
        path: path.relative(REPOSITORY_DIRECTORY, judgmentPath),
        sha256: judgmentSource.sha256,
        expected_unit_ids: [...expectedUnitIds],
        actual_unit_ids: [...expectedUnitIds],
        unit_count: expectedUnitIds.length,
        expected_unit_set_sha256: workloadPass.expected_unit_set_sha256,
        event_ids: judgmentRows.map(({ unit_id: unitId }) => `m5-10d-judgment-${id}-${unitId}`),
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
    workload_history: [{ sha256: workloadSha256, recorded_at: isoAt(firstPassStartMs - 1000) }],
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
    events,
    active_judgments: [],
    note: `Deterministic M5-10D ${kind} timing fixture with workload-derived pass scope.`,
  };
  timing.recording_proof_sha256 = createM5DConcreteTimingProof(timing);
  const timingName = kind === 'editorial' ? 'editorial-timing' : 'audit-timing';
  return { timing, source: await writeJson(path.join(root, `${timingName}.json`), timing) };
}

export function createM5DContractEditorial(proposal, proposalSha256, editorialTiming, editorialSessionId, draftSha256) {
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
    draft_sha256: draftSha256,
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

function createM5DContractFollowUpSource(proposal, proposalSha256, editorialDraft, timingSessionId, initialPassSessionId) {
  const freezeEventId = 'm5-10d-workload-freeze-0001';
  return {
    schema_version: '1',
    artifact_id: 'm5-10d-follow-up-source-20260912',
    batch_id: 'm5-10d-editor-time-recalibration-20260912',
    source_kind: M5_10D_FOLLOW_UP_SOURCE_KIND,
    proposal_sha256: proposalSha256,
    timing_session_id: timingSessionId,
    source_pass_id: 'initial-review',
    source_pass_session_id: initialPassSessionId,
    source_judgment_artifact_sha256: editorialDraft.sha256,
    freeze_event_id: freezeEventId,
    created_at: isoAt(10500),
    findings: editorialDraft.value.records
      .filter(({ decision }) => ['corrected', 'held', 'rejected'].includes(decision))
      .map((decisionRow) => ({
        case_id: decisionRow.case_id,
        record_id: decisionRow.record_id,
        source_record_sha256: decisionRow.source_record_sha256,
        finding_kind: decisionRow.decision === 'corrected' ? 'correction' : decisionRow.decision,
        source_judgment_id: deterministicUuid(`editorial-judgment-initial-review-${decisionRow.case_id}`),
        source_judgment_row_sha256: sha256Json(decisionRow),
        note: `${decisionRow.case_id} was bound to its completed initial-review judgment before follow-up work.`,
      })),
    note: 'Deterministic source-derived follow-up fixture bound to initial-review judgment rows.',
  };
}

export function createM5DContractAudit(proposal, proposalSha256, editorial, editorialSha256, editorialTiming, auditTiming, editorialSessionId, auditSessionId, draftSha256) {
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
    draft_sha256: draftSha256,
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
    follow_up_source: 'external:m5-10d-follow-up-source',
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
    const followUpSourcePath = path.join(fixtureRoot, 'follow-up-source.json');
    const editorialTimingPath = path.join(fixtureRoot, 'editorial-timing.json');
    const editorialPath = path.join(fixtureRoot, 'editorial.json');
    const editorialDraftPath = path.join(fixtureRoot, 'editorial-draft.json');
    const auditTimingPath = path.join(fixtureRoot, 'audit-timing.json');
    const auditPath = path.join(fixtureRoot, 'audit.json');
    const auditDraftPath = path.join(fixtureRoot, 'audit-draft.json');
    const verificationPath = path.join(fixtureRoot, 'verification.json');
    const recoveryPath = path.join(fixtureRoot, 'recovery.json');
    const authorizationPath = path.join(fixtureRoot, 'authorization.json');
    const proposal = createM5DContractProposal();
    const proposalSource = await writeJson(proposalPath, proposal);
    const editorialSessionId = deterministicUuid('m5-10d-editorial-session');
    const auditSessionId = deterministicUuid('m5-10d-audit-session');
    const initialPassSessionId = deterministicUuid('editorial-pass-initial-review');
    const editorialDraftTemplate = createM5DContractEditorial(proposal, proposalSource.sha256, {
      session_id: deterministicUuid('editorial-timing-session'),
      passes: [{ completed_at: isoAt(25000) }],
    }, editorialSessionId);
    const editorialDraft = await writeJson(editorialDraftPath, {
      draft_source: 'record-by-record-editorial-judgment',
      batch_id: 'm5-10d-editor-time-recalibration-20260912',
      proposal_sha256: proposalSource.sha256,
      draft_created_at: isoAt(7500),
      records: editorialDraftTemplate.records,
      note: 'Deterministic separately-authored editorial draft fixture.',
    });
    const followUpSource = createM5DContractFollowUpSource(
      proposal,
      proposalSource.sha256,
      { value: JSON.parse((await readFile(editorialDraftPath)).toString('utf8')), sha256: editorialDraft.sha256 },
      deterministicUuid('editorial-timing-session'),
      initialPassSessionId,
    );
    const followUpSourceWritten = await writeJson(followUpSourcePath, followUpSource);
    const followUpSourceWrapper = { value: followUpSource, sha256: followUpSourceWritten.sha256 };
    const workload = createWorkload(proposalSource.sha256, followUpSourceWrapper);
    const workloadSource = await writeJson(workloadPath, workload);
    const editorialTimingResult = await createTiming({
      kind: 'editorial',
      proposal,
      workload,
      proposalSha256: proposalSource.sha256,
      workloadSha256: workloadSource.sha256,
      root: fixtureRoot,
      editorialSessionId,
      judgmentArtifactPath: editorialDraftPath,
      judgmentArtifactSha256: editorialDraft.sha256,
      judgmentRecords: editorialDraftTemplate.records,
      firstPassStartMs: 2000,
    });
    const editorial = createM5DContractEditorial(proposal, proposalSource.sha256, editorialTimingResult.timing, editorialSessionId, editorialDraft.sha256);
    const editorialSource = await writeJson(editorialPath, editorial);
    const auditDraftTemplate = createM5DContractAudit(
      proposal,
      proposalSource.sha256,
      editorial,
      editorialSource.sha256,
      editorialTimingResult.timing,
      { session_id: deterministicUuid('audit-timing-session'), passes: [{ completed_at: isoAt(33000) }] },
      editorialSessionId,
      auditSessionId,
    );
    const auditDraft = await writeJson(auditDraftPath, {
      draft_source: 'independent-post-freeze-comparison',
      batch_id: 'm5-10d-editor-time-recalibration-20260912',
      proposal_sha256: proposalSource.sha256,
      editorial_decisions_sha256: editorialSource.sha256,
      draft_created_at: isoAt(31500),
      case_reviews: auditDraftTemplate.case_reviews,
      findings: [],
      note: 'Deterministic separately-authored independent audit draft fixture.',
    });
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
      judgmentArtifactPath: auditDraftPath,
      judgmentArtifactSha256: auditDraft.sha256,
      judgmentRecords: auditDraftTemplate.case_reviews,
      firstPassStartMs: 30000,
    });
    const audit = createM5DContractAudit(proposal, proposalSource.sha256, editorial, editorialSource.sha256, editorialTimingResult.timing, auditTimingResult.timing, editorialSessionId, auditSessionId, auditDraft.sha256);
    const auditSource = await writeJson(auditPath, audit);
    const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
    const inventorySha256 = sha256Bytes(await readFile(DEFAULT_INVENTORY_PATH));
    await writeJson(verificationPath, createM5DContractVerification(canonicalDirectorySha256, inventorySha256));
    await buildM5DRecovery({
      proposalPath,
      workloadPath,
      followUpSourcePath,
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
      followUpSourcePath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
    });
    const authorization = await buildM5DAuthorization({
      recoveryPath,
      workloadPath,
      followUpSourcePath,
      outputPath: authorizationPath,
      recoveryOptions: {
        proposalPath,
        followUpSourcePath,
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
      followUpSourcePath,
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

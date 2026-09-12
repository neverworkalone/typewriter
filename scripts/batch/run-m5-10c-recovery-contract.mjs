/**
 * Run the complete M5-10C recovery and authorization validators with a
 * deterministic, self-authored contract fixture.
 *
 * The production calibration proposal remains external. This fixture is
 * generated in a temporary repository directory, never enters canonical data,
 * and is removed after the validators finish.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildM5CRecovery } from './build-m5-10c-recovery.mjs';
import {
  BATCH_DIRECTORY,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_INVENTORY_PATH,
  M5_10C_AUDIT_PASS_IDS,
  M5_10C_BOUNDARY_IDS,
  M5_10C_CANONICAL_SNAPSHOT,
  M5_10C_BATCH_ID,
  M5_10C_CASE_COUNT,
  M5_10C_EDITORIAL_PASS_IDS,
  M5_10C_PROCESS_REVISION,
  M5CRecoveryValidationError,
  REPOSITORY_DIRECTORY,
  assertM5CRecoveryAuthorizable,
  createM5CConcreteTimingProof,
  sha256Json,
  validateM5CAuthorization,
  validateM5CRecovery,
} from './validate-m5-10c-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { M5_10C_PRODUCER_VERSION, produce, proposalInputFromCase } from './produce-m5-10c-work.mjs';

const BASE_TIME_MS = Date.parse('2026-01-01T00:00:00.000Z');
const FIXTURE_SOURCE_PATHS = Object.freeze({
  editorial_decisions: 'data/batches/m5-10c-editorial-decisions-20260910.json',
  editorial_timing: 'data/batches/m5-10c-editorial-timing-20260910.json',
  audit_decisions: 'data/batches/m5-10c-audit-decisions-20260910.json',
  audit_timing: 'data/batches/m5-10c-audit-timing-20260910.json',
  verification: 'data/batches/m5-10c-verification.json',
});

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
  const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  await writeFile(filePath, bytes);
  return { bytes, sha256: sha256Bytes(bytes) };
}

function createProposal() {
  return {
    schema_version: '1',
    artifact_id: 'm5-10c-calibration-proposal',
    process_revision: M5_10C_PROCESS_REVISION,
    case_count: M5_10C_CASE_COUNT,
    cases: Array.from({ length: M5_10C_CASE_COUNT }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      const recordType = index % 2 === 0 ? 'entry' : 'expression';
      const pos = recordType === 'entry' ? 'noun' : 'expression';
      return {
        case_id: `m5-10c-cal-${number}`,
        record: {
          id: `cal-m5-10c-${number}`,
          record_type: recordType,
          lemma: `contract-fixture-${number}`,
          search_forms: [`contract-fixture-${number}`],
          senses: [{
            id: `cal-m5-10c-${number}-s1`,
            pos,
            gloss: `contract fixture gloss ${number}`,
          }],
        },
        relation_candidate: null,
      };
    }),
  };
}

function createWorkRows(cases, pass, sessionId) {
  return cases.map((caseItem) => {
    const inputPayload = proposalInputFromCase(caseItem);
    const inputPayloadSha256 = sha256Json(inputPayload);
    const producerStartedAt = isoAt(pass.start_ms + 100);
    const producerCompletedAt = isoAt(pass.start_ms + 101);
    const payload = produce({
      unitId: caseItem.case_id,
      unitKind: 'calibration-start',
      input: inputPayload,
    });
    return {
      kind: 'work',
      pass_id: pass.id,
      session_id: sessionId,
      pass_session_id: pass.session_id,
      unit_id: caseItem.case_id,
      recorded_at: producerCompletedAt,
      input: {
        payload_sha256: inputPayloadSha256,
        payload: inputPayload,
      },
      producer: {
        module: 'scripts/batch/produce-m5-10c-work.mjs',
        export: 'produce',
        version: M5_10C_PRODUCER_VERSION,
        input_payload_sha256: inputPayloadSha256,
        started_at: producerStartedAt,
        completed_at: producerCompletedAt,
        output_sha256: sha256Json(payload),
      },
      payload,
    };
  });
}

async function createTiming({
  kind,
  cases,
  root,
  proposalSha256,
  sessionId,
  editorialSessionId,
  auditSessionId,
  editorialDecisionsSha256,
  editorialFinalizedAt,
  firstPassStartMs,
  timingPath,
}) {
  const passIds = kind === 'editorial' ? M5_10C_EDITORIAL_PASS_IDS : M5_10C_AUDIT_PASS_IDS;
  const passes = [];
  for (const [index, id] of passIds.entries()) {
    const pass = {
      id,
      start_ms: firstPassStartMs + index * 5000,
      session_id: deterministicUuid(`${kind}-pass-${id}`),
    };
    pass.completed_ms = pass.start_ms + 2000;
    const rows = createWorkRows(cases, pass, sessionId);
    const workPath = path.join(root, `${kind}-${id}.jsonl`);
    const workSource = await writeJsonl(workPath, rows);
    const producerSeconds = rows.reduce(
      (total, row) => total + (Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000,
      0,
    );
    passes.push({
      id,
      status: 'complete',
      started_at: isoAt(pass.start_ms),
      completed_at: isoAt(pass.completed_ms),
      session_id: pass.session_id,
      editor_seconds: 2,
      wall_clock_seconds: 2,
      producer_seconds: producerSeconds,
      work_evidence: {
        path: path.relative(REPOSITORY_DIRECTORY, workPath),
        sha256: workSource.sha256,
        unit_count: cases.length,
        unit_ids: cases.map(({ case_id: caseId }) => caseId),
      },
    });
  }
  const timing = {
    schema_version: '1',
    artifact_id: `m5-10c-${kind === 'editorial' ? 'editorial' : 'audit'}-timing-20260910`,
    batch_id: M5_10C_BATCH_ID,
    timing_kind: kind,
    measurement_kind: 'editor-judgment',
    recorder_version: 'm5-10c-timing-recorder-v1',
    recording_source: 'timing-recorder-v1',
    recorder_command: 'node scripts/batch/record-m5-10c-timing.mjs',
    session_id: sessionId,
    started_at: isoAt(firstPassStartMs - 1000),
    completed_at: isoAt(passes.at(-1).completed_at ? Date.parse(passes.at(-1).completed_at) - BASE_TIME_MS + 1000 : firstPassStartMs),
    status: 'complete',
    proposal_sha256: proposalSha256,
    editorial_session_id: editorialSessionId,
    audit_session_id: auditSessionId,
    editorial_decisions_sha256: editorialDecisionsSha256,
    editorial_finalized_at: editorialFinalizedAt,
    canonical_directory_sha256: await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY),
    inventory_sha256: sha256Bytes(await readFile(DEFAULT_INVENTORY_PATH)),
    passes,
    events: [],
    note: `Deterministic ${kind} contract fixture for the M5-10C full validator.`,
  };
  timing.recording_proof_sha256 = createM5CConcreteTimingProof(timing);
  const source = await writeJson(timingPath, timing);
  return { timing, source };
}

function createEditorial(proposal, proposalSha256, editorialTiming) {
  const finalStopMs = Math.max(...editorialTiming.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt) - BASE_TIME_MS));
  const firstPassStartMs = Date.parse(editorialTiming.passes[0].started_at) - BASE_TIME_MS;
  return {
    schema_version: '1',
    artifact_id: 'm5-10c-editorial-decisions-20260910',
    batch_id: M5_10C_BATCH_ID,
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-record-by-record-editorial-draft',
    proposal_sha256: proposalSha256,
    editorial_session_id: editorialTiming.editorial_session_id,
    timing_session_id: editorialTiming.session_id,
    draft_created_at: isoAt(firstPassStartMs + 500),
    created_at: isoAt(finalStopMs + 1000),
    finalized_at: isoAt(finalStopMs + 1001),
    records: proposal.cases.map((caseItem, index) => {
      const sense = caseItem.record.senses[0];
      const caseId = caseItem.case_id;
      const recordId = caseItem.record.id;
      return {
        case_id: caseId,
        record_id: recordId,
        source_record_sha256: sha256Json(caseItem.record),
        decision: 'included',
        lemma_pos: {
          status: 'checked',
          observed_pos: [sense.pos],
          note: `${caseId} lemma-pos checked against ${sense.id}.`,
        },
        sense_review: {
          status: 'complete',
          observed_sense_count: 1,
          observed_sense_ids: [sense.id],
          observed_pos: [sense.pos],
          note: `${caseId} sense-review retained ${sense.id}.`,
        },
        boundary_reviews: Object.fromEntries(M5_10C_BOUNDARY_IDS.map((boundaryId, boundaryIndex) => [boundaryId, {
          status: 'reviewed',
          applicability: 'not-applicable',
          decision: 'keep',
          evidence: `${caseId} ${boundaryId} contract evidence ${index}-${boundaryIndex} ${sense.id}.`,
        }])),
        relation_review: {
          outcome: 'no-valid-candidate',
          decision: 'not-applicable',
          noise_assessment: 'not-applicable',
          correction: 'none',
          note: `${caseId} relation-review has no candidate for ${sense.id}.`,
        },
        decision_note: `${caseId} ${recordId} included after checking ${sense.id}.`,
      };
    }),
    note: 'Deterministic self-authored editorial contract fixture.',
  };
}

function createAudit(proposal, proposalSha256, editorial, editorialSha256, editorialTiming, auditTiming) {
  const auditStopMs = Math.max(...auditTiming.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt) - BASE_TIME_MS));
  const auditStartMs = Date.parse(auditTiming.passes[0].started_at) - BASE_TIME_MS;
  return {
    schema_version: '1',
    artifact_id: 'm5-10c-audit-decisions-20260910',
    batch_id: M5_10C_BATCH_ID,
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-post-freeze-comparison',
    independent: true,
    proposal_sha256: proposalSha256,
    editorial_decisions_sha256: editorialSha256,
    editorial_session_id: editorialTiming.editorial_session_id,
    audit_session_id: auditTiming.audit_session_id,
    timing_session_id: auditTiming.session_id,
    draft_created_at: isoAt(auditStartMs + 500),
    created_at: isoAt(auditStopMs + 1000),
    finalized_at: isoAt(auditStopMs + 1001),
    status: 'complete',
    case_reviews: proposal.cases.map((caseItem) => {
      const senseId = caseItem.record.senses[0].id;
      const editorialRecord = editorial.records.find(({ case_id: caseId }) => caseId === caseItem.case_id);
      return {
        case_id: caseItem.case_id,
        source_record_sha256: sha256Json(caseItem.record),
        editorial_record_sha256: sha256Json(editorialRecord),
        source_comparison: 'match',
        decision_comparison: 'match',
        relation_comparison: 'match',
        status: 'verified',
        note: `${caseItem.case_id} audit checked ${senseId} against the frozen editorial row.`,
      };
    }),
    findings: [],
    open_blocker_count: 0,
    note: 'Deterministic self-authored independent audit contract fixture.',
  };
}

async function createVerification() {
  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventorySha256 = sha256Bytes(await readFile(DEFAULT_INVENTORY_PATH));
  return {
    schema_version: '1',
    artifact_id: 'm5-10c-verification-20260910',
    issue: 113,
    status: 'passed',
    verified_at: isoAt(50000),
    editorial_review_complete: true,
    human_editorial_review_complete: false,
    canonical_integrity: true,
    deterministic_sqlite: true,
    search_product_regression: true,
    calibration_canonical_mutation: false,
    canonical_snapshot: structuredClone(M5_10C_CANONICAL_SNAPSHOT),
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory_sha256: inventorySha256,
    checks: [
      { id: 'canonical-integrity', status: 'pass' },
      { id: 'deterministic-sqlite', status: 'pass' },
      { id: 'search-product-regression', status: 'pass' },
      { id: 'calibration-canonical-boundary', status: 'pass' },
    ],
    note: 'Deterministic self-authored verification contract fixture.',
  };
}

async function createAuthorization(filePath, recoverySha256) {
  const failedStagePath = path.join(BATCH_DIRECTORY, 'm5-10-wave-b-stage.json');
  const failedStageBytes = await readFile(failedStagePath);
  const inventoryBytes = await readFile(DEFAULT_INVENTORY_PATH);
  const authorization = {
    schema_version: '1',
    authorization_id: 'm5-10c-m5-11-authorization-20260910',
    issue: 113,
    parent_issue: 7,
    target_issue: 97,
    process_revision: M5_10C_PROCESS_REVISION,
    decision: 'AUTHORIZE M5-11 +500 VALIDATION',
    canonical_mutation: false,
    failed_stage: {
      path: 'data/batches/m5-10-wave-b-stage.json',
      sha256: sha256Bytes(failedStageBytes),
      gate_status: 'fail',
      decision: 'HOLD PROCESS',
      next_stage_authorized: false,
      start_count: 778,
    },
    target: {
      base_start_count: 778,
      net_start_increase: 500,
      cumulative_start_target: 1278,
      candidate_data_created: false,
    },
    source: {
      failed_stage: 'data/batches/m5-10-wave-b-stage.json',
      repair_revision: 'data/batches/m5-10a-process-correction.json',
      recovery_artifact: 'data/batches/m5-10c-recovery.json',
      recovery_artifact_sha256: recoverySha256,
      canonical_directory: 'data/canonical',
      canonical_directory_sha256: await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY),
      inventory: 'data/inventory/m5-target-inventory.json',
      inventory_sha256: sha256Bytes(inventoryBytes),
    },
    created_at: isoAt(60000),
    note: 'Deterministic authorization fixture used only to exercise the source-derived validator.',
  };
  return writeJson(filePath, authorization);
}

async function runM5CRecoveryContract() {
  const fixtureRoot = await mkdtemp(path.join(REPOSITORY_DIRECTORY, '.m5-10c-recovery-contract-'));
  try {
    const proposalPath = path.join(fixtureRoot, 'proposal.json');
    const editorialTimingPath = path.join(fixtureRoot, 'editorial-timing.json');
    const editorialPath = path.join(fixtureRoot, 'editorial.json');
    const auditTimingPath = path.join(fixtureRoot, 'audit-timing.json');
    const auditPath = path.join(fixtureRoot, 'audit.json');
    const verificationPath = path.join(fixtureRoot, 'verification.json');
    const recoveryPath = path.join(fixtureRoot, 'recovery.json');
    const authorizationPath = path.join(fixtureRoot, 'authorization.json');
    const proposal = createProposal();
    const proposalSource = await writeJson(proposalPath, proposal);
    const editorialSessionId = deterministicUuid('editorial-session');
    const editorialTimingSessionId = deterministicUuid('editorial-timing-session');
    const auditSessionId = deterministicUuid('audit-session');
    const auditTimingSessionId = deterministicUuid('audit-timing-session');
    const editorialTimingResult = await createTiming({
      kind: 'editorial',
      cases: proposal.cases,
      root: fixtureRoot,
      proposalSha256: proposalSource.sha256,
      sessionId: editorialTimingSessionId,
      editorialSessionId,
      firstPassStartMs: 1000,
      timingPath: editorialTimingPath,
    });
    const editorial = createEditorial(proposal, proposalSource.sha256, editorialTimingResult.timing);
    const editorialSource = await writeJson(editorialPath, editorial);
    const auditTimingResult = await createTiming({
      kind: 'post-freeze-audit',
      cases: proposal.cases,
      root: fixtureRoot,
      proposalSha256: proposalSource.sha256,
      sessionId: auditTimingSessionId,
      editorialSessionId,
      auditSessionId,
      editorialDecisionsSha256: editorialSource.sha256,
      editorialFinalizedAt: editorial.finalized_at,
      firstPassStartMs: 30000,
      timingPath: auditTimingPath,
    });
    const audit = createAudit(
      proposal,
      proposalSource.sha256,
      editorial,
      editorialSource.sha256,
      editorialTimingResult.timing,
      auditTimingResult.timing,
    );
    await writeJson(auditPath, audit);
    await writeJson(verificationPath, await createVerification());

    await buildM5CRecovery({
      proposalPath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
      outputPath: recoveryPath,
    });
    const recovery = JSON.parse((await readFile(recoveryPath)).toString('utf8'));
    for (const [key, value] of Object.entries(FIXTURE_SOURCE_PATHS)) recovery.source[key] = value;
    const recoverySource = await writeJson(recoveryPath, recovery);

    const recoveryResult = await validateM5CRecovery({
      artifactPath: recoveryPath,
      proposalPath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
    });
    assertM5CRecoveryAuthorizable(recoveryResult);
    const authorizationSource = await createAuthorization(authorizationPath, recoverySource.sha256);
    const authorizationResult = await validateM5CAuthorization({
      authorizationPath,
      recoveryPath,
      proposalPath,
      editorialPath,
      editorialTimingPath,
      auditPath,
      auditTimingPath,
      verificationPath,
    });
    console.log(JSON.stringify({
      recovery_gate: recoveryResult.gate.gate_status,
      authorization: authorizationResult.authorization.decision,
      fixture_proposal_sha256: proposalSource.sha256,
      fixture_recovery_sha256: recoverySource.sha256,
      fixture_authorization_sha256: authorizationSource.sha256,
    }, null, 2));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runM5CRecoveryContract().catch((error) => {
    if (error instanceof M5CRecoveryValidationError) console.error(`${error.code}: ${error.message}`);
    else console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

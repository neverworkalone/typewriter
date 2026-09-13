/**
 * Current-clock recorder for M5-10D.
 *
 * Every pass is bound to a frozen workload declaration before it starts. The
 * recorder accepts only proposal facts, records producer execution separately,
 * and refuses missing, duplicate, or expanded work scopes. A zero-work pass is
 * explicit and contributes zero editor seconds. Production judgment rows must
 * be completed by a separate recorder invocation after the source context has
 * been opened; the synthetic contract is the only same-process exception.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AUDIT_DECISIONS_PATH,
  DEFAULT_AUDIT_TIMING_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_DECISIONS_PATH,
  DEFAULT_EDITORIAL_TIMING_PATH,
  DEFAULT_FOLLOW_UP_SOURCE_PATH,
  DEFAULT_INVENTORY_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_WORKLOAD_PATH,
  M5_10D_AUDIT_PASS_IDS,
  M5_10D_BATCH_ID,
  M5_10D_BOUNDARY_IDS,
  M5_10D_EDITORIAL_PASS_IDS,
  M5_10D_PROCESS_REVISION,
  M5DRecoveryValidationError,
  createM5DConcreteTimingProof,
  deriveM5DPassTiming,
  freezeM5DWorkload,
  sha256Json,
  validateM5DProposal,
  validateM5DFollowUpSource,
  validateM5DWorkload,
} from './validate-m5-10d-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  M5_10D_PRODUCER_VERSION,
  produce,
  proposalInputFromCase,
} from './produce-m5-10d-work.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const RECORDER_VERSION = 'm5-10d-workload-timing-recorder-v3';
const RECORDING_SOURCE = 'workload-timing-recorder-v3';
const RECORDING_COMMAND = 'node scripts/batch/record-m5-10d-timing.mjs';
const DATE_SUFFIX = '20260912';
const MANUAL_JUDGMENT_MODE = 'manual-separate-invocation';
const CONTRACT_JUDGMENT_MODE = 'contract-synthetic';

const M5D_FORBIDDEN_VERDICT_KEYS = new Set([
  'decision',
  'verdict',
  'clean',
  'noise_assessment',
  'correction',
  'audit',
  'approved',
  'included',
  'rejected',
  'held',
  'status',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const M5_10D_RECORDER_VERSION = RECORDER_VERSION;
export const M5_10D_RECORDING_SOURCE = RECORDING_SOURCE;
export const M5_10D_RECORDING_COMMAND = RECORDING_COMMAND;

export class M5DRecorderError extends Error {
  constructor(message, code = 'M5_10D_RECORDING_ERROR') {
    super(message);
    this.name = 'M5DRecorderError';
    this.code = code;
  }
}

function fail(message, code = 'M5_10D_RECORDING_ERROR') {
  throw new M5DRecorderError(message, code);
}

function now() {
  return new Date().toISOString();
}

function laterThan(timestamp) {
  return new Date(Math.max(Date.now(), Date.parse(timestamp) + 1)).toISOString();
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${label} must be a UUIDv4`, 'INVALID_SESSION_ID');
  return value;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function storedRepositoryPath(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return absolute;
}

function resolvePath(value, fallback) {
  const selected = value ?? fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(REPOSITORY_DIRECTORY, selected);
}

function canonicalDirectoryForArgs(args = {}) {
  return resolvePath(args['canonical-dir'], DEFAULT_CANONICAL_DIRECTORY);
}

function inventoryPathForArgs(args = {}) {
  return resolvePath(args.inventory, DEFAULT_INVENTORY_PATH);
}

async function readJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_ARTIFACT');
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256Bytes(bytes) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_ARTIFACT');
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function requireMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`refusing to overwrite pre-existing ${label}: ${filePath}`, 'ARTIFACT_EXISTS');
}

function assertNoVerdictKeys(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (M5D_FORBIDDEN_VERDICT_KEYS.has(key)) fail(`${label} contains forbidden verdict key ${key}`, 'PRODUCER_VERDICT_FORBIDDEN');
    assertNoVerdictKeys(child, `${label}.${key}`);
  }
}

function passIds(kind) {
  if (kind === 'editorial') return M5_10D_EDITORIAL_PASS_IDS;
  if (kind === 'post-freeze-audit') return M5_10D_AUDIT_PASS_IDS;
  fail('--kind must be editorial or post-freeze-audit', 'INVALID_TIMING_KIND');
}

function timingArtifactId(kind) {
  return `m5-10d-${kind === 'editorial' ? 'editorial' : 'audit'}-timing-${DATE_SUFFIX}`;
}

function workLogPath(kind, passId, outputPath, requestedPath) {
  if (requestedPath) return resolvePath(requestedPath);
  const kindPart = kind === 'editorial' ? 'editorial' : 'audit';
  return path.join(path.dirname(outputPath), `m5-10d-${kindPart}-work-${passId}-${DATE_SUFFIX}.jsonl`);
}

function judgmentLogPath(kind, passId, outputPath, requestedPath) {
  if (requestedPath) return resolvePath(requestedPath);
  const kindPart = kind === 'editorial' ? 'editorial' : 'audit';
  return path.join(path.dirname(outputPath), `m5-10d-${kindPart}-judgment-${passId}-${DATE_SUFFIX}.jsonl`);
}

async function sourceInfo(proposalPath, workloadPath, followUpSourcePath = DEFAULT_FOLLOW_UP_SOURCE_PATH, timingSessionId, canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY) {
  const proposal = await readJson(proposalPath, 'M5-10D calibration proposal');
  const canonical = await readCanonicalRecords(canonicalDirectory);
  const proposalInfo = validateM5DProposal(proposal.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposal.sha256;
  const workload = await readJson(workloadPath, 'M5-10D workload');
  let followUpSource;
  if (workload.value.source.follow_up_sha256) {
    followUpSource = await readJson(followUpSourcePath, 'M5-10D follow-up source');
    validateM5DFollowUpSource(followUpSource.value, {
      proposalCaseIds: proposalInfo.case_ids,
      proposalSha256: proposal.sha256,
      proposalCasesById: proposalInfo.by_case,
      ...(timingSessionId ? { timingSessionId } : {}),
    });
  }
  const workloadInfo = validateM5DWorkload(workload.value, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: proposal.sha256,
    proposalCasesById: proposalInfo.by_case,
    followUpSource,
    ...(timingSessionId ? { timingSessionId } : {}),
  });
  workloadInfo.sha256 = workload.sha256;
  return { proposal, proposalInfo, workload, workloadInfo, followUpSource };
}

async function assertCanonicalAndInventoryUnchanged(session, label, canonicalDirectory, inventoryPath) {
  const canonicalSha256 = await hashCanonicalDirectory(canonicalDirectory);
  const inventory = await readJson(inventoryPath, 'M5 target inventory');
  if (canonicalSha256 !== session.canonical_directory_sha256) fail(`${label} changed canonical data`, 'CALIBRATION_CANONICAL_MUTATION');
  if (inventory.sha256 !== session.inventory_sha256) fail(`${label} changed target inventory`, 'CALIBRATION_INVENTORY_MUTATION');
}

function eventId(session) {
  return `m5-10d-timing-event-${String(session.events.length + 1).padStart(4, '0')}`;
}

function parseInputJson(inputJson) {
  if (typeof inputJson !== 'string') fail('work recording requires --input-json=<object>', 'PRODUCER_INPUT_MISSING');
  let input;
  try {
    input = JSON.parse(inputJson);
  } catch (error) {
    fail(`--input-json is not valid JSON: ${error.message}`, 'PRODUCER_INPUT_INVALID');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('work input must be an object', 'PRODUCER_INPUT_INVALID');
  return input;
}

async function createTimingSession(kind, args) {
  const proposalPath = resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH);
  const workloadPath = resolvePath(args.workload, DEFAULT_WORKLOAD_PATH);
  const followUpSourcePath = resolvePath(args['follow-up-source'], DEFAULT_FOLLOW_UP_SOURCE_PATH);
  const canonicalDirectory = canonicalDirectoryForArgs(args);
  const inventoryPath = inventoryPathForArgs(args);
  const { proposal, proposalInfo, workload, workloadInfo } = await sourceInfo(proposalPath, workloadPath, followUpSourcePath, undefined, canonicalDirectory);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(canonicalDirectory);
  const inventory = await readJson(inventoryPath, 'M5 target inventory');
  const startedAt = now();
  const session = {
    schema_version: '1',
    artifact_id: timingArtifactId(kind),
    batch_id: M5_10D_BATCH_ID,
    timing_kind: kind,
    measurement_kind: 'editor-judgment',
    recorder_version: RECORDER_VERSION,
    recording_source: RECORDING_SOURCE,
    recorder_command: RECORDING_COMMAND,
    judgment_mode: String(workload.value.source.proposal_artifact).startsWith('contract:')
      ? CONTRACT_JUDGMENT_MODE
      : MANUAL_JUDGMENT_MODE,
    session_id: randomUUID(),
    started_at: startedAt,
    status: 'in-progress',
    workload_artifact: storedRepositoryPath(workloadPath),
    workload_sha256: workload.sha256,
    proposal_sha256: proposal.sha256,
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory_sha256: inventory.sha256,
    workload_history: [{ sha256: workload.sha256, recorded_at: startedAt }],
    passes: passIds(kind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    active_judgments: [],
    note: kind === 'editorial'
      ? 'Current-clock measurement starts before target preparation and semantic editorial judgment; each non-empty pass measures one continuous window from its first judgment start to pass stop, and follow-up queues come from the frozen workload artifact.'
      : 'Current-clock measurement starts after the editorial artifact is frozen for an independent full-sample audit; the non-empty audit pass measures one continuous judgment window from its first judgment start to pass stop.',
  };
  if (kind === 'editorial') {
    session.editorial_session_id = randomUUID();
  } else {
    const editorialPath = resolvePath(args.editorial, DEFAULT_EDITORIAL_DECISIONS_PATH);
    const editorial = await readJson(editorialPath, 'M5-10D editorial decisions');
    if (editorial.value.proposal_sha256 !== proposal.sha256) fail('audit proposal digest does not match editorial proposal digest', 'SOURCE_BINDING_MISMATCH');
    if (!UUID_PATTERN.test(editorial.value.editorial_session_id)) fail('editorial decisions do not carry a valid session ID', 'SOURCE_BINDING_MISMATCH');
    if (Date.parse(editorial.value.finalized_at) > Date.now()) fail('editorial decisions cannot be finalized in the future', 'SOURCE_BINDING_MISMATCH');
    session.editorial_session_id = editorial.value.editorial_session_id;
    session.audit_session_id = randomUUID();
    session.editorial_decisions = storedRepositoryPath(editorialPath);
    session.editorial_decisions_sha256 = editorial.sha256;
    session.editorial_finalized_at = editorial.value.finalized_at;
  }
  if (Date.parse(workload.value.frozen_at) > Date.parse(session.started_at)) fail('timing session started before workload freeze', 'WORKLOAD_CHRONOLOGY');
  session.events.push({
    event_id: eventId(session),
    kind: 'session-start',
    timing_kind: kind,
    session_id: session.session_id,
    recorded_at: session.started_at,
    workload_sha256: workload.sha256,
    proposal_sha256: proposal.sha256,
    ...(kind === 'post-freeze-audit' ? {
      editorial_session_id: session.editorial_session_id,
      audit_session_id: session.audit_session_id,
      editorial_decisions_sha256: session.editorial_decisions_sha256,
    } : { editorial_session_id: session.editorial_session_id }),
  });
  return { session, proposalInfo, workloadInfo };
}

async function loadTiming(outputPath, kind) {
  const source = await readJson(outputPath, 'M5-10D timing session');
  if (source.value.artifact_id !== timingArtifactId(kind) || source.value.timing_kind !== kind) fail('timing session artifact or kind does not match command', 'TIMING_SOURCE_BINDING');
  if (source.value.batch_id !== M5_10D_BATCH_ID || source.value.recorder_version !== RECORDER_VERSION) fail('timing session was not created by the M5-10D recorder', 'TIMING_PROVENANCE_REQUIRED');
  if (source.value.status !== 'in-progress') fail('timing session is not in progress', 'TIMING_SESSION_STATE');
  return source.value;
}

async function loadOrCreateTiming(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  try {
    return { outputPath, session: await loadTiming(outputPath, kind) };
  } catch (error) {
    if (!(error instanceof M5DRecorderError) || error.code !== 'MISSING_ARTIFACT') throw error;
    const { session } = await createTimingSession(kind, args);
    await requireMissing(outputPath, 'timing session artifact');
    await writeJson(outputPath, session);
    return { outputPath, session };
  }
}

function activePass(session, passId) {
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) fail(`${passId} is not part of the ${session.timing_kind} timing contract`, 'UNKNOWN_TIMING_PASS');
  const pass = session.passes[index];
  if (pass.status !== 'in-progress') fail(`${passId} is not an active recorder pass`, 'TIMING_PASS_STATE');
  return { index, pass };
}

function judgmentEventId(passId, unitId) {
  return `m5-10d-judgment-${passId}-${unitId}`;
}

function rejectFullDraftInput(args) {
  if (args['decision-artifact'] !== undefined || args['judgment-artifact'] !== undefined) {
    fail('timed judgments accept one decision row after start; full decision drafts are not accepted', 'TIMING_DECISION_INPUT_FORBIDDEN');
  }
}

function rejectJudgmentInputAtStart(args) {
  rejectFullDraftInput(args);
  if (args['decision-json'] !== undefined || args['decision-file'] !== undefined) {
    fail('judgment input is accepted only by a later complete-judgment invocation', 'TIMING_DECISION_INPUT_FORBIDDEN');
  }
}

export function validateM5DDecisionInputChronology({
  startedAt,
  authoredAt,
  inputMtimeMs,
  label = 'decision input',
} = {}) {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) fail(`${label} judgment start time is invalid`, 'TIMING_CHRONOLOGY');
  if (inputMtimeMs !== undefined && inputMtimeMs < startedAtMs) {
    fail(`${label} was created before judgment started`, 'TIMING_DECISION_INPUT_FORBIDDEN');
  }
  const authoredAtMs = Date.parse(authoredAt);
  if (!Number.isFinite(authoredAtMs)) fail(`${label} authoring time is invalid`, 'TIMING_DECISION_INPUT_INVALID');
  if (authoredAtMs < startedAtMs) {
    fail(`${label} was authored before judgment started`, 'TIMING_DECISION_INPUT_FORBIDDEN');
  }
  return { startedAtMs, authoredAtMs };
}

async function parseDecisionRow(args, judgmentMode, startedAt) {
  if (args['decision-json'] !== undefined && args['decision-file'] !== undefined) {
    fail('choose exactly one of --decision-json or --decision-file', 'TIMING_DECISION_INPUT_INVALID');
  }
  let row;
  let inputKind;
  let inputSha256;
  let authoredAt;
  let inputMtime;
  if (args['decision-file'] !== undefined) {
    const source = await readJson(resolvePath(args['decision-file']), 'timed judgment decision row');
    const inputPath = resolvePath(args['decision-file']);
    const inputStats = await stat(inputPath);
    if (judgmentMode === MANUAL_JUDGMENT_MODE) {
      if (!source.value || typeof source.value !== 'object' || Array.isArray(source.value)
        || !source.value.decision_row || typeof source.value.decision_row !== 'object'
        || Array.isArray(source.value.decision_row)) {
        fail('production decision files must contain a decision_row envelope', 'TIMING_DECISION_INPUT_INVALID');
      }
      if (typeof source.value.authored_at !== 'string' || !Number.isFinite(Date.parse(source.value.authored_at))) {
        fail('production decision files must contain authored_at', 'TIMING_DECISION_INPUT_INVALID');
      }
      authoredAt = source.value.authored_at;
      row = source.value.decision_row;
      inputMtime = inputStats.mtimeMs;
      validateM5DDecisionInputChronology({
        startedAt,
        authoredAt,
        inputMtimeMs: inputMtime,
        label: 'production decision input',
      });
    } else {
      row = source.value;
      authoredAt = now();
      inputMtime = inputStats.mtimeMs;
    }
    inputKind = 'decision-file';
    inputSha256 = source.sha256;
  } else if (typeof args['decision-json'] === 'string') {
    try {
      row = JSON.parse(args['decision-json']);
    } catch (error) {
      fail(`--decision-json is not valid JSON: ${error.message}`, 'TIMING_DECISION_INPUT_INVALID');
    }
    inputKind = 'decision-json';
    inputSha256 = sha256Json(row);
    authoredAt = now();
  } else {
    fail('timed judgment completion requires one decision row via --decision-json or --decision-file', 'TIMING_EDITOR_WORK_MISSING');
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    fail('timed judgment decision must be one object row', 'TIMING_DECISION_INPUT_INVALID');
  }
  if (judgmentMode === MANUAL_JUDGMENT_MODE && inputKind === 'decision-json' && !process.stdin.isTTY) {
    fail('production judgment rows require a separate interactive recorder invocation', 'TIMING_DECISION_INPUT_FORBIDDEN');
  }
  return { row, inputKind, inputSha256, authoredAt, inputMtime };
}

function requireDecisionRowFields(row, fields, label) {
  for (const field of fields) {
    if (!(field in row)) fail(`${label} is missing ${field}`, 'TIMING_DECISION_INPUT_INVALID');
  }
}

function validateDecisionRowInput(row, kind, pass, expectedCase, judgmentMode) {
  const label = `${pass.id}:${expectedCase.case_id}`;
  if (row.case_id !== expectedCase.case_id) fail(`${label} decision row case ID does not match the active unit`, 'TIMING_DECISION_INPUT_INVALID');
  if (kind !== 'post-freeze-audit' && row.record_id !== expectedCase.record.id) {
    fail(`${label} decision row record ID does not match the proposal`, 'TIMING_SOURCE_BINDING');
  }
  if (row.source_record_sha256 !== sha256Json(expectedCase.record)) fail(`${label} decision row source digest does not match the proposal`, 'TIMING_SOURCE_BINDING');
  if (pass.id === 'target-preparation') {
    requireDecisionRowFields(row, ['preparation_status', 'note'], label);
    if (row.preparation_status !== 'source-bound') fail(`${label} preparation status is invalid`, 'TIMING_DECISION_INPUT_INVALID');
    return;
  }
  if (kind === 'editorial') {
    requireDecisionRowFields(row, ['decision', 'lemma_pos', 'sense_review', 'boundary_reviews', 'relation_review', 'decision_note'], label);
    if (judgmentMode === MANUAL_JUDGMENT_MODE) {
      if (!row.boundary_reviews || typeof row.boundary_reviews !== 'object' || Array.isArray(row.boundary_reviews)) {
        fail(`${label} decision row boundary reviews are invalid`, 'TIMING_DECISION_INPUT_INVALID');
      }
      const sourceSenseIds = expectedCase.record.senses.map(({ id }) => id);
      for (const boundaryId of M5_10D_BOUNDARY_IDS) {
        const boundary = row.boundary_reviews[boundaryId];
        if (!boundary || typeof boundary !== 'object') fail(`${label} decision row is missing ${boundaryId} boundary review`, 'TIMING_DECISION_INPUT_INVALID');
        requireDecisionRowFields(boundary, ['status', 'applicability', 'decision', 'evidence'], label);
        if (typeof boundary.evidence !== 'string') fail(`${label} ${boundaryId} evidence must be text`, 'TIMING_DECISION_INPUT_INVALID');
        if (!boundary.evidence.includes(expectedCase.case_id) || !boundary.evidence.includes(boundaryId)) {
          fail(`${label} ${boundaryId} evidence is not record-specific`, 'TIMING_DECISION_INPUT_INVALID');
        }
        if (!sourceSenseIds.some((senseId) => boundary.evidence.includes(senseId))) {
          fail(`${label} ${boundaryId} evidence is missing a source sense`, 'TIMING_DECISION_INPUT_INVALID');
        }
      }
    }
    const candidate = expectedCase.relation_candidate;
    const relation = row.relation_review;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      fail(`${label} decision row relation review is invalid`, 'TIMING_DECISION_INPUT_INVALID');
    }
    if (candidate === null || candidate === undefined) {
      if (relation.outcome !== 'no-valid-candidate') fail(`${label} decision row relation outcome does not match the proposal`, 'TIMING_SOURCE_BINDING');
    } else {
      requireDecisionRowFields(relation, ['outcome', 'source_sense', 'target_record', 'target_sense', 'type', 'direction', 'decision', 'noise_assessment', 'correction', 'note'], label);
      if (relation.outcome !== 'raw-proposal') fail(`${label} decision row relation outcome does not match the proposal`, 'TIMING_SOURCE_BINDING');
      for (const key of ['source_sense', 'target_record', 'target_sense', 'type', 'direction']) {
        if (JSON.stringify(relation[key]) !== JSON.stringify(candidate[key])) {
          fail(`${label} decision row relation ${key} does not match the proposal`, 'TIMING_SOURCE_BINDING');
        }
      }
    }
    return;
  }
  requireDecisionRowFields(row, ['editorial_record_sha256', 'source_comparison', 'decision_comparison', 'relation_comparison', 'status', 'note'], label);
}

async function readJudgmentSourceEvidence(kind, args, session, pass, proposalInfo) {
  const unitId = args.unit;
  if (!unitId) fail('judgment recording requires --unit=<case-id>', 'TIMING_SCOPE_MISMATCH');
  const expectedCase = proposalInfo.by_case.get(unitId);
  if (!expectedCase) fail(`${unitId} is outside proposal case set`, 'TIMING_SCOPE_MISMATCH');
  return {
    path: pass.judgment_evidence.path,
    source_artifact_sha256: kind === 'post-freeze-audit' ? session.editorial_decisions_sha256 : session.proposal_sha256,
    source_artifact_kind: kind === 'post-freeze-audit' ? 'editorial-decisions' : 'proposal',
    source_record_sha256: sha256Json(expectedCase.record),
    source_case_sha256: sha256Json(expectedCase.compact),
  };
}

async function loadBoundSources(session, args) {
  const proposalPath = resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH);
  const workloadPath = resolvePath(args.workload, DEFAULT_WORKLOAD_PATH);
  const { proposalInfo, workloadInfo, followUpSource } = await sourceInfo(
    proposalPath,
    workloadPath,
    resolvePath(args['follow-up-source'], DEFAULT_FOLLOW_UP_SOURCE_PATH),
    session.timing_kind === 'editorial' ? session.session_id : undefined,
    canonicalDirectoryForArgs(args),
  );
  if (proposalInfo.proposal_sha256 !== session.proposal_sha256) fail('proposal digest does not match timing session', 'TIMING_SOURCE_BINDING');
  if (workloadInfo.sha256 !== session.workload_sha256) fail('workload digest does not match timing session', 'TIMING_SOURCE_BINDING');
  return { proposalInfo, workloadInfo, followUpSource };
}

async function startPass(kind, args) {
  const { outputPath, session } = await loadOrCreateTiming(kind, args);
  const { workloadInfo } = await loadBoundSources(session, args);
  const passId = args.pass;
  const passList = passIds(kind);
  if (!passList.includes(passId)) fail(`${passId} is not a valid ${kind} pass`, 'UNKNOWN_TIMING_PASS');
  if (session.passes.some(({ status }) => status === 'in-progress')) fail('another timing pass is already active', 'TIMING_PASS_STATE');
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (session.passes[index].status !== 'unmeasured') fail(`${passId} is not unmeasured`, 'TIMING_PASS_STATE');
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) fail(`${passId} cannot start before earlier passes complete`, 'TIMING_PASS_ORDER');
  const declaration = workloadInfo.by_pass.get(passId);
  if (!declaration) fail(`${passId} has no frozen workload declaration`, 'WORKLOAD_SCOPE_MISMATCH');
  if (['feedback-fixes', 'final-verification', 'held-rejected'].includes(passId)
    && workloadInfo.workload.declaration_status !== 'frozen') {
    fail(`${passId} cannot start before the initial-review workload is frozen from recorder findings`, 'WORKLOAD_NOT_FROZEN');
  }
  const startedAt = now();
  if (Date.parse(declaration.declared_at) > Date.parse(startedAt)) fail(`${passId} workload was declared after pass start`, 'WORKLOAD_CHRONOLOGY');
  const logPath = workLogPath(kind, passId, outputPath, args['work-log']);
  const judgmentPath = judgmentLogPath(kind, passId, outputPath, args['judgment-log']);
  await requireMissing(logPath, `${passId} work log`);
  await requireMissing(judgmentPath, `${passId} judgment log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, '', 'utf8');
  await mkdir(path.dirname(judgmentPath), { recursive: true });
  await writeFile(judgmentPath, '', 'utf8');
  const pass = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: randomUUID(),
    workload_sha256: session.workload_sha256,
    work_status: declaration.empty_work ? 'zero-work' : 'work',
    work_evidence: {
      path: storedRepositoryPath(logPath),
      sha256: sha256Bytes(Buffer.alloc(0)),
      expected_unit_ids: [...declaration.expected_unit_ids],
      actual_unit_ids: [],
      unit_count: 0,
      expected_unit_set_sha256: declaration.expected_unit_set_sha256,
    },
    judgment_evidence: {
      path: storedRepositoryPath(judgmentPath),
      sha256: sha256Bytes(Buffer.alloc(0)),
      expected_unit_ids: [...declaration.expected_unit_ids],
      actual_unit_ids: [],
      unit_count: 0,
      expected_unit_set_sha256: declaration.expected_unit_set_sha256,
      event_ids: [],
    },
  };
  session.passes[index] = pass;
  session.events.push({
    event_id: eventId(session),
    kind: 'pass-start',
    pass_id: passId,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    recorded_at: startedAt,
    expected_unit_ids: [...declaration.expected_unit_ids],
    expected_unit_set_sha256: declaration.expected_unit_set_sha256,
  });
  await writeJson(outputPath, session);
  return { session, pass };
}

async function recordWork(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const passId = args.pass;
  const { index, pass } = activePass(session, passId);
  const declaration = workloadInfo.by_pass.get(passId);
  const input = parseInputJson(args['input-json']);
  assertNoVerdictKeys(input, `${passId} work input`);
  if (input.phase !== 'proposal') fail('M5-10D work accepts proposal facts only', 'PRODUCER_VERDICT_FORBIDDEN');
  const unitId = args.unit ?? input.case_id;
  if (!declaration.expected_unit_ids.includes(unitId)) fail(`${unitId} is outside the frozen ${passId} workload`, 'TIMING_SCOPE_MISMATCH');
  if (input.case_id !== unitId) fail(`${passId} input case_id does not match unit`, 'PRODUCER_INPUT_MISMATCH');
  if (pass.work_evidence.actual_unit_ids.includes(unitId)) fail(`${unitId} was already recorded in ${passId}`, 'TIMING_SCOPE_MISMATCH');
  const expectedCase = proposalInfo.compact_cases.find(({ case_id: caseId }) => caseId === unitId);
  if (!expectedCase) fail(`${unitId} is outside proposal case set`, 'PRODUCER_INPUT_MISMATCH');
  if (JSON.stringify(input) !== JSON.stringify(expectedCase)) fail(`${unitId} input facts do not match proposal`, 'PRODUCER_INPUT_MISMATCH');
  const inputPayloadSha256 = sha256Json(input);
  const producerStartedAt = now();
  const payload = produce({ unitId, unitKind: declaration.unit_kind, input });
  const producerCompletedAt = now();
  const row = {
    kind: 'work',
    pass_id: passId,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    recorded_at: producerCompletedAt,
    input: {
      payload_sha256: inputPayloadSha256,
      payload: input,
    },
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
  const logPath = resolvePath(pass.work_evidence.path);
  await appendFile(logPath, `${JSON.stringify(row)}\n`, 'utf8');
  const logBytes = await readFile(logPath);
  pass.work_evidence = {
    ...pass.work_evidence,
    sha256: sha256Bytes(logBytes),
    actual_unit_ids: [...pass.work_evidence.actual_unit_ids, unitId],
    unit_count: pass.work_evidence.unit_count + 1,
  };
  session.passes[index] = pass;
  session.events.push({
    event_id: eventId(session),
    kind: 'work-recorded',
    pass_id: passId,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    recorded_at: producerCompletedAt,
    producer_output_sha256: row.producer.output_sha256,
  });
  await writeJson(outputPath, session);
  return row;
}

async function recordProposal(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const passId = args.pass;
  activePass(session, passId);
  const declaration = workloadInfo.by_pass.get(passId);
  const rows = [];
  for (const unitId of declaration.expected_unit_ids) {
    const expectedCase = proposalInfo.by_case.get(unitId);
    rows.push(await recordWork(kind, {
      ...args,
      'input-json': JSON.stringify(expectedCase.compact),
      unit: unitId,
    }));
  }
  return rows;
}

async function startJudgment(kind, args) {
  rejectJudgmentInputAtStart(args);
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const { index, pass } = activePass(session, args.pass);
  const declaration = workloadInfo.by_pass.get(args.pass);
  const unitId = args.unit;
  if (!declaration.expected_unit_ids.includes(unitId)) fail(`${unitId} is outside the frozen ${args.pass} workload`, 'TIMING_SCOPE_MISMATCH');
  if (!pass.work_evidence.actual_unit_ids.includes(unitId)) {
    fail(`${args.pass}:${unitId} cannot be judged before its proposal work is recorded`, 'TIMING_SCOPE_MISMATCH');
  }
  if (pass.judgment_evidence.actual_unit_ids.includes(unitId)) fail(`${unitId} was already recorded in ${args.pass}`, 'TIMING_SCOPE_MISMATCH');
  if (session.active_judgments.some(({ pass_id: passId, unit_id: activeUnitId }) => passId === args.pass && activeUnitId === unitId)) {
    fail(`${unitId} already has an active judgment in ${args.pass}`, 'TIMING_JUDGMENT_STATE');
  }
  if (session.active_judgments.some(({ pass_id: passId }) => passId === args.pass)) {
    fail(`${args.pass} already has an active judgment`, 'TIMING_JUDGMENT_STATE');
  }
  const evidence = await readJudgmentSourceEvidence(kind, args, session, pass, proposalInfo);
  const startedAt = now();
  const judgment = {
    judgment_id: randomUUID(),
    pass_id: args.pass,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    started_at: startedAt,
    judgment_mode: session.judgment_mode,
    start_process_id: process.pid,
    start_invocation_id: randomUUID(),
    evidence,
  };
  session.active_judgments = [...(session.active_judgments ?? []), judgment];
  session.events.push({
    event_id: eventId(session),
    kind: 'judgment-started',
    pass_id: args.pass,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    judgment_id: judgment.judgment_id,
    recorded_at: startedAt,
    judgment_mode: session.judgment_mode,
    start_process_id: process.pid,
    start_invocation_id: judgment.start_invocation_id,
    source_artifact_sha256: evidence.source_artifact_sha256,
    source_record_sha256: evidence.source_record_sha256,
  });
  session.passes[index] = pass.judgment_window_started_at
    ? pass
    : { ...pass, judgment_window_started_at: startedAt };
  await writeJson(outputPath, session);
  return judgment;
}

async function completeJudgment(kind, args) {
  rejectFullDraftInput(args);
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const { index, pass } = activePass(session, args.pass);
  const active = (session.active_judgments ?? []).find(({ pass_id: passId, unit_id: unitId }) => passId === args.pass && (args.unit === undefined || unitId === args.unit));
  if (!active) fail(`${args.pass}${args.unit ? `:${args.unit}` : ''} has no active judgment`, 'TIMING_JUDGMENT_STATE');
  const unitId = active.unit_id;
  if (unitId !== pass.judgment_evidence.expected_unit_ids[pass.judgment_evidence.actual_unit_ids.length]) {
    fail(`${args.pass}:${unitId} judgment completed outside declared order`, 'TIMING_SCOPE_MISMATCH');
  }
  const expectedCase = proposalInfo.by_case.get(unitId);
  if (!expectedCase) fail(`${args.pass}:${unitId} judgment is outside proposal`, 'TIMING_SCOPE_MISMATCH');
  if (session.judgment_mode === MANUAL_JUDGMENT_MODE && active.start_process_id === process.pid) {
    fail('production judgment must be completed by a separate recorder invocation', 'TIMING_JUDGMENT_INVOCATION_REUSED');
  }
  const decisionInput = await parseDecisionRow(args, session.judgment_mode, active.started_at);
  const {
    row: decisionRow,
    inputKind,
    inputSha256,
    authoredAt: decisionRowAuthoredAt,
    inputMtime,
  } = decisionInput;
  validateDecisionRowInput(decisionRow, kind, pass, expectedCase, session.judgment_mode);
  const decisionRowSha256 = sha256Json(decisionRow);
  const completedAt = laterThan(decisionRowAuthoredAt);
  const completeInvocationId = randomUUID();
  const evidence = {
    ...active.evidence,
    decision_artifact_sha256: decisionRowSha256,
    decision_row_sha256: decisionRowSha256,
    decision_artifact_kind: 'recorder-owned-decision-row',
    decision_row_authored_at: decisionRowAuthoredAt,
    decision_input_kind: inputKind,
    decision_input_sha256: inputSha256,
    decision_input_authored_at: decisionRowAuthoredAt,
    ...(inputMtime === undefined ? {} : { decision_input_mtime_ms: inputMtime }),
  };
  const row = {
    kind: 'judgment',
    pass_id: args.pass,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    judgment_id: active.judgment_id,
    started_at: active.started_at,
    completed_at: completedAt,
    judgment_mode: session.judgment_mode,
    start_process_id: active.start_process_id,
    complete_process_id: process.pid,
    start_invocation_id: active.start_invocation_id,
    complete_invocation_id: completeInvocationId,
    decision_row_authored_at: decisionRowAuthoredAt,
    recorded_at: completedAt,
    decision_row: decisionRow,
    evidence,
  };
  const logPath = resolvePath(pass.judgment_evidence.path);
  await appendFile(logPath, `${JSON.stringify(row)}\n`, 'utf8');
  const logBytes = await readFile(logPath);
  const completionEventId = judgmentEventId(args.pass, unitId);
  pass.judgment_evidence = {
    ...pass.judgment_evidence,
    sha256: sha256Bytes(logBytes),
    actual_unit_ids: [...pass.judgment_evidence.actual_unit_ids, unitId],
    unit_count: pass.judgment_evidence.unit_count + 1,
    event_ids: [...pass.judgment_evidence.event_ids, completionEventId],
  };
  session.passes[index] = pass;
  session.active_judgments = (session.active_judgments ?? []).filter(({ judgment_id: judgmentId }) => judgmentId !== active.judgment_id);
  session.events.push({
    event_id: completionEventId,
    kind: 'judgment-completed',
    pass_id: args.pass,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    judgment_id: active.judgment_id,
    recorded_at: completedAt,
    completed_at: completedAt,
    judgment_mode: session.judgment_mode,
    start_process_id: active.start_process_id,
    complete_process_id: process.pid,
    start_invocation_id: active.start_invocation_id,
    complete_invocation_id: completeInvocationId,
    decision_artifact_sha256: evidence.decision_artifact_sha256,
    decision_row_sha256: evidence.decision_row_sha256,
  });
  await writeJson(outputPath, session);
  return row;
}

async function validateJudgmentArtifactForRecorder(row, pass, session, expectedCasesById) {
  const evidence = row.evidence;
  const expectedCase = expectedCasesById.get(row.unit_id);
  if (!expectedCase) fail(`${pass.id}:${row.unit_id} judgment is outside proposal`, 'TIMING_SCOPE_MISMATCH');
  if (evidence.decision_artifact_kind !== 'recorder-owned-decision-row') fail(`${pass.id}:${row.unit_id} judgment artifact provenance drifted`, 'TIMING_EDITORIAL_PROVENANCE');
  if (!row.decision_row || evidence.decision_row_sha256 !== sha256Json(row.decision_row)) fail(`${pass.id}:${row.unit_id} judgment row binding drifted`, 'TIMING_SOURCE_BINDING');
  if (row.decision_row.case_id !== row.unit_id || row.decision_row.source_record_sha256 !== expectedCase.source_record_sha256) fail(`${pass.id}:${row.unit_id} judgment source binding drifted`, 'TIMING_SOURCE_BINDING');
  const expectedSourceArtifactSha256 = session.timing_kind === 'post-freeze-audit'
    ? session.editorial_decisions_sha256
    : session.proposal_sha256;
  if (evidence.source_artifact_sha256 !== expectedSourceArtifactSha256) fail(`${pass.id}:${row.unit_id} judgment source artifact drifted`, 'TIMING_SOURCE_BINDING');
  if (row.judgment_mode !== session.judgment_mode) fail(`${pass.id}:${row.unit_id} judgment mode drifted`, 'TIMING_EDITORIAL_PROVENANCE');
  if (evidence.decision_input_kind === undefined || evidence.decision_input_sha256 === undefined) {
    fail(`${pass.id}:${row.unit_id} judgment input provenance is missing`, 'TIMING_EDITOR_WORK_MISSING');
  }
  if (evidence.decision_input_authored_at !== row.decision_row_authored_at) {
    fail(`${pass.id}:${row.unit_id} decision input authoring time drifted`, 'TIMING_SOURCE_BINDING');
  }
  validateM5DDecisionInputChronology({
    startedAt: row.started_at,
    authoredAt: row.decision_row_authored_at,
    label: `${pass.id}:${row.unit_id} decision input`,
  });
  if (row.start_invocation_id === row.complete_invocation_id) {
    fail(`${pass.id}:${row.unit_id} judgment start and completion invocation were reused`, 'TIMING_JUDGMENT_INVOCATION_REUSED');
  }
  if (session.judgment_mode === MANUAL_JUDGMENT_MODE && row.start_process_id === row.complete_process_id) {
    fail(`${pass.id}:${row.unit_id} production judgment start and completion ran in one process`, 'TIMING_JUDGMENT_INVOCATION_REUSED');
  }
}

async function stopPass(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const { index, pass } = activePass(session, args.pass);
  const declaration = workloadInfo.by_pass.get(args.pass);
  if (!declaration) fail(`${args.pass} has no frozen workload declaration`, 'WORKLOAD_SCOPE_MISMATCH');
  if (JSON.stringify(pass.work_evidence.actual_unit_ids) !== JSON.stringify(declaration.expected_unit_ids)) fail(`${args.pass} actual work does not exactly cover its frozen workload`, 'TIMING_SCOPE_MISMATCH');
  if ((session.active_judgments ?? []).some(({ pass_id: passId }) => passId === args.pass)) fail(`${args.pass} has an active judgment that was not completed`, 'TIMING_EDITOR_WORK_MISSING');
  await assertCanonicalAndInventoryUnchanged(
    session,
    `${args.pass} pass`,
    canonicalDirectoryForArgs(args),
    inventoryPathForArgs(args),
  );
  const completedAt = now();
  const elapsed = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
  const logBytes = await readFile(resolvePath(pass.work_evidence.path));
  const rows = logBytes.length === 0 ? [] : logBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const producerSeconds = rows.reduce((total, row) => total + ((Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000), 0);
  const judgmentLogBytes = await readFile(resolvePath(pass.judgment_evidence.path));
  const judgmentRows = judgmentLogBytes.length === 0
    ? []
    : judgmentLogBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const expectedCasesById = new Map(proposalInfo.compact_cases.map((item) => [item.case_id, item]));
  const expectedDecisionCasesById = proposalInfo.by_case;
  for (const row of judgmentRows) {
    if (row.pass_id !== args.pass || row.session_id !== session.session_id || row.pass_session_id !== pass.session_id) fail(`${args.pass}:${row.unit_id} judgment session binding drifted`, 'TIMING_SOURCE_BINDING');
    if (Date.parse(row.completed_at) > Date.parse(completedAt)) fail(`${args.pass}:${row.unit_id} judgment completed after pass stop`, 'TIMING_CHRONOLOGY');
    await validateJudgmentArtifactForRecorder(row, pass, session, expectedCasesById);
    const expectedCase = expectedDecisionCasesById.get(row.unit_id);
    validateDecisionRowInput(row.decision_row, kind, pass, expectedCase, session.judgment_mode);
  }
  const judgmentIds = judgmentRows.map(({ unit_id: unitId }) => unitId);
  if (JSON.stringify(judgmentIds) !== JSON.stringify(declaration.expected_unit_ids)) {
    if (declaration.expected_unit_ids.length > 0 && judgmentRows.length === 0) fail(`${args.pass} has producer work but no editor judgment events`, 'TIMING_EDITOR_WORK_MISSING');
    fail(`${args.pass} actual judgment does not exactly cover its frozen workload`, 'TIMING_EDITOR_WORK_MISSING');
  }
  const workStatus = declaration.expected_unit_ids.length === 0 ? 'zero-work' : 'work';
  const derivedTiming = deriveM5DPassTiming({
    ...pass,
    completed_at: completedAt,
    work_status: workStatus,
  }, judgmentRows);
  session.passes[index] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    work_status: workStatus,
    judgment_seconds: derivedTiming.judgmentSeconds,
    editor_seconds: derivedTiming.editorSeconds,
    wall_clock_seconds: elapsed,
    producer_seconds: producerSeconds,
    work_evidence: {
      ...pass.work_evidence,
      sha256: sha256Bytes(logBytes),
    },
    judgment_evidence: {
      ...pass.judgment_evidence,
      sha256: sha256Bytes(judgmentLogBytes),
      actual_unit_ids: judgmentIds,
      unit_count: judgmentRows.length,
      event_ids: judgmentIds.map((unitId) => judgmentEventId(args.pass, unitId)),
    },
  };
  session.events.push({
    event_id: eventId(session),
    kind: 'pass-stop',
    pass_id: args.pass,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    recorded_at: completedAt,
    work_status: workStatus,
    editor_seconds: session.passes[index].editor_seconds,
    judgment_seconds: derivedTiming.judgmentSeconds,
    wall_clock_seconds: elapsed,
    producer_seconds: producerSeconds,
    expected_unit_count: declaration.expected_unit_count,
    actual_unit_count: pass.work_evidence.unit_count,
    actual_judgment_count: judgmentRows.length,
  });
  await writeJson(outputPath, session);
  return session.passes[index];
}

async function finishSession(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  if (session.passes.some(({ status }) => status !== 'complete')) fail('all timing passes must be complete before finishing', 'TIMING_INCOMPLETE');
  if ((session.active_judgments ?? []).length > 0) fail('timing session has active judgment events', 'TIMING_EDITOR_WORK_MISSING');
  await assertCanonicalAndInventoryUnchanged(
    session,
    'timing session',
    canonicalDirectoryForArgs(args),
    inventoryPathForArgs(args),
  );
  const completedAt = now();
  session.status = 'complete';
  session.completed_at = completedAt;
  session.events.push({
    event_id: eventId(session),
    kind: 'session-stop',
    timing_kind: kind,
    session_id: session.session_id,
    recorded_at: completedAt,
  });
  session.recording_proof_sha256 = createM5DConcreteTimingProof(session);
  await writeJson(outputPath, session);
  return session;
}

async function readJsonlRows(filePath, label) {
  const bytes = await readFile(filePath);
  if (bytes.length > 0 && bytes.at(-1) !== 10) fail(`${label} is not newline-terminated`, 'TIMING_JUDGMENT_LOG_INVALID');
  return bytes.length === 0 ? [] : bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1} is invalid JSON: ${error.message}`, 'TIMING_JUDGMENT_LOG_INVALID');
    }
  });
}

async function freezeFollowUp(args) {
  const kind = 'editorial';
  rejectFullDraftInput(args);
  const outputPath = resolvePath(args.output, DEFAULT_EDITORIAL_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { proposalInfo, workloadInfo } = await loadBoundSources(session, args);
  const initial = session.passes.find(({ id }) => id === 'initial-review');
  if (!initial || initial.status !== 'complete') fail('initial-review must be complete before freezing follow-up work', 'WORKLOAD_FREEZE_STATE');
  if (session.passes.some(({ id, status }) => id !== 'target-preparation' && id !== 'initial-review' && status !== 'unmeasured')) {
    fail('follow-up workload must be frozen before any follow-up pass starts', 'WORKLOAD_FREEZE_STATE');
  }
  const initialRows = await readJsonlRows(resolvePath(initial.judgment_evidence.path), 'initial-review judgment log');
  if (initialRows.length !== proposalInfo.case_ids.length) fail('initial-review must have one judgment event per proposal case', 'TIMING_EDITOR_WORK_MISSING');
  const judgmentByUnit = new Map();
  for (const row of initialRows) {
    if (row.pass_id !== 'initial-review' || row.session_id !== session.session_id || row.pass_session_id !== initial.session_id) fail(`${row.unit_id} initial judgment session binding drifted`, 'WORKLOAD_SOURCE_BINDING');
    if (!row.decision_row || row.evidence.decision_row_sha256 !== sha256Json(row.decision_row)) fail(`${row.unit_id} initial judgment decision row is missing or drifted`, 'WORKLOAD_SOURCE_BINDING');
    judgmentByUnit.set(row.unit_id, row);
  }
  const freezeEventId = `m5-10d-workload-freeze-${String(session.events.length + 1).padStart(4, '0')}`;
  const createdAt = now();
  const findings = initialRows
    .map(({ decision_row: decisionRow }) => decisionRow)
    .filter(({ decision }) => ['corrected', 'held', 'rejected'].includes(decision))
    .map((decisionRow) => {
      const judgment = judgmentByUnit.get(decisionRow.case_id);
      if (!judgment) fail(`${decisionRow.case_id} follow-up source has no initial judgment`, 'WORKLOAD_SOURCE_BINDING');
      return {
        case_id: decisionRow.case_id,
        record_id: decisionRow.record_id,
        source_record_sha256: decisionRow.source_record_sha256,
        finding_kind: decisionRow.decision === 'corrected' ? 'correction' : decisionRow.decision,
        source_judgment_id: judgment.judgment_id,
        source_judgment_row_sha256: judgment.evidence.decision_row_sha256,
        note: `${decisionRow.case_id} follow-up queue was frozen from its completed initial-review judgment ${judgment.judgment_id}.`,
      };
    });
  const source = {
    schema_version: '1',
    artifact_id: 'm5-10d-follow-up-source-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'recorder-owned-initial-review-findings',
    proposal_sha256: session.proposal_sha256,
    timing_session_id: session.session_id,
    source_pass_id: 'initial-review',
    source_pass_session_id: initial.session_id,
    source_judgment_artifact_sha256: sha256Bytes(await readFile(resolvePath(initial.judgment_evidence.path))),
    freeze_event_id: freezeEventId,
    created_at: createdAt,
    findings,
    note: 'Follow-up queues were frozen from recorder-owned initial-review judgment events before any follow-up pass started.',
  };
  const sourcePath = resolvePath(args['follow-up-source'], DEFAULT_FOLLOW_UP_SOURCE_PATH);
  await requireMissing(sourcePath, 'follow-up source artifact');
  await writeJson(sourcePath, source);
  const sourceBytes = await readFile(sourcePath);
  const sourceWrapper = { value: source, sha256: sha256Bytes(sourceBytes) };
  validateM5DFollowUpSource(source, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: session.proposal_sha256,
    proposalCasesById: proposalInfo.by_case,
    timingSessionId: session.session_id,
    initialPassSessionId: initial.session_id,
    initialJudgmentRows: initialRows,
    initialJudgmentLogSha256: source.source_judgment_artifact_sha256,
    initialPass: initial,
    freezeEventId,
  });
  const workloadPath = resolvePath(args.workload, DEFAULT_WORKLOAD_PATH);
  const workloadSource = await readJson(workloadPath, 'M5-10D workload');
  const frozenAt = now();
  const frozenWorkload = freezeM5DWorkload(workloadSource.value, sourceWrapper, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: session.proposal_sha256,
    proposalCasesById: proposalInfo.by_case,
    followUpSha256: sourceWrapper.sha256,
    timingSessionId: session.session_id,
    freezeEventId,
    frozenAt,
  });
  await writeJson(workloadPath, frozenWorkload);
  const frozenWorkloadBytes = await readFile(workloadPath);
  const frozenWorkloadSha256 = sha256Bytes(frozenWorkloadBytes);
  session.workload_sha256 = frozenWorkloadSha256;
  session.workload_history = [
    ...(session.workload_history ?? []),
    { sha256: frozenWorkloadSha256, recorded_at: frozenAt },
  ];
  session.events.push({
    event_id: freezeEventId,
    kind: 'follow-up-workload-frozen',
    session_id: session.session_id,
    pass_id: 'initial-review',
    pass_session_id: initial.session_id,
    recorded_at: frozenAt,
    source_sha256: sourceWrapper.sha256,
    workload_sha256: frozenWorkloadSha256,
  });
  await writeJson(outputPath, session);
  return { source, workload: frozenWorkload, session };
}

async function decisionRowsFromTiming(timing, passIds, expectedCaseIds) {
  const rowsByCase = new Map();
  for (const passId of passIds) {
    const pass = timing.passes.find(({ id }) => id === passId);
    if (!pass) fail(`${passId} is missing from timing`, 'TIMING_SCOPE_MISMATCH');
    const rows = await readJsonlRows(resolvePath(pass.judgment_evidence.path), `${passId} judgment log`);
    for (const row of rows) {
      if (!row.decision_row || row.evidence?.decision_row_sha256 !== sha256Json(row.decision_row)) {
        fail(`${passId}:${row.unit_id} does not carry a recorder-owned decision row`, 'TIMING_EDITOR_WORK_MISSING');
      }
      rowsByCase.set(row.unit_id, row);
    }
  }
  return expectedCaseIds.map((caseId) => {
    const row = rowsByCase.get(caseId);
    if (!row) fail(`${caseId} has no recorder-owned decision row`, 'TIMING_EDITOR_WORK_MISSING');
    return row;
  });
}

function decisionRowsDigest(kind, proposalSha256, rows, editorialDecisionsSha256) {
  return sha256Json({
    kind,
    proposal_sha256: proposalSha256,
    ...(editorialDecisionsSha256 ? { editorial_decisions_sha256: editorialDecisionsSha256 } : {}),
    rows: rows.map(({ decision_row: decisionRow }) => decisionRow),
  });
}

function firstDecisionRowAuthoredAt(rows, label) {
  const timestamps = rows.map(({ decision_row_authored_at: authoredAt }) => {
    if (typeof authoredAt !== 'string' || !Number.isFinite(Date.parse(authoredAt))) fail(`${label} decision row authored time is missing`, 'TIMING_EDITOR_WORK_MISSING');
    return Date.parse(authoredAt);
  });
  return new Date(Math.min(...timestamps)).toISOString();
}

async function finalizeEditorial(args) {
  rejectFullDraftInput(args);
  if (args.draft) fail('editorial finalization derives rows from the recorder timing log; full drafts are not accepted', 'TIMING_DECISION_INPUT_FORBIDDEN');
  const timingPath = resolvePath(args.timing, DEFAULT_EDITORIAL_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'editorial timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'editorial') fail('editorial timing must be complete before freeze', 'TIMING_INCOMPLETE');
  const { proposalInfo } = await sourceInfo(
    resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH),
    resolvePath(args.workload, DEFAULT_WORKLOAD_PATH),
    resolvePath(args['follow-up-source'], DEFAULT_FOLLOW_UP_SOURCE_PATH),
    timing.session_id,
    canonicalDirectoryForArgs(args),
  );
  const decisionRows = await decisionRowsFromTiming(
    timing,
    ['initial-review', 'feedback-fixes', 'final-verification', 'held-rejected'],
    proposalInfo.case_ids,
  );
  const records = decisionRows.map(({ decision_row: decisionRow }) => decisionRow);
  const outputPath = resolvePath(args.output, DEFAULT_EDITORIAL_DECISIONS_PATH);
  await requireMissing(outputPath, 'editorial decisions artifact');
  const createdAt = now();
  const editorial = {
    schema_version: '1',
    artifact_id: 'm5-10d-editorial-decisions-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'recorder-owned',
    decision_source: 'recorder-owned-record-by-record-judgments',
    proposal_sha256: timing.proposal_sha256,
    editorial_session_id: timing.editorial_session_id,
    timing_session_id: timing.session_id,
    draft_sha256: decisionRowsDigest('editorial', timing.proposal_sha256, decisionRows),
    draft_created_at: firstDecisionRowAuthoredAt(decisionRows, 'editorial'),
    created_at: createdAt,
    finalized_at: laterThan(createdAt),
    records,
    note: 'Editorial decision rows were authored one at a time after each recorder judgment timer started and assembled only after all editorial passes stopped.',
  };
  await writeJson(outputPath, editorial);
  return editorial;
}

async function finalizeAudit(args) {
  rejectFullDraftInput(args);
  if (args.draft) fail('audit finalization derives rows from the recorder timing log; full drafts are not accepted', 'TIMING_DECISION_INPUT_FORBIDDEN');
  const timingPath = resolvePath(args.timing, DEFAULT_AUDIT_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'audit timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'post-freeze-audit') fail('audit timing must be complete before freeze', 'TIMING_INCOMPLETE');
  const editorialPath = resolvePath(args.editorial, DEFAULT_EDITORIAL_DECISIONS_PATH);
  const editorialSource = await readJson(editorialPath, 'editorial decisions');
  if (editorialSource.sha256 !== timing.editorial_decisions_sha256) fail('editorial decisions changed after audit timing started', 'AUDIT_SOURCE_BINDING');
  const { proposalInfo } = await sourceInfo(
    resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH),
    resolvePath(args.workload, DEFAULT_WORKLOAD_PATH),
    resolvePath(args['follow-up-source'], DEFAULT_FOLLOW_UP_SOURCE_PATH),
    undefined,
    canonicalDirectoryForArgs(args),
  );
  const decisionRows = await decisionRowsFromTiming(timing, ['post-freeze-audit'], proposalInfo.case_ids);
  const caseReviews = decisionRows.map(({ decision_row: decisionRow }) => decisionRow);
  let findings = [];
  if (args['findings-json'] !== undefined) {
    try {
      findings = JSON.parse(args['findings-json']);
    } catch (error) {
      fail(`--findings-json is not valid JSON: ${error.message}`, 'AUDIT_FINDINGS_INVALID');
    }
    if (!Array.isArray(findings)) fail('audit findings must be an array', 'AUDIT_FINDINGS_INVALID');
  }
  const outputPath = resolvePath(args.output, DEFAULT_AUDIT_DECISIONS_PATH);
  await requireMissing(outputPath, 'audit decisions artifact');
  const createdAt = now();
  const openBlockerCount = findings.filter(({ severity, status }) => severity === 'blocker' && status === 'open').length;
  const audit = {
    schema_version: '1',
    artifact_id: 'm5-10d-audit-decisions-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'recorder-owned',
    decision_source: 'recorder-owned-post-freeze-comparison-judgments',
    independent: true,
    proposal_sha256: timing.proposal_sha256,
    editorial_decisions_sha256: timing.editorial_decisions_sha256,
    editorial_session_id: timing.editorial_session_id,
    audit_session_id: timing.audit_session_id,
    timing_session_id: timing.session_id,
    draft_sha256: decisionRowsDigest('audit', timing.proposal_sha256, decisionRows, timing.editorial_decisions_sha256),
    draft_created_at: firstDecisionRowAuthoredAt(decisionRows, 'audit'),
    created_at: createdAt,
    finalized_at: laterThan(createdAt),
    status: 'complete',
    case_reviews: caseReviews,
    findings,
    open_blocker_count: openBlockerCount,
    note: 'Independent post-freeze comparisons were authored after the editorial artifact was frozen and during a separate audit timing session.',
  };
  await writeJson(outputPath, audit);
  return audit;
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

export async function runM5DRecorder(args) {
  const action = args.action;
  const kind = args.kind ?? 'editorial';
  if (action === 'start-pass') return startPass(kind, args);
  if (action === 'record-work') return recordWork(kind, args);
  if (action === 'record-proposal') return recordProposal(kind, args);
  if (action === 'start-judgment') return startJudgment(kind, args);
  if (action === 'complete-judgment') return completeJudgment(kind, args);
  if (action === 'stop-pass') return stopPass(kind, args);
  if (action === 'finish') return finishSession(kind, args);
  if (action === 'freeze-follow-up') return freezeFollowUp(args);
  if (action === 'freeze-editorial') return finalizeEditorial(args);
  if (action === 'freeze-audit') return finalizeAudit(args);
  fail(`unknown action ${String(action)}`, 'INVALID_ACTION');
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runM5DRecorder(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      if (error instanceof M5DRecoveryValidationError) console.error(`${error.code}: ${error.message}`);
      else console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

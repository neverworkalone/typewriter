/**
 * Current-clock recorder for M5-10D.
 *
 * Every pass is bound to a frozen workload declaration before it starts. The
 * recorder accepts only proposal facts, records producer execution separately,
 * and refuses missing, duplicate, or expanded work scopes. A zero-work pass is
 * explicit and contributes zero editor seconds.
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
  DEFAULT_INVENTORY_PATH,
  DEFAULT_PROPOSAL_PATH,
  DEFAULT_WORKLOAD_PATH,
  M5_10D_AUDIT_PASS_IDS,
  M5_10D_BATCH_ID,
  M5_10D_EDITORIAL_PASS_IDS,
  M5_10D_PROCESS_REVISION,
  M5DRecoveryValidationError,
  createM5DConcreteTimingProof,
  sha256Json,
  validateM5DProposal,
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
const RECORDER_VERSION = 'm5-10d-workload-timing-recorder-v1';
const RECORDING_SOURCE = 'workload-timing-recorder-v1';
const RECORDING_COMMAND = 'node scripts/batch/record-m5-10d-timing.mjs';
const DATE_SUFFIX = '20260912';

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

async function sourceInfo(proposalPath, workloadPath) {
  const proposal = await readJson(proposalPath, 'M5-10D calibration proposal');
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const proposalInfo = validateM5DProposal(proposal.value, { canonicalRecords: canonical.records });
  proposalInfo.proposal_sha256 = proposal.sha256;
  const workload = await readJson(workloadPath, 'M5-10D workload');
  const workloadInfo = validateM5DWorkload(workload.value, {
    proposalCaseIds: proposalInfo.case_ids,
    proposalSha256: proposal.sha256,
  });
  workloadInfo.sha256 = workload.sha256;
  return { proposal, proposalInfo, workload, workloadInfo };
}

async function assertCanonicalAndInventoryUnchanged(session, label) {
  const canonicalSha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventory = await readJson(DEFAULT_INVENTORY_PATH, 'M5 target inventory');
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
  const { proposal, proposalInfo, workload, workloadInfo } = await sourceInfo(proposalPath, workloadPath);
  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventory = await readJson(DEFAULT_INVENTORY_PATH, 'M5 target inventory');
  const session = {
    schema_version: '1',
    artifact_id: timingArtifactId(kind),
    batch_id: M5_10D_BATCH_ID,
    timing_kind: kind,
    measurement_kind: 'editor-judgment',
    recorder_version: RECORDER_VERSION,
    recording_source: RECORDING_SOURCE,
    recorder_command: RECORDING_COMMAND,
    session_id: randomUUID(),
    started_at: now(),
    status: 'in-progress',
    workload_artifact: storedRepositoryPath(workloadPath),
    workload_sha256: workload.sha256,
    proposal_sha256: proposal.sha256,
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory_sha256: inventory.sha256,
    passes: passIds(kind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    note: kind === 'editorial'
      ? 'Current-clock measurement starts before target preparation and semantic editorial judgment; follow-up queues come from the frozen workload artifact.'
      : 'Current-clock measurement starts after the editorial artifact is frozen for an independent full-sample audit.',
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

async function loadBoundSources(session, args) {
  const proposalPath = resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH);
  const workloadPath = resolvePath(args.workload, DEFAULT_WORKLOAD_PATH);
  const { proposalInfo, workloadInfo } = await sourceInfo(proposalPath, workloadPath);
  if (proposalInfo.proposal_sha256 !== session.proposal_sha256) fail('proposal digest does not match timing session', 'TIMING_SOURCE_BINDING');
  if (workloadInfo.sha256 !== session.workload_sha256) fail('workload digest does not match timing session', 'TIMING_SOURCE_BINDING');
  return { proposalInfo, workloadInfo };
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
  const startedAt = now();
  if (Date.parse(declaration.declared_at) > Date.parse(startedAt)) fail(`${passId} workload was declared after pass start`, 'WORKLOAD_CHRONOLOGY');
  const logPath = workLogPath(kind, passId, outputPath, args['work-log']);
  await requireMissing(logPath, `${passId} work log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, '', 'utf8');
  const pass = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: randomUUID(),
    work_status: declaration.empty_work ? 'zero-work' : 'work',
    work_evidence: {
      path: storedRepositoryPath(logPath),
      sha256: sha256Bytes(Buffer.alloc(0)),
      expected_unit_ids: [...declaration.expected_unit_ids],
      actual_unit_ids: [],
      unit_count: 0,
      expected_unit_set_sha256: declaration.expected_unit_set_sha256,
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

async function stopPass(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { workloadInfo } = await loadBoundSources(session, args);
  const { index, pass } = activePass(session, args.pass);
  const declaration = workloadInfo.by_pass.get(args.pass);
  if (!declaration) fail(`${args.pass} has no frozen workload declaration`, 'WORKLOAD_SCOPE_MISMATCH');
  if (JSON.stringify(pass.work_evidence.actual_unit_ids) !== JSON.stringify(declaration.expected_unit_ids)) fail(`${args.pass} actual work does not exactly cover its frozen workload`, 'TIMING_SCOPE_MISMATCH');
  await assertCanonicalAndInventoryUnchanged(session, `${args.pass} pass`);
  const completedAt = now();
  const elapsed = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
  const logBytes = await readFile(resolvePath(pass.work_evidence.path));
  const rows = logBytes.length === 0 ? [] : logBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const producerSeconds = rows.reduce((total, row) => total + ((Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000), 0);
  const workStatus = declaration.expected_unit_ids.length === 0 ? 'zero-work' : 'work';
  session.passes[index] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    work_status: workStatus,
    editor_seconds: workStatus === 'zero-work' ? 0 : elapsed,
    wall_clock_seconds: elapsed,
    producer_seconds: producerSeconds,
    work_evidence: {
      ...pass.work_evidence,
      sha256: sha256Bytes(logBytes),
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
    wall_clock_seconds: elapsed,
    producer_seconds: producerSeconds,
    expected_unit_count: declaration.expected_unit_count,
    actual_unit_count: pass.work_evidence.unit_count,
  });
  await writeJson(outputPath, session);
  return session.passes[index];
}

async function finishSession(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  if (session.passes.some(({ status }) => status !== 'complete')) fail('all timing passes must be complete before finishing', 'TIMING_INCOMPLETE');
  await assertCanonicalAndInventoryUnchanged(session, 'timing session');
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

function timingLastStop(timing) {
  return Math.max(...timing.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
}

function requireDraftRecords(draft, timing, kind, expectedCaseIds) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('decision draft must be an object', 'EDITORIAL_DRAFT_INVALID');
  if (draft.batch_id !== M5_10D_BATCH_ID) fail('decision draft batch ID drifted', 'EDITORIAL_DRAFT_INVALID');
  const expectedSource = kind === 'editorial'
    ? 'record-by-record-editorial-judgment'
    : 'independent-post-freeze-comparison';
  if (draft.draft_source !== expectedSource) fail('decision draft source does not match timing kind', 'EDITORIAL_DRAFT_PROVENANCE');
  const records = kind === 'editorial' ? draft.records : draft.case_reviews;
  if (!Array.isArray(records)) fail('decision draft records are missing', 'EDITORIAL_DRAFT_SCOPE');
  const ids = records.map(({ case_id: caseId }) => caseId);
  if (JSON.stringify(ids) !== JSON.stringify(expectedCaseIds)) fail('decision draft case coverage drifted', 'EDITORIAL_DRAFT_SCOPE');
  if (typeof draft.draft_created_at !== 'string' || !Number.isFinite(Date.parse(draft.draft_created_at))) fail('decision draft must carry draft_created_at', 'EDITORIAL_DRAFT_CHRONOLOGY');
  const firstPass = timing.passes.find(({ id }) => id === (kind === 'editorial' ? 'initial-review' : 'post-freeze-audit'));
  if (Date.parse(draft.draft_created_at) < Date.parse(firstPass.started_at) || Date.parse(draft.draft_created_at) > timingLastStop(timing)) fail('decision draft must be authored during the active timed session', 'EDITORIAL_DRAFT_CHRONOLOGY');
  return draft;
}

async function finalizeEditorial(args) {
  const timingPath = resolvePath(args.timing, DEFAULT_EDITORIAL_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'editorial timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'editorial') fail('editorial timing must be complete before freeze', 'TIMING_INCOMPLETE');
  const { proposalInfo } = await sourceInfo(resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH), resolvePath(args.workload, DEFAULT_WORKLOAD_PATH));
  const draftSource = await readJson(resolvePath(args.draft, '/private/tmp/typewriter-m5-10d-editorial-draft.json'), 'editorial decision draft');
  const draft = requireDraftRecords(draftSource.value, timing, 'editorial', proposalInfo.case_ids);
  if (draft.proposal_sha256 !== timing.proposal_sha256) fail('editorial draft proposal digest drifted', 'EDITORIAL_SOURCE_BINDING');
  const outputPath = resolvePath(args.output, DEFAULT_EDITORIAL_DECISIONS_PATH);
  await requireMissing(outputPath, 'editorial decisions artifact');
  const createdAt = now();
  const editorial = {
    schema_version: '1',
    artifact_id: 'm5-10d-editorial-decisions-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-record-by-record-editorial-draft',
    proposal_sha256: timing.proposal_sha256,
    editorial_session_id: timing.editorial_session_id,
    timing_session_id: timing.session_id,
    draft_created_at: draft.draft_created_at,
    created_at: createdAt,
    finalized_at: laterThan(createdAt),
    records: draft.records,
    note: 'Editorial decisions were separately authored during the timed semantic pass and finalized only after all editorial passes stopped.',
  };
  await writeJson(outputPath, editorial);
  return editorial;
}

async function finalizeAudit(args) {
  const timingPath = resolvePath(args.timing, DEFAULT_AUDIT_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'audit timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'post-freeze-audit') fail('audit timing must be complete before freeze', 'TIMING_INCOMPLETE');
  const editorialPath = resolvePath(args.editorial, DEFAULT_EDITORIAL_DECISIONS_PATH);
  const editorialSource = await readJson(editorialPath, 'editorial decisions');
  if (editorialSource.sha256 !== timing.editorial_decisions_sha256) fail('editorial decisions changed after audit timing started', 'AUDIT_SOURCE_BINDING');
  const { proposalInfo } = await sourceInfo(resolvePath(args.proposal, DEFAULT_PROPOSAL_PATH), resolvePath(args.workload, DEFAULT_WORKLOAD_PATH));
  const draftSource = await readJson(resolvePath(args.draft, '/private/tmp/typewriter-m5-10d-audit-draft.json'), 'audit decision draft');
  const draft = requireDraftRecords(draftSource.value, timing, 'audit', proposalInfo.case_ids);
  if (draft.proposal_sha256 !== timing.proposal_sha256) fail('audit draft proposal digest drifted', 'AUDIT_SOURCE_BINDING');
  if (draft.editorial_decisions_sha256 !== timing.editorial_decisions_sha256) fail('audit draft editorial digest drifted', 'AUDIT_SOURCE_BINDING');
  const outputPath = resolvePath(args.output, DEFAULT_AUDIT_DECISIONS_PATH);
  await requireMissing(outputPath, 'audit decisions artifact');
  const createdAt = now();
  const findings = Array.isArray(draft.findings) ? draft.findings : [];
  const openBlockerCount = findings.filter(({ severity, status }) => severity === 'blocker' && status === 'open').length;
  const audit = {
    schema_version: '1',
    artifact_id: 'm5-10d-audit-decisions-20260912',
    batch_id: M5_10D_BATCH_ID,
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-post-freeze-comparison',
    independent: true,
    proposal_sha256: timing.proposal_sha256,
    editorial_decisions_sha256: timing.editorial_decisions_sha256,
    editorial_session_id: timing.editorial_session_id,
    audit_session_id: timing.audit_session_id,
    timing_session_id: timing.session_id,
    draft_created_at: draft.draft_created_at,
    created_at: createdAt,
    finalized_at: laterThan(createdAt),
    status: 'complete',
    case_reviews: draft.case_reviews,
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
  if (action === 'stop-pass') return stopPass(kind, args);
  if (action === 'finish') return finishSession(kind, args);
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

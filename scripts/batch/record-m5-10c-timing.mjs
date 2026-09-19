/**
 * Recorder for M5-10C's editor-time recovery calibration.
 *
 * The proposal is an external, temporary artifact. This recorder stores only
 * compact proposal facts and proposal-only producer output in the repository.
 * Editorial decisions are supplied separately as a draft while the timed
 * session is active, then finalized after the recorder stops.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BATCH_DIRECTORY,
  DEFAULT_AUDIT_DECISIONS_PATH,
  DEFAULT_AUDIT_TIMING_PATH,
  DEFAULT_CANONICAL_DIRECTORY,
  DEFAULT_EDITORIAL_DECISIONS_PATH,
  DEFAULT_EDITORIAL_TIMING_PATH,
  M5_10C_AUDIT_PASS_IDS,
  M5_10C_BATCH_ID,
  M5_10C_CASE_COUNT,
  M5_10C_EDITORIAL_PASS_IDS,
  M5_10C_PROCESS_REVISION,
  M5CRecoveryValidationError,
  createM5CConcreteTimingProof,
  sha256Json,
  validateM5CProposal,
} from './validate-m5-10c-recovery.mjs';
import { hashCanonicalDirectory } from './validate-m5-8-process.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import {
  DEFAULT_SEED_PATH,
  buildTargetInventory,
  serializeTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import {
  M5_10C_PRODUCER_VERSION,
  produce,
  proposalInputFromCase,
} from './produce-m5-10c-work.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const RECORDER_VERSION = 'm5-10c-timing-recorder-v1';
const RECORDING_SOURCE = 'timing-recorder-v1';
const RECORDING_COMMAND = 'node scripts/batch/record-m5-10c-timing.mjs';
const DATE_SUFFIX = '20260910';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CASE_ID_PATTERN = /^m5-10c-cal-[0-9]{3}$/u;
const FORBIDDEN_VERDICT_KEYS = Object.freeze([
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
const AUDIT_FINDING_ID_PATTERN = /^m5-10c-audit-[a-z0-9-]+$/u;
const AUDIT_FINDING_CATEGORIES = Object.freeze(['source', 'sense', 'relation', 'timing', 'provenance']);
const AUDIT_FINDING_FIELDS = new Set(['id', 'severity', 'status', 'category', 'case_id', 'note']);

export const M5_10C_RECORDER_VERSION = RECORDER_VERSION;
export const M5_10C_RECORDING_SOURCE = RECORDING_SOURCE;
export const M5_10C_RECORDING_COMMAND = RECORDING_COMMAND;

class M5CRecorderError extends Error {
  constructor(message, code = 'M5_10C_RECORDING_ERROR') {
    super(message);
    this.name = 'M5CRecorderError';
    this.code = code;
  }
}

function fail(message, code = 'M5_10C_RECORDING_ERROR') {
  throw new M5CRecorderError(message, code);
}

function now() {
  return new Date().toISOString();
}

function laterThan(timestamp) {
  const minimum = Date.parse(timestamp) + 1;
  return new Date(Math.max(Date.now(), minimum)).toISOString();
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${label} must be a UUIDv4`, 'INVALID_SESSION_ID');
  return value;
}

function requireCaseId(value, label = 'case_id') {
  if (typeof value !== 'string' || !CASE_ID_PATTERN.test(value)) fail(`${label} must be an M5-10C case ID`, 'TIMING_SCOPE_MISMATCH');
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

async function readCurrentInventory() {
  const value = await buildTargetInventory({
    canonicalDirectory: DEFAULT_CANONICAL_DIRECTORY,
    seedPath: DEFAULT_SEED_PATH,
  });
  const bytes = serializeTargetInventory(value);
  return { value, bytes, sha256: sha256Bytes(bytes) };
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_VERDICT_KEYS.includes(key)) fail(`${label} contains forbidden verdict key ${key}`, 'PRODUCER_VERDICT_FORBIDDEN');
    assertNoVerdictKeys(child, `${label}.${key}`);
  }
}

function passIds(kind) {
  if (kind === 'editorial') return M5_10C_EDITORIAL_PASS_IDS;
  if (kind === 'post-freeze-audit') return M5_10C_AUDIT_PASS_IDS;
  fail('--kind must be editorial or post-freeze-audit', 'INVALID_TIMING_KIND');
}

function timingArtifactId(kind) {
  return `m5-10c-${kind === 'editorial' ? 'editorial' : 'audit'}-timing-${DATE_SUFFIX}`;
}

function workLogPath(kind, passId) {
  const kindPart = kind === 'editorial' ? 'editorial' : 'audit';
  return path.join(BATCH_DIRECTORY, `m5-10c-${kindPart}-work-${passId}-${DATE_SUFFIX}.jsonl`);
}

async function assertCanonicalAndInventoryUnchanged(session, label) {
  const canonicalSha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventory = await readCurrentInventory();
  if (canonicalSha256 !== session.canonical_directory_sha256) fail(`${label} changed canonical data`, 'CALIBRATION_CANONICAL_MUTATION');
  if (inventory.sha256 !== session.inventory_sha256) fail(`${label} changed target inventory`, 'CALIBRATION_INVENTORY_MUTATION');
}

async function proposalSource(proposalPath) {
  const source = await readJson(proposalPath, 'M5-10C calibration proposal');
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const info = validateM5CProposal(source.value, { canonicalRecords: canonical.records });
  return { ...source, info };
}

function activePass(session, passId) {
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) fail(`${passId} is not part of the ${session.timing_kind} timing contract`, 'UNKNOWN_TIMING_PASS');
  const pass = session.passes[index];
  if (pass.status !== 'in-progress') fail(`${passId} is not an active recorder pass`, 'TIMING_PASS_STATE');
  return { index, pass };
}

function currentSessionId(session, passId) {
  const { pass } = activePass(session, passId);
  requireUuid(pass.session_id, `${passId}.session_id`);
  return pass.session_id;
}

function eventId(session) {
  return `m5-10c-timing-event-${String(session.events.length + 1).padStart(4, '0')}`;
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
  const proposal = await proposalSource(resolvePath(args.proposal, '/private/tmp/typewriter-m5-10c-calibration-proposal.json'));
  const canonicalDirectorySha256 = await hashCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY);
  const inventory = await readCurrentInventory();
  const session = {
    schema_version: '1',
    artifact_id: timingArtifactId(kind),
    batch_id: M5_10C_BATCH_ID,
    timing_kind: kind,
    measurement_kind: 'editor-judgment',
    recorder_version: RECORDER_VERSION,
    recording_source: RECORDING_SOURCE,
    recorder_command: RECORDING_COMMAND,
    session_id: randomUUID(),
    started_at: now(),
    status: 'in-progress',
    proposal_sha256: proposal.sha256,
    canonical_directory_sha256: canonicalDirectorySha256,
    inventory_sha256: inventory.sha256,
    passes: passIds(kind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    note: kind === 'editorial'
      ? 'Current-clock measurement begins before record-by-record semantic inspection and separately authored editorial judgment.'
      : 'Current-clock measurement begins after editorial freeze for an independent post-freeze audit; this timing cannot reuse editorial decisions as the audit output.',
  };
  if (kind === 'editorial') {
    session.editorial_session_id = randomUUID();
  } else {
    const editorialPath = resolvePath(args.editorial, DEFAULT_EDITORIAL_DECISIONS_PATH);
    const editorial = await readJson(editorialPath, 'M5-10C editorial decisions');
    if (editorial.value.proposal_sha256 !== proposal.sha256) fail('audit proposal digest does not match editorial proposal digest', 'SOURCE_BINDING_MISMATCH');
    if (!UUID_PATTERN.test(editorial.value.editorial_session_id)) fail('editorial decisions do not carry a valid editorial session ID', 'SOURCE_BINDING_MISMATCH');
    session.editorial_session_id = editorial.value.editorial_session_id;
    session.audit_session_id = randomUUID();
    session.editorial_decisions_sha256 = editorial.sha256;
    session.editorial_finalized_at = editorial.value.finalized_at;
  }
  session.events.push({
    event_id: eventId(session),
    kind: 'session-start',
    timing_kind: kind,
    session_id: session.session_id,
    recorded_at: session.started_at,
    proposal_sha256: proposal.sha256,
    ...(kind === 'post-freeze-audit' ? {
      editorial_session_id: session.editorial_session_id,
      audit_session_id: session.audit_session_id,
      editorial_decisions_sha256: session.editorial_decisions_sha256,
    } : { editorial_session_id: session.editorial_session_id }),
  });
  return session;
}

async function loadTiming(outputPath, kind) {
  const source = await readJson(outputPath, 'M5-10C timing session');
  if (source.value.artifact_id !== timingArtifactId(kind) || source.value.timing_kind !== kind) {
    fail('timing session artifact or kind does not match the command', 'TIMING_SOURCE_BINDING');
  }
  if (source.value.batch_id !== M5_10C_BATCH_ID || source.value.recorder_version !== RECORDER_VERSION) {
    fail('timing session was not created by the M5-10C recorder', 'TIMING_PROVENANCE_REQUIRED');
  }
  if (source.value.status !== 'in-progress') fail('timing session is not in progress', 'TIMING_SESSION_STATE');
  return source.value;
}

async function loadOrCreateTiming(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  try {
    return { outputPath, session: await loadTiming(outputPath, kind) };
  } catch (error) {
    if (!(error instanceof M5CRecorderError) || error.code !== 'MISSING_ARTIFACT') throw error;
    const session = await createTimingSession(kind, args);
    await requireMissing(outputPath, 'timing session artifact');
    await writeJson(outputPath, session);
    return { outputPath, session };
  }
}

async function startPass(kind, args) {
  const { outputPath, session } = await loadOrCreateTiming(kind, args);
  const passId = args.pass;
  const passList = passIds(kind);
  if (!passList.includes(passId)) fail(`${passId} is not a valid ${kind} pass`, 'UNKNOWN_TIMING_PASS');
  if (session.passes.some(({ status }) => status === 'in-progress')) fail('another timing pass is already active', 'TIMING_PASS_STATE');
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (session.passes[index].status !== 'unmeasured') fail(`${passId} is not unmeasured`, 'TIMING_PASS_STATE');
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) fail(`${passId} cannot start before earlier passes complete`, 'TIMING_PASS_ORDER');
  const logPath = workLogPath(kind, passId);
  await requireMissing(logPath, `${passId} work log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, '', 'utf8');
  const startedAt = now();
  const pass = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: randomUUID(),
    work_evidence: {
      path: storedRepositoryPath(logPath),
      sha256: sha256Bytes(Buffer.alloc(0)),
      unit_count: 0,
      unit_ids: [],
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
  });
  await writeJson(outputPath, session);
  return { session, pass };
}

async function recordWork(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const passId = args.pass;
  const { index, pass } = activePass(session, passId);
  const input = parseInputJson(args['input-json']);
  assertNoVerdictKeys(input, `${passId} work input`);
  if (input.phase !== 'proposal') fail('M5-10C timing work accepts proposal facts only', 'PRODUCER_VERDICT_FORBIDDEN');
  const unitId = requireCaseId(args.unit ?? input.case_id, 'unit');
  if (input.case_id !== unitId) fail(`${passId} input case_id does not match unit`, 'PRODUCER_INPUT_MISMATCH');
  if (pass.work_evidence.unit_ids.includes(unitId)) fail(`${unitId} was already recorded in ${passId}`, 'TIMING_SCOPE_MISMATCH');
  const proposal = await proposalSource(resolvePath(args.proposal, '/private/tmp/typewriter-m5-10c-calibration-proposal.json'));
  if (proposal.sha256 !== session.proposal_sha256) fail('proposal digest does not match timing session', 'TIMING_SOURCE_BINDING');
  const expectedInput = proposal.info.compact_cases.find(({ case_id: caseId }) => caseId === unitId);
  if (!expectedInput) fail(`${unitId} is outside the proposal case set`, 'PRODUCER_INPUT_MISMATCH');
  if (JSON.stringify(input) !== JSON.stringify(expectedInput)) fail(`${unitId} input facts do not match the external proposal`, 'PRODUCER_INPUT_MISMATCH');
  const payloadSha256 = sha256Json(input);
  const producerStartedAt = now();
  const payload = produce({
    unitId,
    unitKind: args['unit-kind'] ?? 'calibration-start',
    input,
  });
  const producerCompletedAt = now();
  const row = {
    kind: 'work',
    pass_id: passId,
    session_id: session.session_id,
    pass_session_id: pass.session_id,
    unit_id: unitId,
    recorded_at: producerCompletedAt,
    input: {
      payload_sha256: payloadSha256,
      payload: input,
    },
    producer: {
      module: 'scripts/batch/produce-m5-10c-work.mjs',
      export: 'produce',
      version: M5_10C_PRODUCER_VERSION,
      input_payload_sha256: payloadSha256,
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
    path: storedRepositoryPath(logPath),
    sha256: sha256Bytes(logBytes),
    unit_count: pass.work_evidence.unit_count + 1,
    unit_ids: [...pass.work_evidence.unit_ids, unitId],
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
  const proposal = await proposalSource(resolvePath(args.proposal, '/private/tmp/typewriter-m5-10c-calibration-proposal.json'));
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  if (session.proposal_sha256 !== proposal.sha256) fail('proposal digest does not match timing session', 'TIMING_SOURCE_BINDING');
  const passId = args.pass;
  activePass(session, passId);
  const rows = [];
  for (const item of proposal.value.cases) {
    const input = proposalInputFromCase(item);
    rows.push(await recordWork(kind, {
      ...args,
      'input-json': JSON.stringify(input),
      unit: item.case_id,
    }));
  }
  return rows;
}

async function stopPass(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  const { index, pass } = activePass(session, args.pass);
  if (pass.work_evidence.unit_count !== M5_10C_CASE_COUNT) {
    fail(`${args.pass} must record all ${M5_10C_CASE_COUNT} calibration cases before stopping`, 'TIMING_SCOPE_MISMATCH');
  }
  await assertCanonicalAndInventoryUnchanged(session, `${args.pass} pass`);
  const completedAt = now();
  const editorSeconds = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
  const logBytes = await readFile(resolvePath(pass.work_evidence.path));
  const rows = logBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const producerSeconds = rows.reduce((total, row) => total + ((Date.parse(row.producer.completed_at) - Date.parse(row.producer.started_at)) / 1000), 0);
  session.passes[index] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    editor_seconds: editorSeconds,
    wall_clock_seconds: editorSeconds,
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
    editor_seconds: editorSeconds,
    wall_clock_seconds: editorSeconds,
    producer_seconds: producerSeconds,
    unit_count: pass.work_evidence.unit_count,
  });
  await writeJson(outputPath, session);
  return session.passes[index];
}

async function finishSession(kind, args) {
  const outputPath = resolvePath(args.output, kind === 'editorial' ? DEFAULT_EDITORIAL_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH);
  const session = await loadTiming(outputPath, kind);
  if (session.passes.some(({ status }) => status !== 'complete')) fail('all timing passes must be complete before finishing the session', 'TIMING_INCOMPLETE');
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
  session.recording_proof_sha256 = createM5CConcreteTimingProof(session);
  await writeJson(outputPath, session);
  return session;
}

function timingLastStop(timing) {
  return Math.max(...timing.passes.map(({ completed_at: completedAt }) => Date.parse(completedAt)));
}

function requireDraftRecords(draft, timing, kind) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('decision draft must be an object', 'EDITORIAL_DRAFT_INVALID');
  if (draft.batch_id !== M5_10C_BATCH_ID) fail('decision draft batch ID drifted', 'EDITORIAL_DRAFT_INVALID');
  if (draft.draft_source !== (kind === 'editorial' ? 'record-by-record-editorial-judgment' : 'independent-post-freeze-comparison')) {
    fail('decision draft source does not match the timing kind', 'EDITORIAL_DRAFT_PROVENANCE');
  }
  if (!Array.isArray(draft.records) || draft.records.length !== M5_10C_CASE_COUNT) fail(`decision draft must contain ${M5_10C_CASE_COUNT} records`, 'EDITORIAL_DRAFT_SCOPE');
  const ids = draft.records.map(({ case_id: caseId }) => requireCaseId(caseId));
  const expected = Array.from({ length: M5_10C_CASE_COUNT }, (_, index) => `m5-10c-cal-${String(index + 1).padStart(3, '0')}`);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) fail('decision draft case coverage drifted', 'EDITORIAL_DRAFT_SCOPE');
  const draftCreatedAt = draft.draft_created_at;
  if (typeof draftCreatedAt !== 'string' || !Number.isFinite(Date.parse(draftCreatedAt))) fail('decision draft must carry draft_created_at', 'EDITORIAL_DRAFT_CHRONOLOGY');
  if (Date.parse(draftCreatedAt) < Date.parse(timing.started_at) || Date.parse(draftCreatedAt) > timingLastStop(timing)) {
    fail('decision draft must be created during the active timed session', 'EDITORIAL_DRAFT_CHRONOLOGY');
  }
  assertNoVerdictKeys(draft.proposal_facts ?? {}, 'decision draft proposal facts');
  return draft;
}

export function validateM5CAuditDraftFindings(findings, expectedCaseIds = Array.from(
  { length: M5_10C_CASE_COUNT },
  (_, index) => `m5-10c-cal-${String(index + 1).padStart(3, '0')}`,
)) {
  if (!Array.isArray(findings)) fail('audit decision draft must carry a findings array', 'AUDIT_DRAFT_FINDINGS_INVALID');
  const expectedCases = new Set(expectedCaseIds);
  const findingIds = new Set();
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      fail('audit finding must be an object', 'AUDIT_DRAFT_FINDINGS_INVALID');
    }
    if (Object.keys(finding).some((field) => !AUDIT_FINDING_FIELDS.has(field))) {
      fail('audit finding contains an unsupported field', 'AUDIT_DRAFT_FINDINGS_INVALID');
    }
    for (const field of ['id', 'severity', 'status', 'category', 'case_id', 'note']) {
      if (typeof finding[field] !== 'string' || finding[field].trim().length === 0) {
        fail(`audit finding is missing ${field}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
      }
    }
    if (!AUDIT_FINDING_ID_PATTERN.test(finding.id)) fail(`audit finding ID is invalid: ${finding.id}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
    if (findingIds.has(finding.id)) fail(`audit finding ID is duplicated: ${finding.id}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
    findingIds.add(finding.id);
    if (!['warning', 'blocker'].includes(finding.severity)) fail(`audit finding severity is invalid: ${finding.severity}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
    if (!['open', 'closed'].includes(finding.status)) fail(`audit finding status is invalid: ${finding.status}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
    if (!AUDIT_FINDING_CATEGORIES.includes(finding.category)) fail(`audit finding category is invalid: ${finding.category}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
    if (!expectedCases.has(finding.case_id)) fail(`audit finding case is outside the calibration sample: ${finding.case_id}`, 'AUDIT_DRAFT_FINDINGS_INVALID');
  }
  return {
    findings,
    open_blocker_count: findings.filter(({ severity, status }) => severity === 'blocker' && status === 'open').length,
  };
}

async function finalizeEditorial(args) {
  const timingPath = resolvePath(args.timing, DEFAULT_EDITORIAL_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'editorial timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'editorial') fail('editorial timing must be complete before freeze', 'TIMING_INCOMPLETE');
  const draftSource = await readJson(resolvePath(args.draft, '/private/tmp/typewriter-m5-10c-editorial-draft.json'), 'editorial decision draft');
  const draft = requireDraftRecords(draftSource.value, timing, 'editorial');
  if (draft.proposal_sha256 !== timing.proposal_sha256) fail('editorial draft proposal digest drifted', 'EDITORIAL_SOURCE_BINDING');
  const outputPath = resolvePath(args.output, DEFAULT_EDITORIAL_DECISIONS_PATH);
  await requireMissing(outputPath, 'editorial decisions artifact');
  const createdAt = now();
  const editorial = {
    schema_version: '1',
    artifact_id: 'm5-10c-editorial-decisions-20260910',
    batch_id: M5_10C_BATCH_ID,
    source_kind: 'codex-authored',
    decision_source: 'separately-authored-record-by-record-editorial-draft',
    proposal_sha256: timing.proposal_sha256,
    editorial_session_id: timing.editorial_session_id,
    timing_session_id: timing.session_id,
    draft_created_at: draft.draft_created_at,
    created_at: createdAt,
    finalized_at: laterThan(createdAt),
    records: draft.records,
    note: 'Editorial judgments were authored from compact proposal facts during the timed session, then recorder-finalized after all five editorial passes stopped.',
  };
  await writeJson(outputPath, editorial);
  return editorial;
}

async function finalizeAudit(args) {
  const timingPath = resolvePath(args.timing, DEFAULT_AUDIT_TIMING_PATH);
  const timingSource = await readJson(timingPath, 'audit timing');
  const timing = timingSource.value;
  if (timing.status !== 'complete' || timing.timing_kind !== 'post-freeze-audit') fail('audit timing must be complete before audit freeze', 'TIMING_INCOMPLETE');
  const editorialPath = resolvePath(args.editorial, DEFAULT_EDITORIAL_DECISIONS_PATH);
  const editorialSource = await readJson(editorialPath, 'editorial decisions');
  if (editorialSource.sha256 !== timing.editorial_decisions_sha256) fail('editorial decisions changed after audit timing started', 'AUDIT_SOURCE_BINDING');
  const draftSource = await readJson(resolvePath(args.draft, '/private/tmp/typewriter-m5-10c-audit-draft.json'), 'audit decision draft');
  const draft = requireDraftRecords(draftSource.value, timing, 'post-freeze-audit');
  if (draft.proposal_sha256 !== timing.proposal_sha256) fail('audit draft proposal digest drifted', 'AUDIT_SOURCE_BINDING');
  if (draft.editorial_decisions_sha256 !== timing.editorial_decisions_sha256) fail('audit draft editorial freeze digest drifted', 'AUDIT_SOURCE_BINDING');
  const findingSummary = validateM5CAuditDraftFindings(draft.findings);
  const outputPath = resolvePath(args.output, DEFAULT_AUDIT_DECISIONS_PATH);
  await requireMissing(outputPath, 'audit decisions artifact');
  const createdAt = now();
  const audit = {
    schema_version: '1',
    artifact_id: 'm5-10c-audit-decisions-20260910',
    batch_id: M5_10C_BATCH_ID,
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
    case_reviews: draft.records,
    findings: findingSummary.findings,
    open_blocker_count: findingSummary.open_blocker_count,
    note: 'Independent post-freeze comparison was authored after editorial decisions were frozen and after a separate audit timing session started.',
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

export async function runRecorder(args) {
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

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runRecorder(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      if (error instanceof M5CRecoveryValidationError) {
        console.error(error.message);
      } else {
        console.error(error.message);
      }
      process.exitCode = 1;
    });
}

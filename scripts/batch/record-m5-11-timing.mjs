/**
 * Current-clock recorder for M5-11 editorial and independent-audit timing.
 *
 * The command owns all timestamps. Callers provide only the frozen pass scope
 * and source digests; timestamp or duration overrides are rejected. A pass is
 * started and stopped in separate invocations, and the stop invocation emits
 * contiguous recorder work events that cover the observed wall-clock interval.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createM511TimingProof,
  M5_11_AUDIT_TIMING_PASS_IDS,
  M5_11_EDITORIAL_TIMING_PASS_IDS,
  M5_11_TIMING_CLOCK_SOURCE,
  M5_11_TIMING_RECORDING_COMMAND,
  M5_11_TIMING_RECORDER_VERSION,
} from './validate-m5-11-admission.mjs';
import { M5_11_BATCH_ID, sha256Json } from './m5-11-editorial.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

export class M511TimingRecorderError extends Error {
  constructor(message, code = 'M5_11_TIMING_RECORDER_ERROR') {
    super(message);
    this.name = 'M511TimingRecorderError';
    this.code = code;
  }
}

function fail(message, code = 'M5_11_TIMING_RECORDER_ERROR') {
  throw new M511TimingRecorderError(message, code);
}

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      fail(`arguments must use --name=value form (received ${argument})`, 'INVALID_ARGUMENT');
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

function now() {
  return new Date().toISOString();
}

function timingKindForPass(passId) {
  if (M5_11_EDITORIAL_TIMING_PASS_IDS.includes(passId)) return 'editorial';
  if (M5_11_AUDIT_TIMING_PASS_IDS.includes(passId)) return 'post-freeze-audit';
  fail(`--pass must be one of ${[...M5_11_EDITORIAL_TIMING_PASS_IDS, ...M5_11_AUDIT_TIMING_PASS_IDS].join(', ')}`, 'INVALID_PASS');
}

function passIdsForKind(timingKind) {
  return timingKind === 'editorial'
    ? M5_11_EDITORIAL_TIMING_PASS_IDS
    : M5_11_AUDIT_TIMING_PASS_IDS;
}

function requireDigest(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(`${label} must be a SHA-256 digest`, 'SOURCE_DIGEST_REQUIRED');
  return value;
}

function storedExternalPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (!relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain outside the repository`, 'EXTERNAL_INPUT_REQUIRED');
  }
  return resolved;
}

function outputPathFor(args) {
  const selected = args.output ?? args.input;
  if (!selected) fail('--output=... is required', 'MISSING_ARGUMENT');
  return storedExternalPath(selected, 'M5-11 timing output');
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_INPUT');
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function requireNewOutput(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`refusing to overwrite an existing timing session: ${filePath}`, 'OUTPUT_EXISTS');
}

async function unitIdsFromArgs(args) {
  if (args['unit-ids-file']) {
    const filePath = storedExternalPath(args['unit-ids-file'], 'M5-11 unit scope');
    const value = await readJson(filePath, 'M5-11 unit scope');
    if (!Array.isArray(value)) fail('M5-11 unit scope must be a JSON array', 'INVALID_SCOPE');
    return value;
  }
  if (args['unit-ids'] === undefined) {
    fail('--unit-ids=... or --unit-ids-file=... is required for pass start', 'MISSING_SCOPE');
  }
  if (args['unit-ids'].trim().length === 0) return [];
  return args['unit-ids'].split(',').map((value) => value.trim()).filter(Boolean);
}

function assertUnitIds(unitIds) {
  if (new Set(unitIds).size !== unitIds.length || unitIds.some((unitId) => typeof unitId !== 'string' || unitId.length === 0)) {
    fail('M5-11 unit scope must contain unique non-empty strings', 'INVALID_SCOPE');
  }
}

function sourceBinding(args, timingKind) {
  const source = {
    proposal_sha256: requireDigest(args['proposal-sha256'], '--proposal-sha256'),
    editorial_sha256: requireDigest(args['editorial-sha256'], '--editorial-sha256'),
  };
  if (timingKind === 'post-freeze-audit') {
    source.audit_sha256 = requireDigest(args['audit-sha256'], '--audit-sha256');
    source.editorial_timing_sha256 = requireDigest(
      args['editorial-timing-sha256'],
      '--editorial-timing-sha256',
    );
  }
  return source;
}

function newSession(timingKind, args) {
  const sessionId = randomUUID();
  return {
    schema_version: '1',
    issue: 97,
    batch_id: M5_11_BATCH_ID,
    timing_kind: timingKind,
    session_id: sessionId,
    status: 'in-progress',
    recorder_version: M5_11_TIMING_RECORDER_VERSION,
    recording_source: M5_11_TIMING_RECORDER_VERSION,
    recorder_command: M5_11_TIMING_RECORDING_COMMAND,
    clock_source: M5_11_TIMING_CLOCK_SOURCE,
    source: sourceBinding(args, timingKind),
    passes: passIdsForKind(timingKind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    recorder_events: [],
    recorder: {
      version: M5_11_TIMING_RECORDER_VERSION,
      session_id: sessionId,
      event_count: 0,
      event_log_sha256: '0'.repeat(64),
      recorder_event_count: 0,
      recorder_event_log_sha256: '0'.repeat(64),
    },
  };
}

function assertSession(session, timingKind, { allowInProgress = false } = {}) {
  if (!session || typeof session !== 'object'
    || session.schema_version !== '1'
    || session.issue !== 97
    || session.batch_id !== M5_11_BATCH_ID
    || session.timing_kind !== timingKind
    || session.status !== 'in-progress'
    || session.recorder_version !== M5_11_TIMING_RECORDER_VERSION
    || session.recording_source !== M5_11_TIMING_RECORDER_VERSION
    || session.recorder_command !== M5_11_TIMING_RECORDING_COMMAND
    || session.clock_source !== M5_11_TIMING_CLOCK_SOURCE
    || !Array.isArray(session.passes)
    || JSON.stringify(session.passes.map(({ id }) => id)) !== JSON.stringify(passIdsForKind(timingKind))
    || !Array.isArray(session.events)
    || !Array.isArray(session.recorder_events)) {
    fail('input is not an in-progress M5-11 timing recorder session', 'INVALID_SESSION');
  }
  const inProgressCount = session.passes.filter(({ status }) => status === 'in-progress').length;
  if (!allowInProgress && inProgressCount > 0) {
    fail('an M5-11 timing pass is already in progress', 'PASS_IN_PROGRESS');
  }
  if (allowInProgress && inProgressCount !== 1) {
    fail('stop requires exactly one active M5-11 timing pass', 'PASS_NOT_STARTED');
  }
}

function startPass(session, passId, unitIds) {
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) fail(`${passId} is not part of the timing contract`, 'INVALID_PASS');
  if (session.passes[index].status !== 'unmeasured') fail(`${passId} is not an unmeasured pass`, 'PASS_ALREADY_RECORDED');
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) {
    fail(`${passId} cannot start before earlier passes are complete`, 'PASS_ORDER');
  }
  const startedAt = now();
  const eventId = `m5-11-recorder-${session.recorder_events.length + 1}`;
  session.passes[index] = {
    id: passId,
    status: 'in-progress',
    unit_ids: unitIds,
    unit_count: unitIds.length,
    event_ids: [],
    started_at: startedAt,
    recording_source: M5_11_TIMING_RECORDER_VERSION,
  };
  session.recorder_events.push({
    event_id: eventId,
    pass_id: passId,
    kind: 'start',
    session_id: session.session_id,
    at: startedAt,
  });
}

function stopPass(session, passId) {
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) fail(`${passId} is not part of the timing contract`, 'INVALID_PASS');
  const pass = session.passes[index];
  if (pass.status !== 'in-progress') fail(`${passId} has no active recorder start`, 'PASS_NOT_STARTED');
  const completedAt = now();
  const startedMs = Date.parse(pass.started_at);
  const completedMs = Date.parse(completedAt);
  const elapsedMs = completedMs - startedMs;
  if (elapsedMs < 0) fail(`${passId} completed before it started`, 'PASS_ORDER');
  if (pass.unit_count > 0 && elapsedMs < pass.unit_count) {
    fail(`${passId} stopped too quickly to record one positive millisecond event per work unit`, 'PASS_TOO_SHORT');
  }

  let cursor = startedMs;
  const eventIds = [];
  pass.unit_ids.forEach((unitId, unitIndex) => {
    const remainingUnits = pass.unit_count - unitIndex;
    const remainingMs = completedMs - cursor;
    const durationMs = Math.max(1, Math.floor(remainingMs / remainingUnits));
    const eventStarted = cursor;
    const eventCompleted = unitIndex === pass.unit_count - 1
      ? completedMs
      : cursor + durationMs;
    const eventId = `m5-11-work-${passId}-${String(unitIndex + 1).padStart(4, '0')}`;
    eventIds.push(eventId);
    session.events.push({
      event_id: eventId,
      pass_id: passId,
      kind: 'work',
      session_id: session.session_id,
      unit_id: unitId,
      recording_source: M5_11_TIMING_RECORDER_VERSION,
      started_at: new Date(eventStarted).toISOString(),
      completed_at: new Date(eventCompleted).toISOString(),
      recorded_at: new Date(eventCompleted).toISOString(),
    });
    cursor = eventCompleted;
  });

  session.passes[index] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    wall_clock_seconds: elapsedMs / 1000,
    ...(session.timing_kind === 'editorial'
      ? { editor_seconds: pass.unit_count === 0 ? 0 : elapsedMs / 1000 }
      : { audit_seconds: pass.unit_count === 0 ? 0 : elapsedMs / 1000 }),
    event_ids: eventIds,
  };
  session.recorder_events.push({
    event_id: `m5-11-recorder-${session.recorder_events.length + 1}`,
    pass_id: passId,
    kind: 'stop',
    session_id: session.session_id,
    at: completedAt,
  });

  if (session.passes.every(({ status }) => status === 'complete')) {
    session.status = 'complete';
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  for (const forbidden of ['started-at', 'completed-at', 'editor-seconds', 'audit-seconds', 'duration-ms', 'now']) {
    if (Object.hasOwn(args, forbidden)) fail(`--${forbidden} is not accepted; the recorder uses current-clock events`, 'CLOCK_OVERRIDE_FORBIDDEN');
  }
  const action = args.action;
  if (!['start', 'stop'].includes(action)) fail('--action=start or --action=stop is required', 'INVALID_ACTION');
  const passId = args.pass;
  if (!passId) fail('--pass=... is required', 'MISSING_ARGUMENT');
  const timingKind = timingKindForPass(passId);
  const outputPath = outputPathFor(args);
  let session;

  if (action === 'start') {
    if (args.input) {
      session = await readJson(storedExternalPath(args.input, 'M5-11 timing input'), 'M5-11 timing input');
      assertSession(session, timingKind);
    } else {
      await requireNewOutput(outputPath);
      session = newSession(timingKind, args);
    }
    const unitIds = await unitIdsFromArgs(args);
    assertUnitIds(unitIds);
    startPass(session, passId, unitIds);
  } else {
    if (!args.input) fail('--input=... is required for stop', 'MISSING_ARGUMENT');
    session = await readJson(storedExternalPath(args.input, 'M5-11 timing input'), 'M5-11 timing input');
    assertSession(session, timingKind, { allowInProgress: true });
    stopPass(session, passId);
  }

  if (session.status === 'complete') {
    session.recorder.event_count = session.events.length;
    session.recorder.event_log_sha256 = sha256Json(session.events);
    session.recorder.recorder_event_count = session.recorder_events.length;
    session.recorder.recorder_event_log_sha256 = sha256Json(session.recorder_events);
    session.recording_proof_sha256 = createM511TimingProof(session);
  } else {
    session.recorder.event_count = session.events.length;
    session.recorder.event_log_sha256 = sha256Json(session.events);
    session.recorder.recorder_event_count = session.recorder_events.length;
    session.recorder.recorder_event_log_sha256 = sha256Json(session.recorder_events);
  }
  await writeJson(outputPath, session);
  return session;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main()
    .then((session) => console.log(JSON.stringify({
      timing_kind: session.timing_kind,
      pass_ids: session.passes.map(({ id }) => id),
      status: session.status,
      output: session.recorder_command,
    }, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

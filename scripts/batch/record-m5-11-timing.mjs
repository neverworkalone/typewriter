/**
 * Current-clock recorder for M5-11 editorial and independent-audit timing.
 *
 * The command owns all timestamps. A new session starts from the frozen
 * proposal/scope and an absent output artifact; the final stop invocation
 * reads the artifact that was produced during the session and binds its
 * digest. Timestamp, duration, and caller-supplied digest overrides are
 * rejected. A pass is started and stopped in separate invocations, and the
 * stop invocation emits contiguous recorder work events that cover the
 * observed wall-clock interval.
 */

import { access, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createM511TimingProof,
  M5_11_AUDIT_TIMING_PASS_IDS,
  M5_11_EDITORIAL_TIMING_PASS_IDS,
  M5_11_TIMING_CLOCK_SOURCE,
  M5_11_TIMING_LIFECYCLE_VERSION,
  M5_11_TIMING_PROVENANCE_ALGORITHM,
  M5_11_TIMING_PROVENANCE_VERSION,
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

function storedExternalPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPOSITORY_DIRECTORY, resolved);
  if (!relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must remain outside the repository`, 'EXTERNAL_INPUT_REQUIRED');
  }
  return resolved;
}

function requiredExternalPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} is required`, 'MISSING_ARGUMENT');
  }
  return storedExternalPath(value, label);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

async function readExternalBytes(filePath, label) {
  const resolved = storedExternalPath(filePath, label);
  try {
    return { path: resolved, bytes: await readFile(resolved) };
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${resolved}`, 'MISSING_INPUT');
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

async function requireAbsentArtifact(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(
    `bound artifact must be absent before the recorder session starts: ${filePath}`,
    'ARTIFACT_EXISTS_AT_START',
  );
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

async function sourceBinding(args, timingKind) {
  const proposal = await readExternalBytes(
    requiredExternalPath(args.proposal, '--proposal'),
    'M5-11 frozen proposal',
  );
  const source = {
    proposal_sha256: sha256(proposal.bytes),
  };
  if (timingKind === 'post-freeze-audit') {
    const editorial = await readExternalBytes(
      requiredExternalPath(args.editorial, '--editorial'),
      'M5-11 editorial decisions',
    );
    const editorialTiming = await readExternalBytes(
      requiredExternalPath(args['editorial-timing'], '--editorial-timing'),
      'M5-11 editorial timing',
    );
    source.editorial_sha256 = sha256(editorial.bytes);
    source.editorial_timing_sha256 = sha256(editorialTiming.bytes);
  }
  return source;
}

async function newSession(timingKind, args, outputPath) {
  const sessionId = randomUUID();
  const source = await sourceBinding(args, timingKind);
  const artifactPath = requiredExternalPath(args.artifact, '--artifact');
  if (artifactPath === outputPath) {
    fail('--artifact must be different from the timing session output', 'ARTIFACT_PATH_MISMATCH');
  }
  await requireAbsentArtifact(artifactPath);
  const privateKeyPath = `${outputPath}.provenance-key`;
  await requireNewOutput(privateKeyPath);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { encoding: 'utf8', mode: 0o600 },
  );
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
    source,
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
      provenance: {
        version: M5_11_TIMING_PROVENANCE_VERSION,
        algorithm: M5_11_TIMING_PROVENANCE_ALGORITHM,
        public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        signed_recording_proof_sha256: null,
        signature_base64: null,
      },
      lifecycle: {
        version: M5_11_TIMING_LIFECYCLE_VERSION,
        artifact_kind: timingKind === 'editorial' ? 'editorial-decisions' : 'independent-audit',
        binding_mode: 'start-before-artifact-finalization',
        artifact_path: artifactPath,
        artifact_existed_at_session_start: false,
        artifact_bound_at_stop: false,
        session_started_at: null,
        session_start_event_id: null,
        artifact_bound_at: null,
        artifact_bound_event_id: null,
        artifact_bound_pass_id: null,
        artifact_sha256: null,
        artifact_byte_count: null,
        private_key_path: privateKeyPath,
      },
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
    || !Array.isArray(session.recorder_events)
    || session.recorder?.version !== M5_11_TIMING_RECORDER_VERSION
    || session.recorder?.session_id !== session.session_id
    || session.recorder?.provenance?.version !== M5_11_TIMING_PROVENANCE_VERSION
    || session.recorder?.provenance?.algorithm !== M5_11_TIMING_PROVENANCE_ALGORITHM
    || session.recorder?.lifecycle?.version !== M5_11_TIMING_LIFECYCLE_VERSION
    || session.recorder?.lifecycle?.artifact_bound_at_stop !== (session.status === 'complete')
    || session.recorder?.lifecycle?.artifact_existed_at_session_start !== false
    || session.recorder?.lifecycle?.binding_mode !== 'start-before-artifact-finalization'
    || typeof session.recorder?.lifecycle?.artifact_path !== 'string'
    || typeof session.recorder?.lifecycle?.private_key_path !== 'string') {
    fail('input is not an in-progress M5-11 timing recorder session', 'INVALID_SESSION');
  }
  storedExternalPath(session.recorder.lifecycle.artifact_path, 'M5-11 bound artifact');
  storedExternalPath(session.recorder.lifecycle.private_key_path, 'M5-11 recorder provenance key');
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
  if (session.recorder.lifecycle.session_started_at === null) {
    session.recorder.lifecycle.session_started_at = startedAt;
    session.recorder.lifecycle.session_start_event_id = eventId;
  }
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

async function finalizeArtifactBinding(session, completedAt, passId) {
  const lifecycle = session.recorder.lifecycle;
  if (lifecycle.artifact_bound_at_stop === true) {
    fail('timing session already finalized its bound artifact', 'ARTIFACT_ALREADY_BOUND');
  }
  let artifactBytes;
  try {
    artifactBytes = await readFile(lifecycle.artifact_path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(
        'the bound artifact must be produced before the final recorder stop',
        'ARTIFACT_NOT_READY',
      );
    }
    throw error;
  }
  if (artifactBytes.length === 0) fail('the bound artifact must not be empty', 'ARTIFACT_NOT_READY');
  const stopEvent = session.recorder_events.at(-1);
  session.source[session.timing_kind === 'editorial' ? 'editorial_sha256' : 'audit_sha256'] = sha256(artifactBytes);
  Object.assign(lifecycle, {
    artifact_bound_at_stop: true,
    artifact_bound_at: completedAt,
    artifact_bound_event_id: stopEvent.event_id,
    artifact_bound_pass_id: passId,
    artifact_sha256: sha256(artifactBytes),
    artifact_byte_count: artifactBytes.length,
  });
}

async function finalizeRecorderProvenance(session) {
  const privateKeyPath = session.recorder.lifecycle.private_key_path;
  if (privateKeyPath !== null) {
    let privateKeyBytes;
    try {
      privateKeyBytes = await readFile(privateKeyPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') fail('recorder provenance key is missing', 'TIMING_PROVENANCE_ERROR');
      throw error;
    }
    session.recorder.lifecycle.private_key_path = null;
    const proof = createM511TimingProof(session);
    session.recording_proof_sha256 = proof;
    session.recorder.provenance.signed_recording_proof_sha256 = proof;
    session.recorder.provenance.signature_base64 = sign(
      null,
      Buffer.from(proof, 'utf8'),
      createPrivateKey(privateKeyBytes),
    ).toString('base64');
    await rm(privateKeyPath, { force: true });
  } else {
    fail('complete timing session is missing its recorder provenance key', 'TIMING_PROVENANCE_ERROR');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  for (const forbidden of [
    'started-at',
    'completed-at',
    'editor-seconds',
    'audit-seconds',
    'duration-ms',
    'now',
    'proposal-sha256',
    'editorial-sha256',
    'audit-sha256',
    'editorial-timing-sha256',
  ]) {
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
      session = await newSession(timingKind, args, outputPath);
    }
    const unitIds = await unitIdsFromArgs(args);
    assertUnitIds(unitIds);
    startPass(session, passId, unitIds);
  } else {
    if (!args.input) fail('--input=... is required for stop', 'MISSING_ARGUMENT');
    session = await readJson(storedExternalPath(args.input, 'M5-11 timing input'), 'M5-11 timing input');
    assertSession(session, timingKind, { allowInProgress: true });
    stopPass(session, passId);
    if (session.status === 'complete') {
      await finalizeArtifactBinding(session, session.passes.at(-1).completed_at, passId);
    }
  }

  if (session.status === 'complete') {
    session.recorder.event_count = session.events.length;
    session.recorder.event_log_sha256 = sha256Json(session.events);
    session.recorder.recorder_event_count = session.recorder_events.length;
    session.recorder.recorder_event_log_sha256 = sha256Json(session.recorder_events);
    await finalizeRecorderProvenance(session);
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

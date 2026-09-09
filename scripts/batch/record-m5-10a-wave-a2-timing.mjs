import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A2_BATCH_ID,
  A2_AUDIT_TIMING_PASS_IDS,
  A2_MIN_EDITOR_SECONDS_PER_UNIT,
  A2_TIMING_PASS_IDS,
  A2_TIMING_WORK_UNIT_CONTRACT,
  createA2TimingProof,
  sha256Bytes,
  validateA2AuditTimingInput,
  validateA2TimingInput,
} from './validate-m5-10a-wave-a2-inputs.mjs';
import { assertExternalStagingPath } from './validate-batch.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-timing-session.json',
);
const TIMING_RECORDER_VERSION = 'timing-recorder-v1';
const TIMING_RECORDING_COMMAND = 'node scripts/batch/record-m5-10a-wave-a2-timing.mjs';
const DEFAULT_TIMING_ID = 'm5-10a-wave-a2-timing-20260909';
const DEFAULT_AUDIT_TIMING_ID = 'm5-10a-wave-a2-timing-audit-20260909';

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`arguments must use --name=value form (received ${argument})`);
    }
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureNewOutput(outputPath) {
  try {
    await access(outputPath);
    throw new Error(`refusing to overwrite an existing timing session: ${outputPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function timestampFromClock() {
  return new Date().toISOString();
}

function requirePass(args) {
  const passIds = [...A2_TIMING_PASS_IDS, ...A2_AUDIT_TIMING_PASS_IDS];
  if (!args.pass || !passIds.includes(args.pass)) {
    throw new Error(`--pass must be one of ${passIds.join(', ')}`);
  }
  return args.pass;
}

function passIdsForTimingKind(timingKind) {
  if (timingKind === 'editorial') return A2_TIMING_PASS_IDS;
  if (timingKind === 'post-freeze-audit') return A2_AUDIT_TIMING_PASS_IDS;
  throw new Error(`unsupported A2 timing kind: ${timingKind}`);
}

function assertSession(session) {
  if (!session || typeof session !== 'object'
    || session.schema_version !== '1'
    || !['editorial', 'post-freeze-audit'].includes(session.timing_kind)
    || session.batch_id !== A2_BATCH_ID
    || session.recorder_version !== TIMING_RECORDER_VERSION
    || session.recording_source !== TIMING_RECORDER_VERSION
    || session.recorder_command !== TIMING_RECORDING_COMMAND
    || !['in-progress', 'complete'].includes(session.status)
    || !Array.isArray(session.passes)
    || JSON.stringify(session.passes.map(({ id }) => id))
      !== JSON.stringify(passIdsForTimingKind(session.timing_kind))
    || !Array.isArray(session.events)) {
    throw new Error('timing input must be an A2 recorder session created by this command');
  }
  if (session.status === 'complete') {
    throw new Error('the timing session is already complete');
  }
}

function createSession(timingKind) {
  const passIds = passIdsForTimingKind(timingKind);
  return {
    schema_version: '1',
    timing_id: timingKind === 'editorial' ? DEFAULT_TIMING_ID : DEFAULT_AUDIT_TIMING_ID,
    timing_kind: timingKind,
    batch_id: A2_BATCH_ID,
    recorder_version: TIMING_RECORDER_VERSION,
    recording_source: TIMING_RECORDER_VERSION,
    recorder_command: TIMING_RECORDING_COMMAND,
    processed_start_count: 56,
    status: 'in-progress',
    passes: passIds.map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    note: 'A2 timing session is retained as raw recorder events until every pass has a work-evidence file.',
  };
}

function validateWorkEvidence(workEvidence, passId) {
  if (!workEvidence || typeof workEvidence !== 'object' || Array.isArray(workEvidence)) {
    throw new Error(`${passId} stop requires a JSON work-evidence object`);
  }
  const expected = A2_TIMING_WORK_UNIT_CONTRACT[passId];
  const actualKeys = Object.keys(workEvidence).sort();
  const expectedKeys = ['after_sha256', 'before_sha256', 'note', 'unit_count', 'unit_ids', 'unit_kind'];
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${passId} work evidence must contain only unit_kind, unit_count, unit_ids, before_sha256, after_sha256, and note`);
  }
  if (workEvidence.unit_kind !== expected.unit_kind
    || workEvidence.unit_count !== expected.unit_ids.length
    || !Array.isArray(workEvidence.unit_ids)
    || JSON.stringify([...workEvidence.unit_ids].sort()) !== JSON.stringify([...expected.unit_ids].sort())) {
    throw new Error(`${passId} work evidence must list the exact A2 work-unit contract`);
  }
  if (!/^[a-f0-9]{64}$/u.test(workEvidence.before_sha256)
    || !/^[a-f0-9]{64}$/u.test(workEvidence.after_sha256)) {
    throw new Error(`${passId} work evidence must include before_sha256 and after_sha256`);
  }
  if (typeof workEvidence.note !== 'string' || workEvidence.note.trim().length === 0) {
    throw new Error(`${passId} work evidence note must be non-empty`);
  }
  return structuredClone(workEvidence);
}

async function readWorkEvidence(args, passId) {
  if (!args['work-evidence']) {
    throw new Error(`stopping ${passId} requires --work-evidence=<json-file>`);
  }
  return validateWorkEvidence(
    await readJson(path.resolve(args['work-evidence']), `${passId} work evidence`),
    passId,
  );
}

function startPass(session, passId, binding = {}) {
  const passIds = passIdsForTimingKind(session.timing_kind);
  const passIndex = passIds.indexOf(passId);
  if (passIndex < 0) throw new Error(`${passId} is not part of the ${session.timing_kind} timing contract`);
  const pass = session.passes[passIndex];
  if (pass.status !== 'unmeasured') throw new Error(`${passId} is not an unmeasured pass`);
  if (session.passes.some(({ status }) => status === 'in-progress')) {
    throw new Error('an A2 timing pass is already in progress');
  }
  if (session.passes.slice(0, passIndex).some(({ status }) => status !== 'complete')) {
    throw new Error(`${passId} cannot start before earlier passes are complete`);
  }
  const startedAt = timestampFromClock();
  const sessionId = randomUUID();
  session.passes[passIndex] = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: sessionId,
    recording_source: TIMING_RECORDER_VERSION,
    ...binding,
  };
  session.events.push({
    event_id: `m5-10a-wave-a2-timing-event-${String(session.events.length + 1).padStart(4, '0')}`,
    pass_id: passId,
    kind: 'start',
    session_id: sessionId,
    at: startedAt,
  });
  return session;
}

async function stopPass(session, passId, workEvidence) {
  const passIds = passIdsForTimingKind(session.timing_kind);
  const passIndex = passIds.indexOf(passId);
  if (passIndex < 0) throw new Error(`${passId} is not part of the ${session.timing_kind} timing contract`);
  const pass = session.passes[passIndex];
  if (pass.status !== 'in-progress') throw new Error(`${passId} has no active recorder start`);
  const completedAt = timestampFromClock();
  const elapsedSeconds = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
  const minimumSeconds = workEvidence.unit_count * A2_MIN_EDITOR_SECONDS_PER_UNIT;
  if (elapsedSeconds < minimumSeconds) {
    throw new Error(`${passId} recorded ${elapsedSeconds} editor seconds for ${workEvidence.unit_count} work units; at least ${minimumSeconds} seconds are required`);
  }
  session.passes[passIndex] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    wall_clock_seconds: elapsedSeconds,
    editor_seconds: elapsedSeconds,
    work_evidence: workEvidence,
  };
  session.events.push({
    event_id: `m5-10a-wave-a2-timing-event-${String(session.events.length + 1).padStart(4, '0')}`,
    pass_id: passId,
    kind: 'stop',
    session_id: pass.session_id,
    at: completedAt,
  });
  if (session.passes.every(({ status }) => status === 'complete')) {
    session.status = 'complete';
    session.note = 'A2 timing completed from recorder start/stop events and per-pass work evidence.';
    session.recording_proof_sha256 = createA2TimingProof(session);
    if (session.timing_kind === 'editorial') validateA2TimingInput(session);
    else validateA2AuditTimingInput(session);
  }
  return session;
}

async function readAuditTimingBinding(args, outputPath) {
  if (!args['audit-session']) {
    throw new Error('post-freeze-audit start requires --audit-session=<audit-session.json>');
  }
  if (!args.staging) {
    throw new Error('post-freeze-audit start requires --staging=<reviewed-staging.jsonl>');
  }
  const auditSession = await readJson(path.resolve(args['audit-session']), 'audit session');
  if (auditSession.recorder_version !== 'wave-a2-audit-recorder-v2'
    || auditSession.status !== 'in-progress'
    || typeof auditSession.session_id !== 'string'
    || typeof auditSession.started_at !== 'string'
    || typeof auditSession.reviewed_staging_path !== 'string'
    || typeof auditSession.reviewed_staging_sha256 !== 'string'
    || typeof auditSession.audit_timing_input_path !== 'string') {
    throw new Error('audit timing requires an in-progress v2 audit session with a frozen staging binding');
  }
  const stagingPath = path.resolve(args.staging);
  assertExternalStagingPath(stagingPath);
  if (path.resolve(auditSession.reviewed_staging_path) !== stagingPath) {
    throw new Error('audit timing staging path does not match the audit session freeze');
  }
  if (path.resolve(auditSession.audit_timing_input_path) !== path.resolve(outputPath)) {
    throw new Error('audit timing output path does not match the audit session binding');
  }
  const stagingBytes = await readFile(stagingPath);
  if (sha256Bytes(stagingBytes) !== auditSession.reviewed_staging_sha256) {
    throw new Error('audit timing staging digest does not match the audit session freeze');
  }
  if (!Number.isFinite(Date.parse(auditSession.started_at))) {
    throw new Error('audit session started_at must be a valid timestamp');
  }
  return auditSession;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const action = args.action;
  if (!['start', 'stop'].includes(action)) throw new Error('--action=start or --action=stop is required');
  const outputPath = path.resolve(args.output ?? DEFAULT_OUTPUT_PATH);
  for (const forbidden of ['started-at', 'completed-at', 'editor-seconds', 'session-id', 'now', 'duration-ms']) {
    if (Object.hasOwn(args, forbidden)) {
      throw new Error(`--${forbidden} is not accepted; the recorder uses explicit current-clock start/stop events`);
    }
  }
  if (Object.hasOwn(args, 'processed-start-count') && args['processed-start-count'] !== '56') {
    throw new Error('--processed-start-count is fixed at 56 for Wave A2');
  }

  if (action === 'start') {
    const passId = requirePass(args);
    const timingKind = passId === 'post-freeze-audit' ? 'post-freeze-audit' : 'editorial';
    let session;
    if (args.input) {
      session = await readJson(path.resolve(args.input), 'A2 timing session');
      assertSession(session);
    } else {
      await ensureNewOutput(outputPath);
      session = createSession(timingKind);
    }
    if (session.timing_kind !== timingKind) {
      throw new Error(`${passId} cannot be recorded in a ${session.timing_kind} timing session`);
    }
    const auditBinding = timingKind === 'post-freeze-audit'
      ? await readAuditTimingBinding(args, outputPath)
      : null;
    const updated = startPass(
      session,
      passId,
      auditBinding
        ? {
          audit_session_id: auditBinding.session_id,
          reviewed_staging_sha256: auditBinding.reviewed_staging_sha256,
        }
        : {},
    );
    if (auditBinding && Date.parse(updated.passes[0].started_at) < Date.parse(auditBinding.started_at)) {
      throw new Error('post-freeze audit timing must start after the audit provenance session');
    }
    await writeJson(outputPath, updated);
    console.log(`Started explicit A2 timing pass ${args.pass}; session state is in ${path.relative(process.cwd(), outputPath)}.`);
    return updated;
  }

  if (!args.input) throw new Error('--input is required for a stop action');
  const inputPath = path.resolve(args.input);
  const session = await readJson(inputPath, 'A2 timing session');
  assertSession(session);
  const passId = requirePass(args);
  const workEvidence = await readWorkEvidence(args, passId);
  const updated = await stopPass(session, passId, workEvidence);
  await writeJson(outputPath, updated);
  console.log(`${updated.status === 'complete' ? 'Finalized' : 'Stopped'} explicit A2 timing pass ${args.pass} in ${path.relative(process.cwd(), outputPath)}.`);
  return updated;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

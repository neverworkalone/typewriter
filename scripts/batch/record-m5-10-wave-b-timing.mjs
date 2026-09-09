import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WAVE_B_AUDIT_TIMING_PASS_IDS,
  WAVE_B_BATCH_ID,
  WAVE_B_TIMING_PASS_IDS,
  WAVE_B_TIMING_WORK_UNIT_CONTRACT,
  createWaveBTimingProof,
} from './validate-m5-10-wave-b.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_TIMING_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-timing-session.json');
const DEFAULT_AUDIT_TIMING_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-audit-timing-session.json');
const RECORDER_VERSION = 'wave-b-timing-recorder-v1';
const RECORDING_SOURCE = 'timing-recorder-v1';
const RECORDING_COMMAND = 'node scripts/batch/record-m5-10-wave-b-timing.mjs';
const DATE_SUFFIX = '20260909';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function parseArguments(argv) {
  const args = {};
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) throw new Error(`arguments must use --name=value form (received ${argument})`);
    const separator = argument.indexOf('=');
    args[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return args;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`timing session does not exist: ${filePath}`);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function now() {
  return new Date().toISOString();
}

function passIds(kind) {
  if (kind === 'editorial') return WAVE_B_TIMING_PASS_IDS;
  if (kind === 'post-freeze-audit') return WAVE_B_AUDIT_TIMING_PASS_IDS;
  throw new Error('--kind must be editorial or post-freeze-audit');
}

function outputFor(kind, args) {
  return path.resolve(args.output ?? (kind === 'editorial' ? DEFAULT_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH));
}

function sessionFor(kind, args) {
  const session = {
    schema_version: '1',
    timing_id: `m5-10-wave-b-timing${kind === 'post-freeze-audit' ? '-audit' : ''}-${DATE_SUFFIX}`,
    timing_kind: kind,
    batch_id: WAVE_B_BATCH_ID,
    recorder_version: RECORDER_VERSION,
    recording_source: RECORDING_SOURCE,
    recorder_command: RECORDING_COMMAND,
    processed_start_count: 160,
    session_id: randomUUID(),
    status: 'in-progress',
    passes: passIds(kind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    note: 'Wave B timing session remains incomplete until every declared pass has an explicit recorder stop and work evidence.',
  };
  if (kind === 'post-freeze-audit') {
    if (!args['audit-session-id'] || !UUID_PATTERN.test(args['audit-session-id'])) throw new Error('post-freeze-audit start requires --audit-session-id=<UUID>');
    if (!args['staging-sha256'] || !SHA256_PATTERN.test(args['staging-sha256'])) throw new Error('post-freeze-audit start requires --staging-sha256=<sha256>');
    session.audit_session_id = args['audit-session-id'];
    session.reviewed_staging_sha256 = args['staging-sha256'];
  }
  return session;
}

function validateWorkEvidence(passId, args) {
  const contract = WAVE_B_TIMING_WORK_UNIT_CONTRACT[passId];
  const before = args['before-sha256'];
  const after = args['after-sha256'];
  if (!SHA256_PATTERN.test(before ?? '') || !SHA256_PATTERN.test(after ?? '')) throw new Error(`${passId} stop requires valid --before-sha256 and --after-sha256`);
  if (!args.note || args.note.trim().length === 0) throw new Error(`${passId} stop requires --note=<work description>`);
  return {
    unit_kind: contract.unit_kind,
    unit_count: contract.unit_ids.length,
    unit_ids: [...contract.unit_ids],
    before_sha256: before,
    after_sha256: after,
    note: args.note,
  };
}

async function startPass(args) {
  const kind = args.kind;
  const outputPath = outputFor(kind, args);
  const passId = args.pass;
  if (!passIds(kind).includes(passId)) throw new Error(`--pass must be one of ${passIds(kind).join(', ')}`);
  let session;
  try {
    session = await readJson(outputPath);
  } catch (error) {
    if (error.message.startsWith('timing session does not exist:')) {
      session = sessionFor(kind, args);
    } else {
      throw error;
    }
  }
  if (session.timing_kind !== kind || session.status !== 'in-progress') throw new Error('timing session is not an in-progress Wave B session of the requested kind');
  const index = session.passes.findIndex(({ id }) => id === passId);
  const pass = session.passes[index];
  if (pass.status !== 'unmeasured') throw new Error(`${passId} is not an unmeasured pass`);
  if (session.passes.some(({ status }) => status === 'in-progress')) throw new Error('another Wave B timing pass is already in progress');
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) throw new Error(`${passId} cannot start before earlier passes are complete`);
  const startedAt = now();
  const sessionId = randomUUID();
  session.passes[index] = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: sessionId,
    recording_source: RECORDING_SOURCE,
    ...(kind === 'post-freeze-audit' ? {
      audit_session_id: session.audit_session_id,
      reviewed_staging_sha256: session.reviewed_staging_sha256,
  } : {}),
  };
  session.events.push({ event_id: `m5-10-wave-b-timing-event-${String(session.events.length + 1).padStart(4, '0')}`, pass_id: passId, kind: 'start', session_id: sessionId, at: startedAt });
  await writeJson(outputPath, session);
  console.log(`Started ${kind} pass ${passId}: ${outputPath}`);
}

async function initSession(args) {
  const kind = args.kind;
  if (!passIds(kind)) throw new Error('--kind must be editorial or post-freeze-audit');
  const outputPath = outputFor(kind, args);
  let session;
  try {
    await readFile(outputPath);
    throw new Error(`refusing to overwrite an existing timing session: ${outputPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    session = sessionFor(kind, args);
  }
  await writeJson(outputPath, session);
  console.log(`Initialized ${kind} timing session: ${outputPath}`);
}

async function stopPass(args) {
  const outputPath = path.resolve(args.input ?? outputFor(args.kind, args));
  const session = await readJson(outputPath);
  const passId = args.pass;
  if (!passIds(session.timing_kind).includes(passId)) throw new Error(`--pass must be one of ${passIds(session.timing_kind).join(', ')}`);
  const index = session.passes.findIndex(({ id }) => id === passId);
  const pass = session.passes[index];
  if (pass.status !== 'in-progress') throw new Error(`${passId} has no active recorder start`);
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) throw new Error(`${passId} cannot stop before earlier passes are complete`);
  const completedAt = now();
  const elapsed = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
  const workEvidence = validateWorkEvidence(passId, args);
  session.passes[index] = {
    ...pass,
    status: 'complete',
    completed_at: completedAt,
    wall_clock_seconds: elapsed,
    editor_seconds: elapsed,
    work_evidence: workEvidence,
  };
  const eventNumber = session.events.length + 1;
  session.events.push({ event_id: `m5-10-wave-b-timing-event-${String(eventNumber).padStart(4, '0')}`, pass_id: passId, kind: 'stop', session_id: pass.session_id, at: completedAt });
  if (session.passes.every(({ status }) => status === 'complete')) {
    session.status = 'complete';
    session.note = 'Wave B timing completed from recorder start/stop events and exact work-unit evidence.';
    session.recording_proof_sha256 = createWaveBTimingProof(session);
  }
  await writeJson(outputPath, session);
  console.log(`Stopped ${session.timing_kind} pass ${passId}: ${outputPath}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.action === 'init') return initSession(args);
  if (args.action === 'start') return startPass(args);
  if (args.action === 'stop') return stopPass(args);
  throw new Error('--action must be start or stop');
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

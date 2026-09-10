import { readFileSync } from 'node:fs';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  WAVE_B_AUDIT_TIMING_PASS_IDS,
  WAVE_B_BATCH_ID,
  WAVE_B_TIMING_PASS_IDS,
  createWaveBTimingProof,
} from './validate-m5-10-wave-b.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_TIMING_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-timing-session.json');
const DEFAULT_AUDIT_TIMING_PATH = path.resolve(REPOSITORY_DIRECTORY, 'data/batches/m5-10-wave-b-audit-timing-session.json');
const RECORDER_VERSION = 'wave-b-timing-recorder-v6';
const RECORDING_SOURCE = 'timing-recorder-v6';
const RECORDING_COMMAND = 'node scripts/batch/record-m5-10-wave-b-timing.mjs';
const DATE_SUFFIX = '20260910';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function storedArtifactPath(filePath) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(REPOSITORY_DIRECTORY, absolutePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return relativePath;
  return absolutePath;
}

async function readArtifact(filePath, label) {
  const absolutePath = path.resolve(filePath);
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${absolutePath}`);
    throw error;
  }
  return {
    path: storedArtifactPath(absolutePath),
    sha256: sha256Bytes(bytes),
    bytes,
  };
}

async function assertMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite a pre-existing ${label}: ${filePath}`);
}

function passIds(kind) {
  if (kind === 'editorial') return WAVE_B_TIMING_PASS_IDS;
  if (kind === 'post-freeze-audit') return WAVE_B_AUDIT_TIMING_PASS_IDS;
  throw new Error('--kind must be editorial or post-freeze-audit');
}

function outputFor(kind, args) {
  return path.resolve(args.output ?? (kind === 'editorial' ? DEFAULT_TIMING_PATH : DEFAULT_AUDIT_TIMING_PATH));
}

async function sessionFor(kind, args) {
  if (!args['input-artifact'] || !args['output-artifact']) {
    throw new Error('timing start requires --input-artifact=<path> and --output-artifact=<new-path>');
  }
  const inputPath = path.resolve(args['input-artifact']);
  const outputPath = path.resolve(args['output-artifact']);
  if (inputPath === outputPath) throw new Error('timing input and output artifacts must be different files');
  await assertMissing(outputPath, 'timing output artifact');
  const inputArtifact = await readArtifact(inputPath, 'timing input artifact');
  if (inputArtifact.bytes.length > 0 && inputArtifact.bytes.at(-1) !== 10) {
    throw new Error('timing input artifact must be newline-terminated JSONL so work rows can be appended safely');
  }
  const session = {
    schema_version: '2',
    timing_id: `m5-10-wave-b-timing${kind === 'post-freeze-audit' ? '-audit' : ''}-${DATE_SUFFIX}`,
    timing_kind: kind,
    batch_id: WAVE_B_BATCH_ID,
    recorder_version: RECORDER_VERSION,
    recording_source: RECORDING_SOURCE,
    measurement_kind: 'producer-throughput',
    recorder_command: RECORDING_COMMAND,
    processed_start_count: 160,
    session_id: randomUUID(),
    status: 'in-progress',
    passes: passIds(kind).map((id) => ({ id, status: 'unmeasured' })),
    events: [],
    note: 'Wave B producer-throughput timing is complete only when every pass contains recorder-created work rows whose producer executions and unit inputs are inside the pass interval; this session does not measure editorial judgment time.',
  };
  if (kind === 'post-freeze-audit') {
    if (!args['audit-session-id'] || !UUID_PATTERN.test(args['audit-session-id'])) throw new Error('post-freeze-audit start requires --audit-session-id=<UUID>');
    if (!args.staging) throw new Error('post-freeze-audit start requires --staging=<reviewed-staging.jsonl>');
    session.audit_session_id = args['audit-session-id'];
    session.reviewed_staging_artifact = await readArtifact(args.staging, 'post-freeze audit staging artifact');
    delete session.reviewed_staging_artifact.bytes;
    session.reviewed_staging_sha256 = session.reviewed_staging_artifact.sha256;
  }
  return session;
}

function activePass(session, passId) {
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) throw new Error(`${passId} is not part of the ${session.timing_kind} timing contract`);
  const pass = session.passes[index];
  if (pass.status !== 'in-progress') throw new Error(`${passId} has no active recorder start`);
  return { index, pass };
}

function parseWorkInput(args) {
  if (typeof args['input-json'] === 'string' && typeof args['input-record'] === 'string') {
    throw new Error('work input accepts only one of --input-json or --input-record');
  }
  let input;
  if (args['input-record']) {
    const inputPath = path.resolve(args['input-record']);
    try {
      input = JSON.parse(readFileSync(inputPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`work input does not exist: ${inputPath}`);
      throw new Error(`work input is not valid JSON: ${error.message}`);
    }
  } else if (args['input-json']) {
    try {
      input = JSON.parse(args['input-json']);
    } catch (error) {
      throw new Error(`--input-json is not valid JSON: ${error.message}`);
    }
  } else {
    throw new Error('work recording requires --input-json=<object> or --input-record=<path>');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('work input must be a JSON object');
  if (Object.keys(input).length === 0) throw new Error('work input must contain unit evidence');
  return input;
}

async function startPass(args) {
  const kind = args.kind;
  const outputPath = outputFor(kind, args);
  const passId = args.pass;
  if (!passIds(kind).includes(passId)) throw new Error(`--pass must be one of ${passIds(kind).join(', ')}`);
  if (!args['input-artifact'] || !args['output-artifact']) {
    throw new Error(`${passId} start requires --input-artifact=<path> and --output-artifact=<new-path>`);
  }
  let session;
  try {
    session = await readJson(outputPath);
  } catch (error) {
    if (error.message.startsWith('timing session does not exist:')) session = await sessionFor(kind, args);
    else throw error;
  }
  if (session.timing_kind !== kind || session.status !== 'in-progress') throw new Error('timing session is not an in-progress Wave B session of the requested kind');
  const index = session.passes.findIndex(({ id }) => id === passId);
  if (index < 0) throw new Error(`${passId} is not part of the ${kind} timing contract`);
  const pass = session.passes[index];
  if (pass.status !== 'unmeasured') throw new Error(`${passId} is not an unmeasured pass`);
  if (session.passes.some(({ status }) => status === 'in-progress')) throw new Error('another Wave B timing pass is already in progress');
  if (session.passes.slice(0, index).some(({ status }) => status !== 'complete')) throw new Error(`${passId} cannot start before earlier passes are complete`);

  const inputPath = path.resolve(args['input-artifact']);
  const outputArtifactPath = path.resolve(args['output-artifact']);
  if (inputPath === outputArtifactPath) throw new Error(`${passId} input and output artifacts must be different files`);
  await assertMissing(outputArtifactPath, `${passId} timing output artifact`);
  const inputArtifact = await readArtifact(inputPath, `${passId} input artifact`);
  if (inputArtifact.bytes.length > 0 && inputArtifact.bytes.at(-1) !== 10) {
    throw new Error(`${passId} input artifact must be newline-terminated JSONL`);
  }
  if (index > 0 && session.passes[index - 1].work_evidence?.output_artifact?.sha256 !== inputArtifact.sha256) {
    throw new Error(`${passId} input artifact must continue the previous pass output artifact`);
  }
  if (kind === 'post-freeze-audit') {
    if (!args.staging) throw new Error('post-freeze-audit start requires --staging=<reviewed-staging.jsonl>');
    const stagingArtifact = await readArtifact(args.staging, 'post-freeze audit staging artifact');
    if (session.reviewed_staging_sha256 !== stagingArtifact.sha256) throw new Error('post-freeze audit staging artifact changed between timing passes');
  }

  const startedAt = now();
  const sessionId = randomUUID();
  await copyFile(inputPath, outputArtifactPath);
  const outputArtifact = await readArtifact(outputArtifactPath, `${passId} timing output artifact`);
  const outputStat = await stat(outputArtifactPath);
  session.passes[index] = {
    id: passId,
    status: 'in-progress',
    started_at: startedAt,
    session_id: sessionId,
    recording_source: RECORDING_SOURCE,
    input_artifact: { path: inputArtifact.path, sha256: inputArtifact.sha256 },
    output_artifact_path: outputArtifact.path,
    output_artifact_created_at: new Date(outputStat.mtimeMs).toISOString(),
    output_sha256: outputArtifact.sha256,
    work_events: [],
    ...(kind === 'post-freeze-audit' ? {
      audit_session_id: session.audit_session_id,
      reviewed_staging_sha256: session.reviewed_staging_sha256,
    } : {}),
  };
  session.events.push({
    event_id: `m5-10-wave-b-timing-event-${String(session.events.length + 1).padStart(4, '0')}`,
    pass_id: passId,
    kind: 'start',
    session_id: sessionId,
    at: startedAt,
  });
  await writeJson(outputPath, session);
  console.log(`Started ${kind} pass ${passId}: ${outputPath}`);
}

async function initSession(args) {
  const kind = args.kind;
  if (!passIds(kind)) throw new Error('--kind must be editorial or post-freeze-audit');
  const outputPath = outputFor(kind, args);
  await assertMissing(outputPath, 'timing session');
  const session = await sessionFor(kind, args);
  await writeJson(outputPath, session);
  console.log(`Initialized ${kind} timing session: ${outputPath}`);
}

async function recordWork(args) {
  const outputPath = path.resolve(args.input ?? outputFor(args.kind, args));
  const session = await readJson(outputPath);
  const { index, pass } = activePass(session, args.pass);
  if (!args['unit-id']) throw new Error('work recording requires --unit-id=<id>');
  if (!args['unit-kind']) throw new Error('work recording requires --unit-kind=<kind>');
  if (!args.producer) throw new Error('work recording requires --producer=<module-path>');
  const producerPath = path.resolve(args.producer);
  if (path.extname(producerPath) !== '.mjs') throw new Error('work producer must be an .mjs module');
  const input = parseWorkInput(args);
  if (pass.work_events?.some(({ unit_id: unitId }) => unitId === args['unit-id'])) {
    throw new Error(`${args.pass} already recorded work unit ${args['unit-id']}`);
  }
  const outputArtifactPath = path.resolve(pass.output_artifact_path);
  const currentBytes = await readFile(outputArtifactPath);
  if (sha256Bytes(currentBytes) !== pass.output_sha256) throw new Error(`${args.pass} output artifact changed outside the recorder`);
  let producerModule;
  let producerSource;
  const producerStartedAt = now();
  try {
    producerSource = await readFile(producerPath);
    producerModule = await import(pathToFileURL(producerPath).href);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`work producer does not exist: ${producerPath}`);
    throw new Error(`work producer could not be loaded: ${error.message}`);
  }
  if (typeof producerModule.produce !== 'function') throw new Error(`work producer must export produce(): ${producerPath}`);
  let payload;
  try {
    payload = await producerModule.produce({
      passId: args.pass,
      unitId: args['unit-id'],
      unitKind: args['unit-kind'],
      input: structuredClone(input),
    });
  } catch (error) {
    throw new Error(`work producer failed for ${args['unit-id']}: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('work producer must return a JSON object');
  if (Object.keys(payload).length === 0) throw new Error('work producer returned an empty object');
  const producerCompletedAt = now();
  const recordedAt = producerCompletedAt;
  const inputPayloadSha256 = sha256Json(input);
  const payloadSha256 = sha256Json(payload);
  const row = {
    schema_version: '1',
    kind: 'work',
    pass_id: args.pass,
    session_id: pass.session_id,
    unit_id: args['unit-id'],
    unit_kind: args['unit-kind'],
    recorded_at: recordedAt,
    input: {
      unit_id: args['unit-id'],
      unit_kind: args['unit-kind'],
      payload: input,
      payload_sha256: inputPayloadSha256,
    },
    producer: {
      module: storedArtifactPath(producerPath),
      module_sha256: sha256Bytes(producerSource),
      export: 'produce',
      started_at: producerStartedAt,
      completed_at: producerCompletedAt,
      input_payload_sha256: inputPayloadSha256,
      output_sha256: payloadSha256,
    },
    payload,
  };
  await writeFile(outputArtifactPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  const updatedBytes = await readFile(outputArtifactPath);
  const eventId = `m5-10-wave-b-timing-event-${String(session.events.length + 1).padStart(4, '0')}`;
  session.passes[index] = {
    ...pass,
    output_sha256: sha256Bytes(updatedBytes),
    work_events: [
      ...(pass.work_events ?? []),
      {
        event_id: eventId,
        unit_id: args['unit-id'],
        unit_kind: args['unit-kind'],
        recorded_at: recordedAt,
        payload_sha256: payloadSha256,
        input_payload_sha256: inputPayloadSha256,
        producer_module_sha256: sha256Bytes(producerSource),
        producer_started_at: producerStartedAt,
        producer_completed_at: producerCompletedAt,
      },
    ],
  };
  session.events.push({
    event_id: eventId,
    pass_id: args.pass,
    kind: 'work',
    session_id: pass.session_id,
    at: recordedAt,
    unit_id: args['unit-id'],
    unit_kind: args['unit-kind'],
    payload_sha256: payloadSha256,
    input_payload_sha256: inputPayloadSha256,
    producer_module_sha256: sha256Bytes(producerSource),
    producer_started_at: producerStartedAt,
    producer_completed_at: producerCompletedAt,
  });
  await writeJson(outputPath, session);
  console.log(`Recorded work unit ${args['unit-id']} for ${args.pass}: ${outputPath}`);
}

async function stopPass(args) {
  if (args['input-artifact'] || args['output-artifact']) throw new Error('timing stop uses the artifact paths bound at pass start');
  const outputPath = path.resolve(args.input ?? outputFor(args.kind, args));
  const session = await readJson(outputPath);
  const { index, pass } = activePass(session, args.pass);
  const completedAt = now();
  const inputArtifact = await readArtifact(pass.input_artifact.path, `${args.pass} input artifact`);
  const outputArtifactPath = path.resolve(pass.output_artifact_path);
  const outputArtifact = await readArtifact(outputArtifactPath, `${args.pass} output artifact`);
  if (inputArtifact.sha256 !== pass.input_artifact.sha256) throw new Error(`${args.pass} input artifact changed during the timing pass`);
  if (sha256Bytes(outputArtifact.bytes) !== pass.output_sha256) throw new Error(`${args.pass} output artifact changed outside the recorder`);
  if (!outputArtifact.bytes.subarray(0, inputArtifact.bytes.length).equals(inputArtifact.bytes)) {
    throw new Error(`${args.pass} output artifact must preserve the cumulative input log prefix`);
  }
  if (outputArtifact.sha256 === inputArtifact.sha256) throw new Error(`${args.pass} timing pass has no recorded work transition`);
  const outputStat = await stat(outputArtifactPath);
  if (outputStat.mtimeMs < Date.parse(pass.started_at)) throw new Error(`${args.pass} output artifact predates the timing start`);
  const rows = outputArtifact.bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const workRows = rows.filter((row) => row.kind === 'work' && row.pass_id === args.pass && row.session_id === pass.session_id);
  if (workRows.length === 0) throw new Error(`${args.pass} must record at least one work row before stop`);
  if (workRows.length !== (pass.work_events ?? []).length) throw new Error(`${args.pass} work log and recorder event counts differ`);
  const unitIds = workRows.map(({ unit_id: unitId }) => unitId);
  if (new Set(unitIds).size !== unitIds.length) throw new Error(`${args.pass} work log contains duplicate unit IDs`);
  const unitKinds = new Set(workRows.map(({ unit_kind: unitKind }) => unitKind));
  if (unitKinds.size !== 1) throw new Error(`${args.pass} work log must use one unit kind`);
  const eventByUnitId = new Map((pass.work_events ?? []).map((event) => [event.unit_id, event]));
  const expectedEventIds = unitIds.map((unitId) => eventByUnitId.get(unitId)?.event_id);
  if (expectedEventIds.some((eventId) => !eventId)) throw new Error(`${args.pass} work log contains an unbound work row`);
  for (const row of workRows) {
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw new Error(`${args.pass} work log contains an invalid payload`);
    if (!row.input || typeof row.input !== 'object' || Array.isArray(row.input)) throw new Error(`${args.pass} work log contains no recorder-bound input`);
    if (!row.producer || typeof row.producer !== 'object' || Array.isArray(row.producer)) throw new Error(`${args.pass} work log contains no recorder-bound producer execution`);
    if (Date.parse(row.recorded_at) < Date.parse(pass.started_at) || Date.parse(row.recorded_at) > Date.parse(completedAt)) {
      throw new Error(`${args.pass} work row timestamp is outside the timing interval`);
    }
    if (Date.parse(row.producer.started_at) < Date.parse(pass.started_at) || Date.parse(row.producer.completed_at) > Date.parse(completedAt)) {
      throw new Error(`${args.pass} producer execution is outside the timing interval`);
    }
    if (row.recorded_at !== row.producer.completed_at) throw new Error(`${args.pass} work row timestamp must equal producer completion`);
    if (sha256Json(row.input.payload) !== row.input.payload_sha256) throw new Error(`${args.pass} work input digest changed after recording`);
    if (row.producer.input_payload_sha256 !== row.input.payload_sha256) throw new Error(`${args.pass} producer input digest is not bound to the work input`);
    if (row.producer.output_sha256 !== sha256Json(row.payload)) throw new Error(`${args.pass} producer output digest is not bound to the work payload`);
    if (sha256Json(row.payload) !== eventByUnitId.get(row.unit_id).payload_sha256) {
      throw new Error(`${args.pass} work row payload changed after recording`);
    }
    if (row.producer.module_sha256 !== eventByUnitId.get(row.unit_id).producer_module_sha256
      || row.producer.started_at !== eventByUnitId.get(row.unit_id).producer_started_at
      || row.producer.completed_at !== eventByUnitId.get(row.unit_id).producer_completed_at
      || row.input.payload_sha256 !== eventByUnitId.get(row.unit_id).input_payload_sha256) {
      throw new Error(`${args.pass} producer execution binding changed after recording`);
    }
  }
  const workEvidence = {
    unit_kind: [...unitKinds][0],
    unit_count: unitIds.length,
    unit_ids: unitIds,
    work_event_ids: expectedEventIds,
    before_sha256: inputArtifact.sha256,
    after_sha256: outputArtifact.sha256,
    input_artifact: { path: inputArtifact.path, sha256: inputArtifact.sha256 },
    output_artifact: { path: outputArtifact.path, sha256: outputArtifact.sha256 },
    work_log: { path: outputArtifact.path, sha256: outputArtifact.sha256 },
    note: `Recorder-created cumulative JSONL work log with ${unitIds.length} ${[...unitKinds][0]} unit(s).`,
  };
  const elapsed = (Date.parse(completedAt) - Date.parse(pass.started_at)) / 1000;
    session.passes[index] = {
      id: args.pass,
      status: 'complete',
      started_at: pass.started_at,
      session_id: pass.session_id,
      recording_source: pass.recording_source,
      output_artifact_created_at: pass.output_artifact_created_at,
      completed_at: completedAt,
    wall_clock_seconds: elapsed,
    producer_seconds: elapsed,
    work_evidence: workEvidence,
    ...(args.pass === 'post-freeze-audit' ? {
      audit_session_id: pass.audit_session_id,
      reviewed_staging_sha256: pass.reviewed_staging_sha256,
    } : {}),
  };
  session.events.push({
    event_id: `m5-10-wave-b-timing-event-${String(session.events.length + 1).padStart(4, '0')}`,
    pass_id: args.pass,
    kind: 'stop',
    session_id: pass.session_id,
    at: completedAt,
  });
  if (session.passes.every(({ status }) => status === 'complete')) {
    session.status = 'complete';
    session.note = 'Wave B producer-throughput timing completed from recorder start/stop events and recorder-created work-log rows bound to timed producer executions. Editorial judgment time is not measured by this session.';
    session.recording_proof_sha256 = createWaveBTimingProof(session);
  }
  await writeJson(outputPath, session);
  console.log(`Stopped ${session.timing_kind} pass ${args.pass}: ${outputPath}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  for (const forbidden of ['before-sha256', 'after-sha256', 'staging-sha256', 'unit-count', 'unit-ids', 'work-json', 'work-record']) {
    if (Object.hasOwn(args, forbidden)) throw new Error(`--${forbidden} is not accepted; timing scope is derived from recorder-created work-log rows`);
  }
  if (args.action === 'init') return initSession(args);
  if (args.action === 'start') return startPass(args);
  if (args.action === 'work') return recordWork(args);
  if (args.action === 'stop') return stopPass(args);
  throw new Error('--action must be init, start, work, or stop');
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

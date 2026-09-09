import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALIBRATION_TIMING_PASS_IDS,
  CALIBRATION_TIMING_RECORDING_COMMAND,
  CALIBRATION_TIMING_RECORDER_VERSION,
  createCalibrationTimingSession,
  finalizeCalibrationTimingRecording,
  startCalibrationTimingPass,
  stopCalibrationTimingPass,
} from './timing.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-relation-calibration-timing.json',
);

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

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`timing session does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new Error(`timing session is not valid JSON: ${error.message}`);
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

function assertSession(session) {
  if (!session || typeof session !== 'object'
    || session.status !== 'in-progress'
    || session.recorder_version !== CALIBRATION_TIMING_RECORDER_VERSION
    || session.recording_source !== CALIBRATION_TIMING_RECORDER_VERSION
    || session.recorder_command !== CALIBRATION_TIMING_RECORDING_COMMAND
    || session.clock_source !== 'system-clock'
    || !Array.isArray(session.passes)
    || JSON.stringify(session.passes.map(({ id }) => id)) !== JSON.stringify(CALIBRATION_TIMING_PASS_IDS)) {
    throw new Error('timing input must be an in-progress recorder session');
  }
}

function requirePass(args) {
  if (!args.pass || !CALIBRATION_TIMING_PASS_IDS.includes(args.pass)) {
    throw new Error(`--pass must be one of ${CALIBRATION_TIMING_PASS_IDS.join(', ')}`);
  }
  return args.pass;
}

function workEvidenceFromArgs(args, passId) {
  const hasCaseIds = Object.hasOwn(args, 'case-ids');
  const hasDigest = Object.hasOwn(args, 'raw-proposal-sha256');
  if (passId !== 'final-audit' && (hasCaseIds || hasDigest)) {
    throw new Error('--case-ids and --raw-proposal-sha256 are only accepted when stopping final-audit');
  }
  if (passId !== 'final-audit') return undefined;
  if (!hasCaseIds || !hasDigest) {
    throw new Error('stopping final-audit requires --case-ids and --raw-proposal-sha256');
  }
  const caseIds = args['case-ids'].split(',').map((caseId) => caseId.trim()).filter(Boolean);
  return {
    case_ids: caseIds,
    case_count: caseIds.length,
    raw_proposal_sha256: args['raw-proposal-sha256'],
  };
}

function startPass(session, passId) {
  const passIndex = CALIBRATION_TIMING_PASS_IDS.indexOf(passId);
  const pass = session.passes[passIndex];
  if (pass.status !== 'unmeasured') throw new Error(`${passId} is not an unmeasured pass`);
  if (session.passes.some(({ status }) => status === 'in-progress')) {
    throw new Error('a calibration timing pass is already in progress');
  }
  const prior = session.passes.slice(0, passIndex);
  if (prior.some(({ status }) => status !== 'complete')) {
    throw new Error(`${passId} cannot start before earlier passes are complete`);
  }
  session.passes[passIndex] = startCalibrationTimingPass({ passId });
  return session;
}

function stopPass(session, passId, workEvidence) {
  const passIndex = CALIBRATION_TIMING_PASS_IDS.indexOf(passId);
  const pass = session.passes[passIndex];
  if (pass.status !== 'in-progress') throw new Error(`${passId} has no active recorder start`);
  session.passes[passIndex] = stopCalibrationTimingPass(pass, { workEvidence });
  if (session.passes.every(({ status }) => status === 'complete')) {
    return finalizeCalibrationTimingRecording(session);
  }
  return session;
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

  if (action === 'start') {
    let session;
    if (args.input) {
      session = await readJson(path.resolve(args.input));
      assertSession(session);
    } else {
      await ensureNewOutput(outputPath);
      session = createCalibrationTimingSession({
        processedStartCount: Number(args['processed-start-count'] ?? 20),
      });
    }
    const updated = startPass(session, requirePass(args));
    await writeJson(outputPath, updated);
    console.log(`Started explicit calibration timing pass ${args.pass}; session state is in ${path.relative(process.cwd(), outputPath)}.`);
    return updated;
  }

  if (!args.input) throw new Error('--input is required for a stop action');
  const inputPath = path.resolve(args.input);
  const session = await readJson(inputPath);
  assertSession(session);
  const passId = requirePass(args);
  const workEvidence = workEvidenceFromArgs(args, passId);
  const updated = stopPass(session, passId, workEvidence);
  await writeJson(outputPath, updated);
  const final = !updated.status;
  console.log(`${final ? 'Finalized' : 'Stopped'} explicit calibration timing pass ${args.pass} in ${path.relative(process.cwd(), outputPath)}.`);
  return updated;
}

const isMainModule =
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPOSITORY_DIRECTORY,
  timingPassCycle,
  validateBatchManifest,
} from './validate-batch.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export class TimingRecordingError extends Error {
  constructor(message, code = 'TIMING_RECORDING_ERROR') {
    super(message);
    this.name = 'TimingRecordingError';
    this.code = code;
  }
}

function fail(message, code = 'TIMING_RECORDING_ERROR') {
  throw new TimingRecordingError(message, code);
}

function requireFeedbackTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail('feedbackReceivedAt must be an ISO-8601 UTC timestamp', 'INVALID_FEEDBACK_TIMESTAMP');
  }
}

function optionalPasses(manifest) {
  return manifest.measurement.timing.passes.filter(
    ({ id }) => id === 'post-review-audit' || id === 'post-review-fixes',
  );
}

export function nextFeedbackCycle(manifest) {
  validateBatchManifest(manifest);
  const passes = optionalPasses(manifest);
  if (passes.length === 0) return 1;
  const cycles = passes.map((pass) => timingPassCycle(pass));
  return Math.max(...cycles) + 1;
}

function prepareLegacyFollowUpCycles(passes) {
  const followUps = passes.filter(
    ({ id }) => id === 'post-review-audit' || id === 'post-review-fixes',
  );
  if (followUps.length === 0 || followUps.every((pass) => Object.hasOwn(pass, 'cycle'))) {
    return passes;
  }
  if (followUps.length !== 2 || followUps.some((pass) => Object.hasOwn(pass, 'cycle'))) {
    fail(
      'legacy follow-up timing must contain one complete audit/fixes pair before a new cycle is recorded',
      'INCOMPLETE_LEGACY_CYCLE',
    );
  }
  return passes.map((pass) => (
    followUps.includes(pass) ? { ...pass, cycle: 1 } : pass
  ));
}

export function appendFeedbackCycle(
  manifest,
  {
    feedbackReceivedAt,
    auditNote = 'PR feedback cycle audit is awaiting actual start/stop measurement.',
    fixesNote = 'PR feedback cycle fixes are awaiting actual start/stop measurement.',
  } = {},
) {
  validateBatchManifest(manifest);
  requireFeedbackTimestamp(feedbackReceivedAt);
  if (typeof auditNote !== 'string' || auditNote.trim().length === 0) {
    fail('auditNote must be a non-empty string', 'INVALID_NOTE');
  }
  if (typeof fixesNote !== 'string' || fixesNote.trim().length === 0) {
    fail('fixesNote must be a non-empty string', 'INVALID_NOTE');
  }

  const preparedPasses = prepareLegacyFollowUpCycles(
    manifest.measurement.timing.passes.map((pass) => structuredClone(pass)),
  );
  const cycle = preparedPasses.length === 0
    ? 1
    : Math.max(
      0,
      ...preparedPasses
        .filter(({ id }) => id === 'post-review-audit' || id === 'post-review-fixes')
        .map((pass) => timingPassCycle(pass)),
    ) + 1;
  const followUp = [
    {
      id: 'post-review-audit',
      cycle,
      feedback_received_at: feedbackReceivedAt,
      status: 'unmeasured',
      note: auditNote,
    },
    {
      id: 'post-review-fixes',
      cycle,
      feedback_received_at: feedbackReceivedAt,
      status: 'unmeasured',
      note: fixesNote,
    },
  ];
  const updated = structuredClone(manifest);
  updated.measurement.timing.contract_version = 'm5-9a-v1';
  updated.measurement.timing.status = 'incomplete';
  updated.measurement.timing.passes = [...preparedPasses, ...followUp];
  validateBatchManifest(updated);
  return updated;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') fail(`manifest does not exist: ${filePath}`, 'MISSING_MANIFEST');
    if (error instanceof SyntaxError) fail(`manifest is not valid JSON: ${error.message}`, 'INVALID_JSON');
    throw error;
  }
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args.manifest || !args.output || !args['feedback-received-at']) {
    fail('--manifest, --output, and --feedback-received-at are required', 'MISSING_ARGUMENT');
  }
  const manifestPath = path.resolve(args.manifest);
  const outputPath = path.resolve(args.output);
  const manifest = await readJson(manifestPath);
  const updated = appendFeedbackCycle(manifest, {
    feedbackReceivedAt: args['feedback-received-at'],
    auditNote: args['audit-note'],
    fixesNote: args['fixes-note'],
  });
  await writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  console.log(`Recorded feedback cycle ${nextFeedbackCycle(manifest)} for ${path.relative(REPOSITORY_DIRECTORY, manifestPath)}.`);
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

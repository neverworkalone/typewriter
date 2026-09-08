import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALIBRATION_TIMING_RECORDING_COMMAND,
  recordCalibrationTimingSession,
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const forbidden = ['started-at', 'completed-at', 'editor-seconds', 'session-id', 'now'];
  for (const argument of forbidden) {
    if (Object.hasOwn(args, argument)) {
      throw new Error(`--${argument} is not accepted; the timing recorder uses its current clock and generated sessions`);
    }
  }
  const outputPath = path.resolve(args.output ?? DEFAULT_OUTPUT_PATH);
  const recording = await recordCalibrationTimingSession({
    processedStartCount: Number(args['processed-start-count'] ?? 20),
    recorderCommand: CALIBRATION_TIMING_RECORDING_COMMAND,
  });
  await writeFile(outputPath, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
  console.log(`Recorded M5-10A calibration timing in ${path.relative(process.cwd(), outputPath)}.`);
  return recording;
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

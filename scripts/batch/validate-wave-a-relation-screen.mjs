import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPOSITORY_DIRECTORY } from './validate-batch.mjs';
import { validateRelationScreen } from './relation-screen.mjs';

export const DEFAULT_SCREEN_PATH = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-10-wave-a-relation-screen.json',
);
export const DEFAULT_RELATION_DIFF_PATH = path.resolve(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-10-wave-a-relation-diff.json',
);

class WaveARelationScreenValidationError extends Error {
  constructor(message, code = 'WAVE_A_RELATION_SCREEN_VALIDATION_ERROR') {
    super(message);
    this.name = 'WaveARelationScreenValidationError';
    this.code = code;
  }
}

function fail(message, code = 'WAVE_A_RELATION_SCREEN_VALIDATION_ERROR') {
  throw new WaveARelationScreenValidationError(message, code);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJsonSource(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_INPUT');
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
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

export async function validateWaveARelationScreen({
  screenPath = DEFAULT_SCREEN_PATH,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
} = {}) {
  const resolvedScreenPath = path.resolve(screenPath);
  const resolvedRelationDiffPath = path.resolve(relationDiffPath);
  const [screenSource, relationDiffSource] = await Promise.all([
    readJsonSource(resolvedScreenPath, 'relation screen artifact'),
    readJsonSource(resolvedRelationDiffPath, 'relation diff artifact'),
  ]);
  const relativeRelationDiffPath = path.relative(REPOSITORY_DIRECTORY, resolvedRelationDiffPath);
  if (screenSource.value.source?.relation_diff !== relativeRelationDiffPath) {
    fail(
      `relation screen source.relation_diff ${screenSource.value.source?.relation_diff} does not match ${relativeRelationDiffPath}`,
      'SOURCE_PATH_MISMATCH',
    );
  }
  const summary = validateRelationScreen(
    screenSource.value,
    relationDiffSource.value,
    {
      relationDiffPath: relativeRelationDiffPath,
      relationDiffSha256: relationDiffSource.sha256,
    },
  );
  return {
    ...summary,
    source: {
      screen: path.relative(REPOSITORY_DIRECTORY, resolvedScreenPath),
      screen_sha256: screenSource.sha256,
      relation_diff: relativeRelationDiffPath,
      relation_diff_sha256: relationDiffSource.sha256,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const result = await validateWaveARelationScreen({
    screenPath: args.screen ?? DEFAULT_SCREEN_PATH,
    relationDiffPath: args['relation-diff'] ?? DEFAULT_RELATION_DIFF_PATH,
  });
  if (args.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Validated ${result.artifact_id}: ${result.pre_screened_count} pre-screened, ${result.human_admitted_count} human-admitted, ${result.human_rejected_count} human-rejected relation candidate(s).`,
    );
  }
  return result;
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

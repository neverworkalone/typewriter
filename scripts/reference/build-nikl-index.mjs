import path from 'node:path';

import {
  assertNiklCorpusPermission,
  auditNiklCorpus,
  buildNiklIndex,
  DEFAULT_INDEX_PATH,
  DEFAULT_INPUT_DIRECTORY,
} from './nikl-index.mjs';

function usage() {
  return [
    'Usage: node scripts/reference/build-nikl-index.mjs [options]',
    '',
    'Options:',
    '  --input-dir <path>  JSON source directory (default: data/reference/corpus/)',
    '  --output <path>     SQLite output (default: data/reference/indexes/nikl-written-2025.sqlite)',
    '  --check-only        Run the full schema preflight without building SQLite',
    '  --help              Show this help',
  ].join('\n');
}

function parseArguments(argumentsList) {
  const options = {
    inputDirectory: DEFAULT_INPUT_DIRECTORY,
    outputPath: DEFAULT_INDEX_PATH,
    checkOnly: false,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (argument === '--check-only') {
      options.checkOnly = true;
      continue;
    }
    if (argument === '--input-dir' || argument === '--output') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(argument + ' requires a path.');
      }
      index += 1;
      if (argument === '--input-dir') {
        options.inputDirectory = path.resolve(value);
      } else {
        options.outputPath = path.resolve(value);
      }
      continue;
    }
    throw new Error('Unknown option: ' + argument);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    await assertNiklCorpusPermission();
    const summary = options.checkOnly
      ? await auditNiklCorpus({ inputDirectory: options.inputDirectory })
      : await buildNiklIndex(options);
    console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

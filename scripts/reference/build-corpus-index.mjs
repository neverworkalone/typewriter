import path from 'node:path';

import {
  assertCorpusPermission,
  auditCorpus,
  buildCorpusIndex,
  DEFAULT_INPUT_DIRECTORY,
} from './corpus-index.mjs';

function usage() {
  return [
    'Usage: node scripts/reference/build-corpus-index.mjs [options]',
    '',
    'Options:',
    '  --input-dir <path>  JSON source directory (default: ~/.cache/typewriter/corpus/)',
    '  --check-only        Run the full schema preflight without building SQLite',
    '  --help              Show this help',
  ].join('\n');
}

function parseArguments(argumentsList) {
  const options = {
    inputDirectory: DEFAULT_INPUT_DIRECTORY,
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
    if (argument === '--input-dir') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(argument + ' requires a path.');
      }
      index += 1;
      options.inputDirectory = path.resolve(value);
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
    await assertCorpusPermission();
    const summary = options.checkOnly
      ? await auditCorpus({ inputDirectory: options.inputDirectory })
      : await buildCorpusIndex(options);
    console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

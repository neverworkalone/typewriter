import path from 'node:path';

import {
  assertCorpusPermission,
  countCorpusMatches,
  DEFAULT_INDEX_PATH,
  searchCorpusIndex,
} from './corpus-index.mjs';

function parseArguments(argumentsList) {
  const options = { databasePath: DEFAULT_INDEX_PATH, countOnly: false };
  const positional = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--index') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--index requires a path.');
      }
      options.databasePath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--limit') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--limit requires a positive integer.');
      }
      options.limit = Number(value);
      index += 1;
      continue;
    }
    if (argument === '--count') {
      options.countOnly = true;
      continue;
    }
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    positional.push(argument);
  }

  if (positional.length > 1) {
    throw new Error('Provide one literal search query.');
  }
  if (options.countOnly && options.limit !== undefined) {
    throw new Error('--count cannot be combined with --limit.');
  }
  options.query = positional[0];
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/reference/search-corpus-index.mjs [--index <path>] [--limit <1–200; default 50>] [--count] <literal query>',
    );
  } else {
    if (options.query === undefined) {
      throw new Error('Provide one literal search query.');
    }
    await assertCorpusPermission();
    const searchMode = [...options.query].length >= 3
      ? 'fts5-trigram'
      : 'literal-scan';
    if (options.countOnly) {
      console.log(JSON.stringify({
        evidence_type: 'literal_text_match_count',
        search_mode: searchMode,
        match_count: countCorpusMatches(options),
      }, null, 2));
    } else {
      console.log(JSON.stringify({
        evidence_type: 'literal_text_matches',
        search_mode: searchMode,
        results: searchCorpusIndex(options),
      }, null, 2));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

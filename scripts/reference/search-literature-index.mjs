import path from 'node:path';

import {
  assertLiteraturePermission,
  DEFAULT_FULL_LITERATURE_INDEX_PATH,
  searchLiteratureIndex,
} from './literature-index.mjs';

const USAGE = 'Usage: node scripts/reference/search-literature-index.mjs [--index <path>] [--limit <1–200; default 50>] [--genre <poem|novel|essay>] [--context <0–3; default 2>] <literal query>';

try {
  const options = { databasePath: DEFAULT_FULL_LITERATURE_INDEX_PATH };
  const positional = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') { options.help = true; continue; }
    if (['--index', '--limit', '--genre', '--context'].includes(flag)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value.');
      if (flag === '--index') options.databasePath = path.resolve(value);
      if (flag === '--limit') options.limit = Number(value);
      if (flag === '--genre') options.genre = value;
      if (flag === '--context') options.context = Number(value);
      index += 1;
      continue;
    }
    positional.push(flag);
  }
  if (options.help) {
    console.log(USAGE);
  } else {
    if (positional.length !== 1) throw new Error('Provide one literal search query.');
    await assertLiteraturePermission();
    console.log(JSON.stringify(searchLiteratureIndex({ ...options, query: positional[0] }), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

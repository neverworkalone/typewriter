import { readFile } from 'node:fs/promises';

import { writeShardedJson } from '../lib/sharded-json.mjs';
import { SEMANTIC_DECISION_SOURCE_ARRAYS } from '../lib/sharded-json-sources.mjs';

// One-off migration of the single 65.7MB file into manifest + shards.
const target = new URL('../../data/validation/canonical-semantic-decision-source.json', import.meta.url).pathname;
const logical = JSON.parse(await readFile(target, 'utf8'));
const changed = await writeShardedJson(logical, target, { arrayPaths: SEMANTIC_DECISION_SOURCE_ARRAYS });
console.log(changed.join('\n'));

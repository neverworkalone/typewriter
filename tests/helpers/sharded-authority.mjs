import { cp } from 'node:fs/promises';

import { readShardedJson } from '../../scripts/lib/sharded-json.mjs';

export { readShardedJson };

// Copy the sharded canonical semantic decision source (manifest plus its shard directory).
export async function copyShardedAuthority(from, to) {
  await cp(from, to);
  await cp(from.replace(/\.json$/u, '.shards'), to.replace(/\.json$/u, '.shards'), { recursive: true });
}

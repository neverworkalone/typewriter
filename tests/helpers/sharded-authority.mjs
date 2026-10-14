import { cp } from 'node:fs/promises';

import { readShardedJson } from '../../scripts/lib/sharded-json.mjs';

export { readShardedJson };

// Copy the canonical semantic decision source (manifest plus its shard directory, when it is sharded).
export async function copyShardedAuthority(from, to) {
  await cp(from, to);
  try {
    await cp(from.replace(/\.json$/u, '.shards'), to.replace(/\.json$/u, '.shards'), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

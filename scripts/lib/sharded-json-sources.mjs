import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { planShardedJsonChanges } from './sharded-json.mjs';

// Growing sources stored with scripts/lib/sharded-json.mjs, and the arrays that are sharded in each.
export const SEMANTIC_DECISION_SOURCE_PATH = 'data/validation/canonical-semantic-decision-source.json';
export const SEMANTIC_DECISION_SOURCE_ARRAYS = [
  { path: ['authored_review', 'records'], key: (row) => row.record_id },
  { path: ['factory_admissions'], key: (event) => `${event.batch_id}-a${event.attempt}` },
];

/**
 * Files (absolute path and bytes) that store `logicalBytes` at `decisionSourcePath`: the manifest and changed shards when the
 * target is sharded (plus shards to delete, with `bytes: null`), otherwise the single file. Lets an all-or-nothing promotion cover exactly the files that change.
 */
export async function planDecisionSourceFiles(logicalBytes, decisionSourcePath) {
  const existing = await readFile(decisionSourcePath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!existing.includes('"$shards"')) return [{ path: decisionSourcePath, bytes: logicalBytes }];
  const { changed, stale } = await planShardedJsonChanges(JSON.parse(logicalBytes.toString('utf8')), decisionSourcePath, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
  const directory = path.dirname(decisionSourcePath);
  return [
    ...[...changed].map(([file, text]) => ({ path: path.join(directory, file), bytes: Buffer.from(text, 'utf8') })),
    // A shard whose last row is gone is deleted in the same promotion (`bytes: null`).
    ...stale.map((file) => ({ path: path.join(directory, file), bytes: null })),
  ];
}

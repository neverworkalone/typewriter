/** Build the two-character posting sidecar for the local corpus index (Issue #247). Local/manual. */
import { DEFAULT_INDEX_PATH, assertCorpusPermission } from './corpus-index.mjs';
import { buildShortQueryPostings } from './short-query-postings.mjs';

await assertCorpusPermission();
console.log(JSON.stringify(await buildShortQueryPostings({ indexPath: DEFAULT_INDEX_PATH }), null, 2));

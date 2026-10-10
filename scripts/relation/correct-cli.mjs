import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyRelationCorrections, readCanonicalFiles, relationMeanings } from './backfill-apply.mjs';

// Relation corrections (#501): `pnpm run relation:correct <proposals.json>`. The file is `{ "corrections": [{
// source_sense_id, previous_relation, target_meaning_sha256, relation | null, rationale }] }`: the exact tuple the
// reviewer saw, the digest of the target meaning they judged it against (`--meaning <sense_id>` prints it), its
// replacement (null removes it) and a source-bound rationale. Everything else (source record, gloss digest, position,
// packet id) is derived from the current canonical data and committed in the backfill packet.

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [file, senseId] = process.argv.slice(2);
if (file === '--meaning' && senseId) {
  // The tuples of a sense with the target meaning digest each correction must cite as `target_meaning_sha256`.
  console.log(JSON.stringify(relationMeanings((await readCanonicalFiles(REPOSITORY_DIRECTORY)).records, senseId), null, 2));
  process.exit(0);
}
if (!file) {
  console.error('usage: pnpm run relation:correct <proposals.json> | pnpm run relation:correct --meaning <sense_id>');
  process.exit(2);
}
let proposals;
try { proposals = JSON.parse(await readFile(path.resolve(file), 'utf8')).corrections; } catch (error) {
  console.error(`cannot read correction proposals ${file}: ${error.message}`);
  process.exit(2);
}
if (!Array.isArray(proposals) || proposals.length === 0) {
  console.error('the proposals file needs a non-empty "corrections" array');
  process.exit(2);
}
try {
  const result = await applyRelationCorrections({ root: REPOSITORY_DIRECTORY, proposals });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

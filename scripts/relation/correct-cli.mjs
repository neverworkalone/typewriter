import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyRelationCorrections } from './backfill-apply.mjs';

// Relation corrections (#501): `pnpm run relation:correct <proposals.json>`. The file is `{ "corrections": [{
// source_sense_id, previous_relation, relation | null, rationale }] }`: the exact tuple the reviewer saw, its
// replacement (null removes it) and a source-bound rationale. Everything else (source record, gloss digest, position,
// packet id) is derived from the current canonical data and committed in the backfill packet.

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: pnpm run relation:correct <proposals.json>');
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

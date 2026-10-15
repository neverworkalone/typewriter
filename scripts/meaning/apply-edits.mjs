import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  entryIdOfSense, parseMeaningId, parseShardFileName, readAdjudications, readMeanings, validateAdjudicationRow, validateMeaningRow,
  writeAdjudications,
} from './contract.mjs';

/**
 * Applies an edit spec to the meaning/adjudication rows (Issue #715).
 *
 * Spec: `{ merges: [{ entry, senses: [n, ...], gloss }], drops: [{ sense_id, duplicate_of, reason? }] }`.
 * - A merge replaces the single-sense meanings of `entry`'s senses `senses` with ONE meaning whose id is the id of the
 *   lowest-numbered member (`mNNN_K`, or `mNNN` when the record has one sense), whose `sense_ids` list all members and
 *   whose gloss is the authored `gloss`. Members must still be untouched single-sense meanings.
 * - A drop removes the meaning of `sense_id` and records the verdict in adjudication. `duplicate_of` must stay referenced.
 * Pure: returns new row arrays; the CLI writes them. Throws with every problem found instead of partially applying.
 */
export function applyEdits({ meanings, adjudications }, spec) {
  const errors = [];
  const bySense = new Map();
  for (const row of meanings) for (const senseId of row.sense_ids) bySense.set(senseId, row);
  const removed = new Set();
  const added = [];
  const newAdjudications = [];
  const claimed = new Set();

  const claim = (senseId, where) => {
    if (claimed.has(senseId)) { errors.push(`${where}: sense ${senseId} is edited more than once`); return null; }
    claimed.add(senseId);
    const row = bySense.get(senseId);
    if (!row) errors.push(`${where}: sense ${senseId} has no meaning (already dropped or unknown)`);
    else if (row.sense_ids.length !== 1) errors.push(`${where}: meaning ${row.id} is already merged`);
    return row ?? null;
  };

  for (const [i, merge] of (spec.merges ?? []).entries()) {
    const where = `merges[${i}] (${merge.entry})`;
    const ordinals = [...merge.senses].sort((a, b) => a - b);
    if (ordinals.length < 2) { errors.push(`${where}: a merge needs at least two senses`); continue; }
    const senseIds = ordinals.map((n) => `${merge.entry}-s${n}`);
    const rows = senseIds.map((senseId) => claim(senseId, where));
    if (rows.some((row) => !row)) continue;
    const first = rows[0];
    const id = parseMeaningId(first.id);
    const merged = { id: first.id, lemma: first.lemma, gloss: merge.gloss, sense_ids: senseIds };
    if (rows.some((row) => row.lemma !== first.lemma)) errors.push(`${where}: senses belong to different lemmas`);
    if (!id) errors.push(`${where}: bad id ${first.id}`);
    errors.push(...validateMeaningRow(merged, where));
    for (const row of rows) removed.add(row.id);
    added.push(merged);
  }

  for (const [i, drop] of (spec.drops ?? []).entries()) {
    const where = `drops[${i}] (${drop.sense_id})`;
    const row = claim(drop.sense_id, where);
    if (!row) continue;
    const verdict = { sense_id: drop.sense_id, lemma: row.lemma, decision: 'drop', reason: drop.reason ?? 'duplicate', duplicate_of: drop.duplicate_of };
    errors.push(...validateAdjudicationRow(verdict, where));
    if (entryIdOfSense(drop.duplicate_of) !== entryIdOfSense(drop.sense_id) && !bySense.has(drop.duplicate_of)) {
      errors.push(`${where}: duplicate_of ${drop.duplicate_of} has no meaning`);
    }
    removed.add(row.id);
    newAdjudications.push(verdict);
  }
  for (const verdict of newAdjudications) {
    if (claimed.has(verdict.duplicate_of) && !added.some((m) => m.sense_ids.includes(verdict.duplicate_of))) {
      errors.push(`${verdict.sense_id}: duplicate_of ${verdict.duplicate_of} is itself dropped`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    meanings: [...meanings.filter((row) => !removed.has(row.id)), ...added],
    adjudications: [...adjudications, ...newAdjudications],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const specPath = process.argv[2];
  if (!specPath || !existsSync(specPath)) { console.error('usage: node scripts/meaning/apply-edits.mjs <spec.json>'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const meaningsDirectory = path.join(root, 'data/meanings');
  const adjudicationDirectory = path.join(root, 'data/adjudication');
  const current = { meanings: readMeanings(meaningsDirectory), adjudications: readAdjudications(adjudicationDirectory) };
  const problems = [...current.meanings.errors, ...current.adjudications.errors];
  if (problems.length) { console.error(problems.slice(0, 50).join('\n')); process.exit(1); }
  const next = applyEdits({ meanings: current.meanings.rows, adjudications: current.adjudications.rows }, spec);
  // Edit in place: every row stays in its current shard so an edit never reflows (and re-diffs) unrelated shards.
  const position = new Map();
  const fileOf = new Map();
  for (const file of readdirSync(meaningsDirectory).filter((name) => parseShardFileName(name)).sort()) {
    for (const line of readFileSync(path.join(meaningsDirectory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      position.set(row.id, position.size);
      fileOf.set(row.id, file);
    }
  }
  const perFile = new Map();
  for (const row of next.meanings) {
    const file = fileOf.get(row.id);
    if (!perFile.has(file)) perFile.set(file, []);
    perFile.get(file).push(row);
  }
  for (const file of fileOf.values()) {
    if (!perFile.has(file)) throw new Error(`${file}: every row was removed; empty shards are not allowed`);
  }
  for (const [file, rows] of perFile) {
    rows.sort((a, b) => position.get(a.id) - position.get(b.id));
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    if (readFileSync(path.join(meaningsDirectory, file), 'utf8') !== text) writeFileSync(path.join(meaningsDirectory, file), text);
  }
  if (next.adjudications.length) writeAdjudications(adjudicationDirectory, next.adjudications);
  console.log(`applied ${spec.merges?.length ?? 0} merges and ${spec.drops?.length ?? 0} drops: ${next.meanings.length} meanings, ${next.adjudications.length} adjudications`);
}

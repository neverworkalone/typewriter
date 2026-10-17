import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareSenseIds, entryIdOfSense, parseShardFileName, readAdjudications, readMeanings, validateAdjudicationRow, validateMeaningDataset, validateMeaningRow,
  writeAdjudications,
} from './contract.mjs';
import { projectInitialMeanings, readCanonicalEntries } from './initial.mjs';

/**
 * Applies an edit spec to the meaning/adjudication rows (Issues #715 and #764).
 *
 * Spec: `{ glosses, merges, repartitions, drops, relations }`.
 * - A merge replaces the single-sense meanings of `senses` (one or several records of the SAME lemma) with ONE meaning
 *   whose id is the id of the first member in canonical order, whose `sense_ids` list all members in that order and
 *   whose gloss is the authored `gloss`. Members must still be untouched single-sense meanings.
 * - A gloss edit rewrites one untouched single-sense meaning in place, preserving its id and sense binding.
 * - A `duplicate` drop removes the meaning and requires a still-referenced `duplicate_of`; an `out_of_scope` drop
 *   removes the meaning and must omit `duplicate_of`.
 * - A relation edit (Issue #797) appends authored `{ type, target, note }` relations to the named final meaning, which
 *   are projected with `origin = typewriter-authored`. Re-running the same spec is a no-op; a merge, repartition or
 *   drop that would silently discard authored relations is rejected instead. `remove` re-points an authored relation
 *   whose target meaning id moved (another scope re-partitioned that meaning); it is best effort so a re-run stays a
 *   no-op, and it never touches a projected relation, which is not stored on the row.
 * Pure: returns new row arrays; the CLI writes them. Throws with every problem found instead of partially applying.
 */

/** The untouched row shape: authored relations are an optional trailing field, not an empty array. */
function stripRelations(row) {
  const rest = { ...row };
  delete rest.relations;
  return rest;
}

export function applyEdits({ meanings, adjudications, initialMeaningIds = null }, spec) {
  const errors = [];
  const bySense = new Map();
  for (const row of meanings) for (const senseId of row.sense_ids) bySense.set(senseId, row);
  const removed = new Set();
  const replacements = new Map();
  const added = [];
  const repartitioned = [];
  const repartitionedMeaningIds = new Set();
  const repartitionedSenseIds = new Set();
  const repartitionedLemmas = new Set();
  const newAdjudications = [];
  const claimed = new Set();

  const claim = (senseId, where) => {
    if (claimed.has(senseId)) { errors.push(`${where}: sense ${senseId} is edited more than once`); return null; }
    claimed.add(senseId);
    const row = bySense.get(senseId);
    if (!row) errors.push(`${where}: sense ${senseId} has no meaning (already dropped or unknown)`);
    else if (repartitionedSenseIds.has(senseId)) errors.push(`${where}: sense ${senseId} is already included in a repartition`);
    else if (row.sense_ids.length !== 1) errors.push(`${where}: meaning ${row.id} is already merged`);
    return row ?? null;
  };
  // Authored relations are committed editorial data, so an edit that removes their meaning must fail closed
  // instead of silently dropping them (re-author them in the same spec after the regroup).
  const rejectAuthoredRelations = (rows, where, action) => {
    const carriers = rows.filter((row) => (row?.relations ?? []).length > 0);
    if (carriers.length === 0) return false;
    errors.push(`${where}: ${action} would drop the authored relations of ${carriers.map((row) => row.id).join(', ')}`);
    return true;
  };

  for (const [i, edit] of (spec.glosses ?? []).entries()) {
    const where = `glosses[${i}] (${edit.sense_id})`;
    const row = claim(edit.sense_id, where);
    if (!row) continue;
    const rewritten = { ...row, gloss: edit.gloss };
    errors.push(...validateMeaningRow(rewritten, where));
    replacements.set(row.id, rewritten);
  }

  for (const [i, merge] of (spec.merges ?? []).entries()) {
    const where = `merges[${i}] (${(merge.senses ?? []).join(', ')})`;
    if (!Array.isArray(merge.senses) || merge.senses.length < 2) { errors.push(`${where}: a merge needs at least two senses`); continue; }
    const senseIds = [...merge.senses].sort(compareSenseIds);
    const rows = senseIds.map((senseId) => claim(senseId, where));
    if (rows.some((row) => !row)) continue;
    if (rejectAuthoredRelations(rows, where, 'a merge')) continue;
    const first = rows[0];
    if (rows.some((row) => row.lemma !== first.lemma)) { errors.push(`${where}: senses belong to different lemmas`); continue; }
    const merged = { id: first.id, lemma: first.lemma, gloss: merge.gloss, sense_ids: senseIds };
    errors.push(...validateMeaningRow(merged, where));
    for (const row of rows) removed.add(row.id);
    added.push(merged);
  }

  // A meaning regroup under a newer editorial boundary can split or coalesce current rows,
  // including rows that a previous adjudication already merged. The explicit before snapshot
  // makes this a deliberate, source-preserving reclassification rather than a reset.
  for (const [i, edit] of (spec.repartitions ?? []).entries()) {
    const where = `repartitions[${i}] (${edit.lemma})`;
    if (repartitionedLemmas.has(edit.lemma)) {
      errors.push(`${where}: lemma is included in more than one repartition`);
      continue;
    }
    if (!initialMeaningIds) {
      errors.push(`${where}: initial meaning ids from canonical data are required`);
      continue;
    }
    if (typeof edit.lemma !== 'string' || !edit.lemma.trim()) {
      errors.push(`${where}: lemma must be a non-empty string`);
      continue;
    }
    const current = meanings.filter((row) => row.lemma === edit.lemma);
    if (rejectAuthoredRelations(current, where, 'a repartition')) continue;
    const expected = edit.before;
    if (!Array.isArray(expected)) {
      errors.push(`${where}: before must list the exact current meaning rows`);
      continue;
    }
    if (expected.some((row) => !row || typeof row.id !== 'string' || typeof row.gloss !== 'string'
      || !Array.isArray(row.sense_ids) || row.sense_ids.some((senseId) => !entryIdOfSense(senseId)))) {
      errors.push(`${where}: before rows need valid ids, glosses and sense_ids`);
      continue;
    }
    const normalizeRows = (rows) => rows.map((row) => ({
      id: row.id,
      gloss: row.gloss,
      sense_ids: [...row.sense_ids].sort(compareSenseIds),
    })).sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(normalizeRows(current)) !== JSON.stringify(normalizeRows(expected))) {
      errors.push(`${where}: current meanings do not match the recorded before snapshot`);
      continue;
    }
    if (!Array.isArray(edit.groups) || edit.groups.length === 0) {
      errors.push(`${where}: groups must contain at least one final meaning`);
      continue;
    }
    const available = new Set(current.flatMap((row) => row.sense_ids));
    const localSeen = new Set();
    const nextRows = [];
    for (const [j, group] of edit.groups.entries()) {
      const groupWhere = `${where}.groups[${j}]`;
      if (!Array.isArray(group.senses) || group.senses.length === 0) {
        errors.push(`${groupWhere}: senses must be a non-empty array`);
        continue;
      }
      for (const senseId of group.senses) {
        if (!entryIdOfSense(senseId)) errors.push(`${groupWhere}: invalid sense id ${JSON.stringify(senseId)}`);
      }
      if (group.senses.some((senseId) => !entryIdOfSense(senseId))) continue;
      const senseIds = [...group.senses].sort(compareSenseIds);
      for (const senseId of senseIds) {
        if (!available.has(senseId)) errors.push(`${groupWhere}: sense ${senseId} is not in the current ${edit.lemma} meanings`);
        if (localSeen.has(senseId)) errors.push(`${groupWhere}: sense ${senseId} appears in more than one final group`);
        localSeen.add(senseId);
        if (repartitionedSenseIds.has(senseId)) errors.push(`${groupWhere}: sense ${senseId} appears in more than one repartition`);
        if (claimed.has(senseId)) errors.push(`${groupWhere}: sense ${senseId} is also changed by a gloss, merge, or drop`);
      }
      const firstSense = senseIds[0];
      const id = initialMeaningIds.get(firstSense);
      if (!id) errors.push(`${groupWhere}: no initial meaning id exists for ${firstSense}`);
      const row = { id, lemma: edit.lemma, gloss: group.gloss, sense_ids: senseIds };
      errors.push(...validateMeaningRow(row, groupWhere));
      nextRows.push(row);
    }
    for (const senseId of available) if (!localSeen.has(senseId)) errors.push(`${where}: current sense ${senseId} is missing from final groups`);
    if (localSeen.size !== available.size) continue;
    const hasLocalErrors = errors.some((message) => message.startsWith(where));
    if (hasLocalErrors) continue;
    repartitionedLemmas.add(edit.lemma);
    for (const row of current) {
      if (repartitionedMeaningIds.has(row.id)) errors.push(`${where}: meaning ${row.id} is included in more than one repartition`);
      repartitionedMeaningIds.add(row.id);
    }
    for (const senseId of localSeen) repartitionedSenseIds.add(senseId);
    repartitioned.push(...nextRows);
  }

  const dropped = new Set((spec.drops ?? []).map((drop) => drop.sense_id));
  for (const [i, drop] of (spec.drops ?? []).entries()) {
    const where = `drops[${i}] (${drop.sense_id})`;
    const row = claim(drop.sense_id, where);
    if (!row) continue;
    if (rejectAuthoredRelations([row], where, 'a drop')) continue;
    const reason = drop.reason ?? 'duplicate';
    const verdict = { sense_id: drop.sense_id, lemma: row.lemma, decision: 'drop', reason };
    if (reason === 'duplicate' || Object.hasOwn(drop, 'duplicate_of')) verdict.duplicate_of = drop.duplicate_of;
    errors.push(...validateAdjudicationRow(verdict, where));
    if (reason === 'duplicate') {
      // The target must be a currently valid meaning sense of the same lemma, wherever its record is.
      const target = bySense.get(drop.duplicate_of);
      if (!target || dropped.has(drop.duplicate_of)) errors.push(`${where}: duplicate_of ${drop.duplicate_of} has no meaning (unknown or itself dropped)`);
      else if (target.lemma !== row.lemma) errors.push(`${where}: duplicate_of ${drop.duplicate_of} belongs to lemma ${target.lemma}, not ${row.lemma}`);
    }
    removed.add(row.id);
    newAdjudications.push(verdict);
  }
  const result = {
    meanings: [...meanings.filter((row) => !removed.has(row.id) && !repartitionedMeaningIds.has(row.id)).map((row) => replacements.get(row.id) ?? row), ...added, ...repartitioned],
    adjudications: [...adjudications, ...newAdjudications],
  };
  // Authored relations are appended to the final rows, so `row.relations` keeps its trailing key order and the
  // stored shard stays byte-stable when the same spec is applied again.
  const authoredRelations = new Map();
  for (const [i, edit] of (spec.relations ?? []).entries()) {
    const where = `relations[${i}] (${edit.source_meaning_id})`;
    const row = result.meanings.find((item) => item.id === edit.source_meaning_id);
    if (!row) { errors.push(`${where}: no final meaning has this id (unknown, merged or dropped)`); continue; }
    const removals = edit.remove ?? [];
    const additions = edit.add ?? [];
    if (!Array.isArray(removals) || !Array.isArray(additions) || (removals.length === 0 && additions.length === 0)) {
      errors.push(`${where}: needs a non-empty add or remove array`); continue;
    }
    const list = authoredRelations.get(row.id) ?? { remove: [], add: [] };
    for (const [j, relation] of removals.entries()) {
      const removeWhere = `${where}.remove[${j}]`;
      if (!relation || typeof relation !== 'object' || Array.isArray(relation)) { errors.push(`${removeWhere}: not an object`); continue; }
      if (typeof relation.type !== 'string' || typeof relation.target !== 'string') { errors.push(`${removeWhere}: needs a type and a target`); continue; }
      // Best effort: re-applying the same spec must stay a no-op, so a relation that is already gone is not an error.
      list.remove.push({ type: relation.type, target: relation.target });
    }
    for (const [j, relation] of additions.entries()) {
      const addWhere = `${where}.add[${j}]`;
      if (!relation || typeof relation !== 'object' || Array.isArray(relation)) { errors.push(`${addWhere}: not an object`); continue; }
      if (typeof relation.type !== 'string' || typeof relation.target !== 'string') { errors.push(`${addWhere}: needs a type and a target`); continue; }
      list.add.push({ type: relation.type, target: relation.target, note: relation.note });
    }
    authoredRelations.set(row.id, list);
  }
  if (authoredRelations.size > 0) {
    result.meanings = result.meanings.map((row) => {
      const edit = authoredRelations.get(row.id);
      if (!edit) return row;
      // `remove` re-points an authored relation whose target Meaning id moved when another scope re-partitioned its
      // meanings (Issue #797 durability); a projected relation is never stored on the row, so it cannot be removed.
      const relations = (row.relations ?? []).filter((item) => (
        !edit.remove.some((relation) => relation.type === item.type && relation.target === item.target)
      ));
      for (const relation of edit.add) {
        if (!relations.some((item) => item.type === relation.type && item.target === relation.target)) relations.push(relation);
      }
      // A row left with no authored relation returns to its untouched shape instead of keeping an empty array.
      const updated = relations.length === 0 ? stripRelations(row) : { ...row, relations };
      errors.push(...validateMeaningRow(updated, `relations (${row.id})`));
      return updated;
    });
  }
  // The produced rows must satisfy the shared dataset contract (ids, representative record, references) before anything is written.
  if (!errors.length) errors.push(...validateMeaningDataset(result));
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  return result;
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
  let initialMeaningIds = null;
  if (spec.repartitions?.length) {
    initialMeaningIds = new Map();
    for (const row of projectInitialMeanings(readCanonicalEntries(path.join(root, 'data/canonical')))) {
      for (const senseId of row.sense_ids) initialMeaningIds.set(senseId, row.id);
    }
  }
  const next = applyEdits({ meanings: current.meanings.rows, adjudications: current.adjudications.rows, initialMeaningIds }, spec);
  // Edit in place: every row stays in its current shard so an edit never reflows (and re-diffs) unrelated shards.
  const fileOf = new Map();
  const fileForLemma = new Map();
  for (const file of readdirSync(meaningsDirectory).filter((name) => parseShardFileName(name)).sort()) {
    for (const line of readFileSync(path.join(meaningsDirectory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      fileOf.set(row.id, file);
      fileForLemma.set(row.lemma, file);
    }
  }
  const perFile = new Map();
  for (const row of next.meanings) {
    const file = fileOf.get(row.id) ?? fileForLemma.get(row.lemma);
    if (!file) throw new Error(`cannot locate a meaning shard for ${row.lemma} (${row.id})`);
    if (!perFile.has(file)) perFile.set(file, []);
    perFile.get(file).push(row);
  }
  for (const file of new Set(fileOf.values())) {
    if (!perFile.has(file)) rmSync(path.join(meaningsDirectory, file));
  }
  for (const [file, rows] of perFile) {
    rows.sort((a, b) => {
      if (a.lemma !== b.lemma) return a.lemma < b.lemma ? -1 : 1;
      const idA = /^m(\d+)(?:_(\d+))?$/u.exec(a.id);
      const idB = /^m(\d+)(?:_(\d+))?$/u.exec(b.id);
      const entryA = BigInt(idA[1]);
      const entryB = BigInt(idB[1]);
      if (entryA !== entryB) return entryA < entryB ? -1 : 1;
      const ordinalA = BigInt(idA[2] ?? 0);
      const ordinalB = BigInt(idB[2] ?? 0);
      if (ordinalA !== ordinalB) return ordinalA < ordinalB ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    if (readFileSync(path.join(meaningsDirectory, file), 'utf8') !== text) writeFileSync(path.join(meaningsDirectory, file), text);
  }
  if (next.adjudications.length) writeAdjudications(adjudicationDirectory, next.adjudications);
  console.log(`applied ${spec.glosses?.length ?? 0} gloss edits, ${spec.merges?.length ?? 0} merges, ${spec.repartitions?.length ?? 0} repartitions, ${spec.drops?.length ?? 0} drops and ${spec.relations?.length ?? 0} relation edits: ${next.meanings.length} meanings, ${next.adjudications.length} adjudications`);
}

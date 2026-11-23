/**
 * Relation-key 3-way merge of persisted Relation/Drop JSONL (#8784 PR-2).
 *
 * A batch (Stage 2 Part, Stage 3/refine PR) or a Polish edit changes approved data as a delta from its own baseline.
 * When that delta meets newer approved data, only the keys are compared, never line numbers or whole files:
 *
 * - Relation key: the direction-free exact Sense pair of an ID link, or source Sense + normalized text.
 * - Candidate Drop key: source Sense + normalized Candidate (`x/e/z/f`).
 * - Polish exclusion `p` key: its own Sense pair / source Sense + text, distinct from both of the above.
 *
 * For each key the delta changed (`base` → `ours`), the latest (`theirs`) value decides: still equal to `base` → the
 * delta applies; added, changed or removed since → the latest value is kept and the key is reported as a conflict.
 * Keys the delta did not change keep the latest value. Unchanged lines keep their exact bytes and order; added keys
 * are appended in the delta's order. The result is deterministic for the same three inputs.
 */
import { normalizeCandidate } from './candidate-contract.mjs';
import {
  deserializeDropRow, deserializeRelationRow, exclusionKey, isExclusionRow, serializeDropRow, serializeRelationRow,
} from './persisted-jsonl.mjs';

const FAMILIES = new Set(['Relation', 'Drop']);

/** The key of one decoded in-memory row of `family` (see the module comment). */
export function deltaKey(row, family) {
  if (family === 'Relation') return `R\u0000${exclusionKey(row)}`;
  if (isExclusionRow(row)) return `P\u0000${exclusionKey(row)}`;
  return `D\u0000${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`;
}

/** Readable form of a key for reports. */
export const deltaKeyText = (key) => key.replaceAll('\u0000', '|');

function entries(text, family, label) {
  const result = new Map();
  if (!text) return result;
  const decode = family === 'Relation' ? deserializeRelationRow : deserializeDropRow;
  const encode = family === 'Relation' ? serializeRelationRow : serializeDropRow;
  text.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    const location = `${label}:${index + 1}`;
    let row;
    try { row = decode(JSON.parse(line), location); } catch (error) { throw new Error(`${location}: ${error.message}`); }
    const key = deltaKey(row, family);
    if (result.has(key)) throw new Error(`${location}: key ${deltaKeyText(key)} is stored twice`);
    result.set(key, { line, value: JSON.stringify(encode(row)) });
  });
  return result;
}

const sameValue = (left, right) => (left?.value ?? null) === (right?.value ?? null);

/**
 * 3-way merge one JSONL file. Each input is the file text, or null for an absent file.
 * Returns `{ text, applied, conflicts }`: `text` is null when the result is an absent file; `applied` and
 * `conflicts` are the delta keys that were applied or left to the latest value.
 */
export function mergeJsonl({ base, ours, theirs, family, label = family }) {
  if (!FAMILIES.has(family)) throw new Error(`unknown JSONL family ${family}`);
  const baseRows = entries(base, family, `${label} (base)`);
  const ourRows = entries(ours, family, `${label} (ours)`);
  const theirRows = entries(theirs, family, `${label} (theirs)`);
  const changed = [...new Set([...baseRows.keys(), ...ourRows.keys()])]
    .filter((key) => !sameValue(baseRows.get(key), ourRows.get(key)));
  if (theirs === base) return { text: ours, applied: changed, conflicts: [] };
  const applied = [];
  const conflicts = [];
  const take = new Map();
  for (const key of changed) {
    const latest = theirRows.get(key);
    if (sameValue(latest, ourRows.get(key))) continue;   // the latest data already has this exact change
    if (sameValue(latest, baseRows.get(key))) {
      take.set(key, ourRows.get(key) ?? null);
      applied.push(key);
    } else conflicts.push(key);
  }
  if (!take.size) return { text: theirs, applied, conflicts };
  // An added key keeps its place after the preceding base row of `ours` (a Link Repair replaces a text row in place);
  // keys added after the last base row of `ours` are appended after the latest rows.
  const ourList = [...ourRows];
  const lastBase = ourList.findLastIndex(([key]) => baseRows.has(key));
  const after = new Map();
  const tail = [];
  let anchor = '';
  ourList.forEach(([key, entry], position) => {
    if (baseRows.has(key)) { anchor = key; return; }
    if (!take.get(key)) return;
    if (position > lastBase) tail.push(entry.line);
    else after.set(anchor, [...(after.get(anchor) ?? []), entry.line]);
  });
  const lines = [...(after.get('') ?? [])];
  after.delete('');
  for (const [key, entry] of theirRows) {
    if (!take.has(key)) lines.push(entry.line);
    else if (take.get(key)) lines.push(take.get(key).line);
    lines.push(...(after.get(key) ?? []));
    after.delete(key);
  }
  for (const rest of after.values()) lines.push(...rest);
  lines.push(...tail);
  if (!lines.length) return { text: theirs === null ? null : '', applied, conflicts };
  return { text: `${lines.join('\n')}\n`, applied, conflicts };
}

/** Family of a repository-relative shard data path, or null. */
export function dataFileFamily(relative) {
  if (/^data\/relations\/relation-\d{3}\.jsonl$/u.test(relative)) return 'Relation';
  if (/^data\/relation-drops\/drop-\d{3}\.jsonl$/u.test(relative)) return 'Drop';
  return null;
}

/** The Candidate Drop key of one source Sense + Candidate. */
export const candidateDropKey = (senseId, candidate) => `D\u0000${senseId}\u0000${normalizeCandidate(candidate)}`;

/** `text` without the rows whose key is in `keys` (other lines keep their bytes and order). */
export function removeKeys(text, family, keys) {
  if (!text || !keys.size) return text;
  const decode = family === 'Relation' ? deserializeRelationRow : deserializeDropRow;
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() && !keys.has(deltaKey(decode(JSON.parse(line)), family)));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Candidate Drops this delta applied for Candidates the latest data now answers otherwise (an accounting error's
 * `answeredTwice`): the latest answer wins, so these Drops are left out as conflicts instead of double answers.
 */
export function supersededDrops(error, appliedKeys) {
  const keys = new Set();
  for (const { source_sense_id: senseId, candidate } of error?.answeredTwice ?? []) {
    const key = candidateDropKey(senseId, candidate);
    if (appliedKeys.has(key)) keys.add(key);
  }
  return keys;
}

/**
 * Polish exclusion `p` keys this delta applied although the rebuilt Relation file still holds the same relation (its
 * Drop was superseded by the latest value): the kept Relation wins and the stale exclusion is left out.
 */
export function keptRelationExclusions(relationText, appliedKeys) {
  const exclusions = [...appliedKeys].filter((key) => key.startsWith('P\u0000'));
  if (!exclusions.length || !relationText) return new Set();
  const relations = entries(relationText, 'Relation', 'Relation');
  return new Set(exclusions.filter((key) => relations.has(`R${key.slice(1)}`)));
}

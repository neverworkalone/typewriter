/**
 * Stage 4 refinement rule (#9928, #10174): Polish the preselected `p` Senses of a shard, with or without Relations.
 * Each chunk keeps a record's selected Senses together and shows their approved Relations in both directions.
 * The editor adds, drops, retypes or rebinds Relations without repeating the pre-selection.
 *
 * The rule is keyed (`keyed`): a decision names relation keys, never base rows, because a Sense's reverse Relations are
 * stored in other shards' files (`crossShard`). It is Relation-only (`relationsOnly`, #9929): its inputs are Canonical,
 * the confirmed selection and the approved Relations, and every data change goes through the Relation-only mode of the
 * Polish write path (#8784, `polish-cli.mjs apply`): `by:"p"` rows and every changed Relation file's shared row
 * validator. No Candidate or Drop file is read or written (no `p`/`z`, no Drop settlement, no Candidate accounting).
 * Chunking, prepared views, the checkpoint and the parallel save are the shared Refinement Engine core.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ACTION_TARGET_POS, normalizeCandidate, sameSpellingTargets } from '../../admission.mjs';
import { ADMISSION_TYPES, exclusionKey, parseRelationJsonl, parseRelationJsonlLinesMatching } from '../../persisted-jsonl.mjs';
import { apply as polishApply, discardStaged, installStaged, loadCanonical, PolishInputError, scanTouching, stageText } from '../../polish-cli.mjs';
import { readSelection, SelectionError } from '../../selection-cli.mjs';
import { escapeField } from './s3.mjs';
import { fail, gitHead, RefineInputError } from '../core.mjs';

export const label = 'Stage 4';
export const scratch = 'relation-s4';
export const keyed = true;
export const crossShard = true;
export const relationsOnly = true;
export const inputPaths = ['data/relation-selection'];

export const usage = `Usage:
  node scripts/relation/s4-cli.mjs prepare --shard SSS
  node scripts/relation/s4-cli.mjs read-chunk --shard SSS [--chunk NNN [--record <record_id>]] [--out <file>]
  node scripts/relation/s4-cli.mjs refresh-pending --shard SSS
  node scripts/relation/s4-cli.mjs lookup --text <form>[,<form>...]        # exact Canonical Senses of a spelling
  node scripts/relation/s4-cli.mjs save-chunk --shard SSS --in <decisions.txt>
  node scripts/relation/s4-cli.mjs save-chunk --shard SSS --chunk NNN --in <decisions.txt> --expect-view-sha256 <hash>
  node scripts/relation/s4-cli.mjs apply --shard SSS
  node scripts/relation/s4-cli.mjs report --shard SSS [--out <file>]
  node scripts/relation/s4-cli.mjs decisions --shard SSS --base <sha> [--senses <id,...>] [--out <file>]
  node scripts/relation/s4-cli.mjs amend --shard SSS --base <sha> --in <delta.txt>
  node scripts/relation/s4-cli.mjs verify --shard SSS --base <sha>             # admission verify of every affected shard`;

const TYPES = new Set(ADMISSION_TYPES);
const keyOf = (row) => exclusionKey(row);
const keyText = (key) => key.replaceAll('\u0000', '|');
const rowTarget = (row) => ('text' in row ? { text: row.text } : { target_sense_id: row.target_sense_id });
const touches = (row, senseIds) => senseIds.has(row.source_sense_id) || (!('text' in row) && senseIds.has(row.target_sense_id));

// ---- view --------------------------------------------------------------------------------------------------------

export async function loadSelection(root, shard, records = null, name = label) {
  let selection;
  try { selection = await readSelection(root, shard, records); }
  catch (error) {
    if (error instanceof SelectionError) throw new RefineInputError(`${name} ${error.message}`);
    throw error;
  }
  if (!selection) throw new RefineInputError(`${name} requires selection-${shard}.jsonl`);
  const { decisions } = selection;
  return { ...selection,
    polished: new Set([...decisions].filter(([, decision]) => decision === 'p').map(([id]) => id)) };
}

/**
 * Exact-ID selection decision of any Sense, read from its owning shard's confirmed file (#10174): a counterpart in
 * another shard is checked against that shard's selection, not the producing shard's. Each needed file is read and
 * checked once before the synchronous lookups; a missing or invalid file stops the whole input (RefineInputError).
 */
async function decisionLookup(root, own, canonical, ids) {
  const files = new Map([[own.shard, own]]);
  const shardOf = (id) => canonical?.shardOfSense.get(id);
  for (const id of ids) {
    const shard = own.decisions.has(id) ? own.shard : shardOf(id);
    if (shard && !files.has(shard)) files.set(shard, await loadSelection(root, shard, canonical.rowsByShard.get(shard)));
  }
  return (id) => {
    if (own.decisions.has(id)) return own.decisions.get(id);
    const shard = shardOf(id);
    if (!shard) return undefined; // not a Canonical Sense: rejected by the unknown-Sense checks
    if (!files.has(shard)) throw new Error(`${label} selection of ${id} (shard ${shard}) was not loaded`);
    return files.get(shard).decisions.get(id);
  };
}

const opSenseIds = (ops) => ops.flatMap((op) => [op.source_sense_id, op.target_sense_id]).filter(Boolean);

function assertSelectedView(view, selection) {
  for (const sense of view.senses) {
    if (!selection.polished.has(sense.sense_id)) {
      throw new RefineInputError(`${label} prepared view contains non-Polish Sense ${sense.sense_id}`);
    }
  }
}

/**
 * One group per Canonical record with selected `p` Senses, in Canonical order. A Sense's Relations are its own
 * stored rows (forward / text) and the ID rows stored anywhere whose target is that Sense (reverse). A row between two
 * Senses of this shard appears under both. A Sense without Relations weighs 1, so it is chunked like any other.
 */
export async function senseGroups(context, { root, shard }) {
  const selection = await loadSelection(root, shard, context.canonicalRows);
  const forward = new Map();
  const reverse = new Map();
  const push = (map, senseId, entry) => map.set(senseId, [...(map.get(senseId) ?? []), entry]);
  for (const row of context.ownRelations) push(forward, row.source_sense_id, row);
  for (const row of [...context.ownRelations, ...context.otherRelations]) {
    if (!('text' in row) && context.shardSenseIds.has(row.target_sense_id)) push(reverse, row.target_sense_id, row);
  }
  return context.canonicalRows.map((record) => {
    const senses = record.senses.filter((sense) => selection.polished.has(sense.id)).map((sense) => ({ sense,
      relations: [...(forward.get(sense.id) ?? []).map((row) => ({ row, direction: 'text' in row ? 'X' : 'F' })),
        ...(reverse.get(sense.id) ?? []).map((row) => ({ row, direction: 'R' }))] }));
    const relations = senses.flatMap((entry) => entry.relations);
    return { record, senses, relations, weight: senses.reduce((sum, entry) => sum + Math.max(1, entry.relations.length), 0) };
  }).filter((group) => group.senses.length);
}

function describeSense(index, senseId) {
  const found = index.senses.get(senseId);
  if (!found) fail(`${label} cannot resolve Canonical Sense ${senseId}`);
  return { lemma: found.record.lemma, pos: found.sense.pos, gloss: found.sense.gloss };
}

export function renderChunk(groups, index, number, total) {
  let senseNumber = 0;
  let relationNumber = 0;
  const senses = groups.flatMap(({ record, senses: entries }) => entries.map(({ sense, relations }) => ({
    n: ++senseNumber,
    lemma: record.lemma,
    pos: sense.pos,
    gloss: sense.gloss,
    record_id: record.id,
    sense_id: sense.id,
    relations: relations.map(({ row, direction }) => {
      const counterpart = direction === 'X' ? { text: row.text }
        : describeSense(index, direction === 'F' ? row.target_sense_id : row.source_sense_id);
      return { n: ++relationNumber, dir: direction, ...counterpart, type: row.type, tier: row.relevance,
        _source_record_id: row.source_record_id, _source_sense_id: row.source_sense_id,
        ...('text' in row ? { _text: row.text } : { _target_record_id: row.target_record_id, _target_sense_id: row.target_sense_id }) };
    }),
  })));
  return { chunk: String(number).padStart(3, '0'), total_chunks: total, sense_count: senseNumber,
    relation_count: relationNumber, senses };
}

/**
 * One record of a prepared chunk view (#10047): its Senses and Relations with the chunk's own numbers, so a record
 * answer is already a valid line set of the whole chunk. Used only for the one-time record run after a chunk refusal.
 */
export function recordView(view, record) {
  if (!/^w\d+$/u.test(record ?? '')) fail(`--record must be a Canonical record ID such as w123`);
  const senses = view.senses.filter((sense) => sense.record_id === record);
  if (!senses.length) fail(`${label} chunk ${view.chunk} has no record ${record}`);
  return { ...view, sense_count: senses.length,
    relation_count: senses.reduce((sum, sense) => sum + sense.relations.length, 0), senses };
}

/** Compact tab-separated model input: `W` record, `S<j>` Sense, `F/X/R<n>` its Relations (no IDs). */
export function renderPromptView(chunk) {
  const total = String(chunk.total_chunks).padStart(3, '0');
  const lines = [`chunk ${chunk.chunk}/${total} senses ${chunk.sense_count} relations ${chunk.relation_count}`];
  const row = (...fields) => lines.push(fields.map((field) => escapeField(String(field))).join('\t'));
  let record = null;
  for (const sense of chunk.senses) {
    if (sense.record_id !== record) {
      record = sense.record_id;
      row('W', sense.lemma);
    }
    row(`S${sense.n}`, sense.pos, sense.gloss);
    for (const relation of sense.relations) {
      if (relation.dir === 'X') row(`X${relation.n}`, relation.text, relation.type, relation.tier);
      else row(`${relation.dir}${relation.n}`, relation.lemma, relation.pos, relation.gloss, relation.type, relation.tier);
    }
  }
  return lines.join('\n');
}

// ---- decisions ---------------------------------------------------------------------------------------------------

/**
 * A saved decision: the reviewed Sense (`sense`, the prepared view's binding), its action and the Polish edits it
 * makes. A rebind is one decision of a drop and an add, so a conflict never applies only one half of it.
 */
const OP_KEYS = { add: 'op,relevance,source_sense_id,type', set: 'op,relevance,source_sense_id,type', drop: 'op,source_sense_id' };
// `policy` (#10047): a Sense of a record whose own record-scoped run the provider refused — an execution exception,
// never an editorial Skip; it is written only by the War Room Supervisor as `P <record_id...>`.
const ACTION_OPS = { policy: [], add: ['add'], drop: ['drop'], set: ['set'], rebind: ['drop', 'add'] };

export function assertDecisionShape(decision) {
  if (Object.keys(decision).sort().join(',') !== 'action,chunk,ops,sense' || typeof decision.sense !== 'string'
      || !Object.hasOwn(ACTION_OPS, decision.action) || !Array.isArray(decision.ops)
      || decision.ops.map((op) => op?.op).join(',') !== ACTION_OPS[decision.action].join(',')) {
    fail(`${label} checkpoint has an invalid decision`);
  }
  for (const op of decision.ops) {
    const target = Object.hasOwn(op, 'text') ? 'text' : 'target_sense_id';
    if (Object.keys(op).sort().join(',') !== [...OP_KEYS[op.op].split(','), target].sort().join(',')) {
      fail(`${label} checkpoint has an invalid ${op.op} edit`);
    }
  }
}

export const decisionIdentity = (decision) => [decision.sense, decision.action, decision.ops];

const opRow = (op) => ({ source_sense_id: op.source_sense_id, ...('text' in op ? { text: op.text } : { target_sense_id: op.target_sense_id }) });
const opKey = (op) => keyOf(opRow(op));

export function saveSummary(decisions, view, parsed) {
  const count = (action) => decisions.filter((decision) => decision.action === action).length;
  return { senses: view.sense_count, skipped: 0, policy_skipped: count('policy'), added: count('add'), dropped: count('drop'), set: count('set'),
    rebound: count('rebind'), discarded: parsed?.discarded ?? [] };
}

const TEXT = /^"([^"]+)"$/u;
const SENSE_ID = /^w\d+-s\d+$/u;

function viewIndex(view) {
  const senses = new Map(view.senses.map((sense) => [sense.n, sense]));
  const relations = new Map();
  for (const sense of view.senses) for (const relation of sense.relations) relations.set(relation.n, { sense, relation });
  // Every key touching a shown Sense: the view lists all of its Relations in both directions.
  const keysBySense = new Map(view.senses.map((sense) => [sense.sense_id, new Set(sense.relations.map((relation) => keyOf(storedRow(relation))))]));
  return { senses, relations, keysBySense };
}

const storedRow = (relation) => ({ source_sense_id: relation._source_sense_id,
  ...(relation._text !== undefined ? { text: relation._text } : { target_sense_id: relation._target_sense_id }) });

/**
 * Parse one chunk answer. Structure (the `chunk` header) fails closed; a line that is valid grammar but cannot be
 * applied (unknown number or Sense, existing key, own record, action POS) is discarded and reported. An answer whose
 * every line was discarded is not a judgment and is refused. Reclassification with `skip` refuses the whole answer.
 * Accepted edits, `none`, or the Supervisor's record-bound Policy Skip complete a chunk.
 */
export async function parseDecisionText(text, view, checkpoint, { explicit = false, root, canonical = null } = {}) {
  if (typeof text !== 'string') fail(`${label} chunk decisions must be text`);
  const selection = await loadSelection(root, checkpoint.shard);
  assertSelectedView(view, selection);
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = /^chunk\s+(\d{3})$/u.exec(lines[0] ?? '');
  if (!match || match[1] !== view.chunk) fail(`decision input must begin with "chunk ${view.chunk}"`);
  if (!explicit && checkpoint.completed_chunks.includes(view.chunk)) fail(`${label} chunk ${view.chunk} is already saved`);
  const body = lines.slice(1);
  if (body.length === 1 && body[0] === 'none') return { decisions: [], discarded: [] };
  if (body.length === 0) fail(`${label} chunk ${view.chunk} has no judgment; write none when nothing changes`);
  const { senses, relations, keysBySense } = viewIndex(view);
  const discarded = [];
  const drop = (line, why) => discarded.push(`${line.slice(0, 120)}: ${why}`);
  // A rebind (B/M) keeps the stored other end, which may be a Sense of another shard even without an ID token.
  const needsCanonical = body.some((line) => /^[BM]\s/u.test(line)
    || (/^A\s/u.test(line) && line.split(/\s+/u).some((token) => SENSE_ID.test(token))));
  const canon = needsCanonical ? (canonical ?? await loadCanonical(root)) : null;
  const index = canon?.index ?? null;
  const named = body.flatMap((line) => {
    const tokens = line.split(/\s+/u);
    const ids = tokens.filter((token) => SENSE_ID.test(token));
    const relation = /^[BM]$/u.test(tokens[0]) ? relations.get(Number(tokens[1]))?.relation : null;
    if (relation) { const old = storedRow(relation); ids.push(old.source_sense_id, old.target_sense_id); }
    return ids.filter(Boolean);
  });
  const decisionOf = await decisionLookup(root, selection, canon, named);
  const policy = new Set();
  const policyRecords = new Set();
  const proposals = [];

  const tier = (raw) => (/^[1-9]$/u.test(raw ?? '') ? Number(raw) : null);
  const target = (token) => {
    const quoted = TEXT.exec(token);
    if (quoted) return { text: normalizeCandidate(quoted[1]) };
    if (SENSE_ID.test(token)) return { target_sense_id: token };
    return null;
  };
  // A new relation from `source` (a shown Sense) to `counterpart`: the reason it cannot be added, or null.
  const newProblem = (source, counterpart, type) => {
    if ('text' in counterpart) {
      if (!counterpart.text) return 'empty text';
      if (counterpart.text === normalizeCandidate(source.lemma)) return 'text repeats the source lemma';
    } else {
      const found = index?.senses.get(counterpart.target_sense_id);
      if (!found) return `unknown Canonical Sense ${counterpart.target_sense_id}`;
      if (decisionOf(counterpart.target_sense_id) === 'e') return 'target Sense is excluded';
      if (found.record.id === source.record_id) return 'a Relation cannot target its own record';
      if (type === 'action' && !ACTION_TARGET_POS.includes(found.sense.pos)) return `action must target a ${ACTION_TARGET_POS.join(' or ')} Sense`;
    }
    const key = keyOf({ source_sense_id: source.sense_id, ...counterpart });
    if (keysBySense.get(source.sense_id)?.has(key)) return 'this relation already exists';
    return null;
  };

  for (const line of body) {
    const tokens = line.split(/\s+/u);
    // A quoted text may contain spaces: rejoin it as one token.
    const quoted = /"[^"]*"/u.exec(line);
    const args = quoted ? [...line.slice(0, quoted.index).trim().split(/\s+/u).filter(Boolean), quoted[0],
      ...line.slice(quoted.index + quoted[0].length).trim().split(/\s+/u).filter(Boolean)] : tokens;
    const [verb, ...rest] = args;
    if (line === 'none') { drop(line, 'none mixed with other lines is ignored'); continue; }
    if (verb === 'P') {
      // A Policy Skip is never discarded line by line: an invalid one refuses the whole save (#10047).
      if (!rest.length) fail(`${label} chunk ${view.chunk} has a P line without a record`);
      for (const record of rest) {
        const owned = [...senses.values()].filter((sense) => sense.record_id === record);
        if (!/^w\d+$/u.test(record) || !owned.length) fail(`${label} chunk ${view.chunk} P names unknown record ${record}`);
        if (policyRecords.has(record)) fail(`${label} chunk ${view.chunk} P names record ${record} twice`);
        policyRecords.add(record);
        for (const sense of owned) policy.add(sense.sense_id);
      }
      continue;
    }
    if (verb === 'skip') {
      throw new RefineInputError(`${label} uses fixed selection decisions; skip cannot reclassify a Polish Sense`);
    }
    if (verb === 'D') {
      for (const raw of rest) {
        const entry = relations.get(Number(raw));
        if (!/^\d+$/u.test(raw) || !entry) { drop(line, `unknown Relation ${raw}`); continue; }
        const row = storedRow(entry.relation);
        proposals.push({ line, sense: entry.sense, decision: { action: 'drop', ops: [{ op: 'drop', ...row }] } });
      }
      continue;
    }
    if (verb === 'C') {
      const entry = relations.get(Number(rest[0]));
      const relevance = tier(rest[2]);
      if (rest.length !== 3 || !entry || !TYPES.has(rest[1]) || relevance === null) { drop(line, 'use C <n> <type> <tier>'); continue; }
      const { relation } = entry;
      if (relation.type === rest[1] && relation.tier === relevance) { drop(line, 'Type/Tier unchanged'); continue; }
      if (rest[1] === 'action' && relation.dir !== 'X' && !ACTION_TARGET_POS.includes(relation.pos)) { drop(line, 'action target POS'); continue; }
      proposals.push({ line, sense: entry.sense, decision: { action: 'set',
        ops: [{ op: 'set', ...storedRow(relation), type: rest[1], relevance }] } });
      continue;
    }
    if (verb === 'A') {
      const source = senses.get(Number(rest[0]));
      const counterpart = target(rest[1] ?? '');
      const relevance = tier(rest[3]);
      if (rest.length !== 4 || !source || !counterpart || !TYPES.has(rest[2]) || relevance === null) {
        drop(line, 'use A <Sense n> <sense_id|"text"> <type> <tier>');
        continue;
      }
      const problem = newProblem(source, counterpart, rest[2]);
      if (problem) { drop(line, problem); continue; }
      proposals.push({ line, sense: source, decision: { action: 'add',
        ops: [{ op: 'add', source_sense_id: source.sense_id, ...counterpart, type: rest[2], relevance }] } });
      continue;
    }
    if (verb === 'B' || verb === 'M') {
      const entry = relations.get(Number(rest[0]));
      if (!entry) { drop(line, 'unknown Relation'); continue; }
      const { relation, sense } = entry;
      let source = sense;
      let counterpart;
      let type = relation.type;
      let relevance = relation.tier;
      if (verb === 'B') {
        counterpart = target(rest[1] ?? '');
        if (rest.length === 4) { type = rest[2]; relevance = tier(rest[3]); }
        if (!counterpart || ![2, 4].includes(rest.length) || !TYPES.has(type) || relevance === null) {
          drop(line, 'use B <n> <sense_id|"text"> [<type> <tier>]');
          continue;
        }
      } else {
        if (SENSE_ID.test(rest[1] ?? '')) {
          const found = index?.senses.get(rest[1]);
          source = found ? { sense_id: found.sense.id, record_id: found.record.id, lemma: found.record.lemma } : null;
        } else source = senses.get(Number(rest[1]));
        if (rest.length !== 2 || !source || source.record_id !== sense.record_id || source.sense_id === sense.sense_id) {
          drop(line, 'use M <n> <Sense n|sense_id of the same record>');
          continue;
        }
        if (decisionOf(source.sense_id) === 'e') { drop(line, 'destination Sense is excluded'); continue; }
        // The other end stays: a reverse row's source, or the forward row's target/text.
        const old = storedRow(relation);
        counterpart = relation.dir === 'R' ? { target_sense_id: old.source_sense_id }
          : relation.dir === 'X' ? { text: old.text } : { target_sense_id: old.target_sense_id };
      }
      const problem = newProblem(source, counterpart, type);
      if (problem) { drop(line, problem); continue; }
      proposals.push({ line, sense, decision: { action: 'rebind', ops: [{ op: 'drop', ...storedRow(relation) },
        { op: 'add', source_sense_id: source.sense_id, ...counterpart, type, relevance }] } });
      continue;
    }
    drop(line, 'unknown decision; use D, C, A, B, M or none');
  }

  const policyConflict = proposals.find(({ sense }) => policy.has(sense.sense_id))?.sense.sense_id;
  if (policyConflict) fail(`${label} chunk ${view.chunk} Policy Skip Sense ${policyConflict} also has an edit`);
  const decisions = [...policy].sort().map((sense) => ({ chunk: view.chunk, sense, action: 'policy', ops: [] }));
  const seen = new Set();
  for (const { line, sense, decision } of proposals) {
    const full = { chunk: view.chunk, sense: sense.sense_id, ...decision };
    const identity = JSON.stringify(decisionIdentity(full));
    if (seen.has(identity)) continue;
    seen.add(identity);
    decisions.push(full);
  }
  if (!decisions.length) fail(`${label} chunk ${view.chunk} has no valid judgment: ${discarded.slice(0, 10).join('; ')}`);
  return { decisions, discarded };
}

// ---- conflicts, scope and the Polish write path -------------------------------------------------------------------

/**
 * The applied decisions, independent of save or AI completion order. Identical edits apply once. A decision claims
 * every key its edits touch (existing and newly created); among decisions that share a key, the one made while
 * reviewing the stored source Sense wins, then the lower chunk, then a fixed content order. A decision wins or loses
 * whole, so a rebind never applies only its drop or its add.
 */
export function resolveDecisions(decisions) {
  const edits = decisions.filter((decision) => decision.ops.length);
  const rank = (decision) => [decision.ops[0].source_sense_id === decision.sense ? 0 : 1, decision.chunk,
    JSON.stringify(decision.ops), decision.sense];
  const compare = (left, right) => {
    const [a, b] = [rank(left), rank(right)];
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] < b[index]) return -1;
      if (a[index] > b[index]) return 1;
    }
    return 0;
  };
  const ordered = [...edits].sort(compare);
  const applied = [];
  const conflicts = [];
  const claimed = new Map();
  const same = new Set();
  for (const decision of ordered) {
    const content = JSON.stringify(decision.ops);
    if (same.has(content)) continue;
    const keys = decision.ops.map(opKey);
    const holder = keys.map((key) => claimed.get(key)).find(Boolean);
    if (holder) {
      conflicts.push({ chunk: decision.chunk, sense: decision.sense, action: decision.action,
        keys: keys.map(keyText), kept: { chunk: holder.chunk, sense: holder.sense, action: holder.action } });
      continue;
    }
    same.add(content);
    for (const key of keys) claimed.set(key, decision);
    applied.push(decision);
  }
  return { applied, conflicts };
}

function movesSelectedRelation(op, original, selection, index, decisionOf) {
  if (op.op !== 'add') return false;
  for (const previous of [original.source_sense_id, original.target_sense_id].filter((id) => selection.polished.has(id))) {
    let moved;
    if ('text' in original) {
      if ('text' in op && normalizeCandidate(op.text) === normalizeCandidate(original.text)) moved = op.source_sense_id;
    } else if (!('text' in op)) {
      const counterpart = previous === original.source_sense_id ? original.target_sense_id : original.source_sense_id;
      if (op.target_sense_id === counterpart) moved = op.source_sense_id;
      else if (op.source_sense_id === counterpart) moved = op.target_sense_id;
    }
    if (moved && moved !== previous && decisionOf(moved) !== 'e'
        && index.senses.get(moved)?.record.id === index.senses.get(previous)?.record.id) return true;
  }
  return false;
}

/** Independent edits touch a selected Sense; a paired rebind may move that original Relation to its sibling Sense. */
export function assertScope(ops, selection, shard, canonical, originals = [], decisionOf = (id) => selection.decisions.get(id)) {
  const originalByKey = new Map(originals.map((row) => [keyOf(row), row]));
  const movedFrom = ops.filter((op) => op.op === 'drop' && touches(opRow(op), selection.polished))
    .map((op) => originalByKey.get(opKey(op))).filter(Boolean);
  for (const op of ops) {
    if (op.op === 'add' && [op.source_sense_id, op.target_sense_id].filter(Boolean).some((id) => decisionOf(id) === 'e')) {
      throw new RefineInputError(`${label} may not add a Relation to an excluded Sense`);
    }
    if (touches(opRow(op), selection.polished)) continue;
    if (movedFrom.some((original) => movesSelectedRelation(op, original, selection, canonical.index, decisionOf))) continue;
    throw new RefineInputError(`${label} shard ${shard} may not independently edit ${keyText(opKey(op))}: neither end is a selected Polish Sense`);
  }
}

/** Polish input with a fixed edit order (by relation key), so apply and amend reach the same bytes. */
function polishInput(ops, reason) {
  return { edits: [...ops].sort((a, b) => opKey(a).localeCompare(opKey(b)))
    .map(({ reason: own, ...op }) => ({ ...op, reason: own ?? reason })) };
}

const RELATION_DATA_FILE = /^data\/relations\/relation-\d{3}\.jsonl$/u;
export const dataStatus = (root) => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'data/relations'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean).map((line) => line.slice(3));

export function assertCleanSources(root, name = label) {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'data/canonical', ...inputPaths],
    { cwd: root, encoding: 'utf8' });
  if (dirty.trim()) fail(`${name} requires clean Canonical and selection inputs`);
}

/** The PR's changed Relation files. A Stage 4 PR never changes a Drop file: one is a scope error (paths only, no read). */
function changedBetween(root, base, head, name = label) {
  const names = (...paths) => execFileSync('git', ['diff', '--name-only', '--no-renames', base, head, '--', ...paths],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  const drops = names('data/relation-drops');
  if (drops.length) throw new RefineInputError(`${name} is Relation-only; ${base.slice(0, 12)}..${head.slice(0, 12)} changes Drop files: ${drops.slice(0, 5).join(', ')}`);
  return names('data/relations').filter((file) => RELATION_DATA_FILE.test(file));
}

function showFile(root, revision, relative) {
  try { return execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

/**
 * Reader of every data file at one commit: a file that differs from the working tree (dirty, or changed since that
 * commit) is read from Git; every other file is read from disk, where it already equals that commit. Nothing is
 * cached: a whole-shard plan reads every Relation file, and holding them all is what ran out of heap (#10171).
 */
export function revisionReader(root, revision, differing) {
  return async (relative) => (differing.has(relative) ? showFile(root, revision, relative)
    : existsSync(path.join(root, relative)) ? readFile(path.join(root, relative), 'utf8') : null);
}

const sha256 = (text) => (text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex'));

const asInput = async (step) => {
  try { return await step(); } catch (error) {
    if (error instanceof PolishInputError) {
      throw new RefineInputError(error.message);
    }
    throw error;
  }
};

/**
 * Plan `ops` against the data at `revision` through Polish. Each changed file is built, checked and staged one at a
 * time: the result holds paths, hashes and staged temporaries, never every file's text (#10171). The caller installs
 * the staged files (`writePlanned`) or discards them.
 */
export async function planOps({ root, shard, ops, revision, differing, canonical, reason = `${label} shard ${shard}`, only = null }) {
  if (!ops.length) return { files: [], affected_shards: [shard] };
  const result = await polishApply(polishInput(ops, reason), { root, dryRun: true, stage: true, canonical,
    reader: revisionReader(root, revision, differing), relationsOnly: true, only });
  return { ...result, affected_shards: [...new Set([shard, ...result.affected_shards])].sort() };
}

/**
 * Install staged files ({ path, sha256, temporary }) over files that must still hash to `expected` (relative ->
 * sha256|null): the same bytes again is `already-applied`; anything else in between fails before writing; a failed
 * install restores every original. Staged files are always removed.
 */
export function writePlanned(root, files, expected, name = label) {
  return installStaged(root, files, expected, { label: name });
}

const counts = (ops) => ({ add: ops.filter((op) => op.op === 'add').length, drop: ops.filter((op) => op.op === 'drop').length,
  set: ops.filter((op) => op.op === 'set').length });

/** `apply`: every saved chunk decision, resolved, through one Polish plan from HEAD. */
export async function applyCheckpoint({ shard, root, checkpoint, readView }) {
  gitHead(root);
  assertCleanSources(root);
  const canonical = await loadCanonical(root);
  const selection = await loadSelection(root, shard, canonical.rowsByShard.get(shard));
  const seen = new Set();
  const originals = new Map();
  for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
    const view = JSON.parse(await readView(String(number).padStart(3, '0')));
    assertSelectedView(view, selection);
    for (const sense of view.senses) {
      if (seen.has(sense.sense_id)) throw new RefineInputError(`${label} prepared views repeat ${sense.sense_id}`);
      seen.add(sense.sense_id);
      for (const relation of sense.relations) {
        const row = storedRow(relation);
        originals.set(keyOf(row), row);
      }
    }
  }
  if (seen.size !== selection.polished.size) throw new RefineInputError(`${label} prepared views do not cover every selected Polish Sense`);
  for (const decision of checkpoint.decisions) {
    if (!selection.polished.has(decision.sense)) throw new RefineInputError(`${label} decision names non-Polish Sense ${decision.sense}`);
  }
  const { applied, conflicts } = resolveDecisions(checkpoint.decisions);
  const ops = applied.flatMap((decision) => decision.ops);
  assertScope(ops, selection, shard, canonical, [...originals.values()], await decisionLookup(root, selection, canonical, opSenseIds(ops)));
  const differing = new Set(dataStatus(root));
  const planned = await planOps({ root, shard, ops, revision: 'HEAD', differing, canonical });
  const expected = new Map(planned.files.map((file) => [file.path, file.original_sha256]));
  const changedFiles = planned.files.map((file) => file.path).sort();
  const sensesOf = (action) => new Set(checkpoint.decisions.filter((decision) => decision.action === action).map((decision) => decision.sense)).size;
  const policySkipped = sensesOf('policy');
  const { p, s, e } = selection.counts;
  const status = planned.files.length ? await writePlanned(root, planned.files, expected) : 'no-change';
  return {
    status,
    selection: selection.counts,
    senses: { total: p + s + e, skipped: s, excluded: e, policy_skipped: policySkipped, polished: p - policySkipped },
    decisions: Object.fromEntries(['add', 'drop', 'set', 'rebind'].map((action) => [action, applied.filter((decision) => decision.action === action).length])),
    edits: counts(ops),
    conflicts,
    affected_shards: planned.affected_shards,
    changed_files: changedFiles,
  };
}

// ---- PR decisions, amend, report ---------------------------------------------------------------------------------

const lineSet = (text) => new Set(text ? text.split('\n').filter((line) => line.trim() !== '') : []);
const parsedLines = (lines, relative) => (lines.length ? parseRelationJsonl(`${lines.join('\n')}\n`, relative) : []);

/**
 * The Polish edits that take the base data files to the head data files, by relation key. Rows serialize
 * deterministically, so only the lines that differ between a file's base and head are parsed (#10171): an unchanged
 * line is an unchanged row. A key whose line changed, or moved to another file, is compared as rows.
 */
export async function opsBetween(baseRead, headRead, files) {
  const gone = new Map();
  const arrived = new Map();
  const ops = [];
  const compare = (old, row) => {
    if (old.type !== row.type || old.relevance !== row.relevance) {
      ops.push({ op: 'set', source_sense_id: row.source_sense_id, ...rowTarget(row), type: row.type, relevance: row.relevance });
    }
  };
  for (const relative of files.filter((file) => file.startsWith('data/relations/'))) {
    const before = lineSet(await baseRead(relative));
    const after = lineSet(await headRead(relative));
    for (const row of parsedLines([...before].filter((line) => !after.has(line)), relative)) gone.set(keyOf(row), row);
    for (const row of parsedLines([...after].filter((line) => !before.has(line)), relative)) arrived.set(keyOf(row), row);
  }
  for (const [key, row] of arrived) {
    if (gone.has(key)) { compare(gone.get(key), row); gone.delete(key); }
    else ops.push({ op: 'add', source_sense_id: row.source_sense_id, ...rowTarget(row), type: row.type, relevance: row.relevance });
  }
  for (const row of gone.values()) ops.push({ op: 'drop', source_sense_id: row.source_sense_id, ...rowTarget(row) });
  return ops.sort((a, b) => opKey(a).localeCompare(opKey(b)));
}

export function prState(root, base, head, name = label) {
  const changed = changedBetween(root, base, head, name);
  const differing = new Set([...changed, ...dataStatus(root)]);
  return { changed, differing, baseRead: revisionReader(root, base, differing), headRead: revisionReader(root, head, new Set(dataStatus(root))) };
}

function describeOp(op, index, before = null) {
  const source = index.senses.get(op.source_sense_id);
  const describe = (senseId) => {
    const found = index.senses.get(senseId);
    return found ? { sense_id: senseId, lemma: found.record.lemma, pos: found.sense.pos, gloss: found.sense.gloss } : { sense_id: senseId, missing: true };
  };
  return { ...op, source: source ? describe(op.source_sense_id) : { sense_id: op.source_sense_id, missing: true },
    ...('target_sense_id' in op ? { target: describe(op.target_sense_id) } : {}), ...(before ? { before } : {}) };
}

export async function listDecisions({ shard, root, base, head, senses = null }) {
  const canonical = await loadCanonical(root);
  const state = prState(root, base, head);
  const ops = await opsBetween(state.baseRead, state.headRead, state.changed);
  const result = { shard, base, head, counts: counts(ops), decisions: ops.map((op) => describeOp(op, canonical.index)),
    affected_shards: affectedShards(ops, canonical, shard) };
  if (senses) {
    // Every base Relation touching the named Senses, in both directions, with this PR's edit of it (or keep).
    const byKey = new Map(ops.map((op) => [opKey(op), op]));
    const { relations } = await scanTouching(root, senses, new Map(), { reader: state.baseRead, relationsOnly: true });
    result.rows = relations.map(({ row }) => {
      const op = byKey.get(keyOf(row));
      return describeOp(op ?? { op: 'keep', source_sense_id: row.source_sense_id, ...rowTarget(row) }, canonical.index,
        { type: row.type, relevance: row.relevance });
    });
  }
  return result;
}

export function affectedShards(ops, canonical, shard) {
  const shards = new Set([shard]);
  for (const op of ops) {
    for (const senseId of [op.source_sense_id, op.target_sense_id].filter(Boolean)) {
      const owner = canonical.shardOfSense.get(senseId);
      if (owner) shards.add(owner);
    }
  }
  return [...shards].sort();
}

/**
 * `amend <delta>`: `A|C <source_sense_id> <target_sense_id|"text"> <type> <tier>` (add / set), `D <source> <target>`
 * (drop), `K <source> <target>` (keep the base relation: undo this PR's edit of that key). The PR's edits are
 * recovered from base..HEAD, changed by the delta and planned again from the base through Polish.
 */
export async function amendDecisions({ shard, root, base, head, text }) {
  assertCleanSources(root);
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'amend' || lines.length < 2) throw new RefineInputError(`${label} amend input must be "amend" followed by A, C, D or K rows`);
  const canonical = await loadCanonical(root);
  const selection = await loadSelection(root, shard, canonical.rowsByShard.get(shard));
  const state = prState(root, base, head);
  const current = await opsBetween(state.baseRead, state.headRead, state.changed);
  const byKey = new Map(current.map((op) => [opKey(op), op]));
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const quoted = /"([^"]+)"/u.exec(line);
    const tokens = quoted ? [...line.slice(0, quoted.index).trim().split(/\s+/u), quoted[0], ...line.slice(quoted.index + quoted[0].length).trim().split(/\s+/u).filter(Boolean)]
      : line.split(/\s+/u);
    const [verb, source, rawTarget, type, rawTier] = tokens;
    const targetValue = TEXT.exec(rawTarget ?? '') ? { text: normalizeCandidate(TEXT.exec(rawTarget)[1]) }
      : SENSE_ID.test(rawTarget ?? '') ? { target_sense_id: rawTarget } : null;
    if (!['A', 'C', 'D', 'K'].includes(verb) || !SENSE_ID.test(source ?? '') || !targetValue
        || (['A', 'C'].includes(verb) ? tokens.length !== 5 || !TYPES.has(type) || !/^[1-9]$/u.test(rawTier ?? '') : tokens.length !== 3)) {
      throw new RefineInputError(`invalid amend line ${JSON.stringify(line)}`);
    }
    const key = keyOf({ source_sense_id: source, ...targetValue });
    if (seen.has(key)) throw new RefineInputError(`amend names ${keyText(key)} twice`);
    seen.add(key);
    const existing = byKey.get(key);
    if (verb === 'K') byKey.delete(key);
    else if (verb === 'D') {
      if (existing?.op === 'add') byKey.delete(key);
      else byKey.set(key, { op: 'drop', source_sense_id: source, ...targetValue });
    } else {
      const op = verb === 'A' || existing?.op === 'add' ? 'add' : 'set';
      byKey.set(key, { op, source_sense_id: source, ...targetValue, type, relevance: Number(rawTier) });
    }
  }
  const ops = [...byKey.values()];
  const moved = ops.some((op) => !touches(opRow(op), selection.polished));
  const originals = moved ? (await scanTouching(root, selection.polished, new Map(), { reader: state.baseRead, relationsOnly: true })).relations.map(({ row }) => row) : [];
  assertScope(ops, selection, shard, canonical, originals, await decisionLookup(root, selection, canonical, opSenseIds(ops)));
  const planned = await asInput(() => planOps({ root, shard, ops, revision: base, differing: state.differing, canonical }));
  const { files, expected } = await amendTargets(root, state, planned);
  const status = await writePlanned(root, files, expected);
  return { shard, base, head, status, decisions: ops.length, counts: counts(ops),
    affected_shards: planned.affected_shards, outputs: Object.fromEntries(files.map((file) => [file.path, file.sha256])) };
}

/**
 * Every file an amended PR changes or will change: the planned (staged) file, or the base text when it no longer
 * changes, each expected to still hold its HEAD bytes. One file's text at a time.
 */
export async function amendTargets(root, state, planned) {
  const files = [...planned.files];
  const expected = new Map();
  try {
    const plannedPaths = new Set(files.map((file) => file.path));
    for (const relative of [...new Set([...state.changed, ...plannedPaths])].sort()) {
      if (!plannedPaths.has(relative)) files.push(await stageText(root, relative, await state.baseRead(relative)));
      expected.set(relative, sha256(await state.headRead(relative)));
    }
    return { files, expected };
  } catch (error) {
    await discardStaged(files);
    throw error;
  }
}

/** Working tree against HEAD, by relation key: what `apply` changed. */
export async function reportWorktree({ shard, root }) {
  const canonical = await loadCanonical(root);
  const dirty = dataStatus(root);
  const ops = await opsBetween(revisionReader(root, 'HEAD', new Set(dirty)), revisionReader(root, 'HEAD', new Set()), dirty);
  return { counts: counts(ops), edits: ops.map((op) => describeOp(op, canonical.index)), changed_files: dirty.sort(),
    affected_shards: affectedShards(ops, canonical, shard) };
}

/** The shards a PR's verify must cover: those owning an edited Sense, plus the produced shard. */
export async function verifyShards({ shard, root, base, head }) {
  const canonical = await loadCanonical(root);
  const state = prState(root, base, head);
  return affectedShards(await opsBetween(state.baseRead, state.headRead, state.changed), canonical, shard);
}

/**
 * True only when `after` is `before` with whole lines removed: every remaining line, blank lines included, is an
 * original line in the original order with no more copies than before (an order-preserving subsequence). A pure
 * deletion cannot create a new problem in the remaining rows, so its file needs no structural re-check (#10277).
 */
export function pureDeletion(before, after) {
  if (after === null || after === '') return true;
  if (before === null) return false;
  const original = before.split('\n');
  let index = 0;
  for (const line of after.split('\n')) {
    while (index < original.length && original[index] !== line) index += 1;
    if (index === original.length) return false;
    index += 1;
  }
  return true;
}

const relationFileShard = (relative) => /^data\/relations\/relation-(\d{3})\.jsonl$/u.exec(relative)?.[1] ?? null;

/**
 * `verify` scope of a PR (base..head). `shards` is every affected shard (owners of an edited Sense plus the produced
 * shard), as before. `validated` is the shards whose Relation file gets the full structural check: the shard of every
 * changed file that is not a proven pure deletion, and the owner shards of both ends of every Add/Set. A file that
 * only lost lines is not re-checked; anything else (a repeated line, a changed field, a moved line) is.
 */
export async function verifyPlan({ shard, root, base, head, canonical }) {
  const state = prState(root, base, head);
  const ops = await opsBetween(state.baseRead, state.headRead, state.changed);
  return { shards: affectedShards(ops, canonical, shard),
    validated: await structuralShards({ ops, changed: state.changed, baseRead: state.baseRead, headRead: state.headRead, canonical }) };
}

/**
 * The shards whose Relation file needs the full structural check for the change `baseRead` -> `headRead` of the
 * `changed` files with relation-key edits `ops`: the owner shards of both ends of every Add/Set, and the shard of every
 * changed Relation file that is not a proven pure deletion. Shared by `verify` and the Relation-only replay (#10345).
 */
export async function structuralShards({ ops, changed, baseRead, headRead, canonical }) {
  const validated = new Set();
  for (const op of ops.filter((edit) => edit.op !== 'drop')) {
    for (const senseId of [op.source_sense_id, op.target_sense_id].filter(Boolean)) {
      const owner = canonical.shardOfSense.get(senseId);
      if (owner) validated.add(owner);
    }
  }
  for (const relative of changed) {
    const owner = relationFileShard(relative);
    if (owner && !validated.has(owner) && !pureDeletion(await baseRead(relative), await headRead(relative))) validated.add(owner);
  }
  return [...validated].sort();
}

// Every Sense ID token of a Relation line; a line is decoded only when one of its tokens is a Sense of `senseIds`.
// A pattern-like object for the shared line selector, so no regular expression of every wanted Sense ID is built.
function sensePattern(senseIds) {
  const token = /"w\d+-s\d+"/gu;
  return {
    lastIndex: 0,
    exec(text) {
      token.lastIndex = this.lastIndex;
      for (let match = token.exec(text); match !== null; match = token.exec(text)) {
        if (senseIds.has(match[0].slice(1, -1))) { this.lastIndex = token.lastIndex; return match; }
      }
      this.lastIndex = 0;
      return null;
    },
  };
}

/**
 * Cross-shard context of several shards in one pass over the Relation files: for each shard (a Map of shard -> its
 * Canonical Sense IDs), the rows of every other shard's file that touch one of its Senses, in file then line order.
 * This is `loadShardTouchingRelations` for each shard, with every file read and decoded once instead of once per
 * shard; only the selected rows are kept.
 */
export async function touchingContexts(root, sensesByShard) {
  const contexts = new Map([...sensesByShard.keys()].map((name) => [name, []]));
  const shardsOf = new Map();
  for (const [name, senseIds] of sensesByShard) {
    for (const senseId of senseIds) {
      if (!shardsOf.has(senseId)) shardsOf.set(senseId, []);
      shardsOf.get(senseId).push(name);
    }
  }
  const directory = path.join(root, 'data/relations');
  if (!shardsOf.size || !existsSync(directory)) return contexts;
  const wanted = new Set(shardsOf.keys());
  for (const name of (await readdir(directory)).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()) {
    const owner = name.slice('relation-'.length, -'.jsonl'.length);
    for (const { row } of parseRelationJsonlLinesMatching(await readFile(path.join(directory, name), 'utf8'), name, sensePattern(wanted))) {
      const hit = new Set([...(shardsOf.get(row.source_sense_id) ?? []), ...('text' in row ? [] : shardsOf.get(row.target_sense_id) ?? [])]);
      for (const target of hit) if (target !== owner) contexts.get(target).push(row);
    }
  }
  return contexts;
}

/** Non-empty line count of a Relation file in the checkout: the row count of a shard whose file is not re-checked. */
export async function relationLineCount(root, shard) {
  const file = path.join(root, `data/relations/relation-${shard}.jsonl`);
  return existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '').length : 0;
}

/** Every Canonical Sense of a spelling, for exact Add targets (one call per chunk, only when needed). */
export async function lookup(forms, root) {
  const { index } = await loadCanonical(root);
  const lines = [];
  for (const form of forms) {
    lines.push(`Q\t${escapeField(form)}`);
    for (const record of sameSpellingTargets(index, form)) {
      for (const sense of record.senses) lines.push([sense.sense_id, record.lemma, sense.pos, sense.gloss].map((field) => escapeField(field)).join('\t'));
    }
  }
  return `${lines.join('\n')}\n`;
}

// A keyed rule has no Stage 2 Part-scoped mode.
export const scopedRow = null;
export const scopedName = null;

/**
 * Stage 4 refinement rule (#9928): selective whole-shard Polish. Each chunk shows complete Canonical records of the
 * shard — every Sense, with or without Relations — and each Sense's approved Relations in both directions. The editor
 * skips Senses that are no writer search start, and for the others adds, drops, retypes or rebinds Relations.
 *
 * The rule is keyed (`keyed`): a decision names relation keys, never base rows, because a Sense's reverse Relations are
 * stored in other shards' files (`crossShard`). Every data change goes through the Polish write path (#8784,
 * `polish-cli.mjs apply`): `by:"p"` rows, `z` only for real orphans, `p` exclusions, re-approval settlement, every
 * affected shard's row validator and "no new accounting problem". Chunking, prepared views, the checkpoint and the
 * parallel save are the shared Refinement Engine core.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ACTION_TARGET_POS, normalizeCandidate, sameSpellingTargets } from '../../admission.mjs';
import { ADMISSION_TYPES, exclusionKey, parseRelationJsonl } from '../../persisted-jsonl.mjs';
import { apply as polishApply, loadCanonical, PolishInputError, scanTouching } from '../../polish-cli.mjs';
import { escapeField } from './s3.mjs';
import { fail, gitHead, RefineInputError, SHARD_DATA_FILE, writeFilesAtomically } from '../core.mjs';

export const label = 'Stage 4';
export const scratch = 'relation-s4';
export const keyed = true;
export const crossShard = true;

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

/**
 * One group per Canonical record of the shard, in Canonical order, with every Sense. A Sense's Relations are its own
 * stored rows (forward / text) and the ID rows stored anywhere whose target is that Sense (reverse). A row between two
 * Senses of this shard appears under both. A Sense without Relations weighs 1, so it is chunked like any other.
 */
export function senseGroups(context) {
  const forward = new Map();
  const reverse = new Map();
  const push = (map, senseId, entry) => map.set(senseId, [...(map.get(senseId) ?? []), entry]);
  for (const row of context.ownRelations) push(forward, row.source_sense_id, row);
  for (const row of [...context.ownRelations, ...context.otherRelations]) {
    if (!('text' in row) && context.shardSenseIds.has(row.target_sense_id)) push(reverse, row.target_sense_id, row);
  }
  return context.canonicalRows.map((record) => {
    const senses = record.senses.map((sense) => ({ sense,
      relations: [...(forward.get(sense.id) ?? []).map((row) => ({ row, direction: 'text' in row ? 'X' : 'F' })),
        ...(reverse.get(sense.id) ?? []).map((row) => ({ row, direction: 'R' }))] }));
    const relations = senses.flatMap((entry) => entry.relations);
    return { record, senses, relations, weight: senses.reduce((sum, entry) => sum + Math.max(1, entry.relations.length), 0) };
  });
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
const ACTION_OPS = { skip: [], policy: [], add: ['add'], drop: ['drop'], set: ['set'], rebind: ['drop', 'add'] };

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
  return { senses: view.sense_count, skipped: count('skip'), policy_skipped: count('policy'), added: count('add'), dropped: count('drop'), set: count('set'),
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
 * applied (unknown number or Sense, existing key, own record, action POS, an edit under a skipped Sense) is discarded
 * and reported. An answer whose every line was discarded is not a judgment and is refused; only `none`, `skip` and
 * accepted edits complete a chunk (#9928 §5).
 */
export async function parseDecisionText(text, view, checkpoint, { explicit = false, root, canonical = null } = {}) {
  if (typeof text !== 'string') fail(`${label} chunk decisions must be text`);
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
  const needsCanonical = body.some((line) => /^[AB]\s/u.test(line) && line.split(/\s+/u).some((token) => SENSE_ID.test(token)));
  const index = needsCanonical ? (canonical ?? await loadCanonical(root)).index : null;
  const skipped = new Set();
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
      const numbers = rest.map(Number);
      if (!rest.length || numbers.some((number) => !senses.has(number))) { drop(line, 'unknown Sense number'); continue; }
      for (const number of numbers) skipped.add(senses.get(number).sense_id);
      continue;
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
        source = senses.get(Number(rest[1]));
        if (rest.length !== 2 || !source || source.record_id !== sense.record_id || source.sense_id === sense.sense_id) {
          drop(line, 'use M <n> <Sense n of the same record>');
          continue;
        }
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
    drop(line, 'unknown decision; use skip, D, C, A, B, M or none');
  }

  const policyConflict = [...skipped].find((sense) => policy.has(sense))
    ?? proposals.find(({ sense }) => policy.has(sense.sense_id))?.sense.sense_id;
  if (policyConflict) fail(`${label} chunk ${view.chunk} Policy Skip Sense ${policyConflict} also has a skip or edit`);
  const decisions = [...[...skipped].sort().map((sense) => ({ chunk: view.chunk, sense, action: 'skip', ops: [] })),
    ...[...policy].sort().map((sense) => ({ chunk: view.chunk, sense, action: 'policy', ops: [] }))];
  const seen = new Set();
  for (const { line, sense, decision } of proposals) {
    // Skip omits only the judgments made while reviewing that Sense; another Sense may still edit the same Relation.
    if (skipped.has(sense.sense_id)) { drop(line, `S${sense.n} is skipped`); continue; }
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

/** The Stage 4 edit scope: every edit's relation has an end in the produced shard (#9928 §2). */
export function assertScope(ops, shardSenseIds, shard) {
  for (const op of ops) {
    if (!touches(opRow(op), shardSenseIds)) {
      throw new RefineInputError(`${label} shard ${shard} may not edit ${keyText(opKey(op))}: neither end is a shard ${shard} Sense`);
    }
  }
}

/** Polish input with a fixed edit order (by relation key), so apply and amend reach the same bytes. */
function polishInput(ops, shard) {
  return { edits: [...ops].sort((a, b) => opKey(a).localeCompare(opKey(b)))
    .map((op) => ({ ...op, reason: `Stage 4 shard ${shard}` })) };
}

const dataStatus = (root) => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'data/relations', 'data/relation-drops'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean).map((line) => line.slice(3));

function assertCleanSources(root) {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'data/canonical', 'data/relation-candidates'],
    { cwd: root, encoding: 'utf8' });
  if (dirty.trim()) fail(`${label} requires clean Canonical and Candidate inputs`);
}

const changedBetween = (root, base, head) => execFileSync('git', ['diff', '--name-only', '--no-renames', base, head, '--',
  'data/relations', 'data/relation-drops'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\n').filter((file) => SHARD_DATA_FILE.test(file));

function showFile(root, revision, relative) {
  try { return execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

/**
 * Reader of every data file at one commit: a file that differs from the working tree (dirty, or changed since that
 * commit) is read from Git; every other file is read from disk, where it already equals that commit.
 */
function revisionReader(root, revision, differing) {
  const cache = new Map();
  return async (relative) => {
    if (!cache.has(relative)) {
      cache.set(relative, differing.has(relative) ? showFile(root, revision, relative)
        : existsSync(path.join(root, relative)) ? readFile(path.join(root, relative), 'utf8') : null);
    }
    return cache.get(relative);
  };
}

const asInput = async (step) => {
  try { return await step(); } catch (error) {
    if (error instanceof PolishInputError || /would introduce Candidate accounting problems/u.test(error.message)) {
      throw new RefineInputError(error.message);
    }
    throw error;
  }
};

/** Plan `ops` against the data at `revision` through Polish; nothing is written. */
async function planOps({ root, shard, ops, revision, differing, canonical }) {
  if (!ops.length) return { files: [], affected_shards: [shard], z_added: [], drops_removed: [] };
  const result = await polishApply(polishInput(ops, shard), { root, dryRun: true, returnTexts: true, canonical,
    reader: revisionReader(root, revision, differing) });
  return { ...result, affected_shards: [...new Set([shard, ...result.affected_shards])].sort() };
}

/**
 * Write `next` (relative -> text|null) over files that hold `expected` (relative -> text|null): the same bytes again is
 * `already-applied`; anything else in between fails before writing.
 */
async function writePlanned(root, next, expected) {
  const current = new Map();
  for (const relative of new Set([...next.keys(), ...expected.keys()])) {
    const file = path.join(root, relative);
    current.set(relative, existsSync(file) ? await readFile(file, 'utf8') : null);
  }
  const target = (relative) => (next.has(relative) ? next.get(relative) : expected.get(relative) ?? null);
  if ([...current.keys()].every((relative) => current.get(relative) === target(relative))) return 'already-applied';
  const mismatch = [...current.keys()].filter((relative) => current.get(relative) !== (expected.get(relative) ?? null));
  if (mismatch.length) fail(`${label} data files changed from both the baseline and this result; nothing was written: ${mismatch.slice(0, 10).join(', ')}`);
  const state = (text) => ({ exists: text !== null, text: text ?? '' });
  await writeFilesAtomically([...next.keys()].filter((relative) => next.get(relative) !== current.get(relative))
    .map((relative) => ({ file: path.join(root, relative), current: state(current.get(relative)), next: state(next.get(relative)) })));
  return 'applied';
}

async function shardSenses(root, shard, canonical) {
  return new Set(canonical.rowsByShard.get(shard)?.flatMap((record) => record.senses.map((sense) => sense.id)) ?? []);
}

const counts = (ops) => ({ add: ops.filter((op) => op.op === 'add').length, drop: ops.filter((op) => op.op === 'drop').length,
  set: ops.filter((op) => op.op === 'set').length });

/** `apply`: every saved chunk decision, resolved, through one Polish plan from HEAD. */
export async function applyCheckpoint({ shard, root, checkpoint, readView }) {
  gitHead(root);
  assertCleanSources(root);
  const canonical = await loadCanonical(root);
  const senseIds = await shardSenses(root, shard, canonical);
  const { applied, conflicts } = resolveDecisions(checkpoint.decisions);
  const ops = applied.flatMap((decision) => decision.ops);
  assertScope(ops, senseIds, shard);
  const differing = new Set(dataStatus(root));
  const planned = await planOps({ root, shard, ops, revision: 'HEAD', differing, canonical });
  const reader = revisionReader(root, 'HEAD', differing);
  const expected = new Map();
  for (const file of planned.files) expected.set(file.path, await reader(file.path));
  const next = new Map(planned.files.map((file) => [file.path, file.text]));
  let senseTotal = 0;
  for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
    senseTotal += JSON.parse(await readView(String(number).padStart(3, '0'))).sense_count;
  }
  const sensesOf = (action) => new Set(checkpoint.decisions.filter((decision) => decision.action === action).map((decision) => decision.sense)).size;
  const skipped = sensesOf('skip');
  const policySkipped = sensesOf('policy');
  const status = next.size ? await writePlanned(root, next, expected) : 'no-change';
  return {
    status,
    senses: { total: senseTotal, skipped, policy_skipped: policySkipped, polished: senseTotal - skipped - policySkipped },
    decisions: Object.fromEntries(['add', 'drop', 'set', 'rebind'].map((action) => [action, applied.filter((decision) => decision.action === action).length])),
    edits: counts(ops),
    conflicts,
    z_added: planned.z_added.length,
    drops_removed: planned.drops_removed.length,
    affected_shards: planned.affected_shards,
    changed_files: [...next.keys()].sort(),
  };
}

// ---- PR decisions, amend, report ---------------------------------------------------------------------------------

async function relationRowsByKey(read, files) {
  const rows = new Map();
  for (const relative of files.filter((file) => file.startsWith('data/relations/'))) {
    const text = await read(relative);
    for (const row of text ? parseRelationJsonl(text, relative) : []) rows.set(keyOf(row), row);
  }
  return rows;
}

/** The Polish edits that take the base data files to the head data files, by relation key. */
async function opsBetween(baseRead, headRead, files) {
  const [before, after] = await Promise.all([relationRowsByKey(baseRead, files), relationRowsByKey(headRead, files)]);
  const ops = [];
  for (const [key, row] of after) {
    const old = before.get(key);
    if (!old) ops.push({ op: 'add', source_sense_id: row.source_sense_id, ...rowTarget(row), type: row.type, relevance: row.relevance });
    else if (old.type !== row.type || old.relevance !== row.relevance) {
      ops.push({ op: 'set', source_sense_id: row.source_sense_id, ...rowTarget(row), type: row.type, relevance: row.relevance });
    }
  }
  for (const [key, row] of before) if (!after.has(key)) ops.push({ op: 'drop', source_sense_id: row.source_sense_id, ...rowTarget(row) });
  return ops.sort((a, b) => opKey(a).localeCompare(opKey(b)));
}

function prState(root, base, head) {
  const changed = changedBetween(root, base, head);
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
    const { relations } = await scanTouching(root, senses, new Map(), { reader: state.baseRead });
    result.rows = relations.map(({ row }) => {
      const op = byKey.get(keyOf(row));
      return describeOp(op ?? { op: 'keep', source_sense_id: row.source_sense_id, ...rowTarget(row) }, canonical.index,
        { type: row.type, relevance: row.relevance });
    });
  }
  return result;
}

function affectedShards(ops, canonical, shard) {
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
  assertScope(ops, await shardSenses(root, shard, canonical), shard);
  const planned = await asInput(() => planOps({ root, shard, ops, revision: base, differing: state.differing, canonical }));
  // Every file this PR changes or will change: the planned text, or the base text when it no longer changes.
  const next = new Map();
  const expected = new Map();
  const plannedText = new Map(planned.files.map((file) => [file.path, file.text]));
  for (const relative of new Set([...state.changed, ...plannedText.keys()])) {
    next.set(relative, plannedText.has(relative) ? plannedText.get(relative) : await state.baseRead(relative));
    expected.set(relative, await state.headRead(relative));
  }
  const status = await writePlanned(root, next, expected);
  const outputs = Object.fromEntries([...next].map(([relative, value]) => [relative,
    value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex')]));
  return { shard, base, head, status, decisions: ops.length, counts: counts(ops), edit_drops_added: planned.z_added.length,
    affected_shards: planned.affected_shards, outputs };
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

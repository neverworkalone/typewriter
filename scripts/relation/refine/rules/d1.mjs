// D1 rule (#10171): whole Drop of confirmed Skip Senses. The model judges only whether each confirmed `s` Sense
// (#10174) clearly falls in one of the 11 whole-Drop categories, from its headword, POS, full gloss and homograph
// number; it sees no Relation list. Code then drops every approved Relation touching a `D` Sense, in both directions
// and in any shard, through the Relation-only Polish write path (#9929). No Candidate or Drop file is read or written.
//
// The judgments are the PR's own record: the checkpoint and the prepared views it is bound to stay after apply
// (`keepDecisions`), so report, decisions and amend read the same Sense verdicts. Nothing is committed for them.
import { execFileSync } from 'node:child_process';

import { AdmissionVerifyError } from '../../admission.mjs';
import { createHash } from 'node:crypto';

import { discardStaged, loadCanonical, scanTouching, stageText } from '../../polish-cli.mjs';
import { exclusionKey } from '../../persisted-jsonl.mjs';
import { fail, gitHead, RefineInputError, viewDigest } from '../core.mjs';
import { escapeField } from './s3.mjs';
import {
  affectedShards, amendTargets, assertCleanSources, dataStatus, loadSelection, opsBetween, planOps, prState, revisionReader,
  writePlanned,
} from './s4.mjs';

export const label = 'D1';
export const scratch = 'relation-d1';
export const keyed = true;
export const crossShard = true;
export const relationsOnly = true;
export const keepDecisions = true;
export const inputPaths = ['data/relation-selection'];
// About 100 Sense judgments a chunk (a group weighs its Sense count); a record is never split.
export const chunkBounds = { minimum: 90, maximum: 100 };
export const CATEGORIES = 11;

export const usage = `Usage:
  node scripts/relation/d1-cli.mjs prepare --shard SSS
  node scripts/relation/d1-cli.mjs read-chunk --shard SSS [--chunk NNN [--record <record_id>]] [--out <file>]
  node scripts/relation/d1-cli.mjs refresh-pending --shard SSS
  node scripts/relation/d1-cli.mjs save-chunk --shard SSS --in <decisions.txt>
  node scripts/relation/d1-cli.mjs save-chunk --shard SSS --chunk NNN --in <decisions.txt> --expect-view-sha256 <hash>
  node scripts/relation/d1-cli.mjs apply --shard SSS
  node scripts/relation/d1-cli.mjs report --shard SSS [--out <file>]
  node scripts/relation/d1-cli.mjs decisions --shard SSS --base <sha> [--senses <id,...>] [--out <file>]
  node scripts/relation/d1-cli.mjs amend --shard SSS --base <sha> --in <delta.txt>
  node scripts/relation/d1-cli.mjs verify --shard SSS --base <sha> [--judgments <worktree>]   # every D Relation dropped, nothing else

A chunk answer is "chunk NNN" and then exactly one verdict for every shown Sense:
  D <n> <1-11>    whole Drop, with its category number
  N <n> [<n>...]  not in a category
  H <n> [<n>...]  unclear: held for D2 (#10244)
An amend delta is "amend" and then D <sense_id> <1-11> | N <sense_id> | H <sense_id> lines.`;

const VERDICTS = new Set(['D', 'N', 'H', 'P']);
const keyOf = (row) => exclusionKey(row);
const sha256 = (text) => (text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex'));
const touches = (row, senseIds) => senseIds.has(row.source_sense_id) || (!('text' in row) && senseIds.has(row.target_sense_id));
const skipSenses = (selection) => new Set([...selection.decisions].filter(([, decision]) => decision === 's').map(([id]) => id));

// ---- prepare --------------------------------------------------------------------------------------------------

/**
 * One group per Canonical record with confirmed `s` Senses that some approved Relation touches (stored here or in
 * another shard, either direction). An `s` Sense without Relations has nothing to drop and is not judged.
 */
export async function senseGroups(context, { root, shard }) {
  const skipped = skipSenses(await loadSelection(root, shard, context.canonicalRows, label));
  const touched = new Set();
  for (const row of [...context.ownRelations, ...context.otherRelations]) {
    if (skipped.has(row.source_sense_id)) touched.add(row.source_sense_id);
    if (!('text' in row) && skipped.has(row.target_sense_id)) touched.add(row.target_sense_id);
  }
  return context.canonicalRows.map((record) => {
    const senses = record.senses.filter((sense) => touched.has(sense.id)).map((sense) => ({ sense, relations: [] }));
    return { record, senses, relations: [], weight: senses.length };
  }).filter((group) => group.senses.length);
}

export function renderChunk(groups, index, number, total) {
  let senseNumber = 0;
  const senses = groups.flatMap(({ record, senses: entries }) => entries.map(({ sense }) => ({
    n: ++senseNumber, lemma: record.lemma, homograph: record.homograph_no ?? null, pos: sense.pos, gloss: sense.gloss,
    record_id: record.id, sense_id: sense.id, relations: [],
  })));
  return { chunk: String(number).padStart(3, '0'), total_chunks: total, sense_count: senseNumber, relation_count: 0, senses };
}

/** One record of a prepared chunk view (#10047), keeping the chunk's own Sense numbers. */
export function recordView(view, record) {
  if (!/^w\d+$/u.test(record ?? '')) fail('--record must be a Canonical record ID such as w123');
  const senses = view.senses.filter((sense) => sense.record_id === record);
  if (!senses.length) fail(`${label} chunk ${view.chunk} has no record ${record}`);
  return { ...view, sense_count: senses.length, senses };
}

/** Compact tab-separated model input: `W` headword and homograph number (`-` when none), `S<n>` POS and gloss. */
export function renderPromptView(chunk) {
  const total = String(chunk.total_chunks).padStart(3, '0');
  const lines = [`chunk ${chunk.chunk}/${total} senses ${chunk.sense_count}`];
  const row = (...fields) => lines.push(fields.map((field) => escapeField(String(field))).join('\t'));
  let record = null;
  for (const sense of chunk.senses) {
    if (sense.record_id !== record) {
      record = sense.record_id;
      row('W', sense.lemma, sense.homograph ?? '-');
    }
    row(`S${sense.n}`, sense.pos, sense.gloss);
  }
  return lines.join('\n');
}

// ---- decisions ------------------------------------------------------------------------------------------------

/**
 * A saved decision: one shown Sense, its verdict (`D` whole Drop, `N` not a category, `H` held, `P` a Policy Skip of
 * its record, #10047), the category of a `D` and the digest of the prepared view it was made on.
 */
export function assertDecisionShape(decision) {
  const category = decision.category;
  if (Object.keys(decision).sort().join(',') !== 'category,chunk,sense,verdict,view' || typeof decision.sense !== 'string'
      || !VERDICTS.has(decision.verdict) || !/^[0-9a-f]{64}$/u.test(decision.view ?? '')
      || (decision.verdict === 'D' ? !(Number.isSafeInteger(category) && category >= 1 && category <= CATEGORIES) : category !== null)) {
    fail(`${label} checkpoint has an invalid decision`);
  }
}

export const decisionIdentity = (decision) => [decision.sense, decision.verdict, decision.category];

export function saveSummary(decisions, view) {
  const count = (verdict) => decisions.filter((decision) => decision.verdict === verdict).length;
  return { senses: view.sense_count, dropped: count('D'), not_target: count('N'), held: count('H'), policy_skipped: count('P'),
    discarded: [] };
}

function assertSkipView(view, skipped) {
  for (const sense of view.senses) {
    if (!skipped.has(sense.sense_id)) throw new RefineInputError(`${label} prepared view contains non-Skip Sense ${sense.sense_id}`);
  }
}

/**
 * Parse one chunk answer strictly: every shown Sense gets exactly one verdict. A missing, repeated or conflicting
 * verdict, an unknown number, category or line refuses the whole answer — a missing verdict is never read as N, H or
 * P. The Supervisor's `P <record_id...>` covers every shown Sense of those records.
 */
export async function parseDecisionText(text, view, checkpoint, { explicit = false, root } = {}) {
  if (typeof text !== 'string') fail(`${label} chunk decisions must be text`);
  assertSkipView(view, skipSenses(await loadSelection(root, checkpoint.shard, null, label)));
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = /^chunk\s+(\d{3})$/u.exec(lines[0] ?? '');
  if (!match || match[1] !== view.chunk) fail(`decision input must begin with "chunk ${view.chunk}"`);
  if (!explicit && checkpoint.completed_chunks.includes(view.chunk)) fail(`${label} chunk ${view.chunk} is already saved`);
  if (lines.length === 1) fail(`${label} chunk ${view.chunk} has no judgment`);
  const senses = new Map(view.senses.map((sense) => [sense.n, sense]));
  const verdicts = new Map();
  const assign = (sense, verdict, category, line) => {
    if (verdicts.has(sense.n)) fail(`${label} chunk ${view.chunk} judges Sense ${sense.n} more than once (${line})`);
    verdicts.set(sense.n, { verdict, category });
  };
  const number = (raw, line) => {
    const sense = /^[1-9]\d*$/u.test(raw ?? '') ? senses.get(Number(raw)) : undefined;
    if (!sense) fail(`${label} chunk ${view.chunk} names unknown Sense ${raw} (${line})`);
    return sense;
  };
  for (const line of lines.slice(1)) {
    const [verb, ...rest] = line.split(/\s+/u);
    if (verb === 'D') {
      const category = /^(?:[1-9]|1[01])$/u.test(rest[1] ?? '') ? Number(rest[1]) : null;
      if (rest.length !== 2 || category === null) fail(`${label} chunk ${view.chunk} D must be "D <n> <1-${CATEGORIES}>" (${line})`);
      assign(number(rest[0], line), 'D', category, line);
    } else if (verb === 'N' || verb === 'H') {
      if (!rest.length) fail(`${label} chunk ${view.chunk} ${verb} names no Sense (${line})`);
      for (const raw of rest) assign(number(raw, line), verb, null, line);
    } else if (verb === 'P') {
      if (!rest.length) fail(`${label} chunk ${view.chunk} has a P line without a record`);
      for (const record of rest) {
        const owned = view.senses.filter((sense) => sense.record_id === record);
        if (!/^w\d+$/u.test(record) || !owned.length) fail(`${label} chunk ${view.chunk} P names unknown record ${record}`);
        for (const sense of owned) assign(sense, 'P', null, line);
      }
    } else {
      fail(`${label} chunk ${view.chunk} has an unknown line; use D, N or H (${line.slice(0, 120)})`);
    }
  }
  const missing = view.senses.filter((sense) => !verdicts.has(sense.n)).map((sense) => sense.n);
  if (missing.length) fail(`${label} chunk ${view.chunk} has no verdict for Sense ${missing.slice(0, 20).join(', ')}`);
  const digest = viewDigest(view);
  const decisions = view.senses.map((sense) => ({ chunk: view.chunk, sense: sense.sense_id, ...verdicts.get(sense.n), view: digest }));
  return { decisions, discarded: [] };
}

// ---- kept judgments -------------------------------------------------------------------------------------------

/**
 * Bind every saved decision to its prepared view: the view must still hash to the digest the decision was made on,
 * and every shown Sense has exactly one decision. A restored or edited checkpoint that does not match fails closed.
 */
async function boundDecisions(checkpoint, readView, skipped) {
  if (checkpoint.completed_chunks.length !== checkpoint.chunk_total) fail(`${label} has ${checkpoint.completed_chunks.length}/${checkpoint.chunk_total} completed chunks`);
  const bySense = new Map(checkpoint.decisions.map((decision) => [decision.sense, decision]));
  if (bySense.size !== checkpoint.decisions.length) fail(`${label} checkpoint judges a Sense more than once`);
  const senses = new Map();
  for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
    const chunk = String(number).padStart(3, '0');
    const raw = await readView(chunk);
    const view = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (view?.chunk !== chunk || !Array.isArray(view.senses)) fail(`${label} prepared chunk ${chunk} is unavailable or does not match its name`);
    assertSkipView(view, skipped);
    const digest = viewDigest(view);
    for (const sense of view.senses) {
      const decision = bySense.get(sense.sense_id);
      if (!decision || decision.chunk !== chunk || decision.view !== digest) {
        fail(`${label} decision of ${sense.sense_id} is not bound to prepared chunk ${chunk}; the checkpoint and its views do not match`);
      }
      senses.set(sense.sense_id, sense);
    }
  }
  if (senses.size !== bySense.size) fail(`${label} checkpoint judges a Sense that no prepared view shows`);
  return { decisions: checkpoint.decisions, senses };
}

function summarize(decisions, skipped) {
  const count = (verdict) => decisions.filter((decision) => decision.verdict === verdict).length;
  const byCategory = {};
  for (const decision of decisions) if (decision.verdict === 'D') byCategory[decision.category] = (byCategory[decision.category] ?? 0) + 1;
  return { skip_senses: skipped.size, judged: decisions.length, no_relations: skipped.size - decisions.length,
    dropped: count('D'), not_target: count('N'), held: count('H'), policy_skipped: count('P'),
    by_category: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => Number(a) - Number(b))) };
}

const dSenses = (decisions) => new Set(decisions.filter((decision) => decision.verdict === 'D').map((decision) => decision.sense));

/** One drop edit for every approved Relation key touching a `D` Sense in the data `reader` reads; a key once. */
async function dropOps(root, senses, reader = null) {
  if (!senses.size) return [];
  const { relations } = await scanTouching(root, senses, new Map(), { reader, relationsOnly: true });
  const ops = new Map();
  for (const { row } of relations) {
    if (!touches(row, senses)) continue;
    ops.set(keyOf(row), { op: 'drop', source_sense_id: row.source_sense_id,
      ...('text' in row ? { text: row.text } : { target_sense_id: row.target_sense_id }) });
  }
  return [...ops.values()];
}

function diffSize(root, args) {
  const numstat = execFileSync('git', ['diff', '--numstat', '--no-renames', ...args, '--', 'data/relations'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).map((line) => line.split('\t'));
  const bytes = execFileSync('git', ['diff', '--no-renames', '--no-color', ...args, '--', 'data/relations'], { cwd: root, maxBuffer: 1024 * 1024 * 1024 }).length;
  return { files: numstat.length, insertions: numstat.reduce((sum, [added]) => sum + Number(added), 0),
    deletions: numstat.reduce((sum, [, removed]) => sum + Number(removed), 0), bytes };
}

function describe(decision, index) {
  const found = index.senses.get(decision.sense);
  return { sense: decision.sense, verdict: decision.verdict, category: decision.category, chunk: decision.chunk,
    ...(found ? { lemma: found.record.lemma, homograph: found.record.homograph_no ?? null, pos: found.sense.pos, gloss: found.sense.gloss } : { missing: true }) };
}

// ---- apply, report, decisions, amend --------------------------------------------------------------------------

/** `apply`: every approved Relation touching a `D` Sense in the current data, dropped through one Polish plan. */
export async function applyCheckpoint({ shard, root, checkpoint, readView }) {
  gitHead(root);
  assertCleanSources(root, label);
  const canonical = await loadCanonical(root);
  const skipped = skipSenses(await loadSelection(root, shard, canonical.rowsByShard.get(shard), label));
  const { decisions } = await boundDecisions(checkpoint, readView, skipped);
  const ops = await dropOps(root, dSenses(decisions));
  const planned = await planOps({ root, shard, ops, revision: 'HEAD', differing: new Set(dataStatus(root)), canonical,
    reason: `D1 shard ${shard}` });
  const status = planned.files.length
    ? await writePlanned(root, planned.files, new Map(planned.files.map((file) => [file.path, file.original_sha256])), label)
    : 'no-change';
  return { status, senses: summarize(decisions, skipped), removed_relations: ops.length,
    affected_shards: planned.affected_shards, changed_files: planned.files.map((file) => file.path).sort() };
}

/** Working tree against HEAD: the kept judgments and what `apply` changed. */
export async function reportWorktree({ shard, root, saved }) {
  const canonical = await loadCanonical(root);
  const skipped = skipSenses(await loadSelection(root, shard, canonical.rowsByShard.get(shard), label));
  const { decisions } = await boundDecisions(await saved.loadCheckpoint(), saved.readView, skipped);
  const dirty = dataStatus(root).sort();
  const ops = await opsBetween(revisionReader(root, 'HEAD', new Set(dirty)), revisionReader(root, 'HEAD', new Set()), dirty);
  return { senses: summarize(decisions, skipped), decisions: decisions.map((decision) => describe(decision, canonical.index)),
    removed_relations: ops.filter((op) => op.op === 'drop').length, other_edits: ops.filter((op) => op.op !== 'drop').length,
    changed_files: dirty, diff: diffSize(root, []), affected_shards: affectedShards(ops, canonical, shard) };
}

/** The PR's kept judgments; with `senses`, every base Relation touching them and whether this PR drops it. */
export async function listDecisions({ shard, root, base, head, senses = null, saved }) {
  const canonical = await loadCanonical(root);
  const skipped = skipSenses(await loadSelection(root, shard, canonical.rowsByShard.get(shard), label));
  const { decisions } = await boundDecisions(await saved.loadCheckpoint(), saved.readView, skipped);
  const state = prState(root, base, head, label);
  const ops = await opsBetween(state.baseRead, state.headRead, state.changed);
  const result = { shard, base, head, senses: summarize(decisions, skipped),
    decisions: decisions.map((decision) => describe(decision, canonical.index)),
    removed_relations: ops.filter((op) => op.op === 'drop').length, other_edits: ops.filter((op) => op.op !== 'drop').length,
    changed_files: state.changed, diff: diffSize(root, [base, head]), affected_shards: affectedShards(ops, canonical, shard) };
  if (senses) {
    const dropped = new Set(ops.filter((op) => op.op === 'drop').map((op) => keyOf(op)));
    const { relations } = await scanTouching(root, senses, new Map(), { reader: state.baseRead, relationsOnly: true });
    result.rows = relations.map(({ row }) => ({ status: dropped.has(keyOf(row)) ? 'drop' : 'keep', source_sense_id: row.source_sense_id,
      ...('text' in row ? { text: row.text } : { target_sense_id: row.target_sense_id }), type: row.type, relevance: row.relevance }));
  }
  return result;
}

const SENSE_ID = /^w\d+-s\d+$/u;

/**
 * `amend <delta>`: change kept Sense verdicts (`D <sense_id> <1-11>`, `N <sense_id>`, `H <sense_id>`). The new
 * judgments are computed in memory; the PR's data is rebuilt from the base with the whole new `D` set (a Relation
 * stays dropped while either end is still `D`), and the data files and the checkpoint are installed together, or
 * neither is. A Policy Skip is not amended.
 */
export async function amendDecisions({ shard, root, base, head, text, saved }) {
  assertCleanSources(root, label);
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'amend' || lines.length < 2) throw new RefineInputError(`${label} amend input must be "amend" followed by D, N or H rows`);
  const canonical = await loadCanonical(root);
  const skipped = skipSenses(await loadSelection(root, shard, canonical.rowsByShard.get(shard), label));
  const checkpointText = await saved.checkpointText();
  const checkpoint = saved.parseCheckpoint(checkpointText);
  const { decisions } = await boundDecisions(checkpoint, saved.readView, skipped);
  const bySense = new Map(decisions.map((decision) => [decision.sense, decision]));
  const changes = new Map();
  for (const line of lines.slice(1)) {
    const [verb, sense, raw, ...extra] = line.split(/\s+/u);
    const category = verb === 'D' && /^(?:[1-9]|1[01])$/u.test(raw ?? '') ? Number(raw) : null;
    if (!['D', 'N', 'H'].includes(verb) || !SENSE_ID.test(sense ?? '') || extra.length
        || (verb === 'D' ? category === null : raw !== undefined)) throw new RefineInputError(`invalid ${label} amend line ${JSON.stringify(line)}`);
    const current = bySense.get(sense);
    if (!current) throw new RefineInputError(`${label} amend names ${sense}, which this PR did not judge`);
    if (current.verdict === 'P') throw new RefineInputError(`${label} amend cannot change the Policy Skip of ${sense}`);
    if (changes.has(sense)) throw new RefineInputError(`${label} amend names ${sense} twice`);
    changes.set(sense, { verdict: verb, category });
  }
  const next = decisions.map((decision) => (changes.has(decision.sense) ? { ...decision, ...changes.get(decision.sense) } : decision))
    .sort((a, b) => a.chunk.localeCompare(b.chunk) || JSON.stringify(decisionIdentity(a)).localeCompare(JSON.stringify(decisionIdentity(b))));
  const state = prState(root, base, head, label);
  const ops = await dropOps(root, dSenses(next), state.baseRead);
  const planned = await planOps({ root, shard, ops, revision: base, differing: state.differing, canonical, reason: `D1 shard ${shard}` });
  const { files, expected } = await amendTargets(root, state, planned);
  try {
    files.push(await stageText(root, saved.checkpointRelative, `${JSON.stringify({ ...checkpoint, decisions: next })}\n`));
  } catch (error) {
    await discardStaged(files);
    throw error;
  }
  expected.set(saved.checkpointRelative, sha256(checkpointText));
  const status = await writePlanned(root, files, expected, label);
  return { shard, base, head, status, amended: changes.size, senses: summarize(next, skipped), removed_relations: ops.length,
    affected_shards: planned.affected_shards,
    outputs: Object.fromEntries(files.filter((file) => file.path !== saved.checkpointRelative).map((file) => [file.path, file.sha256])) };
}

const RELATION_DATA_FILE = /^data\/relations\/relation-\d{3}\.jsonl$/u;

/**
 * `verify`: the PR does exactly its judgments, checked on the relation-key diff base..head and nothing more.
 * 1. Every approved Relation touching a kept `D` Sense at the base is dropped.
 * 2. Nothing else changed: only Relation files, only drops, and every dropped key touches a `D` Sense.
 * The dictionary-wide structural integrity of Relation files is the build's and Deep CI's job, not re-run per shard.
 * A failure throws `AdmissionVerifyError` (family `d1-scope`) with every finding.
 */
export async function verifyDecisions({ shard, root, base, head, saved }) {
  const skipped = skipSenses(await loadSelection(root, shard, null, label));
  const { decisions } = await boundDecisions(await saved.loadCheckpoint(), saved.readView, skipped);
  const errors = [];
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', base, head], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  for (const file of paths.filter((file) => !RELATION_DATA_FILE.test(file))) errors.push(`${file}: a D1 PR changes Relation files only`);
  const state = prState(root, base, head, label);
  const senses = dSenses(decisions);
  const ops = await opsBetween(state.baseRead, state.headRead, state.changed);
  const dropped = new Set();
  for (const op of ops) {
    const key = keyOf(op);
    const name = key.replaceAll('\u0000', '|');
    if (op.op !== 'drop') errors.push(`${name}: a D1 PR only drops Relations (${op.op})`);
    else if (!touches(op, senses)) errors.push(`${name}: dropped, but neither end is a D Sense`);
    else dropped.add(key);
  }
  const expected = senses.size ? (await scanTouching(root, senses, new Map(), { reader: state.baseRead, relationsOnly: true })).relations : [];
  const kept = new Set();
  for (const { row } of expected) {
    const key = keyOf(row);
    if (touches(row, senses) && !dropped.has(key) && !kept.has(key)) {
      kept.add(key);
      errors.push(`${key.replaceAll('\u0000', '|')}: touches a D Sense but is not dropped`);
    }
  }
  if (errors.length) throw new AdmissionVerifyError('d1-scope', errors, `${label} verify failed: ${errors.length} finding(s)`);
  return { version: 1, ok: true, shard, scope: 'd1-decisions', d_senses: senses.size, removed_relations: dropped.size,
    changed_files: state.changed.length };
}

// A keyed rule has no Stage 2 Part-scoped mode.
export const scopedRow = null;
export const scopedName = null;

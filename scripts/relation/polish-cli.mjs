/**
 * Polish CLI (#8784): direct, word-level Add/Drop/Set of approved Relations, independent of Stage/batch progress.
 *
 * The AI decides only which Relations to add, drop or retype and why. This CLI owns everything else against the
 * current approved JSONL (the source of truth even when a generated DB is stale):
 *
 * - `show` lists, for a word/record/Sense, every approved Relation touching it in both directions with the exact
 *   counterpart Sense, POS, gloss, Type/Tier, owning shard file/line, relation key and provenance (`p`, `ver`, legacy),
 *   STDICT `direct/antonym` links and earlier Polish exclusions.
 * - `apply` validates an edit list, writes `by:"p"` Relations, `z` Drops for real orphaned Stage 1 Candidates (in the
 *   Candidate's owning shard), removes Drops a Polish Add now covers, records/clears `p` exclusions, re-runs the shared
 *   row validator and the Candidate accounting of every affected shard (no new accounting problem may appear), and
 *   saves all changed files together. No change is a no-op.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ACTION_TARGET_POS,
  ADMISSION_TYPES,
  AdmissionVerifyError,
  buildCanonicalIndex,
  loadShardCandidateFiles,
  mergeCandidates,
  normalizeCandidate,
  orphanedCandidateDrops,
  relationCandidateKeys,
  relationTouchesSenses,
  senseTokenPattern,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';
import { parseCandidateJsonl } from './candidate-contract.mjs';
import {
  deserializeDropRow, deserializeRelationRow, exclusionKey, isExclusionRow, parseDropExclusionJsonlLinesMatching,
  parseDropJsonlLinesMatching, parseRelationJsonlLinesMatching, serializeDropRow, serializeRelationRow,
} from './persisted-jsonl.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELATION_FILE = (shard) => `data/relations/relation-${shard}.jsonl`;
const DROP_FILE = (shard) => `data/relation-drops/drop-${shard}.jsonl`;
const EDIT_KEYS = {
  add: ['op', 'reason', 'relevance', 'source_sense_id', 'type'],
  set: ['op', 'reason', 'relevance', 'source_sense_id', 'type'],
  drop: ['op', 'reason', 'source_sense_id'],
};
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class PolishInputError extends Error {}

/** Direction-free relation key: exact Sense pair for ID links, source Sense + normalized text for text-only. */
export const relationKey = (row) => exclusionKey(row);

// ---- repository state ---------------------------------------------------------------------------------------

export async function loadCanonical(root) {
  const directory = path.join(root, 'data/canonical');
  const rows = [];
  const shardOfSense = new Map();
  const rowsByShard = new Map();
  for (const name of (await readdir(directory)).filter((item) => /^stdict-\d{4}\.jsonl$/u.test(item)).sort()) {
    const shard = name.slice('stdict-0'.length, -'.jsonl'.length);
    const shardRows = parseCandidateJsonl(await readFile(path.join(directory, name), 'utf8'), name);
    rowsByShard.set(shard, shardRows);
    for (const record of shardRows) {
      rows.push(record);
      for (const sense of record.senses) shardOfSense.set(sense.id, shard);
    }
  }
  return { index: buildCanonicalIndex(rows), shardOfSense, rowsByShard };
}

async function readText(root, relative) {
  const file = path.join(root, relative);
  return existsSync(file) ? readFile(file, 'utf8') : null;
}

const linesOf = (text) => (text ? text.split(/\r?\n/u).filter((line) => line.trim() !== '') : []);

/** Every persisted row of all Relation and Drop files that names one of `senseIds`, with its file and line. */
export async function scanTouching(root, senseIds, overrides = new Map(), { only = null, reader = null } = {}) {
  const pattern = senseTokenPattern(senseIds);
  const relations = [];
  const drops = [];
  for (const [directory, namePattern, family] of [['data/relations', /^relation-(\d{3})\.jsonl$/u, 'relation'], ['data/relation-drops', /^drop-(\d{3})\.jsonl$/u, 'drop']]) {
    const absolute = path.join(root, directory);
    const names = new Set(existsSync(absolute) ? (await readdir(absolute)).filter((name) => namePattern.test(name)) : []);
    for (const key of overrides.keys()) if (key.startsWith(`${directory}/`)) names.add(path.posix.basename(key));
    for (const name of [...names].sort()) {
      const relative = `${directory}/${name}`;
      if (only && !only.has(relative)) continue;
      const text = overrides.has(relative) ? overrides.get(relative) : reader ? await reader(relative)
        : existsSync(path.join(root, relative)) ? await readFile(path.join(root, relative), 'utf8') : null;
      if (!text) continue;
      const shard = namePattern.exec(name)[1];
      if (family === 'relation') {
        for (const { row, position } of parseRelationJsonlLinesMatching(text, relative, pattern)) {
          if (relationTouchesSenses(row, senseIds)) relations.push({ shard, file: relative, line: position + 1, row });
        }
        continue;
      }
      const entries = [...parseDropJsonlLinesMatching(text, relative, pattern), ...parseDropExclusionJsonlLinesMatching(text, relative, pattern)];
      for (const { row, position } of entries.sort((left, right) => left.position - right.position)) {
        const touches = senseIds.has(row.source_sense_id) || (isExclusionRow(row) && 'target_sense_id' in row && senseIds.has(row.target_sense_id));
        if (touches) drops.push({ shard, file: relative, line: position + 1, row });
      }
    }
  }
  return { relations, drops };
}

/** `scanTouching` after the planned edits, re-reading only the files the plan touched. */
async function rescan(root, senseIds, base, plan) {
  const overrides = plan.overrides();
  const fresh = await scanTouching(root, senseIds, overrides, { only: new Set(overrides.keys()), reader: plan.reader });
  const order = (left, right) => left.file.localeCompare(right.file) || left.line - right.line;
  return {
    relations: [...base.relations.filter((entry) => !overrides.has(entry.file)), ...fresh.relations].sort(order),
    drops: [...base.drops.filter((entry) => !overrides.has(entry.file)), ...fresh.drops].sort(order),
  };
}

// ---- show ---------------------------------------------------------------------------------------------------

function provenanceOf(row) {
  if (row.polish === true) return 'p';
  if (Object.hasOwn(row, 'candidate_assignment_version')) return `ver:${row.candidate_assignment_version}`;
  return 'legacy';
}

function describeSense(index, senseId) {
  const found = index.senses.get(senseId);
  return found ? { record_id: found.record.id, sense_id: senseId, lemma: found.record.lemma, pos: found.sense.pos, gloss: found.sense.gloss } : { sense_id: senseId, missing: true };
}

function selectSenses(index, { word, record, sense }) {
  if ([word, record, sense].filter((value) => value !== null).length !== 1) throw new PolishInputError('show needs exactly one of --word, --record or --sense');
  if (sense) {
    if (!index.senses.has(sense)) throw new PolishInputError(`unknown Sense ${sense}`);
    return [sense];
  }
  const records = record ? [index.byId.get(record)].filter(Boolean)
    : [...index.byId.values()].filter((entry) => normalizeCandidate(entry.lemma) === normalizeCandidate(word));
  if (records.length === 0) throw new PolishInputError(`no Canonical record for ${record ?? JSON.stringify(word)}`);
  return records.flatMap((entry) => entry.senses.map((item) => item.id));
}

export async function show(options, root = REPOSITORY_DIRECTORY) {
  const { index, shardOfSense } = await loadCanonical(root);
  const senseIds = selectSenses(index, options);
  const selected = new Set(senseIds);
  const { relations, drops } = await scanTouching(root, selected);
  const stdictReverse = new Map();
  for (const { record, sense } of index.senses.values()) {
    for (const link of sense.relations ?? []) {
      if (selected.has(link.target_sense)) stdictReverse.set(link.target_sense, [...(stdictReverse.get(link.target_sense) ?? []), { from: sense.id, record: record.id, type: link.type }]);
    }
  }
  const senses = senseIds.map((senseId) => {
    const found = index.senses.get(senseId);
    const touching = relations.filter(({ row }) => row.source_sense_id === senseId || (!('text' in row) && row.target_sense_id === senseId));
    return {
      ...describeSense(index, senseId),
      shard: shardOfSense.get(senseId),
      stdict: [
        ...(found.sense.relations ?? []).map((link) => ({ direction: 'forward', type: link.type, ...describeSense(index, link.target_sense) })),
        ...(stdictReverse.get(senseId) ?? []).map((link) => ({ direction: 'reverse', type: link.type, ...describeSense(index, link.from) })),
      ],
      relations: touching.map(({ file, line, row }) => {
        const forward = row.source_sense_id === senseId;
        return {
          key: relationKey(row).replaceAll('\u0000', '|'),
          direction: 'text' in row ? 'text' : forward ? 'forward' : 'reverse',
          ...('text' in row ? { text: row.text } : { counterpart: describeSense(index, forward ? row.target_sense_id : row.source_sense_id) }),
          type: row.type,
          relevance: row.relevance,
          by: provenanceOf(row),
          stored: `${file}:${line}`,
        };
      }),
      polish_exclusions: drops.filter(({ row }) => isExclusionRow(row)
        && (row.source_sense_id === senseId || row.target_sense_id === senseId)).map(({ file, line, row }) => ({
        ...('text' in row ? { text: row.text } : { counterpart: describeSense(index, row.source_sense_id === senseId ? row.target_sense_id : row.source_sense_id) }),
        stored: `${file}:${line}`,
      })),
    };
  });
  return { version: 1, senses };
}

function renderShow(result) {
  const lines = [];
  for (const sense of result.senses) {
    lines.push(`S\t${sense.sense_id}\t${sense.record_id}\t${sense.lemma}\t${sense.pos}\t${sense.gloss}\tshard ${sense.shard}`);
    for (const link of sense.stdict) lines.push(`  STDICT\t${link.type}\t${link.direction}\t${link.sense_id}\t${link.lemma}\t${link.pos}\t${link.gloss}`);
    for (const link of sense.relations) {
      const target = link.text !== undefined ? `text ${JSON.stringify(link.text)}`
        : `${link.counterpart.sense_id}\t${link.counterpart.lemma}\t${link.counterpart.pos}\t${link.counterpart.gloss}`;
      lines.push(`  R\t${link.type}\t${link.relevance}\t${link.direction}\t${target}\t${link.by}\t${link.stored}`);
    }
    for (const exclusion of sense.polish_exclusions) {
      const target = exclusion.text !== undefined ? `text ${JSON.stringify(exclusion.text)}` : `${exclusion.counterpart.sense_id}\t${exclusion.counterpart.lemma}`;
      lines.push(`  X\t${target}\t${exclusion.stored}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---- apply --------------------------------------------------------------------------------------------------

function parseEdits(input, index) {
  if (!isPlainObject(input) || !Array.isArray(input.edits) || input.edits.length === 0 || Object.keys(input).join() !== 'edits') {
    throw new PolishInputError('input must be {"edits":[...]} with at least one edit');
  }
  const seen = new Set();
  return input.edits.map((edit, position) => {
    const at = `edits[${position}]`;
    if (!isPlainObject(edit) || !Object.hasOwn(EDIT_KEYS, edit.op)) throw new PolishInputError(`${at}: op must be add, set or drop`);
    const targetKeys = Object.hasOwn(edit, 'text') ? ['text'] : ['target_sense_id'];
    const expected = [...EDIT_KEYS[edit.op], ...targetKeys].sort().join(',');
    if (Object.keys(edit).sort().join(',') !== expected) throw new PolishInputError(`${at}: ${edit.op} must have exactly ${expected}`);
    if (typeof edit.reason !== 'string' || !edit.reason.trim()) throw new PolishInputError(`${at}: reason must be a non-empty editorial note`);
    const source = index.senses.get(edit.source_sense_id);
    if (!source) throw new PolishInputError(`${at}: unknown source Sense ${edit.source_sense_id}`);
    const row = { source_record_id: source.record.id, source_sense_id: edit.source_sense_id };
    if (targetKeys[0] === 'text') {
      if (typeof edit.text !== 'string' || !edit.text.trim()) throw new PolishInputError(`${at}: text must be a non-empty string`);
      row.text = normalizeCandidate(edit.text);
      if (row.text === normalizeCandidate(source.record.lemma)) throw new PolishInputError(`${at}: text repeats the source lemma`);
    } else {
      const target = index.senses.get(edit.target_sense_id);
      if (!target) throw new PolishInputError(`${at}: unknown target Sense ${edit.target_sense_id}`);
      if (target.record.id === source.record.id) throw new PolishInputError(`${at}: a Relation cannot target its own record`);
      Object.assign(row, { target_record_id: target.record.id, target_sense_id: edit.target_sense_id });
    }
    if (edit.op !== 'drop') {
      if (!ADMISSION_TYPES.includes(edit.type)) throw new PolishInputError(`${at}: type must be one of ${ADMISSION_TYPES.join('/')}`);
      if (!Number.isInteger(edit.relevance) || edit.relevance < 1 || edit.relevance > 9) throw new PolishInputError(`${at}: relevance must be an integer 1..9`);
      if (edit.type === 'action' && !('text' in row) && !ACTION_TARGET_POS.includes(index.senses.get(row.target_sense_id).sense.pos)) {
        throw new PolishInputError(`${at}: action must target a ${ACTION_TARGET_POS.join(' or ')} Sense`);
      }
    }
    const key = relationKey(row);
    if (seen.has(key)) throw new PolishInputError(`${at}: the same relation key is edited twice`);
    seen.add(key);
    return { position, op: edit.op, reason: edit.reason.trim(), row, key, type: edit.type, relevance: edit.relevance };
  });
}

const stripPosition = (message) => message.replace(/^(?:relation|drop|exclusion):\d+: /u, '');

export function accountingProblems(args) {
  try { verifyAccounting(args); return []; } catch (error) {
    if (error instanceof AdmissionVerifyError) return error.errors.map(stripPosition);
    throw error;
  }
}

/** File-level plan: per relative path, the original text and the edited line list. */
class FilePlan {
  constructor(reader) { this.files = new Map(); this.reader = reader; }
  async open(root, relative) {
    if (!this.files.has(relative)) {
      const text = await this.reader(relative);
      this.files.set(relative, { original: text, lines: linesOf(text), removed: new Set(), replaced: new Map(), appended: [] });
    }
    return this.files.get(relative);
  }
  text(relative) {
    const file = this.files.get(relative);
    if (!file) return undefined;
    const lines = [...file.lines.flatMap((line, position) => (file.removed.has(position + 1) ? [] : [file.replaced.get(position + 1) ?? line])), ...file.appended];
    return lines.length ? `${lines.join('\n')}\n` : (file.original === null ? null : '');
  }
  overrides() { return new Map([...this.files.keys()].map((relative) => [relative, this.text(relative)])); }
  changed() { return [...this.files.keys()].filter((relative) => (this.text(relative) ?? null) !== file(this, relative).original); }
}
const file = (plan, relative) => plan.files.get(relative);

async function writeAll(root, plan, changed, read) {
  for (const relative of changed) {
    const current = await read(relative);
    if (current !== file(plan, relative).original) throw new Error(`${relative} changed during Polish apply; nothing was written, rerun on the latest files`);
  }
  const staged = [];
  try {
    for (const relative of changed) {
      const target = path.join(root, relative);
      const next = plan.text(relative);
      if (next === null) { staged.push({ target, temporary: null }); continue; }
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, next, { encoding: 'utf8', flag: 'wx' });
      staged.push({ target, temporary });
    }
    for (const { target, temporary } of staged) {
      if (temporary) await rename(temporary, target);
      else await rm(target, { force: true });
    }
  } catch (error) {
    await Promise.all(staged.filter(({ temporary }) => temporary).map(({ temporary }) => rm(temporary, { force: true })));
    throw error;
  }
}

/**
 * `reader` (relative path -> text or null) binds every read — scan, file plan, validation and accounting — to one
 * data state (default: the working tree); a caller that rebuilds from a Git base passes that base. `returnTexts` adds
 * each changed file's planned text to a dry run, so the caller can write it itself.
 */
export async function apply(input, { root = REPOSITORY_DIRECTORY, dryRun = false, reader = null, canonical = null,
  returnTexts = false } = {}) {
  const read = reader ?? ((relative) => readText(root, relative));
  const { index, shardOfSense, rowsByShard } = canonical ?? await loadCanonical(root);
  const edits = parseEdits(input, index);
  const editSenses = new Set(edits.flatMap(({ row }) => [row.source_sense_id, ...('text' in row ? [] : [row.target_sense_id])]));
  // One scan of every row touching a Sense of an affected shard; edited Senses are a subset of it.
  const affectedShards = [...new Set([...editSenses].map((senseId) => shardOfSense.get(senseId)))].sort();
  // The accounting scope: every record owning an edited Sense (#9928). Rows of other records cannot change.
  const scopeRecordsByShard = new Map();
  for (const record of new Set([...editSenses].map((senseId) => index.senses.get(senseId).record))) {
    const shard = shardOfSense.get(record.senses[0].id);
    if (!scopeRecordsByShard.has(shard)) scopeRecordsByShard.set(shard, []);
    scopeRecordsByShard.get(shard).push(record);
  }
  const scopeSenses = new Set([...scopeRecordsByShard.values()].flat().flatMap((record) => record.senses.map((sense) => sense.id)));
  const beforeAll = await scanTouching(root, scopeSenses, new Map(), { reader: read });
  const touchesEdit = (entry) => editSenses.has(entry.row.source_sense_id) || editSenses.has(entry.row.target_sense_id);
  const before = { relations: beforeAll.relations.filter(touchesEdit), drops: beforeAll.drops.filter(touchesEdit) };
  const plan = new FilePlan(read);
  const results = [];
  const removedRows = [];
  const addedRows = [];

  // Key indexes built once: a whole-shard edit list (Stage 4) must not rescan every row per edit.
  const byKey = (entries) => entries.reduce((map, entry) => (map.has(entry.key) ? map.get(entry.key).push(entry) : map.set(entry.key, [entry]), map), new Map());
  const relationsByKey = byKey(before.relations.map((entry) => ({ ...entry, key: relationKey(entry.row) })));
  const exclusionsByKey = byKey(before.drops.filter(({ row }) => isExclusionRow(row)).map((entry) => ({ ...entry, key: exclusionKey(entry.row) })));
  const findRelation = (key) => relationsByKey.get(key) ?? [];
  const findExclusions = (key) => exclusionsByKey.get(key) ?? [];
  for (const edit of edits) {
    const [existing, ...extra] = findRelation(edit.key);
    if (extra.length) throw new Error(`relation key ${edit.key.replaceAll('\u0000', '|')} is stored more than once (${[existing, ...extra].map((entry) => `${entry.file}:${entry.line}`).join(', ')})`);
    const exclusions = findExclusions(edit.key);
    const keyText = edit.key.replaceAll('\u0000', '|');
    if (edit.op === 'add' && existing && existing.row.type === edit.type && existing.row.relevance === edit.relevance) {
      results.push({ op: 'add', key: keyText, status: 'unchanged', stored: `${existing.file}:${existing.line}`, reason: edit.reason });
      continue;
    }
    if (edit.op === 'drop' && !existing && exclusions.length) {
      results.push({ op: 'drop', key: keyText, status: 'unchanged', exclusion: `${exclusions[0].file}:${exclusions[0].line}`, reason: edit.reason });
      continue;
    }
    if (edit.op === 'add') {
      if (existing) throw new PolishInputError(`edits[${edit.position}]: relation already exists at ${existing.file}:${existing.line}; use set or drop`);
      const shard = shardOfSense.get(edit.row.source_sense_id);
      const row = 'text' in edit.row
        ? { ...edit.row, type: edit.type, relevance: edit.relevance, polish: true }
        : { ...edit.row, type: edit.type, relevance: edit.relevance, reverse_type: edit.type, reverse_relevance: edit.relevance, polish: true };
      (await plan.open(root, RELATION_FILE(shard))).appended.push(JSON.stringify(serializeRelationRow(row)));
      for (const exclusion of exclusions) (await plan.open(root, exclusion.file)).removed.add(exclusion.line);
      addedRows.push(row);
      results.push({ op: 'add', key: edit.key.replaceAll('\u0000', '|'), stored: RELATION_FILE(shard), reason: edit.reason,
        ...(exclusions.length ? { cleared_exclusions: exclusions.map((entry) => `${entry.file}:${entry.line}`) } : {}) });
      continue;
    }
    if (!existing) throw new PolishInputError(`edits[${edit.position}]: no approved relation ${edit.key.replaceAll('\u0000', '|')} to ${edit.op}`);
    const relationFile = await plan.open(root, existing.file);
    if (edit.op === 'set') {
      if (existing.row.type === edit.type && existing.row.relevance === edit.relevance) {
        results.push({ op: 'set', key: edit.key.replaceAll('\u0000', '|'), status: 'unchanged', stored: `${existing.file}:${existing.line}`, reason: edit.reason });
        continue;
      }
      const row = { ...existing.row, type: edit.type, relevance: edit.relevance, ...('text' in existing.row ? {} : { reverse_type: edit.type, reverse_relevance: edit.relevance }) };
      relationFile.replaced.set(existing.line, JSON.stringify(serializeRelationRow(row)));
      results.push({ op: 'set', key: edit.key.replaceAll('\u0000', '|'), stored: `${existing.file}:${existing.line}`, reason: edit.reason,
        before: { type: existing.row.type, relevance: existing.row.relevance }, after: { type: edit.type, relevance: edit.relevance } });
      continue;
    }
    relationFile.removed.add(existing.line);
    removedRows.push(existing.row);
    const exclusion = 'text' in existing.row
      ? { source_record_id: existing.row.source_record_id, source_sense_id: existing.row.source_sense_id, text: existing.row.text, reason: 'p' }
      : { source_record_id: existing.row.source_record_id, source_sense_id: existing.row.source_sense_id,
        target_record_id: existing.row.target_record_id, target_sense_id: existing.row.target_sense_id, reason: 'p' };
    const dropRelative = DROP_FILE(existing.shard);
    if (!exclusions.length) (await plan.open(root, dropRelative)).appended.push(JSON.stringify(serializeDropRow(exclusion)));
    results.push({ op: 'drop', key: edit.key.replaceAll('\u0000', '|'), removed: `${existing.file}:${existing.line}`, by: provenanceOf(existing.row),
      exclusion: exclusions.length ? `${exclusions[0].file}:${exclusions[0].line}` : dropRelative, reason: edit.reason });
  }

  // Every Relation edit is planned. Each affected shard is now settled once, in turn, and its Candidate data released:
  // Drops an Add now covers go, real orphans get `z`, then its changed files pass the shared row validator and its
  // accounting gains no new problem. Only the edited records can change: rows and accounting are scoped to them.
  const sideEffects = { z_added: [], drops_removed: [] };
  const shardsOf = (row) => new Set([shardOfSense.get(row.source_sense_id), 'target_sense_id' in row ? shardOfSense.get(row.target_sense_id) : null].filter(Boolean));
  const byShard = (entries) => {
    const buckets = new Map();
    for (const entry of entries) {
      for (const shard of shardsOf(entry.row)) {
        if (!buckets.has(shard)) buckets.set(shard, []);
        buckets.get(shard).push(entry);
      }
    }
    return buckets;
  };
  const afterAll = await rescan(root, scopeSenses, beforeAll, plan);
  const removedByShard = byShard(removedRows.map((row) => ({ row })));
  const addedByShard = byShard(addedRows.map((row) => ({ row })));
  const afterRelations = byShard(afterAll.relations);
  const beforeRelations = byShard(beforeAll.relations);
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const parseRelations = (text, relative) => linesOf(text).map((line, position) => deserializeRelationRow(JSON.parse(line), `${relative}:${position + 1}`));
  const parseDrops = (text, relative) => linesOf(text).map((line, position) => deserializeDropRow(JSON.parse(line), `${relative}:${position + 1}`));
  for (const shard of affectedShards) {
    const relationRelative = RELATION_FILE(shard);
    const dropRelative = DROP_FILE(shard);
    const { files } = await loadShardCandidateFiles(shard, root);
    const canonicalRows = rowsByShard.get(shard);
    const candidateMerge = mergeCandidates(canonicalRows, files, { canonicalLemmaForms });
    const shardSenseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
    const dropFile = await plan.open(root, dropRelative);
    const ownDropEntries = new Map();
    for (const entry of beforeAll.drops) {
      if (entry.file !== dropRelative || isExclusionRow(entry.row)) continue;
      const dropKey = `${entry.row.source_sense_id}\u0000${entry.row.candidate}`;
      if (!ownDropEntries.has(dropKey)) ownDropEntries.set(dropKey, []);
      ownDropEntries.get(dropKey).push(entry);
    }
    for (const { row } of addedByShard.get(shard) ?? []) {
      const keys = relationCandidateKeys(row, candidateMerge.merged, index);
      for (const key of [...keys.forward, ...keys.reverse]) {
        if (!shardSenseIds.has(key.senseId) || !candidateMerge.merged.get(key.senseId)?.candidates.has(key.candidate)) continue;
        for (const entry of ownDropEntries.get(`${key.senseId}\u0000${key.candidate}`) ?? []) {
          if (dropFile.removed.has(entry.line)) continue;
          dropFile.removed.add(entry.line);
          sideEffects.drops_removed.push({ stored: `${entry.file}:${entry.line}`, source_sense_id: key.senseId, candidate: key.candidate, by: entry.row.reason });
        }
      }
    }
    if (removedByShard.has(shard)) {   // only a removed row reaching this shard's Senses can orphan its Candidates
      const orphans = orphanedCandidateDrops({ canonicalRows, candidateFiles: files,
        removedRelationRows: removedByShard.get(shard).map(({ row }) => row),
        relationRows: (afterRelations.get(shard) ?? []).map(({ row }) => row),
        dropRows: parseDrops(plan.text(dropRelative) ?? '', dropRelative).filter((row) => !isExclusionRow(row)),
        index, candidateMerge, includeText: true });
      for (const row of orphans) {
        dropFile.appended.push(JSON.stringify(serializeDropRow(row)));
        sideEffects.z_added.push({ stored: dropRelative, source_sense_id: row.source_sense_id, candidate: row.candidate });
      }
    }

    const ownText = plan.files.has(relationRelative) ? plan.text(relationRelative) : await read(relationRelative);
    const ownRows = parseRelations(ownText, relationRelative);
    const ownDropAll = parseDrops(plan.text(dropRelative), dropRelative);
    const ownDrops = ownDropAll.filter((row) => !isExclusionRow(row));
    const others = (afterRelations.get(shard) ?? []).filter((entry) => entry.file !== relationRelative).map(({ row }) => row);
    const shardChanged = [relationRelative, dropRelative].some((relative) => plan.files.has(relative)
      && (plan.text(relative) ?? null) !== plan.files.get(relative).original);
    // Other-shard rows serve only duplicate detection, so the rows touching the edited records find every new one.
    if (shardChanged) {
      validateRelationRows({ relationRows: ownRows, dropRows: ownDrops, exclusionRows: ownDropAll.filter(isExclusionRow), index, shardSenseIds, otherRelationRows: others });
    }
    if (files.length === 0) continue;
    const scopeRows = scopeRecordsByShard.get(shard);
    const beforeOwnRows = parseRelations(await read(relationRelative), relationRelative);
    const beforeOwnDrops = parseDrops(await read(dropRelative), dropRelative).filter((row) => !isExclusionRow(row));
    const beforeOthers = (beforeRelations.get(shard) ?? []).filter((entry) => entry.file !== relationRelative).map(({ row }) => row);
    const common = { canonicalRows, candidateFiles: files, index, candidateMerge, scopeRows };
    const old = new Set(accountingProblems({ ...common, relationRows: beforeOwnRows, dropRows: beforeOwnDrops, otherRelationRows: beforeOthers }));
    const introduced = accountingProblems({ ...common, relationRows: ownRows, dropRows: ownDrops, otherRelationRows: others }).filter((problem) => !old.has(problem));
    if (introduced.length) throw new Error(`Polish edit would introduce Candidate accounting problems in shard ${shard}:\n${introduced.slice(0, 20).map((problem) => `- ${problem}`).join('\n')}`);
  }
  const changed = plan.changed();

  if (changed.length && !dryRun) await writeAll(root, plan, changed, read);
  return {
    version: 1,
    ok: true,
    dry_run: dryRun,
    status: changed.length ? (dryRun ? 'planned' : 'applied') : 'no-op',
    edits: results,
    ...sideEffects,
    files: changed.map((relative) => ({ path: relative, sha256: plan.text(relative) === null ? null : sha256(plan.text(relative)),
      ...(returnTexts ? { text: plan.text(relative) } : {}) })),
    affected_shards: affectedShards,
  };
}

// ---- CLI ----------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, word: null, record: null, sense: null, input: null, dryRun: false, json: false };
  for (let position = 0; position < rest.length; position += 1) {
    const flag = rest[position];
    const value = () => {
      const next = rest[position + 1];
      if (next === undefined) throw new PolishInputError(`${flag} needs a value`);
      position += 1;
      return next;
    };
    if (flag === '--word') options.word = value();
    else if (flag === '--record') options.record = value();
    else if (flag === '--sense') options.sense = value();
    else if (flag === '--input') options.input = value();
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else throw new PolishInputError(`unknown option ${flag}`);
  }
  return options;
}

export async function run(argv, { root = REPOSITORY_DIRECTORY } = {}) {
  const options = parseArgs(argv);
  if (options.command === 'show') {
    const result = await show(options, root);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : renderShow(result));
    return result;
  }
  if (options.command === 'apply') {
    if (!options.input) throw new PolishInputError('apply needs --input <edits.json>');
    const input = JSON.parse(options.input === '-' ? await new Promise((resolve) => {
      let text = '';
      process.stdin.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => resolve(text));
    }) : await readFile(options.input, 'utf8'));
    const result = await apply(input, { root, dryRun: options.dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  throw new PolishInputError('usage: polish-cli.mjs show (--word <lemma>|--record <id>|--sense <sense id>) [--json] | apply --input <edits.json|-> [--dry-run]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof PolishInputError ? 2 : 1;
  });
}

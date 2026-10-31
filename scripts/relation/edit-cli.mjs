import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertShard,
  createReverseCandidateFormLookup,
  existingCandidateKeys,
  loadAllApprovedDrops,
  loadApprovedRelations,
  loadOptionalDropJsonl,
  loadOptionalRelationJsonl,
  loadShard,
  mergeCandidates,
  normalizeCandidate,
  orphanedCandidateDrops,
  sameSpellingTargets,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl, serializeRelationJsonl } from './persisted-jsonl.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VIEW_DIRECTORY = (shard, root) => path.join(root, '.warroom-scratch', `relation-edit-${shard}`);
const CHECKPOINT_PATH = (shard, root) => path.join(root, '.warroom-scratch', `relation-edit-${shard}.json`);
const RELATION_PATH = (shard, root) => path.join(root, 'data/relations', `relation-${shard}.jsonl`);
const DROP_PATH = (shard, root) => path.join(root, 'data/relation-drops', `drop-${shard}.jsonl`);
const MIN_CHUNK_RELATIONS = 350;
const MAX_CHUNK_RELATIONS = 500;

const compactRows = (contents) => contents.split(/\r?\n/u).filter((line) => line.trim() !== '');
const rowKey = (senseId, candidate) => `${senseId}\u0000${normalizeCandidate(candidate)}`;

function fail(message) {
  throw new Error(message);
}

function jsonlLines(contents, file) {
  const lines = compactRows(contents);
  for (const [index, line] of lines.entries()) {
    try { JSON.parse(line); } catch (error) { fail(`${file}:${index + 1} is not valid JSON: ${error.message}`); }
  }
  return lines;
}

function git(root, args, { allowMissing = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing) return null;
    fail(`git ${args.join(' ')} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function gitHead(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) fail('repository HEAD is unavailable');
  return head;
}

async function readOptional(file) {
  try { return { exists: true, text: await readFile(file, 'utf8') }; }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

function readHeadFile(root, file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (path.isAbsolute(relative) || relative.startsWith('../')) fail(`file is outside repository: ${file}`);
  const listed = git(root, ['ls-tree', '--name-only', 'HEAD', '--', relative]);
  if (!listed.trim()) return { exists: false, text: '' };
  return { exists: true, text: git(root, ['show', `HEAD:${relative}`]) };
}

function sameFileState(left, right) {
  return left.exists === right.exists && left.text === right.text;
}

function readCheckpointText(text, shard) {
  let checkpoint;
  try { checkpoint = JSON.parse(text); } catch (error) { fail(`Stage 3 checkpoint is not valid JSON: ${error.message}`); }
  if (!checkpoint || Array.isArray(checkpoint) || typeof checkpoint !== 'object'
      || Object.keys(checkpoint).sort().join(',') !== 'chunk_total,completed_chunks,decisions,shard,version'
      || checkpoint.version !== 1 || checkpoint.shard !== shard
      || !Number.isSafeInteger(checkpoint.chunk_total) || checkpoint.chunk_total < 0
      || !Array.isArray(checkpoint.completed_chunks) || !Array.isArray(checkpoint.decisions)) {
    fail(`Stage 3 checkpoint does not match shard ${shard} or the compact v1 contract`);
  }
  const completed = new Set();
  for (const number of checkpoint.completed_chunks) {
    if (typeof number !== 'string' || !/^\d{3}$/u.test(number) || completed.has(number)
        || Number(number) < 1 || Number(number) > checkpoint.chunk_total) fail('Stage 3 checkpoint has an invalid completed chunk list');
    completed.add(number);
  }
  const rows = new Set();
  for (const decision of checkpoint.decisions) {
    if (!decision || Array.isArray(decision) || typeof decision !== 'object') fail('Stage 3 checkpoint has an invalid decision');
    const keys = Object.keys(decision).sort().join(',');
    if (decision.action === 'drop') {
      if (keys !== 'action,row') fail('Stage 3 Drop decision must have only action and row');
    } else if (decision.action === 'repair') {
      if (keys !== 'action,row,target_record_id,target_sense_id') fail('Stage 3 Link Repair decision must have exact target IDs');
      if (typeof decision.target_record_id !== 'string' || typeof decision.target_sense_id !== 'string') fail('Stage 3 Link Repair decision has invalid target IDs');
    } else fail('Stage 3 checkpoint has an unknown decision');
    if (!Number.isSafeInteger(decision.row) || decision.row < 1 || rows.has(decision.row)) fail('Stage 3 checkpoint repeats or misnumbers a Relation row');
    rows.add(decision.row);
  }
  return checkpoint;
}

async function loadCheckpoint(shard, root) {
  const file = CHECKPOINT_PATH(shard, root);
  const state = await readOptional(file);
  if (!state.exists) fail(`Stage 3 is not prepared for shard ${shard}; run prepare first`);
  return readCheckpointText(state.text, shard);
}

async function writeJsonAtomically(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadContext(shard, root, { relationText, dropText } = {}) {
  const loaded = await loadShard(shard, root);
  if (loaded.inventory.missing.length) {
    fail(`Stage 3 requires complete Stage 1 inputs; missing ${loaded.inventory.missing.join(', ')}`);
  }
  const relationFile = RELATION_PATH(shard, root);
  const dropFile = DROP_PATH(shard, root);
  const [ownRelations, ownDrops] = await Promise.all([
    relationText === undefined ? loadOptionalRelationJsonl(relationFile) : parseRelationJsonl(relationText, path.basename(relationFile)),
    dropText === undefined ? loadOptionalDropJsonl(dropFile) : parseDropJsonl(dropText, path.basename(dropFile)),
  ]);
  const [otherRelations, allDrops] = await Promise.all([
    loadApprovedRelations(root, { exceptShard: shard }),
    loadAllApprovedDrops(root),
  ]);
  const shardSenseIds = new Set(loaded.canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const otherDrops = allDrops.filter((row) => !shardSenseIds.has(row.source_sense_id));
  // Callers may validate a Git baseline while the working tree already contains a prior apply result.
  // Keep the selected shard's drop set bound to that same baseline for repeatable apply calculations.
  const scopedAllDrops = [...otherDrops, ...ownDrops];
  validateRelationRows({ relationRows: ownRelations, dropRows: ownDrops, index: loaded.index, shardSenseIds,
    otherRelationRows: otherRelations });
  verifyAccounting({ canonicalRows: loaded.canonicalRows, candidateFiles: loaded.candidateFiles,
    relationRows: ownRelations, dropRows: ownDrops, otherRelationRows: otherRelations, index: loaded.index });
  return { ...loaded, ownRelations, ownDrops, otherRelations, allDrops: scopedAllDrops, otherDrops, shardSenseIds };
}

/** Partition by complete source Sense groups, targeting 350–500 Relation rows. */
export function chunkSenseGroups(groups, { minimum = MIN_CHUNK_RELATIONS, maximum = MAX_CHUNK_RELATIONS } = {}) {
  if (!Array.isArray(groups) || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
      || minimum < 1 || maximum < minimum) fail('invalid Stage 3 chunk inputs');
  const chunks = [];
  let current = [];
  let count = 0;
  for (const group of groups) {
    if (!group || !Array.isArray(group.relations) || group.relations.length === 0) fail('Stage 3 chunks require non-empty complete Sense groups');
    const size = group.relations.length;
    if (current.length && count >= minimum && count + size > maximum) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(group);
    count += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function buildSenseGroups({ canonicalRows, relationRows }) {
  const bySense = new Map();
  relationRows.forEach((row, index) => {
    const entry = bySense.get(row.source_sense_id) ?? [];
    entry.push({ rowIndex: index + 1, row });
    bySense.set(row.source_sense_id, entry);
  });
  const groups = [];
  for (const record of canonicalRows) {
    for (const sense of record.senses) {
      const relations = bySense.get(sense.id) ?? [];
      if (relations.length) groups.push({ record, sense, relations });
    }
  }
  return groups;
}

function targetAliases(text, index) {
  let number = 0;
  return sameSpellingTargets(index, text).flatMap((record) => record.senses.map((sense) => ({
    alias: `T${++number}`,
    record_id: record.record_id,
    lemma: record.lemma,
    sense_id: sense.sense_id,
    pos: sense.pos,
    gloss: sense.gloss,
  })));
}

function renderChunk(groups, index, number, total) {
  let relationNumber = 0;
  const senses = groups.map(({ record, sense, relations }) => ({
    source: { lemma: record.lemma, pos: sense.pos, gloss: sense.gloss },
    relations: relations.map(({ rowIndex, row }) => {
      const n = ++relationNumber;
      if ('text' in row) return { n, text: row.text, type: row.type, tier: row.relevance,
        targets: targetAliases(row.text, index), _row: rowIndex,
        _source_record_id: record.id, _source_sense_id: sense.id };
      const targetRecord = index.byId.get(row.target_record_id);
      const targetSense = index.senses.get(row.target_sense_id)?.sense;
      const ambiguous = targetRecord.senses.length > 1 || (index.byLemma.get(targetRecord.lemma)?.length ?? 0) > 1;
      return {
        n,
        target: targetRecord.lemma,
        target_record_id: row.target_record_id,
        target_sense_id: row.target_sense_id,
        ...(ambiguous ? { target_pos: targetSense.pos, target_gloss: targetSense.gloss } : {}),
        type: row.type,
        tier: row.relevance,
        _row: rowIndex,
        _source_record_id: record.id,
        _source_sense_id: sense.id,
      };
    }),
  }));
  return { chunk: String(number).padStart(3, '0'), total_chunks: total,
    relation_count: relationNumber, senses };
}

function stripInternalRow(chunk) {
  return { ...chunk, senses: chunk.senses.map((sense) => ({
    ...sense,
    relations: sense.relations.map((relation) => Object.fromEntries(Object.entries(relation)
      .filter(([key]) => !key.startsWith('_')))),
  })) };
}

function chunkFiles(shard, root) {
  return VIEW_DIRECTORY(shard, root);
}

async function prepare(shard, root = REPOSITORY_DIRECTORY) {
  assertShard(shard);
  const checkpointPath = CHECKPOINT_PATH(shard, root);
  if (existsSync(checkpointPath)) {
    const checkpoint = await loadCheckpoint(shard, root);
    return { shard, chunk_count: checkpoint.chunk_total, completed_chunks: checkpoint.completed_chunks.length, resumed: true };
  }
  gitHead(root);
  const relationState = await readOptional(RELATION_PATH(shard, root));
  const dropState = await readOptional(DROP_PATH(shard, root));
  const relationBase = readHeadFile(root, RELATION_PATH(shard, root));
  const dropBase = readHeadFile(root, DROP_PATH(shard, root));
  if (!sameFileState(relationState, relationBase) || !sameFileState(dropState, dropBase)) {
    fail(`Stage 3 prepare requires clean shard ${shard} Relation/Drop files so decisions bind to the Git baseline`);
  }
  const context = await loadContext(shard, root, { relationText: relationBase.text, dropText: dropBase.text });
  const groups = buildSenseGroups({ canonicalRows: context.canonicalRows, relationRows: context.ownRelations });
  const chunks = chunkSenseGroups(groups);
  const directory = chunkFiles(shard, root);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [index, chunkGroups] of chunks.entries()) {
    const view = renderChunk(chunkGroups, context.index, index + 1, chunks.length);
    // The view is derived scratch input; the checkpoint stores only chunk completion and edit decisions.
    await writeFile(path.join(directory, `chunk-${view.chunk}.json`), `${JSON.stringify(view)}\n`, 'utf8');
  }
  const checkpoint = { version: 1, shard, chunk_total: chunks.length, completed_chunks: [], decisions: [] };
  await writeJsonAtomically(checkpointPath, checkpoint);
  return { shard, chunk_count: chunks.length, relation_count: context.ownRelations.length, resumed: false };
}

async function readNextChunk(shard, root = REPOSITORY_DIRECTORY) {
  const checkpoint = await loadCheckpoint(shard, root);
  if (checkpoint.completed_chunks.length === checkpoint.chunk_total) return { shard, complete: true, remaining_chunks: 0 };
  for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
    const chunk = String(number).padStart(3, '0');
    if (checkpoint.completed_chunks.includes(chunk)) continue;
    const file = path.join(chunkFiles(shard, root), `chunk-${chunk}.json`);
    const data = await readFile(file, 'utf8');
    let view;
    try { view = JSON.parse(data); } catch (error) { fail(`Stage 3 chunk ${chunk} is invalid JSON: ${error.message}`); }
    return stripInternalRow(view);
  }
  return { shard, complete: true, remaining_chunks: 0 };
}

function parseDecisionText(text, view, checkpoint) {
  if (typeof text !== 'string') fail('Stage 3 chunk decisions must be text');
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = /^chunk\s+(\d{3})$/u.exec(lines[0] ?? '');
  if (!match || match[1] !== view.chunk) fail(`decision input must begin with "chunk ${view.chunk}"`);
  if (checkpoint.completed_chunks.includes(view.chunk)) fail(`Stage 3 chunk ${view.chunk} is already saved`);
  const relations = view.senses.flatMap((sense) => sense.relations);
  const byNumber = new Map(relations.map((relation) => [relation.n, relation]));
  if (lines[1] === 'none') {
    if (lines.length !== 2) fail('none must be the only decision after the chunk marker');
    return [];
  }
  if (lines.length < 2) fail('write none when every Relation in this chunk should be kept');
  const decisions = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const drop = /^D\s+(\d+(?:\s+\d+)*)$/u.exec(line);
    const repair = /^L\s+(\d+)\s+T(\d+)$/u.exec(line);
    if (drop) {
      for (const rawNumber of drop[1].split(/\s+/u)) {
        const number = Number(rawNumber);
        const relation = byNumber.get(number);
        if (!relation || seen.has(number)) fail(`D ${number}: Relation number is unknown or repeated`);
        seen.add(number);
        decisions.push({ row: relation._row, action: 'drop' });
      }
      continue;
    }
    if (repair) {
      const number = Number(repair[1]);
      const relation = byNumber.get(number);
      if (!relation || seen.has(number)) fail(`L ${number}: Relation number is unknown or repeated`);
      if (typeof relation.text !== 'string') fail(`L ${number}: Link Repair applies only to a text-only Relation`);
      const target = relation.targets.find((item) => item.alias === `T${Number(repair[2])}`);
      if (!target) fail(`L ${number}: target alias T${repair[2]} is not an exact Canonical target for ${JSON.stringify(relation.text)}`);
      seen.add(number);
      decisions.push({ row: relation._row, action: 'repair', target_record_id: target.record_id, target_sense_id: target.sense_id });
      continue;
    }
    fail(`invalid decision line ${JSON.stringify(line)}; use D <row...>, L <row> T<target>, or none`);
  }
  const rows = new Set(checkpoint.decisions.map((decision) => decision.row));
  for (const decision of decisions) if (rows.has(decision.row)) fail(`Relation row ${decision.row} already has a saved edit`);
  return decisions;
}

async function rawNextChunk(shard, root, checkpoint) {
  if (checkpoint.completed_chunks.length === checkpoint.chunk_total) return null;
  for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
    const chunk = String(number).padStart(3, '0');
    if (checkpoint.completed_chunks.includes(chunk)) continue;
    const file = path.join(chunkFiles(shard, root), `chunk-${chunk}.json`);
    let view;
    try { view = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { fail(`Stage 3 chunk ${chunk} is unavailable or invalid: ${error.message}`); }
    if (view.chunk !== chunk || !Array.isArray(view.senses)) fail(`Stage 3 chunk ${chunk} does not match its name`);
    return view;
  }
  return null;
}

async function saveChunk(shard, inputPath, root = REPOSITORY_DIRECTORY) {
  const checkpoint = await loadCheckpoint(shard, root);
  const view = await rawNextChunk(shard, root, checkpoint);
  if (!view) fail('all Stage 3 chunks are already saved');
  const input = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
  const decisions = parseDecisionText(await readFile(input, 'utf8'), view, checkpoint);
  const completed = [...checkpoint.completed_chunks, view.chunk].sort();
  const next = { ...checkpoint, completed_chunks: completed, decisions: [...checkpoint.decisions, ...decisions] };
  await writeJsonAtomically(CHECKPOINT_PATH(shard, root), next);
  return { shard, chunk: view.chunk, completed_chunks: completed.length, total_chunks: next.chunk_total,
    dropped: decisions.filter((decision) => decision.action === 'drop').length,
    repaired: decisions.filter((decision) => decision.action === 'repair').length,
    kept: view.relation_count - decisions.length };
}

function relationTextDrops({ removedRows, relationRows, dropRows, canonicalRows, candidateFiles, index }) {
  const candidateLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms: candidateLemmaForms });
  const covered = existingCandidateKeys(relationRows, index);
  const decidedDrops = new Set(dropRows.map((row) => rowKey(row.source_sense_id, row.candidate)));
  const additions = new Map();
  for (const row of removedRows) {
    if (!('text' in row)) continue;
    const candidate = normalizeCandidate(row.text);
    const key = rowKey(row.source_sense_id, candidate);
    if (!merged.get(row.source_sense_id)?.candidates.has(candidate) || covered.has(key) || decidedDrops.has(key)) continue;
    const source = index.senses.get(row.source_sense_id);
    if (!source || source.record.id !== row.source_record_id) continue;
    additions.set(key, { source_record_id: row.source_record_id, source_sense_id: row.source_sense_id,
      candidate, reason: 'edit' });
  }
  return [...additions.values()];
}

async function writeFilesAtomically(changes) {
  const token = randomUUID();
  const staged = [];
  const backups = [];
  const installed = [];
  try {
    for (const change of changes) {
      await mkdir(path.dirname(change.file), { recursive: true });
      if (!change.next.exists) continue;
      const temporary = `${change.file}.${token}.tmp`;
      await writeFile(temporary, change.next.text, { encoding: 'utf8', flag: 'wx' });
      staged.push({ file: change.file, temporary });
    }
    for (const change of changes) {
      if (!change.current.exists) continue;
      const backup = `${change.file}.${token}.bak`;
      await rename(change.file, backup);
      backups.push({ file: change.file, backup });
    }
    for (const item of staged) {
      await rename(item.temporary, item.file);
      installed.push(item.file);
    }
  } catch (error) {
    for (const file of installed) await rm(file, { force: true });
    for (const item of backups.reverse()) {
      try { await rename(item.backup, item.file); } catch { /* preserve the original error; the backup remains recoverable */ }
    }
    throw error;
  } finally {
    for (const item of staged) await rm(item.temporary, { force: true });
  }
  await Promise.all(backups.map((item) => rm(item.backup, { force: true })));
}

async function applyEdits(shard, root = REPOSITORY_DIRECTORY) {
  const checkpoint = await loadCheckpoint(shard, root);
  if (checkpoint.completed_chunks.length !== checkpoint.chunk_total) {
    fail(`Stage 3 has ${checkpoint.completed_chunks.length}/${checkpoint.chunk_total} completed chunks`);
  }
  const relationFile = RELATION_PATH(shard, root);
  const dropFile = DROP_PATH(shard, root);
  const [relationBase, dropBase] = [readHeadFile(root, relationFile), readHeadFile(root, dropFile)];
  const context = await loadContext(shard, root, { relationText: relationBase.text, dropText: dropBase.text });
  const relationLines = jsonlLines(relationBase.text, path.basename(relationFile));
  const dropLines = jsonlLines(dropBase.text, path.basename(dropFile));
  const beforeRelations = context.ownRelations;
  const beforeDrops = context.ownDrops;
  if (relationLines.length !== beforeRelations.length || dropLines.length !== beforeDrops.length) {
    fail('Git baseline JSONL lines do not match the parsed Stage 3 inputs');
  }

  const decisionByRow = new Map(checkpoint.decisions.map((decision) => [decision.row, decision]));
  for (const decision of checkpoint.decisions) {
    const original = beforeRelations[decision.row - 1];
    if (!original) fail(`saved decision refers to missing Relation row ${decision.row}`);
    if (decision.action === 'repair') {
      if (!('text' in original)) fail(`saved Link Repair row ${decision.row} is no longer text-only`);
      const targets = sameSpellingTargets(context.index, original.text).flatMap((record) => record.senses.map((sense) => ({
        record_id: record.record_id, sense_id: sense.sense_id,
      })));
      if (!targets.some((target) => target.record_id === decision.target_record_id && target.sense_id === decision.target_sense_id)) {
        fail(`saved Link Repair row ${decision.row} does not target an exact same-spelling Canonical sense`);
      }
    }
  }

  const dropRows = [];
  const remainingOriginalRows = beforeRelations.filter((row, index) => {
    const decision = decisionByRow.get(index + 1);
    if (decision?.action === 'drop') { dropRows.push(row); return false; }
    return decision?.action !== 'repair';
  });
  const reverseLookup = createReverseCandidateFormLookup({
    relationRows: [...context.otherRelations, ...remainingOriginalRows], dropRows: context.allDrops, index: context.index,
  });
  const repairedRows = new Map();
  for (const [index, original] of beforeRelations.entries()) {
    const decision = decisionByRow.get(index + 1);
    if (decision?.action !== 'repair') continue;
    const sourceRecord = context.index.byId.get(original.source_record_id);
    const reverseForms = reverseLookup.available(sourceRecord, decision.target_sense_id);
    const repaired = {
      source_record_id: original.source_record_id,
      source_sense_id: original.source_sense_id,
      target_record_id: decision.target_record_id,
      target_sense_id: decision.target_sense_id,
      type: original.type,
      relevance: original.relevance,
      reverse_type: original.type,
      reverse_relevance: original.relevance,
      candidate_assignment_version: 1,
      candidate_forms: [original.text],
      reverse_candidate_forms: reverseForms,
    };
    reverseLookup.addRelation(repaired);
    repairedRows.set(index + 1, repaired);
  }

  const afterOwnRows = [];
  const afterRelationLines = [];
  for (const [index, original] of beforeRelations.entries()) {
    const rowNumber = index + 1;
    const decision = decisionByRow.get(rowNumber);
    if (decision?.action === 'drop') continue;
    if (decision?.action === 'repair') {
      const repaired = repairedRows.get(rowNumber);
      afterOwnRows.push(repaired);
      afterRelationLines.push(serializeRelationJsonl([repaired]).trimEnd());
    } else {
      afterOwnRows.push(original);
      afterRelationLines.push(relationLines[index]);
    }
  }

  const afterAllRelations = [...context.otherRelations, ...afterOwnRows];
  const idDrops = orphanedCandidateDrops({ canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles,
    scopeRows: context.canonicalRows, removedRelationRows: dropRows, relationRows: afterAllRelations,
    dropRows: context.allDrops, index: context.index });
  const afterAllDrops = [...context.allDrops, ...idDrops];
  const textDrops = relationTextDrops({ removedRows: dropRows, relationRows: afterAllRelations,
    dropRows: afterAllDrops, canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles, index: context.index });
  const newDropsByKey = new Map();
  for (const row of [...idDrops, ...textDrops]) newDropsByKey.set(rowKey(row.source_sense_id, row.candidate), row);
  const newDrops = [...newDropsByKey.values()];
  const afterOwnDrops = [...beforeDrops, ...newDrops];
  validateRelationRows({ relationRows: afterOwnRows, dropRows: afterOwnDrops, index: context.index,
    shardSenseIds: context.shardSenseIds, otherRelationRows: context.otherRelations });
  verifyAccounting({ canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles,
    relationRows: afterOwnRows, dropRows: afterOwnDrops, otherRelationRows: context.otherRelations, index: context.index });

  const afterDropLines = [...dropLines, ...newDrops.map((row) => serializeDropJsonl([row]).trimEnd())];
  const relationNext = { exists: relationBase.exists || afterRelationLines.length > 0,
    text: afterRelationLines.length ? `${afterRelationLines.join('\n')}\n` : '' };
  const dropNext = { exists: dropBase.exists || afterDropLines.length > 0,
    text: afterDropLines.length ? `${afterDropLines.join('\n')}\n` : '' };
  const relationCurrent = await readOptional(relationFile);
  const dropCurrent = await readOptional(dropFile);
  const currentIsDesired = sameFileState(relationCurrent, relationNext) && sameFileState(dropCurrent, dropNext);
  if (currentIsDesired) return { shard, status: 'already-applied', removed: dropRows.length,
    repaired: repairedRows.size, edit_drops_added: newDrops.length };
  const currentIsBase = sameFileState(relationCurrent, relationBase) && sameFileState(dropCurrent, dropBase);
  if (!currentIsBase) fail(`shard ${shard} Relation/Drop files changed from both the Git baseline and this apply result; no files were written`);
  if (!sameFileState(relationNext, relationBase) || !sameFileState(dropNext, dropBase)) {
    await writeFilesAtomically([
      { file: relationFile, current: relationCurrent, next: relationNext },
      { file: dropFile, current: dropCurrent, next: dropNext },
    ]);
  }
  await rm(chunkFiles(shard, root), { recursive: true, force: true });
  return { shard, status: 'applied', removed: dropRows.length, repaired: repairedRows.size,
    edit_drops_added: newDrops.length, relation_count: afterOwnRows.length, drop_count: afterOwnDrops.length };
}

async function parseDiffRows(root, shard) {
  const relationRelative = `data/relations/relation-${shard}.jsonl`;
  const dropRelative = `data/relation-drops/drop-${shard}.jsonl`;
  const output = { removedRelations: [], addedRelations: [], addedDrops: [] };
  const diff = git(root, ['diff', '--no-ext-diff', '--no-renames', '--unified=0', 'HEAD', '--', relationRelative, dropRelative]);
  let current = null;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      current = match?.[2] ?? null;
      continue;
    }
    if (!current || (!line.startsWith('+') && !line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) continue;
    const raw = line.slice(1);
    if (!raw.trim()) continue;
    if (current === relationRelative) {
      const row = parseRelationJsonl(`${raw}\n`, relationRelative)[0];
      if (line.startsWith('-')) output.removedRelations.push(row);
      else output.addedRelations.push(row);
    } else if (current === dropRelative && line.startsWith('+')) {
      output.addedDrops.push(parseDropJsonl(`${raw}\n`, dropRelative)[0]);
    }
  }
  for (const [relative, key] of [[relationRelative, 'addedRelations'], [dropRelative, 'addedDrops']]) {
    const tracked = git(root, ['ls-files', '--error-unmatch', '--', relative], { allowMissing: true });
    if (tracked !== null) continue;
    const state = await readOptional(path.join(root, relative));
    if (!state.exists) continue;
    const rows = relative === relationRelative
      ? parseRelationJsonl(state.text, relative)
      : parseDropJsonl(state.text, relative);
    output[key].push(...rows);
  }
  return output;
}

function describeSense(index, recordId, senseId) {
  const record = index.byId.get(recordId);
  const sense = index.senses.get(senseId);
  if (!record || !sense || sense.record.id !== recordId) fail(`report cannot resolve Canonical sense ${senseId} on ${recordId}`);
  return { record_id: recordId, lemma: record.lemma, sense_id: senseId, pos: sense.sense.pos, gloss: sense.sense.gloss };
}

function describeRelation(index, row) {
  const description = {
    source: describeSense(index, row.source_record_id, row.source_sense_id),
    type: row.type,
    tier: row.relevance,
  };
  if ('text' in row) description.text = row.text;
  else description.target = describeSense(index, row.target_record_id, row.target_sense_id);
  return description;
}

async function reportEdits(shard, root = REPOSITORY_DIRECTORY) {
  assertShard(shard);
  gitHead(root);
  const diff = await parseDiffRows(root, shard);
  const { index } = await loadShard(shard, root);
  const unmatched = [...diff.addedRelations];
  const deletions = [];
  const repairs = [];
  for (const original of diff.removedRelations) {
    if ('text' in original) {
      const position = unmatched.findIndex((row) => !('text' in row)
        && row.source_record_id === original.source_record_id
        && row.source_sense_id === original.source_sense_id
        && row.type === original.type && row.relevance === original.relevance
        && row.candidate_forms?.length === 1 && row.candidate_forms[0] === original.text);
      if (position >= 0) {
        const [repaired] = unmatched.splice(position, 1);
        repairs.push({
          source: describeSense(index, original.source_record_id, original.source_sense_id),
          before: { text: original.text, type: original.type, tier: original.relevance },
          after: { target: describeSense(index, repaired.target_record_id, repaired.target_sense_id),
            type: repaired.type, tier: repaired.relevance },
        });
        continue;
      }
    }
    deletions.push(describeRelation(index, original));
  }
  return {
    shard,
    deleted_relations: deletions,
    link_repairs: repairs,
    added_relations: unmatched.map((row) => describeRelation(index, row)),
    added_drops: diff.addedDrops.map((row) => ({
      source: describeSense(index, row.source_record_id, row.source_sense_id),
      candidate: row.candidate,
      reason: row.reason,
    })),
  };
}

const USAGE = `Usage:
  node scripts/relation/edit-cli.mjs prepare --shard SSS
  node scripts/relation/edit-cli.mjs read-chunk --shard SSS [--out <file>]
  node scripts/relation/edit-cli.mjs save-chunk --shard SSS --in <decisions.txt>
  node scripts/relation/edit-cli.mjs apply --shard SSS
  node scripts/relation/edit-cli.mjs report --shard SSS [--out <file>]`;

function parseArgs(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (!['prepare', 'read-chunk', 'save-chunk', 'apply', 'report'].includes(command)) fail(USAGE);
  const options = { command, shard: null, input: null, output: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--shard', '--in', '--out'].includes(flag) || !value || value.startsWith('--')) fail(`invalid arguments\n${USAGE}`);
    index += 1;
    const key = flag === '--shard' ? 'shard' : flag === '--in' ? 'input' : 'output';
    if (options[key] !== null) fail(`${flag} may be supplied only once`);
    options[key] = value;
  }
  assertShard(options.shard);
  if (command === 'save-chunk' && !options.input) fail(`save-chunk requires --in\n${USAGE}`);
  if (command !== 'save-chunk' && options.input) fail(`--in is only valid for save-chunk\n${USAGE}`);
  if (!['read-chunk', 'report'].includes(command) && options.output) fail(`--out is only valid for read-chunk/report\n${USAGE}`);
  return options;
}

async function writeOutput(file, text, root) {
  const destination = path.isAbsolute(file) ? file : path.resolve(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text, 'utf8');
}

export async function run(argv, { root = REPOSITORY_DIRECTORY } = {}) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    console.log(USAGE);
    return { usage: USAGE };
  }
  let result;
  if (options.command === 'prepare') result = await prepare(options.shard, root);
  else if (options.command === 'read-chunk') result = await readNextChunk(options.shard, root);
  else if (options.command === 'save-chunk') result = await saveChunk(options.shard, options.input, root);
  else if (options.command === 'apply') result = await applyEdits(options.shard, root);
  else result = await reportEdits(options.shard, root);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeOutput(options.output, serialized, root);
  else process.stdout.write(serialized);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}

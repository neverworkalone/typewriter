/**
 * Refinement Engine core (#6555): the shard-owned editing flow shared by every refinement Stage (S3 onward).
 *
 * A refinement Stage audits already-approved Relations of one shard. Its rule module (`rules/<stage>.mjs`) owns what
 * the editor may decide: the chunk view, the decision grammar, how decisions change rows, and how a Git diff maps back
 * to decisions. This core owns everything else — the projected shard context, Sense-group chunking, prepared views and
 * their digests, the compact checkpoint, the atomic two-file apply, orphan `z` Drop accounting, the existing row
 * validators, and the `decisions`/`amend` path that recomputes a whole PR from its base commit.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertShard,
  assertStage2Part,
  existingCandidateKeys,
  loadAllApprovedDrops,
  loadApprovedRelations,
  loadOptionalDropJsonl,
  loadOptionalRelationJsonl,
  loadShard,
  loadShardTouchingRelations,
  mergeCandidates,
  normalizeCandidate,
  orphanedCandidateDrops,
  partScope,
  shardSenseIds as senseIdsOf,
  validateRelationRows,
  verifyAccounting,
} from '../admission.mjs';
import { parseDropJsonl, parseRelationJsonl, serializeDropJsonl } from '../persisted-jsonl.mjs';

export const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RELATION_RELATIVE = (shard) => `data/relations/relation-${shard}.jsonl`;
export const DROP_RELATIVE = (shard) => `data/relation-drops/drop-${shard}.jsonl`;
export const RELATION_PATH = (shard, root) => path.join(root, RELATION_RELATIVE(shard));
export const DROP_PATH = (shard, root) => path.join(root, DROP_RELATIVE(shard));
const MIN_CHUNK_RELATIONS = 350;
const MAX_CHUNK_RELATIONS = 500;

const compactRows = (contents) => contents.split(/\r?\n/u).filter((line) => line.trim() !== '');
export const rowKey = (senseId, candidate) => `${senseId}\u0000${normalizeCandidate(candidate)}`;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function fail(message) {
  throw new Error(message);
}

export function jsonlLines(contents, file) {
  const lines = compactRows(contents);
  for (const [index, line] of lines.entries()) {
    try { JSON.parse(line); } catch (error) { fail(`${file}:${index + 1} is not valid JSON: ${error.message}`); }
  }
  return lines;
}

export function git(root, args, { allowMissing = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing) return null;
    fail(`git ${args.join(' ')} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export function gitHead(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) fail('repository HEAD is unavailable');
  return head;
}

export async function readOptional(file) {
  try { return { exists: true, text: await readFile(file, 'utf8') }; }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

/** A tracked file at a commit (`HEAD` or a full SHA); a path absent from that tree is `{ exists: false }`. */
export function readRevisionFile(root, revision, file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (path.isAbsolute(relative) || relative.startsWith('../')) fail(`file is outside repository: ${file}`);
  const listed = git(root, ['ls-tree', '--name-only', revision, '--', relative]);
  if (!listed.trim()) return { exists: false, text: '' };
  return { exists: true, text: git(root, ['show', `${revision}:${relative}`]) };
}

export const readHeadFile = (root, file) => readRevisionFile(root, 'HEAD', file);

export function sameFileState(left, right) {
  return left.exists === right.exists && left.text === right.text;
}

export function idSensePairKey(sourceSenseId, targetSenseId) {
  return sourceSenseId < targetSenseId
    ? `${sourceSenseId}\u0000${targetSenseId}`
    : `${targetSenseId}\u0000${sourceSenseId}`;
}

export async function writeJsonAtomically(file, value) {
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

export async function writeFilesAtomically(changes) {
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

/** Partition by complete source Sense groups, targeting 350–500 Relation rows. */
export function chunkSenseGroups(groups, { minimum = MIN_CHUNK_RELATIONS, maximum = MAX_CHUNK_RELATIONS, label = 'Stage 3' } = {}) {
  if (!Array.isArray(groups) || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
      || minimum < 1 || maximum < minimum) fail(`invalid ${label} chunk inputs`);
  const chunks = [];
  let current = [];
  let count = 0;
  for (const group of groups) {
    if (!group || !Array.isArray(group.relations) || group.relations.length === 0) fail(`${label} chunks require non-empty complete Sense groups`);
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

function buildSenseGroups({ canonicalRows, relationRows, scopeSenseIds = null, rowFilter = null }) {
  const bySense = new Map();
  relationRows.forEach((row, index) => {
    if (scopeSenseIds && !scopeSenseIds.has(row.source_sense_id)) return;
    if (rowFilter && !rowFilter(row)) return;
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

/** The prepared view without its hidden `_`-prefixed row bindings: what an editor sees. */
export function stripInternalRow(chunk) {
  return { ...chunk, senses: chunk.senses.map((sense) => ({
    ...sense,
    relations: sense.relations.map((relation) => Object.fromEntries(Object.entries(relation)
      .filter(([key]) => !key.startsWith('_')))),
  })) };
}

// Digest of the prepared raw view (JSON.stringify, including hidden `_row` bindings), not the file bytes.
export function viewDigest(rawView) {
  return createHash('sha256').update(JSON.stringify(rawView), 'utf8').digest('hex');
}

function assertChunkName(chunk) {
  if (!/^\d{3}$/u.test(chunk ?? '')) fail('--chunk must be a three-digit chunk number such as 001');
}

/** Orphan candidate `z` Drops for removed rows: ID rows through the shared accounting, text rows by their own key. */
function relationTextDrops({ removedRows, relationRows, dropRows, canonicalRows, candidateFiles, index, candidateMerge = null }) {
  const candidateLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const candidates = candidateMerge ?? mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms: candidateLemmaForms });
  const { merged } = candidates;
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
      candidate, reason: 'z' });
  }
  return [...additions.values()];
}

// Differential tests run the CLI with every other-shard row (the path before the #6555 projection) as the reference.
const referenceRun = new AsyncLocalStorage();

/**
 * Build the command set of one refinement Stage from its rule module. The returned `run(argv, { root })` is the
 * Stage's CLI; every message names the rule's `label` and every scratch path its `scratch` prefix.
 */
export function createRefineCli(rule) {
  const { label } = rule;
  const scopeName = (shard, scope) => scope ? `${shard}-${scope.batch}-${scope.part}` : shard;
  const VIEW_DIRECTORY = (shard, root, scope = null) => path.join(root, '.warroom-scratch', `${rule.scratch}-${scopeName(shard, scope)}`);
  const CHECKPOINT_PATH = (shard, root, scope = null) => path.join(root, '.warroom-scratch', `${rule.scratch}-${scopeName(shard, scope)}.json`);
  const chunkFiles = (shard, root, scope = null) => VIEW_DIRECTORY(shard, root, scope);
  const chunkFile = (shard, chunk, root, scope = null) => path.join(chunkFiles(shard, root, scope), `chunk-${chunk}.json`);

  function readCheckpointText(text, shard, scope = null) {
    let checkpoint;
    try { checkpoint = JSON.parse(text); } catch (error) { fail(`${label} checkpoint is not valid JSON: ${error.message}`); }
    const expectedKeys = scope ? 'chunk_total,completed_chunks,decisions,scope,shard,version' : 'chunk_total,completed_chunks,decisions,shard,version';
    if (!checkpoint || Array.isArray(checkpoint) || typeof checkpoint !== 'object'
        || Object.keys(checkpoint).sort().join(',') !== expectedKeys
        || checkpoint.version !== 1 || checkpoint.shard !== shard
        || (scope && (checkpoint.scope?.batch !== scope.batch || checkpoint.scope?.part !== scope.part
          || Object.keys(checkpoint.scope).sort().join(',') !== 'batch,part'))
        || !Number.isSafeInteger(checkpoint.chunk_total) || checkpoint.chunk_total < 0
        || !Array.isArray(checkpoint.completed_chunks) || !Array.isArray(checkpoint.decisions)) {
      fail(`${label} checkpoint does not match shard ${shard} or the compact v1 contract`);
    }
    const completed = new Set();
    for (const number of checkpoint.completed_chunks) {
      if (typeof number !== 'string' || !/^\d{3}$/u.test(number) || completed.has(number)
          || Number(number) < 1 || Number(number) > checkpoint.chunk_total) fail(`${label} checkpoint has an invalid completed chunk list`);
      completed.add(number);
    }
    const rows = new Set();
    for (const decision of checkpoint.decisions) {
      if (!decision || Array.isArray(decision) || typeof decision !== 'object') fail(`${label} checkpoint has an invalid decision`);
      rule.assertDecisionShape(decision);
      if (typeof decision.chunk !== 'string' || !/^\d{3}$/u.test(decision.chunk)
          || Number(decision.chunk) < 1 || Number(decision.chunk) > checkpoint.chunk_total
          || !completed.has(decision.chunk)) fail(`${label} decision refers to an incomplete or unknown chunk`);
      if (!Number.isSafeInteger(decision.row) || decision.row < 1 || rows.has(decision.row)) fail(`${label} checkpoint repeats or misnumbers a Relation row`);
      rows.add(decision.row);
    }
    return checkpoint;
  }

  async function loadCheckpoint(shard, root, scope = null) {
    const state = await readOptional(CHECKPOINT_PATH(shard, root, scope));
    if (!state.exists) fail(`${label} is not prepared for shard ${shard}; run prepare first`);
    return readCheckpointText(state.text, shard, scope);
  }

  async function loadContext(shard, root, { relationText, dropText } = {}) {
    const loaded = await loadShard(shard, root);
    if (loaded.inventory.missing.length) {
      fail(`${label} requires complete Stage 1 inputs; missing ${loaded.inventory.missing.join(', ')}`);
    }
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const [ownRelations, ownDrops] = await Promise.all([
      relationText === undefined ? loadOptionalRelationJsonl(relationFile) : parseRelationJsonl(relationText, path.basename(relationFile)),
      dropText === undefined ? loadOptionalDropJsonl(dropFile) : parseDropJsonl(dropText, path.basename(dropFile)),
    ]);
    const shardSenseIds = senseIdsOf(loaded.canonicalRows);
    // #6555: every consumer (ID pair conflicts, reverse candidate forms, orphan and text Drops, row validation and
    // accounting) looks other-shard rows up only by a key whose Sense belongs to this shard, so only Relations touching
    // a shard Sense can change a result. Drops are looked up only by a source Sense of this shard, and other files' Drops
    // with such a source are excluded on both paths, so no other-file Drop can either. `fullOtherRows` is the full path.
    const full = referenceRun.getStore() === true;
    const [otherRelations, otherDrops] = full
      ? await Promise.all([
        loadApprovedRelations(root, { exceptShard: shard }),
        loadAllApprovedDrops(root).then((rows) => rows.filter((row) => !shardSenseIds.has(row.source_sense_id))),
      ])
      : [await loadShardTouchingRelations(root, { exceptShard: shard, senseIds: shardSenseIds }), []];
    const candidateMerge = mergeCandidates(loaded.canonicalRows, loaded.candidateFiles, {
      canonicalLemmaForms: new Set([...loaded.index.byLemma.keys()].map(normalizeCandidate)),
    });
    // Callers may validate a Git baseline while the working tree already contains a prior apply result.
    // Keep the selected shard's drop set bound to that same baseline for repeatable apply calculations.
    const scopedAllDrops = [...otherDrops, ...ownDrops];
    validateRelationRows({ relationRows: ownRelations, dropRows: ownDrops, index: loaded.index, shardSenseIds,
      otherRelationRows: otherRelations });
    verifyAccounting({ canonicalRows: loaded.canonicalRows, candidateFiles: loaded.candidateFiles,
      relationRows: ownRelations, dropRows: ownDrops, otherRelationRows: otherRelations, index: loaded.index, candidateMerge });
    return { ...loaded, candidateMerge, ownRelations, ownDrops, otherRelations, allDrops: scopedAllDrops, otherDrops, shardSenseIds };
  }

  function assertCleanInputs(root, what) {
    const inputStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--',
      'data/canonical', 'data/relation-candidates', 'data/relations', 'data/relation-drops']);
    if (inputStatus.trim()) fail(`${label} ${what} requires clean Canonical, Candidate, Relation, and Drop inputs`);
  }

  async function renderPreparedViews(shard, root, scope = null) {
    gitHead(root);
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const [relationState, dropState] = await Promise.all([readOptional(relationFile), readOptional(dropFile)]);
    const relationBase = readHeadFile(root, relationFile);
    const dropBase = readHeadFile(root, dropFile);
    if (!sameFileState(relationState, relationBase) || !sameFileState(dropState, dropBase)) {
      fail(`${label} prepare requires clean shard ${shard} Relation/Drop files so decisions bind to the Git baseline`);
    }
    assertCleanInputs(root, 'view refresh');
    const context = await loadContext(shard, root, { relationText: relationBase.text, dropText: dropBase.text });
    const scopeRows = scope
      ? partScope(context.canonicalRows, context.candidateFiles, scope.batch, scope.part, shard).scopeRows
      : context.canonicalRows;
    const scopeSenseIds = scope ? new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id))) : null;
    const groups = buildSenseGroups({ canonicalRows: context.canonicalRows, relationRows: context.ownRelations,
      scopeSenseIds, rowFilter: scope ? rule.scopedRow : null });
    const chunks = chunkSenseGroups(groups, { label });
    const views = chunks.map((chunkGroups, index) => rule.renderChunk(chunkGroups, context.index, index + 1, chunks.length));
    return { context, views, scope_record_count: scopeRows.length };
  }

  async function prepare(shard, root, scope = null) {
    assertShard(shard);
    const checkpointPath = CHECKPOINT_PATH(shard, root, scope);
    if (existsSync(checkpointPath)) {
      const checkpoint = await loadCheckpoint(shard, root, scope);
      return { shard, ...(scope ? { batch: scope.batch, part: scope.part } : {}),
        chunk_count: checkpoint.chunk_total, completed_chunks: checkpoint.completed_chunks.length, resumed: true };
    }
    const { views, scope_record_count } = await renderPreparedViews(shard, root, scope);
    const directory = chunkFiles(shard, root, scope);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    for (const view of views) {
      // The view is derived scratch input; the checkpoint stores only chunk completion and edit decisions.
      await writeFile(path.join(directory, `chunk-${view.chunk}.json`), `${JSON.stringify(view)}\n`, 'utf8');
    }
    const checkpoint = { version: 1, shard, ...(scope ? { scope: { batch: scope.batch, part: scope.part } } : {}),
      chunk_total: views.length, completed_chunks: [], decisions: [] };
    await writeJsonAtomically(checkpointPath, checkpoint);
    return { shard, ...(scope ? { batch: scope.batch, part: scope.part, source_record_count: scope_record_count } : {}),
      chunk_count: views.length, relation_count: views.reduce((sum, view) => sum + view.relation_count, 0), resumed: false };
  }

  async function readRawPreparedView(shard, chunk, root, scope = null) {
    let view;
    try { view = JSON.parse(await readFile(chunkFile(shard, chunk, root, scope), 'utf8')); }
    catch (error) { fail(`${label} prepared chunk ${chunk} is unavailable or invalid: ${error.message}`); }
    if (!view || view.chunk !== chunk || !Array.isArray(view.senses)) fail(`${label} prepared chunk ${chunk} does not match its name`);
    return view;
  }

  async function refreshPendingChunks(shard, root, scope = null) {
    const checkpoint = await loadCheckpoint(shard, root, scope);
    const { views } = await renderPreparedViews(shard, root, scope);
    if (views.length !== checkpoint.chunk_total) {
      fail(`${label} refresh changed shard ${shard} chunk count; completed decisions cannot be rebound safely`);
    }
    const completed = new Set(checkpoint.completed_chunks);
    const prepared = [];
    for (const fresh of views) {
      const previous = await readRawPreparedView(shard, fresh.chunk, root, scope);
      const same = JSON.stringify(previous) === JSON.stringify(fresh);
      if (completed.has(fresh.chunk) && !same) {
        fail(`${label} completed chunk ${fresh.chunk} inputs changed after save; checkpoint is preserved`);
      }
      prepared.push({ fresh, previous, same, isCompleted: completed.has(fresh.chunk) });
    }
    const pending = prepared.filter((entry) => !entry.isCompleted);
    for (const entry of pending) {
      if (!entry.same) await writeJsonAtomically(chunkFile(shard, entry.fresh.chunk, root, scope), entry.fresh);
    }
    const active = pending[0];
    return {
      shard,
      ...(scope ? { batch: scope.batch, part: scope.part } : {}),
      chunk_count: views.length,
      current_chunk: active?.fresh.chunk ?? null,
      active_changed: Boolean(active && !active.same),
      pending_view_sha256: Object.fromEntries(pending.map((entry) => [entry.fresh.chunk, viewDigest(entry.fresh)])),
      current_view: active ? stripInternalRow(active.fresh) : null,
      prompt_view: active ? rule.renderPromptView(stripInternalRow(active.fresh)) : null,
    };
  }

  async function readNextChunk(shard, root, scope = null) {
    const checkpoint = await loadCheckpoint(shard, root, scope);
    if (checkpoint.completed_chunks.length === checkpoint.chunk_total) return { shard, complete: true, remaining_chunks: 0 };
    for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
      const chunk = String(number).padStart(3, '0');
      if (checkpoint.completed_chunks.includes(chunk)) continue;
      const data = await readFile(chunkFile(shard, chunk, root, scope), 'utf8');
      let view;
      try { view = JSON.parse(data); } catch (error) { fail(`${label} chunk ${chunk} is invalid JSON: ${error.message}`); }
      const stripped = stripInternalRow(view);
      return { ...stripped, prompt_view: rule.renderPromptView(stripped) };
    }
    return { shard, complete: true, remaining_chunks: 0 };
  }

  function assertChunkInRange(chunk, checkpoint) {
    if (Number(chunk) < 1 || Number(chunk) > checkpoint.chunk_total) fail(`${label} chunk ${chunk} is outside 001..${String(checkpoint.chunk_total).padStart(3, '0')}`);
  }

  async function readChunkByNumber(shard, chunk, root) {
    assertChunkName(chunk);
    const checkpoint = await loadCheckpoint(shard, root);
    assertChunkInRange(chunk, checkpoint);
    const raw = await readRawPreparedView(shard, chunk, root);
    const stripped = stripInternalRow(raw);
    return { ...stripped, prompt_view: rule.renderPromptView(stripped), view_sha256: viewDigest(raw),
      completed: checkpoint.completed_chunks.includes(chunk) };
  }

  async function rawNextChunk(shard, root, checkpoint, scope = null) {
    if (checkpoint.completed_chunks.length === checkpoint.chunk_total) return null;
    for (let number = 1; number <= checkpoint.chunk_total; number += 1) {
      const chunk = String(number).padStart(3, '0');
      if (checkpoint.completed_chunks.includes(chunk)) continue;
      let view;
      try { view = JSON.parse(await readFile(chunkFile(shard, chunk, root, scope), 'utf8')); }
      catch (error) { fail(`${label} chunk ${chunk} is unavailable or invalid: ${error.message}`); }
      if (view.chunk !== chunk || !Array.isArray(view.senses)) fail(`${label} chunk ${chunk} does not match its name`);
      return view;
    }
    return null;
  }

  const decisionKey = (decision) => JSON.stringify(rule.decisionIdentity(decision));

  async function saveChunkByNumber(shard, chunk, inputPath, expectedSha256, root) {
    assertChunkName(chunk);
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? '')) fail('--expect-view-sha256 must be a 64-character lowercase SHA-256');
    const checkpoint = await loadCheckpoint(shard, root);
    assertChunkInRange(chunk, checkpoint);
    const view = await readRawPreparedView(shard, chunk, root);
    if (viewDigest(view) !== expectedSha256) fail(`${label} chunk ${chunk} view changed since it was launched`);
    const input = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const decisions = rule.parseDecisionText(await readFile(input, 'utf8'), view, checkpoint, { explicit: true });
    const base = { shard, chunk, total_chunks: checkpoint.chunk_total };
    if (checkpoint.completed_chunks.includes(chunk)) {
      const saved = checkpoint.decisions.filter((decision) => decision.chunk === chunk);
      const savedKeys = new Set(saved.map(decisionKey));
      const same = saved.length === decisions.length && savedKeys.size === saved.length
        && decisions.every((decision) => savedKeys.has(decisionKey(decision)));
      if (!same) fail(`${label} chunk ${chunk} is already saved with different decisions`);
      return { ...base, already_saved: true, completed_chunks: checkpoint.completed_chunks.length };
    }
    const completed = [...checkpoint.completed_chunks, chunk].sort();
    const merged = [...checkpoint.decisions, ...decisions].sort((a, b) => a.row - b.row);
    await writeJsonAtomically(CHECKPOINT_PATH(shard, root), { ...checkpoint, completed_chunks: completed, decisions: merged });
    return { ...base, already_saved: false, completed_chunks: completed.length, ...rule.saveSummary(decisions, view) };
  }

  async function saveChunk(shard, inputPath, root, scope = null) {
    const checkpoint = await loadCheckpoint(shard, root, scope);
    const view = await rawNextChunk(shard, root, checkpoint, scope);
    if (!view) fail(`all ${label} chunks are already saved`);
    const input = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const decisions = rule.parseDecisionText(await readFile(input, 'utf8'), view, checkpoint);
    const completed = [...checkpoint.completed_chunks, view.chunk].sort();
    const next = { ...checkpoint, completed_chunks: completed, decisions: [...checkpoint.decisions, ...decisions] };
    await writeJsonAtomically(CHECKPOINT_PATH(shard, root, scope), next);
    return { shard, ...(scope ? { batch: scope.batch, part: scope.part } : {}), chunk: view.chunk, completed_chunks: completed.length, total_chunks: next.chunk_total,
      ...rule.saveSummary(decisions, view) };
  }

  /**
   * Apply `decisions` (each bound to a 1-based row of the baseline Relation file) to the baseline Relation/Drop text:
   * the rule changes rows, then the shared accounting appends orphan `z` Drops and the existing validators check the
   * result. Pure: nothing is written, so `apply` and `amend` reach identical bytes from identical inputs.
   */
  async function computeEdits(shard, root, relationBase, dropBase, decisions, scope = null) {
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const context = await loadContext(shard, root, { relationText: relationBase.text, dropText: dropBase.text });
    const relationLines = jsonlLines(relationBase.text, path.basename(relationFile));
    const dropLines = jsonlLines(dropBase.text, path.basename(dropFile));
    const beforeRelations = context.ownRelations;
    const beforeDrops = context.ownDrops;
    const scopedSenseIds = scope
      ? new Set(partScope(context.canonicalRows, context.candidateFiles, scope.batch, scope.part, shard)
        .scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)))
      : null;
    if (relationLines.length !== beforeRelations.length || dropLines.length !== beforeDrops.length) {
      fail(`Git baseline JSONL lines do not match the parsed ${label} inputs`);
    }
    for (const decision of decisions) {
      const original = beforeRelations[decision.row - 1];
      if (!original) fail(`saved decision refers to missing Relation row ${decision.row}`);
      rule.checkDecision({ decision, original, scope, scopedSenseIds, context });
    }
    const { removedRows, afterOwnRows, afterRelationLines, summary } = rule.transform({
      context, beforeRelations, relationLines, decisions });

    const afterAllRelations = [...context.otherRelations, ...afterOwnRows];
    const idDrops = orphanedCandidateDrops({ canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles,
      scopeRows: context.canonicalRows, removedRelationRows: removedRows, relationRows: afterAllRelations,
      dropRows: context.allDrops, index: context.index, candidateMerge: context.candidateMerge });
    const afterAllDrops = [...context.allDrops, ...idDrops];
    const textDrops = relationTextDrops({ removedRows, relationRows: afterAllRelations,
      dropRows: afterAllDrops, canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles, index: context.index,
      candidateMerge: context.candidateMerge });
    const newDropsByKey = new Map();
    for (const row of [...idDrops, ...textDrops]) newDropsByKey.set(rowKey(row.source_sense_id, row.candidate), row);
    const newDrops = [...newDropsByKey.values()];
    const afterOwnDrops = [...beforeDrops, ...newDrops];
    validateRelationRows({ relationRows: afterOwnRows, dropRows: afterOwnDrops, index: context.index,
      shardSenseIds: context.shardSenseIds, otherRelationRows: context.otherRelations });
    verifyAccounting({ canonicalRows: context.canonicalRows, candidateFiles: context.candidateFiles,
      relationRows: afterOwnRows, dropRows: afterOwnDrops, otherRelationRows: context.otherRelations, index: context.index,
      candidateMerge: context.candidateMerge });

    const afterDropLines = [...dropLines, ...newDrops.map((row) => serializeDropJsonl([row]).trimEnd())];
    const relationNext = { exists: relationBase.exists || afterRelationLines.length > 0,
      text: afterRelationLines.length ? `${afterRelationLines.join('\n')}\n` : '' };
    const dropNext = { exists: dropBase.exists || afterDropLines.length > 0,
      text: afterDropLines.length ? `${afterDropLines.join('\n')}\n` : '' };
    return { context, beforeRelations, relationNext, dropNext, summary, newDrops, afterOwnRows, afterOwnDrops };
  }

  async function applyEdits(shard, root, scope = null) {
    const checkpoint = await loadCheckpoint(shard, root, scope);
    if (checkpoint.completed_chunks.length !== checkpoint.chunk_total) {
      fail(`${label} has ${checkpoint.completed_chunks.length}/${checkpoint.chunk_total} completed chunks`);
    }
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const [relationBase, dropBase] = [readHeadFile(root, relationFile), readHeadFile(root, dropFile)];
    const edits = await computeEdits(shard, root, relationBase, dropBase, checkpoint.decisions, scope);
    const { relationNext, dropNext, summary, newDrops } = edits;
    const scoped = scope ? { batch: scope.batch, part: scope.part } : {};
    const relationCurrent = await readOptional(relationFile);
    const dropCurrent = await readOptional(dropFile);
    if (sameFileState(relationCurrent, relationNext) && sameFileState(dropCurrent, dropNext)) {
      await rm(chunkFiles(shard, root, scope), { recursive: true, force: true });
      await rm(CHECKPOINT_PATH(shard, root, scope), { force: true });
      return { shard, ...scoped, status: 'already-applied', ...summary, edit_drops_added: newDrops.length };
    }
    const currentIsBase = sameFileState(relationCurrent, relationBase) && sameFileState(dropCurrent, dropBase);
    if (!currentIsBase) fail(`shard ${shard} Relation/Drop files changed from both the Git baseline and this apply result; no files were written`);
    await rule.validatePreparedDecisions({ decisions: checkpoint.decisions, currentRelations: edits.beforeRelations,
      index: edits.context.index, readView: (chunk) => readFile(chunkFile(shard, chunk, root, scope), 'utf8') });
    if (!sameFileState(relationNext, relationBase) || !sameFileState(dropNext, dropBase)) {
      await writeFilesAtomically([
        { file: relationFile, current: relationCurrent, next: relationNext },
        { file: dropFile, current: dropCurrent, next: dropNext },
      ]);
    }
    await rm(chunkFiles(shard, root, scope), { recursive: true, force: true });
    await rm(CHECKPOINT_PATH(shard, root, scope), { force: true });
    return { shard, ...scoped, status: 'applied', ...summary, edit_drops_added: newDrops.length,
      relation_count: edits.afterOwnRows.length, drop_count: edits.afterOwnDrops.length };
  }

  async function parseDiffRows(root, shard) {
    const relationRelative = RELATION_RELATIVE(shard);
    const dropRelative = DROP_RELATIVE(shard);
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

  async function reportEdits(shard, root) {
    assertShard(shard);
    gitHead(root);
    const diff = await parseDiffRows(root, shard);
    const { index } = await loadShard(shard, root);
    return { shard, ...rule.report(diff, index) };
  }

  /** Base and HEAD of a refinement PR whose commits since `base` touch only this shard's two files. */
  function prRevisions(shard, root, base) {
    if (!/^[a-f0-9]{40}$/u.test(base ?? '')) fail('--base must be a full 40-character commit SHA');
    const head = gitHead(root);
    const resolved = git(root, ['rev-parse', '--verify', `${base}^{commit}`], { allowMissing: true })?.trim();
    if (resolved !== base) fail(`base commit ${base} is not available in this repository`);
    if (git(root, ['merge-base', '--is-ancestor', base, head], { allowMissing: true }) === null) {
      fail(`base commit ${base} is not an ancestor of HEAD ${head}`);
    }
    const allowed = new Set([RELATION_RELATIVE(shard), DROP_RELATIVE(shard)]);
    const changed = git(root, ['diff', '--name-only', '--no-renames', base, head]).split('\n').filter(Boolean);
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length) fail(`${label} PR changes files outside shard ${shard} since ${base}: ${outside.join(', ')}`);
    return head;
  }

  function prState(shard, root, base) {
    const head = prRevisions(shard, root, base);
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const relationBase = readRevisionFile(root, base, relationFile);
    const dropBase = readRevisionFile(root, base, dropFile);
    const relationHead = readRevisionFile(root, head, relationFile);
    const dropHead = readRevisionFile(root, head, dropFile);
    const baseRelations = parseRelationJsonl(relationBase.text, path.basename(relationFile));
    const decisions = rule.decisionsFromDiff({
      baseRelations,
      baseLines: jsonlLines(relationBase.text, path.basename(relationFile)),
      headLines: jsonlLines(relationHead.text, path.basename(relationFile)),
      baseDropLines: jsonlLines(dropBase.text, path.basename(dropFile)),
      headDropLines: jsonlLines(dropHead.text, path.basename(dropFile)),
    });
    return { head, relationBase, dropBase, relationHead, dropHead, baseRelations, decisions };
  }

  /** The decisions a refinement PR made, recovered from its own Git diff: the PR is its own state, there is no ledger. */
  async function listDecisions(shard, root, base) {
    assertShard(shard);
    const state = prState(shard, root, base);
    const { index } = await loadShard(shard, root);
    return { shard, base, head: state.head,
      decisions: state.decisions.map((decision) => rule.describeDecision(decision, state.baseRelations, index)) };
  }

  /**
   * Change a refinement PR by its decisions: the delta updates the decisions recovered from base..HEAD, and the same
   * apply computation rebuilds both shard files from the base commit. The output is deterministic, so re-running the
   * same delta after an interruption reaches the same bytes; the receipt carries the sha256 of each file it set.
   */
  async function amendDecisions(shard, root, base, inputPath) {
    assertShard(shard);
    const state = prState(shard, root, base);
    assertCleanInputsFor(root, 'amend', shard);
    const input = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const next = rule.applyDelta(state.decisions, await readFile(input, 'utf8'), state.baseRelations);
    const edits = await computeEdits(shard, root, state.relationBase, state.dropBase, next);
    const relationFile = RELATION_PATH(shard, root);
    const dropFile = DROP_PATH(shard, root);
    const relationCurrent = await readOptional(relationFile);
    const dropCurrent = await readOptional(dropFile);
    const outputs = {
      [RELATION_RELATIVE(shard)]: edits.relationNext.exists ? sha256(edits.relationNext.text) : null,
      [DROP_RELATIVE(shard)]: edits.dropNext.exists ? sha256(edits.dropNext.text) : null,
    };
    const receipt = (status) => ({ shard, base, head: state.head, status, decisions: next.length,
      ...edits.summary, edit_drops_added: edits.newDrops.length, outputs });
    if (sameFileState(relationCurrent, edits.relationNext) && sameFileState(dropCurrent, edits.dropNext)) {
      return receipt('already-applied');
    }
    if (!sameFileState(relationCurrent, state.relationHead) || !sameFileState(dropCurrent, state.dropHead)) {
      fail(`shard ${shard} Relation/Drop files changed from both HEAD and this amend result; no files were written`);
    }
    await writeFilesAtomically([
      { file: relationFile, current: relationCurrent, next: edits.relationNext },
      { file: dropFile, current: dropCurrent, next: edits.dropNext },
    ]);
    return receipt('applied');
  }

  function assertCleanInputsFor(root, what, shard) {
    const owned = new Set([RELATION_RELATIVE(shard), DROP_RELATIVE(shard)]);
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--',
      'data/canonical', 'data/relation-candidates', 'data/relations', 'data/relation-drops']);
    const others = status.split('\n').filter(Boolean).map((line) => line.slice(3)).filter((file) => !owned.has(file));
    if (others.length) fail(`${label} ${what} requires clean Canonical, Candidate, and other-shard inputs: ${others.join(', ')}`);
  }

  const COMMANDS = ['prepare', 'read-chunk', 'refresh-pending', 'save-chunk', 'apply', 'report', 'decisions', 'amend'];

  function parseArgs(argv) {
    const command = argv[0];
    if (command === '--help' || command === '-h') return { command: 'help' };
    if (!COMMANDS.includes(command)) fail(rule.usage);
    const options = { command, shard: null, batch: null, part: null, input: null, output: null, chunk: null, expect: null, base: null };
    for (let index = 1; index < argv.length; index += 1) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!['--shard', '--batch', '--part', '--in', '--out', '--chunk', '--expect-view-sha256', '--base'].includes(flag) || !value || value.startsWith('--')) fail(`invalid arguments\n${rule.usage}`);
      index += 1;
      const key = flag === '--shard' ? 'shard' : flag === '--batch' ? 'batch' : flag === '--part' ? 'part' : flag === '--in' ? 'input'
        : flag === '--chunk' ? 'chunk' : flag === '--expect-view-sha256' ? 'expect' : flag === '--base' ? 'base' : 'output';
      if (options[key] !== null) fail(`${flag} may be supplied only once`);
      options[key] = value;
    }
    assertShard(options.shard);
    if ((options.batch === null) !== (options.part === null)) fail(`--batch and --part must be supplied together\n${rule.usage}`);
    if (options.batch !== null) {
      try { assertStage2Part(options.shard, options.batch, options.part); } catch (error) { fail(`${error.message}\n${rule.usage}`); }
    }
    if (options.batch !== null && !['prepare', 'read-chunk', 'refresh-pending', 'save-chunk', 'apply'].includes(command)) {
      fail(`--batch/--part are only valid for ${rule.scopedName} commands\n${rule.usage}`);
    }
    if (['save-chunk', 'amend'].includes(command) && !options.input) fail(`${command} requires --in\n${rule.usage}`);
    if (!['save-chunk', 'amend'].includes(command) && options.input) fail(`--in is only valid for save-chunk/amend\n${rule.usage}`);
    if (['decisions', 'amend'].includes(command) !== (options.base !== null)) fail(`--base is required by, and only valid for, decisions/amend\n${rule.usage}`);
    if (!['read-chunk', 'report', 'decisions'].includes(command) && options.output) fail(`--out is only valid for read-chunk/report/decisions\n${rule.usage}`);
    if (options.chunk !== null) {
      if (!['read-chunk', 'save-chunk'].includes(command)) fail(`--chunk is only valid for read-chunk/save-chunk\n${rule.usage}`);
      if (options.batch !== null) fail(`--chunk cannot be combined with --batch/--part\n${rule.usage}`);
    }
    if (options.expect !== null && (command !== 'save-chunk' || options.chunk === null)) fail(`--expect-view-sha256 is only valid with save-chunk --chunk\n${rule.usage}`);
    if (command === 'save-chunk' && options.chunk !== null && options.expect === null) fail(`save-chunk --chunk requires --expect-view-sha256\n${rule.usage}`);
    options.scope = options.batch === null ? null : { batch: options.batch, part: options.part };
    return options;
  }

  async function writeOutput(file, text, root) {
    const destination = path.isAbsolute(file) ? file : path.resolve(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text, 'utf8');
  }

  async function runCommand(argv, root) {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      console.log(rule.usage);
      return { usage: rule.usage };
    }
    let result;
    if (options.command === 'prepare') result = await prepare(options.shard, root, options.scope);
    else if (options.command === 'read-chunk' && options.chunk !== null) result = await readChunkByNumber(options.shard, options.chunk, root);
    else if (options.command === 'read-chunk') result = await readNextChunk(options.shard, root, options.scope);
    else if (options.command === 'refresh-pending') result = await refreshPendingChunks(options.shard, root, options.scope);
    else if (options.command === 'save-chunk' && options.chunk !== null) result = await saveChunkByNumber(options.shard, options.chunk, options.input, options.expect, root);
    else if (options.command === 'save-chunk') result = await saveChunk(options.shard, options.input, root, options.scope);
    else if (options.command === 'apply') result = await applyEdits(options.shard, root, options.scope);
    else if (options.command === 'decisions') result = await listDecisions(options.shard, root, options.base);
    else if (options.command === 'amend') result = await amendDecisions(options.shard, root, options.base, options.input);
    else result = await reportEdits(options.shard, root);
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) await writeOutput(options.output, serialized, root);
    else process.stdout.write(serialized);
    return result;
  }

  function run(argv, { root = REPOSITORY_DIRECTORY, fullOtherRows = false } = {}) {
    return referenceRun.run(fullOtherRows === true, () => runCommand(argv, root));
  }

  return { run };
}

/** Run a Stage CLI module as a script: print the error message and exit 1 on failure. */
export function runAsScript(moduleUrl, run) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl)) {
    run(process.argv.slice(2)).catch((error) => {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
  }
}

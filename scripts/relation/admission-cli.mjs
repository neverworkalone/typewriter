import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  ADMISSION_TYPES,
  approvedPeersForSense,
  assertShard,
  batchScope,
  candidateInventory,
  loadApprovedRelations,
  loadOptionalJsonl,
  loadShard,
  normalizeCandidate,
  partScope,
  prepareShard,
  sameSpellingTargets,
  shardDropPath,
  shardRelationPath,
  validateRelationRows,
  verifyAccounting,
} from './admission.mjs';

const USAGE = `usage:
  node scripts/relation/admission-cli.mjs prepare --shard 001 [--batch 01] [--out <file.json>] [--allow-partial]
  node scripts/relation/admission-cli.mjs prepare --shard 001 --batch 01 --part 01 [--checkpoint <file.json>] [--allow-partial]
  node scripts/relation/admission-cli.mjs read-chunk --checkpoint <file.json> [--max-candidates 250] [--out <file.json>]
  node scripts/relation/admission-cli.mjs save-chunk --checkpoint <file.json> --in <decisions.json>
  node scripts/relation/admission-cli.mjs merge --checkpoint <file.json>
  node scripts/relation/admission-cli.mjs verify --shard 001 [--batch 01 [--part 01]] [--checkpoint <file.json>] [--allow-partial]`;

const CHECKPOINT_VERSION = 1;
const DEFAULT_CHUNK_CANDIDATES = 250;
const CHECKPOINT_DIRECTORY = '.warroom-scratch';
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => Object.keys(value).sort().join(',');
const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;

function defaultCheckpointPath(shard, batch, part, root) {
  return path.join(root, CHECKPOINT_DIRECTORY, `relation-admission-${shard}-${batch}-${part}.json`);
}

function resolveRootPath(root, file) {
  return path.isAbsolute(file) ? file : path.resolve(root, file);
}

async function writeJsonAtomically(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, file);
}

async function writeJsonlAtomically(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const contents = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

function validateDecision(item, candidate, decision) {
  if (!isPlainObject(decision)) throw new Error(`${item.sense_id}/${candidate.text}: decision must be an object`);
  if (decision.source_sense_id !== item.sense_id || decision.candidate !== candidate.text) {
    throw new Error(`${item.sense_id}/${candidate.text}: decision must retain the exact source sense and candidate`);
  }
  if (decision.disposition === 'drop') {
    if (keysOf(decision) !== 'candidate,disposition,reason,source_sense_id') throw new Error(`${item.sense_id}/${candidate.text}: Drop decision has unexpected or missing fields`);
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) throw new Error(`${item.sense_id}/${candidate.text}: Drop needs a reason`);
    return;
  }
  if (decision.disposition !== 'relation') throw new Error(`${item.sense_id}/${candidate.text}: disposition must be relation or drop`);
  if (!ADMISSION_TYPES.includes(decision.type)) throw new Error(`${item.sense_id}/${candidate.text}: type must be one of ${ADMISSION_TYPES.join('/')}`);
  if (!isTier(decision.relevance)) throw new Error(`${item.sense_id}/${candidate.text}: relevance must be an integer 1..9`);
  const availableTargetSenseIds = candidate.same_spelling_targets.flatMap((target) => target.senses.map((sense) => sense.sense_id)).sort();

  if (decision.target_resolution === 'exact') {
    if (keysOf(decision) !== 'candidate,disposition,relevance,reverse_relevance,reverse_type,source_sense_id,target_record_id,target_resolution,target_sense_id,type') {
      throw new Error(`${item.sense_id}/${candidate.text}: exact ID decision has unexpected or missing fields`);
    }
    const target = candidate.same_spelling_targets.find((record) => record.record_id === decision.target_record_id);
    if (!target || !target.senses.some((sense) => sense.sense_id === decision.target_sense_id)) {
      throw new Error(`${item.sense_id}/${candidate.text}: exact target must be one of the supplied same-spelling senses`);
    }
    if (decision.target_record_id === item.record_id) throw new Error(`${item.sense_id}/${candidate.text}: an ID relation cannot target its own record`);
    if (!ADMISSION_TYPES.includes(decision.reverse_type)) throw new Error(`${item.sense_id}/${candidate.text}: reverse_type must be one of ${ADMISSION_TYPES.join('/')}`);
    if (!isTier(decision.reverse_relevance)) throw new Error(`${item.sense_id}/${candidate.text}: reverse_relevance must be an integer 1..9`);
    return;
  }

  if (availableTargetSenseIds.length === 0) {
    if (keysOf(decision) !== 'candidate,disposition,relevance,source_sense_id,type') {
      throw new Error(`${item.sense_id}/${candidate.text}: omit target-resolution fields when no same-spelling target exists`);
    }
    return;
  }
  if (decision.target_resolution !== 'no_exact_match') throw new Error(`${item.sense_id}/${candidate.text}: target_resolution must be exact or no_exact_match`);
  if (!Array.isArray(decision.checked_target_sense_ids) || decision.checked_target_sense_ids.some((id) => typeof id !== 'string')) {
    throw new Error(`${item.sense_id}/${candidate.text}: text-only with same-spelling targets needs checked_target_sense_ids`);
  }
  const checkedTargetSenseIds = [...decision.checked_target_sense_ids].sort();
  if (new Set(checkedTargetSenseIds).size !== checkedTargetSenseIds.length
      || JSON.stringify(checkedTargetSenseIds) !== JSON.stringify(availableTargetSenseIds)) {
    throw new Error(`${item.sense_id}/${candidate.text}: check every same-spelling target sense exactly once`);
  }
  if (keysOf(decision) !== 'candidate,checked_target_sense_ids,disposition,relevance,source_sense_id,target_resolution,type') {
    throw new Error(`${item.sense_id}/${candidate.text}: text-only decision must explicitly omit target IDs and reverse fields`);
  }
}

function validateCheckpoint(checkpoint, identity = {}) {
  if (!isPlainObject(checkpoint) || checkpoint.version !== CHECKPOINT_VERSION) throw new Error('unsupported or malformed Stage 2 checkpoint');
  if (!/^\d{3}$/u.test(checkpoint.shard ?? '') || !['01', '02'].includes(checkpoint.batch) || !['01', '02', '03', '04', '05'].includes(checkpoint.part)) {
    throw new Error('checkpoint must identify one shard, batch and Part');
  }
  for (const key of ['shard', 'batch', 'part']) {
    if (identity[key] !== undefined && identity[key] !== checkpoint[key]) throw new Error(`checkpoint ${key} does not match this command`);
  }
  if (!Array.isArray(checkpoint.items) || !Number.isInteger(checkpoint.next_chunk_number) || checkpoint.next_chunk_number < 1) {
    throw new Error('checkpoint is missing its items or chunk cursor');
  }
  if (typeof checkpoint.complete !== 'boolean') throw new Error('checkpoint must record whether all Stage 1 inputs are complete');
  const seen = new Set();
  const seenSenses = new Set();
  for (const item of checkpoint.items) {
    if (!isPlainObject(item) || !Array.isArray(item.candidates) || typeof item.sense_id !== 'string') throw new Error('checkpoint contains an invalid source sense');
    if (seenSenses.has(item.sense_id)) throw new Error(`checkpoint repeats source sense ${item.sense_id}`);
    seenSenses.add(item.sense_id);
    let hasPending = false;
    for (const candidate of item.candidates) {
      if (!isPlainObject(candidate) || typeof candidate.text !== 'string' || !Array.isArray(candidate.same_spelling_targets)) throw new Error(`${item.sense_id}: checkpoint contains an invalid candidate`);
      const key = `${item.sense_id}\u0000${candidate.text}`;
      if (seen.has(key)) throw new Error(`checkpoint repeats ${item.sense_id}/${candidate.text}`);
      seen.add(key);
      if (candidate.decision === null) hasPending = true;
      else {
        if (hasPending) throw new Error(`${item.sense_id}: saved decisions must form a prefix so a large sense can resume exactly`);
      }
    }
  }
  if (checkpoint.pending_chunk !== null && !isPlainObject(checkpoint.pending_chunk)) throw new Error('checkpoint pending_chunk must be an object or null');
  if (checkpoint.pending_chunk) {
    const { pending_chunk: pending } = checkpoint;
    if (keysOf(pending) !== 'candidate_count,chunk_id,slices' || !Array.isArray(pending.slices) || pending.slices.length === 0
        || pending.chunk_id !== `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}-${String(checkpoint.next_chunk_number).padStart(3, '0')}`) {
      throw new Error('checkpoint contains an invalid pending chunk');
    }
    const pendingSenses = new Set();
    let pendingCount = 0;
    for (const slice of pending.slices) {
      if (!isPlainObject(slice)) throw new Error('checkpoint contains a malformed pending slice');
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      const firstUndecided = item?.candidates.findIndex((candidate) => candidate.decision === null) ?? -1;
      if (!item || keysOf(slice) !== 'end,sense_id,start' || pendingSenses.has(slice.sense_id)
          || !Number.isInteger(slice.start) || !Number.isInteger(slice.end)
          || slice.start !== firstUndecided || slice.end <= slice.start || slice.end > item.candidates.length) {
        throw new Error(`checkpoint contains an invalid pending slice for ${slice.sense_id}`);
      }
      pendingSenses.add(slice.sense_id);
      pendingCount += slice.end - slice.start;
    }
    if (pendingCount !== pending.candidate_count) throw new Error('checkpoint pending chunk candidate count does not match its slices');
  }
  if (checkpoint.merged && (checkpoint.pending_chunk || checkpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null)))) {
    throw new Error('checkpoint cannot be merged while decisions are missing');
  }
  return checkpoint;
}

function validateCheckpointDecisions(checkpoint) {
  for (const item of checkpoint.items) {
    for (const candidate of item.candidates) {
      if (candidate.decision === null) throw new Error(`${item.sense_id}/${candidate.text}: decision is missing`);
      validateDecision(item, candidate, candidate.decision);
    }
  }
}

async function readCheckpoint(file, identity = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read checkpoint ${file}: ${error.message}`); }
  return validateCheckpoint(parsed, identity);
}

function decisionRows(checkpoint) {
  const relations = [];
  const drops = [];
  for (const item of checkpoint.items) {
    for (const candidate of item.candidates) {
      const decision = candidate.decision;
      if (decision.disposition === 'drop') {
        drops.push({ source_record_id: item.record_id, source_sense_id: item.sense_id, candidate: candidate.text, reason: decision.reason.trim() });
      } else if (decision.target_resolution === 'exact') {
        relations.push({
          source_record_id: item.record_id,
          source_sense_id: item.sense_id,
          target_record_id: decision.target_record_id,
          target_sense_id: decision.target_sense_id,
          type: decision.type,
          relevance: decision.relevance,
          reverse_type: decision.reverse_type,
          reverse_relevance: decision.reverse_relevance,
        });
      } else {
        relations.push({
          source_record_id: item.record_id,
          source_sense_id: item.sense_id,
          text: candidate.text,
          type: decision.type,
          relevance: decision.relevance,
        });
      }
    }
  }
  return { relations, drops };
}

function stableRow(row) {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))));
}

function idPairKey(sourceSenseId, targetSenseId) {
  return `${sourceSenseId}\u0000${targetSenseId}`;
}

function assertNoMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, newDrops) {
  const exactRelations = new Set(existingRelations.map(stableRow));
  const exactDrops = new Set(existingDrops.map(stableRow));
  const idPairs = new Set();
  const textPairs = new Set();
  const drops = new Set(existingDrops.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  const sourceCandidateForPair = new Map();
  const existingIdCandidates = new Set();
  const checkpointCandidates = new Map();
  for (const item of checkpoint.items) for (const candidate of item.candidates) {
    const candidateKey = `${item.sense_id}\u0000${candidate.text}`;
    checkpointCandidates.set(candidateKey, candidate);
    if (candidate.decision?.target_resolution === 'exact') {
      sourceCandidateForPair.set(idPairKey(item.sense_id, candidate.decision.target_sense_id), candidateKey);
    }
  }
  for (const row of existingRelations) {
    if ('text' in row) textPairs.add(`${row.source_sense_id}\u0000${normalizeCandidate(row.text)}`);
    else {
      idPairs.add(idPairKey(row.source_sense_id, row.target_sense_id));
      idPairs.add(idPairKey(row.target_sense_id, row.source_sense_id));
      for (const item of checkpoint.items) {
        const forward = item.candidates.filter((candidate) => item.sense_id === row.source_sense_id
          && candidate.same_spelling_targets.some((target) => target.record_id === row.target_record_id));
        const reverse = item.candidates.filter((candidate) => item.sense_id === row.target_sense_id
          && candidate.same_spelling_targets.some((target) => target.record_id === row.source_record_id));
        for (const candidate of forward) existingIdCandidates.add(`${item.sense_id}\u0000${candidate.text}`);
        for (const candidate of reverse) existingIdCandidates.add(`${item.sense_id}\u0000${candidate.text}`);
      }
    }
  }
  const appendRelations = [];
  for (const row of newRelations) {
    if (exactRelations.has(stableRow(row))) continue;
    if ('text' in row) {
      const key = `${row.source_sense_id}\u0000${normalizeCandidate(row.text)}`;
      if (textPairs.has(key) || drops.has(key) || existingIdCandidates.has(key)) throw new Error(`cannot merge duplicate or already-decided candidate ${row.source_sense_id}/${row.text}`);
      textPairs.add(key);
    } else {
      const key = idPairKey(row.source_sense_id, row.target_sense_id);
      const reverse = idPairKey(row.target_sense_id, row.source_sense_id);
      if (idPairs.has(key) || idPairs.has(reverse)) throw new Error(`cannot merge duplicate or reverse-duplicate ID relation ${row.source_sense_id}/${row.target_sense_id}`);
      const candidateKey = sourceCandidateForPair.get(key);
      if (candidateKey && drops.has(candidateKey)) throw new Error(`cannot merge an ID relation already marked Drop for ${candidateKey.replace('\u0000', '/')}`);
      if (candidateKey && textPairs.has(candidateKey)) throw new Error(`cannot merge an ID relation already text-only for ${candidateKey.replace('\u0000', '/')}`);
      idPairs.add(key);
      idPairs.add(reverse);
    }
    appendRelations.push(row);
  }
  const appendDrops = [];
  for (const row of newDrops) {
    if (exactDrops.has(stableRow(row))) continue;
    const key = `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`;
    if (drops.has(key) || textPairs.has(key) || existingIdCandidates.has(key)) throw new Error(`cannot merge duplicate or already-decided candidate ${row.source_sense_id}/${row.candidate}`);
    drops.add(key);
    appendDrops.push(row);
  }
  for (const [key, candidate] of checkpointCandidates) {
    if (candidate.decision.disposition === 'drop' && existingIdCandidates.has(key)) {
      throw new Error(`cannot merge a Drop already answered by an approved ID relation ${key.replace('\u0000', '/')}`);
    }
  }
  return { relations: [...existingRelations, ...appendRelations], drops: [...existingDrops, ...appendDrops] };
}

function checkpointIndex(checkpoint) {
  const byId = new Map();
  const senses = new Map();
  const add = (recordId, lemma, sense) => {
    const record = byId.get(recordId) ?? { id: recordId, lemma, senses: [] };
    byId.set(recordId, record);
    if (!record.senses.some((entry) => entry.id === sense.sense_id)) record.senses.push({ id: sense.sense_id, pos: sense.pos, gloss: sense.gloss });
    senses.set(sense.sense_id, { record, sense: { id: sense.sense_id, pos: sense.pos, gloss: sense.gloss } });
  };
  for (const item of checkpoint.items) {
    add(item.record_id, item.lemma, { sense_id: item.sense_id, pos: item.pos, gloss: item.gloss });
    for (const candidate of item.candidates) for (const target of candidate.same_spelling_targets) {
      for (const sense of target.senses) add(target.record_id, target.lemma, sense);
    }
  }
  return { byId, senses };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, shard: null, batch: null, part: null, out: null, checkpoint: null, input: null, maxCandidates: DEFAULT_CHUNK_CANDIDATES, allowPartial: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--shard') options.shard = rest[++index];
    else if (flag === '--batch') options.batch = rest[++index];
    else if (flag === '--part') options.part = rest[++index];
    else if (flag === '--out') options.out = rest[++index];
    else if (flag === '--checkpoint') options.checkpoint = rest[++index];
    else if (flag === '--in') options.input = rest[++index];
    else if (flag === '--max-candidates') options.maxCandidates = Number(rest[++index]);
    else if (flag === '--allow-partial') options.allowPartial = true;
    else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (!['prepare', 'read-chunk', 'save-chunk', 'merge', 'verify'].includes(command)) throw new Error(USAGE);
  if (['prepare', 'verify'].includes(command)) assertShard(options.shard);
  if (options.batch !== null && !['01', '02'].includes(options.batch)) throw new Error(`--batch must be 01 or 02\n${USAGE}`);
  if (options.part !== null && !['01', '02', '03', '04', '05'].includes(options.part)) throw new Error(`--part must be 01, 02, 03, 04 or 05\n${USAGE}`);
  if (options.part !== null && options.batch === null) throw new Error(`--part requires --batch\n${USAGE}`);
  if (options.part !== null && !['prepare', 'verify'].includes(command)) throw new Error(`--part is only valid for prepare/verify\n${USAGE}`);
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1) throw new Error(`--max-candidates must be a positive integer\n${USAGE}`);
  if (['read-chunk', 'save-chunk', 'merge'].includes(command) && !options.checkpoint) throw new Error(`${command} requires --checkpoint\n${USAGE}`);
  if (command === 'save-chunk' && !options.input) throw new Error(`save-chunk requires --in\n${USAGE}`);
  if (options.allowPartial && !['prepare', 'verify'].includes(command)) throw new Error(`--allow-partial is only valid for prepare/verify\n${USAGE}`);
  if (command === 'prepare' && options.part && options.out) throw new Error('Part prepare writes its checkpoint; use --checkpoint instead of --out');
  return options;
}

function requireComplete(inventory, allowPartial) {
  if (inventory.missing.length === 0) return;
  const message = `shard Stage 1 inputs are incomplete; missing batch/producer: ${inventory.missing.join(', ')}`;
  if (!allowPartial) throw new Error(`${message}. Do not substitute other AI output; pass --allow-partial only for tooling checks.`);
  console.error(`PARTIAL: ${message}`);
}

export async function run(argv, { root } = {}) {
  const options = parseArgs(argv);
  const repositoryRoot = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const checkpointPath = options.checkpoint
    ? resolveRootPath(repositoryRoot, options.checkpoint)
    : options.part && ['prepare', 'verify'].includes(options.command)
        ? defaultCheckpointPath(options.shard, options.batch, options.part, repositoryRoot)
        : null;

  if (options.command === 'read-chunk' || options.command === 'save-chunk') {
    const checkpoint = await readCheckpoint(checkpointPath);
    if (options.command === 'read-chunk') return readChunk(checkpoint, checkpointPath, options.maxCandidates, options.out, repositoryRoot);
    return saveChunk(checkpoint, checkpointPath, options.input, repositoryRoot);
  }
  if (options.command === 'merge') return mergeCheckpoint(await readCheckpoint(checkpointPath), checkpointPath, repositoryRoot);
  if (options.command === 'prepare' && options.part && existsSync(checkpointPath)) {
    const checkpoint = await readCheckpoint(checkpointPath, { shard: options.shard, batch: options.batch, part: options.part });
    console.log(`Resuming shard ${options.shard} batch ${options.batch} part ${options.part}: ${checkpointProgress(checkpoint)} -> ${checkpointPath}`);
    return checkpoint;
  }
  if (options.command === 'verify' && options.part && existsSync(checkpointPath)) {
    const checkpoint = await readCheckpoint(checkpointPath, { shard: options.shard, batch: options.batch, part: options.part });
    if (!checkpoint.merged || checkpoint.pending_chunk || checkpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null))) {
      throw new Error(`Part checkpoint is incomplete or not merged: ${checkpointProgress(checkpoint)}`);
    }
    validateCheckpointDecisions(checkpoint);
  }

  const loaded = await loadShard(options.shard, repositoryRoot, { batch: options.batch });
  const { canonicalRows, index } = loaded;
  // --batch selects and fully validates one 500-record Stage 1 input set; --part narrows only Stage 2 editing/accounting.
  const scoped = options.part
    ? partScope(canonicalRows, loaded.candidateFiles, options.batch, options.part)
    : options.batch
      ? batchScope(canonicalRows, loaded.candidateFiles, options.batch)
      : { scopeRows: canonicalRows, files: loaded.candidateFiles };
  const { scopeRows } = scoped;
  const candidateFiles = scoped.files;
  const inventory = options.batch ? candidateInventory(candidateFiles.map((file) => file.name), { batches: [options.batch] }) : loaded.inventory;
  requireComplete(inventory, options.allowPartial);
  const others = await loadApprovedRelations(repositoryRoot, { exceptShard: options.shard });

  if (options.command === 'prepare') {
    // A re-run must not re-offer what is already decided: this shard's own approved rows and real Drops count too.
    const own = await loadOptionalJsonl(shardRelationPath(options.shard, repositoryRoot));
    const ownDrops = await loadOptionalJsonl(shardDropPath(options.shard, repositoryRoot));
    const result = prepareShard({ canonicalRows, candidateFiles, approvedRelationRows: [...others, ...own], dropRows: ownDrops, index, scopeRows });
    if (options.part) {
      const checkpoint = {
        version: CHECKPOINT_VERSION,
        shard: options.shard,
        batch: options.batch,
        part: options.part,
        complete: inventory.missing.length === 0,
        stats: result.stats,
        next_chunk_number: 1,
        pending_chunk: null,
        merged: false,
        items: result.items.map((item) => ({
          ...item,
          approved_peers: approvedPeersForSense(item.sense_id, [...others, ...own], index),
          candidates: item.candidates.map((candidate) => ({
            text: candidate.text,
            producers: candidate.producers,
            same_spelling_targets: sameSpellingTargets(index, candidate.text),
            decision: null,
          })),
        })),
      };
      validateCheckpoint(checkpoint, { shard: options.shard, batch: options.batch, part: options.part });
      await writeJsonAtomically(checkpointPath, checkpoint);
      console.log(`Prepared shard ${options.shard} batch ${options.batch} part ${options.part}: ${JSON.stringify(result.stats)} -> ${checkpointPath}`);
      return checkpoint;
    }
    const payload = {
      shard: options.shard,
      batch: options.batch,
      ...(options.part ? { part: options.part } : {}),
      complete: inventory.missing.length === 0,
      missing: inventory.missing,
      stats: result.stats,
      items: result.items,
    };
    if (options.out) {
      await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(payload)}\n`);
    }
    console.log(`Prepared shard ${options.shard}${options.batch ? ` batch ${options.batch}` : ''}${options.part ? ` part ${options.part}` : ''}: ${JSON.stringify(result.stats)}${options.out ? ` -> ${options.out}` : ''}`);
    return payload;
  }

  const relationRows = await loadOptionalJsonl(shardRelationPath(options.shard, repositoryRoot));
  const dropRows = await loadOptionalJsonl(shardDropPath(options.shard, repositoryRoot));
  const shardSenseIds = new Set(canonicalRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  validateRelationRows({ relationRows, dropRows, index, shardSenseIds, otherRelationRows: others });
  const counts = verifyAccounting({ canonicalRows, candidateFiles, relationRows, dropRows, otherRelationRows: others, index, scopeRows });
  if (options.part && existsSync(checkpointPath)) {
    const checkpoint = await readCheckpoint(checkpointPath, { shard: options.shard, batch: options.batch, part: options.part });
    assertCheckpointMerged(checkpoint, relationRows, dropRows);
  }
  console.log(`Relation Admission accounting valid for shard ${options.shard}${options.batch ? ` batch ${options.batch}` : ''}${options.part ? ` part ${options.part}` : ''}: ${JSON.stringify(counts)}`);
  return counts;
}

function checkpointProgress(checkpoint) {
  const total = checkpoint.items.reduce((sum, item) => sum + item.candidates.length, 0);
  const decided = checkpoint.items.reduce((sum, item) => sum + item.candidates.filter((candidate) => candidate.decision !== null).length, 0);
  return `${decided}/${total} candidates decided`;
}

function checkpointProgressPayload(checkpoint) {
  const total = checkpoint.items.reduce((sum, item) => sum + item.candidates.length, 0);
  const decided = total - checkpoint.items.reduce((sum, item) => sum + item.candidates.filter((candidate) => candidate.decision === null).length, 0);
  return { decided, total };
}

function pendingChunkPayload(checkpoint, pending) {
  return {
    chunk_id: pending.chunk_id,
    shard: checkpoint.shard,
    batch: checkpoint.batch,
    part: checkpoint.part,
    candidate_count: pending.candidate_count,
    continuation: pending.slices.map((slice) => {
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      return {
        source_sense_id: item.sense_id,
        candidate_start: slice.start,
        candidate_end: slice.end,
        candidate_total: item.candidates.length,
        continues_from_previous: slice.start > 0,
        continues_in_next: slice.end < item.candidates.length,
      };
    }),
    items: pending.slices.map((slice) => {
      const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
      return {
        record_id: item.record_id,
        sense_id: item.sense_id,
        lemma: item.lemma,
        pos: item.pos,
        gloss: item.gloss,
        approved_peers: item.approved_peers,
        candidate_start: slice.start,
        candidate_end: slice.end,
        candidate_total: item.candidates.length,
        continues_from_previous: slice.start > 0,
        continues_in_next: slice.end < item.candidates.length,
        candidates: item.candidates.slice(slice.start, slice.end).map(({ text, producers, same_spelling_targets: targets }) => ({
          text,
          producers,
          same_spelling_targets: targets,
        })),
      };
    }),
  };
}

async function readChunk(checkpoint, checkpointPath, maxCandidates, out, root) {
  let pending = checkpoint.pending_chunk;
  if (!pending) {
    let remaining = maxCandidates;
    const slices = [];
    for (const item of checkpoint.items) {
      const start = item.candidates.findIndex((candidate) => candidate.decision === null);
      if (start === -1) continue;
      const unresolvedCount = item.candidates.length - start;
      if (unresolvedCount > remaining) {
        if (slices.length > 0) break;
        if (unresolvedCount > maxCandidates) {
          slices.push({ sense_id: item.sense_id, start, end: start + maxCandidates });
          remaining = 0;
          break;
        }
      }
      slices.push({ sense_id: item.sense_id, start, end: item.candidates.length });
      remaining -= unresolvedCount;
      if (remaining <= 0) break;
    }
    if (slices.length === 0) {
      const complete = { complete: true, shard: checkpoint.shard, batch: checkpoint.batch, part: checkpoint.part, ...checkpointProgressPayload(checkpoint), items: [] };
      if (out) await writeJsonAtomically(resolveRootPath(root, out), complete);
      else console.log(JSON.stringify(complete));
      return complete;
    }
    const candidateCount = slices.reduce((sum, slice) => sum + slice.end - slice.start, 0);
    const chunkNumber = String(checkpoint.next_chunk_number).padStart(3, '0');
    pending = { chunk_id: `${checkpoint.shard}-${checkpoint.batch}-${checkpoint.part}-${chunkNumber}`, candidate_count: candidateCount, slices };
    checkpoint.pending_chunk = pending;
    await writeJsonAtomically(checkpointPath, checkpoint);
  }
  const payload = pendingChunkPayload(checkpoint, pending);
  if (out) await writeJsonAtomically(resolveRootPath(root, out), payload);
  else console.log(JSON.stringify(payload));
  return payload;
}

async function saveChunk(checkpoint, checkpointPath, inputPath, root) {
  const pending = checkpoint.pending_chunk;
  if (!pending) throw new Error('checkpoint has no unread or unsaved chunk');
  let input;
  try { input = JSON.parse(await readFile(resolveRootPath(root, inputPath), 'utf8')); }
  catch (error) { throw new Error(`cannot read chunk decisions: ${error.message}`); }
  if (!isPlainObject(input) || keysOf(input) !== 'chunk_id,decisions' || input.chunk_id !== pending.chunk_id || !Array.isArray(input.decisions)) {
    throw new Error(`decision file must contain the active chunk_id ${pending.chunk_id} and a decisions array`);
  }
  const expected = new Map();
  for (const slice of pending.slices) {
    const item = checkpoint.items.find((entry) => entry.sense_id === slice.sense_id);
    for (const candidate of item.candidates.slice(slice.start, slice.end)) expected.set(`${item.sense_id}\u0000${candidate.text}`, { item, candidate });
  }
  const received = new Map();
  for (const decision of input.decisions) {
    if (!isPlainObject(decision) || typeof decision.source_sense_id !== 'string' || typeof decision.candidate !== 'string') throw new Error('each decision needs source_sense_id and candidate');
    const key = `${decision.source_sense_id}\u0000${decision.candidate}`;
    if (received.has(key)) throw new Error(`chunk repeats decision ${decision.source_sense_id}/${decision.candidate}`);
    const source = expected.get(key);
    if (!source) throw new Error(`decision ${decision.source_sense_id}/${decision.candidate} is outside the active chunk`);
    validateDecision(source.item, source.candidate, decision);
    received.set(key, decision);
  }
  const missing = [...expected.keys()].filter((key) => !received.has(key));
  if (missing.length) throw new Error(`chunk has missing decisions: ${missing.map((key) => key.replace('\u0000', '/')).join(', ')}`);
  for (const [key, decision] of received) expected.get(key).candidate.decision = decision;
  checkpoint.pending_chunk = null;
  checkpoint.next_chunk_number += 1;
  await writeJsonAtomically(checkpointPath, checkpoint);
  const result = { saved: received.size, ...checkpointProgressPayload(checkpoint), checkpoint: checkpointPath };
  console.log(`Saved ${received.size} decisions: ${result.decided}/${result.total} -> ${checkpointPath}`);
  return result;
}

async function mergeCheckpoint(checkpoint, checkpointPath, root) {
  if (!checkpoint.complete) throw new Error('cannot merge a checkpoint prepared with incomplete Stage 1 inputs');
  if (checkpoint.pending_chunk) throw new Error(`save the active chunk ${checkpoint.pending_chunk.chunk_id} before merging`);
  if (checkpoint.items.some((item) => item.candidates.some((candidate) => candidate.decision === null))) throw new Error(`cannot merge an incomplete checkpoint: ${checkpointProgress(checkpoint)}`);
  validateCheckpointDecisions(checkpoint);
  const { relations: newRelations, drops: newDrops } = decisionRows(checkpoint);
  const index = checkpointIndex(checkpoint);
  const shardSenseIds = new Set(checkpoint.items.map((item) => item.sense_id));
  const others = await loadApprovedRelations(root, { exceptShard: checkpoint.shard });
  validateRelationRows({ relationRows: newRelations, dropRows: newDrops, index, shardSenseIds, otherRelationRows: others });
  const relationFile = shardRelationPath(checkpoint.shard, root);
  const dropFile = shardDropPath(checkpoint.shard, root);
  const existingRelations = await loadOptionalJsonl(relationFile);
  const existingDrops = await loadOptionalJsonl(dropFile);
  const merged = assertNoMergeConflicts(checkpoint, existingRelations, existingDrops, newRelations, newDrops);
  if (merged.relations.length > existingRelations.length) await writeJsonlAtomically(relationFile, merged.relations);
  if (merged.drops.length > existingDrops.length) await writeJsonlAtomically(dropFile, merged.drops);
  checkpoint.merged = true;
  await writeJsonAtomically(checkpointPath, checkpoint);
  const result = { merged: true, relations_added: merged.relations.length - existingRelations.length, drops_added: merged.drops.length - existingDrops.length, checkpoint: checkpointPath };
  console.log(`Merged ${result.relations_added} Relations and ${result.drops_added} Drops for ${checkpoint.shard}/${checkpoint.batch}/${checkpoint.part}`);
  return result;
}

function assertCheckpointMerged(checkpoint, relationRows, dropRows) {
  if (!checkpoint.merged) throw new Error('Part checkpoint is not marked merged');
  const relationSet = new Set(relationRows.map(stableRow));
  const dropSet = new Set(dropRows.map(stableRow));
  const expected = decisionRows(checkpoint);
  for (const row of expected.relations) if (!relationSet.has(stableRow(row))) throw new Error(`merged Part relation is missing: ${stableRow(row)}`);
  for (const row of expected.drops) if (!dropSet.has(stableRow(row))) throw new Error(`merged Part Drop is missing: ${stableRow(row)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

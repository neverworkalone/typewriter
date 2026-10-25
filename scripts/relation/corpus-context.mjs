import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CANDIDATE_BATCH_SIZE,
  loadCanonicalLemmaForms,
  normalizeCandidate,
  parseCandidateJsonl,
  patchCandidateRows,
  serializeCandidateJsonl,
  validateCandidateBatch,
} from './candidate-contract.mjs';
import { inspectCorpusIndex, openCorpusIndex } from './literary-context.mjs';

export const CORPUS_CONTEXT_CONTRACT = 'corpus-context-v1';
export const CORPUS_CHECKPOINT_CONTRACT = 'corpus-checkpoint-v1';
export const CORPUS_RESPONSE_LIMIT = 28_000;
export const CORPUS_CONTEXT_PAGE_SIZE = 4;
export const CORPUS_CONTEXT_LIMIT = 16;
export const CORPUS_SNIPPET_CHARS = 700;
export const CORPUS_SUBMIT_LIMIT = 256_000;

// These are the approved NIKL Written Corpus 2025 (1.0) logical input digests
// recorded in docs/corpus-index-design.md and the source-specific permission record.
export const APPROVED_WRITTEN_CORPUS = Object.freeze({
  source_manifest_sha256: '50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211',
  logical_row_sha256: 'c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd',
});

const DEFAULT_SCRATCH_DIRECTORY = '.warroom-scratch';
const SEARCH_CONTRACT = 'd-written-context-search-v1';
const MAX_QUEUE_LIMIT = 100;
const SUBMIT_STATUSES = Object.freeze({ discovered: 'DISCOVERED', no_verified: 'NO_VERIFIED', incomplete: 'INCOMPLETE' });
const SUBMIT_KEYS = new Set(['sense_id', 'status', 'verified', 'rejected', 'ambiguous', 'candidates']);
const EXPORTABLE_STATUSES = new Set(['ZERO_HITS', 'NO_VERIFIED', 'DISCOVERED', 'OUTPUT']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function assertScratchPath(filePath, scratchDirectory) {
  const root = path.resolve(scratchDirectory);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('private checkpoint and evidence must stay under .warroom-scratch/');
  }
  return absolute;
}

async function writeJsonAtomic(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode });
  await rename(temporary, filePath);
}

function parseCanonicalShard(contents, label) {
  return contents.split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    try {
      const row = JSON.parse(line);
      if (typeof row?.id !== 'string' || typeof row?.lemma !== 'string' || !Array.isArray(row.senses)) fail(`${label}:${index + 1} is not a Canonical record`);
      return row;
    } catch (error) {
      fail(`${label}:${index + 1} is invalid Canonical JSON: ${error.message}`);
    }
  });
}

function canonicalForms(record, addedForms = []) {
  return [...new Set([record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : []), ...addedForms]
    .filter((form) => typeof form === 'string' && form.trim().length > 0)
    .map((form) => form.normalize('NFC').trim()))].sort(compare);
}

function normalizeShardBatch(shard, batch) {
  const normalizedShard = String(shard).padStart(3, '0');
  const batchNumber = Number(batch);
  if (!/^\d{3}$/u.test(normalizedShard) || Number(normalizedShard) < 1 || Number(normalizedShard) > 428) fail('shard must be in [001, 428]');
  if (![1, 2].includes(batchNumber)) fail('batch must be 01 or 02');
  return { shard: normalizedShard, batch: String(batchNumber).padStart(2, '0'), batchNumber };
}

function isNiklDistributor(value) {
  const normalized = String(value ?? '').toLocaleLowerCase('en');
  return normalized.includes('국립국어원') || normalized.includes('national institute of korean language') || /\bnikl\b/u.test(normalized);
}

function isWrittenCorpusProfile(profile) {
  const category = String(profile.category ?? '').trim();
  return /^(?:문어|written corpus)(?:\s|>|$)/iu.test(category);
}

function inspectShortIndex(database) {
  const object = database.prepare("SELECT type FROM sqlite_schema WHERE name = 'paragraph_bigrams' LIMIT 1").get();
  if (!object) return { available: false };
  if (object.type !== 'table') fail('paragraph_bigrams exists but is not a table');
  const columns = new Set(database.prepare('PRAGMA table_info(paragraph_bigrams)').all().map((row) => row.name));
  if (!columns.has('gram') || !columns.has('paragraph_rowid')) fail('paragraph_bigrams must contain gram and paragraph_rowid columns');
  return { available: true };
}

/**
 * Small read-only identity check for the approved NIKL written-corpus snapshot.
 * It follows the shared index metadata contract (`schema_version` or `index_version`) and never
 * hashes the whole database unless `verifyBinary` is requested for an initial approval or suspected change.
 */
export async function inspectWrittenCorpusIndex(databasePath, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY), verifyBinary = false } = {}) {
  const inspected = await inspectCorpusIndex(databasePath, { scratchDirectory, verifyBinary });
  if (inspected.index.source_manifest_sha256 !== APPROVED_WRITTEN_CORPUS.source_manifest_sha256
    || inspected.index.logical_row_sha256 !== APPROVED_WRITTEN_CORPUS.logical_row_sha256) {
    fail('corpus index does not match the approved NIKL Written Corpus 2025 (1.0) input and logical-row digests');
  }

  const { database } = openCorpusIndex(databasePath);
  let profileCount = 0;
  let bigram;
  try {
    const sourceRows = database.prepare('SELECT title, distributor, category FROM source_files').all();
    if (sourceRows.length === 0) fail('source profile count must be at least 1');
    const profiles = new Set();
    for (const source of sourceRows) {
      if (!isNiklDistributor(source.distributor) || !isWrittenCorpusProfile(source)) {
        fail('corpus source metadata does not identify only NIKL written-corpus material');
      }
      profiles.add(JSON.stringify([source.title, source.distributor, source.category]));
    }
    profileCount = profiles.size;
    bigram = inspectShortIndex(database);
  } finally {
    database.close();
  }
  return {
    contract: CORPUS_CONTEXT_CONTRACT,
    status: 'READY',
    source: { name: 'NIKL Written Corpus 2025 (1.0)', profile_count: profileCount },
    database: inspected.database,
    index: inspected.index,
    search: { read_only: true, bigram_index: bigram.available },
  };
}

function currentStatIdentity(fileStat) {
  return {
    device: String(fileStat.dev),
    inode: String(fileStat.ino),
    bytes: Number(fileStat.size),
    mtime_ns: String(fileStat.mtimeNs),
    ctime_ns: String(fileStat.ctimeNs),
  };
}

async function assertIndexUnchanged(checkpoint, databasePath) {
  const resolvedPath = await realpath(databasePath);
  const actual = currentStatIdentity(await stat(resolvedPath, { bigint: true }));
  if (resolvedPath !== checkpoint.index.path || JSON.stringify(actual) !== JSON.stringify(checkpoint.index.file_identity)) {
    fail('corpus index identity changed after checkpoint initialization; run preflight and initialize a new checkpoint');
  }
}

function makeSense(record, sense) {
  return {
    sense_id: sense.id,
    pos: sense.pos ?? null,
    gloss: sense.gloss ?? '',
    added_forms: [],
    status: 'PENDING',
    search: null,
    verified: [],
    rejected: [],
    ambiguous: [],
    candidates: [],
    search_forms: canonicalForms(record),
  };
}

/** Initialize one private D checkpoint from an exact canonical batch and the approved index. */
export async function initializeCorpusCheckpoint({ canonicalPath, shard, batch, model, databasePath, checkpointPath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const resolvedCheckpoint = assertScratchPath(checkpointPath, scratchDirectory);
  const normalized = normalizeShardBatch(shard, batch);
  const canonicalText = await readFile(canonicalPath, 'utf8');
  const canonicalRows = parseCanonicalShard(canonicalText, canonicalPath);
  const canonicalShard = path.basename(canonicalPath).match(/^stdict-(\d{4})\.jsonl$/u)?.[1];
  if (canonicalShard !== normalized.shard.padStart(4, '0')) fail(`Canonical path does not match shard ${normalized.shard}`);
  const selected = canonicalRows.slice((normalized.batchNumber - 1) * CANDIDATE_BATCH_SIZE, normalized.batchNumber * CANDIDATE_BATCH_SIZE);
  if (selected.length === 0) fail(`Canonical shard ${normalized.shard} has no records in batch ${normalized.batch}`);
  if (selected.length !== CANDIDATE_BATCH_SIZE && !(normalized.shard === '428' && normalized.batchNumber === 2 && selected.length === 83)) {
    fail(`Canonical batch has ${selected.length} records; expected ${CANDIDATE_BATCH_SIZE}`);
  }
  const normalizedModel = String(model ?? '').toLowerCase();
  if (!['codex', 'claude', 'deepseek'].includes(normalizedModel)) fail('model must be codex, claude, or deepseek');
  const expectedCanonicalPath = path.resolve(repositoryDirectory, 'data/canonical', `stdict-${normalized.shard.padStart(4, '0')}.jsonl`);
  if (path.resolve(canonicalPath) !== expectedCanonicalPath) fail(`Canonical path must be ${path.relative(repositoryDirectory, expectedCanonicalPath)}`);

  const indexCheck = await inspectWrittenCorpusIndex(databasePath, { scratchDirectory });
  const databaseRealPath = await realpath(databasePath);
  const checkpoint = {
    contract: CORPUS_CHECKPOINT_CONTRACT,
    batch: {
      shard: normalized.shard,
      batch: normalized.batch,
      model: normalizedModel,
      canonical_path: path.relative(repositoryDirectory, path.resolve(canonicalPath)),
      canonical_sha256: sha256(canonicalText),
      initialized_at: new Date().toISOString(),
    },
    index: {
      path: databaseRealPath,
      file_identity: currentStatIdentity(await stat(databaseRealPath, { bigint: true })),
      source_manifest_sha256: indexCheck.index.source_manifest_sha256,
      logical_row_sha256: indexCheck.index.logical_row_sha256,
      schema_version: indexCheck.index.schema_version,
      index_version: indexCheck.index.index_version,
    },
    records: selected.map((record) => ({
      record_id: record.id,
      lemma: record.lemma,
      search_forms: Array.isArray(record.search_forms) ? [...record.search_forms] : [],
      senses: record.senses.map((sense) => makeSense(record, sense)),
    })),
    search_cache: {},
    output: null,
    stats: { count_queries: 0, cache_hits: 0, records_scanned: 0 },
  };
  await writeJsonAtomic(resolvedCheckpoint, checkpoint);
  return { status: 'READY', batch: { shard: normalized.shard, batch: normalized.batch, model: normalizedModel }, records: selected.length, senses: selected.reduce((sum, record) => sum + record.senses.length, 0) };
}

/** One read of the private checkpoint. Code or document edits never invalidate it. */
export async function loadCorpusCheckpoint(checkpointPath, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  const resolvedPath = assertScratchPath(checkpointPath, scratchDirectory);
  const checkpoint = JSON.parse(await readFile(resolvedPath, 'utf8'));
  if (checkpoint?.contract !== CORPUS_CHECKPOINT_CONTRACT || !Array.isArray(checkpoint.records) || !checkpoint.index?.path) fail('unsupported D corpus checkpoint contract');
  return { checkpoint, path: resolvedPath };
}

function searchForms(sense) {
  return [...new Set([...sense.search_forms, ...sense.added_forms.map((entry) => entry.form)])].sort(compare);
}

// Earlier checkpoints keyed the cache with the whole-file digest; keep their keys valid.
function searchCacheKey(checkpoint, forms) {
  return sha256(JSON.stringify([
    SEARCH_CONTRACT,
    checkpoint.index.database_sha256 ?? checkpoint.index.logical_row_sha256,
    checkpoint.index.source_manifest_sha256,
    checkpoint.index.logical_row_sha256,
    forms,
    CORPUS_CONTEXT_LIMIT,
    CORPUS_SNIPPET_CHARS,
  ]));
}

function senseRows(checkpoint, recordStart = 0, recordEnd = checkpoint.records.length) {
  return checkpoint.records.slice(recordStart, recordEnd).flatMap((record) => record.senses.map((sense) => ({ record, sense })));
}

function querySetRows(rows, checkpoint) {
  const unique = new Map();
  for (const { sense } of rows) {
    const forms = searchForms(sense);
    if (forms.length === 0) continue;
    const key = searchCacheKey(checkpoint, forms);
    if (!checkpoint.search_cache[key] || checkpoint.search_cache[key].failure) unique.set(key, { key, forms });
  }
  return [...unique.values()];
}

function rawHitsSql(hasBigram, withForm) {
  const form = withForm ? ', q.form' : '';
  const bigramBranch = hasBigram
    ? `UNION ALL
      SELECT q.search_key, p.paragraph_rowid${form}
      FROM query_forms q
      JOIN paragraph_bigrams b ON b.gram = substr(q.form, 1, 2)
      JOIN paragraphs p ON p.paragraph_rowid = b.paragraph_rowid
      WHERE length(q.form) = 2 AND instr(p.form, q.form) > 0`
    : '';
  const literalCondition = hasBigram ? 'length(q.form) = 1' : 'length(q.form) < 3';
  return `WITH query_sets AS (
    SELECT json_extract(value, '$.key') AS search_key, json_extract(value, '$.forms') AS forms_json
    FROM json_each(?)
  ), query_forms AS (
    SELECT search_key, CAST(value AS TEXT) AS form FROM query_sets, json_each(forms_json)
  ), long_forms AS (
    SELECT search_key, form FROM query_forms WHERE length(form) >= 3
  ), raw_hits AS (
    SELECT q.search_key, paragraph_fts.rowid AS paragraph_rowid${form}
    FROM long_forms q
    JOIN paragraph_fts ON paragraph_fts MATCH ('"' || replace(q.form, '"', '""') || '"')
    JOIN paragraphs p ON p.paragraph_rowid = paragraph_fts.rowid
    WHERE instr(p.form, q.form) > 0
    ${bigramBranch}
    UNION ALL
    SELECT q.search_key, p.paragraph_rowid${form}
    FROM query_forms q
    JOIN paragraphs p ON instr(p.form, q.form) > 0
    WHERE ${literalCondition}`;
}

function countQuerySql(hasBigram) {
  return `${rawHitsSql(hasBigram, false)}
  )
  SELECT search_key, COUNT(DISTINCT paragraph_rowid) AS total_hits
  FROM raw_hits GROUP BY search_key`;
}

function contextRefsSql(hasBigram) {
  return `${rawHitsSql(hasBigram, true)}
  ), deduped AS (
    SELECT search_key, paragraph_rowid, group_concat(DISTINCT form) AS matched_forms
    FROM raw_hits GROUP BY search_key, paragraph_rowid
  ), ranked AS (
    SELECT h.search_key, h.paragraph_rowid, h.matched_forms,
      ROW_NUMBER() OVER (PARTITION BY h.search_key, p.document_rowid ORDER BY p.ordinal, p.paragraph_rowid) AS work_rank
    FROM deduped h JOIN paragraphs p ON p.paragraph_rowid = h.paragraph_rowid
  )
  SELECT r.paragraph_rowid, r.matched_forms
  FROM ranked r
  JOIN paragraphs p ON p.paragraph_rowid = r.paragraph_rowid
  JOIN documents d ON d.document_rowid = p.document_rowid
  WHERE r.work_rank <= ?
  ORDER BY r.work_rank, d.source_path, d.document_ordinal, p.ordinal, p.paragraph_rowid
  LIMIT ?`;
}

const CONTEXT_PAGE_SQL = `SELECT CAST(json_extract(j.value, '$.paragraph_rowid') AS INTEGER) AS paragraph_rowid, p.form
  FROM json_each(?) j
  JOIN paragraphs p ON p.paragraph_rowid = CAST(json_extract(j.value, '$.paragraph_rowid') AS INTEGER)
  ORDER BY CAST(j.key AS INTEGER)`;

function excerptAround(text, forms, maxChars = CORPUS_SNIPPET_CHARS) {
  const matchAt = forms.map((form) => text.indexOf(form)).filter((at) => at >= 0).sort((left, right) => left - right)[0] ?? 0;
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  const matchIndex = [...text.slice(0, matchAt)].length;
  const start = Math.max(0, Math.min(chars.length - maxChars, matchIndex - Math.floor(maxChars / 2)));
  return chars.slice(start, start + maxChars).join('');
}

function safeSqliteFailure(error) {
  const message = String(error?.message ?? error?.name ?? 'SQLite search failed').slice(0, 240);
  const busy = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/iu.test(`${error?.code ?? ''} ${message}`);
  return { kind: busy ? 'timeout' : 'sqlite', message };
}

function senseCandidates(sense) {
  if (Array.isArray(sense.candidates)) return sense.candidates;
  return (sense.candidate_reviews ?? []).filter((review) => review.decision === 'KEEP').map((review) => review.candidate);
}

function senseHasVerified(sense) {
  return Array.isArray(sense.verified) ? sense.verified.length > 0 : (sense.contexts ?? []).some((context) => context.judgment === 'VERIFIED');
}

function checkpointSummary(checkpoint) {
  const totals = {};
  let senseCount = 0;
  let candidateCount = 0;
  for (const record of checkpoint.records) {
    for (const sense of record.senses) {
      senseCount += 1;
      totals[sense.status] = (totals[sense.status] ?? 0) + 1;
      candidateCount += senseCandidates(sense).length;
    }
  }
  return { records: checkpoint.records.length, senses: senseCount, statuses: totals, candidates: candidateCount, stats: { ...checkpoint.stats } };
}

function markSearchFailed(sense, queryKey, failure) {
  sense.search = { status: 'SEARCH_FAILED', total_hits: null, query_key: queryKey, failure };
  sense.status = 'SEARCH_FAILED';
}

/** Count the whole batch in 25-record aggregate queries on one read-only connection; save once. */
export async function scanCorpusBatch({ databasePath, checkpointPath, scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  await assertIndexUnchanged(checkpoint, databasePath);
  const started = performance.now();
  let failures = 0;
  let newCountQueries = 0;
  let cacheHits = 0;
  let database;
  let openFailure = null;
  try {
    database = openCorpusIndex(databasePath).database;
  } catch (error) {
    openFailure = safeSqliteFailure(error);
  }
  try {
    let countStatement;
    if (database) {
      database.exec('PRAGMA busy_timeout = 5000');
      countStatement = database.prepare(countQuerySql(inspectShortIndex(database).available));
    }
    for (let start = 0; start < checkpoint.records.length; start += 25) {
      const rows = senseRows(checkpoint, start, Math.min(start + 25, checkpoint.records.length));
      const querySets = querySetRows(rows, checkpoint);
      if (querySets.length > 0) {
        try {
          if (!countStatement) throw Object.assign(new Error(openFailure.message), { code: openFailure.kind === 'timeout' ? 'SQLITE_BUSY' : '' });
          const counts = new Map(countStatement.all(JSON.stringify(querySets)).map((row) => [row.search_key, Number(row.total_hits)]));
          newCountQueries += 1;
          checkpoint.stats.count_queries += 1;
          for (const querySet of querySets) checkpoint.search_cache[querySet.key] = { forms: querySet.forms, total_hits: counts.get(querySet.key) ?? 0, context_refs: null };
        } catch (error) {
          const failure = safeSqliteFailure(error);
          failures += querySets.length;
          for (const querySet of querySets) checkpoint.search_cache[querySet.key] = { forms: querySet.forms, total_hits: null, failure };
        }
      }
      const fresh = new Set(querySets.map((item) => item.key));
      for (const { sense } of rows) {
        const forms = searchForms(sense);
        if (forms.length === 0) {
          sense.search = { status: 'UNSEARCHABLE', total_hits: null, query_key: null, failure: null };
          sense.status = 'UNSEARCHABLE';
          continue;
        }
        const queryKey = searchCacheKey(checkpoint, forms);
        const cached = checkpoint.search_cache[queryKey];
        if (cached?.failure) {
          markSearchFailed(sense, queryKey, cached.failure);
          continue;
        }
        if (!fresh.has(queryKey)) cacheHits += 1;
        const recorded = ['DISCOVERED', 'NO_VERIFIED', 'INCOMPLETE', 'OUTPUT'].includes(sense.status);
        if (recorded && sense.search?.query_key && sense.search.query_key !== queryKey) {
          fail(`search forms changed after the result for ${sense.sense_id} was recorded; preserve the checkpoint and initialize a new one`);
        }
        const totalHits = cached.total_hits;
        sense.search = { status: totalHits === 0 ? 'ZERO_HITS' : 'COUNTED', total_hits: totalHits, query_key: queryKey, failure: null };
        if (!recorded) sense.status = totalHits === 0 ? 'ZERO_HITS' : 'SEARCHED';
      }
      checkpoint.stats.records_scanned += Math.min(start + 25, checkpoint.records.length) - start;
    }
  } finally {
    database?.close();
  }
  checkpoint.stats.cache_hits += cacheHits;
  await writeJsonAtomic(checkpointFile, checkpoint);
  return {
    contract: CORPUS_CONTEXT_CONTRACT,
    status: failures > 0 ? 'INCOMPLETE' : 'SEARCHED',
    query_calls: newCountQueries,
    cache_hits: cacheHits,
    failed_queries: failures,
    elapsed_ms: Number((performance.now() - started).toFixed(1)),
    checkpoint: checkpointSummary(checkpoint),
  };
}

function findSense(checkpoint, senseId) {
  for (const record of checkpoint.records) {
    const sense = record.senses.find((item) => item.sense_id === senseId);
    if (sense) return { record, sense };
  }
  fail(`sense_id ${JSON.stringify(senseId)} is not in this checkpoint`);
}

function integerOption(value, fallback, min, max, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`${label} must be an integer in [${min}, ${max}]`);
  return parsed;
}

/**
 * Print the Canonical gloss and the first contexts of the next SEARCHED senses in one response, packed
 * up to the response budget. With `senseId` it pages further contexts of that sense. Read-only apart
 * from caching the context locators once.
 */
export async function readCorpusContexts({ databasePath, checkpointPath, senseId, offset, count, scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  await assertIndexUnchanged(checkpoint, databasePath);
  const start = integerOption(offset, 0, 0, CORPUS_CONTEXT_LIMIT - 1, 'offset');
  const size = integerOption(count, CORPUS_CONTEXT_PAGE_SIZE, 1, CORPUS_CONTEXT_PAGE_SIZE, 'count');
  if ((offset !== undefined || count !== undefined) && !senseId) fail('--offset and --count require --sense-id');
  const pending = senseRows(checkpoint).filter(({ sense }) => sense.status === 'SEARCHED');
  let targets = pending;
  if (senseId) {
    const target = findSense(checkpoint, senseId);
    if (target.sense.search?.status !== 'COUNTED') fail(`sense ${senseId} has no countable search result (${target.sense.status}); run scan or use submit only after reading contexts`);
    targets = [target];
  }
  const database = openCorpusIndex(databasePath).database;
  const entries = [];
  let used = 0;
  let dirty = false;
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const hasBigram = inspectShortIndex(database).available;
    let refsStatement;
    const pageStatement = database.prepare(CONTEXT_PAGE_SQL);
    for (const { record, sense } of targets) {
      const cached = checkpoint.search_cache[sense.search.query_key];
      if (!cached || cached.total_hits !== sense.search.total_hits) fail(`search cache is missing for ${sense.sense_id}; run scan again`);
      if (!Array.isArray(cached.context_refs)) {
        refsStatement ??= database.prepare(contextRefsSql(hasBigram));
        const rows = refsStatement.all(JSON.stringify([{ key: sense.search.query_key, forms: cached.forms }]), CORPUS_CONTEXT_LIMIT, CORPUS_CONTEXT_LIMIT);
        cached.context_refs = rows.map((row) => ({ paragraph_rowid: Number(row.paragraph_rowid), matched_forms: String(row.matched_forms ?? '').split(',').filter(Boolean).sort(compare) }));
        dirty = true;
      }
      const refs = cached.context_refs.slice(0, CORPUS_CONTEXT_LIMIT);
      const page = refs.slice(start, start + size);
      if (page.length === 0) {
        if (senseId) fail('no further contexts are available for this sense');
        continue;
      }
      const rows = pageStatement.all(JSON.stringify(page.map((ref) => ({ paragraph_rowid: ref.paragraph_rowid }))));
      if (rows.length !== page.length) fail('context locator mapping changed; run preflight and initialize a new checkpoint');
      const entry = {
        record_id: record.record_id,
        sense_id: sense.sense_id,
        lemma: record.lemma,
        pos: sense.pos,
        gloss: sense.gloss,
        total_hits: sense.search.total_hits,
        contexts: rows.map((row, index) => ({ id: page[index].paragraph_rowid, text: excerptAround(row.form, page[index].matched_forms) })),
        more: start + page.length < refs.length,
      };
      const length = JSON.stringify(entry).length;
      if (entries.length > 0 && used + length > CORPUS_RESPONSE_LIMIT) break;
      used += length;
      entries.push(entry);
    }
  } finally {
    database.close();
  }
  if (dirty) await writeJsonAtomic(checkpointFile, checkpoint);
  return {
    contract: CORPUS_CONTEXT_CONTRACT,
    returned: entries.length,
    remaining_searched: senseId ? null : pending.length - entries.length,
    senses: entries,
  };
}

/** Add one human-selected query form before the sense is scanned. */
export async function addCorpusSearchForm(checkpointPath, { senseId, form, basis }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  const normalizedForm = typeof form === 'string' ? form.normalize('NFC').trim() : '';
  if (!normalizedForm || typeof basis !== 'string' || basis.trim().length < 4) fail('form and a brief source-bound basis are required');
  if (['COUNTED', 'ZERO_HITS'].includes(sense.search?.status) || ['DISCOVERED', 'NO_VERIFIED', 'INCOMPLETE', 'OUTPUT'].includes(sense.status)) fail('add search forms before scanning this sense');
  if (searchForms(sense).includes(normalizedForm)) return { status: 'UNCHANGED', sense_id: senseId, form: normalizedForm };
  sense.added_forms.push({ form: normalizedForm, basis: basis.trim() });
  sense.search = null;
  sense.status = 'PENDING';
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: 'ADDED', sense_id: senseId, form: normalizedForm, form_count: searchForms(sense).length };
}

function parseSubmission(entry, index, checkpoint) {
  const label = typeof entry?.sense_id === 'string' ? entry.sense_id : `#${index + 1}`;
  const problem = (message) => ({ error: `${label}: ${message}` });
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return problem('entry must be an object');
  const extra = Object.keys(entry).filter((key) => !SUBMIT_KEYS.has(key));
  if (extra.length > 0) return problem(`unsupported field(s) ${extra.join(', ')}`);
  let found;
  try { found = findSense(checkpoint, entry.sense_id); } catch (error) { return problem(error.message); }
  const { sense } = found;
  if (sense.search?.status !== 'COUNTED') return problem(`has no successful search with contexts (${sense.status}); it cannot be submitted`);
  const status = SUBMIT_STATUSES[entry.status];
  if (!status) return problem('status must be discovered, no_verified, or incomplete');
  const refs = checkpoint.search_cache[sense.search.query_key]?.context_refs;
  if (!Array.isArray(refs)) return problem('contexts were not read yet; run read first');
  const allowed = new Set(refs.slice(0, CORPUS_CONTEXT_LIMIT).map((ref) => ref.paragraph_rowid));
  const lists = {};
  for (const key of ['verified', 'rejected', 'ambiguous']) {
    const list = entry[key] === undefined ? [] : entry[key];
    if (!Array.isArray(list) || list.some((id) => !allowed.has(id)) || new Set(list).size !== list.length) return problem(`${key} must list distinct context ids returned for this sense`);
    lists[key] = list;
  }
  if (new Set([...lists.verified, ...lists.rejected, ...lists.ambiguous]).size !== lists.verified.length + lists.rejected.length + lists.ambiguous.length) return problem('a context id may appear in only one of verified, rejected, ambiguous');
  if (entry.candidates !== undefined && !Array.isArray(entry.candidates)) return problem('candidates must be an array of strings');
  const candidates = [];
  const seen = new Set();
  for (const candidate of entry.candidates ?? []) {
    if (typeof candidate !== 'string' || candidate.trim() !== candidate || candidate.length === 0) return problem('candidates must be non-empty trimmed strings');
    const normalized = normalizeCandidate(candidate);
    if (!seen.has(normalized)) { seen.add(normalized); candidates.push(candidate.normalize('NFC')); }
  }
  if (status === 'DISCOVERED' && lists.verified.length === 0) return problem('discovered requires at least one verified context');
  if (status === 'NO_VERIFIED' && (lists.verified.length > 0 || lists.rejected.length === 0 || lists.ambiguous.length > 0 || candidates.length > 0)) return problem('no_verified requires rejected contexts only, with no verified, ambiguous, or candidates');
  if (candidates.length > 0 && lists.verified.length === 0) return problem('candidates require at least one verified context');
  return { sense, value: { ...lists, candidates, status } };
}

/** Record the AI's source-sense reading and final candidates for many senses in one save. */
export async function submitCorpusResults(checkpointPath, entries, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) fail('submission must be a non-empty list of sense results');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const errors = [];
  const accepted = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const parsed = parseSubmission(entry, index, checkpoint);
    if (!parsed.error && seen.has(entry.sense_id)) parsed.error = `${entry.sense_id}: sense_id appears more than once`;
    if (parsed.error) errors.push(parsed.error);
    else { seen.add(entry.sense_id); accepted.push(parsed); }
  }
  if (errors.length > 0) return { status: 'REJECTED', recorded: 0, errors: errors.slice(0, 20), error_count: errors.length };
  for (const { sense, value } of accepted) {
    const { status, ...result } = value;
    Object.assign(sense, result, { status });
  }
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: 'RECORDED', recorded: accepted.length, remaining_searched: senseRows(checkpoint).filter(({ sense }) => sense.status === 'SEARCHED').length };
}

/** Bounded summary and optional queue page; never serializes the full checkpoint. */
export async function reportCorpusCheckpoint(checkpointPath, { status, offset = 0, limit = 50 } = {}, options = {}) {
  const { checkpoint } = await loadCorpusCheckpoint(checkpointPath, options);
  if (status === undefined) return { contract: CORPUS_CONTEXT_CONTRACT, checkpoint: checkpointSummary(checkpoint) };
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) fail('queue offset must be a non-negative integer');
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_QUEUE_LIMIT) fail(`queue limit must be in [1, ${MAX_QUEUE_LIMIT}]`);
  const queue = senseRows(checkpoint).filter(({ sense }) => sense.status === status)
    .map(({ record, sense }) => ({ record_id: record.record_id, sense_id: sense.sense_id, lemma: record.lemma, status: sense.status, total_hits: sense.search?.total_hits ?? null, candidates: senseCandidates(sense).length }));
  const items = queue.slice(parsedOffset, parsedOffset + parsedLimit);
  const hasMore = parsedOffset + items.length < queue.length;
  return { status: 'READY', state_filter: status, total_count: queue.length, offset: parsedOffset, returned: items.length, has_more: hasMore, next_offset: hasMore ? parsedOffset + items.length : null, items };
}

function validateEvidence(checkpoint, rows, canonicalRows) {
  const canonicalById = new Map(canonicalRows.map((row) => [row.id, row]));
  const byRecord = new Map(rows.map((row) => [row.record_id, row]));
  for (const record of checkpoint.records) {
    const canonical = canonicalById.get(record.record_id);
    const row = byRecord.get(record.record_id);
    if (!canonical || !row) return { message: `Candidate row does not map to the checkpoint Canonical record ${record.record_id}`, record_id: record.record_id, sense_id: null, candidate: null };
    for (const sense of record.senses) {
      if (!canonical.senses.some((item) => item.id === sense.sense_id)) return { message: `checkpoint sense ${sense.sense_id} is not a sense of ${record.record_id}`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      const candidateSense = row.senses?.find((item) => item.sense_id === sense.sense_id);
      if (!candidateSense) return { message: `Candidate output is missing sense ${sense.sense_id}`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      if (!EXPORTABLE_STATUSES.has(sense.status)) {
        return { message: `sense ${sense.sense_id} is ${sense.status}; search it, read its contexts and submit its result before output`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      }
      if (candidateSense.candidates.length > 0 && !senseHasVerified(sense)) {
        return { message: `sense ${sense.sense_id} has candidates but no VERIFIED source-sense context`, record_id: record.record_id, sense_id: sense.sense_id, candidate: candidateSense.candidates[0] };
      }
    }
  }
  return null;
}

/** Validate one output against source-sense status and the complete shared Candidate v1 contract. */
export async function validateCorpusExport({ checkpointPath, canonicalPath, candidateRows, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const canonicalText = await readFile(canonicalPath, 'utf8');
  if (sha256(canonicalText) !== checkpoint.batch.canonical_sha256) fail('Canonical shard changed after checkpoint initialization');
  const canonicalRows = parseCanonicalShard(canonicalText, canonicalPath);
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const evidenceFailure = validateEvidence(checkpoint, candidateRows, canonicalRows);
  if (evidenceFailure) return { status: 'INVALID', message: evidenceFailure.message, affected: evidenceFailure, repair_scope: 'Correct only the reported record_id/sense_id/candidate, then run complete Candidate v1 validation again.' };
  try {
    const summary = validateCandidateBatch(canonicalRows, candidateRows, {
      batch: Number(checkpoint.batch.batch),
      canonicalLemmaForms,
      sourceName: canonicalPath,
      candidateName: `${checkpoint.batch.shard}_${checkpoint.batch.batch}_d_${checkpoint.batch.model}.jsonl`,
    });
    return { status: 'VALID', ...summary };
  } catch (error) {
    const line = Number(error.message.match(/(?:Candidate|\.jsonl):(\d+)/u)?.[1] ?? 0) || null;
    const row = line ? candidateRows[line - 1] : null;
    const canonical = line ? canonicalRows[(Number(checkpoint.batch.batch) - 1) * CANDIDATE_BATCH_SIZE + line - 1] : null;
    const candidate = row?.senses?.flatMap((item) => item.candidates ?? []).find((value) => error.message.includes(JSON.stringify(value))) ?? null;
    return { status: 'INVALID', error_type: error.name, message: error.message, affected: row ? { record_id: row.record_id, canonical_record_id: canonical?.id ?? null, sense_ids: row.senses?.map((item) => item.sense_id) ?? [], candidate, candidate_line: line } : null, repair_scope: 'Correct only the reported Candidate row/sense/candidate, then run complete Candidate v1 validation again.' };
  }
}

function candidateRowsFromCheckpoint(checkpoint) {
  return checkpoint.records.map((record) => ({
    record_id: record.record_id,
    senses: record.senses.map((sense) => ({ sense_id: sense.sense_id, candidates: [...senseCandidates(sense)] })),
  }));
}

function expectedOutputName(checkpoint) {
  return `${checkpoint.batch.shard}_${checkpoint.batch.batch}_d_${checkpoint.batch.model}.jsonl`;
}

function assertCandidateOutputPath(outputPath, checkpoint, repositoryDirectory, scratchDirectory) {
  const resolved = path.resolve(outputPath);
  const expected = path.resolve(repositoryDirectory, 'data/relation-candidates', checkpoint.batch.shard, expectedOutputName(checkpoint));
  const relativeScratch = path.relative(path.resolve(scratchDirectory), resolved);
  const inScratch = relativeScratch && relativeScratch !== '..' && !relativeScratch.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeScratch);
  if (resolved !== expected && !inScratch) fail(`Candidate output must be the expected repository file or stay under .warroom-scratch/: ${expectedOutputName(checkpoint)}`);
  return resolved;
}

/** Write the Candidate file after the single full Candidate v1 validation. */
export async function exportCorpusCandidates({ checkpointPath, canonicalPath, outputPath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  if (checkpoint.output) fail('this checkpoint already has output; preserve it and use a new checkpoint for another batch');
  if (path.basename(outputPath) !== expectedOutputName(checkpoint)) fail(`output filename must be ${expectedOutputName(checkpoint)}`);
  const rows = candidateRowsFromCheckpoint(checkpoint);
  const validation = await validateCorpusExport({ checkpointPath: checkpointFile, canonicalPath, candidateRows: rows, repositoryDirectory, scratchDirectory });
  if (validation.status !== 'VALID') fail(`${validation.message}${validation.affected ? ` (affected ${JSON.stringify(validation.affected)})` : ''}`);
  const resolvedOutput = assertCandidateOutputPath(outputPath, checkpoint, repositoryDirectory, scratchDirectory);
  try { await stat(resolvedOutput); fail('refusing to overwrite an existing Candidate output'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const serialized = serializeCandidateJsonl(rows);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(`${resolvedOutput}.${process.pid}.tmp`, serialized, { mode: 0o644 }).then(() => rename(`${resolvedOutput}.${process.pid}.tmp`, resolvedOutput));
  checkpoint.output = { file: path.basename(resolvedOutput), sha256: sha256(serialized), status: 'VALID', exported_at: new Date().toISOString() };
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: 'OUTPUT', file: path.basename(resolvedOutput), coverage: { records: validation.recordCount, senses: validation.senseCount, candidates: validation.candidateCount, empty_senses: validation.emptySenseCount } };
}

export async function validateExistingCorpusCandidates({ checkpointPath, canonicalPath, candidatePath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  if (path.basename(candidatePath) !== expectedOutputName(checkpoint)) fail(`candidate filename must be ${expectedOutputName(checkpoint)}`);
  const candidateText = await readFile(candidatePath, 'utf8');
  let validation;
  try {
    validation = await validateCorpusExport({ checkpointPath: checkpointFile, canonicalPath, candidateRows: parseCandidateJsonl(candidateText, candidatePath), repositoryDirectory, scratchDirectory });
  } catch (error) {
    validation = { status: 'INVALID', error_type: error.name, message: error.message, affected: null };
  }
  checkpoint.output = { ...(checkpoint.output ?? {}), file: path.basename(candidatePath), sha256: sha256(candidateText), validation_status: validation.status, stale: validation.status !== 'VALID', stale_reason: validation.status === 'VALID' ? null : validation.message };
  await writeJsonAtomic(checkpointFile, checkpoint);
  return validation;
}

/** Remove or replace one candidate in an existing Candidate file, then run the full validator. */
export async function patchCorpusCandidateFile({ checkpointPath, canonicalPath, candidatePath, recordId, senseId, action, candidate, replacement, reason, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  if (typeof reason !== 'string' || reason.trim().length < 3) fail('a concise correction reason is required');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  if (path.basename(candidatePath) !== expectedOutputName(checkpoint)) fail(`candidate filename must be ${expectedOutputName(checkpoint)}`);
  const resolvedCandidate = assertCandidateOutputPath(candidatePath, checkpoint, repositoryDirectory, scratchDirectory);
  const { sense } = findSense(checkpoint, senseId);
  if (action === 'replace' && !senseHasVerified(sense)) fail('replacement needs a sense with a VERIFIED source-sense context');
  const fileText = await readFile(resolvedCandidate, 'utf8');
  const mutation = patchCandidateRows(parseCandidateJsonl(fileText, resolvedCandidate), { recordId, senseId, action, candidate, replacement });
  const validation = await validateCorpusExport({ checkpointPath: checkpointFile, canonicalPath, candidateRows: mutation.rows, repositoryDirectory, scratchDirectory });
  const serialized = serializeCandidateJsonl(mutation.rows);
  const existingStat = await stat(resolvedCandidate);
  await writeFile(`${resolvedCandidate}.${process.pid}.tmp`, serialized, { mode: existingStat.mode & 0o777 }).then(() => rename(`${resolvedCandidate}.${process.pid}.tmp`, resolvedCandidate));
  checkpoint.output = { ...(checkpoint.output ?? {}), file: path.basename(resolvedCandidate), sha256: sha256(serialized), patched_at: new Date().toISOString(), stale: validation.status !== 'VALID', stale_reason: validation.status === 'VALID' ? null : validation.message, patch_history: [...(checkpoint.output?.patch_history ?? []), { ...mutation.patched, reason: reason.trim(), applied_at: new Date().toISOString() }] };
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: validation.status, patched: mutation.patched, validation };
}

export { checkpointSummary as summarizeCorpusCheckpoint };

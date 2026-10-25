import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
export const CORPUS_RESPONSE_LIMIT = 12_000;
export const CORPUS_RECORD_CHECKPOINT = 25;
export const CORPUS_CONTEXT_PAGE_SIZE = 4;
export const CORPUS_CONTEXT_LIMIT = 16;
export const CORPUS_SNIPPET_CHARS = 700;
const CORPUS_DISPLAY_LIMITS = Object.freeze({ paragraph_id: 100, title: 160, author: 100, category: 80, year: 40, form: 80, matched_forms: 8 });
export const CORPUS_SWEEP_LENSES = Object.freeze([
  'lexical',
  'action_role_tool',
  'scene_time_environment',
  'cause_effect_response',
  'contrast_sensation_metaphor',
]);

// These are the approved NIKL Written Corpus 2025 (1.0) logical input digests
// recorded in docs/corpus-index-design.md and the source-specific permission record.
export const APPROVED_WRITTEN_CORPUS = Object.freeze({
  source_manifest_sha256: '50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211',
  logical_row_sha256: 'c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd',
});

const DEFAULT_SCRATCH_DIRECTORY = '.warroom-scratch';
const SEARCH_CONTRACT = 'd-written-context-search-v1';
const MAX_QUEUE_LIMIT = 100;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    fail('cannot bind this checkpoint to a Git HEAD; run the command inside the prepared Typewriter worktree');
  }
}

async function procedureDigest() {
  const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    'scripts/relation/corpus-context.mjs',
    'scripts/relation/corpus-context-cli.mjs',
    'scripts/relation/literary-context.mjs',
    'scripts/relation/candidate-contract.mjs',
    'docs/relation-corpus-context.md',
    'docs/relation-factory.md',
    'tools/warroom/prompts/d.md',
  ];
  const inputs = [];
  for (const relativePath of files) {
    const contents = await readFile(path.join(repositoryDirectory, relativePath));
    inputs.push([relativePath, sha256(contents)]);
  }
  return sha256(JSON.stringify(inputs));
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
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
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
  const title = String(profile.title ?? '');
  const category = String(profile.category ?? '');
  return /문어|written corpus/iu.test(`${title}\n${category}`);
}

function inspectShortIndex(database) {
  const object = database.prepare("SELECT type FROM sqlite_schema WHERE name = 'paragraph_bigrams' LIMIT 1").get();
  if (!object) return { available: false };
  if (object.type !== 'table') fail('paragraph_bigrams exists but is not a table');
  const columns = new Set(database.prepare('PRAGMA table_info(paragraph_bigrams)').all().map((row) => row.name));
  if (!columns.has('gram') || !columns.has('paragraph_rowid')) fail('paragraph_bigrams must contain gram and paragraph_rowid columns');
  return { available: true };
}

/** Small read-only identity check for the approved NIKL written-corpus snapshot. */
export async function inspectWrittenCorpusIndex(databasePath, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  const inspected = await inspectCorpusIndex(databasePath, { scratchDirectory });
  if (inspected.index.source_manifest_sha256 !== APPROVED_WRITTEN_CORPUS.source_manifest_sha256
    || inspected.index.logical_row_sha256 !== APPROVED_WRITTEN_CORPUS.logical_row_sha256) {
    fail('corpus index does not match the approved NIKL Written Corpus 2025 (1.0) input and logical-row digests');
  }
  for (const field of ['schema_version', 'builder_version', 'index_version', 'sqlite_version']) {
    if (!inspected.index[field]) fail(`corpus index metadata is missing ${field}`);
  }

  const { database } = openCorpusIndex(databasePath);
  let profileCount = 0;
  let bigram;
  try {
    const profiles = database.prepare('SELECT DISTINCT title, distributor, category FROM source_files LIMIT 65').all();
    if (profiles.length === 0 || profiles.length > 64) fail('source profile count must be within [1, 64]');
    if (profiles.some((profile) => !isNiklDistributor(profile.distributor) || !isWrittenCorpusProfile(profile))) {
      fail('corpus source metadata does not identify only NIKL written-corpus material');
    }
    profileCount = profiles.length;
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
    search: {
      long_forms: 'FTS5 trigram literal with exact instr() verification',
      two_character_forms: bigram.available ? 'paragraph_bigrams postings with exact instr() verification' : 'bounded literal instr() fallback',
      one_character_forms: 'bounded literal instr() fallback',
      bigram_index: bigram.available,
      read_only: true,
    },
    limits: { response_chars: CORPUS_RESPONSE_LIMIT, record_checkpoint: CORPUS_RECORD_CHECKPOINT, page_size: CORPUS_CONTEXT_PAGE_SIZE, contexts_per_sense: CORPUS_CONTEXT_LIMIT, excerpt_chars: CORPUS_SNIPPET_CHARS },
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
  const [actual, expected] = await Promise.all([
    stat(resolvedPath, { bigint: true }),
    stat(checkpoint.index.path, { bigint: true }),
  ]);
  const actualIdentity = currentStatIdentity(actual);
  const expectedIdentity = checkpoint.index.file_identity;
  if (resolvedPath !== checkpoint.index.path || JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)
    || JSON.stringify(currentStatIdentity(expected)) !== JSON.stringify(expectedIdentity)) {
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
    sample_complete: false,
    sample_note: null,
    contexts: [],
    discoveries: [],
    candidate_reviews: [],
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
  const indexStat = currentStatIdentity(await stat(databaseRealPath, { bigint: true }));
  const head = gitHead();
  const checkpoint = {
    contract: CORPUS_CHECKPOINT_CONTRACT,
    batch: {
      shard: normalized.shard,
      batch: normalized.batch,
      model: normalizedModel,
      canonical_path: path.relative(repositoryDirectory, path.resolve(canonicalPath)),
      canonical_sha256: sha256(canonicalText),
      git_head: head,
      procedure_sha256: await procedureDigest(),
      initialized_at: new Date().toISOString(),
    },
    index: {
      path: databaseRealPath,
      file_identity: indexStat,
      database_sha256: indexCheck.database.sha256,
      source_manifest_sha256: indexCheck.index.source_manifest_sha256,
      logical_row_sha256: indexCheck.index.logical_row_sha256,
      schema_version: indexCheck.index.schema_version,
      builder_version: indexCheck.index.builder_version,
      index_version: indexCheck.index.index_version,
      sqlite_version: indexCheck.index.sqlite_version,
    },
    records: selected.map((record) => ({
      record_id: record.id,
      lemma: record.lemma,
      search_forms: Array.isArray(record.search_forms) ? [...record.search_forms] : [],
      senses: record.senses.map((sense) => makeSense(record, sense)),
    })),
    search_cache: {},
    output: null,
    stats: { count_queries: 0, context_id_queries: 0, context_page_queries: 0, cache_hits: 0, records_scanned: 0 },
  };
  await writeJsonAtomic(resolvedCheckpoint, checkpoint);
  return { status: 'READY', batch: { shard: normalized.shard, batch: normalized.batch, model: normalizedModel }, index: indexCheck.index, records: selected.length, senses: selected.reduce((sum, record) => sum + record.senses.length, 0) };
}

export async function loadCorpusCheckpoint(checkpointPath, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  const resolvedPath = assertScratchPath(checkpointPath, scratchDirectory);
  const checkpoint = JSON.parse(await readFile(resolvedPath, 'utf8'));
  if (checkpoint?.contract !== CORPUS_CHECKPOINT_CONTRACT || !Array.isArray(checkpoint.records) || !checkpoint.index?.path) fail('unsupported D corpus checkpoint contract');
  if (checkpoint.batch.procedure_sha256 !== await procedureDigest()) fail('D procedure files changed since checkpoint initialization; preserve the checkpoint and initialize a new batch checkpoint');
  return { checkpoint, path: resolvedPath };
}

function searchForms(sense) {
  return [...new Set([...sense.search_forms, ...sense.added_forms.map((entry) => entry.form)])].sort(compare);
}

function searchCacheKey(checkpoint, forms) {
  return sha256(JSON.stringify([
    SEARCH_CONTRACT,
    checkpoint.index.database_sha256,
    checkpoint.index.source_manifest_sha256,
    checkpoint.index.logical_row_sha256,
    forms,
    CORPUS_CONTEXT_LIMIT,
    CORPUS_SNIPPET_CHARS,
  ]));
}

function senseRows(checkpoint, recordStart, recordEnd) {
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

function countQuerySql(hasBigram) {
  const bigramBranch = hasBigram
    ? `UNION ALL
      SELECT q.search_key, p.paragraph_rowid
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
    SELECT q.search_key, paragraph_fts.rowid AS paragraph_rowid
    FROM long_forms q
    JOIN paragraph_fts ON paragraph_fts MATCH ('"' || replace(q.form, '"', '""') || '"')
    JOIN paragraphs p ON p.paragraph_rowid = paragraph_fts.rowid
    WHERE instr(p.form, q.form) > 0
    ${bigramBranch}
    UNION ALL
    SELECT q.search_key, p.paragraph_rowid
    FROM query_forms q
    JOIN paragraphs p ON instr(p.form, q.form) > 0
    WHERE ${literalCondition}
  )
  SELECT search_key, COUNT(DISTINCT paragraph_rowid) AS total_hits
  FROM raw_hits GROUP BY search_key`;
}

function contextRefsSql(hasBigram) {
  const bigramBranch = hasBigram
    ? `UNION ALL
      SELECT q.search_key, p.paragraph_rowid, q.form
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
    SELECT q.search_key, paragraph_fts.rowid AS paragraph_rowid, q.form
    FROM long_forms q
    JOIN paragraph_fts ON paragraph_fts MATCH ('"' || replace(q.form, '"', '""') || '"')
    JOIN paragraphs p ON p.paragraph_rowid = paragraph_fts.rowid
    WHERE instr(p.form, q.form) > 0
    ${bigramBranch}
    UNION ALL
    SELECT q.search_key, p.paragraph_rowid, q.form
    FROM query_forms q
    JOIN paragraphs p ON instr(p.form, q.form) > 0
    WHERE ${literalCondition}
  ), deduped AS (
    SELECT search_key, paragraph_rowid, group_concat(DISTINCT form) AS matched_forms
    FROM raw_hits GROUP BY search_key, paragraph_rowid
  ), ranked AS (
    SELECT h.search_key, h.paragraph_rowid, h.matched_forms, p.document_rowid,
      ROW_NUMBER() OVER (PARTITION BY h.search_key, p.document_rowid ORDER BY p.ordinal, p.paragraph_rowid) AS work_rank
    FROM deduped h JOIN paragraphs p ON p.paragraph_rowid = h.paragraph_rowid
  )
  SELECT r.search_key, r.paragraph_rowid, r.matched_forms,
    p.document_rowid, p.paragraph_id, p.ordinal, p.form,
    d.source_path, d.document_ordinal, d.title, d.author,
    sf.category, sf.year
  FROM ranked r
  JOIN paragraphs p ON p.paragraph_rowid = r.paragraph_rowid
  JOIN documents d ON d.document_rowid = p.document_rowid
  JOIN source_files sf ON sf.source_path = d.source_path
  WHERE r.work_rank <= ?
  ORDER BY r.work_rank, d.source_path, d.document_ordinal, p.ordinal, p.paragraph_rowid
  LIMIT ?`;
}

function contextPageSql() {
  return `SELECT CAST(json_extract(j.value, '$.paragraph_rowid') AS INTEGER) AS paragraph_rowid,
    p.paragraph_id, p.ordinal, p.form, d.document_rowid, d.source_path,
    d.document_ordinal, sf.category, sf.year
  FROM json_each(?) j
  JOIN paragraphs p ON p.paragraph_rowid = CAST(json_extract(j.value, '$.paragraph_rowid') AS INTEGER)
  JOIN documents d ON d.document_rowid = p.document_rowid
  JOIN source_files sf ON sf.source_path = d.source_path
  ORDER BY CAST(j.key AS INTEGER)`;
}

function excerptAround(text, forms, maxChars = CORPUS_SNIPPET_CHARS) {
  const matchAt = forms.map((form) => text.indexOf(form)).filter((at) => at >= 0).sort((left, right) => left - right)[0] ?? 0;
  const chars = [...text];
  if (chars.length <= maxChars) return { text, truncated: false };
  const matchIndex = [...text.slice(0, matchAt)].length;
  const start = Math.max(0, Math.min(chars.length - maxChars, matchIndex - Math.floor(maxChars / 2)));
  return { text: chars.slice(start, start + maxChars).join(''), truncated: true };
}

function boundedDisplayText(value, limit) {
  if (value === null || value === undefined) return { value: null, truncated: false };
  const characters = [...String(value)];
  return { value: characters.length <= limit ? characters.join('') : characters.slice(0, limit).join(''), truncated: characters.length > limit };
}

function publicContextResult(result) {
  const paragraphId = boundedDisplayText(result.paragraph_id, CORPUS_DISPLAY_LIMITS.paragraph_id);
  const title = boundedDisplayText(result.document_title, CORPUS_DISPLAY_LIMITS.title);
  const author = boundedDisplayText(result.document_author, CORPUS_DISPLAY_LIMITS.author);
  const category = boundedDisplayText(result.category, CORPUS_DISPLAY_LIMITS.category);
  const year = boundedDisplayText(result.year, CORPUS_DISPLAY_LIMITS.year);
  const forms = result.matched_forms.slice(0, CORPUS_DISPLAY_LIMITS.matched_forms).map((form) => boundedDisplayText(form, CORPUS_DISPLAY_LIMITS.form));
  return {
    ...result,
    paragraph_id: paragraphId.value,
    document_title: title.value,
    document_author: author.value,
    category: category.value,
    year: year.value,
    matched_forms: forms.map((item) => item.value),
    metadata_truncated: {
      paragraph_id: paragraphId.truncated,
      document_title: title.truncated,
      document_author: author.truncated,
      category: category.truncated,
      year: year.truncated,
      matched_forms: result.matched_forms.length > forms.length || forms.some((item) => item.truncated),
    },
  };
}

function locatorKey(checkpoint, paragraphRowId) {
  return sha256(JSON.stringify([checkpoint.index.database_sha256, Number(paragraphRowId)]));
}

function makeContextRef(row, checkpoint) {
  const workKey = sha256(JSON.stringify([row.source_path, Number(row.document_rowid)]));
  return {
    paragraph_rowid: Number(row.paragraph_rowid),
    locator_key: locatorKey(checkpoint, row.paragraph_rowid),
    work_key: workKey,
    paragraph_id: row.paragraph_id,
    matched_forms: String(row.matched_forms ?? '').split(',').filter(Boolean).sort(compare),
    category: row.category ?? null,
    year: row.year ?? null,
    document_title: row.title ?? null,
    document_author: row.author ?? null,
  };
}

function safeSqliteFailure(error) {
  const message = String(error?.message ?? error?.name ?? 'SQLite search failed').slice(0, 240);
  const busy = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/iu.test(`${error?.code ?? ''} ${message}`);
  return { kind: busy ? 'timeout' : 'sqlite', message };
}

function refreshSenseState(sense) {
  if (!sense.search) return sense.status = 'PENDING';
  if (sense.search.status === 'UNSEARCHABLE' || sense.search.status === 'SEARCH_FAILED' || sense.search.status === 'ZERO_HITS') {
    return sense.status = sense.search.status;
  }
  if (sense.contexts.some((context) => context.judgment === 'PENDING')) return sense.status = sense.sample_complete ? 'INCOMPLETE' : 'SEARCHED';
  if (!sense.sample_complete) return sense.status = 'INCOMPLETE';
  const verified = sense.contexts.filter((context) => context.judgment === 'VERIFIED');
  if (verified.length === 0) {
    const staleDiscovery = sense.discoveries.some((item) => {
      const context = sense.contexts.find((entry) => entry.locator_key === item.locator_key);
      return !context || context.judgment !== 'VERIFIED' || !context.explorations[String(item.pass)]?.results?.[item.lens]?.some((candidate) => normalizeCandidate(candidate) === normalizeCandidate(item.candidate));
    });
    if (staleDiscovery) return sense.status = 'INCOMPLETE';
    const allConfirmedMismatches = sense.contexts.length > 0
      && sense.contexts.every((context) => context.judgment === 'REJECTED' && context.mismatch_confirmed === true);
    return sense.status = allConfirmedMismatches ? 'NO_VERIFIED' : 'INCOMPLETE';
  }
  if (verified.some((context) => !context.explorations['1'])) return sense.status = 'INSPECTED';
  if (verified.some((context) => context.explorations['2']?.incomplete)) return sense.status = 'INCOMPLETE';
  const discoveries = sense.discoveries;
  if (discoveries.some((item) => {
    const context = sense.contexts.find((entry) => entry.locator_key === item.locator_key);
    return !context || context.judgment !== 'VERIFIED' || !context.explorations[String(item.pass)]?.results?.[item.lens]?.some((candidate) => normalizeCandidate(candidate) === normalizeCandidate(item.candidate));
  })) return sense.status = 'INSPECTED';
  if (discoveries.some((item) => !sense.candidate_reviews.some((review) => review.normalized === normalizeCandidate(item.candidate)))) {
    return sense.status = 'INSPECTED';
  }
  return sense.status = 'DISCOVERED';
}

function parsePageSize(value) {
  const size = value === undefined ? CORPUS_CONTEXT_PAGE_SIZE : Number(value);
  if (!Number.isInteger(size) || size < 1 || size > CORPUS_CONTEXT_PAGE_SIZE) fail(`page-size must be an integer in [1, ${CORPUS_CONTEXT_PAGE_SIZE}]`);
  return size;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor, cacheKey) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail('page cursor is invalid'); }
  if (parsed?.cache_key !== cacheKey || !Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > CORPUS_CONTEXT_LIMIT) {
    fail('page cursor does not match this search result and checkpoint');
  }
  return parsed.offset;
}

function checkpointSummary(checkpoint) {
  const totals = {};
  let senseCount = 0;
  let contextCount = 0;
  let candidateCount = 0;
  for (const record of checkpoint.records) {
    for (const sense of record.senses) {
      senseCount += 1;
      totals[sense.status] = (totals[sense.status] ?? 0) + 1;
      contextCount += sense.contexts.length;
      candidateCount += sense.candidate_reviews.filter((review) => review.decision === 'KEEP').length;
    }
  }
  return { records: checkpoint.records.length, senses: senseCount, statuses: totals, contexts: contextCount, kept_candidates: candidateCount, stats: { ...checkpoint.stats } };
}

/** Count a whole batch chunk with one prepared statement and one read-only SQLite connection. */
export async function scanCorpusBatch({ databasePath, checkpointPath, scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  await assertIndexUnchanged(checkpoint, databasePath);
  let database;
  const started = performance.now();
  try {
    database = openCorpusIndex(databasePath).database;
  } catch (error) {
    const failure = safeSqliteFailure(error);
    let failedQueries = 0;
    for (const { sense } of senseRows(checkpoint, 0, checkpoint.records.length)) {
      if (sense.search && sense.search.status !== 'SEARCH_FAILED') continue;
      const forms = searchForms(sense);
      if (forms.length === 0) {
        sense.search = { status: 'UNSEARCHABLE', forms_sha256: sha256(JSON.stringify(forms)), total_hits: null, query_key: null, searched_at: new Date().toISOString(), failure: null };
        sense.status = 'UNSEARCHABLE';
        continue;
      }
      sense.search = { status: 'SEARCH_FAILED', forms_sha256: sha256(JSON.stringify(forms)), total_hits: null, query_key: searchCacheKey(checkpoint, forms), searched_at: new Date().toISOString(), failure };
      sense.status = 'SEARCH_FAILED';
      failedQueries += 1;
    }
    await writeJsonAtomic(checkpointFile, checkpoint);
    return { contract: CORPUS_CONTEXT_CONTRACT, status: 'INCOMPLETE', batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch }, query_calls: 0, cache_hits: 0, failed_queries: failedQueries, elapsed_ms: Number((performance.now() - started).toFixed(1)), checkpoint: checkpointSummary(checkpoint) };
  }
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const hasBigram = inspectShortIndex(database).available;
    const countStatement = database.prepare(countQuerySql(hasBigram));
    let newCountQueries = 0;
    let cacheHits = 0;
    let failures = 0;
    for (let start = 0; start < checkpoint.records.length; start += CORPUS_RECORD_CHECKPOINT) {
      const end = Math.min(start + CORPUS_RECORD_CHECKPOINT, checkpoint.records.length);
      const rows = senseRows(checkpoint, start, end);
      const querySets = querySetRows(rows, checkpoint);
      let chunkCacheHits = 0;
      let counts = new Map();
      if (querySets.length > 0) {
        try {
          const results = countStatement.all(JSON.stringify(querySets));
          newCountQueries += 1;
          checkpoint.stats.count_queries += 1;
          counts = new Map(results.map((row) => [row.search_key, Number(row.total_hits)]));
          for (const querySet of querySets) checkpoint.search_cache[querySet.key] = {
            forms: querySet.forms,
            total_hits: counts.get(querySet.key) ?? 0,
            context_refs: null,
          };
        } catch (error) {
          const failure = safeSqliteFailure(error);
          failures += querySets.length;
          for (const querySet of querySets) checkpoint.search_cache[querySet.key] = { forms: querySet.forms, total_hits: null, failure };
        }
      }

      for (const { record, sense } of rows) {
        const forms = searchForms(sense);
        if (forms.length === 0) {
          sense.search = { status: 'UNSEARCHABLE', forms_sha256: sha256(JSON.stringify(forms)), total_hits: null, query_key: null, searched_at: new Date().toISOString(), failure: null };
          sense.status = 'UNSEARCHABLE';
          continue;
        }
        const queryKey = searchCacheKey(checkpoint, forms);
        const cached = checkpoint.search_cache[queryKey];
        if (cached?.failure) {
          sense.search = { status: 'SEARCH_FAILED', forms_sha256: sha256(JSON.stringify(forms)), total_hits: null, query_key: queryKey, searched_at: new Date().toISOString(), failure: cached.failure };
          sense.status = 'SEARCH_FAILED';
          continue;
        }
        if (!querySets.some((item) => item.key === queryKey)) chunkCacheHits += 1;
        const totalHits = cached?.total_hits ?? counts.get(queryKey) ?? 0;
        sense.search = { status: totalHits === 0 ? 'ZERO_HITS' : 'COUNTED', forms_sha256: sha256(JSON.stringify(forms)), total_hits: totalHits, query_key: queryKey, searched_at: new Date().toISOString(), failure: null };
        sense.status = totalHits === 0 ? 'ZERO_HITS' : 'SEARCHED';
      }
      cacheHits += chunkCacheHits;
      checkpoint.stats.cache_hits += chunkCacheHits;
      checkpoint.stats.records_scanned += end - start;
      await writeJsonAtomic(checkpointFile, checkpoint);
    }
    return {
      contract: CORPUS_CONTEXT_CONTRACT,
      status: failures > 0 ? 'INCOMPLETE' : 'SEARCHED',
      batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch },
      query_calls: newCountQueries,
      cache_hits: cacheHits,
      failed_queries: failures,
      elapsed_ms: Number((performance.now() - started).toFixed(1)),
      checkpoint: checkpointSummary(checkpoint),
    };
  } finally {
    database.close();
  }
}

function findSense(checkpoint, senseId) {
  for (const record of checkpoint.records) {
    const sense = record.senses.find((item) => item.sense_id === senseId);
    if (sense) return { record, sense };
  }
  fail(`sense_id ${JSON.stringify(senseId)} is not in this checkpoint`);
}

/** Return a bounded page of raw contexts. This never judges the source sense. */
export async function searchCorpusSense({ databasePath, checkpointPath, senseId, pageSize, cursor, scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  await assertIndexUnchanged(checkpoint, databasePath);
  const { record, sense } = findSense(checkpoint, senseId);
  if (!sense.search || sense.search.status === 'PENDING') fail('run scan before retrieving contexts for this sense');
  if (sense.search.status === 'SEARCH_FAILED') fail('retry scan after the recorded search failure before retrieving contexts');
  if (sense.search.status === 'UNSEARCHABLE') fail('this sense has no canonical or explicitly added search forms');
  if (sense.search.status === 'ZERO_HITS') return { status: 'ZERO_HITS', record_id: record.record_id, sense_id: senseId, total_hits: 0, returned: 0, has_more: false, truncated: false, next_cursor: null, results: [] };
  if (sense.contexts.length >= CORPUS_CONTEXT_LIMIT) fail(`the ${CORPUS_CONTEXT_LIMIT}-context per-sense cap is reached; record an explicit sample stop`);
  const size = parsePageSize(pageSize);
  const cacheKey = sense.search.query_key;
  const startOffset = cursor ? decodeCursor(cursor, cacheKey) : (sense.contexts.length === 0 ? 0 : fail('provide the next_cursor returned by the previous context page'));
  if (cursor && sense.search.next_cursor !== cursor) fail('page cursor is stale or does not match the saved checkpoint');
  if (startOffset !== sense.contexts.length) fail('page cursor does not continue after the saved contexts');

  const cachedSearch = checkpoint.search_cache[cacheKey];
  if (!cachedSearch || cachedSearch.total_hits !== sense.search.total_hits) fail('search cache is missing or does not match this sense result');
  let database;
  try {
    database = openCorpusIndex(databasePath).database;
    database.exec('PRAGMA busy_timeout = 5000');
    if (!Array.isArray(cachedSearch.context_refs)) {
      const hasBigram = inspectShortIndex(database).available;
      const refsStatement = database.prepare(contextRefsSql(hasBigram));
      const rows = refsStatement.all(JSON.stringify([{ key: cacheKey, forms: cachedSearch.forms }]), CORPUS_CONTEXT_LIMIT + 1, CORPUS_CONTEXT_LIMIT + 1);
      checkpoint.stats.context_id_queries += 1;
      cachedSearch.context_refs = rows.map((row) => makeContextRef(row, checkpoint));
    } else {
      checkpoint.stats.cache_hits += 1;
    }
    const pageRefs = cachedSearch.context_refs.slice(startOffset, startOffset + size);
    if (pageRefs.length === 0) fail('no further context rows are available for this sense');
    const pageRows = database.prepare(contextPageSql()).all(JSON.stringify(pageRefs.map((ref) => ({ paragraph_rowid: ref.paragraph_rowid }))));
    if (pageRows.length !== pageRefs.length) fail('context locator mapping changed; preserve the checkpoint and re-run index preflight');
    checkpoint.stats.context_page_queries += 1;
    const results = pageRows.map((row, index) => {
      const reference = pageRefs[index];
      const excerpt = excerptAround(row.form, reference.matched_forms);
      return {
        ...reference,
        excerpt: excerpt.text,
        excerpt_truncated: excerpt.truncated,
        _private: { paragraph_text: row.form },
      };
    });
    for (const result of results) {
      if (!sense.contexts.some((context) => context.locator_key === result.locator_key)) {
        sense.contexts.push({
          locator_key: result.locator_key,
          paragraph_rowid: result.paragraph_rowid,
          work_key: result.work_key,
          paragraph_id: result.paragraph_id,
          matched_forms: result.matched_forms,
          category: result.category,
          year: result.year,
          document_title: result.document_title,
          document_author: result.document_author,
          paragraph_sha256: sha256(result._private.paragraph_text),
          paragraph_text: result._private.paragraph_text,
          excerpt: result.excerpt,
          excerpt_truncated: result.excerpt_truncated,
          judgment: 'PENDING',
          mismatch_confirmed: false,
          judgment_note: null,
          explorations: {},
        });
      }
    }
    const nextOffset = startOffset + results.length;
    const contextCeiling = Math.min(sense.search.total_hits, CORPUS_CONTEXT_LIMIT);
    const hasMore = nextOffset < contextCeiling;
    sense.search.pages = (sense.search.pages ?? 0) + 1;
    sense.search.returned_contexts = sense.contexts.length;
    sense.search.next_cursor = hasMore ? encodeCursor({ cache_key: cacheKey, offset: nextOffset }) : null;
    sense.search.truncated = sense.search.total_hits > nextOffset;
    if (sense.search.total_hits <= nextOffset) sense.sample_complete = true;
    refreshSenseState(sense);
    await writeJsonAtomic(checkpointFile, checkpoint);
    return {
      contract: CORPUS_CONTEXT_CONTRACT,
      record_id: record.record_id,
      sense_id: sense.sense_id,
      status: sense.status,
      total_hits: sense.search.total_hits,
      inspected_contexts: sense.contexts.length,
      returned: results.length,
      has_more: hasMore,
      truncated: sense.search.truncated,
      limit_reached: !hasMore && sense.search.total_hits > nextOffset,
      next_cursor: sense.search.next_cursor,
      results: results.map(({ _private, paragraph_rowid, ...result }) => publicContextResult(result)),
    };
  } catch (error) {
    if (error.message.startsWith('no further context')) throw error;
    const failure = safeSqliteFailure(error);
    sense.search.status = 'SEARCH_FAILED';
    sense.search.failure = failure;
    sense.status = 'SEARCH_FAILED';
    await writeJsonAtomic(checkpointFile, checkpoint);
    throw error;
  } finally {
    database?.close();
  }
}

/** Add one human-selected query form before any context has been retrieved. */
export async function addCorpusSearchForm(checkpointPath, { senseId, form, basis }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  const normalizedForm = typeof form === 'string' ? form.normalize('NFC').trim() : '';
  if (!normalizedForm || typeof basis !== 'string' || basis.trim().length < 4) fail('form and a brief source-bound basis are required');
  if (sense.contexts.length > 0 || sense.search?.status === 'COUNTED' || sense.search?.status === 'ZERO_HITS') fail('add search forms before scanning or retrieving contexts');
  if (searchForms(sense).includes(normalizedForm)) return { status: 'UNCHANGED', sense_id: senseId, form: normalizedForm };
  sense.added_forms.push({ form: normalizedForm, basis: basis.trim() });
  sense.search = null;
  sense.status = 'PENDING';
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: 'ADDED', sense_id: senseId, form: normalizedForm, form_count: searchForms(sense).length };
}

function findContext(sense, locatorKey) {
  const context = sense.contexts.find((item) => item.locator_key === locatorKey);
  if (!context) fail(`locator_key ${JSON.stringify(locatorKey)} is not recorded for this exact source sense`);
  return context;
}

/** Store an explicit source-sense decision; the tool never infers VERIFIED or NO_VERIFIED. */
export async function reviewCorpusContext(checkpointPath, { senseId, locatorKey, judgment, note, mismatchConfirmed = false }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  if (!['VERIFIED', 'AMBIGUOUS', 'REJECTED'].includes(judgment)) fail('judgment must be VERIFIED, AMBIGUOUS, or REJECTED');
  if (typeof note !== 'string' || note.trim().length < 5) fail('a brief source-sense judgment note is required');
  if (judgment === 'REJECTED' && mismatchConfirmed !== true) fail('REJECTED requires explicit confirmation that the exact source-sense meaning mismatches this context');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  const context = findContext(sense, locatorKey);
  context.judgment_history ??= [];
  if (context.judgment) context.judgment_history.push({ judgment: context.judgment, mismatch_confirmed: context.mismatch_confirmed, note: context.judgment_note, changed_at: new Date().toISOString() });
  context.judgment = judgment;
  context.mismatch_confirmed = judgment === 'REJECTED' && mismatchConfirmed === true;
  context.judgment_note = note.trim();
  refreshSenseState(sense);
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: sense.status, record_id: findSense(checkpoint, senseId).record.record_id, sense_id: senseId, locator_key: locatorKey, judgment };
}

function validateSweepResults(results) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) fail('exploration results must be a JSON object');
  if (Object.keys(results).sort().join('\0') !== [...CORPUS_SWEEP_LENSES].sort().join('\0')) fail(`exploration must contain exactly these five lenses: ${CORPUS_SWEEP_LENSES.join(', ')}`);
  for (const lens of CORPUS_SWEEP_LENSES) {
    if (!Array.isArray(results[lens]) || results[lens].some((candidate) => typeof candidate !== 'string' || candidate.trim() !== candidate || candidate.length === 0)) {
      fail(`${lens} must be an array of non-empty trimmed candidate strings`);
    }
  }
}

/** Record one integrated five-lens pass and optional independently reread second pass. */
export async function recordCorpusExploration(checkpointPath, { senseId, locatorKey, pass, results, independentRead = false, note = '' }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  if (![1, 2].includes(Number(pass))) fail('pass must be 1 or 2');
  const passNumber = Number(pass);
  validateSweepResults(results);
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  const context = findContext(sense, locatorKey);
  if (context.judgment !== 'VERIFIED') fail('only an explicitly VERIFIED context can be explored');
  if (passNumber === 1 && context.explorations['1']) fail('pass 1 is already recorded; preserve the checkpoint');
  if (passNumber === 2 && !context.explorations['1']) fail('optional pass 2 requires the integrated pass 1 first');
  if (passNumber === 2 && context.explorations['2']) fail('optional pass 2 is already recorded; preserve the checkpoint');
  if (passNumber === 2 && independentRead !== true) fail('optional pass 2 requires an independent-read attestation');
  if (passNumber === 2 && (typeof note !== 'string' || note.trim().length < 5)) fail('optional pass 2 needs a brief reason for re-reading this context');
  const normalizedResults = Object.fromEntries(CORPUS_SWEEP_LENSES.map((lens) => [lens, [...new Set(results[lens].map((candidate) => candidate.normalize('NFC').trim()))]]));
  context.explorations[String(passNumber)] = {
    results: normalizedResults,
    independent_read: passNumber === 2,
    note: passNumber === 2 ? note.trim() : null,
    recorded_at: new Date().toISOString(),
  };
  for (const lens of CORPUS_SWEEP_LENSES) {
    for (const candidate of normalizedResults[lens]) {
      if (!sense.discoveries.some((item) => item.locator_key === locatorKey && item.pass === passNumber && item.lens === lens && normalizeCandidate(item.candidate) === normalizeCandidate(candidate))) {
        sense.discoveries.push({ locator_key: locatorKey, pass: passNumber, lens, candidate });
      }
    }
  }
  refreshSenseState(sense);
  await writeJsonAtomic(checkpointFile, checkpoint);
  return {
    status: sense.status,
    sense_id: senseId,
    locator_key: locatorKey,
    pass: passNumber,
    lens_counts: Object.fromEntries(CORPUS_SWEEP_LENSES.map((lens) => [lens, normalizedResults[lens].length])),
    candidates_discovered: sense.discoveries.length,
  };
}

function uniqueDiscovered(sense) {
  const byNormalized = new Map();
  for (const discovery of sense.discoveries) {
    const normalized = normalizeCandidate(discovery.candidate);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, { candidate: discovery.candidate, normalized });
  }
  return [...byNormalized.values()];
}

/** Apply a human form-gate decision to an exact source-sense candidate. */
export async function reviewCorpusCandidate(checkpointPath, { senseId, candidate, decision, kind = 'word', note }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  if (!['KEEP', 'REMOVE'].includes(decision)) fail('decision must be KEEP or REMOVE');
  if (typeof candidate !== 'string' || candidate.trim() !== candidate || candidate.length === 0) fail('candidate must be an exact non-empty string');
  if (decision === 'KEEP' && !['word', 'phrase'].includes(kind)) fail('KEEP kind must be word or phrase');
  if (typeof note !== 'string' || note.trim().length < 5) fail('a brief form-gate note is required');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  const normalized = normalizeCandidate(candidate);
  const discoveries = sense.discoveries.filter((item) => normalizeCandidate(item.candidate) === normalized);
  if (discoveries.length === 0) fail('candidate was not found in an integrated exploration of this exact source sense');
  for (const discovery of discoveries) {
    const context = findContext(sense, discovery.locator_key);
    if (context.judgment !== 'VERIFIED' || !context.explorations[String(discovery.pass)]?.results?.[discovery.lens]?.some((value) => normalizeCandidate(value) === normalized)) {
      fail('candidate evidence does not point to its current VERIFIED context and recorded exploration');
    }
  }
  const previous = sense.candidate_reviews.find((item) => item.normalized === normalized);
  const review = { candidate, normalized, decision, kind: decision === 'KEEP' ? kind : null, note: note.trim(), reviewed_at: new Date().toISOString() };
  if (previous) Object.assign(previous, review);
  else sense.candidate_reviews.push(review);
  refreshSenseState(sense);
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: sense.status, sense_id: senseId, ...review, evidence_contexts: discoveries.length };
}

/** Record a conscious adaptive-search stop. Incomplete or ambiguous senses remain incomplete. */
export async function finishCorpusSearch(checkpointPath, { senseId, note }, { scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) } = {}) {
  if (typeof note !== 'string' || note.trim().length < 5) fail('a brief adaptive-sampling stop reason is required');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  const { sense } = findSense(checkpoint, senseId);
  if (!sense.search || sense.search.status !== 'COUNTED') fail('finish-search requires a successful, current search result');
  if (sense.contexts.some((context) => context.judgment === 'PENDING')) fail('judge every returned context before recording the sampling stop');
  if (sense.contexts.length === 0) fail('finish-search requires at least one inspected context');
  sense.sample_complete = true;
  sense.sample_note = note.trim();
  sense.search.next_cursor = null;
  refreshSenseState(sense);
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: sense.status, sense_id: senseId, inspected_contexts: sense.contexts.length, remaining_hit_count: Math.max(0, sense.search.total_hits - sense.contexts.length), stop_reason_recorded: true };
}

/** Bounded summary and optional queue page; never serializes the full checkpoint. */
export async function reportCorpusCheckpoint(checkpointPath, { status, offset = 0, limit = 50 } = {}, options = {}) {
  const { checkpoint } = await loadCorpusCheckpoint(checkpointPath, options);
  if (status === undefined) return { contract: CORPUS_CONTEXT_CONTRACT, checkpoint: checkpointSummary(checkpoint) };
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) fail('queue offset must be a non-negative integer');
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_QUEUE_LIMIT) fail(`queue limit must be in [1, ${MAX_QUEUE_LIMIT}]`);
  const queue = checkpoint.records.flatMap((record) => record.senses.map((sense) => ({ record_id: record.record_id, sense_id: sense.sense_id, lemma: record.lemma, status: sense.status, search_status: sense.search?.status ?? 'PENDING', total_hits: sense.search?.total_hits ?? null, contexts: sense.contexts.length, candidates: sense.candidate_reviews.length })))
    .filter((item) => item.status === status || item.search_status === status);
  const items = queue.slice(parsedOffset, parsedOffset + parsedLimit);
  const hasMore = parsedOffset + items.length < queue.length;
  return { status: 'READY', state_filter: status, total_count: queue.length, offset: parsedOffset, returned: items.length, has_more: hasMore, truncated: hasMore, next_offset: hasMore ? parsedOffset + items.length : null, items };
}

function validateEvidence(checkpoint, rows, canonicalRows) {
  const byRecord = new Map(rows.map((row) => [row.record_id, row]));
  for (const record of checkpoint.records) {
    const canonical = canonicalRows.find((item) => item.id === record.record_id);
    const row = byRecord.get(record.record_id);
    if (!canonical || !row) return { message: `Candidate row does not map to the checkpoint Canonical record ${record.record_id}`, record_id: record.record_id, sense_id: null, candidate: null };
    for (const sense of record.senses) {
      if (!canonical.senses.some((item) => item.id === sense.sense_id)) return { message: `checkpoint sense ${sense.sense_id} is not a sense of ${record.record_id}`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      const candidateSense = row.senses?.find((item) => item.sense_id === sense.sense_id);
      if (!candidateSense) return { message: `Candidate output is missing sense ${sense.sense_id}`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      if (!['ZERO_HITS', 'NO_VERIFIED', 'DISCOVERED', 'OUTPUT'].includes(sense.status)) {
        return { message: `sense ${sense.sense_id} is ${sense.status}; finish search, exact source-sense review, exploration and form decisions before output`, record_id: record.record_id, sense_id: sense.sense_id, candidate: null };
      }
      const expected = sense.candidate_reviews.filter((item) => item.decision === 'KEEP');
      const expectedByForm = new Map(expected.map((item) => [item.normalized, item]));
      const actual = candidateSense.candidates;
      for (const value of actual) {
        const normalized = normalizeCandidate(value);
        const review = expectedByForm.get(normalized);
        if (!review || review.candidate !== value) return { message: `candidate ${JSON.stringify(value)} on ${sense.sense_id} has no exact current KEEP disposition`, record_id: record.record_id, sense_id: sense.sense_id, candidate: value };
        const discoveries = sense.discoveries.filter((item) => normalizeCandidate(item.candidate) === normalized);
        if (discoveries.length === 0 || discoveries.some((item) => {
          const context = sense.contexts.find((entry) => entry.locator_key === item.locator_key);
          return !context || context.judgment !== 'VERIFIED' || !context.explorations[String(item.pass)]?.results?.[item.lens]?.some((candidate) => normalizeCandidate(candidate) === normalized);
        })) return { message: `candidate ${JSON.stringify(value)} on ${sense.sense_id} has a locator that does not bind to its VERIFIED source sense`, record_id: record.record_id, sense_id: sense.sense_id, candidate: value };
        expectedByForm.delete(normalized);
      }
      if (expectedByForm.size > 0) {
        const missing = expectedByForm.values().next().value;
        return { message: `KEEP candidate ${JSON.stringify(missing.candidate)} on ${sense.sense_id} is missing from Candidate output`, record_id: record.record_id, sense_id: sense.sense_id, candidate: missing.candidate };
      }
    }
  }
  return null;
}

/** Validate one output against source evidence and the complete shared Candidate v1 contract. */
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
    senses: record.senses.map((sense) => ({
      sense_id: sense.sense_id,
      candidates: sense.candidate_reviews.filter((review) => review.decision === 'KEEP').map((review) => review.candidate),
    })),
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
  checkpoint.output = { file: path.basename(resolvedOutput), sha256: sha256(serialized), status: 'VALID', exported_at: new Date().toISOString(), coverage: validation };
  for (const record of checkpoint.records) for (const sense of record.senses) sense.status = 'OUTPUT';
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

export async function patchCorpusCandidateFile({ checkpointPath, canonicalPath, candidatePath, recordId, senseId, action, candidate, replacement, reason, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(DEFAULT_SCRATCH_DIRECTORY) }) {
  if (typeof reason !== 'string' || reason.trim().length < 3) fail('a concise correction reason is required');
  const { checkpoint, path: checkpointFile } = await loadCorpusCheckpoint(checkpointPath, { scratchDirectory });
  if (path.basename(candidatePath) !== expectedOutputName(checkpoint)) fail(`candidate filename must be ${expectedOutputName(checkpoint)}`);
  const resolvedCandidate = assertCandidateOutputPath(candidatePath, checkpoint, repositoryDirectory, scratchDirectory);
  const { sense } = findSense(checkpoint, senseId);
  const normalized = normalizeCandidate(candidate);
  const oldReview = sense.candidate_reviews.find((item) => item.normalized === normalized);
  if (!oldReview || oldReview.decision !== 'REMOVE') fail('patch target must have an explicit REMOVE form-gate decision');
  let normalizedReplacement = replacement;
  if (action === 'replace') {
    const replacementReview = sense.candidate_reviews.find((item) => item.normalized === normalizeCandidate(replacement));
    if (!replacementReview || replacementReview.decision !== 'KEEP') fail('replacement must have a KEEP form-gate decision and verified exploration evidence');
    normalizedReplacement = replacementReview.candidate;
  }
  const fileText = await readFile(resolvedCandidate, 'utf8');
  let rows = parseCandidateJsonl(fileText, resolvedCandidate);
  const mutation = patchCandidateRows(rows, { recordId, senseId, action, candidate, replacement: normalizedReplacement });
  rows = mutation.rows;
  const validation = await validateCorpusExport({ checkpointPath: checkpointFile, canonicalPath, candidateRows: rows, repositoryDirectory, scratchDirectory });
  const serialized = serializeCandidateJsonl(rows);
  const existingStat = await stat(resolvedCandidate);
  await writeFile(`${resolvedCandidate}.${process.pid}.tmp`, serialized, { mode: existingStat.mode & 0o777 }).then(() => rename(`${resolvedCandidate}.${process.pid}.tmp`, resolvedCandidate));
  checkpoint.output = { ...(checkpoint.output ?? {}), file: path.basename(resolvedCandidate), sha256: sha256(serialized), patched_at: new Date().toISOString(), stale: validation.status !== 'VALID', stale_reason: validation.status === 'VALID' ? null : validation.message, patch_history: [...(checkpoint.output?.patch_history ?? []), { ...mutation.patched, reason: reason.trim(), applied_at: new Date().toISOString() }] };
  await writeJsonAtomic(checkpointFile, checkpoint);
  return { status: validation.status, patched: mutation.patched, validation };
}

export { checkpointSummary as summarizeCorpusCheckpoint };

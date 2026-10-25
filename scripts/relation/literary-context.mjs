import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATE_BATCH_SIZE,
  loadCanonicalLemmaForms,
  normalizeCandidate,
  validateCandidateBatch,
} from './candidate-contract.mjs';

export const LITERARY_CONTEXT_CONTRACT = 'literary-context-v3';
export const CHECKPOINT_CONTRACT = 'literary-checkpoint-v3';
const LEGACY_CHECKPOINT_CONTRACT = 'literary-checkpoint-v2';
export const MAX_RESPONSE_CHARS = 40_000;
export const SWEEP_LENSES = Object.freeze([
  'image',
  'action',
  'emotion',
  'sensation',
  'scene_situation',
  'causality',
  'metaphor_contrast',
]);

const CHUNK_DEFAULT_SENSES = 12;
const CHUNK_DEFAULT_CONTEXTS = 8;
const CHUNK_RESPONSE_CHARS = 36_000;
const SHORT_KEY_LENGTH = 12;
const MAX_CONTEXTS_PER_SENSE = 16;
const DEFAULT_SNIPPET_CHARS = 700;
const MAX_SNIPPET_CHARS = 700;
const MAX_CONTEXT_PAGE_CHARS = 1000;
const INDEX_REQUIRED_TABLES = ['source_files', 'works', 'text_units', 'unit_fts', 'index_metadata'];
const LEGACY_INDEX_TABLES = ['documents', 'paragraphs', 'paragraph_fts'];
const CORPUS_INDEX_REQUIRED_TABLES = ['source_files', 'documents', 'paragraphs', 'paragraph_fts', 'index_metadata'];
const CONTEXT_WINDOW_UNITS = 2;
const CHECKPOINT_SCRATCH_DIRECTORY = '.warroom-scratch';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const codePointLength = (value) => [...value].length;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    fail('cannot bind C checkpoint to a Git HEAD; run this command inside the prepared Typewriter worktree');
  }
}

async function procedureDigest() {
  const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    'scripts/relation/literary-context.mjs',
    'scripts/relation/literary-context-cli.mjs',
    'docs/relation-literary-context.md',
    'docs/relation-factory.md',
    'tools/warroom/prompts/c.md',
  ];
  const inputs = [];
  for (const relativePath of files) {
    const contents = await readFile(path.join(repositoryDirectory, relativePath));
    inputs.push([relativePath, sha256(contents)]);
  }
  return sha256(JSON.stringify(inputs));
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all();
}

function assertColumns(database, table, expected) {
  const columns = tableColumns(database, table);
  const names = new Set(columns.map((row) => row.name));
  const missing = expected.filter((column) => !names.has(column));
  if (missing.length > 0) fail(`unsupported literary index schema; ${table} is missing ${missing.join(', ')}`);
  return columns;
}

function assertForeignKey(database, table, targetTable, from, to) {
  const found = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .some((row) => row.table === targetTable && row.from === from && row.to === to);
  if (!found) fail(`unsupported literary index schema; ${table}.${from} must reference ${targetTable}.${to}`);
}

function assertUniqueIndex(database, table, expectedColumns) {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all();
  const found = indexes.some((index) => index.unique && database.prepare(`PRAGMA index_info(${index.name})`).all()
    .map((row) => row.name).join('\0') === expectedColumns.join('\0'));
  if (!found) fail(`unsupported literary index schema; ${table} needs a unique ${expectedColumns.join(', ')} key`);
}

function readIndexMetadata(database) {
  const columns = tableColumns(database, 'index_metadata').map((row) => row.name);
  if (columns.join('\0') !== 'key\0value') fail('unsupported literary index metadata schema; expected key/value rows');
  const rows = database.prepare('SELECT key, value FROM index_metadata ORDER BY key LIMIT 65').all();
  if (rows.length === 0) fail('literary index metadata is empty');
  if (rows.length > 64) fail('literary index metadata exceeds the 64-row contract');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function normalizeMetadata(metadata) {
  const required = [
    'schema_version', 'builder_version', 'build_kind', 'search_layer', 'sqlite_version', 'tool_identity',
    'input_manifest_sha256', 'logical_rows_sha256', 'inventory_file_count', 'excluded_file_count',
    'file_count', 'work_count', 'unit_count',
  ];
  const missing = required.filter((key) => typeof metadata[key] !== 'string' || metadata[key] === '');
  if (missing.length > 0) fail(`literary index metadata is missing ${missing.join(', ')}`);
  if (metadata.schema_version !== '1' || metadata.builder_version !== '1' || metadata.build_kind !== 'full') {
    fail('unsupported literary index metadata version or build kind');
  }
  if (!/FTS5 trigram/iu.test(metadata.search_layer) || !/instr\(\)/iu.test(metadata.search_layer) || !/no norm/iu.test(metadata.search_layer)) {
    fail('literary index metadata does not describe the supported literal unit search');
  }
  if (!/^[a-f0-9]{64}$/iu.test(metadata.input_manifest_sha256) || !/^[a-f0-9]{64}$/iu.test(metadata.logical_rows_sha256)) {
    fail('literary index provenance digests are malformed');
  }
  const countKeys = ['inventory_file_count', 'excluded_file_count', 'file_count', 'work_count', 'unit_count'];
  const counts = Object.fromEntries(countKeys.map((key) => {
    if (!/^\d+$/u.test(metadata[key])) fail(`literary index metadata ${key} is not a non-negative integer`);
    return [key, Number(metadata[key])];
  }));
  if (counts.inventory_file_count !== counts.file_count + counts.excluded_file_count) {
    fail('literary index inventory and included/excluded file counts do not agree');
  }
  return { ...metadata, ...counts };
}

function assertIndexSchema(database) {
  const objects = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view')").all();
  const names = new Set(objects.map((row) => row.name));
  if (LEGACY_INDEX_TABLES.some((name) => names.has(name))) {
    fail('unsupported literary index schema; retired paragraph-index tables are not accepted');
  }
  const missing = INDEX_REQUIRED_TABLES.filter((name) => !names.has(name));
  if (missing.length > 0) fail(`unsupported literary index schema; missing ${missing.join(', ')}`);

  const requiredColumns = {
    source_files: ['file_id', 'genre', 'relative_path', 'source_sha256', 'source_bytes', 'encoding', 'has_bom', 'newline_convention', 'final_newline', 'nfc', 'char_count', 'unit_count', 'status', 'warnings'],
    works: ['work_id', 'genre', 'file_id', 'source_id', 'title', 'author', 'metadata_origin', 'title_in_first_unit'],
    text_units: ['unit_rowid', 'file_id', 'ordinal', 'kind', 'block_ordinal', 'text', 'eol'],
    unit_fts: ['text'],
    index_metadata: ['key', 'value'],
  };
  for (const [table, required] of Object.entries(requiredColumns)) assertColumns(database, table, required);

  assertForeignKey(database, 'works', 'source_files', 'file_id', 'file_id');
  assertForeignKey(database, 'text_units', 'source_files', 'file_id', 'file_id');
  assertUniqueIndex(database, 'works', ['file_id']);
  assertUniqueIndex(database, 'text_units', ['file_id', 'ordinal']);

  const ftsSql = objects.find((row) => row.name === 'unit_fts')?.sql ?? '';
  const normalizedFtsSql = ftsSql.toLowerCase().replace(/[\s"'`]/gu, '');
  const expectedFtsSql = 'createvirtualtableunit_ftsusingfts5(text,content=text_units,content_rowid=unit_rowid,tokenize=trigram)';
  if (normalizedFtsSql !== expectedFtsSql) fail('unsupported literary index FTS definition; expected unit_fts over text_units.unit_rowid with trigram');

  // Exercise FTS5 trigram and literal substring support without returning indexed text.
  database.prepare('SELECT rowid FROM unit_fts WHERE unit_fts MATCH ? LIMIT 1').all('"preflight"');
  if (database.prepare("SELECT instr('abc', 'b') AS found").get().found !== 2) fail('SQLite literal substring search is unavailable');
}

function readCorpusIndexMetadata(database) {
  const columns = database.prepare('PRAGMA table_info(index_metadata)').all().map((row) => row.name);
  if (columns.length === 0) fail('corpus index is missing index_metadata columns');
  if (columns.includes('key') && columns.includes('value')) {
    const rows = database.prepare('SELECT key, value FROM index_metadata LIMIT 65').all();
    if (rows.length === 0) fail('corpus index index_metadata is empty');
    if (rows.length > 64) fail('corpus index metadata exceeds the 64-row summary limit');
    return Object.fromEntries(rows.filter((row) => typeof row.key === 'string').map((row) => [row.key, row.value]));
  }
  const rows = database.prepare('SELECT * FROM index_metadata LIMIT 2').all();
  if (rows.length === 0) fail('corpus index index_metadata is empty');
  if (rows.length !== 1) fail('corpus index index_metadata must be key/value rows or a single-row metadata table');
  return Object.fromEntries(columns.map((column) => [column, rows[0][column]]));
}

function normalizeCorpusIndexMetadata(metadata) {
  const read = (...keys) => {
    for (const key of keys) {
      const value = metadata[key];
      if (value !== null && value !== undefined && String(value) !== '') return String(value);
    }
    return null;
  };
  const sourceManifestDigest = read('input_manifest_sha256', 'source_manifest_sha256', 'manifest_sha256');
  const logicalRowDigest = read('logical_row_digest', 'logical_rows_sha256', 'row_digest_sha256');
  if (!sourceManifestDigest && !logicalRowDigest) {
    fail('corpus index metadata must expose an input-manifest or logical-row SHA-256 digest');
  }
  if ((sourceManifestDigest && !/^[a-f0-9]{64}$/iu.test(sourceManifestDigest)) || (logicalRowDigest && !/^[a-f0-9]{64}$/iu.test(logicalRowDigest))) {
    fail('corpus index metadata contains a malformed SHA-256 digest');
  }
  const schemaVersion = read('schema_version', 'schemaVersion');
  const indexVersion = read('index_version', 'version');
  if (!schemaVersion && !indexVersion) fail('corpus index metadata must expose schema_version or index_version');
  return {
    index_id: read('index_id', 'index_name', 'name'),
    schema_version: schemaVersion,
    builder_version: read('builder_version', 'builderVersion'),
    index_version: indexVersion,
    sqlite_version: read('sqlite_version', 'sqliteVersion'),
    source_manifest_sha256: sourceManifestDigest,
    logical_row_sha256: logicalRowDigest,
    source_count: read('source_count', 'sources'),
    document_count: read('document_count', 'documents'),
    paragraph_count: read('paragraph_count', 'paragraphs'),
  };
}

function assertCorpusIndexSchema(database) {
  const objects = database.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view')").all();
  const names = new Set(objects.map((row) => row.name));
  const missing = CORPUS_INDEX_REQUIRED_TABLES.filter((name) => !names.has(name));
  if (missing.length > 0) fail(`unsupported paragraph corpus index schema; missing ${missing.join(', ')}`);

  const requiredColumns = {
    source_files: ['source_path', 'title', 'creator', 'year', 'category'],
    documents: ['document_rowid', 'source_path', 'document_id', 'document_ordinal', 'title', 'author'],
    paragraphs: ['paragraph_rowid', 'document_rowid', 'paragraph_id', 'ordinal', 'form'],
    paragraph_fts: ['form'],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const absent = required.filter((column) => !columns.has(column));
    if (absent.length > 0) fail(`unsupported paragraph corpus index schema; ${table} is missing ${absent.join(', ')}`);
  }
  database.prepare('SELECT rowid FROM paragraph_fts WHERE paragraph_fts MATCH ? LIMIT 1').all('"아무"');
  if (database.prepare("SELECT instr('abc', 'b') AS found").get().found !== 2) fail('SQLite literal substring search is unavailable');
}

/** Read the paragraph-corpus index used by the independent D workflow. */
export function openCorpusIndex(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON');
    assertCorpusIndexSchema(database);
    const metadata = normalizeCorpusIndexMetadata(readCorpusIndexMetadata(database));
    return { database, metadata };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Inspect the paragraph-corpus index without returning its local path.
 * The whole-file SHA-256 is read only with `verifyBinary` (first approval or a suspected change);
 * routine checks use the schema, the logical metadata digests and the file size/mtime identity.
 */
export async function inspectCorpusIndex(databasePath, { scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY), verifyBinary = false } = {}) {
  const { database, metadata } = openCorpusIndex(databasePath);
  try {
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    const identity = await databaseIdentity(databasePath);
    const digest = verifyBinary ? await cachedDatabaseDigest(databasePath, scratchDirectory) : null;
    return {
      contract: 'corpus-index-v1',
      status: 'READY',
      database: { bytes: identity.bytes, sha256: digest?.sha256 ?? null, sha256_cached: digest?.cached ?? null },
      index: { ...metadata, runtime_sqlite_version: sqliteVersion },
    };
  } finally {
    database.close();
  }
}

function assertIndexData(database, metadata) {
  const counts = {
    file_count: database.prepare('SELECT count(*) AS count FROM source_files').get().count,
    work_count: database.prepare('SELECT count(*) AS count FROM works').get().count,
    unit_count: database.prepare('SELECT count(*) AS count FROM text_units').get().count,
  };
  for (const key of Object.keys(counts)) if (counts[key] !== metadata[key]) fail(`literary index ${key} does not match index_metadata`);
  if (database.prepare('SELECT count(*) AS count FROM unit_fts').get().count !== counts.unit_count) fail('literary index FTS content count does not match text_units');
  const actualTrigramTokens = database.prepare('SELECT count(*) AS count FROM temp.literary_unit_fts_vocab').get().count;
  const expectedTrigramTokens = database.prepare(`SELECT coalesce(sum(CASE WHEN length(text) > 2 THEN length(text) - 2 ELSE 0 END), 0) AS count FROM text_units`).get().count;
  if (actualTrigramTokens !== expectedTrigramTokens) fail('literary index FTS trigram token coverage does not match text_units');
  const postingMismatch = database.prepare(`SELECT
      EXISTS(
        SELECT 1 FROM (
          SELECT term, doc, col, offset FROM temp.literary_unit_fts_vocab
          EXCEPT
          SELECT term, doc, col, offset FROM temp.literary_expected_fts_vocab
        )
      ) AS unexpected_posting,
      EXISTS(
        SELECT 1 FROM (
          SELECT term, doc, col, offset FROM temp.literary_expected_fts_vocab
          EXCEPT
          SELECT term, doc, col, offset FROM temp.literary_unit_fts_vocab
        )
      ) AS missing_posting`).get();
  if (postingMismatch.unexpected_posting || postingMismatch.missing_posting) {
    fail('literary index FTS trigram term and row postings do not match text_units');
  }
  if (database.prepare(`SELECT count(*) AS count FROM source_files s
      LEFT JOIN text_units u ON u.file_id = s.file_id
      GROUP BY s.file_id HAVING s.unit_count != count(u.unit_rowid)`).all().length !== 0) {
    fail('literary index source-file unit counts do not match text_units');
  }
  if (database.prepare(`SELECT count(*) AS count FROM source_files s
      LEFT JOIN works w ON w.file_id = s.file_id
      WHERE w.work_id IS NULL OR w.genre != s.genre`).get().count !== 0) {
    fail('literary index work-to-file mapping or genre is inconsistent');
  }
  if (database.prepare("SELECT count(*) AS count FROM (SELECT file_id FROM works GROUP BY file_id HAVING count(*) != 1)").get().count !== 0) {
    fail('literary index work-to-file relation is ambiguous');
  }
  if (database.prepare(`SELECT count(*) AS count FROM (
      SELECT file_id FROM text_units GROUP BY file_id
      HAVING min(ordinal) != 0 OR max(ordinal) != count(*) - 1
    )`).get().count !== 0) fail('literary index unit ordinals are not zero-based and contiguous within each source file');
  if (database.prepare("SELECT count(*) AS count FROM text_units WHERE kind NOT IN ('blank', 'text') OR eol NOT IN ('', char(10), char(13), char(13, 10))").get().count !== 0) {
    fail('literary index contains an unsupported physical-unit kind or line ending');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('literary index has broken source-file references');
}

function openLiteraryIndex(databasePath, { prepareFtsVocabulary = false } = {}) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertIndexSchema(database);
    if (prepareFtsVocabulary) {
      // Rebuild an exact, connection-local reference index from source units, then compare its posting tuples.
      // The approved database remains read-only; only the temporary schema is written during preflight.
      database.exec(`
        PRAGMA temp_store = FILE;
        CREATE VIRTUAL TABLE temp.literary_unit_fts_vocab USING fts5vocab(main, unit_fts, instance);
        CREATE TEMP VIEW literary_expected_units AS SELECT unit_rowid, text FROM main.text_units;
        CREATE VIRTUAL TABLE temp.literary_expected_unit_fts USING fts5(
          text,
          content='literary_expected_units',
          content_rowid='unit_rowid',
          tokenize='trigram'
        );
        INSERT INTO literary_expected_unit_fts(literary_expected_unit_fts) VALUES ('rebuild');
        CREATE VIRTUAL TABLE temp.literary_expected_fts_vocab USING fts5vocab(temp, literary_expected_unit_fts, instance);
      `);
    }
    database.exec('PRAGMA query_only = ON');
    if (database.prepare('PRAGMA query_only').get().query_only !== 1) fail('literary index could not be opened query-only');
    const metadata = normalizeMetadata(readIndexMetadata(database));
    return { database, metadata };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function cachedDatabaseDigest(databasePath, scratchDirectory) {
  const absolutePath = await realpath(databasePath);
  const fileStat = await stat(absolutePath, { bigint: true });
  const cachePath = path.join(scratchDirectory, 'literary-index-digests.json');
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const fingerprint = [String(fileStat.dev), String(fileStat.ino), String(fileStat.size), String(fileStat.mtimeNs), String(fileStat.ctimeNs)].join(':');
  const previous = cache[absolutePath];
  if (previous?.fingerprint === fingerprint && /^[a-f0-9]{64}$/u.test(previous.sha256 ?? '')) {
    return {
      sha256: previous.sha256,
      bytes: Number(fileStat.size),
      cached: true,
      path: absolutePath,
      fingerprint,
      validation_contract: previous.validation_contract ?? null,
    };
  }
  const digest = await hashFile(absolutePath);
  cache[absolutePath] = { fingerprint, sha256: digest, validation_contract: null };
  await writeJsonAtomic(cachePath, cache);
  return { sha256: digest, bytes: Number(fileStat.size), cached: false, path: absolutePath, fingerprint, validation_contract: null };
}

async function databaseIdentity(databasePath) {
  const absolutePath = await realpath(databasePath);
  const fileStat = await stat(absolutePath, { bigint: true });
  const fingerprint = [String(fileStat.dev), String(fileStat.ino), String(fileStat.size), String(fileStat.mtimeNs), String(fileStat.ctimeNs)].join(':');
  return { path: absolutePath, bytes: Number(fileStat.size), fingerprint, sha256: null };
}

/**
 * Lean identity check for an already approved index: schema, metadata digests (format) and a real FTS probe.
 * The whole-file SHA-256 and the FTS rebuild/posting comparison run only with `deep` (first approval or a suspected change).
 */
async function inspectLiteraryIndexInternal(databasePath, scratchDirectory, { deep = false } = {}) {
  const identity = await databaseIdentity(databasePath);
  if (deep) identity.sha256 = (await cachedDatabaseDigest(databasePath, scratchDirectory)).sha256;
  const { database, metadata } = openLiteraryIndex(databasePath, { prepareFtsVocabulary: deep });
  try {
    if (deep) assertIndexData(database, metadata);
    const after = await databaseIdentity(databasePath);
    if (after.fingerprint !== identity.fingerprint) fail('literary index changed while its read-only preflight was running');
    const runtimeSqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    return {
      identity,
      metadata,
      summary: {
        schema_contract: 'works/text_units/unit_fts-v1',
        schema_version: metadata.schema_version,
        builder_version: metadata.builder_version,
        runtime_sqlite_version: runtimeSqliteVersion,
        source_file_count: metadata.file_count,
        work_count: metadata.work_count,
        text_unit_count: metadata.unit_count,
        inventory_file_count: metadata.inventory_file_count,
        excluded_file_count: metadata.excluded_file_count,
        fts_index_validation: deep ? 'trigram-term-row-posting-map-verified' : 'approved-index-not-rebuilt',
        manifest_digest: 'sha256-format-valid',
        logical_row_digest: 'sha256-format-valid',
        status: 'READY',
      },
    };
  } finally {
    database.close();
  }
}

/** Read-only preflight. Private DB identity is retained only in the local checkpoint. */
export async function inspectLiteraryIndex(databasePath, { scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY), deep = false } = {}) {
  const inspected = await inspectLiteraryIndexInternal(databasePath, scratchDirectory, { deep });
  return {
    contract: LITERARY_CONTEXT_CONTRACT,
    status: inspected.summary.status,
    index: inspected.summary,
    search: { long_forms: 'FTS5 trigram with instr() re-verification', short_forms: 'instr() literal unit scan', context_window: `${CONTEXT_WINDOW_UNITS} adjacent physical units per side`, read_only: true },
    output_limits: { max_response_chars: MAX_RESPONSE_CHARS, chunk_response_chars: CHUNK_RESPONSE_CHARS, default_chunk_senses: CHUNK_DEFAULT_SENSES, default_contexts_per_sense: CHUNK_DEFAULT_CONTEXTS, max_contexts_per_sense: MAX_CONTEXTS_PER_SENSE, default_snippet_chars: DEFAULT_SNIPPET_CHARS, max_snippet_chars: MAX_SNIPPET_CHARS },
  };
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

function formsForSense(record, sense) {
  return [...new Set([record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : [])]
    .filter((form) => typeof form === 'string' && form.trim().length > 0)
    .map((form) => form.normalize('NFC').trim()))].sort(compare);
}

function assertScratchPath(filePath, scratchDirectory) {
  const root = path.resolve(scratchDirectory);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail(`private literary state must be stored under ${root}`);
  }
  return absolutePath;
}

function findSense(checkpoint, senseId) {
  for (const record of checkpoint.records) {
    const sense = record.senses.find((item) => item.sense_id === senseId);
    if (sense) return { record, sense };
  }
  fail(`sense_id ${JSON.stringify(senseId)} is not in this checkpoint`);
}

function currentSenseStatus(sense) {
  const search = sense.search;
  if (!search) return 'PENDING';
  if (search.status === 'SEARCH_FAILED') return 'SEARCH_FAILED';
  if (search.status === 'UNSEARCHABLE') return 'UNSEARCHABLE';
  if (search.status === 'COUNTED') return search.total_hits === 0 ? 'NO_VERIFIED' : 'INCOMPLETE';
  if (search.status === 'INCOMPLETE' || search.status === 'SEARCHED' && sense.contexts.some((context) => context.judgment === 'PENDING')) return 'INCOMPLETE';
  if (search.status === 'ZERO_HITS') return 'NO_VERIFIED';
  if (search.status !== 'SEARCHED') return 'INCOMPLETE';

  if (sense.contexts.some((context) => context.judgment === 'PENDING')) return 'INCOMPLETE';
  const verified = sense.contexts.filter((context) => context.judgment === 'VERIFIED');
  if (verified.length === 0) return search.sampling_complete && search.remaining_hit_count > 0 ? 'SAMPLED_NO_VERIFIED' : 'NO_VERIFIED';
  if (verified.some((context) => [1, 2].some((sweep) => !context.sweeps[String(sweep)]))) return 'INSPECTED';
  if (sense.candidate_reviews.some((review) => !['KEEP', 'REMOVE'].includes(review.decision))) return 'INSPECTED';
  const discovered = new Set(verified.flatMap((context) => [1, 2].flatMap((sweep) => SWEEP_LENSES.flatMap((lens) => context.sweeps[String(sweep)].results[lens]))
    .map((candidate) => normalizeCandidate(candidate))));
  if ([...discovered].some((candidate) => !sense.candidate_reviews.some((review) => review.normalized === candidate))) return 'INSPECTED';
  return 'DISCOVERED';
}

function literalFtsQuery(form) {
  return `"${form.replaceAll('"', '""')}"`;
}

function matchesSql(forms) {
  const terms = [];
  const parameters = [];
  for (const form of forms) {
    if (codePointLength(form) >= 3) {
      terms.push(`SELECT u.unit_rowid AS unit_rowid, ? AS matched_form
        FROM unit_fts JOIN text_units u ON u.unit_rowid = unit_fts.rowid
        WHERE unit_fts MATCH ? AND instr(u.text, ?) > 0`);
      parameters.push(form, literalFtsQuery(form), form);
    } else {
      terms.push('SELECT unit_rowid AS unit_rowid, ? AS matched_form FROM text_units WHERE instr(text, ?) > 0');
      parameters.push(form, form);
    }
  }
  if (terms.length === 0) return null;
  return {
    cte: `WITH raw_hits AS (${terms.join(' UNION ALL ')})`,
    parameters,
  };
}

function countMatches(database, forms) {
  const query = matchesSql(forms);
  if (!query) return null;
  return database.prepare(`${query.cte} SELECT COUNT(DISTINCT unit_rowid) AS total_hits FROM raw_hits`).get(...query.parameters).total_hits;
}

function readUnitWindow(database, { file_id: fileId, ordinal }, radius = CONTEXT_WINDOW_UNITS) {
  const start = ordinal - radius;
  const end = ordinal + radius;
  const units = database.prepare(`
    SELECT unit_rowid, ordinal, kind, block_ordinal, text, eol
    FROM text_units
    WHERE file_id = ? AND ordinal BETWEEN ? AND ?
    ORDER BY ordinal, unit_rowid
  `).all(fileId, start, end);
  if (!units.some((unit) => unit.ordinal === ordinal)) fail('literary context locator no longer resolves to its exact text unit');
  const text = units.map((unit) => `${unit.text}${unit.eol}`).join('');
  const hitIndex = units.findIndex((unit) => unit.ordinal === ordinal);
  const hitStart = units.slice(0, hitIndex).reduce((length, unit) => length + unit.text.length + unit.eol.length, 0);
  return {
    units: units.map(({ unit_rowid, ordinal: unitOrdinal, kind, block_ordinal, eol }) => ({ unit_rowid, ordinal: unitOrdinal, kind, block_ordinal, eol })),
    start_ordinal: units[0].ordinal,
    end_ordinal: units.at(-1).ordinal,
    hit_ordinal: ordinal,
    hit_start: hitStart,
    text,
    sha256: sha256(text),
  };
}

async function assertCheckpointIndexUnchanged(checkpoint, databasePath, metadata) {
  const databaseRealPath = await realpath(databasePath);
  const [current, recorded] = await Promise.all([
    stat(databaseRealPath, { bigint: true }),
    stat(checkpoint.index.path, { bigint: true }),
  ]);
  const fingerprint = [String(current.dev), String(current.ino), String(current.size), String(current.mtimeNs), String(current.ctimeNs)].join(':');
  const unchanged = String(current.dev) === String(recorded.dev)
    && String(current.ino) === String(recorded.ino)
    && String(current.size) === String(recorded.size)
    && String(current.mtimeNs) === String(recorded.mtimeNs)
    && String(current.ctimeNs) === String(recorded.ctimeNs)
    && fingerprint === checkpoint.index.fingerprint
    && checkpoint.index.schema_version === metadata.schema_version
    && checkpoint.index.input_manifest_sha256 === metadata.input_manifest_sha256
    && checkpoint.index.logical_rows_sha256 === metadata.logical_rows_sha256;
  if (!unchanged) fail('literary index identity or schema provenance changed after checkpoint initialization; re-run preflight and start a new checkpoint');
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function cursorDecode(cursor, fingerprint) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    fail('page cursor is invalid');
  }
  if (decoded?.fingerprint !== fingerprint || !Array.isArray(decoded.after) || decoded.after.length !== 5) {
    fail('page cursor does not belong to this exact sense/form set');
  }
  return decoded.after;
}

function makeLocatorKey(row) {
  return sha256(JSON.stringify([row.file_id, row.work_id, row.unit_rowid, row.ordinal, row.source_sha256]));
}

function excerptAround(text, forms, maxChars, hitStart = 0) {
  const matchAt = forms.map((form) => text.indexOf(form, hitStart)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? hitStart;
  const length = codePointLength(text);
  if (length <= maxChars) return { text, truncated: false };
  const chars = [...text];
  const matchCodePointAt = codePointLength(text.slice(0, matchAt));
  const contentLimit = maxChars - 2;
  const start = Math.max(0, Math.min(length - contentLimit, matchCodePointAt - Math.floor(contentLimit / 2)));
  const end = Math.min(length, start + contentLimit);
  return {
    text: `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < length ? '…' : ''}`,
    truncated: true,
  };
}

function validateSnippetChars(value, defaultValue = DEFAULT_SNIPPET_CHARS) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > MAX_SNIPPET_CHARS) fail(`snippet chars must be an integer in [100, ${MAX_SNIPPET_CHARS}]`);
  return parsed;
}

function runSearch(database, forms, { pageSize, cursor, snippetChars }) {
  const query = matchesSql(forms);
  if (!query) return { status: 'UNSEARCHABLE', total_hits: 0, returned: 0, has_more: false, next_cursor: null, results: [] };
  const fingerprint = sha256(JSON.stringify(forms));
  const after = cursor ? cursorDecode(cursor, fingerprint) : null;
  const rawHitsCte = query.cte;
  const countSql = `${rawHitsCte} SELECT COUNT(DISTINCT unit_rowid) AS total_hits FROM raw_hits`;
  const totalHits = database.prepare(countSql).get(...query.parameters).total_hits;
  const pageParams = [...query.parameters];
  const afterClause = after ? 'WHERE (m.work_hit_ordinal, w.genre, w.work_id, u.ordinal, u.unit_rowid) > (?, ?, ?, ?, ?)' : '';
  if (after) pageParams.push(...after);
  pageParams.push(pageSize + 1);
  const pageSql = `${rawHitsCte}, matched AS (
      SELECT unit_rowid, group_concat(matched_form, char(31)) AS matched_forms
      FROM raw_hits GROUP BY unit_rowid
    ), ranked AS (
      SELECT m.unit_rowid, m.matched_forms,
        ROW_NUMBER() OVER (PARTITION BY w.work_id ORDER BY u.ordinal, u.unit_rowid) AS work_hit_ordinal
      FROM matched m
      JOIN text_units u ON u.unit_rowid = m.unit_rowid
      JOIN works w ON w.file_id = u.file_id
    )
    SELECT u.unit_rowid, u.file_id, u.ordinal, u.kind, u.block_ordinal,
      w.work_id, w.genre, w.source_id, w.title, w.author, w.metadata_origin, w.title_in_first_unit,
      s.relative_path, s.source_sha256, m.work_hit_ordinal, m.matched_forms
    FROM ranked m
    JOIN text_units u ON u.unit_rowid = m.unit_rowid
    JOIN works w ON w.file_id = u.file_id
    JOIN source_files s ON s.file_id = u.file_id
    ${afterClause}
    ORDER BY m.work_hit_ordinal, w.genre, w.work_id, u.ordinal, u.unit_rowid
    LIMIT ?`;
  const pageRows = database.prepare(pageSql).all(...pageParams);
  const hasMore = pageRows.length > pageSize;
  const included = pageRows.slice(0, pageSize);
  const results = included.map((row) => {
    const matchedForms = String(row.matched_forms ?? '').split('\u001f').filter(Boolean).sort((a, b) => codePointLength(b) - codePointLength(a) || compare(a, b));
    const window = readUnitWindow(database, row);
    const excerpt = excerptAround(window.text, matchedForms, snippetChars, window.hit_start);
    return {
      locator_key: makeLocatorKey(row),
      source: {
        title: (row.title ?? '').slice(0, 80) || null,
        author: (row.author ?? '').slice(0, 80) || null,
        genre: (row.genre ?? '').slice(0, 40) || null,
        metadata_origin: (row.metadata_origin ?? '').slice(0, 40) || null,
      },
      unit_ordinal: row.ordinal,
      unit_kind: row.kind,
      context_window: {
        first_unit_ordinal: window.start_ordinal,
        last_unit_ordinal: window.end_ordinal,
        included_units: window.units.length,
        units_before: row.ordinal - window.start_ordinal,
        units_after: window.end_ordinal - row.ordinal,
        physical_line_endings_preserved: true,
      },
      matched_forms: matchedForms.slice(0, 3).map((form) => form.slice(0, 30)),
      matched_form_count: matchedForms.length,
      excerpt: excerpt.text,
      excerpt_truncated: excerpt.truncated,
      context_sha256: window.sha256,
      // Private fields are included for checkpoint persistence only and removed by the CLI serializer.
      _private: {
        locator: {
          relative_path: row.relative_path,
          source_sha256: row.source_sha256,
          file_id: row.file_id,
          work_id: row.work_id,
          unit_rowid: row.unit_rowid,
          ordinal: row.ordinal,
        },
        unit_window: window.units,
        context_text: window.text,
        work_key: String(row.work_id),
        order: [row.work_hit_ordinal, row.genre, row.work_id, row.ordinal, row.unit_rowid],
      },
    };
  });
  const lastResult = results.at(-1);
  const lastOrder = lastResult?._private?.order ?? null;
  const perWork = new Map();
  for (const result of results) {
    const workKey = result._private.work_key;
    perWork.set(workKey, (perWork.get(workKey) ?? 0) + 1);
  }
  return {
    status: totalHits === 0 ? 'ZERO_HITS' : hasMore ? 'INCOMPLETE' : 'SEARCHED',
    total_hits: totalHits,
    returned: included.length,
    has_more: hasMore,
    next_cursor: hasMore && lastOrder ? cursorEncode({ fingerprint, after: lastOrder }) : null,
    work_diversity: { distinct_works: perWork.size, max_contexts_per_work: Math.max(0, ...perWork.values()) },
    results,
  };
}


function senseForms(sense) {
  return [...new Set([...sense.search_forms, ...sense.added_forms.map((item) => item.form)])].sort(compare);
}

function candidatesForSense(sense) {
  const candidates = new Map();
  for (const context of sense.contexts ?? []) {
    if (context.judgment !== 'VERIFIED') continue;
    for (const sweep of ['1', '2']) {
      for (const lens of SWEEP_LENSES) {
        for (const candidate of context.sweeps?.[sweep]?.results[lens] ?? []) {
          const normalized = normalizeCandidate(candidate);
          if (!candidates.has(normalized)) candidates.set(normalized, candidate.trim());
        }
      }
    }
  }
  return candidates;
}

/** Final candidates of a sense: the chunk submission, or (read compatibility) a complete v2 checkpoint's KEEP list. */
function finalCandidates(sense) {
  if (sense.submission) return sense.submission.candidates ?? [];
  return [...candidatesForSense(sense).entries()]
    .filter(([normalized]) => sense.candidate_reviews?.find((item) => item.normalized === normalized)?.decision === 'KEEP')
    .map(([, candidate]) => candidate);
}

function senseState(sense) {
  if (sense.submission) return sense.submission.status;
  return currentSenseStatus(sense);
}

function senseDone(sense) {
  return ['ZERO_HITS', 'SUBMITTED', 'NO_VERIFIED', 'SAMPLED_NO_VERIFIED', 'DISCOVERED'].includes(senseState(sense));
}

function checkpointSummary(checkpoint) {
  const senseStatuses = {};
  let finalCount = 0;
  let emptySenses = 0;
  let senses = 0;
  const outputIsCurrent = Boolean(checkpoint.output && !checkpoint.output.stale);
  for (const record of checkpoint.records) {
    for (const sense of record.senses) {
      senses += 1;
      const status = senseState(sense);
      senseStatuses[status] = (senseStatuses[status] ?? 0) + 1;
      const count = senseDone(sense) ? finalCandidates(sense).length : 0;
      finalCount += count;
      if (count === 0) emptySenses += 1;
    }
  }
  return {
    contract: CHECKPOINT_CONTRACT,
    batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch, model: checkpoint.batch.model, state: outputIsCurrent ? 'OUTPUT' : checkpoint.output ? 'OUTPUT_STALE' : 'IN_PROGRESS' },
    coverage: { records: checkpoint.records.length, senses, sense_statuses: senseStatuses },
    final_candidates: { count: finalCount, empty_senses: emptySenses },
    output: checkpoint.output ? {
      state: outputIsCurrent ? 'OUTPUT' : 'OUTPUT_STALE',
      path: checkpoint.output.path ?? null,
      sha256: checkpoint.output.sha256 ?? null,
      validation_status: checkpoint.output.validation_status ?? checkpoint.output.validation?.status ?? null,
    } : null,
  };
}

/** Initialize a batch-local checkpoint from the exact Canonical shard and a read-only index preflight. */
export async function initializeLiteraryCheckpoint({ canonicalPath, shard, batch, model, databasePath, checkpointPath, scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const resolvedCheckpoint = assertScratchPath(checkpointPath, scratchDirectory);
  const shardText = await readFile(canonicalPath, 'utf8');
  const canonicalRows = parseCanonicalShard(shardText, canonicalPath);
  const canonicalShard = path.basename(canonicalPath).match(/^stdict-(\d{4})\.jsonl$/u)?.[1];
  const normalizedShard = String(shard).padStart(3, '0');
  if (canonicalShard !== normalizedShard.padStart(4, '0')) fail(`Canonical path does not match shard ${normalizedShard}`);
  const batchNumber = Number(batch);
  if (![1, 2].includes(batchNumber)) fail('batch must be 01 or 02');
  const selected = canonicalRows.slice((batchNumber - 1) * CANDIDATE_BATCH_SIZE, batchNumber * CANDIDATE_BATCH_SIZE);
  if (selected.length === 0) fail(`Canonical shard ${normalizedShard} has no records in batch ${String(batchNumber).padStart(2, '0')}`);
  if (selected.length !== CANDIDATE_BATCH_SIZE && !(normalizedShard === '428' && batchNumber === 2 && selected.length === 83)) {
    fail(`Canonical batch has ${selected.length} records; expected ${CANDIDATE_BATCH_SIZE}`);
  }
  if (!['codex', 'claude', 'deepseek'].includes(String(model).toLowerCase())) fail('model must be codex, claude, or deepseek');

  const inspectedIndex = await inspectLiteraryIndexInternal(databasePath, scratchDirectory);
  const head = gitHead();
  const checkpoint = {
    contract: CHECKPOINT_CONTRACT,
    batch: {
      shard: normalizedShard,
      batch: String(batchNumber).padStart(2, '0'),
      model: String(model).toLowerCase(),
      canonical_path: path.relative(process.cwd(), path.resolve(canonicalPath)),
      canonical_sha256: sha256(shardText),
      canonical_revision: head,
      procedure_contract: 'issue-1155-c-literary-v2',
      procedure_sha256: await procedureDigest(),
      git_head: head,
      initialized_at: new Date().toISOString(),
    },
    index: {
      ...inspectedIndex.identity,
      schema_version: inspectedIndex.metadata.schema_version,
      input_manifest_sha256: inspectedIndex.metadata.input_manifest_sha256,
      logical_rows_sha256: inspectedIndex.metadata.logical_rows_sha256,
    },
    index_metadata: inspectedIndex.metadata,
    records: selected.map((record) => ({
      record_id: record.id,
      lemma: record.lemma,
      search_forms: Array.isArray(record.search_forms) ? [...record.search_forms] : [],
      senses: record.senses.map((sense) => ({
        sense_id: sense.id,
        pos: sense.pos,
        gloss: sense.gloss ?? '',
        search_forms: formsForSense(record, sense),
        added_forms: [],
        submission: null,
      })),
    })),
    output: null,
  };
  await writeJsonAtomic(resolvedCheckpoint, checkpoint);
  return { checkpoint, summary: checkpointSummary(checkpoint), index_summary: inspectedIndex.summary, path: resolvedCheckpoint };
}

export async function loadLiteraryCheckpoint(checkpointPath, { scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) } = {}) {
  const resolvedPath = assertScratchPath(checkpointPath, scratchDirectory);
  const checkpoint = JSON.parse(await readFile(resolvedPath, 'utf8'));
  if (![CHECKPOINT_CONTRACT, LEGACY_CHECKPOINT_CONTRACT].includes(checkpoint?.contract) || !Array.isArray(checkpoint.records)) fail('unsupported literary checkpoint contract');
  return { checkpoint, path: resolvedPath };
}

async function saveCheckpoint(checkpointPath, checkpoint) {
  await writeJsonAtomic(checkpointPath, checkpoint);
}

function markOutputStale(checkpoint, reason) {
  if (!checkpoint.output) return;
  checkpoint.output.stale = true;
  checkpoint.output.stale_reason = reason;
}

/** Add a source-bound additional inflection before the sense has been read and submitted. */
export async function addSearchForm(checkpointPath, senseId, form, basis, options = {}) {
  if (typeof form !== 'string' || form.trim() === '' || typeof basis !== 'string' || basis.trim() === '') fail('additional form and its source/basis are required');
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  const { sense } = findSense(checkpoint, senseId);
  const normalized = form.normalize('NFC').trim();
  const alreadyKnown = sense.search_forms.includes(normalized) || sense.added_forms.some((item) => item.form === normalized);
  if (!alreadyKnown) {
    if ((sense.contexts?.length ?? 0) > 0 || sense.submission?.status === 'SUBMITTED') fail('add reviewed search forms before reading and submitting the sense so its 16-context sample stays exact');
    markOutputStale(checkpoint, 'search forms changed');
    sense.added_forms.push({ form: normalized, basis: basis.trim(), added_at: new Date().toISOString() });
    sense.added_forms.sort((left, right) => compare(left.form, right.form));
    sense.submission = null;
    sense.search = null;
    await saveCheckpoint(resolvedPath, checkpoint);
  }
  return { sense_id: senseId, query_form_count: senseForms(sense).length };
}

function boundedInteger(value, defaultValue, minimum, maximum, label) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) fail(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return parsed;
}

const sourceLabel = (source) => [source.title, source.author].filter(Boolean).join(' / ');

/**
 * Read the next chunk of unsubmitted senses with all their sampled contexts in one result and one index connection.
 * Zero-hit senses are recorded in the same single write; senses with hits are never recorded until the AI submits them.
 */
export async function readLiteraryChunk({ databasePath, checkpointPath, senseIds, limit, contexts, snippetChars, scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const senseLimit = boundedInteger(limit, CHUNK_DEFAULT_SENSES, 1, 50, 'chunk limit');
  const contextLimit = boundedInteger(contexts, CHUNK_DEFAULT_CONTEXTS, 1, MAX_CONTEXTS_PER_SENSE, 'contexts per sense');
  const snippetLimit = validateSnippetChars(snippetChars);
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const requested = senseIds ? [...new Set(String(senseIds).split(',').map((item) => item.trim()).filter(Boolean))] : null;
  if (requested) for (const senseId of requested) findSense(checkpoint, senseId);
  const targets = checkpoint.records.flatMap((record) => record.senses
    .filter((sense) => (requested ? requested.includes(sense.sense_id) : !senseDone(sense)))
    .map((sense) => ({ record, sense })));
  const { database, metadata } = openLiteraryIndex(databasePath);
  try {
    await assertCheckpointIndexUnchanged(checkpoint, databasePath, metadata);
    const items = [];
    let usedChars = 0;
    let zeroHitRecorded = 0;
    let unqueried = 0;
    let full = false;
    for (const { record, sense } of targets) {
      if (full || items.length >= senseLimit) {
        unqueried += 1;
        continue;
      }
      const forms = senseForms(sense);
      if (forms.length === 0) {
        items.push({ sense_id: sense.sense_id, status: 'UNSEARCHABLE' });
        continue;
      }
      let result;
      try {
        result = runSearch(database, forms, { pageSize: contextLimit, cursor: null, snippetChars: snippetLimit });
      } catch {
        items.push({ sense_id: sense.sense_id, status: 'SEARCH_FAILED' });
        continue;
      }
      if (result.total_hits === 0) {
        if (!sense.submission) {
          sense.submission = { status: 'ZERO_HITS', submitted_at: new Date().toISOString(), total_hits: 0, candidates: [] };
          zeroHitRecorded += 1;
        }
        continue;
      }
      const item = {
        sense_id: sense.sense_id,
        lemma: record.lemma,
        pos: sense.pos,
        gloss: sense.gloss.slice(0, 600),
        ...(forms.length > 1 ? { forms } : {}),
        total_hits: result.total_hits,
        unseen_hits: Math.max(0, result.total_hits - result.results.length),
        contexts: result.results.map((row) => ({ k: row.locator_key.slice(0, SHORT_KEY_LENGTH), src: sourceLabel(row.source), x: row.excerpt })),
      };
      const size = JSON.stringify(item).length;
      if (items.length > 0 && usedChars + size > CHUNK_RESPONSE_CHARS) {
        full = true;
        unqueried += 1;
        continue;
      }
      usedChars += size;
      items.push(item);
    }
    if (zeroHitRecorded > 0) await saveCheckpoint(resolvedCheckpoint, checkpoint);
    const progress = checkpointSummary(checkpoint).coverage;
    return {
      contract: LITERARY_CONTEXT_CONTRACT,
      status: 'READY',
      batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch },
      done_senses: progress.senses - targetsPending(checkpoint),
      total_senses: progress.senses,
      zero_hit_recorded: zeroHitRecorded,
      not_yet_read: unqueried,
      items,
    };
  } finally {
    database.close();
  }
}

function targetsPending(checkpoint) {
  return checkpoint.records.reduce((count, record) => count + record.senses.filter((sense) => !senseDone(sense)).length, 0);
}

function validateSubmission(submission) {
  assertRecord(submission, 'chunk submission');
  if (!exactKeys(submission, ['senses']) || !Array.isArray(submission.senses) || submission.senses.length === 0) fail('chunk submission must be {"senses":[...]} with at least one sense');
  const seen = new Set();
  for (const entry of submission.senses) {
    assertRecord(entry, 'submitted sense');
    if (!exactKeys(entry, ['sense_id', 'verified', 'candidates'])) fail('each submitted sense needs exactly sense_id, verified[], candidates[]');
    if (typeof entry.sense_id !== 'string' || entry.sense_id === '') fail('submitted sense_id must be a non-empty string');
    if (seen.has(entry.sense_id)) fail(`sense_id ${JSON.stringify(entry.sense_id)} is submitted more than once`);
    seen.add(entry.sense_id);
    for (const key of ['verified', 'candidates']) {
      if (!Array.isArray(entry[key]) || entry[key].some((item) => typeof item !== 'string' || item.trim() === '')) fail(`${key} of ${entry.sense_id} must be a string[]`);
    }
  }
}

/**
 * Save the whole chunk in one write: VERIFIED context keys (re-resolved against the index, so only real
 * contexts of that sense can be cited) and the final candidates. Nothing is written unless every sense is valid.
 */
export async function submitLiteraryChunk({ databasePath, checkpointPath, submission, scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  validateSubmission(submission);
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const { database, metadata } = openLiteraryIndex(databasePath);
  const accepted = [];
  try {
    await assertCheckpointIndexUnchanged(checkpoint, databasePath, metadata);
    for (const entry of submission.senses) {
      const { sense } = findSense(checkpoint, entry.sense_id);
      const forms = senseForms(sense);
      if (forms.length === 0) fail(`${entry.sense_id} has no search forms and cannot be submitted`);
      const result = runSearch(database, forms, { pageSize: MAX_CONTEXTS_PER_SENSE, cursor: null, snippetChars: DEFAULT_SNIPPET_CHARS });
      if (result.total_hits === 0 && (entry.verified.length > 0 || entry.candidates.length > 0)) fail(`${entry.sense_id} has no literary hits, so it cannot have verified contexts or candidates`);
      const verified = entry.verified.map((key) => {
        if (key.length < SHORT_KEY_LENGTH) fail(`context key ${JSON.stringify(key)} on ${entry.sense_id} is shorter than ${SHORT_KEY_LENGTH} characters`);
        const matches = result.results.filter((row) => row.locator_key.startsWith(key));
        if (matches.length !== 1) fail(`context key ${JSON.stringify(key)} on ${entry.sense_id} does not identify exactly one indexed context`);
        return matches[0];
      });
      if (new Set(verified.map((row) => row.locator_key)).size !== verified.length) fail(`${entry.sense_id} lists the same verified context twice`);
      const candidates = new Map();
      for (const candidate of entry.candidates) {
        const normalized = normalizeCandidate(candidate);
        if (!candidates.has(normalized)) candidates.set(normalized, candidate.normalize('NFC').trim());
      }
      if (candidates.size > 0 && verified.length === 0) fail(`${entry.sense_id} has candidates but no VERIFIED source-sense context`);
      accepted.push({
        sense,
        submission: {
          status: result.total_hits === 0 ? 'ZERO_HITS' : 'SUBMITTED',
          submitted_at: new Date().toISOString(),
          total_hits: result.total_hits,
          contexts_available: result.results.length,
          remaining_hit_count: Math.max(0, result.total_hits - result.results.length),
          verified: verified.map((row) => ({ locator_key: row.locator_key, locator: row._private.locator, source: row.source, context_sha256: row.context_sha256 })),
          candidates: [...candidates.values()],
        },
      });
    }
  } finally {
    database.close();
  }
  for (const { sense, submission: saved } of accepted) sense.submission = saved;
  markOutputStale(checkpoint, 'chunk submission changed');
  await saveCheckpoint(resolvedCheckpoint, checkpoint);
  return {
    status: 'SAVED',
    senses: accepted.length,
    verified_contexts: accepted.reduce((sum, item) => sum + item.submission.verified.length, 0),
    candidates: accepted.reduce((sum, item) => sum + item.submission.candidates.length, 0),
    pending_senses: targetsPending(checkpoint),
  };
}

export function summarizeLiteraryCheckpoint(checkpoint) {
  return checkpointSummary(checkpoint);
}

function candidateRowsFromCheckpoint(checkpoint) {
  return checkpoint.records.map((record) => ({
    record_id: record.record_id,
    senses: record.senses.map((sense) => ({ sense_id: sense.sense_id, candidates: [...finalCandidates(sense)] })),
  }));
}

/** The checkpoint must still describe exactly the current Canonical batch it was initialized from. */
function assertCheckpointBoundToCanonical(checkpoint, canonicalRows) {
  const offset = (Number(checkpoint.batch.batch) - 1) * CANDIDATE_BATCH_SIZE;
  const expected = canonicalRows.slice(offset, offset + CANDIDATE_BATCH_SIZE);
  if (checkpoint.records.length !== expected.length) fail(`checkpoint has ${checkpoint.records.length} records; expected ${expected.length} from the current Canonical batch`);
  for (const [recordIndex, record] of checkpoint.records.entries()) {
    const source = expected[recordIndex];
    if (record.record_id !== source.id || record.lemma !== source.lemma || record.senses.length !== source.senses.length) {
      fail(`checkpoint record ${record.record_id} is not bound to current Canonical record ${source.id}`);
    }
    for (const [senseIndex, sense] of record.senses.entries()) {
      const sourceSense = source.senses[senseIndex];
      if (sense.sense_id !== sourceSense.id || sense.pos !== sourceSense.pos || sense.gloss !== (sourceSense.gloss ?? '')) {
        fail(`checkpoint sense ${sense.sense_id} is not bound to current Canonical sense ${sourceSense.id}`);
      }
    }
  }
}

/** The one final check: the shared Candidate v1 batch validator over the whole file, scoped to a row on failure. */
async function validateCandidateRows({ checkpoint, canonicalPath, candidateRows, repositoryDirectory }) {
  const canonicalText = await readFile(canonicalPath, 'utf8');
  if (sha256(canonicalText) !== checkpoint.batch.canonical_sha256) fail('Canonical shard changed after checkpoint initialization');
  const canonicalRows = parseCanonicalShard(canonicalText, canonicalPath);
  assertCheckpointBoundToCanonical(checkpoint, canonicalRows);
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const batchNumber = Number(checkpoint.batch.batch);
  try {
    const summary = validateCandidateBatch(canonicalRows, candidateRows, {
      batch: batchNumber,
      canonicalLemmaForms,
      sourceName: canonicalPath,
      candidateName: `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`,
    });
    return { status: 'VALID', ...summary };
  } catch (error) {
    const lineMatch = error.message.match(/(?:^|\s)(?:[^\s:]+\.jsonl|Candidate):(\d+)(?::|\s)/u);
    const line = lineMatch ? Number(lineMatch[1]) : null;
    const failedRow = line ? candidateRows[line - 1] : null;
    const failedSource = line ? canonicalRows[(batchNumber - 1) * CANDIDATE_BATCH_SIZE + line - 1] : null;
    const candidateInfo = failedRow?.senses?.flatMap((candidateSense) => candidateSense.candidates ?? []).find((candidate) => error.message.includes(JSON.stringify(candidate)));
    return {
      status: 'INVALID',
      error_type: error.name,
      message: error.message,
      affected: failedRow ? { record_id: failedRow.record_id, canonical_record_id: failedSource?.id, sense_ids: failedRow.senses?.map((sense) => sense.sense_id) ?? [], candidate: candidateInfo ?? null, candidate_line: line } : null,
      repair_scope: 'Resubmit only the affected sense (read it again with --sense-ids if needed), then export again.',
    };
  }
}

/** Export after every sense is read and submitted (or has zero hits); Candidate v1 runs once over the whole batch. */
export async function exportLiteraryCandidates({ checkpointPath, canonicalPath, outputPath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const expectedName = `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`;
  if (path.basename(outputPath) !== expectedName) fail(`output filename must be ${expectedName}`);
  const unfinished = checkpoint.records.flatMap((record) => record.senses.filter((sense) => !senseDone(sense)).map((sense) => sense.sense_id));
  if (unfinished.length > 0) fail(`${unfinished.length} sense(s) are not read and submitted yet (first: ${unfinished.slice(0, 5).join(', ')}); run chunk/submit until none remain`);
  const candidateRows = candidateRowsFromCheckpoint(checkpoint);
  const validation = await validateCandidateRows({ checkpoint, canonicalPath, candidateRows, repositoryDirectory });
  if (validation.status !== 'VALID') fail(`${validation.message}${validation.affected ? ` (affected ${JSON.stringify(validation.affected)})` : ''}`);
  const resolvedOutput = path.resolve(outputPath);
  const expectedRepositoryPath = path.resolve(repositoryDirectory, 'data/relation-candidates', checkpoint.batch.shard, expectedName);
  try {
    assertScratchPath(resolvedOutput, scratchDirectory);
  } catch (error) {
    if (resolvedOutput !== expectedRepositoryPath) throw error;
  }
  const ownPreviousOutput = checkpoint.output?.path && path.resolve(checkpoint.output.path) === resolvedOutput;
  if (!ownPreviousOutput) {
    try {
      await stat(resolvedOutput);
      fail(`refusing to overwrite existing Candidate output ${resolvedOutput}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  const serialized = `${candidateRows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const temporary = `${resolvedOutput}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: 0o644 });
  await rename(temporary, resolvedOutput);
  checkpoint.output = {
    path: path.relative(process.cwd(), resolvedOutput),
    sha256: sha256(serialized),
    exported_at: new Date().toISOString(),
    validation_status: validation.status,
  };
  await saveCheckpoint(resolvedCheckpoint, checkpoint);
  return { status: 'OUTPUT', output: checkpoint.output, coverage: { records: validation.recordCount, senses: validation.senseCount, candidates: validation.candidateCount, empty_senses: validation.emptySenseCount } };
}

/** Validate an existing Candidate file with the shared Candidate v1 batch contract (for a hand-edited file). */
export async function validateExistingLiteraryCandidates({ checkpointPath, canonicalPath, candidatePath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const expectedName = `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`;
  if (path.basename(candidatePath) !== expectedName) fail(`candidate filename must be ${expectedName}`);
  const candidateText = await readFile(candidatePath, 'utf8');
  let candidateRows;
  try {
    candidateRows = candidateText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    return { status: 'INVALID', error_type: error.name, message: `Candidate JSONL parse failed: ${error.message}`, affected: null };
  }
  return validateCandidateRows({ checkpoint, canonicalPath, candidateRows, repositoryDirectory });
}

export function normalizeLiteraryCandidate(value) {
  return normalizeCandidate(value);
}

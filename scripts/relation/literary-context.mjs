import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
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
  validateCandidateBatch,
} from './candidate-contract.mjs';

export const LITERARY_CONTEXT_CONTRACT = 'literary-context-v2';
export const CHECKPOINT_CONTRACT = 'literary-checkpoint-v2';
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

const DEFAULT_PAGE_SIZE = 4;
const MAX_PAGE_SIZE = 4;
const MAX_CONTEXTS_PER_SENSE = 16;
const DEFAULT_SNIPPET_CHARS = 700;
const MAX_SNIPPET_CHARS = 700;
const MAX_CONTEXT_PAGE_CHARS = 1000;
const INDEX_REQUIRED_TABLES = ['source_files', 'works', 'text_units', 'unit_fts', 'index_metadata'];
const LEGACY_INDEX_TABLES = ['documents', 'paragraphs', 'paragraph_fts'];
const CONTEXT_WINDOW_UNITS = 2;
const FTS_INDEX_VALIDATION_CONTRACT = 'unit-fts-trigram-token-coverage-v1';
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

function assertIndexData(database, metadata) {
  const counts = {
    file_count: database.prepare('SELECT count(*) AS count FROM source_files').get().count,
    work_count: database.prepare('SELECT count(*) AS count FROM works').get().count,
    unit_count: database.prepare('SELECT count(*) AS count FROM text_units').get().count,
  };
  for (const key of Object.keys(counts)) if (counts[key] !== metadata[key]) fail(`literary index ${key} does not match index_metadata`);
  if (database.prepare('SELECT count(*) AS count FROM unit_fts').get().count !== counts.unit_count) fail('literary index FTS content count does not match text_units');
  const actualTrigramTokens = database.prepare('SELECT coalesce(sum(cnt), 0) AS count FROM temp.literary_unit_fts_vocab').get().count;
  const expectedTrigramTokens = database.prepare(`SELECT coalesce(sum(CASE WHEN length(text) > 2 THEN length(text) - 2 ELSE 0 END), 0) AS count FROM text_units`).get().count;
  if (actualTrigramTokens !== expectedTrigramTokens) fail('literary index FTS trigram token coverage does not match text_units');
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
      database.exec('CREATE VIRTUAL TABLE temp.literary_unit_fts_vocab USING fts5vocab(main, unit_fts, row)');
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

async function markDatabaseDigestValidated(identity, scratchDirectory) {
  const cachePath = path.join(scratchDirectory, 'literary-index-digests.json');
  const fileStat = await stat(identity.path, { bigint: true });
  const fingerprint = [String(fileStat.dev), String(fileStat.ino), String(fileStat.size), String(fileStat.mtimeNs), String(fileStat.ctimeNs)].join(':');
  if (fingerprint !== identity.fingerprint) fail('literary index changed while its read-only preflight was running');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const entry = cache[identity.path];
  if (entry?.fingerprint !== identity.fingerprint || entry?.sha256 !== identity.sha256) {
    fail('literary index changed while its read-only preflight was running');
  }
  entry.validation_contract = FTS_INDEX_VALIDATION_CONTRACT;
  await writeJsonAtomic(cachePath, cache);
}

async function inspectLiteraryIndexInternal(databasePath, scratchDirectory) {
  const { database, metadata } = openLiteraryIndex(databasePath, { prepareFtsVocabulary: true });
  try {
    const digest = await cachedDatabaseDigest(databasePath, scratchDirectory);
    if (digest.validation_contract !== FTS_INDEX_VALIDATION_CONTRACT) {
      assertIndexData(database, metadata);
      await markDatabaseDigestValidated(digest, scratchDirectory);
    }
    const runtimeSqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    return {
      identity: digest,
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
        fts_index_validation: 'trigram-token-count-verified',
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
export async function inspectLiteraryIndex(databasePath, { scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) } = {}) {
  const inspected = await inspectLiteraryIndexInternal(databasePath, scratchDirectory);
  return {
    contract: LITERARY_CONTEXT_CONTRACT,
    status: inspected.summary.status,
    index: inspected.summary,
    search: { long_forms: 'FTS5 trigram with instr() re-verification', short_forms: 'instr() literal unit scan', context_window: `${CONTEXT_WINDOW_UNITS} adjacent physical units per side`, read_only: true },
    output_limits: { max_response_chars: MAX_RESPONSE_CHARS, default_page_size: DEFAULT_PAGE_SIZE, max_page_size: MAX_PAGE_SIZE, max_contexts_per_sense: MAX_CONTEXTS_PER_SENSE, default_snippet_chars: DEFAULT_SNIPPET_CHARS, max_snippet_chars: MAX_SNIPPET_CHARS },
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

function getContext(sense, locatorKey) {
  const context = sense.contexts.find((item) => item.locator_key === locatorKey);
  if (!context) fail(`locator_key ${JSON.stringify(locatorKey)} is not recorded for this sense`);
  return context;
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

function validatePageSize(pageSize) {
  const parsed = Number(pageSize ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) fail(`page size must be an integer in [1, ${MAX_PAGE_SIZE}]`);
  return parsed;
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

function checkpointSummary(checkpoint) {
  const senseStatuses = {};
  const contextJudgments = { PENDING: 0, VERIFIED: 0, AMBIGUOUS: 0, REJECTED: 0 };
  const sweepCounts = Object.fromEntries([1, 2].map((sweep) => [String(sweep), Object.fromEntries(SWEEP_LENSES.map((lens) => [lens, { contexts: 0, candidates: 0, zero: 0 }]))]));
  let totalContexts = 0;
  let rawDiscoveries = 0;
  let duplicateDiscoveries = 0;
  let independentSweep2New = 0;
  const contextCountByWork = new Map();
  const allCandidatesBySense = new Map();
  const outputIsCurrent = Boolean(checkpoint.output && !checkpoint.output.stale);

  for (const record of checkpoint.records) {
    for (const sense of record.senses) {
      const status = outputIsCurrent ? 'OUTPUT' : currentSenseStatus(sense);
      senseStatuses[status] = (senseStatuses[status] ?? 0) + 1;
      const candidateSet = new Set();
      const firstSweep = new Set();
      const secondSweep = new Set();
      for (const context of sense.contexts) {
        totalContexts += 1;
        const workKey = String(context.locator?.work_id ?? context.locator?.file_id ?? 'unknown-work');
        contextCountByWork.set(workKey, (contextCountByWork.get(workKey) ?? 0) + 1);
        contextJudgments[context.judgment] = (contextJudgments[context.judgment] ?? 0) + 1;
        for (const sweepNumber of [1, 2]) {
          const sweep = context.sweeps[String(sweepNumber)];
          if (!sweep) continue;
          for (const lens of SWEEP_LENSES) {
            const values = sweep.results[lens];
            sweepCounts[String(sweepNumber)][lens].contexts += 1;
            sweepCounts[String(sweepNumber)][lens].candidates += values.length;
            if (values.length === 0) sweepCounts[String(sweepNumber)][lens].zero += 1;
            for (const candidate of values) {
              rawDiscoveries += 1;
              const normalized = normalizeCandidate(candidate);
              if (candidateSet.has(normalized)) duplicateDiscoveries += 1;
              else candidateSet.add(normalized);
              if (sweepNumber === 1) firstSweep.add(normalized);
              else secondSweep.add(normalized);
            }
          }
        }
      }
      independentSweep2New += [...secondSweep].filter((candidate) => !firstSweep.has(candidate)).length;
      allCandidatesBySense.set(sense.sense_id, candidateSet);
    }
  }

  const candidateReviews = checkpoint.records.flatMap((record) => record.senses.flatMap((sense) => sense.candidate_reviews));
  const finalCandidateKinds = { word: 0, condensed_phrase: 0, fixed_expression: 0 };
  for (const review of candidateReviews) if (review.decision === 'KEEP' && review.kind in finalCandidateKinds) finalCandidateKinds[review.kind] += 1;

  const finalUnique = new Set();
  for (const review of candidateReviews) if (review.decision === 'KEEP') finalUnique.add(`${review.sense_id}\0${review.normalized}`);
  const finalKeptCount = finalUnique.size;
  const finalSpacing = { no_space: 0, space: 0 };
  for (const review of candidateReviews) {
    if (review.decision !== 'KEEP' || !finalUnique.delete(`${review.sense_id}\0${review.normalized}`)) continue;
    if (/\s/u.test(review.candidate)) finalSpacing.space += 1;
    else finalSpacing.no_space += 1;
  }

  return {
    contract: CHECKPOINT_CONTRACT,
    batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch, model: checkpoint.batch.model, state: outputIsCurrent ? 'OUTPUT' : checkpoint.output ? 'OUTPUT_STALE' : 'IN_PROGRESS' },
    coverage: {
      records: checkpoint.records.length,
      senses: checkpoint.records.reduce((count, record) => count + record.senses.length, 0),
      sense_statuses: senseStatuses,
      contexts: totalContexts,
      context_judgments: contextJudgments,
      work_diversity: {
        distinct_works: contextCountByWork.size,
        max_contexts_per_work: Math.max(0, ...contextCountByWork.values()),
      },
    },
    sweeps: {
      per_sweep_lens_totals: sweepCounts,
      raw_discoveries: rawDiscoveries,
      duplicate_discoveries: duplicateDiscoveries,
      sweep2_new_against_sweep1: independentSweep2New,
      unique_discoveries: [...allCandidatesBySense.values()].reduce((sum, candidates) => sum + candidates.size, 0),
    },
    final_candidates: {
      kept: finalKeptCount,
      spacing: finalSpacing,
      kinds: finalCandidateKinds,
      reviewed: candidateReviews.length,
    },
    output: checkpoint.output ? {
      state: outputIsCurrent ? 'OUTPUT' : 'OUTPUT_STALE',
      path: checkpoint.output.path ?? null,
      sha256: checkpoint.output.sha256 ?? null,
      validation_status: checkpoint.output.validation_status ?? checkpoint.output.validation?.status ?? null,
      patch_count: checkpoint.output.patch_history?.length ?? 0,
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
      procedure_contract: 'issue-1155-c-literary-v1',
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
        search: null,
        contexts: [],
        candidate_reviews: [],
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
  if (checkpoint?.contract !== CHECKPOINT_CONTRACT || !Array.isArray(checkpoint.records)) fail('unsupported literary checkpoint contract');
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

/** Add a source-bound additional inflection without inventing or generalizing morphology. */
export async function addSearchForm(checkpointPath, senseId, form, basis, options = {}) {
  if (typeof form !== 'string' || form.trim() === '' || typeof basis !== 'string' || basis.trim() === '') fail('additional form and its source/basis are required');
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  const { sense } = findSense(checkpoint, senseId);
  const normalized = form.normalize('NFC').trim();
  const alreadyKnown = sense.search_forms.includes(normalized) || sense.added_forms.some((item) => item.form === normalized);
  if (!alreadyKnown) {
    if (sense.contexts.length > 0) fail('add reviewed search forms before retrieving contexts so the per-sense 16-context cap remains exact');
    markOutputStale(checkpoint, 'search forms changed');
    sense.added_forms.push({ form: normalized, basis: basis.trim(), added_at: new Date().toISOString() });
    sense.added_forms.sort((left, right) => compare(left.form, right.form));
    sense.search_history ??= [];
    if (sense.search) sense.search_history.push({ ...sense.search });
    sense.search = null;
  }
  await saveCheckpoint(resolvedPath, checkpoint);
  return { sense_id: senseId, query_form_count: new Set([...sense.search_forms, ...sense.added_forms.map((item) => item.form)]).size };
}

/** Count all source-sense hits in a batch without returning source text or a sense ledger. */
export async function scanLiteraryBatch({ databasePath, checkpointPath, scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const { database, metadata } = openLiteraryIndex(databasePath);
  try {
    await assertCheckpointIndexUnchanged(checkpoint, databasePath, metadata);
    const started = performance.now();
    const queryDurations = [];
    const failures = [];
    let searched = 0;
    let hitSenses = 0;
    let zeroHitSenses = 0;
    let unsearchableSenses = 0;
    for (const [recordIndex, record] of checkpoint.records.entries()) {
      for (const sense of record.senses) {
        const forms = [...new Set([...sense.search_forms, ...sense.added_forms.map((item) => item.form)])].sort(compare);
        const fingerprint = sha256(JSON.stringify(forms));
        const reusableCount = ['COUNTED', 'INCOMPLETE', 'SEARCHED', 'ZERO_HITS'].includes(sense.search?.status)
          || sense.search?.status === 'SEARCH_FAILED' && Number.isInteger(sense.search.total_hits);
        if (reusableCount && sense.search.query_sha256 === fingerprint) {
          searched += 1;
          if (sense.search.total_hits > 0) hitSenses += 1;
          else zeroHitSenses += 1;
          continue;
        }
        if (forms.length === 0) {
          sense.search_history ??= [];
          if (sense.search) sense.search_history.push({ ...sense.search });
          sense.search = { status: 'UNSEARCHABLE', query_sha256: fingerprint, query_form_count: 0, total_hits: null, pages: 0, returned_contexts: 0, next_cursor: null, searched_at: new Date().toISOString(), error: 'no canonical or explicitly added search forms' };
          unsearchableSenses += 1;
          continue;
        }
        const queryStarted = performance.now();
        try {
          const totalHits = countMatches(database, forms);
          queryDurations.push(performance.now() - queryStarted);
          sense.search_history ??= [];
          if (sense.search) sense.search_history.push({ ...sense.search });
          sense.search = {
            status: totalHits === 0 ? 'ZERO_HITS' : 'COUNTED',
            query_sha256: fingerprint,
            query_form_count: forms.length,
            total_hits: totalHits,
            pages: 0,
            returned_contexts: 0,
            next_cursor: null,
            searched_at: new Date().toISOString(),
            error: null,
          };
          searched += 1;
          if (totalHits === 0) zeroHitSenses += 1;
          else hitSenses += 1;
        } catch (error) {
          queryDurations.push(performance.now() - queryStarted);
          sense.search_history ??= [];
          if (sense.search) sense.search_history.push({ ...sense.search });
          sense.search = { status: 'SEARCH_FAILED', query_sha256: fingerprint, query_form_count: forms.length, total_hits: null, pages: 0, returned_contexts: sense.contexts.length, next_cursor: null, searched_at: new Date().toISOString(), error: 'literary unit query failed' };
          failures.push({ sense_id: sense.sense_id, error_type: error.name });
        }
      }
      if ((recordIndex + 1) % 25 === 0) await saveCheckpoint(resolvedCheckpoint, checkpoint);
    }
    await saveCheckpoint(resolvedCheckpoint, checkpoint);
    queryDurations.sort((left, right) => left - right);
    const median = queryDurations.length === 0 ? null : queryDurations[Math.floor(queryDurations.length / 2)];
    return {
      contract: LITERARY_CONTEXT_CONTRACT,
      status: failures.length > 0 || unsearchableSenses > 0 ? 'INCOMPLETE' : 'SEARCHED',
      batch: { shard: checkpoint.batch.shard, batch: checkpoint.batch.batch },
      total_senses: searched + unsearchableSenses + failures.length,
      searched_senses: searched,
      hit_senses: hitSenses,
      zero_hit_senses: zeroHitSenses,
      unsearchable_senses: unsearchableSenses,
      failed_senses: failures.length,
      failure_preview: failures.slice(0, 10),
      failure_preview_truncated: failures.length > 10,
      query_performance_ms: {
        total: Number((performance.now() - started).toFixed(1)),
        median_sense_query: median === null ? null : Number(median.toFixed(1)),
        max_sense_query: queryDurations.length === 0 ? null : Number(queryDurations.at(-1).toFixed(1)),
      },
      checkpoint: checkpointSummary(checkpoint),
    };
  } finally {
    database.close();
  }
}

/** Return a bounded, resumable list of senses by state; the total and truncation are always explicit. */
export async function listLiterarySearchQueue(checkpointPath, { status, offset = 0, limit = 50 }, options = {}) {
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) fail('queue offset must be a non-negative integer');
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) fail('queue limit must be an integer in [1, 100]');
  if (typeof status !== 'string' || status.trim() === '') fail('queue status is required');
  const { checkpoint } = await loadLiteraryCheckpoint(checkpointPath, options);
  const rows = checkpoint.records.flatMap((record) => record.senses.map((sense) => ({
    record_id: record.record_id,
    sense_id: sense.sense_id,
    lemma: record.lemma,
    status: currentSenseStatus(sense),
    search_status: sense.search?.status ?? 'PENDING',
    total_hits: sense.search?.total_hits ?? null,
    context_count: sense.contexts.length,
  }))).filter((item) => item.status === status || item.search_status === status);
  const items = rows.slice(parsedOffset, parsedOffset + parsedLimit);
  const hasMore = parsedOffset + items.length < rows.length;
  return {
    status: 'READY',
    state_filter: status,
    total_count: rows.length,
    offset: parsedOffset,
    returned: items.length,
    has_more: hasMore,
    truncated: hasMore,
    next_offset: hasMore ? parsedOffset + items.length : null,
    items,
  };
}

/** Search one exact Canonical sense. Every page and its private excerpt is checkpointed locally. */
export async function searchLiterarySense({ databasePath, checkpointPath, senseId, pageSize, snippetChars, cursor, scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const { record, sense } = findSense(checkpoint, senseId);
  const currentForms = [...new Set([...sense.search_forms, ...sense.added_forms.map((item) => item.form)])].sort(compare);
  const requestedPageSize = validatePageSize(pageSize);
  const snippetLimit = validateSnippetChars(snippetChars);
  const remainingContextSlots = MAX_CONTEXTS_PER_SENSE - sense.contexts.length;
  if (remainingContextSlots <= 0) fail(`the #1155 limit of ${MAX_CONTEXTS_PER_SENSE} inspected contexts per sense is reached; record the sampling stop with finish-search`);
  const page = Math.min(requestedPageSize, remainingContextSlots);
  if (sense.search && !['COUNTED', 'INCOMPLETE', 'SEARCH_FAILED'].includes(sense.search.status) && !cursor) fail('this sense search is already complete; preserve the checkpoint or initialize a new batch');
  if (cursor && sense.search?.next_cursor !== cursor) fail('page cursor is stale or does not match this checkpoint');
  if (cursor) cursorDecode(cursor, sha256(JSON.stringify(currentForms)));
  const priorSearch = sense.search ? { ...sense.search } : null;
  const attemptCursor = cursor ?? priorSearch?.next_cursor ?? null;
  let attemptTotalHits = priorSearch?.total_hits ?? null;
  let opened;
  try {
    opened = openLiteraryIndex(databasePath);
    await assertCheckpointIndexUnchanged(checkpoint, databasePath, opened.metadata);
    const results = runSearch(opened.database, currentForms, { pageSize: page, cursor: attemptCursor, snippetChars: snippetLimit });
    attemptTotalHits = results.total_hits;
    const queryHash = sha256(JSON.stringify(currentForms));
    sense.search_history ??= [];
    if (priorSearch && ['COUNTED', 'SEARCH_FAILED'].includes(priorSearch.status)) sense.search_history.push(priorSearch);
    sense.search = {
      status: results.status,
      query_sha256: queryHash,
      query_form_count: currentForms.length,
      total_hits: results.total_hits,
      pages: (priorSearch?.pages ?? 0) + 1,
      returned_contexts: sense.contexts.length,
      next_cursor: results.next_cursor,
      searched_at: new Date().toISOString(),
      error: null,
    };
    for (const result of results.results) {
      const existing = sense.contexts.find((context) => context.locator_key === result.locator_key);
      if (existing) {
        existing.matched_forms = [...new Set([...existing.matched_forms, ...result.matched_forms])].sort(compare);
        existing.context_sha256 = result.context_sha256;
        existing.context_text = result._private.context_text;
        existing.unit_window = result._private.unit_window;
      } else {
        sense.contexts.push({
          locator_key: result.locator_key,
          locator: result._private.locator,
          source: result.source,
          unit_ordinal: result.unit_ordinal,
          unit_kind: result.unit_kind,
          matched_forms: result.matched_forms,
          context_sha256: result.context_sha256,
          context_text: result._private.context_text,
          unit_window: result._private.unit_window,
          context_window: result.context_window,
          excerpt: result.excerpt,
          excerpt_truncated: result.excerpt_truncated,
          judgment: 'PENDING',
          judgment_history: [],
          sweeps: {},
        });
      }
    }
    sense.search.returned_contexts = sense.contexts.length;
    await saveCheckpoint(resolvedCheckpoint, checkpoint);
    return {
      contract: LITERARY_CONTEXT_CONTRACT,
      sense: { record_id: record.record_id, sense_id: sense.sense_id, lemma: record.lemma, pos: sense.pos, gloss: sense.gloss.slice(0, 600), gloss_truncated: sense.gloss.length > 600 },
      status: results.status,
      total_hits: results.total_hits,
      returned: results.returned,
      has_more: results.has_more,
      next_cursor: results.next_cursor,
      truncated: results.has_more,
      work_diversity: results.work_diversity,
      query_form_count: currentForms.length,
      results: results.results.map(({ _private, context_sha256: _contextDigest, ...publicResult }) => publicResult),
    };
  } catch (error) {
    sense.search_history ??= [];
    if (priorSearch) sense.search_history.push(priorSearch);
    sense.search = {
      status: 'SEARCH_FAILED',
      query_sha256: sha256(JSON.stringify(currentForms)),
      query_form_count: currentForms.length,
      total_hits: attemptTotalHits,
      pages: priorSearch?.pages ?? 0,
      returned_contexts: sense.contexts.length,
      next_cursor: attemptCursor,
      searched_at: new Date().toISOString(),
      error: 'literary unit query failed',
    };
    await saveCheckpoint(resolvedCheckpoint, checkpoint);
    throw error;
  } finally {
    opened?.database.close();
  }
}

/** Explicitly finish an adaptive context sample after every returned context has a real disposition. */
export async function finishLiterarySearch(checkpointPath, { senseId, note }, options = {}) {
  if (typeof note !== 'string' || note.trim().length < 8) fail('finish-search needs a concise reason for stopping context sampling');
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  markOutputStale(checkpoint, 'context sample completion changed');
  const { sense } = findSense(checkpoint, senseId);
  if (sense.search?.status !== 'INCOMPLETE' || !sense.search.next_cursor) fail('finish-search is only for a search with remaining paginated contexts');
  if (sense.contexts.some((context) => context.judgment === 'PENDING')) fail('review every returned context before finishing the search sample');
  const inspectedContexts = sense.contexts.length;
  if (inspectedContexts < 1 || inspectedContexts > MAX_CONTEXTS_PER_SENSE) fail('context sample size is outside the #1155 limit');
  sense.search.sampling_history ??= [];
  sense.search.sampling_history.push({
    stopped_at: new Date().toISOString(),
    note: note.trim(),
    inspected_contexts: inspectedContexts,
    total_hits: sense.search.total_hits,
    remaining_hit_count: Math.max(0, sense.search.total_hits - inspectedContexts),
    continuation_cursor: sense.search.next_cursor,
  });
  sense.search.status = 'SEARCHED';
  sense.search.sampling_complete = true;
  sense.search.sampling_stop_note = note.trim();
  sense.search.remaining_hit_count = Math.max(0, sense.search.total_hits - inspectedContexts);
  sense.search.next_cursor = null;
  sense.search.searched_at = new Date().toISOString();
  await saveCheckpoint(resolvedPath, checkpoint);
  return {
    sense_id: senseId,
    status: currentSenseStatus(sense),
    sampling_complete: true,
    inspected_contexts: inspectedContexts,
    total_hits: sense.search.total_hits,
    remaining_hit_count: sense.search.remaining_hit_count,
    truncated: sense.search.remaining_hit_count > 0,
  };
}

/** Record an explicit human/AI source-sense disposition for exactly one returned physical text unit. */
export async function reviewLiteraryContext(checkpointPath, { senseId, locatorKey, judgment, note }, options = {}) {
  if (!['VERIFIED', 'AMBIGUOUS', 'REJECTED'].includes(judgment)) fail('judgment must be VERIFIED, AMBIGUOUS, or REJECTED');
  if (typeof note !== 'string' || note.trim().length < 3) fail('a concise source-sense review note is required');
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  markOutputStale(checkpoint, 'source-sense judgment changed');
  const { sense } = findSense(checkpoint, senseId);
  const context = getContext(sense, locatorKey);
  context.judgment = judgment;
  context.judgment_history.push({ judgment, note: note.trim(), reviewed_at: new Date().toISOString() });
  await saveCheckpoint(resolvedPath, checkpoint);
  return { sense_id: senseId, locator_key: locatorKey, judgment, sense_status: currentSenseStatus(sense) };
}

function validateSweepResults(results) {
  assertRecord(results, 'sweep results');
  if (!exactKeys(results, SWEEP_LENSES)) fail(`sweep results must contain exactly these seven lenses: ${SWEEP_LENSES.join(', ')}`);
  for (const lens of SWEEP_LENSES) {
    if (!Array.isArray(results[lens]) || results[lens].some((candidate) => typeof candidate !== 'string' || candidate.trim() === '')) {
      fail(`${lens} must be a string[]; use [] to record an inspected lens with zero discoveries`);
    }
  }
}

/** Store one complete independent sweep. Empty lens arrays are explicit zero results. */
export async function recordLiterarySweep(checkpointPath, { senseId, locatorKey, sweep, results, independentRead = false }, options = {}) {
  if (![1, 2].includes(Number(sweep))) fail('sweep must be 1 or 2');
  validateSweepResults(results);
  const sweepNumber = Number(sweep);
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  markOutputStale(checkpoint, 'sweep evidence changed');
  const { sense } = findSense(checkpoint, senseId);
  const context = getContext(sense, locatorKey);
  if (context.judgment !== 'VERIFIED') fail('only a manually VERIFIED context can be swept');
  if (context.sweeps[String(sweepNumber)]) fail(`sweep ${sweepNumber} is already recorded; preserve history instead of replacing it`);
  if (sweepNumber === 2 && (!context.sweeps['1'] || independentRead !== true)) {
    fail('sweep 2 requires sweep 1 and an explicit independent-read attestation after rereading the same context');
  }
  context.sweeps[String(sweepNumber)] = {
    recorded_at: new Date().toISOString(),
    independent_read_attested: sweepNumber === 2,
    results: Object.fromEntries(SWEEP_LENSES.map((lens) => [lens, results[lens].map((candidate) => candidate.normalize('NFC').trim())])),
  };
  await saveCheckpoint(resolvedPath, checkpoint);
  const summary = checkpointSummary(checkpoint);
  return { sense_id: senseId, locator_key: locatorKey, sweep: sweepNumber, lens_count: SWEEP_LENSES.length, candidates: SWEEP_LENSES.reduce((count, lens) => count + results[lens].length, 0), status: currentSenseStatus(sense), summary: summary.sweeps };
}

function candidatesForSense(sense) {
  const candidates = new Map();
  for (const context of sense.contexts) {
    if (context.judgment !== 'VERIFIED') continue;
    for (const sweep of ['1', '2']) {
      for (const lens of SWEEP_LENSES) {
        for (const candidate of context.sweeps[sweep]?.results[lens] ?? []) {
          const normalized = normalizeCandidate(candidate);
          if (!candidates.has(normalized)) candidates.set(normalized, candidate.trim());
        }
      }
    }
  }
  return candidates;
}

/** Record the producer's explicit form-gate disposition and type for one discovered expression. */
export async function reviewLiteraryCandidate(checkpointPath, { senseId, candidate, decision, kind, note }, options = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') fail('candidate is required');
  if (!['KEEP', 'REMOVE'].includes(decision)) fail('decision must be KEEP or REMOVE');
  if (decision === 'KEEP' && !['word', 'condensed_phrase', 'fixed_expression'].includes(kind)) fail('a kept candidate needs kind word, condensed_phrase, or fixed_expression');
  if (typeof note !== 'string' || note.trim().length < 3) fail('a concise candidate form-review note is required');
  const { checkpoint, path: resolvedPath } = await loadLiteraryCheckpoint(checkpointPath, options);
  markOutputStale(checkpoint, 'candidate form disposition changed');
  const { sense } = findSense(checkpoint, senseId);
  const normalized = normalizeCandidate(candidate);
  const known = candidatesForSense(sense);
  if (!known.has(normalized)) fail('candidate is not present in a recorded VERIFIED sweep');
  const review = {
    sense_id: senseId,
    candidate: known.get(normalized),
    normalized,
    decision,
    kind: decision === 'KEEP' ? kind : null,
    note: note.trim(),
    reviewed_at: new Date().toISOString(),
  };
  const index = sense.candidate_reviews.findIndex((item) => item.normalized === normalized);
  if (index >= 0) {
    const previous = sense.candidate_reviews[index];
    const history = previous.history ?? [];
    const previousReview = { ...previous };
    delete previousReview.history;
    history.push(previousReview);
    sense.candidate_reviews[index] = { ...review, history };
  } else {
    sense.candidate_reviews.push(review);
    sense.candidate_reviews.sort((left, right) => compare(left.normalized, right.normalized));
  }
  await saveCheckpoint(resolvedPath, checkpoint);
  return { sense_id: senseId, candidate: review.candidate, decision, kind: review.kind, status: currentSenseStatus(sense) };
}

export async function getLiteraryContextPage(databasePath, checkpointPath, { senseId, locatorKey, offset = 0, chars = MAX_CONTEXT_PAGE_CHARS }, options = {}) {
  const parsedOffset = Number(offset);
  const parsedChars = Number(chars);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) fail('context offset must be a non-negative integer');
  if (!Number.isInteger(parsedChars) || parsedChars < 100 || parsedChars > MAX_CONTEXT_PAGE_CHARS) fail(`context chars must be in [100, ${MAX_CONTEXT_PAGE_CHARS}]`);
  const { checkpoint } = await loadLiteraryCheckpoint(checkpointPath, options);
  const { sense } = findSense(checkpoint, senseId);
  const context = getContext(sense, locatorKey);
  const { database, metadata } = openLiteraryIndex(databasePath);
  try {
    await assertCheckpointIndexUnchanged(checkpoint, databasePath, metadata);
    const window = readUnitWindow(database, context.locator);
    if (window.sha256 !== context.context_sha256 || JSON.stringify(window.units) !== JSON.stringify(context.unit_window)) {
      fail('literary context locator changed after search; start a new checkpoint from the verified index');
    }
    const charsArray = [...window.text];
    const slice = charsArray.slice(parsedOffset, parsedOffset + parsedChars);
    const nextOffset = parsedOffset + slice.length;
    return {
      sense_id: senseId,
      locator_key: locatorKey,
      judgment: context.judgment,
      unit_window: context.context_window,
      total_chars: charsArray.length,
      offset: parsedOffset,
      chars_returned: slice.length,
      has_more: nextOffset < charsArray.length,
      next_offset: nextOffset < charsArray.length ? nextOffset : null,
      truncated: nextOffset < charsArray.length,
      text: slice.join(''),
    };
  } finally {
    database.close();
  }
}

export function summarizeLiteraryCheckpoint(checkpoint) {
  return checkpointSummary(checkpoint);
}

function candidateRowsFromCheckpoint(checkpoint) {
  return checkpoint.records.map((record) => ({
    record_id: record.record_id,
    senses: record.senses.map((sense) => ({
      sense_id: sense.sense_id,
      candidates: [...candidatesForSense(sense).entries()]
        .filter(([normalized]) => sense.candidate_reviews.find((item) => item.normalized === normalized)?.decision === 'KEEP')
        .map(([, candidate]) => candidate),
    })),
  }));
}

function validateLiteraryEvidence(checkpoint, candidateRows, canonicalRows) {
  const expectedRows = candidateRowsFromCheckpoint(checkpoint);
  const acceptableStatuses = new Set(['NO_VERIFIED', 'SAMPLED_NO_VERIFIED', 'DISCOVERED']);
  const invalid = (message, record, sense = null, candidate = null) => ({
    status: 'INVALID',
    error_type: 'LiteraryEvidenceValidationError',
    message,
    affected: {
      record_id: record.record_id,
      sense_id: sense?.sense_id ?? null,
      candidate,
    },
    repair_scope: 'Reconcile this Candidate row with the current completed source-sense evidence and KEEP/REMOVE disposition, then validate the complete batch again.',
  });

  const batchOffset = (Number(checkpoint.batch.batch) - 1) * CANDIDATE_BATCH_SIZE;
  const expectedCanonicalRecords = canonicalRows.slice(batchOffset, batchOffset + CANDIDATE_BATCH_SIZE);
  if (checkpoint.records.length !== expectedCanonicalRecords.length) {
    return invalid(`checkpoint has ${checkpoint.records.length} records; expected ${expectedCanonicalRecords.length} from the current Canonical batch`, checkpoint.records[0] ?? { record_id: null });
  }

  for (const [recordIndex, record] of checkpoint.records.entries()) {
    const candidateRecord = candidateRows[recordIndex];
    const expectedRecord = expectedRows[recordIndex];
    const sourceRecord = expectedCanonicalRecords[recordIndex];
    if (record.record_id !== sourceRecord.id || record.lemma !== sourceRecord.lemma
      || JSON.stringify(record.search_forms) !== JSON.stringify(Array.isArray(sourceRecord.search_forms) ? sourceRecord.search_forms : [])) {
      return invalid(`checkpoint record ${record.record_id} is not bound to current Canonical record ${sourceRecord.id}`, record);
    }
    if (record.senses.length !== sourceRecord.senses.length) {
      return invalid(`checkpoint has ${record.senses.length} senses for ${sourceRecord.id}; expected ${sourceRecord.senses.length} from Canonical`, record);
    }
    for (const [senseIndex, sense] of record.senses.entries()) {
      const sourceSense = sourceRecord.senses[senseIndex];
      if (sense.sense_id !== sourceSense.id || sense.pos !== sourceSense.pos || sense.gloss !== (sourceSense.gloss ?? '')
        || JSON.stringify(sense.search_forms) !== JSON.stringify(formsForSense(sourceRecord, sourceSense))) {
        return invalid(`checkpoint sense ${sense.sense_id} is not bound to current Canonical sense ${sourceSense.id}`, record, sense);
      }
      const status = currentSenseStatus(sense);
      if (!acceptableStatuses.has(status)) {
        return invalid(`cannot validate current literary evidence: ${sense.sense_id} is ${status}`, record, sense);
      }

      for (const context of sense.contexts) {
        if (context.judgment !== 'VERIFIED') continue;
        const firstSweep = context.sweeps?.['1'];
        const secondSweep = context.sweeps?.['2'];
        if (!firstSweep || !secondSweep || secondSweep.independent_read_attested !== true) {
          return invalid(`verified context ${context.locator_key} on ${sense.sense_id} lacks two complete independent sweeps`, record, sense);
        }
        try {
          validateSweepResults(firstSweep.results);
          validateSweepResults(secondSweep.results);
        } catch (error) {
          return invalid(`verified context ${context.locator_key} on ${sense.sense_id} has invalid sweep evidence: ${error.message}`, record, sense);
        }
      }

      const discovered = candidatesForSense(sense);
      for (const [normalized, candidate] of discovered) {
        const review = sense.candidate_reviews.find((item) => item.normalized === normalized);
        if (!review || !['KEEP', 'REMOVE'].includes(review.decision)) {
          return invalid(`discovered candidate ${JSON.stringify(candidate)} on ${sense.sense_id} has no current form-gate disposition`, record, sense, candidate);
        }
        if (review.decision === 'KEEP' && !['word', 'condensed_phrase', 'fixed_expression'].includes(review.kind)) {
          return invalid(`kept candidate ${JSON.stringify(candidate)} on ${sense.sense_id} has no valid expression classification`, record, sense, candidate);
        }
      }

      const expected = new Map(expectedRecord.senses[senseIndex].candidates.map((candidate) => [normalizeCandidate(candidate), candidate]));
      const actual = candidateRecord.senses[senseIndex].candidates;
      const seen = new Set();
      for (const candidate of actual) {
        const normalized = normalizeCandidate(candidate);
        const evidenceCandidate = expected.get(normalized);
        if (!evidenceCandidate) {
          return invalid(`candidate ${JSON.stringify(candidate)} on ${sense.sense_id} has no current VERIFIED sweep and KEEP disposition`, record, sense, candidate);
        }
        if (candidate !== evidenceCandidate) {
          return invalid(`candidate ${JSON.stringify(candidate)} on ${sense.sense_id} differs from its reviewed evidence form ${JSON.stringify(evidenceCandidate)}`, record, sense, candidate);
        }
        seen.add(normalized);
      }
      for (const [normalized, candidate] of expected) {
        if (!seen.has(normalized)) {
          return invalid(`current KEEP candidate ${JSON.stringify(candidate)} on ${sense.sense_id} is missing from the Candidate file`, record, sense, candidate);
        }
      }
    }
  }
  return null;
}

/** Validate the full candidate batch with the common Candidate v1 validator and scope a failure to its row. */
export async function validateLiteraryExport({ checkpointPath, canonicalPath, candidateRows, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const canonicalText = await readFile(canonicalPath, 'utf8');
  if (sha256(canonicalText) !== checkpoint.batch.canonical_sha256) fail('Canonical shard changed after checkpoint initialization');
  const canonicalRows = parseCanonicalShard(canonicalText, canonicalPath);
  const canonicalLemmaForms = await loadCanonicalLemmaForms(repositoryDirectory);
  const batchNumber = Number(checkpoint.batch.batch);
  try {
    const summary = validateCandidateBatch(canonicalRows, candidateRows, {
      batch: batchNumber,
      canonicalLemmaForms,
      sourceName: canonicalPath,
      candidateName: `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`,
    });
    const evidenceFailure = validateLiteraryEvidence(checkpoint, candidateRows, canonicalRows);
    if (evidenceFailure) return evidenceFailure;
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
      repair_scope: 'Correct only the reported Candidate row/sense/candidate, then run the complete Candidate v1 validation again before submission.',
    };
  }
}

/** Export only after every search, context judgment, sweep, and candidate form review is complete. */
export async function exportLiteraryCandidates({ checkpointPath, canonicalPath, outputPath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  if (checkpoint.output) fail('this checkpoint already has an exported output; preserve it and use a new checkpoint for a new output');
  const expectedName = `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`;
  if (path.basename(outputPath) !== expectedName) fail(`output filename must be ${expectedName}`);
  const candidateRows = candidateRowsFromCheckpoint(checkpoint);
  const validation = await validateLiteraryExport({ checkpointPath: resolvedCheckpoint, canonicalPath, candidateRows, repositoryDirectory, scratchDirectory });
  if (validation.status !== 'VALID') fail(`${validation.message}${validation.affected ? ` (affected ${JSON.stringify(validation.affected)})` : ''}`);
  const resolvedOutput = path.resolve(outputPath);
  const expectedRepositoryPath = path.resolve(repositoryDirectory, 'data/relation-candidates', checkpoint.batch.shard, expectedName);
  try {
    assertScratchPath(resolvedOutput, scratchDirectory);
  } catch (error) {
    if (resolvedOutput !== expectedRepositoryPath) throw error;
  }
  try {
    await stat(resolvedOutput);
    fail(`refusing to overwrite existing Candidate output ${resolvedOutput}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
    ...validation,
  };
  await saveCheckpoint(resolvedCheckpoint, checkpoint);
  return { status: 'OUTPUT', output: checkpoint.output, coverage: { records: validation.recordCount, senses: validation.senseCount, candidates: validation.candidateCount, empty_senses: validation.emptySenseCount } };
}

/** Validate an already exported/fixed candidate file via the common Candidate v1 contract. */
export async function validateExistingLiteraryCandidates({ checkpointPath, canonicalPath, candidatePath, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const candidateText = await readFile(candidatePath, 'utf8');
  let candidateRows;
  let validation;
  try {
    candidateRows = candidateText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    validation = { status: 'INVALID', error_type: error.name, message: `Candidate JSONL parse failed: ${error.message}`, affected: null };
  }
  const expectedName = `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`;
  if (path.basename(candidatePath) !== expectedName) fail(`candidate filename must be ${expectedName}`);
  validation ??= await validateLiteraryExport({ checkpointPath, canonicalPath, candidateRows, repositoryDirectory, scratchDirectory });
  checkpoint.output = {
    ...(checkpoint.output ?? {}),
    path: path.relative(process.cwd(), path.resolve(candidatePath)),
    sha256: sha256(candidateText),
    validated_at: new Date().toISOString(),
    validation_status: validation.status,
    stale: validation.status !== 'VALID',
    stale_reason: validation.status === 'VALID' ? null : validation.message,
  };
  await saveCheckpoint(resolvedCheckpoint, checkpoint);
  return validation;
}

/** Apply one exact, source-reviewed Candidate correction and report any remaining batch validator failure. */
export async function patchLiteraryCandidateFile({ checkpointPath, canonicalPath, candidatePath, recordId, senseId, action, candidate, replacement, reason, repositoryDirectory = process.cwd(), scratchDirectory = path.resolve(CHECKPOINT_SCRATCH_DIRECTORY) }) {
  if (!['remove', 'replace'].includes(action)) fail('patch action must be remove or replace');
  if (typeof recordId !== 'string' || !recordId || typeof senseId !== 'string' || !senseId) fail('record_id and sense_id are required');
  if (typeof candidate !== 'string' || candidate.trim() === '') fail('exact candidate to patch is required');
  if (action === 'replace' && (typeof replacement !== 'string' || replacement.trim() === '')) fail('replacement candidate is required');
  if (typeof reason !== 'string' || reason.trim().length < 3) fail('a concise correction reason is required');

  const { checkpoint, path: resolvedCheckpoint } = await loadLiteraryCheckpoint(checkpointPath, { scratchDirectory });
  const expectedName = `${checkpoint.batch.shard}_${checkpoint.batch.batch}_c_${checkpoint.batch.model}.jsonl`;
  const resolvedCandidate = path.resolve(candidatePath);
  if (path.basename(resolvedCandidate) !== expectedName) fail(`candidate filename must be ${expectedName}`);
  const expectedRepositoryPath = path.resolve(repositoryDirectory, 'data/relation-candidates', checkpoint.batch.shard, expectedName);
  try {
    assertScratchPath(resolvedCandidate, scratchDirectory);
  } catch (error) {
    if (resolvedCandidate !== expectedRepositoryPath) throw error;
  }

  const { sense } = findSense(checkpoint, senseId);
  const normalizedCandidate = normalizeCandidate(candidate);
  const oldReview = sense.candidate_reviews.find((item) => item.normalized === normalizedCandidate);
  if (!oldReview || oldReview.decision !== 'REMOVE') fail('patch target must have an explicit REMOVE decision in the local form-review checkpoint');
  const text = await readFile(resolvedCandidate, 'utf8');
  const rows = parseCandidateJsonl(text, resolvedCandidate);
  const rowIndex = rows.findIndex((row) => row.record_id === recordId);
  if (rowIndex < 0) fail(`record_id ${JSON.stringify(recordId)} is not in the Candidate file`);
  const candidateSense = rows[rowIndex].senses?.find((item) => item.sense_id === senseId);
  if (!candidateSense) fail(`sense_id ${JSON.stringify(senseId)} is not in Candidate record ${recordId}`);
  const oldIndex = candidateSense.candidates.indexOf(candidate);
  if (oldIndex < 0) fail('exact patch candidate is not present in the specified record and sense');
  if (candidateSense.candidates.lastIndexOf(candidate) !== oldIndex) fail('patch target occurs more than once; resolve the duplicate explicitly before applying this one-candidate patch');

  if (action === 'replace') {
    const normalizedReplacement = normalizeCandidate(replacement);
    const replacementReview = sense.candidate_reviews.find((item) => item.normalized === normalizedReplacement);
    if (!replacementReview || replacementReview.decision !== 'KEEP') fail('replacement must have an explicit KEEP decision and verified sweep evidence in this checkpoint');
    if (candidateSense.candidates.some((item) => normalizeCandidate(item) === normalizedReplacement)) fail('replacement already exists in the same source sense');
    candidateSense.candidates[oldIndex] = replacementReview.candidate;
  } else {
    candidateSense.candidates.splice(oldIndex, 1);
  }

  const validation = await validateLiteraryExport({ checkpointPath: resolvedCheckpoint, canonicalPath, candidateRows: rows, repositoryDirectory, scratchDirectory });
  const serialized = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const currentStat = await stat(resolvedCandidate);
  const temporary = `${resolvedCandidate}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { mode: currentStat.mode & 0o777 });
  await rename(temporary, resolvedCandidate);
  checkpoint.output = {
    ...(checkpoint.output ?? {}),
    path: path.relative(process.cwd(), resolvedCandidate),
    sha256: sha256(serialized),
    patched_at: new Date().toISOString(),
    patch_history: [
      ...(checkpoint.output?.patch_history ?? []),
      { record_id: recordId, sense_id: senseId, action, candidate, replacement: action === 'replace' ? replacement : null, reason: reason.trim(), applied_at: new Date().toISOString() },
    ],
    validation: { status: validation.status, message: validation.status === 'INVALID' ? validation.message : null },
    stale: validation.status !== 'VALID',
    stale_reason: validation.status === 'VALID' ? null : validation.message,
  };
  await saveCheckpoint(resolvedCheckpoint, checkpoint);
  return {
    status: validation.status,
    patched: { record_id: recordId, sense_id: senseId, action, candidate, replacement: action === 'replace' ? replacement : null },
    validation,
  };
}

export function normalizeLiteraryCandidate(value) {
  return normalizeCandidate(value);
}

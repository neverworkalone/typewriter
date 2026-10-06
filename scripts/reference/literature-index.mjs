import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

// Local-only literary-text pilot index (#332). TXT is the only source format.
// The literature schema is separate from the NIKL written-corpus index.

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const REPOSITORY_INDEX_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/reference/indexes');

export const LITERATURE_GENRES = Object.freeze(['poem', 'novel', 'essay']);
export const DEFAULT_LITERATURE_INPUT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/public-domain',
);
export const DEFAULT_LITERATURE_INDEX_PATH = path.join(
  REPOSITORY_INDEX_DIRECTORY,
  'literature-pilot-2026.sqlite',
);
export const DEFAULT_LITERATURE_MANIFEST_PATH = path.join(
  REPOSITORY_INDEX_DIRECTORY,
  'literature-pilot-2026.manifest.json',
);
export const DEFAULT_FULL_LITERATURE_INDEX_PATH = path.join(
  REPOSITORY_INDEX_DIRECTORY,
  'public-domain-literature.sqlite',
);
export const DEFAULT_FULL_LITERATURE_MANIFEST_PATH = path.join(
  REPOSITORY_INDEX_DIRECTORY,
  'public-domain-literature.manifest.json',
);
export const DEFAULT_LITERATURE_PERMISSION_RECORD_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'docs/external-material-review-public-domain-literature.md',
);

export const LITERATURE_SCHEMA_VERSION = '1';
export const LITERATURE_BUILDER_VERSION = '1';
export const LITERATURE_TOOL_IDENTITY = 'typewriter/scripts/reference/literature-index.mjs';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const MAX_PILOT_WORKS_PER_GENRE = 5;
const DEFAULT_CONTEXT_UNITS = 2;
const MAX_CONTEXT_UNITS = 3;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CP949 = new TextDecoder('euc-kr', { fatal: true, ignoreBOM: true });

function compareLexically(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isWithinDirectory(directoryPath, candidatePath) {
  const relative = path.relative(directoryPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------- permission

const PERMISSION_FIELDS = Object.freeze({
  'Intended role': 'reference',
  'Source terms': '공유마당 expired work',
  'Allowed local storage': 'permitted',
  'Allowed SQLite/FTS indexing': 'permitted',
  'Allowed lexical-reference use': 'permitted',
  'Distribution/embedding terms reviewed': 'complete',
  Decision: 'permitted for stated role',
});

export async function assertLiteraturePermission({
  permissionRecordPath = DEFAULT_LITERATURE_PERMISSION_RECORD_PATH,
} = {}) {
  let record;
  try {
    record = await readFile(permissionRecordPath, 'utf8');
  } catch (error) {
    throw new Error(
      'Literature use is not authorized: cannot read permission record '
      + permissionRecordPath + ' (' + error.message + ')',
    );
  }
  const fields = new Map();
  for (const line of record.split(/\r?\n/u)) {
    const match = line.match(/^- ([^:]+):\s*(.*?)\s*$/u);
    if (!match || !(match[1].trim() in PERMISSION_FIELDS)) continue;
    if (fields.has(match[1].trim())) {
      throw new Error('Permission record has a duplicate field: ' + match[1].trim());
    }
    fields.set(match[1].trim(), match[2].trim().toLowerCase());
  }
  const unresolved = Object.entries(PERMISSION_FIELDS)
    .filter(([field, value]) => fields.get(field) !== value)
    .map(([field]) => field);
  if (unresolved.length > 0) {
    throw new Error(
      'Literature scanning, indexing, and lookup are disabled until '
      + permissionRecordPath + ' records the required decision. Unresolved fields: '
      + unresolved.join(', ') + '.',
    );
  }
}

// ------------------------------------------------------------------ decoding

/**
 * Decode TXT bytes without altering the text. UTF-8 (with or without BOM) is
 * tried first; otherwise CP949/EUC-KR. Anything lossy, empty or garbled throws.
 * The BOM is recorded separately; no Unicode normalization is applied.
 */
export function decodeLiteratureText(bytes) {
  if (bytes.byteLength === 0) {
    throw new Error('empty file');
  }
  if (
    bytes.byteLength >= 2
    && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    throw new Error('unsupported UTF-16 byte order mark');
  }
  const hasBom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  if (body.byteLength === 0) {
    throw new Error('empty file (BOM only)');
  }
  let encoding = 'utf-8';
  let text;
  let ambiguityNote = null;
  try {
    text = UTF8.decode(body);
    // Valid UTF-8 that is also valid CP949 is ambiguous unless UTF-8 is clearly
    // the better reading (true UTF-8 Korean decodes to fewer Hangul as CP949).
    let alternative = null;
    try { alternative = CP949.decode(body); } catch { /* not CP949: unambiguous */ }
    if (alternative !== null && /[^\u0000-\u007F]/u.test(text)) {
      const hangul = (value) => (value.match(/[\uAC00-\uD7A3]/gu) ?? []).length;
      if (hangul(text) < hangul(alternative)) {
        throw new Error('ambiguous encoding: bytes are valid UTF-8 and valid CP949 and the CP949 reading has more Hangul');
      }
      ambiguityNote = 'also valid CP949; UTF-8 chosen because it yields at least as many Hangul syllables';
    }
  } catch (error) {
    if (error.message.startsWith('ambiguous encoding')) throw error;
    if (hasBom) {
      throw new Error('invalid UTF-8 sequence after UTF-8 BOM');
    }
    try {
      text = CP949.decode(body);
      encoding = 'cp949';
    } catch {
      throw new Error('undecodable bytes: neither valid UTF-8 nor valid CP949/EUC-KR');
    }
  }
  if (text.includes('�')) {
    throw new Error('decoded text contains U+FFFD replacement characters (lossy source)');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new Error('decoded text contains control characters (garbled or binary source)');
  }
  if (/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(text)) {
    throw new Error('decoded text contains private-use code points (unmapped glyph substitutes or wrong encoding; not faithfully interpretable)');
  }
  if (text.trim().length === 0) {
    throw new Error('file contains only whitespace');
  }
  if (encoding === 'cp949' && !/[가-힣]/u.test(text)) {
    throw new Error('CP949 decode produced no Hangul (ambiguous encoding)');
  }
  return { text, encoding, hasBom, ambiguityNote };
}

/** Faithful, reversible line units: each unit keeps its exact terminator. */
export function splitLiteratureUnits(text) {
  const units = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  let block = 0;
  let inBlock = false;
  for (const match of text.matchAll(pattern)) {
    const [, lineText, eol] = match;
    if (lineText === '' && eol === '') break;
    const blank = lineText.trim() === '';
    if (blank) {
      inBlock = false;
    } else if (!inBlock) {
      block += 1;
      inBlock = true;
    }
    units.push({
      ordinal: units.length,
      kind: blank ? 'blank' : 'text',
      blockOrdinal: blank ? null : block,
      text: lineText,
      eol,
    });
    if (eol === '') break;
  }
  return units;
}

export function reconstructLiteratureText(units) {
  return units.map((unit) => unit.text + unit.eol).join('');
}

function newlineConvention(text) {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/gu) ?? []).length;
  const cr = (text.match(/\r(?!\n)/gu) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  return lf > 0 ? 'lf' : 'cr';
}

/** Filename convention `<id>_<author>-<title>[-<seq>].txt`; unverified metadata. */
export function parseLiteratureFilename(fileName) {
  const base = fileName.replace(/\.txt$/iu, '');
  const match = base.match(/^(\d+)_([^-]+)-(.+?)(?:-(\d+))?$/u);
  if (!match) return { sourceId: null, author: null, title: null };
  return { sourceId: match[1], author: match[2], title: match[3] };
}

/** Pure analysis of one source file's bytes; never throws for bad content. */
export function analyzeLiteratureBytes(bytes, relativePath) {
  const result = {
    relative_path: relativePath,
    source_bytes: bytes.byteLength,
    source_sha256: sha256Hex(bytes),
    status: 'ok',
    warnings: [],
    error: null,
  };
  let decoded;
  try {
    decoded = decodeLiteratureText(bytes);
  } catch (error) {
    return { ...result, status: 'error', error: error.message };
  }
  const { text, encoding, hasBom, ambiguityNote } = decoded;
  const units = splitLiteratureUnits(text);
  const warnings = [];
  if (encoding === 'cp949') warnings.push('decoded as CP949; no independent check of the encoding choice');
  if (ambiguityNote) warnings.push(ambiguityNote);
  if (hasBom) warnings.push('UTF-8 BOM recorded and excluded from text units');
  if (!text.endsWith('\n') && !text.endsWith('\r')) warnings.push('missing terminal newline');
  const convention = newlineConvention(text);
  if (convention === 'mixed') warnings.push('mixed newline conventions preserved per unit');
  if (text !== text.normalize('NFC')) warnings.push('text is not NFC; stored as-is');
  if (/^\s*$/u.test(units[0]?.text ?? '')) warnings.push('leading blank line');
  return {
    ...result,
    status: warnings.length > 0 ? 'warning' : 'ok',
    warnings,
    encoding,
    has_bom: hasBom ? 1 : 0,
    newline_convention: convention,
    final_newline: text.endsWith('\n') || text.endsWith('\r') ? 1 : 0,
    nfc: text === text.normalize('NFC') ? 1 : 0,
    char_count: [...text].length,
    unit_count: units.length,
    text_unit_count: units.filter((unit) => unit.kind === 'text').length,
    block_count: units.at(-1) ? Math.max(0, ...units.map((unit) => unit.blockOrdinal ?? 0)) : 0,
    text,
    units,
  };
}

// ------------------------------------------------------------------ inventory

export async function listLiteratureSourcePaths(inputDirectory) {
  const paths = [];
  for (const genre of LITERATURE_GENRES) {
    const directory = path.join(inputDirectory, genre);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(directory + ': cannot list genre directory (' + error.message + ')');
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw new Error(path.join(genre, entry.name) + ': nested directories are not supported');
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
        paths.push(genre + '/' + entry.name);
      }
    }
  }
  return paths.sort(compareLexically);
}

/** Per-file ingestion result for a path list, without retaining text. */
export async function inventoryLiterature({
  inputDirectory = DEFAULT_LITERATURE_INPUT_DIRECTORY,
  relativePaths,
} = {}) {
  const paths = relativePaths ?? await listLiteratureSourcePaths(inputDirectory);
  const results = [];
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(inputDirectory, relativePath));
    const { text, units, ...rest } = analyzeLiteratureBytes(bytes, relativePath);
    results.push({ genre: relativePath.split('/')[0], ...rest });
  }
  return results;
}

export function literatureManifestDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => compareLexically(a.relative_path, b.relative_path))) {
    hash.update([file.relative_path, file.source_sha256, file.source_bytes].join('\u0000') + '\n');
  }
  return hash.digest('hex');
}

function quantileIndex(count, fraction) {
  return Math.min(count - 1, Math.floor(count * fraction));
}

/**
 * Deterministic pilot sample: per genre, from ingestable files only, ordered
 * rules pick structurally different works (size quantiles, CP949, BOM, LF-only,
 * missing terminal newline, stanza/paragraph breaks). Ties break on path.
 */
export function selectLiteraturePilotSample(inventory, perGenre = MAX_PILOT_WORKS_PER_GENRE) {
  if (perGenre < 3 || perGenre > MAX_PILOT_WORKS_PER_GENRE) {
    throw new RangeError('perGenre must be between 3 and ' + MAX_PILOT_WORKS_PER_GENRE);
  }
  const selected = [];
  for (const genre of LITERATURE_GENRES) {
    const eligible = inventory
      .filter((file) => file.genre === genre && file.status !== 'error' && file.block_count >= 1)
      .sort((a, b) => a.source_bytes - b.source_bytes || compareLexically(a.relative_path, b.relative_path));
    if (eligible.length === 0) continue;
    const chosen = [];
    const take = (file, rule) => {
      if (file && chosen.length < perGenre && !chosen.some((entry) => entry.file === file)) {
        chosen.push({ file, rule });
      }
    };
    const multiBlock = eligible.filter((file) => file.block_count >= 2);
    take(multiBlock[quantileIndex(multiBlock.length, 0.5)], 'median size, multiple blocks');
    take(eligible[quantileIndex(eligible.length, 0.95)], 'p95 size');
    take(eligible.find((file) => file.encoding === 'cp949'), 'first CP949 file');
    take(eligible.find((file) => file.has_bom), 'first UTF-8 BOM file');
    take(eligible.find((file) => file.newline_convention === 'lf'), 'first LF-only file');
    take(eligible.find((file) => !file.final_newline), 'first file without terminal newline');
    take(eligible.find((file) => !file.nfc), 'first non-NFC file');
    take(eligible[quantileIndex(eligible.length, 0.1)], 'p10 size');
    take(eligible[quantileIndex(eligible.length, 0.75)], 'p75 size');
    take(eligible[quantileIndex(eligible.length, 0.25)], 'p25 size');
    selected.push(...chosen.map(({ file, rule }) => ({ ...file, selection_rule: rule })));
  }
  return selected.sort((a, b) => compareLexically(a.relative_path, b.relative_path));
}

// ---------------------------------------------------------------- SQLite store

export function assertLiteratureFts5Support() {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'trigram')");
  } catch (error) {
    throw new Error('SQLite FTS5 trigram tokenizer is required: ' + error.message);
  } finally {
    database.close();
  }
}

export function createLiteratureSchema(database) {
  database.exec(`
    CREATE TABLE source_files (
      file_id INTEGER PRIMARY KEY,
      genre TEXT NOT NULL CHECK (genre IN ('poem', 'novel', 'essay')),
      relative_path TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL,
      source_bytes INTEGER NOT NULL CHECK (source_bytes > 0),
      encoding TEXT NOT NULL CHECK (encoding IN ('utf-8', 'cp949')),
      has_bom INTEGER NOT NULL CHECK (has_bom IN (0, 1)),
      newline_convention TEXT NOT NULL CHECK (newline_convention IN ('crlf', 'lf', 'cr', 'mixed', 'none')),
      final_newline INTEGER NOT NULL CHECK (final_newline IN (0, 1)),
      nfc INTEGER NOT NULL CHECK (nfc IN (0, 1)),
      char_count INTEGER NOT NULL CHECK (char_count > 0),
      unit_count INTEGER NOT NULL CHECK (unit_count > 0),
      status TEXT NOT NULL CHECK (status IN ('ok', 'warning')),
      warnings TEXT NOT NULL
    );
    CREATE TABLE works (
      work_id INTEGER PRIMARY KEY,
      genre TEXT NOT NULL,
      file_id INTEGER NOT NULL UNIQUE REFERENCES source_files(file_id),
      source_id TEXT,
      title TEXT,
      author TEXT,
      metadata_origin TEXT NOT NULL,
      title_in_first_unit INTEGER NOT NULL CHECK (title_in_first_unit IN (0, 1))
    );
    CREATE TABLE text_units (
      unit_rowid INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES source_files(file_id),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'blank')),
      block_ordinal INTEGER,
      text TEXT NOT NULL,
      eol TEXT NOT NULL CHECK (eol IN ('', char(10), char(13), char(13) || char(10))),
      UNIQUE (file_id, ordinal),
      CHECK ((kind = 'blank') = (block_ordinal IS NULL))
    );
    CREATE VIRTUAL TABLE unit_fts USING fts5(
      text,
      content = 'text_units',
      content_rowid = 'unit_rowid',
      tokenize = 'trigram'
    );
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  `);
}

export function logicalRowsDigest(database) {
  const hash = createHash('sha256');
  const feed = (label, sql) => {
    hash.update('#' + label + '\n');
    for (const row of database.prepare(sql).iterate()) {
      hash.update(JSON.stringify(Object.values(row)) + '\n');
    }
  };
  feed('source_files', 'SELECT * FROM source_files ORDER BY relative_path');
  feed('works', 'SELECT w.genre, f.relative_path, w.source_id, w.title, w.author, w.metadata_origin, w.title_in_first_unit FROM works w JOIN source_files f USING (file_id) ORDER BY f.relative_path');
  feed('text_units', 'SELECT f.relative_path, u.ordinal, u.kind, u.block_ordinal, u.text, u.eol FROM text_units u JOIN source_files f USING (file_id) ORDER BY f.relative_path, u.ordinal');
  return hash.digest('hex');
}

export function counts(database) {
  const one = (sql) => database.prepare(sql).get().n;
  return {
    files: one('SELECT count(*) AS n FROM source_files'),
    works: one('SELECT count(*) AS n FROM works'),
    units: one('SELECT count(*) AS n FROM text_units'),
  };
}

export function requireIntegrity(database, label) {
  const quick = database.prepare('PRAGMA quick_check').all();
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') {
    throw new Error(label + ': SQLite quick_check failed');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error(label + ': SQLite foreign_key_check failed');
  }
  database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('integrity-check')");
}

export function readLiteratureUnits(database, relativePath) {
  return database.prepare(`
    SELECT u.ordinal, u.kind, u.block_ordinal AS blockOrdinal, u.text, u.eol
    FROM text_units u JOIN source_files f USING (file_id)
    WHERE f.relative_path = ? ORDER BY u.ordinal
  `).all(relativePath);
}

/** Rebuild a work's decoded text from stored units only (BOM excluded, see source_files.has_bom). */
export function reconstructWorkFromDatabase(database, relativePath) {
  const units = readLiteratureUnits(database, relativePath);
  if (units.length === 0) throw new Error(relativePath + ': no stored units');
  return reconstructLiteratureText(units);
}

export function normalizeSpaces(value) {
  return value.replace(/\s+/gu, '');
}

export async function readLiteratureManifest(manifestPath = DEFAULT_LITERATURE_MANIFEST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(manifestPath + ': cannot read pilot manifest (' + error.message + ')');
  }
  if (!Array.isArray(parsed.works) || parsed.works.length === 0) {
    throw new Error(manifestPath + ': manifest must list a non-empty works array');
  }
  const paths = parsed.works.map((work) => work.relative_path);
  if (paths.some((entry) => typeof entry !== 'string') || new Set(paths).size !== paths.length) {
    throw new Error(manifestPath + ': works must have unique relative_path strings');
  }
  return paths.sort(compareLexically);
}

export function validateRelativePath(relativePath) {
  const parts = relativePath.split('/');
  if (
    parts.length !== 2
    || !LITERATURE_GENRES.includes(parts[0])
    || parts[1] === ''
    || parts[1].startsWith('.')
    || !parts[1].toLowerCase().endsWith('.txt')
  ) {
    throw new Error(relativePath + ': expected <poem|novel|essay>/<name>.txt');
  }
}

export function prepareLiteratureInserts(database) {
  return {
    file: database.prepare('INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    work: database.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?)'),
    unit: database.prepare('INSERT INTO text_units (file_id, ordinal, kind, block_ordinal, text, eol) VALUES (?,?,?,?,?,?)'),
  };
}

export function insertLiteratureAnalysis(inserts, fileId, analysis) {
  const genre = analysis.relative_path.split('/')[0];
  inserts.file.run(
    fileId, genre, analysis.relative_path, analysis.source_sha256, analysis.source_bytes,
    analysis.encoding, analysis.has_bom, analysis.newline_convention, analysis.final_newline,
    analysis.nfc, analysis.char_count, analysis.unit_count, analysis.status,
    JSON.stringify(analysis.warnings),
  );
  const meta = parseLiteratureFilename(path.posix.basename(analysis.relative_path));
  const firstText = analysis.units.find((unit) => unit.kind === 'text')?.text ?? '';
  const titleSeen = meta.title !== null
    && normalizeSpaces(firstText).includes(normalizeSpaces(meta.title));
  inserts.work.run(
    fileId, genre, fileId, meta.sourceId, meta.title, meta.author,
    meta.title === null ? 'none' : 'filename (unverified)', titleSeen ? 1 : 0,
  );
  for (const unit of analysis.units) {
    inserts.unit.run(fileId, unit.ordinal, unit.kind, unit.blockOrdinal, unit.text, unit.eol);
  }
}

function assertOutputLocation(absoluteInput, absoluteOutput) {
  if (isWithinDirectory(absoluteInput, absoluteOutput)) {
    throw new Error('SQLite output must be outside the TXT input directory: ' + absoluteOutput);
  }
  if (
    isWithinDirectory(REPOSITORY_DIRECTORY, absoluteOutput)
    && !isWithinDirectory(REPOSITORY_INDEX_DIRECTORY, absoluteOutput)
  ) {
    throw new Error('Repository-local SQLite output is restricted to ' + REPOSITORY_INDEX_DIRECTORY);
  }
}

/**
 * Build the pilot DB from an explicit TXT path list. Any per-file error aborts
 * the build before the existing output is touched; replacement is atomic.
 */
export async function buildLiteratureIndex({
  inputDirectory = DEFAULT_LITERATURE_INPUT_DIRECTORY,
  outputPath = DEFAULT_LITERATURE_INDEX_PATH,
  relativePaths,
  permissionRecordPath,
} = {}) {
  await assertLiteraturePermission(permissionRecordPath ? { permissionRecordPath } : {});
  const startedAt = process.hrtime.bigint();
  const absoluteInput = path.resolve(inputDirectory);
  const absoluteOutput = path.resolve(outputPath);
  assertOutputLocation(absoluteInput, absoluteOutput);
  if (!relativePaths || relativePaths.length === 0) {
    throw new Error('A non-empty explicit TXT path list is required (pilot only; no bulk scan).');
  }
  const paths = [...relativePaths].sort(compareLexically);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate TXT paths in build list.');
  paths.forEach(validateRelativePath);
  assertLiteratureFts5Support();

  const analyses = [];
  const failures = [];
  for (const relativePath of paths) {
    let bytes;
    try {
      bytes = await readFile(path.join(absoluteInput, relativePath));
    } catch (error) {
      failures.push(relativePath + ': cannot read source file (' + error.message + ')');
      continue;
    }
    const analysis = analyzeLiteratureBytes(bytes, relativePath);
    if (analysis.status === 'error') {
      failures.push(relativePath + ': ' + analysis.error);
    } else if (reconstructLiteratureText(analysis.units) !== analysis.text) {
      failures.push(relativePath + ': unit split is not reversible');
    } else {
      analyses.push(analysis);
    }
  }
  if (failures.length > 0) {
    throw new Error('Literature build refused; previous index left intact.\n' + failures.join('\n'));
  }

  const outputDirectory = path.dirname(absoluteOutput);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.literature-index-build-'));
  const temporaryPath = path.join(temporaryDirectory, 'index.sqlite');
  let database;
  try {
    database = new DatabaseSync(temporaryPath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
    createLiteratureSchema(database);
    database.exec('BEGIN IMMEDIATE');
    const inserts = prepareLiteratureInserts(database);
    for (const [index, analysis] of analyses.entries()) {
      insertLiteratureAnalysis(inserts, index + 1, analysis);
    }
    database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('rebuild')");

    // Reconstruct every stored work from the database and compare to the decoded source.
    for (const analysis of analyses) {
      if (reconstructWorkFromDatabase(database, analysis.relative_path) !== analysis.text) {
        throw new Error(analysis.relative_path + ': stored units do not reconstruct the source text');
      }
    }
    const rowCounts = counts(database);
    const expectedUnits = analyses.reduce((total, analysis) => total + analysis.unit_count, 0);
    if (rowCounts.files !== analyses.length || rowCounts.works !== analyses.length || rowCounts.units !== expectedUnits) {
      throw new Error('stored row counts differ from the ingestion results');
    }
    const manifestSha256 = literatureManifestDigest(analyses);
    const logicalDigest = logicalRowsDigest(database);
    const metadata = {
      schema_version: LITERATURE_SCHEMA_VERSION,
      builder_version: LITERATURE_BUILDER_VERSION,
      tool_identity: LITERATURE_TOOL_IDENTITY,
      input_manifest_sha256: manifestSha256,
      file_count: String(rowCounts.files),
      work_count: String(rowCounts.works),
      unit_count: String(rowCounts.units),
      logical_rows_sha256: logicalDigest,
      sqlite_version: database.prepare('SELECT sqlite_version() AS v').get().v,
      search_layer: 'none: FTS5 trigram over faithful text; matches re-verified with instr(); no normalization applied',
    };
    const insertMetadata = database.prepare('INSERT INTO index_metadata VALUES (?, ?)');
    for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, value);
    requireIntegrity(database, 'staged database');
    database.exec('COMMIT');
    database.close();
    database = undefined;

    // Source set must not have changed while building.
    for (const analysis of analyses) {
      const bytes = await readFile(path.join(absoluteInput, analysis.relative_path));
      if (sha256Hex(bytes) !== analysis.source_sha256) {
        throw new Error(analysis.relative_path + ': source changed during build');
      }
    }
    const readOnly = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      if (logicalRowsDigest(readOnly) !== logicalDigest) throw new Error('logical digest changed after commit');
    } finally {
      readOnly.close();
    }
    const outputBytes = (await stat(temporaryPath)).size;
    await rename(temporaryPath, absoluteOutput);
    const sourceBytes = analyses.reduce((total, analysis) => total + analysis.source_bytes, 0);
    return {
      output_path: absoluteOutput,
      output_bytes: outputBytes,
      source_bytes_total: sourceBytes,
      db_overhead_ratio: Number((outputBytes / sourceBytes).toFixed(2)),
      file_count: rowCounts.files,
      unit_count: rowCounts.units,
      input_manifest_sha256: manifestSha256,
      logical_rows_sha256: logicalDigest,
      build_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    if (database) {
      try { database.exec('ROLLBACK'); } catch { /* keep original error */ }
      database.close();
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Compare every stored work with the current decoded TXT source (exact text). */
export async function verifyLiteratureIndex({
  inputDirectory = DEFAULT_LITERATURE_INPUT_DIRECTORY,
  databasePath = DEFAULT_LITERATURE_INDEX_PATH,
} = {}) {
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  try {
    const results = [];
    for (const row of database.prepare('SELECT relative_path, source_sha256 FROM source_files ORDER BY relative_path').all()) {
      const bytes = await readFile(path.join(inputDirectory, row.relative_path));
      const analysis = analyzeLiteratureBytes(bytes, row.relative_path);
      const rebuilt = reconstructWorkFromDatabase(database, row.relative_path);
      results.push({
        relative_path: row.relative_path,
        source_unchanged: analysis.source_sha256 === row.source_sha256,
        text_identical: analysis.status !== 'error' && analysis.text === rebuilt,
      });
    }
    return results;
  } finally {
    database.close();
  }
}

// ----------------------------------------------------------- full production DB

function inventoryEntry(analysis) {
  const entry = {
    genre: analysis.relative_path.split('/')[0],
    relative_path: analysis.relative_path,
    source_bytes: analysis.source_bytes,
    source_sha256: analysis.source_sha256,
    status: analysis.status,
  };
  if (analysis.status === 'error') return { ...entry, error: analysis.error };
  return { ...entry, encoding: analysis.encoding, warnings: analysis.warnings };
}

/** Aggregate, text-free accounting of an inventory: genre → status counts and error reasons. */
export function summarizeLiteratureInventory(entries) {
  const byGenre = {};
  const errorReasons = {};
  for (const entry of entries) {
    const genre = (byGenre[entry.genre] ??= { ok: 0, warning: 0, error: 0 });
    genre[entry.status] += 1;
    if (entry.status === 'error') {
      const reason = entry.error.replace(/ \(.*$/u, '');
      errorReasons[reason] = (errorReasons[reason] ?? 0) + 1;
    }
  }
  return { by_genre: byGenre, error_reasons: errorReasons };
}

async function writeJsonAtomically(targetPath, directory, value) {
  const staged = path.join(directory, 'manifest.json');
  await writeFile(staged, JSON.stringify(value, null, 2) + '\n');
  await rename(staged, targetPath);
}

/**
 * Build the full DB from every TXT under the genre directories. Files are
 * decoded and inserted one at a time (no corpus-wide retention); `error` files
 * are excluded from the DB but kept in the manifest. Everything is staged and
 * replaced atomically only after integrity, reconstruction and source-stability
 * checks pass.
 */
export async function buildFullLiteratureIndex({
  inputDirectory = DEFAULT_LITERATURE_INPUT_DIRECTORY,
  outputPath = DEFAULT_FULL_LITERATURE_INDEX_PATH,
  manifestPath = DEFAULT_FULL_LITERATURE_MANIFEST_PATH,
  permissionRecordPath,
  hooks = {},
} = {}) {
  await assertLiteraturePermission(permissionRecordPath ? { permissionRecordPath } : {});
  const startedAt = process.hrtime.bigint();
  const absoluteInput = path.resolve(inputDirectory);
  const absoluteOutput = path.resolve(outputPath);
  const absoluteManifest = path.resolve(manifestPath);
  assertOutputLocation(absoluteInput, absoluteOutput);
  assertOutputLocation(absoluteInput, absoluteManifest);
  assertLiteratureFts5Support();
  const paths = await listLiteratureSourcePaths(absoluteInput);
  if (paths.length === 0) throw new Error('No TXT sources found under ' + absoluteInput);
  paths.forEach(validateRelativePath);

  const outputDirectory = path.dirname(absoluteOutput);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(path.dirname(absoluteManifest), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.literature-index-build-'));
  const temporaryPath = path.join(temporaryDirectory, 'index.sqlite');
  let database;
  try {
    database = new DatabaseSync(temporaryPath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
    createLiteratureSchema(database);
    database.exec('BEGIN IMMEDIATE');
    const inserts = prepareLiteratureInserts(database);
    const entries = [];
    let fileId = 0;
    for (const relativePath of paths) {
      let bytes;
      try {
        bytes = await readFile(path.join(absoluteInput, relativePath));
      } catch (error) {
        throw new Error(relativePath + ': cannot read source file (' + error.message + ')');
      }
      const analysis = analyzeLiteratureBytes(bytes, relativePath);
      entries.push(inventoryEntry(analysis));
      if (hooks.afterRead) await hooks.afterRead(relativePath);
      if (analysis.status === 'error') continue;
      if (reconstructLiteratureText(analysis.units) !== analysis.text) {
        throw new Error(relativePath + ': unit split is not reversible');
      }
      fileId += 1;
      insertLiteratureAnalysis(inserts, fileId, analysis);
      if (reconstructWorkFromDatabase(database, relativePath) !== analysis.text) {
        throw new Error(relativePath + ': stored units do not reconstruct the source text');
      }
    }
    if (fileId === 0) throw new Error('No ingestable (ok|warning) TXT sources; refusing to build an empty index.');
    database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('rebuild')");

    const included = entries.filter((entry) => entry.status !== 'error');
    const rowCounts = counts(database);
    const expectedUnits = database.prepare('SELECT coalesce(sum(unit_count), 0) AS n FROM source_files').get().n;
    if (rowCounts.files !== included.length || rowCounts.works !== included.length || rowCounts.units !== expectedUnits) {
      throw new Error('stored row counts differ from the ingestion results');
    }
    const manifestSha256 = literatureManifestDigest(entries);
    const logicalDigest = logicalRowsDigest(database);
    const inventory = summarizeLiteratureInventory(entries);
    const metadata = {
      schema_version: LITERATURE_SCHEMA_VERSION,
      builder_version: LITERATURE_BUILDER_VERSION,
      tool_identity: LITERATURE_TOOL_IDENTITY,
      build_kind: 'full',
      input_manifest_sha256: manifestSha256,
      inventory_file_count: String(entries.length),
      excluded_file_count: String(entries.length - included.length),
      file_count: String(rowCounts.files),
      work_count: String(rowCounts.works),
      unit_count: String(rowCounts.units),
      logical_rows_sha256: logicalDigest,
      sqlite_version: database.prepare('SELECT sqlite_version() AS v').get().v,
      search_layer: 'none: FTS5 trigram over faithful text; matches re-verified with instr(); no normalization applied',
    };
    const insertMetadata = database.prepare('INSERT INTO index_metadata VALUES (?, ?)');
    for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, value);
    requireIntegrity(database, 'staged database');
    database.exec('COMMIT');
    database.close();
    database = undefined;

    // The source set must be exactly what was ingested: same paths, same bytes.
    const currentPaths = await listLiteratureSourcePaths(absoluteInput);
    if (currentPaths.length !== paths.length || currentPaths.some((entry, index) => entry !== paths[index])) {
      throw new Error('TXT source set changed during build (files added or removed)');
    }
    for (const entry of entries) {
      const bytes = await readFile(path.join(absoluteInput, entry.relative_path));
      if (sha256Hex(bytes) !== entry.source_sha256) {
        throw new Error(entry.relative_path + ': source changed during build');
      }
    }
    const readOnly = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      if (logicalRowsDigest(readOnly) !== logicalDigest) throw new Error('logical digest changed after commit');
    } finally {
      readOnly.close();
    }
    const outputBytes = (await stat(temporaryPath)).size;
    const sourceBytes = entries.reduce((total, entry) => total + entry.source_bytes, 0);
    const includedBytes = included.reduce((total, entry) => total + entry.source_bytes, 0);
    const summary = {
      build_kind: 'full',
      inventory_file_count: entries.length,
      included_work_count: included.length,
      excluded_file_count: entries.length - included.length,
      ...inventory,
      unit_count: rowCounts.units,
      source_bytes_total: sourceBytes,
      source_bytes_included: includedBytes,
      output_bytes: outputBytes,
      db_overhead_ratio: Number((outputBytes / includedBytes).toFixed(2)),
      input_manifest_sha256: manifestSha256,
      logical_rows_sha256: logicalDigest,
    };
    await writeJsonAtomically(absoluteManifest, temporaryDirectory, { ...summary, files: entries });
    await rename(temporaryPath, absoluteOutput);
    return {
      output_path: absoluteOutput,
      manifest_path: absoluteManifest,
      ...summary,
      build_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    if (database) {
      try { database.exec('ROLLBACK'); } catch { /* keep original error */ }
      database.close();
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Verify a full DB against its manifest and the current TXT collection:
 * manifest ↔ DB binding, source set and bytes, exact reconstruction of every
 * included work, absence of excluded files, and SQLite/FTS integrity.
 */
export async function verifyFullLiteratureIndex({
  inputDirectory = DEFAULT_LITERATURE_INPUT_DIRECTORY,
  databasePath = DEFAULT_FULL_LITERATURE_INDEX_PATH,
  manifestPath = DEFAULT_FULL_LITERATURE_MANIFEST_PATH,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(manifestPath + ': cannot read full manifest (' + error.message + ')');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(manifestPath + ': manifest must list a non-empty files array');
  }
  // FTS5 'integrity-check' is an INSERT command, so the connection is writable
  // but everything runs inside one transaction that is always rolled back.
  const database = new DatabaseSync(path.resolve(databasePath));
  database.exec('BEGIN');
  try {
    const metadata = Object.fromEntries(
      database.prepare('SELECT key, value FROM index_metadata').all().map((row) => [row.key, row.value]),
    );
    if (metadata.build_kind !== 'full') problems.push('database is not a full build');
    if (literatureManifestDigest(manifest.files) !== manifest.input_manifest_sha256) {
      problems.push('manifest digest does not match its own file list');
    }
    if (metadata.input_manifest_sha256 !== manifest.input_manifest_sha256) {
      problems.push('manifest is not bound to this database (input_manifest_sha256 differs)');
    }
    try {
      requireIntegrity(database, 'database');
    } catch (error) {
      problems.push(error.message);
    }
    if (logicalRowsDigest(database) !== metadata.logical_rows_sha256) {
      problems.push('logical row digest differs from index_metadata');
    }
    const stored = new Map(
      database.prepare('SELECT relative_path, source_sha256 FROM source_files').all()
        .map((row) => [row.relative_path, row.source_sha256]),
    );
    const manifestByPath = new Map(manifest.files.map((entry) => [entry.relative_path, entry]));
    const currentPaths = await listLiteratureSourcePaths(path.resolve(inputDirectory));
    for (const current of currentPaths) {
      if (!manifestByPath.has(current)) problems.push(current + ': TXT present on disk but not in manifest');
    }
    const currentSet = new Set(currentPaths);
    let reconstructed = 0;
    let excludedAbsent = 0;
    for (const entry of manifest.files) {
      if (!currentSet.has(entry.relative_path)) {
        problems.push(entry.relative_path + ': listed in manifest but missing on disk');
        continue;
      }
      const bytes = await readFile(path.join(inputDirectory, entry.relative_path));
      const analysis = analyzeLiteratureBytes(bytes, entry.relative_path);
      if (analysis.source_sha256 !== entry.source_sha256) {
        problems.push(entry.relative_path + ': source bytes changed since the build');
        continue;
      }
      if (entry.status === 'error') {
        if (analysis.status !== 'error') problems.push(entry.relative_path + ': manifest error file now decodes');
        if (stored.has(entry.relative_path)) problems.push(entry.relative_path + ': excluded error file present in database');
        else excludedAbsent += 1;
        continue;
      }
      if (analysis.status === 'error' || stored.get(entry.relative_path) !== entry.source_sha256) {
        problems.push(entry.relative_path + ': included work missing from or inconsistent with database');
        continue;
      }
      if (reconstructWorkFromDatabase(database, entry.relative_path) !== analysis.text) {
        problems.push(entry.relative_path + ': stored units do not reconstruct the decoded text');
        continue;
      }
      reconstructed += 1;
    }
    const included = manifest.files.filter((entry) => entry.status !== 'error').length;
    if (stored.size !== included) problems.push('database holds ' + stored.size + ' works, manifest includes ' + included);
    return {
      ok: problems.length === 0,
      inventory_file_count: manifest.files.length,
      included_work_count: included,
      reconstructed_exactly: reconstructed,
      excluded_confirmed_absent: excludedAbsent,
      input_manifest_sha256: manifest.input_manifest_sha256,
      logical_rows_sha256: metadata.logical_rows_sha256,
      verify_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
      problems,
    };
  } finally {
    database.exec('ROLLBACK');
    database.close();
  }
}

// --------------------------------------------------------------------- search

function validateQuery(query) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new TypeError('Search query must be a non-empty string.');
  }
  if (query.includes('\u0000')) throw new TypeError('Search query must not contain NUL characters.');
  if (/[\r\n]/u.test(query)) throw new TypeError('Search query must be a single line.');
  return [...query].length >= 3;
}

function validateLimit(limit) {
  const effective = limit === undefined ? DEFAULT_SEARCH_LIMIT : limit;
  if (!Number.isSafeInteger(effective) || effective < 1 || effective > MAX_SEARCH_LIMIT) {
    throw new TypeError('Search limit must be an integer from 1 to ' + MAX_SEARCH_LIMIT + '.');
  }
  return effective;
}

/**
 * Literal substring probe over faithful line units. Matches never span lines
 * (hard-wrapped text can hide a term split across a wrap). Evidence is not
 * lemma, POS or word frequency. Order: genre, relative path, unit ordinal.
 * Each hit carries ±`context` neighbouring physical lines in file order; they
 * are physical units, not semantic paragraphs. Title/author are unverified.
 */
export function searchLiteratureIndex({
  databasePath = DEFAULT_LITERATURE_INDEX_PATH,
  query,
  limit,
  genre,
  context = DEFAULT_CONTEXT_UNITS,
} = {}) {
  const useFts = validateQuery(query);
  const effectiveLimit = validateLimit(limit);
  if (!Number.isSafeInteger(context) || context < 0 || context > MAX_CONTEXT_UNITS) {
    throw new TypeError('Search context must be an integer from 0 to ' + MAX_CONTEXT_UNITS + '.');
  }
  if (genre !== undefined && !LITERATURE_GENRES.includes(genre)) {
    throw new TypeError('genre must be one of ' + LITERATURE_GENRES.join(', '));
  }
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  try {
    const where = [useFts ? 'unit_fts MATCH ?' : null, 'instr(u.text, ?) > 0', genre ? 'f.genre = ?' : null]
      .filter(Boolean).join(' AND ');
    const parameters = [
      ...(useFts ? ['"' + query.replaceAll('"', '""') + '"'] : []),
      query,
      ...(genre ? [genre] : []),
    ];
    const from = `FROM text_units u JOIN source_files f USING (file_id) ${useFts ? 'JOIN unit_fts ON unit_fts.rowid = u.unit_rowid' : ''}`;
    const total = database.prepare(`SELECT count(*) AS n ${from} WHERE ${where}`).get(...parameters).n;
    const rows = database.prepare(`
      SELECT f.genre, f.file_id, f.relative_path, u.ordinal AS unit_ordinal, u.block_ordinal, u.text, u.eol
      ${from} WHERE ${where}
      ORDER BY CASE f.genre WHEN 'poem' THEN 0 WHEN 'novel' THEN 1 ELSE 2 END, f.relative_path, u.ordinal
      LIMIT ?
    `).all(...parameters, effectiveLimit);
    const workStatement = database.prepare('SELECT work_id, title, author, metadata_origin FROM works WHERE file_id = ?');
    const neighborStatement = database.prepare(`
      SELECT ordinal, kind, block_ordinal, text, eol FROM text_units
      WHERE file_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal
    `);
    return {
      evidence_type: 'literal_text_matches',
      search_mode: useFts ? 'fts5-trigram+instr' : 'literal-scan',
      match_unit_count: total,
      returned: rows.length,
      context_units: context,
      results: rows.map(({ file_id: fileId, ...row }) => {
        const work = workStatement.get(fileId);
        return {
          ...row,
          work_id: work.work_id,
          title: work.title,
          author: work.author,
          metadata_origin: work.metadata_origin,
          context: neighborStatement.all(fileId, row.unit_ordinal - context, row.unit_ordinal + context)
            .map((unit) => ({ ...unit, is_hit: unit.ordinal === row.unit_ordinal })),
        };
      }),
    };
  } finally {
    database.close();
  }
}

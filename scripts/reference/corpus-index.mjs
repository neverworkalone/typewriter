import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { openShortQueryCounts, SHORT_QUERY_LENGTH } from './short-query-counts.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

export const DEFAULT_INPUT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/corpus',
);
export const DEFAULT_INDEX_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/indexes/written-corpus-2025.sqlite',
);
const REPOSITORY_INDEX_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'data/reference/indexes',
);
export const DEFAULT_PERMISSION_RECORD_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'docs/external-material-review-written-corpus-2025.md',
);

export const INDEX_SCHEMA_VERSION = '1';
export const INDEX_BUILDER_VERSION = '1';

const DEFAULT_SEARCH_RESULT_LIMIT = 50;
const MAX_SEARCH_RESULT_LIMIT = 200;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SOURCE_METADATA_FIELDS = Object.freeze([
  'title',
  'creator',
  'distributor',
  'year',
  'category',
  'sampling',
]);
const DOCUMENT_METADATA_FIELDS = Object.freeze([
  'title',
  'author',
  'publisher',
  'date',
]);
const PERMISSION_SCOPE_REQUIREMENTS = Object.freeze({
  'Allowed local storage': 'permitted',
  'Allowed schema scanning and processing': 'permitted',
  'Allowed SQLite/FTS indexing': 'permitted',
  'Allowed lexical-reference use': 'permitted',
  'Distribution/embedding terms reviewed': 'complete',
  'Attribution/notice terms reviewed': 'complete',
});

function compareLexically(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(sourcePath, fieldPath, detail) {
  return new Error(sourcePath + ': ' + fieldPath + ': ' + detail);
}

function requireObject(sourcePath, value, fieldPath) {
  if (!isObject(value)) {
    throw schemaError(sourcePath, fieldPath, 'expected an object');
  }
}

function requireArray(sourcePath, value, fieldPath) {
  if (!Array.isArray(value)) {
    throw schemaError(sourcePath, fieldPath, 'expected an array');
  }
}

function requireString(sourcePath, value, fieldPath) {
  if (typeof value !== 'string') {
    throw schemaError(sourcePath, fieldPath, 'expected a string');
  }
}

function validateOptionalStringFields(sourcePath, object, fields, basePath) {
  for (const field of fields) {
    if (!Object.hasOwn(object, field) || object[field] === null) {
      continue;
    }
    requireString(sourcePath, object[field], basePath + '.' + field);
  }
}

function parseAndValidateSource(sourcePath, bytes) {
  let text;
  let source;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw schemaError(sourcePath, '$', 'input is not valid UTF-8 (' + error.message + ')');
  }

  try {
    source = JSON.parse(text);
  } catch (error) {
    throw schemaError(sourcePath, '$', 'invalid JSON (' + error.message + ')');
  }

  requireObject(sourcePath, source, '$');
  requireString(sourcePath, source.id, '$.id');
  requireObject(sourcePath, source.metadata, '$.metadata');
  requireArray(sourcePath, source.document, '$.document');

  for (const field of SOURCE_METADATA_FIELDS) {
    requireString(
      sourcePath,
      source.metadata[field],
      '$.metadata.' + field,
    );
  }

  const annotationLevel = source.metadata.annotation_level;
  if (typeof annotationLevel !== 'string') {
    if (!Array.isArray(annotationLevel)) {
      throw schemaError(
        sourcePath,
        '$.metadata.annotation_level',
        'expected a string or an array of strings',
      );
    }
    for (const [index, value] of annotationLevel.entries()) {
      requireString(
        sourcePath,
        value,
        '$.metadata.annotation_level[' + index + ']',
      );
    }
  }

  for (const [documentIndex, document] of source.document.entries()) {
    const documentPath = '$.document[' + documentIndex + ']';
    requireObject(sourcePath, document, documentPath);
    requireString(sourcePath, document.id, documentPath + '.id');
    requireObject(sourcePath, document.metadata, documentPath + '.metadata');
    requireArray(sourcePath, document.paragraph, documentPath + '.paragraph');
    validateOptionalStringFields(
      sourcePath,
      document.metadata,
      DOCUMENT_METADATA_FIELDS,
      documentPath + '.metadata',
    );

    for (const [paragraphIndex, paragraph] of document.paragraph.entries()) {
      const paragraphPath = documentPath + '.paragraph[' + paragraphIndex + ']';
      requireObject(sourcePath, paragraph, paragraphPath);
      requireString(sourcePath, paragraph.id, paragraphPath + '.id');
      requireString(sourcePath, paragraph.form, paragraphPath + '.form');
      if (paragraph.form.includes('\u0000')) {
        throw schemaError(
          sourcePath,
          paragraphPath + '.form',
          'NUL characters are not supported by the FTS5 trigram index',
        );
      }
    }
  }

  return source;
}

async function listJsonSourcePaths(inputDirectory) {
  const absoluteDirectory = path.resolve(inputDirectory);
  const result = [];

  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        'Cannot enumerate corpus input directory ' + absoluteDirectory + ': ' + error.message,
      );
    }

    entries.sort((left, right) => compareLexically(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? relativeDirectory + '/' + entry.name
        : entry.name;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(
          relativePath + ': symbolic links are not supported in corpus input',
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(relativePath + ': expected a regular file or directory');
      }
      if (path.extname(entry.name).toLowerCase() === '.json') {
        result.push(relativePath);
      }
    }
  }

  await visit(absoluteDirectory, '');
  result.sort(compareLexically);
  if (result.length === 0) {
    throw new Error('No JSON source files found in ' + absoluteDirectory);
  }
  return result;
}

function manifestDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const line = JSON.stringify([
      file.source_path,
      file.source_sha256,
      file.source_bytes,
    ]);
    hash.update(String(Buffer.byteLength(line, 'utf8')));
    hash.update(':');
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export async function auditCorpus({
  inputDirectory = DEFAULT_INPUT_DIRECTORY,
} = {}) {
  const absoluteDirectory = path.resolve(inputDirectory);
  const sourcePaths = await listJsonSourcePaths(absoluteDirectory);
  const files = [];
  let documentCount = 0;
  let paragraphCount = 0;
  let sourceBytesTotal = 0;

  for (const sourcePath of sourcePaths) {
    let bytes;
    try {
      bytes = await readFile(path.join(absoluteDirectory, sourcePath));
    } catch (error) {
      throw new Error(sourcePath + ': cannot read source file (' + error.message + ')');
    }
    const source = parseAndValidateSource(sourcePath, bytes);
    const sourceDocumentCount = source.document.length;
    const sourceParagraphCount = source.document.reduce(
      (total, document) => total + document.paragraph.length,
      0,
    );

    files.push({
      source_path: sourcePath,
      source_sha256: createHash('sha256').update(bytes).digest('hex'),
      source_bytes: bytes.byteLength,
      document_count: sourceDocumentCount,
      paragraph_count: sourceParagraphCount,
    });
    documentCount += sourceDocumentCount;
    paragraphCount += sourceParagraphCount;
    sourceBytesTotal += bytes.byteLength;
  }

  return {
    input_directory: absoluteDirectory,
    source_count: files.length,
    document_count: documentCount,
    paragraph_count: paragraphCount,
    source_bytes_total: sourceBytesTotal,
    input_manifest_sha256: manifestDigest(files),
    files,
  };
}

function sqliteVersion(database) {
  return database.prepare('SELECT sqlite_version() AS version').get().version;
}

export function assertFts5TrigramSupport() {
  let database;
  try {
    database = new DatabaseSync(':memory:');
    database.exec(
      "CREATE VIRTUAL TABLE corpus_trigram_probe USING fts5(value, tokenize='trigram')",
    );
    database.prepare('INSERT INTO corpus_trigram_probe(rowid, value) VALUES (?, ?)').run(
      1,
      '바람숲',
    );
    const match = database.prepare(
      'SELECT rowid FROM corpus_trigram_probe WHERE corpus_trigram_probe MATCH ?',
    ).get('"바람숲"');
    if (!match || Number(match.rowid) !== 1) {
      throw new Error('trigram MATCH probe returned no row');
    }
  } catch (error) {
    const version = database ? sqliteVersion(database) : 'unavailable';
    throw new Error(
      'Corpus reference indexing requires SQLite FTS5 with the trigram tokenizer '
      + '(SQLite ' + version + '): ' + error.message,
    );
  } finally {
    database?.close();
  }
}

function createIndexSchema(database) {
  database.exec(`
    CREATE TABLE source_files (
      source_path TEXT PRIMARY KEY,
      corpus_id TEXT NOT NULL,
      title TEXT NOT NULL,
      creator TEXT NOT NULL,
      distributor TEXT NOT NULL,
      year TEXT NOT NULL,
      category TEXT NOT NULL,
      annotation_level_json TEXT NOT NULL,
      sampling TEXT NOT NULL,
      source_metadata_json TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0)
    ) STRICT;

    CREATE INDEX idx_source_files_category_year
      ON source_files(category, year);

    CREATE TABLE documents (
      document_rowid INTEGER PRIMARY KEY,
      source_path TEXT NOT NULL REFERENCES source_files(source_path),
      document_id TEXT NOT NULL,
      document_ordinal INTEGER NOT NULL CHECK (document_ordinal >= 0),
      title TEXT,
      author TEXT,
      publisher TEXT,
      document_date TEXT,
      metadata_json TEXT NOT NULL,
      UNIQUE (source_path, document_ordinal)
    ) STRICT;

    CREATE TABLE paragraphs (
      paragraph_rowid INTEGER PRIMARY KEY,
      document_rowid INTEGER NOT NULL REFERENCES documents(document_rowid),
      paragraph_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      form TEXT NOT NULL,
      UNIQUE (document_rowid, ordinal)
    ) STRICT;

    CREATE INDEX idx_paragraphs_document_id
      ON paragraphs(document_rowid, paragraph_id);

    CREATE VIRTUAL TABLE paragraph_fts USING fts5(
      form,
      content='paragraphs',
      content_rowid='paragraph_rowid',
      tokenize='trigram'
    );

    CREATE TABLE index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    PRAGMA user_version = 1;
  `);
}

function metadataField(metadata, field) {
  return Object.hasOwn(metadata, field) && metadata[field] !== null
    ? metadata[field]
    : null;
}

function insertSource(database, sourcePath, source, file) {
  database.prepare(`
    INSERT INTO source_files (
      source_path, corpus_id, title, creator, distributor, year, category,
      annotation_level_json, sampling, source_metadata_json,
      source_sha256, source_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourcePath,
    source.id,
    source.metadata.title,
    source.metadata.creator,
    source.metadata.distributor,
    source.metadata.year,
    source.metadata.category,
    JSON.stringify(source.metadata.annotation_level),
    source.metadata.sampling,
    JSON.stringify(source.metadata),
    file.source_sha256,
    file.source_bytes,
  );
}

function insertDocument(database, sourcePath, document, documentOrdinal) {
  const result = database.prepare(`
    INSERT INTO documents (
      source_path, document_id, document_ordinal, title, author,
      publisher, document_date, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourcePath,
    document.id,
    documentOrdinal,
    metadataField(document.metadata, 'title'),
    metadataField(document.metadata, 'author'),
    metadataField(document.metadata, 'publisher'),
    metadataField(document.metadata, 'date'),
    JSON.stringify(document.metadata),
  );
  return Number(result.lastInsertRowid);
}

function insertParagraphs(database, documentRowid, paragraphs) {
  const insert = database.prepare(`
    INSERT INTO paragraphs (
      document_rowid, paragraph_id, ordinal, form
    ) VALUES (?, ?, ?, ?)
  `);
  for (const [ordinal, paragraph] of paragraphs.entries()) {
    insert.run(documentRowid, paragraph.id, ordinal, paragraph.form);
  }
}

function queryCounts(database) {
  return {
    source_count: Number(database.prepare('SELECT COUNT(*) AS count FROM source_files').get().count),
    document_count: Number(database.prepare('SELECT COUNT(*) AS count FROM documents').get().count),
    paragraph_count: Number(database.prepare('SELECT COUNT(*) AS count FROM paragraphs').get().count),
  };
}

function logicalRowsDigest(database) {
  const hash = createHash('sha256');
  const queries = [
    [
      'source_files',
      `SELECT source_path, corpus_id, title, creator, distributor, year, category,
              annotation_level_json, sampling, source_metadata_json,
              source_sha256, source_bytes
       FROM source_files
       ORDER BY source_path COLLATE BINARY`,
    ],
    [
      'documents',
      `SELECT document_rowid, source_path, document_id, document_ordinal,
              title, author, publisher, document_date, metadata_json
       FROM documents
       ORDER BY source_path COLLATE BINARY, document_ordinal`,
    ],
    [
      'paragraphs',
      `SELECT p.paragraph_rowid, p.document_rowid, d.source_path,
              d.document_ordinal, p.paragraph_id, p.ordinal, p.form
       FROM paragraphs AS p
       JOIN documents AS d ON d.document_rowid = p.document_rowid
       ORDER BY d.source_path COLLATE BINARY, d.document_ordinal, p.ordinal`,
    ],
  ];

  for (const [table, sql] of queries) {
    hash.update(table);
    hash.update('\n');
    for (const row of database.prepare(sql).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function readIndexMetadata(database) {
  const rows = database.prepare(
    'SELECT key, value FROM index_metadata ORDER BY key COLLATE BINARY',
  ).all();
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

function requireQuickCheck(database, label) {
  const rows = database.prepare('PRAGMA quick_check').all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
    throw new Error(label + ' failed SQLite quick_check: ' + JSON.stringify(rows));
  }
}

function requireForeignKeyCheck(database, label) {
  const rows = database.prepare('PRAGMA foreign_key_check').all();
  if (rows.length > 0) {
    throw new Error(label + ' failed foreign_key_check: ' + JSON.stringify(rows.slice(0, 10)));
  }
}

function insertIndexMetadata(database, audit, counts, logicalDigest) {
  const entries = {
    schema_version: INDEX_SCHEMA_VERSION,
    builder_version: INDEX_BUILDER_VERSION,
    sqlite_version: sqliteVersion(database),
    source_count: String(counts.source_count),
    document_count: String(counts.document_count),
    paragraph_count: String(counts.paragraph_count),
    input_manifest_sha256: audit.input_manifest_sha256,
    logical_rows_sha256: logicalDigest,
  };
  const insert = database.prepare(
    'INSERT INTO index_metadata(key, value) VALUES (?, ?)',
  );
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, value);
  }
  return entries;
}

function requireExpectedCounts(actual, expected, label) {
  for (const field of ['source_count', 'document_count', 'paragraph_count']) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        label + ' count mismatch for ' + field + ': expected '
        + expected[field] + ', received ' + actual[field],
      );
    }
  }
}

function validateWritableDatabase(database, audit) {
  database.prepare("INSERT INTO paragraph_fts(paragraph_fts) VALUES ('rebuild')").run();
  database.prepare(
    "INSERT INTO paragraph_fts(paragraph_fts, rank) VALUES ('integrity-check', 1)",
  ).run();

  const counts = queryCounts(database);
  requireExpectedCounts(counts, audit, 'Built index');
  const digest = logicalRowsDigest(database);
  const metadata = insertIndexMetadata(database, audit, counts, digest);

  requireQuickCheck(database, 'Temporary index');
  requireForeignKeyCheck(database, 'Temporary index');
  return { counts, digest, metadata };
}

function validateReadOnlyDatabase(database, audit, expected) {
  requireQuickCheck(database, 'Temporary index');
  requireForeignKeyCheck(database, 'Temporary index');
  const counts = queryCounts(database);
  requireExpectedCounts(counts, audit, 'Temporary index');

  const metadata = readIndexMetadata(database);
  if (
    metadata.schema_version !== INDEX_SCHEMA_VERSION
    || metadata.builder_version !== INDEX_BUILDER_VERSION
    || metadata.sqlite_version !== sqliteVersion(database)
    || metadata.input_manifest_sha256 !== audit.input_manifest_sha256
    || metadata.logical_rows_sha256 !== expected.digest
  ) {
    throw new Error('Temporary index metadata does not match the audited build inputs.');
  }
  if (
    metadata.source_count !== String(counts.source_count)
    || metadata.document_count !== String(counts.document_count)
    || metadata.paragraph_count !== String(counts.paragraph_count)
  ) {
    throw new Error('Temporary index metadata row counts do not match its tables.');
  }
  const digest = logicalRowsDigest(database);
  if (digest !== metadata.logical_rows_sha256) {
    throw new Error('Temporary index logical row digest does not match its tables.');
  }
}

async function verifyInputPathSet(inputDirectory, audit) {
  const currentPaths = await listJsonSourcePaths(inputDirectory);
  const expectedPaths = audit.files.map((file) => file.source_path);
  if (
    currentPaths.length !== expectedPaths.length
    || currentPaths.some((sourcePath, index) => sourcePath !== expectedPaths[index])
  ) {
    throw new Error('Corpus JSON file set changed during the index build; active index was not replaced.');
  }
}

function isWithinDirectory(directoryPath, candidatePath) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === ''
    || (
      !path.isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith('..' + path.sep)
    );
}

function requireSafeOutputPath(inputDirectory, outputPath) {
  if (isWithinDirectory(inputDirectory, outputPath)) {
    throw new Error(
      'SQLite output must be outside the corpus input directory: ' + outputPath,
    );
  }
  if (
    isWithinDirectory(REPOSITORY_DIRECTORY, outputPath)
    && !isWithinDirectory(REPOSITORY_INDEX_DIRECTORY, outputPath)
  ) {
    throw new Error(
      'Repository-local SQLite output is restricted to '
      + REPOSITORY_INDEX_DIRECTORY + ': ' + outputPath,
    );
  }
}

export async function buildCorpusIndex({
  inputDirectory = DEFAULT_INPUT_DIRECTORY,
  outputPath = DEFAULT_INDEX_PATH,
} = {}) {
  const absoluteInputDirectory = path.resolve(inputDirectory);
  const absoluteOutputPath = path.resolve(outputPath);
  requireSafeOutputPath(absoluteInputDirectory, absoluteOutputPath);
  assertFts5TrigramSupport();
  const audit = await auditCorpus({ inputDirectory: absoluteInputDirectory });

  const outputDirectory = path.dirname(absoluteOutputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(outputDirectory, '.corpus-index-build-'),
  );
  const temporaryDatabasePath = path.join(temporaryDirectory, 'index.sqlite');
  let database;
  let databaseClosed = false;

  try {
    database = new DatabaseSync(temporaryDatabasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
    createIndexSchema(database);
    database.exec('BEGIN IMMEDIATE');

    try {
      for (const file of audit.files) {
        const sourcePath = file.source_path;
        let bytes;
        try {
          bytes = await readFile(path.join(absoluteInputDirectory, sourcePath));
        } catch (error) {
          throw new Error(sourcePath + ': cannot read source file during build (' + error.message + ')');
        }
        const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
        if (
          sourceSha256 !== file.source_sha256
          || bytes.byteLength !== file.source_bytes
        ) {
          throw new Error(sourcePath + ': source changed after schema preflight');
        }
        const source = parseAndValidateSource(sourcePath, bytes);
        const paragraphCount = source.document.reduce(
          (total, document) => total + document.paragraph.length,
          0,
        );
        if (
          source.document.length !== file.document_count
          || paragraphCount !== file.paragraph_count
        ) {
          throw new Error(sourcePath + ': source row counts changed after schema preflight');
        }

        insertSource(database, sourcePath, source, file);
        for (const [documentOrdinal, document] of source.document.entries()) {
          const documentRowid = insertDocument(
            database,
            sourcePath,
            document,
            documentOrdinal,
          );
          insertParagraphs(database, documentRowid, document.paragraph);
        }
      }

      const validation = validateWritableDatabase(database, audit);
      database.exec('COMMIT');
      database.close();
      databaseClosed = true;

      const readOnlyDatabase = new DatabaseSync(temporaryDatabasePath, {
        readOnly: true,
      });
      try {
        validateReadOnlyDatabase(readOnlyDatabase, audit, validation);
      } finally {
        readOnlyDatabase.close();
      }

      await verifyInputPathSet(absoluteInputDirectory, audit);
      const outputBytes = (await stat(temporaryDatabasePath)).size;
      await rename(temporaryDatabasePath, absoluteOutputPath);
      return {
        output_path: absoluteOutputPath,
        output_bytes: outputBytes,
        source_count: audit.source_count,
        document_count: audit.document_count,
        paragraph_count: audit.paragraph_count,
        source_bytes_total: audit.source_bytes_total,
        input_manifest_sha256: audit.input_manifest_sha256,
        logical_rows_sha256: validation.digest,
        sqlite_version: validation.metadata.sqlite_version,
      };
    } catch (error) {
      if (!databaseClosed) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Keep the original build error.
        }
      }
      throw error;
    }
  } finally {
    if (database && !databaseClosed) {
      database.close();
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function exactFtsPhrase(query) {
  return '"' + query.replaceAll('"', '""') + '"';
}

function validateCorpusQuery(query) {
  if (typeof query !== 'string') {
    throw new TypeError('Search query must be a string.');
  }
  if (query.includes('\u0000')) {
    throw new TypeError('Search query must not contain NUL characters.');
  }
  return [...query].length >= 3;
}

function validateSearchLimit(limit) {
  const effectiveLimit = limit === undefined ? DEFAULT_SEARCH_RESULT_LIMIT : limit;
  if (
    !Number.isSafeInteger(effectiveLimit)
    || effectiveLimit < 1
    || effectiveLimit > MAX_SEARCH_RESULT_LIMIT
  ) {
    throw new TypeError(
      'Search limit must be a positive safe integer no greater than '
      + MAX_SEARCH_RESULT_LIMIT + '.',
    );
  }
  return effectiveLimit;
}

function corpusMatchParameters(query, useFts) {
  return useFts ? [exactFtsPhrase(query), query] : [query];
}

function corpusCountFromAndWhere(useFts) {
  return `
    FROM paragraphs AS p
    ${useFts ? 'JOIN paragraph_fts ON paragraph_fts.rowid = p.paragraph_rowid' : ''}
    WHERE ${useFts ? 'paragraph_fts MATCH ? AND instr(p.form, ?) > 0' : 'instr(p.form, ?) > 0'}
  `;
}

export function searchCorpusIndex({
  databasePath = DEFAULT_INDEX_PATH,
  query,
  limit,
} = {}) {
  const useFts = validateCorpusQuery(query);
  const effectiveLimit = validateSearchLimit(limit);
  if (query.length === 0) {
    return [];
  }
  const reader = createCorpusIndexReader({ databasePath });
  try {
    return reader.search(query, effectiveLimit);
  } finally {
    reader.close();
  }
}

export function countCorpusMatches({
  databasePath = DEFAULT_INDEX_PATH,
  query,
} = {}) {
  const useFts = validateCorpusQuery(query);
  if (query.length === 0) {
    return 0;
  }
  const reader = createCorpusIndexReader({ databasePath });
  try {
    return reader.count(query);
  } finally {
    reader.close();
  }
}

/** Keep one read-only SQLite connection open while collecting evidence for a bounded candidate batch. */
export function createCorpusIndexReader({ databasePath = DEFAULT_INDEX_PATH, useShortCounts = true } = {}) {
  const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  const statements = new Map();
  let closed = false;
  // Two-character literal counts are answered from an exact, digest-bound
  // sidecar when one exists; otherwise the exact scan below runs, so the
  // result never depends on whether the sidecar was built.
  const shortCounts = useShortCounts ? openShortQueryCounts({ indexPath: databasePath, indexDatabase: database }) : null;

  const statement = (key, sql) => {
    if (!statements.has(key)) statements.set(key, database.prepare(sql));
    return statements.get(key);
  };
  const ensureOpen = () => {
    if (closed) throw new Error('Corpus index reader is closed.');
  };

  return {
    search(query, limit) {
      ensureOpen();
      const useFts = validateCorpusQuery(query);
      const effectiveLimit = validateSearchLimit(limit);
      if (query.length === 0) return [];
      const sql = `
        WITH bounded_paragraphs AS (
          SELECT p.paragraph_rowid
          FROM paragraphs AS p
          ${useFts ? 'JOIN paragraph_fts ON paragraph_fts.rowid = p.paragraph_rowid' : ''}
          WHERE ${useFts ? 'paragraph_fts MATCH ? AND instr(p.form, ?) > 0' : 'instr(p.form, ?) > 0'}
          ORDER BY p.paragraph_rowid
          LIMIT ?
        )
        SELECT
          p.paragraph_rowid,
          d.document_rowid,
          sf.source_path,
          sf.corpus_id,
          sf.title AS source_title,
          sf.creator,
          sf.distributor,
          sf.year,
          sf.category,
          sf.annotation_level_json,
          sf.sampling,
          d.document_id,
          d.document_ordinal,
          d.title AS document_title,
          d.author,
          d.publisher,
          d.document_date,
          p.paragraph_id,
          p.ordinal AS paragraph_ordinal,
          p.form
        FROM bounded_paragraphs AS bounded
        JOIN paragraphs AS p ON p.paragraph_rowid = bounded.paragraph_rowid
        JOIN documents AS d ON d.document_rowid = p.document_rowid
        JOIN source_files AS sf ON sf.source_path = d.source_path
        ORDER BY bounded.paragraph_rowid
      `;
      const parameters = corpusMatchParameters(query, useFts);
      parameters.push(effectiveLimit);
      return statement(`search:${Number(useFts)}`, sql).all(...parameters);
    },

    count(query) {
      ensureOpen();
      const useFts = validateCorpusQuery(query);
      if (query.length === 0) return 0;
      if (shortCounts && [...query].length === SHORT_QUERY_LENGTH) return shortCounts.count(query);
      const sql = `
        SELECT COUNT(*) AS match_count
        ${corpusCountFromAndWhere(useFts)}
      `;
      return statement(`count:${Number(useFts)}`, sql)
        .get(...corpusMatchParameters(query, useFts)).match_count;
    },

    evidence(query, limit) {
      return {
        matchCount: this.count(query),
        matches: this.search(query, limit),
      };
    },

    close() {
      if (closed) return;
      closed = true;
      shortCounts?.close();
      database.close();
    },
  };
}

export async function assertCorpusPermission({
  permissionRecordPath = DEFAULT_PERMISSION_RECORD_PATH,
} = {}) {
  let record;
  try {
    record = await readFile(permissionRecordPath, 'utf8');
  } catch (error) {
    throw new Error(
      'Corpus use is not authorized: cannot read permission record '
      + permissionRecordPath + ' (' + error.message + ')',
    );
  }

  const recognizedFields = new Set([
    'Decision',
    'Intended role',
    ...Object.keys(PERMISSION_SCOPE_REQUIREMENTS),
  ]);
  const fields = new Map();
  for (const line of record.split(/\r?\n/u)) {
    const match = line.match(/^- ([^:]+):\s*(.*?)\s*$/u);
    if (!match) continue;
    const field = match[1].trim();
    if (!recognizedFields.has(field)) continue;
    if (fields.has(field)) {
      throw new Error(
        'Permission record ' + permissionRecordPath
        + ' has a duplicate field: ' + field,
      );
    }
    fields.set(field, match[2].trim().toLowerCase());
  }

  const decision = fields.get('Decision');
  const role = fields.get('Intended role');
  if (decision !== 'permitted for stated role' || role !== 'reference') {
    throw new Error(
      'Corpus scanning, indexing, and lookup are disabled until '
      + permissionRecordPath
      + ' records a permitted decision for the reference role, with terms '
      + 'covering local storage, indexing, and lexical-reference use.',
    );
  }

  const unresolvedFields = Object.entries(PERMISSION_SCOPE_REQUIREMENTS)
    .filter(([field, requiredValue]) => fields.get(field) !== requiredValue)
    .map(([field]) => field);
  if (unresolvedFields.length > 0) {
    throw new Error(
      'Corpus scanning, indexing, and lookup are disabled until '
      + permissionRecordPath
      + ' records all required permission scopes and completed terms reviews. '
      + 'Unresolved fields: ' + unresolvedFields.join(', ') + '.',
    );
  }
}

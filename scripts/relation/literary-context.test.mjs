import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  addSearchForm,
  exportLiteraryCandidates,
  finishLiterarySearch,
  getLiteraryContextPage,
  initializeLiteraryCheckpoint,
  inspectLiteraryIndex,
  listLiterarySearchQueue,
  loadLiteraryCheckpoint,
  patchLiteraryCandidateFile,
  recordLiterarySweep,
  reviewLiteraryCandidate,
  reviewLiteraryContext,
  scanLiteraryBatch,
  searchLiterarySense,
  summarizeLiteraryCheckpoint,
  validateExistingLiteraryCandidates,
  validateLiteraryExport,
} from './literary-context.mjs';

const jsonl = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

async function makeFixture({ unitCount = 2, unitText, unitTexts, firstForm = '가나다', workCount = 1 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-literary-context-'));
  const canonicalDirectory = path.join(root, 'data/canonical');
  const scratchDirectory = path.join(root, '.warroom-scratch');
  await mkdir(canonicalDirectory, { recursive: true });
  await mkdir(scratchDirectory, { recursive: true });
  const records = Array.from({ length: 500 }, (_, index) => {
    const ordinal = String(index + 1).padStart(6, '0');
    const lemma = index === 0 ? firstForm : `표제${ordinal}`;
    return {
      id: `record-${ordinal}`,
      lemma,
      search_forms: [],
      senses: [{ id: `sense-${ordinal}`, pos: 'noun', gloss: `fixture gloss ${ordinal}`, relations: [] }],
    };
  });
  const canonicalPath = path.join(canonicalDirectory, 'stdict-0001.jsonl');
  await writeFile(canonicalPath, jsonl(records));

  const databasePath = path.join(root, 'literature.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (
      file_id INTEGER PRIMARY KEY, genre TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL, source_bytes INTEGER NOT NULL, encoding TEXT NOT NULL,
      has_bom INTEGER NOT NULL, newline_convention TEXT NOT NULL, final_newline INTEGER NOT NULL,
      nfc INTEGER NOT NULL, char_count INTEGER NOT NULL, unit_count INTEGER NOT NULL,
      status TEXT NOT NULL, warnings TEXT NOT NULL
    );
    CREATE TABLE works (
      work_id INTEGER PRIMARY KEY, genre TEXT NOT NULL,
      file_id INTEGER NOT NULL UNIQUE REFERENCES source_files(file_id),
      source_id TEXT, title TEXT, author TEXT, metadata_origin TEXT NOT NULL,
      title_in_first_unit INTEGER NOT NULL
    );
    CREATE TABLE text_units (
      unit_rowid INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES source_files(file_id),
      ordinal INTEGER NOT NULL, kind TEXT NOT NULL, block_ordinal INTEGER,
      text TEXT NOT NULL, eol TEXT NOT NULL, UNIQUE(file_id, ordinal)
    );
    CREATE VIRTUAL TABLE unit_fts USING fts5(
      text, content='text_units', content_rowid='unit_rowid', tokenize='trigram'
    );
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insertSource = database.prepare(`INSERT INTO source_files
    (file_id, genre, relative_path, source_sha256, source_bytes, encoding, has_bom, newline_convention,
     final_newline, nfc, char_count, unit_count, status, warnings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertWork = database.prepare(`INSERT INTO works
    (work_id, genre, file_id, source_id, title, author, metadata_origin, title_in_first_unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertUnit = database.prepare(`INSERT INTO text_units
    (unit_rowid, file_id, ordinal, kind, block_ordinal, text, eol)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const unitCounts = Array.from({ length: workCount }, (_, index) => Math.floor((unitCount + workCount - index - 1) / workCount));
  let unitRowId = 0;
  for (let workId = 1; workId <= workCount; workId += 1) {
    insertSource.run(workId, 'poem', `fixture/work-${workId}.txt`, String(workId).padStart(64, 'a'), 100, 'UTF-8', 0, 'CRLF', 1, 1, unitCounts[workId - 1] * 10, unitCounts[workId - 1], 'ok', '[]');
    insertWork.run(workId, 'poem', workId, `work-${workId}`, `Fixture Work ${workId}`, `Test Author ${workId}`, 'fixture', 0);
  }
  const insertFts = database.prepare('INSERT INTO unit_fts (rowid, text) VALUES (?, ?)');
  for (let workId = 1; workId <= workCount; workId += 1) {
    for (let ordinal = 0; ordinal < unitCounts[workId - 1]; ordinal += 1) {
      unitRowId += 1;
      const text = unitTexts?.[unitRowId - 1] ?? unitText ?? `앞 문맥 ${ordinal}. ${firstForm}가 문학 장면에서 쓰였다. 뒤 문맥 ${ordinal}.`;
      const eol = ordinal === unitCounts[workId - 1] - 1 ? '' : '\r\n';
      insertUnit.run(unitRowId, workId, ordinal, text.length === 0 ? 'blank' : 'text', Math.floor(ordinal / 5), text, eol);
      insertFts.run(unitRowId, text);
    }
  }
  const insertMetadata = database.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?)');
  insertMetadata.run('schema_version', '1');
  insertMetadata.run('builder_version', '1');
  insertMetadata.run('build_kind', 'full');
  insertMetadata.run('search_layer', 'FTS5 trigram over faithful text; matches re-verified with instr(); no normalization');
  insertMetadata.run('sqlite_version', '3.53.3');
  insertMetadata.run('tool_identity', 'project-authored synthetic fixture');
  insertMetadata.run('input_manifest_sha256', 'a'.repeat(64));
  insertMetadata.run('logical_rows_sha256', 'b'.repeat(64));
  insertMetadata.run('inventory_file_count', String(workCount));
  insertMetadata.run('excluded_file_count', '0');
  insertMetadata.run('file_count', String(workCount));
  insertMetadata.run('work_count', String(workCount));
  insertMetadata.run('unit_count', String(unitCount));
  database.close();

  const checkpointPath = path.join(scratchDirectory, '001_01_c_codex.checkpoint.json');
  const initialized = await initializeLiteraryCheckpoint({
    canonicalPath,
    shard: '001',
    batch: '01',
    model: 'codex',
    databasePath,
    checkpointPath,
    scratchDirectory,
  });
  return { root, scratchDirectory, canonicalPath, databasePath, checkpointPath, records, initialized };
}

async function cleanup(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

async function makeRetiredParagraphIndex() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typewriter-retired-literary-index-'));
  const databasePath = path.join(root, 'retired.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (source_path TEXT PRIMARY KEY);
    CREATE TABLE documents (document_rowid INTEGER PRIMARY KEY, source_path TEXT);
    CREATE TABLE paragraphs (paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER, form TEXT);
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, content='paragraphs', content_rowid='paragraph_rowid', tokenize='trigram');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.close();
  return { root, databasePath };
}

const sevenEmptyLenses = () => ({
  image: [],
  action: [],
  emotion: [],
  sensation: [],
  scene_situation: [],
  causality: [],
  metaphor_contrast: [],
});

test('read-only preflight validates the approved schema and omits private database identity', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const bytesBefore = await readFile(fixture.databasePath);
    const first = await inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.status, 'READY');
    assert.equal(first.contract, 'literary-context-v2');
    assert.equal(first.index.schema_version, '1');
    assert.equal(first.index.builder_version, '1');
    assert.equal(first.index.schema_contract, 'works/text_units/unit_fts-v1');
    assert.equal(first.index.source_file_count, 1);
    assert.equal(first.index.work_count, 1);
    assert.equal(first.index.text_unit_count, 1);
    assert.equal(first.index.manifest_digest, 'sha256-format-valid');
    assert.equal(first.index.logical_row_digest, 'sha256-format-valid');
    assert.equal(first.search.read_only, true);
    assert.equal('database' in first, false);
    assert.equal(JSON.stringify(first).includes(fixture.databasePath), false);
    assert.deepEqual(await readFile(fixture.databasePath), bytesBefore);
  } finally {
    await cleanup(fixture);
  }
});

test('retired and incomplete literary index schemas fail closed', async () => {
  const retired = await makeRetiredParagraphIndex();
  try {
    await assert.rejects(inspectLiteraryIndex(retired.databasePath), /retired paragraph-index tables are not accepted/u);
  } finally {
    await rm(retired.root, { recursive: true, force: true });
  }

  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.exec('ALTER TABLE text_units RENAME COLUMN eol TO line_ending');
    database.close();
    await assert.rejects(inspectLiteraryIndex(fixture.databasePath), /text_units is missing eol/u);
  } finally {
    await cleanup(fixture);
  }
});

test('read-only preflight rejects missing postings in an external-content FTS index', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const database = new DatabaseSync(fixture.databasePath);
    const text = database.prepare('SELECT text FROM text_units WHERE unit_rowid = 1').get().text;
    database.prepare("INSERT INTO unit_fts(unit_fts, rowid, text) VALUES ('delete', 1, ?)").run(text);
    assert.equal(database.prepare('SELECT count(*) AS count FROM unit_fts').get().count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM unit_fts WHERE unit_fts MATCH ?').get('"가나다"').count, 0);
    database.close();
    await assert.rejects(
      inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory }),
      /FTS trigram token coverage does not match text_units/u,
    );
  } finally {
    await cleanup(fixture);
  }
});

test('read-only preflight rejects wrong FTS term-to-row postings when the total token count is unchanged', async () => {
  const fixture = await makeFixture({ unitCount: 1, unitText: '가나다' });
  try {
    const database = new DatabaseSync(fixture.databasePath);
    const text = database.prepare('SELECT text FROM text_units WHERE unit_rowid = 1').get().text;
    database.prepare("INSERT INTO unit_fts(unit_fts, rowid, text) VALUES ('delete', 1, ?)").run(text);
    database.prepare('INSERT INTO unit_fts(rowid, text) VALUES (1, ?)').run('나가다');
    database.exec('CREATE VIRTUAL TABLE temp.fixture_fts_vocab USING fts5vocab(main, unit_fts, row)');
    const actualTrigramTokens = database.prepare('SELECT coalesce(sum(cnt), 0) AS count FROM temp.fixture_fts_vocab').get().count;
    const expectedTrigramTokens = database.prepare('SELECT coalesce(sum(length(text) - 2), 0) AS count FROM text_units').get().count;
    assert.equal(actualTrigramTokens, expectedTrigramTokens);
    assert.equal(database.prepare('SELECT count(*) AS count FROM unit_fts').get().count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM unit_fts WHERE unit_fts MATCH ?').get('"가나다"').count, 0);
    database.close();
    await assert.rejects(
      inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory }),
      /FTS trigram term and row postings do not match text_units/u,
    );
  } finally {
    await cleanup(fixture);
  }
});

test('CLI failures suppress local database paths and environment values', () => {
  const marker = 'private-probe-path-marker';
  const tokenMarker = 'synthetic-secret-marker';
  const result = spawnSync(process.execPath, [
    'scripts/relation/literary-context-cli.mjs', 'preflight', '--db', path.join(os.tmpdir(), marker, 'missing.sqlite'),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TYPEWRITER_TEST_SECRET: tokenMarker },
  });
  assert.equal(result.status, 1);
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(tokenMarker), false);
  assert.match(result.stderr, /local paths, source text, and secret details were suppressed/u);
});

test('literal search does not join matches across physical line boundaries', async () => {
  const fixture = await makeFixture({ unitCount: 2, unitTexts: ['가나', '다'] });
  try {
    const scan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.hit_senses, 0);
    assert.equal(scan.zero_hit_senses, 500);
    const { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].search.status, 'ZERO_HITS');
  } finally {
    await cleanup(fixture);
  }
});
test('batch scan returns counts only; paginated exact-sense search resumes without treating truncation as zero', async () => {
  const fixture = await makeFixture({ unitCount: 6, unitText: `${'앞 문맥 '.repeat(30)}가나다가 정확한 장면에 있다.${' 뒤 문맥'.repeat(30)}` });
  try {
    const scan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.total_senses, 500);
    assert.equal(scan.hit_senses, 1);
    assert.equal(scan.zero_hit_senses, 499);
    assert.equal(scan.failed_senses, 0);
    assert.equal('text_units' in scan, false);

    const resumed = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(resumed.hit_senses, 1);
    assert.equal(resumed.zero_hit_senses, 499);
    assert.equal(resumed.query_performance_ms.median_sense_query, null);

    const queue = await listLiterarySearchQueue(fixture.checkpointPath, { status: 'COUNTED', limit: 10 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(queue.total_count, 1);
    assert.equal(queue.items[0].sense_id, 'sense-000001');

    const first = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', pageSize: 2, scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.status, 'INCOMPLETE');
    assert.equal(first.total_hits, 6);
    assert.equal(first.returned, 2);
    assert.equal(first.truncated, true);
    assert.deepEqual(first.work_diversity, { distinct_works: 1, max_contexts_per_work: 2 });
    assert.ok(first.next_cursor, JSON.stringify(first));
    assert.ok(first.results.every((item) => item.excerpt.length <= 700));
    assert.equal(first.results[0].context_window.physical_line_endings_preserved, true);
    assert.ok(first.results.every((item) => !('unit_rowid' in item) && !('relative_path' in item) && !('context_sha256' in item)));

    const scanWhileSearchIsIncomplete = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scanWhileSearchIsIncomplete.query_performance_ms.median_sense_query, null);
    const { checkpoint: afterResumeScan } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(afterResumeScan.records[0].senses[0].search.status, 'INCOMPLETE');
    assert.equal(afterResumeScan.records[0].senses[0].search.next_cursor, first.next_cursor);

    const second = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', pageSize: 2, cursor: first.next_cursor, scratchDirectory: fixture.scratchDirectory });
    assert.equal(second.status, 'INCOMPLETE');
    assert.equal(second.total_hits, 6);
    assert.equal(second.returned, 2);
    const third = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', pageSize: 2, cursor: second.next_cursor, scratchDirectory: fixture.scratchDirectory });
    assert.equal(third.status, 'SEARCHED');
    assert.equal(third.has_more, false);

    const { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].contexts.length, 6);
    assert.ok(checkpoint.records[0].senses[0].contexts.every((context) => context.judgment === 'PENDING'));
    assert.equal(summarizeLiteraryCheckpoint(checkpoint).coverage.context_judgments.PENDING, 6);

    await assert.rejects(searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', cursor: 'stale-cursor', scratchDirectory: fixture.scratchDirectory }), /stale/u);
    const afterBadCursor = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(afterBadCursor.checkpoint.records[0].senses[0].search.status, 'SEARCHED');
  } finally {
    await cleanup(fixture);
  }
});

test('failed later page keeps its continuation and sample counts use distinct locators', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const first = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.returned, 4);
    await assert.rejects(searchLiterarySense({
      databasePath: path.join(fixture.root, 'unavailable.sqlite'),
      checkpointPath: fixture.checkpointPath,
      senseId: 'sense-000001',
      cursor: first.next_cursor,
      scratchDirectory: fixture.scratchDirectory,
    }), /database|open/iu);

    let { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    let sense = checkpoint.records[0].senses[0];
    assert.equal(sense.search.status, 'SEARCH_FAILED');
    assert.equal(sense.search.total_hits, 20);
    assert.equal(sense.search.returned_contexts, 4);
    assert.equal(sense.search.next_cursor, first.next_cursor);

    const resumedScan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(resumedScan.query_performance_ms.median_sense_query, null);
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    sense = checkpoint.records[0].senses[0];
    assert.equal(sense.search.status, 'SEARCH_FAILED');
    assert.equal(sense.search.next_cursor, first.next_cursor);

    let page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    while (page.next_cursor && page.returned > 0) {
      ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
      sense = checkpoint.records[0].senses[0];
      if (sense.contexts.length >= 16) break;
      page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', cursor: page.next_cursor, scratchDirectory: fixture.scratchDirectory });
    }

    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    sense = checkpoint.records[0].senses[0];
    assert.equal(sense.contexts.length, 16);
    assert.equal(sense.search.returned_contexts, 16);
    assert.equal(sense.search.total_hits, 20);
    assert.equal(sense.search.status, 'INCOMPLETE');
    assert.ok(sense.search.next_cursor);

    for (const context of sense.contexts) {
      await reviewLiteraryContext(fixture.checkpointPath, {
        senseId: 'sense-000001',
        locatorKey: context.locator_key,
        judgment: 'REJECTED',
        note: 'fixture context does not match the bound sense',
      }, { scratchDirectory: fixture.scratchDirectory });
    }
    const finished = await finishLiterarySearch(fixture.checkpointPath, { senseId: 'sense-000001', note: 'sixteen unique contexts were reached after retry' }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(finished.inspected_contexts, 16);
    assert.equal(finished.remaining_hit_count, 4);
    assert.equal(finished.truncated, true);
  } finally {
    await cleanup(fixture);
  }
});

test('search pages interleave works before returning second contexts from the same work', async () => {
  const fixture = await makeFixture({ unitCount: 6, workCount: 3 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const first = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', pageSize: 3, scratchDirectory: fixture.scratchDirectory });
    assert.deepEqual(first.work_diversity, { distinct_works: 3, max_contexts_per_work: 1 });
    const second = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', pageSize: 3, cursor: first.next_cursor, scratchDirectory: fixture.scratchDirectory });
    assert.deepEqual(second.work_diversity, { distinct_works: 3, max_contexts_per_work: 1 });
    const { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].contexts.length, 6);
    assert.deepEqual(summarizeLiteraryCheckpoint(checkpoint).coverage.work_diversity, { distinct_works: 3, max_contexts_per_work: 2 });
  } finally {
    await cleanup(fixture);
  }
});

test('long text-unit context reads remain character bounded and report total length and continuation', async () => {
  const fixture = await makeFixture({ unitCount: 1, unitText: `${'문학 문맥 '.repeat(180)}가나다${' 뒤 문맥'.repeat(180)}` });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const search = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const first = await getLiteraryContextPage(fixture.databasePath, fixture.checkpointPath, { senseId: 'sense-000001', locatorKey: search.results[0].locator_key, offset: 0, chars: 100 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.chars_returned, 100);
    assert.ok(first.total_chars > first.chars_returned);
    assert.equal(first.truncated, true);
    const second = await getLiteraryContextPage(fixture.databasePath, fixture.checkpointPath, { senseId: 'sense-000001', locatorKey: search.results[0].locator_key, offset: first.next_offset, chars: 100 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(second.total_chars, first.total_chars);
    assert.equal(second.offset, first.next_offset);
    assert.equal(second.chars_returned, 100);
  } finally {
    await cleanup(fixture);
  }
});

test('bounded context requery preserves the exact physical EOLs around a hit', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const search = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const page = await getLiteraryContextPage(fixture.databasePath, fixture.checkpointPath, {
      senseId: 'sense-000001', locatorKey: search.results[0].locator_key, offset: 0, chars: 1000,
    }, { scratchDirectory: fixture.scratchDirectory });
    assert.match(page.text, /\r\n/u);
    assert.equal(page.unit_window.physical_line_endings_preserved, true);
    assert.equal(page.unit_window.included_units, 3);
  } finally {
    await cleanup(fixture);
  }
});

test('multiple exact forms deduplicate one physical unit and retain all matched forms', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '나다', 'Synthetic overlapping literal form', { scratchDirectory: fixture.scratchDirectory });
    const scan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.hit_senses, 1);
    const search = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    assert.equal(search.total_hits, 3);
    assert.equal(search.returned, 3);
    assert.equal(new Set(search.results.map((item) => item.locator_key)).size, 3);
    assert.ok(search.results.every((item) => item.matched_form_count === 2));
  } finally {
    await cleanup(fixture);
  }
});

test('legacy checkpoint contracts cannot resume against the unit index', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const checkpoint = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
    checkpoint.contract = 'literary-checkpoint-v1';
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    await assert.rejects(loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }), /unsupported literary checkpoint contract/u);
  } finally {
    await cleanup(fixture);
  }
});

test('short literal search forms use the bounded page path and invalidate stale zero-hit summaries', async () => {
  const fixture = await makeFixture({ unitCount: 1, unitText: '짧은 두자 검색 예시' });
  try {
    const scan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.zero_hit_senses, 500);
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '두자', 'Canonical search form', { scratchDirectory: fixture.scratchDirectory });
    const researched = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(researched.hit_senses, 1);
    const page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    assert.equal(page.total_hits, 1);
    assert.equal(page.status, 'SEARCHED');
    assert.equal(page.results[0].matched_forms.includes('두자'), true);
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '두자', 'already recorded form', { scratchDirectory: fixture.scratchDirectory });
    await assert.rejects(addSearchForm(fixture.checkpointPath, 'sense-000001', '새형', 'late form', { scratchDirectory: fixture.scratchDirectory }), /before retrieving contexts/u);
    const { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].search.status, 'SEARCHED');
  } finally {
    await cleanup(fixture);
  }
});

test('each context needs an explicit source-sense judgment; ambiguous contexts cannot be swept', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const locatorKey = page.results[0].locator_key;
    let { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].contexts[0].judgment, 'PENDING');
    await assert.rejects(recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 1, results: sevenEmptyLenses() }, { scratchDirectory: fixture.scratchDirectory }), /VERIFIED/u);
    const result = await reviewLiteraryContext(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, judgment: 'AMBIGUOUS', note: '문맥의 다른 의미 가능성' }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(result.sense_status, 'NO_VERIFIED');
    await assert.rejects(recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 1, results: sevenEmptyLenses() }, { scratchDirectory: fixture.scratchDirectory }), /VERIFIED/u);
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.records[0].senses[0].contexts[0].judgment, 'AMBIGUOUS');
  } finally {
    await cleanup(fixture);
  }
});

test('adaptive stopping preserves remaining-hit counts and enforces the 16-context ceiling', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    let page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    let inspected = 0;
    while (page) {
      for (const context of page.results) {
        await reviewLiteraryContext(fixture.checkpointPath, {
          senseId: 'sense-000001',
          locatorKey: context.locator_key,
          judgment: 'REJECTED',
          note: 'sample context does not express the Canonical sense',
        }, { scratchDirectory: fixture.scratchDirectory });
        inspected += 1;
      }
      if (!page.next_cursor || inspected === 16) break;
      page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', cursor: page.next_cursor, scratchDirectory: fixture.scratchDirectory });
    }
    assert.equal(inspected, 16);
    assert.equal(page.status, 'INCOMPLETE');
    await assert.rejects(searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', cursor: page.next_cursor, scratchDirectory: fixture.scratchDirectory }), /16 inspected contexts/u);

    const finished = await finishLiterarySearch(fixture.checkpointPath, { senseId: 'sense-000001', note: 'sixteen contexts reached the documented cap; no more may be inspected' }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(finished.status, 'SAMPLED_NO_VERIFIED');
    assert.equal(finished.total_hits, 20);
    assert.equal(finished.remaining_hit_count, 4);
    assert.equal(finished.truncated, true);

    const queue = await listLiterarySearchQueue(fixture.checkpointPath, { status: 'SAMPLED_NO_VERIFIED', limit: 10 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(queue.total_count, 1);
    const outputPath = path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl');
    const exported = await exportLiteraryCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath, repositoryDirectory: fixture.root, scratchDirectory: fixture.scratchDirectory });
    assert.equal(exported.status, 'OUTPUT');
  } finally {
    await cleanup(fixture);
  }
});

test('seven lenses and two distinct sweeps are recorded; pass two requires independent rereading', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const locatorKey = page.results[0].locator_key;
    await reviewLiteraryContext(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, judgment: 'VERIFIED', note: '제시 뜻과 문맥 의미 일치' }, { scratchDirectory: fixture.scratchDirectory });
    const first = sevenEmptyLenses();
    first.image = ['바람'];
    await recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 1, results: first }, { scratchDirectory: fixture.scratchDirectory });
    const second = sevenEmptyLenses();
    second.image = ['바람', '그늘'];
    await assert.rejects(recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 2, results: second }, { scratchDirectory: fixture.scratchDirectory }), /independent-read/u);
    await recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 2, results: second, independentRead: true }, { scratchDirectory: fixture.scratchDirectory });
    await reviewLiteraryCandidate(fixture.checkpointPath, { senseId: 'sense-000001', candidate: '바람', decision: 'KEEP', kind: 'word', note: '독립 어휘로 연결 확인' }, { scratchDirectory: fixture.scratchDirectory });
    await reviewLiteraryCandidate(fixture.checkpointPath, { senseId: 'sense-000001', candidate: '그늘', decision: 'KEEP', kind: 'word', note: '짧은 심상 확장' }, { scratchDirectory: fixture.scratchDirectory });
    let { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    const summary = summarizeLiteraryCheckpoint(checkpoint);
    assert.equal(summary.sweeps.per_sweep_lens_totals['1'].image.contexts, 1);
    assert.equal(summary.sweeps.per_sweep_lens_totals['1'].image.candidates, 1);
    assert.equal(summary.sweeps.per_sweep_lens_totals['1'].action.zero, 1);
    assert.equal(summary.sweeps.raw_discoveries, 3);
    assert.equal(summary.sweeps.duplicate_discoveries, 1);
    assert.equal(summary.sweeps.sweep2_new_against_sweep1, 1);
    assert.equal(summary.final_candidates.kept, 2);
    assert.equal(summary.final_candidates.kinds.word, 2);

    const outputPath = path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl');
    const exported = await exportLiteraryCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath, repositoryDirectory: fixture.root, scratchDirectory: fixture.scratchDirectory });
    assert.equal(exported.status, 'OUTPUT');
    assert.equal(exported.coverage.records, 500);
    assert.equal(exported.coverage.candidates, 2);
    const outputRows = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(outputRows.length, 500);
    assert.deepEqual(outputRows[0].senses[0].candidates, ['바람', '그늘']);
    assert.deepEqual(Object.keys(outputRows[0]).sort(), ['record_id', 'senses']);

    const validateOutput = () => validateExistingLiteraryCandidates({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      candidatePath: outputPath,
      repositoryDirectory: fixture.root,
      scratchDirectory: fixture.scratchDirectory,
    });
    const initialValidation = await validateOutput();
    assert.equal(initialValidation.status, 'VALID');
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.output.stale, false);

    await reviewLiteraryContext(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, judgment: 'REJECTED', note: 'rechecked context belongs to another sense' }, { scratchDirectory: fixture.scratchDirectory });
    const rejectedEvidence = await validateOutput();
    assert.equal(rejectedEvidence.status, 'INVALID');
    assert.match(rejectedEvidence.message, /no current VERIFIED sweep and KEEP disposition/u);
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.output.stale, true);

    await reviewLiteraryContext(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, judgment: 'VERIFIED', note: 'rechecked context matches the source sense' }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal((await validateOutput()).status, 'VALID');
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.output.stale, false);

    await reviewLiteraryCandidate(fixture.checkpointPath, { senseId: 'sense-000001', candidate: '그늘', decision: 'REMOVE', note: '최종 형태 검사에서 독립성 불충분' }, { scratchDirectory: fixture.scratchDirectory });
    const removedDisposition = await validateOutput();
    assert.equal(removedDisposition.status, 'INVALID');
    assert.match(removedDisposition.message, /current VERIFIED sweep and KEEP disposition/u);
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.output.stale, true);

    const patched = await patchLiteraryCandidateFile({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      candidatePath: outputPath,
      recordId: 'record-000001',
      senseId: 'sense-000001',
      action: 'remove',
      candidate: '그늘',
      reason: 'remove the one explicitly reviewed candidate only',
      repositoryDirectory: fixture.root,
      scratchDirectory: fixture.scratchDirectory,
    });
    assert.equal(patched.status, 'VALID');
    assert.equal((await validateOutput()).status, 'VALID');
    ({ checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.output.stale, false);
    const patchedRows = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(patchedRows[0].senses[0].candidates, ['바람']);
    assert.deepEqual(patchedRows.slice(1), outputRows.slice(1));
  } finally {
    await cleanup(fixture);
  }
});

test('search failures remain distinct from zero hits and do not reject uninspected contexts', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    await assert.rejects(searchLiterarySense({ databasePath: path.join(fixture.root, 'missing.sqlite'), checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory }));
    const { checkpoint } = await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    const sense = checkpoint.records[0].senses[0];
    assert.equal(sense.search.status, 'SEARCH_FAILED');
    assert.equal(summarizeLiteraryCheckpoint(checkpoint).coverage.sense_statuses.SEARCH_FAILED, 1);
    assert.equal(sense.contexts.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

test('Candidate v1 failure reports a minimal affected row and does not mutate the batch', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const rows = fixture.records.map((record) => ({ record_id: record.id, senses: [{ sense_id: record.senses[0].id, candidates: [] }] }));
    rows[0].record_id = 'wrong-record';
    const result = await validateLiteraryExport({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidateRows: rows, repositoryDirectory: fixture.root, scratchDirectory: fixture.scratchDirectory });
    assert.equal(result.status, 'INVALID');
    assert.equal(result.affected.record_id, 'wrong-record');
    assert.equal(result.affected.canonical_record_id, 'record-000001');
    assert.equal(result.affected.candidate_line, 1);
    assert.match(result.repair_scope, /reported Candidate row/u);
  } finally {
    await cleanup(fixture);
  }
});

test('one reviewed Candidate defect is patched in place and the complete batch is revalidated', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const page = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const locatorKey = page.results[0].locator_key;
    await reviewLiteraryContext(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, judgment: 'VERIFIED', note: 'fixture source sense matches' }, { scratchDirectory: fixture.scratchDirectory });
    const first = sevenEmptyLenses();
    first.image = ['가나다'];
    await recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 1, results: first }, { scratchDirectory: fixture.scratchDirectory });
    await recordLiterarySweep(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey, sweep: 2, independentRead: true, results: first }, { scratchDirectory: fixture.scratchDirectory });
    await reviewLiteraryCandidate(fixture.checkpointPath, { senseId: 'sense-000001', candidate: '가나다', decision: 'REMOVE', note: 'exact source lemma repeats the prompt' }, { scratchDirectory: fixture.scratchDirectory });

    const candidatePath = path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl');
    const invalidRows = fixture.records.map((record) => ({
      record_id: record.id,
      senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: record.id === 'record-000001' ? ['가나다'] : [] })),
    }));
    await writeFile(candidatePath, jsonl(invalidRows));
    const before = await validateExistingLiteraryCandidates({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      candidatePath,
      repositoryDirectory: fixture.root,
      scratchDirectory: fixture.scratchDirectory,
    });
    assert.equal(before.status, 'INVALID');
    assert.equal(before.affected.record_id, 'record-000001');

    const repaired = await patchLiteraryCandidateFile({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      candidatePath,
      recordId: 'record-000001',
      senseId: 'sense-000001',
      action: 'remove',
      candidate: '가나다',
      reason: 'remove exact source lemma only',
      repositoryDirectory: fixture.root,
      scratchDirectory: fixture.scratchDirectory,
    });
    assert.equal(repaired.status, 'VALID');
    assert.equal(repaired.validation.recordCount, 500);
    const afterRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(afterRows[0].senses[0].candidates, []);
    assert.deepEqual(afterRows.slice(1), invalidRows.slice(1));
  } finally {
    await cleanup(fixture);
  }
});

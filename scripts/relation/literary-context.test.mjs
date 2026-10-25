import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  addSearchForm,
  exportLiteraryCandidates,
  initializeLiteraryCheckpoint,
  inspectLiteraryIndex,
  loadLiteraryCheckpoint,
  readLiteraryChunk,
  submitLiteraryChunk,
  summarizeLiteraryCheckpoint,
  validateExistingLiteraryCandidates,
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
  const scratchDirectory = path.join(root, '.warroom-scratch');
  await mkdir(scratchDirectory, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (source_path TEXT PRIMARY KEY);
    CREATE TABLE documents (document_rowid INTEGER PRIMARY KEY, source_path TEXT);
    CREATE TABLE paragraphs (paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER, form TEXT);
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, content='paragraphs', content_rowid='paragraph_rowid', tokenize='trigram');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.close();
  return { root, databasePath, scratchDirectory };
}


const chunk = (fixture, extra = {}) => readLiteraryChunk({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory, ...extra });
const submit = (fixture, senses) => submitLiteraryChunk({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, submission: { senses }, scratchDirectory: fixture.scratchDirectory });
const load = async (fixture) => (await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint;
const exportOutput = (fixture) => exportLiteraryCandidates({
  checkpointPath: fixture.checkpointPath,
  canonicalPath: fixture.canonicalPath,
  outputPath: path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl'),
  repositoryDirectory: fixture.root,
  scratchDirectory: fixture.scratchDirectory,
});

test('default preflight is read-only and does not hash the database or rebuild the FTS index', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const bytesBefore = await readFile(fixture.databasePath);
    const first = await inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.status, 'READY');
    assert.equal(first.contract, 'literary-context-v3');
    assert.equal(first.index.schema_contract, 'works/text_units/unit_fts-v1');
    assert.equal(first.index.text_unit_count, 1);
    assert.equal(first.index.fts_index_validation, 'approved-index-not-rebuilt');
    assert.equal(first.search.read_only, true);
    assert.equal(JSON.stringify(first).includes(fixture.databasePath), false);
    assert.deepEqual(await readFile(fixture.databasePath), bytesBefore);
    await assert.rejects(stat(path.join(fixture.scratchDirectory, 'literary-index-digests.json')), { code: 'ENOENT' });
    const checkpoint = await load(fixture);
    assert.equal(checkpoint.index.sha256, null);
  } finally {
    await cleanup(fixture);
  }
});

test('retired and incomplete literary index schemas fail closed', async () => {
  const retired = await makeRetiredParagraphIndex();
  try {
    await assert.rejects(inspectLiteraryIndex(retired.databasePath, { scratchDirectory: retired.scratchDirectory }), /retired paragraph-index tables are not accepted/u);
  } finally {
    await rm(retired.root, { recursive: true, force: true });
  }
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.exec('ALTER TABLE text_units RENAME COLUMN eol TO line_ending');
    database.close();
    await assert.rejects(inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory }), /text_units is missing eol/u);
  } finally {
    await cleanup(fixture);
  }
});

test('deep preflight (first approval) still rejects missing and wrong FTS postings that the lean path does not rebuild', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const database = new DatabaseSync(fixture.databasePath);
    const text = database.prepare('SELECT text FROM text_units WHERE unit_rowid = 1').get().text;
    database.prepare("INSERT INTO unit_fts(unit_fts, rowid, text) VALUES ('delete', 1, ?)").run(text);
    database.close();
    await inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    await assert.rejects(inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory, deep: true }), /FTS trigram token coverage does not match text_units/u);
  } finally {
    await cleanup(fixture);
  }
  const wrong = await makeFixture({ unitCount: 1, unitText: '가나다' });
  try {
    const database = new DatabaseSync(wrong.databasePath);
    database.prepare("INSERT INTO unit_fts(unit_fts, rowid, text) VALUES ('delete', 1, ?)").run('가나다');
    database.prepare('INSERT INTO unit_fts(rowid, text) VALUES (1, ?)').run('나가다');
    database.close();
    await assert.rejects(inspectLiteraryIndex(wrong.databasePath, { scratchDirectory: wrong.scratchDirectory, deep: true }), /FTS trigram term and row postings do not match text_units/u);
  } finally {
    await cleanup(wrong);
  }
});

test('CLI failures suppress local database paths and environment values', () => {
  const marker = 'private-probe-path-marker';
  const tokenMarker = 'synthetic-secret-marker';
  const result = spawnSync(process.execPath, [
    'scripts/relation/literary-context-cli.mjs', 'preflight', '--db', path.join(os.tmpdir(), marker, 'missing.sqlite'),
  ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TYPEWRITER_TEST_SECRET: tokenMarker } });
  assert.equal(result.status, 1);
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(tokenMarker), false);
  assert.match(result.stderr, /local paths, source text, and secret details were suppressed/u);
});

test('literal search does not join matches across physical lines; zero-hit senses are recorded in the chunk write', async () => {
  const fixture = await makeFixture({ unitCount: 2, unitTexts: ['가나', '다'] });
  try {
    const result = await chunk(fixture);
    assert.equal(result.items.length, 0);
    assert.equal(result.zero_hit_recorded, 500);
    assert.equal(result.done_senses, 500);
    assert.equal(summarizeLiteraryCheckpoint(await load(fixture)).coverage.sense_statuses.ZERO_HITS, 500);
  } finally {
    await cleanup(fixture);
  }
});

test('context excerpts prefer the canonical lemma when an earlier shorter search form also hits', async () => {
  const fixture = await makeFixture({
    unitCount: 1,
    firstForm: '교이',
    unitText: `교${'앞'.repeat(180)}교이가 문장에 나타났다.`,
  });
  try {
    const checkpoint = await load(fixture);
    checkpoint.records[0].senses[0].added_forms.push({ form: '교', basis: 'fixture supplemental form', added_at: '2026-01-01T00:00:00.000Z' });
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));

    const [item] = (await chunk(fixture, { contexts: 1, snippetChars: 100 })).items;
    assert.equal(item.total_hits, 1);
    assert.equal(item.contexts.length, 1);
    assert.ok(item.contexts[0].x.includes('교이'), 'the excerpt should retain the canonical lemma hit instead of centering an earlier shorter form');
  } finally {
    await cleanup(fixture);
  }
});

test('one chunk read, one submit and one export produce a Candidate v1 file bound to cited contexts', async () => {
  const fixture = await makeFixture({ unitCount: 6, workCount: 3 });
  try {
    const read = await chunk(fixture, { contexts: 3 });
    assert.equal(read.zero_hit_recorded, 499);
    assert.equal(read.items.length, 1);
    const [item] = read.items;
    assert.equal(item.sense_id, 'sense-000001');
    assert.equal(item.total_hits, 6);
    assert.equal(item.unseen_hits, 3);
    assert.equal(item.contexts.length, 3);
    assert.ok(item.contexts.every((context) => context.k.length === 12 && context.x.length <= 700));
    assert.equal(new Set(item.contexts.map((context) => context.src)).size, 3, 'works are interleaved before a second context from one work');
    const afterRead = await load(fixture);
    assert.equal(afterRead.records[0].senses[0].submission, null, 'senses with hits are not recorded until submitted');
    await assert.rejects(exportOutput(fixture), /1 sense\(s\) are not read and submitted yet/u);

    const saved = await submit(fixture, [{ sense_id: 'sense-000001', verified: [item.contexts[0].k, item.contexts[2].k], candidates: ['서리', ' 서리 ', '겨울 아침'] }]);
    assert.deepEqual({ senses: saved.senses, verified: saved.verified_contexts, candidates: saved.candidates, pending: saved.pending_senses }, { senses: 1, verified: 2, candidates: 2, pending: 0 });
    const checkpoint = await load(fixture);
    const sense = checkpoint.records[0].senses[0];
    assert.equal(sense.submission.verified.length, 2);
    assert.equal('context_text' in sense.submission.verified[0], false);
    assert.equal(sense.submission.total_hits, 6);

    const output = await exportOutput(fixture);
    assert.equal(output.status, 'OUTPUT');
    assert.equal(output.coverage.candidates, 2);
    const rows = (await readFile(path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 500);
    assert.deepEqual(rows[0].senses[0].candidates, ['서리', '겨울 아침']);
    assert.equal(summarizeLiteraryCheckpoint(await load(fixture)).batch.state, 'OUTPUT');
    assert.equal((await chunk(fixture)).items.length, 0, 'finished batch has nothing left to read');
  } finally {
    await cleanup(fixture);
  }
});

test('submission fails closed and writes nothing for uncited, duplicate or unknown contexts', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    const [item] = (await chunk(fixture)).items;
    const key = item.contexts[0].k;
    const before = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [], candidates: ['서리'] }]), /no VERIFIED source-sense context/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: ['0'.repeat(12)], candidates: [] }]), /does not identify exactly one indexed context/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [key, key], candidates: [] }]), /same verified context twice/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [key.slice(0, 4)], candidates: [] }]), /shorter than 12/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }, { sense_id: 'sense-000001', verified: [], candidates: [] }]), /more than once/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [], note: 'extra' }]), /exactly sense_id, verified\[\], candidates\[\]/u);
    await assert.rejects(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }, { sense_id: 'sense-999999', verified: [], candidates: [] }]), /not in this checkpoint/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    // A sense with hits but no VERIFIED context is a real result, not a missing one.
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]);
    assert.equal((await load(fixture)).records[0].senses[0].submission.status, 'SUBMITTED');
  } finally {
    await cleanup(fixture);
  }
});

test('contexts per sense are capped at 16, unseen hits stay explicit and any shown context can be cited', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const first = (await chunk(fixture)).items[0];
    assert.equal(first.contexts.length, 8);
    assert.equal(first.unseen_hits, 12);
    const wide = (await chunk(fixture, { senseIds: 'sense-000001', contexts: 16 })).items[0];
    assert.equal(wide.contexts.length, 16);
    assert.equal(wide.unseen_hits, 4);
    assert.deepEqual(wide.contexts.slice(0, 8).map((context) => context.k), first.contexts.map((context) => context.k));
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [wide.contexts[15].k], candidates: ['서리'] }]);
    assert.equal((await load(fixture)).records[0].senses[0].submission.remaining_hit_count, 4);
    await assert.rejects(chunk(fixture, { contexts: 17 }), /contexts per sense/u);
  } finally {
    await cleanup(fixture);
  }
});

test('a search failure is neither a zero-hit result nor a recorded sense', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const before = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(readLiteraryChunk({ databasePath: path.join(fixture.root, 'missing.sqlite'), checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory }));
    await assert.rejects(submitLiteraryChunk({ databasePath: path.join(fixture.root, 'missing.sqlite'), checkpointPath: fixture.checkpointPath, submission: { senses: [{ sense_id: 'sense-000001', verified: [], candidates: [] }] }, scratchDirectory: fixture.scratchDirectory }));
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(fixture);
  }
});

test('added forms: multi-form units are deduplicated, short forms are searched, and only unsubmitted senses accept new forms', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '나다', 'Synthetic overlapping literal form', { scratchDirectory: fixture.scratchDirectory });
    const [item] = (await chunk(fixture)).items;
    assert.equal(item.total_hits, 3);
    assert.equal(new Set(item.contexts.map((context) => context.k)).size, 3);
    assert.deepEqual(item.forms, ['가나다', '나다']);
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]);
    await assert.rejects(addSearchForm(fixture.checkpointPath, 'sense-000001', '새형', 'late form', { scratchDirectory: fixture.scratchDirectory }), /before reading and submitting/u);
  } finally {
    await cleanup(fixture);
  }
  const zero = await makeFixture({ unitCount: 1, unitText: '짧은 두자 검색 예시' });
  try {
    assert.equal((await chunk(zero)).zero_hit_recorded, 500);
    await addSearchForm(zero.checkpointPath, 'sense-000001', '두자', 'Canonical search form', { scratchDirectory: zero.scratchDirectory });
    const [item] = (await chunk(zero)).items;
    assert.equal(item.total_hits, 1);
    assert.equal(item.contexts.length, 1);
  } finally {
    await cleanup(zero);
  }
});

test('checkpoint contracts: v1 is rejected, a v2 checkpoint remains readable and resumable', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const checkpoint = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
    checkpoint.contract = 'literary-checkpoint-v1';
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    await assert.rejects(loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }), /unsupported literary checkpoint contract/u);
    checkpoint.contract = 'literary-checkpoint-v2';
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    assert.equal((await chunk(fixture)).items.length, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('a complete v2 evidence checkpoint exports its KEEP candidates without the retired ledger commands', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const checkpoint = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
    checkpoint.contract = 'literary-checkpoint-v2';
    const sweep = { results: { image: ['서리'], action: [], emotion: [], sensation: [], scene_situation: [], causality: [], metaphor_contrast: [] } };
    for (const record of checkpoint.records) {
      for (const sense of record.senses) {
        const first = sense.sense_id === 'sense-000001';
        Object.assign(sense, {
          search: { status: first ? 'SEARCHED' : 'ZERO_HITS', total_hits: first ? 1 : 0 },
          contexts: first ? [{ locator_key: 'k', judgment: 'VERIFIED', sweeps: { 1: sweep, 2: { ...sweep, independent_read_attested: true } } }] : [],
          candidate_reviews: first ? [{ normalized: '서리', candidate: '서리', decision: 'KEEP', kind: 'word' }] : [],
        });
        delete sense.submission;
      }
    }
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    const output = await exportOutput(fixture);
    assert.equal(output.coverage.candidates, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('Candidate v1 runs once at export: an ineligible candidate is reported with its row, and one resubmit fixes it', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const [item] = (await chunk(fixture)).items;
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [item.contexts[0].k], candidates: ['가나다'] }]);
    await assert.rejects(exportOutput(fixture), /record-000001|가나다/u);
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [item.contexts[0].k], candidates: ['서리'] }]);
    const output = await exportOutput(fixture);
    assert.equal(output.coverage.candidates, 1);
    // Re-export of the checkpoint's own output after a later correction overwrites that file, nothing else.
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [item.contexts[0].k], candidates: ['서리', '겨울 아침'] }]);
    assert.equal(summarizeLiteraryCheckpoint(await load(fixture)).batch.state, 'OUTPUT_STALE');
    assert.equal((await exportOutput(fixture)).coverage.candidates, 2);
    const candidatePath = path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl');
    const valid = await validateExistingLiteraryCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidatePath, repositoryDirectory: fixture.root, scratchDirectory: fixture.scratchDirectory });
    assert.equal(valid.status, 'VALID');
    const rows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    rows[0].record_id = 'wrong-record';
    await writeFile(candidatePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const invalid = await validateExistingLiteraryCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidatePath, repositoryDirectory: fixture.root, scratchDirectory: fixture.scratchDirectory });
    assert.equal(invalid.status, 'INVALID');
    assert.equal(invalid.affected.record_id, 'wrong-record');
    assert.equal(invalid.affected.candidate_line, 1);
  } finally {
    await cleanup(fixture);
  }
});

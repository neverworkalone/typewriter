import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  addSearchForm,
  excerptAround,
  exportLiteraryCandidates,
  initializeLiteraryCheckpoint,
  inspectLiteraryIndex,
  loadLiteraryCheckpoint,
  readLiteraryChunk,
  renderChunkText,
  reportLiteraryCheckpointSenses,
  resolveVerifiedContextKey,
  submitLiteraryChunk,
  summarizeLiteraryCheckpoint,
  validateExistingLiteraryCandidates,
} from './literary-context.mjs';

const jsonl = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

async function makeFixture({ unitCount = 2, unitText, unitTexts, firstForm = '가나다', firstSenseGlosses, workCount = 1 } = {}) {
  const fixtureRoot = path.resolve('.warroom-scratch');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'typewriter-literary-context-'));
  const canonicalDirectory = path.join(root, 'data/canonical');
  const scratchDirectory = path.join(root, '.warroom-scratch');
  await mkdir(canonicalDirectory, { recursive: true });
  await mkdir(scratchDirectory, { recursive: true });
  const records = Array.from({ length: 500 }, (_, index) => {
    const ordinal = String(index + 1).padStart(6, '0');
    const lemma = index === 0 ? firstForm : `표제${ordinal}`;
    const senses = index === 0 && firstSenseGlosses
      ? firstSenseGlosses.map((gloss, senseIndex) => ({
        id: senseIndex === 0 ? `sense-${ordinal}` : `sense-${ordinal}-${senseIndex + 1}`,
        pos: 'noun',
        gloss,
        relations: [],
      }))
      : [{ id: `sense-${ordinal}`, pos: 'noun', gloss: `fixture gloss ${ordinal}`, relations: [] }];
    return {
      id: `record-${ordinal}`,
      lemma,
      search_forms: [],
      senses,
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
  const fixtureRoot = path.resolve('.warroom-scratch');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'typewriter-retired-literary-index-'));
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
const rejectsSubmitAs = (promise, reason) => assert.rejects(promise, (error) => error.code === 'LITERARY_SUBMISSION_VALIDATION' && error.reason === reason);
const load = async (fixture) => (await loadLiteraryCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint;
const exportOutput = (fixture) => exportLiteraryCandidates({
  checkpointPath: fixture.checkpointPath,
  canonicalPath: fixture.canonicalPath,
  outputPath: path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl'),
  repositoryDirectory: fixture.root,
  scratchDirectory: fixture.scratchDirectory,
});

async function submitCli(fixture, submission, databasePath = fixture.databasePath) {
  const inputPath = path.join(fixture.scratchDirectory, 'submit-input.json');
  await writeFile(inputPath, typeof submission === 'string' ? submission : JSON.stringify(submission));
  return spawnSync(process.execPath, [
    path.resolve('scripts/relation/literary-context-cli.mjs'), 'submit',
    '--db', databasePath,
    '--checkpoint', fixture.checkpointPath,
    '--input', inputPath,
  ], { cwd: fixture.root, encoding: 'utf8' });
}

function reportCli(fixture, senseIds) {
  return spawnSync(process.execPath, [
    path.resolve('scripts/relation/literary-context-cli.mjs'), 'report',
    '--checkpoint', fixture.checkpointPath,
    '--sense-ids', senseIds,
  ], { cwd: fixture.root, encoding: 'utf8' });
}

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
    'scripts/relation/literary-context-cli.mjs', 'preflight', '--db', path.join(process.cwd(), '.warroom-scratch', marker, 'missing.sqlite'),
  ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TYPEWRITER_TEST_SECRET: tokenMarker } });
  assert.equal(result.status, 1);
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(tokenMarker), false);
  assert.match(result.stderr, /local paths, source text, and secret details were suppressed/u);
});

test('CLI export reports the exact sense for a Candidate v1 source-lemma repeat', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '구름', firstSenseGlosses: ['first sense', 'second sense'] });
  try {
    const read = await chunk(fixture);
    const contextsBySense = new Map(read.items.map((item) => [item.sense_id, item.contexts[0].k]));
    const senseIds = ['sense-000001', 'sense-000001-2'];
    assert.deepEqual([...contextsBySense.keys()], senseIds);
    await submit(fixture, senseIds.map((sense_id) => ({
      sense_id,
      verified: [contextsBySense.get(sense_id)],
      candidates: [sense_id === 'sense-000001' ? '구름' : '서리'],
    })));
    const fixtureRoot = await realpath(fixture.root);
    const outputPath = path.join(fixtureRoot, 'data/relation-candidates/001/001_01_c_codex.jsonl');
    const cliPath = path.resolve('scripts/relation/literary-context-cli.mjs');
    const result = spawnSync(process.execPath, [
      cliPath, 'export', '--checkpoint', path.join(fixtureRoot, '.warroom-scratch/001_01_c_codex.checkpoint.json'),
      '--canonical', path.join(fixtureRoot, 'data/canonical/stdict-0001.jsonl'), '--output', outputPath,
    ], { cwd: fixtureRoot, encoding: 'utf8' });

    assert.equal(result.status, 1);
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.status, 'FAILED');
    assert.equal(diagnostic.diagnostic, 'candidate_validation', result.stderr);
    assert.equal(diagnostic.error_type, 'Error');
    assert.deepEqual(diagnostic.affected, {
      record_id: 'record-000001',
      canonical_record_id: 'record-000001',
      sense_ids: ['sense-000001'],
      sense_id: 'sense-000001',
      sense_index: 1,
      candidate: '구름',
      candidate_line: 1,
    });
    assert.match(diagnostic.repair_scope, /Resubmit only the affected sense/u);
    assert.equal(JSON.stringify(diagnostic).includes(fixture.root), false);
    assert.equal(JSON.stringify(diagnostic).includes('fixture gloss'), false);
    assert.equal((await load(fixture)).output, null);
    await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  } finally {
    await cleanup(fixture);
  }
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

test('literal-hit excerpts stay anchored to the exact unit row when work ordinals repeat', async () => {
  const fixture = await makeFixture({
    unitCount: 2,
    workCount: 2,
    firstForm: '교이',
    unitTexts: ['이 문장에는 검색형이 없다.', `${'앞'.repeat(180)}교이가 문장에 나타났다.`],
  });
  try {
    const [item] = (await chunk(fixture, { contexts: 1, snippetChars: 100 })).items;
    assert.equal(item.total_hits, 1);
    assert.equal(item.contexts.length, 1);
    assert.equal(item.contexts[0].src, 'Fixture Work 2 / Test Author 2');
    assert.ok(item.contexts[0].x.includes(item.lemma), 'the excerpt must include the literal form from its exact hit unit');
  } finally {
    await cleanup(fixture);
  }
});

test('excerpt mapping fails closed when the locator offset has no literal hit', () => {
  const context = `교이${'앞'.repeat(180)} 문맥`;
  assert.throws(
    () => excerptAround(context, ['교이'], 100, context.length + 1, '교이'),
    /literal search hit is absent from its context window/u,
  );
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
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [], candidates: ['서리'] }]), 'missing_verified');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: ['0'.repeat(12)], candidates: [] }]), 'context_key_not_found');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [key, key], candidates: [] }]), 'duplicate_verified');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [key.slice(0, 4)], candidates: [] }]), 'context_key_too_short');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }, { sense_id: 'sense-000001', verified: [], candidates: [] }]), 'duplicate_sense');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [], note: 'extra' }]), 'submission_schema');
    await rejectsSubmitAs(submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }, { sense_id: 'sense-999999', verified: [], candidates: [] }]), 'unknown_sense');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    // A sense with hits but no VERIFIED context is a real result, not a missing one.
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]);
    assert.equal((await load(fixture)).records[0].senses[0].submission.status, 'SUBMITTED');
  } finally {
    await cleanup(fixture);
  }
});

test('submit validation returns bounded reason codes and source-sense fields without echoing private input', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    const [item] = (await chunk(fixture)).items;
    const key = item.contexts[0].k;
    const before = await readFile(fixture.checkpointPath, 'utf8');
    const cases = [
      {
        name: 'short context key',
        senses: [{ sense_id: item.sense_id, verified: [key.slice(0, 4)], candidates: [] }],
        reason: 'context_key_too_short',
        field: 'verified',
        senseId: item.sense_id,
      },
      {
        name: 'unknown context key',
        senses: [{ sense_id: item.sense_id, verified: ['private-locator-marker'], candidates: [] }],
        reason: 'context_key_not_found',
        field: 'verified',
        senseId: item.sense_id,
      },
      {
        name: 'duplicate verified context',
        senses: [{ sense_id: item.sense_id, verified: [key, key], candidates: [] }],
        reason: 'duplicate_verified',
        field: 'verified',
        senseId: item.sense_id,
      },
      {
        name: 'candidates without verified context',
        senses: [{ sense_id: item.sense_id, verified: [], candidates: ['서리'] }],
        reason: 'missing_verified',
        field: 'verified',
        senseId: item.sense_id,
      },
      {
        name: 'unknown source sense',
        senses: [{ sense_id: 'private-unknown-sense-marker', verified: [], candidates: [] }],
        reason: 'unknown_sense',
        field: 'sense_id',
        senseId: null,
      },
      {
        name: 'malformed candidates field',
        senses: [{ sense_id: item.sense_id, verified: [], candidates: 'private-input-marker' }],
        reason: 'submission_schema',
        field: 'candidates',
        senseId: item.sense_id,
      },
      {
        name: 'invalid JSON input',
        raw: '{not-json private-json-marker',
        reason: 'submission_schema',
        field: 'input',
        senseId: null,
        jsonSyntax: { line: 1, column: 2 },
      },
      {
        name: 'missing final closing brace reports its line and column',
        raw: '{"senses":[{"sense_id":"private-json-marker","verified":[],"candidates":[]}]\n',
        reason: 'submission_schema',
        field: 'input',
        senseId: null,
        jsonSyntax: { line: 2, column: 1 },
      },
      {
        name: 'truncated JSON reports the end position',
        raw: '{"senses":[{"sense_id":"private-json-marker",',
        reason: 'submission_schema',
        field: 'input',
        senseId: null,
        jsonSyntax: { line: 1, column: 46 },
      },
      {
        name: 'unsupported top-level field',
        submission: { senses: [], private_top_level_marker: true },
        reason: 'submission_schema',
        field: 'submission',
        senseId: null,
      },
      {
        name: 'multiple ID and schema errors retain submitted array positions',
        senses: [
          { sense_id: item.sense_id, verified: [], candidates: [] },
          { sense_id: 'private-unknown-sense-second-marker', verified: [], candidates: [] },
          { sense_id: item.sense_id, verified: [], candidates: [] },
          { sense_id: item.sense_id, verified: [], candidates: 'private-schema-marker' },
          ...Array.from({ length: 6 }, () => ({ sense_id: item.sense_id, verified: [], candidates: [] })),
          { sense_id: 'private-unknown-sense-eleventh-marker', verified: [], candidates: [] },
        ],
        reason: 'unknown_sense',
        field: 'sense_id',
        senseId: null,
        entryNumber: 2,
        expectedIssuePositions: [
          [2, 'unknown_sense', 'sense_id'],
          [3, 'duplicate_sense', 'sense_id'],
          [4, 'duplicate_sense', 'sense_id'],
          [4, 'submission_schema', 'candidates'],
          [5, 'duplicate_sense', 'sense_id'],
          [6, 'duplicate_sense', 'sense_id'],
          [7, 'duplicate_sense', 'sense_id'],
          [8, 'duplicate_sense', 'sense_id'],
          [9, 'duplicate_sense', 'sense_id'],
          [10, 'duplicate_sense', 'sense_id'],
          [11, 'unknown_sense', 'sense_id'],
        ],
      },
      {
        name: 'issue list is bounded for oversized invalid submissions',
        senses: Array.from({ length: 20 }, (_, index) => ({ sense_id: `private-unknown-sense-${index}`, verified: [], candidates: [] })),
        reason: 'unknown_sense',
        field: 'sense_id',
        senseId: null,
        entryNumber: 1,
        expectedIssueCount: 16,
        issuesTruncated: true,
      },
    ];

    for (const scenario of cases) {
      const result = await submitCli(fixture, scenario.raw ?? scenario.submission ?? { senses: scenario.senses });
      assert.equal(result.status, 1, scenario.name);
      assert.equal(result.stdout, '', scenario.name);
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.status, 'FAILED', scenario.name);
      assert.equal(diagnostic.diagnostic, 'submit_validation', scenario.name);
      assert.equal(diagnostic.reason, scenario.reason, scenario.name);
      const entryNumber = scenario.entryNumber ?? (scenario.senses ? 1 : null);
      assert.deepEqual(diagnostic.affected, { sense_id: scenario.senseId, field: scenario.field, entry_number: entryNumber }, scenario.name);
      assert.ok(Array.isArray(diagnostic.issues), scenario.name);
      assert.ok(diagnostic.issues.length <= 16, scenario.name);
      if (scenario.expectedIssuePositions) {
        assert.deepEqual(diagnostic.issues.map((issue) => [issue.entry_number, issue.reason, issue.field]), scenario.expectedIssuePositions, scenario.name);
      } else if (scenario.expectedIssueCount) {
        assert.equal(diagnostic.issues.length, scenario.expectedIssueCount, scenario.name);
        assert.deepEqual(diagnostic.issues.map((issue) => issue.entry_number), Array.from({ length: scenario.expectedIssueCount }, (_, index) => index + 1), scenario.name);
      } else {
        assert.deepEqual(diagnostic.issues, [{ entry_number: entryNumber, reason: scenario.reason, field: scenario.field }], scenario.name);
      }
      if (scenario.issuesTruncated) assert.equal(diagnostic.issues_truncated, true, scenario.name);
      assert.deepEqual(diagnostic.json_syntax, scenario.jsonSyntax, scenario.name);
      const expectedRepairScope = scenario.reason === 'submission_schema'
        ? 'correct_submission_shape'
        : scenario.reason === 'unknown_sense'
          ? 'correct_source_sense_id'
          : 'resubmit_affected_sense';
      assert.equal(diagnostic.repair_scope, expectedRepairScope, scenario.name);
      assert.equal(result.stderr.includes(fixture.root), false, scenario.name);
      assert.equal(result.stderr.includes('fixture gloss'), false, scenario.name);
      assert.equal(result.stderr.includes('private-locator-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-unknown-sense-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-unknown-sense-second-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-unknown-sense-eleventh-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-schema-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-input-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private-json-marker'), false, scenario.name);
      assert.equal(result.stderr.includes('private_top_level_marker'), false, scenario.name);
      assert.equal(result.stderr.includes(' at '), false, scenario.name);
      assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before, scenario.name);
    }

    const successful = await submitCli(fixture, { senses: [{ sense_id: item.sense_id, verified: [key], candidates: ['서리'] }] });
    assert.equal(successful.status, 0, successful.stderr);
    assert.equal(JSON.parse(successful.stdout).status, 'SAVED');
  } finally {
    await cleanup(fixture);
  }
});

test('a rejected extra Sense is repaired in the same chunk while saved work remains intact', async () => {
  const fixture = await makeFixture({ unitCount: 3, firstSenseGlosses: ['first sense', 'second sense'] });
  try {
    const items = (await chunk(fixture)).items;
    assert.equal(items.length, 2);
    const entries = items.map((item) => ({ sense_id: item.sense_id, verified: [item.contexts[0].k], candidates: [] }));
    const beforeDiagnostics = await readFile(fixture.checkpointPath, 'utf8');
    const expectCliFailure = async (submission, reason, entryNumber, field, senseId = null) => {
      const result = await submitCli(fixture, submission);
      assert.equal(result.status, 1, result.stderr);
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.reason, reason);
      assert.deepEqual(diagnostic.affected, { sense_id: senseId, field, entry_number: entryNumber });
      assert.equal(result.stderr.includes('private-extra-sense-marker'), false);
    };
    await expectCliFailure({ senses: [...entries, {
      sense_id: 'private-extra-sense-marker', verified: [], candidates: [],
    }] }, 'unknown_sense', 3, 'sense_id'); // All expected IDs plus one added ID.
    await expectCliFailure({ senses: [entries[0], {
      sense_id: 'private-extra-sense-marker', verified: [], candidates: [],
    }] }, 'unknown_sense', 2, 'sense_id'); // One expected ID is absent; do not infer that the unknown ID is its replacement.
    await expectCliFailure({ senses: [entries[0], entries[0]] }, 'duplicate_sense', 2, 'sense_id', entries[0].sense_id);
    await expectCliFailure({ senses: [entries[0], {
      ...entries[1], candidates: 'private-extra-sense-marker',
    }] }, 'submission_schema', 2, 'candidates', entries[1].sense_id);
    const topLevelSchema = await submitCli(fixture, { senses: [], private_top_level_marker: true });
    assert.equal(topLevelSchema.status, 1);
    assert.deepEqual(JSON.parse(topLevelSchema.stderr).affected, { sense_id: null, field: 'submission', entry_number: null });
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), beforeDiagnostics, 'all diagnostic failures leave the checkpoint unchanged');

    await submit(fixture, [entries[0]]); // Represents a sense already saved before a resumed submission.

    const beforeRejectedSubmit = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(submit(fixture, [entries[1], {
      sense_id: 'private-extra-sense-marker', verified: [], candidates: [],
    }]), (error) => {
      assert.equal(error.reason, 'unknown_sense');
      assert.deepEqual(error.affected, { sense_id: null, field: 'sense_id', entry_number: 2 });
      assert.deepEqual(error.issues, [{ entry_number: 2, reason: 'unknown_sense', field: 'sense_id' }]);
      return true;
    });
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), beforeRejectedSubmit, 'a rejected submit makes no checkpoint change');

    const saved = await submit(fixture, [entries[1]]); // Retry only the remaining Sense in this active chunk.
    assert.equal(saved.status, 'SAVED');
    const report = reportCli(fixture, items.map((item) => item.sense_id).join(','));
    assert.equal(report.status, 0, report.stderr);
    assert.equal(report.stderr, '');
    const completion = JSON.parse(report.stdout);
    assert.equal(completion.all_done, true);
    assert.deepEqual(completion.senses.map((sense) => [sense.sense_id, sense.done]), items.map((item) => [item.sense_id, true]));
  } finally {
    await cleanup(fixture);
  }
});

test('ambiguous context prefixes are classified without including the key', () => {
  const senseId = 'sense-000001';
  assert.throws(
    () => resolveVerifiedContextKey('abcdef123456', senseId, [
      { locator_key: 'abcdef123456' + '0'.repeat(52) },
      { locator_key: 'abcdef123456' + '1'.repeat(52) },
    ]),
    (error) => error.code === 'LITERARY_SUBMISSION_VALIDATION'
      && error.reason === 'context_key_ambiguous'
      && error.affected.sense_id === senseId
      && error.affected.field === 'verified'
      && !error.message.includes('abcdef123456'),
  );
});

test('submit index access and identity failures stop safely and leave the checkpoint unchanged', async () => {
  const inaccessible = await makeFixture({ unitCount: 1 });
  try {
    const before = await readFile(inaccessible.checkpointPath, 'utf8');
    const result = await submitCli(inaccessible, { senses: [{ sense_id: 'sense-000001', verified: [], candidates: [] }] }, path.join(inaccessible.root, 'missing.sqlite'));
    assert.equal(result.status, 1);
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.diagnostic, 'index_access');
    assert.equal(diagnostic.repair_scope, 'stop_and_report');
    assert.equal(result.stderr.includes(inaccessible.root), false);
    assert.equal(await readFile(inaccessible.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(inaccessible);
  }

  for (const scenario of [
    {
      name: 'schema mismatch',
      diagnostic: 'index_schema',
      mutate(database) { database.exec('ALTER TABLE text_units RENAME COLUMN eol TO line_ending'); },
    },
    {
      name: 'metadata mismatch',
      diagnostic: 'index_metadata',
      mutate(database) { database.prepare("UPDATE index_metadata SET value = 'invalid' WHERE key = 'logical_rows_sha256'").run(); },
    },
  ]) {
    const invalidIndex = await makeFixture({ unitCount: 1 });
    try {
      const before = await readFile(invalidIndex.checkpointPath, 'utf8');
      const database = new DatabaseSync(invalidIndex.databasePath);
      scenario.mutate(database);
      database.close();
      const result = await submitCli(invalidIndex, { senses: [{ sense_id: 'sense-000001', verified: [], candidates: [] }] });
      assert.equal(result.status, 1, scenario.name);
      const diagnostic = JSON.parse(result.stderr);
      assert.equal(diagnostic.diagnostic, scenario.diagnostic, scenario.name);
      assert.equal(diagnostic.repair_scope, 'stop_and_report', scenario.name);
      assert.equal(result.stderr.includes(invalidIndex.root), false, scenario.name);
      assert.equal(result.stderr.includes('fixture gloss'), false, scenario.name);
      assert.equal(await readFile(invalidIndex.checkpointPath, 'utf8'), before, scenario.name);
    } finally {
      await cleanup(invalidIndex);
    }
  }

  const changed = await makeFixture({ unitCount: 1 });
  try {
    const [item] = (await chunk(changed)).items;
    const before = await readFile(changed.checkpointPath, 'utf8');
    const database = new DatabaseSync(changed.databasePath);
    database.prepare('UPDATE works SET title = ? WHERE work_id = 1').run('Changed fixture title');
    database.close();
    const result = await submitCli(changed, { senses: [{ sense_id: item.sense_id, verified: [], candidates: [] }] });
    assert.equal(result.status, 1);
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.diagnostic, 'index_identity');
    assert.equal(diagnostic.repair_scope, 'stop_and_report');
    assert.equal(result.stderr.includes(changed.root), false);
    assert.equal(result.stderr.includes('Changed fixture title'), false);
    assert.equal(await readFile(changed.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(changed);
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

test('submit re-resolves only the contexts chunk showed: shown units stay bound to the index, and unread or re-formed senses fall back to a full search', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const [item] = (await chunk(fixture)).items;
    const key = item.contexts[0].k;
    const shown = (await load(fixture)).records[0].senses[0].shown;
    assert.equal(shown.total_hits, 20);
    assert.equal(shown.unit_rowids.length, 8);
    // A shown unit that no longer contains a search form is rejected and nothing is written.
    const checkpoint = await load(fixture);
    const original = JSON.stringify(checkpoint);
    checkpoint.records[0].senses[0].shown.unit_rowids[0] = 999999;
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    const tampered = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(
      submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }]),
      (error) => error.code === 'LITERARY_INDEX_SEARCH',
    );
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), tampered);
    // Without recorded reads (legacy checkpoint) the original full search still binds the key.
    const legacy = JSON.parse(original);
    delete legacy.records[0].senses[0].shown;
    await writeFile(fixture.checkpointPath, JSON.stringify(legacy));
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [key], candidates: [] }]);
    const saved = (await load(fixture)).records[0].senses[0].submission;
    assert.equal(saved.verified[0].locator_key.startsWith(key), true);
    assert.equal(saved.total_hits, 20);
  } finally {
    await cleanup(fixture);
  }
});

test('adding a search form after chunk drops the shown contexts so the changed form set is searched afresh', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    await chunk(fixture);
    assert.ok((await load(fixture)).records[0].senses[0].shown);
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '서릿발', 'reviewed form', { scratchDirectory: fixture.scratchDirectory });
    assert.equal((await load(fixture)).records[0].senses[0].shown, null);
  } finally {
    await cleanup(fixture);
  }
});

const runCli = (fixture, args) => spawnSync(process.execPath, [path.resolve('scripts/relation/literary-context-cli.mjs'), ...args], { cwd: fixture.root, encoding: 'utf8' });
const cliChunkArgs = (fixture, extra = []) => ['chunk', '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, ...extra];

test('chunk --format text carries every sense, state and context of the JSON result, and JSON stays the default', async () => {
  const fixture = await makeFixture({ unitCount: 6, workCount: 3, firstSenseGlosses: ['첫째 뜻', '둘째 뜻'] });
  try {
    const asText = runCli(fixture, cliChunkArgs(fixture, ['--contexts', '3', '--format', 'text']));
    assert.equal(asText.status, 0, asText.stderr);
    const check = await load(fixture);
    // chunk records zero-hit senses; read the same chunk again as JSON for the comparison (nothing left but the hit senses)
    const asJson = runCli(fixture, cliChunkArgs(fixture, ['--contexts', '3']));
    assert.equal(asJson.status, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    const body = (text) => text.slice(text.indexOf('\n\n') + 2);   // the header's zero_hit differs: the first read recorded them
    assert.equal(body(asText.stdout), body(renderChunkText(parsed)));
    assert.match(asText.stdout, /zero_hit=499 /u);
    assert.ok(parsed.items.length >= 1);
    for (const item of parsed.items) {
      assert.ok(asText.stdout.includes(`## ${item.sense_id} — ${item.lemma} [${item.pos}]\n${item.gloss}\n`));
      assert.ok(asText.stdout.includes(`hits=${item.total_hits} unseen=${item.unseen_hits}`));
      for (const context of item.contexts) assert.ok(asText.stdout.includes(`[${context.k}] ${context.src}\n${context.x}`), 'context key, source and excerpt are verbatim');
    }
    assert.ok(check.records.length > 0);
    const bad = runCli(fixture, cliChunkArgs(fixture, ['--format', 'xml']));
    assert.notEqual(bad.status, 0);
  } finally {
    await cleanup(fixture);
  }
});

test('renderChunkText table: header, forms line, status-only items and empty chunk', () => {
  const base = { batch: { shard: '001', batch: '01' }, done_senses: 3, total_senses: 5, zero_hit_recorded: 1, not_yet_read: 2 };
  const withContexts = { sense_id: 's1', lemma: '가나', pos: '명사', gloss: '뜻', total_hits: 4, unseen_hits: 2, contexts: [{ k: 'aaaaaaaaaaaa', src: '제목 / 작가', x: '원문 한 줄' }, { k: 'bbbbbbbbbbbb', src: '', x: '둘째' }] };
  const cases = [
    ['plain', { ...base, items: [withContexts] }, '## s1 — 가나 [명사]\n뜻\nhits=4 unseen=2\n[aaaaaaaaaaaa] 제목 / 작가\n원문 한 줄\n\n[bbbbbbbbbbbb] \n둘째\n'],
    ['forms', { ...base, items: [{ ...withContexts, forms: ['가나', '가날'] }] }, 'forms: 가나, 가날\nhits=4'],
    ['status only', { ...base, items: [{ sense_id: 's2', status: 'SEARCH_FAILED' }, { sense_id: 's3', status: 'UNSEARCHABLE' }] }, '## s2 — SEARCH_FAILED\n\n## s3 — UNSEARCHABLE\n'],
    ['empty', { ...base, items: [] }, 'not_yet_read=2\n\n\n'],
  ];
  for (const [name, result, expected] of cases) {
    const text = renderChunkText(result);
    assert.ok(text.startsWith('batch=001_01 done=3/5 zero_hit=1 not_yet_read=2\n\n'), name);
    assert.ok(text.includes(expected), name);
  }
});

test('report --sense-ids returns done-ness by the existing senseDone meaning and fails closed on bad input', async () => {
  const fixture = await makeFixture({ unitCount: 3, firstSenseGlosses: ['첫째 뜻', '둘째 뜻'] });
  try {
    const read = await chunk(fixture);
    const ids = read.items.map((item) => item.sense_id);
    assert.equal(ids.length, 2);
    let checkpoint = await load(fixture);
    let report = reportLiteraryCheckpointSenses(checkpoint, `${ids.join(',')},${checkpoint.records[1].senses[0].sense_id}`);
    assert.deepEqual(report.senses.map((item) => [item.status, item.done]), [['PENDING', false], ['PENDING', false], ['ZERO_HITS', true]]);
    assert.equal(report.all_done, false);
    await submit(fixture, [{ sense_id: ids[0], verified: [], candidates: [] }]);
    checkpoint = await load(fixture);
    report = reportLiteraryCheckpointSenses(checkpoint, ids[0]);
    assert.deepEqual(report.senses, [{ sense_id: ids[0], status: 'SUBMITTED', done: true }]);
    assert.equal(JSON.stringify(report).includes(fixture.root), false, 'no paths');
    const viaCli = runCli(fixture, ['report', '--checkpoint', fixture.checkpointPath, '--sense-ids', `${ids[0]},${ids[1]}`]);
    assert.equal(viaCli.status, 0, viaCli.stderr);
    assert.deepEqual(JSON.parse(viaCli.stdout).senses.map((item) => item.done), [true, false]);
    assert.equal(JSON.parse(runCli(fixture, ['report', '--checkpoint', fixture.checkpointPath]).stdout).contract, 'literary-checkpoint-v3', 'plain report unchanged');

    const clone = () => structuredClone(checkpoint);
    const unusual = clone();
    Object.assign(unusual.records[0].senses[0].submission, { status: 'ZERO_HITS', verified: [], candidates: [] });
    assert.equal(reportLiteraryCheckpointSenses(unusual, ids[0]).senses[0].done, true, 'ZERO_HITS with no candidates is valid');
    const withCandidate = clone();
    Object.assign(withCandidate.records[0].senses[0].submission, { verified: [{ locator_key: 'k' }], candidates: ['후보'] });
    assert.equal(reportLiteraryCheckpointSenses(withCandidate, ids[0]).senses[0].done, true, 'candidate with a verified context is valid');
    const damaged = [
      ['unknown id', () => clone(), 'nope', /not in this checkpoint/u],
      ['repeated request id', () => clone(), `${ids[0]},${ids[0]}`, /repeated/u],
      ['empty element', () => clone(), `${ids[0]},`, /comma-separated/u],
      ['unknown submission status', () => { const c = clone(); c.records[0].senses[0].submission.status = 'DONE'; return c; }, ids[0], /submission is damaged/u],
      ['ZERO_HITS with a candidate', () => { const c = clone(); Object.assign(c.records[0].senses[0].submission, { status: 'ZERO_HITS', candidates: ['후보'] }); return c; }, ids[0], /submission is damaged/u],
      ['candidate without any verified context', () => { const c = clone(); Object.assign(c.records[0].senses[0].submission, { verified: [], candidates: ['후보'] }); return c; }, ids[0], /submission is damaged/u],
      ['verified item without locator_key', () => { const c = clone(); c.records[0].senses[0].submission.verified = [{}]; return c; }, ids[0], /submission is damaged/u],
      ['submission candidates not strings', () => { const c = clone(); c.records[0].senses[0].submission.candidates = [1]; return c; }, ids[0], /submission is damaged/u],
      ['duplicate sense id in checkpoint', () => { const c = clone(); c.records[1].senses[0].sense_id = ids[0]; return c; }, ids[0], /sense structure is damaged/u],
      ['missing batch binding', () => { const c = clone(); delete c.batch.model; return c; }, ids[0], /batch binding/u],
      ['bad search state', () => { const c = clone(); c.records[0].senses[1].search = { status: 5 }; return c; }, ids[1], /search state is damaged/u],
      ['senses not an array', () => { const c = clone(); c.records[0].senses = null; return c; }, ids[0], /record structure is damaged/u],
    ];
    for (const [name, make, list, pattern] of damaged) assert.throws(() => reportLiteraryCheckpointSenses(make(), list), pattern, name);
  } finally {
    await cleanup(fixture);
  }
});

test('a damaged checkpoint is refused by every consumer (plain report, chunk, export), valid ZERO_HITS passes', async () => {
  const fixture = await makeFixture({ unitCount: 3 });
  try {
    const [item] = (await chunk(fixture)).items;
    await submit(fixture, [{ sense_id: item.sense_id, verified: [item.contexts[0].k], candidates: ['서리'] }]);
    const good = await readFile(fixture.checkpointPath, 'utf8');
    const damagedVariants = [
      ['ZERO_HITS carrying a candidate', (cp) => Object.assign(cp.records[0].senses[0].submission, { status: 'ZERO_HITS', verified: [] })],
      ['candidate without verified context', (cp) => { cp.records[0].senses[0].submission.verified = []; }],
    ];
    for (const [name, damage] of damagedVariants) {
      const cp = JSON.parse(good);
      damage(cp);
      await writeFile(fixture.checkpointPath, JSON.stringify(cp));
      const plain = runCli(fixture, ['report', '--checkpoint', fixture.checkpointPath]);
      assert.notEqual(plain.status, 0, `plain report: ${name}`);
      assert.notEqual(runCli(fixture, cliChunkArgs(fixture)).status, 0, `chunk: ${name}`);
      await assert.rejects(exportOutput(fixture), /damaged/u, `export: ${name}`);
    }
    const valid = JSON.parse(good);
    Object.assign(valid.records[0].senses[0].submission, { status: 'ZERO_HITS', verified: [], candidates: [] });
    await writeFile(fixture.checkpointPath, JSON.stringify(valid));
    const plain = runCli(fixture, ['report', '--checkpoint', fixture.checkpointPath]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(plain.stdout).coverage.sense_statuses.ZERO_HITS >= 1, true);
  } finally {
    await cleanup(fixture);
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

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
  withCheckpointLock,
} from './literary-context.mjs';

const jsonl = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

async function makeFixture({ unitCount = 2, unitText, unitTexts, firstForm = '가나다', firstSenseGlosses,
  firstSearchForms = [], firstSenseId, secondLemma, workCount = 1, supervisorWorktree = false,
  senseCount = 500, repeatFirstLemma = false } = {}) {
  const fixtureRoot = path.resolve('.warroom-scratch');
  await mkdir(fixtureRoot, { recursive: true });
  const containerRoot = await mkdtemp(path.join(fixtureRoot, 'typewriter-literary-context-'));
  const root = supervisorWorktree ? path.join(containerRoot, 'worktree') : containerRoot;
  const repositoryRoot = supervisorWorktree ? path.join(containerRoot, 'repository') : null;
  if (supervisorWorktree) {
    await mkdir(repositoryRoot, { recursive: true });
    const sourceFiles = [
      'scripts/relation/candidate-contract.mjs',
      'scripts/relation/literary-context-cli.mjs',
      'scripts/relation/literary-context.mjs',
      'scripts/relation/literary-context-supervisor-cli.mjs',
      'scripts/relation/d-chunk-cli.mjs',
      'scripts/relation/corpus-utility.mjs',
      'docs/relation-literary-context.md',
      'docs/relation-factory.md',
      'tools/warroom/prompts/c.md',
    ];
    for (const file of sourceFiles) {
      const target = path.join(repositoryRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.resolve(file), target);
    }
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const staged = spawnSync('git', ['add', '--', 'scripts/relation', 'docs/relation-literary-context.md',
      'docs/relation-factory.md', 'tools/warroom/prompts/c.md'], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(staged.status, 0, staged.stderr);
    const committed = spawnSync('git', ['-c', 'user.name=Typewriter Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const added = spawnSync('git', ['worktree', 'add', '--quiet', '--detach', root, 'HEAD'], {
      cwd: repositoryRoot, encoding: 'utf8',
    });
    assert.equal(added.status, 0, added.stderr);
  }
  const canonicalDirectory = path.join(root, 'data/canonical');
  const scratchDirectory = path.join(root, '.warroom-scratch');
  await mkdir(canonicalDirectory, { recursive: true });
  await mkdir(scratchDirectory, { recursive: true });
  const extraSenseCount = Math.max(0, senseCount - 500);
  const records = Array.from({ length: 500 }, (_, index) => {
    const ordinal = String(index + 1).padStart(6, '0');
    const lemma = repeatFirstLemma ? firstForm : index === 0 ? firstForm : index === 1 && secondLemma ? secondLemma : `표제${ordinal}`;
    const senses = index === 0 && firstSenseGlosses
      ? firstSenseGlosses.map((gloss, senseIndex) => ({
        id: senseIndex === 0 ? firstSenseId ?? `sense-${ordinal}` : `sense-${ordinal}-${senseIndex + 1}`,
        pos: 'noun',
        gloss,
        relations: [],
      }))
      : Array.from({ length: index < extraSenseCount ? 2 : 1 }, (_, senseIndex) => ({
        id: senseIndex === 0 ? index === 0 && firstSenseId ? firstSenseId : `sense-${ordinal}` : `sense-${ordinal}-extra`,
        pos: 'noun', gloss: senseIndex === 0 ? `fixture gloss ${ordinal}` : `fixture extra gloss ${ordinal}`, relations: [],
      }));
    return {
      id: `record-${ordinal}`,
      lemma,
      search_forms: index === 0 ? firstSearchForms : [],
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
  return {
    root, containerRoot, repositoryRoot, scratchDirectory, canonicalPath, databasePath, checkpointPath, records, initialized,
  };
}

async function cleanup(fixture) {
  await rm(fixture.containerRoot ?? fixture.root, { recursive: true, force: true });
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

test('CLI export repairs source-lemma repeats in a saved checkpoint and preserves other senses', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '구름', firstSenseGlosses: ['first sense', 'second sense'] });
  try {
    const read = await chunk(fixture);
    const contextsBySense = new Map(read.items.map((item) => [item.sense_id, item.contexts[0].k]));
    const senseIds = ['sense-000001', 'sense-000001-2'];
    assert.deepEqual([...contextsBySense.keys()], senseIds);
    await submit(fixture, senseIds.map((sense_id) => ({
      sense_id,
      verified: [contextsBySense.get(sense_id)],
      candidates: ['서리'],
    })));
    const checkpoint = await load(fixture);
    checkpoint.records[0].senses[0].submission.candidates.push('구름');
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    const fixtureRoot = await realpath(fixture.root);
    const outputPath = path.join(fixtureRoot, 'data/relation-candidates/001/001_01_c_codex.jsonl');
    const cliPath = path.resolve('scripts/relation/literary-context-cli.mjs');
    const result = spawnSync(process.execPath, [
      cliPath, 'export', '--checkpoint', path.join(fixtureRoot, '.warroom-scratch/001_01_c_codex.checkpoint.json'),
      '--canonical', path.join(fixtureRoot, 'data/canonical/stdict-0001.jsonl'), '--output', outputPath,
    ], { cwd: fixtureRoot, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).coverage, { records: 500, senses: 501, candidates: 2, empty_senses: 499 });
    const saved = await load(fixture);
    assert.deepEqual(saved.records[0].senses.map((sense) => sense.submission.candidates), [['서리'], ['서리']]);
    const rows = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows[0].senses.map((sense) => sense.candidates), [['서리'], ['서리']]);
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

test('C producer-visible module has no technical-skip writer', async () => {
  const module = await import('./literary-context.mjs');
  assert.equal('supervisorSkipLiterarySense' in module, false);
  assert.throws(() => module.supervisorSkipLiterarySense({ retryAttempts: 2 }), TypeError);
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
        name: 'lone CR and CRLF count as line breaks',
        raw: '{"senses":\r[\r\n{"sense_id":"x"}\r]\r',
        reason: 'submission_schema',
        field: 'input',
        senseId: null,
        jsonSyntax: { line: 5, column: 1 },
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
      assert.match(diagnostic.input_sha256, /^[a-f0-9]{64}$/u, scenario.name);
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
      // The CLI's own diagnostic is what lets the Supervisor retry in place; a repairable rejection leaves it beside the input.
      const left = JSON.parse(await readFile(path.join(fixture.scratchDirectory, 'submit-input.json.diag.json'), 'utf8'));
      assert.equal(left.diagnostic, 'submit_validation', scenario.name);
      assert.equal(left.repair_scope, diagnostic.repair_scope, scenario.name);
      assert.equal(left.input_sha256, diagnostic.input_sha256, scenario.name);
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
    await assert.rejects(readFile(path.join(fixture.scratchDirectory, 'submit-input.json.diag.json'), 'utf8'), { code: 'ENOENT' });   // a stale diagnostic never survives a later submit
    // Input-file refusals (path outside scratch, missing, oversize) used to surface as an unlabeled "operation". Each is now named,
    // never retried, and never touches a sidecar outside .warroom-scratch/. (The recorded 035_02 cause is waived, not proven here.)
    const outside = path.join(fixture.root, 'outside-submit.json');
    await writeFile(outside, '{"senses":[]}');
    await writeFile(`${outside}.diag.json`, 'sentinel');
    await writeFile(path.join(fixture.scratchDirectory, 'oversize.json'), ' '.repeat(64_001));
    for (const [input, reason] of [[outside, 'outside_scratch'], [path.join(fixture.scratchDirectory, 'absent.json'), 'not_found'], [path.join(fixture.scratchDirectory, 'oversize.json'), 'too_large']]) {
      const refused = runCli(fixture, ['submit', '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, '--input', input]);
      const refusal = JSON.parse(refused.stderr);
      assert.equal(refused.status, 1, reason);
      assert.deepEqual([refusal.diagnostic, refusal.reason, refusal.repair_scope], ['submit_input', reason, 'correct_submission_path'], reason);
      assert.equal(refused.stderr.includes(fixture.root), false, reason);
      if (input !== outside) assert.equal(await readFile(`${input}.diag.json`, 'utf8').then(() => true, () => false), false, reason);
    }
    assert.equal(await readFile(`${outside}.diag.json`, 'utf8'), 'sentinel');
    // A symlink inside scratch that points outside must not let the sidecar be deleted or written there.
    const outsideDirectory = path.join(fixture.root, 'outside-directory');
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(path.join(outsideDirectory, 'submit.json'), '{"senses":[');
    await writeFile(path.join(outsideDirectory, 'submit.json.diag.json'), 'sentinel');
    await symlink(outsideDirectory, path.join(fixture.scratchDirectory, 'alias'));
    for (const linked of [path.join(fixture.scratchDirectory, 'alias', 'submit.json'), path.join(fixture.scratchDirectory, 'alias', 'new.json')]) {
      const refused = runCli(fixture, ['submit', '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, '--input', linked]);
      assert.equal(refused.status, 1, linked);
      assert.equal(JSON.parse(refused.stderr).diagnostic, 'submit_input', linked);
    }
    assert.equal(await readFile(path.join(outsideDirectory, 'submit.json.diag.json'), 'utf8'), 'sentinel');
    assert.equal(await readFile(path.join(outsideDirectory, 'new.json.diag.json'), 'utf8').then(() => true, () => false), false);
    const unrepairable = await submitCli(fixture, { senses: [{ sense_id: item.sense_id, verified: [], candidates: [] }] }, path.join(fixture.root, 'missing.sqlite'));
    assert.notEqual(unrepairable.status, 0);
    await assert.rejects(readFile(path.join(fixture.scratchDirectory, 'submit-input.json.diag.json'), 'utf8'), { code: 'ENOENT' });   // index/operation failures are never retryable
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

test('verified context keys trim surrounding whitespace before the unique-prefix check', () => {
  const row = { locator_key: 'abcdef123456' + '0'.repeat(52) };
  assert.equal(resolveVerifiedContextKey('  abcdef123456  ', 'sense-000001', [row]), row);
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

test('an empty submission completes a fully sampled sense with no verified context despite unread hits', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const senseId = 'sense-000001';
    const first = (await chunk(fixture, { senseIds: senseId, contexts: 8 })).items[0];
    const extra = (await chunk(fixture, { senseIds: senseId, contexts: 16, skip: 8 })).items[0];
    assert.equal(first.contexts.length, 8);
    assert.equal(extra.contexts.length, 8);
    assert.equal(extra.unseen_hits, 4);
    assert.equal((await load(fixture)).records[0].senses[0].shown.unit_rowids.length, 16);

    const saved = await submit(fixture, [{ sense_id: senseId, verified: [], candidates: [] }]);
    assert.equal(saved.status, 'SAVED');
    const report = reportCli(fixture, senseId);
    assert.equal(report.status, 0, report.stderr);
    const completion = JSON.parse(report.stdout);
    assert.equal(completion.all_done, true);
    assert.equal(completion.senses[0].status, 'SAMPLED_NO_VERIFIED');
    const checkpoint = await load(fixture);
    assert.deepEqual(checkpoint.records[0].senses[0].submission.verified, []);
    assert.deepEqual(checkpoint.records[0].senses[0].submission.candidates, []);
    const damaged = structuredClone(checkpoint);
    damaged.records[0].senses[0].submission.contexts_available = 8;
    assert.throws(() => reportLiteraryCheckpointSenses(damaged, senseId), /checkpoint sense submission is damaged/u);
    const missingShown = structuredClone(checkpoint);
    missingShown.records[0].senses[0].shown = null;
    assert.throws(() => reportLiteraryCheckpointSenses(missingShown, senseId), /checkpoint sense submission is damaged/u);
  } finally {
    await cleanup(fixture);
  }
});

test('SAMPLED_NO_VERIFIED requires 16 distinct contexts exposed for the current forms', async () => {
  const unopened = await makeFixture({ unitCount: 20 });
  try {
    const before = await readFile(unopened.checkpointPath, 'utf8');
    await rejectsSubmitAs(submit(unopened, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]), 'unshown_empty_sample');
    assert.equal(await readFile(unopened.checkpointPath, 'utf8'), before);
    const cliFailure = await submitCli(unopened, { senses: [{ sense_id: 'sense-000001', verified: [], candidates: [] }] });
    assert.equal(cliFailure.status, 1);
    const diagnostic = JSON.parse(cliFailure.stderr);
    assert.equal(diagnostic.reason, 'unshown_empty_sample');
    assert.equal(diagnostic.repair_scope, 'resubmit_affected_sense');
    const report = reportLiteraryCheckpointSenses(await load(unopened), 'sense-000001');
    assert.equal(report.all_done, false);
    assert.equal(report.senses[0].status, 'PENDING');
  } finally {
    await cleanup(unopened);
  }

  const reformed = await makeFixture({ unitCount: 20 });
  try {
    await chunk(reformed, { senseIds: 'sense-000001', contexts: 8 });
    await addSearchForm(reformed.checkpointPath, 'sense-000001', '새로운 검색 형태', 'reviewed fixture form',
      { scratchDirectory: reformed.scratchDirectory });
    await rejectsSubmitAs(submit(reformed, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]), 'unshown_empty_sample');
    const sense = (await load(reformed)).records[0].senses[0];
    assert.equal(sense.shown, null);
    assert.equal(sense.submission, null);
    const report = reportLiteraryCheckpointSenses(await load(reformed), 'sense-000001');
    assert.equal(report.all_done, false);
    assert.equal(report.senses[0].done, false);
  } finally {
    await cleanup(reformed);
  }

  const completeSmallSet = await makeFixture({ unitCount: 5 });
  try {
    const read = await chunk(completeSmallSet, { senseIds: 'sense-000001', contexts: 8 });
    assert.equal(read.items[0].contexts.length, 5);
    assert.equal(read.items[0].unseen_hits, 0);
    const saved = await submit(completeSmallSet, [{ sense_id: 'sense-000001', verified: [], candidates: [] }]);
    assert.equal(saved.status, 'SAVED');
    const sense = (await load(completeSmallSet)).records[0].senses[0];
    assert.equal(sense.submission.status, 'SUBMITTED');
    assert.equal(reportLiteraryCheckpointSenses(await load(completeSmallSet), 'sense-000001').all_done, true);
  } finally {
    await cleanup(completeSmallSet);
  }
});

test('chunk --skip returns only new contexts while preserving the full lookup evidence for submission', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const senseIds = 'sense-000001';
    const first = (await chunk(fixture, { senseIds, contexts: 8 })).items[0];
    const additional = (await chunk(fixture, { senseIds, contexts: 16, skip: 8 })).items[0];

    assert.equal(additional.contexts.length, 8);
    assert.equal(additional.unseen_hits, additional.total_hits - 16);
    const full = await chunk(fixture, { senseIds, contexts: 16 });
    assert.deepEqual(additional.contexts.map((context) => context.k), full.items[0].contexts.slice(8).map((context) => context.k));
    assert.deepEqual(full.items[0].contexts.slice(0, 8).map((context) => context.k), first.contexts.map((context) => context.k));
    assert.equal((await load(fixture)).records[0].senses[0].shown.unit_rowids.length, 16);

    const saved = await submit(fixture, [{
      sense_id: senseIds,
      verified: [first.contexts[0].k, additional.contexts[0].k],
      candidates: ['서리'],
    }]);
    assert.equal(saved.verified_contexts, 2);
  } finally {
    await cleanup(fixture);
  }
});

test('chunk --skip zero needs no prior evidence and skip 15 accepts an exact 15-context prefix', async () => {
  const zero = await makeFixture({ unitCount: 3 });
  try {
    const [item] = (await chunk(zero, { senseIds: 'sense-000001', contexts: 2, skip: 0 })).items;
    assert.equal(item.contexts.length, 2);
  } finally {
    await cleanup(zero);
  }

  const fifteen = await makeFixture({ unitCount: 20 });
  try {
    await chunk(fifteen, { senseIds: 'sense-000001', contexts: 15 });
    const [last] = (await chunk(fifteen, { senseIds: 'sense-000001', contexts: 16, skip: 15 })).items;
    assert.equal(last.contexts.length, 1);
    assert.equal(last.unseen_hits, last.total_hits - 16);
  } finally {
    await cleanup(fifteen);
  }
});

test('chunk --skip rejects invalid ranges, missing evidence and mismatched shown order without checkpoint writes', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const fresh = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 16, skip: 8 }), /previously shown context evidence/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), fresh);
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 8, skip: 8 }), /skip/u);
    await assert.rejects(chunk(fixture, { contexts: 16, skip: 0 }), /--sense-ids/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), fresh);

    await chunk(fixture, { senseIds: 'sense-000001', contexts: 8 });
    await addSearchForm(fixture.checkpointPath, 'sense-000001', '서릿발', 'fixture-reviewed form', { scratchDirectory: fixture.scratchDirectory });
    const afterFormChange = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 16, skip: 8 }), /previously shown context evidence/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), afterFormChange);

    await chunk(fixture, { senseIds: 'sense-000001', contexts: 8 });
    const checkpoint = await load(fixture);
    checkpoint.records[0].senses[0].shown.unit_rowids.reverse();
    await writeFile(fixture.checkpointPath, `${JSON.stringify(checkpoint)}\n`);
    const outOfOrder = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 16, skip: 8 }), /order no longer matches/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), outOfOrder);
  } finally {
    await cleanup(fixture);
  }
});

test('chunk output limits do not save evidence for context items that were not returned', async () => {
  const longForms = Array.from({ length: 50 }, (_, index) => `fixtureform${index}${'x'.repeat(900)}`);
  const fixture = await makeFixture({ unitCount: 2, firstSearchForms: longForms });
  try {
    const before = await readFile(fixture.checkpointPath, 'utf8');
    const cliArgs = (extra) => ['chunk', '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, ...extra];
    const textFailure = spawnSync(process.execPath, [path.resolve('scripts/relation/literary-context-cli.mjs'),
      ...cliArgs(['--sense-ids', 'sense-000001', '--contexts', '1', '--format', 'text'])],
    { cwd: fixture.root, encoding: 'utf8' });
    assert.equal(textFailure.status, 1);
    assert.equal(JSON.parse(textFailure.stderr).status, 'OUTPUT_LIMIT');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 2, skip: 1, format: 'text' }), /previously shown context evidence/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);

    const json = spawnSync(process.execPath, [path.resolve('scripts/relation/literary-context-cli.mjs'),
      ...cliArgs(['--sense-ids', 'sense-000001', '--contexts', '1'])],
    { cwd: fixture.root, encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const jsonOutput = JSON.parse(json.stdout);
    assert.deepEqual(jsonOutput.items, []);
    assert.deepEqual({ returned: jsonOutput.returned, has_more: jsonOutput.has_more, truncated: jsonOutput.truncated,
      next_offset: jsonOutput.next_offset, has_offset: Object.hasOwn(jsonOutput, 'offset') },
    { returned: 0, has_more: true, truncated: true, next_offset: null, has_offset: false });
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', contexts: 2, skip: 1 }), /previously shown context evidence/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
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

test('export removes one normalized duplicate and reuses the checkpoint output after later edits', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const [item] = (await chunk(fixture)).items;
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [item.contexts[0].k], candidates: ['겨울 아침'] }]);
    const checkpoint = await load(fixture);
    checkpoint.records[0].senses[0].submission.candidates.push('겨울  아침');
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    const output = await exportOutput(fixture);
    assert.equal(output.coverage.candidates, 1);
    assert.deepEqual((await load(fixture)).records[0].senses[0].submission.candidates, ['겨울 아침']);
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

test('submit removes all normalized source-lemma containment and preserves unrelated candidates and evidence', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '기륭', firstSearchForms: ['기-륭'], secondLemma: '기-륭' });
  try {
    const [item] = (await chunk(fixture)).items;
    const result = await submit(fixture, [{
      sense_id: item.sense_id,
      verified: [item.contexts[0].k],
      candidates: ['기륭', '기륭(註)', '기륭항', '서리', '기-륭'],
    }]);
    assert.equal(result.candidates, 1);
    const checkpoint = await load(fixture);
    const saved = checkpoint.records[0].senses[0].submission;
    assert.deepEqual(saved.candidates, ['서리']);
    assert.equal(saved.verified[0].locator_key.startsWith(item.contexts[0].k), true);
    assert.equal((await exportOutput(fixture)).coverage.candidates, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('submit may remove every ineligible candidate and still exports a verified empty sense', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '기륭' });
  try {
    const [item] = (await chunk(fixture)).items;
    const result = await submit(fixture, [{
      sense_id: item.sense_id,
      verified: [item.contexts[0].k],
      candidates: ['기륭', '기륭(註)'],
    }]);
    assert.equal(result.candidates, 0);
    const saved = (await load(fixture)).records[0].senses[0].submission;
    assert.deepEqual(saved.candidates, []);
    assert.equal(saved.verified.length, 1);
    const output = await exportOutput(fixture);
    assert.equal(output.coverage.candidates, 0);
    assert.equal(output.coverage.empty_senses, 500);
  } finally {
    await cleanup(fixture);
  }
});

test('export removes all diagnosed source-bound content errors from saved checkpoint senses and preserves the rest', async () => {
  const fixture = await makeFixture({
    unitCount: 1,
    firstForm: '구름',
    firstSenseGlosses: ['약 7,460미터의 길이', '두 번째 뜻'],
  });
  try {
    const items = (await chunk(fixture)).items;
    const contexts = new Map(items.map((item) => [item.sense_id, item.contexts[0].k]));
    await submit(fixture, items.map((item, index) => ({
      sense_id: item.sense_id,
      verified: [contexts.get(item.sense_id)],
      candidates: [index === 0 ? '서리' : '겨울 아침'],
    })));
    const checkpoint = await load(fixture);
    const first = checkpoint.records[0].senses[0].submission;
    const second = checkpoint.records[0].senses[1].submission;
    const firstVerified = structuredClone(first.verified);
    const secondVerified = structuredClone(second.verified);
    const submittedAt = [first.submitted_at, second.submitted_at];
    first.candidates.push('구름', '460');
    second.candidates.push('구름 (註)');
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));

    const output = await exportOutput(fixture);
    assert.equal(output.coverage.candidates, 2);
    const repaired = await load(fixture);
    assert.deepEqual(repaired.records[0].senses[0].submission.candidates, ['서리']);
    assert.deepEqual(repaired.records[0].senses[1].submission.candidates, ['겨울 아침']);
    assert.deepEqual(repaired.records[0].senses[0].submission.verified, firstVerified);
    assert.deepEqual(repaired.records[0].senses[1].submission.verified, secondVerified);
    assert.deepEqual(repaired.records[0].senses.slice(0, 2).map((sense) => sense.submission.submitted_at), submittedAt);
    assert.equal(repaired.output.validation_status, 'VALID');
    const rows = (await readFile(path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows[0].senses.map((sense) => sense.candidates), [['서리'], ['겨울 아침']]);
  } finally {
    await cleanup(fixture);
  }
});

test('export does not clean candidate strings when checkpoint-to-Canonical binding fails', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '구름' });
  try {
    const [item] = (await chunk(fixture)).items;
    await submit(fixture, [{ sense_id: item.sense_id, verified: [item.contexts[0].k], candidates: ['서리'] }]);
    const checkpoint = await load(fixture);
    checkpoint.records[0].senses[0].submission.candidates.push('구름');
    checkpoint.records[0].lemma = '손상된 결속';
    await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint));
    const before = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(exportOutput(fixture), /not bound to current Canonical/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(fixture);
  }
});

test('candidate fallback empties exact source-bound senses while preserving submission evidence', async () => {
  const fixture = await makeFixture({ unitCount: 1, firstForm: '기륭' });
  try {
    const [item] = (await chunk(fixture)).items;
    await submit(fixture, [{ sense_id: item.sense_id, verified: [item.contexts[0].k], candidates: ['서리'] }]);
    const before = (await load(fixture)).records[0].senses[0].submission;
    const result = runCli(fixture, ['clear-candidates', '--checkpoint', fixture.checkpointPath,
      '--canonical', fixture.canonicalPath, '--sense-ids', item.sense_id]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'CLEARED', senses: 1, candidates: 1 });
    const after = (await load(fixture)).records[0].senses[0].submission;
    assert.deepEqual(after.candidates, []);
    assert.deepEqual(after.verified, before.verified);
    assert.equal(after.submitted_at, before.submitted_at);
    assert.equal((await exportOutput(fixture)).coverage.candidates, 0);
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

const runCli = (fixture, args, environment = {}, cwd = fixture.root) => spawnSync(process.execPath,
  [path.join(fixture.repositoryRoot ?? process.cwd(), 'scripts/relation/literary-context-cli.mjs'), ...args],
  { cwd, env: { ...process.env, ...environment }, encoding: 'utf8' });
const cliChunkArgs = (fixture, extra = []) => ['chunk', '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, ...extra];
const PRE_2889_C_HEAD = '54518330f83c4fb31aabc9cb067b328a58125dd6';
const runScriptAt = (cwd, script, args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('pre-#2889 C worktree is revalidated and resumed through the current Supervisor CLI', async () => {
  const fixture = await makeFixture({ supervisorWorktree: true, senseCount: 613, repeatFirstLemma: true });
  const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'typewriter-c-legacy-test-')));
  const legacyRoot = path.join(temporaryRoot, 'worktree');
  const supervisorRoot = path.join(temporaryRoot, 'supervisor');
  const repoRoot = path.resolve('.');
  const checkpoint = '.warroom-scratch/044_01_c_codex.checkpoint.json';
  const input = '.warroom-scratch/c-chunk-014.submit.json';
  const diagnostic = `${input}.diag.json`;
  const currentCli = path.join(supervisorRoot, 'scripts/relation/literary-context-cli.mjs');
  const supervisorCli = path.join(supervisorRoot, 'scripts/relation/literary-context-supervisor-cli.mjs');
  const supervisorStorePath = path.join(supervisorRoot, 'tools/warroom/.local/warroom.db');
  const supervisorBatchId = 1140;
  const supervisorRunId = 1401;
  const supervisorSessionId = 'fixture-session';
  const supervisorBranch = 'codex/test-c-044-01';
  let supervisorStore;
  let currentHead = '';
  const supervisorSkip = (head = null, storePath = supervisorStorePath, extraArgs = []) => runScriptAt(legacyRoot,
    supervisorCli, [
      '--checkpoint', checkpoint, '--input', input, '--diagnostic', diagnostic,
      '--active', '.warroom-scratch/c-active-chunk.json', '--view', '.warroom-scratch/c-active-chunk.txt',
      '--chunk-no', '14', '--supervisor-store', storePath, '--batch-id', String(supervisorBatchId),
      '--branch', supervisorBranch, '--session-id', supervisorSessionId, '--run-id', String(supervisorRunId),
      '--expected-head', head ?? currentHead, ...extraArgs,
    ]);
  try {
    const legacyFiles = [
      'scripts/relation/candidate-contract.mjs',
      'scripts/relation/literary-context-cli.mjs',
      'scripts/relation/literary-context.mjs',
      'docs/relation-literary-context.md',
      'docs/relation-factory.md',
      'tools/warroom/prompts/c.md',
    ];
    await mkdir(supervisorRoot, { recursive: true });
    for (const file of [...legacyFiles, 'scripts/relation/literary-context-supervisor-cli.mjs']) {
      const target = path.join(supervisorRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repoRoot, file), target);
    }
    await mkdir(path.dirname(supervisorStorePath), { recursive: true });
    supervisorStore = new DatabaseSync(supervisorStorePath);
    supervisorStore.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE batches (
        id INTEGER PRIMARY KEY, method TEXT, producer TEXT, shard TEXT, batch TEXT, branch TEXT, worktree TEXT,
        state TEXT, session_id TEXT, pid INTEGER, run_kind TEXT
      );
      CREATE TABLE runs (id INTEGER PRIMARY KEY, batch_id INTEGER, kind TEXT, session_id TEXT, ended_at REAL);
    `);
    supervisorStore.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run(`c_resubmit_${supervisorBatchId}`, '2');
    supervisorStore.prepare(`INSERT INTO batches
      (id, method, producer, shard, batch, branch, worktree, state, session_id, pid, run_kind)
      VALUES(?, 'c', 'codex', '044', '01', ?, ?, 'PRODUCING', ?, NULL, 'c_chunk_new')`)
      .run(supervisorBatchId, supervisorBranch, legacyRoot, supervisorSessionId);
    supervisorStore.prepare(`INSERT INTO runs(id, batch_id, kind, session_id, ended_at)
      VALUES(?, ?, 'c_chunk_new', ?, 1)`)
      .run(supervisorRunId, supervisorBatchId, supervisorSessionId);
    const setSupervisorState = ({ retryAttempts = '2', pid = null, endedAt = 1 } = {}) => {
      supervisorStore.prepare('UPDATE kv SET value=? WHERE key=?').run(retryAttempts, `c_resubmit_${supervisorBatchId}`);
      supervisorStore.prepare('UPDATE batches SET pid=? WHERE id=?').run(pid, supervisorBatchId);
      supervisorStore.prepare('UPDATE runs SET ended_at=? WHERE id=?').run(endedAt, supervisorRunId);
    };
    const archived = spawnSync('git', ['archive', '--format=tar', PRE_2889_C_HEAD, ...legacyFiles], {
      cwd: repoRoot, encoding: null, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(archived.status, 0, archived.stderr?.toString());
    await mkdir(legacyRoot, { recursive: true });
    const extracted = spawnSync('tar', ['-xf', '-'], { cwd: legacyRoot, input: archived.stdout, encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    const initializedGit = spawnSync('git', ['init', '--quiet'], { cwd: legacyRoot, encoding: 'utf8' });
    assert.equal(initializedGit.status, 0, initializedGit.stderr);
    const stagedLegacy = spawnSync('git', ['add', '--', ...legacyFiles], { cwd: legacyRoot, encoding: 'utf8' });
    assert.equal(stagedLegacy.status, 0, stagedLegacy.stderr);
    const committedLegacy = spawnSync('git', ['-c', 'user.name=Typewriter Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'legacy C CLI source fixture'], { cwd: legacyRoot, encoding: 'utf8' });
    assert.equal(committedLegacy.status, 0, committedLegacy.stderr);
    currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: legacyRoot, encoding: 'utf8' }).stdout.trim();
    const oldCli = path.join(legacyRoot, 'scripts/relation/literary-context-cli.mjs');
    const oldModule = path.join(legacyRoot, 'scripts/relation/literary-context.mjs');
    for (const file of legacyFiles) {
      const source = spawnSync('git', ['show', `${PRE_2889_C_HEAD}:${file}`], { cwd: repoRoot, encoding: null });
      assert.equal(source.status, 0, source.stderr?.toString());
      assert.deepEqual(await readFile(path.join(legacyRoot, file)), source.stdout, `legacy source snapshot: ${file}`);
    }
    assert.doesNotMatch(await readFile(oldCli, 'utf8'), /input_sha256/u, 'the checked-out CLI is the actual pre-#2889 source');
    assert.doesNotMatch(await readFile(oldModule, 'utf8'), /TECHNICAL_SKIPPED/u, 'the legacy checkpoint reader lacks the new state');

    await mkdir(path.join(legacyRoot, 'data/canonical'), { recursive: true });
    await mkdir(path.join(legacyRoot, '.warroom-scratch'), { recursive: true });
    await mkdir(path.join(legacyRoot, 'data/relation-candidates/044'), { recursive: true });
    await writeFile(path.join(legacyRoot, 'data/canonical/stdict-0044.jsonl'), jsonl(fixture.records));
    await copyFile(fixture.databasePath, path.join(legacyRoot, 'approved.sqlite'));

    const initialized = runScriptAt(legacyRoot, oldCli, [
      'init', '--canonical', 'data/canonical/stdict-0044.jsonl', '--shard', '044', '--batch', '01', '--model', 'codex',
      '--db', 'approved.sqlite', '--checkpoint', checkpoint,
    ]);
    assert.equal(initialized.status, 0, initialized.stderr);
    let cp = JSON.parse(await readFile(path.join(legacyRoot, checkpoint), 'utf8'));
    const allSenses = cp.records.flatMap((record) => record.senses);
    assert.equal(allSenses.length, 613);
    const priorSenses = allSenses.slice(0, 435);
    for (const [index, sense] of priorSenses.entries()) {
      sense.submission = { status: 'SUBMITTED', verified: [{ locator_key: `prior-${index}` }], candidates: ['겨울'] };
    }
    const priorBefore = structuredClone(priorSenses.map((sense) => sense.submission));
    await writeFile(path.join(legacyRoot, checkpoint), `${JSON.stringify(cp, null, 2)}\n`);

    const chunkArgs = ['chunk', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--limit', '12'];
    const chunkJson = runScriptAt(legacyRoot, oldCli, [...chunkArgs, '--format', 'json']);
    assert.equal(chunkJson.status, 0, chunkJson.stderr);
    const items = JSON.parse(chunkJson.stdout).items;
    assert.equal(items.length, 12);
    const activeIds = items.map((item) => item.sense_id);
    const activeView = runScriptAt(legacyRoot, oldCli, [...chunkArgs, '--format', 'text']);
    assert.equal(activeView.status, 0, activeView.stderr);
    const viewBytes = Buffer.from(activeView.stdout, 'utf8');
    const viewSha256 = createHash('sha256').update(viewBytes).digest('hex');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: legacyRoot, encoding: 'utf8' }).stdout.trim();
    await writeFile(path.join(legacyRoot, '.warroom-scratch/c-active-chunk.txt'), viewBytes);
    await writeFile(path.join(legacyRoot, '.warroom-scratch/c-active-chunk.json'), `${JSON.stringify({
      chunk_id: '044-01-014', chunk_no: 14, sense_ids: activeIds, view_sha256: viewSha256,
      view_bytes: viewBytes.length, git_head: head, shard: '044', batch: '01', model: 'codex',
    })}\n`);
    const entryById = new Map(items.map((item) => [item.sense_id, item]));
    const entries = activeIds.map((senseId, index) => ({
      sense_id: senseId,
      verified: [index === 7 ? 'zzzzzzzzzzzz' : entryById.get(senseId).contexts[0].k],
      candidates: ['겨울'],
    }));
    const fullSubmission = { senses: entries };
    const inputBytes = Buffer.from(JSON.stringify(fullSubmission), 'utf8');
    await writeFile(path.join(legacyRoot, input), inputBytes);

    const legacyRejected = runScriptAt(legacyRoot, oldCli, [
      'submit', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--input', input,
    ]);
    assert.notEqual(legacyRejected.status, 0);
    let currentDiagnostic = JSON.parse(await readFile(path.join(legacyRoot, diagnostic), 'utf8'));
    assert.equal(currentDiagnostic.reason, 'context_key_not_found');
    assert.equal(currentDiagnostic.affected.entry_number, 8);
    assert.equal(Object.hasOwn(currentDiagnostic, 'input_sha256'), false, 'legacy CLI reproduces the missing digest');
    const beforeRevalidation = JSON.parse(await readFile(path.join(legacyRoot, checkpoint), 'utf8'));
    const legacySkip = supervisorSkip();
    assert.notEqual(legacySkip.status, 0);
    assert.equal(JSON.parse(legacySkip.stdout).reason_code, 'input_digest_mismatch',
      'a legacy diagnostic without a digest cannot authorize a skip');

    const refreshed = runScriptAt(legacyRoot, currentCli, [
      'submit', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--input', input,
    ]);
    assert.notEqual(refreshed.status, 0);
    currentDiagnostic = JSON.parse(await readFile(path.join(legacyRoot, diagnostic), 'utf8'));
    const inputSha = createHash('sha256').update(inputBytes).digest('hex');
    assert.equal(currentDiagnostic.input_sha256, inputSha);
    assert.deepEqual(JSON.parse(await readFile(path.join(legacyRoot, checkpoint), 'utf8')), beforeRevalidation,
      'rejected current validation leaves the legacy checkpoint unchanged');

    await writeFile(path.join(legacyRoot, input), Buffer.concat([inputBytes, Buffer.from(' ')]));
    const stale = supervisorSkip(head);
    assert.notEqual(stale.status, 0);
    assert.equal(JSON.parse(stale.stdout).reason_code, 'input_digest_mismatch');
    assert.deepEqual(JSON.parse(await readFile(path.join(legacyRoot, checkpoint), 'utf8')), beforeRevalidation,
      'a stale sidecar does not mutate the checkpoint');

    await writeFile(path.join(legacyRoot, input), inputBytes);
    const refreshedAgain = runScriptAt(legacyRoot, currentCli, [
      'submit', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--input', input,
    ]);
    assert.notEqual(refreshedAgain.status, 0);

    const validDiagnostic = await readFile(path.join(legacyRoot, diagnostic));
    const validCheckpoint = await readFile(path.join(legacyRoot, checkpoint));
    const expectBlockedWithoutMutation = async (invoke, reason) => {
      const checkpointBefore = await readFile(path.join(legacyRoot, checkpoint));
      const result = invoke();
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).reason_code, reason);
      assert.deepEqual(await readFile(path.join(legacyRoot, checkpoint)), checkpointBefore);
    };
    const multipleIssueDiagnostic = JSON.parse(validDiagnostic.toString('utf8'));
    multipleIssueDiagnostic.issues.push({ ...multipleIssueDiagnostic.issues[0] });
    await writeFile(path.join(legacyRoot, diagnostic), JSON.stringify(multipleIssueDiagnostic));
    await expectBlockedWithoutMutation(() => supervisorSkip(), 'diagnostic_not_single_sense');
    await writeFile(path.join(legacyRoot, diagnostic), validDiagnostic);

    const wrongAffectedDiagnostic = JSON.parse(validDiagnostic.toString('utf8'));
    wrongAffectedDiagnostic.affected.sense_id = activeIds[0];
    await writeFile(path.join(legacyRoot, diagnostic), JSON.stringify(wrongAffectedDiagnostic));
    await expectBlockedWithoutMutation(() => supervisorSkip(), 'diagnostic_not_single_sense');
    await writeFile(path.join(legacyRoot, diagnostic), validDiagnostic);

    await expectBlockedWithoutMutation(() => supervisorSkip('b'.repeat(40)), 'worktree_identity_mismatch');

    await expectBlockedWithoutMutation(() => supervisorSkip(null, path.join(temporaryRoot, 'fake-warroom.db')),
      'supervisor_store_identity_mismatch');
    setSupervisorState({ retryAttempts: '1' });
    await expectBlockedWithoutMutation(() => supervisorSkip(null, supervisorStorePath, ['--retry-attempts', '2']),
      'supervisor_skip_operation_failed');
    await expectBlockedWithoutMutation(() => supervisorSkip(), 'resubmit_budget_not_exhausted');
    setSupervisorState({ pid: 21644 });
    await expectBlockedWithoutMutation(() => supervisorSkip(), 'supervisor_batch_not_idle');
    setSupervisorState({ endedAt: null });
    await expectBlockedWithoutMutation(() => supervisorSkip(), 'supervisor_run_not_finished');
    setSupervisorState();

    let invalidCheckpoint = JSON.parse(validCheckpoint.toString('utf8'));
    invalidCheckpoint.batch.git_head = 'b'.repeat(40);
    await writeFile(path.join(legacyRoot, checkpoint), JSON.stringify(invalidCheckpoint));
    await expectBlockedWithoutMutation(() => supervisorSkip(head), 'checkpoint_or_active_binding_mismatch');
    await writeFile(path.join(legacyRoot, checkpoint), validCheckpoint);

    invalidCheckpoint = JSON.parse(validCheckpoint.toString('utf8'));
    invalidCheckpoint.batch.procedure_sha256 = 'b'.repeat(64);
    await writeFile(path.join(legacyRoot, checkpoint), JSON.stringify(invalidCheckpoint));
    await expectBlockedWithoutMutation(() => supervisorSkip(head), 'source_procedure_digest_mismatch');
    await writeFile(path.join(legacyRoot, checkpoint), validCheckpoint);

    const indexFailure = runScriptAt(legacyRoot, currentCli, [
      'submit', '--db', 'missing-approved.sqlite', '--checkpoint', checkpoint, '--input', input,
    ]);
    assert.notEqual(indexFailure.status, 0);
    assert.equal(await stat(path.join(legacyRoot, diagnostic)).then(() => true, () => false), false,
      'an approved index failure clears the previous retry diagnostic');
    await expectBlockedWithoutMutation(() => supervisorSkip(head), 'current_evidence_unavailable');
    await writeFile(path.join(legacyRoot, diagnostic), validDiagnostic);

    const unaffected = entries.filter((_, index) => index !== 7);
    const unaffectedInput = '.warroom-scratch/c-chunk-014.supervisor-submit.json';
    await writeFile(path.join(legacyRoot, unaffectedInput), JSON.stringify({ senses: unaffected }));
    const saved = runScriptAt(legacyRoot, currentCli, [
      'submit', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--input', unaffectedInput,
    ]);
    assert.equal(saved.status, 0, saved.stderr);
    const skipped = supervisorSkip(head);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(JSON.parse(skipped.stdout).status, 'TECHNICAL_SKIPPED');

    // Parallel (`--task`) authority: the task's OWN completed automatic corrections and finished run decide, never the
    // serial counters. The target is already skipped here, so a passing authority ends at `source_sense_already_saved`.
    supervisorStore.exec(`CREATE TABLE s2_tasks (batch_id INTEGER, task TEXT, state TEXT, session_id TEXT, data TEXT);
      ALTER TABLE runs ADD COLUMN exit_status TEXT; ALTER TABLE runs ADD COLUMN task TEXT;`);
    supervisorStore.prepare("UPDATE batches SET run_kind='c_parallel' WHERE id=?").run(supervisorBatchId);
    const addTaskRun = (id, kind) => supervisorStore.prepare(`INSERT INTO runs(id, batch_id, kind, session_id, ended_at, exit_status, task)
      VALUES(?, ?, ?, ?, 1, '0', '014')`).run(id, supervisorBatchId, kind, supervisorSessionId);
    const setTask = (data) => {
      supervisorStore.prepare('DELETE FROM s2_tasks WHERE batch_id=?').run(supervisorBatchId);
      supervisorStore.prepare("INSERT INTO s2_tasks(batch_id, task, state, session_id, data) VALUES(?, '014', 'PENDING', ?, ?)")
        .run(supervisorBatchId, supervisorSessionId, JSON.stringify(data));
    };
    const taskSkip = (runId) => runScriptAt(legacyRoot, supervisorCli, [
      '--checkpoint', checkpoint, '--input', input, '--diagnostic', diagnostic,
      '--active', '.warroom-scratch/c-active-chunk.json', '--view', '.warroom-scratch/c-active-chunk.txt',
      '--chunk-no', '14', '--supervisor-store', supervisorStorePath, '--batch-id', String(supervisorBatchId),
      '--branch', supervisorBranch, '--session-id', supervisorSessionId, '--run-id', String(runId),
      '--expected-head', head, '--task', '014']);
    const reasonOf = (result) => JSON.parse(result.stdout).reason_code;
    addTaskRun(2001, 'c_chunk_fix');
    assert.equal(reasonOf(taskSkip(2001)), 'supervisor_session_mismatch', 'no task row');
    setTask({ auto_fix_runs: [2001], completed_fix_runs: [2001] });
    assert.equal(reasonOf(taskSkip(2001)), 'resubmit_budget_not_exhausted', 'one automatic correction is not enough');
    addTaskRun(2002, 'c_chunk_fix');
    addTaskRun(2003, 'c_chunk_new');
    setTask({ auto_fix_runs: [2001, 2002], completed_fix_runs: [2001, 2002, 2003] });
    assert.equal(reasonOf(taskSkip(2003)), 'resubmit_budget_not_exhausted', 'the current failure must bind to a correction');
    setTask({ auto_fix_runs: [2001, 2002], completed_fix_runs: [2001, 2002] });
    assert.equal(reasonOf(taskSkip(2002)), 'supervisor_run_not_finished', 'only the task\'s latest run is current');
    supervisorStore.prepare('DELETE FROM runs WHERE id=2003').run();
    assert.equal(reasonOf(taskSkip(2002)), 'source_sense_already_saved', 'two completed automatic corrections pass the authority');
    supervisorStore.prepare('DELETE FROM s2_tasks WHERE batch_id=?').run(supervisorBatchId);

    cp = JSON.parse(await readFile(path.join(legacyRoot, checkpoint), 'utf8'));
    const savedSenses = new Map(cp.records.flatMap((record) => record.senses.map((sense) => [sense.sense_id, sense])));
    assert.deepEqual(cp.records.flatMap((record) => record.senses).slice(0, 435).map((sense) => sense.submission), priorBefore,
      'all 435 earlier senses remain unchanged');
    const targetId = activeIds[7];
    assert.equal(savedSenses.get(targetId).submission.status, 'TECHNICAL_SKIPPED');
    assert.deepEqual(savedSenses.get(targetId).submission.candidates, []);
    const skip = savedSenses.get(targetId).submission.technical_skip;
    assert.equal(skip.input_sha256, inputSha);
    assert.equal(skip.source_procedure_sha256, cp.batch.procedure_sha256);
    assert.match(skip.runtime_procedure_sha256, /^[a-f0-9]{64}$/u);
    assert.match(skip.supervisor_cli_sha256, /^[a-f0-9]{64}$/u);
    for (const entry of unaffected) {
      const savedSense = savedSenses.get(entry.sense_id).submission;
      assert.equal(savedSense.status, 'SUBMITTED');
      assert.deepEqual(savedSense.candidates, entry.candidates);
      assert.equal(savedSense.verified.length, 1);
      assert.ok(savedSense.verified[0].locator_key.startsWith(entry.verified[0]));
    }
    const latestReport = runScriptAt(legacyRoot, currentCli, ['report', '--checkpoint', checkpoint,
      '--sense-ids', activeIds.join(',')]);
    assert.equal(latestReport.status, 0, latestReport.stderr);
    assert.equal(JSON.parse(latestReport.stdout).all_done, true);
    const oldReport = runScriptAt(legacyRoot, oldCli, ['report', '--checkpoint', checkpoint]);
    assert.notEqual(oldReport.status, 0, 'legacy CLI cannot report the new state');

    const currentChunk = runScriptAt(legacyRoot, currentCli, [
      'chunk', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--limit', '12', '--contexts', '1',
    ]);
    assert.equal(currentChunk.status, 0, currentChunk.stderr);
    assert.equal(JSON.parse(currentChunk.stdout).items.some((item) => item.sense_id === targetId), false,
      'restart does not requeue the technical exclusion');
    let finishedChunks = 0;
    while (true) {
      const next = runScriptAt(legacyRoot, currentCli, [
        'chunk', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--limit', '12', '--contexts', '1',
      ]);
      assert.equal(next.status, 0, next.stderr);
      const nextItems = JSON.parse(next.stdout).items;
      if (nextItems.length === 0) break;
      const nextEntries = nextItems.map((item) => ({ sense_id: item.sense_id,
        verified: [item.contexts[0].k], candidates: ['겨울'] }));
      const nextInput = `.warroom-scratch/next-${finishedChunks}.submit.json`;
      await writeFile(path.join(legacyRoot, nextInput), JSON.stringify({ senses: nextEntries }));
      const nextSave = runScriptAt(legacyRoot, currentCli, [
        'submit', '--db', 'approved.sqlite', '--checkpoint', checkpoint, '--input', nextInput,
      ]);
      assert.equal(nextSave.status, 0, nextSave.stderr);
      finishedChunks += 1;
    }
    const output = 'data/relation-candidates/044/044_01_c_codex.jsonl';
    const exported = runScriptAt(legacyRoot, currentCli, [
      'export', '--checkpoint', checkpoint, '--canonical', 'data/canonical/stdict-0044.jsonl', '--output', output,
    ]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).status, 'OUTPUT');
    const finalReport = JSON.parse(runScriptAt(legacyRoot, currentCli, ['report', '--checkpoint', checkpoint]).stdout);
    assert.equal(finalReport.coverage.senses, 613);
    assert.equal(finalReport.coverage.sense_statuses.TECHNICAL_SKIPPED, 1);
    assert.equal(finalReport.coverage.sense_statuses.SUBMITTED, 612);
    assert.equal(finalReport.output.validation_status, 'VALID');
    assert.equal((await readFile(path.join(legacyRoot, output), 'utf8')).trim().split('\n').length, 500);
  } finally {
    supervisorStore?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    await cleanup(fixture);
  }
});

test('chunk CLI emits each shared-form Sense’s unread suffix within the C chunk scope', async () => {
  const fixture = await makeFixture({ unitCount: 42, firstForm: '능사', firstSenseId: 'w68162-s1',
    firstSenseGlosses: ['뜻 하나', '뜻 둘'], repeatFirstLemma: true });
  try {
    const ids = ['w68162-s1', 'sense-000001-2', 'sense-000002'];
    const keysBySense = (output) => new Map(output.split(/^## /mu).slice(1).map((item) => [
      item.split(' ')[0], [...item.matchAll(/^\[([A-Za-z0-9]{12})\] /gmu)].map((match) => match[1]),
    ]));
    const first = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', ids.join(','), '--contexts', '8', '--format', 'text']));
    assert.equal(first.status, 0, first.stderr);
    const initialKeys = keysBySense(first.stdout);

    const activeView = Buffer.from(first.stdout);
    await writeFile(path.join(fixture.scratchDirectory, 'c-active-001.txt'), activeView);
    await writeFile(path.join(fixture.scratchDirectory, 'c-active-001.json'), JSON.stringify({
      chunk_id: '001-01-001', chunk_no: 1, sense_ids: ids, shard: '001', batch: '01', model: 'codex',
      git_head: 'a'.repeat(40), view_sha256: createHash('sha256').update(activeView).digest('hex'),
      view_bytes: activeView.byteLength,
    }));

    const extra = runCli(fixture, cliChunkArgs(fixture, [
      '--sense-ids', ids.join(','), '--skip', '8', '--contexts', '16', '--format', 'text', '--chunk', '001',
    ]));
    assert.equal(extra.status, 0, extra.stderr);
    const suffixKeys = keysBySense(extra.stdout);
    for (const id of ids) {
      assert.equal(initialKeys.get(id).length, 8);
      assert.equal(suffixKeys.get(id).length, 8);
      for (const key of initialKeys.get(id)) assert.equal(suffixKeys.get(id).includes(key), false);
      assert.deepEqual(initialKeys.get(id), initialKeys.get(ids[0]));
      assert.deepEqual(suffixKeys.get(id), suffixKeys.get(ids[0]));
    }
    assert.match(extra.stdout, /hits=42 unseen=26/u);
    const checkpoint = await load(fixture);
    assert.equal(checkpoint.records[0].senses[0].sense_id, 'w68162-s1');
    assert.equal(checkpoint.records[0].senses[0].shown.unit_rowids.length, 16);
  } finally {
    await cleanup(fixture);
  }
});

test('CLI usage diagnostics are fixed and validation precedes checkpoint/database access', async () => {
  const fixture = await makeFixture({ unitCount: 1 });
  try {
    const before = await readFile(fixture.checkpointPath, 'utf8');
    const cases = [
      [['--contexts', '1-4'], '--contexts must be an integer 1..16'],
      [['--contexts', '0'], '--contexts must be an integer 1..16'],
      [['--sense-ids', 'a b'], '--sense-ids must be a comma-separated list of valid IDs'],
      [['--sense-ids', 'a', 'b'], 'arguments must use --option value pairs'],
      [['--unknown', 'private-value'], 'unsupported option'],
      [['--skip', '0'], '--skip requires --sense-ids'],
      [['--sense-ids', 'sense-000001', '--skip', '16', '--contexts', '16'], '--skip must be an integer 0..contexts-1'],
    ];
    for (const [args, expectedMessage] of cases) {
      const result = runCli(fixture, cliChunkArgs(fixture, args));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const diagnostic = JSON.parse(result.stderr);
      assert.deepEqual(diagnostic, { status: 'FAILED', diagnostic: 'usage', message: expectedMessage });
      assert.equal(result.stderr.includes(fixture.root), false);
      assert.equal(result.stderr.includes('private-value'), false);
      assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    }

    const missingDb = path.join(fixture.root, 'private-missing-literary-index.sqlite');
    const failedOperation = runCli(fixture, [
      'chunk', '--db', missingDb, '--checkpoint', fixture.checkpointPath,
      '--sense-ids', 'sense-000001', '--contexts', '1',
    ]);
    assert.equal(failedOperation.status, 1);
    const protectedDiagnostic = JSON.parse(failedOperation.stderr);
    assert.equal(protectedDiagnostic.diagnostic, 'index_access');
    assert.equal(failedOperation.stderr.includes(missingDb), false);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(fixture);
  }
});

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

// ---- #3076: concurrent chunk workers share one checkpoint -----------------------------------------------------------
const THREE_SENSES = ['one', 'two', 'three'];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Hold a live lock by hand, start the operation (it must wait), change the checkpoint, then release. */
async function changeWhileOperationWaits(fixture, startOperation, mutate) {
  const lockFile = `${fixture.checkpointPath}.lock`;
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: 'test-holder', acquired_at: new Date().toISOString() }));
  const operation = startOperation();
  const settled = operation.then(() => null, (error) => error);
  await sleep(600);
  const checkpoint = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
  mutate(checkpoint);
  await writeFile(fixture.checkpointPath, JSON.stringify(checkpoint, null, 2));
  await unlink(lockFile);
  return { operation, error: await settled };
}

const addFormInPlace = (checkpoint, senseId, form) => {
  const sense = checkpoint.records.flatMap((record) => record.senses).find((item) => item.sense_id === senseId);
  sense.added_forms.push({ form, basis: 'test', added_at: new Date().toISOString() });
  sense.submission = null;
  sense.shown = null;
};

function runChild(source, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { cwd: process.cwd() });
    let stderr = '';
    child.stderr.on('data', (chunkData) => { stderr += chunkData; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('mutations of different Senses overlap without losing each other (submit, add-form, chunk --skip)', async () => {
  const fixture = await makeFixture({ unitCount: 20, firstSenseGlosses: THREE_SENSES });
  try {
    const first = await chunk(fixture, { contexts: 8 });
    const [one, , three] = first.items;
    assert.equal(first.items.length, 3);
    await Promise.all([
      submit(fixture, [{ sense_id: 'sense-000001', verified: [one.contexts[0].k], candidates: ['서리'] }]),
      addSearchForm(fixture.checkpointPath, 'sense-000001-2', '가나다라', 'test basis', { scratchDirectory: fixture.scratchDirectory }),
      chunk(fixture, { senseIds: three.sense_id, contexts: 16, skip: 8 }),
    ]);
    const senses = (await load(fixture)).records[0].senses;
    assert.equal(senses[0].submission.status, 'SUBMITTED');
    assert.deepEqual(senses[1].added_forms.map((item) => item.form), ['가나다라']);
    assert.equal(senses[1].submission, null);
    assert.equal(senses[2].shown.unit_rowids.length, 16);
  } finally {
    await cleanup(fixture);
  }
});

test('checkpoint lock: exclusive across processes, one reclaimer of a dead owner, timeout leaves the checkpoint untouched', async () => {
  const fixture = await makeFixture({ unitCount: 2 });
  try {
    const counter = path.join(fixture.scratchDirectory, 'lock-counter.txt');
    await writeFile(counter, '0');
    const lockFile = `${fixture.checkpointPath}.lock`;
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(lockFile, JSON.stringify({ pid: dead, token: 'dead-owner', acquired_at: new Date().toISOString() }));
    const worker = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { withCheckpointLock } from ${JSON.stringify(path.resolve('scripts/relation/literary-context.mjs'))};
      const [checkpoint, counter] = process.argv.slice(1);
      for (let index = 0; index < 15; index += 1) {
        await withCheckpointLock(checkpoint, async () => {
          const value = Number(await readFile(counter, 'utf8'));
          await new Promise((resolve) => setTimeout(resolve, 2));
          await writeFile(counter, String(value + 1));
        });
      }`;
    const results = await Promise.all([1, 2, 3].map(() => runChild(worker, [fixture.checkpointPath, counter])));
    assert.deepEqual(results.map((item) => item.status), [0, 0, 0], results.map((item) => item.stderr).join());
    assert.equal(await readFile(counter, 'utf8'), '45', 'no update was lost');
    await assert.rejects(stat(lockFile), { code: 'ENOENT' });
    await assert.rejects(stat(`${lockFile}.reclaim`), { code: 'ENOENT' });

    // A live owner is never reclaimed; the waiter fails with a coded timeout and changes nothing.
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: 'live-owner', acquired_at: new Date().toISOString() }));
    const before = await readFile(fixture.checkpointPath, 'utf8');
    const timeout = await runChild(`
      import { withCheckpointLock } from ${JSON.stringify(path.resolve('scripts/relation/literary-context.mjs'))};
      try { await withCheckpointLock(process.argv[1], async () => {}, { timeoutMs: 150 }); } catch (error) { console.error(error.code); process.exit(7); }`,
    [fixture.checkpointPath]);
    assert.equal(timeout.status, 7);
    assert.match(timeout.stderr, /LITERARY_CHECKPOINT_LOCK_TIMEOUT/u);
    assert.match(await readFile(lockFile, 'utf8'), /live-owner/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    await unlink(lockFile);

    await withCheckpointLock(fixture.checkpointPath, async () => {
      await assert.rejects(withCheckpointLock(fixture.checkpointPath, async () => {}), { code: 'LITERARY_CHECKPOINT_LOCK_NESTED' });
    });
  } finally {
    await cleanup(fixture);
  }
});

test('init refuses to overwrite an existing checkpoint', async () => {
  const fixture = await makeFixture({ unitCount: 2 });
  try {
    const before = await readFile(fixture.checkpointPath, 'utf8');
    await assert.rejects(initializeLiteraryCheckpoint({
      canonicalPath: fixture.canonicalPath, shard: '001', batch: '01', model: 'codex', databasePath: fixture.databasePath,
      checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory,
    }), /already exists/u);
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
  } finally {
    await cleanup(fixture);
  }
});

test('chunk lists only the Senses it really recorded: forms changed during the lookup leave the Sense unread', async () => {
  const fixture = await makeFixture({ unitCount: 6, firstSenseGlosses: THREE_SENSES });
  try {
    const { operation, error } = await changeWhileOperationWaits(fixture,
      () => chunk(fixture, { contexts: 4 }),
      (checkpoint) => addFormInPlace(checkpoint, 'sense-000001-2', '가나다라'));
    assert.equal(error, null);
    const view = await operation;
    assert.deepEqual(view.items.map((item) => item.sense_id), ['sense-000001', 'sense-000001-3']);
    assert.equal(view.not_yet_read, 1);
    const senses = (await load(fixture)).records[0].senses;
    assert.equal(senses[1].shown, null, 'no shown evidence is recorded for the Sense that was not listed');
    assert.ok(senses[0].shown && senses[2].shown);
    assert.equal((await chunk(fixture, { contexts: 4 })).items.some((item) => item.sense_id === 'sense-000001-2'), true, 'it is selected again');
  } finally {
    await cleanup(fixture);
  }
});

test('an explicit re-read of a submitted Sense with 16 contexts allows a later submit of an added context key', async () => {
  const fixture = await makeFixture({ unitCount: 20 });
  try {
    const first = (await chunk(fixture, { contexts: 8 })).items[0];
    await submit(fixture, [{ sense_id: 'sense-000001', verified: [first.contexts[0].k], candidates: ['서리'] }]);
    const wide = (await chunk(fixture, { senseIds: 'sense-000001', contexts: 16 })).items[0];
    assert.equal(wide.contexts.length, 16);
    assert.equal((await load(fixture)).records[0].senses[0].shown.unit_rowids.length, 16);
    const saved = await submit(fixture, [{ sense_id: 'sense-000001', verified: [first.contexts[0].k, wide.contexts[15].k], candidates: ['서리'] }]);
    assert.equal(saved.verified_contexts, 2);
  } finally {
    await cleanup(fixture);
  }
});

test('submit is refused when its own Sense changed during validation, while other Senses may change freely', async () => {
  const fixture = await makeFixture({ unitCount: 6, firstSenseGlosses: THREE_SENSES });
  try {
    const items = (await chunk(fixture, { contexts: 4 })).items;
    const entries = [{ sense_id: 'sense-000001', verified: [items[0].contexts[0].k], candidates: ['서리'] }];
    const other = await changeWhileOperationWaits(fixture, () => submit(fixture, entries),
      (checkpoint) => addFormInPlace(checkpoint, 'sense-000001-3', '가나다라'));
    assert.equal(other.error, null);
    assert.equal((await load(fixture)).records[0].senses[0].submission.status, 'SUBMITTED');

    const own = await changeWhileOperationWaits(fixture,
      () => submit(fixture, [{ sense_id: 'sense-000001-2', verified: [items[1].contexts[0].k], candidates: ['눈'] }]),
      (checkpoint) => addFormInPlace(checkpoint, 'sense-000001-2', '가나다마'));
    assert.equal(own.error?.code, 'LITERARY_SUBMISSION_VALIDATION');
    assert.equal(own.error.reason, 'checkpoint_sense_changed');
    assert.equal(own.error.affected.sense_id, 'sense-000001-2');
    const senses = (await load(fixture)).records[0].senses;
    assert.equal(senses[1].submission, null, 'nothing was partially saved');
  } finally {
    await cleanup(fixture);
  }
});

test('chunk --exclude-sense-ids selects around reserved Senses and reports excluded_pending in both formats', async () => {
  const fixture = await makeFixture({ unitCount: 4, firstSenseGlosses: THREE_SENSES });
  try {
    const partial = await chunk(fixture, { excludeSenseIds: 'sense-000001' });
    assert.deepEqual(partial.items.map((item) => item.sense_id), ['sense-000001-2', 'sense-000001-3']);
    assert.equal(partial.excluded_pending, 1);
    const all = await chunk(fixture, { excludeSenseIds: 'sense-000001,sense-000001-2,sense-000001-3' });
    assert.deepEqual({ items: all.items.length, excluded: all.excluded_pending, unread: all.not_yet_read }, { items: 0, excluded: 3, unread: 0 });
    assert.match(renderChunkText(all), /^batch=001_01 done=\d+\/\d+ zero_hit=0 not_yet_read=0 excluded_pending=3\n/u);
    assert.doesNotMatch(renderChunkText({ ...all, excluded_pending: 0 }), /excluded_pending/u, 'serial headers keep their old shape');
    await assert.rejects(chunk(fixture, { senseIds: 'sense-000001', excludeSenseIds: 'sense-000001-2' }), /cannot be combined/u);
  } finally {
    await cleanup(fixture);
  }
});

test('--chunk keeps chunk/add-form/submit inside the active chunk record; omitting it keeps the old behavior', async () => {
  const fixture = await makeFixture({ unitCount: 6, firstSenseGlosses: THREE_SENSES });
  try {
    const rendered = await chunk(fixture, { contexts: 4 });
    const activeIds = ['sense-000001', 'sense-000001-2'];
    const initialCheckpoint = await load(fixture);
    for (const record of initialCheckpoint.records) {
      const outsideSense = record.senses.find((sense) => sense.sense_id === 'sense-000001-3');
      if (outsideSense) outsideSense.shown = null;
    }
    await writeFile(fixture.checkpointPath, JSON.stringify(initialCheckpoint));
    const viewText = renderChunkText({ ...rendered, items: rendered.items.filter((item) => activeIds.includes(item.sense_id)) });
    const viewBytes = Buffer.from(viewText);
    await writeFile(path.join(fixture.scratchDirectory, 'c-active-001.txt'), viewBytes);
    await writeFile(path.join(fixture.scratchDirectory, 'c-active-001.json'), JSON.stringify({
      chunk_id: '001-01-001', chunk_no: 1, sense_ids: activeIds, shard: '001', batch: '01', model: 'codex',
      git_head: 'a'.repeat(40), view_sha256: createHash('sha256').update(viewBytes).digest('hex'),
      view_bytes: viewBytes.byteLength,
    }));
    const activePath = path.join(fixture.scratchDirectory, 'c-active-001.json');
    const activeBefore = await readFile(activePath, 'utf8');
    const before = await readFile(fixture.checkpointPath, 'utf8');
    const diagnostic = (result) => JSON.parse(result.stderr);
    const outside = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001-3', '--chunk', '1']));
    assert.equal(outside.status, 1);
    assert.equal(diagnostic(outside).diagnostic, 'chunk_scope');
    const outsideForm = runCli(fixture, ['add-form', '--checkpoint', fixture.checkpointPath, '--sense-id', 'sense-000001-3',
      '--form', '가나다라', '--basis', 'test', '--chunk', '1']);
    assert.equal(diagnostic(outsideForm).diagnostic, 'chunk_scope');
    const outsideItem = rendered.items.find((item) => item.sense_id === 'sense-000001-3');
    const outsideSubmit = await submitCliWithChunk(fixture, [{ sense_id: 'sense-000001-3', verified: [outsideItem.contexts[0].k], candidates: ['눈'] }], 1);
    assert.equal(diagnostic(outsideSubmit).diagnostic, 'chunk_scope');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);
    for (const malformed of [[], [{ verified: [], candidates: [] }]]) {
      const shape = await submitCliWithChunk(fixture, malformed, 1);
      assert.equal(shape.status, 1);
      const shapeDiagnostic = diagnostic(shape);
      assert.equal(shapeDiagnostic.diagnostic, 'submit_validation');
      assert.equal(shapeDiagnostic.repair_scope, 'correct_submission_shape');
    }
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), before);

    const mixed = runCli(fixture, cliChunkArgs(fixture, [
      '--sense-ids', 'sense-000001,sense-000001-3,sense-000001-2', '--chunk', '1', '--format', 'text',
    ]));
    assert.equal(mixed.status, 0, mixed.stderr);
    assert.match(mixed.stdout, /^batch=001_01 /u);
    assert.deepEqual(diagnostic(mixed), {
      status: 'WARNING', warning: 'active_chunk_scope_ids_excluded', chunk_no: 1,
      applied_sense_ids: activeIds, excluded_sense_ids: ['sense-000001-3'],
    });
    assert.deepEqual([...mixed.stdout.matchAll(/^## ([^ ]+)/gmu)].map((match) => match[1]), activeIds);
    const afterMixed = await load(fixture);
    const afterMixedSenses = Object.fromEntries(afterMixed.records.flatMap((record) => record.senses.map((sense) => [sense.sense_id, sense])));
    assert.ok(afterMixedSenses[activeIds[0]].shown);
    assert.ok(afterMixedSenses[activeIds[1]].shown);
    assert.equal(afterMixedSenses['sense-000001-3'].shown, null);

    const mixedCheckpoint = await readFile(fixture.checkpointPath, 'utf8');
    const tooMany = runCli(fixture, cliChunkArgs(fixture, [
      '--sense-ids', 'sense-000001,sense-000001-2,sense-000001-3,sense-000001-4,sense-000001-5', '--chunk', '1',
    ]));
    assert.equal(tooMany.status, 1);
    assert.equal(diagnostic(tooMany).diagnostic, 'chunk_scope');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), mixedCheckpoint);

    await writeFile(activePath, JSON.stringify({ ...JSON.parse(activeBefore), sense_ids: ['sense-000001-3'] }));
    const forged = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001-3', '--chunk', '1']));
    assert.equal(forged.status, 1);
    assert.equal(diagnostic(forged).diagnostic, 'chunk_scope');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), mixedCheckpoint);
    await writeFile(activePath, activeBefore);

    const wrongChunk = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001', '--chunk', '2']));
    assert.equal(wrongChunk.status, 1);
    assert.equal(diagnostic(wrongChunk).diagnostic, 'chunk_scope');
    await writeFile(activePath, JSON.stringify({ ...JSON.parse(activeBefore), batch: '02' }));
    const wrongBatch = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001', '--chunk', '1']));
    assert.equal(wrongBatch.status, 1);
    assert.equal(diagnostic(wrongBatch).diagnostic, 'chunk_scope');
    await writeFile(activePath, activeBefore);
    const otherCheckpoint = path.join(fixture.scratchDirectory, 'other.checkpoint.json');
    await writeFile(otherCheckpoint, before);
    const wrongCheckpoint = runCli(fixture, ['chunk', '--db', fixture.databasePath, '--checkpoint', otherCheckpoint,
      '--sense-ids', 'sense-000001', '--chunk', '1']);
    assert.equal(wrongCheckpoint.status, 1);
    assert.equal(diagnostic(wrongCheckpoint).diagnostic, 'chunk_scope');
    assert.equal(await readFile(fixture.checkpointPath, 'utf8'), mixedCheckpoint);

    const inside = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001', '--chunk', '1']));
    assert.equal(inside.status, 0, inside.stderr);
    const insideSubmit = await submitCliWithChunk(fixture, [{ sense_id: 'sense-000001', verified: [rendered.items[0].contexts[0].k], candidates: ['서리'] }], 1);
    assert.equal(insideSubmit.status, 0, insideSubmit.stderr);
    const unscoped = runCli(fixture, cliChunkArgs(fixture, ['--sense-ids', 'sense-000001-2']));
    assert.equal(unscoped.status, 0, unscoped.stderr);
  } finally {
    await cleanup(fixture);
  }
});

async function submitCliWithChunk(fixture, senses, chunkNo) {
  const inputPath = path.join(fixture.scratchDirectory, 'submit-input.json');
  await writeFile(inputPath, JSON.stringify({ senses }));
  return spawnSync(process.execPath, [path.resolve('scripts/relation/literary-context-cli.mjs'), 'submit',
    '--db', fixture.databasePath, '--checkpoint', fixture.checkpointPath, '--input', inputPath, '--chunk', String(chunkNo)],
  { cwd: fixture.root, encoding: 'utf8' });
}

test('the order in which fixed Sense submissions are applied does not change the exported bytes', async () => {
  const outputs = [];
  for (const reverse of [false, true]) {
    const fixture = await makeFixture({ unitCount: 6, firstSenseGlosses: THREE_SENSES });
    try {
      const items = (await chunk(fixture, { contexts: 4 })).items;
      const entries = items.map((item, index) => ({ sense_id: item.sense_id, verified: [item.contexts[0].k], candidates: [['서리'], ['눈'], ['바람']][index] }));
      for (const entry of reverse ? [...entries].reverse() : entries) await submit(fixture, [entry]);
      await exportOutput(fixture);
      const checkpoint = await load(fixture);
      const business = checkpoint.records[0].senses.map(({ sense_id: id, submission }) => [id, { ...submission, submitted_at: undefined }]);
      outputs.push([await readFile(path.join(fixture.scratchDirectory, '001_01_c_codex.jsonl'), 'utf8'), JSON.stringify(business)]);
    } finally {
      await cleanup(fixture);
    }
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

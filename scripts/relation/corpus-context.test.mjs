import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_WRITTEN_CORPUS,
  exportCorpusCandidates,
  initializeCorpusCheckpoint,
  inspectWrittenCorpusIndex,
  loadCorpusCheckpoint,
  patchCorpusCandidateFile,
  readCorpusContexts,
  scanCorpusBatch,
  submitCorpusResults,
  CORPUS_RESPONSE_LIMIT,
} from './corpus-context.mjs';

async function makeFixture({ paragraphCount = 1, withBigram = true, approvedDigests = true, longMetadata = false, sourceProfileCount = 1, invalidDistributorAt = null, invalidCategoryAt = null } = {}) {
  const scratchRoot = path.join(process.cwd(), '.warroom-scratch');
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(scratchRoot, 'typewriter-d-corpus-'));
  const repositoryDirectory = path.join(root, 'repo');
  const scratchDirectory = path.join(repositoryDirectory, '.warroom-scratch');
  const canonicalDirectory = path.join(repositoryDirectory, 'data', 'canonical');
  await mkdir(scratchDirectory, { recursive: true });
  await mkdir(canonicalDirectory, { recursive: true });
  const canonicalRows = Array.from({ length: 500 }, (_, offset) => {
    const number = offset + 1;
    const lemma = number === 1 || number === 26 ? '사람' : number === 2 ? '빛' : number === 3 ? '두자' : number === 4 ? '연결어' : `표제어${number}`;
    return { id: `w${number}`, lemma, search_forms: [], senses: [{ id: `w${number}-s1`, pos: '명사', gloss: `${lemma}의 뜻` }] };
  });
  const canonicalPath = path.join(canonicalDirectory, 'stdict-0001.jsonl');
  await writeFile(canonicalPath, `${canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const databasePath = path.join(root, 'private', 'approved-written-corpus.sqlite');
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (
      source_path TEXT PRIMARY KEY, corpus_id TEXT, title TEXT, creator TEXT,
      distributor TEXT, year TEXT, category TEXT, annotation_level_json TEXT,
      sampling TEXT, source_sha256 TEXT, source_bytes INTEGER
    );
    CREATE TABLE documents (
      document_rowid INTEGER PRIMARY KEY, source_path TEXT NOT NULL, document_id TEXT,
      document_ordinal INTEGER NOT NULL, title TEXT, author TEXT, publisher TEXT,
      document_date TEXT
    );
    CREATE TABLE paragraphs (
      paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER NOT NULL,
      paragraph_id TEXT, ordinal INTEGER NOT NULL, form TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, tokenize='trigram', content='paragraphs', content_rowid='paragraph_rowid');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${withBigram ? 'CREATE TABLE paragraph_bigrams (gram TEXT NOT NULL, paragraph_rowid INTEGER NOT NULL); CREATE INDEX paragraph_bigrams_gram ON paragraph_bigrams(gram);' : ''}
  `);
  const sourcePath = path.join(root, 'personal', 'must-not-print.json');
  const insertSource = database.prepare('INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let index = 1; index <= sourceProfileCount; index += 1) {
    insertSource.run(
      index === 1 ? sourcePath : path.join(root, 'personal', `source-${index}.json`),
      'NIKL-WRITTEN-2025',
      `문서 제목 ${index}`,
      '국립국어원',
      index === invalidDistributorAt ? 'unapproved distributor' : '국립국어원 모두의 말뭉치',
      '2025',
      index === invalidCategoryAt ? '구어 > 일상 대화' : '문어 > 책-상상 > 문학',
      '[]',
      '본문 전체',
      'f'.repeat(64),
      1234,
    );
  }
  const paragraphs = paragraphCount === 20
    ? [...Array.from({ length: 20 }, (_, index) => `사람이 등장하는 문맥 ${index + 1}`), '두자 빛과 연결어를 보고 바람이 분다.']
    : ['사람은 두자 빛과 연결어를 보고 바람이 분다.'];
  const insertDocument = database.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertParagraph = database.prepare('INSERT INTO paragraphs VALUES (?, ?, ?, ?, ?)');
  const insertBigram = withBigram ? database.prepare('INSERT OR IGNORE INTO paragraph_bigrams VALUES (?, ?)') : null;
  for (const [index, form] of paragraphs.entries()) {
    const documentRowId = index + 1;
    const paragraphRowId = index + 1;
    insertDocument.run(documentRowId, sourcePath, `doc-${documentRowId}`, documentRowId, longMetadata ? '문서'.repeat(5000) : `문서 ${documentRowId}`, longMetadata ? '저자'.repeat(5000) : `저자 ${documentRowId}`, null, '20250101');
    insertParagraph.run(paragraphRowId, documentRowId, longMetadata ? '문맥ID'.repeat(1000) : `para-${paragraphRowId}`, 1, form);
    if (insertBigram) {
      const chars = [...form];
      for (let at = 0; at < chars.length - 1; at += 1) insertBigram.run(chars.slice(at, at + 2).join(''), paragraphRowId);
    }
  }
  database.exec("INSERT INTO paragraph_fts(paragraph_fts) VALUES ('rebuild')");
  const metadataDigest = approvedDigests ? APPROVED_WRITTEN_CORPUS : { ...APPROVED_WRITTEN_CORPUS, source_manifest_sha256: '0'.repeat(64) };
  const insertMetadata = database.prepare('INSERT INTO index_metadata VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    schema_version: 'fixture-schema-v1',
    sqlite_version: database.prepare('SELECT sqlite_version() AS version').get().version,
    input_manifest_sha256: metadataDigest.source_manifest_sha256,
    logical_row_digest: metadataDigest.logical_row_sha256,
    source_count: String(sourceProfileCount),
    document_count: String(paragraphs.length),
    paragraph_count: String(paragraphs.length),
  })) insertMetadata.run(key, value);
  database.close();

  return {
    root,
    repositoryDirectory,
    scratchDirectory,
    canonicalPath,
    canonicalRows,
    databasePath,
    checkpointPath: path.join(scratchDirectory, '001_01_d_codex.checkpoint.json'),
    sourcePath,
  };
}

async function initialize(fixture) {
  return initializeCorpusCheckpoint({
    canonicalPath: fixture.canonicalPath,
    shard: '001',
    batch: '01',
    model: 'codex',
    databasePath: fixture.databasePath,
    checkpointPath: fixture.checkpointPath,
    repositoryDirectory: fixture.repositoryDirectory,
    scratchDirectory: fixture.scratchDirectory,
  });
}

async function cleanup(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}
const CLI = fileURLToPath(new URL('./corpus-context-cli.mjs', import.meta.url));
const SENSES = ['w1-s1', 'w2-s1', 'w3-s1', 'w4-s1', 'w26-s1'];

function scanOptions(fixture) {
  return { databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory };
}

async function scanAndRead(fixture, extra = {}) {
  await initialize(fixture);
  await scanCorpusBatch(scanOptions(fixture));
  return readCorpusContexts({ ...scanOptions(fixture), ...extra });
}

const discovered = (senseId, ids, candidates = []) => ({ sense_id: senseId, status: 'discovered', verified: ids, candidates });

test('preflight accepts the existing schema_version-only index without hashing the database', async () => {
  const fixture = await makeFixture();
  try {
    const routine = await inspectWrittenCorpusIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(routine.status, 'READY');
    assert.equal(routine.index.index_version, null);
    assert.equal(routine.database.sha256, null);
    assert.equal(routine.search.read_only, true);
    assert.equal(JSON.stringify(routine).includes(fixture.databasePath), false);
    const explicit = await inspectWrittenCorpusIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory, verifyBinary: true });
    assert.match(explicit.database.sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await cleanup(fixture);
  }
});

test('preflight fails closed for the wrong snapshot and reports the literal short-form fallback', async () => {
  const wrong = await makeFixture({ approvedDigests: false });
  try {
    await assert.rejects(inspectWrittenCorpusIndex(wrong.databasePath, { scratchDirectory: wrong.scratchDirectory }), /approved NIKL Written Corpus/u);
  } finally {
    await cleanup(wrong);
  }
  const fallback = await makeFixture({ withBigram: false });
  try {
    assert.equal((await inspectWrittenCorpusIndex(fallback.databasePath, { scratchDirectory: fallback.scratchDirectory })).search.bigram_index, false);
  } finally {
    await cleanup(fallback);
  }
});

test('preflight accepts every valid source profile and checks invalid metadata after profile 64', async () => {
  const valid = await makeFixture({ sourceProfileCount: 65 });
  try {
    const inspected = await inspectWrittenCorpusIndex(valid.databasePath, { scratchDirectory: valid.scratchDirectory });
    assert.equal(inspected.status, 'READY');
    assert.equal(inspected.source.profile_count, 65);
  } finally {
    await cleanup(valid);
  }

  for (const invalid of [
    { invalidDistributorAt: 66 },
    { invalidCategoryAt: 66 },
  ]) {
    const fixture = await makeFixture({ sourceProfileCount: 66, ...invalid });
    try {
      await assert.rejects(
        inspectWrittenCorpusIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory }),
        /corpus source metadata does not identify only NIKL written-corpus material/u,
      );
    } finally {
      await cleanup(fixture);
    }
  }
});

test('chunk scan, one read, one submit and a single Candidate v1 export complete a batch', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    const scan = await scanCorpusBatch(scanOptions(fixture));
    assert.equal(scan.status, 'SEARCHED');
    assert.equal(scan.query_calls, 20);
    assert.equal(scan.cache_hits, 1);
    assert.equal(scan.checkpoint.statuses.SEARCHED, 5);
    assert.equal(scan.checkpoint.statuses.ZERO_HITS, 495);

    const read = await readCorpusContexts(scanOptions(fixture));
    assert.equal(read.returned, 5);
    assert.equal(read.remaining_searched, 0);
    assert.deepEqual(read.senses.map((item) => item.sense_id), SENSES);
    assert.ok(JSON.stringify(read).length < CORPUS_RESPONSE_LIMIT);
    assert.match(read.senses[0].gloss, /의 뜻/u);
    const ids = Object.fromEntries(read.senses.map((item) => [item.sense_id, item.contexts.map((context) => context.id)]));

    const submitted = await submitCorpusResults(fixture.checkpointPath, SENSES.map((id) => discovered(id, ids[id], id === 'w4-s1' ? ['바람'] : [])), { scratchDirectory: fixture.scratchDirectory });
    assert.deepEqual({ status: submitted.status, recorded: submitted.recorded, remaining: submitted.remaining_searched }, { status: 'RECORDED', recorded: 5, remaining: 0 });

    const candidatePath = path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl');
    const exported = await exportCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath: candidatePath, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.deepEqual(exported.coverage, { records: 500, senses: 500, candidates: 1, empty_senses: 499 });
    const rows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows[3].senses[0].candidates, ['바람']);

    const patched = await patchCorpusCandidateFile({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidatePath, recordId: 'w4', senseId: 'w4-s1', action: 'remove', candidate: '바람', reason: 'remove one tuple', repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(patched.status, 'VALID');
    assert.deepEqual(JSON.parse((await readFile(candidatePath, 'utf8')).split('\n')[3]).senses[0].candidates, []);
  } finally {
    await cleanup(fixture);
  }
});

test('unread, unverified, or inconsistent senses are rejected without becoming empty candidates', async () => {
  const fixture = await makeFixture({ paragraphCount: 20 });
  try {
    const read = await scanAndRead(fixture);
    const w26 = read.senses.find((item) => item.sense_id === 'w26-s1');
    assert.equal(w26.contexts.length, 4);
    assert.equal(w26.more, true);
    const more = await readCorpusContexts({ ...scanOptions(fixture), senseId: 'w26-s1', offset: 4 });
    assert.equal(more.senses[0].contexts.length, 4);
    assert.notEqual(more.senses[0].contexts[0].id, w26.contexts[0].id);

    const submit = (entries) => submitCorpusResults(fixture.checkpointPath, entries, { scratchDirectory: fixture.scratchDirectory });
    const foreign = more.senses[0].contexts[0].id;
    for (const [entry, pattern] of [
      [{ sense_id: 'w1-s1', status: 'discovered', verified: [] }, /at least one verified/u],
      [{ sense_id: 'w1-s1', status: 'incomplete', candidates: ['바람'] }, /candidates require/u],
      [{ sense_id: 'w1-s1', status: 'no_verified', verified: [1], rejected: [] }, /no_verified requires/u],
      [{ sense_id: 'w1-s1', status: 'discovered', verified: [999999] }, /context ids returned/u],
      [{ sense_id: 'w1-s1', status: 'discovered', verified: [foreign, foreign] }, /distinct context ids/u],
      [{ sense_id: 'w5-s1', status: 'discovered', verified: [1] }, /no successful search/u],
      [{ sense_id: 'w1-s1', status: 'discovered', verified: [1], extra: true }, /unsupported field/u],
      ...['바람', null, 7, { 0: '바람' }].map((candidates) => [{ sense_id: 'w1-s1', status: 'discovered', verified: [1], candidates }, /array of strings/u]),
      ...['1', null, 1, { 0: 1 }].map((verified) => [{ sense_id: 'w1-s1', status: 'discovered', verified }, /context ids returned/u]),
      ...['rejected', 'ambiguous'].map((key) => [{ sense_id: 'w1-s1', status: 'incomplete', [key]: '1' }, /context ids returned/u]),
      [{ sense_id: 'w1-s1', status: 'discovered', verified: [1], candidates: ['바람', 3] }, /non-empty trimmed strings/u],
    ]) {
      const result = await submit([entry]);
      assert.equal(result.status, 'REJECTED');
      assert.match(result.errors[0], pattern);
    }
    const mixed = await submit([discovered('w2-s1', [w26.contexts[0].id]), { sense_id: 'w3-s1', status: 'discovered', verified: [] }]);
    assert.equal(mixed.status, 'REJECTED');
    assert.equal((await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint.records[1].senses[0].status, 'SEARCHED');

    assert.equal((await submit([{ sense_id: 'w2-s1', status: 'no_verified', rejected: [read.senses.find((item) => item.sense_id === 'w2-s1').contexts[0].id] }])).status, 'RECORDED');
    await assert.rejects(exportCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath: path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl'), repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory }), /is SEARCHED/u);
  } finally {
    await cleanup(fixture);
  }
});

test('search failures stay explicit and a rescan retries them while preserving submitted senses', async () => {
  const fixture = await makeFixture();
  let writer;
  try {
    await initialize(fixture);
    writer = new DatabaseSync(fixture.databasePath);
    writer.exec('BEGIN EXCLUSIVE');
    const failed = await scanCorpusBatch(scanOptions(fixture));
    assert.equal(failed.status, 'INCOMPLETE');
    assert.ok(failed.failed_queries > 0);
    writer.exec('ROLLBACK');
    writer.close();
    writer = null;
    let { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].status, 'SEARCH_FAILED');
    await assert.rejects(readCorpusContexts({ ...scanOptions(fixture), senseId: 'w1-s1' }), /no countable search result/u);
    assert.equal((await scanCorpusBatch(scanOptions(fixture))).status, 'SEARCHED');
    const read = await readCorpusContexts(scanOptions(fixture));
    await submitCorpusResults(fixture.checkpointPath, [discovered('w1-s1', [read.senses[0].contexts[0].id])], { scratchDirectory: fixture.scratchDirectory });
    assert.equal((await scanCorpusBatch(scanOptions(fixture))).query_calls, 0);
    ({ checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.records[0].senses[0].status, 'DISCOVERED');
    assert.equal(checkpoint.records[1].senses[0].status, 'SEARCHED');
  } finally {
    try { writer?.exec('ROLLBACK'); } catch {}
    writer?.close();
    await cleanup(fixture);
  }
});

test('an earlier-format checkpoint resumes: procedure edits do not block it and its KEEP decisions export', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    const legacy = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
    legacy.batch.procedure_sha256 = 'f'.repeat(64);
    legacy.index.database_sha256 = 'a'.repeat(64);
    const sense = legacy.records[3].senses[0];
    delete sense.verified; delete sense.rejected; delete sense.ambiguous; delete sense.candidates;
    sense.status = 'DISCOVERED';
    sense.contexts = [{ locator_key: 'k', judgment: 'VERIFIED', paragraph_text: '사람', explorations: {} }];
    sense.candidate_reviews = [{ candidate: '바람', normalized: '바람', decision: 'KEEP', kind: 'word' }, { candidate: '구름', normalized: '구름', decision: 'REMOVE' }];
    for (const other of legacy.records.flatMap((record) => record.senses)) if (other !== sense) other.status = 'ZERO_HITS';
    await writeFile(fixture.checkpointPath, JSON.stringify(legacy));
    const exported = await exportCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath: path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl'), repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(exported.coverage.candidates, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('the CLI reads and submits a chunk of senses with no per-context commands', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    await scanCorpusBatch(scanOptions(fixture));
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: fixture.repositoryDirectory, encoding: 'utf8' }));
    const checkpoint = '.warroom-scratch/001_01_d_codex.checkpoint.json';
    const read = run('read', '--db', fixture.databasePath, '--checkpoint', checkpoint);
    assert.equal(read.returned, 5);
    await writeFile(path.join(fixture.scratchDirectory, 'results.json'), JSON.stringify(read.senses.map((item) => discovered(item.sense_id, [item.contexts[0].id]))));
    assert.equal(run('submit', '--checkpoint', checkpoint, '--results', '.warroom-scratch/results.json').recorded, 5);
    assert.equal(run('report', '--checkpoint', checkpoint).checkpoint.statuses.DISCOVERED, 5);
    for (const retired of ['review-context', 'explore', 'review-candidate', 'finish-search']) {
      assert.throws(() => execFileSync(process.execPath, [CLI, retired], { cwd: fixture.repositoryDirectory, stdio: 'pipe' }), /unknown command/u);
    }
  } finally {
    await cleanup(fixture);
  }
});

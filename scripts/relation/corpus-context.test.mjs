import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  addCorpusSearchForm,
  APPROVED_WRITTEN_CORPUS,
  exportCorpusCandidates,
  finishCorpusSearch,
  initializeCorpusCheckpoint,
  inspectWrittenCorpusIndex,
  loadCorpusCheckpoint,
  patchCorpusCandidateFile,
  recordCorpusExploration,
  reviewCorpusCandidate,
  reviewCorpusContext,
  scanCorpusBatch,
  searchCorpusSense,
  validateCorpusExport,
  validateExistingCorpusCandidates,
  CORPUS_RESPONSE_LIMIT,
  CORPUS_SWEEP_LENSES,
} from './corpus-context.mjs';

async function makeFixture({ paragraphCount = 1, withBigram = true, approvedDigests = true, longMetadata = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-d-corpus-'));
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
  insertSource.run(sourcePath, 'NIKL-WRITTEN-2025', '국립국어원 문어 말뭉치 2025 (1.0)', '국립국어원', '국립국어원 모두의 말뭉치', '2025', '문어 > 책-상상 > 문학', '[]', '본문 전체', 'f'.repeat(64), 1234);
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
    builder_version: 'fixture-builder-v1',
    index_version: 'written-corpus-2025-1.0',
    sqlite_version: database.prepare('SELECT sqlite_version() AS version').get().version,
    input_manifest_sha256: metadataDigest.source_manifest_sha256,
    logical_row_digest: metadataDigest.logical_row_sha256,
    source_count: '1',
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

const emptyFiveLenses = () => Object.fromEntries(CORPUS_SWEEP_LENSES.map((lens) => [lens, []]));
const CORPUS_CLI_PATH = fileURLToPath(new URL('./corpus-context-cli.mjs', import.meta.url));

function runExploreCli(fixture, { senseId, locatorKey, pass = 1, inputName, independentRead = false, note }) {
  const args = [
    CORPUS_CLI_PATH,
    'explore',
    '--checkpoint', '.warroom-scratch/001_01_d_codex.checkpoint.json',
    '--sense-id', senseId,
    '--locator-key', locatorKey,
    '--pass', String(pass),
    '--results', `.warroom-scratch/${inputName}`,
  ];
  if (independentRead) args.push('--independent-read');
  if (note) args.push('--note', note);
  return JSON.parse(execFileSync(process.execPath, args, { cwd: fixture.repositoryDirectory, encoding: 'utf8' }));
}

test('preflight binds the approved NIKL index, validates read-only schema, and never prints local paths', async () => {
  const fixture = await makeFixture();
  try {
    const first = await inspectWrittenCorpusIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    const second = await inspectWrittenCorpusIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.status, 'READY');
    assert.equal(first.source.name, 'NIKL Written Corpus 2025 (1.0)');
    assert.equal(first.search.bigram_index, true);
    assert.equal(first.search.read_only, true);
    assert.match(first.database.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(first.database.sha256_cached, false);
    assert.equal(second.database.sha256_cached, true);
    assert.equal(JSON.stringify(first).includes(fixture.databasePath), false);
    assert.equal(JSON.stringify(first).includes(fixture.sourcePath), false);
  } finally {
    await cleanup(fixture);
  }
});

test('preflight fails closed for the wrong snapshot and reports the bounded literal short-form fallback', async () => {
  const wrong = await makeFixture({ approvedDigests: false });
  try {
    await assert.rejects(inspectWrittenCorpusIndex(wrong.databasePath, { scratchDirectory: wrong.scratchDirectory }), /approved NIKL Written Corpus/u);
  } finally {
    await cleanup(wrong);
  }
  const fallback = await makeFixture({ withBigram: false });
  try {
    const result = await inspectWrittenCorpusIndex(fallback.databasePath, { scratchDirectory: fallback.scratchDirectory });
    assert.equal(result.search.bigram_index, false);
    assert.match(result.search.two_character_forms, /literal instr\(\) fallback/u);
  } finally {
    await cleanup(fallback);
  }
});

test('one read-only batch query per 25 records reuses duplicate form-set counts without sharing sense decisions', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    const scan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.status, 'SEARCHED');
    assert.equal(scan.query_calls, 20);
    assert.ok(scan.cache_hits >= 1);
    assert.equal(scan.checkpoint.records, 500);
    const { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].search.status, 'COUNTED');
    assert.equal(checkpoint.records[1].senses[0].search.total_hits, 1, 'one-character fallback finds a literal match');
    assert.equal(checkpoint.records[2].senses[0].search.total_hits, 1, 'short-bigram index finds a literal match');
    assert.equal(checkpoint.records[3].senses[0].search.total_hits, 1, 'trigram FTS finds a literal match');
    assert.equal(checkpoint.records[25].senses[0].search.total_hits, 1, 'duplicate spelling reuses its raw count');
    assert.equal(checkpoint.records[25].senses[0].contexts.length, 0, 'a cached query does not share context or source-sense judgment');
    assert.equal(checkpoint.records[4].senses[0].status, 'ZERO_HITS');
    assert.equal(checkpoint.records[4].senses[0].search.status, 'ZERO_HITS');
  } finally {
    await cleanup(fixture);
  }
});

test('paged contexts are bounded, resumable, exact-sense scoped, and do not imply verification', async () => {
  const fixture = await makeFixture({ paragraphCount: 20 });
  try {
    await initialize(fixture);
    await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const first = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.total_hits, 20);
    assert.equal(first.returned, 4);
    assert.equal(first.truncated, true);
    assert.equal(first.results[0].judgment, undefined);
    assert.ok([...first.results[0].excerpt].length <= 700);
    assert.equal(JSON.stringify(first).includes(fixture.sourcePath), false);
    assert.ok(first.next_cursor);
    await assert.rejects(searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w26-s1', pageSize: 4, cursor: first.next_cursor, scratchDirectory: fixture.scratchDirectory }), /cursor/u);
    const second = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, cursor: first.next_cursor, scratchDirectory: fixture.scratchDirectory });
    assert.equal(second.returned, 4);
    assert.notEqual(second.results[0].locator_key, first.results[0].locator_key);
    const { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].contexts[0].judgment, 'PENDING');
    assert.equal(checkpoint.records[25].senses[0].contexts.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

test('long source metadata is explicitly bounded without dropping contexts from a saved page', async () => {
  const fixture = await makeFixture({ paragraphCount: 20, longMetadata: true });
  try {
    await initialize(fixture);
    await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const page = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(page.returned, 4);
    assert.equal(page.results.length, 4);
    assert.ok(JSON.stringify(page).length < CORPUS_RESPONSE_LIMIT);
    assert.equal(page.results[0].metadata_truncated.document_title, true);
    assert.equal(page.results[0].metadata_truncated.document_author, true);
    assert.equal(page.results[0].metadata_truncated.paragraph_id, true);
    assert.ok(page.next_cursor);
    const { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].contexts.length, 4);
  } finally {
    await cleanup(fixture);
  }
});

test('a failed later context page resumes from its checkpoint after the corpus lock clears', async () => {
  const fixture = await makeFixture({ paragraphCount: 20 });
  let lock;
  try {
    await initialize(fixture);
    const initialScan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(initialScan.status, 'SEARCHED');
    const first = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.returned, 4);

    lock = new DatabaseSync(fixture.databasePath);
    lock.exec('BEGIN EXCLUSIVE');
    await assert.rejects(searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, cursor: first.next_cursor, scratchDirectory: fixture.scratchDirectory }), /locked|busy/iu);
    lock.exec('ROLLBACK');
    lock.close();
    lock = null;

    let { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].search.status, 'SEARCH_FAILED');
    assert.equal(checkpoint.records[0].senses[0].contexts.length, 4);
    assert.equal(checkpoint.records[0].senses[0].search.next_cursor, first.next_cursor);

    const retryScan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(retryScan.status, 'SEARCHED');
    assert.equal(retryScan.query_calls, 0, 'recovery reuses the successful batch count cache');
    const resumed = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(resumed.returned, 4);
    assert.equal(resumed.inspected_contexts, 8);
    assert.ok(resumed.results.every((result) => !first.results.some((prior) => prior.locator_key === result.locator_key)));
    assert.ok(resumed.next_cursor);

    ({ checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.records[0].senses[0].contexts.length, 8);
    assert.equal(checkpoint.records[0].senses[0].search.status, 'COUNTED');
  } finally {
    if (lock) {
      try { lock.exec('ROLLBACK'); } catch {}
      lock.close();
    }
    await cleanup(fixture);
  }
});

test('checkpoint scan retry preserves completed senses and keeps the full Candidate output eligible', async () => {
  const fixture = await makeFixture({ paragraphCount: 20 });
  let lock;
  try {
    await initialize(fixture);
    const firstScan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(firstScan.status, 'SEARCHED');

    const discoveredPage = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 1, scratchDirectory: fixture.scratchDirectory });
    await reviewCorpusContext(fixture.checkpointPath, { senseId: 'w1-s1', locatorKey: discoveredPage.results[0].locator_key, judgment: 'VERIFIED', note: '문맥의 쓰임이 출발 sense와 일치함' }, { scratchDirectory: fixture.scratchDirectory });
    const exploration = emptyFiveLenses();
    exploration.lexical.push('문맥연상');
    await recordCorpusExploration(fixture.checkpointPath, { senseId: 'w1-s1', locatorKey: discoveredPage.results[0].locator_key, pass: 1, results: exploration }, { scratchDirectory: fixture.scratchDirectory });
    await reviewCorpusCandidate(fixture.checkpointPath, { senseId: 'w1-s1', candidate: '문맥연상', decision: 'KEEP', note: '독립된 표현 단어로 Stage 1 형식에 맞음' }, { scratchDirectory: fixture.scratchDirectory });
    await finishCorpusSearch(fixture.checkpointPath, { senseId: 'w1-s1', note: '첫 VERIFIED 문맥의 통합 PASS B 검토를 마침' }, { scratchDirectory: fixture.scratchDirectory });

    const rejectedPage = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w2-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(rejectedPage.total_hits, 1);
    await reviewCorpusContext(fixture.checkpointPath, { senseId: 'w2-s1', locatorKey: rejectedPage.results[0].locator_key, judgment: 'REJECTED', mismatchConfirmed: true, note: '이 문맥은 정확한 source sense와 불일치함' }, { scratchDirectory: fixture.scratchDirectory });
    await finishCorpusSearch(fixture.checkpointPath, { senseId: 'w2-s1', note: '유일한 hit를 정확히 판독함' }, { scratchDirectory: fixture.scratchDirectory });

    const interruptedPage = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w26-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(interruptedPage.returned, 4);
    lock = new DatabaseSync(fixture.databasePath);
    lock.exec('BEGIN EXCLUSIVE');
    await assert.rejects(searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w26-s1', pageSize: 4, cursor: interruptedPage.next_cursor, scratchDirectory: fixture.scratchDirectory }), /locked|busy/iu);
    lock.exec('ROLLBACK');
    lock.close();
    lock = null;

    const retryScan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(retryScan.status, 'SEARCHED');
    assert.equal(retryScan.query_calls, 0);
    let { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].status, 'DISCOVERED');
    assert.equal(checkpoint.records[0].senses[0].sample_complete, true);
    assert.deepEqual(checkpoint.records[0].senses[0].candidate_reviews.map((item) => item.decision), ['KEEP']);
    assert.equal(checkpoint.records[1].senses[0].status, 'NO_VERIFIED');
    assert.equal(checkpoint.records[1].senses[0].contexts[0].mismatch_confirmed, true);

    const resumedPage = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w26-s1', pageSize: 4, scratchDirectory: fixture.scratchDirectory });
    assert.equal(resumedPage.returned, 4);
    assert.equal(resumedPage.inspected_contexts, 8);
    assert.ok(resumedPage.results.every((result) => !interruptedPage.results.some((prior) => prior.locator_key === result.locator_key)));
    for (const context of [...interruptedPage.results, ...resumedPage.results]) {
      await reviewCorpusContext(fixture.checkpointPath, { senseId: 'w26-s1', locatorKey: context.locator_key, judgment: 'REJECTED', mismatchConfirmed: true, note: '합성 fixture의 이 문맥은 source sense와 불일치함' }, { scratchDirectory: fixture.scratchDirectory });
    }
    await finishCorpusSearch(fixture.checkpointPath, { senseId: 'w26-s1', note: '8개 문맥을 판독한 뒤 적응적 표본을 종료함' }, { scratchDirectory: fixture.scratchDirectory });

    for (const senseId of ['w3-s1', 'w4-s1']) {
      const page = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId, pageSize: 4, scratchDirectory: fixture.scratchDirectory });
      assert.equal(page.total_hits, 1);
      await reviewCorpusContext(fixture.checkpointPath, { senseId, locatorKey: page.results[0].locator_key, judgment: 'REJECTED', mismatchConfirmed: true, note: '이 문맥은 정확한 source sense와 불일치함' }, { scratchDirectory: fixture.scratchDirectory });
      await finishCorpusSearch(fixture.checkpointPath, { senseId, note: '유일한 hit를 정확히 판독함' }, { scratchDirectory: fixture.scratchDirectory });
    }

    const candidatePath = path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl');
    const exported = await exportCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath: candidatePath, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(exported.status, 'OUTPUT');
    const validation = await validateExistingCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidatePath, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(validation.status, 'VALID');
    const outputRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(outputRows[0].senses[0].candidates, ['문맥연상']);
  } finally {
    if (lock) {
      try { lock.exec('ROLLBACK'); } catch {}
      lock.close();
    }
    await cleanup(fixture);
  }
});

test('zero hits, ambiguity, exact mismatch, and incomplete samples remain distinct', async () => {
  const fixture = await makeFixture({ paragraphCount: 20 });
  try {
    await initialize(fixture);
    await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const ambiguous = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w1-s1', pageSize: 1, scratchDirectory: fixture.scratchDirectory });
    await reviewCorpusContext(fixture.checkpointPath, { senseId: 'w1-s1', locatorKey: ambiguous.results[0].locator_key, judgment: 'AMBIGUOUS', note: '문맥 의미를 단정하기 어려움' }, { scratchDirectory: fixture.scratchDirectory });
    await finishCorpusSearch(fixture.checkpointPath, { senseId: 'w1-s1', note: '추가 검색보다 source 의미 검토가 필요함' }, { scratchDirectory: fixture.scratchDirectory });
    let { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].status, 'INCOMPLETE');

    const mismatch = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'w2-s1', pageSize: 1, scratchDirectory: fixture.scratchDirectory });
    await assert.rejects(reviewCorpusContext(fixture.checkpointPath, { senseId: 'w2-s1', locatorKey: mismatch.results[0].locator_key, judgment: 'REJECTED', note: '의미 불일치' }, { scratchDirectory: fixture.scratchDirectory }), /mismatch/u);
    await reviewCorpusContext(fixture.checkpointPath, { senseId: 'w2-s1', locatorKey: mismatch.results[0].locator_key, judgment: 'REJECTED', mismatchConfirmed: true, note: '이 문맥은 다른 sense의 용례임' }, { scratchDirectory: fixture.scratchDirectory });
    await finishCorpusSearch(fixture.checkpointPath, { senseId: 'w2-s1', note: '유일한 hit를 정확히 판독함' }, { scratchDirectory: fixture.scratchDirectory });
    ({ checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }));
    assert.equal(checkpoint.records[1].senses[0].status, 'NO_VERIFIED');
    assert.equal(checkpoint.records[1].senses[0].search.status, 'COUNTED');
    assert.equal(checkpoint.records[2].senses[0].status, 'SEARCHED', 'a remaining positive search is not a zero result');
    assert.equal(checkpoint.records[4].senses[0].status, 'ZERO_HITS');
  } finally {
    await cleanup(fixture);
  }
});

test('five-lens exploration, independent candidate review, full Candidate v1 export, and local tuple patch', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    const legacyCheckpoint = JSON.parse(await readFile(fixture.checkpointPath, 'utf8'));
    legacyCheckpoint.batch.procedure_sha256 = '51073e8b8bd1a642accc1c5ea0f6edf68589b4ad116e237c1edf3fbdb97f2928';
    await writeFile(fixture.checkpointPath, JSON.stringify(legacyCheckpoint));
    assert.equal((await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint.batch.procedure_sha256, legacyCheckpoint.batch.procedure_sha256);
    const staleCheckpoint = { ...legacyCheckpoint, batch: { ...legacyCheckpoint.batch, procedure_sha256: 'f'.repeat(64) } };
    await writeFile(fixture.checkpointPath, JSON.stringify(staleCheckpoint));
    await assert.rejects(loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory }), /procedure files changed/u);
    await writeFile(fixture.checkpointPath, JSON.stringify(legacyCheckpoint));
    await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const activeSenseIds = ['w1-s1', 'w2-s1', 'w3-s1', 'w4-s1', 'w26-s1'];
    for (const senseId of activeSenseIds) {
      const page = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId, scratchDirectory: fixture.scratchDirectory });
      const locatorKey = page.results[0].locator_key;
      await reviewCorpusContext(fixture.checkpointPath, { senseId, locatorKey, judgment: 'VERIFIED', note: '합성 fixture에서 정확한 source sense 확인' }, { scratchDirectory: fixture.scratchDirectory });
      const lenses = emptyFiveLenses();
      if (senseId === 'w4-s1') lenses.scene_time_environment = ['바람'];
      await recordCorpusExploration(fixture.checkpointPath, { senseId, locatorKey, pass: 1, results: lenses }, { scratchDirectory: fixture.scratchDirectory });
      if (senseId === 'w4-s1') await reviewCorpusCandidate(fixture.checkpointPath, { senseId, candidate: '바람', decision: 'KEEP', kind: 'word', note: '독립 어휘이며 VERIFIED 문맥에 결속됨' }, { scratchDirectory: fixture.scratchDirectory });
    }
    const validationRows = (await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint.records.map((record) => ({
      record_id: record.record_id,
      senses: record.senses.map((sense) => ({ sense_id: sense.sense_id, candidates: sense.sense_id === 'w4-s1' ? ['바람'] : [] })),
    }));
    const valid = await validateCorpusExport({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidateRows: validationRows, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(valid.status, 'VALID');
    assert.equal(valid.recordCount, 500);
    assert.equal(valid.candidateCount, 1);

    const checkpointFile = await readFile(fixture.checkpointPath, 'utf8');
    const damaged = JSON.parse(checkpointFile);
    damaged.records[3].senses[0].discoveries[0].locator_key = 'foreign-sense-locator';
    await writeFile(fixture.checkpointPath, JSON.stringify(damaged));
    const wrongLocator = await validateCorpusExport({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidateRows: validationRows, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(wrongLocator.status, 'INVALID');
    assert.match(wrongLocator.message, /locator that does not bind/u);
    await writeFile(fixture.checkpointPath, checkpointFile);

    const candidatePath = path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl');
    const exported = await exportCorpusCandidates({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, outputPath: candidatePath, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(exported.status, 'OUTPUT');
    assert.equal(exported.coverage.candidates, 1);
    const outputRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(outputRows[3].senses[0].candidates, ['바람']);
    assert.deepEqual(outputRows[0].senses[0].candidates, []);

    await reviewCorpusCandidate(fixture.checkpointPath, { senseId: 'w4-s1', candidate: '바람', decision: 'REMOVE', note: '후보 표현 검사에서 출력 제외' }, { scratchDirectory: fixture.scratchDirectory });
    const patched = await patchCorpusCandidateFile({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidatePath, recordId: 'w4', senseId: 'w4-s1', action: 'remove', candidate: '바람', reason: 'remove only the reviewed Candidate tuple', repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(patched.status, 'VALID');
    const afterRows = (await readFile(candidatePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(afterRows[3].senses[0].candidates, []);
    assert.deepEqual(afterRows.slice(4), outputRows.slice(4));
  } finally {
    await cleanup(fixture);
  }
});

test('integrated PASS B CLI records empty, multiple and tagged discoveries, and export requires each explicit PASS 1', async () => {
  const fixture = await makeFixture();
  try {
    await initialize(fixture);
    await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });

    const locators = new Map();
    for (const senseId of ['w1-s1', 'w2-s1', 'w3-s1', 'w4-s1', 'w26-s1']) {
      const page = await searchCorpusSense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId, scratchDirectory: fixture.scratchDirectory });
      assert.ok(page.results.length > 0, `${senseId} fixture has a matching context`);
      const locatorKey = page.results[0].locator_key;
      locators.set(senseId, locatorKey);
      await reviewCorpusContext(fixture.checkpointPath, { senseId, locatorKey, judgment: 'VERIFIED', note: '합성 fixture에서 정확한 source sense 확인' }, { scratchDirectory: fixture.scratchDirectory });
    }

    await writeFile(path.join(fixture.scratchDirectory, 'empty-pass-b.json'), '[]\n');
    const zero = runExploreCli(fixture, { senseId: 'w1-s1', locatorKey: locators.get('w1-s1'), inputName: 'empty-pass-b.json' });
    assert.equal(zero.candidates_recorded, 0);
    const duplicateLemmaZero = runExploreCli(fixture, { senseId: 'w26-s1', locatorKey: locators.get('w26-s1'), inputName: 'empty-pass-b.json' });
    assert.equal(duplicateLemmaZero.candidates_recorded, 0);

    await writeFile(path.join(fixture.scratchDirectory, 'tagged-pass-b.json'), JSON.stringify([
      { candidate: '잔향', lenses: ['scene_time_environment', 'contrast_sensation_metaphor'] },
    ]));
    const tagged = runExploreCli(fixture, { senseId: 'w2-s1', locatorKey: locators.get('w2-s1'), inputName: 'tagged-pass-b.json' });
    assert.equal(tagged.candidates_recorded, 1);

    await writeFile(path.join(fixture.scratchDirectory, 'multiple-pass-b.json'), JSON.stringify([
      '바람',
      { candidate: '바람', lenses: ['action_role_tool'] },
      { candidate: '흐름', lenses: ['contrast_sensation_metaphor'] },
    ]));
    const multiple = runExploreCli(fixture, { senseId: 'w4-s1', locatorKey: locators.get('w4-s1'), inputName: 'multiple-pass-b.json' });
    assert.equal(multiple.candidates_recorded, 2, 'normalized duplicates are stored once');

    for (const [senseId, candidates] of [['w2-s1', ['잔향']], ['w4-s1', ['바람', '흐름']]]) {
      for (const candidate of candidates) {
        await reviewCorpusCandidate(fixture.checkpointPath, { senseId, candidate, decision: 'KEEP', note: '합성 fixture의 독립 후보 형식 확인' }, { scratchDirectory: fixture.scratchDirectory });
      }
    }
    for (const senseId of ['w1-s1', 'w2-s1', 'w3-s1', 'w4-s1', 'w26-s1']) {
      await finishCorpusSearch(fixture.checkpointPath, { senseId, note: '검토한 표본의 PASS B 상태를 기록함' }, { scratchDirectory: fixture.scratchDirectory });
    }

    const candidateRows = (await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory })).checkpoint.records.map((record) => ({
      record_id: record.record_id,
      senses: record.senses.map((sense) => ({
        sense_id: sense.sense_id,
        candidates: sense.sense_id === 'w2-s1' ? ['잔향'] : sense.sense_id === 'w4-s1' ? ['바람', '흐름'] : [],
      })),
    }));
    const missingPass = await validateCorpusExport({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidateRows, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(missingPass.status, 'INVALID');
    assert.match(missingPass.message, /lacks an explicit integrated PASS 1 record/u);
    await assert.rejects(exportCorpusCandidates({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      outputPath: path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl'),
      repositoryDirectory: fixture.repositoryDirectory,
      scratchDirectory: fixture.scratchDirectory,
    }), /lacks an explicit integrated PASS 1 record/u);

    await writeFile(path.join(fixture.scratchDirectory, 'empty-resumed-pass-b.json'), '[]\n');
    const resumedZero = runExploreCli(fixture, { senseId: 'w3-s1', locatorKey: locators.get('w3-s1'), inputName: 'empty-resumed-pass-b.json' });
    assert.equal(resumedZero.candidates_recorded, 0);

    const passTwoInput = path.join(fixture.scratchDirectory, 'optional-pass-b.json');
    await writeFile(passTwoInput, '[]\n');
    const cliArgs = [CORPUS_CLI_PATH, 'explore', '--checkpoint', '.warroom-scratch/001_01_d_codex.checkpoint.json', '--sense-id', 'w1-s1', '--locator-key', locators.get('w1-s1'), '--pass', '2', '--results', '.warroom-scratch/optional-pass-b.json'];
    assert.throws(() => execFileSync(process.execPath, cliArgs, { cwd: fixture.repositoryDirectory, encoding: 'utf8', stdio: 'pipe' }), (error) => {
      assert.match(String(error.stderr), /independent-read/u);
      return true;
    });
    assert.throws(() => execFileSync(process.execPath, [...cliArgs, '--independent-read'], { cwd: fixture.repositoryDirectory, encoding: 'utf8', stdio: 'pipe' }), (error) => {
      assert.match(String(error.stderr), /brief reason for re-reading/u);
      return true;
    });
    const secondPass = runExploreCli(fixture, { senseId: 'w1-s1', locatorKey: locators.get('w1-s1'), pass: 2, inputName: 'optional-pass-b.json', independentRead: true, note: '첫 통합 탐색 뒤 문맥을 독립적으로 다시 읽음' });
    assert.equal(secondPass.pass, 2);

    const { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].status, 'DISCOVERED');
    assert.deepEqual(checkpoint.records[0].senses[0].contexts[0].explorations['1'].results, []);
    assert.equal(checkpoint.records[0].senses[0].discoveries.length, 0);
    assert.deepEqual(checkpoint.records[3].senses[0].contexts[0].explorations['1'].results, [
      { candidate: '바람', lenses: ['action_role_tool'] },
      { candidate: '흐름', lenses: ['contrast_sensation_metaphor'] },
    ]);
    assert.equal(checkpoint.records[3].senses[0].candidate_reviews.length, 2);

    const valid = await validateCorpusExport({ checkpointPath: fixture.checkpointPath, canonicalPath: fixture.canonicalPath, candidateRows, repositoryDirectory: fixture.repositoryDirectory, scratchDirectory: fixture.scratchDirectory });
    assert.equal(valid.status, 'VALID', JSON.stringify(valid));
    assert.equal(valid.candidateCount, 3);
    const exported = await exportCorpusCandidates({
      checkpointPath: fixture.checkpointPath,
      canonicalPath: fixture.canonicalPath,
      outputPath: path.join(fixture.scratchDirectory, '001_01_d_codex.jsonl'),
      repositoryDirectory: fixture.repositoryDirectory,
      scratchDirectory: fixture.scratchDirectory,
    });
    assert.equal(exported.status, 'OUTPUT');
    assert.equal(exported.coverage.candidates, 3);
  } finally {
    await cleanup(fixture);
  }
});

test('search failures remain explicit instead of becoming ZERO_HITS', async () => {
  const fixture = await makeFixture();
  let writer;
  try {
    await initialize(fixture);
    writer = new DatabaseSync(fixture.databasePath);
    writer.exec('BEGIN EXCLUSIVE');
    const scan = await scanCorpusBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.status, 'INCOMPLETE');
    assert.ok(scan.failed_queries > 0);
    writer.exec('ROLLBACK');
    writer.close();
    writer = null;
    const { checkpoint } = await loadCorpusCheckpoint(fixture.checkpointPath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(checkpoint.records[0].senses[0].status, 'SEARCH_FAILED');
    assert.ok(['timeout', 'sqlite'].includes(checkpoint.records[0].senses[0].search.failure.kind));
  } finally {
    try { writer?.exec('ROLLBACK'); } catch {}
    writer?.close();
    await cleanup(fixture);
  }
});

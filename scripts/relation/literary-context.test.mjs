import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function makeFixture({ paragraphCount = 2, paragraphText, firstForm = '가나다', documentCount = 1 } = {}) {
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
      source_path TEXT PRIMARY KEY, corpus_id TEXT, title TEXT, creator TEXT,
      year TEXT, category TEXT, annotation_level_json TEXT, sampling TEXT,
      source_sha256 TEXT, source_bytes INTEGER
    );
    CREATE TABLE documents (
      document_rowid INTEGER PRIMARY KEY, source_path TEXT NOT NULL, document_id TEXT,
      document_ordinal INTEGER NOT NULL, title TEXT, author TEXT, publisher TEXT,
      document_date TEXT
    );
    CREATE TABLE paragraphs (
      paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER NOT NULL,
      paragraph_id TEXT NOT NULL, ordinal INTEGER NOT NULL, form TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, content='paragraphs', content_rowid='paragraph_rowid', tokenize='trigram');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.prepare('INSERT INTO source_files (source_path, corpus_id, title, creator, year, category) VALUES (?, ?, ?, ?, ?, ?)')
    .run('local/source-001.json', 'source-001', 'Fixture Literary Source', 'Test Author', '2025', 'literary');
  const insertDocument = database.prepare('INSERT INTO documents (document_rowid, source_path, document_id, document_ordinal, title, author) VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 1; index <= documentCount; index += 1) {
    insertDocument.run(index, 'local/source-001.json', `document-${String(index).padStart(3, '0')}`, index, `Fixture Document ${index}`, `Test Author ${index}`);
  }
  const insertParagraph = database.prepare('INSERT INTO paragraphs (paragraph_rowid, document_rowid, paragraph_id, ordinal, form) VALUES (?, ?, ?, ?, ?)');
  for (let index = 1; index <= paragraphCount; index += 1) {
    const text = paragraphText ?? `앞 문맥. ${firstForm}가 문학 장면에서 쓰였다. 뒤 문맥 ${index}.`;
    const documentOrdinal = ((index - 1) % documentCount) + 1;
    const paragraphOrdinal = Math.floor((index - 1) / documentCount) + 1;
    insertParagraph.run(index, documentOrdinal, `paragraph-${String(index).padStart(3, '0')}`, paragraphOrdinal, text);
    database.prepare('INSERT INTO paragraph_fts (rowid, form) VALUES (?, ?)').run(index, text);
  }
  const insertMetadata = database.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?)');
  insertMetadata.run('schema_version', 'fixture-v1');
  insertMetadata.run('builder_version', 'test-builder');
  insertMetadata.run('input_manifest_sha256', 'a'.repeat(64));
  insertMetadata.run('paragraph_count', String(paragraphCount));
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

const sevenEmptyLenses = () => ({
  image: [],
  action: [],
  emotion: [],
  sensation: [],
  scene_situation: [],
  causality: [],
  metaphor_contrast: [],
});

test('read-only preflight identifies a bounded index and reuses its local exact-file digest', async () => {
  const fixture = await makeFixture({ paragraphCount: 1 });
  try {
    await rm(path.join(fixture.scratchDirectory, 'literary-index-digests.json'), { force: true });
    const first = await inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    const second = await inspectLiteraryIndex(fixture.databasePath, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.status, 'READY');
    assert.equal(first.index.schema_version, 'fixture-v1');
    assert.match(first.database.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(first.search.read_only, true);
    assert.equal(first.database.sha256_cached, false);
    assert.equal(second.database.sha256_cached, true);
    assert.equal(second.database.sha256, first.database.sha256);
  } finally {
    await cleanup(fixture);
  }
});
test('batch scan returns counts only; paginated exact-sense search resumes without treating truncation as zero', async () => {
  const fixture = await makeFixture({ paragraphCount: 6, paragraphText: `${'앞 문맥 '.repeat(30)}가나다가 정확한 장면에 있다.${' 뒤 문맥'.repeat(30)}` });
  try {
    const scan = await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    assert.equal(scan.total_senses, 500);
    assert.equal(scan.hit_senses, 1);
    assert.equal(scan.zero_hit_senses, 499);
    assert.equal(scan.failed_senses, 0);
    assert.equal('paragraphs' in scan, false);

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
    assert.ok(first.results.every((item) => !('paragraph_id' in item) && !('paragraph_sha256' in item)));

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
  const fixture = await makeFixture({ paragraphCount: 20 });
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
  const fixture = await makeFixture({ paragraphCount: 6, documentCount: 3 });
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

test('long paragraph reads remain character bounded and report total length and continuation', async () => {
  const fixture = await makeFixture({ paragraphCount: 1, paragraphText: `${'문학 문맥 '.repeat(180)}가나다${' 뒤 문맥'.repeat(180)}` });
  try {
    await scanLiteraryBatch({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, scratchDirectory: fixture.scratchDirectory });
    const search = await searchLiterarySense({ databasePath: fixture.databasePath, checkpointPath: fixture.checkpointPath, senseId: 'sense-000001', scratchDirectory: fixture.scratchDirectory });
    const first = await getLiteraryContextPage(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey: search.results[0].locator_key, offset: 0, chars: 100 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(first.chars_returned, 100);
    assert.ok(first.total_chars > first.chars_returned);
    assert.equal(first.truncated, true);
    const second = await getLiteraryContextPage(fixture.checkpointPath, { senseId: 'sense-000001', locatorKey: search.results[0].locator_key, offset: first.next_offset, chars: 100 }, { scratchDirectory: fixture.scratchDirectory });
    assert.equal(second.total_chars, first.total_chars);
    assert.equal(second.offset, first.next_offset);
    assert.equal(second.chars_returned, 100);
  } finally {
    await cleanup(fixture);
  }
});

test('short literal search forms use the bounded page path and invalidate stale zero-hit summaries', async () => {
  const fixture = await makeFixture({ paragraphCount: 1, paragraphText: '짧은 두자 검색 예시' });
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
  const fixture = await makeFixture({ paragraphCount: 1 });
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
  const fixture = await makeFixture({ paragraphCount: 20 });
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
  const fixture = await makeFixture({ paragraphCount: 1 });
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
  const fixture = await makeFixture({ paragraphCount: 1 });
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
  const fixture = await makeFixture({ paragraphCount: 1 });
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
  const fixture = await makeFixture({ paragraphCount: 1 });
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

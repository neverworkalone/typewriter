import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openReadonlyDb, renderContexts, saveChunk, searchContexts } from './corpus-utility.mjs';

async function makeCorpus(paragraphs) {
  const root = await mkdtemp(path.join((await mkdir(path.resolve('.warroom-scratch'), { recursive: true })) ?? path.resolve('.warroom-scratch'), 'corpus-utility-'));
  const databasePath = path.join(root, 'corpus.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (source_path TEXT PRIMARY KEY, title TEXT, creator TEXT, year TEXT, category TEXT);
    CREATE TABLE documents (document_rowid INTEGER PRIMARY KEY, source_path TEXT, document_id TEXT, document_ordinal INTEGER, title TEXT, author TEXT);
    CREATE TABLE paragraphs (paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER, paragraph_id TEXT, ordinal INTEGER, form TEXT);
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, content='paragraphs', content_rowid='paragraph_rowid', tokenize='trigram');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO index_metadata VALUES ('schema_version', '1'), ('input_manifest_sha256', '${'a'.repeat(64)}');
    INSERT INTO source_files VALUES ('s', 't', 'c', '2000', 'x');
    INSERT INTO documents VALUES (1, 's', 'd', 1, '합성 문서', '합성 저자');
  `);
  paragraphs.forEach((form, index) => {
    database.prepare('INSERT INTO paragraphs VALUES (?, 1, ?, ?, ?)').run(index + 1, `p${index}`, index, form);
    database.prepare('INSERT INTO paragraph_fts(rowid, form) VALUES (?, ?)').run(index + 1, form);
  });
  database.close();
  return { root, databasePath };
}

const drain = (database, forms, options) => {
  const pages = [];
  let result = searchContexts(database, forms, options);
  pages.push(result);
  while (result.next_cursor) {
    result = searchContexts(database, forms, { ...options, cursor: result.next_cursor });
    pages.push(result);
  }
  return pages;
};

test('the sample bound holds across many matching paragraphs and paging reads each context exactly once', async () => {
  // Old nested `for rows { for snippets { if (n >= 3) break } }` kept walking every row (here 50 outputs).
  const paragraphs = Array.from({ length: 50 }, (_, index) => `${index}번째 문단에서 김구 선생을 말했다. 김구는 또 말했다.`);
  const { root, databasePath } = await makeCorpus(paragraphs);
  try {
    const database = openReadonlyDb(databasePath);
    const first = searchContexts(database, ['김구'], { maxSamples: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.status, 'LIMITED');
    const pages = drain(database, ['김구'], { maxSamples: 3 });
    assert.ok(pages.every((page) => page.items.length <= 3));
    assert.equal(pages.at(-1).status, 'COMPLETE');
    const ids = pages.flatMap((page) => page.items.map((item) => item.paragraph_rowid));
    assert.deepEqual(ids, Array.from({ length: 50 }, (_, index) => index + 1));
    assert.throws(() => database.exec('DELETE FROM paragraphs'), /readonly|read-only|query_only/i);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a character budget limits one call and a cursor with the wrong form list fails closed', async () => {
  const { root, databasePath } = await makeCorpus(Array.from({ length: 20 }, () => `${'가'.repeat(100)} 새벽안개 ${'나'.repeat(100)}`));
  try {
    const database = openReadonlyDb(databasePath);
    const result = searchContexts(database, ['새벽안개'], { maxSamples: 20, maxChars: 500, snippetChars: 200 });
    assert.ok(result.items.reduce((sum, item) => sum + item.excerpt.length, 0) <= 500);
    assert.equal(result.status, 'LIMITED');
    assert.ok(renderContexts(result).length < 1500);
    assert.equal(searchContexts(database, ['다른말'], { cursor: result.next_cursor }).status, 'SEARCH_FAILED');
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('short forms keep both-side boundaries and homonym hits are left to the reader; limits are never ZERO_HITS', async () => {
  const { root, databasePath } = await makeCorpus([
    '이 기현상은 흔하다.', '이기현 씨가 왔다.', '기현이 웃었다.', '그 기현, 낯설다.', '전혀 관계없는 글이다.',
    ...Array.from({ length: 30 }, () => '앞에 아무 말도 없는 문단이다.'),
  ]);
  try {
    const database = openReadonlyDb(databasePath);
    const both = searchContexts(database, ['기현']);
    assert.deepEqual(both.items.map((item) => item.paragraph_rowid), [4]);
    assert.deepEqual(searchContexts(database, ['기현'], { boundary: 'left' }).items.map((item) => item.paragraph_rowid), [1, 3, 4]);
    assert.equal(searchContexts(database, ['없는표면형']).status, 'ZERO_HITS');
    // A scan bound reached before any boundary-valid hit is LIMITED with a cursor, not a corpus-wide zero.
    const bounded = searchContexts(database, ['기현'], { scanRows: 2 });
    assert.equal(bounded.status, 'LIMITED');
    assert.ok(bounded.next_cursor);
    assert.equal(drain(database, ['기현'], { scanRows: 2 }).flatMap((page) => page.items).length, 1);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveChunk exposes only a complete chunk file and rejects a wrong record set', async () => {
  const root = await mkdtemp(path.join(await (async () => { await mkdir(path.resolve('.warroom-scratch'), { recursive: true }); return path.resolve('.warroom-scratch'); })(), 'corpus-utility-chunk-'));
  try {
    const rows = [{ record_id: 'r1', senses: [] }, { record_id: 'r2', senses: [] }];
    await assert.rejects(saveChunk(root, 1, rows, ['r2', 'r1']), /Canonical order/);
    assert.deepEqual(await readdir(root), []);
    const target = await saveChunk(root, 1, rows, ['r1', 'r2']);
    assert.equal(path.basename(target), 'chunk-001.jsonl');
    assert.deepEqual(await readdir(root), ['chunk-001.jsonl']);
    assert.equal((await readFile(target, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rendered output stays within maxChars for many forms, and the cursor does not carry the form list', async () => {
  const forms = Array.from({ length: 12 }, (_, index) => `검색어${String(index).padStart(2, '가')}긴표면형`);
  const { root, databasePath } = await makeCorpus(Array.from({ length: 60 }, (_, index) => `${'앞'.repeat(150)} ${forms[index % forms.length]} ${'뒤'.repeat(150)}`));
  try {
    const database = openReadonlyDb(databasePath);
    for (const maxChars of [400, 700, 1500]) {
      const pages = drain(database, forms, { maxChars, maxSamples: 50 });
      for (const page of pages) {
        const text = renderContexts(page);
        assert.ok(text.length <= maxChars, `${text.length} > ${maxChars}`);
        if (page.next_cursor) assert.ok(page.next_cursor.length < 100);
      }
      const ids = pages.flatMap((page) => page.items.map((item) => `${item.form}:${item.paragraph_rowid}`));
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, 60);
    }
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

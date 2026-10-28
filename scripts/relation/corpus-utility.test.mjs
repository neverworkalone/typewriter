import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { corpusScanRows, createSearchContextReuse, openReadonlyDb, renderContexts, saveChunk, searchContexts } from './corpus-utility.mjs';

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
    assert.equal(corpusScanRows(database), 50);
    const first = searchContexts(database, ['김구'], { maxSamples: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.status, 'LIMITED');
    assert.ok(first.scanned_rows > 0);
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

test('zero-hit FTS forms consume the scan budget and leave the next form in the cursor', async () => {
  const { root, databasePath } = await makeCorpus([]);
  try {
    const database = openReadonlyDb(databasePath);
    const result = searchContexts(database, ['없는말', '없는형', '없는뜻'], { scanRows: 2 });
    assert.equal(result.status, 'LIMITED');
    assert.deepEqual(result.items, []);
    assert.equal(result.scanned_rows, 2, 'an empty FTS page still consumes its result-page budget');
    assert.ok(result.next_cursor);
    const state = JSON.parse(Buffer.from(result.next_cursor, 'base64url').toString('utf8'));
    assert.equal(state.form, 1, 'the cursor resumes at the first unsearched form');
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

test('overlapping forms return each paragraph once across cursor pages', async () => {
  const { root, databasePath } = await makeCorpus([
    '난처히 말했고 난처하다며 웃었다.',
    '난처히 고개를 돌렸다.',
    '난처하다 생각했다.',
  ]);
  try {
    const database = openReadonlyDb(databasePath);
    const pages = drain(database, ['난처히', '난처하다'], { maxSamples: 1 });
    const items = pages.flatMap((page) => page.items);
    assert.deepEqual(items.map((item) => item.paragraph_rowid), [1, 2, 3]);
    assert.equal(new Set(items.map((item) => item.paragraph_rowid)).size, 3);
    assert.ok(pages.length >= 3, 'the cursor crosses pages and overlapping forms');
    assert.equal(pages.at(-1).status, 'COMPLETE');

    const withSeen = JSON.parse(Buffer.from(pages[0].next_cursor, 'base64url').toString('utf8'));
    const oldState = { ...withSeen };
    delete oldState.p;
    delete oldState.seen;
    const oldCursor = Buffer.from(JSON.stringify(oldState)).toString('base64url');
    assert.notEqual(searchContexts(database, ['난처히', '난처하다'], { maxSamples: 1, cursor: oldCursor }).status, 'SEARCH_FAILED', 'pre-change cursors remain resumable');
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveChunk publishes only a chunk that matches every Canonical record and sense', async () => {
  const root = await mkdtemp(path.join(await (async () => { await mkdir(path.resolve('.warroom-scratch'), { recursive: true }); return path.resolve('.warroom-scratch'); })(), 'corpus-utility-chunk-'));
  try {
    const expected = [{ record_id: 'r1', sense_ids: ['s1', 's2'] }, { record_id: 'r2', sense_ids: ['s3'] }];
    const good = [
      { record_id: 'r1', senses: [{ sense_id: 's1', candidates: ['가'] }, { sense_id: 's2', candidates: [] }] },
      { record_id: 'r2', senses: [{ sense_id: 's3', candidates: [] }] },
    ];
    const bad = {
      'missing record': good.slice(0, 1),
      'wrong order': [good[1], good[0]],
      'missing sense': [{ record_id: 'r1', senses: [good[0].senses[0]] }, good[1]],
      'empty senses': [{ record_id: 'r1', senses: [] }, good[1]],
      'swapped senses': [{ record_id: 'r1', senses: [good[0].senses[1], good[0].senses[0]] }, good[1]],
      'candidates not an array': [{ record_id: 'r1', senses: [{ sense_id: 's1' }, good[0].senses[1]] }, good[1]],
    };
    for (const [label, rows] of Object.entries(bad)) {
      await assert.rejects(saveChunk(root, 1, rows, expected), /./, label);
    }
    await assert.rejects(saveChunk(root, 1, good), /expected chunk records/);
    assert.deepEqual(await readdir(root), []);
    const target = await saveChunk(root, 1, good, expected);
    assert.equal(path.basename(target), 'chunk-001.jsonl');
    assert.deepEqual(await readdir(root), ['chunk-001.jsonl']);
    assert.equal((await readFile(target, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a short form examines a bounded paragraph span per call and reaches later matches through the cursor', async () => {
  const { root, databasePath } = await makeCorpus([...Array.from({ length: 95 }, () => '아무 일도 없는 문단이다.'), '그 기현, 낯설다.', '다시 기현 이다.']);
  try {
    const database = openReadonlyDb(databasePath);
    const traced = [];
    const spy = new Proxy(database, { get: (target, key) => (key === 'prepare' ? (sql) => { const statement = target.prepare(sql); return { all: (...args) => { traced.push(args); return statement.all(...args); }, get: (...args) => statement.get(...args) }; } : target[key].bind?.(target) ?? target[key]) });
    const first = searchContexts(spy, ['기현'], { scanRows: 40 });
    assert.deepEqual([first.status, first.items.length], ['LIMITED', 0]);
    assert.ok(first.next_cursor);
    // Every instr query was confined to a rowid window no larger than the scan bound.
    for (const [after, end] of traced.filter((args) => args.length === 3)) assert.ok(end - after <= 40);
    const pages = drain(database, ['기현'], { scanRows: 40 });
    assert.deepEqual(pages.flatMap((page) => page.items.map((item) => item.paragraph_rowid)), [96, 97]);
    assert.ok(pages.length >= 3);
    assert.equal(pages.at(-1).status, 'COMPLETE');
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cursor is rejected when its options, corpus or position differ', async () => {
  const { root, databasePath } = await makeCorpus(Array.from({ length: 10 }, () => '기현 이 말했다. 기현, 또.'));
  try {
    const database = openReadonlyDb(databasePath);
    const first = searchContexts(database, ['기현'], { maxSamples: 2 });
    assert.equal(searchContexts(database, ['기현'], { cursor: first.next_cursor, maxSamples: 20 }).status, 'COMPLETE');
    assert.equal(searchContexts(database, ['기현'], { cursor: first.next_cursor, boundary: 'none' }).status, 'SEARCH_FAILED');
    const forged = (state) => Buffer.from(JSON.stringify(state)).toString('base64url');
    const id = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString()).id;
    for (const state of [{ id, form: 5, after: 1 }, { id, form: 0, after: -1 }, { id, form: 0, after: 9999 }, { id, form: 0, after: 1.5 }]) {
      assert.equal(searchContexts(database, ['기현'], { cursor: forged(state) }).status, 'SEARCH_FAILED');
    }
    database.close();
    const other = await makeCorpus(Array.from({ length: 11 }, () => '기현 이 말했다.'));
    const otherDb = openReadonlyDb(other.databasePath);
    assert.equal(searchContexts(otherDb, ['기현'], { cursor: first.next_cursor }).status, 'SEARCH_FAILED');
    otherDb.close();
    await rm(other.root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same-chunk search reuse skips identical SQLite reads and keeps request pages separate', async () => {
  const { root, databasePath } = await makeCorpus([
    '이 기현상은 흔하다.', '이기현 씨가 왔다.', '기현이 웃었다.', '그 기현, 낯설다.', '전혀 관계없는 글이다.',
    ...Array.from({ length: 30 }, () => '앞에 아무 말도 없는 문단이다.'),
  ]);
  try {
    const database = openReadonlyDb(databasePath);
    let reads = 0;
    const counted = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare') return (sql) => {
          const statement = target.prepare(sql);
          return { all: (...args) => { reads += 1; return statement.all(...args); }, get: (...args) => statement.get(...args) };
        };
        return target[key].bind?.(target) ?? target[key];
      },
    });
    const search = createSearchContextReuse(counted);
    const options = { maxSamples: 1, maxChars: 800, snippetChars: 80, scanRows: 40, boundary: 'both' };
    const first = search(['기현'], options);
    assert.equal(first.reused, false);
    assert.equal(first.result.status, 'LIMITED');
    assert.ok(first.result.next_cursor);
    const firstReadCount = reads;

    first.result.items[0].excerpt = 'caller mutation';
    const sameRequest = search([' 기현 ', '기현'], options);
    assert.equal(sameRequest.reused, true);
    assert.equal(reads, firstReadCount);
    assert.notEqual(sameRequest.result.items[0].excerpt, 'caller mutation');

    for (const changedOptions of [
      { ...options, maxSamples: 2 },
      { ...options, maxChars: 801 },
      { ...options, snippetChars: 81 },
      { ...options, scanRows: 39 },
      { ...options, boundary: 'left' },
    ]) {
      const before = reads;
      assert.equal(search(['기현'], changedOptions).reused, false);
      assert.equal(reads, before + 1);
    }

    const firstOrder = search(['기현', '기현상'], options);
    const reverseOrder = search(['기현상', '기현'], options);
    assert.equal(firstOrder.reused, false);
    assert.equal(reverseOrder.reused, false);

    const nextPageOptions = { ...options, cursor: sameRequest.result.next_cursor };
    const nextPage = search(['기현'], nextPageOptions);
    assert.equal(nextPage.reused, false);
    assert.equal(nextPage.result.status, 'COMPLETE');
    const nextPageReadCount = reads;
    assert.equal(search(['기현'], nextPageOptions).reused, true);
    assert.equal(reads, nextPageReadCount);

    const noHits = search(['없는표면형']);
    assert.equal(noHits.result.status, 'ZERO_HITS');
    assert.equal(search(['없는표면형']).reused, true);
    const failed = search(['기현'], { ...options, cursor: 'invalid' });
    assert.equal(failed.result.status, 'SEARCH_FAILED');
    assert.equal(search(['기현'], { ...options, cursor: 'invalid' }).reused, false);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rendered output stays within maxChars for many forms, and the cursor does not carry the form list', async () => {
  const forms = Array.from({ length: 12 }, (_, index) => `검색어${String(index).padStart(2, '가')}긴표면형`);
  const { root, databasePath } = await makeCorpus(Array.from({ length: 60 }, (_, index) => `${'앞'.repeat(150)} ${forms[index % forms.length]} ${'뒤'.repeat(150)}`));
  try {
    const database = openReadonlyDb(databasePath);
    for (const maxChars of [600, 900, 1500]) {
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

test('supplementary-plane text is bounded by the rendered UTF-16 length, including the first item', async () => {
  const forms = ['𠮷검색어𠮷', '😀표면형😀'];
  const { root, databasePath } = await makeCorpus(Array.from({ length: 24 }, (_, index) => `${'😀'.repeat(200)} ${forms[index % 2]} ${'𠮷'.repeat(200)}`));
  try {
    const database = openReadonlyDb(databasePath);
    for (const maxChars of [400, 600, 1000]) {
      const pages = drain(database, forms, { maxChars, maxSamples: 50, snippetChars: 700 });
      for (const page of pages) assert.ok(renderContexts(page).length <= Math.max(maxChars, 600), `${renderContexts(page).length} > ${maxChars}`);
      const ids = pages.flatMap((page) => page.items.map((item) => `${item.form}:${item.paragraph_rowid}`));
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, 24);
    }
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeLiteratureBytes,
  assertLiteraturePermission,
  buildLiteratureIndex,
  decodeLiteratureText,
  inventoryLiterature,
  literatureManifestDigest,
  reconstructLiteratureText,
  reconstructWorkFromDatabase,
  searchLiteratureIndex,
  selectLiteraturePilotSample,
  splitLiteratureUnits,
  verifyLiteratureIndex,
} from './literature-index.mjs';

const directories = [];
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-literature-'));
  directories.push(directory);
  return directory;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// Synthetic, project-authored text only.
const POEM = '가나다 라마\r\n바사 아자\r\n\r\n차카 타파\r\n하\r\n';
const NOVEL = ' 첫째 문단의 앞줄이다.\r\n둘째 줄이 이어진다.\r\n\r\n 둘째 문단 (漢字) 시작\r\n끝';
const ESSAY = '제목 하나\n\n본문 一二三\n\n각주: 합성 각주\n';

async function makeCollection(extra = {}) {
  const input = await makeDirectory();
  const files = {
    'poem/1_작가-시하나-1.txt': Buffer.from(POEM),
    'novel/2_작가-소설하나-2.txt': Buffer.concat([BOM, Buffer.from(NOVEL)]),
    'essay/3_작가-제목 하나-3.txt': Buffer.from(ESSAY),
    ...extra,
  };
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(input, relative)), { recursive: true });
    await writeFile(path.join(input, relative), bytes);
  }
  return { input, paths: Object.keys(files) };
}

test('units are reversible for CRLF, LF, CR, mixed and missing terminal newline', () => {
  for (const text of [POEM, NOVEL, ESSAY, 'a\rb\r\nc\nd', '\n\n', ' \t　\r\nx', 'solo']) {
    assert.equal(reconstructLiteratureText(splitLiteratureUnits(text)), text);
  }
  const units = splitLiteratureUnits(POEM);
  assert.deepEqual(units.map((u) => u.kind), ['text', 'text', 'blank', 'text', 'text']);
  assert.deepEqual(units.map((u) => u.blockOrdinal), [1, 1, null, 2, 2]);
});

test('decoding records UTF-8, BOM and CP949 and rejects lossy or ambiguous bytes', () => {
  assert.equal(decodeLiteratureText(Buffer.from('가나')).encoding, 'utf-8');
  const bom = decodeLiteratureText(Buffer.concat([BOM, Buffer.from('가나')]));
  assert.deepEqual([bom.hasBom, bom.text], [true, '가나']);
  assert.deepEqual(decodeLiteratureText(Buffer.from([0xb0, 0xa1, 0xb3, 0xaa])), {
    text: '가나', encoding: 'cp949', hasBom: false,
  });
  for (const bad of [
    Buffer.alloc(0),
    BOM,
    Buffer.from('  \r\n'),
    Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    Buffer.from([0xea, 0xb0]), // truncated UTF-8 and invalid CP949 trail
    Buffer.from([0xb0]),
    Buffer.concat([BOM, Buffer.from([0xb0, 0xa1])]),
    Buffer.from('가\u0000나'),
    Buffer.from('가�나'),
    Buffer.from('가나'),
  ]) {
    assert.throws(() => decodeLiteratureText(bad), undefined, JSON.stringify([...bad]));
  }
});

test('analysis flags warnings without altering text and keeps non-NFC text as-is', () => {
  const nfd = '가나'.normalize('NFD') + '\n';
  const analysis = analyzeLiteratureBytes(Buffer.from(nfd), 'poem/x.txt');
  assert.equal(analysis.status, 'warning');
  assert.equal(analysis.nfc, 0);
  assert.equal(analysis.text, nfd);
  const bad = analyzeLiteratureBytes(Buffer.alloc(0), 'poem/empty.txt');
  assert.deepEqual([bad.status, bad.error], ['error', 'empty file']);
});

test('permission gate blocks pending terms and accepts only the stated scope', async () => {
  const directory = await makeDirectory();
  const record = path.join(directory, 'r.md');
  await assert.rejects(assertLiteraturePermission({ permissionRecordPath: record }), /cannot read/u);
  const good = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/external-material-review-public-domain-literature.md'),
    'utf8',
  );
  await assertLiteraturePermission({
    permissionRecordPath: await (async () => { await writeFile(record, good); return record; })(),
  });
  await writeFile(record, good.replace('Allowed SQLite/FTS indexing: permitted', 'Allowed SQLite/FTS indexing: pending'));
  await assert.rejects(assertLiteraturePermission({ permissionRecordPath: record }), /Allowed SQLite\/FTS indexing/u);
  await writeFile(record, good.replace('not authorized', 'authorized'));
  await assert.rejects(assertLiteraturePermission({ permissionRecordPath: record }), /Redistribution/u);
});

test('build reconstructs each work exactly from stored units and is reproducible', async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  const first = await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const database = new DatabaseSync(output, { readOnly: true });
  assert.equal(reconstructWorkFromDatabase(database, 'poem/1_작가-시하나-1.txt'), POEM);
  assert.equal(reconstructWorkFromDatabase(database, 'novel/2_작가-소설하나-2.txt'), NOVEL);
  assert.equal(reconstructWorkFromDatabase(database, 'essay/3_작가-제목 하나-3.txt'), ESSAY);
  assert.equal(database.prepare('SELECT has_bom FROM source_files WHERE genre = ?').get('novel').has_bom, 1);
  assert.equal(database.prepare('SELECT title_in_first_unit AS t FROM works WHERE genre = ?').get('essay').t, 1);
  assert.equal(database.prepare('SELECT title_in_first_unit AS t FROM works WHERE genre = ?').get('poem').t, 0);
  database.close();
  const second = await buildLiteratureIndex({
    inputDirectory: input, outputPath: path.join(await makeDirectory(), 'again.sqlite'), relativePaths: [...paths].reverse(),
  });
  assert.equal(second.logical_rows_sha256, first.logical_rows_sha256);
  assert.equal(second.input_manifest_sha256, first.input_manifest_sha256);
  assert((await verifyLiteratureIndex({ inputDirectory: input, databasePath: output }))
    .every((r) => r.source_unchanged && r.text_identical));
});

test('changed or removed source changes the manifest digest and verification', async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  const built = await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  await writeFile(path.join(input, paths[0]), POEM + '추가\r\n');
  const changed = await buildLiteratureIndex({
    inputDirectory: input, outputPath: path.join(await makeDirectory(), 'b.sqlite'), relativePaths: paths,
  });
  assert.notEqual(changed.input_manifest_sha256, built.input_manifest_sha256);
  const verification = await verifyLiteratureIndex({ inputDirectory: input, databasePath: output });
  assert.equal(verification.find((r) => r.relative_path === paths[0]).source_unchanged, false);
  await rm(path.join(input, paths[2]));
  await assert.rejects(verifyLiteratureIndex({ inputDirectory: input, databasePath: output }), /ENOENT/u);
  await assert.rejects(buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths }), /cannot read source file.*3_/u);
});

test('failed build leaves the previous index intact and names the offending path', async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const before = await readFile(output);
  for (const [name, bytes, pattern] of [
    ['poem/9_작가-빈-9.txt', Buffer.alloc(0), /poem\/9_작가-빈-9\.txt: empty file/u],
    ['novel/9_작가-깨짐-9.txt', Buffer.from([0xea, 0xb0]), /novel\/9_.*: (undecodable|CP949 decode produced no Hangul)/u],
    ['essay/9_작가-널-9.txt', Buffer.from('가\u0000'), /essay\/9_.*control characters/u],
  ]) {
    await mkdir(path.dirname(path.join(input, name)), { recursive: true });
    await writeFile(path.join(input, name), bytes);
    await assert.rejects(
      buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: [...paths, name] }),
      pattern,
    );
    assert.deepEqual(await readFile(output), before);
  }
  await assert.rejects(buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: ['poem/../x.txt'] }), /expected/u);
  await assert.rejects(buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: [] }), /non-empty/u);
  await assert.rejects(buildLiteratureIndex({ inputDirectory: input, outputPath: path.join(input, 'x.sqlite'), relativePaths: paths }), /outside the TXT input/u);
});

test('duplicate titles and file names across genres stay distinct works', async () => {
  const { input, paths } = await makeCollection({
    'poem/5_작가-같은제목-1.txt': Buffer.from('같은 시\r\n'),
    'poem/6_작가-같은제목-2.txt': Buffer.from('같은 시\r\n'),
    'essay/5_작가-같은제목-1.txt': Buffer.from('같은 시\r\n'),
  });
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const result = searchLiteratureIndex({ databasePath: output, query: '같은 시' });
  assert.deepEqual(result.results.map((r) => r.relative_path), [
    'poem/5_작가-같은제목-1.txt', 'poem/6_작가-같은제목-2.txt', 'essay/5_작가-같은제목-1.txt',
  ]);
});

test('search is literal, bounded, deterministic and covers 1-2 character queries', async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const one = searchLiteratureIndex({ databasePath: output, query: '가' });
  assert.equal(one.search_mode, 'literal-scan');
  assert.deepEqual(one.results.map((r) => [r.relative_path, r.unit_ordinal]), [['poem/1_작가-시하나-1.txt', 0]]);
  const three = searchLiteratureIndex({ databasePath: output, query: '一二三' });
  assert.equal(three.search_mode, 'fts5-trigram+instr');
  assert.equal(three.results[0].text, '본문 一二三');
  assert.equal(searchLiteratureIndex({ databasePath: output, query: '꿈' }).match_unit_count, 0);
  const limited = searchLiteratureIndex({ databasePath: output, query: '문', limit: 1 });
  assert.equal(limited.returned, 1);
  assert(limited.match_unit_count > 1);
  assert.deepEqual(searchLiteratureIndex({ databasePath: output, query: '문' }), searchLiteratureIndex({ databasePath: output, query: '문' }));
  assert.equal(searchLiteratureIndex({ databasePath: output, query: '문', genre: 'essay' }).results.every((r) => r.genre === 'essay'), true);
  // No term spans a hard line wrap, and FTS never matches case-folded ASCII falsely.
  assert.equal(searchLiteratureIndex({ databasePath: output, query: '이다.둘째' }).match_unit_count, 0);
  for (const bad of ['', 'a\nb', 'a\u0000b', 3]) {
    assert.throws(() => searchLiteratureIndex({ databasePath: output, query: bad }), TypeError);
  }
  for (const limit of [0, 201, 1.5]) {
    assert.throws(() => searchLiteratureIndex({ databasePath: output, query: '문', limit }), /limit/u);
  }
  assert.throws(() => searchLiteratureIndex({ databasePath: output, query: '문', genre: 'x' }), /genre/u);
});

test('SQLite integrity, foreign keys and FTS are consistent', async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const database = new DatabaseSync(output);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.exec("INSERT INTO unit_fts(unit_fts) VALUES ('integrity-check')");
  const keys = database.prepare('SELECT key FROM index_metadata ORDER BY key').all().map((r) => r.key);
  for (const key of ['schema_version', 'builder_version', 'input_manifest_sha256', 'file_count', 'work_count', 'unit_count', 'logical_rows_sha256', 'tool_identity']) {
    assert(keys.includes(key), key);
  }
  database.close();
});

test('inventory reports an explicit result per file and sampling is deterministic', async () => {
  const { input } = await makeCollection({
    'poem/7_작가-빈-7.txt': Buffer.alloc(0),
    'poem/8_작가-엘에프-8.txt': Buffer.from('가\n나\n\n다'),
    'poem/9_작가-시코드-9.txt': Buffer.from([0xb0, 0xa1, 0x0d, 0x0a, 0xb3, 0xaa, 0x0d, 0x0a]),
  });
  const inventory = await inventoryLiterature({ inputDirectory: input });
  assert.equal(inventory.length, 6);
  assert.equal(inventory.find((f) => f.relative_path === 'poem/7_작가-빈-7.txt').status, 'error');
  assert.equal(inventory.every((f) => f.status && f.source_sha256), true);
  const sample = selectLiteraturePilotSample(inventory, 3);
  assert.deepEqual(sample, selectLiteraturePilotSample([...inventory].reverse(), 3));
  assert(sample.every((f) => f.status !== 'error'));
  assert(sample.some((f) => f.encoding === 'cp949'));
  assert.equal(literatureManifestDigest(inventory), literatureManifestDigest([...inventory].reverse()));
});

test('CLI refuses a missing manifest and prints usage', async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-literature-index.mjs');
  const missing = spawnSync(process.execPath, [script, 'build', '--manifest', '/nonexistent/m.json'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot read pilot manifest/u);
  assert.match(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).stdout, /Usage/u);
});

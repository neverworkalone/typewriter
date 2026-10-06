import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, rename, symlink, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeLiteratureBytes,
  assertLiteratureFts5Support,
  assertLiteraturePermission,
  buildFullLiteratureIndex,
  buildLiteratureIndex,
  decodeLiteratureText,
  inventoryLiterature,
  literatureManifestDigest,
  recoverLiteraturePublish,
  reconstructLiteratureText,
  reconstructWorkFromDatabase,
  searchLiteratureIndex,
  selectLiteraturePilotSample,
  splitLiteratureUnits,
  summarizeLiteratureInventory,
  verifyFullLiteratureIndex,
  verifyLiteratureIndex,
} from './literature-index.mjs';

let fts5Error;
try {
  assertLiteratureFts5Support();
} catch (error) {
  fts5Error = error;
}
// Builds need SQLite FTS5 trigram; some CI Node builds ship SQLite without it.
const needsFts5 = { skip: fts5Error ? fts5Error.message : false };

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
    text: '가나', encoding: 'cp949', hasBom: false, ambiguityNote: null,
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

test('UTF-8 that is also valid CP949 is accepted only with an explicit warning when UTF-8 is clearly better', () => {
  const placeholder = Buffer.from('<그림>\r\n');
  assert.equal(decodeLiteratureText(placeholder).encoding, 'utf-8');
  assert.match(decodeLiteratureText(placeholder).ambiguityNote, /also valid CP949/u);
  assert.match(analyzeLiteratureBytes(placeholder, 'poem/p.txt').warnings.join('|'), /also valid CP949/u);
  assert.equal(decodeLiteratureText(Buffer.from('가나다')).ambiguityNote, null);
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
  await writeFile(record, good.replace('- Distribution/embedding terms reviewed: complete', '- Distribution/embedding terms reviewed: pending'));
  await assert.rejects(assertLiteraturePermission({ permissionRecordPath: record }), /Distribution\/embedding/u);
});

test('build reconstructs each work exactly from stored units and is reproducible', needsFts5, async () => {
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

test('changed or removed source changes the manifest digest and verification', needsFts5, async () => {
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

test('failed build leaves the previous index intact and names the offending path', needsFts5, async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const before = await readFile(output);
  for (const [name, bytes, pattern] of [
    ['poem/9_작가-빈-9.txt', Buffer.alloc(0), /poem\/9_작가-빈-9\.txt: empty file/u],
    ['novel/9_작가-깨짐-9.txt', Buffer.from([0xea, 0xb0]), /novel\/9_.*: (undecodable|CP949 decode produced no Hangul)/u],
    ['essay/9_작가-널-9.txt', Buffer.from('가\u0000'), /essay\/9_.*control characters/u],
    ['poem/9_작가-보조-9.txt', Buffer.from('가\u{F0000}'), /poem\/9_작가-보조-9\.txt: .*private-use/u],
    ['novel/9_작가-보조-8.txt', Buffer.from('가\u{10FFFD}'), /novel\/9_작가-보조-8\.txt: .*private-use/u],
    ['essay/9_작가-모호-9.txt', Buffer.from([0xc2, 0xa1, 0x0a]), /essay\/9_작가-모호-9\.txt: ambiguous encoding/u],
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

test('duplicate titles and file names across genres stay distinct works', needsFts5, async () => {
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

test('search is literal, bounded, deterministic and covers 1-2 character queries', needsFts5, async () => {
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

test('SQLite integrity, foreign keys and FTS are consistent', needsFts5, async () => {
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

const BAD_FILES = {
  'poem/7_작가-빈-7.txt': Buffer.alloc(0),
  'novel/7_작가-보조-7.txt': Buffer.from('가\u{F0000}'),
  'essay/7_작가-대체-7.txt': Buffer.from('가�나'),
  'poem/8_작가-사설-8.txt': Buffer.from('가'),
  'poem/8_작가-끝사설-9.txt': Buffer.from('가'),
  'essay/8_작가-널-8.txt': Buffer.from('가\u0000'),
};

async function fullPaths() {
  const directory = await makeDirectory();
  return { output: path.join(directory, 'full.sqlite'), manifest: path.join(directory, 'full.manifest.json') };
}

test('full build inventories every TXT, excludes errors from the DB and keeps them in the manifest', needsFts5, async () => {
  const { input, paths } = await makeCollection({
    ...BAD_FILES,
    'poem/9_작가-엘에프-9.txt': Buffer.from('가\n나\n\n다'),
    'poem/9_작가-시코드-9.txt': Buffer.from([0xb0, 0xa1, 0x0d, 0x0a, 0xb3, 0xaa, 0x0d, 0x0a]),
    'novel/9_작가-씨알-9.txt': Buffer.from('가\r나\r\n다\n라'),
    'poem/9_작가-비정규-9.txt': Buffer.from('가나'.normalize('NFD') + '\r\n'),
    'essay/9_작가-끝없음-9.txt': Buffer.from('끝 줄 없음'),
  });
  const { output, manifest } = await fullPaths();
  const built = await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const total = paths.length;
  assert.equal(built.inventory_file_count, total);
  assert.equal(built.excluded_file_count, Object.keys(BAD_FILES).length);
  assert.equal(built.included_work_count, total - Object.keys(BAD_FILES).length);
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(saved.files.length, total);
  assert.deepEqual(
    saved.files.filter((f) => f.status === 'error').map((f) => f.relative_path).sort(),
    Object.keys(BAD_FILES).sort(),
  );
  assert(saved.files.every((f) => f.source_sha256 && (f.status !== 'error' || f.error)));
  const reasons = summarizeLiteratureInventory(saved.files).error_reasons;
  assert.equal(Object.values(reasons).reduce((a, b) => a + b, 0), Object.keys(BAD_FILES).length);
  const database = new DatabaseSync(output, { readOnly: true });
  const stored = database.prepare('SELECT relative_path FROM source_files').all().map((r) => r.relative_path);
  assert.equal(stored.length, built.included_work_count);
  assert(Object.keys(BAD_FILES).every((name) => !stored.includes(name)));
  assert.equal(reconstructWorkFromDatabase(database, 'novel/9_작가-씨알-9.txt'), '가\r나\r\n다\n라');
  assert.equal(reconstructWorkFromDatabase(database, 'poem/9_작가-비정규-9.txt'), '가나'.normalize('NFD') + '\r\n');
  assert.equal(database.prepare('SELECT value FROM index_metadata WHERE key = ?').get('build_kind').value, 'full');
  database.close();
  const verified = await verifyFullLiteratureIndex({ inputDirectory: input, databasePath: output, manifestPath: manifest });
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.reconstructed_exactly, built.included_work_count);
  assert.equal(verified.excluded_confirmed_absent, built.excluded_file_count);
});

test('full build digests are independent of enumeration order and repeat exactly', needsFts5, async () => {
  const { input } = await makeCollection(BAD_FILES);
  const first = await fullPaths();
  const second = await fullPaths();
  const a = await buildFullLiteratureIndex({ inputDirectory: input, outputPath: first.output, manifestPath: first.manifest });
  // Same bytes written in a different creation order give the same digests.
  const other = await makeDirectory();
  for (const genre of ['essay', 'novel', 'poem']) {
    await mkdir(path.join(other, genre));
    for (const name of (await readdir(path.join(input, genre))).reverse()) {
      await writeFile(path.join(other, genre, name), await readFile(path.join(input, genre, name)));
    }
  }
  const b = await buildFullLiteratureIndex({ inputDirectory: other, outputPath: second.output, manifestPath: second.manifest });
  assert.equal(b.logical_rows_sha256, a.logical_rows_sha256);
  assert.equal(b.input_manifest_sha256, a.input_manifest_sha256);
  assert.equal(literatureManifestDigest(JSON.parse(await readFile(first.manifest, 'utf8')).files.reverse()), a.input_manifest_sha256);
});

test('full build failure leaves the previous full index and manifest untouched', needsFts5, async () => {
  const { input } = await makeCollection();
  const { output, manifest } = await fullPaths();
  await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const before = [await readFile(output), await readFile(manifest)];
  await assert.rejects(buildFullLiteratureIndex({
    inputDirectory: input, outputPath: output, manifestPath: manifest,
    hooks: { afterRead: async (relativePath) => { if (relativePath.startsWith('novel/')) throw new Error('simulated crash'); } },
  }), /simulated crash/u);
  // A source changing while the build runs is detected before replacement.
  await assert.rejects(buildFullLiteratureIndex({
    inputDirectory: input, outputPath: output, manifestPath: manifest,
    hooks: { afterRead: async (relativePath) => { if (relativePath.startsWith('poem/')) await writeFile(path.join(input, 'essay/3_작가-제목 하나-3.txt'), '바뀜\n'); } },
  }), /source changed during build/u);
  await writeFile(path.join(input, 'essay/3_작가-제목 하나-3.txt'), ESSAY);
  await assert.rejects(buildFullLiteratureIndex({
    inputDirectory: input, outputPath: output, manifestPath: manifest,
    hooks: { afterRead: async (relativePath) => { if (relativePath.startsWith('poem/')) await writeFile(path.join(input, 'poem/late.txt'), '늦음\r\n'); } },
  }), /source set changed/u);
  await rm(path.join(input, 'poem/late.txt'));
  assert.deepEqual([await readFile(output), await readFile(manifest)], before);
  assert.deepEqual((await readdir(path.dirname(output))).filter((name) => name.startsWith('.literature')), []);
  const empty = await makeDirectory();
  await mkdir(path.join(empty, 'poem'));
  await writeFile(path.join(empty, 'poem/1_작가-빈-1.txt'), '');
  await assert.rejects(buildFullLiteratureIndex({ inputDirectory: empty, outputPath: output, manifestPath: manifest }), /refusing to build an empty/u);
  await assert.rejects(buildFullLiteratureIndex({ inputDirectory: input, outputPath: path.join(input, 'x.sqlite'), manifestPath: manifest }), /outside the TXT input/u);
  assert.deepEqual([await readFile(output), await readFile(manifest)], before);
});

test('failed publish of the DB/manifest pair keeps the previous pair verifiable', needsFts5, async () => {
  const { input } = await makeCollection();
  const { output, manifest } = await fullPaths();
  await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const before = [await readFile(output), await readFile(manifest)];
  await writeFile(path.join(input, 'poem/new.txt'), '새 글\r\n');
  for (const failAt of [1, 2, 3, 4]) {
    let calls = 0;
    await assert.rejects(buildFullLiteratureIndex({
      inputDirectory: input, outputPath: output, manifestPath: manifest,
      hooks: {
        renameFile: async (from, to) => {
          calls += 1;
          if (calls === failAt) throw new Error('simulated rename failure ' + failAt);
          return rename(from, to);
        },
      },
    }), /simulated rename failure/u);
    assert.deepEqual([await readFile(output), await readFile(manifest)], before);
  }
  await rm(path.join(input, 'poem/new.txt'));
  assert.deepEqual((await verifyFullLiteratureIndex({ inputDirectory: input, databasePath: output, manifestPath: manifest })).problems, []);
});

test('a publish killed mid-way is recovered to a verifiable pair on the next run', needsFts5, async () => {
  const { input } = await makeCollection();
  const { output, manifest } = await fullPaths();
  await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const before = [await readFile(output), await readFile(manifest)];
  await writeFile(path.join(input, 'poem/new.txt'), '새 글\r\n');
  const moduleUrl = new URL('./literature-index.mjs', import.meta.url).href;
  for (const [step, after] of [[1, false], [2, false], [3, false], [4, false], [4, true]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { rename } from 'node:fs/promises';
      import { buildFullLiteratureIndex } from ${JSON.stringify(moduleUrl)};
      let calls = 0;
      await buildFullLiteratureIndex({
        inputDirectory: ${JSON.stringify(input)}, outputPath: ${JSON.stringify(output)}, manifestPath: ${JSON.stringify(manifest)},
        hooks: { renameFile: async (from, to) => {
          calls += 1;
          if (calls === ${step} && !${after}) process.exit(42);
          await rename(from, to);
          if (calls === ${step} && ${after}) process.exit(42);
        } },
      });
    `], { encoding: 'utf8' });
    assert.equal(child.status, 42, child.stderr);
    const outcome = await recoverLiteraturePublish({ databasePath: output });
    assert.equal(outcome, step === 4 && after ? 'kept' : step === 1 ? 'kept' : 'restored', 'step ' + step);
    if (step === 4 && after) {
      // The fully published new pair is kept and is mutually bound; restore the old sources/pair.
      assert.notDeepEqual(await readFile(manifest), before[1]);
      await rm(path.join(input, 'poem/new.txt'));
      assert.equal((await verifyFullLiteratureIndex({ inputDirectory: input, databasePath: output, manifestPath: manifest })).ok, false);
      await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
      await writeFile(path.join(input, 'poem/new.txt'), '새 글\r\n');
    } else {
      assert.deepEqual([await readFile(output), await readFile(manifest)], before, 'step ' + step);
      await rm(path.join(input, 'poem/new.txt'));
      assert.deepEqual((await verifyFullLiteratureIndex({ inputDirectory: input, databasePath: output, manifestPath: manifest })).problems, [], 'step ' + step);
      await writeFile(path.join(input, 'poem/new.txt'), '새 글\r\n');
    }
    assert.deepEqual((await readdir(path.dirname(output))).filter((name) => name.endsWith('.publish-backup')), []);
  }
});

test('full build rejects identical or aliased DB and manifest paths before touching anything', needsFts5, async () => {
  const { input } = await makeCollection();
  const { output, manifest } = await fullPaths();
  await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const before = [await readFile(output), await readFile(manifest)];
  const directory = path.dirname(output);
  const alias = path.join(directory, 'alias.sqlite');
  await symlink(output, alias);
  const hard = path.join(directory, 'hard.json');
  await link(output, hard);
  const realDirectory = path.join(directory, 'real');
  await mkdir(realDirectory);
  await symlink(realDirectory, path.join(directory, 'via'));
  for (const [dbPath, manifestPath] of [
    [path.join(directory, 'via/not-yet/deeper/index.sqlite'), path.join(realDirectory, 'not-yet/deeper/index.sqlite')],
    [path.join(directory, 'via/a/b/index.sqlite'), path.join(realDirectory, 'a/b/index.sqlite')],
    [output, output],
    [output, path.join(directory, '.', path.basename(output))],
    [output, alias],
    [output, hard],
    [output, path.join(output + '.publish-backup', 'manifest')],
  ]) {
    await assert.rejects(
      buildFullLiteratureIndex({ inputDirectory: input, outputPath: dbPath, manifestPath }),
      /must be different files/u,
    );
    assert.deepEqual([await readFile(output), await readFile(manifest)], before);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('.literature') || name.endsWith('.publish-backup')), []);
    assert.deepEqual(await readdir(realDirectory), []);
  }
});

test('full build rejects a not-yet-existing case alias of the manifest path', needsFts5, async (t) => {
  const { input } = await makeCollection();
  const directory = await makeDirectory();
  await writeFile(path.join(directory, 'probe.TXT'), 'x');
  const caseInsensitive = await readFile(path.join(directory, 'probe.txt')).then(() => true, () => false);
  if (!caseInsensitive) return t.skip('case-sensitive filesystem: no case aliases exist');
  const target = path.join(directory, 'fresh/index.sqlite');
  await assert.rejects(
    buildFullLiteratureIndex({ inputDirectory: input, outputPath: target, manifestPath: path.join(directory, 'fresh/INDEX.SQLITE') }),
    /must be different files/u,
  );
  assert.deepEqual(await readdir(path.join(directory, 'fresh')), []);
});

test('full verification detects changed, removed, added and tampered sources', needsFts5, async () => {
  const { input, paths } = await makeCollection(BAD_FILES);
  const { output, manifest } = await fullPaths();
  await buildFullLiteratureIndex({ inputDirectory: input, outputPath: output, manifestPath: manifest });
  const verify = () => verifyFullLiteratureIndex({ inputDirectory: input, databasePath: output, manifestPath: manifest });
  assert.equal((await verify()).ok, true);
  await writeFile(path.join(input, paths[0]), POEM + '추가\r\n');
  assert.match((await verify()).problems.join('|'), /source bytes changed/u);
  await writeFile(path.join(input, paths[0]), POEM);
  await writeFile(path.join(input, 'poem/new.txt'), '새 글\r\n');
  assert.match((await verify()).problems.join('|'), /present on disk but not in manifest/u);
  await rm(path.join(input, 'poem/new.txt'));
  await writeFile(path.join(input, 'poem/7_작가-빈-7.txt'), '이제 내용\r\n');
  assert.match((await verify()).problems.join('|'), /source bytes changed/u);
  await writeFile(path.join(input, 'poem/7_작가-빈-7.txt'), '');
  await rm(path.join(input, paths[1]));
  assert.match((await verify()).problems.join('|'), /missing on disk/u);
  await writeFile(path.join(input, paths[1]), Buffer.concat([BOM, Buffer.from(NOVEL)]));
  assert.equal((await verify()).ok, true);
  // Tampering with the faithful layer or the manifest binding is caught.
  const tampered = new DatabaseSync(output);
  tampered.exec("UPDATE text_units SET text = '변조' WHERE file_id = 1 AND ordinal = 0");
  tampered.close();
  const result = await verify();
  assert.equal(result.ok, false);
  assert.match(result.problems.join('|'), /reconstruct|logical row digest/u);
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  saved.input_manifest_sha256 = 'f'.repeat(64);
  await writeFile(manifest, JSON.stringify(saved));
  assert.match((await verify()).problems.join('|'), /manifest digest does not match/u);
});

test('search returns bounded neighbouring-line context with source traceability', needsFts5, async () => {
  const { input, paths } = await makeCollection();
  const output = path.join(await makeDirectory(), 'lit.sqlite');
  await buildLiteratureIndex({ inputDirectory: input, outputPath: output, relativePaths: paths });
  const { results } = searchLiteratureIndex({ databasePath: output, query: '둘째 문단', context: 2 });
  assert.equal(results.length, 1);
  const [hit] = results;
  assert.deepEqual([hit.genre, hit.relative_path, hit.unit_ordinal, hit.block_ordinal, hit.eol], ['novel', 'novel/2_작가-소설하나-2.txt', 3, 2, '\r\n']);
  assert.equal(hit.title, '소설하나');
  assert.equal(hit.metadata_origin, 'filename (unverified)');
  assert.deepEqual(hit.context.map((u) => u.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(hit.context.map((u) => u.is_hit), [false, false, true, false]);
  assert.equal(hit.context.map((u) => u.text + u.eol).join(''), NOVEL.split('\r\n').slice(1).join('\r\n'));
  // File boundaries are never crossed; context 0 is the hit alone.
  const first = searchLiteratureIndex({ databasePath: output, query: '가나다', context: 3 }).results[0];
  assert.deepEqual(first.context.map((u) => u.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(searchLiteratureIndex({ databasePath: output, query: '가나다', context: 0 }).results[0].context.map((u) => u.ordinal), [0]);
  assert(searchLiteratureIndex({ databasePath: output, query: '가' }).results.every((r) => r.context.length >= 1));
  for (const context of [-1, 4, 1.5]) {
    assert.throws(() => searchLiteratureIndex({ databasePath: output, query: '가', context }), /context/u);
  }
});

test('full CLI commands print usage and refuse a missing manifest', async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-literature-index.mjs');
  assert.match(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).stdout, /full-build/u);
  const missing = spawnSync(process.execPath, [script, 'full-verify', '--manifest', '/nonexistent/m.json'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot read full manifest/u);
});

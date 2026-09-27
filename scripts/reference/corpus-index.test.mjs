import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

import {
  assertFts5TrigramSupport,
  assertCorpusPermission,
  auditCorpus,
  buildCorpusIndex,
  REPOSITORY_DIRECTORY,
  searchCorpusIndex,
} from './corpus-index.mjs';

let fts5TrigramError;
try {
  assertFts5TrigramSupport();
} catch (error) {
  fts5TrigramError = error;
}
const hasFts5Trigram = fts5TrigramError === undefined;

const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })),
  );
});

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-corpus-reference-'));
  temporaryDirectories.add(directory);
  return directory;
}

function makeSource({
  id = 'synthetic-corpus',
  title = 'Synthetic reference corpus',
  annotationLevel = ['raw'],
  documents = [],
} = {}) {
  return {
    id,
    metadata: {
      title,
      creator: 'Typewriter synthetic fixture',
      distributor: 'Typewriter synthetic fixture',
      year: '2026',
      category: 'synthetic > test',
      annotation_level: annotationLevel,
      sampling: 'self-authored fixture only',
    },
    document: documents,
  };
}

function makeDocument({
  id,
  title,
  author = 'Fixture author',
  publisher = 'Fixture publisher',
  date = '20260101',
  paragraphs = [],
}) {
  return {
    id,
    metadata: { title, author, publisher, date },
    paragraph: paragraphs,
  };
}

function makeParagraph(id, form) {
  return { id, form };
}

async function writeSource(directory, filename, source) {
  const target = path.join(directory, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(source), 'utf8');
  return target;
}

async function makeCorpus(directory) {
  const corpusDirectory = path.join(directory, 'corpus');
  const zSource = makeSource({
    id: 'same-corpus-id',
    title: 'Z synthetic source',
    documents: [
      makeDocument({
        id: 'repeated-document-id',
        title: 'Z first document',
        paragraphs: [
          makeParagraph('repeated-paragraph-id', '새벽 바람빛 문장을 적는다'),
          makeParagraph('z-second-paragraph', '강물에 비친 별빛을 그린다'),
        ],
      }),
      makeDocument({
        id: 'repeated-document-id',
        title: 'Z second document',
        paragraphs: [
          makeParagraph('repeated-paragraph-id', '바람 속에서 문장을 고른다'),
          makeParagraph('quoted-paragraph', '빛"표현을 조심히 기록한다'),
        ],
      }),
    ],
  });
  const aSource = makeSource({
    id: 'same-corpus-id',
    title: 'A synthetic source',
    annotationLevel: 'raw',
    documents: [
      makeDocument({
        id: 'a-document',
        title: 'A first document',
        author: 'Another fixture author',
        paragraphs: [
          makeParagraph('a-paragraph', '바람빛으로 짧은 글을 쓴다'),
        ],
      }),
    ],
  });

  await writeSource(corpusDirectory, 'z-source.json', zSource);
  await writeSource(corpusDirectory, 'nested/a-source.json', aSource);
  return corpusDirectory;
}

async function buildFixtureIndex(directory, corpusDirectory) {
  const outputPath = path.join(directory, 'indexes', 'fixture.sqlite');
  const summary = await buildCorpusIndex({ inputDirectory: corpusDirectory, outputPath });
  return { outputPath, summary };
}

function readLogicalRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      sources: database.prepare(`
        SELECT source_path, corpus_id, title, source_sha256, source_bytes
        FROM source_files ORDER BY source_path COLLATE BINARY
      `).all(),
      documents: database.prepare(`
        SELECT document_rowid, source_path, document_id, document_ordinal,
               title, author, publisher, document_date, metadata_json
        FROM documents ORDER BY source_path COLLATE BINARY, document_ordinal
      `).all(),
      paragraphs: database.prepare(`
        SELECT p.paragraph_rowid, p.document_rowid, d.source_path,
               d.document_ordinal, p.paragraph_id, p.ordinal, p.form
        FROM paragraphs AS p
        JOIN documents AS d ON d.document_rowid = p.document_rowid
        ORDER BY d.source_path COLLATE BINARY, d.document_ordinal, p.ordinal
      `).all(),
    };
  } finally {
    database.close();
  }
}

test('runtime reports FTS5 trigram availability with a useful error', () => {
  if (hasFts5Trigram) {
    assert.doesNotThrow(assertFts5TrigramSupport);
  } else {
    assert.match(
      fts5TrigramError.message,
      /requires SQLite FTS5 with the trigram tokenizer \(SQLite [^)]+\):/u,
    );
  }
});

test('valid sources build positional rows, metadata joins, and a trigram FTS index', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const { outputPath, summary } = await buildFixtureIndex(directory, corpusDirectory);
  const database = new DatabaseSync(outputPath, { readOnly: true });
  try {
    assert.equal(summary.source_count, 2);
    assert.equal(summary.document_count, 3);
    assert.equal(summary.paragraph_count, 5);
    assert.match(summary.input_manifest_sha256, /^[a-f0-9]{64}$/u);
    assert.match(summary.logical_rows_sha256, /^[a-f0-9]{64}$/u);

    const source = database.prepare(`
      SELECT source_path, corpus_id, title, year, category,
             annotation_level_json, source_sha256, source_bytes
      FROM source_files
      WHERE source_path = 'nested/a-source.json'
    `).get();
    assert.equal(source.corpus_id, 'same-corpus-id');
    assert.equal(source.title, 'A synthetic source');
    assert.equal(source.annotation_level_json, '"raw"');
    assert.match(source.source_sha256, /^[a-f0-9]{64}$/u);
    assert.ok(source.source_bytes > 0);

    const ftsSql = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'paragraph_fts'
    `).get().sql;
    assert.match(ftsSql, /content='paragraphs'/u);
    assert.match(ftsSql, /content_rowid='paragraph_rowid'/u);
    assert.match(ftsSql, /tokenize='trigram'/u);

    const metadata = Object.fromEntries(database.prepare(
      'SELECT key, value FROM index_metadata',
    ).all().map(({ key, value }) => [key, value]));
    assert.equal(metadata.schema_version, '1');
    assert.equal(metadata.builder_version, '1');
    assert.equal(metadata.source_count, '2');
    assert.equal(metadata.document_count, '3');
    assert.equal(metadata.paragraph_count, '5');
    assert.equal(metadata.input_manifest_sha256, summary.input_manifest_sha256);
    assert.equal(metadata.logical_rows_sha256, summary.logical_rows_sha256);
  } finally {
    database.close();
  }
});

test('three-character FTS and one/two-character fallbacks return literal matches in source order', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const { outputPath } = await buildFixtureIndex(directory, corpusDirectory);

  const trigramHits = searchCorpusIndex({ databasePath: outputPath, query: '바람빛' });
  assert.deepEqual(
    trigramHits.map((row) => [row.source_path, row.document_ordinal, row.paragraph_ordinal]),
    [
      ['nested/a-source.json', 0, 0],
      ['z-source.json', 0, 0],
    ],
  );
  assert.equal(trigramHits[0].source_title, 'A synthetic source');
  assert.equal(trigramHits[0].document_title, 'A first document');
  assert.equal(trigramHits[0].author, 'Another fixture author');
  assert.equal(trigramHits[0].form, '바람빛으로 짧은 글을 쓴다');
  assert.equal(Object.hasOwn(trigramHits[0], 'candidate'), false);

  const oneCharacterHits = searchCorpusIndex({ databasePath: outputPath, query: '빛' });
  assert.deepEqual(
    oneCharacterHits.map((row) => [row.source_path, row.document_ordinal, row.paragraph_ordinal]),
    [
      ['nested/a-source.json', 0, 0],
      ['z-source.json', 0, 0],
      ['z-source.json', 0, 1],
      ['z-source.json', 1, 1],
    ],
  );
  assert.equal(
    searchCorpusIndex({ databasePath: outputPath, query: '강물' }).length,
    1,
  );
  assert.deepEqual(
    searchCorpusIndex({ databasePath: outputPath, query: '없는표현' }),
    [],
  );
});

test('repeated source, document, and paragraph IDs remain separate positional evidence rows', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const { outputPath } = await buildFixtureIndex(directory, corpusDirectory);

  const hits = searchCorpusIndex({ databasePath: outputPath, query: '바람 속' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source_path, 'z-source.json');
  assert.equal(hits[0].document_id, 'repeated-document-id');
  assert.equal(hits[0].document_ordinal, 1);
  assert.equal(hits[0].paragraph_id, 'repeated-paragraph-id');
  assert.equal(hits[0].paragraph_ordinal, 0);

  const repeatedIdHits = searchCorpusIndex({ databasePath: outputPath, query: '바람' })
    .filter((row) => row.source_path === 'z-source.json');
  assert.deepEqual(
    repeatedIdHits.map((row) => [
      row.document_id,
      row.document_ordinal,
      row.paragraph_id,
      row.paragraph_ordinal,
    ]),
    [
      ['repeated-document-id', 0, 'repeated-paragraph-id', 0],
      ['repeated-document-id', 1, 'repeated-paragraph-id', 0],
    ],
  );
  assert.notEqual(repeatedIdHits[0].document_rowid, repeatedIdHits[1].document_rowid);
  assert.notEqual(repeatedIdHits[0].paragraph_rowid, repeatedIdHits[1].paragraph_rowid);
});

test('unsupported input fails closed with its relative source and field path', async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = path.join(directory, 'corpus');
  await writeSource(corpusDirectory, 'broken.json', {
    ...makeSource(),
    document: [{
      id: 'bad-document',
      metadata: {},
      paragraph: 'not-an-array',
    }],
  });

  await assert.rejects(
    auditCorpus({ inputDirectory: corpusDirectory }),
    /broken\.json: \$\.document\[0\]\.paragraph: expected an array/u,
  );
});

test('source edits and deletions change the sorted input manifest digest', async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const initial = await auditCorpus({ inputDirectory: corpusDirectory });

  const changedSource = makeSource({
    id: 'changed-corpus-id',
    title: 'Changed synthetic source',
    documents: [],
  });
  await writeSource(corpusDirectory, 'nested/a-source.json', changedSource);
  const changed = await auditCorpus({ inputDirectory: corpusDirectory });
  assert.notEqual(changed.input_manifest_sha256, initial.input_manifest_sha256);

  await rm(path.join(corpusDirectory, 'z-source.json'));
  const deleted = await auditCorpus({ inputDirectory: corpusDirectory });
  assert.notEqual(deleted.input_manifest_sha256, changed.input_manifest_sha256);
  assert.equal(deleted.source_count, 1);
});

test('identical fixture rebuilds produce identical sorted rows and logical digests', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const first = await buildFixtureIndex(directory, corpusDirectory);
  const secondPath = path.join(directory, 'indexes', 'second.sqlite');
  const second = await buildCorpusIndex({
    inputDirectory: corpusDirectory,
    outputPath: secondPath,
  });

  assert.equal(first.summary.input_manifest_sha256, second.input_manifest_sha256);
  assert.equal(first.summary.logical_rows_sha256, second.logical_rows_sha256);
  assert.deepEqual(readLogicalRows(first.outputPath), readLogicalRows(secondPath));
});

test('failed build leaves an existing valid target index untouched', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const validCorpus = await makeCorpus(directory);
  const { outputPath } = await buildFixtureIndex(directory, validCorpus);
  const originalIndexBytes = await readFile(outputPath);

  const malformedCorpus = path.join(directory, 'malformed-corpus');
  await writeSource(malformedCorpus, 'bad.json', { id: 'missing-fields' });
  await assert.rejects(
    buildCorpusIndex({ inputDirectory: malformedCorpus, outputPath }),
    /bad\.json: \$\.metadata: expected an object/u,
  );

  assert.deepEqual(await readFile(outputPath), originalIndexBytes);
});

test('build refuses to place SQLite output inside the raw source directory', async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const sourcePath = path.join(corpusDirectory, 'z-source.json');
  const originalSourceBytes = await readFile(sourcePath);

  await assert.rejects(
    buildCorpusIndex({
      inputDirectory: corpusDirectory,
      outputPath: sourcePath,
    }),
    /SQLite output must be outside the corpus input directory/u,
  );

  assert.deepEqual(await readFile(sourcePath), originalSourceBytes);
});

test('repository-local SQLite output is restricted to the ignored reference index directory', async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const publicOutputPath = path.join(REPOSITORY_DIRECTORY, 'public', 'leak.sqlite');

  await assert.rejects(
    buildCorpusIndex({
      inputDirectory: corpusDirectory,
      outputPath: publicOutputPath,
    }),
    /Repository-local SQLite output is restricted to .*data[\\/]reference[\\/]indexes/u,
  );
});

test('permission record blocks pending terms and accepts the stated reference scope', async () => {
  const directory = await makeTemporaryDirectory();
  const permissionRecordPath = path.join(directory, 'permission-review.md');

  await writeFile(permissionRecordPath, [
    '- Intended role: reference',
    '- Decision: pending',
  ].join('\n'));
  await assert.rejects(
    assertCorpusPermission({ permissionRecordPath }),
    /disabled until .*records a permitted decision/u,
  );

  await writeFile(permissionRecordPath, [
    '- Intended role: reference',
    '- Decision: permitted for stated role',
  ].join('\n'));
  await assert.doesNotReject(
    assertCorpusPermission({ permissionRecordPath }),
  );
});

test('a literal quote is safely searched through the trigram phrase path', {
  skip: hasFts5Trigram ? false : fts5TrigramError.message,
}, async () => {
  const directory = await makeTemporaryDirectory();
  const corpusDirectory = await makeCorpus(directory);
  const { outputPath } = await buildFixtureIndex(directory, corpusDirectory);
  const hits = searchCorpusIndex({ databasePath: outputPath, query: '빛"표현' });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].paragraph_id, 'quoted-paragraph');
});

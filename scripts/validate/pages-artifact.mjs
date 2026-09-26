import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { PRODUCT_LEGAL_FILES } from './product-output-contract.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const PAGES_BASE_PATH = '/typewriter/';
const ASSET_PATTERN = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u;
const CHUNK_PATTERN = /^chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/u;
const ALLOWED_DIRECTORIES = new Set(['about', 'assets', 'chunks', 'runtime', 'runtime/vendor']);
const ALLOWED_FILES = new Set([
  'index.html',
  'about/index.html',
  'favicon.ico',
  'dictionary.sqlite',
  'runtime/dictionary-worker.mjs',
  'runtime/protocol.js',
  'runtime/query-adapter.js',
  'runtime/search-query.js',
  'runtime/sqlite-query.js',
  'runtime/vendor/sqlite3.mjs',
  'runtime/vendor/sqlite3.wasm',
  ...PRODUCT_LEGAL_FILES,
]);
const REQUIRED_FILES = new Set([
  ...ALLOWED_FILES,
]);

export class PagesArtifactError extends Error {
  constructor(message, code = 'PAGES_ARTIFACT_ERROR') {
    super(message);
    this.name = 'PagesArtifactError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new PagesArtifactError(message, code);
}

function isAllowedFile(relativePath) {
  return ALLOWED_FILES.has(relativePath)
    || ASSET_PATTERN.test(relativePath)
    || CHUNK_PATTERN.test(relativePath);
}

function currentGitRevision(repositoryDirectory) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryDirectory,
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    fail(
      'could not resolve the Pages source revision: ' + (error.stderr || error.message).trim(),
      'PAGES_ARTIFACT_SOURCE_REVISION',
    );
  }
}

async function collectArtifactFiles(outputDirectory, relativeDirectory = '', result = { files: [], directories: [] }) {
  if (!relativeDirectory) {
    let rootStat;
    try {
      rootStat = await lstat(outputDirectory);
    } catch (error) {
      fail('could not inspect Pages artifact directory ' + outputDirectory + ': ' + error.message, 'PAGES_ARTIFACT_DIRECTORY');
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail('Pages artifact root must be a real directory.', 'PAGES_ARTIFACT_DIRECTORY');
    }
  }
  let entries;
  try {
    entries = await readdir(path.join(outputDirectory, relativeDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    fail(
      'could not read Pages artifact directory ' + outputDirectory + ': ' + error.message,
      'PAGES_ARTIFACT_DIRECTORY',
    );
  }

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      fail('Pages artifact contains a symbolic link: ' + relativePath, 'PAGES_ARTIFACT_SYMLINK');
    }
    if (entry.isDirectory()) {
      if (!ALLOWED_DIRECTORIES.has(relativePath)) {
        fail('Pages artifact contains an unapproved directory: ' + relativePath, 'PAGES_ARTIFACT_DIRECTORY');
      }
      result.directories.push(relativePath);
      await collectArtifactFiles(outputDirectory, relativePath, result);
      continue;
    }
    if (!entry.isFile()) {
      fail('Pages artifact contains a non-regular entry: ' + relativePath, 'PAGES_ARTIFACT_FILE_TYPE');
    }
    const fileStat = await lstat(path.join(outputDirectory, relativePath));
    if (fileStat.nlink > 1) {
      fail('Pages artifact contains a hard link: ' + relativePath, 'PAGES_ARTIFACT_HARDLINK');
    }
    if (!isAllowedFile(relativePath)) {
      fail('Pages artifact contains an unapproved file: ' + relativePath, 'PAGES_ARTIFACT_FILE');
    }
    result.files.push(relativePath);
  }

  return result;
}

function assertRequiredFiles(files) {
  const fileSet = new Set(files);
  const missingFiles = [...REQUIRED_FILES].filter((filePath) => !fileSet.has(filePath));
  if (missingFiles.length > 0) {
    fail(
      'Pages artifact is missing required files: ' + missingFiles.join(', '),
      'PAGES_ARTIFACT_REQUIRED_FILE',
    );
  }

  const javascriptAssets = files.filter((filePath) => (
    ASSET_PATTERN.test(filePath) && filePath.endsWith('.js')
  ));
  const stylesheetAssets = files.filter((filePath) => (
    ASSET_PATTERN.test(filePath) && filePath.endsWith('.css')
  ));
  if (javascriptAssets.length === 0 || stylesheetAssets.length === 0) {
    fail(
      'Pages artifact must include hashed JavaScript and CSS bundles under assets/.',
      'PAGES_ARTIFACT_ASSET_COUNT',
    );
  }
}

async function validateHtmlAssetPaths(outputDirectory, files) {
  const fileSet = new Set(files);

  for (const htmlPath of ['index.html', 'about/index.html']) {
    const html = await readFile(path.join(outputDirectory, htmlPath), 'utf8');
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)]
      .map(([, reference]) => reference);

    if (!references.includes(PAGES_BASE_PATH + 'favicon.ico')) {
      fail(
        `Pages ${htmlPath} must resolve favicon.ico under ${PAGES_BASE_PATH}`,
        'PAGES_ARTIFACT_BASE_PATH',
      );
    }

    for (const reference of references) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)) {
        fail(`Pages ${htmlPath} must not load remote assets: ${reference}`, 'PAGES_ARTIFACT_REMOTE_ASSET');
      }
      if (reference.startsWith('/') && !reference.startsWith(PAGES_BASE_PATH)) {
        fail(
          `Pages ${htmlPath} contains an absolute path outside ${PAGES_BASE_PATH}: ${reference}`,
          'PAGES_ARTIFACT_BASE_PATH',
        );
      }
      if (reference.startsWith(PAGES_BASE_PATH)) {
        const pathname = new URL(reference, 'https://typewriter.invalid').pathname;
        const relativePath = pathname.slice(PAGES_BASE_PATH.length);
        if (!fileSet.has(relativePath)) {
          fail(
            `Pages ${htmlPath} references a missing artifact file: ${relativePath}`,
            'PAGES_ARTIFACT_HTML_REFERENCE',
          );
        }
      }
    }

    if (!references.some((reference) => (
      reference.startsWith(PAGES_BASE_PATH + 'assets/') && reference.endsWith('.js')
    ))) {
      fail(`Pages ${htmlPath} must load a JavaScript bundle under the Pages base path.`, 'PAGES_ARTIFACT_BASE_PATH');
    }
    if (!references.some((reference) => (
      reference.startsWith(PAGES_BASE_PATH + 'assets/') && reference.endsWith('.css')
    ))) {
      fail(`Pages ${htmlPath} must load a CSS bundle under the Pages base path.`, 'PAGES_ARTIFACT_BASE_PATH');
    }
  }
}

async function validateFavicon(repositoryDirectory, outputDirectory) {
  const [source, shipped] = await Promise.all([
    readFile(path.join(repositoryDirectory, 'public/favicon.ico')),
    readFile(path.join(outputDirectory, 'favicon.ico')),
  ]);
  if (!source.equals(shipped)) {
    fail(
      'favicon.ico in the Pages artifact must match public/favicon.ico.',
      'PAGES_ARTIFACT_FAVICON',
    );
  }
}

async function validateLegalFiles(repositoryDirectory, outputDirectory) {
  for (const fileName of PRODUCT_LEGAL_FILES) {
    const [source, shipped] = await Promise.all([
      readFile(path.join(repositoryDirectory, fileName)),
      readFile(path.join(outputDirectory, fileName)),
    ]);
    if (!source.equals(shipped)) {
      fail(fileName + ' in the Pages artifact must match the repository source.', 'PAGES_ARTIFACT_LEGAL_FILE');
    }
  }
}

function readDatabaseMetadata(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') {
      fail('Pages dictionary failed SQLite integrity_check.', 'PAGES_ARTIFACT_SQLITE');
    }
    const rows = database.prepare('SELECT key, value FROM metadata ORDER BY key').all();
    return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  } catch (error) {
    if (error instanceof PagesArtifactError) throw error;
    fail('Pages dictionary metadata could not be read: ' + error.message, 'PAGES_ARTIFACT_SQLITE');
  } finally {
    database?.close();
  }
}

function assertDatabaseMetadata(metadata, expectedSourceRevision, expectedCanonicalRevision) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSourceRevision)) {
    fail('expected source revision must be a full Git SHA.', 'PAGES_ARTIFACT_SOURCE_REVISION');
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedCanonicalRevision)) {
    fail('expected canonical revision must be a SHA-256 digest.', 'PAGES_ARTIFACT_CANONICAL_REVISION');
  }
  if (metadata.source_revision !== expectedSourceRevision
    || metadata.source_revision_source !== 'git-head'
    || metadata.source_revision_verified !== 'true'
    || metadata.worktree_state !== 'clean') {
    fail(
      'Pages dictionary provenance must bind to the exact clean Git source revision.',
      'PAGES_ARTIFACT_SOURCE_REVISION',
    );
  }
  if (metadata.canonical_revision !== expectedCanonicalRevision) {
    fail(
      'Pages dictionary canonical revision does not match the current canonical inputs.',
      'PAGES_ARTIFACT_CANONICAL_REVISION',
    );
  }
}

export async function validatePagesArtifact({
  outputDirectory = path.join(REPOSITORY_DIRECTORY, 'dist-web'),
  repositoryDirectory = REPOSITORY_DIRECTORY,
  canonicalDirectory = path.join(REPOSITORY_DIRECTORY, 'data/canonical'),
  expectedSourceRevision,
  expectedCanonicalRevision,
} = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const resolvedRepositoryDirectory = path.resolve(repositoryDirectory);
  const [fileInventory, canonicalContext] = await Promise.all([
    collectArtifactFiles(resolvedOutputDirectory),
    expectedCanonicalRevision
      ? Promise.resolve(null)
      : loadCanonicalContext({ directory: canonicalDirectory, contextPath: null }),
  ]);
  const expectedGitRevision = expectedSourceRevision
    ?? currentGitRevision(resolvedRepositoryDirectory);
  const expectedCanonicalDigest = expectedCanonicalRevision
    ?? canonicalContext.canonicalRevision;

  assertRequiredFiles(fileInventory.files);
  await validateHtmlAssetPaths(resolvedOutputDirectory, fileInventory.files);
  await validateFavicon(resolvedRepositoryDirectory, resolvedOutputDirectory);
  await validateLegalFiles(resolvedRepositoryDirectory, resolvedOutputDirectory);
  const metadata = readDatabaseMetadata(path.join(resolvedOutputDirectory, 'dictionary.sqlite'));
  assertDatabaseMetadata(metadata, expectedGitRevision, expectedCanonicalDigest);

  return {
    fileCount: fileInventory.files.length,
    sourceRevision: metadata.source_revision,
    canonicalRevision: metadata.canonical_revision,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expectedSourceRevision = process.env.TYPEWRITER_EXPECTED_SOURCE_REVISION || undefined;
  const result = await validatePagesArtifact({ expectedSourceRevision });
  console.log(
    'Pages artifact contract passed: '
      + result.fileCount
      + ' allowlisted files; source='
      + result.sourceRevision
      + '; canonical='
      + result.canonicalRevision
      + '.',
  );
}

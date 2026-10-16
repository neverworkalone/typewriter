import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { PRODUCT_LEGAL_FILES } from './product-output-contract.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const PAGES_BASE_PATH = '/typewriter/';
export const PAGES_BUILD_INFO_FILE = 'pages-build-info.json';
export const PAGES_BUILD_INFO_SCHEMA = 'typewriter-pages-build-info/1';
const ASSET_PATTERN = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u;
const IMAGE_ASSET_PATTERN = /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:jpg|png)$/u;
const CHUNK_PATTERN = /^chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/u;
const ALLOWED_DIRECTORIES = new Set(['about', 'assets', 'chunks']);
const ALLOWED_FILES = new Set([
  'index.html',
  'about/index.html',
  'favicon.ico',
  PAGES_BUILD_INFO_FILE,
  ...PRODUCT_LEGAL_FILES,
]);
const REQUIRED_FILES = new Set(ALLOWED_FILES);
const HTML_PAGES = ['index.html', 'about/index.html'];
const SCRIPT_PAGES = ['index.html'];

// The Pages product is a static landing page: the dictionary and its search
// runtime live only in the Chrome Extension package.
const DICTIONARY_RUNTIME_FILE_PATTERN = /(?:^|\/)(?:runtime|vendor)(?:\/|$)|\.(?:sqlite3?|db|wasm)$|dictionary-(?:worker|background|host|build-info|contract|validation)|(?:^|\/)sqlite3\./u;
const DICTIONARY_RUNTIME_BUNDLE_PATTERN = /dictionary\.sqlite|sqlite3\.wasm|sqlite3Worker1|@sqlite\.org|dictionary-worker|DictionaryRuntime/u;

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
    || IMAGE_ASSET_PATTERN.test(relativePath)
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
    if (DICTIONARY_RUNTIME_FILE_PATTERN.test(relativePath)) {
      fail(
        'Pages artifact must not contain the dictionary database or search runtime: ' + relativePath,
        'PAGES_ARTIFACT_DICTIONARY_RUNTIME',
      );
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

  const hasAsset = (extension) => files.some((filePath) => (
    ASSET_PATTERN.test(filePath) && filePath.endsWith(extension)
  ));
  if (!hasAsset('.js') || !hasAsset('.css')) {
    fail(
      'Pages artifact must include hashed JavaScript and CSS bundles under assets/.',
      'PAGES_ARTIFACT_ASSET_COUNT',
    );
  }
}

function resolveArtifactReference(htmlPath, reference) {
  const pageUrl = new URL(PAGES_BASE_PATH + htmlPath, 'https://typewriter.invalid');
  const resolved = new URL(reference, pageUrl);
  if (resolved.origin !== pageUrl.origin) return { external: true };
  if (!resolved.pathname.startsWith(PAGES_BASE_PATH)) return { outside: resolved.pathname };
  let relativePath = resolved.pathname.slice(PAGES_BASE_PATH.length);
  if (relativePath === '' || relativePath.endsWith('/')) relativePath += 'index.html';
  return { relativePath };
}

async function validateHtmlPages(outputDirectory, files) {
  const fileSet = new Set(files);
  const initialLoadFiles = new Set();

  for (const htmlPath of HTML_PAGES) {
    const html = await readFile(path.join(outputDirectory, htmlPath), 'utf8');
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)]
      .map(([, reference]) => reference);
    const loadsScript = SCRIPT_PAGES.includes(htmlPath);
    if (htmlPath === 'index.html') initialLoadFiles.add(htmlPath);

    if (!references.some((reference) => reference.endsWith('favicon.ico')
      && resolveArtifactReference(htmlPath, reference).relativePath === 'favicon.ico')) {
      fail(
        `Pages ${htmlPath} must resolve favicon.ico under ${PAGES_BASE_PATH}`,
        'PAGES_ARTIFACT_BASE_PATH',
      );
    }

    for (const reference of references) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)) {
        fail(`Pages ${htmlPath} must not load remote assets: ${reference}`, 'PAGES_ARTIFACT_REMOTE_ASSET');
      }
      if (reference.startsWith('#')) continue;
      const target = resolveArtifactReference(htmlPath, reference);
      if (target.outside) {
        fail(
          `Pages ${htmlPath} contains a path outside ${PAGES_BASE_PATH}: ${reference}`,
          'PAGES_ARTIFACT_BASE_PATH',
        );
      }
      if (!fileSet.has(target.relativePath)) {
        fail(
          `Pages ${htmlPath} references a missing artifact file: ${target.relativePath}`,
          'PAGES_ARTIFACT_HTML_REFERENCE',
        );
      }
      if (htmlPath === 'index.html') initialLoadFiles.add(target.relativePath);
    }

    if (loadsScript) {
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

    if (htmlPath === 'about/index.html') {
      const refresh = html.match(/<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*?url=([^"]+)"/iu);
      const target = refresh ? resolveArtifactReference(htmlPath, refresh[1]) : null;
      if (target?.relativePath !== 'index.html') {
        fail(
          'Pages about/index.html must redirect to the landing page under the Pages base path.',
          'PAGES_ARTIFACT_ABOUT_REDIRECT',
        );
      }
    }
  }

  return initialLoadFiles;
}

async function validateNoDictionaryRuntimeInBundles(outputDirectory, files) {
  for (const filePath of files) {
    if (!ASSET_PATTERN.test(filePath) && !CHUNK_PATTERN.test(filePath)) continue;
    const content = await readFile(path.join(outputDirectory, filePath), 'utf8');
    if (DICTIONARY_RUNTIME_BUNDLE_PATTERN.test(content)) {
      fail(
        'Pages bundle must not include the dictionary search runtime: ' + filePath,
        'PAGES_ARTIFACT_DICTIONARY_RUNTIME',
      );
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

async function readBuildInfo(outputDirectory, expectedSourceRevision) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSourceRevision)) {
    fail('expected source revision must be a full Git SHA.', 'PAGES_ARTIFACT_SOURCE_REVISION');
  }
  let info;
  try {
    info = JSON.parse(await readFile(path.join(outputDirectory, PAGES_BUILD_INFO_FILE), 'utf8'));
  } catch (error) {
    fail('Pages build info could not be read: ' + error.message, 'PAGES_ARTIFACT_SOURCE_REVISION');
  }
  if (info?.schema !== PAGES_BUILD_INFO_SCHEMA
    || info.source_revision !== expectedSourceRevision
    || info.source_revision_source !== 'git-head'
    || info.source_revision_verified !== 'true'
    || info.worktree_state !== 'clean') {
    fail(
      'Pages build info must bind to the exact clean Git source revision.',
      'PAGES_ARTIFACT_SOURCE_REVISION',
    );
  }
  if (info.base_path !== PAGES_BASE_PATH) {
    fail(`Pages build info base path must be ${PAGES_BASE_PATH}`, 'PAGES_ARTIFACT_BASE_PATH');
  }
  return info;
}

async function measureArtifact(outputDirectory, files, initialLoadFiles) {
  const measure = async (filePaths) => {
    let bytes = 0;
    let gzipBytes = 0;
    for (const filePath of filePaths) {
      const content = await readFile(path.join(outputDirectory, filePath));
      bytes += content.length;
      gzipBytes += gzipSync(content).length;
    }
    return { bytes, gzipBytes };
  };
  const [total, initialLoad] = await Promise.all([
    measure(files),
    measure([...initialLoadFiles]),
  ]);
  return { total, initialLoad };
}

export async function validatePagesArtifact({
  outputDirectory = path.join(REPOSITORY_DIRECTORY, 'dist-web'),
  repositoryDirectory = REPOSITORY_DIRECTORY,
  expectedSourceRevision,
} = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const resolvedRepositoryDirectory = path.resolve(repositoryDirectory);
  const fileInventory = await collectArtifactFiles(resolvedOutputDirectory);
  const expectedGitRevision = expectedSourceRevision
    ?? currentGitRevision(resolvedRepositoryDirectory);

  assertRequiredFiles(fileInventory.files);
  const initialLoadFiles = await validateHtmlPages(resolvedOutputDirectory, fileInventory.files);
  await validateNoDictionaryRuntimeInBundles(resolvedOutputDirectory, fileInventory.files);
  await validateFavicon(resolvedRepositoryDirectory, resolvedOutputDirectory);
  await validateLegalFiles(resolvedRepositoryDirectory, resolvedOutputDirectory);
  const buildInfo = await readBuildInfo(resolvedOutputDirectory, expectedGitRevision);
  const sizes = await measureArtifact(
    resolvedOutputDirectory,
    fileInventory.files,
    initialLoadFiles,
  );

  return {
    fileCount: fileInventory.files.length,
    sourceRevision: buildInfo.source_revision,
    sizes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expectedSourceRevision = process.env.TYPEWRITER_EXPECTED_SOURCE_REVISION || undefined;
  const result = await validatePagesArtifact({ expectedSourceRevision });
  console.log(
    'Pages artifact contract passed: '
      + result.fileCount
      + ' allowlisted static files; source='
      + result.sourceRevision
      + '; artifact='
      + result.sizes.total.bytes
      + ' B ('
      + result.sizes.total.gzipBytes
      + ' B gzip); initial load='
      + result.sizes.initialLoad.bytes
      + ' B ('
      + result.sizes.initialLoad.gzipBytes
      + ' B gzip).',
  );
}

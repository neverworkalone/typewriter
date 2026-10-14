import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildDictionary, DICTIONARY_VERSION } from '../build/dictionary.mjs';
import { BUILD_TOOL_VERSION } from '../build/provenance.mjs';
import { SQLITE_SCHEMA_VERSION } from '../build/sqlite-schema.mjs';
import { NORMALIZATION_VERSION } from '../normalize/canonical.mjs';
import {
  DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST,
  DEFAULT_SURFACE_FORM_REVIEW_MANIFEST,
  SURFACE_FORM_PROJECTION_VERSION,
} from '../inflection/surface-form-projection.mjs';
import { assertWithinDirectory, resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

export const CANONICAL_DICTIONARY_CACHE_CONTRACT = 'stage1-canonical-dictionary-cache-v1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export const canonicalDictionaryCacheKey = (identity) => sha256(JSON.stringify(identity));

// A repository with no canonical data yet (zero-data state) has no directory to list.
const namesIn = (directory) => readdir(directory).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});

async function canonicalSnapshotSha256(repositoryDirectory) {
  const directory = path.join(repositoryDirectory, 'data/canonical');
  const names = (await namesIn(directory)).filter((name) => name.endsWith('.jsonl')).sort(compare);
  const parts = [];
  for (const name of names) parts.push([name, sha256(await readFile(path.join(directory, name)))]);
  return sha256(JSON.stringify(parts));
}

async function sourceFilesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFilesUnder(file));
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name) && !entry.name.endsWith('.test.mjs')) files.push(file);
  }
  return files;
}

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

async function builderSourceSha256(repositoryDirectory) {
  const files = [
    ...await sourceFilesUnder(path.join(repositoryDirectory, 'scripts/build')),
    ...await sourceFilesUnder(path.join(repositoryDirectory, 'scripts/normalize')),
    ...await sourceFilesUnder(path.join(repositoryDirectory, 'scripts/inflection')),
    ...await sourceFilesUnder(path.join(repositoryDirectory, 'scripts/validate')),
    ...['scripts/factory/relation-corrections.mjs', 'scripts/factory/relation-amendments.mjs',
      'scripts/batch/authored-semantic-decision-source.mjs', 'scripts/lib/sharded-json.mjs']
      .map((name) => path.join(repositoryDirectory, name)),
    ...await sourceFilesUnder(path.join(repositoryDirectory, 'src/runtime')),
    ...['schema/canonical-record.schema.json', 'package.json', 'pnpm-lock.yaml']
      .map((name) => path.join(repositoryDirectory, name)),
  ].sort(compare);
  const parts = [];
  for (const file of files) parts.push([path.relative(repositoryDirectory, file).split(path.sep).join('/'), sha256(await readFile(file))]);
  return sha256(JSON.stringify(parts));
}

async function canonicalBuildInputSha256(repositoryDirectory) {
  const validationDirectory = path.join(repositoryDirectory, 'data/validation/canonical-semantic-decision-source.shards');
  const batchDirectory = path.join(repositoryDirectory, 'data/batches');
  const batchNames = (await namesIn(batchDirectory)).filter((name) => name.endsWith('-semantic-decisions.json')).sort(compare);
  const files = [
    path.join(repositoryDirectory, 'data/validation/canonical-semantic-decision-source.json'),
    ...await filesUnder(validationDirectory),
    ...batchNames.map((name) => path.join(batchDirectory, name)),
  ].sort(compare);
  const parts = [];
  for (const file of files) parts.push([path.relative(repositoryDirectory, file).split(path.sep).join('/'), sha256(await readFile(file))]);
  return sha256(JSON.stringify(parts));
}

function repositoryHead(repositoryDirectory) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repositoryDirectory, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Cannot bind canonical dictionary cache to repository HEAD: ${error.message}`);
  }
}

async function cacheIdentity(repositoryDirectory) {
  const [canonicalSnapshot, builderSource, canonicalBuildInputs, exceptionBytes, reviewBytes] = await Promise.all([
    canonicalSnapshotSha256(repositoryDirectory),
    builderSourceSha256(repositoryDirectory),
    canonicalBuildInputSha256(repositoryDirectory),
    readFile(DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST),
    readFile(DEFAULT_SURFACE_FORM_REVIEW_MANIFEST),
  ]);
  return {
    canonical_snapshot_sha256: canonicalSnapshot,
    builder_source_sha256: builderSource,
    canonical_build_inputs_sha256: canonicalBuildInputs,
    exception_manifest_sha256: sha256(exceptionBytes),
    review_manifest_sha256: sha256(reviewBytes),
    repository_head: repositoryHead(repositoryDirectory),
    build_tool_version: BUILD_TOOL_VERSION,
    normalization_version: NORMALIZATION_VERSION,
    schema_version: SQLITE_SCHEMA_VERSION,
    surface_form_projection_version: SURFACE_FORM_PROJECTION_VERSION,
    dictionary_version: DICTIONARY_VERSION,
    node_version: process.version,
    node_sqlite_version: process.versions.sqlite,
    check_pilot_completeness: true,
  };
}

function assertDatabaseMetadata(metadata, identity, expectedMetadata) {
  const expected = {
    source_revision: identity.repository_head,
    build_tool_version: identity.build_tool_version,
    normalization_version: identity.normalization_version,
    schema_version: identity.schema_version,
    surface_form_projection_version: identity.surface_form_projection_version,
    dictionary_version: identity.dictionary_version,
    node_version: identity.node_version,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== String(value)) throw new Error(`Canonical dictionary cache metadata mismatch for ${key}.`);
  }
  if (expectedMetadata) {
    for (const [key, value] of Object.entries(expectedMetadata)) {
      if (metadata[key] !== value) throw new Error(`Canonical dictionary cache contents do not match manifest metadata for ${key}.`);
    }
  }
}

async function verifyCachedDictionary({ directory, cacheKey, identity }) {
  const databasePath = path.join(directory, 'dictionary.sqlite');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.contract !== CANONICAL_DICTIONARY_CACHE_CONTRACT
    || manifest.cache_key !== cacheKey
    || JSON.stringify(manifest.identity) !== JSON.stringify(identity)
    || manifest.dictionary_sha256 !== sha256(await readFile(databasePath))
    || !manifest.dictionary_metadata || typeof manifest.dictionary_metadata !== 'object') {
    throw new Error('Canonical dictionary cache is incomplete or its source binding does not match.');
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA quick_check').get();
    if (integrity?.quick_check !== 'ok') throw new Error('Canonical dictionary cache failed SQLite quick_check.');
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error('Canonical dictionary cache failed its foreign-key check.');
    const userVersion = database.prepare('PRAGMA user_version').get();
    if (userVersion?.user_version !== Number.parseInt(identity.schema_version, 10)) {
      throw new Error('Canonical dictionary cache SQLite schema version does not match its source binding.');
    }
    const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM metadata ORDER BY key').all().map(({ key, value }) => [key, value]));
    assertDatabaseMetadata(metadata, identity, manifest.dictionary_metadata);
    if (metadata.canonical_revision !== manifest.canonical_revision) {
      throw new Error('Canonical dictionary cache canonical revision does not match its manifest.');
    }
  } finally {
    database.close();
  }

  const metadata = manifest.dictionary_metadata;
  return {
    outputPath: databasePath,
    canonicalSnapshotSha256: identity.canonical_snapshot_sha256,
    cacheIdentity: identity,
    recordCount: Number(metadata.record_count),
    searchFormCount: Number(metadata.search_form_count),
    generatedSurfaceFormCount: Number(metadata.generated_surface_form_count),
    metadata,
    cacheKey,
    cacheManifestSha256: sha256(manifestBytes),
    reused: true,
  };
}

async function exists(directory) {
  try {
    await readFile(path.join(directory, 'manifest.json'));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await readdir(directory);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function loadOrBuildCanonicalDictionary({
  repositoryDirectory,
  canonicalCacheDirectory,
  cachePaths = resolveTypewriterCachePaths(),
  build = buildDictionary,
} = {}) {
  assertWithinDirectory(cachePaths.runs, canonicalCacheDirectory, { label: 'Canonical dictionary cache directory' });
  const identity = await cacheIdentity(repositoryDirectory);
  const cacheKey = canonicalDictionaryCacheKey(identity);
  const cacheRoot = path.join(canonicalCacheDirectory, 'canonical-dictionary-cache-v1');
  const targetDirectory = path.join(cacheRoot, cacheKey);
  await mkdir(cacheRoot, { recursive: true });
  assertWithinDirectory(cachePaths.runs, cacheRoot, { label: 'Canonical dictionary cache store' });

  if (await exists(targetDirectory)) return verifyCachedDictionary({ directory: targetDirectory, cacheKey, identity });

  const temporaryDirectory = await mkdtemp(path.join(cacheRoot, `.build-${cacheKey.slice(0, 12)}-`));
  try {
    const dictionary = await build({
      outputPath: path.join(temporaryDirectory, 'dictionary.sqlite'),
      repositoryDirectory,
      allowDirty: true,
    });
    const currentIdentity = await cacheIdentity(repositoryDirectory);
    if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) {
      throw new Error('Canonical dictionary inputs changed while the task cache entry was being built.');
    }
    const dictionaryMetadata = dictionary.metadata;
    assertDatabaseMetadata(dictionaryMetadata, identity);
    const databaseBytes = await readFile(path.join(temporaryDirectory, 'dictionary.sqlite'));
    const manifest = {
      contract: CANONICAL_DICTIONARY_CACHE_CONTRACT,
      cache_key: cacheKey,
      identity,
      canonical_revision: dictionaryMetadata.canonical_revision,
      dictionary_sha256: sha256(databaseBytes),
      dictionary_metadata: dictionaryMetadata,
    };
    await writeFile(path.join(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    try {
      await rename(temporaryDirectory, targetDirectory);
    } catch (error) {
      if (!await exists(targetDirectory)) throw error;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return verifyCachedDictionary({ directory: targetDirectory, cacheKey, identity }).then((result) => ({ ...result, reused: false }));
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

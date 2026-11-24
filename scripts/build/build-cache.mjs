import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileDigest, inputsMatch } from './build-inputs.mjs';

/**
 * Immutable build-cache entries (Issue #9931): `<cache>/<kind>-<id>/` holding `manifest.json` and the files it lists
 * with their sha256. An entry is written in a private temp directory and published with one `rename`; it is never
 * modified afterwards. Readers copy what they use before relying on it, so removing an entry never affects a build
 * that already took its copy, and a build that loses a race simply sees a miss.
 */
export const MANIFEST_NAME = 'manifest.json';
const KEEP_ENTRIES = 2;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

export function cacheEnabled(environment = process.env) {
  return environment.TYPEWRITER_BUILD_CACHE !== 'off';
}

/** Private scratch directory for one build: inside the cache directory when caching, else in the OS temp directory. */
export async function createWorkDirectory(cacheDirectory, enabled) {
  if (!enabled) return mkdtemp(path.join(tmpdir(), 'typewriter-build-'));
  await mkdir(cacheDirectory, { recursive: true });
  return mkdtemp(path.join(cacheDirectory, 'tmp-'));
}

async function entryDirectories(cacheDirectory, kind) {
  let names;
  try {
    names = await readdir(cacheDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.startsWith(`${kind}-`)).map((name) => path.join(cacheDirectory, name));
}

/**
 * The first entry of `kind` whose manifest satisfies `accept` and whose recorded inputs still match the working tree.
 * Unreadable or foreign manifests are skipped (a miss, never an error).
 */
export async function findEntry({ cacheDirectory, kind, root, memo, accept }) {
  for (const directory of await entryDirectories(cacheDirectory, kind)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
    } catch {
      continue;
    }
    if (!accept(manifest) || !Array.isArray(manifest.inputs) || !inputsMatch(manifest.inputs, { root, memo })) continue;
    return { directory, manifest };
  }
  return null;
}

/** sha256 of `file` against the manifest; a mismatch means a corrupted or replaced artifact. */
export async function verifyEntryFile(manifest, name, file) {
  const expected = manifest.files?.[name];
  return typeof expected === 'string' && expected === await fileDigest(file);
}

/** Mark an entry as recently used, so housekeeping keeps it. */
export async function touchEntry(directory) {
  const now = new Date();
  await utimes(directory, now, now).catch(() => {});
}

/**
 * Publish `temporaryDirectory` (already holding every listed file) as `<kind>-<id>`. Files are hashed here, after
 * the caller finished writing and verifying them. Returns false when an entry with that id already exists.
 */
export async function publishEntry({ cacheDirectory, kind, id, temporaryDirectory, manifest, fileNames }) {
  const files = {};
  for (const name of fileNames) files[name] = await fileDigest(path.join(temporaryDirectory, name));
  await writeFile(path.join(temporaryDirectory, MANIFEST_NAME), `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
  const target = path.join(cacheDirectory, `${kind}-${id}`);
  try {
    await rename(temporaryDirectory, target);
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    await rm(temporaryDirectory, { recursive: true, force: true });
    return false;
  }
  await pruneEntries(cacheDirectory, kind, target);
  return true;
}

/** Keep the newest entries of `kind` (and always `keep`); drop abandoned temp directories older than a day. */
async function pruneEntries(cacheDirectory, kind, keep) {
  const entries = [];
  for (const directory of await entryDirectories(cacheDirectory, kind)) {
    if (directory === keep) continue;
    try {
      entries.push({ directory, time: (await stat(directory)).mtimeMs });
    } catch {
      // Removed concurrently.
    }
  }
  entries.sort((left, right) => right.time - left.time);
  for (const { directory } of entries.slice(KEEP_ENTRIES - 1)) await rm(directory, { recursive: true, force: true });
  for (const directory of await entryDirectories(cacheDirectory, 'tmp')) {
    try {
      if (Date.now() - (await stat(directory)).mtimeMs > STALE_TEMP_MS) await rm(directory, { recursive: true, force: true });
    } catch {
      // Removed concurrently.
    }
  }
}

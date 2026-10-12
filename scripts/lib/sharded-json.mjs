import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Lightweight sharding for growing JSON sources. A manifest file keeps the
// logical object with each large array replaced in place (key order preserved)
// by `{ "$shards": [{ "file", "count" }] }`; each shard file is a JSON array
// stored beside the manifest. Readers get the original logical object back;
// writers rewrite only shards whose text changed. Size is a soft guideline:
// a shard rolls over to a new file once it reaches TARGET_SHARD_BYTES, or earlier
// if the next row would carry it past SOFT_SHARD_BYTES. Neither is enforced as a limit.
export const TARGET_SHARD_BYTES = 8 * 1024 * 1024;
export const SOFT_SHARD_BYTES = 10 * 1024 * 1024;
const MARKER = '$shards';

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isMarker = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value[MARKER]);

function shardDirectory(manifestPath) {
  return path.join(path.dirname(manifestPath), `${path.basename(manifestPath, '.json')}.shards`);
}

function visit(node, onMarker) {
  if (Array.isArray(node)) {
    node.forEach((child, index) => { if (isMarker(child)) node[index] = onMarker(child); else visit(child, onMarker); });
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      if (isMarker(child)) node[key] = onMarker(child); else visit(child, onMarker);
    }
  }
}

function inflate(manifest, loadText, parse = JSON.parse) {
  if (isMarker(manifest)) throw new Error('a sharded manifest cannot itself be a shard marker');
  visit(manifest, (marker) => marker[MARKER].flatMap(({ file }) => {
    const rows = parse(loadText(file));
    if (!Array.isArray(rows)) throw new Error(`shard ${file} is not a JSON array`);
    return rows;
  }));
  return manifest;
}

/** Read the logical object. A file without shard markers (legacy single file) is returned unchanged. */
export async function readShardedJson(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = new Map();
  visit(manifest, (marker) => { for (const { file } of marker[MARKER]) files.set(file, undefined); return marker; });
  for (const file of files.keys()) files.set(file, await readFile(path.join(path.dirname(manifestPath), file), 'utf8'));
  return inflate(JSON.parse(await readFile(manifestPath, 'utf8')), (file) => files.get(file));
}

export function readShardedJsonSync(manifestPath) {
  return inflate(JSON.parse(readFileSync(manifestPath, 'utf8')), (file) => readFileSync(path.join(path.dirname(manifestPath), file), 'utf8'));
}

/** Same as the file readers for text held elsewhere (for example `git show`). `loadText(relativeFile)` returns a shard's text. */
export function inflateShardedJsonText(manifestText, loadText, { parse = JSON.parse } = {}) {
  return inflate(parse(manifestText), loadText, parse);
}

function itemBytes(item) {
  return Buffer.byteLength(JSON.stringify(item, null, 2).replaceAll('\n', '\n  ')) + 4;
}

function partition(rows, previous) {
  const shards = [];
  let cursor = 0;
  for (const { count } of previous) {
    if (cursor >= rows.length) break;
    const take = Math.min(count, rows.length - cursor);
    shards.push(rows.slice(cursor, cursor + take));
    cursor += take;
  }
  let size = shards.length ? shards.at(-1).reduce((sum, row) => sum + itemBytes(row), 0) : 0;
  for (; cursor < rows.length; cursor += 1) {
    const bytes = itemBytes(rows[cursor]);
    if (!shards.length || (shards.at(-1).length && (size >= TARGET_SHARD_BYTES || size + bytes > SOFT_SHARD_BYTES))) { shards.push([]); size = 0; }
    shards.at(-1).push(rows[cursor]);
    size += bytes;
  }
  return shards;
}

/**
 * Plan the files for a logical object. `arrayPaths` lists the key paths (for example
 * `['authored_review', 'records']`) to shard; `name` prefixes their shard files. Rows keep their
 * existing shard (counts come from `previousManifest`), only new rows extend the last shard or add one.
 * Returns `{ manifestText, shards: Map<file, text> }` with files relative to the manifest directory.
 */
export function planShardedJson(logical, manifestPath, { arrayPaths, previousManifest } = {}) {
  const manifest = structuredClone(logical);
  const shards = new Map();
  const directory = path.basename(shardDirectory(manifestPath));
  for (const keyPath of arrayPaths) {
    const parent = keyPath.slice(0, -1).reduce((node, key) => node[key], manifest);
    const key = keyPath.at(-1);
    const rows = parent[key];
    if (!Array.isArray(rows)) throw new Error(`${keyPath.join('.')} is not an array`);
    const previous = keyPath.reduce((node, key) => node?.[key], previousManifest)?.[MARKER] ?? [];
    const name = keyPath.join('-').replaceAll('_', '-');
    parent[key] = { [MARKER]: partition(rows, previous).map((part, index) => {
      const file = `${directory}/${name}-${String(index + 1).padStart(3, '0')}.json`;
      shards.set(file, serialize(part));
      return { file, count: part.length };
    }) };
  }
  return { manifestText: serialize(manifest), shards };
}

async function readOptionalText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Plan against the manifest currently on disk and keep only the files whose text differs. */
export async function planShardedJsonChanges(logical, manifestPath, { arrayPaths }) {
  const existingText = await readOptionalText(manifestPath);
  const previousManifest = existingText === undefined ? undefined : JSON.parse(existingText);
  const { manifestText, shards } = planShardedJson(logical, manifestPath, { arrayPaths, previousManifest });
  const changed = new Map();
  for (const [file, text] of shards) {
    if (await readOptionalText(path.join(path.dirname(manifestPath), file)) !== text) changed.set(file, text);
  }
  if (existingText !== manifestText) changed.set(path.basename(manifestPath), manifestText);
  const stale = [];
  visit(structuredClone(previousManifest ?? {}), (marker) => { for (const { file } of marker[MARKER]) if (!shards.has(file)) stale.push(file); return marker; });
  return { changed, stale, manifestText };
}

/** Write only changed shards (and the manifest if it changed). Returns the changed paths relative to the manifest directory. */
export async function writeShardedJson(logical, manifestPath, { arrayPaths }) {
  const { changed, stale } = await planShardedJsonChanges(logical, manifestPath, { arrayPaths });
  const baseDirectory = path.dirname(manifestPath);
  for (const [file, text] of changed) {
    await mkdir(path.dirname(path.join(baseDirectory, file)), { recursive: true });
    await writeFile(path.join(baseDirectory, file), text, 'utf8');
  }
  for (const file of stale) await rm(path.join(baseDirectory, file), { force: true });
  return [...changed.keys()];
}

/** Bytes of the equivalent single-file serialization, so digests recorded against the legacy single file stay valid. */
export async function readShardedJsonLogicalBytes(manifestPath) {
  const raw = await readFile(manifestPath);
  if (!raw.includes(MARKER)) return raw;
  return Buffer.from(serialize(await readShardedJson(manifestPath)), 'utf8');
}

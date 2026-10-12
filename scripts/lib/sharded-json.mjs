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

// Rows keep the shard they already live in, identified by `keyOf`; a new row joins the shard of the row before it
// (the first shard if none), and only rows appended after the final shard extend it or open a new one. Shard order is
// never reversed, so concatenation always restores the logical order.
function partition(rows, previousRows, previousShards, keyOf) {
  const shardOf = new Map();
  let cursor = 0;
  previousShards.forEach(({ count }, index) => {
    for (const row of previousRows.slice(cursor, cursor + count)) shardOf.set(keyOf(row), index);
    cursor += count;
  });
  // Without any row already stored (first split, or no shared key) the layout is built fresh and rolls over by size.
  const anyKnown = rows.some((row) => shardOf.has(keyOf(row)));
  const lastPrevious = anyKnown ? previousShards.length - 1 : -1;
  const buckets = [];
  const sizes = [];
  let current = -1;
  const place = (row, index) => {
    while (buckets.length <= index) { buckets.push([]); sizes.push(0); }
    buckets[index].push(row);
    sizes[index] += itemBytes(row);
    current = index;
  };
  const pending = [];
  for (const row of rows) {
    const known = shardOf.get(keyOf(row));
    if (known === undefined) {
      if (current < 0) {
        if (anyKnown) { pending.push(row); continue; }
        place(row, 0);
        continue;
      }
      const bytes = itemBytes(row);
      const roll = current >= lastPrevious && buckets[current].length
        && (sizes[current] >= TARGET_SHARD_BYTES || sizes[current] + bytes > SOFT_SHARD_BYTES);
      place(row, roll ? current + 1 : current);
    } else {
      place(row, Math.max(known, current));
      if (pending.length) { buckets[current].unshift(...pending.splice(0)); }
    }
  }
  for (const row of pending) place(row, Math.max(current, 0));
  return buckets;
}

/**
 * Plan the files for a logical object. Each `arrays` entry is `{ path, key }`: the key path to shard (for example
 * `['authored_review', 'records']`) and `key(row)`, a stable row identity. `previous` is the logical object and manifest
 * currently stored (if any); rows keep their existing shard and only new rows extend the last shard or add one.
 * Returns `{ manifestText, shards: Map<file, text> }` with files relative to the manifest directory.
 */
export function planShardedJson(logical, manifestPath, { arrays, previous } = {}) {
  const manifest = structuredClone(logical);
  const shards = new Map();
  const directory = path.basename(shardDirectory(manifestPath));
  for (const { path: keyPath, key } of arrays) {
    const parent = keyPath.slice(0, -1).reduce((node, name) => node[name], manifest);
    const name = keyPath.join('-').replaceAll('_', '-');
    const rows = parent[keyPath.at(-1)];
    if (!Array.isArray(rows)) throw new Error(`${keyPath.join('.')} is not an array`);
    const previousShards = keyPath.reduce((node, part) => node?.[part], previous?.manifest)?.[MARKER] ?? [];
    const previousRows = keyPath.reduce((node, part) => node?.[part], previous?.logical) ?? [];
    const files = previousShards.map(({ file }) => file);
    const numberOf = (file) => Number(/-(\d+)\.json$/u.exec(file)?.[1] ?? 0);
    let next = Math.max(0, ...files.map(numberOf)) + 1;
    const entries = [];
    partition(rows, previousRows, previousShards, key).forEach((part, index) => {
      if (!part.length) return;
      const file = files[index] ?? `${directory}/${name}-${String(next++).padStart(3, '0')}.json`;
      shards.set(file, serialize(part));
      entries.push({ file, count: part.length });
    });
    parent[keyPath.at(-1)] = { [MARKER]: entries };
  }
  return { manifestText: serialize(manifest), shards };
}

async function readOptionalText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Plan against the stored files and keep only the manifest and shards whose text differs. */
export async function planShardedJsonChanges(logical, manifestPath, { arrays }) {
  const existingText = await readOptionalText(manifestPath);
  const previousManifest = existingText === undefined ? undefined : JSON.parse(existingText);
  const previous = previousManifest && { manifest: previousManifest, logical: await readShardedJson(manifestPath) };
  const { manifestText, shards } = planShardedJson(logical, manifestPath, { arrays, previous });
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
export async function writeShardedJson(logical, manifestPath, { arrays }) {
  const { changed, stale } = await planShardedJsonChanges(logical, manifestPath, { arrays });
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

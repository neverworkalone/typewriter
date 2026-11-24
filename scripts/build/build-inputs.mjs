import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Build-cache inputs (Issue #9931).
 *
 * A cache entry is keyed by two things, neither of them a Git revision:
 *   - `codeKey`: every local module the generators can execute (the real ES import graph, walked by esbuild), the JSON
 *     they `require`, the lockfile/package manifest and the Node/SQLite versions;
 *   - the data inputs the generator actually read, recorded while it ran (`traceInputs`): every file read (content
 *     hash), every directory listed (entry names, so additions/removals/renames count) and every existence probe.
 * An entry is reused only when the current state of every recorded input still matches (`inputsMatch`).
 */
export const BUILD_CACHE_VERSION = '1';

export class InputChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputChangedError';
    this.code = 'BUILD_INPUT_CHANGED';
  }
}

// Unpatched fs entry points: hashing and observation must never re-enter an active trace.
const real = {
  readFileSync: fs.readFileSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const JSON_REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+\.json)['"]\s*\)/gu;

/** Hash of the generator code and toolchain: the esbuild import graph of `entryPoints`, relative to `projectRoot`. */
export async function codeFingerprint({ projectRoot, entryPoints, extraFiles = [] }) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints,
    absWorkingDir: projectRoot,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  const files = new Set(Object.keys(result.metafile.inputs).map((file) => path.resolve(projectRoot, file)));
  for (const file of [...files]) {
    // `createRequire` JSON (schemas) is loaded outside the ES graph and outside any later read trace.
    for (const match of real.readFileSync(file, 'utf8').matchAll(JSON_REQUIRE)) files.add(path.resolve(path.dirname(file), match[1]));
  }
  for (const file of ['package.json', 'pnpm-lock.yaml', ...extraFiles]) files.add(path.resolve(projectRoot, file));
  const database = new DatabaseSync(':memory:');
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();
  const hash = createHash('sha256');
  hash.update(`cache:${BUILD_CACHE_VERSION}\0node:${process.version}\0sqlite:${sqliteVersion}\0`);
  for (const file of [...files].sort()) {
    hash.update(`${path.relative(projectRoot, file)}\0`);
    hash.update(real.existsSync(file) ? sha256(real.readFileSync(file)) : 'absent');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function directoryState(directory) {
  const names = real.readdirSync(directory, { withFileTypes: true })
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
  return sha256(names.join('\0'));
}

/** Current state of one recorded input, comparable with what the trace recorded. `memo` avoids rehashing a file. */
function observe(file, kind, memo) {
  const key = `${kind}\0${file}`;
  if (memo?.has(key)) return memo.get(key);
  let value;
  try {
    const stat = real.statSync(file);
    if (kind === 'file') value = stat.isFile() ? sha256(real.readFileSync(file)) : 'not-a-file';
    else if (kind === 'dir') value = stat.isDirectory() ? directoryState(file) : 'not-a-directory';
    else value = stat.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    value = 'absent';
  }
  memo?.set(key, value);
  return value;
}

/** True when every recorded input (`[{ path, kind, value }]`, paths relative to `root`) still has its recorded state. */
export function inputsMatch(inputs, { root, memo } = {}) {
  return inputs.every((input) => observe(path.resolve(root, input.path), input.kind, memo) === input.value);
}

/**
 * Run `callback` while recording every data input it reads under `root` (outside `exclude`). A file read twice with
 * different bytes, or any recorded input that differs once the callback is done, fails with `InputChangedError`: the
 * whole build then describes one snapshot of its inputs. Returns `{ result, inputs }`.
 */
export async function traceInputs(callback, { root, roots = [], exclude = [] }) {
  const resolvedRoot = path.resolve(root);
  // Inputs under `root` are stored relative to it; inputs under another traced root (an external fixture) absolutely.
  const tracedRoots = [resolvedRoot, ...roots.map((item) => path.resolve(item))];
  const excluded = exclude.map((item) => path.resolve(item));
  const records = new Map();
  const tracked = (target) => {
    if (typeof target !== 'string' && !(target instanceof URL)) return null;
    const resolved = path.resolve(target instanceof URL ? target.pathname : target);
    const inside = (base) => {
      const relative = path.relative(base, resolved);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    if (!tracedRoots.some(inside)) return null;
    if (excluded.some((item) => resolved === item || resolved.startsWith(`${item}${path.sep}`))) return null;
    return resolved;
  };
  const record = (file, kind, value) => {
    const key = `${kind}\0${file}`;
    const previous = records.get(key);
    if (previous !== undefined && previous !== value) {
      throw new InputChangedError(`${path.relative(resolvedRoot, file)} changed while the build was reading it`);
    }
    records.set(key, value);
  };
  const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);
  const withoutEncoding = (options) => (typeof options === 'object' && options !== null ? { ...options, encoding: null } : undefined);
  const decode = (bytes, encoding) => (encoding ? bytes.toString(encoding) : bytes);

  const original = {
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFile: fsp.readFile,
    readdir: fsp.readdir,
    stat: fsp.stat,
  };
  const recordDirectory = (file) => {
    try {
      record(file, 'dir', original.statSync(file).isDirectory() ? directoryState(file) : 'not-a-directory');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      record(file, 'dir', 'absent');
    }
  };
  const recordExists = (file) => {
    let value;
    try {
      value = original.statSync(file).isDirectory() ? 'directory' : 'file';
    } catch {
      value = 'absent';
    }
    record(file, 'exists', value);
  };

  fs.readFileSync = function readFileSync(target, options) {
    const file = tracked(target);
    if (!file) return original.readFileSync.call(fs, target, options);
    const bytes = original.readFileSync.call(fs, target, withoutEncoding(options));
    record(file, 'file', sha256(bytes));
    return decode(bytes, encodingOf(options));
  };
  fsp.readFile = async function readFile(target, options) {
    const file = tracked(target);
    if (!file) return original.readFile.call(fsp, target, options);
    const bytes = await original.readFile.call(fsp, target, withoutEncoding(options));
    record(file, 'file', sha256(bytes));
    return decode(bytes, encodingOf(options));
  };
  fs.readdirSync = function readdirSync(target, options) {
    const file = tracked(target);
    if (file) recordDirectory(file);
    return original.readdirSync.call(fs, target, options);
  };
  fsp.readdir = async function readdir(target, options) {
    const file = tracked(target);
    if (file) recordDirectory(file);
    return original.readdir.call(fsp, target, options);
  };
  fs.existsSync = function existsSync(target) {
    const file = tracked(target);
    if (file) recordExists(file);
    return original.existsSync.call(fs, target);
  };
  fs.statSync = function statSync(target, options) {
    const file = tracked(target);
    if (file) recordExists(file);
    return original.statSync.call(fs, target, options);
  };
  fsp.stat = async function stat(target, options) {
    const file = tracked(target);
    if (file) recordExists(file);
    return original.stat.call(fsp, target, options);
  };
  syncBuiltinESMExports();

  let result;
  try {
    result = await callback();
  } finally {
    Object.assign(fs, { readFileSync: original.readFileSync, readdirSync: original.readdirSync, existsSync: original.existsSync, statSync: original.statSync });
    Object.assign(fsp, { readFile: original.readFile, readdir: original.readdir, stat: original.stat });
    syncBuiltinESMExports();
  }

  const inputs = [...records].map(([key, value]) => {
    const [kind, file] = key.split('\0');
    const relative = path.relative(resolvedRoot, file);
    return { path: relative.startsWith('..') || path.isAbsolute(relative) ? file : relative, kind, value };
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : 1));
  // Snapshot: nothing the build read may have changed before its result is published.
  for (const input of inputs) {
    if (observe(path.resolve(resolvedRoot, input.path), input.kind) !== input.value) {
      throw new InputChangedError(`${input.path} changed during the build`);
    }
  }
  return { result, inputs };
}

/** Stable identity of a recorded input list. */
export function inputsDigest(inputs) {
  return sha256(inputs.map((input) => `${input.kind}\0${input.path}\0${input.value}`).join('\n'));
}

/** sha256 of a file's bytes. */
export async function fileDigest(file) {
  const hash = createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertWithinDirectory, isWithinDirectory, resolveCacheArtifactPath, resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');

function parseArguments(argv) {
  const options = { source: path.join(REPOSITORY_DIRECTORY, 'data/reference'), apply: false, move: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--move') { options.apply = true; options.move = true; }
    else if (argument === '--source') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--source requires a data/reference directory.');
      options.source = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (path.basename(options.source) !== 'reference' || path.basename(path.dirname(options.source)) !== 'data') {
    throw new Error('--source must name a worktree data/reference directory.');
  }
  return options;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertNoSymlinkComponents(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = assertWithinDirectory(absoluteRoot, candidate, { label: 'Migration destination' });
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  const components = relative ? relative.split(path.sep) : [];
  let current = absoluteRoot;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`migration refuses symlinked cache path: ${current}`);
      if (component && current !== absoluteCandidate && !stat.isDirectory()) {
        throw new Error(`migration path component is not a directory: ${current}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return absoluteCandidate;
}

async function listSourceFiles(sourceDirectory) {
  const files = [];
  const skipped = [];
  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(directory, entry.name);
      if (entry.name === '.DS_Store') {
        skipped.push({ path: childRelative, reason: 'macOS metadata file' });
        continue;
      }
      if (entry.name === '.venv' || entry.name === 'venv') {
        skipped.push({ path: childRelative, reason: 'tooling environment; not reference data' });
        continue;
      }
      const stat = await lstat(childPath);
      if (stat.isSymbolicLink()) throw new Error(`migration refuses source symlink: ${childPath}`);
      if (stat.isDirectory()) await walk(childPath, childRelative);
      else if (stat.isFile()) files.push({ path: childPath, relativePath: childRelative, size: stat.size });
      else throw new Error(`unsupported local reference entry: ${childPath}`);
    }
  }
  await walk(sourceDirectory);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return { files, skipped };
}

async function copyWithoutOverwrite(source, destination, expectedDigest, size) {
  await mkdir(path.dirname(destination), { recursive: true });
  await assertNoSymlinkComponents(path.dirname(destination), destination);
  const temporary = path.join(path.dirname(destination), `.typewriter-migrate-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const hash = createHash('sha256');
  const hashingTransform = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(source), hashingTransform, createWriteStream(temporary, { flags: 'wx' }));
    const copiedDigest = hash.digest('hex');
    const temporaryStat = await lstat(temporary);
    if (temporaryStat.size !== size || copiedDigest !== expectedDigest) {
      throw new Error(`staged copy failed digest/size verification: ${source}`);
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.size !== size || await sha256File(destination) !== expectedDigest) {
        throw new Error(`destination changed during migration and does not match source: ${destination}`);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/reference/migrate-local-reference.mjs [--source <worktree>/data/reference] [--apply] [--move]');
    console.log('Default is a read-only plan. --apply copies and verifies; --move removes the source only after full verification.');
    return;
  }

  const sourceDirectory = path.resolve(options.source);
  let sourceStat;
  try { sourceStat = await lstat(sourceDirectory); } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`No legacy data/reference directory at ${sourceDirectory}; no migration is needed.`);
      return;
    }
    throw error;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`source must be a real directory: ${sourceDirectory}`);
  const cachePaths = resolveTypewriterCachePaths();
  if (isWithinDirectory(sourceDirectory, cachePaths.root) || isWithinDirectory(cachePaths.root, sourceDirectory)) {
    throw new Error('source and shared cache must be separate directory trees');
  }

  const { files, skipped } = await listSourceFiles(sourceDirectory);
  const plan = [];
  const conflicts = [];
  for (const file of files) {
    const legacyPath = path.join('data/reference', file.relativePath);
    const destination = resolveCacheArtifactPath(legacyPath, { paths: cachePaths, label: legacyPath });
    await assertNoSymlinkComponents(cachePaths.root, destination);
    let existing;
    try { existing = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      plan.push({ ...file, destination, status: 'copy' });
      continue;
    }
    if (!existing.isFile() || existing.size !== file.size) {
      conflicts.push({ source: file.relativePath, destination, reason: 'destination exists with a different type or size' });
      continue;
    }
    const [sourceDigest, destinationDigest] = await Promise.all([sha256File(file.path), sha256File(destination)]);
    if (sourceDigest !== destinationDigest) {
      conflicts.push({ source: file.relativePath, destination, reason: 'destination digest differs' });
    } else plan.push({ ...file, destination, digest: sourceDigest, status: 'already-identical' });
  }

  const summary = {
    source: sourceDirectory,
    cache_root: cachePaths.root,
    planned_files: plan.length,
    files_to_copy: plan.filter((item) => item.status === 'copy').length,
    already_identical: plan.filter((item) => item.status === 'already-identical').length,
    bytes_to_copy: plan.filter((item) => item.status === 'copy').reduce((total, item) => total + item.size, 0),
    skipped,
    conflicts,
    apply_requested: options.apply,
    remove_source_requested: options.move,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (conflicts.length) throw new Error('migration stopped before copying because one or more destinations conflict');
  if (!options.apply) return;

  for (const item of plan.filter((entry) => entry.status === 'copy')) {
    const digest = await sha256File(item.path);
    await copyWithoutOverwrite(item.path, item.destination, digest, item.size);
    item.digest = digest;
  }
  for (const item of plan) {
    const [sourceStat, destinationStat, sourceDigest, destinationDigest] = await Promise.all([
      lstat(item.path),
      lstat(item.destination),
      sha256File(item.path),
      sha256File(item.destination),
    ]);
    if (!sourceStat.isFile() || !destinationStat.isFile()
      || sourceStat.size !== item.size || destinationStat.size !== item.size
      || sourceDigest !== item.digest || destinationDigest !== item.digest) {
      throw new Error(`post-copy verification failed; original data was retained: ${item.destination}`);
    }
  }

  console.log(`Verified ${plan.length} local reference files in ${cachePaths.root}.`);
  if (options.move) {
    const currentSource = await listSourceFiles(sourceDirectory);
    const originalInventory = files.map(({ relativePath, size }) => ({ relativePath, size }));
    const currentInventory = currentSource.files.map(({ relativePath, size }) => ({ relativePath, size }));
    if (JSON.stringify(currentInventory) !== JSON.stringify(originalInventory)) {
      throw new Error('source contents changed during migration; original data was retained');
    }
    const runtimeEnvironment = skipped.some((entry) => entry.reason === 'tooling environment; not reference data');
    if (runtimeEnvironment) throw new Error('verified reference files were copied, but source removal was skipped because a local venv needs separate handling');
    await rm(sourceDirectory, { recursive: true });
    console.log(`Removed migrated source directory ${sourceDirectory}.`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

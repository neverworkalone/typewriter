#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_NATIVE_CACHE, NATIVE_RELEASE, defaultNativeRoot } from './khaiii-provider.mjs';

// Explicit, user-invoked setup of the native Khaiii runtime (issue #273). It downloads the pinned
// `genonfire/khaiii` Release asset into the local cache (never into Git), verifies the archive
// SHA-256 and the archive's own MANIFEST.sha256, and extracts it. The provider itself never
// downloads anything at analysis time.
const cache = process.env.TYPEWRITER_KHAIII_CACHE || DEFAULT_NATIVE_CACHE;
const root = defaultNativeRoot(cache);
const archive = path.join(cache, NATIVE_RELEASE.asset);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('the native Khaiii release is macOS arm64 only; use the docker runtime');
  await mkdir(cache, { recursive: true });
  let bytes = existsSync(archive) ? await readFile(archive) : null;
  if (!bytes || sha256(bytes) !== NATIVE_RELEASE.archive_sha256) {
    const response = await fetch(NATIVE_RELEASE.url);
    if (!response.ok) throw new Error(`download failed: ${response.status} ${NATIVE_RELEASE.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== NATIVE_RELEASE.archive_sha256) throw new Error(`archive SHA-256 ${sha256(bytes)} does not match pinned ${NATIVE_RELEASE.archive_sha256}`);
    await writeFile(archive, bytes);
  }
  await rm(path.dirname(root), { recursive: true, force: true });
  await mkdir(path.dirname(root), { recursive: true });
  const untar = spawnSync('tar', ['-xzf', archive, '-C', path.dirname(root)], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`extract failed: ${untar.stderr}`);
  const manifest = spawnSync('shasum', ['-a', '256', '-c', 'MANIFEST.sha256'], { cwd: root, encoding: 'utf8' });
  if (manifest.status !== 0) throw new Error(`MANIFEST.sha256 check failed: ${manifest.stdout}${manifest.stderr}`);
  console.log(`Khaiii ${NATIVE_RELEASE.tag} native release verified and extracted to ${root}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

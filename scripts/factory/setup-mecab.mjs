#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_MECAB_CACHE, MECAB_REQUIREMENTS_PATH, PINNED_MECAB } from './mecab-provider.mjs';

// Explicit, user-invoked setup of the MeCab-ko runtime (issue #281): a fresh virtual environment in
// the local cache (never Git) populated only from the hash-pinned mecab-requirements.txt. The
// provider itself never installs or downloads anything at analysis time.
const cache = process.env.TYPEWRITER_MECAB_CACHE || DEFAULT_MECAB_CACHE;
const venv = path.join(cache, 'venv');
const base = process.env.TYPEWRITER_MECAB_BASE_PYTHON || 'python3.11';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.error?.message || '').slice(0, 400)}`);
  return result.stdout.trim();
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('the pinned MeCab-ko runtime is verified for macOS arm64 only');
  const version = run(base, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])']);
  if (version !== PINNED_MECAB.python_version) throw new Error(`${base} is Python ${version}; the pinned wheel needs CPython ${PINNED_MECAB.python_version}. Set TYPEWRITER_MECAB_BASE_PYTHON.`);
  await rm(venv, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  run(base, ['-m', 'venv', venv]);
  run(path.join(venv, 'bin', 'pip'), ['install', '--quiet', '--require-hashes', '-r', MECAB_REQUIREMENTS_PATH]);
  console.log(`MeCab-ko ${PINNED_MECAB.mecab_ko_version} + ${PINNED_MECAB.dictionary_package} ${PINNED_MECAB.dictionary_package_version} installed in ${venv} (hash-verified).`);
  console.log('Verify against the pins with: node --test tests/factory-mecab-provider.test.mjs');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

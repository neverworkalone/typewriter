#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CONTRACT_MARKER, REQUIREMENTS_PATH, checkPython, contractHash, defaultVenvDir, venvPython } from './env.mjs';

// Idempotent, user-invoked setup of the shared Typewriter Python venv (issue #336). The venv is a
// cache outside Git; scripts/python/requirements.txt remains the contract it is verified against.
const venv = defaultVenvDir();
const base = process.env.TYPEWRITER_BASE_PYTHON || 'python3';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${(result.error?.message || result.stderr || '').trim().slice(0, 600)}`);
}

function main() {
  const python = venvPython(venv);
  if (!existsSync(python)) {
    mkdirSync(path.dirname(venv), { recursive: true });
    run(base, ['-m', 'venv', venv]);
  }
  run(python, ['-m', 'pip', 'install', '--quiet', '-r', REQUIREMENTS_PATH]);
  const problems = checkPython(python, { venv: null });
  if (problems.length) throw new Error(`installed environment violates the pinned contract: ${problems.join('; ')}`);
  writeFileSync(path.join(venv, CONTRACT_MARKER), `${contractHash()}\n`);
  console.log(`Typewriter Python environment ready and verified: ${venv}`);
}

try { main(); } catch (error) { console.error(`Typewriter Python bootstrap failed: ${error.message}`); process.exitCode = 1; }

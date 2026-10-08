import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';

export const REQUIREMENTS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'requirements.txt');
export const CONTRACT_MARKER = 'typewriter-requirements.sha256';
export const BOOTSTRAP_COMMAND = 'node scripts/python/bootstrap.mjs';

// Shared per machine, never per worktree. TYPEWRITER_PYTHON_VENV relocates the venv;
// TYPEWRITER_PYTHON names an explicit interpreter and wins over the venv.
export const defaultVenvDir = (env = process.env) => path.resolve(env.TYPEWRITER_PYTHON_VENV || path.join(resolveTypewriterCachePaths({ env }).root, 'venv'));
export const venvPython = (venv) => path.join(venv, 'bin', 'python');
export const sharedPythonPath = (env = process.env) => env.TYPEWRITER_PYTHON || venvPython(defaultVenvDir(env));

const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

export function readRequirements(file = REQUIREMENTS_PATH) {
  const pins = new Map();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9._+!-]*)$/.exec(line);
    if (!match) throw new Error(`${file}: "${line}" is not an exact name==version pin`);
    pins.set(normalizeName(match[1]), { name: match[1], version: match[2] });
  }
  if (pins.size === 0) throw new Error(`${file} declares no pinned dependencies`);
  return pins;
}

export const contractHash = (file = REQUIREMENTS_PATH) => createHash('sha256').update(readFileSync(file)).digest('hex');

const LIST_PACKAGES = 'import json,importlib.metadata as m;print(json.dumps({d.metadata["Name"]:d.version for d in m.distributions()}))';

// Returns problem strings; an empty array means the interpreter satisfies the tracked contract.
export function checkPython(python, { requirements = REQUIREMENTS_PATH, venv = null } = {}) {
  if (path.isAbsolute(python) && !existsSync(python)) return [`Python not found at ${python}`];
  const run = spawnSync(python, ['-c', LIST_PACKAGES], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return [`cannot run ${python}: ${(run.error?.message || run.stderr || '').trim().slice(0, 300)}`];
  const installed = new Map(Object.entries(JSON.parse(run.stdout)).map(([name, version]) => [normalizeName(name), version]));
  const problems = [];
  for (const [key, pin] of readRequirements(requirements)) {
    const actual = installed.get(key);
    if (actual === undefined) problems.push(`${pin.name} is not installed (need ${pin.version})`);
    else if (actual !== pin.version) problems.push(`${pin.name} ${actual} does not match pinned ${pin.version}`);
  }
  if (venv) {
    const marker = path.join(venv, CONTRACT_MARKER);
    if (!existsSync(marker)) problems.push('the environment was not bootstrapped from the tracked requirements');
    else if (readFileSync(marker, 'utf8').trim() !== contractHash(requirements)) problems.push('scripts/python/requirements.txt changed since the environment was bootstrapped');
  }
  return problems;
}

// The managed Python for repository commands that need the pinned runtime. Throws, never falls back to system packages.
export function resolveManagedPython(env = process.env, options = {}) {
  const explicit = Boolean(env.TYPEWRITER_PYTHON);
  const venv = defaultVenvDir(env);
  const python = sharedPythonPath(env);
  const problems = checkPython(python, { ...options, venv: explicit ? null : venv });
  if (problems.length) {
    throw new Error(`The Typewriter Python environment (${python}) is missing or stale: ${problems.join('; ')}. Bootstrap it with: ${BOOTSTRAP_COMMAND}`);
  }
  return python;
}

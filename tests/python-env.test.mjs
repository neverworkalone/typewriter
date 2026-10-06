import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CONTRACT_MARKER, REQUIREMENTS_PATH, checkPython, contractHash, defaultVenvDir, readRequirements, resolveManagedPython, sharedPythonPath } from '../scripts/python/env.mjs';

const fakePython = (dir, packages) => {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const file = path.join(dir, 'bin', 'python');
  writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify(packages)}'\n`);
  chmodSync(file, 0o755);
  return file;
};

test('tracked contract pins Kiwi and resolves one shared location outside the repository', () => {
  const pins = readRequirements();
  assert.equal(pins.get('kiwipiepy').version, '0.24.0');
  assert.equal(pins.get('kiwipiepy-model').version, '0.24.0');
  assert.equal(defaultVenvDir({}), path.join(os.homedir(), '.cache', 'typewriter', 'venv'));
  assert.equal(sharedPythonPath({ TYPEWRITER_PYTHON_VENV: '/x/venv' }), '/x/venv/bin/python');
  assert.equal(sharedPythonPath({ TYPEWRITER_PYTHON: '/y/python' }), '/y/python');
  assert.ok(!REQUIREMENTS_PATH.includes(`${path.sep}data${path.sep}reference`));
});

test('missing, wrong-version and stale environments fail closed with the bootstrap instruction', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tw-python-'));
  const env = { TYPEWRITER_PYTHON_VENV: dir };
  assert.throws(() => resolveManagedPython(env), /scripts\/python\/bootstrap\.mjs/);

  const python = fakePython(dir, { kiwipiepy: '0.24.0', kiwipiepy_model: '0.24.0' });
  assert.deepEqual(checkPython(python), []);
  assert.match(checkPython(python, { venv: dir }).join(), /not bootstrapped/);

  writeFileSync(path.join(dir, CONTRACT_MARKER), `${contractHash()}\n`);
  assert.equal(resolveManagedPython(env), python);

  writeFileSync(path.join(dir, CONTRACT_MARKER), 'stale\n');
  assert.throws(() => resolveManagedPython(env), /changed since.*bootstrap/);

  fakePython(dir, { kiwipiepy: '0.23.0', kiwipiepy_model: '0.24.0' });
  assert.match(checkPython(python).join(), /kiwipiepy 0\.23\.0 does not match pinned 0\.24\.0/);
  fakePython(dir, { kiwipiepy: '0.24.0' });
  assert.match(checkPython(python).join(), /kiwipiepy_model is not installed/);
});

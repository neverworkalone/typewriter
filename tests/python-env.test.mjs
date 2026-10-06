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

// Default (non-injected) Kiwi/factory execution must go through the managed resolver, not just a path.
test('default Kiwi and factory Python resolution rejects a stale shared venv and accepts a valid one', async () => {
  const { createKiwiAnalyzer } = await import('../scripts/intake/kiwi-client.mjs');
  const { PROVIDER_REGISTRY } = await import('../scripts/factory/produce-candidates.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tw-python-default-'));
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const python = path.join(dir, 'bin', 'python');
  const packages = JSON.stringify({ kiwipiepy: '0.24.0', kiwipiepy_model: '0.24.0' });
  writeFileSync(python, `#!/bin/sh\nif [ "$1" = "-c" ]; then echo '${packages}'; else cat >/dev/null; echo '{"metadata":{"m":1},"results":[]}'; fi\n`);
  chmodSync(python, 0o755);
  const saved = { venv: process.env.TYPEWRITER_PYTHON_VENV, python: process.env.TYPEWRITER_PYTHON };
  process.env.TYPEWRITER_PYTHON_VENV = dir;
  delete process.env.TYPEWRITER_PYTHON;
  try {
    const request = [{ id: 'a', text: '푸르다' }];
    writeFileSync(path.join(dir, CONTRACT_MARKER), 'stale\n');
    await assert.rejects(() => createKiwiAnalyzer()(request), /scripts\/python\/bootstrap\.mjs/);
    await assert.rejects(() => PROVIDER_REGISTRY.kiwi({ python: undefined }).analyze(request), /scripts\/python\/bootstrap\.mjs/);

    writeFileSync(path.join(dir, CONTRACT_MARKER), `${contractHash()}\n`);
    assert.deepEqual((await createKiwiAnalyzer()(request)).metadata, { m: 1 });
    assert.deepEqual((await PROVIDER_REGISTRY.kiwi({ python: undefined }).analyze(request)).metadata, { m: 1 });
  } finally {
    for (const [key, name] of [['venv', 'TYPEWRITER_PYTHON_VENV'], ['python', 'TYPEWRITER_PYTHON']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
});

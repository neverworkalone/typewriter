import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve('.');
const FIXTURE = path.join(ROOT, 'tests/fixtures/validator-b16');
const B16 = 'issue-223-m9-e-corpus-batch-16-20261004';
const STEM = 'issue-223-m9-e-corpus-batch-16';

// A deterministic stand-in for the pinned kiwipiepy package (CI has no Kiwi model). It is
// installed only on PYTHONPATH of the child processes, so the REAL kiwi client, hand-off
// builder, batch builder and tracked validator all run unchanged against it.
const KIWI_STUB = `
class _Token:
    def __init__(self, form, tag):
        self.form, self.tag = form, tag

_TABLE = {
    "소년기": [([_Token("소년기", "NNG")], 0.0)],
    "청년기": [([_Token("청년기", "NNG")], 0.0)],
    "호시탐탐": [([_Token("호시탐탐", "MAG")], 0.0), ([_Token("호시탐탐", "NNG")], -1.0)],
}

class Kiwi:
    def analyze(self, text, top_n):
        return _TABLE.get(text, [])[:top_n]
`;

async function installStub(directory) {
  await mkdir(path.join(directory, 'kiwipiepy'), { recursive: true });
  await writeFile(path.join(directory, 'kiwipiepy/__init__.py'), KIWI_STUB);
  for (const name of ['kiwipiepy', 'kiwipiepy_model']) {
    const info = path.join(directory, `${name}-0.24.0.dist-info`);
    await mkdir(info, { recursive: true });
    await writeFile(path.join(info, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: 0.24.0\n`);
  }
}

async function tree() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'typewriter-b16-positive-')));
  for (const entry of ['scripts', 'config', 'schema', 'src', 'package.json']) await cp(path.join(ROOT, entry), path.join(temp, entry), { recursive: true });
  await symlink(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'));
  for (const directory of ['batches', 'canonical']) {
    await mkdir(path.join(temp, 'data', directory), { recursive: true });
    for (const entry of await readdir(path.join(ROOT, 'data', directory), { withFileTypes: true })) {
      const from = path.join(ROOT, 'data', directory, entry.name);
      const to = path.join(temp, 'data', directory, entry.name);
      if (entry.isDirectory()) await cp(from, to, { recursive: true });
      else await link(from, to).catch(() => copyFile(from, to));
    }
  }
  // The builder rewrites these two files; they must be private copies, not hard links.
  await cp(path.join(ROOT, 'data/inventory'), path.join(temp, 'data/inventory'), { recursive: true });
  await mkdir(path.join(temp, 'data/validation'), { recursive: true });
  for (const entry of await readdir(path.join(ROOT, 'data/validation'), { withFileTypes: true })) {
    const from = path.join(ROOT, 'data/validation', entry.name);
    const to = path.join(temp, 'data/validation', entry.name);
    if (entry.isDirectory()) await symlink(from, to);
    else if (entry.name === 'canonical-semantic-decision-source.json') await copyFile(from, to);
    else await link(from, to).catch(() => copyFile(from, to));
  }
  await symlink(path.join(ROOT, 'data/timing'), path.join(temp, 'data/timing'));
  await cp(FIXTURE, path.join(temp, 'fixture'), { recursive: true });
  await installStub(path.join(temp, 'kiwi-stub'));
  return temp;
}

const env = (temp) => ({ ...process.env, PYTHONPATH: path.join(temp, 'kiwi-stub'), TYPEWRITER_PYTHON: process.env.TYPEWRITER_PYTHON_FOR_TESTS || 'python3' });
const node = (temp, script, args) => run('node', [path.join(temp, script), ...args], { cwd: temp, env: env(temp), maxBuffer: 64 * 1024 * 1024 });
const validate = async (temp) => {
  try {
    await node(temp, 'scripts/batch/validate-issue-223.mjs', ['--no-local-corpus-evidence', '--skip-issue-222', '--no-build']);
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: `${error.stderr ?? ''}${error.stdout ?? ''}` };
  }
};

test('a normal B16 (real hand-off build, bind, builder with hand-off) passes the real tracked validator; bypasses fail', { timeout: 600000 }, async () => {
  const temp = await tree();
  try {
    const analysis = 'fixture';
    const common = [`--batch-id=${B16}`, `--analysis-directory=${analysis}`];
    await node(temp, 'scripts/intake/production-handoff-cli.mjs', ['build', ...common, '--out=handoff.json']);
    await cp(path.join(temp, 'fixture/semantic-review-input.json'), path.join(temp, 'input.json'));
    await node(temp, 'scripts/intake/production-handoff-cli.mjs', ['bind', '--handoff=handoff.json', '--review-input=input.json', `--analysis-directory=${analysis}`, '--authored-decisions=fixture/authored-decisions.json']);
    const builderArgs = [...common, '--authored-decisions=fixture/authored-decisions.json', '--semantic-reviews=input.json'];

    // Old bypass: B16 without --intake-handoff is refused by the real builder.
    await assert.rejects(node(temp, 'scripts/batch/build-issue-223-corpus-batch.mjs', builderArgs), (error) => /INTAKE_HANDOFF_REQUIRED/u.test(error.stderr));

    // New route: builds, and the real tracked validator accepts the complete batch.
    const built = JSON.parse((await node(temp, 'scripts/batch/build-issue-223-corpus-batch.mjs', [...builderArgs, '--intake-handoff=handoff.json'])).stdout);
    assert.equal(built.canonical_import_count, 2);
    const accepted = await validate(temp);
    assert.equal(accepted.ok, true, accepted.message.slice(-800));
    const files = await readdir(path.join(temp, 'data/batches'));
    assert.ok(files.includes(`${STEM}-intake-handoff.json`));

    // Removing the tracked hand-off (or its integration block) from the accepted B16 fails validation.
    const handoffPath = path.join(temp, `data/batches/${STEM}-intake-handoff.json`);
    const saved = await readFile(handoffPath);
    await rm(handoffPath);
    const missing = await validate(temp);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /intake hand-off|INTAKE_HANDOFF/u);
    await writeFile(handoffPath, saved);

    // Tampering the tracked hand-off bytes breaks the review-input binding.
    const tampered = JSON.parse(saved.toString('utf8'));
    tampered.entries[0].duplicate_count += 1;
    await writeFile(handoffPath, JSON.stringify(tampered));
    const broken = await validate(temp);
    assert.equal(broken.ok, false);
    assert.match(broken.message, /INTAKE_HANDOFF|bound to a different intake hand-off/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

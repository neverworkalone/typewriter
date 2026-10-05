import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Python extractor and cached-selection regressions (synthetic fixtures, stdlib only) are part
// of the normal CI path: factory opt-in keeps exact canonical lemmas and every observed POS in both
// the direct and the cached re-selection path, the default M9 behaviour is unchanged, and a stale
// or tampered cache is rejected. Bytecode writing is disabled so the run leaves the worktree clean
// (the CI build step refuses a dirty tree). A missing python3 fails closed instead of skipping.
test('Python corpus extractor and cached selection regressions pass', () => {
  const result = spawnSync(process.env.TYPEWRITER_PYTHON_TESTS || 'python3', ['scripts/reference/test-corpus-lemma-pilot.py'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.error, undefined, `python3 is required: ${result.error?.message}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('synthetic morphology partitions, exact union, checkpoints and crash recovery', () => {
  const result = spawnSync(process.env.TYPEWRITER_PYTHON_TESTS || 'python3',
    ['scripts/reference/test-corpus-morphology.py'], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  assert.equal(result.error, undefined, `Python is required: ${result.error?.message}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

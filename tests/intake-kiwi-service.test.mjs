import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Kiwi service regressions (synthetic analyzer, no Kiwi install needed)', () => {
  const result = spawnSync(process.env.TYPEWRITER_PYTHON || 'python3', ['scripts/intake/test_kiwi_service.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});

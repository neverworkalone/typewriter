// Runs every War Room test, preferring the local venv and parallel class workers by default.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const venvPython = path.join(root, '.local', 'venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';
const serial = process.env.WARROOM_TEST_JOBS === '1';
const args = serial ? ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.']
  : ['-m', 'tests.parallel_runner'];
const result = spawnSync(python, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error) {
  console.error(`War Room tests could not start ${python}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

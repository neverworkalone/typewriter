// Runs the War Room Python unittest suite. Uses the War Room venv when present
// (adds the Textual smoke test); otherwise plain python3 (core tests are stdlib-only).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const venvPython = path.join(root, '.local', 'venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error) {
  console.error(`War Room tests could not start ${python}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

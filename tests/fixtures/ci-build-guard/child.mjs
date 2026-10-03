// Synthetic CI command: builds SQLite databases so the normal-level guard can be
// exercised end to end. `current` is the canonical revision the fixture session
// loads; `other` is a different isolated fixture revision.
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../../../scripts/build/dictionary.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../normalization');
export const CURRENT_FIXTURE = path.join(FIXTURES, 'one-file.jsonl');
export const OTHER_FIXTURE = path.join(FIXTURES, 'split');

const modes = {
  noop: [],
  'other-build': [OTHER_FIXTURE],
  'current-build': [CURRENT_FIXTURE],
  'current-twice': [CURRENT_FIXTURE, CURRENT_FIXTURE],
};
const declaredModes = new Set([...Object.keys(modes), 'nested-current-build', 'current-build-as-deep']);

const [mode] = process.argv.slice(2);
if (mode === 'nested-current-build') {
  // A validator that shells out to another node process which builds (nested path).
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'current-build'], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
if (mode === 'current-build-as-deep') {
  // A process that labels its own normal-phase build as deep.
  process.env.TYPEWRITER_CI_PHASE = 'deep';
  modes['current-build-as-deep'] = [CURRENT_FIXTURE];
}
if (!declaredModes.has(mode)) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-ci-guard-child-'));
try {
  for (const [index, inputDirectory] of modes[mode].entries()) {
    await buildDictionary({
      inputDirectory,
      outputPath: path.join(directory, `${index}.sqlite`),
      allowDirty: true,
      repositoryDirectory: process.cwd(),
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

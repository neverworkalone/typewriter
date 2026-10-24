// Runs the real CI runner (ledger, per-command zero-build guard, checkpoints,
// phase-completion and final-exit guards) against a small synthetic registry.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCanonicalSession, runCli } from '../../../scripts/ci/run-category.mjs';
import { loadCanonicalContext } from '../../../scripts/validate/canonical-context.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(DIRECTORY, 'child.mjs');
const CURRENT_FIXTURE = path.resolve(DIRECTORY, '../normalization/one-file.jsonl');

const child = (mode, extra = {}) => ({
  label: `child ${mode}`,
  command: () => ({ executable: process.execPath, args: [CHILD, mode] }),
  ...extra,
});
const shell = (label, script) => ({
  label,
  command: () => ({ executable: 'sh', args: ['-c', script] }),
});

const SCENARIOS = {
  'zero-build': { fast: [child('noop')], rest: [child('noop'), child('other-build')] },
  'current-normal': { fast: [child('noop')], rest: [child('current-build')] },
  'current-twice': { fast: [child('noop')], rest: [child('current-twice')] },
  'current-without-normal-prior': { fast: [child('current-build')], rest: [child('noop')] },
  'hook-omitted': { fast: [child('noop')], rest: [shell('non-node command', 'true')] },
  'malformed-ledger': {
    fast: [child('noop')],
    rest: [shell('corrupt ledger', 'echo not-json >> "$TYPEWRITER_PROCESS_METRICS_PATH"')],
  },
  'deleted-ledger': {
    fast: [child('noop')],
    rest: [shell('delete ledger', 'rm "$TYPEWRITER_PROCESS_METRICS_PATH"')],
  },
  'mislabeled-as-deep': { fast: [child('noop')], rest: [child('current-build-as-deep')] },
  'nested-normal': { fast: [child('noop')], rest: [child('nested-current-build')] },
  'nested-deep': {
    fast: [child('noop')],
    rest: [child('noop')],
    deep: [child('nested-current-build', { independentCurrentRevisionBuilds: true })],
  },
  'deep-independent': {
    fast: [child('noop')],
    rest: [child('noop')],
    deep: [child('current-twice', { independentCurrentRevisionBuilds: true })],
  },
};

const [scenarioName, level = 'normal'] = process.argv.slice(2);
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`unknown scenario ${scenarioName}`);
  process.exit(2);
}
const category = (label, checks) => ({ label, checks });
const categories = {
  fast: category('fixture fast', scenario.fast),
  rest: category('fixture rest', scenario.rest),
  deep: category('fixture deep', scenario.deep ?? [child('noop')]),
};
const levels = {
  fast: ['fast'],
  normal: ['fast', 'rest'],
  all: ['fast', 'rest', 'deep'],
};

await runCli([level], {
  categories,
  levels,
  createSession: () => createCanonicalSession({
    prepareContext: () => loadCanonicalContext({ directory: CURRENT_FIXTURE, contextPath: null }),
  }),
}).catch((error) => {
  console.error(`\nCI category failed: ${error.message}`);
  process.exitCode = 1;
});

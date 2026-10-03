// Runs the real CI runner (`runCli`: ledger, per-command guard, fast checkpoint,
// phase-completion and final-exit guards) against a small synthetic registry whose
// canonical session is a tiny fixture. Exit status is the runner's own.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCanonicalSession, runCli } from '../../../scripts/ci/run-category.mjs';
import { loadCanonicalContext } from '../../../scripts/validate/canonical-context.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(DIRECTORY, 'child.mjs');
const CURRENT_FIXTURE = path.resolve(DIRECTORY, '../normalization/one-file.jsonl');

const sharedBuild = {
  label: 'Build shared SQLite dictionary artifact',
  inProcess: 'shared-dictionary-build',
  command: () => ({ executable: '[in-process]', args: ['shared-dictionary-build'] }),
};
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
  'one-build': { fast: [sharedBuild], rest: [child('noop'), child('other-build')] },
  'zero-build': { fast: [child('noop')], rest: [child('noop')] },
  // Fault injection: the session forgets its shared artifact, so the normal
  // continuation rebuilds the current revision in the parent process.
  'two-parent-builds': { fast: [sharedBuild], rest: [sharedBuild], forgetSharedArtifact: true },
  'parent-and-child': { fast: [sharedBuild], rest: [child('current-build')] },
  'two-child-builds': { fast: [sharedBuild], rest: [child('current-twice')] },
  'child-without-parent': { fast: [child('current-build')], rest: [child('noop')] },
  'hook-omitted': { fast: [sharedBuild], rest: [shell('non-node command', 'true')] },
  'malformed-ledger': {
    fast: [sharedBuild],
    rest: [shell('corrupt ledger', 'echo not-json >> "$TYPEWRITER_PROCESS_METRICS_PATH"')],
  },
  'deleted-ledger': {
    fast: [sharedBuild],
    rest: [shell('delete ledger', 'rm "$TYPEWRITER_PROCESS_METRICS_PATH"')],
  },
  'mislabeled-as-deep': { fast: [sharedBuild], rest: [child('current-build-as-deep')] },
  'nested-normal': { fast: [sharedBuild], rest: [child('nested-current-build')] },
  'nested-deep': {
    fast: [sharedBuild],
    rest: [child('noop')],
    deep: [child('nested-current-build', { independentCurrentRevisionBuilds: true })],
  },
  'deep-independent': {
    fast: [sharedBuild],
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
  }).then((session) => {
    const prepared = { ...session, checkPilotCompleteness: false };
    if (scenario.forgetSharedArtifact) {
      Object.defineProperty(prepared, 'sharedDictionaryPath', { get: () => undefined, set() {} });
    }
    return prepared;
  }),
}).catch((error) => {
  console.error(`\nCI category failed: ${error.message}`);
  process.exitCode = 1;
});

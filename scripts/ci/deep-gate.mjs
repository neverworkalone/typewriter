import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CI_CATEGORIES,
  CI_ALL_CATEGORY_ORDER,
  REPOSITORY_DIRECTORY,
} from './registry.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const DEEP_CONTRACT_PATHS = Object.freeze([
  '.github/workflows/',
  'scripts/ci/',
  'scripts/benchmark/',
  'scripts/build/',
  'scripts/factory/',
  'scripts/relation/',
  'scripts/validate/',
  'scripts/inventory/generate-target-inventory.mjs',
  'scripts/batch/m5-12a-',
  'scripts/batch/validate-m5-8-process.mjs',
  'scripts/batch/authored-semantic-decision-source.mjs',
  'config/ci-level-evidence.json',
  'config/artifact-policy.json',
  'package.json',
  'pnpm-lock.yaml',
  'tests/ci-registry.test.mjs',
  'tests/ci-runner.test.mjs',
  'tests/ci-sqlite-build-guard.test.mjs',
]);

const KNOWN_NON_DEEP_PATHS = Object.freeze([
  'docs/',
  'data/',
  'src/',
  'web/',
  'public/',
  'README.md',
  'REVIEW.md',
  'AGENTS.md',
  'popup.html',
  'options.html',
  'vite.config.js',
  'vite.web.config.js',
  'vitest.config.js',
  'pack.py',
  'pack.sh',
]);

function matchesPath(pathValue, rule) {
  return rule.endsWith('/') || rule.endsWith('-')
    ? pathValue.startsWith(rule)
    : pathValue === rule;
}

function registeredTestTiers() {
  const tiersByFile = new Map();
  const historicalInputs = {
    waveA2Reviewed: 'synthetic-wave-a2-reviewed.jsonl',
    waveA2SemanticAudit: 'synthetic-wave-a2-semantic-audit.json',
    waveBReviewed: 'synthetic-wave-b-reviewed.jsonl',
    waveBSemanticAudit: 'synthetic-wave-b-semantic-audit.json',
  };
  for (const categoryName of CI_ALL_CATEGORY_ORDER) {
    for (const check of CI_CATEGORIES[categoryName].checks) {
      const files = new Set(check.testFiles ?? []);
      let command;
      try {
        command = check.command({ historicalInputs });
      } catch {
        command = undefined;
      }
      for (const argument of command?.args ?? []) {
        if (
          typeof argument === 'string'
          && /^(?:tests|scripts)\/.+\.test\.mjs$/u.test(argument)
        ) files.add(argument);
      }
      for (const file of files) {
        const tiers = tiersByFile.get(file) ?? new Set();
        tiers.add(check.tier);
        tiersByFile.set(file, tiers);
      }
    }
  }
  return tiersByFile;
}

function validRepositoryPath(pathValue) {
  return typeof pathValue === 'string'
    && pathValue.length > 0
    && !pathValue.startsWith('/')
    && !pathValue.includes('\\')
    && !pathValue.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function classifyDeepGatePaths(changedPaths, {
  testTiers = registeredTestTiers(),
} = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runDeep: true, reason: 'missing-or-empty-path-evidence' };
  }
  if (changedPaths.some((changedPath) => !validRepositoryPath(changedPath))) {
    return { runDeep: true, reason: 'unclassifiable-path-evidence' };
  }

  for (const changedPath of changedPaths) {
    if (DEEP_CONTRACT_PATHS.some((rule) => matchesPath(changedPath, rule))) {
      return { runDeep: true, reason: 'deep-contract-path', path: changedPath };
    }
    if (changedPath.endsWith('.test.mjs')) {
      const tiers = testTiers.get(changedPath);
      if (!tiers || tiers.has('deep')) {
        return { runDeep: true, reason: 'unregistered-or-deep-test', path: changedPath };
      }
      continue;
    }
    if (KNOWN_NON_DEEP_PATHS.some((rule) => matchesPath(changedPath, rule))) continue;
    return { runDeep: true, reason: 'unclassified-path', path: changedPath };
  }
  return { runDeep: false, reason: 'no-deep-contract-path' };
}

export function classifyDeepGateDiff(baseSha, headSha, {
  runGit = (args) => execFileSync('git', args, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  if (typeof baseSha !== 'string' || !baseSha || typeof headSha !== 'string' || !headSha) {
    return { runDeep: true, reason: 'missing-revision-evidence' };
  }
  try {
    const result = runGit(['diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`]);
    const changedPaths = Buffer.from(result).toString('utf8').split('\0').filter(Boolean);
    return classifyDeepGatePaths(changedPaths);
  } catch {
    return { runDeep: true, reason: 'diff-command-failed' };
  }
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const result = classifyDeepGateDiff(baseSha, headSha);
  const output = `run_deep=${result.runDeep}\nreason=${result.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, base_sha: baseSha ?? null, head_sha: headSha ?? null })}\n`);
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) main();

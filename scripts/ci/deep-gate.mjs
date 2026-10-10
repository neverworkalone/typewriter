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
import { validateCanonicalRecord } from '../validate/canonical-jsonl.mjs';
import { relationAmendmentErrors } from '../factory/relation-amendments.mjs';
import { relationCorrectionErrors } from '../factory/relation-corrections.mjs';
import { validateTrashChunk } from '../factory/permanent-trash.mjs';
import KNOWN_NON_DEEP_PATHS from './deep-gate-known-non-deep-paths.json' with { type: 'json' };
import NORMAL_COVERAGE from './deep-gate-coverage.json' with { type: 'json' };

const SCRIPT_PATH = fileURLToPath(import.meta.url);

// These paths affect the classifier or the mechanism that selects checks. The
// only safe response is the complete current-system Deep suite.
const FULL_DEEP_PATHS = Object.freeze([
  '.github/workflows/',
  'scripts/ci/deep-gate.mjs',
  'scripts/ci/registry.mjs',
  'scripts/ci/run-category.mjs',
  'scripts/ci/sqlite-build-ledger.mjs',
  'tests/ci-registry.test.mjs',
  'tests/ci-runner.test.mjs',
  'tests/ci-sqlite-build-guard.test.mjs',
  'package.json',
  'pnpm-lock.yaml',
]);

const KNOWN_NON_DEEP_ROOT_PATHS = Object.freeze([
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

if (KNOWN_NON_DEEP_PATHS.version !== 1 || !Array.isArray(KNOWN_NON_DEEP_PATHS.paths)) {
  throw new TypeError('Deep Gate known non-Deep path contract has an unsupported shape.');
}

const knownNonDeepPaths = [
  ...KNOWN_NON_DEEP_PATHS.paths,
  ...KNOWN_NON_DEEP_ROOT_PATHS,
];
if (new Set(knownNonDeepPaths).size !== knownNonDeepPaths.length) {
  throw new TypeError('Deep Gate known non-Deep path contract contains duplicates.');
}
if (knownNonDeepPaths.some((knownPath) => !validRepositoryPath(knownPath))) {
  throw new TypeError('Deep Gate known non-Deep paths must be normalized repository-relative files.');
}
const KNOWN_NON_DEEP_PATH_SET = new Set(knownNonDeepPaths);
const NORMAL_COVERAGE_PATH = 'scripts/ci/deep-gate-coverage.json';

// This is an exact-file allowlist, not a directory wildcard or a claim that
// a changed producer is safe without regression coverage. Normal owns every
// listed test on every PR; Deep dependency matches take precedence.
export function validateNormalCoverage(manifest = NORMAL_COVERAGE, {
  categories = CI_CATEGORIES,
  deepChecks = registeredDeepChecks(),
} = {}) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.bindings)) {
    throw new TypeError('Normal coverage registry has an unsupported shape.');
  }
  const bindings = new Map();
  for (const binding of manifest.bindings) {
    const tests = binding?.normal_tests;
    if (
      !validRepositoryPath(binding?.path)
      || typeof binding?.protected_contract !== 'string'
      || !binding.protected_contract.trim()
      || !Array.isArray(tests) || tests.length === 0
      || tests.some((test) => typeof test !== 'string' || !new RegExp('^(?:tests|scripts)/.+[.]test[.]mjs$', 'u').test(test))
      || new Set(tests).size !== tests.length
      || bindings.has(binding.path)
      || FULL_DEEP_PATHS.some((rule) => matchesPath(binding.path, rule))
      || deepChecks.some((check) => deepPathMatches(binding.path, check))
      || binding.path === NORMAL_COVERAGE_PATH
    ) {
      throw new TypeError('Unsafe or duplicate Normal coverage binding: ' + JSON.stringify(binding));
    }
    for (const test of tests) {
      const covered = Object.values(categories).some((category) => category.checks.some((check) => (
        check.tier === 'normal'
        && check.schedule === 'always'
        && (check.testFiles ?? []).includes(test)
      )));
      if (!covered) throw new TypeError('Normal coverage test is not always-on in Normal CI: ' + test);
    }
    bindings.set(binding.path, binding);
  }
  return bindings;
}

// Extend coverage without silently narrowing a previous accepted mapping.
// Replacing/removing a binding is a genuine CI contract change and falls
// back to the full Deep gate. A test can be added or replaced only in a new
// explicitly registered binding for a new path.
export function validateAdditiveNormalCoverage(previous, next, options) {
  const before = validateNormalCoverage(previous, options);
  const after = validateNormalCoverage(next, options);
  for (const [pathValue, binding] of before) {
    if (JSON.stringify(after.get(pathValue)) !== JSON.stringify(binding)) {
      throw new Error('Normal coverage change removes or alters existing protection: ' + pathValue);
    }
  }
  return after;
}
const STAGE1_CANDIDATE_ARTIFACT_PATH = /^data\/candidates\/C\d{6}\/(?:manifest\.json|candidates\.jsonl|stage1-decisions\.json)$/u;
const STAGE1_TRASH_ARTIFACT_PATH = /^data\/candidate-trash\/T\d{6}\.jsonl$/u;
const REVIEW_ARTIFACT_PATH = /^data\/reviews\/C\d{6}\/(?:manifest\.json|decisions\.jsonl|semantic-decisions\.json|intake-handoff\.json)$/u;
const RELATION_BACKFILL_PATH = /^data\/relation-backfill\/(R\d{6})\.json$/u;

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

function registeredDeepChecks() {
  return CI_ALL_CATEGORY_ORDER.flatMap((categoryName) => (
    CI_CATEGORIES[categoryName].checks
  )).filter((check) => check.tier === 'deep');
}

function checkId(check) {
  return `${check.owner}/${check.label}`;
}

function deepCheckMap(deepChecks) {
  for (const check of deepChecks) {
    if (check.schedule !== 'affected' || !Array.isArray(check.paths) || check.paths.length === 0) {
      throw new TypeError(`Deep check ${checkId(check)} must register affected contract paths.`);
    }
  }
  return deepChecks;
}

function normalDataKind(pathValue) {
  if (/^data\/canonical\/.+\.jsonl$/u.test(pathValue)) return 'canonical-jsonl';
  if (STAGE1_CANDIDATE_ARTIFACT_PATH.test(pathValue)) return pathValue.endsWith('.jsonl') ? 'jsonl' : 'json';
  if (STAGE1_TRASH_ARTIFACT_PATH.test(pathValue)) return 'trash-jsonl';
  if (REVIEW_ARTIFACT_PATH.test(pathValue)) return pathValue.endsWith('.jsonl') ? 'jsonl' : 'json';
  if (RELATION_BACKFILL_PATH.test(pathValue)) return 'relation-backfill';
  if (
    pathValue === 'data/validation/canonical-semantic-decision-source.json'
    || pathValue === 'data/validation/canonical-semantic-correction-manifest.json'
    || pathValue === 'data/validation/canonical-semantic-boundary-decisions.json'
    || pathValue === 'data/validation/canonical-non-batch-baseline.json'
    || /^data\/validation\/issue-\d+-.+-report\.json$/u.test(pathValue)
  ) return 'json';
  if (/^data\/inventory\/[^/]+\.(?:json|jsonl)$/u.test(pathValue)) {
    return pathValue.endsWith('.jsonl') ? 'jsonl' : 'json';
  }
  return undefined;
}

function decodeUtf8(bytes, label) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(`${label}: invalid UTF-8 (${error.message})`);
  }
}

function parseJsonlRecords(text, filePath) {
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  if (rows.length === 0 || rows.some((row) => row.trim().length === 0)) {
    throw new Error(`${filePath}: empty or blank JSONL row`);
  }
  return rows.map((row, index) => {
    let value;
    try {
      value = JSON.parse(row);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSON (${error.message})`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${filePath}:${index + 1}: row must be a JSON object`);
    }
    return value;
  });
}

function validateCanonicalPatch(pathValue, baseSha, headSha, runGit) {
  const patch = decodeUtf8(runGit([
    'diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=0',
    `${baseSha}...${headSha}`, '--', pathValue,
  ]), pathValue);
  let changedRowCount = 0;
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const jsonLine = line.slice(1);
    let record;
    try {
      record = JSON.parse(jsonLine);
    } catch (error) {
      throw new Error(`${pathValue}: changed canonical row is invalid JSON (${error.message})`);
    }
    validateCanonicalRecord(record, pathValue, 1);
    changedRowCount += 1;
  }
  if (changedRowCount === 0) throw new Error(`${pathValue}: no changed canonical JSONL rows were validated`);
}

function readFileAtRevision(pathValue, baseSha, headSha, runGit) {
  let bytes;
  try {
    bytes = runGit(['show', `${headSha}:${pathValue}`]);
  } catch (headError) {
    let deletedAtHead = false;
    try {
      const deletedPaths = runGit([
        'diff', '--no-ext-diff', '--no-color', '--no-renames', '--diff-filter=D',
        '--name-only', '-z', `${baseSha}...${headSha}`, '--', pathValue,
      ]);
      deletedAtHead = Buffer.from(deletedPaths).toString('utf8').split('\0').includes(pathValue);
    } catch (diffError) {
      throw new Error(`${pathValue}: could not verify whether the unreadable HEAD file was deleted (${diffError.message})`);
    }
    if (!deletedAtHead) {
      throw new Error(`${pathValue}: could not read the changed file at HEAD (${headError.message})`);
    }
    bytes = runGit(['show', `${baseSha}:${pathValue}`]);
  }
  return decodeUtf8(bytes, pathValue);
}

function validateRoutineDataFile(pathValue, kind, baseSha, headSha, runGit) {
  if (kind === 'canonical-jsonl') {
    validateCanonicalPatch(pathValue, baseSha, headSha, runGit);
    return;
  }

  const text = readFileAtRevision(pathValue, baseSha, headSha, runGit);
  if (kind === 'jsonl' || kind === 'trash-jsonl') {
    // Keep the changed-file gate strict even if another consumer tolerates blank lines.
    parseJsonlRecords(text, pathValue);
    if (kind === 'trash-jsonl') {
      // Reuse the real Factory contract (identity hashes, variants, occurrences,
      // bounded chunk size and text-free evidence); Normal additionally checks
      // new chunks against all changed and historic archive IDs.
      const errors = validateTrashChunk(text);
      if (errors.length > 0) throw new Error(`${pathValue}: ${errors.join('; ')}`);
    }
    return;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${pathValue}: invalid JSON (${error.message})`);
  }
  if (kind === 'relation-backfill') {
    const [, packetId] = pathValue.match(RELATION_BACKFILL_PATH) ?? [];
    if (value?.packet_id !== packetId) throw new Error(`${pathValue}: packet_id does not match its filename`);
    const errors = [
      ...relationAmendmentErrors(value, pathValue),
      ...relationCorrectionErrors(value, pathValue),
    ];
    if (errors.length > 0) throw new Error(errors.join('; '));
    if (!Array.isArray(value.relation_amendments) && !Array.isArray(value.relation_corrections)) {
      throw new Error(`${pathValue}: no recognized relation backfill contract`);
    }
  }
}

function deepPathMatches(changedPath, check) {
  return check.paths.some((dependencyPath) => (
    changedPath === dependencyPath
    || (dependencyPath.endsWith('-')
      ? changedPath.startsWith(dependencyPath)
      : changedPath.startsWith(`${dependencyPath}/`))
  ));
}

export function classifyDeepGatePaths(changedPaths, {
  testTiers = registeredTestTiers(),
  deepChecks = deepCheckMap(registeredDeepChecks()),
  validatedDataPaths = new Set(),
  coverage = validateNormalCoverage(),
  coverageChangeValidated = false,
} = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runDeep: true, deepMode: 'full', reason: 'missing-or-empty-path-evidence', changeClass: 'unclassifiable' };
  }
  if (changedPaths.some((changedPath) => !validRepositoryPath(changedPath))) {
    return { runDeep: true, deepMode: 'full', reason: 'unclassifiable-path-evidence', changeClass: 'unclassifiable' };
  }

  const selectedDeepChecks = new Set();
  const matchedTriggers = [];
  const normalDataPaths = [];
  const knownNonDeepPaths = [];

  for (const changedPath of changedPaths) {
    if (FULL_DEEP_PATHS.some((rule) => matchesPath(changedPath, rule))) {
      return {
        runDeep: true,
        deepMode: 'full',
        reason: 'classifier-or-ci-contract-path',
        changeClass: 'ci-contract',
        path: changedPath,
        selectedDeepChecks: deepChecks.map(checkId),
        matchedTriggers: [{ path: changedPath, checks: deepChecks.map(checkId) }],
      };
    }

    const pathChecks = deepChecks.filter((check) => deepPathMatches(changedPath, check));
    if (pathChecks.length > 0) {
      const checkIds = pathChecks.map(checkId);
      for (const id of checkIds) selectedDeepChecks.add(id);
      matchedTriggers.push({ path: changedPath, checks: checkIds });
      continue;
    }

    if (changedPath.endsWith('.test.mjs')) {
      const tiers = testTiers.get(changedPath);
      if (!tiers || tiers.has('deep')) {
        return {
          runDeep: true,
          deepMode: 'full',
          reason: 'unregistered-or-unmapped-deep-test',
          changeClass: 'unclassifiable',
          path: changedPath,
          selectedDeepChecks: deepChecks.map(checkId),
        };
      }
      knownNonDeepPaths.push(changedPath);
      continue;
    }

    // Root Stage 1 artifacts keep their candidate-only route. The PR diff
    // classifier still schema-checks their contents before this result is used.
    if (STAGE1_CANDIDATE_ARTIFACT_PATH.test(changedPath) && !validatedDataPaths.has(changedPath)) {
      knownNonDeepPaths.push(changedPath);
      continue;
    }

    const dataKind = normalDataKind(changedPath);
    if (dataKind) {
      if (!validatedDataPaths.has(changedPath)) {
        return {
          runDeep: true,
          deepMode: 'full',
          reason: 'routine-data-shape-unverified',
          changeClass: 'unclassifiable',
          path: changedPath,
          selectedDeepChecks: deepChecks.map(checkId),
        };
      }
      normalDataPaths.push(changedPath);
      continue;
    }

    if (changedPath === NORMAL_COVERAGE_PATH && !coverageChangeValidated) {
      return { runDeep: true, deepMode: 'full', reason: 'unvalidated-normal-coverage-change', changeClass: 'ci-contract', path: changedPath };
    }
    if (
      changedPath.startsWith('docs/')
      || KNOWN_NON_DEEP_PATH_SET.has(changedPath)
      || coverage.has(changedPath)
      || (changedPath === NORMAL_COVERAGE_PATH && coverageChangeValidated)
      || STAGE1_CANDIDATE_ARTIFACT_PATH.test(changedPath)
    ) {
      knownNonDeepPaths.push(changedPath);
      continue;
    }

    return {
      runDeep: true,
      deepMode: 'full',
      reason: 'unclassified-path',
      changeClass: 'unclassifiable',
      path: changedPath,
      selectedDeepChecks: deepChecks.map(checkId),
    };
  }

  if (selectedDeepChecks.size > 0) {
    const selected = [...selectedDeepChecks].sort();
    return {
      runDeep: true,
      deepMode: 'selective',
      reason: 'registered-deep-contract-dependency',
      changeClass: normalDataPaths.length > 0 || knownNonDeepPaths.length > 0
        ? 'mixed-normal-and-deep-contract'
        : 'deep-contract',
      selectedDeepChecks: selected,
      matchedTriggers,
      normalDataPaths,
      knownNonDeepPaths,
    };
  }

  return {
    runDeep: false,
    deepMode: 'none',
    reason: normalDataPaths.length > 0 ? 'validated-routine-data' : 'known-non-deep-paths-only',
    changeClass: normalDataPaths.length > 0 ? 'routine-data' : 'non-deep',
    selectedDeepChecks: [],
    matchedTriggers: [],
    normalDataPaths,
    knownNonDeepPaths,
  };
}

export function classifyDeepGateDiff(baseSha, headSha, {
  runGit = (args) => execFileSync('git', args, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  if (typeof baseSha !== 'string' || !baseSha || typeof headSha !== 'string' || !headSha) {
    return { runDeep: true, deepMode: 'full', reason: 'missing-revision-evidence', changeClass: 'unclassifiable' };
  }
  try {
    const result = runGit(['diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`]);
    const changedPaths = Buffer.from(result).toString('utf8').split('\0').filter(Boolean);
    const validatedDataPaths = new Set();
    let coverageChangeValidated = false;
    if (changedPaths.includes(NORMAL_COVERAGE_PATH)) {
      try {
        const base = decodeUtf8(runGit(['show', baseSha + ':' + NORMAL_COVERAGE_PATH]), NORMAL_COVERAGE_PATH);
        const head = decodeUtf8(runGit(['show', headSha + ':' + NORMAL_COVERAGE_PATH]), NORMAL_COVERAGE_PATH);
        validateAdditiveNormalCoverage(JSON.parse(base), JSON.parse(head));
        coverageChangeValidated = true;
      } catch (error) {
        return {
          runDeep: true,
          deepMode: 'full',
          reason: 'normal-coverage-registration-unverified',
          changeClass: 'ci-contract',
          path: NORMAL_COVERAGE_PATH,
          detail: error.message,
          changedPaths,
          selectedDeepChecks: deepCheckMap(registeredDeepChecks()).map(checkId),
        };
      }
    }
    for (const changedPath of changedPaths) {
      const kind = normalDataKind(changedPath);
      if (!kind) continue;
      try {
        validateRoutineDataFile(changedPath, kind, baseSha, headSha, runGit);
      } catch (error) {
        return {
          runDeep: true,
          deepMode: 'full',
          reason: 'routine-data-validation-failed',
          changeClass: 'unclassifiable',
          path: changedPath,
          detail: error.message,
          changedPaths,
          selectedDeepChecks: deepCheckMap(registeredDeepChecks()).map(checkId),
        };
      }
      validatedDataPaths.add(changedPath);
    }
    return {
      ...classifyDeepGatePaths(changedPaths, { validatedDataPaths, coverageChangeValidated }),
      changedPaths,
    };
  } catch {
    return { runDeep: true, deepMode: 'full', reason: 'diff-command-failed', changeClass: 'unclassifiable' };
  }
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const result = classifyDeepGateDiff(baseSha, headSha);
  const deepChecks = deepCheckMap(registeredDeepChecks());
  const selectedLabels = result.deepMode === 'full'
    ? deepChecks.map(checkId)
    : (result.selectedDeepChecks ?? []);
  const selected = new Set(selectedLabels);
  const skippedLabels = deepChecks.map(checkId).filter((id) => !selected.has(id));
  const runLevel = process.env.TYPEWRITER_CI_RUN_LEVEL ?? 'normal';
  const baseGate = runLevel === 'none'
    ? 'ci:normal skipped (documentation-only)'
    : runLevel === 'candidates' ? 'ci:candidates' : 'ci:normal';
  const triggerEvidence = (result.matchedTriggers ?? []).length > 0
    ? result.matchedTriggers.map(({ path: changedPath, checks }) => (
      `\`${changedPath}\` -> ${checks.map((id) => `\`${id}\``).join(', ')}`
    )).join('; ')
    : result.path
      ? `\`${result.path}\` -> full Deep fallback (${result.reason})`
      : `none (${result.reason})`;
  const output = [
    `run_deep=${result.runDeep}`,
    `deep_mode=${result.deepMode}`,
    `reason=${result.reason}`,
  ].join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output, 'utf8');

  const summary = [
    '## PR CI change coverage',
    '',
    `- Base: \`${baseSha ?? 'missing'}\``,
    `- Exact HEAD: \`${headSha ?? 'missing'}\``,
    `- Change class: \`${result.changeClass ?? 'unclassifiable'}\``,
    `- Base PR gate: \`${baseGate}\``,
    `- Classification: \`${result.deepMode}\` (${result.reason})`,
    `- Changed paths: ${(result.changedPaths ?? []).length > 0 ? result.changedPaths.map((value) => `\`${value}\``).join(', ') : 'unavailable'}`,
    `- Matched contract triggers: ${triggerEvidence}`,
    `- Deep checks selected (${selectedLabels.length}/${deepChecks.length}): ${selectedLabels.length > 0 ? selectedLabels.map((value) => `\`${value}\``).join(', ') : 'none'}`,
    `- Deep checks skipped: ${skippedLabels.length > 0 ? skippedLabels.map((value) => `\`${value}\``).join(', ') : 'none'}${skippedLabels.length > 0 ? ` (reason: no registered dependency matched this change; classifier: ${result.reason})` : ''}`,
    `- PR command: \`${result.deepMode === 'full' ? 'ci:all' : result.deepMode === 'selective' ? 'ci:pr' : 'ci:normal or ci:candidates'}\``,
  ].join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, base_sha: baseSha ?? null, head_sha: headSha ?? null })}\n`);
}

function validRepositoryPath(pathValue) {
  return typeof pathValue === 'string'
    && pathValue.length > 0
    && !pathValue.startsWith('/')
    && !pathValue.includes('\\')
    && !pathValue.split('/').some((part) => part === '' || part === '.' || part === '..');
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) main();

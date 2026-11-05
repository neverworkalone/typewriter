import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function validateSha(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(`${name} must be a full lowercase 40-character Git SHA.`);
  }
  return value;
}

function gitText(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} was not valid UTF-8.`);
  }
}

function runGit(args, cwd = REPOSITORY_DIRECTORY) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? `status=${error.status}` : 'process-failure';
    throw new Error(`git ${args[0]} failed (${status}).`);
  }
}

/**
 * Resolve the range used only to select validations.
 * Pull requests use their merge-base and source head; merge queues retain the
 * existing integration-candidate range. The workflow's checked-out
 * integration candidate is tracked separately and is never changed here.
 */
export function resolveChangeRange({
  eventName,
  integrationBaseSha,
  integrationHeadSha,
  pullRequestBaseSha,
  pullRequestHeadSha,
}, { runGit: executeGit = (args) => runGit(args) } = {}) {
  validateSha(integrationBaseSha, 'integrationBaseSha');
  validateSha(integrationHeadSha, 'integrationHeadSha');

  if (eventName === 'pull_request') {
    validateSha(pullRequestBaseSha, 'pullRequestBaseSha');
    validateSha(pullRequestHeadSha, 'pullRequestHeadSha');
    const mergeBaseSha = gitText(
      executeGit(['merge-base', pullRequestBaseSha, pullRequestHeadSha]),
      'PR merge-base',
    ).trim();
    return {
      changeBaseSha: validateSha(mergeBaseSha, 'PR merge-base'),
      changeHeadSha: pullRequestHeadSha,
      integrationBaseSha,
      integrationHeadSha,
    };
  }

  if (eventName === 'merge_group') {
    return {
      changeBaseSha: integrationBaseSha,
      changeHeadSha: integrationHeadSha,
      integrationBaseSha,
      integrationHeadSha,
    };
  }

  throw new TypeError(`Unsupported validation event: ${String(eventName)}.`);
}

function parseNameStatus(bytes, label) {
  const text = gitText(bytes, label);
  if (text.length === 0) return [];
  if (!text.endsWith('\0')) throw new Error(`${label} was not NUL-terminated.`);
  const tokens = text.slice(0, -1).split('\0');
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) throw new Error(`${label} contains an empty status.`);
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) throw new Error(`${label} contains an incomplete rename.`);
      files.push({ status, oldPath, newPath });
    } else {
      const filePath = tokens[index++];
      if (!filePath) throw new Error(`${label} contains an incomplete file entry.`);
      files.push({ status, path: filePath });
    }
  }
  return files;
}

function isWarRoomPath(filePath) {
  return /^(?:tools\/warroom\/warroom\/|tools\/warroom\/tests\/|tools\/warroom\/run-tests\.mjs$|tools\/warroom\/requirements\.txt$|war$|dashboard$)/u.test(filePath);
}

/** Classify the same exact changed-path list used by the Deep selector. */
export function classifyChangedFiles(changes, renames = []) {
  if (!Array.isArray(changes) || !Array.isArray(renames)) {
    throw new TypeError('Changed-file evidence must be arrays.');
  }

  let docsOnly = true;
  let warRoomOnly = true;
  let runWarRoomTests = false;
  let runUiBuild = false;
  let runWebBuild = false;

  for (const change of changes) {
    if (!change || typeof change.status !== 'string' || typeof change.path !== 'string' || !change.path) {
      throw new TypeError('Changed-file evidence contains an invalid status/path pair.');
    }
    if (!['A', 'M', 'D'].includes(change.status)) {
      docsOnly = false;
      warRoomOnly = false;
    }
    if (change.path.startsWith('src/')) runUiBuild = true;
    if (change.path.startsWith('site/')) runWebBuild = true;

    if (change.path.startsWith('docs/')
      || change.path === 'README.md'
      || change.path === 'REVIEW.md'
      || change.path.startsWith('tools/warroom/prompts/')) {
      continue;
    }
    docsOnly = false;
    if (isWarRoomPath(change.path)) runWarRoomTests = true;
    else warRoomOnly = false;
  }

  for (const rename of renames) {
    if (!rename || typeof rename.status !== 'string') {
      throw new TypeError('Rename evidence contains an invalid status/path tuple.');
    }
    if (rename.status.startsWith('R')) {
      if (typeof rename.oldPath !== 'string' || typeof rename.newPath !== 'string') {
        throw new TypeError('Rename evidence contains an invalid status/path tuple.');
      }
      if (isWarRoomPath(rename.oldPath) !== isWarRoomPath(rename.newPath)) {
        warRoomOnly = false;
      }
    } else if (typeof rename.path !== 'string' || !rename.path) {
      throw new TypeError('Rename evidence contains an invalid status/path tuple.');
    }
  }

  const changedPathsComplete = changes.length > 0;
  const runLevel = !changedPathsComplete
    ? 'normal'
    : docsOnly
      ? 'none'
      : warRoomOnly && runWarRoomTests
        ? 'warroom'
        : 'normal';

  return {
    runLevel,
    runWarRoomTests,
    runUiBuild,
    runWebBuild,
    changedPathsComplete,
    changedPaths: changes.map((change) => change.path),
  };
}

export function classifyChangedPathDiff(baseSha, headSha, {
  cwd = REPOSITORY_DIRECTORY,
  runGit: executeGit = (args) => runGit(args, cwd),
} = {}) {
  validateSha(baseSha, 'baseSha');
  validateSha(headSha, 'headSha');
  const range = `${baseSha}...${headSha}`;
  const changes = parseNameStatus(
    executeGit(['diff', '--no-renames', '--name-status', '-z', range]),
    'changed-file diff',
  );
  const renames = parseNameStatus(
    executeGit(['diff', '--find-renames', '--name-status', '-z', range]),
    'rename diff',
  );
  return classifyChangedFiles(changes, renames);
}

function writeOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required for CI output.');
  appendFileSync(outputPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', 'utf8');
}

function appendSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, text, 'utf8');
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'resolve' && args.length === 0) {
    const range = resolveChangeRange({
      eventName: process.env.EVENT_NAME,
      integrationBaseSha: process.env.INTEGRATION_BASE_SHA,
      integrationHeadSha: process.env.INTEGRATION_HEAD_SHA,
      pullRequestBaseSha: process.env.PULL_REQUEST_BASE_SHA,
      pullRequestHeadSha: process.env.PULL_REQUEST_HEAD_SHA,
    });
    writeOutputs({
      change_base_sha: range.changeBaseSha,
      change_head_sha: range.changeHeadSha,
    });
    process.stdout.write(`${JSON.stringify(range)}\n`);
    return;
  }

  if (command === 'classify' && args.length === 2) {
    const result = classifyChangedPathDiff(args[0], args[1]);
    writeOutputs({
      run_level: result.runLevel,
      run_warroom_tests: result.runWarRoomTests,
      run_ui_build: result.runUiBuild,
      run_web_build: result.runWebBuild,
      changed_paths_complete: result.changedPathsComplete,
    });
    appendSummary([
      `Changed-path classification: ${result.runLevel}.`,
      `War Room Python tests selected: ${result.runWarRoomTests}.`,
      `Extension UI build selected: ${result.runUiBuild}.`,
      `Web build and Pages validation selected: ${result.runWebBuild}.`,
      '',
    ].join('\n'));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new TypeError('Usage: changed-files.mjs resolve | classify <base-sha> <head-sha>.');
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`CI changed-file classification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

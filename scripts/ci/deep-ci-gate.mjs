import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

function requireSha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a full 40-character commit SHA`);
  }
  return value;
}

export function resolveDeepCiRequest({ eventName, eventPayload, defaultSha }) {
  const fallbackSha = requireSha(defaultSha, 'defaultSha');

  if (eventName !== 'pull_request') {
    return { deepRequired: true, targetRef: fallbackSha };
  }

  const pullRequest = eventPayload?.pull_request;
  if (!pullRequest || typeof pullRequest !== 'object') {
    throw new Error('pull_request event payload is missing pull_request');
  }

  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels : [];
  const deepRequired = labels.some((label) => label?.name === 'deep-ci');

  return {
    deepRequired,
    targetRef: requireSha(pullRequest.head?.sha, 'pull_request.head.sha'),
  };
}

export function evaluateDeepCiGate({
  isPullRequest,
  deepRequired,
  deepResult,
  resolveResult,
}) {
  if (!isPullRequest) {
    return { success: true, reason: 'not-a-pull-request' };
  }
  if (resolveResult !== 'success') {
    return { success: false, reason: `resolve-${resolveResult || 'missing'}` };
  }
  if (deepRequired !== true) {
    return { success: true, reason: 'deep-ci-label-not-present' };
  }
  if (deepResult === 'success') {
    return { success: true, reason: 'deep-validation-succeeded' };
  }
  return { success: false, reason: `deep-${deepResult || 'missing'}` };
}

async function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  return JSON.parse(await readFile(eventPath, 'utf8'));
}

async function resolveCommand() {
  const result = resolveDeepCiRequest({
    eventName: process.env.GITHUB_EVENT_NAME,
    eventPayload: await readEventPayload(),
    defaultSha: process.env.GITHUB_SHA,
  });
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');

  await appendFile(
    outputPath,
    `deep_required=${result.deepRequired}\ntarget_ref=${result.targetRef}\n`,
  );
  process.stdout.write(
    `Deep validation required: ${result.deepRequired}; target: ${result.targetRef}\n`,
  );
}

function gateCommand() {
  const result = evaluateDeepCiGate({
    isPullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request',
    deepRequired: process.env.DEEP_REQUIRED === 'true',
    deepResult: process.env.DEEP_RESULT,
    resolveResult: process.env.RESOLVE_RESULT,
  });
  process.stdout.write(`Deep CI Gate: ${result.reason}\n`);
  if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'resolve') {
    await resolveCommand();
  } else if (command === 'gate') {
    gateCommand();
  } else {
    throw new Error('Usage: node scripts/ci/deep-ci-gate.mjs <resolve|gate>');
  }
}

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export class PagesReleaseApprovalError extends Error {
  constructor(message, code = 'PAGES_RELEASE_APPROVAL_ERROR') {
    super(message);
    this.name = 'PagesReleaseApprovalError';
    this.code = code;
  }
}

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function fail(message, code) {
  throw new PagesReleaseApprovalError(message, code);
}

function nextPageFromLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/u.exec(link);
    if (match) return match[1];
  }
  return null;
}

async function fetchJson(url, { token, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    fail(
      'GitHub release approval API request failed with HTTP ' + response.status + '.',
      'PAGES_RELEASE_APPROVAL_API',
    );
  }
  return {
    value: await response.json(),
    nextPage: nextPageFromLinkHeader(response.headers?.get('link')),
  };
}

async function fetchAllComments(url, options) {
  const comments = [];
  let pageUrl = url;
  while (pageUrl) {
    const page = await fetchJson(pageUrl, options);
    if (!Array.isArray(page.value)) {
      fail('GitHub release approval comments response is not an array.', 'PAGES_RELEASE_APPROVAL_API');
    }
    comments.push(...page.value);
    pageUrl = page.nextPage;
  }
  return comments.sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
}

function decisionLinesOutsideMarkdownFences(body) {
  const lines = [];
  let insideFence = false;
  const backtickFence = String.fromCharCode(96).repeat(3);

  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(backtickFence) || trimmed.startsWith('~~~')) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence) lines.push(line);
  }
  return lines;
}

function verifyDecisionComment(comment, releaseRevision, approverLogin) {
  if (!comment || typeof comment.body !== 'string') {
    fail('The final #157 comment must contain a structured release decision.', 'PAGES_RELEASE_APPROVAL_MISSING');
  }

  const commentLogin = comment.user?.login?.toLowerCase();
  if (commentLogin !== approverLogin.toLowerCase()
    || !TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.author_association)) {
    fail(
      'The final #157 decision must be authored by the configured approver with a trusted repository association.',
      'PAGES_RELEASE_APPROVER_MISMATCH',
    );
  }

  const lines = decisionLinesOutsideMarkdownFences(comment.body);
  const decisionLines = lines.filter((line) => (
    line.includes('APPROVE PUBLIC CUTOVER') || line.includes('HOLD PUBLIC CUTOVER')
  ));
  if (decisionLines.length !== 1 || decisionLines[0] !== 'Decision: APPROVE PUBLIC CUTOVER') {
    fail(
      'The final #157 comment must contain exactly one unquoted Decision: APPROVE PUBLIC CUTOVER line.',
      'PAGES_RELEASE_APPROVAL_FORMAT',
    );
  }

  const releaseLines = lines.filter((line) => line.includes('Release commit:'));
  if (releaseLines.length !== 1) {
    fail(
      'The final #157 comment must contain exactly one Release commit: line.',
      'PAGES_RELEASE_APPROVAL_FORMAT',
    );
  }
  const releaseMatch = /^Release commit: ([0-9a-f]{40})$/u.exec(releaseLines[0]);
  if (!releaseMatch) {
    fail(
      'The final #157 comment must use the exact Release commit: <full SHA> format.',
      'PAGES_RELEASE_APPROVAL_FORMAT',
    );
  }
  if (releaseMatch[1] !== releaseRevision) {
    fail(
      'The #157 decision does not approve this exact release SHA.',
      'PAGES_RELEASE_APPROVAL_MISSING',
    );
  }
}

export async function verifyPagesReleaseApproval({
  repository,
  token,
  releaseRevision,
  approverLogin,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository || '')) {
    fail('GITHUB_REPOSITORY must have owner/name form.', 'PAGES_RELEASE_APPROVAL_INPUT');
  }
  if (!token) {
    fail('GITHUB_TOKEN is required to verify the MO-8 release decision.', 'PAGES_RELEASE_APPROVAL_INPUT');
  }
  if (!/^[0-9a-f]{40}$/u.test(releaseRevision || '')) {
    fail('the approved release revision must be a full Git SHA.', 'PAGES_RELEASE_APPROVAL_INPUT');
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(approverLogin || '')) {
    fail('PAGES_RELEASE_APPROVER must name one GitHub account.', 'PAGES_RELEASE_APPROVAL_INPUT');
  }

  const expectedApprover = approverLogin.trim();
  const base = apiUrl.replace(/\/+$/u, '');
  const options = { token, fetchImpl };
  const issueResult = await fetchJson(
    base + '/repos/' + repository + '/issues/157',
    options,
  );
  if (issueResult.value.state !== 'closed') {
    fail('MO-8 issue #157 is not closed; Pages deployment remains blocked.', 'PAGES_RELEASE_APPROVAL_MISSING');
  }
  if (issueResult.value.closed_by?.login?.toLowerCase() !== expectedApprover.toLowerCase()) {
    fail(
      'MO-8 issue #157 must be closed by the configured Pages release approver.',
      'PAGES_RELEASE_APPROVER_MISMATCH',
    );
  }

  const comments = await fetchAllComments(
    base + '/repos/' + repository + '/issues/157/comments?per_page=100&sort=created&direction=asc',
    options,
  );
  verifyDecisionComment(comments.at(-1), releaseRevision, expectedApprover);

  return { issueNumber: 157, releaseRevision, approverLogin: expectedApprover };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyPagesReleaseApproval({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    releaseRevision: process.env.RELEASE_COMMIT_SHA,
    approverLogin: process.env.PAGES_RELEASE_APPROVER,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  console.log(
    'MO-8 Pages release approval verified for #'
      + result.issueNumber
      + ' at '
      + result.releaseRevision
      + '.',
  );
}

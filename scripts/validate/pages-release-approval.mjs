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
  return comments;
}

export async function verifyPagesReleaseApproval({
  repository,
  token,
  releaseRevision,
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

  const base = apiUrl.replace(/\/+$/u, '');
  const options = { token, fetchImpl };
  const issueResult = await fetchJson(
    base + '/repos/' + repository + '/issues/157',
    options,
  );
  if (issueResult.value.state !== 'closed') {
    fail('MO-8 issue #157 is not closed; Pages deployment remains blocked.', 'PAGES_RELEASE_APPROVAL_MISSING');
  }

  const comments = await fetchAllComments(
    base + '/repos/' + repository + '/issues/157/comments?per_page=100',
    options,
  );
  const finalComment = comments.at(-1)?.body;
  if (typeof finalComment !== 'string'
    || !finalComment.includes('APPROVE PUBLIC CUTOVER')
    || finalComment.includes('HOLD PUBLIC CUTOVER')
    || !finalComment.includes(releaseRevision)) {
    fail(
      'The final #157 comment must record APPROVE PUBLIC CUTOVER and the exact release SHA.',
      'PAGES_RELEASE_APPROVAL_MISSING',
    );
  }

  return { issueNumber: 157, releaseRevision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyPagesReleaseApproval({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    releaseRevision: process.env.RELEASE_COMMIT_SHA,
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyPagesReleaseApproval } from '../scripts/validate/pages-release-approval.mjs';

const REPOSITORY = 'neverworkalone/typewriter';
const RELEASE_REVISION = 'a'.repeat(40);

function apiResponse(value, link = null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) },
    json: async () => value,
  };
}

function fakeFetch(responses) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const response = responses.shift();
    if (!response) throw new Error('unexpected API request');
    return response;
  };
  return { fetchImpl, requests };
}

test('accepts a closed MO-8 gate whose final comment approves the same release SHA', async () => {
  const { fetchImpl, requests } = fakeFetch([
    apiResponse({ state: 'closed' }),
    apiResponse([{
      body: 'Decision: APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    }]),
  ]);
  const result = await verifyPagesReleaseApproval({
    repository: REPOSITORY,
    token: 'test-token',
    releaseRevision: RELEASE_REVISION,
    fetchImpl,
  });
  assert.equal(result.issueNumber, 157);
  assert.equal(requests.length, 2);
  assert.match(requests[0].options.headers.Authorization, /^Bearer /u);
});

test('rejects an open MO-8 issue even when comments mention approval', async () => {
  const { fetchImpl } = fakeFetch([apiResponse({ state: 'open' })]);
  await assert.rejects(
    verifyPagesReleaseApproval({
      repository: REPOSITORY,
      token: 'test-token',
      releaseRevision: RELEASE_REVISION,
      fetchImpl,
    }),
    { code: 'PAGES_RELEASE_APPROVAL_MISSING' },
  );
});

test('rejects an approval comment for a different release SHA or a hold decision', async () => {
  const differentSha = 'c'.repeat(40);
  const { fetchImpl: differentShaFetch } = fakeFetch([
    apiResponse({ state: 'closed' }),
    apiResponse([{ body: 'APPROVE PUBLIC CUTOVER\nRelease commit: ' + differentSha }]),
  ]);
  await assert.rejects(
    verifyPagesReleaseApproval({
      repository: REPOSITORY,
      token: 'test-token',
      releaseRevision: RELEASE_REVISION,
      fetchImpl: differentShaFetch,
    }),
    { code: 'PAGES_RELEASE_APPROVAL_MISSING' },
  );

  const { fetchImpl: holdFetch } = fakeFetch([
    apiResponse({ state: 'closed' }),
    apiResponse([{
      body: 'HOLD PUBLIC CUTOVER\nAPPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    }]),
  ]);
  await assert.rejects(
    verifyPagesReleaseApproval({
      repository: REPOSITORY,
      token: 'test-token',
      releaseRevision: RELEASE_REVISION,
      fetchImpl: holdFetch,
    }),
    { code: 'PAGES_RELEASE_APPROVAL_MISSING' },
  );
});

test('checks the final comment across GitHub API pagination', async () => {
  const nextUrl = 'https://api.github.com/repos/neverworkalone/typewriter/issues/157/comments?page=2';
  const { fetchImpl, requests } = fakeFetch([
    apiResponse({ state: 'closed' }),
    apiResponse([{ body: 'Earlier discussion' }], '<' + nextUrl + '>; rel="next"'),
    apiResponse([{
      body: 'APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    }]),
  ]);
  await verifyPagesReleaseApproval({
    repository: REPOSITORY,
    token: 'test-token',
    releaseRevision: RELEASE_REVISION,
    fetchImpl,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, nextUrl);
});

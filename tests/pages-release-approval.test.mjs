import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyPagesReleaseApproval } from '../scripts/validate/pages-release-approval.mjs';

const REPOSITORY = 'neverworkalone/typewriter';
const APPROVER = 'genonfire';
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

function approvalComment(body, {
  login = APPROVER,
  authorAssociation = 'MEMBER',
  id = 1,
} = {}) {
  return {
    id,
    body,
    user: { login },
    author_association: authorAssociation,
  };
}

function gateResponses(comment, { closedBy = APPROVER } = {}) {
  return [
    apiResponse({ state: 'closed', closed_by: { login: closedBy } }),
    apiResponse([comment]),
  ];
}

async function verify(responses, overrides = {}) {
  const { fetchImpl } = fakeFetch(responses);
  return verifyPagesReleaseApproval({
    repository: REPOSITORY,
    token: 'test-token',
    releaseRevision: RELEASE_REVISION,
    approverLogin: APPROVER,
    fetchImpl,
    ...overrides,
  });
}

function approvedBody(revision = RELEASE_REVISION) {
  return 'Final MO-8 report\nDecision: APPROVE PUBLIC CUTOVER\nRelease commit: '
    + revision
    + '\nAll release-gate evidence is recorded above.';
}

test('accepts the configured trusted approver exact decision for the same release SHA', async () => {
  const { fetchImpl, requests } = fakeFetch(gateResponses(approvalComment(approvedBody())));
  const result = await verifyPagesReleaseApproval({
    repository: REPOSITORY,
    token: 'test-token',
    releaseRevision: RELEASE_REVISION,
    approverLogin: APPROVER,
    fetchImpl,
  });
  assert.equal(result.issueNumber, 157);
  assert.equal(result.approverLogin, APPROVER);
  assert.equal(requests.length, 2);
  assert.match(requests[0].options.headers.Authorization, /^Bearer /u);
});

test('rejects an open MO-8 issue even when comments mention approval', async () => {
  await assert.rejects(
    verify([apiResponse({ state: 'open' })]),
    { code: 'PAGES_RELEASE_APPROVAL_MISSING' },
  );
});

test('rejects an exact approval comment from an unconfigured author', async () => {
  await assert.rejects(
    verify(gateResponses(approvalComment(approvedBody(), {
      login: 'untrusted-user',
      authorAssociation: 'NONE',
    }))),
    { code: 'PAGES_RELEASE_APPROVER_MISMATCH' },
  );
});

test('rejects the configured login when GitHub does not report a trusted association', async () => {
  await assert.rejects(
    verify(gateResponses(approvalComment(approvedBody(), {
      authorAssociation: 'CONTRIBUTOR',
    }))),
    { code: 'PAGES_RELEASE_APPROVER_MISMATCH' },
  );
});

test('requires the configured approver to close MO-8 as well as author its decision', async () => {
  await assert.rejects(
    verify(gateResponses(approvalComment(approvedBody()), { closedBy: 'another-maintainer' })),
    { code: 'PAGES_RELEASE_APPROVER_MISMATCH' },
  );
});

test('rejects negated, quoted, embedded, or conflicting decision text', async (t) => {
  const fence = String.fromCharCode(96).repeat(3);
  const newline = String.fromCharCode(10);
  const invalidBodies = [
    fence + 'text' + newline + 'Decision: APPROVE PUBLIC CUTOVER' + newline
      + 'Release commit: ' + RELEASE_REVISION + newline + fence,
    'cannot APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    '> Decision: APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    'Decision: APPROVE PUBLIC CUTOVER (not approved)\nRelease commit: ' + RELEASE_REVISION,
    'Decision: APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION
      + '\nHOLD PUBLIC CUTOVER',
    'Decision: HOLD PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION,
    'Decision: APPROVE PUBLIC CUTOVER\nRelease commit: ' + RELEASE_REVISION
      + '\nRelease commit: ' + RELEASE_REVISION,
  ];
  for (const [index, body] of invalidBodies.entries()) {
    await t.test('format ' + (index + 1), async () => {
      await assert.rejects(
        verify(gateResponses(approvalComment(body))),
        { code: 'PAGES_RELEASE_APPROVAL_FORMAT' },
      );
    });
  }
});

test('rejects an approval for a different release SHA', async () => {
  await assert.rejects(
    verify(gateResponses(approvalComment(approvedBody('c'.repeat(40))))),
    { code: 'PAGES_RELEASE_APPROVAL_MISSING' },
  );
});

test('rejects a closed issue whose final comment is not the approval decision', async () => {
  const priorApproval = approvalComment(approvedBody(), { id: 1 });
  const laterComment = approvalComment('Thanks, noted.', { id: 2 });
  const { fetchImpl } = fakeFetch([
    apiResponse({ state: 'closed', closed_by: { login: APPROVER } }),
    apiResponse([priorApproval, laterComment]),
  ]);
  await assert.rejects(
    verifyPagesReleaseApproval({
      repository: REPOSITORY,
      token: 'test-token',
      releaseRevision: RELEASE_REVISION,
      approverLogin: APPROVER,
      fetchImpl,
    }),
    { code: 'PAGES_RELEASE_APPROVAL_FORMAT' },
  );
});

test('checks the final comment across GitHub API pagination', async () => {
  const nextUrl = 'https://api.github.com/repos/neverworkalone/typewriter/issues/157/comments?page=2';
  const { fetchImpl, requests } = fakeFetch([
    apiResponse({ state: 'closed', closed_by: { login: APPROVER } }),
    apiResponse([approvalComment('Earlier discussion', { id: 1 })], '<' + nextUrl + '>; rel="next"'),
    apiResponse([approvalComment(approvedBody(), { id: 2 })]),
  ]);
  await verifyPagesReleaseApproval({
    repository: REPOSITORY,
    token: 'test-token',
    releaseRevision: RELEASE_REVISION,
    approverLogin: APPROVER,
    fetchImpl,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, nextUrl);
});

test('requires an explicitly configured approver', async () => {
  const { fetchImpl } = fakeFetch([]);
  await assert.rejects(
    verifyPagesReleaseApproval({
      repository: REPOSITORY,
      token: 'test-token',
      releaseRevision: RELEASE_REVISION,
      fetchImpl,
    }),
    { code: 'PAGES_RELEASE_APPROVAL_INPUT' },
  );
});

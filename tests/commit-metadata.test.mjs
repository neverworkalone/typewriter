import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitRange,
  findUnapprovedCommitEmails,
  isGitHubNoReplyAddress,
  parseCommitMetadata,
} from '../scripts/validate/commit-metadata.mjs';

test('pull request metadata range excludes GitHub generated merge commit', () => {
  const calls = [];
  const range = commitRange({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_BASE_REF: 'master',
  }, (...args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return 'base-sha';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^2') return 'pull-request-head-sha';
    throw new Error('unexpected git invocation');
  });

  assert.equal(range, 'base-sha..pull-request-head-sha');
  assert.deepEqual(calls, [
    ['merge-base', 'HEAD', 'origin/master'],
    ['rev-parse', 'HEAD^2'],
  ]);
});

test('GitHub no-reply commit addresses are accepted', () => {
  assert.equal(isGitHubNoReplyAddress('2526178+genonfire@users.noreply.github.com'), true);
  assert.equal(isGitHubNoReplyAddress('noreply@github.com'), true);
});

test('personal-domain commit addresses are rejected without printing the address', () => {
  assert.equal(isGitHubNoReplyAddress('writer@example.test'), false);
  const findings = findUnapprovedCommitEmails([{
    sha: '0123456789abcdef',
    authorEmail: 'writer@example.test',
    committerEmail: 'noreply@github.com',
  }]);
  assert.deepEqual(findings, [{ sha: '0123456789abcdef', role: 'author' }]);
});

test('commit log records are parsed without losing author or committer boundaries', () => {
  const commits = parseCommitMetadata([
    '0123456789abcdef\t2526178+genonfire@users.noreply.github.com\tnoreply@github.com',
    'fedcba9876543210\twriter@example.test\t2526178+genonfire@users.noreply.github.com',
  ].join('\n'));

  assert.deepEqual(commits, [
    {
      sha: '0123456789abcdef',
      authorEmail: '2526178+genonfire@users.noreply.github.com',
      committerEmail: 'noreply@github.com',
    },
    {
      sha: 'fedcba9876543210',
      authorEmail: 'writer@example.test',
      committerEmail: '2526178+genonfire@users.noreply.github.com',
    },
  ]);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUnapprovedCommitEmails,
  isGitHubNoReplyAddress,
  parseCommitMetadata,
} from '../scripts/validate/commit-metadata.mjs';

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

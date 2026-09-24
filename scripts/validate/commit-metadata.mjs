import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const ZERO_SHA = /^0+$/u;

function git(...args) {
  return execFileSync('git', args, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: 'utf8',
  }).trim();
}

export function isGitHubNoReplyAddress(email) {
  const normalizedEmail = email.trim().toLowerCase();
  return normalizedEmail === 'noreply@github.com'
    || /^[^@\s]+@users\.noreply\.github\.com$/u.test(normalizedEmail);
}

export function parseCommitMetadata(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, authorEmail, committerEmail] = line.split('\t');
      return { sha, authorEmail, committerEmail };
    });
}

export function findUnapprovedCommitEmails(commits) {
  const findings = [];
  for (const commit of commits) {
    if (!isGitHubNoReplyAddress(commit.authorEmail)) {
      findings.push({ sha: commit.sha, role: 'author' });
    }
    if (!isGitHubNoReplyAddress(commit.committerEmail)) {
      findings.push({ sha: commit.sha, role: 'committer' });
    }
  }
  return findings;
}

function firstParentRange(runGit = git) {
  try {
    return `${runGit('rev-parse', 'HEAD^')}..HEAD`;
  } catch {
    return 'HEAD';
  }
}

export function commitRange(environment = process.env, runGit = git) {
  if (environment.GITHUB_BASE_REF) {
    const baseRef = `origin/${environment.GITHUB_BASE_REF}`;
    const mergeBase = runGit('merge-base', 'HEAD', baseRef);
    if (environment.GITHUB_EVENT_NAME === 'pull_request') {
      try {
        // actions/checkout defaults to GitHub's temporary PR merge commit.
        // Check the PR branch tip, not the generated merge commit's author.
        const pullRequestHead = runGit('rev-parse', 'HEAD^2');
        return `${mergeBase}..${pullRequestHead}`;
      } catch {
        // Keep working if a caller checks out the PR head directly.
      }
    }
    return `${mergeBase}..HEAD`;
  }

  if (
    environment.GITHUB_EVENT_NAME === 'push'
    && environment.GITHUB_EVENT_BEFORE
    && !ZERO_SHA.test(environment.GITHUB_EVENT_BEFORE)
  ) {
    return `${environment.GITHUB_EVENT_BEFORE}..HEAD`;
  }

  try {
    const upstream = runGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
    return `${runGit('merge-base', 'HEAD', upstream)}..HEAD`;
  } catch {
    return firstParentRange(runGit);
  }
}

export function validateCommitMetadata({ environment = process.env } = {}) {
  const range = commitRange(environment);
  const output = git('log', '--format=%H%x09%ae%x09%ce', range);
  const commits = parseCommitMetadata(output);
  const findings = findUnapprovedCommitEmails(commits);
  if (findings.length > 0) {
    const summary = findings
      .map(({ sha, role }) => `${sha.slice(0, 12)}: non-GitHub ${role} email`)
      .join('\n');
    throw new Error(`Commit metadata check failed:\n${summary}`);
  }
  return { checkedCommitCount: commits.length };
}

function main() {
  const { checkedCommitCount } = validateCommitMetadata();
  console.log(`Commit metadata check passed: ${checkedCommitCount} new commit(s) use GitHub no-reply addresses.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

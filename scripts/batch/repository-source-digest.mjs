import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function sourceDigestExistsInGitHistory(relativePath, expectedDigest, repositoryRoot) {
  let commits;
  try {
    commits = execFileSync('git', ['rev-list', '--all', '--', relativePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s+/u).filter(Boolean);
  } catch {
    return false;
  }
  return commits.some((commit) => {
    try {
      const bytes = execFileSync('git', ['show', `${commit}:${relativePath}`], {
        cwd: repositoryRoot,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return sha256Bytes(bytes) === expectedDigest;
    } catch {
      return false;
    }
  });
}

export async function assertSourceDigestRetained({ relativePath, expectedDigest, label, repositoryRoot }) {
  const currentDigest = sha256Bytes(await readFile(path.join(repositoryRoot, relativePath)));
  if (currentDigest === expectedDigest || sourceDigestExistsInGitHistory(relativePath, expectedDigest, repositoryRoot)) return true;
  throw new Error(`${label} source digest must match the current source or a source version retained in Git history`);
}

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const FULL_REVISION_PATTERN = /^[0-9a-f]{40}$/i;

export const BUILD_TOOL_VERSION = '1';

async function runGit(repositoryDirectory, args) {
  try {
    const result = await execFile('git', args, {
      cwd: repositoryDirectory,
      encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch (error) {
    if (
      error.code === 'ENOENT' ||
      (error.code === 128 && /not a git repository/i.test(error.stderr ?? ''))
    ) {
      error.gitUnavailable = true;
    }
    throw error;
  }
}

function invalidRevision(message) {
  const error = new Error(message);
  error.code = 'INVALID_SOURCE_REVISION';
  return error;
}

export async function resolveBuildProvenance({
  repositoryDirectory = process.cwd(),
  sourceRevision,
  allowDirty = false,
} = {}) {
  const explicitRevision = sourceRevision !== undefined;
  let gitHead;
  let gitAvailable = true;

  try {
    gitHead = await runGit(repositoryDirectory, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    gitAvailable = !error.gitUnavailable;
    if (!explicitRevision) {
      const unavailable = new Error(
        `could not resolve Git HEAD in ${repositoryDirectory}: ${error.message.trim()}`,
      );
      unavailable.code = 'SOURCE_REVISION_UNAVAILABLE';
      throw unavailable;
    }
  }

  let resolvedRevision;
  let revisionSource;
  let revisionVerified;

  if (explicitRevision) {
    if (typeof sourceRevision !== 'string' || sourceRevision.trim().length === 0) {
      throw invalidRevision('sourceRevision must be a non-empty string');
    }

    if (gitAvailable) {
      try {
        resolvedRevision = await runGit(repositoryDirectory, [
          'rev-parse',
          '--verify',
          `${sourceRevision}^{commit}`,
        ]);
      } catch (error) {
        throw invalidRevision(
          `sourceRevision ${sourceRevision} is not a valid Git commit: ${error.message.trim()}`,
        );
      }
      revisionSource = 'explicit-git';
      revisionVerified = 'true';
    } else {
      if (!FULL_REVISION_PATTERN.test(sourceRevision)) {
        throw invalidRevision(
          'Git is unavailable; an explicit sourceRevision must be a full 40-character commit SHA',
        );
      }
      resolvedRevision = sourceRevision.toLowerCase();
      revisionSource = 'explicit-unverified';
      revisionVerified = 'false';
    }
  } else {
    resolvedRevision = gitHead;
    revisionSource = 'git-head';
    revisionVerified = 'true';
  }

  let worktreeState = gitAvailable ? 'clean' : 'unavailable';
  if (gitAvailable) {
    let status;
    try {
      status = await runGit(repositoryDirectory, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
    } catch (error) {
      const unavailable = new Error(
        `could not inspect Git worktree in ${repositoryDirectory}: ${error.message.trim()}`,
      );
      unavailable.code = 'SOURCE_REVISION_UNAVAILABLE';
      throw unavailable;
    }

    if (status.length > 0) {
      if (!allowDirty) {
        const dirty = new Error(
          `Git worktree is dirty in ${repositoryDirectory}; commit changes or pass allowDirty only for an explicitly non-reproducible build`,
        );
        dirty.code = 'DIRTY_WORKTREE';
        throw dirty;
      }
      worktreeState = 'dirty-allowed';
    }
  }

  return {
    source_revision: resolvedRevision,
    source_revision_source: revisionSource,
    source_revision_verified: revisionVerified,
    worktree_state: worktreeState,
    build_tool_version: BUILD_TOOL_VERSION,
  };
}

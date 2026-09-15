import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
export const DEFAULT_POLICY_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'config/artifact-policy.json',
);

export class ArtifactPolicyError extends Error {
  constructor(message, code = 'ARTIFACT_POLICY_ERROR') {
    super(message);
    this.name = 'ArtifactPolicyError';
    this.code = code;
  }
}

function fail(message, code = 'ARTIFACT_POLICY_ERROR') {
  throw new ArtifactPolicyError(message, code);
}

function patternRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '[^/]*')}$`, 'u');
}

function matchesPattern(filePath, pattern) {
  return patternRegExp(pattern).test(filePath);
}

function isProtectedPath(filePath, roots) {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

function trackedFiles(repositoryDirectory) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean);
}

function gitStatus(repositoryDirectory) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  }).trim();
}

async function existingProjectionFiles(repositoryDirectory, patterns) {
  const files = [];
  for (const pattern of patterns) {
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex < 0) {
      try {
        await stat(path.join(repositoryDirectory, pattern));
        files.push(pattern);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      continue;
    }

    const directory = pattern.slice(0, wildcardIndex).replace(/\/$/u, '');
    const entries = await readdir(path.join(repositoryDirectory, directory));
    for (const entry of entries) {
      const relativePath = path.posix.join(directory, entry);
      if (matchesPattern(relativePath, pattern)) files.push(relativePath);
    }
  }
  return files.sort();
}

export async function readArtifactPolicy(policyPath = DEFAULT_POLICY_PATH) {
  try {
    return JSON.parse(await readFile(policyPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`artifact policy is not valid JSON: ${policyPath}`, 'POLICY_JSON');
    }
    throw error;
  }
}

export function classifyTrackedArtifacts(
  files,
  {
    deterministicProjectionPatterns,
    durableTrackedPatterns,
    protectedRoots,
  },
) {
  const generated = [];
  const unclassified = [];
  for (const filePath of files) {
    if (deterministicProjectionPatterns.some((pattern) => matchesPattern(filePath, pattern))) {
      generated.push(filePath);
      continue;
    }
    if (isProtectedPath(filePath, protectedRoots)
      && !durableTrackedPatterns.some((pattern) => matchesPattern(filePath, pattern))) {
      unclassified.push(filePath);
    }
  }
  return { generated, unclassified };
}

export async function validateArtifactPolicy({
  repositoryDirectory = REPOSITORY_DIRECTORY,
  policyPath = DEFAULT_POLICY_PATH,
  tracked = trackedFiles(repositoryDirectory),
  checkClean = false,
} = {}) {
  const policy = await readArtifactPolicy(policyPath);
  const requiredKeys = [
    'protected_roots',
    'deterministic_projection_patterns',
    'durable_tracked_patterns',
  ];
  for (const key of requiredKeys) {
    if (!Array.isArray(policy[key]) || policy[key].length === 0) {
      fail(`artifact policy ${key} must be a non-empty array`, 'POLICY_SHAPE');
    }
  }

  const { generated, unclassified } = classifyTrackedArtifacts(tracked, {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
  });
  if (generated.length > 0) {
    fail(
      `deterministic projections must not be Git-tracked: ${generated.join(', ')}`,
      'GENERATED_PROJECTION_TRACKED',
    );
  }
  if (unclassified.length > 0) {
    fail(
      `protected data artifact is not classified as durable evidence: ${unclassified.join(', ')}`,
      'UNCLASSIFIED_ARTIFACT',
    );
  }

  const presentProjections = await existingProjectionFiles(
    repositoryDirectory,
    policy.deterministic_projection_patterns,
  );
  if (presentProjections.length > 0) {
    fail(
      `deterministic projections must be materialized outside the repository: ${presentProjections.join(', ')}`,
      'GENERATED_PROJECTION_PRESENT',
    );
  }

  if (checkClean) {
    const status = gitStatus(repositoryDirectory);
    if (status.length > 0) {
      fail(`validation workflow left the working tree dirty:\n${status}`, 'DIRTY_WORKTREE');
    }
  }

  return {
    policyPath,
    trackedArtifactCount: tracked.filter((filePath) => isProtectedPath(filePath, policy.protected_roots)).length,
    generatedProjectionCount: generated.length,
    unclassifiedArtifactCount: unclassified.length,
    workingTreeClean: checkClean,
  };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateArtifactPolicy({
    checkClean: process.argv.includes('--clean'),
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
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
  return new RegExp(
    `^${escaped.replaceAll('**', '__GLOBSTAR__').replaceAll('*', '[^/]*').replaceAll('__GLOBSTAR__', '.*')}$`,
    'u',
  );
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

async function listFiles(directory, relativeDirectory = '') {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function existingProjectionFiles(
  repositoryDirectory,
  patterns,
  excludedPatterns = [],
  projectionRoles = {},
) {
  const files = await listFiles(path.join(repositoryDirectory, 'data'), 'data');
  const artifactRoles = await artifactRolesForFiles(repositoryDirectory, files, projectionRoles);
  return files
    .filter((filePath) => patterns.some((pattern) => matchesPattern(filePath, pattern))
      || artifactRoles.has(filePath))
    .filter((filePath) => !excludedPatterns.some((pattern) => matchesPattern(filePath, pattern)))
    .sort();
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

export function detectProjectionRole(value, projectionRoles = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contractVersion = value.contract_version;
  if (projectionRoles.semanticAuditContractVersions?.includes(contractVersion)) {
    return 'semantic-audit';
  }
  if (projectionRoles.semanticCoverageContractVersions?.includes(contractVersion)) {
    return 'semantic-coverage';
  }
  if (projectionRoles.semanticReviewContractVersions?.includes(contractVersion)) {
    return 'semantic-review';
  }
  if (projectionRoles.targetInventoryIds?.includes(value.inventory_id)
    && value.canonical_snapshot
    && Array.isArray(value.entries)) {
    return 'target-inventory';
  }
  return undefined;
}

async function artifactRolesForFiles(repositoryDirectory, files, projectionRoles) {
  const roles = new Map();
  for (const filePath of files) {
    if (!filePath.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readFile(path.join(repositoryDirectory, filePath), 'utf8'));
      const role = detectProjectionRole(value, projectionRoles);
      if (role) roles.set(filePath, role);
    } catch (error) {
      // JSON/schema validation owns malformed durable artifacts; path policy still applies.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return roles;
}

export function classifyTrackedArtifacts(
  files,
  {
    deterministicProjectionPatterns,
    relocatableProjectionPatterns = [],
    durableProjectionPatterns = [],
    durableTrackedPatterns,
    protectedRoots,
    artifactRoles = new Map(),
  },
) {
  const generated = [];
  const unclassified = [];
  for (const filePath of files) {
    if (durableProjectionPatterns.some((pattern) => matchesPattern(filePath, pattern))) {
      continue;
    }
    if (deterministicProjectionPatterns.some((pattern) => matchesPattern(filePath, pattern))
      || relocatableProjectionPatterns.some((pattern) => matchesPattern(filePath, pattern))
      || artifactRoles.has(filePath)) {
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
    'relocatable_projection_patterns',
    'durable_projection_patterns',
    'durable_tracked_patterns',
  ];
  for (const key of requiredKeys) {
    if (!Array.isArray(policy[key]) || policy[key].length === 0) {
      fail(`artifact policy ${key} must be a non-empty array`, 'POLICY_SHAPE');
    }
  }
  if (!policy.projection_roles || typeof policy.projection_roles !== 'object') {
    fail('artifact policy projection_roles must be an object', 'POLICY_SHAPE');
  }
  const projectionRoleKeys = [
    'semantic_audit_contract_versions',
    'semantic_coverage_contract_versions',
    'semantic_review_contract_versions',
    'target_inventory_ids',
  ];
  for (const key of projectionRoleKeys) {
    if (!Array.isArray(policy.projection_roles[key]) || policy.projection_roles[key].length === 0) {
      fail(`artifact policy projection_roles.${key} must be a non-empty array`, 'POLICY_SHAPE');
    }
  }

  const projectionRoles = {
    semanticAuditContractVersions: policy.projection_roles.semantic_audit_contract_versions,
    semanticCoverageContractVersions: policy.projection_roles.semantic_coverage_contract_versions,
    semanticReviewContractVersions: policy.projection_roles.semantic_review_contract_versions,
    targetInventoryIds: policy.projection_roles.target_inventory_ids,
  };
  const artifactRoles = await artifactRolesForFiles(
    repositoryDirectory,
    tracked,
    projectionRoles,
  );
  const { generated, unclassified } = classifyTrackedArtifacts(tracked, {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    relocatableProjectionPatterns: policy.relocatable_projection_patterns,
    durableProjectionPatterns: policy.durable_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
    artifactRoles,
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
    [
      ...policy.deterministic_projection_patterns,
      ...policy.relocatable_projection_patterns,
    ],
    policy.durable_projection_patterns,
    projectionRoles,
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

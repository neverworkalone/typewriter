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

function validateCompactPreflight(value, filePath, label, semantics) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${filePath} ${label} must be an object`, 'DURABLE_GATE_POLICY_SHAPE');
  }
  const extraFields = Object.keys(value).filter((key) => !semantics.preflight_allowed_fields.includes(key));
  if (extraFields.length > 0) {
    fail(
      `${filePath} ${label} stores non-durable preflight fields: ${extraFields.join(', ')}`,
      'DURABLE_GATE_DUPLICATION',
    );
  }
  if (!value.contract_version || !value.status || !value.input_canonical_directory_sha256
    || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) {
    fail(`${filePath} ${label} is not a compact preflight manifest`, 'DURABLE_GATE_POLICY_SHAPE');
  }
  for (const [checkName, check] of Object.entries(value.checks)) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      fail(`${filePath} ${label}.checks.${checkName} must be an object`, 'DURABLE_GATE_POLICY_SHAPE');
    }
    const checkExtraFields = Object.keys(check)
      .filter((key) => !semantics.preflight_check_allowed_fields.includes(key));
    if (checkExtraFields.length > 0) {
      fail(
        `${filePath} ${label}.checks.${checkName} stores non-durable fields: ${checkExtraFields.join(', ')}`,
        'DURABLE_GATE_DUPLICATION',
      );
    }
  }
}

function validateClosedObjectFields(value, allowedFields, filePath, label, code = 'DURABLE_EVIDENCE_POLICY_SHAPE') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${filePath} ${label} must be an object`, code);
  }
  const allowed = new Set(allowedFields);
  const extraFields = Object.keys(value).filter((key) => !allowed.has(key));
  if (extraFields.length > 0) {
    fail(
      `${filePath} ${label} contains unknown durable fields: ${extraFields.join(', ')}`,
      code,
    );
  }
}

function resolveClosedObjectTargets(value, selector) {
  const segments = selector.split('.').filter((segment) => segment !== '$' && segment.length > 0);
  let targets = [value];
  for (const segment of segments) {
    const next = [];
    for (const target of targets) {
      if (segment === '*') {
        if (Array.isArray(target)) next.push(...target);
        else if (target && typeof target === 'object') next.push(...Object.values(target));
      } else if (target && typeof target === 'object' && Object.hasOwn(target, segment)) {
        next.push(target[segment]);
      }
    }
    targets = next;
  }
  return targets;
}

function validateNestedClosedObjects(value, nestedAllowedFields, filePath, label) {
  for (const [selector, allowedFields] of Object.entries(nestedAllowedFields ?? {})) {
    for (const target of resolveClosedObjectTargets(value, selector)) {
      validateClosedObjectFields(target, allowedFields, filePath, `${label}${selector.slice(1)}`);
    }
  }
}

function validateClosedContract(value, filePath, semantics, label) {
  const contracts = semantics.closed_contracts ?? {};
  for (const [contractName, contract] of Object.entries(contracts)) {
    if (!Array.isArray(contract.contract_versions)
      || !contract.contract_versions.includes(value?.contract_version)) continue;
    if (!Array.isArray(contract.allowed_fields)) {
      fail(`artifact policy durable_semantics.closed_contracts.${contractName}.allowed_fields must be an array`, 'POLICY_SHAPE');
    }
    validateClosedObjectFields(value, contract.allowed_fields, filePath, label);
    validateNestedClosedObjects(value, contract.nested_allowed_fields, filePath, label);
    return contract;
  }
  return undefined;
}

function validateCompactGateArtifact(value, filePath, semantics) {
  const gate = value?.gate;
  if (gate?.contract_version === 'lexical-batch-gate-v2') {
    validateClosedObjectFields(gate, semantics.gate_allowed_fields, filePath, 'gate');
  }

  const gateEvidence = value?.gate_evidence;
  if (!gateEvidence || !semantics.gate_contract_versions.includes(gateEvidence.contract_version)) {
    if (value?.preflight) validateCompactPreflight(value.preflight, filePath, 'preflight', semantics);
    return;
  }

  validateClosedObjectFields(
    gateEvidence,
    semantics.gate_evidence_allowed_fields,
    filePath,
    'gate_evidence',
  );
  if (gateEvidence.inputs) {
    validateClosedObjectFields(
      gateEvidence.inputs,
      semantics.gate_inputs_allowed_fields,
      filePath,
      'gate_evidence.inputs',
    );
  }

  const forbiddenTopLevel = semantics.gate_forbidden_fields
    .filter((field) => Object.hasOwn(value, field));
  if (forbiddenTopLevel.length > 0) {
    fail(
      `${filePath} stores reconstructible gate outputs: ${forbiddenTopLevel.join(', ')}`,
      'DURABLE_GATE_DUPLICATION',
    );
  }
  const forbiddenGateFields = [
    ...semantics.gate_forbidden_fields,
    'fixed_gate',
  ].filter((field) => Object.hasOwn(gateEvidence, field));
  if (forbiddenGateFields.length > 0) {
    fail(
      `${filePath}.gate_evidence stores reconstructible gate outputs: ${forbiddenGateFields.join(', ')}`,
      'DURABLE_GATE_DUPLICATION',
    );
  }
  if (value.preflight) validateCompactPreflight(value.preflight, filePath, 'preflight', semantics);
  if (gateEvidence.preflight) {
    validateCompactPreflight(gateEvidence.preflight, filePath, 'gate_evidence.preflight', semantics);
  }
  const audit = gateEvidence.complete_audit;
  if (audit) {
    validateClosedObjectFields(
      audit,
      semantics.gate_complete_audit_allowed_fields,
      filePath,
      'gate_evidence.complete_audit',
      'DURABLE_GATE_DUPLICATION',
    );
  }
}

function validateCompactDecisionSource(value, filePath, semantics) {
  if (!semantics.batch_decision_contract_versions.includes(value.contract_version)
    || !Array.isArray(value.decisions)) return;
  const contract = semantics.closed_contracts?.decision_source;
  if (!contract) fail('artifact policy is missing the decision-source closed contract', 'POLICY_SHAPE');
  validateClosedObjectFields(value, contract.allowed_fields, filePath, 'decision source');
  for (const [index, row] of value.decisions.entries()) {
    validateClosedObjectFields(
      row,
      contract.decision_allowed_fields,
      filePath,
      `decision ${index}`,
    );
    for (const field of semantics.batch_decision_required_fields) {
      if (!Object.hasOwn(row, field)) {
        fail(
          `${filePath} decision ${index} is missing compact field ${field}`,
          'DURABLE_EVIDENCE_POLICY_SHAPE',
        );
      }
    }
    const duplicated = semantics.batch_decision_forbidden_fields
      .filter((field) => Object.hasOwn(row, field));
    if (duplicated.length > 0) {
      fail(
        `${filePath} decision ${index} stores reconstructible duplicate fields: ${duplicated.join(', ')}`,
        'DURABLE_EVIDENCE_DUPLICATION',
      );
    }
    if (!Array.isArray(row.sense_reviews)) {
      fail(`${filePath} decision ${index}.sense_reviews must be an array`, 'DURABLE_EVIDENCE_POLICY_SHAPE');
    }
    for (const [senseIndex, senseReview] of row.sense_reviews.entries()) {
      validateClosedObjectFields(
        senseReview,
        contract.sense_review_allowed_fields,
        filePath,
        `decision ${index}.sense_reviews[${senseIndex}]`,
      );
      for (const field of semantics.batch_decision_forbidden_fields) {
        if (Object.hasOwn(senseReview, field)
          && !['sense_id', 'semantic_rationale', 'boundary_rationale', 'relation_decision', 'relation_count', 'relation_ids', 'no_relation_rationale'].includes(field)) {
          fail(
            `${filePath} decision ${index}.sense_reviews[${senseIndex}] stores reconstructible duplicate field ${field}`,
            'DURABLE_EVIDENCE_DUPLICATION',
          );
        }
      }
      if (senseReview.review_basis) {
        validateClosedObjectFields(
          senseReview.review_basis,
          contract.review_basis_allowed_fields,
          filePath,
          `decision ${index}.sense_reviews[${senseIndex}].review_basis`,
        );
        for (const [basisKey, basisValue] of Object.entries(senseReview.review_basis)) {
          if (basisKey === 'topic_analysis') {
            validateClosedObjectFields(
              basisValue,
              contract.review_basis_topic_allowed_fields,
              filePath,
              `decision ${index}.sense_reviews[${senseIndex}].review_basis.topic_analysis`,
            );
          } else if (basisKey === 'topic_analyses') {
            if (!Array.isArray(basisValue)) {
              fail(
                `${filePath} decision ${index}.sense_reviews[${senseIndex}].review_basis.topic_analyses must be an array`,
                'DURABLE_EVIDENCE_POLICY_SHAPE',
              );
            }
            basisValue.forEach((analysis, analysisIndex) => validateClosedObjectFields(
              analysis,
              contract.review_basis_topic_allowed_fields,
              filePath,
              `decision ${index}.sense_reviews[${senseIndex}].review_basis.topic_analyses[${analysisIndex}]`,
            ));
          }
        }
        const keys = Object.keys(senseReview.review_basis);
        if (keys.some((key) => !['topic_analysis', 'topic_analyses'].includes(key))) {
          fail(
            `${filePath} decision ${index}.sense_reviews[${senseIndex}].review_basis contains derived fields`,
            'DURABLE_EVIDENCE_DUPLICATION',
          );
        }
      }
    }
  }
}

function validateCanonicalBatchBindings(value, filePath, semantics) {
  if (!Array.isArray(value?.authored_review?.records)) return;
  const allowed = new Set(semantics.canonical_batch_binding_allowed_fields);
  const required = semantics.canonical_batch_binding_required_fields ?? [];
  for (const record of value.authored_review.records) {
    const binding = record.authored_batch_decision;
    if (!binding) continue;
    for (const field of required) {
      if (!Object.hasOwn(binding, field)) {
        fail(
          `${filePath} ${record.record_id}.authored_batch_decision is missing ${field}`,
          'DURABLE_EVIDENCE_POLICY_SHAPE',
        );
      }
    }
    const duplicated = Object.keys(binding).filter((key) => !allowed.has(key));
    if (duplicated.length > 0) {
      fail(
        `${filePath} ${record.record_id}.authored_batch_decision stores duplicated fields: ${duplicated.join(', ')}`,
        'DURABLE_EVIDENCE_DUPLICATION',
      );
    }
  }
}

async function validateDurableEvidenceSemantics({ repositoryDirectory, tracked, policy }) {
  const semantics = policy.durable_semantics;
  if (!semantics || typeof semantics !== 'object') {
    fail('artifact policy durable_semantics must be an object', 'POLICY_SHAPE');
  }
  for (const key of [
    'gate_contract_versions',
    'gate_forbidden_fields',
    'preflight_allowed_fields',
    'preflight_check_allowed_fields',
    'batch_decision_contract_versions',
    'batch_decision_required_fields',
    'batch_decision_forbidden_fields',
    'canonical_batch_binding_allowed_fields',
    'canonical_batch_binding_required_fields',
    'gate_allowed_fields',
    'gate_evidence_allowed_fields',
    'gate_inputs_allowed_fields',
    'gate_complete_audit_allowed_fields',
  ]) {
    if (!Array.isArray(semantics[key]) || semantics[key].length === 0) {
      fail(`artifact policy durable_semantics.${key} must be a non-empty array`, 'POLICY_SHAPE');
    }
  }
  for (const filePath of tracked) {
    if (!filePath.startsWith('data/')) continue;
    const absolutePath = path.join(repositoryDirectory, filePath);
    let bytes;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (filePath.endsWith('.json')) {
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        continue;
      }
      // Preserve the gate-specific duplication diagnostics before applying the
      // recursive contract allowlists to the remaining durable containers.
      validateCompactGateArtifact(value, filePath, semantics);
      validateClosedContract(value, filePath, semantics, 'durable artifact');
      validateCompactDecisionSource(value, filePath, semantics);
      validateCanonicalBatchBindings(value, filePath, semantics);
      continue;
    }
    if (filePath.endsWith('.jsonl')) {
      const lines = bytes.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) continue;
      const first = JSON.parse(lines[0]);
      if (!first.decision_source_id || !first.decision_row_sha256) continue;
      const ledgerContract = semantics.closed_contracts?.promotion_ledger;
      if (!ledgerContract) fail('artifact policy is missing the promotion-ledger closed contract', 'POLICY_SHAPE');
      for (const [index, line] of lines.entries()) {
        const entry = JSON.parse(line);
        validateClosedObjectFields(
          entry,
          ledgerContract.allowed_fields,
          filePath,
          `promotion ledger line ${index + 1}`,
        );
        for (const field of ledgerContract.required_fields) {
          if (!Object.hasOwn(entry, field)) {
            fail(
              `${filePath} line ${index + 1} promotion ledger is missing ${field}`,
              'DURABLE_EVIDENCE_POLICY_SHAPE',
            );
          }
        }
      }
    }
  }
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

  await validateDurableEvidenceSemantics({ repositoryDirectory, tracked, policy });

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

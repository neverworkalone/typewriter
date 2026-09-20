import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import {
  buildCanonicalSemanticAudit,
  serializeSemanticAuditArtifact,
} from '../scripts/validate/semantic-audit.mjs';
import {
  buildTargetInventory,
  serializeTargetInventory,
} from '../scripts/inventory/generate-target-inventory.mjs';
import {
  ArtifactPolicyError,
  classifyTrackedArtifacts,
  detectProjectionRole,
  readArtifactPolicy,
  validateArtifactPolicy,
} from '../scripts/validate/artifact-policy.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('current semantic audit and target inventory are deterministic in-memory projections', async () => {
  const { artifact } = await buildCanonicalSemanticAudit();
  const inventory = await buildTargetInventory();

  assert.equal(artifact.source.canonical_records_sha256, '5fb48ed6e9ffb5780bf1cd499b06fe879860f2f9de8af90e10d49cb89ef0c8ec');
  assert.equal(artifact.record_count, 2042);
  assert.equal(artifact.sense_count, 2301);
  const semanticAuditBytes = serializeSemanticAuditArtifact(artifact);
  const inventoryBytes = serializeTargetInventory(inventory);
  assert.equal(semanticAuditBytes.length, 12818460);
  assert.equal(sha256(semanticAuditBytes), '0a6cde6c0d1a4a95ea66686ba75315879177c4683f1d2422e0841672239c3881');
  assert.equal(inventoryBytes.length, 1339184);
  assert.equal(sha256(inventoryBytes), 'a0b77d996a76488ab2d765e1561e7c6956257a15716c86fe5fdba9eac4aa271f');
  assert.equal(inventory.canonical_snapshot.record_count, 2042);
  assert.equal(inventory.canonical_snapshot.start_count, 2000);
  assert.equal(inventory.canonical_snapshot.reference_only_count, 42);
});

test('artifact policy classifies projections before they can become tracked data', async () => {
  const policy = await readArtifactPolicy();
  const options = {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    relocatableProjectionPatterns: policy.relocatable_projection_patterns,
    durableProjectionPatterns: policy.durable_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
  };

  const generated = classifyTrackedArtifacts(
    ['data/validation/future-semantic-review.json'],
    options,
  );
  assert.deepEqual(generated.generated, ['data/validation/future-semantic-review.json']);
  assert.deepEqual(generated.unclassified, []);

  const unclassified = classifyTrackedArtifacts(
    ['data/validation/future-derived-envelope.json'],
    options,
  );
  assert.deepEqual(unclassified.generated, []);
  assert.deepEqual(unclassified.unclassified, ['data/validation/future-derived-envelope.json']);

  const renamedProjection = {
    contract_version: 'lexical-semantic-review-v2',
    scope: 'complete-canonical',
  };
  assert.equal(
    detectProjectionRole(renamedProjection, {
      semanticReviewContractVersions: policy.projection_roles.semantic_review_contract_versions,
    }),
    'semantic-review',
  );
  const relocatedWithDifferentName = classifyTrackedArtifacts(
    ['data/batches/editorial-judgments-20260915.json'],
    {
      ...options,
      artifactRoles: new Map([
        ['data/batches/editorial-judgments-20260915.json', 'semantic-review'],
      ]),
    },
  );
  assert.deepEqual(relocatedWithDifferentName.generated, ['data/batches/editorial-judgments-20260915.json']);
  assert.deepEqual(relocatedWithDifferentName.unclassified, []);

  await assert.doesNotReject(validateArtifactPolicy());
  await assert.rejects(
    validateArtifactPolicy({
      tracked: ['data/validation/future-semantic-review.json'],
    }),
    (error) => error instanceof ArtifactPolicyError && error.code === 'GENERATED_PROJECTION_TRACKED',
  );
});

test('artifact policy rejects role-shaped projections relocated into a future batch path', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-artifact-policy-'));
  const cases = [
    ['future-editorial-audit-envelope.json', { contract_version: 'lexical-semantic-audit-v3' }],
    ['future-editorial-coverage-envelope.json', { contract_version: 'lexical-semantic-coverage-v1' }],
    ['future-editorial-review-envelope.json', { contract_version: 'lexical-semantic-review-v2' }],
  ];

  try {
    for (const [fileName, value] of cases) {
      const relativePath = `data/batches/${fileName}`;
      const filePath = path.join(repositoryDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      await assert.rejects(
        validateArtifactPolicy({
          repositoryDirectory,
          tracked: [relativePath],
        }),
        (error) => error instanceof ArtifactPolicyError && error.code === 'GENERATED_PROJECTION_TRACKED',
      );
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

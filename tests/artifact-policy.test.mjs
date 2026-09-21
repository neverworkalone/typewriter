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

  assert.equal(artifact.source.canonical_records_sha256, '9243dc74cdcc96f7c140979377006c2197d1cc261e97beebbba772c2e4341de8');
  assert.equal(artifact.record_count, 2042);
  assert.equal(artifact.sense_count, 2301);
  const semanticAuditBytes = serializeSemanticAuditArtifact(artifact);
  const inventoryBytes = serializeTargetInventory(inventory);
  assert.equal(semanticAuditBytes.length, 14936707);
  assert.equal(sha256(semanticAuditBytes), '16b0602d01825194ed785e3a0eb82b6c2600610c0521220afaf257c2dee35cea');
  assert.equal(inventoryBytes.length, 1338554);
  assert.equal(sha256(inventoryBytes), '0d3058ecd005189ceb5f413d9e2422269d861af39ee7de00ddbb12abdbe95a66');
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

test('artifact policy rejects reconstructible gate output in a v2 durable manifest', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-gate-policy-'));
  const relativePath = 'data/batches/future-admission.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '2',
    contract_version: 'lexical-batch-admission-v2',
    artifact_id: 'future-admission',
    gate_evidence: {
      contract_version: 'lexical-batch-gate-evidence-v2',
      preflight: {
        contract_version: 'lexical-batch-preflight-v1',
        status: 'complete',
        input_canonical_directory_sha256: 'a'.repeat(64),
        checks: {
          deterministic_sqlite: {
            status: 'pass',
            input_canonical_directory_sha256: 'a'.repeat(64),
            summary: { outputPath: '/tmp/generated.sqlite' },
          },
        },
      },
    },
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_GATE_DUPLICATION',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy closes the v2 promotion preflight contract even without gate_evidence', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-promotion-policy-'));
  const relativePath = 'data/batches/future-promotion.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '2',
    contract_version: 'lexical-batch-promotion-v2',
    preflight: {
      contract_version: 'lexical-batch-preflight-v1',
      status: 'complete',
      input_canonical_directory_sha256: 'a'.repeat(64),
      checks: {
        deterministic_sqlite: {
          status: 'pass',
          input_canonical_directory_sha256: 'a'.repeat(64),
          summary: { outputPath: '/tmp/generated.sqlite' },
        },
      },
    },
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_GATE_DUPLICATION',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects alternate full-record keys in a promotion ledger', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-ledger-policy-'));
  const relativePath = 'data/inventory/m5-target-promotions.jsonl';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '1',
    batch_id: 'm5-12a',
    inventory_id: 'm5-12a-w001',
    canonical_id: 'w1001',
    decision: 'included',
    record_sha256: 'a'.repeat(64),
    decision_source_id: 'm5-12a-decisions',
    decision_source_sha256: 'b'.repeat(64),
    decision_row_sha256: 'c'.repeat(64),
    reason_codes: [],
    flags: [],
    decision_note: 'promotion event',
    record: { lemma: '재도입된 본문' },
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects alternate decision-row envelopes in the v2 source', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-decision-policy-'));
  const relativePath = 'data/batches/future-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '1',
    contract_version: 'lexical-semantic-decision-source-v2',
    kind: 'separately-authored-semantic-decision-source',
    source_id: 'future-source',
    authoring_mode: 'agent-authored-decision',
    issue: 141,
    parent_issue: 138,
    batch_id: 'future-batch',
    provenance: {},
    candidate_source: {},
    selection: {},
    decisions: [{
      candidate_record_id: 'w1001',
      inventory_id: 'm5-12a-w001',
      candidate_record_sha256: 'a'.repeat(64),
      decision: 'held',
      rank: 1,
      score: 1,
      decision_rationale: 'future decision',
      sense_reviews: [],
      candidate_record: { id: 'w1001', lemma: 'duplicate body' },
    }],
    review: {},
    candidate_records: [],
    candidate_records_sha256: 'b'.repeat(64),
    artifact_sha256: 'c'.repeat(64),
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

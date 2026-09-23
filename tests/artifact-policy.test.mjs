import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { parseJsonWithUniqueKeys } from '../scripts/validate/unique-json.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decisionSourceFixture({ candidateRecords = [], decisions = [] } = {}) {
  return {
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
    decisions,
    review: {},
    candidate_records: candidateRecords,
    candidate_records_sha256: 'b'.repeat(64),
    artifact_sha256: 'c'.repeat(64),
  };
}

function decisionRowFixture(overrides = {}) {
  return {
    candidate_record_id: 'w1001',
    inventory_id: 'm5-12a-w001',
    candidate_record_sha256: 'a'.repeat(64),
    decision: 'held',
    rank: 1,
    score: 1,
    decision_rationale: 'future decision',
    selection_rationale: 'future selection',
    review_pass_id: 'future-review',
    gloss_judgment: 'fit',
    sense_reviews: [],
    ...overrides,
  };
}

function candidateRecordFixture({ multiSense = false, relation = false } = {}) {
  const senses = [{
    id: 'w1001-s1',
    pos: 'noun',
    gloss: '첫 번째 뜻',
    ...(relation
      ? {
        relations: [{
          target: 'w1002',
          target_sense: 'w1002-s1',
          type: 'near',
          note: 'source-bound relation note',
        }],
      }
      : {}),
  }];
  if (multiSense) {
    senses.push({
      id: 'w1001-s2',
      pos: 'noun',
      gloss: '두 번째 뜻',
      relations: [],
    });
  }
  return {
    id: 'w1001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w1001',
    lemma: '시험 단어',
    search_forms: ['시험 단어'],
    senses,
  };
}

test('current semantic audit and target inventory are deterministic in-memory projections', async () => {
  const { artifact } = await buildCanonicalSemanticAudit();
  const inventory = await buildTargetInventory();

  assert.equal(artifact.source.canonical_records_sha256, 'f90aba4abf55df4a0742e90cb5fe31ee8b67da8ea914eec58ecc066adf50d7d5');
  assert.equal(artifact.record_count, 3042);
  assert.equal(artifact.sense_count, 3301);
  const semanticAuditBytes = serializeSemanticAuditArtifact(artifact);
  const inventoryBytes = serializeTargetInventory(inventory);
  assert.equal(semanticAuditBytes.length, 20793143);
  assert.equal(sha256(semanticAuditBytes), '27b070c38100880b3bf907317f88bd799dc4cf321ccf03f305fd0d98b968555e');
  assert.equal(inventoryBytes.length, 2043526);
  assert.equal(sha256(inventoryBytes), 'b3848451bc03a344eaa39bfd09eb0b7256959d336d6c9adefbe0b4cdca80fe6a');
  assert.equal(inventory.canonical_snapshot.record_count, 3042);
  assert.equal(inventory.canonical_snapshot.start_count, 3000);
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

test('artifact policy requires a registered closed contract for future pre-admission artifacts', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-pre-admission-policy-'));
  const cases = [
    ['data/batches/m5-14-review.json', { schema_version: '1', status: 'pre-admission' }],
    ['data/batches/m5-14-stage.json', { schema_version: '1', status: 'pre-admission' }],
    ['data/batches/m5-13-base-inventory.json', { schema_version: '1', status: 'snapshot' }],
    ['data/batches/m5-13-base-canonical/part.jsonl', { schema_version: '1', status: 'snapshot' }],
  ];

  try {
    for (const [relativePath, value] of cases) {
      const filePath = path.join(repositoryDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      await assert.rejects(
        validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
        (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNCLASSIFIED',
      );
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects future copied canonical and inventory snapshots', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-snapshot-policy-'));
  const cases = [
    ['data/batches/m5-14-base-canonical/pilot.jsonl', '{}\n'],
    ['data/batches/m5-14-base-inventory.json', '{}\n'],
  ];

  try {
    for (const [relativePath, contents] of cases) {
      const filePath = path.join(repositoryDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, 'utf8');
      await assert.rejects(
        validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
        (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNCLASSIFIED',
      );
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('durable JSON loading rejects duplicate keys before schema validation', async () => {
  assert.deepEqual(
    parseJsonWithUniqueKeys('{"outer":{"key":1},"items":[{"key":2}]}', 'synthetic fixture'),
    { outer: { key: 1 }, items: [{ key: 2 }] },
  );
  assert.throws(
    () => parseJsonWithUniqueKeys('{"key":1,"key":2}', 'synthetic fixture'),
    (error) => error.code === 'DUPLICATE_JSON_KEY' && error.message.includes('"key"'),
  );
  assert.throws(
    () => parseJsonWithUniqueKeys('{"outer":{"key":1,"key":2}}', 'synthetic fixture'),
    (error) => error.code === 'DUPLICATE_JSON_KEY' && error.message.includes('$.outer'),
  );
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

test('artifact policy closes nested admission and promotion durable containers', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-nested-policy-'));
  const cases = [
    {
      relativePath: 'data/batches/future-promotion.json',
      value: {
        schema_version: '2',
        contract_version: 'lexical-batch-promotion-v2',
        outputs: {
          canonical_directory_sha256: 'a'.repeat(64),
          rebuilt_sqlite_summary: { outputPath: '/tmp/generated.sqlite' },
        },
      },
    },
    {
      relativePath: 'data/batches/future-admission.json',
      value: {
        schema_version: '2',
        contract_version: 'lexical-batch-admission-v2',
        sources: {
          authorization: { source_id: 'authorization', path: 'external', sha256: 'a'.repeat(64) },
          unexpected_review_payload: { reviewed_record: { lemma: 'duplicate' } },
        },
      },
    },
  ];

  try {
    for (const { relativePath, value } of cases) {
      const filePath = path.join(repositoryDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      await assert.rejects(
        validateArtifactPolicy({
          repositoryDirectory,
          tracked: [relativePath],
        }),
        (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
      );
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy accepts authored correction, boundary, and relation payloads', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-typed-decision-policy-'));
  const relativePath = 'data/batches/future-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const correctedRecord = candidateRecordFixture({ relation: true });
  const corrected = decisionSourceFixture({
    candidateRecords: [correctedRecord],
    decisions: [decisionRowFixture({
      decision: 'corrected',
      correction: {
        action: 'replace-authored-record',
        record: correctedRecord,
        output_record_sha256: 'd'.repeat(64),
      },
    })],
  });
  const multiSenseRecord = candidateRecordFixture({ multiSense: true, relation: true });
  const multiSense = decisionSourceFixture({
    candidateRecords: [multiSenseRecord],
    decisions: [decisionRowFixture({
      boundary_pairs: [{
        left_sense_id: 'w1001-s1',
        right_sense_id: 'w1001-s2',
        relationship: 'distinct',
        decision: 'retain',
        left_gloss_sha256: 'e'.repeat(64),
        right_gloss_sha256: 'f'.repeat(64),
        evidence_basis: 'separate gloss evidence',
        distinguishing_feature: 'distinct writer-facing meanings',
        decision_source_id: 'future-source',
        rationale: 'w1001 w1001-s1 w1001-s2 pair evidence',
      }],
      sense_reviews: [{}, {}],
    })],
  });

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    for (const value of [corrected, multiSense]) {
      await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      await assert.doesNotReject(
        validateArtifactPolicy({
          repositoryDirectory,
          tracked: [relativePath],
        }),
      );
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects arbitrary objects hidden in allowed scalar fields', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-typed-scalar-policy-'));
  const cases = [
    {
      relativePath: 'data/batches/future-promotion.json',
      value: {
        schema_version: '2',
        contract_version: 'lexical-batch-promotion-v2',
        checkpoint: {
          issue: 7,
          milestone: { reviewed_record: { lemma: 'duplicate body' } },
          canonical_records: 1,
          canonical_starts: 1,
          status: 'recorded-on-promotion',
        },
      },
    },
    {
      relativePath: 'data/batches/future-admission.json',
      value: {
        schema_version: '2',
        contract_version: 'lexical-batch-admission-v2',
        sources: {
          authorization: {
            source_id: 'authorization',
            path: { reviewed_record: { lemma: 'duplicate body' } },
          },
        },
      },
    },
  ];

  try {
    for (const { relativePath, value } of cases) {
      const filePath = path.join(repositoryDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
      await assert.rejects(
        validateArtifactPolicy({
          repositoryDirectory,
          tracked: [relativePath],
        }),
        (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
      );
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects an unregistered decision-source contract version', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-unregistered-contract-policy-'));
  const relativePath = 'data/batches/future-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = decisionSourceFixture();
  value.contract_version = 'lexical-semantic-decision-source-v4';

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNREGISTERED',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects an equivalent decision source hidden under an alternate root envelope', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-envelope-policy-'));
  const relativePath = 'data/batches/future-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = { archive: decisionSourceFixture() };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNREGISTERED',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy rejects a markerless promotion-evidence JSONL envelope', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-markerless-ledger-policy-'));
  const relativePath = 'data/batches/future-promotion-evidence.jsonl';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '1',
    batch_id: 'future-batch',
    record: { id: 'w1001', lemma: 'reintroduced body' },
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy closes the compact canonical decision source against derived-field reintroduction', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-canonical-source-policy-'));
  const relativePath = 'data/validation/canonical-semantic-decision-source.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const source = JSON.parse(await readFile(
    path.resolve('data/validation/canonical-semantic-decision-source.json'),
    'utf8',
  ));

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(source)}\n`, 'utf8');
    await assert.doesNotReject(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
    );

    const derivedField = structuredClone(source);
    derivedField.authored_review.records[0].sense_reviews[0].pos = {
      status: 'pass',
      observed_pos: 'noun',
    };
    await writeFile(filePath, `${JSON.stringify(derivedField)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
    );

    const unregistered = structuredClone(source);
    unregistered.contract_version = 'lexical-semantic-canonical-decision-source-v3';
    await writeFile(filePath, `${JSON.stringify(unregistered)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({
        repositoryDirectory,
        tracked: [relativePath],
      }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNREGISTERED',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

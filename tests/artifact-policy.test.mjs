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
    contract_version: 'lexical-semantic-decision-source-v4',
    review_binding_contract_version: 'source-bound-semantic-review-v2',
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
  const row = {
    candidate_record_id: 'w1001',
    inventory_id: 'm5-12a-w001',
    candidate_record_sha256: 'a'.repeat(64),
    decision: 'held',
    hold_basis: 'unresolved-sense',
    rank: 1,
    score: 1,
    decision_rationale: 'future decision',
    selection_rationale: 'future selection',
    review_pass_id: 'future-review',
    gloss_judgment: 'fit',
    sense_reviews: [],
    ...overrides,
  };
  if (row.decision !== 'held') delete row.hold_basis;
  if (row.decision !== 'rejected') delete row.rejection_basis;
  row.gloss_judgment = row.decision === 'held'
    ? 'needs-context'
    : row.decision === 'rejected' ? 'reject' : 'fit';
  row.review_binding ??= {
    contract_version: 'source-bound-semantic-review-v2',
    candidate_record_id: row.candidate_record_id,
    candidate_record_sha256: row.candidate_record_sha256,
    decision_evidence_sha256: 'd'.repeat(64),
    sense_evidence: row.sense_reviews.map((senseReview, index) => ({
      sense_id: senseReview.sense_id ?? `w1001-s${index + 1}`,
      sense_sha256: 'e'.repeat(64),
      gloss_sha256: 'f'.repeat(64),
      evidence_sha256: '0'.repeat(64),
    })),
  };
  return row;
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

  const source = JSON.parse(await readFile('data/validation/canonical-semantic-decision-source.json', 'utf8'));
  assert.equal(artifact.source.canonical_records_sha256, source.source.canonical_records_sha256);
  assert.equal(artifact.record_count, inventory.canonical_snapshot.record_count);
  assert.equal(artifact.record_count, inventory.canonical_snapshot.start_count + inventory.canonical_snapshot.reference_only_count);
  assert.equal(artifact.sense_count, artifact.review.records.reduce((count, record) => count + record.sense_reviews.length, 0));
  const semanticAuditBytes = serializeSemanticAuditArtifact(artifact);
  const inventoryBytes = serializeTargetInventory(inventory);
  const secondAudit = (await buildCanonicalSemanticAudit()).artifact;
  const secondInventory = await buildTargetInventory();
  assert.equal(sha256(semanticAuditBytes), sha256(serializeSemanticAuditArtifact(secondAudit)));
  assert.equal(sha256(inventoryBytes), sha256(serializeTargetInventory(secondInventory)));
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

  const sourceContract = classifyTrackedArtifacts(
    ['data/validation/m6-2-inflection-exceptions.json'],
    options,
  );
  assert.deepEqual(sourceContract.generated, []);
  assert.deepEqual(sourceContract.unclassified, []);

  const projectionReview = classifyTrackedArtifacts(
    ['data/validation/m6-3-surface-form-review.json'],
    options,
  );
  assert.deepEqual(projectionReview.generated, []);
  assert.deepEqual(projectionReview.unclassified, []);

  const calibrationEvidence = classifyTrackedArtifacts(
    ['data/validation/m6-5-correction-calibration.json'],
    options,
  );
  assert.deepEqual(calibrationEvidence.generated, []);
  assert.deepEqual(calibrationEvidence.unclassified, []);

  const issue210RecoveryInventory = classifyTrackedArtifacts(
    ['data/inventory/issue-210-recovery-inventory.json'],
    options,
  );
  assert.deepEqual(issue210RecoveryInventory.generated, []);
  assert.deepEqual(issue210RecoveryInventory.unclassified, []);

  const issue222ScaleCoverageReport = classifyTrackedArtifacts(
    ['data/validation/issue-222-m9-d-scale-coverage-report.json'],
    options,
  );
  assert.deepEqual(issue222ScaleCoverageReport.generated, []);
  assert.deepEqual(issue222ScaleCoverageReport.unclassified, []);

  const issue222CorpusCandidateReview = classifyTrackedArtifacts(
    ['data/batches/issue-222-m9-d-corpus-batch-03-candidate-review.json'],
    options,
  );
  assert.deepEqual(issue222CorpusCandidateReview.generated, []);
  assert.deepEqual(issue222CorpusCandidateReview.unclassified, []);

  const futureInventory = classifyTrackedArtifacts(
    ['data/inventory/future-recovery-inventory.json'],
    options,
  );
  assert.deepEqual(futureInventory.generated, []);
  assert.deepEqual(futureInventory.unclassified, ['data/inventory/future-recovery-inventory.json']);

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

test('artifact policy tracks only the four Stage 2 review artifacts per batch directory', async () => {
  const policy = await readArtifactPolicy();
  const options = {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    relocatableProjectionPatterns: policy.relocatable_projection_patterns,
    durableProjectionPatterns: policy.durable_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
  };
  const legitimate = classifyTrackedArtifacts(
    ['manifest.json', 'decisions.jsonl', 'semantic-decisions.json', 'intake-handoff.json'].map((name) => `data/reviews/C000417/${name}`),
    options,
  );
  assert.deepEqual([...legitimate.generated, ...legitimate.unclassified], []);
  const stray = [
    'data/reviews/C000417/raw-evidence.json',
    'data/reviews/C000417/decisions.jsonl.bak',
    'data/reviews/C000417/nested/manifest.json',
    'data/reviews/manifest.json',
    'data/reviews/D000417/manifest.json',
  ];
  const strays = classifyTrackedArtifacts(stray, options);
  assert.deepEqual([...strays.unclassified, ...strays.generated].sort(), [...stray].sort());
});

test('artifact policy tracks only the two immutable candidate artifacts per batch directory', async () => {
  const policy = await readArtifactPolicy();
  const options = {
    deterministicProjectionPatterns: policy.deterministic_projection_patterns,
    relocatableProjectionPatterns: policy.relocatable_projection_patterns,
    durableProjectionPatterns: policy.durable_projection_patterns,
    durableTrackedPatterns: policy.durable_tracked_patterns,
    protectedRoots: policy.protected_roots,
  };
  // Generic: any `C…` batch directory (v1 historical or v2 lemma-centered), never a named batch.
  const legitimate = classifyTrackedArtifacts(
    [
      'data/candidates/C000002/manifest.json',
      'data/candidates/C000002/candidates.jsonl',
      'data/candidates/C000417/manifest.json',
      'data/candidates/C000417/candidates.jsonl',
    ],
    options,
  );
  assert.deepEqual(legitimate.generated, []);
  assert.deepEqual(legitimate.unclassified, []);

  const stray = [
    'data/candidates/C000002/raw-corpus.txt',
    'data/candidates/C000002/paragraphs.jsonl',
    'data/candidates/C000002/evidence.json',
    'data/candidates/C000002/report.json',
    'data/candidates/C000002/candidates.jsonl.bak',
    'data/candidates/C000002/nested/candidates.jsonl',
    'data/candidates/C000002/nested/manifest.json',
    'data/candidates/manifest.json',
    'data/candidates/stray.json',
    'data/candidates/D000002/manifest.json',
    'data/candidates/C000002/semantic-audit.json',
  ];
  const strays = classifyTrackedArtifacts(stray, options);
  assert.deepEqual([...strays.unclassified, ...strays.generated].sort(), [...stray].sort());

  // A generated projection cannot be reclassified as durable evidence by placing it in a batch.
  const moved = classifyTrackedArtifacts(
    ['data/candidates/C000002/manifest.json'],
    { ...options, artifactRoles: new Map([['data/candidates/C000002/manifest.json', 'semantic-review']]) },
  );
  assert.deepEqual(moved.generated, ['data/candidates/C000002/manifest.json']);
  const renamedAudit = classifyTrackedArtifacts(['data/candidates/C000002/canonical-semantic-audit.json'], options);
  assert.deepEqual(renamedAudit.unclassified.length + renamedAudit.generated.length, 1);

  await assert.doesNotReject(
    validateArtifactPolicy({
      tracked: ['data/candidates/C000002/manifest.json', 'data/candidates/C000002/candidates.jsonl'],
    }),
  );
  await assert.rejects(
    validateArtifactPolicy({ tracked: ['data/candidates/C000002/raw-corpus.txt'] }),
    (error) => error instanceof ArtifactPolicyError && /not classified as durable evidence/u.test(error.message),
  );
});

test('Issue #223 retrospective semantic QA uses a registered closed durable artifact contract', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-223-qa-policy-'));
  const relativePath = 'data/batches/issue-223-b01-b04-semantic-qa.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '1',
    contract_version: 'issue-223-b01-b04-semantic-qa-v1',
    kind: 'issue-223-retrospective-semantic-qa',
    issue: 223,
    parent_issue: 218,
    recorded_on: '2026-10-02',
    policy: 'source-bound AI self-check; preserve completed legacy review results',
    source_batches: [],
    legacy_runs: [],
    legacy_review_results: [],
    ai_self_checks: [],
    historical_overlap: {},
    coverage: {},
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    await assert.doesNotReject(validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }));

    await writeFile(filePath, `${JSON.stringify({ ...value, unregistered_decision: true })}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE',
    );

    await writeFile(filePath, `${JSON.stringify({ ...value, contract_version: 'issue-223-b01-b04-semantic-qa-v2' })}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNREGISTERED',
    );
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
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
    ['data/batches/m5-16-review.json', { schema_version: '1', status: 'pre-admission' }],
    ['data/batches/m5-16-stage.json', { schema_version: '1', status: 'pre-admission' }],
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
    ['data/batches/m5-15-base-canonical/pilot.jsonl', '{}\n'],
    ['data/batches/m5-15-base-inventory.json', '{}\n'],
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

test('artifact policy rejects alternate decision-row envelopes in a source-bound source', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-decision-policy-'));
  const relativePath = 'data/batches/future-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = {
    schema_version: '1',
    contract_version: 'lexical-semantic-decision-source-v4',
    review_binding_contract_version: 'source-bound-semantic-review-v2',
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
      hold_basis: 'unresolved-sense',
      rank: 1,
      score: 1,
      decision_rationale: 'future decision',
      sense_reviews: [],
      review_binding: {
        contract_version: 'source-bound-semantic-review-v2',
        candidate_record_id: 'w1001',
        candidate_record_sha256: 'a'.repeat(64),
        decision_evidence_sha256: 'd'.repeat(64),
        sense_evidence: [],
      },
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

test('artifact policy rejects any future v2 batch decision source', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-v2-downgrade-policy-'));
  const relativePath = 'data/batches/m5-14-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const value = decisionSourceFixture({ decisions: [decisionRowFixture()] });
  value.contract_version = 'lexical-semantic-decision-source-v2';
  delete value.review_binding_contract_version;
  delete value.decisions[0].review_binding;

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

test('artifact policy grandfathering accepts only the exact historical M5-12A source bytes', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-v2-grandfather-policy-'));
  const relativePath = 'data/batches/m5-12a-semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const historicalBytes = await readFile(path.resolve(relativePath));

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, historicalBytes);
    await assert.doesNotReject(validateArtifactPolicy({
      repositoryDirectory,
      tracked: [relativePath],
    }));

    const alteredSource = JSON.parse(historicalBytes.toString('utf8'));
    alteredSource.source_id = 'm5-12a-altered-source';
    await writeFile(filePath, `${JSON.stringify(alteredSource)}\n`, 'utf8');
    await assert.rejects(
      validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_CONTRACT_UNREGISTERED',
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
  value.contract_version = 'lexical-semantic-decision-source-v5';

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

test('artifact policy closes factory admission history and preserved snapshots recursively', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-factory-ledger-policy-'));
  const relativePath = 'data/validation/canonical-semantic-decision-source.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const source = JSON.parse(await readFile(path.resolve(relativePath), 'utf8'));
  source.factory_admissions = [{
    batch_id: 'C999999', attempt: 1, semantic_decisions_sha256: 'a'.repeat(64),
    entries: [{ source_candidate_id: 'C999999-0001', record_id: 'w1001', sense_ids: ['w1001-s2'] }],
    changes: [{
      entry_id: 'w1001', operation: 'append_senses', path: 'data/canonical/example.jsonl',
      source_candidate_ids: ['C999999-0001'], added_sense_ids: ['w1001-s2'],
      before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64),
      previous_semantic_review_sha256: 'd'.repeat(64), semantic_review_sha256: 'e'.repeat(64),
      previous_record: candidateRecordFixture({ relation: true }),
      previous_semantic_review: structuredClone(source.authored_review.records[0]),
    }], sha256: 'f'.repeat(64),
  }];
  const check = async (value) => {
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
    return validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] });
  };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await assert.doesNotReject(check(source));
    for (const inject of [
      (event) => { event.raw_evidence = {}; },
      (event) => { event.entries[0].raw_evidence = {}; },
      (event) => { event.changes[0].raw_evidence = {}; },
      (event) => { event.changes[0].previous_record.raw_evidence = {}; },
      (event) => { event.changes[0].previous_record.senses[0].raw_evidence = {}; },
      (event) => { event.changes[0].previous_record.senses[0].relations[0].raw_evidence = {}; },
      (event) => { event.changes[0].previous_semantic_review.raw_evidence = {}; },
    ]) {
      const invalid = structuredClone(source);
      inject(invalid.factory_admissions[0]);
      await assert.rejects(check(invalid),
        (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE');
    }
    const invalidType = structuredClone(source);
    invalidType.factory_admissions[0].attempt = '1';
    await assert.rejects(check(invalidType),
      (error) => error instanceof ArtifactPolicyError && error.code === 'DURABLE_EVIDENCE_POLICY_SHAPE');
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

test('artifact policy accepts a factory decision row addressed by source_candidate_id without inventory identity or rank', async () => {
  const repositoryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-factory-decision-policy-'));
  const relativePath = 'data/reviews/C000002/semantic-decisions.json';
  const filePath = path.join(repositoryDirectory, relativePath);
  const source = {
  review_binding_contract_version: 'source-bound-semantic-review-v2',
  "schema_version": "1",
  "contract_version": "lexical-semantic-decision-source-v4",
  "kind": "separately-authored-semantic-decision-source",
  "batch_id": "C000001",
  "authoring_mode": "agent-authored-decision",
  "provenance": {
    "human_reviewed": false
  },
  "review": {
    "status": "complete",
    "reviewer": "claude-agent-self-check",
    "reviewed_candidate_count": 1
  },
  "decisions": [
    {
      "source_candidate_id": "C000001-0002",
      "candidate_record_id": "C000001-0002",
      "candidate_record_sha256": "b03b910e85b36f4fa4f84aa6197d7fa04046ab91b8f1fcb0079a941ef04835fe",
      "decision": "included",
      "decision_rationale": "C000001-0002: 어휘 정체성, 품사, 뜻풀이 적합성, 뜻 경계를 근거 문맥으로 확인했다.",
      "gloss_judgment": "fit",
      "sense_reviews": [
        {
          "sense_id": "C000001-0002-s1",
          "boundary_action": "retain",
          "boundary_classification": "atomic",
          "boundary_decision": "atomic",
          "boundary_rationale": "C000001-0002: 대동사 쓰임 하나로 한정된다.",
          "semantic_rationale": "C000001-0002: 앞선 말이나 행동을 이어받아 그렇게 하다를 뜻한다.",
          "relation_decision": "no-relations",
          "relation_count": 0,
          "relation_ids": [],
          "no_relation_rationale": "C000001-0002 C000001-0002-s1: 이번 검토에서는 근거가 확인된 연관 관계가 없어 관계를 두지 않는다."
        }
      ],
      "boundary_pairs": [],
      "review_binding": {
        "contract_version": "source-bound-semantic-review-v2",
        "candidate_record_id": "C000001-0002",
        "candidate_record_sha256": "b03b910e85b36f4fa4f84aa6197d7fa04046ab91b8f1fcb0079a941ef04835fe",
        "decision_evidence_sha256": "70a058c5440c2ff76d7828565ff3404a6be4836149a1be923c83fd95a6472cb5",
        "sense_evidence": [
          {
            "sense_id": "C000001-0002-s1",
            "sense_sha256": "073437d3b745d4d7ba79610c11efe8f3dd8b195b27d5c427131c505b5bd2e9e7",
            "gloss_sha256": "f9f10992d0570a4eb9d1027449de4102ffb8a27350d47db14aed41a64f4f4098",
            "evidence_sha256": "db96925e9f9f9303e4e1db4c7d39348b1844e4d0955878a0cfce68e14117ddf6"
          }
        ]
      }
    }
  ]
};
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(source)}\n`, 'utf8');
    await assert.doesNotReject(validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }));
    // An M5/M9 selection row (no source_candidate_id) still needs inventory identity and rank.
    const legacy = structuredClone(source);
    delete legacy.decisions[0].source_candidate_id;
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');
    await assert.rejects(validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }), /missing compact field inventory_id/u);
    // The closed contract still rejects any other unregistered field on a factory row.
    const extra = structuredClone(source);
    extra.decisions[0].unregistered_field = 'x';
    await writeFile(filePath, `${JSON.stringify(extra)}\n`, 'utf8');
    await assert.rejects(validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }), /unknown durable fields: unregistered_field/u);
    await writeFile(filePath, `${JSON.stringify(source)}\n`, 'utf8');
    // A v3 selection row at the factory path cannot opt out either: the exemption needs the v4 contract.
    const v3 = structuredClone(source);
    v3.contract_version = 'lexical-semantic-decision-source-v3';
    await writeFile(filePath, `${JSON.stringify(v3)}\n`, 'utf8');
    await assert.rejects(validateArtifactPolicy({ repositoryDirectory, tracked: [relativePath] }), /missing compact field inventory_id/u);
    await writeFile(filePath, `${JSON.stringify(source)}\n`, 'utf8');
    // The exemption is bound to the factory review path: an M5/M9 batch decision source cannot opt out
    // of inventory identity and rank by adding source_candidate_id.
    const batchPath = 'data/batches/m9-synthetic-semantic-decisions.json';
    await mkdir(path.dirname(path.join(repositoryDirectory, batchPath)), { recursive: true });
    await writeFile(path.join(repositoryDirectory, batchPath), `${JSON.stringify(source)}\n`, 'utf8');
    await assert.rejects(validateArtifactPolicy({ repositoryDirectory, tracked: [batchPath] }), /missing compact field inventory_id/u);
  } finally {
    await rm(repositoryDirectory, { recursive: true, force: true });
  }
});

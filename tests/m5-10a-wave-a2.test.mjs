import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWaveA2Manifest } from '../scripts/batch/build-m5-10a-wave-a2.mjs';
import { main as recordA2Timing } from '../scripts/batch/record-m5-10a-wave-a2-timing.mjs';
import {
  createA2TimingProof,
  validateA2AuditInput,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  sha256Bytes,
  sha256ProvenanceSubject,
  validateA2TimingInput,
} from '../scripts/batch/validate-m5-10a-wave-a2-inputs.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import {
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const CURRENT_CANONICAL_DIRECTORY = path.resolve('data/canonical');
const A2_BOUNDARY_IDS = [
  'physical-figurative',
  'homonym-pos',
  'sensory-emotion-state-action',
  'directional-symmetry',
  'compound-spaced-phrase',
  'word-idiom',
];

async function readBatchJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

function assertInputError(action, code) {
  assert.throws(action, (error) => error.code === code);
}

function createVerifiedEditorialFixture(editorial, canonicalRecords) {
  const fixture = structuredClone(editorial);
  const canonicalById = new Map(canonicalRecords.map(({ record }) => [record.id, record]));
  fixture.schema_version = '2';
  fixture.source_kind = 'human-authored';
  fixture.provenance = {
    verification_status: 'verified',
    actor_kind: 'human',
    actor_id: 'editor-session-owner',
    session_id: '11111111-1111-4111-8111-111111111111',
    artifact: 'data/batches/test-editorial-session.json',
    sha256: 'a'.repeat(64),
    note: 'Test-only verified editorial session fixture.',
  };
  fixture.status = 'complete';
  fixture.completed_at = '2026-09-09T06:00:00Z';
  fixture.sense_review.status = 'complete';
  fixture.sense_review.reviewed_start_count = 50;
  fixture.sense_review.scoped_single_sense_count = 35;
  fixture.sense_review.split_record_count = 15;
  fixture.sense_review.split_canonical_ids = fixture.records
    .slice(0, 50)
    .filter(({ decision }) => decision === 'corrected')
    .map(({ canonical_id: canonicalId }) => canonicalId);
  fixture.sense_review.note = 'Test fixture records structured sense decisions and boundary contrasts.';

  fixture.records.slice(0, 50).forEach((recordReview, index) => {
    const canonical = canonicalById.get(recordReview.canonical_id);
    recordReview.decision_note = `${recordReview.inventory_id} ${canonical.id} ${canonical.lemma}: verified editorial decision for the test fixture.`;
    const split = recordReview.decision === 'corrected';
    recordReview.boundary_evidence = Object.fromEntries(A2_BOUNDARY_IDS.map((boundaryId) => {
      if (split && boundaryId === 'sensory-emotion-state-action') {
        const [left, right] = canonical.senses;
        return [boundaryId, {
          review_status: 'reviewed',
          applicability: 'applicable',
          candidate_sense_ids: canonical.senses.map(({ id }) => id),
          decision: 'split',
          contrasts: [{
            left_sense_id: left.id,
            right_sense_id: right.id,
            dimension: 'sensory',
            facets: ['sense-contrast', `case-${String.fromCharCode(97 + index)}`],
            left_observation: `${left.gloss} is the first observed focus.`,
            right_observation: `${right.gloss} is the second observed focus.`,
            difference: `${canonical.lemma} separates these senses by the observed focus rather than treating them as one use.`,
          }],
        }];
      }
      return [boundaryId, {
        review_status: 'reviewed',
        applicability: 'not-applicable',
        candidate_sense_ids: canonical.senses.map(({ id }) => id),
        decision: 'keep',
        contrasts: [],
      }];
    }));
  });
  return fixture;
}

function createVerifiedAuditFixture(audit, editorial, relationDiff) {
  const fixture = structuredClone(audit);
  fixture.schema_version = '2';
  fixture.source_kind = 'human-authored';
  fixture.provenance = {
    verification_status: 'verified',
    actor_kind: 'human',
    actor_id: 'audit-session-owner',
    session_id: '22222222-2222-4222-8222-222222222222',
    artifact: 'data/batches/test-audit-session.json',
    sha256: 'b'.repeat(64),
    note: 'Test-only verified audit session fixture.',
  };
  fixture.auditor_id = fixture.provenance.actor_id;
  fixture.independent = true;
  fixture.created_at = '2026-09-09T06:10:00Z';
  fixture.completed_at = '2026-09-09T06:30:00Z';
  fixture.reviewed_record_ids = editorial.records
    .slice(0, 50)
    .map(({ canonical_id: canonicalId }) => canonicalId);
  fixture.relation_reviews = relationDiff.candidate_reviews.map((review) => ({
    candidate_id: review.candidate_id,
    relation_id: review.relation_id,
    source_sense: review.source_sense,
    target_sense: review.relation.target_sense,
    review_status: 'reviewed',
    relation_type: review.relation.type,
    decision: review.decision,
    basis: {
      facets: ['relation-contrast', `case-${String.fromCharCode(97 + relationDiff.candidate_reviews.indexOf(review))}`],
      source_observation: `${review.source_sense} carries the source-side writer-facing focus.`,
      target_observation: `${review.relation.target_sense} carries the target-side writer-facing focus.`,
      difference: `${review.candidate_id} compares the two senses using their distinct role in the proposed relation.`,
    },
  }));
  fixture.status = 'complete';
  fixture.findings = [{
    id: 'a2-test-audit-complete',
    category: 'sense',
    severity: 'info',
    status: 'resolved',
    evidence_refs: ['w579-s1', 'm5-10-wave-a2-rel-001'],
    note: 'Test fixture records a resolved structural audit result.',
  }];
  fixture.note = 'Test fixture records a distinct verified audit session and structured relation bases.';
  return fixture;
}

function createVerifiedRelationDiffFixture(relationDiff) {
  const fixture = structuredClone(relationDiff);
  fixture.candidate_reviews.forEach((review) => {
    if (review.decision === 'pending') review.decision = 'admit';
  });
  return fixture;
}

test('M5-10A Wave A2 validates the bounded +50 promotion and keeps Wave B blocked', async () => {
  const [manifest, relationDiff, metrics, stage, plan, canonical] = await Promise.all([
    readBatchJson('m5-10-wave-a2.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readBatchJson('m5-10a-wave-a2-metrics.json'),
    readBatchJson('m5-10a-wave-a2.json'),
    readBatchJson('m5-8-expansion-plan.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);

  assert.equal(manifest.batch_id, 'm5-10-wave-a2-20260909');
  assert.equal(manifest.records.length, 58);
  assert.equal(manifest.review.status, 'in-review');
  assert.equal(manifest.review.reviewer, 'unknown');
  assert.equal(manifest.sense_review.status, 'incomplete');
  assert.equal(manifest.sense_review.reviewed_start_count, 0);
  assert.equal(manifest.sense_review.split_record_count, 0);
  assert.equal(manifest.sense_review.preflight.record_checkpoints.length, 58);
  assert.ok(manifest.sense_review.preflight.record_checkpoints.every((checkpoint) => checkpoint.status === 'not-reviewed'));
  assert.deepEqual(metrics.derived.decisions, {
    included: 35,
    held: 3,
    rejected: 3,
    corrected: 15,
    deferred: 2,
    importable_start_count: 50,
    correction_rate_of_selected: 15 / 56,
    correction_rate_of_importable: 15 / 50,
    held_rate: 3 / 56,
    rejected_rate: 3 / 56,
    held_or_rejected_rate: 6 / 56,
    sense_field_correction_count: 15,
    relation_field_correction_count: 0,
  });
  assert.equal(metrics.derived.canonical_import.imported_start_count, 50);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 67);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 6);
  assert.equal(metrics.derived.canonical_import.import_status, 'proposed');

  validateRelationDiff(relationDiff);
  assert.deepEqual(summarizeRelationDiff(relationDiff), {
    before_count: 0,
    after_count: 6,
    added_count: 6,
    removed_count: 0,
    retyped_count: 0,
    retargeted_count: 0,
    changed_count: 0,
    net_removed_count: -6,
    noise_event_count: 0,
    noise_rate_of_before: 0,
    classification_counts: {},
    candidate_count: 6,
    admitted_candidate_count: 0,
    pending_candidate_count: 6,
    rejected_candidate_count: 0,
    noise_denominator_count: 6,
    noise_rate_of_candidates: 0,
  });

  assertMetricsMatch(metrics, createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonical.records,
    source: metrics.source,
  }));
  assert.deepEqual(metrics.derived.canonical_import.relation_type_counts, {
    association: 1,
    mood: 3,
    near: 1,
    sensory: 1,
  });
  assert.equal(metrics.derived.timing.status, 'incomplete');
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, [
    'target-preparation',
    'initial-review',
    'feedback-fixes',
    'final-audit',
    'held-rejected',
  ]);
  assert.equal(metrics.derived.audit.status, 'incomplete');
  assert.equal(metrics.derived.audit.independent, false);
  assert.equal(metrics.derived.audit.open_blocker_count, 1);
  assert.equal(metrics.derived.sense_review.status, 'incomplete');

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-10a-wave-a2-plus-50',
    imported_start_count: 50,
    candidate_buffer: 8,
    gate_status: 'fail',
  });
  assert.deepEqual(stage.actual.canonical_snapshot, {
    record_count: 670,
    start_count: 628,
    reference_only_count: 42,
    sense_count: 810,
    relation_count: 473,
    expression_count: 43,
  });
  assert.equal(stage.metrics.timing_status, 'incomplete');
  assert.equal(stage.metrics.total_editor_seconds, null);
  assert.equal(stage.metrics.unmeasured_timing_pass_count, 5);
  assert.equal(stage.decision, 'HOLD PROCESS');
  assert.equal(stage.next_stage_created, false);
  assert.equal(stage.next_stage_authorized, false);
  assert.equal(stage.metrics.human_editorial_review_complete, false);
  assert.equal(stage.metrics.audit_status, 'incomplete');
  assert.equal(stage.metrics.audit_independent, false);
});

test('M5-10A Wave A2 keeps unverified proposals out of completed claims', async () => {
  const [editorial, audit, timing, relationDiff, canonical] = await Promise.all([
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
    readBatchJson('m5-10a-wave-a2-audit-input.json'),
    readBatchJson('m5-10a-wave-a2-timing-input.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);
  const unverifiedEditorial = validateA2EditorialInput({
    input: editorial,
    canonicalRecords: canonical.records,
  });
  assert.equal(unverifiedEditorial.verified, false);
  const unverifiedAudit = validateA2AuditInput({
    audit,
    editorialInput: unverifiedEditorial,
    relationDiff,
    canonicalRecords: canonical.records,
  });
  assert.equal(unverifiedAudit.verified, false);
  validateA2TimingInput(timing);

  const verifiedEditorial = createVerifiedEditorialFixture(editorial, canonical.records);
  validateA2EditorialInput({
    input: verifiedEditorial,
    canonicalRecords: canonical.records,
  });
  const verifiedRelationDiff = createVerifiedRelationDiffFixture(relationDiff);
  const verifiedAudit = createVerifiedAuditFixture(audit, verifiedEditorial, verifiedRelationDiff);
  assert.equal(
    validateA2AuditInput({
      audit: verifiedAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: verifiedRelationDiff,
      canonicalRecords: canonical.records,
    }).verified,
    true,
  );

  const pendingAudit = createVerifiedAuditFixture(audit, verifiedEditorial, relationDiff);
  assertInputError(
    () => validateA2AuditInput({
      audit: pendingAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff,
      canonicalRecords: canonical.records,
    }),
    'AUDIT_INCOMPLETE',
  );

  const invalidCanonicalRelationDiff = structuredClone(verifiedRelationDiff);
  invalidCanonicalRelationDiff.candidate_reviews[0].relation.target_sense = 'w018-s99';
  const invalidCanonicalAudit = createVerifiedAuditFixture(
    audit,
    verifiedEditorial,
    invalidCanonicalRelationDiff,
  );
  assertInputError(
    () => validateA2AuditInput({
      audit: invalidCanonicalAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: invalidCanonicalRelationDiff,
      canonicalRecords: canonical.records,
    }),
    'MISSING_CANONICAL_SENSE',
  );

  const posMismatch = structuredClone(verifiedEditorial);
  posMismatch.records[0].observed_pos = [];
  assertInputError(
    () => validateA2EditorialInput({ input: posMismatch, canonicalRecords: canonical.records }),
    'CANONICAL_POS_MISMATCH',
  );
  await assert.rejects(
    validateA2ProvenanceArtifact({
      input: verifiedEditorial,
      repositoryDirectory: tmpdir(),
      subjectKind: 'editorial',
    }),
    (error) => error.code === 'PROVENANCE_ARTIFACT_MISSING',
  );

  const provenanceDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-provenance-'));
  try {
    const artifactDirectory = path.join(provenanceDirectory, 'data', 'batches');
    await mkdir(artifactDirectory, { recursive: true });
    const verifiedWithArtifact = structuredClone(verifiedEditorial);
    verifiedWithArtifact.provenance.artifact = 'data/batches/test-editorial-session.json';
    verifiedWithArtifact.provenance.sha256 = null;
    const provenanceArtifact = {
      schema_version: '1',
      artifact_id: 'm5-10a-wave-a2-provenance-editorial-20260909',
      subject_kind: 'editorial',
      subject_id: verifiedWithArtifact.input_id,
      subject_sha256: sha256ProvenanceSubject(verifiedWithArtifact),
      session_id: verifiedWithArtifact.provenance.session_id,
      actor_kind: 'human',
      actor_id: verifiedWithArtifact.provenance.actor_id,
      started_at: '2026-09-09T05:30:00Z',
      completed_at: verifiedWithArtifact.completed_at,
    };
    const provenanceBytes = Buffer.from(`${JSON.stringify(provenanceArtifact, null, 2)}\n`, 'utf8');
    verifiedWithArtifact.provenance.sha256 = sha256Bytes(provenanceBytes);
    await writeFile(path.join(artifactDirectory, 'test-editorial-session.json'), provenanceBytes);
    assert.deepEqual(
      await validateA2ProvenanceArtifact({
        input: verifiedWithArtifact,
        repositoryDirectory: provenanceDirectory,
        subjectKind: 'editorial',
      }),
      provenanceArtifact,
    );

    const tamperedInput = structuredClone(verifiedWithArtifact);
    tamperedInput.records[0].decision_note = `${tamperedInput.records[0].decision_note} tampered`;
    await assert.rejects(
      validateA2ProvenanceArtifact({
        input: tamperedInput,
        repositoryDirectory: provenanceDirectory,
        subjectKind: 'editorial',
      }),
      (error) => error.code === 'PROVENANCE_ARTIFACT_MISMATCH',
    );
  } finally {
    await rm(provenanceDirectory, { recursive: true, force: true });
  }

  const structuralMismatch = structuredClone(verifiedEditorial);
  structuralMismatch.records[0].boundary_evidence['physical-figurative'].candidate_sense_ids = [];
  assertInputError(
    () => validateA2EditorialInput({ input: structuralMismatch, canonicalRecords: canonical.records }),
    'BOUNDARY_SENSE_COVERAGE_MISMATCH',
  );

  const missingEvidence = structuredClone(verifiedEditorial);
  delete missingEvidence.records[0].boundary_evidence['word-idiom'];
  assertInputError(
    () => validateA2EditorialInput({ input: missingEvidence, canonicalRecords: canonical.records }),
    'SCHEMA_ERROR',
  );

  const unreviewedEvidence = structuredClone(verifiedEditorial);
  unreviewedEvidence.records[0].boundary_evidence['word-idiom'].review_status = 'unreviewed';
  assertInputError(
    () => validateA2EditorialInput({ input: unreviewedEvidence, canonicalRecords: canonical.records }),
    'UNREVIEWED_BOUNDARY_EVIDENCE',
  );

  const duplicatedEvidence = structuredClone(verifiedEditorial);
  const splitRecords = duplicatedEvidence.records.filter(({ decision }) => decision === 'corrected');
  const firstSplit = splitRecords[0];
  const secondSplit = splitRecords[1];
  const firstContrast = firstSplit.boundary_evidence['sensory-emotion-state-action'].contrasts[0];
  const secondCanonical = canonical.records.find(({ record }) => record.id === secondSplit.canonical_id).record;
  secondSplit.boundary_evidence['sensory-emotion-state-action'].contrasts = [{
    ...firstContrast,
    left_sense_id: secondCanonical.senses[0].id,
    right_sense_id: secondCanonical.senses[1].id,
    left_observation: `${secondCanonical.senses[0].gloss} is the first observed focus.`,
    right_observation: `${secondCanonical.senses[1].gloss} is the second observed focus.`,
    difference: `${secondCanonical.lemma} separates these senses by the observed focus rather than treating them as one use.`,
  }];
  assertInputError(
    () => validateA2EditorialInput({ input: duplicatedEvidence, canonicalRecords: canonical.records }),
    'GENERIC_EDITORIAL_EVIDENCE',
  );

  const duplicatedAudit = structuredClone(verifiedAudit);
  duplicatedAudit.relation_reviews[1].basis = {
    ...structuredClone(duplicatedAudit.relation_reviews[0].basis),
    source_observation: `${duplicatedAudit.relation_reviews[1].source_sense} carries the source-side writer-facing focus.`,
    target_observation: `${duplicatedAudit.relation_reviews[1].target_sense} carries the target-side writer-facing focus.`,
  };
  assertInputError(
    () => validateA2AuditInput({
      audit: duplicatedAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: verifiedRelationDiff,
      canonicalRecords: canonical.records,
    }),
    'GENERIC_EDITORIAL_EVIDENCE',
  );

  const nonIndependentAudit = structuredClone(audit);
  nonIndependentAudit.independent = true;
  assertInputError(
    () => validateA2AuditInput({
      audit: nonIndependentAudit,
      editorialInput: unverifiedEditorial,
      relationDiff,
      canonicalRecords: canonical.records,
    }),
    'AUDIT_NOT_INDEPENDENT',
  );

  const falseHumanClaim = structuredClone(editorial);
  falseHumanClaim.source_kind = 'human-authored';
  falseHumanClaim.status = 'complete';
  falseHumanClaim.completed_at = '2026-09-09T06:00:00Z';
  falseHumanClaim.sense_review.status = 'complete';
  assertInputError(
    () => validateA2EditorialInput({ input: falseHumanClaim, canonicalRecords: canonical.records }),
    'PROVENANCE_REQUIRED',
  );

  const inReviewHumanClaim = structuredClone(editorial);
  inReviewHumanClaim.source_kind = 'human-authored';
  inReviewHumanClaim.provenance.verification_status = 'verified';
  inReviewHumanClaim.provenance.actor_kind = 'human';
  inReviewHumanClaim.provenance.actor_id = 'editor-session-owner';
  assertInputError(
    () => validateA2EditorialInput({ input: inReviewHumanClaim, canonicalRecords: canonical.records }),
    'SCHEMA_ERROR',
  );

  const syntheticTiming = structuredClone(timing);
  syntheticTiming.status = 'complete';
  syntheticTiming.recording_proof_sha256 = createA2TimingProof(syntheticTiming);
  assertInputError(() => validateA2TimingInput(syntheticTiming), 'TIMING_EVENT_COVERAGE');

  const canonicalById = new Map(canonical.records.map(({ record }) => [record.id, record]));
  assert.equal(canonicalById.get('w603').senses.length, 3);
  assert.deepEqual(
    canonicalById.get('w603').senses.map(({ gloss }) => gloss),
    ['햇볕이 강하고 눈부시다', '소리가 맑고 세차게 울리다', '빛이 맑고 세차게 비치다'],
  );
  assert.equal(canonicalById.get('w620').senses.length, 3);
  assert.deepEqual(
    canonicalById.get('w620').senses.map(({ gloss }) => gloss),
    ['액체나 물결이 잔잔하게 흔들리다', '빛이 가볍게 흔들리며 움직이다', '감정이 가볍게 흔들리며 움직이다'],
  );
  assert.equal(canonicalById.get('w621').senses[1].relations[0].type, 'association');
});

test('M5-10A Wave A2 build and timing recorder refuse missing or synthetic evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-wave-a2-'));
  const sessionPath = path.join(directory, 'timing-session.json');
  try {
    await assert.rejects(
      buildWaveA2Manifest({
        editorialInputPath: path.join(directory, 'missing-editorial-input.json'),
        outputPath: path.join(directory, 'manifest.json'),
      }),
      (error) => error.code === 'MISSING_A2_INPUT',
    );

    await assert.rejects(
      recordA2Timing([
        '--action=start',
        '--pass=target-preparation',
        '--editor-seconds=1',
        `--output=${sessionPath}`,
      ]),
      /--editor-seconds is not accepted/,
    );

    const started = await recordA2Timing([
      '--action=start',
      '--pass=target-preparation',
      `--output=${sessionPath}`,
    ]);
    assert.equal(started.status, 'in-progress');
    assert.equal(started.events.length, 1);
    assert.equal(started.events[0].kind, 'start');
    assert.match(started.events[0].session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    await assert.rejects(
      recordA2Timing([
        '--action=stop',
        '--pass=target-preparation',
        `--input=${sessionPath}`,
        `--output=${sessionPath}`,
      ]),
      /requires --work-evidence/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

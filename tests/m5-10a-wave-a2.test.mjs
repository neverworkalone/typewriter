import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildWaveA2Manifest,
  createWaveA2Manifest,
} from '../scripts/batch/build-m5-10a-wave-a2.mjs';
import { nextStageState } from '../scripts/batch/build-m5-10a-wave-a2-stage.mjs';
import {
  validateWaveA2,
} from '../scripts/batch/validate-m5-10a-wave-a2.mjs';
import { main as recordA2Timing } from '../scripts/batch/record-m5-10a-wave-a2-timing.mjs';
import {
  assertEditorialCompletionChronology,
  main as recordA2Editorial,
} from '../scripts/batch/record-m5-10a-wave-a2-editorial.mjs';
import { main as recordA2Audit } from '../scripts/batch/record-m5-10a-wave-a2-audit.mjs';
import {
  createA2TimingProof,
  A2_TIMING_WORK_UNIT_CONTRACT,
  validateA2AuditInput,
  validateA2EditorialInput,
  validateA2ProvenanceArtifact,
  validateA2ProposalStagingDigest,
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
  validateBatch,
} from '../scripts/batch/validate-batch.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const CURRENT_CANONICAL_DIRECTORY = path.resolve('data/canonical');
const A2_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-preimport-inventory.json');
const A2_BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');
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

function createSelfAuthoredA2ReferenceRecords(editorial, canonicalRecords) {
  const specialGlosses = {
    w603: ['햇볕이 강하고 눈부시다', '소리가 맑고 세차게 울리다'],
    w620: ['액체나 물결이 잔잔하게 흔들리다', '빛이 가볍게 흔들리며 움직이다', '감정이 가볍게 흔들리며 움직이다'],
  };
  const proposalRecords = editorial.records.slice(0, 50).map((recordReview) => {
    const id = recordReview.proposal_canonical_id ?? recordReview.canonical_id;
    const glosses = specialGlosses[id] ?? Array.from(
      { length: recordReview.observed_sense_count },
      (_, index) => `Self-authored test sense ${id}-${index + 1}.`,
    );
    const senses = glosses.map((gloss, index) => ({
      id: `${id}-s${index + 1}`,
      pos: recordReview.observed_pos[index],
      gloss,
      ...(id === 'w621' && index === 1 ? {
        relations: [{
          target: 'w009',
          target_sense: 'w009-s1',
          type: 'association',
          note: 'Self-authored test relation for the verified promotion fixture.',
        }],
      } : {}),
    }));
    return {
      source: 'test-fixture',
      record: {
        id,
        record_type: recordReview.observed_pos[0] === 'expression' ? 'expression' : 'entry',
        role: 'start',
        candidate_id: id,
        lemma: `self-authored-${id}`,
        search_forms: [`self-authored-${id}`],
        senses,
      },
    };
  });
  return [...canonicalRecords, ...proposalRecords];
}

function serializeCanonicalRecords(recordInfos) {
  return `${recordInfos.map(({ record }) => JSON.stringify(record)).join('\n')}\n`;
}

function assertInputError(action, code) {
  assert.throws(action, (error) => error.code === code);
}

function createUnverifiedEditorialFixture(editorial) {
  const fixture = structuredClone(editorial);
  fixture.source_kind = 'unverified-draft';
  fixture.status = 'in-review';
  delete fixture.completed_at;
  delete fixture.reviewed_staging_sha256;
  delete fixture.timing_artifact;
  delete fixture.decision_artifact;
  fixture.provenance = {
    verification_status: 'unverified',
    actor_kind: 'unknown',
    actor_id: 'unknown',
    session_id: null,
    artifact: null,
    sha256: null,
    note: 'Test-only unverified proposal fixture.',
  };
  fixture.sense_review = {
    ...fixture.sense_review,
    status: 'in-review',
    reviewed_start_count: 0,
    scoped_single_sense_count: 0,
    split_record_count: 0,
    split_canonical_ids: [],
    note: 'Test fixture keeps the proposal outside completed claims.',
  };
  fixture.records.slice(0, 50).forEach((recordReview) => {
    const canonicalId = recordReview.canonical_id ?? recordReview.proposal_canonical_id;
    const decision = recordReview.decision === 'proposed'
      ? recordReview.proposal_decision
      : recordReview.decision;
    const correctedFields = recordReview.corrected_fields ?? recordReview.proposal_corrected_fields;
    recordReview.proposal_canonical_id = canonicalId;
    recordReview.proposal_decision = decision;
    if (correctedFields) recordReview.proposal_corrected_fields = correctedFields;
    delete recordReview.canonical_id;
    delete recordReview.corrected_fields;
    recordReview.decision = 'proposed';
    const proposedSenseIds = Array.from(
      { length: recordReview.observed_sense_count },
      (_, index) => `${canonicalId}-s${index + 1}`,
    );
    recordReview.boundary_evidence = Object.fromEntries(A2_BOUNDARY_IDS.map((boundaryId) => [boundaryId, {
      review_status: 'unreviewed',
      applicability: 'unknown',
      candidate_sense_ids: proposedSenseIds,
      decision: 'pending',
      contrasts: [],
    }]));
  });
  return fixture;
}

function createUnverifiedAuditFixture(audit) {
  const fixture = structuredClone(audit);
  fixture.source_kind = 'unverified-draft';
  fixture.status = 'incomplete';
  delete fixture.completed_at;
  delete fixture.reviewed_staging_sha256;
  delete fixture.timing_artifact;
  delete fixture.decision_artifact;
  fixture.provenance = {
    verification_status: 'unverified',
    actor_kind: 'unknown',
    actor_id: 'unknown',
    session_id: null,
    artifact: null,
    sha256: null,
    note: 'Test-only unverified audit fixture.',
  };
  fixture.auditor_id = 'unknown';
  fixture.independent = false;
  fixture.reviewed_record_ids = [];
  fixture.relation_reviews = [];
  fixture.findings = [{
    id: 'a2-test-unverified-provenance',
    category: 'provenance',
    severity: 'blocker',
    status: 'open',
    evidence_refs: ['unverified-editorial-input'],
    note: 'Test fixture retains an open provenance blocker until an editorial pass is verified.',
  }];
  fixture.note = 'Test fixture keeps the audit outside completed claims.';
  return fixture;
}

function createVerifiedEditorialFixture(
  editorial,
  canonicalRecords,
  reviewedStagingSha256,
  { sourceKind = 'human-authored', actorKind = 'human', actorId = 'editor-session-owner' } = {},
) {
  const fixture = editorial.source_kind === 'unverified-draft'
    ? structuredClone(editorial)
    : createUnverifiedEditorialFixture(editorial);
  const canonicalById = new Map(canonicalRecords.map(({ record }) => [record.id, record]));
  fixture.schema_version = '2';
  fixture.source_kind = sourceKind;
  fixture.provenance = {
    verification_status: 'verified',
    actor_kind: actorKind,
    actor_id: actorId,
    session_id: '11111111-1111-4111-8111-111111111111',
    artifact: 'data/batches/test-editorial-session.json',
    sha256: 'a'.repeat(64),
    note: 'Test-only verified editorial session fixture.',
  };
  fixture.status = 'complete';
  fixture.created_at = '2026-09-09T05:30:00Z';
  fixture.completed_at = '2026-09-09T06:00:00Z';
  fixture.reviewed_staging_sha256 = reviewedStagingSha256;
  fixture.timing_artifact = {
    path: 'data/batches/test-timing.json',
    sha256: 'c'.repeat(64),
    completed_at: '2026-09-09T05:50:00Z',
  };
  fixture.decision_artifact = {
    path: 'data/batches/test-editorial-decisions.json',
    sha256: 'd'.repeat(64),
    created_at: '2026-09-09T05:40:00Z',
    finalized_at: '2026-09-09T05:55:00Z',
  };
  fixture.sense_review.status = 'complete';
  fixture.sense_review.reviewed_start_count = 50;
  fixture.sense_review.split_record_count = fixture.records
    .slice(0, 50)
    .filter(({ proposal_decision, proposal_canonical_id }) => (
      proposal_decision === 'corrected'
      && canonicalById.get(proposal_canonical_id).senses.length > 1
    )).length;
  fixture.sense_review.scoped_single_sense_count = 50 - fixture.sense_review.split_record_count;
  fixture.sense_review.split_canonical_ids = fixture.records
    .slice(0, 50)
    .filter(({ proposal_decision, proposal_canonical_id }) => (
      proposal_decision === 'corrected'
      && canonicalById.get(proposal_canonical_id).senses.length > 1
    ))
    .map(({ proposal_canonical_id: canonicalId }) => canonicalId);
  fixture.sense_review.note = 'Test fixture records structured sense decisions and boundary contrasts.';

  fixture.records.slice(0, 50).forEach((recordReview, index) => {
    recordReview.canonical_id = recordReview.proposal_canonical_id;
    recordReview.decision = recordReview.proposal_decision;
    if (recordReview.proposal_corrected_fields) {
      recordReview.corrected_fields = recordReview.proposal_corrected_fields;
    }
    delete recordReview.proposal_canonical_id;
    delete recordReview.proposal_decision;
    delete recordReview.proposal_corrected_fields;
    const canonical = canonicalById.get(recordReview.canonical_id);
    recordReview.decision_note = `${recordReview.inventory_id} ${canonical.id} ${canonical.lemma}: verified editorial decision for the test fixture.`;
    const split = recordReview.decision === 'corrected' && canonical.senses.length > 1;
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

function createVerifiedAuditFixture(
  audit,
  editorial,
  relationDiff,
  {
    sourceKind = 'human-authored',
    actorKind = 'human',
    actorId = 'audit-session-owner',
    sessionId = '22222222-2222-4222-8222-222222222222',
    artifact = 'data/batches/test-audit-session.json',
  } = {},
) {
  const fixture = structuredClone(audit);
  fixture.schema_version = '2';
  fixture.source_kind = sourceKind;
  fixture.provenance = {
    verification_status: 'verified',
    actor_kind: actorKind,
    actor_id: actorId,
    session_id: sessionId,
    artifact,
    sha256: 'b'.repeat(64),
    note: 'Test-only verified audit session fixture.',
  };
  fixture.auditor_id = fixture.provenance.actor_id;
  fixture.reviewed_staging_sha256 = editorial.reviewed_staging_sha256;
  fixture.independent = true;
  fixture.created_at = '2026-09-09T06:10:00Z';
  fixture.completed_at = '2026-09-09T06:30:00Z';
  fixture.timing_artifact = structuredClone(editorial.timing_artifact);
  fixture.decision_artifact = {
    path: 'data/batches/test-audit-decisions.json',
    sha256: 'e'.repeat(64),
    created_at: '2026-09-09T06:15:00Z',
    finalized_at: '2026-09-09T06:20:00Z',
  };
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

function createCompleteTimingFixture(timing) {
  const fixture = structuredClone(timing);
  const baseTime = Date.parse('2026-09-09T07:00:00Z');
  fixture.status = 'complete';
  fixture.passes = fixture.passes.map((pass, index) => {
    const sessionId = `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`;
    const startedAt = new Date(baseTime + index * 360000).toISOString();
    const completedAt = new Date(baseTime + index * 360000 + 300000).toISOString();
    const contract = A2_TIMING_WORK_UNIT_CONTRACT[pass.id];
    return {
      ...pass,
      status: 'complete',
      started_at: startedAt,
      completed_at: completedAt,
      wall_clock_seconds: 300,
      editor_seconds: 300,
      session_id: sessionId,
      recording_source: 'timing-recorder-v1',
      work_evidence: {
        unit_kind: contract.unit_kind,
        unit_count: contract.unit_ids.length,
        unit_ids: [...contract.unit_ids],
        before_sha256: 'c'.repeat(64),
        after_sha256: 'd'.repeat(64),
        note: `${pass.id} completed work-unit fixture evidence.`,
      },
    };
  });
  fixture.events = fixture.passes.flatMap((pass, index) => ([
    {
      event_id: `m5-10a-wave-a2-timing-event-${String(index * 2 + 1).padStart(4, '0')}`,
      pass_id: pass.id,
      kind: 'start',
      session_id: pass.session_id,
      at: pass.started_at,
    },
    {
      event_id: `m5-10a-wave-a2-timing-event-${String(index * 2 + 2).padStart(4, '0')}`,
      pass_id: pass.id,
      kind: 'stop',
      session_id: pass.session_id,
      at: pass.completed_at,
    },
  ]));
  fixture.recording_proof_sha256 = createA2TimingProof(fixture);
  return fixture;
}

test('M5-10A Wave A2 imports frozen reviewed data but keeps the next stage uncreated', async () => {
  const [manifest, editorial, audit, relationDiff, metrics, stage, plan, canonical] = await Promise.all([
    readBatchJson('m5-10-wave-a2.json'),
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
    readBatchJson('m5-10a-wave-a2-audit-input.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readBatchJson('m5-10a-wave-a2-metrics.json'),
    readBatchJson('m5-10a-wave-a2.json'),
    readBatchJson('m5-8-expansion-plan.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);

  assert.equal(manifest.batch_id, 'm5-10-wave-a2-20260909');
  assert.equal(manifest.records.length, 58);
  assert.equal(manifest.review.status, 'complete');
  assert.equal(manifest.review.reviewer, editorial.provenance.actor_id);
  assert.equal(manifest.generator.draft_sha256, editorial.proposal_staging.sha256);
  assert.equal(manifest.review.reviewed_staging_sha256, editorial.reviewed_staging_sha256);
  assert.equal(manifest.sense_review.status, 'complete');
  assert.equal(manifest.sense_review.reviewed_start_count, 50);
  assert.equal(manifest.sense_review.split_record_count, 15);
  assert.equal(manifest.sense_review.preflight.record_checkpoints.length, 58);
  assert.ok(manifest.sense_review.preflight.record_checkpoints.slice(0, 50).every((checkpoint) => checkpoint.status === 'complete'));
  assert.deepEqual(manifest.sense_review.preflight.record_checkpoints.slice(50).map(({ status }) => status), [
    'held', 'held', 'held', 'rejected', 'rejected', 'rejected', 'deferred', 'deferred',
  ]);
  assert.deepEqual(metrics.derived.decisions, {
    included: 34,
    held: 3,
    rejected: 3,
    corrected: 16,
    deferred: 2,
    importable_start_count: 50,
    correction_rate_of_selected: 16 / 56,
    correction_rate_of_importable: 16 / 50,
    held_rate: 3 / 56,
    rejected_rate: 3 / 56,
    held_or_rejected_rate: 6 / 56,
    sense_field_correction_count: 16,
    relation_field_correction_count: 0,
  });
  assert.equal(metrics.derived.canonical_import.imported_start_count, 50);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 66);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 6);
  assert.deepEqual(metrics.derived.canonical_import.relation_type_counts, {
    mood: 3,
    near: 1,
    sensory: 1,
    association: 1,
  });
  assert.equal(canonical.records.length, 670);
  const reviewedIds = editorial.records.slice(0, 50).map(({ canonical_id: canonicalId }) => canonicalId);
  assert.equal(editorial.source_kind, 'codex-authored');
  assert.equal(editorial.status, 'complete');
  assert.equal(audit.source_kind, 'codex-authored');
  assert.equal(audit.status, 'complete');
  assert.equal(audit.independent, true);
  assert.ok(canonical.records.every(({ record }) => record.id !== 'w603' || record.senses.length === 2));
  assert.deepEqual(reviewedIds, Array.from({ length: 50 }, (_, index) => `w${index + 579}`));

  const stagingDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-staging-'));
  try {
    const reviewedStagingPath = path.join(stagingDirectory, 'reviewed.jsonl');
    await writeFile(
      reviewedStagingPath,
      serializeCanonicalRecords(canonical.records.filter(({ record }) => reviewedIds.includes(record.id))),
      'utf8',
    );
    assert.deepEqual((await validateWaveA2({ stagedRecordsPath: reviewedStagingPath })).batch, {
      batch_id: 'm5-10-wave-a2-20260909',
      validation_status: 'validated',
      selected_start_count: 58,
      proposed_start_count: 50,
      proposed_sense_count: 66,
    });
    const tamperedStagingPath = path.join(stagingDirectory, 'tampered.jsonl');
    await writeFile(tamperedStagingPath, '{"not":"a canonical record"}\n', 'utf8');
    await assert.rejects(
      validateA2ProposalStagingDigest({
        input: editorial,
        stagedRecordsPath: tamperedStagingPath,
      }),
      (error) => error.code === 'REVIEWED_STAGING_DIGEST_MISMATCH',
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }

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
    admitted_candidate_count: 6,
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
  assert.equal(metrics.derived.timing.status, 'complete');
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, []);
  assert.equal(metrics.derived.audit.status, 'complete');
  assert.equal(metrics.derived.audit.independent, true);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);
  assert.equal(metrics.derived.sense_review.status, 'complete');

  assert.deepEqual(await validateExpansionStage(stage, plan), {
    stage_id: 'm5-10a-wave-a2-plus-50',
    imported_start_count: 50,
    candidate_buffer: 8,
    gate_status: 'pass',
  });
  assert.deepEqual(stage.actual.canonical_snapshot, {
    record_count: 670,
    start_count: 628,
    reference_only_count: 42,
    sense_count: 809,
    relation_count: 473,
    expression_count: 43,
  });
  assert.equal(stage.decisions.proposed_start_count, undefined);
  assert.deepEqual(stage.decisions, {
    included_start_count: 34,
    corrected_start_count: 16,
    held_start_count: 3,
    rejected_start_count: 3,
    deferred_start_count: 2,
  });
  assert.equal(stage.metrics.timing_status, 'complete');
  assert.equal(stage.metrics.total_editor_seconds, metrics.derived.timing.total_editor_seconds);
  assert.ok(stage.metrics.editor_seconds_per_selected_start <= 12);
  assert.equal(stage.metrics.unmeasured_timing_pass_count, 0);
  assert.equal(stage.decision, 'APPROVE BOUNDED');
  assert.deepEqual(nextStageState('pass'), {
    ready_to_create: true,
    next_stage_created: false,
    next_stage_authorized: false,
  });
  assert.equal(stage.ready_to_create, true);
  assert.equal(stage.correction_plan.status, 'not-required');
  assert.equal(stage.correction_plan.expected_saving_editor_seconds, 0);
  assert.match(stage.correction_plan.next_validation.note, /^No retry is required by this passing result\b/);
  assert.equal(stage.next_stage_created, false);
  assert.equal(stage.next_stage_authorized, false);
  assert.equal(stage.metrics.editorial_review_complete, true);
  assert.equal(stage.metrics.human_editorial_review_complete, false);
  assert.equal(stage.metrics.audit_status, 'complete');
  assert.equal(stage.metrics.audit_independent, true);

  const contradictoryStage = structuredClone(stage);
  contradictoryStage.correction_plan.next_validation.note = 'Run a retry and HOLD Wave B until re-evaluated.';
  await assert.rejects(
    validateExpansionStage(contradictoryStage, plan),
    (error) => error.code === 'CORRECTION_PLAN_CONTRADICTION',
  );
});

test('M5-10A Wave A2 keeps unverified proposals out of completed claims', async () => {
  const [editorial, audit, timing, relationDiff, canonical] = await Promise.all([
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
    readBatchJson('m5-10a-wave-a2-audit-input.json'),
    readBatchJson('m5-10a-wave-a2-timing-input.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);
  const referenceRecords = createSelfAuthoredA2ReferenceRecords(editorial, canonical.records);
  const reviewedStagingBytes = Buffer.from(
    serializeCanonicalRecords(referenceRecords.slice(canonical.records.length)),
    'utf8',
  );
  const reviewedStagingSha256 = sha256Bytes(reviewedStagingBytes);
  const unverifiedInput = createUnverifiedEditorialFixture(editorial);
  const unverifiedAuditInput = createUnverifiedAuditFixture(audit);
  const unverifiedEditorial = validateA2EditorialInput({
    input: unverifiedInput,
    canonicalRecords: referenceRecords,
  });
  assert.equal(unverifiedEditorial.verified, false);
  const unverifiedAudit = validateA2AuditInput({
    audit: unverifiedAuditInput,
    editorialInput: unverifiedEditorial,
    relationDiff,
    canonicalRecords: referenceRecords,
  });
  assert.equal(unverifiedAudit.verified, false);
  validateA2TimingInput(timing);

  const verifiedEditorial = createVerifiedEditorialFixture(
    editorial,
    referenceRecords,
    reviewedStagingSha256,
  );
  validateA2EditorialInput({
    input: verifiedEditorial,
    canonicalRecords: referenceRecords,
  });
  const verifiedRelationDiff = createVerifiedRelationDiffFixture(relationDiff);
  const verifiedAudit = createVerifiedAuditFixture(audit, verifiedEditorial, verifiedRelationDiff);
  assert.equal(
    validateA2AuditInput({
      audit: verifiedAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: verifiedRelationDiff,
      canonicalRecords: referenceRecords,
    }).verified,
    true,
  );

  const manifestSources = {
    editorialInputSource: { path: 'data/batches/test-editorial.json', sha256: 'a'.repeat(64) },
    auditInputSource: { path: 'data/batches/test-audit.json', sha256: 'b'.repeat(64) },
    timingInputSource: { path: 'data/batches/test-timing.json', sha256: 'c'.repeat(64) },
    relationDiffSource: {
      path: 'data/batches/test-relation-diff.json',
      sha256: 'd'.repeat(64),
      value: relationDiff,
    },
  };
  const blockedPromotionManifest = createWaveA2Manifest({
    editorialInput: verifiedEditorial,
    auditInput: unverifiedAuditInput,
    timingInput: timing,
    canonicalRecords: referenceRecords,
    ...manifestSources,
  });
  assert.equal(blockedPromotionManifest.review.status, 'in-review');
  assert.equal(blockedPromotionManifest.sense_review.status, 'incomplete');
  assert.equal(blockedPromotionManifest.records[0].decision, 'proposed');
  assert.equal(blockedPromotionManifest.records[0].canonical_id, undefined);
  assert.equal(blockedPromotionManifest.records[0].proposal_canonical_id, 'w579');

  const completeTiming = createCompleteTimingFixture(timing);
  const promotedManifest = createWaveA2Manifest({
    editorialInput: verifiedEditorial,
    auditInput: verifiedAudit,
    timingInput: completeTiming,
    canonicalRecords: referenceRecords,
    ...manifestSources,
    relationDiffSource: {
      ...manifestSources.relationDiffSource,
      value: verifiedRelationDiff,
    },
  });
  assert.equal(promotedManifest.review.status, 'complete');
  assert.equal(promotedManifest.sense_review.status, 'complete');
  assert.equal(promotedManifest.records[0].decision, 'included');
  assert.equal(promotedManifest.records[0].canonical_id, 'w579');
  assert.equal(promotedManifest.records[0].proposal_canonical_id, undefined);
  assert.equal(promotedManifest.review.reviewed_staging_sha256, reviewedStagingSha256);
  assert.equal(promotedManifest.measurement.audit.reviewed_staging_sha256, reviewedStagingSha256);

  const promotionDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-promotion-'));
  try {
    const promotedManifestPath = path.join(promotionDirectory, 'manifest.json');
    const stagedRecordsPath = path.join(promotionDirectory, 'reviewed.jsonl');
    const tamperedStagedRecordsPath = path.join(promotionDirectory, 'tampered.jsonl');
    await writeFile(promotedManifestPath, `${JSON.stringify(promotedManifest)}\n`, 'utf8');
    await writeFile(stagedRecordsPath, reviewedStagingBytes);
    const promotion = await validateBatch({
      manifestPath: promotedManifestPath,
      stagedRecordsPath,
      inventoryPath: A2_INVENTORY_PATH,
      canonicalDirectory: A2_BASE_CANONICAL_DIRECTORY,
    });
    assert.equal(promotion.stagedRecordCount, 50);

    const tamperedStaging = reviewedStagingBytes
      .toString('utf8')
      .replace('Self-authored test sense w579-1.', 'Self-authored test sense w579-x1.');
    assert.notEqual(tamperedStaging, reviewedStagingBytes.toString('utf8'));
    await writeFile(tamperedStagedRecordsPath, tamperedStaging, 'utf8');
    await assert.rejects(
      validateBatch({
        manifestPath: promotedManifestPath,
        stagedRecordsPath: tamperedStagedRecordsPath,
        inventoryPath: A2_INVENTORY_PATH,
        canonicalDirectory: A2_BASE_CANONICAL_DIRECTORY,
      }),
      (error) => error.code === 'REVIEWED_STAGING_DIGEST_MISMATCH',
    );
  } finally {
    await rm(promotionDirectory, { recursive: true, force: true });
  }

  const pendingRelationDiff = structuredClone(relationDiff);
  pendingRelationDiff.candidate_reviews[0].decision = 'pending';
  const pendingAudit = createVerifiedAuditFixture(audit, verifiedEditorial, pendingRelationDiff);
  const auditDigestMismatch = structuredClone(verifiedAudit);
  auditDigestMismatch.reviewed_staging_sha256 = 'e'.repeat(64);
  assertInputError(
    () => validateA2AuditInput({
      audit: auditDigestMismatch,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: verifiedRelationDiff,
      canonicalRecords: referenceRecords,
    }),
    'AUDIT_STAGING_BINDING_MISMATCH',
  );
  assertInputError(
    () => validateA2AuditInput({
      audit: pendingAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: pendingRelationDiff,
      canonicalRecords: referenceRecords,
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
      canonicalRecords: referenceRecords,
    }),
    'MISSING_CANONICAL_SENSE',
  );

  const posMismatch = structuredClone(verifiedEditorial);
  posMismatch.records[0].observed_pos = [];
  assertInputError(
    () => validateA2EditorialInput({ input: posMismatch, canonicalRecords: referenceRecords }),
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
    () => validateA2EditorialInput({ input: structuralMismatch, canonicalRecords: referenceRecords }),
    'BOUNDARY_SENSE_COVERAGE_MISMATCH',
  );

  const missingEvidence = structuredClone(verifiedEditorial);
  delete missingEvidence.records[0].boundary_evidence['word-idiom'];
  assertInputError(
    () => validateA2EditorialInput({ input: missingEvidence, canonicalRecords: referenceRecords }),
    'SCHEMA_ERROR',
  );

  const unreviewedEvidence = structuredClone(verifiedEditorial);
  unreviewedEvidence.records[0].boundary_evidence['word-idiom'].review_status = 'unreviewed';
  assertInputError(
    () => validateA2EditorialInput({ input: unreviewedEvidence, canonicalRecords: referenceRecords }),
    'UNREVIEWED_BOUNDARY_EVIDENCE',
  );

  const duplicatedEvidence = structuredClone(verifiedEditorial);
  const splitRecords = duplicatedEvidence.records.filter(({ decision, boundary_evidence: boundaryEvidence }) => (
    decision === 'corrected'
    && boundaryEvidence['sensory-emotion-state-action'].contrasts.length > 0
  ));
  const firstSplit = splitRecords[0];
  const secondSplit = splitRecords[1];
  const firstContrast = firstSplit.boundary_evidence['sensory-emotion-state-action'].contrasts[0];
  const firstCanonical = referenceRecords.find(({ record }) => record.id === firstSplit.canonical_id).record;
  const secondCanonical = referenceRecords.find(({ record }) => record.id === secondSplit.canonical_id).record;
  const duplicatedContrastEvidence = {
    ...firstContrast,
    dimension: 'sensory',
    facets: ['duplicated-sensory-facet'],
    left_observation: 'The left use focuses on a concrete observed signal.',
    right_observation: 'The right use focuses on a different observed signal.',
    difference: 'These two uses differ in their observed focus and cannot share one sense.',
  };
  firstSplit.boundary_evidence['sensory-emotion-state-action'].contrasts = [{
    ...duplicatedContrastEvidence,
    left_sense_id: firstCanonical.senses[0].id,
    right_sense_id: firstCanonical.senses[1].id,
  }];
  secondSplit.boundary_evidence['sensory-emotion-state-action'].contrasts = [{
    ...duplicatedContrastEvidence,
    left_sense_id: secondCanonical.senses[0].id,
    right_sense_id: secondCanonical.senses[1].id,
  }];
  assertInputError(
    () => validateA2EditorialInput({ input: duplicatedEvidence, canonicalRecords: referenceRecords }),
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
      canonicalRecords: referenceRecords,
    }),
    'GENERIC_EDITORIAL_EVIDENCE',
  );

  const nonIndependentAudit = structuredClone(verifiedAudit);
  nonIndependentAudit.independent = true;
  nonIndependentAudit.provenance.session_id = verifiedEditorial.provenance.session_id;
  nonIndependentAudit.provenance.artifact = verifiedEditorial.provenance.artifact;
  assertInputError(
    () => validateA2AuditInput({
      audit: nonIndependentAudit,
      editorialInput: { ...verifiedEditorial, verified: true },
      relationDiff: verifiedRelationDiff,
      canonicalRecords: referenceRecords,
    }),
    'AUDIT_NOT_INDEPENDENT',
  );

  const falseHumanClaim = structuredClone(editorial);
  falseHumanClaim.source_kind = 'human-authored';
  falseHumanClaim.status = 'complete';
  falseHumanClaim.completed_at = '2026-09-09T06:00:00Z';
  falseHumanClaim.reviewed_staging_sha256 = 'a'.repeat(64);
  falseHumanClaim.sense_review.status = 'complete';
  assertInputError(
    () => validateA2EditorialInput({ input: falseHumanClaim, canonicalRecords: referenceRecords }),
    'PROVENANCE_REQUIRED',
  );

  const inReviewHumanClaim = structuredClone(editorial);
  inReviewHumanClaim.source_kind = 'human-authored';
  inReviewHumanClaim.status = 'in-review';
  delete inReviewHumanClaim.completed_at;
  delete inReviewHumanClaim.reviewed_staging_sha256;
  inReviewHumanClaim.sense_review.status = 'in-review';
  inReviewHumanClaim.provenance.verification_status = 'verified';
  inReviewHumanClaim.provenance.actor_kind = 'human';
  inReviewHumanClaim.provenance.actor_id = 'editor-session-owner';
  assertInputError(
    () => validateA2EditorialInput({ input: inReviewHumanClaim, canonicalRecords: referenceRecords }),
    'SCHEMA_ERROR',
  );

  const syntheticTiming = structuredClone(timing);
  syntheticTiming.status = 'complete';
  syntheticTiming.events = [];
  syntheticTiming.recording_proof_sha256 = createA2TimingProof(syntheticTiming);
  assertInputError(() => validateA2TimingInput(syntheticTiming), 'TIMING_EVENT_COVERAGE');

  const timingAfterEditorial = structuredClone(verifiedEditorial);
  timingAfterEditorial.timing_artifact.completed_at = '2026-09-09T06:01:00Z';
  assertInputError(
    () => validateA2EditorialInput({ input: timingAfterEditorial, canonicalRecords: referenceRecords }),
    'EDITORIAL_CHRONOLOGY_MISMATCH',
  );
  const decisionBeforeTiming = structuredClone(verifiedEditorial);
  decisionBeforeTiming.decision_artifact.finalized_at = '2026-09-09T05:49:00Z';
  assertInputError(
    () => validateA2EditorialInput({ input: decisionBeforeTiming, canonicalRecords: referenceRecords }),
    'EDITORIAL_DECISION_ARTIFACT_CHRONOLOGY',
  );
  assert.throws(
    () => assertEditorialCompletionChronology(
      createCompleteTimingFixture(timing),
      '2026-09-09T06:00:00Z',
    ),
    /editorial completion cannot precede the final timing stop/,
  );

  const canonicalById = new Map(referenceRecords.map(({ record }) => [record.id, record]));
  assert.equal(canonicalById.get('w603').senses.length, 2);
  assert.deepEqual(
    canonicalById.get('w603').senses.map(({ gloss }) => gloss),
    ['햇볕이 강하고 눈부시다', '소리가 맑고 세차게 울리다'],
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

test('M5-10A completion recorders require separately supplied decision artifacts', async () => {
  await assert.rejects(
    recordA2Editorial([
      '--action=complete',
      '--proposal=/private/tmp/typewriter-m5-10a-wave-a2-proposal.jsonl',
      '--session=/private/tmp/typewriter-m5-10a-wave-a2-editorial-session-negative.json',
      '--staging=/private/tmp/typewriter-m5-10a-wave-a2-reviewed.jsonl',
      '--timing=data/batches/m5-10a-wave-a2-timing-input.json',
      '--editorial=data/batches/m5-10a-wave-a2-editorial-input-negative.json',
      '--canonical=data/canonical',
    ]),
    /--decisions is required for complete/,
  );
  await assert.rejects(
    recordA2Audit([
      '--action=complete',
      '--session=/private/tmp/typewriter-m5-10a-wave-a2-audit-session-negative.json',
      '--editorial=data/batches/m5-10a-wave-a2-editorial-input.json',
      '--staging=/private/tmp/typewriter-m5-10a-wave-a2-reviewed.jsonl',
      '--timing=data/batches/m5-10a-wave-a2-timing-input.json',
    ]),
    /--decisions is required/,
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-audit-recorder-'));
  try {
    const [editorial, canonical] = await Promise.all([
      readBatchJson('m5-10a-wave-a2-editorial-input.json'),
      readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
    ]);
    const reviewedIds = new Set(editorial.records.slice(0, 50).map(({ canonical_id: canonicalId }) => canonicalId));
    const stagingPath = path.join(directory, 'reviewed.jsonl');
    const sessionPath = path.join(directory, 'audit-session.json');
    const decisionsPath = path.join(directory, 'audit-decisions.json');
    await writeFile(
      stagingPath,
      serializeCanonicalRecords(canonical.records.filter(({ record }) => reviewedIds.has(record.id))),
      'utf8',
    );
    const started = await recordA2Audit([
      '--action=start',
      `--session=${sessionPath}`,
      '--editorial=data/batches/m5-10a-wave-a2-editorial-input.json',
      `--staging=${stagingPath}`,
      '--timing=data/batches/m5-10a-wave-a2-timing-input.json',
      `--decisions=${decisionsPath}`,
      '--canonical=data/canonical',
    ]);
    assert.equal(started.status, 'in-progress');
    await assert.rejects(
      recordA2Audit([
        '--action=complete',
        `--session=${sessionPath}`,
        '--editorial=data/batches/m5-10a-wave-a2-editorial-input.json',
        `--staging=${stagingPath}`,
        '--timing=data/batches/m5-10a-wave-a2-timing-input.json',
        `--decisions=${decisionsPath}`,
        '--audit=data/batches/m5-10a-wave-a2-audit-input-negative.json',
        '--relation=data/batches/m5-10a-wave-a2-relation-diff.json',
        '--canonical=data/canonical',
      ]),
      /audit decision artifact does not exist/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M5-10A treats a separate Codex audit pass as independent without requiring another actor', async () => {
  const [editorial, audit, relationDiff, canonical] = await Promise.all([
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
    readBatchJson('m5-10a-wave-a2-audit-input.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);
  const referenceRecords = createSelfAuthoredA2ReferenceRecords(editorial, canonical.records);
  const reviewedStagingSha256 = sha256Bytes(
    Buffer.from(serializeCanonicalRecords(referenceRecords.slice(canonical.records.length)), 'utf8'),
  );
  const codexEditorial = createVerifiedEditorialFixture(
    editorial,
    referenceRecords,
    reviewedStagingSha256,
    { sourceKind: 'codex-authored', actorKind: 'codex', actorId: 'codex-wave-a2' },
  );
  const codexAudit = createVerifiedAuditFixture(
    audit,
    codexEditorial,
    createVerifiedRelationDiffFixture(relationDiff),
    {
      sourceKind: 'codex-authored',
      actorKind: 'codex',
      actorId: 'codex-wave-a2',
      sessionId: '22222222-2222-4222-8222-222222222222',
      artifact: 'data/batches/test-codex-audit-session.json',
    },
  );
  const validatedEditorial = validateA2EditorialInput({
    input: codexEditorial,
    canonicalRecords: referenceRecords,
  });
  assert.equal(validatedEditorial.verified, true);
  assert.equal(
    validateA2AuditInput({
      audit: codexAudit,
      editorialInput: validatedEditorial,
      relationDiff: createVerifiedRelationDiffFixture(relationDiff),
      canonicalRecords: referenceRecords,
    }).verified,
    true,
  );

  const reusedSession = structuredClone(codexAudit);
  reusedSession.provenance.session_id = codexEditorial.provenance.session_id;
  assertInputError(
    () => validateA2AuditInput({
      audit: reusedSession,
      editorialInput: validatedEditorial,
      relationDiff: createVerifiedRelationDiffFixture(relationDiff),
      canonicalRecords: referenceRecords,
    }),
    'AUDIT_NOT_INDEPENDENT',
  );

  const reusedArtifact = structuredClone(codexAudit);
  reusedArtifact.provenance.artifact = codexEditorial.provenance.artifact;
  assertInputError(
    () => validateA2AuditInput({
      audit: reusedArtifact,
      editorialInput: validatedEditorial,
      relationDiff: createVerifiedRelationDiffFixture(relationDiff),
      canonicalRecords: referenceRecords,
    }),
    'AUDIT_NOT_INDEPENDENT',
  );
});

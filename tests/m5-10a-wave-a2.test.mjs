import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildWaveA2Manifest,
  createWaveA2Manifest,
} from '../scripts/batch/build-m5-10a-wave-a2.mjs';
import {
  validateA2CanonicalBoundary,
  validateWaveA2,
} from '../scripts/batch/validate-m5-10a-wave-a2.mjs';
import { main as recordA2Timing } from '../scripts/batch/record-m5-10a-wave-a2-timing.mjs';
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
  validateBatchManifest,
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
    w603: ['햇볕이 강하고 눈부시다', '소리가 맑고 세차게 울리다', '빛이 맑고 세차게 비치다'],
    w620: ['액체나 물결이 잔잔하게 흔들리다', '빛이 가볍게 흔들리며 움직이다', '감정이 가볍게 흔들리며 움직이다'],
  };
  const proposalRecords = editorial.records.slice(0, 50).map((recordReview) => {
    const id = recordReview.proposal_canonical_id;
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

function createVerifiedEditorialFixture(editorial, canonicalRecords, reviewedStagingSha256) {
  const fixture = structuredClone(editorial);
  const canonicalById = new Map(canonicalRecords.map(({ record }) => [record.id, record]));
  fixture.records.slice(0, 50).forEach((recordReview) => {
    if (recordReview.decision !== 'proposed') return;
    recordReview.canonical_id = recordReview.proposal_canonical_id;
    recordReview.decision = recordReview.proposal_decision;
    delete recordReview.proposal_canonical_id;
    delete recordReview.proposal_decision;
    if (recordReview.proposal_corrected_fields) {
      recordReview.corrected_fields = recordReview.proposal_corrected_fields;
      delete recordReview.proposal_corrected_fields;
    }
  });
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
  fixture.reviewed_staging_sha256 = reviewedStagingSha256;
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
  fixture.reviewed_staging_sha256 = editorial.reviewed_staging_sha256;
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

function createCompleteTimingFixture(timing) {
  const fixture = structuredClone(timing);
  const baseTime = Date.parse('2026-09-09T07:00:00Z');
  fixture.status = 'complete';
  fixture.passes = fixture.passes.map((pass, index) => {
    const sessionId = `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`;
    const startedAt = new Date(baseTime + index * 120000).toISOString();
    const completedAt = new Date(baseTime + index * 120000 + 300000).toISOString();
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

test('M5-10A Wave A2 keeps the bounded +50 proposal out of canonical data and keeps Wave B blocked', async () => {
  const [manifest, editorial, relationDiff, metrics, stage, plan, canonical] = await Promise.all([
    readBatchJson('m5-10-wave-a2.json'),
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
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
  assert.equal(manifest.generator.draft_sha256, editorial.proposal_staging.sha256);
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
  assert.equal(metrics.derived.canonical_import.imported_start_count, 0);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 0);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 0);
  assert.equal(metrics.derived.canonical_import.import_status, 'proposed');
  assert.deepEqual(metrics.derived.canonical_import.relation_type_counts, {});
  assert.equal(canonical.records.length, 620);
  const proposalIds = editorial.records.slice(0, 50).map(({ proposal_canonical_id: canonicalId }) => canonicalId);
  assert.equal(proposalIds.length, 50);
  assert.equal(editorial.proposal_staging.format, 'canonical-jsonl');
  assert.match(editorial.proposal_staging.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(canonical.records.some(({ record }) => proposalIds.includes(record.id)), false);
  assert.deepEqual(proposalIds, Array.from({ length: 50 }, (_, index) => `w${index + 579}`));

  validateA2CanonicalBoundary({
    editorialInput: editorial,
    canonicalRecords: canonical.records,
  });
  assert.deepEqual((await validateWaveA2()).batch, {
    batch_id: 'm5-10-wave-a2-20260909',
    validation_status: 'proposal',
    selected_start_count: 58,
    proposed_start_count: 50,
    proposed_sense_count: 67,
  });
  await assert.rejects(
    validateWaveA2({
      stagedRecordsPath: path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-proposal.jsonl'),
    }),
    (error) => error.code === 'STAGED_INPUT_INSIDE_REPOSITORY',
  );
  const stagingDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-10a-staging-'));
  try {
    const tamperedStagingPath = path.join(stagingDirectory, 'proposal.jsonl');
    await writeFile(tamperedStagingPath, '{"not":"a canonical record"}\n', 'utf8');
    await assert.rejects(
      validateA2ProposalStagingDigest({
        input: editorial,
        stagedRecordsPath: tamperedStagingPath,
      }),
      (error) => error.code === 'PROPOSAL_STAGING_DIGEST_MISMATCH',
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  assertInputError(
    () => validateA2CanonicalBoundary({
      editorialInput: editorial,
      canonicalRecords: [...canonical.records, {
        record: { id: proposalIds[0] },
      }],
    }),
    'UNVERIFIED_CANONICAL_PROMOTION',
  );
  for (const decision of ['included', 'corrected']) {
    const illegallyPromoted = structuredClone(manifest);
    illegallyPromoted.records[0].decision = decision;
    illegallyPromoted.records[0].canonical_id = illegallyPromoted.records[0].proposal_canonical_id;
    delete illegallyPromoted.records[0].proposal_canonical_id;
    delete illegallyPromoted.records[0].proposal_decision;
    delete illegallyPromoted.records[0].proposal_corrected_fields;
    if (decision === 'corrected') illegallyPromoted.records[0].corrected_fields = ['senses'];
    assertInputError(
      () => validateBatchManifest(illegallyPromoted),
      'UNVERIFIED_IMPORTABLE_DECISION',
    );
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
  assert.deepEqual(metrics.derived.canonical_import.relation_type_counts, {});
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
    imported_start_count: 0,
    candidate_buffer: 8,
    gate_status: 'fail',
  });
  assert.deepEqual(stage.actual.canonical_snapshot, {
    record_count: 620,
    start_count: 578,
    reference_only_count: 42,
    sense_count: 743,
    relation_count: 467,
    expression_count: 39,
  });
  assert.equal(stage.decisions.proposed_start_count, 50);
  assert.deepEqual(stage.proposal_decisions, {
    included_start_count: 35,
    corrected_start_count: 15,
    held_start_count: 3,
    rejected_start_count: 3,
    deferred_start_count: 2,
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
  const referenceRecords = createSelfAuthoredA2ReferenceRecords(editorial, canonical.records);
  const reviewedStagingBytes = Buffer.from(
    serializeCanonicalRecords(referenceRecords.slice(canonical.records.length)),
    'utf8',
  );
  const reviewedStagingSha256 = sha256Bytes(reviewedStagingBytes);
  const unverifiedEditorial = validateA2EditorialInput({
    input: editorial,
    canonicalRecords: referenceRecords,
  });
  assert.equal(unverifiedEditorial.verified, false);
  const unverifiedAudit = validateA2AuditInput({
    audit,
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
    auditInput: audit,
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

  const pendingAudit = createVerifiedAuditFixture(audit, verifiedEditorial, relationDiff);
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
      relationDiff,
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
  const splitRecords = duplicatedEvidence.records.filter(({ decision }) => decision === 'corrected');
  const firstSplit = splitRecords[0];
  const secondSplit = splitRecords[1];
  const firstContrast = firstSplit.boundary_evidence['sensory-emotion-state-action'].contrasts[0];
  const secondCanonical = referenceRecords.find(({ record }) => record.id === secondSplit.canonical_id).record;
  secondSplit.boundary_evidence['sensory-emotion-state-action'].contrasts = [{
    ...firstContrast,
    left_sense_id: secondCanonical.senses[0].id,
    right_sense_id: secondCanonical.senses[1].id,
    left_observation: `${secondCanonical.senses[0].gloss} is the first observed focus.`,
    right_observation: `${secondCanonical.senses[1].gloss} is the second observed focus.`,
    difference: `${secondCanonical.lemma} separates these senses by the observed focus rather than treating them as one use.`,
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

  const nonIndependentAudit = structuredClone(audit);
  nonIndependentAudit.independent = true;
  assertInputError(
    () => validateA2AuditInput({
      audit: nonIndependentAudit,
      editorialInput: unverifiedEditorial,
      relationDiff,
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
  inReviewHumanClaim.provenance.verification_status = 'verified';
  inReviewHumanClaim.provenance.actor_kind = 'human';
  inReviewHumanClaim.provenance.actor_id = 'editor-session-owner';
  assertInputError(
    () => validateA2EditorialInput({ input: inReviewHumanClaim, canonicalRecords: referenceRecords }),
    'SCHEMA_ERROR',
  );

  const syntheticTiming = structuredClone(timing);
  syntheticTiming.status = 'complete';
  syntheticTiming.recording_proof_sha256 = createA2TimingProof(syntheticTiming);
  assertInputError(() => validateA2TimingInput(syntheticTiming), 'TIMING_EVENT_COVERAGE');

  const canonicalById = new Map(referenceRecords.map(({ record }) => [record.id, record]));
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

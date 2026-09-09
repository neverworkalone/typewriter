import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWaveA2Manifest } from '../scripts/batch/build-m5-10a-wave-a2.mjs';
import { main as recordA2Timing } from '../scripts/batch/record-m5-10a-wave-a2-timing.mjs';
import {
  createA2TimingProof,
  validateA2AuditInput,
  validateA2EditorialInput,
  validateA2TimingInput,
} from '../scripts/batch/validate-m5-10a-wave-a2-inputs.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import { validateBatch } from '../scripts/batch/validate-batch.mjs';
import {
  validateExpansionStage,
} from '../scripts/batch/validate-m5-8-process.mjs';
import {
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-10a-wave-a-base-canonical');
const CURRENT_CANONICAL_DIRECTORY = path.resolve('data/canonical');
const A2_CANONICAL_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-10a-wave-a2.jsonl');

async function readBatchJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

function assertInputError(action, code) {
  assert.throws(action, (error) => error.code === code);
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

  const batch = await validateBatch({
    manifestPath: path.join(BATCH_DIRECTORY, 'm5-10-wave-a2.json'),
    stagedRecordsPath: A2_CANONICAL_PATH,
    inventoryPath: path.join(BATCH_DIRECTORY, 'm5-10a-wave-a2-preimport-inventory.json'),
    canonicalDirectory: BASE_CANONICAL_DIRECTORY,
    allowRepositoryStaging: true,
  });

  assert.equal(manifest.batch_id, 'm5-10-wave-a2-20260909');
  assert.equal(manifest.records.length, 58);
  assert.deepEqual(manifest.sense_review, {
    status: 'complete',
    reviewed_start_count: 50,
    scoped_single_sense_count: 35,
    split_record_count: 15,
    split_canonical_ids: [
      'w588', 'w595', 'w598', 'w599', 'w603', 'w604', 'w606', 'w609',
      'w617', 'w618', 'w619', 'w620', 'w621', 'w622', 'w628',
    ],
    note: manifest.sense_review.note,
    preflight: manifest.sense_review.preflight,
  });
  assert.deepEqual(batch.counts, {
    included: 35,
    held: 3,
    rejected: 3,
    corrected: 15,
    deferred: 2,
  });
  assert.equal(batch.canonicalRecordCount, 620);
  assert.equal(batch.stagedRecordCount, 50);
  assert.equal(batch.targetCount, 58);

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
  assert.equal(metrics.derived.canonical_import.imported_start_count, 50);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 67);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 6);
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
  assert.equal(metrics.derived.audit.open_blocker_count, 0);

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
});

test('M5-10A Wave A2 binds manifest claims to explicit inputs and rejects generated evidence', async () => {
  const [editorial, audit, timing, relationDiff, canonical] = await Promise.all([
    readBatchJson('m5-10a-wave-a2-editorial-input.json'),
    readBatchJson('m5-10a-wave-a2-audit-input.json'),
    readBatchJson('m5-10a-wave-a2-timing-input.json'),
    readBatchJson('m5-10a-wave-a2-relation-diff.json'),
    readCanonicalRecords(CURRENT_CANONICAL_DIRECTORY),
  ]);
  const reviewedEditorial = validateA2EditorialInput({
    input: editorial,
    canonicalRecords: canonical.records,
  });
  validateA2AuditInput({
    audit,
    editorialInput: reviewedEditorial,
    relationDiff,
    canonicalRecords: canonical.records,
  });
  validateA2TimingInput(timing);

  const genericEvidence = structuredClone(editorial);
  genericEvidence.records[0].boundary_evidence['physical-figurative'].note = '환희 실제 sense 경계로 대조해 확인했다.';
  assertInputError(
    () => validateA2EditorialInput({ input: genericEvidence, canonicalRecords: canonical.records }),
    'GENERIC_EDITORIAL_EVIDENCE',
  );

  const missingEvidence = structuredClone(editorial);
  delete missingEvidence.records[0].boundary_evidence['word-idiom'];
  assertInputError(
    () => validateA2EditorialInput({ input: missingEvidence, canonicalRecords: canonical.records }),
    'SCHEMA_ERROR',
  );

  const unreviewedEvidence = structuredClone(editorial);
  unreviewedEvidence.records[0].boundary_evidence['word-idiom'].status = 'not-reviewed';
  assertInputError(
    () => validateA2EditorialInput({ input: unreviewedEvidence, canonicalRecords: canonical.records }),
    'UNREVIEWED_BOUNDARY_EVIDENCE',
  );

  const duplicatedEvidence = structuredClone(editorial);
  duplicatedEvidence.records[1].boundary_evidence['physical-figurative'].note =
    duplicatedEvidence.records[0].boundary_evidence['physical-figurative'].note
      .replaceAll('환희', '연민')
      .replaceAll('w579-s1', 'w580-s1')
      .replaceAll('w579', 'w580');
  assertInputError(
    () => validateA2EditorialInput({ input: duplicatedEvidence, canonicalRecords: canonical.records }),
    'GENERIC_EDITORIAL_EVIDENCE',
  );

  const nonIndependentAudit = structuredClone(audit);
  nonIndependentAudit.auditor_id = editorial.reviewer_id;
  assertInputError(
    () => validateA2AuditInput({
      audit: nonIndependentAudit,
      editorialInput: reviewedEditorial,
      relationDiff,
      canonicalRecords: canonical.records,
    }),
    'AUDIT_NOT_INDEPENDENT',
  );

  const genericAudit = structuredClone(audit);
  genericAudit.findings[0].note = 'source/target sense와 writer-facing relation type으로 독립 대조해 확인했다.';
  assertInputError(
    () => validateA2AuditInput({
      audit: genericAudit,
      editorialInput: reviewedEditorial,
      relationDiff,
      canonicalRecords: canonical.records,
    }),
    'GENERIC_EDITORIAL_EVIDENCE',
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSemanticReviewerRegistry } from './build-issue-223-corpus-batch.mjs';
import { preservesReviewedRecord } from '../validate/relevance-projection.mjs';
import {
  classifyIssue223QaOutcome,
  summarizeIssue223QaOutcomes,
  validateIssue223SemanticQaArtifact,
} from './issue-223-semantic-qa.mjs';
import { validateSemanticReviewInputBinding } from './validate-issue-223.mjs';

// Cross-file regressions over the COMMITTED B06 artifacts: the review input, the
// reviewer run record, the semantic decision source, the candidate review, and
// the canonical import must stay bound to each other. Each case tampers one of
// them in memory and expects rejection.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BATCHES = ['06', '07', '08', '09'];
const HISTORICAL_QA_BATCHES = ['01', '02', '03', '04'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (relativePath) => readFile(path.join(ROOT, relativePath));

function assertImportPreservesReviewedRecords(importRecords, sourceRecords, label) {
  for (let recordIndex = 0; recordIndex < sourceRecords.length; recordIndex += 1) {
    const imported = importRecords[recordIndex];
    const source = sourceRecords[recordIndex];
    assert.ok(
      preservesReviewedRecord(source, imported),
      `${label} preserves reviewed fields and original relations for ${source.id}`,
    );
  }
}

test('historical reviewed records allow only append-only relation enrichment', () => {
  const reviewed = {
    id: 'w001',
    lemma: 'fixture',
    senses: [{
      id: 'w001-s1',
      pos: 'noun',
      gloss: 'Reviewed gloss.',
      relations: [{ target: 'w002', target_sense: 'w002-s1', type: 'near', note: 'Reviewed relation.' }],
    }],
  };
  const enriched = structuredClone(reviewed);
  enriched.senses[0].relations[0].relevance = 5;
  enriched.senses[0].relations.push({
    target: 'w003',
    target_sense: 'w003-s1',
    type: 'association',
    note: 'Later relation enrichment.',
  });
  assert.equal(preservesReviewedRecord(reviewed, enriched), true);

  const changedGloss = structuredClone(enriched);
  changedGloss.senses[0].gloss = 'Changed gloss.';
  assert.equal(preservesReviewedRecord(reviewed, changedGloss), false);

  const changedOriginalRelation = structuredClone(enriched);
  changedOriginalRelation.senses[0].relations[0].target = 'w004';
  assert.equal(preservesReviewedRecord(reviewed, changedOriginalRelation), false);

  const removedOriginalRelation = structuredClone(reviewed);
  removedOriginalRelation.senses[0].relations = [];
  assert.equal(preservesReviewedRecord(reviewed, removedOriginalRelation), false);
});

async function load(number = '06') {
  const STEM = `issue-223-m9-e-corpus-batch-${number}`;
  const BATCH_ID = `${STEM}-20261001`;
  const [reviewBytes, inputBytes, runRecordBytes, sourceBytes, importBytes, registry] = await Promise.all([
    read(`data/batches/${STEM}-candidate-review.json`),
    read(`data/batches/${STEM}-semantic-review-input.json`),
    read(`data/batches/${STEM}-reviewer-run-record.json`),
    read(`data/batches/${STEM}-semantic-decisions.json`),
    read(`data/canonical/${STEM}.jsonl`),
    loadSemanticReviewerRegistry(),
  ]);
  const candidateReview = JSON.parse(reviewBytes.toString('utf8'));
  const semanticSource = JSON.parse(sourceBytes.toString('utf8'));
  const importRecords = importBytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return {
    candidateReview, semanticSource, importRecords, inputBytes, runRecordBytes, registry,
    args: () => ({
      semanticSource: structuredClone(semanticSource),
      inputBytes,
      runRecordBytes,
      batchId: BATCH_ID,
      admittedRows: candidateReview.decisions.filter((row) => row.editorial_judgment.disposition === 'admit'),
      candidateRows: candidateReview.decisions,
      candidateAuthor: candidateReview.reviewer,
      registry,
    }),
  };
}

async function loadHistoricalQa() {
  const artifact = JSON.parse(await read('data/batches/issue-223-b01-b04-semantic-qa.json').then((bytes) => bytes.toString('utf8')));
  const batches = await Promise.all(HISTORICAL_QA_BATCHES.map(async (number) => {
    const STEM = `issue-223-m9-e-corpus-batch-${number}`;
    const [candidateReviewBytes, semanticSourceBytes, canonicalImportBytes] = await Promise.all([
      read(`data/batches/${STEM}-candidate-review.json`),
      read(`data/batches/${STEM}-semantic-decisions.json`),
      read(`data/canonical/${STEM}.jsonl`),
    ]);
    return {
      batch_id: `issue-223-m9-e-corpus-batch-${number}-20261001`,
      candidateReview: JSON.parse(candidateReviewBytes.toString('utf8')),
      candidateReviewBytes,
      semanticSourceBytes,
      canonicalImportBytes,
      importRecords: canonicalImportBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse),
    };
  }));
  return { artifact, batches };
}

test('every committed reviewer-checked batch is bound to its artifacts', async () => {
  for (const number of BATCHES) {
    const { args, importRecords, semanticSource, candidateReview } = await load(number);
    validateSemanticReviewInputBinding(args());
    assertImportPreservesReviewedRecords(
      importRecords,
      semanticSource.candidate_records,
      `B${number} import`,
    );
    assert.equal(importRecords.length, candidateReview.decision_counts.admit);
  }
});

test('the committed B06 artifacts are bound to each other', async () => {
  const { args, importRecords, semanticSource, candidateReview } = await load('06');
  validateSemanticReviewInputBinding(args());
  // The canonical import is exactly the semantic source's candidate records.
  assert.deepEqual(importRecords, semanticSource.candidate_records);
  assert.equal(importRecords.length, candidateReview.decision_counts.admit);
  // Every canonical gloss is the reviewed gloss.
  assert.equal(candidateReview.decisions.length, 305);
});

test('tampering with any committed B06 artifact is rejected', async () => {
  const { args, inputBytes, runRecordBytes } = await load('06');
  const rejects = (name, change, pattern) => {
    const a = args();
    change(a);
    assert.throws(() => validateSemanticReviewInputBinding(a), pattern, name);
  };
  // A gloss changed in the canonical record after the reviewers assessed it.
  rejects('canonical gloss changed', (a) => { a.semanticSource.candidate_records[0].senses[0].gloss += ' (수정)'; }, /admitted gloss differs from the gloss the reviewer assessed/u);
  // Any edit to the review input breaks its digest in the semantic source.
  rejects('input edited', (a) => { a.inputBytes = Buffer.concat([inputBytes, Buffer.from(' ')]); }, /digest/u);
  // Any edit to the run record breaks the digest bound in the input.
  rejects('run record edited', (a) => { a.runRecordBytes = Buffer.concat([runRecordBytes, Buffer.from(' ')]); }, /digest bound in the input/u);
  rejects('run record missing', (a) => { a.runRecordBytes = null; }, /run record is missing/u);
  // A recomputed digest still cannot make a changed proposal match the input.
  rejects('run record rewritten consistently', (a) => {
    const record = JSON.parse(runRecordBytes.toString('utf8'));
    record.reviewed_proposals[0].lemma = '다른표제어';
    a.runRecordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const input = JSON.parse(inputBytes.toString('utf8'));
    input.run_record_sha256 = sha(a.runRecordBytes);
    a.inputBytes = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
    a.semanticSource.source_basis.semantic_review_input_sha256 = sha(a.inputBytes);
  }, /different lemma|digest of the reviewed proposals/u);
  // The outcome and the review row are two tracked records of one reviewer pass:
  // changing the contexts one cites (to still-valid indices) while the other and
  // the semantic source digest are consistently rebound must still be rejected.
  rejects('outcome and review row cite different contexts', (a) => {
    const input = JSON.parse(inputBytes.toString('utf8'));
    const outcome = input.candidate_outcomes.find((entry) => entry.verdict === 'pass' && entry.checked_hit_indices.length > 1);
    outcome.checked_hit_indices = [outcome.checked_hit_indices[1]];
    a.inputBytes = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
    a.semanticSource.source_basis.semantic_review_input_sha256 = sha(a.inputBytes);
  }, /disagree on checked_hit_indices/u);
  // The reviewer may not be the candidate-review author, and must be registered.
  rejects('self-review', (a) => { a.candidateAuthor = JSON.parse(inputBytes.toString('utf8')).reviewer; }, /self-review/u);
  rejects('unregistered reviewer', (a) => { a.registry = new Set(['someone-else']); }, /trusted reviewer registry/u);
  // A held candidate cannot be turned into an admission by editing the candidate review.
  rejects('hold turned into an admit', (a) => {
    const held = a.candidateRows.find((row) => row.editorial_judgment.disposition === 'hold');
    held.editorial_judgment = { ...held.editorial_judgment, disposition: 'admit' };
  }, /cannot be admitted|must be admitted|exactly the admitted/u);
});

test('the B01-B04 semantic QA audit preserves completed legacy results and covers only the remaining rows with AI self-check', async () => {
  const { artifact, batches } = await loadHistoricalQa();
  const coverage = validateIssue223SemanticQaArtifact(artifact, batches);
  assert.equal(coverage.canonical_record_count, 1206);
  assert.equal(coverage.preserved_legacy_review_event_count, 1219);
  assert.equal(coverage.latest_legacy_unique_record_count, 672);
  assert.equal(coverage.legacy_overlap_verdict_conflict_count, 32);
  assert.equal(coverage.legacy_overlap_axis_conflict_count, 42);
  assert.equal(coverage.ai_self_check_record_count, 534);
  assert.equal(coverage.records_with_an_outcome_count, 1206);
  assert.equal(coverage.records_with_unconflicted_pass_outcome_count, 1086);
  assert.equal(coverage.records_with_hold_outcome_count, 101);
  assert.equal(coverage.records_with_conflicted_outcome_count, 19);
  assert.equal(coverage.records_requiring_follow_up_count, 120);
  assert.equal(coverage.canonical_records_changed, 0);
  assert.deepEqual(Object.keys(coverage.batches), ['B01', 'B02', 'B03', 'B04']);
  assert.deepEqual(coverage.batches.B01, {
    canonical_records: 174,
    legacy_result_records: 174,
    legacy_pass: 156,
    legacy_hold: 18,
    ai_self_check_records: 0,
    ai_self_check_pass: 0,
    ai_self_check_hold: 0,
    legacy_earlier_hold_later_pass_conflict_count: 10,
    legacy_earlier_pass_later_hold_conflict_count: 3,
    records_with_unconflicted_pass_outcome_count: 146,
    records_with_hold_outcome_count: 18,
    records_with_conflicted_outcome_count: 10,
    records_requiring_follow_up_count: 28,
  });
  assert.deepEqual(coverage.batches.B03, {
    canonical_records: 439,
    legacy_result_records: 325,
    legacy_pass: 295,
    legacy_hold: 30,
    ai_self_check_records: 114,
    ai_self_check_pass: 105,
    ai_self_check_hold: 9,
    legacy_earlier_hold_later_pass_conflict_count: 4,
    legacy_earlier_pass_later_hold_conflict_count: 4,
    records_with_unconflicted_pass_outcome_count: 396,
    records_with_hold_outcome_count: 39,
    records_with_conflicted_outcome_count: 4,
    records_requiring_follow_up_count: 43,
  });
  assert.deepEqual(coverage.batches.B04, {
    canonical_records: 420,
    legacy_result_records: 0,
    legacy_pass: 0,
    legacy_hold: 0,
    ai_self_check_records: 420,
    ai_self_check_pass: 398,
    ai_self_check_hold: 22,
    legacy_earlier_hold_later_pass_conflict_count: 0,
    legacy_earlier_pass_later_hold_conflict_count: 0,
    records_with_unconflicted_pass_outcome_count: 398,
    records_with_hold_outcome_count: 22,
    records_with_conflicted_outcome_count: 0,
    records_requiring_follow_up_count: 22,
  });
});

test('a prior HOLD contradicted by a later PASS stays conflicted while a later HOLD stays held', () => {
  assert.equal(classifyIssue223QaOutcome({ earlierVerdict: 'hold', laterVerdict: 'pass' }), 'conflicted');
  assert.equal(classifyIssue223QaOutcome({ earlierVerdict: 'pass', laterVerdict: 'hold' }), 'hold');

  const coverage = summarizeIssue223QaOutcomes([
    { batch_id: 'issue-223-m9-e-corpus-batch-01-20261001', canonical_id: 'w1', earlierVerdict: 'hold', laterVerdict: 'pass' },
    { batch_id: 'issue-223-m9-e-corpus-batch-01-20261001', canonical_id: 'w2', earlierVerdict: 'pass', laterVerdict: 'hold' },
    { batch_id: 'issue-223-m9-e-corpus-batch-02-20261001', canonical_id: 'w3', laterVerdict: 'pass' },
    { batch_id: 'issue-223-m9-e-corpus-batch-02-20261001', canonical_id: 'w4', aiSelfCheckVerdict: 'pass' },
    { batch_id: 'issue-223-m9-e-corpus-batch-02-20261001', canonical_id: 'w5', aiSelfCheckVerdict: 'hold' },
  ]);
  assert.equal(coverage.records_with_an_outcome_count, 5);
  assert.equal(coverage.records_with_unconflicted_pass_outcome_count, 2);
  assert.equal(coverage.records_with_hold_outcome_count, 2);
  assert.equal(coverage.records_with_conflicted_outcome_count, 1);
  assert.equal(coverage.records_requiring_follow_up_count, 3);
  assert.deepEqual(coverage.batches.B01, {
    legacy_earlier_hold_later_pass_conflict_count: 1,
    legacy_earlier_pass_later_hold_conflict_count: 1,
    records_with_unconflicted_pass_outcome_count: 0,
    records_with_hold_outcome_count: 1,
    records_with_conflicted_outcome_count: 1,
    records_requiring_follow_up_count: 2,
  });
  assert.deepEqual(coverage.batches.B02, {
    legacy_earlier_hold_later_pass_conflict_count: 0,
    legacy_earlier_pass_later_hold_conflict_count: 0,
    records_with_unconflicted_pass_outcome_count: 2,
    records_with_hold_outcome_count: 1,
    records_with_conflicted_outcome_count: 0,
    records_requiring_follow_up_count: 1,
  });
});

test('the B01-B04 semantic QA validator rejects detached, missing, overstated, or mislabeled evidence', async () => {
  const { artifact, batches } = await loadHistoricalQa();
  const rejects = (name, change, pattern) => {
    const changed = structuredClone(artifact);
    change(changed);
    assert.throws(() => validateIssue223SemanticQaArtifact(changed, batches), pattern, name);
  };

  rejects('source digest changed', (value) => { value.source_batches[2].canonical_import_sha256 = '0'.repeat(64); }, /source digests and counts/u);
  rejects('legacy result removed', (value) => { value.legacy_review_results.pop(); }, /result count matches preserved events|sequential result event/u);
  rejects('legacy result detached from canonical ID', (value) => { value.legacy_review_results[0].canonical_id = 'w0000'; }, /binds to a B01-B03 canonical record/u);
  rejects('AI self-check ID changed', (value) => { value.ai_self_checks[0].canonical_id = 'w0000'; }, /was not already completed|binds to a source batch/u);
  rejects('AI self-check ordinal changed', (value) => { value.ai_self_checks[0].canonical_import_ordinal += 1; }, /canonical import ordinal/u);
  rejects('AI self-check context out of range', (value) => { value.ai_self_checks[0].checked_context_indices = [999]; }, /outside its candidate's bounded evidence/u);
  rejects('self-check relabeled as independent', (value) => { value.ai_self_checks[0].review_mode = 'independent-review'; }, /review mode/u);
  rejects('legacy identity falsely authenticated', (value) => { value.legacy_runs[0].reviewer_identity_authenticated = true; }, /must not claim authenticated reviewer identity/u);
  rejects('batch coverage summary altered', (value) => { value.coverage.batches.B04.ai_self_check_hold = 0; }, /coverage is derived from bound results/u);
  rejects('conflicted outcome aggregate overstated', (value) => { value.coverage.records_with_conflicted_outcome_count = 0; }, /coverage is derived from bound results/u);
  rejects('per-batch unconflicted pass total overstated', (value) => { value.coverage.batches.B01.records_with_unconflicted_pass_outcome_count += 1; }, /coverage is derived from bound results/u);
});

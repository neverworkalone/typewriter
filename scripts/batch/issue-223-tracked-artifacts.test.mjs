import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSemanticReviewerRegistry } from './build-issue-223-corpus-batch.mjs';
import { validateSemanticReviewInputBinding } from './validate-issue-223.mjs';

// Cross-file regressions over the COMMITTED B06 artifacts: the review input, the
// reviewer run record, the semantic decision source, the candidate review, and
// the canonical import must stay bound to each other. Each case tampers one of
// them in memory and expects rejection.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BATCHES = ['06', '07', '08', '09'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (relativePath) => readFile(path.join(ROOT, relativePath));

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

test('every committed reviewer-checked batch is bound to its artifacts', async () => {
  for (const number of BATCHES) {
    const { args, importRecords, semanticSource, candidateReview } = await load(number);
    validateSemanticReviewInputBinding(args());
    assert.deepEqual(importRecords, semanticSource.candidate_records, `B${number} import matches its source`);
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

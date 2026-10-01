import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReviewOnlyCanonicalImportBoundary } from './validate-issue-223.mjs';

function reviewOnlyBatch() {
  return {
    batch_id: 'issue-223-m9-e-corpus-batch-05-20261001',
    canonical_import_status: 'owner-deferred-review-only',
    canonical_import_count: 0,
    canonical_import_deferred_count: 1,
    canonical_import_deferred_reason: 'Owner requested review decisions only for this checkpoint.',
    decision_counts: { admit: 1, hold: 1, reject: 0 },
    decisions: [
      {
        morphology_proposal: { lemma: '검토어' },
        editorial_judgment: { disposition: 'admit', candidate_record_id: 'w9064' },
      },
      {
        morphology_proposal: { lemma: '보류어' },
        editorial_judgment: { disposition: 'hold', candidate_record_id: null },
      },
    ],
  };
}

test('Issue #223 review-only candidates remain outside canonical imports', () => {
  const deferred = validateReviewOnlyCanonicalImportBoundary({
    candidateReview: reviewOnlyBatch(),
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [{ record: { id: 'w9063', lemma: '기존어' } }],
  });

  assert.equal(deferred, 1);
});

test('Issue #223 review-only boundary rejects generated sidecars and existing canonical rows', () => {
  const candidateReview = reviewOnlyBatch();
  const base = {
    candidateReview,
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [],
  };

  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({ ...base, semanticSourceExists: true }));
  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({ ...base, canonicalImportExists: true }));
  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({
    ...base,
    currentCanonicalRecords: [{ id: 'w9064', lemma: '검토어' }],
  }));
});

test('Issue #223 review-only boundary binds its deferred count to the admit decisions', () => {
  const candidateReview = reviewOnlyBatch();
  candidateReview.canonical_import_deferred_count = 2;

  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({
    candidateReview,
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [],
  }));
});

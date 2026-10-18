import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCandidateBatch } from './candidate-contract.mjs';

function fixture(candidate = '다른 표현') {
  const canonicalRows = Array.from({ length: 500 }, (_, index) => ({
    id: `w${index + 1}`,
    lemma: index === 0 ? '가짜 미끼' : `표제어 ${index + 1}`,
    senses: [{ id: `w${index + 1}-s1` }],
  }));
  const candidateRows = canonicalRows.map((record, index) => ({
    record_id: record.id,
    senses: [{
      sense_id: record.senses[0].id,
      candidates: index === 0 ? [candidate] : [],
    }],
  }));
  return { canonicalRows, candidateRows };
}

test('Candidate v1 rejects a candidate identical to its source lemma and accepts distinct candidates', () => {
  const invalid = fixture('가짜 미끼');
  assert.throws(
    () => validateCandidateBatch(invalid.canonicalRows, invalid.candidateRows, { batch: '01' }),
    /candidate repeats source lemma "가짜 미끼"/,
  );

  const valid = fixture('가짜 미끼를 물다');
  assert.deepEqual(
    validateCandidateBatch(valid.canonicalRows, valid.candidateRows, { batch: '01' }),
    { recordCount: 500, senseCount: 500, candidateCount: 1, emptySenseCount: 499 },
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSearchResponse,
  normalizeSearchInput,
  SEARCH_RESULT_STATUSES,
  SEARCH_UNSUPPORTED_REASONS,
} from '../src/runtime/search-query.js';

test('search input normalization is deterministic and keeps raw input', () => {
  assert.deepEqual(normalizeSearchInput('담담하다'), {
    rawQuery: '담담하다',
    normalizedQuery: '담담하다',
    normalizationRules: [],
    unsupportedReason: null,
  });

  assert.deepEqual(normalizeSearchInput('담담하다'), {
    rawQuery: '담담하다',
    normalizedQuery: '담담하다',
    normalizationRules: ['unicode-nfc'],
    unsupportedReason: null,
  });

  assert.deepEqual(normalizeSearchInput('  담담하다  '), {
    rawQuery: '  담담하다  ',
    normalizedQuery: '담담하다',
    normalizationRules: ['trim-surrounding-whitespace'],
    unsupportedReason: null,
  });
});

test('normalization does not rewrite internal expression boundaries', () => {
  const input = normalizeSearchInput('마음이  놓이다');

  assert.equal(input.normalizedQuery, '마음이  놓이다');
  assert.deepEqual(input.normalizationRules, []);
  assert.equal(input.unsupportedReason, SEARCH_UNSUPPORTED_REASONS.internalWhitespace);

  const empty = normalizeSearchInput('   ');
  assert.equal(empty.unsupportedReason, SEARCH_UNSUPPORTED_REASONS.emptyAfterNormalization);
  assert.equal(
    createSearchResponse(empty).status,
    SEARCH_RESULT_STATUSES.unsupported,
  );
});

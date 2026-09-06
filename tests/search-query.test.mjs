import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSearchMatch,
  createSearchResponse,
  normalizeSearchInput,
  rankSearchMatches,
  SEARCH_MATCH_FIELDS,
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

test('candidate ranking prefers match tiers, deduplicates records, and keeps source order ties', () => {
  const exactSearchForm = createSearchMatch(
    { id: 'w200', lemma: '형식 후보' },
    { field: SEARCH_MATCH_FIELDS.searchForm, value: '공통 입력' },
  );
  const exactLemma = createSearchMatch(
    { id: 'w100', lemma: '표제어 후보' },
    { field: SEARCH_MATCH_FIELDS.lemma, value: '공통 입력' },
  );
  const normalizedForm = createSearchMatch(
    { id: 'w001', lemma: '정규화 후보' },
    {
      field: SEARCH_MATCH_FIELDS.searchForm,
      value: '공통 입력',
      normalizationRules: ['trim-surrounding-whitespace'],
    },
  );
  const normalizedLemmaDuplicate = createSearchMatch(
    { id: 'w100', lemma: '표제어 후보' },
    {
      field: SEARCH_MATCH_FIELDS.lemma,
      value: '공통 입력',
      normalizationRules: ['trim-surrounding-whitespace'],
    },
  );
  const normalizedTieLater = createSearchMatch(
    { id: 'w000', lemma: '뒤의 정규화 후보' },
    {
      field: SEARCH_MATCH_FIELDS.lemma,
      value: '공통 입력',
      normalizationRules: ['unicode-nfc'],
    },
  );

  const ranked = rankSearchMatches([
    normalizedForm,
    exactSearchForm,
    normalizedLemmaDuplicate,
    exactLemma,
    normalizedTieLater,
  ]);

  assert.deepEqual(ranked.map(({ id }) => id), ['w100', 'w200', 'w001', 'w000']);
  assert.deepEqual(ranked.map(({ match }) => match.kind), [
    'exact-lemma',
    'exact-search-form',
    'normalized',
    'normalized',
  ]);
  assert.equal(
    createSearchResponse(normalizeSearchInput('공통 입력'), ranked).matches[0].id,
    'w100',
  );
});

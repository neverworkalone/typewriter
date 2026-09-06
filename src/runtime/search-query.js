export const SEARCH_RESULT_STATUSES = Object.freeze({
  ready: 'ready',
  noMatch: 'no-match',
  unsupported: 'unsupported',
});

export const SEARCH_MATCH_KINDS = Object.freeze({
  exact: 'exact',
  exactLemma: 'exact-lemma',
  exactSearchForm: 'exact-search-form',
  normalized: 'normalized',
});

export const SEARCH_MATCH_FIELDS = Object.freeze({
  lemma: 'lemma',
  searchForm: 'search-form',
});

export const SEARCH_NORMALIZATION_RULES = Object.freeze({
  unicodeNfc: 'unicode-nfc',
  trimSurroundingWhitespace: 'trim-surrounding-whitespace',
});

export const SEARCH_UNSUPPORTED_REASONS = Object.freeze({
  emptyAfterNormalization: 'empty-after-normalization',
  internalWhitespace: 'internal-whitespace-not-normalized',
  referenceOnly: 'reference-only-not-searchable',
});

function requireRawQuery(rawQuery) {
  if (typeof rawQuery !== 'string') {
    throw new TypeError('rawQuery must be a string.');
  }

  return rawQuery;
}

function requireResponseString(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string.`);
  }

  return value;
}

function matchKind(field, normalizationRules) {
  if (normalizationRules.length > 0) {
    return SEARCH_MATCH_KINDS.normalized;
  }

  return field === SEARCH_MATCH_FIELDS.lemma
    ? SEARCH_MATCH_KINDS.exactLemma
    : SEARCH_MATCH_KINDS.exactSearchForm;
}

export function normalizeSearchInput(rawQuery) {
  const raw = requireRawQuery(rawQuery);
  const unicodeNormalized = raw.normalize('NFC');
  const normalizedQuery = unicodeNormalized.trim();
  const normalizationRules = [];

  if (unicodeNormalized !== raw) {
    normalizationRules.push(SEARCH_NORMALIZATION_RULES.unicodeNfc);
  }
  if (normalizedQuery !== unicodeNormalized) {
    normalizationRules.push(SEARCH_NORMALIZATION_RULES.trimSurroundingWhitespace);
  }

  let unsupportedReason = null;
  if (normalizedQuery.length === 0) {
    unsupportedReason = SEARCH_UNSUPPORTED_REASONS.emptyAfterNormalization;
  } else if (/\S\s{2,}\S/u.test(normalizedQuery)) {
    // Keep expression boundaries explicit. Only surrounding whitespace is
    // normalized; repeated internal whitespace is never collapsed.
    unsupportedReason = SEARCH_UNSUPPORTED_REASONS.internalWhitespace;
  }

  return {
    rawQuery: raw,
    normalizedQuery,
    normalizationRules,
    unsupportedReason,
  };
}

export function createSearchMatch(summary, {
  field,
  value,
  normalizationRules = [],
} = {}) {
  const sourceField = field === SEARCH_MATCH_FIELDS.lemma
    ? SEARCH_MATCH_FIELDS.lemma
    : SEARCH_MATCH_FIELDS.searchForm;
  const rules = [...normalizationRules];
  const {
    match_field: ignoredField,
    match_value: ignoredValue,
    match_priority: ignoredPriority,
    ...record
  } = summary;

  return {
    ...record,
    match: {
      kind: matchKind(sourceField, rules),
      field: sourceField,
      value: value ?? ignoredValue ?? null,
      normalizationRules: rules,
    },
  };
}

export function createSearchResponse(input, matches = [], { reason = null } = {}) {
  const normalizedMatches = [...matches];
  const status = (
    input.unsupportedReason
    || reason === SEARCH_UNSUPPORTED_REASONS.referenceOnly
  )
    ? SEARCH_RESULT_STATUSES.unsupported
    : normalizedMatches.length > 0
      ? SEARCH_RESULT_STATUSES.ready
      : SEARCH_RESULT_STATUSES.noMatch;

  return {
    rawQuery: input.rawQuery,
    normalizedQuery: input.normalizedQuery,
    normalizationRules: [...input.normalizationRules],
    status,
    reason: input.unsupportedReason || reason || (
      status === SEARCH_RESULT_STATUSES.noMatch ? 'no-exact-match' : null
    ),
    matches: normalizedMatches,
  };
}

export function createLegacySearchResponse(rawQuery, summaries) {
  const input = normalizeSearchInput(rawQuery);
  const matches = Array.isArray(summaries)
    ? summaries.map((summary, position) => {
      const legacyMatch = createSearchMatch(summary, {
        field: SEARCH_MATCH_FIELDS.lemma,
        value: summary.lemma,
        normalizationRules: input.normalizationRules,
      });

      return {
        ...legacyMatch,
        match: {
          ...legacyMatch.match,
          kind: input.normalizationRules.length > 0
            ? SEARCH_MATCH_KINDS.normalized
            : SEARCH_MATCH_KINDS.exact,
          position,
        },
      };
    })
    : [];

  return createSearchResponse(input, matches);
}

export function normalizeSearchResponse(response, rawQuery) {
  if (Array.isArray(response)) {
    return createLegacySearchResponse(rawQuery, response);
  }

  if (!response || typeof response !== 'object' || !Array.isArray(response.matches)) {
    throw new TypeError('dictionary runtime search result must be a search response.');
  }

  const resolvedRawQuery = requireRawQuery(response.rawQuery ?? rawQuery);
  const input = normalizeSearchInput(resolvedRawQuery);
  const normalizedQuery = requireResponseString(
    response.normalizedQuery ?? input.normalizedQuery,
    'normalizedQuery',
  );
  const normalizationRules = Array.isArray(response.normalizationRules)
    ? [...response.normalizationRules]
    : [...input.normalizationRules];
  const matches = [...response.matches];
  const status = response.status ?? (
    input.unsupportedReason
      ? SEARCH_RESULT_STATUSES.unsupported
      : matches.length > 0
        ? SEARCH_RESULT_STATUSES.ready
        : SEARCH_RESULT_STATUSES.noMatch
  );

  if (!Object.values(SEARCH_RESULT_STATUSES).includes(status)) {
    throw new TypeError(`Unknown search response status: ${String(status)}.`);
  }
  if (status === SEARCH_RESULT_STATUSES.ready && matches.length === 0) {
    throw new TypeError('Ready search responses must contain at least one match.');
  }
  if (
    (status === SEARCH_RESULT_STATUSES.noMatch || status === SEARCH_RESULT_STATUSES.unsupported)
    && matches.length > 0
  ) {
    throw new TypeError(`${status} search responses must not contain matches.`);
  }

  const reason = response.reason ?? input.unsupportedReason ?? (
    status === SEARCH_RESULT_STATUSES.noMatch ? 'no-exact-match' : null
  );

  return {
    ...response,
    rawQuery: resolvedRawQuery,
    normalizedQuery,
    normalizationRules,
    status,
    reason,
    matches,
  };
}

export const EXPECTED_PROOF = Object.freeze({
  lemma: Object.freeze({
    id: 'w026',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w026',
    lemma: '담담하다',
  }),
  search_form: Object.freeze({
    id: 'w026',
    lemma: '담담하다',
  }),
  relation: Object.freeze({
    type: 'direct',
    target: 'r008',
    target_sense: 'r008-s1',
    target_lemma: '덤덤하다',
  }),
});

function assertFields(actual, expected, label) {
  if (!actual || typeof actual !== 'object') {
    throw new Error(`${label} must be an object`);
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      throw new Error(
        `${label}.${key} expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual[key])}`,
      );
    }
  }
}

export function assertProofPayload(payload) {
  if (!payload || payload.ok !== true) {
    throw new Error('proof payload must be successful');
  }
  if (payload.query_only !== 1) {
    throw new Error(`query_only expected 1, got ${JSON.stringify(payload.query_only)}`);
  }

  if (!Array.isArray(payload.lemma) || payload.lemma.length !== 1) {
    throw new Error('lemma lookup must return exactly one representative record');
  }
  assertFields(payload.lemma[0], EXPECTED_PROOF.lemma, 'lemma');

  if (!Array.isArray(payload.search_form) || payload.search_form.length !== 1) {
    throw new Error('search form lookup must return exactly one representative record');
  }
  assertFields(payload.search_form[0], EXPECTED_PROOF.search_form, 'search_form');

  if (!Array.isArray(payload.relation) || payload.relation.length === 0) {
    throw new Error('relation lookup must return at least one representative relation');
  }
  if (!payload.relation.some((relation) => {
    try {
      assertFields(relation, EXPECTED_PROOF.relation, 'relation');
      return true;
    } catch {
      return false;
    }
  })) {
    throw new Error('relation lookup did not return the expected direct relation');
  }

  if (payload.write_blocked !== true || payload.persisted_write_count !== 0) {
    throw new Error(
      `read-only assertion failed: ${JSON.stringify({
        write_blocked: payload.write_blocked,
        persisted_write_count: payload.persisted_write_count,
      })}`,
    );
  }

  return payload;
}

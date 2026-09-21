const RECONSTRUCTIBLE_DECISION_FIELDS = Object.freeze([
  'source_sha256',
  'sense_id',
  'sense_gloss_sha256',
  'pos',
  'record_type',
  'observed_domain_axes',
  'domain_evidence',
  'connector_observations',
  'semantic_rationale',
  'boundary_rationale',
  'relation_decision',
  'relation_count',
  'relation_ids',
  'no_relation_rationale',
]);

/**
 * Normalize an authored batch row for its immutable row binding. The full
 * row remains the durable authored source; this digest intentionally ignores
 * projections that are validated from the candidate/canonical record.
 */
export function compactAuthoredSemanticDecisionRow(row) {
  const normalized = structuredClone(row);
  for (const field of RECONSTRUCTIBLE_DECISION_FIELDS) delete normalized[field];
  if (Array.isArray(normalized.sense_reviews)) {
    normalized.sense_reviews = normalized.sense_reviews.map((senseReview) => {
      const compact = structuredClone(senseReview);
      for (const field of RECONSTRUCTIBLE_DECISION_FIELDS) {
        if (field !== 'sense_id'
          && field !== 'semantic_rationale'
          && field !== 'boundary_rationale'
          && field !== 'relation_decision'
          && field !== 'relation_count'
          && field !== 'relation_ids'
          && field !== 'no_relation_rationale') {
          delete compact[field];
        }
      }
      if (compact.review_basis) {
        compact.review_basis = Object.fromEntries(
          Object.entries(compact.review_basis)
            .filter(([key]) => key === 'topic_analysis' || key === 'topic_analyses'),
        );
        if (Object.keys(compact.review_basis).length === 0) delete compact.review_basis;
      }
      return compact;
    });
  }
  return normalized;
}

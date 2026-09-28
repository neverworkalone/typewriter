const AMBIGUOUS_HOLD_STATUS = 'held_surface_has_multiple_analyzer_interpretations';
const SINGLE_ANALYSIS_STATUS = 'single_observed_analysis_unverified';

function fail(message) {
  throw new Error(`Issue #204 review evidence is invalid: ${message}`);
}

export function validateIssue204MorphologyEvidence({
  proposal,
  disposition,
  rationale,
  label = 'candidate',
} = {}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    fail(`${label} morphology proposal must be an object`);
  }
  if (!Number.isSafeInteger(proposal.analyzer_pos_interpretation_count)
    || proposal.analyzer_pos_interpretation_count < 0
    || !Number.isSafeInteger(proposal.ambiguous_observed_surface_count)
    || proposal.ambiguous_observed_surface_count < 0) {
    fail(`${label} must keep POS and observed-surface counts as separate non-negative integers`);
  }

  if (proposal.ambiguity_status === AMBIGUOUS_HOLD_STATUS) {
    if (disposition !== 'hold' || proposal.ambiguous_observed_surface_count === 0) {
      fail(`${label} with ambiguous observed surfaces must be held and report a positive surface count`);
    }
    if (typeof rationale !== 'string'
      || !rationale.includes(`analyzer_pos_interpretation_count=${proposal.analyzer_pos_interpretation_count}`)
      || !rationale.includes(`ambiguous_observed_surface_count=${proposal.ambiguous_observed_surface_count}`)
      || /Kiwi returned\s+\d+ analyzer interpretations for sampled surface forms/iu.test(rationale)) {
      fail(`${label} hold rationale must identify the POS interpretation count and ambiguous observed-surface count separately`);
    }
    return true;
  }

  if (proposal.ambiguity_status !== SINGLE_ANALYSIS_STATUS
    || disposition === 'hold'
    || proposal.ambiguous_observed_surface_count !== 0) {
    fail(`${label} non-hold disposition must match its single-analysis evidence`);
  }
  return true;
}

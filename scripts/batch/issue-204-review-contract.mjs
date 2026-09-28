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

export function validateIssue204HoldSeedNotes({ ledgerDecisions, seedTargets } = {}) {
  if (!Array.isArray(ledgerDecisions) || !Array.isArray(seedTargets)) {
    fail('the pilot ledger and inventory seed must both provide decision rows');
  }
  const holdDecisions = ledgerDecisions.filter(
    (row) => row?.editorial_judgment?.disposition === 'hold',
  );
  const holdSeedRows = seedTargets.filter(
    (row) => typeof row?.decision_note === 'string'
      && row.decision_note.startsWith('Issue #204 hold:'),
  );
  if (holdDecisions.length !== holdSeedRows.length) {
    fail(`the seed has ${holdSeedRows.length} Issue #204 hold notes for ${holdDecisions.length} held pilot candidates`);
  }

  const seedByInventoryId = new Map();
  for (const seedRow of holdSeedRows) {
    if (seedByInventoryId.has(seedRow.inventory_id)) {
      fail(`the seed duplicates Issue #204 hold note ${seedRow.inventory_id}`);
    }
    seedByInventoryId.set(seedRow.inventory_id, seedRow);
  }
  for (const decision of holdDecisions) {
    const seedRow = seedByInventoryId.get(decision.inventory_id);
    const expectedNote = `Issue #204 hold: ${decision.editorial_judgment.rationale}`;
    if (!seedRow
      || seedRow.status !== 'held'
      || seedRow.lemma !== decision.morphology_proposal?.lemma
      || seedRow.decision_note !== expectedNote) {
      fail(`${decision.inventory_id} seed hold note must match its source-bound morphology rationale`);
    }
  }
  return true;
}

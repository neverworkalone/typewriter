import {
  assertHandoffMatchesFreshAnalysis,
  assertReviewsBoundToHandoff,
  batchCandidatesFor,
  verifyProductionHandoff,
} from '../intake/production-handoff.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

// Write-free core of the batch builder's intake check (issue #251). It only reads
// and compares; the production builder calls it with the pinned local Kiwi
// analyzer fixed (see `assertBatchIntakeHandoff`), tests inject a synthetic one.
// Revalidates the hand-off against the current inventory/evidence, re-runs the
// analyzer, and requires each admitted candidate's review to be bound.
export async function checkBatchIntakeHandoff({ handoffBytes, inventory, evidence, batchId, semanticInput, rows, analyzer }) {
  const handoff = JSON.parse(handoffBytes.toString('utf8'));
  const adapterId = handoff.source_adapter;
  const rawCandidates = batchCandidatesFor(adapterId, inventory, evidence);
  verifyProductionHandoff(handoff, { rawCandidates, batchId, adapterId });
  await assertHandoffMatchesFreshAnalysis(handoff, { rawCandidates, batchId, analyzer, adapterId });
  const admitted = rows.filter(({ editorial_judgment: judgment }) => judgment.disposition === 'admit');
  return assertReviewsBoundToHandoff({
    handoff,
    handoffBytes,
    integration: semanticInput.intake_handoff,
    admittedRows: admitted.map((row) => ({
      lemma: row.morphology_proposal.lemma,
      proposedPos: inventory.candidates[row.candidate_ordinal - 1].proposed_pos,
      finalPos: row.morphology_proposal.pos,
      glossSha256: sha256Json(row.editorial_judgment.writer_gloss),
    })),
    hitCountByLemma: new Map(rows.map((row) => [row.morphology_proposal.lemma, row.bounded_provenance.representative_hits.length])),
  });
}

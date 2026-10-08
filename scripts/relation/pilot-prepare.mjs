import { writeFile } from 'node:fs/promises';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import {
  COHORT_RULE, provisionalId, readReviewedBatchSenses, retrieveForCohort, selectCohortSenses,
} from './pilot.mjs';

// Prints the pre-registered cohort and its bounded candidate shortlist for relation review.
// Usage: node scripts/relation/pilot-prepare.mjs <out.json>
const out = process.argv[2];
const canonical = await loadCanonicalContext();
const indexStart = performance.now();
const index = buildRelationIndex(canonical);
const indexMilliseconds = performance.now() - indexStart;
const byId = new Map();
const cohort = [];
const batches = [];
for (const batchId of COHORT_RULE.batches) {
  // Retrieval runs over every reviewed sense of the batch (as in production, so same-batch targets exist);
  // only the pre-registered cohort is then reviewed.
  const all = await readReviewedBatchSenses(batchId);
  for (const sense of all) byId.set(provisionalId(sense), sense);
  const { artifact, milliseconds } = await retrieveForCohort(batchId, all, { canonical, index });
  batches.push({ batch_id: batchId, sources: all.length, retrieval_ms: Number(milliseconds.toFixed(1)) });
  for (const sense of selectCohortSenses(all)) {
    cohort.push({ sense, found: artifact.sources.find((s) => s.source.provisional_id === provisionalId(sense)) });
  }
}
const senses = cohort.map(({ sense, found }) => ({
  sense_ref: sense.sense_id, kind: sense.target_kind, lemma: sense.lemma, pos: sense.pos, gloss: sense.gloss,
  candidate_count: found?.candidates.length ?? null,
  top: (found?.candidates ?? []).slice(0, COHORT_RULE.inspect_limit).map((c) => {
    const id = c.target.sense_id ?? c.target.provisional_id;
    const t = c.target.sense_id ? index.bySenseId.get(c.target.sense_id) : null;
    const p = c.target.provisional_id ? byId.get(id) : null;
    return { id: p ? p.sense_id : id, lemma: t?.lemma ?? p?.lemma, gloss: t?.gloss ?? p?.gloss, pos: c.target.pos, signals: c.signals };
  }),
}));
await writeFile(out, JSON.stringify({ index_ms: Number(indexMilliseconds.toFixed(1)), batches, senses }, null, 1));
console.log(`cohort ${senses.length}`, JSON.stringify(batches), `index_ms ${indexMilliseconds.toFixed(0)}`);

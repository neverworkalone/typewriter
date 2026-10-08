import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import { buildRelationIndex } from './candidate-retrieval.mjs';
import {
  COHORT_RULE, measurePilot, provisionalId, readReviewedBatchSenses, senseRefOfTarget, retrieveForCohort, selectCohortSenses,
  simulateStage3, validatePilotRecord,
} from './pilot.mjs';

// Validates docs/relation-pilot-issue-400.json against live retrieval + the real Stage 3 planner and prints/writes
// the measured report. Usage: node scripts/relation/pilot-run.mjs [--write <metrics.json>]
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const pilot = JSON.parse(await readFile(path.join(REPO, 'docs/relation-pilot-issue-400.json'), 'utf8'));
const canonical = await loadCanonicalContext();
if (pilot.canonical_revision !== canonical.canonicalRevision) {
  console.error(`pilot record is bound to canonical revision ${pilot.canonical_revision} (master ${pilot.master_commit}); check that revision out to reproduce it.`);
  process.exit(3);
}
const t0 = performance.now();
const index = buildRelationIndex(canonical);
const indexMs = performance.now() - t0;

const poolBySource = new Map();
const batchSenseIds = new Set();
const cohortRefs = [];
const perBatch = [];
for (const batchId of COHORT_RULE.batches) {
  const all = await readReviewedBatchSenses(batchId);
  for (const sense of all) batchSenseIds.add(sense.sense_id);
  const { artifact, milliseconds } = await retrieveForCohort(batchId, all, { canonical, index });
  perBatch.push({ batch_id: batchId, sources: all.length, retrieval_ms: Number(milliseconds.toFixed(1)) });
  const byId = new Map(artifact.sources.map((s) => [s.source.provisional_id, s]));
  for (const sense of selectCohortSenses(all)) {
    cohortRefs.push(sense.sense_id);
    const found = byId.get(provisionalId(sense));
    const top = found.candidates.slice(0, COHORT_RULE.inspect_limit);
    const ranked = top.map((c) => ({ ref: senseRefOfTarget(c.target), record: c.target.record_id ?? null }));
    poolBySource.set(sense.sense_id, { total: found.candidates.length, shortlist: new Set(ranked.map((r) => r.ref)), ranked });
  }
}
const errors = validatePilotRecord(pilot, { index, cohortRefs, batchSenseIds, poolBySource });
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const stage3 = await simulateStage3({ pilot, batchIds: COHORT_RULE.batches, canonical, index });
const metrics = measurePilot(pilot, {
  canonicalRecords: canonical.records,
  stage3,
  runtime: { relation_index_build_ms: Number(indexMs.toFixed(1)), canonical_senses: index.senses.length, retrieval_by_batch: perBatch },
});
// Retrieval diagnostics: where the accepted relations sat in the bounded shortlist, and how many shortlist slots
// were taken by additional senses of a record already shown (the same-lemma sibling slots a diversity rule could free).
const acceptedByRank = Array.from({ length: COHORT_RULE.inspect_limit }, () => 0);
const inspectedByRank = Array.from({ length: COHORT_RULE.inspect_limit }, () => 0);
let siblingSlots = 0;
for (const entry of pilot.senses) {
  const { ranked } = poolBySource.get(entry.sense_ref);
  const accepted = new Set((entry.relations ?? []).map((r) => r.target_sense));
  const seenRecords = new Set();
  ranked.forEach((item, position) => {
    inspectedByRank[position] += 1;
    if (accepted.has(item.ref)) acceptedByRank[position] += 1;
    if (item.record && seenRecords.has(item.record)) siblingSlots += 1;
    if (item.record) seenRecords.add(item.record);
  });
}
metrics.retrieval_diagnostics = {
  accepted_by_shortlist_rank: acceptedByRank,
  inspected_by_shortlist_rank: inspectedByRank,
  accepted_in_ranks_1_5: acceptedByRank.slice(0, 5).reduce((a, b) => a + b, 0),
  accepted_in_ranks_6_10: acceptedByRank.slice(5).reduce((a, b) => a + b, 0),
  sibling_sense_slots: siblingSlots,
};
const text = `${JSON.stringify(metrics, null, 2)}\n`;
const writeAt = process.argv.indexOf('--write');
if (writeAt > 0) await writeFile(process.argv[writeAt + 1], text);
console.log(text);

import path from 'node:path';
import { createCanonicalContext } from '../validate/canonical-context.mjs';
import { loadSurfaceFormReviewManifestSync } from '../inflection/surface-form-projection.mjs';

const recordOf = (info) => info.record ?? info;

/** Scope already-reviewed evidence to an older record set; never author a collision judgment. */
export function projectHistoricalSurfaceFormReview(manifest, records) {
  const recordIds = new Set(records.map((info) => recordOf(info).id));
  const senseIds = new Set(records.flatMap((info) => recordOf(info).senses.map((sense) => sense.id)));
  const hasSense = (candidate) => recordIds.has(candidate.record_id) && senseIds.has(candidate.sense_id);
  const result = structuredClone(manifest);
  result.dispositions = result.dispositions.filter(hasSense);
  result.reviewed_collisions.exact_generated = result.reviewed_collisions.exact_generated.map((entry) => ({
    ...entry,
    exact_candidates: entry.exact_candidates.filter((candidate) => recordIds.has(candidate.record_id)),
    generated_candidates: entry.generated_candidates.filter(hasSense),
  })).filter((entry) => entry.exact_candidates.length && entry.generated_candidates.length);
  result.reviewed_collisions.ambiguous_generated = result.reviewed_collisions.ambiguous_generated.map((entry) => ({
    ...entry, candidates: entry.candidates.filter(hasSense),
  })).filter((entry) => entry.candidates.length > 1);
  return result;
}

export function historicalAdmissionContext(records, semanticAudit) {
  const context = createCanonicalContext({ records }, {
    canonicalDirectory: path.resolve('data/batches'), source: 'retained-historical-canonical',
  });
  context.semanticAudit = semanticAudit;
  context.derived.surfaceFormReviewManifest = projectHistoricalSurfaceFormReview(loadSurfaceFormReviewManifestSync(), records);
  return context;
}

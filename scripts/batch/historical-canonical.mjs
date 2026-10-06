import path from 'node:path';
import { createCanonicalContext } from '../validate/canonical-context.mjs';
import { loadSurfaceFormExceptionManifestSync, loadSurfaceFormReviewManifestSync } from '../inflection/surface-form-projection.mjs';

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

/** The exception bindings of a later factory admission must not target records this view rewinds past. */
export function projectHistoricalSurfaceFormExceptions(manifest, records) {
  const senseIdsByRecord = new Map(records.map((info) => [recordOf(info).id, new Set(recordOf(info).senses.map((sense) => sense.id))]));
  const result = structuredClone(manifest);
  result.exceptions = result.exceptions.filter((entry) => senseIdsByRecord.get(entry.record_id)?.has(entry.sense_id));
  return result;
}

/** Both surface-form inputs of one historical record set, so neither can reference a later admission. */
export function applyHistoricalSurfaceFormViews(context, records, { review = loadSurfaceFormReviewManifestSync(), exceptions = loadSurfaceFormExceptionManifestSync() } = {}) {
  context.derived ??= {};
  context.derived.surfaceFormReviewManifest = projectHistoricalSurfaceFormReview(review, records);
  context.derived.surfaceFormExceptionManifest = projectHistoricalSurfaceFormExceptions(exceptions, records);
  return context;
}

export function historicalAdmissionContext(records, semanticAudit) {
  const context = createCanonicalContext({ records }, {
    canonicalDirectory: path.resolve('data/batches'), source: 'retained-historical-canonical',
  });
  context.semanticAudit = semanticAudit;
  applyHistoricalSurfaceFormViews(context, records);
  return context;
}

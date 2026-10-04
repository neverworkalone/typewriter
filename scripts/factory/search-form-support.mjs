import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
} from '../inflection/surface-form-projection.mjs';
import { buildSearchFormSupport } from './identity-adapter.mjs';

// Search-form support of canonical lemmas for the Stage 1 canonical comparison (issue #275): the
// generated-surface projection the runtime already uses, indexed by record id. It reads canonical
// only; a projection failure is surfaced, never treated as "supported".
export async function loadSearchFormSupport(canonicalEntries) {
  const records = canonicalEntries.filter((entry) => entry.record_type === undefined || entry.record_type === 'entry');
  if (records.length === 0) return new Map();
  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest: await loadSurfaceFormExceptionManifest(),
    reviewManifest: await loadSurfaceFormReviewManifest(),
  });
  return buildSearchFormSupport(projection.rows);
}

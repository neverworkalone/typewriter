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

// Same projection, scoped to the canonical sense's POS (issue #391): Map<`${record id}\0${pos}`, Set<form>>.
// A generated predicate form is safe only for the POS of the canonical sense that generated it; the
// record-level map above merges every sense of a record and cannot tell a verb form from a noun.
export async function loadPosScopedSearchFormSupport(canonicalEntries) {
  const records = canonicalEntries.filter((entry) => entry.record_type === undefined || entry.record_type === 'entry');
  const support = new Map();
  if (records.length === 0) return support;
  const posOf = new Map(records.flatMap((record) => record.senses.map((sense) => [`${record.id}\0${sense.id}`, sense.pos])));
  const projection = buildSurfaceFormProjection(records, {
    exceptionManifest: await loadSurfaceFormExceptionManifest(),
    reviewManifest: await loadSurfaceFormReviewManifest(),
  });
  for (const { record_id: recordId, sense_id: senseId, form } of projection.rows) {
    const key = `${recordId}\0${posOf.get(`${recordId}\0${senseId}`)}`;
    support.set(key, (support.get(key) ?? new Set()).add(form));
  }
  return support;
}

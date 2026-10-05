import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildSurfaceFormProjection,
  listSurfaceFormDispositionGaps,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
} from '../inflection/surface-form-projection.mjs';
import { Stage3AdmissionError } from './admission.mjs';

const EXACT_REASON = 'Exact lemma and search-form lookup keeps precedence while the generated candidate remains available.';
const AMBIGUOUS_REASON = 'Retain every listed sense-bound candidate; do not select or collapse candidates.';
const byForm = (left, right) => (left.form < right.form ? -1 : left.form > right.form ? 1 : 0);
const REVIEW_REASON = 'Plain past for this open-final vowel class remains outside the current projection whitelist; retain its other applicable forms.';

async function canonicalRecords(root) {
  const directory = path.join(root, 'data/canonical');
  const records = [];
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(path.join(directory, name), 'utf8')).split('\n').filter(Boolean)) records.push(JSON.parse(line));
  }
  return records;
}

/**
 * Stage 3 writes new canonical predicate senses, so it also owns the sense-bound M6-2/M6-3
 * surface-form dispositions and collision reviews those senses need. Only an entry the rule itself dictates (`fix`)
 * is added; a gap that needs a reviewer's judgment fails as a lexical blocker instead of being guessed.
 * Returns the repository-relative manifest paths that changed.
 */
export async function applySurfaceFormDispositions({ root }) {
  const exceptionPath = path.join(root, 'data/validation/m6-2-inflection-exceptions.json');
  const reviewPath = path.join(root, 'data/validation/m6-3-surface-form-review.json');
  const exceptionManifest = await loadSurfaceFormExceptionManifest(exceptionPath);
  const reviewManifest = await loadSurfaceFormReviewManifest(reviewPath);
  const gaps = listSurfaceFormDispositionGaps(await canonicalRecords(root), { exceptionManifest, reviewManifest });
  const changed = new Set();
  for (const gap of gaps) {
    if (!gap.fix) {
      throw new Stage3AdmissionError(`${gap.message} It needs a reviewer's surface-form judgment.`, { category: 'lexical', code: 'STAGE3_SURFACE_FORM_JUDGMENT' });
    }
    const { manifest, class_id: classId } = gap.fix;
    if (manifest === 'review') {
      reviewManifest.dispositions.push({ class_id: classId, record_id: gap.record_id, sense_id: gap.sense_id, reason: REVIEW_REASON });
      changed.add(reviewPath);
    } else if (manifest === 'exception') {
      exceptionManifest.exceptions.push({ class_id: classId, record_id: gap.record_id, sense_id: gap.sense_id });
      changed.add(exceptionPath);
    } else {
      throw new Stage3AdmissionError(`unknown surface-form manifest ${manifest}`, { category: 'systemic', code: 'STAGE3_SURFACE_FORM_MANIFEST' });
    }
  }
  // New senses can also create exact/generated or generated/generated collisions. The collision
  // policy is fixed (exact lookup keeps precedence; every sense-bound candidate is retained), so
  // the entries for newly appearing forms are dictated by the rule rather than judged here.
  const records = await canonicalRecords(root);
  const { collisions } = buildSurfaceFormProjection(records, { exceptionManifest, reviewManifest });
  const reviewed = reviewManifest.reviewed_collisions;
  const haveExact = new Set(reviewed.exact_generated.map(({ form }) => form));
  const haveAmbiguous = new Set(reviewed.ambiguous_generated.map(({ form }) => form));
  const newExact = collisions.exactCollisions.filter(({ form }) => !haveExact.has(form));
  const newAmbiguous = collisions.ambiguousGeneratedForms.filter(({ form }) => !haveAmbiguous.has(form));
  if (newExact.length) {
    reviewed.exact_generated = [...reviewed.exact_generated, ...newExact.map(({ form, exact_candidates: exact, generated_candidates: generated }) => ({
      form, exact_candidates: exact, generated_candidates: generated, reason: EXACT_REASON,
    }))].sort(byForm);
    changed.add(reviewPath);
  }
  if (newAmbiguous.length) {
    reviewed.ambiguous_generated = [...reviewed.ambiguous_generated, ...newAmbiguous.map(({ form, candidates }) => ({ form, candidates, reason: AMBIGUOUS_REASON }))].sort(byForm);
    changed.add(reviewPath);
  }
  if (changed.has(reviewPath)) await writeFile(reviewPath, `${JSON.stringify(reviewManifest, null, 2)}\n`, 'utf8');
  if (changed.has(exceptionPath)) await writeFile(exceptionPath, `${JSON.stringify(exceptionManifest, null, 2)}\n`, 'utf8');
  return [...changed].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}

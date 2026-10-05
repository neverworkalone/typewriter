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
 * `plan…` computes the manifest rewrites without writing anything; `write…` applies them.
 */
export async function planSurfaceFormDispositions({ root, records: projected }) {
  const exceptionPath = path.join(root, 'data/validation/m6-2-inflection-exceptions.json');
  const reviewPath = path.join(root, 'data/validation/m6-3-surface-form-review.json');
  const exceptionManifest = await loadSurfaceFormExceptionManifest(exceptionPath);
  const reviewManifest = await loadSurfaceFormReviewManifest(reviewPath);
  const gaps = listSurfaceFormDispositionGaps(projected ?? await canonicalRecords(root), { exceptionManifest, reviewManifest });
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
  // New senses can also create, or extend the candidate set of, exact/generated and generated/generated
  // collisions. The policy is fixed (exact lookup keeps precedence; every sense-bound candidate is
  // retained), so these entries are dictated by the rule rather than judged here; reasons are kept.
  const records = projected ?? await canonicalRecords(root);
  const { collisions } = buildSurfaceFormProjection(records, { exceptionManifest, reviewManifest });
  const reviewed = reviewManifest.reviewed_collisions;
  const reasonOf = (entries) => new Map(entries.map((entry) => [entry.form, entry.reason]));
  const exactReasons = reasonOf(reviewed.exact_generated);
  const ambiguousReasons = reasonOf(reviewed.ambiguous_generated);
  const nextExact = collisions.exactCollisions.map(({ form, exact_candidates: exact, generated_candidates: generated }) => ({
    form, exact_candidates: exact, generated_candidates: generated, reason: exactReasons.get(form) ?? EXACT_REASON,
  })).sort(byForm);
  const nextAmbiguous = collisions.ambiguousGeneratedForms.map(({ form, candidates }) => ({
    form, candidates, reason: ambiguousReasons.get(form) ?? AMBIGUOUS_REASON,
  })).sort(byForm);
  // An additive admission can only add collision forms or extend the candidate set of an existing one.
  const disappeared = [...exactReasons.keys()].some((form) => !nextExact.some((entry) => entry.form === form))
    || [...ambiguousReasons.keys()].some((form) => !nextAmbiguous.some((entry) => entry.form === form));
  if (disappeared) {
    throw new Stage3AdmissionError('a reviewed surface-form collision disappeared after an additive admission', { category: 'systemic', code: 'STAGE3_SURFACE_FORM_COLLISION' });
  }
  if (JSON.stringify(nextExact) !== JSON.stringify(reviewed.exact_generated)) {
    reviewed.exact_generated = nextExact;
    changed.add(reviewPath);
  }
  if (JSON.stringify(nextAmbiguous) !== JSON.stringify(reviewed.ambiguous_generated)) {
    reviewed.ambiguous_generated = nextAmbiguous;
    changed.add(reviewPath);
  }
  const files = [];
  if (changed.has(exceptionPath)) files.push({ file: exceptionPath, text: `${JSON.stringify(exceptionManifest, null, 2)}\n` });
  if (changed.has(reviewPath)) files.push({ file: reviewPath, text: `${JSON.stringify(reviewManifest, null, 2)}\n` });
  return files.map(({ file, text }) => ({ file, path: path.relative(root, file).split(path.sep).join('/'), text }));
}

// Writes a plan produced before any canonical change, so a judgment gap never leaves a partial write.
export async function writeSurfaceFormDispositions(plan) {
  for (const { file, text } of plan) await writeFile(file, text, 'utf8');
  return plan.map(({ path: relativePath }) => relativePath).sort();
}

export async function applySurfaceFormDispositions({ root, records }) {
  return writeSurfaceFormDispositions(await planSurfaceFormDispositions({ root, records }));
}

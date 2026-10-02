/**
 * List (and optionally record) every M6-2/M6-3 surface-form disposition that
 * newly admitted predicate senses still need.
 *
 * The strict projection check reports only the first missing disposition, so
 * a batch with many predicates used to cost one validation run per sense. This
 * lists all of them at once. `--write` appends only the entries the projection
 * rules dictate (open-vowel plain-past exclusions and 없다/있다 present-adnominal
 * classes); a risk-coda regular class needs a reviewer's decision and is
 * reported, never written.
 *
 *   node scripts/batch/surface-form-dispositions.mjs [--write]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CANONICAL_DIRECTORY } from '../validate/canonical-jsonl.mjs';
import { loadCanonicalContext } from '../validate/canonical-context.mjs';
import {
  DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST,
  DEFAULT_SURFACE_FORM_REVIEW_MANIFEST,
  listSurfaceFormDispositionGaps,
} from '../inflection/surface-form-projection.mjs';

export const OPEN_VOWEL_PAST_REASON = 'Plain past for this open-final vowel class remains outside the current projection whitelist; retain its other applicable forms.';

export function planDispositionEntries(gaps) {
  const review = [];
  const exceptions = [];
  const needsReview = [];
  for (const gap of gaps) {
    if (!gap.fix) needsReview.push(gap);
    else if (gap.fix.manifest === 'review') {
      review.push({ class_id: gap.fix.class_id, record_id: gap.record_id, sense_id: gap.sense_id, reason: OPEN_VOWEL_PAST_REASON });
    } else {
      exceptions.push({ class_id: gap.fix.class_id, record_id: gap.record_id, sense_id: gap.sense_id });
    }
  }
  return { review, exceptions, needsReview };
}

export async function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const context = await loadCanonicalContext({ directory: DEFAULT_CANONICAL_DIRECTORY });
  const exceptionManifest = JSON.parse(await readFile(DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST, 'utf8'));
  const reviewManifest = JSON.parse(await readFile(DEFAULT_SURFACE_FORM_REVIEW_MANIFEST, 'utf8'));
  const gaps = listSurfaceFormDispositionGaps(context.records, { exceptionManifest, reviewManifest });
  const plan = planDispositionEntries(gaps);
  const summary = {
    missing: gaps.length,
    open_vowel_past_exclusions: plan.review.length,
    present_adnominal_classes: plan.exceptions.length,
    needs_reviewer_decision: plan.needsReview.map(({ record_id: id, sense_id: sense, message }) => ({ id, sense, message })),
    written: false,
  };
  if (write && (plan.review.length > 0 || plan.exceptions.length > 0)) {
    reviewManifest.dispositions.push(...plan.review);
    exceptionManifest.exceptions.push(...plan.exceptions);
    if (plan.review.length > 0) await writeFile(DEFAULT_SURFACE_FORM_REVIEW_MANIFEST, `${JSON.stringify(reviewManifest, null, 2)}\n`);
    if (plan.exceptions.length > 0) await writeFile(DEFAULT_SURFACE_FORM_EXCEPTION_MANIFEST, `${JSON.stringify(exceptionManifest, null, 2)}\n`);
    summary.written = true;
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}

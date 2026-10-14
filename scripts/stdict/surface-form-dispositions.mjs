import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planSurfaceFormDispositions,
  writeSurfaceFormDispositions,
} from '../factory/surface-form-dispositions.mjs';
import {
  listSurfaceFormDispositionGaps,
  loadSurfaceFormExceptionManifest,
  loadSurfaceFormReviewManifest,
} from '../inflection/surface-form-projection.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const EXCLUDED_REASON = 'STDICT import: risk-coda predicate inflection class is not reviewed; generated forms are not produced (fail closed).';

/**
 * Surface-form dispositions for official-source predicates. The shared
 * Stage 3 planner already applies every rule-dictated fix and the collision
 * policy; the only gap it cannot decide is a risk-coda predicate whose
 * regular/irregular class nobody has reviewed. Those are excluded from
 * generated forms rather than guessed regular.
 */
export async function planStdictSurfaceFormDispositions({ root, records }) {
  const exceptionManifest = await loadSurfaceFormExceptionManifest();
  const reviewManifest = await loadSurfaceFormReviewManifest();
  const judgments = listSurfaceFormDispositionGaps(records, { exceptionManifest, reviewManifest })
    .filter((gap) => !gap.fix)
    .map((gap) => ({
      record_id: gap.record_id,
      sense_id: gap.sense_id,
      class_id: 'm6-3-predicate-excluded',
      reason: EXCLUDED_REASON,
    }));
  return planSurfaceFormDispositions({ root, records, judgments });
}

async function main() {
  const root = path.resolve(process.argv[2] ?? '.');
  const canonical = await readCanonicalRecords(path.join(root, 'data/canonical'), { useSharedContext: false });
  const records = canonical.records.map(({ record }) => record);
  const plan = await planStdictSurfaceFormDispositions({ root, records });
  console.log(`updated: ${(await writeSurfaceFormDispositions(plan)).join(', ') || 'nothing'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

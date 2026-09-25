import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CANONICAL_DIRECTORY } from './canonical-jsonl.mjs';
import { loadCanonicalContext } from './canonical-context.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
} from '../inflection/surface-form-projection.mjs';

export async function validateCanonicalSurfaceFormProjection({
  canonicalContext,
  directory = DEFAULT_CANONICAL_DIRECTORY,
  exceptionManifest,
  requireExceptionTargets = true,
} = {}) {
  const context = canonicalContext ?? await loadCanonicalContext({ directory });
  const manifest = exceptionManifest ?? await loadSurfaceFormExceptionManifest();
  return buildSurfaceFormProjection(context.records, {
    exceptionManifest: manifest,
    requireExceptionTargets,
  });
}

export async function main() {
  const projection = await validateCanonicalSurfaceFormProjection();
  console.log(
    'Validated M6-3 projection coverage for '
      + projection.coverage.eligible_sense_count
      + ' predicate sense(s): '
      + projection.coverage.generated_surface_form_count
      + ' generated form/sense row(s), '
      + projection.coverage.excluded_rule_count
      + ' explicit exclusion(s), '
      + projection.coverage.exact_collision_form_count
      + ' exact-key collision(s), and '
      + projection.coverage.ambiguous_generated_form_count
      + ' ambiguous generated form(s).',
  );
  return projection;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? error.code + ': ' + error.message : error.message);
    process.exitCode = 1;
  });
}
